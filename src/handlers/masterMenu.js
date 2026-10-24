import * as evo from '../services/evolution.js';
import { clampListTitle } from '../services/evolution.js';
import { env } from '../config/env.js';
import { setFlow, getFlow, logUsage } from '../db/pool.js';
import { spawnSubBot } from '../services/spawner.js';
import { searchSongs } from '../services/music.js';
import { enqueueJob } from '../services/worker.js';
import { vipMenuText, vipPitchText, VIP_FEATURES } from './vip.js';

const BOT_TYPES = { '1': 'support', '2': 'ai', '3': 'music', '4': 'leadgen' };
const BOT_LABELS = { support: 'Auto-Reply / Support Bot', ai: 'AI Assistant Bot', music: 'Music Bot', leadgen: 'Lead Gen Bot' };
const META_AI_LINK = 'https://wa.me/13135550069?text=Create%20an%20image'; // Meta AI official chat (placeholder number pattern — deploy par verify karna)

const MENU_TEXT = `╭━━━ ❖ ━━━╮
   🤖 *RAZZSCALE AI BOTFATHER*
╰━━━ ❖ ━━━╯

Namaste! 🙏 Main aapka apna WhatsApp dost hoon — bot banana, gaane sunna, AI se baat karna… sab kuch *bilkul FREE* me!

👇 *Bas number likho, kaam shuru:*

1️⃣ *Create Your Own Bot* 🤖
      Apna khud ka WhatsApp bot banao — FREE

2️⃣ *Music Bot* 🎵
      Gaane ka naam bhejo, audio haath me

3️⃣ *Free AI Chat* 💬
      Mujhse kuch bhi pucho, jawab milega

4️⃣ *Image Banana Hai* 🎨
      Meta AI se photo banwao

5️⃣ *Advanced Automation & VIP Tools* 🚀
      Bade businesses ke liye khaas

━━━━━━━━━━━━━━━
📞 *Seedha baat karni ho to:* +91 72051 91890`;

// --- Music results helpers (KDMusic-style: 8 results, 3-3 ke pages, tappable list + number fallback) ---
const MUSIC_PAGE = 3;
function musicPageText(results, fromIdx, toIdx) {
  const lines = results.slice(fromIdx, toIdx).map((r, i) => `${fromIdx + i + 1}. ${r.title}`).join('\n');
  const moreLine = toIdx < results.length ? '\nAur results ke liye "more" likho 👇' : '';
  return `${fromIdx === 0 ? 'Top results:' : 'Aur results:'}\n\n${lines}\n\nNumber likho (1-${toIdx}) — audio bhej dunga.${moreLine}`;
}
function musicListRows(results, shown) {
  const rows = results.slice(0, shown).map((r, i) => {
    const dur = r.duration ? `${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')}` : '';
    return {
      rowId: String(i + 1), // global index — sessionRouter list-reply ko isi se pick banata hai
      // WhatsApp list limit: row title ≤24 chars — poora title description (≤72) me rehta hai
      title: clampListTitle(r.title || 'Gaana'),
      description: dur ? `${r.title || 'Gaana'} • ${dur}` : (r.title || undefined),
    };
  });
  if (results.length > shown) rows.push({ rowId: 'more', title: '➕ More tracks', description: 'Aur results dekho' });
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

export async function handleMasterMessage({ user, from, text, pushName, msgId }) {
  const inst = env.masterInstance;
  let t = (text || '').trim();
  const flow = await getFlow(user.id, 'master');
  const state = flow?.step || 'menu';

  // Music selection state — download+send WORKER ke paas (V2.1):
  // handler sirf ack deta hai, bhaari kaam queue me; idempotency key = WhatsApp message id.
  // Pick: dikhaye hue (shown) results me se koi bhi number — text se ya list-tap se (rowId = wahi number).
  // 'more'/'aur': agla page (3 aur). List wala 'more' row bhi text 'more' bankar yahi aata hai.
  if (state === 'music_pick') {
    const results = flow.results || [];
    const shown = flow.shown || Math.min(MUSIC_PAGE, results.length);
    if (['more', 'aur'].includes(t.toLowerCase())) {
      if (shown >= results.length) {
        await evo.sendText(inst, from, 'Bas itne hi results mile is gaane ke 🙏 — number likho ya "menu" likho.');
      } else {
        const newShown = Math.min(shown + MUSIC_PAGE, results.length);
        await setFlow(user.id, 'master', { step: 'music_pick', results, shown: newShown, query: flow.query, lastTitle: flow.lastTitle });
        await evo.sendText(inst, from, musicPageText(results, shown, newShown));
        await sendMusicList(inst, from, results, newShown);
      }
      return;
    }
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= shown && results[n - 1]) {
      const pick = results[n - 1];
      // Halki 'music_done' state: delivery ke baad bhi lastTitle zinda rahe, taaki post-audio
      // action list ke 'lyrics' / 'music_new' taps (aur type) dono kaam karein.
      await setFlow(user.id, 'master', { step: 'music_done', lastTitle: pick.title });
      await evo.sendText(inst, from, `"${pick.title}" bhej raha hoon, ek minute…`);
      await evo.sendPresence(inst, from, 'recording', 55000);
      await enqueueJob('music_download',
        { instance: inst, to: from, userId: user.id, videoId: pick.id, title: pick.title },
        `music:${msgId || `${user.id}:${pick.id}:${Date.now()}`}`);
      return;
    }
    // number/more nahi hai to neeche ke flows (menu aadi) ko mauka do — return mat karo
  }
  // TAP-FIRST mapping (KDMusic-style, 2026-10-24): tappable lists ke rowIds ko wahi banao jo
  // user type karke pata — existing handlers hi reuse hote hain, koi duplicate logic nahi.
  //  - Menu list: 'm1'..'m5' → '1'..'5'. Post-audio action list: 'music_new' → '2',
  //    'lyrics' (keyword branch neeche), 'menu' (menu-keyword branch neeche) — as-is aate hain.
  // Gate: sirf menu/music_done states me — music_pick ke number-picks, spawn/ai_chat jaise
  // state-flows me tap-text ko unke matlab se takrane mat do.
  if (state === 'menu' || state === 'music_done') {
    const TAP_MAP = { m1: '1', m2: '2', m3: '3', m4: '4', m5: '5', music_new: '2' };
    if (TAP_MAP[t]) t = TAP_MAP[t];
  }
  // VIP pick: koi bhi advanced feature chuna → pitch + personal WhatsApp deep link
  if (state === 'vip_pick' && ['1','2','3','4','5'].includes(t)) {
    const feature = VIP_FEATURES[Number(t) - 1];
    await setFlow(user.id, 'master', { step: 'menu' });
    await logUsage(user.id, 'vip_pitch');
    await evo.sendText(inst, from, vipPitchText(feature));
    return;
  }
  // Bot-create wizard: type chuna → owner number maango
  if (state === 'spawn_type' && BOT_TYPES[t]) {
    await setFlow(user.id, 'master', { step: 'spawn_phone', botType: BOT_TYPES[t] });
    await evo.sendText(inst, from, `Theek hai — *${BOT_LABELS[BOT_TYPES[t]]}* banega.\nAb woh WhatsApp number bhejo jis par ye bot chalega (country code ke saath, jaise 91XXXXXXXXXX). Us number par pairing code aayega.`);
    return;
  }
  if (t.toLowerCase() === 'naya code') {
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
    await setFlow(user.id, 'master', { step: 'spawn_confirm', botType: flow.botType, phone });
    await evo.sendText(inst, from, `Confirm karo: kya *${phone}* tumhara APNA WhatsApp number hai, aur tum is par bot jodne ke liye taiyaar ho?\n\n*HAAN* likho to pairing code bhejta hoon.`);
    return;
  }
  if (state === 'spawn_confirm') {
    if (!['haan', 'ha', 'yes', 'y'].includes(t.toLowerCase())) {
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

  // Top-level menu
  const lower = t.toLowerCase();
  if (['hi', 'hii', 'hello', 'hey', 'menu', 'start', 'namaste'].includes(lower) || t === '') {
    await evo.sendList(inst, from, {
      title: 'RazzScale AI BotFather', buttonText: 'Menu Dekho',
      description: MENU_TEXT, footer: true, // menu = footer ON (rule)
      // TAP-FIRST: rows m1..m5 — upar wali TAP_MAP se '1'..'5' bankar existing handlers chalti hain.
      // Titles ≤24 chars (WhatsApp list limit); kuch type karne ki zaroorat nahi, bas tap karo.
      sections: [{ title: '🤖 RazzScale Services', rows: [
        { rowId: 'm1', title: 'Apna Bot Banao', description: 'Apna WhatsApp bot FREE me banao' },
        { rowId: 'm2', title: 'Music Bot — Gaana Suno', description: 'Gaane ka naam bhejo, audio pao' },
        { rowId: 'm3', title: 'Free AI Chat', description: 'Kuch bhi pucho, jawab milega' },
        { rowId: 'm4', title: 'Image Generation', description: 'Meta AI se photo banwao' },
        { rowId: 'm5', title: 'VIP Tools & Automation', description: 'Bade business ke khaas tools' },
      ] }],
    }).catch(async () => { await evo.sendText(inst, from, MENU_TEXT, { footer: true }); });
    // kuch clients list ko text me badal kar bhejte hain — text fallback hamesha saath
    if (!lower) return;
    return;
  }
  if (t === '1') {
    await setFlow(user.id, 'master', { step: 'spawn_type' });
    // Text fallback barkarar + tappable chooser (rowIds '1'..'4' = spawn_type ke text inputs hi;
    // list-tap sessionRouter se text bankar aata hai aur neeche BOT_TYPES branch hi handle karta hai)
    await evo.sendText(inst, from, `Kaun sa bot banana hai? Number likho ya list se tap karo:\n\n1. Auto-Reply / Support Bot\n2. AI Assistant Bot\n3. Music Bot\n4. Lead Gen Bot`);
    await evo.sendList(inst, from, {
      title: '🤖 Bot Types', buttonText: 'Bot Chuno',
      description: 'Kaun sa bot banana hai? Tap karo 👇',
      sections: [{ title: 'Bot Types', rows: [
        { rowId: '1', title: 'Auto-Reply / Support Bot', description: 'Customer sawalon ke auto-jawab' },
        { rowId: '2', title: 'AI Assistant Bot', description: 'Smart AI wala helper bot' },
        { rowId: '3', title: 'Music Bot', description: 'Gaana bajane wala bot' },
        { rowId: '4', title: 'Lead Gen Bot', description: 'Customer leads ikatthe karo' },
      ] }],
    }).catch(() => {});
    return;
  }
  if (t === '2') {
    await setFlow(user.id, 'master', { step: 'music_query', lastTitle: flow?.lastTitle });
    await evo.sendText(inst, from, 'Gaane ka naam bhejo — main top results dunga.');
    return;
  }
  // Lyrics: gaana bajne ke baad ('menu' ya halki 'music_done' state — lastTitle yaad hai)
  // user 'lyrics' likhe YA action list se tap kare (rowId 'lyrics' text bankar yahi aata hai) → worker job
  if (lower === 'lyrics' && (state === 'menu' || state === 'music_done') && flow?.lastTitle) {
    await enqueueJob('lyrics',
      { instance: inst, to: from, userId: user.id, title: flow.lastTitle },
      `lyrics:${msgId || `${user.id}:${Date.now()}`}`);
    return;
  }
  if (state === 'music_query' && t) {
    await evo.sendText(inst, from, `🔍 *${t}* dhoondh raha hoon… bas ek minute, yahi raho 🎧`);
    await evo.sendPresence(inst, from, 'composing', 55000);
    let results = [];
    try { results = await searchSongs(t, 8); } catch { results = []; }
    if (!results.length) { await evo.sendText(inst, from, 'Ye gaana abhi nahi mil paya 😔 — naam thoda alag likh kar phir bhejo, ya koi aur gaana try karo.'); return; }
    const shown = Math.min(MUSIC_PAGE, results.length);
    await setFlow(user.id, 'master', { step: 'music_pick', results, shown, query: t, lastTitle: flow?.lastTitle });
    await evo.sendText(inst, from, musicPageText(results, 0, shown));
    await sendMusicList(inst, from, results, shown);
    return;
  }
  if (t === '3') {
    await setFlow(user.id, 'master', { step: 'ai_chat' });
    await evo.sendText(inst, from, 'AI Chat shuru! Apna sawaal likho. (Band karne ke liye "menu" likho)');
    return;
  }
  if (state === 'ai_chat') {
    // AI chat bhi queue me (V2.1) — LLM call handler ko block nahi karegi; typing presence saath me.
    await evo.sendPresence(inst, from, 'composing', 30000).catch(() => {});
    await enqueueJob('ai_chat',
      { instance: inst, to: from, userId: user.id, text: t },
      `ai:${msgId || `${user.id}:${Date.now()}`}`);
    return;
  }
  if (t === '5') {
    await setFlow(user.id, 'master', { step: 'vip_pick' });
    await evo.sendText(inst, from, vipMenuText());
    return;
  }
  if (t === '4') {
    await logUsage(user.id, 'image_redirect');
    await evo.sendText(inst, from, `Image banane ke liye Meta AI (official) par jao — wahan best quality milegi:\n${META_AI_LINK}\n\nWapas aakar "menu" likhna, aur bhi kaam hai.`);
    return;
  }
  // Default: menu dobara (menu = footer ON)
  await evo.sendText(inst, from, MENU_TEXT, { footer: true });
}
