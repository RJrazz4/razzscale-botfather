import * as evo from '../services/evolution.js';
import { clampListTitle } from '../services/evolution.js';
import { env } from '../config/env.js';
import { setFlow, getFlow, logUsage } from '../db/pool.js';
import { spawnSubBot } from '../services/spawner.js';
import { searchSongs } from '../services/music.js';
import { searchSongsSaavn } from '../services/jiosaavn.js';
import { enqueueJob } from '../services/worker.js';
import { vipMenuText, vipPitchText, VIP_FEATURES } from './vip.js';
import { handleConsult, resendConsultScreen, CONSULT_BACK } from './consult.js';

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

Namaste! 🙏 Gaane sunna, AI se baat, business automation — sab yahin, *bilkul FREE* shuruaat ke saath!

👇 *Number likho ya list se tap karo:*

1️⃣ *Music Zone* 🎵
      Category chuno ya gaane ka naam bhejo

2️⃣ *Free AI Chat* 💬
      Mujhse kuch bhi pucho, jawab milega

3️⃣ *VIP Action Automation* 🚀
      Business ke liye guided consultation

4️⃣ *Create Your Own Bot* 🤖
      Apna khud ka WhatsApp bot banao — FREE

🎨 Image banana ho to *image* likho.
━━━━━━━━━━━━━━━
📞 *Insaan se baat karni ho* to yahin likho — Boss khud jawab denge.`;

// ---------- Home menu (STATIC builder — music sabse upar, bada) ----------
export function homeRows() {
  return [
    { rowId: 'mz', title: '🎵 MUSIC ZONE', description: 'Gaane suno — category ya search' },
    { rowId: 'ai', title: '💬 Chat with AI', description: 'Kuch bhi pucho, jawab milega' },
    { rowId: 'vip', title: '🚀 VIP Automation', description: 'Business ke liye khaas kaam' },
    { rowId: 'mk', title: '🤖 Apna Bot Banao', description: 'Apna WhatsApp bot FREE me' },
  ];
}
async function sendHomeMenu(inst, from) {
  // List primary (footer ON — menu = footer rule ki jagah); fail ho to text menu fallback (footer ON).
  await evo.sendList(inst, from, {
    title: '🤖 RazzScale AI BotFather', buttonText: 'Menu Dekho',
    description: MENU_TEXT, footer: true,
    sections: [{ title: '🤖 RazzScale Services', rows: homeRows() }],
  }).catch(async () => { await evo.sendText(inst, from, MENU_TEXT, { footer: true }).catch(() => {}); });
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
  return [
    ...Object.entries(CATEGORIES).map(([id, c]) => ({ rowId: id, title: c.label, description: `${c.label.replace(/^\S+\s/, '')} gaane suno` })),
    { rowId: 'cat_search', title: '🔍 Gaana Search Karo', description: 'Apne gaane ka naam likho' },
    { rowId: 'nav_menu', title: '🏠 Main Menu', description: 'Home par wapas' },
  ];
}
async function sendMusicZone(inst, from) {
  await evo.sendText(inst, from, '🎵 *Music Zone*\n\nCategory tap karo — ya number likho:\n\n' +
    [...Object.values(CATEGORIES).map((c, i) => `${i + 1}. ${c.label}`), '7. 🔍 Gaana Search Karo'].join('\n'));
  await evo.sendList(inst, from, {
    title: '🎵 Music Zone', buttonText: 'Category Chuno',
    description: 'Kaunsi category ke gaane? Tap karo 👇',
    sections: [{ title: 'Categories', rows: zoneRows() }],
  }).catch(() => {});
}

// --- Music results helpers (KDMusic-style: 8 results, 3-3 ke pages, tappable list + number fallback) ---
const MUSIC_PAGE = 3;
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
    return {
      rowId: String(i + 1), // global index — sessionRouter list-reply ko isi se pick banata hai
      // WhatsApp list limit: row title ≤24 chars — poora title description (≤72) me rehta hai
      title: clampListTitle(r.title || 'Gaana'),
      description: dur ? `${r.title || 'Gaana'} • ${dur}` : (r.title || undefined),
    };
  });
  if (results.length > page) rows.push({ rowId: 'more', title: '➕ More tracks', description: 'Aur results dekho' });
  rows.push({ rowId: 'nav_back', title: '⬅️ Back', description: 'Music Zone par wapas' });
  rows.push({ rowId: 'nav_menu', title: '🏠 Main Menu', description: 'Home par wapas' });
  return rows;
}
async function sendMusicList(inst, from, results, shown) {
  // List sirf sajawat hai — fail ho to chup-chaap ignore, text flow hi main hai.
  await evo.sendList(inst, from, {
    title: '🎵 Top Results', buttonText: 'Gaana Chuno',
    description: 'Tap karke gaana chuno — ya number likh do 👇',
    sections: [{ title: 'Results', rows: musicListRows(results, shown) }],
  }).catch(() => {});
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

// Category/typed search ka common pipeline: ack -> search -> pick state ya empty state
async function runMusicSearch(ctx, query, fromKind) {
  const { user, from, inst, flow } = ctx;
  await evo.sendText(inst, from, `🔍 *${query}* dhoondh raha hoon… bas ek minute, yahi raho 🎧`);
  await evo.sendPresence(inst, from, 'composing', 55000);
  // FAST MUSIC v2: PEHLE JioSaavn source (seedha api.php — tez, CPU halka);
  // 0 results ya fail par hi purana YT search (yt-dlp) fallback. Categories bhi
  // isi raste se bharengi (unke preset queries bhi pehle saavn par jayengi).
  let results = [];
  try { results = await searchSongsSaavn(query, 8); } catch { results = []; }
  if (!results.length) { try { results = await searchSongs(query, 8); } catch { results = []; } }
  if (!results.length) {
    await setFlow(user.id, 'master', { step: 'music_zone', lastTitle: flow?.lastTitle }, FLOW_TTL);
    await sendMusicEmpty(inst, from);
    return;
  }
  const shown = Math.min(MUSIC_PAGE, results.length);
  await setFlow(user.id, 'master', { step: 'music_pick', results, shown, query, from: fromKind, lastTitle: flow?.lastTitle }, FLOW_TTL);
  await evo.sendText(inst, from, musicPageText(results, 0, shown));
  await sendMusicList(inst, from, results, shown);
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
    if (prev === 'menu') { await setFlow(user.id, 'master', { step: 'menu' }); await sendHomeMenu(inst, from); return true; }
    await setFlow(user.id, 'master', { step: prev, answers: flow?.answers || {} }, FLOW_TTL);
    await resendConsultScreen({ ...ctx, state: prev });
    return true;
  }
  switch (state) {
    case 'music_zone': case 'music_done': case 'music_busy': case 'ai_chat':
    case 'spawn_type': case 'vip_pick':
      await setFlow(user.id, 'master', { step: 'menu' });
      await sendHomeMenu(inst, from);
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
      await sendHomeMenu(inst, from);
      return true;
  }
}

export async function handleMasterMessage({ user, from, text, pushName, msgId }) {
  const inst = env.masterInstance;
  let t = (text || '').trim();
  const flow = await getFlow(user.id, 'master');
  const state = flow?.step || 'menu';
  const lower = t.toLowerCase();
  const ctx = { user, from, text, t, lower, flow, state, inst, msgId, goHome: () => sendHomeMenu(inst, from) };

  // ===== Global nav — state dispatch se PEHLE (Back/Main Menu har jagah consistent) =====
  if (t === 'nav_menu' || lower === 'main menu') {
    await setFlow(user.id, 'master', { step: 'menu' });
    await sendHomeMenu(inst, from);
    return;
  }
  if (t === 'nav_back') { await handleBack(ctx); return; }

  // ===== Double-pick guard (brief §acceptance: double tap = dohra kaam nahi) =====
  // Pick ke baad state 'music_busy' hai. Worker delivery par use 'music_done' aur final
  // fail par 'music_zone' par le jata hai (worker.js moveBusyState) — is beech doosra
  // pick/job nahi banta, sirf intezaar wala jawab jata hai. Nav/menu hamesha khula hai.
  if (state === 'music_busy') {
    if (lower === 'menu') { await setFlow(user.id, 'master', { step: 'menu' }); await sendHomeMenu(inst, from); return; }
    await evo.sendText(inst, from, '⏳ Gaana aa raha hai… download ho raha hai, bas thoda sa sabr karo 🎧\nRukna ho to "menu" likh do.');
    return;
  }

  // ===== Music selection state — download+send WORKER ke paas (V2.1) =====
  if (state === 'music_pick') {
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
      await setFlow(user.id, 'master', { step: 'music_busy', videoId: pick.id, lastTitle: pick.title }, FLOW_TTL);
      await evo.sendText(inst, from, `"${pick.title}" bhej raha hoon, ek minute…`);
      await evo.sendPresence(inst, from, 'recording', 55000);
      await enqueueJob('music_download',
        { instance: inst, to: from, userId: user.id, videoId: pick.id, title: pick.title,
          // Source routing (FAST MUSIC v2): jiosaavn picks par worker saavn chain
          // chalata hai; url sirf YT picks par (failure-text ka YouTube link wahi se banta hai).
          source: pick.source || 'yt', songId: pick.source === 'jiosaavn' ? pick.id : undefined,
          url: pick.source === 'jiosaavn' ? undefined : pick.url },
        `music:${msgId || `${user.id}:${pick.id}:${Date.now()}`}`);
      return;
    }
    // number/more nahi hai to neeche ke flows (menu aadi) ko mauka do — return mat karo
  }

  // ===== TAP mapping — purani chats ke rowIds -> naye actions (dead end kahin nahi) =====
  // Gate: sirf menu-ish states me, taaki state-flows (spawn/ai/consult/music numbers) na takrayen.
  // Ye consult entry se PEHLE hai taaki m5 -> 'vip' bhi consultation khole.
  if (['menu', 'music_done', 'music_zone'].includes(state)) {
    const TAP_MAP = { m1: 'mk', m2: 'mz', m3: 'ai', m4: 'image', m5: 'vip', music_new: 'mz' };
    if (TAP_MAP[t]) { t = TAP_MAP[t]; ctx.t = t; }
  }

  // ===== VIP Consultation (naya state machine — masterMenu sirf route karta hai) =====
  if (await handleConsult(ctx)) return;

  // ===== Music Zone state =====
  if (state === 'music_zone') {
    if (t === 'mz') { await sendMusicZone(inst, from); return; }
    const catId = CATEGORIES[t] ? t : (CAT_KEYWORDS[lower] || null);
    if (catId) { await runMusicSearch(ctx, CATEGORIES[catId].query, 'category'); return; }
    if (t === 'cat_search' || ['7', 'search', 'khojo'].includes(lower)) {
      await setFlow(user.id, 'master', { step: 'music_query', lastTitle: flow?.lastTitle }, FLOW_TTL);
      await evo.sendText(inst, from, 'Gaane ka naam bhejo — main top results dunga.');
      return;
    }
    const zn = Number(t);
    if (Number.isInteger(zn) && zn >= 1 && zn <= 6) {
      const catId = Object.keys(CATEGORIES)[zn - 1];
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
    await sendHomeMenu(inst, from);
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
  if (t === 'vip' || (inMenuState && (t === '3' || t === '5'))) {
    // '3' = naye text menu ka VIP number; '5' = purane text menu ka VIP number (aadat ka lihaz)
    await handleConsult({ ...ctx, t: 'vip', state });
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
  if (state === 'music_query' && t) {
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

  // ===== Default: home menu (dead end kabhi nahi) =====
  await setFlow(user.id, 'master', { step: 'menu' });
  await sendHomeMenu(inst, from);
}
