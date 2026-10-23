import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpegStatic from 'ffmpeg-static';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
import * as telegram from './telegram.js';
const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN || ffmpegStatic || 'ffmpeg';

// yt-dlp: top-3 search (flat) + chune hue gaane ka audio download.
export async function searchTop3(query) {
  const hash = crypto.createHash('sha256').update(query.toLowerCase().trim()).digest('hex');
  const { rows } = await pool.query('select results from music_cache where query_hash=$1', [hash]);
  if (rows[0]) return rows[0].results;
  const { stdout } = await run(env.ytdlp, ['-J', '--flat-playlist', '--no-warnings', `ytsearch3:${query}`], { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
  const json = JSON.parse(stdout);
  const results = (json.entries || []).slice(0, 3).map(e => ({ id: e.id, title: e.title, duration: e.duration || null, url: `https://www.youtube.com/watch?v=${e.id}` }));
  await pool.query('insert into music_cache (query_hash, query_text, results) values ($1,$2,$3) on conflict do nothing',
    [hash, query, JSON.stringify(results)]);
  return results;
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
  const srcPath = path.join(env.musicTmp, `${videoId}.src.mp4`);
  try {
    await run(env.ytdlp, ['-f', '18/best[height<=360]/best', '--no-warnings',
      '--extractor-args', 'youtube:player_client=android',
      '-o', srcPath, `https://www.youtube.com/watch?v=${videoId}`],
      { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    console.error('[music] ytdlp failed:', String(e.stderr || e.message || '').slice(0, 500));
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
