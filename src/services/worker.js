import fs from 'node:fs';
import path from 'node:path';
import { pool, logUsage, getFlow, setFlow } from '../db/pool.js';
import { env } from '../config/env.js';
import * as evo from './transport.js';
import * as graph from './graph-cloud.js';
import * as telegram from './telegram.js';
import { getAudioForVideo, searchSongs, noteDownloadFailure, initYtdlp, getAudioForScTrack, searchSongsSc } from './music.js';
import { getFreshUrl, withQuality, searchSongsSaavn } from './jiosaavn.js';
import { isSongLength, pickSaavnRescue, pickAltUpload, pickAltUploads, rescueQueryFromTitle } from './musicSearch.js';
import { markSent } from './musicMemory.js';
import { startSeeder } from './librarySeeder.js';
import { freeChat, workWrite } from './llm.js';
import { notifyOwner } from './owner.js';

// Async Worker (Architecture V2.1, plan §3): heavy kaam (music download, AI chat) webhook handler
// se bahar, SQLite jobs table ke peeche. Idempotency: ek idempotency_key wala kaam do baar nahi bhejta.
const TIMEOUTS = { music_download: 330_000, music_prefetch: 240_000, ai_chat: 120_000, lyrics: 30_000, likhai_work: 120_000 };
const MAX_ATTEMPTS = 2;

// ⭐ Escalation ki shabd-pakad (v1): Boss/insaan se baat, ya action-level
// banwane ki maang. Jhooti pakad (false positive) par bhi customer ko sahi
// rasta hi milta hai — isiliye ye sasti chaal surakshit hai.
const ESCALATION_WORDS = ['boss', 'insaan se', 'insan se', 'malik se', 'owner se', 'baat karao', 'baat karwa', 'milao', 'mila do', 'call kar', 'number do', 'number batao', 'bot banwa', 'bot banana hai', 'website banwa', 'app banwa', 'automation karwa', 'tum bana do', 'aap bana do', 'khud kar do'];
function isEscalation(text = '') {
  const l = String(text).toLowerCase();
  return ESCALATION_WORDS.some((w) => l.includes(w));
}
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

export async function claimNext() {
  // Priority: user ke pick (music_download) hamesha pehle, baaki kaam beech
  // me, prefetch sabse peeche — kataar me pada prefetch kisi user ko kabhi
  // intezaar nahi karayega (2026-11-07).
  const { rows } = await pool.query(
    `update jobs set status='running', attempts=attempts+1, updated_at=$1
     where id = (select id from jobs where status='pending'
       order by (case when type='music_download' then 0 when type='music_prefetch' then 2 else 1 end), id asc limit 1)
     returning *`, [new Date().toISOString()]);
  return rows[0] || null;
}
async function finish(job, ok, result) {
  if (ok) {
    await pool.query("update jobs set status='done', result=$2, updated_at=$3 where id=$1",
      [job.id, result || null, new Date().toISOString()]).catch(() => {});
  } else if (job.attempts >= MAX_ATTEMPTS || job.type === 'music_download') {
    // music_download par job-retry NAHI: uske andar ka rescue hi dusri
    // koshish hai. Retry wahi fail hua download dohrata tha — 2026-11-07
    // 16:22 wale case me user ko 2× (kul ~5 min) intezaar karna pada.
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

// Post-audio ACTION LIST (TAP-FIRST) — success par 4 rows: lyrics /
// music_list (wahi results list dobara) / music_new / menu; failure par
// gaana nahi aaya, isliye lyrics aur list wale rows nahi — sirf music_new/menu.
// RowIds masterMenu me text bankar handle hote hain ('lyrics' keyword branch,
// 'music_list' branch, 'music_new'/'mz'/TAP mapping, 'menu' keyword branch,
// 'nav_menu' global nav).
// Return: list bheji gayi ya nahi (false par caller text fallback bhejta hai).
async function sendMusicActionList(instance, to, ok) {
  const rows = ok
    ? [
      { rowId: 'lyrics', title: '🔤 Is gaane ke Lyrics', description: 'Isi gaane ke bol dekho' },
      { rowId: 'music_list', title: '🎵 Gaana chuno', description: 'Wahi list dobara — dusra gaana chuno' },
      { rowId: 'music_new', title: '🔍 Naya gaana khojo', description: 'Koi aur gaana sunna hai' },
      { rowId: 'menu', title: '🏠 Menu par wapas', description: 'Saari services dekho' },
    ]
    : [
      { rowId: 'music_list', title: '🎵 Gaana chuno', description: 'Wahi list se dusra gaana chuno' },
      { rowId: 'music_new', title: '🔍 Naya gaana khojo', description: 'Koi aur gaana try karo' },
      { rowId: 'menu', title: '🏠 Menu par wapas', description: 'Saari services dekho' },
    ];
  const sent = await evo.sendList(instance, to, {
    title: ok ? '🎵 Gaana mil gaya!' : '🎵 Gaana nahi aaya',
    buttonText: 'Options Dekho',
    description: ok ? 'Ab kya karna hai? Ek option tap karo 👇' : 'Ye gaana nahi aa paya 😔 — wahi list se koi aur gaana chuno, ya naya gaana search karo 👇',
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

// ---------- CLOUD par YT gaane ki delivery (2026-11-07, Hero ki shikayat) ----------
// Pehle YT pick Cloud par seedha fail hota tha ('cloud_yt_link_only') — jabki
// kitne hi gaane (Zaroorat jaise) Saavn par hain hi nahi, sirf YT par hain.
// User ko fail dikhana galat tha jab asal rasta maujood hai: file download
// karke (backup vault me bhi rehti hai) Meta par media upload, phir media_id
// se audio. Upload wali media_id wa_media_cache me 25 din rakhi jati hai —
// gaana ek baar baja to agli baar na download, na upload: seedha send.
const WA_MEDIA_TTL_MS = 25 * 24 * 3600_000; // Meta media_id ~30 din chalti hai
let waCacheReady = null;
function ensureWaMediaCache() {
  if (!waCacheReady) {
    waCacheReady = pool.query(`create table if not exists wa_media_cache (
      video_id text primary key, media_id text not null, created_at text not null
    )`).catch((e) => { waCacheReady = null; throw e; });
  }
  return waCacheReady;
}
export async function getWaMediaId(videoId) {
  if (!videoId) return null;
  await ensureWaMediaCache();
  const { rows } = await pool.query('select media_id, created_at from wa_media_cache where video_id=$1', [videoId]);
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - Date.parse(row.created_at) > WA_MEDIA_TTL_MS) return null; // purani id par bharosa nahi
  return row.media_id;
}
export async function setWaMediaId(videoId, mediaId) {
  if (!videoId || !mediaId) return;
  await ensureWaMediaCache();
  await pool.query(
    `insert into wa_media_cache (video_id, media_id, created_at) values ($1,$2,$3)
     on conflict (video_id) do update set media_id = excluded.media_id, created_at = excluded.created_at`,
    [videoId, mediaId, new Date().toISOString()]);
}
export async function clearWaMediaId(videoId) {
  if (!videoId) return;
  await ensureWaMediaCache();
  await pool.query('delete from wa_media_cache where video_id=$1', [videoId]);
}

function audioMimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.aac') return 'audio/aac';
  return 'audio/mp4'; // .m4a ka WhatsApp-naam
}

async function deliverYtTrackCloud(p, opts = {}) {
  // Pehla rasta: cache wali media_id — sabse tez, koi download/upload nahi.
  const cached = await getWaMediaId(p.videoId).catch(() => null);
  if (cached) {
    const sent = await graph.sendAudioById(p.to, cached).catch(() => false);
    if (sent) return;
    await clearWaMediaId(p.videoId).catch(() => {}); // id mar gayi — fresh upload par giro
  }
  // File lao: getAudioForVideo media_vault (Telegram backup) pehle dekhta
  // hai, warna yt-dlp se download karke vault me bhi rakh deta hai — ek baar
  // aaya gaana hamesha ke liye backup (Hero ki maang, 2026-11-07).
  const file = await getAudioForVideo(p.videoId, p.title, opts);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { throw new Error('yt_cloud_file_missing'); }
  if (!size || size > WHATSAPP_MAX) throw new Error('yt_cloud_too_large');
  const mediaId = await graph.uploadMediaFile(file, audioMimeFor(file), path.basename(file));
  if (!mediaId) throw new Error('yt_cloud_upload_failed');
  const sent = await graph.sendAudioById(p.to, mediaId);
  if (!sent) throw new Error('yt_cloud_send_failed');
  await setWaMediaId(p.videoId, mediaId).catch(() => {});
}

// ---------- CLOUD par SoundCloud gaane ki delivery (2026-11-07) ----------
// YT wali hi kataar (media_id cache -> file -> Meta upload -> send), par
// chaabi 'sc:<id>' namespace me aur file getAudioForScTrack se aati hai.
async function deliverScTrackCloud(p, timeoutMs = 120_000) {
  const scId = p.scId || p.videoId;
  const cacheKey = `sc:${scId}`;
  const cached = await getWaMediaId(cacheKey).catch(() => null);
  if (cached) {
    const sent = await graph.sendAudioById(p.to, cached).catch(() => false);
    if (sent) return;
    await clearWaMediaId(cacheKey).catch(() => {});
  }
  const file = await getAudioForScTrack(scId, p.url, p.title, timeoutMs);
  let size = 0;
  try { size = fs.statSync(file).size; } catch { throw new Error('sc_cloud_file_missing'); }
  if (!size || size > WHATSAPP_MAX) throw new Error('sc_cloud_too_large');
  const mediaId = await graph.uploadMediaFile(file, audioMimeFor(file), path.basename(file));
  if (!mediaId) throw new Error('sc_cloud_upload_failed');
  const sent = await graph.sendAudioById(p.to, mediaId);
  if (!sent) throw new Error('sc_cloud_send_failed');
  await setWaMediaId(cacheKey, mediaId).catch(() => {});
}

// ---------- CROSS-SOURCE RESCUE (2026-11-07, Hero: "har music aana chahiye") ----------
// Ek source fail ho to wahi gaana dusre source se: YT pick fail -> Saavn par
// wahi gaana (pickSaavnRescue ke sakht mel par hi); Saavn fail -> YT.
// Kamyab ho to p.rescuedSource/rescuedId me asal delivery likhi jati hai
// (history ke liye). Na mile to throw — asal fail wala rasta hi aage chalega.
// Rescue ke liye: koi YT video dono transport par bhejo — Cloud par media
// upload wala rasta (deliverYtTrackCloud), Evolution par file/base64 wala.
async function deliverYtAny(p, videoId, url, opts = {}) {
  const p2 = { ...p, source: 'yt', videoId, url, songId: undefined };
  if (p.instance === evo.CLOUD_INSTANCE) { await deliverYtTrackCloud(p2, opts); return; }
  const file = await getAudioForVideo(videoId, p.title, opts);
  await evo.sendPresence(p.instance, p.to, 'recording', 30000).catch(() => {});
  const b64 = fs.readFileSync(file).toString('base64');
  await evo.sendMedia(p.instance, p.to, b64, p.title, 'audio', { footer: true });
}

async function deliverScAny(p, scTrack, timeoutMs = 120_000) {
  const p2 = { ...p, source: 'soundcloud', scId: scTrack.id, videoId: undefined, url: scTrack.url };
  if (p.instance === evo.CLOUD_INSTANCE) { await deliverScTrackCloud(p2, timeoutMs); return; }
  const file = await getAudioForScTrack(scTrack.id, scTrack.url, scTrack.title, timeoutMs);
  await evo.sendPresence(p.instance, p.to, 'recording', 30000).catch(() => {});
  const b64 = fs.readFileSync(file).toString('base64');
  await evo.sendMedia(p.instance, p.to, b64, p.title, 'audio', { footer: true });
}

async function rescueDeliver(p) {
  const t0 = p._t0 || Date.now();
  const elapsed = () => Date.now() - t0;
  if (p.source === 'jiosaavn') {
    const hits = await searchSongs(rescueQueryFromTitle(p.title) || p.title, 6).catch(() => []);
    const hit = (hits || []).find((h) => h?.id && isSongLength(h));
    if (!hit) throw new Error('rescue_no_yt_match');
    await deliverYtAny(p, hit.id, hit.url);
    // Bookkeeping: asal pick ke source/id p par hi rehne do; rescue ka
    // source/id alag se rakho (history ke liye). p.videoId = undefined isliye
    // taaki moveBusyState bina id-mel ke busy guard saaf kar de — rescue wala
    // id flow ke busy id se mel hi nahi khayega aur user 30 min atka rahega.
    p.rescuedSource = 'yt'; p.rescuedId = hit.id; p.videoId = undefined;
    console.log('[music] rescue: Saavn fail -> YT se aaya:', hit.id);
    return;
  }
  // (1) Saavn par wahi gaana (sakht mel par hi) — CDN link, extraction ki
  // deewaar wahan hai hi nahi, isliye ye sabse bharosemand rescue hai.
  const hits = await searchSongsSaavn(rescueQueryFromTitle(p.title) || p.title, 6).catch(() => []);
  const hit = pickSaavnRescue(p.title, hits);
  if (hit) {
    const p2 = { ...p, source: 'jiosaavn', songId: hit.id, videoId: undefined };
    if (p.instance === evo.CLOUD_INSTANCE) await deliverSaavnTrackCloud(p2);
    else await deliverSaavnTrack(p2);
    p.rescuedSource = 'jiosaavn'; p.rescuedId = hit.id; p.videoId = undefined;
    console.log('[music] rescue: -> Saavn se aaya:', hit.id);
    return;
  }
  // (2) LIST KE DUSRE UPLOADS — user ki apni list me usi gaane ke aur
  // uploads the (payload.altIds, masterMenu bhejta hai). Ye sabse ummeed
  // wala rasta hai: khoj wahi, gaana wahi, sirf upload dusra. Ek-ek karke
  // TEZ (fast) chain se parkho — jo chal jaye wahi jeet.
  const tried = new Set([p.videoId]);
  const altIds = Array.isArray(p.altIds) ? p.altIds : [];
  for (const altId of altIds.slice(0, 3)) {
    if (!altId || tried.has(altId)) continue;
    tried.add(altId);
    if (elapsed() > 200_000) break;
    try {
      await deliverYtAny(p, altId, undefined, { fast: true });
      p.rescuedSource = 'yt'; p.rescuedId = altId; p.videoId = undefined;
      console.log('[music] rescue: -> list ke dusre upload se aaya:', altId);
      return;
    } catch { console.log('[music] rescue: list upload fail:', altId); }
  }
  // (3) Khoj se aur dusre uploads (2 tak) — wahi chaal, taazi khoj par.
  if (elapsed() < 180_000) {
    const rescueQ = rescueQueryFromTitle(p.title) || p.title;
    const alts = pickAltUploads(await searchSongs(rescueQ, 8).catch(() => []), [...tried], 2, rescueQ);
    for (const alt of alts) {
      tried.add(alt.id);
      if (elapsed() > 200_000) break;
      try {
        await deliverYtAny(p, alt.id, alt.url, { fast: true });
        p.rescuedSource = 'yt'; p.rescuedId = alt.id; p.videoId = undefined;
        console.log('[music] rescue: -> khoj ke dusre upload se aaya:', alt.id);
        return;
      } catch { console.log('[music] rescue: khoj upload fail:', alt.id); }
    }
  }
  // (4) SoundCloud par wahi gaana — wahan bhi extraction ki deewaar nahi.
  // Jo SC track abhi fail hua hai use dobara nahi uthayenge. Download par
  // 60s ki hadd — deri chalegi, par job ki kul hadd ke andar rehna hai.
  if (elapsed() < 230_000) {
    const scHits = await searchSongsSc(rescueQueryFromTitle(p.title) || p.title, 6).catch(() => []);
    const failedScId = p.source === 'soundcloud' ? (p.scId || p.videoId) : null;
    const sc = (scHits || []).find((h) => h?.id && h.id !== failedScId && isSongLength(h));
    if (sc) {
      await deliverScAny(p, sc, 60_000);
      p.rescuedSource = 'soundcloud'; p.rescuedId = sc.id; p.videoId = undefined;
      console.log('[music] rescue: -> SoundCloud se aaya:', sc.id);
      return;
    }
  }
  console.log('[music] rescue: koi rasta nahi chala:', String(p.title || '').slice(0, 60), `(${Math.round(elapsed() / 1000)}s)`);
  throw new Error('rescue_no_match');
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
      { id: 'music_list', title: '🎵 Gaana chuno' },
      { id: 'music_new', title: '🔍 Naya gaana' },
      { id: 'menu', title: '🏠 Menu' },
    ];
  const sent = await graph.sendButtons(to, {
    body: ok ? '🎵 Gaana mil gaya! Ab kya karna hai? Ek option tap karo 👇' : 'Ye gaana nahi aa paya 😔 — wahi list se koi aur gaana chuno, ya naya gaana search karo 👇',
    buttons,
  }).catch(() => false);
  return Boolean(sent);
}

const EXECUTORS = {
  // PREFETCH (2026-11-07, Hero ka logic): list bante hi peeche se download —
  // sirf file taiyaar karni hai (disk + vault backup), bhejna NAHI. User
  // tap kare to pick wali delivery wahi taiyaar file uthayegi. Fail par
  // dead-nishan (2 fail = list se gayab).
  async music_prefetch(p) {
    try {
      if (p.scId) await getAudioForScTrack(p.scId, p.url, p.title);
      else await getAudioForVideo(p.videoId, p.title);
    }
    catch (e) { await noteDownloadFailure(p.scId || p.videoId).catch(() => {}); throw e; }
  },
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
    p._t0 = Date.now(); // rescue ke deadline hisaab ke liye (rescueDeliver)
    // WAIT UPDATE (2026-11-07 raat, Hero ka 4D order): delivery 30s se zyada
    // lage to EK chhota update — chuppi me user "bot mar gaya" samajh kar
    // chala jata hai. tick() job khatm hone par _waitDone=true kar deta hai,
    // isliye gaana pahunchne ke baad ye update kabhi nahi jayega.
    p._waitDone = false;
    setTimeout(() => {
      if (!p._waitDone) evo.sendText(p.instance, p.to, '⏳ Gaana mil raha hai — bas thoda sa aur, yahin raho 🎧').catch(() => {});
    }, 30000);
    try {
      if (p.instance === evo.CLOUD_INSTANCE) {
        // CLOUD branch: saavn gaana LINK se jata hai; YT gaana download karke
        // media upload se (deliverYtTrackCloud — usi ke liye bana hai, kyunki
        // kitne gaane Saavn par hain hi nahi). Dono ke baad action LIST jati hai.
        if (p.source === 'jiosaavn' && p.songId) {
          try {
            await deliverSaavnTrackCloud(p);
          } catch (e) {
            // RESCUE: wahi gaana YT se lane ki koshish (rescueDeliver)
            try { await rescueDeliver(p); }
            catch { p.url = undefined; p.videoId = null; throw e; } // failure text bina dead-link ke jaye
          }
        } else if (p.source === 'soundcloud') {
          try {
            await deliverScTrackCloud(p);
          } catch (e) {
            // RESCUE: wahi gaana Saavn/YT se (rescueDeliver)
            try { await rescueDeliver(p); }
            catch { throw e; }
          }
        } else {
          try {
            await deliverYtTrackCloud(p);
          } catch (e) {
            // RESCUE: wahi gaana Saavn se — kitne hi YT gaane Saavn par hain
            try { await rescueDeliver(p); }
            catch { throw e; }
          }
        }
        await moveBusyState(p.userId, p.videoId, { step: 'music_done', lastTitle: p.title });
        // 4 options chahiye (Lyrics/Gaana chuno/Naya gaana/Menu) — WhatsApp
        // reply buttons zyada se zyada 3 hote hain, isliye success par ab
        // LIST jayegi (categories/results bhi list hi hain, user aadat me hai).
        // Failure wala rasta (2 buttons) sendMusicActionButtons par hi hai.
        const listed = await sendMusicActionList(p.instance, p.to, true);
        if (!listed) {
          await evo.sendText(p.instance, p.to, "Lyrics chahiye to 'lyrics' likh do 🎵").catch(() => {});
        }
        if (p.userId) await logUsage(p.userId, 'music').catch(() => {});
        if (p.userId) await markSent(p.userId, p.rescuedSource || p.source, p.rescuedId || (p.source === 'jiosaavn' ? p.songId : p.videoId)).catch(() => {});
        return;
      }
      if (p.source === 'jiosaavn' && p.songId) {
        // FAST MUSIC v2 chain (upar deliverSaavnTrack): vault -> URL -> buffer -> yt-dlp
        try {
          await deliverSaavnTrack(p);
        } catch (e) {
          // RESCUE: wahi gaana YT se lane ki koshish (rescueDeliver)
          try { await rescueDeliver(p); }
          catch {
            // Payload saaf: saavn ID ko videoId ki jagah mat rehne do — tick()
            // ka failure-rasta videoId se busy state milata hai, aur failure
            // text ab link banata hi nahi (2026-11-07 ka niyam).
            p.url = undefined; p.videoId = null;
            throw e;
          }
        }
      } else if (p.source === 'soundcloud') {
        try {
          const file = await getAudioForScTrack(p.scId || p.videoId, p.url, p.title);
          await evo.sendPresence(p.instance, p.to, 'recording', 30000).catch(() => {});
          const b64 = fs.readFileSync(file).toString('base64');
          await evo.sendMedia(p.instance, p.to, b64, p.title, 'audio', { footer: true });
        } catch (e) {
          // RESCUE: wahi gaana Saavn/YT se (rescueDeliver)
          try { await rescueDeliver(p); }
          catch { throw e; }
        }
      } else {
        try {
          const file = await getAudioForVideo(p.videoId, p.title);
          await evo.sendPresence(p.instance, p.to, 'recording', 30000).catch(() => {});
          const b64 = fs.readFileSync(file).toString('base64');
          await evo.sendMedia(p.instance, p.to, b64, p.title, 'audio', { footer: true });
        } catch (e) {
          // RESCUE: wahi gaana Saavn se lane ki koshish (rescueDeliver)
          try { await rescueDeliver(p); }
          catch { throw e; }
        }
      }
      // Delivery ho gayi — busy guard hatao, ab post-audio taps (lyrics/music_new) khulenge
      await moveBusyState(p.userId, p.videoId, { step: 'music_done', lastTitle: p.title });
      const actionList = await sendMusicActionList(p.instance, p.to, true);
      if (!actionList) {
        await evo.sendText(p.instance, p.to, "Lyrics chahiye to 'lyrics' likh do 🎵").catch(() => {});
      }
      if (p.userId) await logUsage(p.userId, 'music').catch(() => {});
      if (p.userId) await markSent(p.userId, p.rescuedSource || p.source, p.rescuedId || (p.source === 'jiosaavn' ? p.songId : p.videoId)).catch(() => {});
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
      // ⭐ ESCALATION (2026-11-06, Hero ka niyam): baat Boss/action-level ki
      // ho to AI ke ghumane ki jagah pakka rasta — customer ko saaf jawab,
      // aur Boss ke WhatsApp par turant khabar (number + maang), deal Boss
      // close karega. Pakad abhi shabdon se hai (sasti, chaabi ke bina bhi
      // chalti hai); chaabi lagne par agent-wali pehchan iske upar judegi.
      if (isEscalation(p.text)) {
        await evo.sendText(p.instance, p.to,
          'Ye wala kaam mere *Boss RazzScale* khud karte hain — maine unhe tumhari khabar bhej di hai ✅\nWoh apne WhatsApp se tumse baat karenge. Jaldi ho to tum bhi unhe message kar sakte ho: +91 72051 91890\n\nMenu ke liye *menu* likh do.');
        await notifyOwner(p.instance,
          `🔔 *Nayi deal wali baat!*\n👤 Customer: +${String(p.to).replace(/\D/g, '')}\n💬 Maang: "${String(p.text || '').slice(0, 200)}"\n\nCustomer ko bol diya hai ki tum sampark karoge — deal yahin se close karo 👍`)
          .catch(() => {});
        if (p.userId) await logUsage(p.userId, 'escalation').catch(() => {});
        return;
      }
      let reply = await freeChat({ id: p.userId }, p.text);
      // Dimag busy/set-na-ho par user ko band gali me mat chhodo — menu ka
      // rasta har aise jawab ke saath (Hero ka "menu hamesha dikhe" niyam).
      // Error/fallback jawab par AD KABHI NAHI (2026-11-07 raat, Hero ki
      // report): atke hue user ko vigyapan sabse zyada chubhta hai.
      const isFallback = /busy hai|set nahi hua|limit khatm/.test(reply);
      if (isFallback) {
        reply += '\n\nTab tak menu se kaam chala lo — *menu* likho, saare option tap karke khul jayenge.';
      }
      await evo.sendText(p.instance, p.to, reply, isFallback ? {} : { ad: true });
    } finally {
      await evo.sendPresence(p.instance, p.to, 'paused', 1000).catch(() => {});
    }
  },
  async likhai_work(p) {
    // WORKPLACE v1 (likhai): kaam banao → jobs row me result save → customer
    // ko 'taiyaar hai' ki khabar → Boss ko approval buttons. Delivery Boss ke
    // tap ke baad hi hoti hai (handlers/workplace.js → handleOwnerWork).
    // WEB ORDER (source='web'): customer WhatsApp chat me hai hi nahi — use
    // presence/'taiyaar hai' text bhejna bekaar hai (window bhi band hota
    // hai). Uski khabar Boss ko jati hai; delivery Boss ke 'Bhej do' par
    // uske number par hogi.
    const isWeb = p.source === 'web';
    if (!isWeb) await evo.sendPresence(p.instance, p.to, 'composing', 15000).catch(() => {});
    const out = await workWrite({ id: p.userId }, { kind: p.workKind, brief: p.brief });
    if (!out) {
      if (isWeb) await notifyOwner(p.instance, `⚠️ *Web order ${p.orderId} nahi ban paya*\n👤 +${p.to}\n📝 ${p.workKind}: "${String(p.brief || '').slice(0, 140)}"\nCustomer ko khabar nahi gayi — chaho to WhatsApp par haath se baat kar lo.`).catch(() => {});
      else await evo.sendText(p.instance, p.to, 'Maaf karo, ye kaam abhi nahi ban paya 😔 — thodi der me dobara try karo, ya VIP section se Boss se baat kar lo.');
      return;
    }
    if (out.startsWith('CLARIFY:')) {
      const question = out.replace('CLARIFY:', '').trim();
      if (isWeb) {
        try {
          const { rows } = await pool.query('select payload from jobs where idempotency_key=$1', [`work:${p.orderId}`]);
          const pl = rows[0] ? (typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload) : {};
          pl.stage = 'clarify';
          await pool.query('update jobs set payload=$2 where idempotency_key=$1', [`work:${p.orderId}`, JSON.stringify(pl)]);
        } catch { /* stage na lage to bhi owner ko khabar ja chuki hogi */ }
        await notifyOwner(p.instance, `❓ *Web order ${p.orderId} — aur tafseel chahiye*\n👤 +${p.to}\n📝 ${p.workKind}: "${String(p.brief || '').slice(0, 140)}"\n🤖 Agent ka sawal: ${question}\nCustomer se WhatsApp par puchh kar order aage badhao.`).catch(() => {});
      } else {
        await evo.sendText(p.instance, p.to, `Ek chhoti si baat aur bata do, phir kaam pakka banega 🙏\n${question}\n\n(Jawab ke saath menu se *Kaam Karwao* wala order dobara de dena.)`);
      }
      return;
    }
    await pool.query('update jobs set result=$2 where idempotency_key=$1', [`work:${p.orderId}`, out]).catch(() => {});
    try {
      const { rows } = await pool.query('select payload from jobs where idempotency_key=$1', [`work:${p.orderId}`]);
      const pl = rows[0] ? (typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload) : {};
      pl.stage = 'ready';
      await pool.query('update jobs set payload=$2 where idempotency_key=$1', [`work:${p.orderId}`, JSON.stringify(pl)]);
    } catch { /* stage na lage to bhi worklist result se hi pehchan lega */ }
    if (!isWeb) await evo.sendText(p.instance, p.to, '✅ *Tumhara kaam taiyaar hai!*\nEk aakhri quality jaanch ke baad yahin bhej raha hoon — bas kuch der 🙏');
    await notifyOwnerForApproval(p, out).catch((e) => console.error('[work] owner notify fail:', e?.message || e));
  },
};

// Workplace: taiyaar kaam ki approval-khabar Boss (owner) ko buttons ke saath.
// Fail ho to sirf log — kaam jobs row me pada hai, Boss 'worklist' se utha lega.
async function notifyOwnerForApproval(p, workText) {
  const body = `✍️ *Naya kaam taiyaar hai* — Order ${p.orderId}\n📝 Kaam: ${p.workKind}\n📋 Brief: ${String(p.brief || '').slice(0, 120)}\n\n—— Taiyaar likhai ——\n${workText}\n\nPakka ho to *Bhej do* tap karo — customer ko yahi bhej dunga.`;
  if (p.instance === evo.CLOUD_INSTANCE) {
    const sent = await graph.sendButtons(env.ownerWaNumber, {
      body,
      buttons: [
        { id: `work_ok_${p.orderId}`, title: '✅ Bhej do' },
        { id: `work_no_${p.orderId}`, title: '❌ Radd' },
      ],
    }).catch(() => false);
    if (sent) return;
  }
  await evo.sendText(p.instance, `${env.ownerWaNumber}@s.whatsapp.net`, body + '\n\n(Approval ke liye bot ko "worklist" likho.)');
}

const FAILURE_TEXT = {
  lyrics: { type: 'text', text: 'Is gaane ke lyrics nahi mile 😔' },
};
// Music fail: YOUTUBE LINK KABHI NAHI (Hero, 2026-11-07 — pakka niyam).
// User yahan WhatsApp me audio sunne aaya hai; use YouTube par bhejna
// matlab apna kaam hi khatm kar dena. Fail par imaandaar text + bot ke
// ANDAR ke raste: wahi list se dusra gaana (music_list), naya search, menu.
// (Results flow me rehte hain — tick() failure par moveBusyState unhe
// music_zone tak carry karta hai, isliye music_list yahan kaam karta hai.)
async function sendMusicFailure(p) {
  // EK HI message (2026-11-07 raat, Hero ki report): pehle fail par text +
  // buttons/list DO alag messages jate the — chat bharti thi, user confuse
  // hota tha. Ab fail ki baat buttons/list ke body me hi hai, ek message.
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
      // Results aage badhao (2026-11-07): delivery ke baad ke "Gaana chuno"
      // option ko wahi list chahiye jo pick ke samay thi — busy state me
      // masterMenu use pehle se rakhta hai, yahan use done tak le jana hai.
      const carry = {};
      if (Array.isArray(f.results) && f.results.length) { carry.results = f.results; carry.shown = f.shown; carry.query = f.query; }
      await setFlow(userId, 'master', { ...next, ...carry }, 1800);
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
        payload._waitDone = true;
        await finish(job, true);
      } catch (e) {
        payload._waitDone = true;
        const lastTry = job.attempts >= MAX_ATTEMPTS || job.type === 'music_download';
        await finish(job, false, String(e?.message || e));
        if (lastTry && payload.instance && payload.to) {
          if (job.type === 'music_download') {
            // YT pick ka pakka fail — dead-nishan lagao taaki woh video aage
            // ki lists me aaye hi nahi (2 fail par search use hata deta hai)
            if (payload.source !== 'jiosaavn' && payload.videoId) {
              await noteDownloadFailure(payload.videoId).catch(() => {});
            }
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
  initYtdlp(); // Khud-taaza yt-dlp boot par hi taiyaar karna shuru (music.js)
  startSeeder(); // Auto Library (2026-11-07) — apni dheere gati se, user jobs hamesha pehle
  console.log('[worker] jobs worker shuru');
}
