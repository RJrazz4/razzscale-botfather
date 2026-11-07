import { searchSongsSaavn, foldText, queryOverlap, MAX_SONG_SEC } from './jiosaavn.js';
import { searchSongs, deadVideoIds, searchSongsSc } from './music.js';

/** Gaana delivery ke layak hai? Duration pata ho aur 10-min cap se lamba ho
 *  to NAHI (1-ghante wale mix/playlist — WhatsApp par bheje hi nahi ja sakte).
 *  Duration na pata ho to roko mat (galti se achha gaana na mare). */
export function isSongLength(track) {
  const d = Number(track?.durationSec || track?.duration) || 0;
  return !d || d <= MAX_SONG_SEC;
}

// MERGED MUSIC SEARCH (2026-11-06 raat — Hero ki shikayat: "officially song
// nahi de pa raha hai, AI song aur Bhojpuri la raha hai").
// SABOOT: JioSaavn ki khoj me kai mashhoor official gaane hote hi nahi
// (Ek Villain ka 'Zaroorat' kisi bhi query par nahi mila), jabki YouTube par
// T-Series ka official upload sabse upar hota hai. Aur jahan Saavn ke paas
// official hai, wahan cover/lofi usse upar baithe the.
// HAL: dono source PARALLEL chalao, har natije ko ek hi tarazu par naapo —
// query se title ka mel + kitni baar baja/suna gaya (log) + official
// channel/label ka bonus − cover-wale shabdon ki sazaa — phir milakar
// sabse achhe 8 do. Pick ka rasta pehle jaisa hi hai (source dekh kar
// saavn chain ya YT chain) — ye module sirf KRAM badalta hai.

const MAJOR_CHANNEL_WORDS = ['t series', 'tseries', 'sony music', 'jee music', 'zee music', 'yrf', 'tips official', 'tips', 'saregama', 'universal music', 'warner music', 'aditya music', 'lahari', 'venus', 'eros', 'times music', 'speed records', 'geet mp3', 'white hill', 'hitz music', 'vyrl', 'lahari music'];
const PENALTY_WORDS = ['lofi', 'slowed', 'reverb', '8d', 'nightcore', 'karaoke', 'instrumental', 'ringtone', 'cover', 'flute', 'violin', 'bhakti', 'reaction', 'ai version', 'dj mix', 'dj remix', 'status video', 'whatsapp status'];

export function scoreYtTrack(track, query, position = 0, total = 8) {
  const titleF = foldText(track.title || '');
  const channelF = foldText(track.channel || '');
  const allText = `${titleF} ${channelF}`;
  const overlap = queryOverlap(query, track.title || '');
  const views = Number(track.viewCount) || 0;
  let score = 4 * overlap;
  // Views mile to wahi asli taakat hai; na mile (purana cache) to YouTube ke
  // apne kram par halka bharosa — pehle wale natije ko thoda zyada.
  score += views > 0 ? 1.15 * Math.log10(views + 1) : Math.max(0, 3.2 - position * 0.35);
  if (MAJOR_CHANNEL_WORDS.some((w) => channelF.includes(w))) score += 1.2;
  if (allText.includes('official')) score += 0.5;
  // ⭐ OFFICIAL CHANNEL PEHCHAN (Hero, 2026-11-06 raat — Telegram wale music
  // boton wala jugaad): gaana usi ke channel se pehle mile jiska woh hai —
  // T-Series ka gaana T-Series se, Arijit Singh ka gaana Arijit Singh ke
  // apne channel se, Honey Singh/Badshah ka unke channel se.
  // Nishan 1: user ne query me channel/artist ka naam khud likha hai aur
  // natija usi channel se hai.
  const queryF2 = foldText(query);
  if (channelF.length >= 4 && queryF2.includes(channelF)) score += 2.5;
  // Nishan 2: title ke hisse (Artist — Song | ...) me jo artist likha hai,
  // channel ka naam bhi wahi hai = artist ka apna official channel.
  if (channelF.length >= 4) {
    const segments = titleF.split(/[|—:()[\]-]+/).map((x) => x.trim()).filter(Boolean);
    if (segments.some((seg) => seg === channelF || (seg.length >= 5 && channelF.includes(seg)) || (channelF.length >= 5 && seg.includes(channelF)))) score += 2.0;
  }
  const queryF = foldText(query);
  for (const w of PENALTY_WORDS) if (allText.includes(w) && !queryF.includes(w)) score -= 2.2;
  if (!queryF.includes('remix') && allText.includes('remix')) score -= 2.2;
  // CLICKBAIT DEMOTE (2026-11-07 raat, Hero ki report): title me keyword
  // bharmaar (bahut '|' hisse) ya bina mange "New Hindi Song 20XX" ka dawa —
  // local uploader ke nakli upload ki pehchan; official title saaf hota hai.
  const pipeCount = (track.title || '').split('|').length - 1;
  if (pipeCount >= 3) score -= 1.0;
  if (/new (hindi |bollywood )?song 20\d\d/.test(titleF) && !/20\d\d/.test(queryF)) score -= 1.0;
  const dur = Number(track.duration) || 0;
  if (dur && dur < 100) score -= 1.2;
  if (dur > 560) score -= 0.8;
  return Math.round(score * 100) / 100;
}

// Ek hi gaane ki nakal dono source se aaye to behtar wala rakho.
// Pehchan: saavn ke gaane ka naam YT title ke andar mile (fold karke).
function songCoreOf(track) {
  if (track.source === 'jiosaavn') return foldText(track.song || '');
  return '';
}

/** SoundCloud score: khoj-mel sabse bada, phir plays ki halki taakat.
 *  SC ka kaam Phonk/remix wali jagah bharna hai — jahan YT/Saavn kamzor
 *  hote hain wahan ye khud upar aa jayega; jahan woh mazboot hain wahan
 *  peeche rahega. Pure. */
export function scoreScTrack(track, query) {
  let s = queryOverlap(query, `${track.title || ''} ${track.channel || ''}`) * 4;
  s += Math.min(1.5, Math.log10((track.viewCount || 0) + 1) * 0.25);
  return s;
}

export async function searchMusicMerged(query, limit = 8, opts = {}) {
  const [saavnRes, ytRes, scRes] = await Promise.allSettled([
    searchSongsSaavn(query, 8),
    searchSongs(query, 8),
    searchSongsSc(query, 8),
  ]);
  const saavn = saavnRes.status === 'fulfilled' ? saavnRes.value || [] : [];
  const ytRaw = ytRes.status === 'fulfilled' ? ytRes.value || [] : [];
  const scRaw = scRes.status === 'fulfilled' ? scRes.value || [] : [];

  const pool = [];
  // LAMBE MIX BAND (2026-11-07): 10-min cap se lambe natije pool me ghusne
  // hi na do — Phonk jaisi category me 1-ghante wale playlist sabse upar
  // baithe the, woh na download hote hain na WhatsApp par jate hain.
  for (const t of saavn) if (isSongLength(t)) pool.push({ track: t, score: Number(t._score) || 0 });
  ytRaw.forEach((t, i) => {
    if (!isSongLength(t)) return;
    let s = scoreYtTrack(t, query, i, ytRaw.length);
    // DURATION CROSS-CHECK (2026-11-07 raat): Saavn par wahi gaana maujood
    // hai aur is YT upload ki lambai usse 30s+ alag hai to ye woh gaana ho
    // hi nahi sakta (clickbait/short nakli version) — zor se neeche dabao.
    const tf = foldText(t.title || '');
    for (const st of saavn) {
      const core = songCoreOf(st);
      if (core && core.length >= 4 && st.duration && tf.includes(core)) {
        const d = Number(t.duration) || 0;
        if (d && Math.abs(d - Number(st.duration)) > 30) s -= 3;
        break;
      }
    }
    pool.push({ track: t, score: s });
  });
  for (const t of scRaw) if (isSongLength(t)) pool.push({ track: t, score: scoreScTrack(t, query) });
  // STRICT GATE (2026-11-07 raat, typed search par hi): gaane ke naam se
  // ZERO mel wala track chahe kitna bhi mashhoor ho (plays/views), woh IS
  // khoj ka gaana nahi hai — "Officially Mujhe teri jarurat hai" par Ek
  // Villain ke dusre hit (Humdard/Galliyan) upar baith gaye the kyunki unke
  // plays zyada the. Category browsing par ye gate NAHI (wahan naam hota hi
  // nahi, mahaul hota hai).
  if (opts.strict) {
    for (const e of pool) {
      const txt = e.track.source === 'jiosaavn' ? (e.track.song || e.track.title || '')
        : e.track.source === 'soundcloud' ? `${e.track.title || ''} ${e.track.channel || ''}`
        : (e.track.title || '');
      if (queryOverlap(query, txt) === 0) e.score -= 6;
    }
  }
  pool.sort((a, b) => b.score - a.score);

  const out = [];
  const perSource = { jiosaavn: 0, yt: 0, soundcloud: 0 };
  const CAPS = { jiosaavn: 6, yt: 6, soundcloud: 3 };
  const seenCore = new Set();
  for (const { track, score } of pool) {
    if (out.length >= limit) break;
    const src = track.source === 'jiosaavn' ? 'jiosaavn' : (track.source === 'soundcloud' ? 'soundcloud' : 'yt');
    if (perSource[src] >= CAPS[src]) continue;
    const core = songCoreOf(track);
    if (core) {
      if (seenCore.has(core)) continue;
      seenCore.add(core);
    }
    track._score = score;
    perSource[src]++;
    out.push(track);
  }
  // Kuch na mile to jo mila wahi (khaali se behtar) — par lambe mix yahan bhi nahi
  let final = out.length ? out : [...saavn, ...ytRaw, ...scRaw].filter(isSongLength).slice(0, limit);
  // DEAD FILTER (2026-11-07): jo YT video baar-baar download fail ho chuka
  // hai, use list me dikhao hi mat — "list me hai par bajta nahi" wali
  // shikayat ki jad yahi thi. Nishan music.js ke music_dead me rehta hai;
  // jaanch fail ho to bina filter ke aage badho (search kabhi na ruke).
  try {
    const ytIds = final.filter((t) => t.source !== 'jiosaavn').map((t) => t.id).filter(Boolean);
    if (ytIds.length) {
      const dead = await deadVideoIds(ytIds);
      if (dead.size) final = final.filter((t) => t.source === 'jiosaavn' || !dead.has(t.id));
    }
  } catch { /* upar likha hai — search nahi rukegi */ }
  return final;
}

/** List ke gaane jinhe list bante hi peeche se download (prefetch) karna
 *  hai — dikhaye gaye page se, kram barkarar, zyada se zyada `limit`.
 *  YouTube -> {videoId}, SoundCloud -> {scId, url}.
 *  Saavn picks link se jate hain, unhe prefetch ki zaroorat nahi. Pure. */
export function prefetchTargets(results, limit = 3) {
  const out = [];
  for (const r of results || []) {
    if (out.length >= limit) break;
    if (!r || !r.id) continue;
    if (r.duration && r.duration > MAX_SONG_SEC) continue;
    if (r.source === 'jiosaavn') continue;
    if (r.source === 'soundcloud') {
      if (r.url) out.push({ scId: r.id, url: r.url, title: r.title || '' });
      continue;
    }
    out.push({ videoId: r.id, title: r.title || '' });
  }
  return out;
}

// ---------- CROSS-SOURCE RESCUE ke helpers (2026-11-07) ----------
// Ek source fail ho jaye to wahi gaana dusre source se lane ke liye pehchan
// sakht rakhi hai: galat gaana bhejna, fail se bhi bura hai.
const RESCUE_NOISE = new Set(['official', 'video', 'song', 'full', 'hd', '4k', '8k', 'lyrical', 'lyrics', 'audio', 'new', 'latest', 'mp3', 'feat', 'ft', 'hq']);

/** YT ke lambe title se saaf khoj-shabd: pehla hissa (| se pehle), brackets
 *  bahar, "Artist - Song" ho to gaane wala hissa, noise shabd bahar. Pure. */
export function rescueQueryFromTitle(title) {
  const raw = String(title || '');
  const segs = raw.split('|').map((x) => x.trim()).filter(Boolean);
  // Kaun sa hissa khoj banega: aam taur par PEHLA hissa (gaane ka naam wahi
  // hota hai). Par pehla hissa sirf Devanagari hook ho ("ओ सांवरे || O
  // Saanware Mujhe Teri Jarurat Hai || Kanhaiya Mittal") to Latin aksharon
  // wala SABSE LAMBA hissa — asal naam wahi hai, usi par Saavn milega.
  let s = segs[0] || raw;
  if (!/[A-Za-z]{3,}/.test(s)) {
    const latin = segs.filter((x) => /[A-Za-z]{3,}/.test(x));
    if (latin.length) s = latin.sort((a, b) => b.length - a.length)[0];
  }
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  const parts = s.split(/\s*[—–-]\s*/).filter(Boolean);
  if (parts.length >= 2) s = parts.slice(1).join(' ');
  const words = foldText(s).split(' ').filter((w) => w && !RESCUE_NOISE.has(w));
  return [...new Set(words)].join(' ');
}

/** Saavn natijon me se wahi gaana chuno jo YT title se PAKKA mel khaye:
 *  khoj ka pehla shabd (sabse pehchan wala) lazmi, kul mel >= 70%.
 *  Mel na ho to null — galat gaana kabhi nahi jayega. Pure. */
export function pickSaavnRescue(ytTitle, candidates) {
  const q = rescueQueryFromTitle(ytTitle);
  if (!q) return null;
  const qWords = q.split(' ');
  let best = null;
  let bestScore = 0;
  for (const c of candidates || []) {
    if (!c?.id) continue;
    const hayWords = new Set(foldText(`${c.song || c.title || ''} ${c.artist || ''}`).split(' ').filter(Boolean));
    if (!hayWords.has(qWords[0])) continue;
    const hits = qWords.filter((w) => hayWords.has(w)).length;
    const score = hits / qWords.length;
    if (score >= 0.7 && score > bestScore) { best = c; bestScore = score; }
  }
  return best;
}

/** Rescue ke liye DUSRA upload: fail hue video se alag pehla length-ok
 *  natija — kharab upload par atke rehne se dusra upload aksar chal jata
 *  hai. Pure. */
export function pickAltUpload(results, failedId) {
  return pickAltUploads(results, [failedId], 1)[0] || null;
}

/** Kai dusre uploads ek saath (rescue v3): bahar rakhe ids chhod kar,
 *  kram barkarar, zyada se zyada n. Pure. */
export function pickAltUploads(results, excludeIds, n = 3, query = '') {
  const ex = new Set(Array.isArray(excludeIds) ? excludeIds : [excludeIds]);
  const cands = [];
  for (const r of results || []) {
    if (!r?.id || ex.has(r.id)) continue;
    if (!isSongLength(r)) continue;
    cands.push(r);
  }
  // Query mile to wahi tarazu (official/views/clickbait demote) — pehle rescue
  // bina parkhe agla upload utha leta tha, clickbait yahin se ghusta tha.
  if (query) cands.sort((a, b) => scoreYtTrack(b, query, 0) - scoreYtTrack(a, query, 0));
  return cands.slice(0, n);
}
