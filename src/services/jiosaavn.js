import crypto from 'node:crypto';
import { pool } from '../db/pool.js';

// FAST MUSIC v2 (2026-10-24): primary source = JioSaavn ka APNA api.php
// (www.jiosaavn.com/api.php) — koi third-party wrapper NAHI. Wrapper saavn.dev
// probe me mara hua mila (empty reply), jabki source khud 1-2s me jawab deta hai.
// Chain: search.getResults -> encrypted_media_url -> DES decrypt -> aac.saavncdn.com URL.
// Decryption open-source ecosystem (sumitkolhe/jiosaavn-api, jiosaavn-api-client) ka
// documented tareeka hai: DES (ECB, PKCS7) key '38346591'. Node ke OpenSSL 3 me plain
// 'des-ecb' band hai — isiliye 'des-ede3-ecb' with same key 3 baar (= single DES ke
// bilkul barabar, aur 2026-10-24 ko asal gaane par verify kiya gaya).
const API_BASE = 'https://www.jiosaavn.com/api.php';
const DES_KEY = Buffer.from('38346591'.repeat(3), 'utf8'); // 24 bytes for EDE3

export const META_TTL_MS = 24 * 3600_000; // metadata cache: 24 ghante
export const URL_TTL_MS = 45 * 60_000;    // download URL sirf 45 min fresh maano —
// WAJAH: JioSaavn ke media URLs time-limited hote hain. Metadata (naam/artist/ID)
// 24h chalega, lekin purana download URL CDN par dead mil sakta hai; isiliye bhejne
// se pehle ID se fresh URL lena hi safe hai. (URL refresh = 1 halki API call.)

const FETCH_TIMEOUT_MS = 15_000;

// ---------- HTTP ----------
async function apiCall(call, extra = {}) {
  const params = new URLSearchParams({ __call: call, _format: 'json', _marker: '0', cc: 'in', includeMetaTags: '1', ...extra });
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}?${params}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`jiosaavn_http_${res.status}`);
    return await res.json();
  } finally { clearTimeout(to); }
}

// ---------- Pure helpers (harness inhi ko test karta hai) ----------
// Encrypted media URL -> asal CDN URL. Fail ho to null (guess kabhi nahi).
export function decryptMediaUrl(encrypted) {
  try {
    const data = Buffer.from(String(encrypted || ''), 'base64');
    if (!data.length || data.length % 8 !== 0) return null;
    const d = crypto.createDecipheriv('des-ede3-ecb', DES_KEY, null);
    const out = Buffer.concat([d.update(data), d.final()]).toString('utf8').replace(/\0+$/, '');
    return out.startsWith('http') ? out : null;
  } catch { return null; }
}
// Decrypted URL hamesha _96 par aata hai; quality suffix badalna CDN par verify hai
// (_96/_160/_320 teeno asal audio dete hain — probe 2026-10-24).
export function withQuality(url, kbps) {
  if (!url) return url;
  return url.replace(/_\d+(\.mp4)$/, `_${kbps}$1`);
}
// 320kbps flag asal ho to 320, warna 160 (base rendition 96 har jagah garanty nahi
// chahiye isiliye default 160 — size/quality ka santulan; worker badi file par
// khud downgrade bhi karta hai).
export function preferredUrl(decrypted96, song) {
  if (!decrypted96) return null;
  return song?.['320kbps'] === 'true' ? withQuality(decrypted96, 320) : withQuality(decrypted96, 160);
}
// Cache faisla: URL kitna purana hai us par 'use' ya 'refresh'
export function decideUrlAction(row, now = Date.now()) {
  if (!row?.download_url || !row?.url_fetched_at) return 'refresh';
  const age = now - Date.parse(row.url_fetched_at);
  return Number.isFinite(age) && age >= 0 && age < URL_TTL_MS ? 'use' : 'refresh';
}
export function isMetaFresh(row, now = Date.now()) {
  if (!row?.updated_at) return false;
  const age = now - Date.parse(row.updated_at);
  return Number.isFinite(age) && age >= 0 && age < META_TTL_MS;
}
// Raw JioSaavn song object -> humara track shape (masterMenu ke YT results jaisa:
// UI r.title/r.duration padhta hai; lyrics parseTrackQuery 'Artist — Song' maangta hai).
export function mapSong(s) {
  if (!s?.id) return null;
  const name = String(s.song || s.title || 'Gaana').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const artist = String(s.singers || s.primary_artists || s.music || '').trim();
  const dur = Number(s.duration) || null;
  return {
    source: 'jiosaavn',
    id: s.id,
    title: artist ? `${artist} — ${name}` : name,
    song: name,
    artist,
    duration: dur,
    durationSec: dur,
    image: s.image ? String(s.image).replace('150x150', '500x500') : null,
    url: s.perma_url || null,
  };
}

// ---------- Cache (saavn_cache) ----------
async function upsertCache(track, downloadUrl, rawSong) {
  if (!track?.id) return;
  const now = new Date().toISOString();
  const meta = rawSong ? JSON.stringify({
    album: rawSong.album || null, image: track.image, permaUrl: track.url,
    kbps320: rawSong['320kbps'] === 'true', encrypted: rawSong.encrypted_media_url || null,
  }) : null;
  await pool.query(
    `insert into saavn_cache (song_id, title, artist, duration_sec, image, download_url, url_fetched_at, meta_json, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (song_id) do update set
       title=excluded.title, artist=excluded.artist, duration_sec=excluded.duration_sec,
       image=excluded.image,
       download_url=coalesce(excluded.download_url, saavn_cache.download_url),
       url_fetched_at=coalesce(excluded.url_fetched_at, saavn_cache.url_fetched_at),
       meta_json=coalesce(excluded.meta_json, saavn_cache.meta_json),
       updated_at=excluded.updated_at`,
    [track.id, track.title, track.artist || null, track.durationSec || null, track.image || null,
     downloadUrl || null, downloadUrl ? now : null, meta, now]).catch(() => {});
}
async function cacheRow(songId) {
  const { rows } = await pool.query('select * from saavn_cache where song_id=$1', [songId]).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

// Details by ID (batch bhi chalta hai) — fresh encrypted URL isi se aata hai
async function fetchDetails(songId) {
  const j = await apiCall('song.getDetails', { pids: songId });
  const s = j?.[songId];
  if (!s) throw new Error('jiosaavn_details_empty');
  return s;
}

// songId ke liye taaza download URL: cache ka URL 45 min ke andar ho to wahi,
// warna details se fresh decrypt (cache bhi update ho jata hai).
export async function getFreshUrl(songId) {
  const row = await cacheRow(songId);
  if (decideUrlAction(row) === 'use') return { url: row.download_url, fromCache: true };
  const s = await fetchDetails(songId);
  const track = mapSong(s);
  const url = preferredUrl(decryptMediaUrl(s.encrypted_media_url), s);
  if (!url) throw new Error('jiosaavn_decrypt_failed');
  await upsertCache(track, url, s);
  return { url, fromCache: false };
}
// Metadata chahiye ho (worker/UI) to: fresh ho to cache se, warna details se
export async function getSongMeta(songId) {
  const row = await cacheRow(songId);
  if (row && isMetaFresh(row)) return row;
  const s = await fetchDetails(songId);
  const track = mapSong(s);
  const url = preferredUrl(decryptMediaUrl(s.encrypted_media_url), s);
  await upsertCache(track, url, s);
  return cacheRow(songId);
}

// ---------- Search (PRIMARY) ----------
// search.getResults results me encrypted_media_url saath aata hai — search ke saath hi
// har gaana cache me chala jata hai (metadata + URL), taaki pick par taaza URL turant mile.
export async function searchSongsSaavn(query, limit = 8) {
  const j = await apiCall('search.getResults', { q: String(query || ''), p: '1', n: String(limit) });
  const raw = Array.isArray(j?.results) ? j.results : [];
  const tracks = [];
  for (const s of raw) {
    const track = mapSong(s);
    if (!track) continue;
    const url = preferredUrl(decryptMediaUrl(s.encrypted_media_url), s);
    // URL na bane (kuch gaane DRM/Pro-only hote hain) to track list me rakho hi mat —
    // user ko woh gaana dikhana hi bekaar hai jo baj hi nahi sakta.
    if (!url) continue;
    tracks.push(track);
    upsertCache(track, url, s).catch(() => {}); // fire-and-forget: cache fail ho to search na ruke
  }
  return tracks.slice(0, limit);
}

// ---------- Trending pre-cache ----------
// Launch data -> charts me 'Trending' playlist -> playlist.getDetails (48 ke aas-paas
// gaane, encrypted URL ke saath). Sirf metadata+URL cache hota hai — poore gaane
// pre-download NAHI (free-tier RAM/bandwidth ki hifazat; pehli asal request par
// gaana vault me jaakar hamesha ke liye fast ho jata hai).
const SEED_QUERIES = ['trending songs india', 'latest bollywood hits', 'punjabi latest hits', 'arijit singh hits'];
export async function precacheTrending(limit = 50) {
  const seen = new Map();
  const addSongs = (list) => {
    for (const s of list || []) {
      const track = mapSong(s);
      if (track && !seen.has(track.id)) seen.set(track.id, { track, raw: s });
    }
  };
  try {
    const launch = await apiCall('webapi.getLaunchData');
    const chart = (launch?.charts || []).find(c => /trending/i.test(c.title || '')) || (launch?.charts || [])[0];
    if (chart?.id) {
      const pl = await apiCall('playlist.getDetails', { listid: String(chart.id) });
      addSongs(pl?.songs);
    }
    addSongs((launch?.new_trending || []).filter(x => x.type === 'song').map(x => x.details));
  } catch (e) { console.error('[jiosaavn] trending launch path fail:', e?.message || e); }
  // Launch se 50 na bane to seed queries se bharo
  for (const q of SEED_QUERIES) {
    if (seen.size >= limit) break;
    try { const j = await apiCall('search.getResults', { q, p: '1', n: '20' }); addSongs(j?.results); }
    catch { /* agla seed */ }
  }
  let cached = 0;
  for (const { track, raw } of [...seen.values()].slice(0, limit)) {
    const url = preferredUrl(decryptMediaUrl(raw.encrypted_media_url), raw);
    if (!url) continue;
    await upsertCache(track, url, raw);
    cached++;
  }
  console.log(`[jiosaavn] trending pre-cache: ${cached} gaane cache me`);
  return cached;
}

let precacheStarted = false;
export function startTrendingPrecache() {
  if (precacheStarted) return;
  precacheStarted = true;
  const run = () => { precacheTrending().catch(() => {}); };
  const t = setTimeout(run, 30_000); // boot ke ~30s baad, non-blocking
  if (t.unref) t.unref();
  const iv = setInterval(run, 24 * 3600_000); // roz ek baar
  if (iv.unref) iv.unref();
}
