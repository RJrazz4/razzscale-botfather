import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import * as telegram from './telegram.js';
import { downloadAudio } from './music.js';
import { MAX_SONG_SEC } from './jiosaavn.js';
import { notifyOwner } from './owner.js';
import { CLOUD_INSTANCE } from './transport.js';

const run = promisify(execFile);

// =====================================================================
// AUTO LIBRARY SEEDER (Hero ka order, 2026-11-07) — 1 mahina chalega.
// Kaam: official bade channels + viral lists se gaane dheere-dheere
// download karke Telegram vault (media_vault) me pehle se bharna, taaki
// user ke pehle mange par bhi gaana library se turant mile.
// Maryada:
//  - User ke live requests HAMESHA pehle — music_download ka koi job
//    pending/running ho to seeder us cycle me haath nahi lagata.
//  - Bina duplicate: media_vault (video_id) hi pehchan hai; seed_seen
//    har koshish ka hisaab rakhta hai taaki restart par dohraya na jaye.
//  - Sirf gaane: 60s..MAX_SONG_SEC, trailer/teaser/promo/jukebox bahar.
//  - Lagatar 5 fail = 6 ghante ka auto-pause + owner ko khabar. Zor nahi.
// =====================================================================

const MIN_SONG_SEC = 60;
const SEED_INTERVAL_MS = 18 * 60_000; // ~3 cycle/ghanta, cap ke andar
const FAIL_STREAK_PAUSE = 5;
const PAUSE_MS = 6 * 3600_000;

// Official channel /videos lists (handle badalna ho to yahi list badlo).
// Search sources par channel-naam ka sakht mel lazmi hai (official hi).
export const SEED_SOURCES = [
  { type: 'channel', name: 'T-Series', url: 'https://www.youtube.com/@tseries/videos' },
  { type: 'channel', name: 'Zee Music Company', url: 'https://www.youtube.com/@zeemusiccompany/videos' },
  { type: 'channel', name: 'Sony Music India', url: 'https://www.youtube.com/@SonyMusicIndia/videos' },
  { type: 'channel', name: 'YRF', url: 'https://www.youtube.com/@yrf/videos' },
  { type: 'channel', name: 'Tips Official', url: 'https://www.youtube.com/@TipsOfficial/videos' },
  { type: 'channel', name: 'Speed Records', url: 'https://www.youtube.com/@speedrecords/videos' },
  { type: 'search', name: 'Wave Music (Bhojpuri)', query: 'Wave Music Bhojpuri new song official', channels: ['Wave Music'] },
  { type: 'search', name: 'Worldwide Records Bhojpuri', query: 'Worldwide Records Bhojpuri new song official', channels: ['Worldwide Records Bhojpuri', 'World Wide Records Bhojpuri'] },
  { type: 'search', name: 'Sidharth Music (Odia)', query: 'Sidharth Music Odia new song official', channels: ['Sidharth Music'] },
  { type: 'search', name: 'Amara Odia', query: 'Amara Odia new song official', channels: ['Amara Odia', 'AmaraMuzik Odia', 'Amara Muzik'] },
];

// Title me ye shabdein = gaana nahi (trailer/teaser/promo aadi) — bahar.
export const BLOCKED_TITLE_WORDS = [
  'trailer', 'teaser', 'promo', 'making of', 'behind the scenes', 'first look',
  'motion poster', 'announcement', 'interview', 'press meet', 'jukebox',
  '#shorts', 'pre release', 'pre-release', 'launch event', 'success meet',
];

function fold(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isBlockedTitle(title) {
  const t = ` ${fold(title)} `;
  return BLOCKED_TITLE_WORDS.some((w) => t.includes(` ${w}`) || t.includes(w));
}

export function channelMatches(uploader, allowed) {
  const u = fold(uploader);
  if (!u) return false;
  return (allowed || []).some((name) => {
    const n = fold(name);
    return u === n || u.startsWith(n) || n.startsWith(u);
  });
}

/** yt-dlp flat entries -> saaf candidates (filter + viral pehle). Pure. */
export function filterCandidates(entries, source) {
  const out = [];
  for (const e of entries || []) {
    const videoId = e?.id;
    const title = String(e?.title || '').trim();
    const duration = Number(e?.duration || 0);
    if (!videoId || !title) continue;
    if (!(duration >= MIN_SONG_SEC && duration <= MAX_SONG_SEC)) continue;
    if (isBlockedTitle(title)) continue;
    if (source?.type === 'search' && !channelMatches(e?.uploader || e?.channel || '', source.channels)) continue;
    out.push({
      videoId, title: title.slice(0, 200),
      durationSec: Math.round(duration),
      viewCount: Number(e?.view_count || 0),
      channel: String(e?.uploader || e?.channel || source?.name || ''),
      source: source?.name || '',
    });
  }
  out.sort((a, b) => b.viewCount - a.viewCount);
  return out;
}

// ---------- State (DB; restart-safe) ----------
let tablesReady = null;
function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`create table if not exists seed_seen (
        video_id text primary key, title text, source text,
        status text not null, attempts integer not null default 0,
        created_at text not null, updated_at text not null
      )`);
      await pool.query(`create table if not exists seed_state (
        k text primary key, v text not null
      )`);
    })().catch((e) => { tablesReady = null; throw e; });
  }
  return tablesReady;
}

async function stateGet(k) {
  await ensureTables();
  const { rows } = await pool.query('select v from seed_state where k=$1', [k]);
  return rows[0]?.v ?? null;
}
async function stateSet(k, v) {
  await ensureTables();
  await pool.query(
    `insert into seed_state (k, v) values ($1,$2)
     on conflict (k) do update set v = excluded.v`,
    [k, String(v)]);
}

export async function isInVault(videoId) {
  const { rows } = await pool.query('select video_id from media_vault where video_id=$1', [videoId]).catch(() => ({ rows: [] }));
  return rows.length > 0;
}

async function seenStatus(videoId) {
  await ensureTables();
  const { rows } = await pool.query('select status, attempts from seed_seen where video_id=$1', [videoId]);
  return rows[0] || null;
}

async function markSeen(c, status) {
  await ensureTables();
  const now = new Date().toISOString();
  await pool.query(
    `insert into seed_seen (video_id, title, source, status, attempts, created_at, updated_at)
     values ($1,$2,$3,$4,1,$5,$5)
     on conflict (video_id) do update set status = excluded.status,
       attempts = seed_seen.attempts + 1, updated_at = excluded.updated_at`,
    [c.videoId, c.title, c.source, status, now]);
}

// IST din (YYYY-MM-DD) — roz ki ginati aur digest is par chalte hain.
function istDate(d = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
function istHour(d = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600_000).getUTCHours();
}

async function todayCount() {
  return Number((await stateGet(`count:${istDate()}`)) || 0);
}
async function bumpTodayCount() {
  const n = (await todayCount()) + 1;
  await stateSet(`count:${istDate()}`, n);
  return n;
}

// ---------- Discovery (yt-dlp flat list) ----------
async function discoverFromSource(source) {
  const target = source.type === 'search' ? `ytsearch40:${source.query}` : source.url;
  const { stdout } = await run(env.ytdlp, [
    '--flat-playlist', '-J', '--no-warnings', '--playlist-end', '60', target,
  ], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  return filterCandidates(data?.entries || [], source);
}

// Candidate kataar (memory me; khaali ho to sources ghuma kar bharti hai)
let queue = [];
let sourceIdx = 0;
async function refillQueue() {
  const fresh = [];
  for (let i = 0; i < SEED_SOURCES.length; i++) {
    const source = SEED_SOURCES[(sourceIdx + i) % SEED_SOURCES.length];
    try {
      const cands = await discoverFromSource(source);
      for (const c of cands) {
        if (await isInVault(c.videoId)) { await markSeen(c, 'invault'); continue; }
        const seen = await seenStatus(c.videoId);
        if (seen && (seen.status === 'seeded' || seen.status === 'invault')) continue;
        if (seen && seen.status === 'failed' && seen.attempts >= 3) continue;
        fresh.push(c);
      }
    } catch (e) {
      console.error(`[seeder] source fail (${source.name}):`, String(e?.message || e).slice(0, 160));
    }
  }
  sourceIdx = (sourceIdx + 1) % SEED_SOURCES.length;
  // Doosri baar aane wale duplicates hatao, viral upar rakhe hue kram me
  const seenIds = new Set();
  queue = fresh.filter((c) => (seenIds.has(c.videoId) ? false : (seenIds.add(c.videoId), true)));
  console.log(`[seeder] kataar taiyaar: ${queue.length} naye candidates`);
}

// ---------- Ek gaana seed karna ----------
async function seedOne(c) {
  const file = await downloadAudio(c.videoId); // dlGate live downloads ke saath saanjha hai
  try {
    const up = await telegram.uploadFile(env.telegramVaultChatId, file, c.videoId);
    if (!up?.file_id) throw new Error('vault_upload_failed');
    await pool.query(
      `insert into media_vault (video_id, title, file_id, message_id, size) values ($1,$2,$3,$4,$5)
       on conflict (video_id) do update set file_id=excluded.file_id, message_id=excluded.message_id, size=excluded.size`,
      [c.videoId, c.title, up.file_id, up.message_id, fs.statSync(file).size]);
  } finally {
    // Local copy ka kaam khatm — asli copy vault me hai (disk bharne se bachao)
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

async function userJobsBusy() {
  const { rows } = await pool.query(
    "select count(*)::int as n from jobs where type='music_download' and status in ('pending','running')",
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return Number(rows[0]?.n || 0) > 0;
}

async function maybeDigest() {
  if (istHour() < 21) return;
  const today = istDate();
  if ((await stateGet('last_digest')) === today) return;
  await stateSet('last_digest', today);
  const dayN = await todayCount();
  const { rows } = await pool.query('select count(*)::int as n from media_vault').catch(() => ({ rows: [{ n: 0 }] }));
  await notifyOwner(CLOUD_INSTANCE,
    `📚 *Auto Library — aaj ki report*\nAaj bhare: ${dayN} gaane\nKul library: ${rows[0]?.n ?? '?'} gaane\nSeeder apne aap chal raha hai.`).catch(() => {});
}

let stepping = false;
async function seedStep() {
  if (stepping) return;
  stepping = true;
  try {
    if (!telegram.vaultEnabled()) return; // vault bina seeding bekaar hai
    const pausedUntil = Number((await stateGet('paused_until')) || 0);
    if (Date.now() < pausedUntil) return;
    await maybeDigest();
    if ((await todayCount()) >= env.seedDailyCap) return;
    if (await userJobsBusy()) return; // user pehle, hamesha
    if (!queue.length) await refillQueue();
    const c = queue.shift();
    if (!c) return;
    try {
      await seedOne(c);
      await markSeen(c, 'seeded');
      await stateSet('fail_streak', 0);
      const n = await bumpTodayCount();
      console.log(`[seeder] seeded "${c.title}" (${c.videoId}) — aaj kul ${n}`);
    } catch (e) {
      await markSeen(c, 'failed').catch(() => {});
      const streak = Number((await stateGet('fail_streak')) || 0) + 1;
      await stateSet('fail_streak', streak);
      console.error(`[seeder] fail "${c.title}":`, String(e?.message || e).slice(0, 160), `(streak ${streak})`);
      if (streak >= FAIL_STREAK_PAUSE) {
        await stateSet('paused_until', Date.now() + PAUSE_MS);
        await stateSet('fail_streak', 0);
        await notifyOwner(CLOUD_INSTANCE,
          '⏸️ *Auto Library ruk gaya hai*\nLagatar 5 gaane fail hue (YouTube ki rok ho sakti hai). Seeder 6 ghante baad khud phir koshish karega.').catch(() => {});
      }
    }
  } catch (e) {
    console.error('[seeder] step error:', String(e?.message || e).slice(0, 200));
  } finally { stepping = false; }
}

let timer = null;
export function startSeeder() {
  if (timer) return;
  if (!env.seederEnabled) { console.log('[seeder] disabled (SEEDER_ENABLED=false)'); return; }
  timer = setInterval(() => { seedStep().catch(() => {}); }, SEED_INTERVAL_MS);
  setTimeout(() => { seedStep().catch(() => {}); }, 120_000); // boot ke 2 min baad pehla kadam
  console.log(`[seeder] auto library shuru — cap ${env.seedDailyCap}/din, har ${SEED_INTERVAL_MS / 60000} min ek kadam`);
}
