import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ffmpegStatic from 'ffmpeg-static';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_BIN || ffmpegStatic || 'ffmpeg';

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
let dlActive = 0; const dlQueue = [];
async function dlGate() { if (dlActive >= 3) await new Promise(r => dlQueue.push(r)); dlActive++; }
function dlDone() { dlActive--; const n = dlQueue.shift(); if (n) n(); }
export async function downloadAudio(videoId) {
  fs.mkdirSync(env.musicTmp, { recursive: true });
  const m4a = path.join(env.musicTmp, `${videoId}.m4a`);
  if (fs.existsSync(m4a)) return m4a;
  await dlGate();
  try { return await _downloadAudio(videoId, m4a); } finally { dlDone(); }
}
async function _downloadAudio(videoId, m4aPath) {
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
  if (fs.statSync(m4aPath).size > 16 * 1024 * 1024) throw new Error('audio_too_large');
  return m4aPath;
}
