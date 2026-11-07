import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpegStatic from 'ffmpeg-static';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import { MAX_SONG_SEC } from './jiosaavn.js';
import * as telegram from './telegram.js';
const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN || ffmpegStatic || 'ffmpeg';

// ---------- yt-dlp binary: KHUD-TAAZA (2026-11-07) ----------
// Logs ne jad batayi: production ka binary (env.ytdlp = bin/yt-dlp) ek
// jagah band hai, aur YouTube har kuch hafton me player badal deta hai —
// purana binary kuch videos par "player response" nahi nikaal pata, wahi
// videos naye binary se turant khul jate hain. Hal: bot khud taaza yt-dlp
// taiyaar rakhe — pehle repo wala jana-pehchana binary (tools/yt-dlp,
// 2026.10.21), phir peeche se GitHub se SABSE NAYA download karke usi par
// switch. Naya rasta fail ho to purana binary hi chalta rahega — bigadega
// kuch nahi. --js-runtimes jaise naye flags SIRF pehchane hue (modern)
// binary par lagte hain; anjaan binary par surakshit purane arguments hi.
let binState = null; // { path, modern }
let binInitStarted = false;

export function ytdlpStatus() { return binState || { path: env.ytdlp, modern: false }; }

export function initYtdlp() {
  if (binInitStarted) return;
  binInitStarted = true;
  try {
    const toolsBin = path.join(process.cwd(), 'tools', 'yt-dlp');
    if (fs.existsSync(toolsBin)) binState = { path: toolsBin, modern: true };
  } catch { /* ignore */ }
  prepareFreshYtdlp().catch(() => {});
}

async function prepareFreshYtdlp() {
  const dir = path.join(env.musicTmp, 'ytdlp-fresh');
  const bin = path.join(dir, 'yt-dlp');
  try {
    if (fs.existsSync(bin)) {
      const v = await run(bin, ['--version'], { timeout: 10_000 });
      if (v.stdout?.trim()) {
        binState = { path: bin, modern: true };
        console.log('[music] taaza yt-dlp pehle se taiyaar:', v.stdout.trim());
        return;
      }
    }
  } catch { /* kharab file — neeche fresh download hoga */ }
  await fs.promises.mkdir(dir, { recursive: true });
  const res = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
    { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`ytdlp_fetch_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error('ytdlp_too_small');
  const tmp = `${bin}.tmp`;
  await fs.promises.writeFile(tmp, buf);
  fs.chmodSync(tmp, 0o755);
  const v = await run(tmp, ['--version'], { timeout: 15_000 });
  if (!v.stdout?.trim()) throw new Error('ytdlp_no_version');
  await fs.promises.rename(tmp, bin);
  binState = { path: bin, modern: true };
  console.log('[music] taaza yt-dlp taiyaar:', v.stdout.trim());
}

/** Download ke arguments — modern binary par JS-runtime wala hathiyaar bhi
 *  (bina JS runtime ke YouTube kuch videos ka player jawab deta hi nahi;
 *  server par Node hai hi). Pure. */
export function downloadArgs(client, srcPath, videoId, modern) {
  return ['-f', '18/best[height<=360]/best', '--no-warnings', '-4',
    ...(modern ? ['--js-runtimes', 'node'] : []),
    '--extractor-args', `youtube:player_client=${client}`,
    '-o', srcPath, `https://www.youtube.com/watch?v=${videoId}`];
}

// yt-dlp search (flat) + chune hue gaane ka audio download.
// KDMusic-style UX (2026-10-24): master bot ab top 8 lata hai (pages of 3 + "more").
// Cache key me limit shamil hai taaki 3-wali aur 8-wali khoj ek dusre ko na kaatein.
export async function searchSongs(query, limit = 8) {
  // v3 (2026-11-07): lambe-mix filter ke baad purana v2 cache bekaar — usme
  // 1-ghante wale playlist phanse hue hain, woh dobara na aayen.
  const hash = crypto.createHash('sha256').update(`v3:${limit}:${query.toLowerCase().trim()}`).digest('hex');
  const { rows } = await pool.query('select results from music_cache where query_hash=$1', [hash]);
  if (rows[0]) return rows[0].results;
  // limit+4 isliye: lambe mix filter me nikal jayenge, peeche purti rahe.
  initYtdlp();
  const { stdout } = await run(ytdlpStatus().path, ['-J', '--flat-playlist', '--no-warnings', '-4', `ytsearch${limit + 4}:${query}`], { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
  const json = JSON.parse(stdout);
  // channel + viewCount bhi rakho (2026-11-06): merged ranking ko official
  // channel (T-Series aadi) aur views ki taakat naapne ke liye chahiye.
  // 10-min cap se lambe mix/playlist yahin rok do (MAX_SONG_SEC).
  const results = (json.entries || []).filter((e) => !(Number(e.duration) > MAX_SONG_SEC)).slice(0, limit).map(e => ({ id: e.id, title: e.title, duration: e.duration || null, url: `https://www.youtube.com/watch?v=${e.id}`, channel: e.channel || e.uploader || '', viewCount: Number(e.view_count) || 0 }));
  await pool.query('insert into music_cache (query_hash, query_text, results) values ($1,$2,$3) on conflict do nothing',
    [hash, query, JSON.stringify(results)]);
  return results;
}
// Back-compat: sub-bots (bots/index.js) abhi bhi top-3 wale naam se bulate hain.
export async function searchTop3(query) {
  return searchSongs(query, 3);
}

// Downloads EK baar me sirf 1 (V2.1, plan §3 fix #5 — free-tier RAM par 3 = OOM risk)
let dlActive = 0; const dlQueue = [];
async function dlGate() { if (dlActive >= 1) await new Promise(r => dlQueue.push(r)); dlActive++; }
function dlDone() { dlActive--; const n = dlQueue.shift(); if (n) n(); }

function diskCached(videoId) {
  const exact = path.join(env.musicTmp, `${videoId}.m4a`);
  if (fs.existsSync(exact)) return exact;
  try {
    const f = fs.readdirSync(env.musicTmp).find(x => x.startsWith(videoId + '.') && !x.includes('.src.'));
    return f ? path.join(env.musicTmp, f) : null;
  } catch { return null; }
}

export async function downloadAudio(videoId) {
  fs.mkdirSync(env.musicTmp, { recursive: true });
  const m4a = path.join(env.musicTmp, `${videoId}.m4a`);
  if (fs.existsSync(m4a)) return m4a;
  await dlGate();
  try { return await _downloadAudio(videoId, m4a); } finally { dlDone(); }
}

async function _downloadAudio(videoId, m4aPath) {
  // Verified recipe: datacenter IP se seedha audio format 403 deta hai;
  // android player_client se format 18 (mp4, AAC audio) chalta hai -> ffmpeg -c:a copy se .m4a (bina re-encode).
  // 2026-11-07 ke Render logs ki pakki wajah: kuch videos par YouTube
  // "Failed to extract any player response" deta hai — wahi video bahar ke
  // IP se turant khul gaya, matlab rukawat server ke mahol se hai. Isliye
  // har koshish me IPv4 (-4 — YouTube IPv6 blocks ko zyada distrust karta
  // hai) aur modern binary par --js-runtimes node (downloadArgs dekho).
  // Client badal kar 3 koshishen (android -> tv -> ios), wahi format.
  // Teeno fail = download_failed (phir worker ka cross-source rescue hai).
  initYtdlp();
  const { path: bin, modern } = ytdlpStatus();
  const srcPath = path.join(env.musicTmp, `${videoId}.src.mp4`);
  let downloaded = false;
  let lastErr = null;
  for (const client of ['android', 'tv', 'ios']) {
    try {
      await run(bin, downloadArgs(client, srcPath, videoId, modern),
        { timeout: 75_000, maxBuffer: 4 * 1024 * 1024 });
      downloaded = true;
      break;
    } catch (e) { lastErr = e; try { fs.unlinkSync(srcPath); } catch { /* ignore */ } }
  }
  if (!downloaded) {
    console.error('[music] ytdlp failed (saare clients):', String(lastErr?.stderr || lastErr?.message || '').slice(0, 500));
    throw new Error('download_failed');
  }
  try {
    await run(FFMPEG, ['-y', '-i', srcPath, '-vn', '-c:a', 'copy', m4aPath],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    console.error('[music] ffmpeg failed:', String(e.stderr || e.message || '').slice(0, 500));
    throw new Error('convert_failed');
  } finally {
    try { fs.unlinkSync(srcPath); } catch {}
  }
  if (!fs.existsSync(m4aPath)) throw new Error('download_failed');
  if (fs.statSync(m4aPath).size > 16 * 1024 * 1024) throw new Error('audio_too_large'); // WhatsApp media cap
  return m4aPath;
}

// ---------- SOUNDCLOUD — TEESRA SOURCE (2026-11-07, Hero ka order) ----------
// Phonk/remix/Punjabi ka woh hissa jo YouTube par kamzor padta hai.
// Search bhi yt-dlp se (scsearch), download bhi — koi API key nahi.
// Fail ho to search [] degi aur delivery throw karegi; merged search aur
// worker ka rescue use sambhal lete hain — SC band ho to baaki do source
// bina ruke chalte rehte hain.
export function mapScEntry(e) {
  if (!e?.id || !e?.url) return null;
  const dur = Number(e.duration) || null;
  return {
    source: 'soundcloud', id: String(e.id), title: e.title || 'Gaana',
    duration: dur, durationSec: dur, url: e.url,
    channel: e.uploader || '', viewCount: Number(e.view_count || e.playback_count) || 0,
  };
}

export async function searchSongsSc(query, limit = 8) {
  const hash = crypto.createHash('sha256').update(`sc1:${limit}:${query.toLowerCase().trim()}`).digest('hex');
  const { rows } = await pool.query('select results from music_cache where query_hash=$1', [hash]);
  if (rows[0]) return rows[0].results;
  initYtdlp();
  const { stdout } = await run(ytdlpStatus().path, ['-J', '--flat-playlist', '--no-warnings', '-4', `scsearch${limit + 4}:${query}`], { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
  const json = JSON.parse(stdout);
  const results = (json?.entries || []).map(mapScEntry).filter(Boolean)
    .filter((t) => !(t.duration > MAX_SONG_SEC)).slice(0, limit);
  await pool.query('insert into music_cache (query_hash, query_text, results) values ($1,$2,$3) on conflict do nothing',
    [hash, query, JSON.stringify(results)]);
  return results;
}

/** SoundCloud download ke arguments — audio ko saaf .m4a me nikalo
 *  (pipeline ki baaki files bhi .m4a hi hain). Pure. */
export function scDownloadArgs(url, outTemplate, modern) {
  return ['--no-warnings', '-4',
    ...(modern ? ['--js-runtimes', 'node'] : []),
    '--ffmpeg-location', FFMPEG,
    '--extract-audio', '--audio-format', 'm4a', '--audio-quality', '0',
    '-o', outTemplate, url];
}

async function downloadScAudio(scId, url) {
  fs.mkdirSync(env.musicTmp, { recursive: true });
  const m4a = path.join(env.musicTmp, `sc_${scId}.m4a`);
  if (fs.existsSync(m4a)) return m4a;
  if (!url) throw new Error('sc_no_url');
  await dlGate();
  try {
    initYtdlp();
    const { path: bin, modern } = ytdlpStatus();
    await run(bin, scDownloadArgs(url, path.join(env.musicTmp, `sc_${scId}.%(ext)s`), modern),
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    console.error('[music] sc download failed:', String(e?.stderr || e?.message || '').slice(0, 400));
    throw new Error('download_failed');
  } finally { dlDone(); }
  if (!fs.existsSync(m4a)) throw new Error('download_failed');
  return m4a;
}

// Vault-aware getter — YouTube wali hi kataar (vault -> disk -> download),
// par chaabi 'sc:<id>' / file 'sc_<id>.m4a' ke alag namespace me.
export async function getAudioForScTrack(scId, url, title = '') {
  fs.mkdirSync(env.musicTmp, { recursive: true });
  const key = `sc:${scId}`;
  if (telegram.vaultEnabled()) {
    const { rows } = await pool.query('select * from media_vault where video_id=$1', [key]).catch(() => ({ rows: [] }));
    if (rows[0]?.file_id) {
      const dest = path.join(env.musicTmp, `sc_${scId}.m4a`);
      const ok = await telegram.downloadByFileId(rows[0].file_id, dest);
      if (ok && fs.existsSync(dest) && fs.statSync(dest).size <= 16 * 1024 * 1024) return dest;
      await pool.query('delete from media_vault where video_id=$1', [key]).catch(() => {});
    }
  }
  const disk = path.join(env.musicTmp, `sc_${scId}.m4a`);
  if (fs.existsSync(disk)) return disk;
  const file = await downloadScAudio(scId, url);
  if (telegram.vaultEnabled()) {
    telegram.uploadFile(env.telegramVaultChatId, file, key)
      .then(async (up) => {
        if (up?.file_id) {
          await pool.query(
            `insert into media_vault (video_id, title, file_id, message_id, size) values ($1,$2,$3,$4,$5)
             on conflict (video_id) do update set file_id=excluded.file_id, message_id=excluded.message_id, size=excluded.size`,
            [key, title || null, up.file_id, up.message_id, fs.statSync(file).size]).catch(() => {});
        }
      })
      .catch(() => {});
  }
  return file;
}

// ---------- DEAD VIDEO NISHAAN (2026-11-07, Hero: "jo bajta nahi woh list me kyun hai") ----------
// Jo YT video 2+ baar download fail ho jaye, us par nishan lag jata hai aur
// searchMusicMerged use list se hata deta hai. Nishan kabhi purana nahi
// hota — video asal me mare hue hote hain (private/region-block), aur
// galti se koi zinda video phas jaye to bhi usi gaane ke dusre uploads
// list me rehte hain.
let deadTableReady = null;
function ensureDeadTable() {
  if (!deadTableReady) {
    deadTableReady = pool.query(`create table if not exists music_dead (
      video_id text primary key, fails integer not null default 0, updated_at text not null
    )`).catch((e) => { deadTableReady = null; throw e; });
  }
  return deadTableReady;
}
export async function noteDownloadFailure(videoId) {
  if (!videoId) return;
  await ensureDeadTable();
  await pool.query(
    `insert into music_dead (video_id, fails, updated_at) values ($1, 1, $2)
     on conflict (video_id) do update set fails = music_dead.fails + 1, updated_at = excluded.updated_at`,
    [videoId, new Date().toISOString()]);
}
export async function deadVideoIds(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return new Set();
  await ensureDeadTable();
  const ph = list.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await pool.query(
    `select video_id from music_dead where fails >= 2 and video_id in (${ph})`, list);
  return new Set(rows.map((r) => r.video_id));
}

// Vault-aware getter (V2.1, plan §2.2): order = Telegram media_vault -> local disk -> yt-dlp cold.
// Cold ke baad gaana BACKGROUND me vault me chala jata hai — user ka reply us par nahi rukta.
export async function getAudioForVideo(videoId, title = '') {
  fs.mkdirSync(env.musicTmp, { recursive: true });
  // 1) Telegram vault
  if (telegram.vaultEnabled()) {
    const { rows } = await pool.query('select * from media_vault where video_id=$1', [videoId]).catch(() => ({ rows: [] }));
    if (rows[0]?.file_id) {
      const dest = path.join(env.musicTmp, `${videoId}.m4a`);
      const ok = await telegram.downloadByFileId(rows[0].file_id, dest);
      if (ok && fs.existsSync(dest) && fs.statSync(dest).size <= 16 * 1024 * 1024) return dest;
      // Dead file_id — row hatao aur neeche ke raste par giro (plan fix #6)
      await pool.query('delete from media_vault where video_id=$1', [videoId]).catch(() => {});
    }
  }
  // 2) Local disk cache
  const disk = diskCached(videoId);
  if (disk) return disk;
  // 3) Cold download (yt-dlp) + background vault upload
  const file = await downloadAudio(videoId);
  if (telegram.vaultEnabled()) {
    telegram.uploadFile(env.telegramVaultChatId, file, videoId)
      .then(async (up) => {
        if (up?.file_id) {
          await pool.query(
            `insert into media_vault (video_id, title, file_id, message_id, size) values ($1,$2,$3,$4,$5)
             on conflict (video_id) do update set file_id=excluded.file_id, message_id=excluded.message_id, size=excluded.size`,
            [videoId, title || null, up.file_id, up.message_id, fs.statSync(file).size]).catch(() => {});
        }
      })
      .catch(() => {});
  }
  return file;
}
