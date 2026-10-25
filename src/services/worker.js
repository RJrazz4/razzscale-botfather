import fs from 'node:fs';
import path from 'node:path';
import { pool, logUsage, getFlow, setFlow } from '../db/pool.js';
import { env } from '../config/env.js';
import * as evo from './transport.js';
import * as graph from './graph-cloud.js';
import * as telegram from './telegram.js';
import { getAudioForVideo, searchSongs } from './music.js';
import { getFreshUrl, withQuality } from './jiosaavn.js';
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

// Post-audio ACTION LIST (TAP-FIRST) — success par lyrics/music_new/menu wale 3 rows;
// failure par gaana nahi aaya, isliye lyrics row nahi — sirf music_new/menu.
// RowIds masterMenu me text bankar handle hote hain ('lyrics' keyword branch,
// 'music_new'/'mz'/TAP mapping, 'menu' keyword branch, 'nav_menu' global nav).
// Return: list bheji gayi ya nahi (false par caller text fallback bhejta hai).
async function sendMusicActionList(instance, to, ok) {
  const rows = ok
    ? [
      { rowId: 'lyrics', title: '🔤 Is gaane ke Lyrics', description: 'Isi gaane ke bol dekho' },
      { rowId: 'music_new', title: '🔍 Naya gaana khojo', description: 'Koi aur gaana sunna hai' },
      { rowId: 'menu', title: '🏠 Menu par wapas', description: 'Saari services dekho' },
    ]
    : [
      { rowId: 'music_new', title: '🔍 Naya gaana khojo', description: 'Koi aur gaana try karo' },
      { rowId: 'menu', title: '🏠 Menu par wapas', description: 'Saari services dekho' },
    ];
  const sent = await evo.sendList(instance, to, {
    title: ok ? '🎵 Gaana mil gaya!' : '🎵 Gaana nahi aaya',
    buttonText: 'Options Dekho',
    description: 'Ab kya karna hai? Ek option tap karo 👇',
    sections: [{ title: 'Gaane ke options', rows }],
  }).catch(() => null);
  return Boolean(sent);
}

// ---------- FAST MUSIC v2: JioSaavn delivery chain ----------
// Order pakka hai: (1) VAULT — repeat gaana sabse fast (Telegram file_id se disk par),
// (2) fresh URL DIRECT send — Evolution khud CDN se fetch karta hai, disk zero,
// (3) buffer download karke send (+ gaana vault me, agli baar step 1 se milega),
// (4) LAST FALLBACK — purana yt-dlp pipeline (title se YT khoj). Koi kadam fail ho
// to agla kadam; sab fail hon to hi job fail hota hai.
const WHATSAPP_MAX = 16 * 1024 * 1024; // WhatsApp media cap (music.js se ek)

async function sendAudioFile(p, file) {
  const b64 = fs.readFileSync(file).toString('base64');
  await evo.sendMedia(p.instance, p.to, b64, p.title, 'audio', { footer: true });
}
// Vault save: key 'saavn:<songId>' — YT video IDs se takraav nahi. Background pattern
// (music.js jaisa): user ka jawab is par nahi rukta.
function vaultSaveSaavn(vaultId, file, title) {
  if (!telegram.vaultEnabled() || !fs.existsSync(file)) return;
  telegram.uploadFile(env.telegramVaultChatId, file, vaultId)
    .then(async (up) => {
      if (up?.file_id) {
        await pool.query(
          `insert into media_vault (video_id, title, file_id, message_id, size) values ($1,$2,$3,$4,$5)
           on conflict (video_id) do update set file_id=excluded.file_id, message_id=excluded.message_id, size=excluded.size`,
          [vaultId, title || null, up.file_id, up.message_id, fs.statSync(file).size]).catch(() => {});
      }
    })
    .catch(() => {});
}
async function headSize(url) {
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(to);
    const len = Number(res.headers.get('content-length'));
    return res.ok && Number.isFinite(len) && len > 0 ? len : null;
  } catch { return null; }
}
async function fetchBuffer(url) {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`cdn_http_${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally { clearTimeout(to); }
}
// Quality ki utarti seedhi: jo URL mila wahi, phir 160, phir 96
function qualityLadder(url) {
  const out = [url];
  for (const kb of [160, 96]) {
    const v = withQuality(url, kb);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

async function deliverSaavnTrack(p) {
  const vaultId = `saavn:${p.songId}`;
  fs.mkdirSync(env.musicTmp, { recursive: true });
  const localFile = path.join(env.musicTmp, `saavn-${p.songId}.m4a`);
  // (1) VAULT pehle — repeat gaana yahin se sabse tez aata hai
  if (telegram.vaultEnabled()) {
    const { rows } = await pool.query('select * from media_vault where video_id=$1', [vaultId]).catch(() => ({ rows: [] }));
    if (rows[0]?.file_id) {
      const ok = await telegram.downloadByFileId(rows[0].file_id, localFile);
      if (ok && fs.existsSync(localFile) && fs.statSync(localFile).size <= WHATSAPP_MAX) {
        await evo.sendPresence(p.instance, p.to, 'recording', 30000).catch(() => {});
        await sendAudioFile(p, localFile);
        return;
      }
      // Dead file_id — saaf karke aage badho (music.js wala hi usool)
      await pool.query('delete from media_vault where video_id=$1', [vaultId]).catch(() => {});
    }
  }
  // (2)+(3) fresh URL se delivery — koi bhi gadbad ho to delivered=false, step 4 chalega
  let delivered = false;
  try {
    const { url } = await getFreshUrl(p.songId);
    let sendUrl = url;
    // 320kbps ka lamba gaana 16MB cap tod sakta hai — HEAD se size dekh lo,
    // bada ho to pehle se quality gira kar bhejo (fail-retry se tez hai)
    const size = await headSize(url);
    if (size && size > WHATSAPP_MAX) {
      for (const kb of [160, 96]) {
        const v = withQuality(url, kb);
        const s2 = await headSize(v);
        sendUrl = v;
        if (!s2 || s2 <= WHATSAPP_MAX) break;
      }
    }
    await evo.sendPresence(p.instance, p.to, 'recording', 30000).catch(() => {});
    try {
      // (2) DIRECT URL send — disk par kuch save nahi hota
      await evo.sendMedia(p.instance, p.to, sendUrl, p.title, 'audio', { footer: true });
      delivered = true;
      // Vault ke liye background download — user is par nahi rukta
      fetchBuffer(sendUrl).then((buf) => {
        if (buf.length && buf.length <= WHATSAPP_MAX) { fs.writeFileSync(localFile, buf); vaultSaveSaavn(vaultId, localFile, p.title); }
      }).catch(() => {});
    } catch { /* (3) buffer path */ }
    if (!delivered) {
      for (const v of qualityLadder(sendUrl)) {
        try {
          const buf = await fetchBuffer(v);
          if (buf.length && buf.length <= WHATSAPP_MAX) {
            fs.writeFileSync(localFile, buf);
            await sendAudioFile(p, localFile);
            vaultSaveSaavn(vaultId, localFile, p.title);
            delivered = true;
            break;
          }
        } catch { /* agli quality try karo */ }
      }
    }
  } catch { /* fresh URL hi nahi mila — step 4 */ }
  if (delivered) return;
  // (4) LAST FALLBACK: purana yt-dlp pipeline (gaane ke title se YT khoj)
  const yt = await searchSongs(p.title, 1).catch(() => []);
  if (yt[0]?.id) {
    const file = await getAudioForVideo(yt[0].id, p.title);
    await evo.sendPresence(p.instance, p.to, 'recording', 30000).catch(() => {});
    await sendAudioFile(p, file);
    return;
  }
  throw new Error('saavn_delivery_failed');
}

// ---------- Cloud (Official API): gaana LINK se delivery ----------
// Evolution wali chain (vault/base64) Cloud par nahi chalti — wahan Meta khud CDN se
// audio kheenchta hai (sendAudioByLink). Fresh URL jiosaavn.js se (TTL/cache niyam
// wahi), quality ka faisla HEAD size se: 16MB se bada ho to 160, phir 96.
async function deliverSaavnTrackCloud(p) {
  const { url } = await getFreshUrl(p.songId);
  let sendUrl = url;
  const size = await headSize(url);
  if (size && size > WHATSAPP_MAX) {
    for (const kb of [160, 96]) {
      const v = withQuality(url, kb);
      const s2 = await headSize(v);
      sendUrl = v;
      if (!s2 || s2 <= WHATSAPP_MAX) break;
    }
  }
  // transport ka cloud sendMedia = audio link send (Cloud audio par caption nahi hota)
  const sent = await evo.sendMedia(p.instance, p.to, sendUrl, p.title, 'audio', { footer: true });
  if (sent) return;
  // Link fail — quality gira kar ek aur koshish (CDN kabhi ek rendition par akadta hai)
  for (const v of qualityLadder(sendUrl)) {
    if (v === sendUrl) continue;
    const retry = await evo.sendMedia(p.instance, p.to, v, p.title, 'audio', { footer: true }).catch(() => null);
    if (retry) return;
  }
  throw new Error('saavn_cloud_delivery_failed');
}

// Post-audio BUTTONS (Cloud) — Evolution par yahi kaam action LIST karti hai; Cloud par
// 3 reply buttons: Lyrics / Naya gaana / Menu. Button ids masterMenu ke purane rowIds
// hi hain — wahi branches (lyrics keyword / TAP_MAP music_new / menu keyword) chalenge.
async function sendMusicActionButtons(to, ok) {
  const buttons = ok
    ? [
      { id: 'lyrics', title: '🔤 Lyrics' },
      { id: 'music_new', title: '🔍 Naya gaana' },
      { id: 'menu', title: '🏠 Menu' },
    ]
    : [
      { id: 'music_new', title: '🔍 Naya gaana' },
      { id: 'menu', title: '🏠 Menu' },
    ];
  const sent = await graph.sendButtons(to, {
    body: ok ? '🎵 Gaana mil gaya! Ab kya karna hai? Ek option tap karo 👇' : '🎵 Gaana nahi aaya. Aur kya karna hai? 👇',
    buttons,
  }).catch(() => false);
  return Boolean(sent);
}

const EXECUTORS = {
  // Music: vault/disk/cold se audio lao aur WhatsApp par bhejo.
  // Footer rule: audio delivery = footer ON (caption me).
  // TAP-FIRST (KDMusic-style): delivery ke turant baad ACTION LIST — user ko kuch type nahi karna.
  // RowIds masterMenu me text bankar handle hote hain: 'lyrics' → lyrics keyword branch,
  // 'music_new' → TAP_MAP se '2', 'menu' → menu keyword branch. List fail ho to purani text line fallback.
  async music_download(p) {
    // LIVE PRESENCE (2026-10-24): kaam chalte waqt user ko typing/recording dikhe —
    // composing = dhoondh/download ho raha hai, recording = audio bheja ja raha hai,
    // khatm (success ya fail) par paused. Presence kabhi main kaam ko nahi rokta
    // (sendPresence andar hi errors swallow karta hai, upar se .catch bhi hai).
    await evo.sendPresence(p.instance, p.to, 'composing', 20000).catch(() => {});
    try {
      if (p.instance === evo.CLOUD_INSTANCE) {
        // CLOUD branch: file/vault wala rasta nahi — saavn gaana LINK se, uske baad
        // action BUTTONS. YT-source pick ka audio link Cloud par nahi banta, isliye
        // woh fail hokar sendMusicFailure ke YouTube-link wale text par jata hai.
        if (p.source === 'jiosaavn' && p.songId) {
          try {
            await deliverSaavnTrackCloud(p);
          } catch (e) {
            p.url = undefined; p.videoId = null; // failure text bina dead-link ke jaye
            throw e;
          }
        } else {
          throw new Error('cloud_yt_link_only');
        }
        await moveBusyState(p.userId, p.videoId, { step: 'music_done', lastTitle: p.title });
        const btns = await sendMusicActionButtons(p.to, true);
        if (!btns) {
          await evo.sendText(p.instance, p.to, "Lyrics chahiye to 'lyrics' likh do 🎵").catch(() => {});
        }
        if (p.userId) await logUsage(p.userId, 'music').catch(() => {});
        return;
      }
      if (p.source === 'jiosaavn' && p.songId) {
        // FAST MUSIC v2 chain (upar deliverSaavnTrack): vault -> URL -> buffer -> yt-dlp
        try {
          await deliverSaavnTrack(p);
        } catch (e) {
          // Failure-text ke liye payload saaf: saavn ID se YouTube link banana DEAD
          // link hoga — tick wala sendMusicFailure phir bina-link wala text chunega.
          p.url = undefined; p.videoId = null;
          throw e;
        }
      } else {
        const file = await getAudioForVideo(p.videoId, p.title);
        await evo.sendPresence(p.instance, p.to, 'recording', 30000).catch(() => {});
        const b64 = fs.readFileSync(file).toString('base64');
        await evo.sendMedia(p.instance, p.to, b64, p.title, 'audio', { footer: true });
      }
      // Delivery ho gayi — busy guard hatao, ab post-audio taps (lyrics/music_new) khulenge
      await moveBusyState(p.userId, p.videoId, { step: 'music_done', lastTitle: p.title });
      const actionList = await sendMusicActionList(p.instance, p.to, true);
      if (!actionList) {
        await evo.sendText(p.instance, p.to, "Lyrics chahiye to 'lyrics' likh do 🎵").catch(() => {});
      }
      if (p.userId) await logUsage(p.userId, 'music').catch(() => {});
    } finally {
      await evo.sendPresence(p.instance, p.to, 'paused', 1000).catch(() => {});
    }
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
    // LIVE PRESENCE: LLM soch raha hai — user ko 'composing' (typing…) dikhe, khatm par paused.
    // (masterMenu enqueue ke waqt pehle hi ek quick composing bhejta hai — ye use refresh rakhta hai.)
    await evo.sendPresence(p.instance, p.to, 'composing', 15000).catch(() => {});
    try {
      const reply = await freeChat({ id: p.userId }, p.text);
      await evo.sendText(p.instance, p.to, reply, { ad: true });
    } finally {
      await evo.sendPresence(p.instance, p.to, 'paused', 1000).catch(() => {});
    }
  },
};

const FAILURE_TEXT = {
  lyrics: { type: 'text', text: 'Is gaane ke lyrics nahi mile 😔' },
};
// Music fail (FRONTEND BRIEF §3): sirf "fail ho gaya" nahi — usi track ka YouTube link
// (alternative sunne ka rasta) + action list. Link videoId se banta hai (pick ke time
// payload me videoId hamesha hota hai; url bhi bheja jata hai, woh mile to wahi use karo).
async function sendMusicFailure(p) {
  const link = p.url || (p.videoId ? `https://www.youtube.com/watch?v=${p.videoId}` : null);
  const text = link
    ? `Ye gaana download nahi ho paya 😔\nTab tak YouTube par sun lo: ${link}`
    : 'Ye gaana download nahi ho paya 😔 — koi aur gaana try karo.';
  await evo.sendText(p.instance, p.to, text).catch(() => {});
  if (p.instance === evo.CLOUD_INSTANCE) { await sendMusicActionButtons(p.to, false); return; }
  await sendMusicActionList(p.instance, p.to, false);
}

// Pick ke baad state 'music_busy' rehta hai (double-pick guard). Delivery/fail par worker
// use aage badhata hai — PAR sirf tab jab state ab bhi busy ho (user beech me menu par
// chala gaya ho to use wapas mat kheenchon). masterMenu ke busy guard ka jod yahi hai.
async function moveBusyState(userId, videoId, next) {
  if (!userId) return;
  try {
    const f = await getFlow(userId, 'master');
    if (f?.step === 'music_busy' && (!videoId || f.videoId === videoId)) {
      await setFlow(userId, 'master', next, 1800);
    }
  } catch { /* state na badle to guard agle user action par khud saaf ho jayega */ }
}

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
        if (lastTry && payload.instance && payload.to) {
          if (job.type === 'music_download') {
            // Fail pakka ho gaya — busy guard hatao, user Music Zone se dobara try kar sakta hai
            await moveBusyState(payload.userId, payload.videoId, { step: 'music_zone', lastTitle: payload.title });
            await sendMusicFailure(payload).catch(() => {});
          }
          else if (FAILURE_TEXT[job.type]) await evo.sendText(payload.instance, payload.to, FAILURE_TEXT[job.type].text).catch(() => {});
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
