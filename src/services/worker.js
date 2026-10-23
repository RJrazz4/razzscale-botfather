import fs from 'node:fs';
import { pool, logUsage } from '../db/pool.js';
import * as evo from './evolution.js';
import { getAudioForVideo } from './music.js';
import { freeChat } from './llm.js';

// Async Worker (Architecture V2.1, plan §3): heavy kaam (music download, AI chat) webhook handler
// se bahar, SQLite jobs table ke peeche. Idempotency: ek idempotency_key wala kaam do baar nahi bhejta.
const TIMEOUTS = { music_download: 240_000, ai_chat: 120_000, lyrics: 30_000 };
const MAX_ATTEMPTS = 2;
let timer = null;
let ticking = false;

export async function enqueueJob(type, payload, idempotencyKey) {
  const { rows } = await pool.query(
    `insert into jobs (type, payload, idempotency_key) values ($1,$2,$3)
     on conflict (idempotency_key) do nothing returning id`,
    [type, JSON.stringify(payload), idempotencyKey || null]);
  if (rows[0]) return { id: rows[0].id, queued: true };
  if (idempotencyKey) {
    const { rows: ex } = await pool.query('select id, status from jobs where idempotency_key=$1', [idempotencyKey]);
    if (ex[0]?.status === 'done') return { id: ex[0].id, queued: false, deduped: true };
    if (ex[0]) return { id: ex[0].id, queued: false, existing: true };
  }
  return { id: null, queued: false };
}

async function claimNext() {
  const { rows } = await pool.query(
    `update jobs set status='running', attempts=attempts+1, updated_at=$1
     where id = (select id from jobs where status='pending' order by id asc limit 1)
     returning *`, [new Date().toISOString()]);
  return rows[0] || null;
}
async function finish(job, ok, result) {
  if (ok) {
    await pool.query("update jobs set status='done', result=$2, updated_at=$3 where id=$1",
      [job.id, result || null, new Date().toISOString()]).catch(() => {});
  } else if (job.attempts >= MAX_ATTEMPTS) {
    await pool.query("update jobs set status='failed', result=$2, updated_at=$3 where id=$1",
      [job.id, result || null, new Date().toISOString()]).catch(() => {});
  } else {
    await pool.query("update jobs set status='pending', updated_at=$2 where id=$1",
      [job.id, new Date().toISOString()]).catch(() => {});
  }
}

// Lyrics ke liye YouTube title ki safai: "|" ke baad ka hissa, [..]/(..) wale hisse aur
// Official/Video/Lyrical jaise shabd hatao; phir '—'/'-' par todo — pehla hissa artist, baki gaana.
function parseTrackQuery(rawTitle = '') {
  let s = String(rawTitle).split('|')[0];
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  s = s.replace(/\b(official|lyrical|lyrics|video|audio|full|hd|4k)\b/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const parts = s.split(/\s*[—–-]\s*/).filter(Boolean);
  if (parts.length >= 2) return { artist: parts[0], song: parts.slice(1).join(' - ') };
  return { artist: '', song: s };
}

async function fetchLyrics(artist, title) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8_000); // 8s timeout
  try {
    const res = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    return (j?.lyrics || '').trim() || null;
  } catch { return null; } finally { clearTimeout(to); }
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('job_timeout')), ms))]);
}

const EXECUTORS = {
  // Music: vault/disk/cold se audio lao aur WhatsApp par bhejo.
  // Footer rule: audio delivery = footer ON (caption me); uske baad lyrics-wali chhoti line (bina footer).
  async music_download(p) {
    const file = await getAudioForVideo(p.videoId, p.title);
    const b64 = fs.readFileSync(file).toString('base64');
    await evo.sendMedia(p.instance, p.to, b64, p.title, 'audio', { footer: true });
    await evo.sendText(p.instance, p.to, "Lyrics chahiye to 'lyrics' likh do 🎵").catch(() => {});
    if (p.userId) await logUsage(p.userId, 'music').catch(() => {});
  },
  // Lyrics: last-played gaane ke bol lyrics.ovh (free) se — na mile to saaf mana kar do.
  async lyrics(p) {
    const { artist, song } = parseTrackQuery(p.title);
    let lyr = null;
    if (artist && song) lyr = await fetchLyrics(artist, song);
    if (!lyr && song) lyr = await fetchLyrics('', song); // artist bina, sirf title se ek try
    if (!lyr) { await evo.sendText(p.instance, p.to, 'Is gaane ke lyrics nahi mile 😔'); return; }
    // Max ~3000 chars, line-boundary par ~1500 ke tukde, zyada se zyada 2 messages (bina footer)
    const chunks = [];
    let cur = '';
    for (const line of lyr.slice(0, 3000).split('\n')) {
      if (cur && (cur.length + line.length + 1) > 1500) { chunks.push(cur); cur = line; if (chunks.length === 2) break; }
      else cur = cur ? `${cur}\n${line}` : line;
    }
    if (cur && chunks.length < 2) chunks.push(cur);
    for (const c of chunks.slice(0, 2)) await evo.sendText(p.instance, p.to, c);
    if (p.userId) await logUsage(p.userId, 'lyrics').catch(() => {});
  },
  async ai_chat(p) {
    const reply = await freeChat({ id: p.userId }, p.text);
    await evo.sendText(p.instance, p.to, reply, { ad: true });
  },
};

const FAILURE_TEXT = {
  music_download: { type: 'text', text: 'Ye gaana download nahi ho paya 😔 — "menu" likh kar koi aur gaana try karo.' },
  lyrics: { type: 'text', text: 'Is gaane ke lyrics nahi mile 😔' },
};

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    let job;
    while ((job = await claimNext().catch(() => null))) {
      let payload = {};
      try { payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : (job.payload || {}); } catch { /* khali payload */ }
      const run = EXECUTORS[job.type];
      if (!run) { await finish(job, false, 'unknown_type'); continue; }
      try {
        await withTimeout(run(payload), TIMEOUTS[job.type] || 120_000);
        await finish(job, true);
      } catch (e) {
        const lastTry = job.attempts >= MAX_ATTEMPTS;
        await finish(job, false, String(e?.message || e));
        if (lastTry && FAILURE_TEXT[job.type] && payload.instance && payload.to) {
          await evo.sendText(payload.instance, payload.to, FAILURE_TEXT[job.type].text).catch(() => {});
        }
      }
    }
  } finally { ticking = false; }
}

export function startWorker() {
  if (timer) return;
  // Boot par atke hue 'running' jobs ko wapas pending karo (crash/restart recovery)
  pool.query("update jobs set status='pending' where status='running'").catch(() => {});
  timer = setInterval(() => { tick().catch(() => {}); }, 1500);
  console.log('[worker] jobs worker shuru');
}
