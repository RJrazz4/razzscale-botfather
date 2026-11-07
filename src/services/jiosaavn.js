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
// DELIVERY CAP (2026-11-07, Hero ki shikayat par): WhatsApp audio ki had
// 16MB hai — 10 minute (600s) se lamba "gaana" asal me mix/playlist hota
// hai, woh download bhi nahi hota aur bheja bhi nahi ja sakta. Bot woh
// sujhaye hi na jo de na sake: teeno source (Saavn/YT/merged) yahi cap
// maante hain. Cap yahan isliye hai kyunki baaki dono module yahi se lete hain.
export const MAX_SONG_SEC = 600;
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
  // WAJAH (2026-11-06 bug): search response ka 'singers' field kabhi DUSRE gaane ka
  // artist chipka deta hai (DevSena case: singers='Arijit Singh' tha, asal gaana
  // Mukesh Gurjar ka — primary_artists + primary_artists_id dono sahi the).
  // Isliye artist ka bharosa: primary_artists pehle, singers sabse aakhir me.
  const artist = String(s.primary_artists || s.music || s.singers || '').trim();
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

// ---------- Search ranking (2026-11-06 raat — Hero ki shikayat par) ----------
// MASLA (live saboot ke saath): Saavn ki apni khoj lyric-line wali query par
// cover/lofi/bhakti versions upar rakhti hai aur kai mashhoor official gaane
// (maslan Ek Villain ka 'Zaroorat') khoj me aate hi nahi — API ka index hi
// aisa hai. Isliye: (1) kai queryon se ummeedwar jama karo, (2) har ummeedwar
// ko ASAL nishaanon par naapo — kitni baar baja (play_count), label kitna
// bada, title query se kitna milta hai, aur cover-wale shabd kitne hain.
// fold: chhote akshar + z->j (Zaroorat/Jarurat ek hi shabd maano — Hinglish
// spelling ka jhanjhat khatm) + bekaar nishaan hatao.
export function foldText(s) {
  return String(s || '').toLowerCase().replace(/z/g, 'j').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const QUERY_STOPWORDS = new Set(['mujhe', 'mujhko', 'teri', 'tere', 'tera', 'meri', 'mera', 'mere', 'hai', 'hain', 'ho', 'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'mai', 'ne', 'bhi', 'song', 'gaana', 'gana', 'full', 'video', 'audio', 'hindi', 'new', 'best', 'top']);
export function distinctiveWords(query) {
  const words = foldText(query).split(' ').filter((w) => w.length >= 3 && !QUERY_STOPWORDS.has(w));
  if (words.length) return [...new Set(words)];
  return [...new Set(foldText(query).split(' ').filter((w) => w.length >= 2))];
}
const MAJOR_LABEL_WORDS = ['t series', 'tseries', 'sony music', 'jee music', 'zee music', 'yrf', 'tips', 'saregama', 'universal music', 'warner music', 'aditya music', 'lahari', 'venus', 'eros', 'times music', 'speed records', 'geet mp3', 'white hill', 'hitz music', 'vyrl'];
const PENALTY_WORDS = ['lofi', 'slowed', 'reverb', '8d', 'nightcore', 'karaoke', 'instrumental', 'ringtone', 'cover', 'flute', 'violin', 'bhakti', 'dj mix', 'dj remix'];
// Loose fold: mel naapne ke liye — oo->u, ee->i (Zaroorat=Jarurat, Deewana=Diwana).
// Bina iske asal title 'Zaroorat' user ke 'Jarurat' se mil hi nahi pata tha.
export function looseFold(s) {
  return foldText(s).replace(/oo/g, 'u').replace(/ee/g, 'i');
}
const GENERIC_QUERY_WORDS = new Set(['song', 'gaana', 'gana', 'full', 'video', 'audio', 'hindi', 'new', 'best', 'top', 'official', 'lyrics', 'lyrical']);
// Query ke shabdon ka title se mel: khaas shabd (distinctive) dogune vajan ke,
// baaki aam shabd ikahre. Sirf khaas shabd ginne par 'Jarurat' naam ka koi bhi
// alag gaana poori kahani wale asal gaane se upar chala jata tha (live test).
export function queryOverlap(query, titleText) {
  const distinct = new Set(distinctiveWords(query));
  const words = [...new Set(foldText(query).split(' ').filter((w) => w.length >= 2 && !GENERIC_QUERY_WORDS.has(w)))];
  if (!words.length) return 0;
  const titleLoose = looseFold(titleText);
  const titleWords = new Set(titleLoose.split(' '));
  let got = 0, total = 0;
  for (const w of words) {
    const weight = distinct.has(w) ? 2 : 1;
    total += weight;
    if (titleWords.has(looseFold(w)) || titleLoose.includes(looseFold(w))) got += weight;
  }
  return total ? got / total : 0;
}
export function scoreSaavnSong(s, query) {
  const titleF = foldText(s.song || s.title || '');
  const albumF = foldText(s.album || '');
  const artistF = foldText(s.primary_artists || s.music || s.singers || '');
  const labelF = foldText(s.label || '');
  const allText = `${titleF} ${albumF} ${artistF} ${labelF}`;
  const overlap = queryOverlap(query, s.song || s.title || '');
  const plays = Number(s.play_count) || 0;
  let score = 4 * overlap + 1.15 * Math.log10(plays + 1);
  // Artist bonus (Hero ka official-channel wala niyam, Saavn taraf): user ne
  // artist ka naam likha ho aur gaana usi artist ka ho to upar rakho.
  const qWordsForArtist = foldText(query).split(' ').filter((w) => w.length >= 3);
  if (qWordsForArtist.some((w) => artistF.split(/[\s,]+/).includes(w))) score += 1.2;
  if (MAJOR_LABEL_WORDS.some((w) => labelF.includes(w))) score += 1.2;
  if (albumF && albumF !== titleF) score += 0.4;
  const queryF = foldText(query);
  for (const w of PENALTY_WORDS) if (allText.includes(w) && !queryF.includes(w)) score -= 2.2;
  if (queryF.includes('remix')) { /* remix maanga hai to sazaa nahi */ } else if (allText.includes('remix')) score -= 2.2;
  const lang = String(s.language || '').toLowerCase();
  if ((lang === 'bhojpuri' || lang === 'rajasthani') && !queryF.includes(lang)) score -= 1.2;
  const dur = Number(s.duration) || 0;
  if (dur && dur < 100) score -= 1.2;
  if (dur > 560) score -= 0.8;
  return Math.round(score * 100) / 100;
}
// Raw results -> naap-tol ke saath kram (sabse achha pehle) + nakal hatao.
// Nakal = ek hi gaana kai compilation albums me (Tum Hi Ho 4 baar aaya tha) —
// pehchan: bracket-hataya title ek ho aur plays lagbhag barabar (wahi asal
// recording dobara listed) ya pehla artist ek ho — sabse achha score rakho.
export function rankSaavnRaw(rawList, query) {
  const scored = (rawList || []).map((s) => ({ s, score: scoreSaavnSong(s, query) }));
  scored.sort((a, b) => b.score - a.score);
  const seenIds = new Set();
  const keptByTitle = new Map();
  const out = [];
  for (const { s, score } of scored) {
    if (seenIds.has(s.id)) continue;
    const titleCore = foldText(String(s.song || s.title || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\([^)]*\)/g, ' '));
    const firstArtist = foldText(s.primary_artists || '').split(',')[0].trim();
    const plays = Number(s.play_count) || 0;
    const kept = keptByTitle.get(titleCore) || [];
    const isDup = kept.some((k) => k.firstArtist === firstArtist || (Math.max(k.plays, plays) > 0 && Math.abs(k.plays - plays) <= 0.05 * Math.max(k.plays, plays)));
    if (isDup) continue;
    kept.push({ firstArtist, plays });
    keptByTitle.set(titleCore, kept);
    seenIds.add(s.id);
    out.push({ raw: s, score });
  }
  return out;
}

// ---------- Search (PRIMARY) ----------
// Khoj ka naya tareeka: sirf user ki query nahi — uske khaas shabdon wali
// query bhi saath chalao (lyric-line ki jagah asal title aksar wahi hota hai),
// saare ummeedwar milakar rank karo, phir top wale do.
export async function searchSongsSaavn(query, limit = 8) {
  const q = String(query || '').trim();
  const queries = [q];
  const distinct = distinctiveWords(q).join(' ');
  if (distinct && foldText(distinct) !== foldText(q)) queries.push(distinct);
  const rawById = new Map();
  for (const qq of queries.slice(0, 2)) {
    try {
      const j = await apiCall('search.getResults', { q: qq, p: '1', n: '20' });
      for (const s of Array.isArray(j?.results) ? j.results : []) if (s?.id && !rawById.has(s.id)) rawById.set(s.id, s);
    } catch { /* ek query fail ho to dusri se kaam chalega */ }
  }
  const ranked = rankSaavnRaw([...rawById.values()], q);
  const tracks = [];
  for (const { raw: s, score } of ranked) {
    if (tracks.length >= limit) break;
    const track = mapSong(s);
    if (!track) continue;
    // 10-min cap (MAX_SONG_SEC): lamba mix list me aaye hi na.
    if (track.durationSec && track.durationSec > MAX_SONG_SEC) continue;
    const url = preferredUrl(decryptMediaUrl(s.encrypted_media_url), s);
    // URL na bane (kuch gaane DRM/Pro-only hote hain) to track list me rakho hi mat —
    // user ko woh gaana dikhana hi bekaar hai jo baj hi nahi sakta.
    if (!url) continue;
    track._score = score;
    tracks.push(track);
    upsertCache(track, url, s).catch(() => {}); // fire-and-forget: cache fail ho to search na ruke
  }
  return tracks;
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
