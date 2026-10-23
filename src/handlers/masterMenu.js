import * as evo from '../services/evolution.js';
import { env } from '../config/env.js';
import { setFlow, getFlow, logUsage } from '../db/pool.js';
import { spawnSubBot } from '../services/spawner.js';
import { searchTop3 } from '../services/music.js';
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

export async function handleMasterMessage({ user, from, text, pushName, msgId }) {
  const inst = env.masterInstance;
  const t = (text || '').trim();
  const flow = await getFlow(user.id, 'master');
  const state = flow?.step || 'menu';

  // Music selection state (top-3 me se chuna) — download+send ab WORKER ke paas (V2.1):
  // handler sirf ack deta hai, bhaari kaam queue me; idempotency key = WhatsApp message id.
  if (state === 'music_pick' && ['1', '2', '3'].includes(t)) {
    const pick = flow.results[Number(t) - 1];
    await setFlow(user.id, 'master', { step: 'menu' });
    await evo.sendText(inst, from, `"${pick.title}" bhej raha hoon, ek minute…`);
    await evo.sendPresence(inst, from, 'recording', 55000);
    await enqueueJob('music_download',
      { instance: inst, to: from, userId: user.id, videoId: pick.id, title: pick.title },
      `music:${msgId || `${user.id}:${pick.id}:${Date.now()}`}`);
    return;
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
      description: MENU_TEXT,
      sections: [{ title: 'Options', rows: [
        { rowId: '1', title: 'Create Your Own Bot', description: 'Support / AI / Music / Lead Gen — FREE' },
        { rowId: '2', title: 'Music Bot', description: 'Gaane ka naam → audio' },
        { rowId: '3', title: 'Free AI Chat', description: 'Kuch bhi pucho' },
        { rowId: '4', title: 'Image Generation', description: 'Meta AI par redirect' },
        { rowId: '5', title: '🚀 Advanced Automation & VIP Tools', description: 'Bulk Msg, Lead Gen, Order System, White-Label' },
      ] }],
    }).catch(async () => { await evo.sendText(inst, from, MENU_TEXT); });
    // kuch clients list ko text me badal kar bhejte hain — text fallback hamesha saath
    if (!lower) return;
    return;
  }
  if (t === '1') {
    await setFlow(user.id, 'master', { step: 'spawn_type' });
    await evo.sendText(inst, from, `Kaun sa bot banana hai? Number likho:\n\n1. Auto-Reply / Support Bot\n2. AI Assistant Bot\n3. Music Bot\n4. Lead Gen Bot`);
    return;
  }
  if (t === '2') {
    await setFlow(user.id, 'master', { step: 'music_query' });
    await evo.sendText(inst, from, 'Gaane ka naam bhejo — main top 3 results dunga.');
    return;
  }
  if (state === 'music_query' && t) {
    await evo.sendText(inst, from, `🔍 *${t}* dhoondh raha hoon… bas ek minute, yahi raho 🎧`);
    await evo.sendPresence(inst, from, 'composing', 55000);
    let results = [];
    try { results = await searchTop3(t); } catch { results = []; }
    if (!results.length) { await evo.sendText(inst, from, 'Ye gaana abhi nahi mil paya 😔 — naam thoda alag likh kar phir bhejo, ya koi aur gaana try karo.'); return; }
    await setFlow(user.id, 'master', { step: 'music_pick', results });
    await evo.sendText(inst, from, `Top results:\n\n${results.map((r, i) => `${i + 1}. ${r.title}`).join('\n')}\n\nNumber likho (1/2/3) — audio bhej dunga.`);
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
  // Default: menu dobara
  await evo.sendText(inst, from, MENU_TEXT);
}
