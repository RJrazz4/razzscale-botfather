import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';
const run = promisify(execFile);

// yt-dlp: top-3 search (flat) + chune hue gaane ka audio download (mp3, chhota size)
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
  const out = path.join(env.musicTmp, `${videoId}.mp3`);
  if (fs.existsSync(out)) return out;
  await dlGate();
  try { return await _downloadAudio(videoId, out); } finally { dlDone(); }
}
async function _downloadAudio(videoId, out) {
  await run(env.ytdlp, ['-x', '--audio-format', 'mp3', '--audio-quality', '5', '--no-warnings', '-o', path.join(env.musicTmp, '%(id)s.%(ext)s'), `https://www.youtube.com/watch?v=${videoId}`],
    { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  const size = fs.statSync(out).size;
  if (size > 16 * 1024 * 1024) throw new Error('audio_too_large'); // WhatsApp media cap
  return out;
}
