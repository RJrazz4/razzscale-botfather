import * as evo from '../services/transport.js';
import { clampListTitle } from '../services/transport.js';
import { env } from '../config/env.js';
import { setFlow, getFlow, logUsage } from '../db/pool.js';
import { spawnSubBot } from '../services/spawner.js';
import { searchSongs } from '../services/music.js';
import { searchSongsSaavn } from '../services/jiosaavn.js';
import { searchMusicMerged, prefetchTargets, isSongLength } from '../services/musicSearch.js';
import { findRepeat, recordPick, getRecent } from '../services/musicMemory.js';
import { enqueueJob } from '../services/worker.js';
import { vipMenuText, vipPitchText, VIP_FEATURES } from './vip.js';
import { handleConsult, resendConsultScreen, CONSULT_BACK } from './consult.js';
import { handleWork, handleOwnerWork, resendWorkScreen, WORK_BACK } from './workplace.js';

// FRONTEND BRIEF V1.0 (docs/FRONTEND-BRIEF-PLAN.md): music-first home, categories,
// tap-only navigation (defined action IDs), guided VIP consultation (handlers/consult.js).
// Speed usool: home/zone/category/service lists PURE STATIC builders hain — unke path par
// koi search/LLM/extra DB call nahi; handler sirf flow read/write karta hai.

const BOT_TYPES = { '1': 'support', '2': 'ai', '3': 'music', '4': 'leadgen' };
const BOT_LABELS = { support: 'Auto-Reply / Support Bot', ai: 'AI Assistant Bot', music: 'Music Bot', leadgen: 'Lead Gen Bot' };
const META_AI_LINK = 'https://wa.me/13135550069?text=Create%20an%20image'; // Meta AI official chat (placeholder number pattern — deploy par verify karna)
const FLOW_TTL = 1800; // lambe flows (music pick, consult, spawn) ke liye; default 600 kam padta tha

// Text fallback (list render na ho to yahi menu hai — numbers TAP wale naye order ke hisaab se)
const MENU_TEXT = `╭━━━ ❖ ━━━╮
   🤖 *RAZZSCALE AI BOTFATHER*
╰━━━ ❖ ━━━╯

Namaste! 🙏

🎵 *Gaane ka naam likho — gaana yahin milega!*
Bas naam bhej do, menu ghumane ki zaroorat nahi.

👇 *Ya number likho / list se tap karo:*

1️⃣ *Music Zone* 🎵 — Category ya search
2️⃣ *Free AI Chat* 💬 — Kuch bhi pucho
3️⃣ *VIP Automation* 🚀 — Business ke liye khaas
4️⃣ *Apna Bot Banao* 🤖 — FREE me shuru
5️⃣ *Kaam Karwao* ✍️ — Likhai wala kaam

🎨 Image ke liye *image* likho.
━━━━━━━━━━━━━━━
📞 *Insaan se baat karni ho* to yahin likho — Boss khud jawab denge.`;

// ---------- Home menu (STATIC builder — music sabse upar, bada) ----------
export function homeRows() {
  return [
    { rowId: 'mz', title: '🎵 MUSIC ZONE', description: 'Gaane suno — category ya search' },
    { rowId: 'ai', title: '💬 Chat with AI', description: 'Kuch bhi pucho, jawab milega' },
    { rowId: 'vip', title: '🚀 VIP Automation', description: 'Business ke liye khaas kaam' },
    { rowId: 'mk', title: '🤖 Apna Bot Banao', description: 'Apna WhatsApp bot FREE me' },
    { rowId: 'work', title: '✍️ Kaam Karwao', description: 'Likhai wala kaam — caption, message, script' },
  ];
}
async function sendHomeMenu(inst, from, userId) {
  // ADAPTIVE CHEHRA (2026-11-07 raat, Hero ka 4D order): purana user (2+ gaane
  // asal me bheje ja chuke) ko guided menu nahi — pehchan wala chhota chehra,
  // Recently Played SABSE UPAR. Naya user = guided menu (use sikhana hai).
  // History read fail ho to normal menu hi jayega.
  let returning = false;
  if (userId) {
    try {
      const hist = await getRecent(userId, 8);
      returning = hist.filter((r) => r.status === 'sent').length >= 2;
    } catch { returning = false; }
  }
  const rows = returning
    ? [{ rowId: 'music_recent', title: '🕘 Recently Played', description: 'Tumhare pichhle gaane — tap karke phir suno' }, ...homeRows()]
    : homeRows();
  // List primary (footer ON — menu = footer rule ki jagah); fail ho to text menu fallback (footer ON).
  await evo.sendList(inst, from, {
    title: '🤖 RazzScale AI BotFather', buttonText: 'Menu Dekho',
    description: MENU_TEXT, footer: true,
    listBody: returning
      ? 'Wapas aa gaye! 🙏\n\n🎵 *Gaane ka naam likho — gaana yahin milega!*\nYa apne pichhle gaane ek tap me suno 👇'
      : 'Namaste! 🙏\n\n🎵 *Gaane ka naam likho — gaana yahin milega!*\nYa neeche button se menu kholo 👇',
    sections: [{ title: '🤖 RazzScale Services', rows }],
  }).catch(async () => {
    console.error('[masterMenu] home list failed → text menu fallback');
    await evo.sendText(inst, from, MENU_TEXT, { footer: true }).catch(() => {});
  });
}

// ---------- Music Zone (STATIC builders) ----------
export const CATEGORIES = {
  cat_trending: { label: '🔥 Trending', query: 'latest trending songs india' },
  cat_bollywood: { label: '🎬 Bollywood', query: 'bollywood latest hits' },
  cat_punjabi: { label: '🎤 Punjabi', query: 'punjabi latest hits' },
  cat_phonk: { label: '🔊 Phonk', query: 'phonk music' },
  cat_devotional: { label: '🙏 Devotional', query: 'bhakti bhajan' },
  cat_discover: { label: '✨ Discover', query: 'viral songs india' },
};
const CAT_KEYWORDS = { trending: 'cat_trending', bollywood: 'cat_bollywood', punjabi: 'cat_punjabi', phonk: 'cat_phonk', devotional: 'cat_devotional', bhajan: 'cat_devotional', discover: 'cat_discover' };
export function zoneRows() {
  // SEARCH SABSE UPAR (2026-11-07, Hero ka order): user zyadatar apna gaana
  // khojne aata hai — category baad me. RowIds wahi purane, sirf kram badla.
  return [
    { rowId: 'cat_search', title: '🔍 Gaana Search Karo', description: 'Apne gaane ka naam likho' },
    { rowId: 'music_recent', title: '🕘 Recently Played', description: 'Tumhare pichhle gaane — tap karke phir suno' },
    ...Object.entries(CATEGORIES).map(([id, c]) => ({ rowId: id, title: c.label, description: `${c.label.replace(/^\S+\s/, '')} gaane suno` })),
    { rowId: 'nav_menu', title: '🏠 Main Menu', description: 'Home par wapas' },
  ];
}
async function sendMusicZone(inst, from) {
  // DESIGN (2026-11-06, Hero ki report): pehle text-list + tappable list DONO
  // jate the — user ko wahi categories do baar dikhti thi ("duplicate screen").
  // Ab home-menu wala pattern: pehle SIRF tappable list; lamba text sirf tab
  // jab list fail ho jaye (transport fail par throw karta hai, dono channels).
  const listed = await evo.sendList(inst, from, {
    title: '🎵 Music Zone', buttonText: 'Category Chuno',
    description: 'Kaunsi category ke gaane? Tap karo 👇',
    sections: [{ title: 'Categories', rows: zoneRows() }],
  }).then(() => true).catch(() => false);
  if (!listed) {
    await evo.sendText(inst, from, '🎵 *Music Zone*\n\nCategory tap karo — ya number likho:\n\n' +
      ['1. 🔍 Gaana Search Karo', '2. 🕘 Recently Played', ...Object.values(CATEGORIES).map((c, i) => `${i + 3}. ${c.label}`)].join('\n'));
  }
}

// --- Music results helpers (KDMusic-style: 8 results, 3-3 ke pages, tappable list + number fallback) ---
const MUSIC_PAGE = 6; // 2026-11-07 raat: 3 bahut kam the — sahi gaana aksar 'More' ke peeche chhupta tha; 6 gaane + More + Back + Menu = 9 rows, WhatsApp ki 10-row hadd ke andar
function musicPageText(results, fromIdx, toIdx) {
  const lines = results.slice(fromIdx, toIdx).map((r, i) => `${fromIdx + i + 1}. ${r.title}`).join('\n');
  const moreLine = toIdx < results.length ? '\nAur results ke liye "more" likho 👇' : '';
  return `${fromIdx === 0 ? 'Top results:' : 'Aur results:'}\n\n${lines}\n\nNumber likho (1-${toIdx}) — audio bhej dunga.${moreLine}`;
}
function musicListRows(results, shown) {
  // List budget: sirf pehla page (3) + More + Back + Menu ≤ 6 rows. Aage ke pages par list
  // NAHI bhejta (chat spam); number-tap har dikhaye hue track par text se chalta hai.
  const page = Math.min(shown, MUSIC_PAGE);
  const rows = results.slice(0, page).map((r, i) => {
    const dur = r.duration ? `${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')}` : '';
    // Channel bhi description me (2026-11-07 raat): title 24-char clamp me
    // clickbait aur official ek jaise dikhte the — user ko T-Series jaisa
    // channel naam dikhe to galat upload khud pehchan lega.
    const descParts = [r.title || 'Gaana'];
    if (r.source === 'yt' && r.channel) descParts.push(r.channel);
    if (dur) descParts.push(dur);
    return {
      rowId: String(i + 1), // global index — sessionRouter list-reply ko isi se pick banata hai
      // WhatsApp list limit: row title ≤24 chars — poora title description (≤72) me rehta hai
      title: clampListTitle(r.title || 'Gaana'),
      description: descParts.join(' • ').slice(0, 72),
    };
  });
  if (results.length > page) rows.push({ rowId: 'more', title: '➕ More tracks', description: 'Aur results dekho' });
  rows.push({ rowId: 'nav_back', title: '⬅️ Back', description: 'Music Zone par wapas' });
  rows.push({ rowId: 'nav_menu', title: '🏠 Main Menu', description: 'Home par wapas' });
  return rows;
}
async function sendMusicList(inst, from, results, shown) {
  // List gayi to true, fail (throw) ho to false — caller tab text page bhejega.
  return evo.sendList(inst, from, {
    title: '🎵 Top Results', buttonText: 'Gaana Chuno',
    description: 'Tap karke gaana chuno — ya number likh do 👇',
    sections: [{ title: 'Results', rows: musicListRows(results, shown) }],
  }).then(() => true).catch(() => false);
}
// RECENTLY PLAYED (2026-11-07, Hero ki manjuri): listening_history se user ke
// pichhle gaane — wahi pick wali list, tap karte hi aam pick flow se wahi
// gaana dobara bajta hai (aur ginati history me badhti hai). History khaali
// ho to saaf text + zone wahi rehta hai — dead end nahi.
async function sendRecentList(ctx) {
  const { user, from, inst, flow } = ctx;
  let rows = [];
  try { rows = await getRecent(user.id, 8); } catch { rows = []; }
  if (!rows.length) {
    await evo.sendText(inst, from, 'Abhi tak tumne koi gaana nahi suna 🎵 — pehle Search se apna gaana khoj kar suno, phir woh yahan milega.');
    return;
  }
  const results = rows.map((r) => ({
    id: r.provider_id, title: r.title, source: r.provider,
    url: r.ref_url || undefined, duration: r.duration_sec || undefined,
    artist: r.artist || undefined, channel: r.provider === 'yt' ? (r.artist || undefined) : undefined,
  }));
  const shown = Math.min(MUSIC_PAGE, results.length);
  await setFlow(user.id, 'master', { step: 'music_pick', results, shown, query: 'recent', from: 'recent', lastTitle: flow?.lastTitle }, FLOW_TTL);
  const listed = await evo.sendList(inst, from, {
    title: '🕘 Recently Played', buttonText: 'Gaana Chuno',
    description: 'Tumhare pichhle gaane — tap karo, wahi gaana phir bajega 👇',
    sections: [{ title: 'Pichhle gaane', rows: musicListRows(results, shown) }],
  }).then(() => true).catch(() => false);
  if (!listed) await evo.sendText(inst, from, musicPageText(results, 0, shown));
}
// Khali results (brief §11 — empty state): saaf message + doosri category/search/menu ke rows
async function sendMusicEmpty(inst, from) {
  await evo.sendText(inst, from, 'Is khoj me koi gaana nahi mila 😔 — doosri category try karo, ya apna gaana search karo.');
  await evo.sendList(inst, from, {
    title: '🎵 Kuch nahi mila', buttonText: 'Options Dekho',
    description: 'Aur kya kar sakte ho 👇',
    sections: [{ title: 'Options', rows: [
      { rowId: 'cat_search', title: '🔍 Gaana Search Karo', description: 'Apne gaane ka naam likho' },
      { rowId: 'nav_back', title: '⬅️ Categories Dekho', description: 'Music Zone par wapas' },
      { rowId: 'nav_menu', title: '🏠 Main Menu', description: 'Home par wapas' },
    ] }],
  }).catch(() => {});
}

// SMART MUSIC MEMORY (2026-11-07): repeat hit par wahi recording dobara
// bhejna — bilkul pick wale raste se (busy guard + wahi music_download job),
// taaki delivery ke saare niyam (vault/saavn chain, fail par saaf text) ek
// jaise rahein. Delivery fail ho to worker ka failure text user ko naya
// search karne ka rasta deta hi hai.
async function deliverRepeat(ctx, hit, query) {
  const { user, from, inst } = ctx;
  // results me sirf yahi ek gaana — delivery ke baad "Gaana chuno" khule to
  // kam se kam yahi track phir dikhe (poori purani list is raste par nahi hai).
  const single = [{ id: hit.provider_id, title: hit.title, source: hit.provider, url: hit.ref_url || undefined, duration: hit.duration_sec || undefined }];
  await setFlow(user.id, 'master', { step: 'music_busy', videoId: hit.provider_id, lastTitle: hit.title, results: single, shown: 1, query }, FLOW_TTL);
  await evo.sendText(inst, from, `🎵 Ye gaana tum pehle bhi sun chuke ho — wahi wala phir bhej raha hoon: *${hit.title}*\nDusri version chahiye to artist ya version (jaise remix) saath likh kar bhejo.`);
  await evo.sendPresence(inst, from, 'recording', 55000);
  await enqueueJob('music_download',
    { instance: inst, to: from, userId: user.id, videoId: hit.provider_id, title: hit.title,
      source: hit.provider, songId: hit.provider === 'jiosaavn' ? hit.provider_id : undefined,
      scId: hit.provider === 'soundcloud' ? hit.provider_id : undefined,
      url: hit.provider === 'jiosaavn' ? undefined : (hit.ref_url || `https://www.youtube.com/watch?v=${hit.provider_id}`) },
    `music:repeat:${user.id}:${hit.provider_id}:${Date.now()}`);
  recordPick({ userId: user.id, waId: from, pick: { id: hit.provider_id, source: hit.provider, title: hit.title, artist: hit.artist || '', durationSec: hit.duration_sec, url: hit.ref_url }, query }).catch(() => {});
}

// QUERY SAFAAI (2026-11-07 raat): typed search ke faltu shabd (official,
// full, hd...) gaane ke naam ka hissa nahi hote — ye khoj ko bigaad dete
// hain ("Officially Mujhe teri jarurat hai" par Saavn/YT bhatak gaye the).
const SEARCH_FILLER = new Set(['official', 'officially', 'full', 'hd', '4k', 'video', 'audio', 'mp3', 'download', 'lyrical']);
function cleanSearchQuery(q) {
  const kept = String(q || '').split(/\s+/).filter((x) => x && !SEARCH_FILLER.has(x.toLowerCase()));
  return kept.length ? kept.join(' ') : q;
}

// Category/typed search ka common pipeline: ack -> search -> pick state ya empty state
async function runMusicSearch(ctx, query, fromKind) {
  const { user, from, inst, flow } = ctx;
  if (fromKind === 'search') query = cleanSearchQuery(query);
  // SMART MUSIC MEMORY: typed search par pehle is user ki apni history —
  // pakka repeat mile to search chalaye bina wahi recording. Category
  // browsing (generic query) par ye check NAHI lagta. Memory fail ho to
  // aam search hi chalega (catch me khamosh).
  if (fromKind === 'search') {
    try {
      const hit = await findRepeat(user.id, query);
      if (hit) { await deliverRepeat(ctx, hit, query); return; }
    } catch { /* memory nahi chali — aam search */ }
  }
  await evo.sendText(inst, from, `🔍 *${query}* dhoondh raha hoon… bas ek minute, yahi raho 🎧`);
  await evo.sendPresence(inst, from, 'composing', 55000);
  // MERGED SEARCH (2026-11-06 raat): Saavn akela official gaana kai baar de
  // hi nahi pata tha (uski khoj me gaana hota hi nahi) aur cover upar rehte
  // the — isliye dono source parallel, ek hi tarazu par naap kar (musicSearch).
  // Merged fail ho to purani chain (Saavn -> YT) backup hai.
  let results = [];
  try { results = await searchMusicMerged(query, 8, { strict: fromKind === 'search' }); } catch { results = []; }
  if (!results.length) {
    try { results = await searchSongsSaavn(query, 8); } catch { results = []; }
    if (!results.length) { try { results = await searchSongs(query, 8); } catch { results = []; } }
  }
  if (!results.length) {
    await setFlow(user.id, 'master', { step: 'music_zone', lastTitle: flow?.lastTitle }, FLOW_TTL);
    await sendMusicEmpty(inst, from);
    return;
  }
  const shown = Math.min(MUSIC_PAGE, results.length);
  await setFlow(user.id, 'master', { step: 'music_pick', results, shown, query, from: fromKind, lastTitle: flow?.lastTitle }, FLOW_TTL);
  // PREFETCH (2026-11-07, Hero ka logic): list bante hi dikhaye gaye page ke
  // YT gaano ka download peeche se shuru — user tap kare, tab tak file
  // disk/vault me taiyaar. Search ho ya category/trending, ye function
  // dono ka saanjha rasta hai — isliye har list par lagega. Dedupe
  // idempotency key se hai; user ke pick jobs kataar me hamesha aage rehte
  // hain (worker claimNext ki priority).
  for (const tg of prefetchTargets(results.slice(0, shown))) {
    if (tg.scId) enqueueJob('music_prefetch', { scId: tg.scId, url: tg.url, title: tg.title }, `prefetch:sc:${tg.scId}`).catch(() => {});
    else enqueueJob('music_prefetch', { videoId: tg.videoId, title: tg.title }, `prefetch:${tg.videoId}`).catch(() => {});
  }
  // DESIGN (2026-11-06, wahi duplicate-screen report): results bhi pehle SIRF
  // tappable list — poora text page sirf list fail hone par jayega. ('more'
  // wale aage ke pages pehle ki tarah text hi rahenge — list budget ka niyam.)
  const listed = await sendMusicList(inst, from, results, shown);
  if (!listed) await evo.sendText(inst, from, musicPageText(results, 0, shown));
}

async function enterAiChat(inst, from, user) {
  await setFlow(user.id, 'master', { step: 'ai_chat' }, FLOW_TTL);
  await evo.sendText(inst, from, '💬 *AI Chat shuru!*\n\nBas apna sawaal ya baat likhte jao — main jawab deta rahunga, beech me menu nahi khulega.\nBahar nikalna ho to *menu* likh do ya list se Main Menu tap karo.');
}

// spawn type chooser (text + list) — maujooda flow, sirf helper me nikala
async function sendSpawnChooser(inst, from) {
  await evo.sendText(inst, from, `Kaun sa bot banana hai? Number likho ya list se tap karo:\n\n1. Auto-Reply / Support Bot\n2. AI Assistant Bot\n3. Music Bot\n4. Lead Gen Bot`);
  await evo.sendList(inst, from, {
    title: '🤖 Bot Types', buttonText: 'Bot Chuno',
    description: 'Kaun sa bot banana hai? Tap karo 👇',
    sections: [{ title: 'Bot Types', rows: [
      { rowId: '1', title: 'Auto-Reply / Support Bot', description: 'Customer sawalon ke auto-jawab' },
      { rowId: '2', title: 'AI Assistant Bot', description: 'Smart AI wala helper bot' },
      { rowId: '3', title: 'Music Bot', description: 'Gaana bajane wala bot' },
      { rowId: '4', title: 'Lead Gen Bot', description: 'Customer leads ikatthe karo' },
      { rowId: 'nav_menu', title: '🏠 Main Menu', description: 'Home par wapas' },
    ] }],
  }).catch(() => {});
}

// ---------- BACK map (brief §8: har state ka back target defined) ----------
// Return true = back handle ho gaya. Consult ke kadam handlers/consult.js ke paas hain.
async function handleBack(ctx) {
  const { user, from, inst, flow, state } = ctx;
  const goZone = async () => { await setFlow(user.id, 'master', { step: 'music_zone', lastTitle: flow?.lastTitle }, FLOW_TTL); await sendMusicZone(inst, from); };
  if (CONSULT_BACK[state]) {
    const prev = CONSULT_BACK[state];
    if (prev === 'menu') { await setFlow(user.id, 'master', { step: 'menu' }); await sendHomeMenu(inst, from, user.id); return true; }
    await setFlow(user.id, 'master', { step: prev, answers: flow?.answers || {} }, FLOW_TTL);
    await resendConsultScreen({ ...ctx, state: prev });
    return true;
  }
  if (WORK_BACK[state]) {
    const prev = WORK_BACK[state];
    if (prev === 'menu') { await setFlow(user.id, 'master', { step: 'menu' }); await sendHomeMenu(inst, from, user.id); return true; }
    await setFlow(user.id, 'master', { step: prev, work: flow?.work || {} }, FLOW_TTL);
    await resendWorkScreen({ ...ctx, state: prev });
    return true;
  }
  switch (state) {
    case 'music_zone': case 'music_done': case 'music_busy': case 'ai_chat':
    case 'spawn_type': case 'vip_pick':
      await setFlow(user.id, 'master', { step: 'menu' });
      await sendHomeMenu(inst, from, user.id);
      return true;
    case 'music_query':
      await goZone();
      return true;
    case 'music_pick':
      // category se aaye the to zone; typed search se aaye the to search prompt dobara
      if (flow?.from === 'search') {
        await setFlow(user.id, 'master', { step: 'music_query', lastTitle: flow?.lastTitle }, FLOW_TTL);
        await evo.sendText(inst, from, 'Gaane ka naam bhejo — main top results dunga.');
      } else await goZone();
      return true;
    case 'spawn_phone':
      await setFlow(user.id, 'master', { step: 'spawn_type' }, FLOW_TTL);
      await sendSpawnChooser(inst, from);
      return true;
    case 'spawn_confirm':
      await setFlow(user.id, 'master', { step: 'spawn_phone', botType: flow?.botType }, FLOW_TTL);
      await evo.sendText(inst, from, 'Theek hai — woh WhatsApp number dobara bhejo jis par ye bot chalega (country code ke saath, jaise 91XXXXXXXXXX).');
      return true;
    default:
      await setFlow(user.id, 'master', { step: 'menu' });
      await sendHomeMenu(inst, from, user.id);
      return true;
  }
}

export async function handleMasterMessage({ user, from, text, pushName, msgId, channel }) {
  // Channel: 'cloud' (Official API) ho to saare sends transport se Graph par jate hain
  // (inst = CLOUD_INSTANCE pseudo-instance); warna Evolution master — purana behavior
  // bilkul barkarar. Flow logic dono channels par EK hi hai.
  const inst = channel === 'cloud' ? evo.CLOUD_INSTANCE : env.masterInstance;
  let t = (text || '').trim();
  const flow = await getFlow(user.id, 'master');
  const state = flow?.step || 'menu';
  const lower = t.toLowerCase();
  const ctx = { user, from, text, t, lower, flow, state, inst, msgId, goHome: () => sendHomeMenu(inst, from, user.id) };

  // ===== Owner (Boss) work approval — SABSE PEHLE, kisi bhi state se upar =====
  // (Sirf owner number par chalta hai; customer ke liye hamesha false.)
  if (await handleOwnerWork(ctx)) return;

  // ===== Global nav — state dispatch se PEHLE (Back/Main Menu har jagah consistent) =====
  if (t === 'nav_menu' || lower === 'main menu') {
    await setFlow(user.id, 'master', { step: 'menu' });
    await sendHomeMenu(inst, from, user.id);
    return;
  }
  if (t === 'nav_back') { await handleBack(ctx); return; }

  // ===== Double-pick guard (brief §acceptance: double tap = dohra kaam nahi) =====
  // Pick ke baad state 'music_busy' hai. Worker delivery par use 'music_done' aur final
  // fail par 'music_zone' par le jata hai (worker.js moveBusyState) — is beech doosra
  // pick/job nahi banta, sirf intezaar wala jawab jata hai. Nav/menu hamesha khula hai.
  if (state === 'music_busy') {
    if (lower === 'menu') { await setFlow(user.id, 'master', { step: 'menu' }); await sendHomeMenu(inst, from, user.id); return; }
    await evo.sendText(inst, from, '⏳ Gaana aa raha hai… download ho raha hai, bas thoda sa sabr karo 🎧\nRukna ho to "menu" likh do.');
    return;
  }

  // ===== Music selection state — download+send WORKER ke paas (V2.1) =====
  // music_done bhi (2026-11-07 raat, Hero ki live report): gaana bajne ke baad
  // worker results ko music_done me carry karta hai — purani Top Results list
  // ka number-tap WAHIN pick hai. Pehle ye tap home-menu ke number samjhe jate
  // the ('2' = AI Chat khul jata tha!) — ab list ka number = list ka gaana.
  if (state === 'music_pick' || state === 'music_done') {
    const results = flow.results || [];
    const shown = flow.shown || Math.min(MUSIC_PAGE, results.length);
    if (['more', 'aur'].includes(lower)) {
      if (shown >= results.length) {
        await evo.sendText(inst, from, 'Bas itne hi results mile is gaane ke 🙏 — number likho ya "menu" likho.');
      } else {
        const newShown = Math.min(shown + MUSIC_PAGE, results.length);
        await setFlow(user.id, 'master', { step: 'music_pick', results, shown: newShown, query: flow.query, from: flow.from, lastTitle: flow.lastTitle }, FLOW_TTL);
        await evo.sendText(inst, from, musicPageText(results, shown, newShown));
        // aage ke pages par list nahi (rows budget + spam) — pehle page ki list chat me maujood hai
      }
      return;
    }
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= shown && results[n - 1]) {
      const pick = results[n - 1];
      // Busy guard: download chalne tak state 'music_busy' (videoId ke saath) —
      // isi dauraan dobara tap par dusra job NAHI jayega.
      // results/shown/query bhi saath rakho — delivery ke baad worker inhe
      // music_done me aage badhayega, taaki "Gaana chuno" option wahi list
      // dobara khol sake (2026-11-07, Hero ka order).
      await setFlow(user.id, 'master', { step: 'music_busy', videoId: pick.id, lastTitle: pick.title, results, shown, query: flow.query }, FLOW_TTL);
      await evo.sendText(inst, from, `"${pick.title}" bhej raha hoon, ek minute…`);
      await evo.sendPresence(inst, from, 'recording', 55000);
      await enqueueJob('music_download',
        { instance: inst, to: from, userId: user.id, videoId: pick.id, title: pick.title,
          // Source routing (FAST MUSIC v2): jiosaavn picks par worker saavn chain
          // chalata hai; url sirf YT picks par (andar ki delivery chain ke liye —
          // failure par user ko YouTube link KABHI nahi jata, 2026-11-07 niyam).
          source: pick.source || 'yt', songId: pick.source === 'jiosaavn' ? pick.id : undefined,
          scId: pick.source === 'soundcloud' ? pick.id : undefined,
          // Rescue ke liye: isi list ke dusre YT uploads (usi gaane ke) —
          // pehla upload fail ho to worker inhe ek-ek karke parkhega.
          altIds: (results || [])
            .filter((r) => r && r.id && r.id !== pick.id && r.source !== 'jiosaavn' && r.source !== 'soundcloud' && isSongLength(r))
            .slice(0, 3).map((r) => r.id),
          url: pick.source === 'jiosaavn' ? undefined : pick.url },
        `music:${msgId || `${user.id}:${pick.id}:${Date.now()}`}`);
      // SMART MUSIC MEMORY: pick history me likho (repeat detection ki neev).
      // 'recent' wali list se pick hua ho to woh asal khoj-query nahi hai —
      // last_query me use mat ghusao (purani achhi query surakshit rahe).
      recordPick({ userId: user.id, waId: from, pick, query: flow.query && flow.query !== 'recent' ? flow.query : undefined }).catch(() => {});
      return;
    }
    // Number/more nahi hai — par RESULTS khule hue hain aur user ne koi naam
    // likha hai to woh NAYI khoj hai (2026-11-07, Hero: "har option par bhi
    // search karne se gaana milega"). Escape shabd (menu/greeting/lyrics)
    // neeche ke flows ke liye chhode hain — wohi purane raste chalenge.
    if (t && !['hi', 'hii', 'hello', 'hey', 'menu', 'start', 'namaste', 'lyrics'].includes(lower)) {
      await runMusicSearch(ctx, t, 'search');
      return;
    }
    // kuch bhi nahi bacha to neeche ke flows (menu aadi) ko mauka do — return mat karo
  }

  // ===== TAP mapping — purani chats ke rowIds -> naye actions (dead end kahin nahi) =====
  // Gate: sirf menu-ish states me, taaki state-flows (spawn/ai/consult/music numbers) na takrayen.
  // Ye consult entry se PEHLE hai taaki m5 -> 'vip' bhi consultation khole.
  if (['menu', 'music_done', 'music_zone', 'ai_chat'].includes(state)) {
    const TAP_MAP = { m1: 'mk', m2: 'mz', m3: 'ai', m4: 'image', m5: 'vip', music_new: 'mz' };
    if (TAP_MAP[t]) { t = TAP_MAP[t]; ctx.t = t; }
  }

  // ===== GAANA CHUNO — wahi results list dobara (2026-11-07, Hero ka order) =====
  // Gaana bajne ke baad wala 4th option: ek baar search hua tha, usi list se
  // dusra gaana chunna hai (jaise chuna hua gaana duplicate/waisa-na-mila ho).
  // List flow ke results me rehti hai (pick -> busy -> done, worker aage
  // badhata hai). Na mile (purani chat) to seedha search prompt — dead end nahi.
  if (t === 'music_list' && ['music_done', 'music_pick', 'music_zone', 'menu', 'ai_chat'].includes(state)) {
    const last = flow?.results || [];
    if (last.length) {
      const shown = Math.min(flow.shown || MUSIC_PAGE, last.length);
      await setFlow(user.id, 'master', { step: 'music_pick', results: last, shown, query: flow.query || '', from: 'search', lastTitle: flow?.lastTitle }, FLOW_TTL);
      const listed = await sendMusicList(inst, from, last, shown);
      if (!listed) await evo.sendText(inst, from, musicPageText(last, 0, shown));
    } else {
      await setFlow(user.id, 'master', { step: 'music_query', lastTitle: flow?.lastTitle }, FLOW_TTL);
      await evo.sendText(inst, from, 'Purani list ab nahi mili — gaane ka naam likho, phir se dhoondh deta hoon 🎵');
    }
    return;
  }

  // ===== RECENTLY PLAYED — global route (2026-11-07 raat) =====
  // Home ke adaptive chehre me Recently Played sabse upar hai — uska tap
  // menu/ai_chat state se bhi yahin aayega (music_zone ka apna rasta neeche hai).
  if (t === 'music_recent' && ['menu', 'music_done', 'ai_chat'].includes(state)) {
    await sendRecentList(ctx);
    return;
  }

  // ===== VIP Consultation (naya state machine — masterMenu sirf route karta hai) =====
  if (await handleConsult(ctx)) return;

  // ===== Workplace (likhai ke orders) =====
  if (await handleWork(ctx)) return;

  // ===== Music Zone state =====
  if (state === 'music_zone') {
    if (t === 'mz') { await sendMusicZone(inst, from); return; }
    const catId = CATEGORIES[t] ? t : (CAT_KEYWORDS[lower] || null);
    if (catId) { await runMusicSearch(ctx, CATEGORIES[catId].query, 'category'); return; }
    if (t === 'cat_search' || ['1', 'search', 'khojo'].includes(lower)) {
      await setFlow(user.id, 'master', { step: 'music_query', lastTitle: flow?.lastTitle }, FLOW_TTL);
      await evo.sendText(inst, from, 'Gaane ka naam bhejo — main top results dunga.');
      return;
    }
    if (t === 'music_recent' || ['2', 'recent'].includes(lower)) {
      await sendRecentList(ctx);
      return;
    }
    const zn = Number(t);
    if (Number.isInteger(zn) && zn >= 3 && zn <= 8) {
      const catId = Object.keys(CATEGORIES)[zn - 3];
      await runMusicSearch(ctx, CATEGORIES[catId].query, 'category');
      return;
    }
    // kuch aur likha = seedha gaana search maan lo (zone se typed naam bhi chalega)
    if (t) { await runMusicSearch(ctx, t, 'search'); return; }
    await sendMusicZone(inst, from);
    return;
  }

  // ===== Lyrics (menu/music_done par, lastTitle yaad ho) =====
  if (lower === 'lyrics' && (state === 'menu' || state === 'music_done') && flow?.lastTitle) {
    await enqueueJob('lyrics',
      { instance: inst, to: from, userId: user.id, title: flow.lastTitle },
      `lyrics:${msgId || `${user.id}:${Date.now()}`}`);
    return;
  }

  // ===== VIP legacy pick (purana static pitch — backward compat) =====
  if (state === 'vip_pick' && ['1', '2', '3', '4', '5'].includes(t)) {
    const feature = VIP_FEATURES[Number(t) - 1];
    await setFlow(user.id, 'master', { step: 'menu' });
    await logUsage(user.id, 'vip_pitch');
    await evo.sendText(inst, from, vipPitchText(feature));
    return;
  }

  // ===== Bot-create wizard (maujooda spawn flow — bilkul chheda nahi) =====
  if (state === 'spawn_type' && BOT_TYPES[t]) {
    await setFlow(user.id, 'master', { step: 'spawn_phone', botType: BOT_TYPES[t] }, FLOW_TTL);
    await evo.sendText(inst, from, `Theek hai — *${BOT_LABELS[BOT_TYPES[t]]}* banega.\nAb woh WhatsApp number bhejo jis par ye bot chalega (country code ke saath, jaise 91XXXXXXXXXX). Us number par pairing code aayega.`);
    return;
  }
  if (lower === 'naya code') {
    const { rows } = await (await import('../db/pool.js')).pool.query(
      `select * from sessions where user_id=$1 and status='awaiting_pair' order by created_at desc limit 1`, [user.id]);
    if (rows[0]) {
      const { resendPairing } = await import('../services/spawner.js');
      const code = await resendPairing(rows[0]);
      await evo.sendText(inst, from, code ? `Naya pairing code: *${code}*\nWhatsApp → Linked Devices → Link with phone number me daalo.` : 'Code abhi nahi ban paya — ek minute me phir "naya code" likho.');
      return;
    }
  }
  if (state === 'spawn_phone') {
    const phone = t.replace(/\D/g, '');
    if (phone.length < 11) { await evo.sendText(inst, from, 'Number sahi se bhejo (91 ke saath 10 digit).'); return; }
    await setFlow(user.id, 'master', { step: 'spawn_confirm', botType: flow.botType, phone }, FLOW_TTL);
    await evo.sendText(inst, from, `Confirm karo: kya *${phone}* tumhara APNA WhatsApp number hai, aur tum is par bot jodne ke liye taiyaar ho?\n\n*HAAN* likho to pairing code bhejta hoon.`);
    return;
  }
  if (state === 'spawn_confirm') {
    if (!['haan', 'ha', 'yes', 'y'].includes(lower)) {
      await setFlow(user.id, 'master', { step: 'menu' });
      await evo.sendText(inst, from, 'Theek hai, spawn rok diya. Menu ke liye "menu" likho.');
      return;
    }
    const { botType, phone } = flow;
    await setFlow(user.id, 'master', { step: 'menu' });
    const res = await spawnSubBot({ user, botType, ownerPhone: phone });
    if (!res.ok) { await evo.sendText(inst, from, 'Abhi saare slots bhare hain. Thodi der me phir try karo.'); return; }
    await logUsage(user.id, 'spawn');
    if (res.pairingCode) {
      await evo.sendText(inst, from, `Tumhara *${BOT_LABELS[botType]}* taiyaar ho raha hai!\n\nWhatsApp kholo → Settings → Linked Devices → Link a Device → "Link with phone number" → ye code daalo:\n\n*${res.pairingCode}*\n\nJaise hi jud jayega, tumhara bot us number par live ho jayega.`);
    } else {
      await evo.sendText(inst, from, 'Session ban gaya hai — QR/pairing ke liye ek minute ruko, main bhej raha hoon.');
    }
    return;
  }

  // ===== Menu / greeting (state yahan hamesha 'menu' par reset — Main Menu har jagah consistent) =====
  if (['hi', 'hii', 'hello', 'hey', 'menu', 'start', 'namaste'].includes(lower) || t === '') {
    await setFlow(user.id, 'master', { step: 'menu' });
    await sendHomeMenu(inst, from, user.id);
    return;
  }

  // ===== Home actions =====
  // Tap IDs (mz/ai/vip/mk/image) jaan-boojh wale commands hain — menu-ish states ke bahar bhi
  // girne par yahin aate hain. Text NUMBERS sirf menu/music_done par (warna state-flows ke
  // apne numbers — spawn types, music picks — takra jayenge).
  const inMenuState = ['menu', 'music_done'].includes(state);
  if (t === 'mz' || (inMenuState && (t === '1' || lower === 'music'))) {
    await setFlow(user.id, 'master', { step: 'music_zone', lastTitle: flow?.lastTitle }, FLOW_TTL);
    await sendMusicZone(inst, from);
    return;
  }
  if (t === 'ai' || (inMenuState && (t === '2' || lower === 'chat'))) {
    await enterAiChat(inst, from, user);
    return;
  }
  if (t === 'vip' || (inMenuState && t === '3')) {
    // '3' = text menu ka VIP number ('5' ab Kaam Karwao ka hai — naya menu 5 items ka)
    await handleConsult({ ...ctx, t: 'vip', state });
    return;
  }
  if (inMenuState && t === '5') {
    await handleWork({ ...ctx, t: 'work', state });
    return;
  }
  if (t === 'mk' || (inMenuState && t === '4')) {
    await setFlow(user.id, 'master', { step: 'spawn_type' }, FLOW_TTL);
    await sendSpawnChooser(inst, from);
    return;
  }
  if (t === 'image') {
    await logUsage(user.id, 'image_redirect');
    await evo.sendText(inst, from, `Image banane ke liye Meta AI (official) par jao — wahan best quality milegi:\n${META_AI_LINK}\n\nWapas aakar "menu" likhna, aur bhi kaam hai.`);
    return;
  }

  // ===== Typed music search =====
  // music_done bhi (2026-11-06, Hero ki report): gaana bajne ke baad user seedha
  // agle gaane ka naam likhta hai ('Dilnashi dilnashi songs') — use Main Menu par
  // phenkna galat tha, user wahin confuse hota hai. Music wali gali chipki
  // rahegi: typed naam = nayi khoj. ('menu'/'hi' greeting, 'lyrics', numbers aur
  // music_new wala button upar pehle hi handle ho chuke hain — wohi escape
  // rahenge; ye branch sirf bacha hua aam text pakadti hai.)
  if ((state === 'music_query' || state === 'music_done') && t) {
    await runMusicSearch(ctx, t, 'search');
    return;
  }

  // ===== AI chat (continuous — har text seedha LLM job, menu beech me nahi khulta) =====
  if (state === 'ai_chat') {
    await evo.sendPresence(inst, from, 'composing', 30000).catch(() => {});
    await enqueueJob('ai_chat',
      { instance: inst, to: from, userId: user.id, text: t },
      `ai:${msgId || `${user.id}:${Date.now()}`}`);
    return;
  }

  // ===== INTENT ROUTER (2026-11-06, Hero ki shikayat par) =====
  // "Mujhe music sunna hai" jaisi saaf maang par baat-cheet me uljhane ki
  // jagah seedha WAHI kaam chalu — asli agentic yahi hai: baat samjho, kaam
  // shuru karo. Pakad abhi pakke shabdon se (music); baaki baatein neeche
  // AI brain ko jati hain.
  if (state === 'menu' && t) {
    const musicWord = ['music', 'gaana', 'gana', 'song', 'songs', 'geet'].some((w) => t.includes(w));
    const listenVerb = ['sunna', 'sunao', 'suna do', 'chahiye', 'chalao', 'bajao', 'lagao', 'play'].some((w) => t.includes(w));
    if (musicWord && (listenVerb || t.split(/\s+/).length <= 3)) {
      await setFlow(user.id, 'music', { step: 'music_home' });
      await sendMusicZone(ctx);
      return;
    }
    // NANGA GAANA-NAAM (2026-11-07 raat, Hero ki live report): user menu par
    // seedha gaane ka naam likh de ("Mujhe Teri jarurat hai") to woh AI chat
    // nahi, gaana hi hai — bot ka sabse bada kaam yahi hai, aur dimag (LLM)
    // atka ho to bhi gaana milna chahiye. Sawal/service wale shabd hon to
    // ye andaz NAHI lagega — woh neeche agent wale raste par jayenge.
    const lw = lower.split(/\s+/).filter(Boolean);
    const hintHit = lower.includes('?')
      || ['bot banana', 'band hai', 'nahi ho'].some((p) => lower.includes(p))
      || ['kya', 'kaise', 'kitna', 'kitne', 'kyon', 'kyu', 'kab', 'price', 'daam', 'website', 'automation', 'madad', 'help', 'problem', 'dikkat', 'error'].some((w) => lw.includes(w));
    if (!hintHit && lw.length >= 1 && lw.length <= 8) {
      await runMusicSearch(ctx, t, 'search');
      return;
    }
  }

  // ===== Default: AGENT MODE (2026-11-06, Hero ka order: "har page par agentic") =====
  // Home (menu state) par anjaan free-text ab menu dobara nahi phenkta — user
  // jo bole woh seedha AI brain ko jata hai (wahi dimag jo AI Chat lane me
  // hai: services samjhata hai, sawalon ke jawab deta hai). State ai_chat ho
  // jata hai taaki baat aage bhi chalti rahe; 'menu' likhna = kabhi bhi bahar.
  if (state === 'menu' && t) {
    await setFlow(user.id, 'master', { step: 'ai_chat' }, FLOW_TTL);
    await evo.sendPresence(inst, from, 'composing', 30000).catch(() => {});
    await enqueueJob('ai_chat',
      { instance: inst, to: from, userId: user.id, text: t },
      `ai:${msgId || `${user.id}:${Date.now()}`}`);
    return;
  }

  // ===== Default: home menu (dead end kabhi nahi) =====
  await setFlow(user.id, 'master', { step: 'menu' });
  await sendHomeMenu(inst, from, user.id);
}
