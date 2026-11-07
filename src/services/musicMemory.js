// SMART MUSIC MEMORY (2026-11-07) — per-user listening history + repeat detection.
//
// Kaam: user koi gaana dobara mange to mehenga merged search chalaye bina
// USI user ki history se wahi recording phir bhej do (masterMenu isko
// search se pehle bulata hai). History hamesha user_id se bandhi hai —
// ek user ki history dusre ko kabhi nahi dikhti/milti (saari queries
// user_id par filter hoti hain).
//
// States (imaandaari wala niyam): 'selected' (user ne pick kiya) ->
// 'sent' (worker ne audio bhej diya). WhatsApp par asal "suna" ki koi
// pakki pushti nahi milti, isliye 'listened' jaisi koi state NAHI hai —
// bhejna aur sunna ek baat nahi hai.
//
// Timestamps saavn_cache wale usool par JS se ISO text me aate hain taaki
// pg aur sqlite dono mode me table bilkul ek jaisi rahe. Table lazy-ensure
// se banti hai (IF NOT EXISTS, sirf additive) — koi purani table/data
// kabhi nahi chhuti.
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { looseFold, distinctiveWords } from './jiosaavn.js';

// Version wale shabd: ye title me hon aur query me NA hon to woh gaana
// original ka "exact repeat" NAHI mana jayega (remix sunne wale ko
// original, ya original wale ko remix, khud se nahi milega).
const VERSION_WORDS = ['remix', 'lofi', 'slowed', 'reverb', 'spedup', 'cover', 'karaoke', 'instrumental', 'nightcore', '8d', 'mashup', 'unplugged', 'acoustic'];

let ensured = null;
export function ensureMusicHistory() {
  if (!ensured) {
    ensured = (async () => {
      await pool.query(`create table if not exists listening_history (
        id text primary key,
        user_id text not null,
        wa_id text,
        provider text not null,
        provider_id text not null,
        title text,
        normalized_title text,
        artist text,
        norm_artist text,
        duration_sec integer,
        ref_url text,
        first_requested_at text not null,
        last_requested_at text not null,
        request_count integer not null default 1,
        status text not null default 'selected',
        last_query text
      )`);
      await pool.query(`create unique index if not exists uniq_listening_user_track on listening_history (user_id, provider, provider_id)`);
      await pool.query(`create index if not exists idx_listening_user_title on listening_history (user_id, normalized_title)`);
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

/** Title/artist ko mel ke liye ek roop do (looseFold: z->j, oo->u, ee->i). */
export function normalizeText(s) {
  return looseFold(String(s || ''));
}

function lev(a, b) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 2) return 99;
  const prev = Array.from({ length: lb + 1 }, (_, i) => i);
  const cur = new Array(lb + 1).fill(0);
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    for (let j = 1; j <= lb; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= lb; j++) prev[j] = cur[j];
  }
  return prev[lb];
}

/** Do shabd ek hi maano: barabar, ek dusre ke andar, ya chhoti spelling galti. */
function tokenMatch(qt, tt) {
  if (!qt || !tt) return false;
  if (qt === tt) return true;
  if (qt.length >= 4 && tt.length >= 4 && (qt.includes(tt) || tt.includes(qt))) return true;
  const d = lev(qt, tt);
  return (qt.length >= 5 && d <= 1) || (qt.length >= 9 && d <= 2);
}

function versionWordsIn(tokens) {
  return VERSION_WORDS.filter((w) => tokens.includes(w));
}

/**
 * User ki history me is query ka pakka repeat dhoondo.
 * Pakka = query ke SAARE khaas (distinctive) shabd gaane ke title+artist
 * me milein AUR version ka mel khaye (title ka remix/cover query me bhi
 * manga gaya ho). Fuzzy mel kabhi khud se delivery nahi deta — ya to
 * pakka hit, ya null (phir aam search chalega).
 */
export async function findRepeat(userId, query) {
  if (!userId || !query) return null;
  await ensureMusicHistory();
  const started = Date.now();
  const dWords = [...new Set(distinctiveWords(query).map((w) => looseFold(w)).filter((w) => w.length >= 3))];
  if (!dWords.length) return null;
  const qVersion = versionWordsIn(normalizeText(query).split(' ').filter(Boolean));

  const { rows } = await pool.query(
    "select * from listening_history where user_id=$1 and status='sent' order by request_count desc, last_requested_at desc limit 100",
    [userId]);
  for (const row of rows) {
    const titleTokens = (row.normalized_title || '').split(' ').filter(Boolean);
    const artistTokens = (row.norm_artist || '').split(' ').filter(Boolean);
    // Version guard: title me version shabd hai par query me nahi -> exact nahi.
    if (versionWordsIn(titleTokens).some((w) => !qVersion.includes(w))) continue;
    // Query me version manga hai par is title me nahi -> ye woh version nahi.
    if (qVersion.some((w) => !titleTokens.includes(w))) continue;
    const hay = [...titleTokens, ...artistTokens];
    // User ne pehli baar jis query se ye gaana manga tha, uske shabd bhi
    // mel me shamil — log aksar film ka naam jod dete hain ("Zaroorat Ek
    // Villain"), jo title/artist me hota hi nahi.
    if (row.last_query) hay.push(...normalizeText(row.last_query).split(' ').filter(Boolean));
    if (dWords.every((dw) => hay.some((ht) => tokenMatch(dw, ht)))) {
      // EXACT DAAWA (2026-11-07 raat, live bhajan-galti ke baad): upar wala mel
      // ek-tarfa hai (khoj ke shabd title me) — isiliye "Maa Mujhe Teri
      // Zaroorat Hai" (bhajan, asal me bheja hua) bhi "Mujhe Teri Jarurat
      // Hai" (film gaana) par hit ho gaya. Auto-delivery sirf tab jab gaane
      // ke SAARE khaas shabd (artist wale shabd chhod kar) user ki khoj me
      // hon. Exact na ho to hit nahi — aam khoj list dikhayegi, user chune.
      const titleD = [...new Set(distinctiveWords(row.normalized_title || '').map((w) => looseFold(w)))];
      const artistD = new Set((row.norm_artist || '').split(' ').filter(Boolean));
      const allowed = (tw) => artistD.has(tw) || dWords.some((qw) => tokenMatch(qw, tw));
      if (!titleD.length || !titleD.every(allowed)) continue;
      console.log(`[music-memory] repeat hit user=${userId} track=${row.provider}:${row.provider_id} lookup_ms=${Date.now() - started}`);
      return row;
    }
  }
  return null;
}

// Monotonic ISO time: ek hi millisecond me kai recordPick ho jayein to bhi
// har stamp pichhle se bada — warna Recently Played ka kram (last_requested_at
// desc) ek-si timestamps par taash ke patto ki tarah bikhar jata hai.
let lastStampMs = 0;
function isoNow() {
  lastStampMs = Math.max(Date.now(), lastStampMs + 1);
  return new Date(lastStampMs).toISOString();
}

/** Pick (ya repeat delivery) ko history me likho — ek user+track = ek row, ginati badhti hai. */
export async function recordPick({ userId, waId, pick, query }) {
  if (!userId || !pick?.id) return;
  await ensureMusicHistory();
  const provider = pick.source === 'jiosaavn' ? 'jiosaavn' : (pick.source === 'soundcloud' ? 'soundcloud' : 'yt');
  const songTitle = provider === 'jiosaavn' ? (pick.song || pick.title || '') : (pick.title || '');
  const artist = provider === 'jiosaavn' ? (pick.artist || '') : (pick.channel || '');
  const now = isoNow();
  await pool.query(
    `insert into listening_history (id, user_id, wa_id, provider, provider_id, title, normalized_title, artist, norm_artist, duration_sec, ref_url, first_requested_at, last_requested_at, request_count, status, last_query)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,'selected',$14)
     on conflict (user_id, provider, provider_id) do update set
       last_requested_at = excluded.last_requested_at,
       request_count = listening_history.request_count + 1,
       status = case when listening_history.status = 'sent' then 'sent' else 'selected' end,
       last_query = coalesce(excluded.last_query, listening_history.last_query),
       title = excluded.title,
       artist = excluded.artist,
       normalized_title = excluded.normalized_title,
       norm_artist = excluded.norm_artist,
       duration_sec = coalesce(excluded.duration_sec, listening_history.duration_sec),
       ref_url = coalesce(excluded.ref_url, listening_history.ref_url)`,
    [crypto.randomUUID(), userId, waId || null, provider, String(pick.id),
     pick.title || songTitle, normalizeText(songTitle), artist || null, normalizeText(artist),
     pick.durationSec || pick.duration || null, pick.url || null, now, now, query || null]);
}

/** Recently Played: user ke sabse taze gaane, aakhri baar mange hue ke kram me. */
export async function getRecent(userId, limit = 8) {
  if (!userId) return [];
  await ensureMusicHistory();
  const { rows } = await pool.query(
    'select * from listening_history where user_id=$1 order by last_requested_at desc, first_requested_at desc limit $2',
    [userId, limit]);
  return rows;
}

/** Worker ki safal delivery ke baad status 'sent' karo. Sunne ki pushti isse NAHI banti. */
export async function markSent(userId, provider, providerId) {
  if (!userId || !providerId) return;
  await ensureMusicHistory();
  await pool.query(
    `update listening_history set status='sent' where user_id=$1 and provider=$2 and provider_id=$3`,
    [userId, provider === 'jiosaavn' ? 'jiosaavn' : (provider === 'soundcloud' ? 'soundcloud' : 'yt'), String(providerId)]);
}
