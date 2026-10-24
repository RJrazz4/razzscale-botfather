import axios from 'axios';
import { env } from '../config/env.js';
import { brandText, brandCaption } from '../middleware/branding.js';
import { getAdForJid, adBlock } from './ads.js';
import { pool } from '../db/pool.js';

const api = axios.create({
  baseURL: env.evolutionBase,
  headers: { apikey: env.evolutionKey, 'Content-Type': 'application/json' },
  timeout: 30_000,
});

// ---------- Session / instance management ----------
export async function createInstance(instanceName, webhookUrl, webhookSecret) {
  const { data } = await api.post('/instance/create', {
    instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS',
    webhook: { url: webhookUrl, byEvents: false, base64: true, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'] },
    // webhookSecret Evolution ke header config me jata hai deployment ke hisaab se; yaha hum apna token URL-path me bhi rakhte hain
  });
  return data;
}
export async function connectPairing(instanceName, phoneNumber) {
  // Pairing code route (Evolution): /instance/connect/:name?number=<intl>
  const { data } = await api.get(`/instance/connect/${instanceName}`, { params: { number: phoneNumber } });
  return data; // { pairingCode, code (qr), ... } deployment ke hisaab se
}
export async function fetchInstances() {
  const { data } = await api.get('/instance/fetchInstances');
  return data;
}
export async function deleteInstance(instanceName) {
  await api.delete(`/instance/delete/${instanceName}`);
}
// Webhook self-heal (V2.1): instance recreate ke baad webhook udd jata tha —
// bootstrap har baar ise dobara set karega (payload createInstance wale webhook block ke barabar).
export async function setInstanceWebhook(instanceName, webhookUrl) {
  const { data } = await api.post(`/webhook/set/${instanceName}`, {
    webhook: { url: webhookUrl, byEvents: false, base64: true, events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'] },
  });
  return data;
}

// Sent registry (V2.1, plan §5): bot ke bheje har message ka ID note karo —
// auto-pause isi se pehchanta hai ki fromMe message bot ka hai ya owner ke phone ka.
async function recordSent(instanceName, toJid, data) {
  try {
    const mid = data?.key?.id || data?.messageId || data?.id || null;
    if (!mid) return;
    await pool.query(
      'insert into sent_registry (message_id, instance_name, jid, sent_at) values ($1,$2,$3,$4) on conflict (message_id) do nothing',
      [String(mid), instanceName, String(toJid), new Date().toISOString()]);
    if (Math.random() < 0.02) { // kabhi-kabhi 48h se purane saaf karo
      const cutoff = new Date(Date.now() - 48 * 3600_000).toISOString();
      await pool.query('delete from sent_registry where sent_at < $1', [cutoff]).catch(() => {});
    }
  } catch { /* registry fail ho to send flow kabhi na ruke */ }
}

// ---------- Sending ----------
// Footer discipline (2026-10-24): footer DEFAULT band; sirf opts.footer === true par lagega
// (menu sends + music delivery). Ad block (opts.ad) footer se alag hai — jaisa tha waisa.
export async function sendText(instanceName, toJid, text, opts = {}) {
  let finalText = text;
  if (opts.ad) { const ad = await getAdForJid(toJid).catch(() => null); finalText = text + adBlock(ad); }
  const { data } = await api.post(`/message/sendText/${instanceName}`, {
    number: toJid, text: brandText(finalText, opts.footer === true), delay: 400, linkPreview: false,
  });
  await recordSent(instanceName, toJid, data);
  return data;
}
export async function sendMedia(instanceName, toJid, mediaUrlOrBase64, caption = '', mediatype = 'audio', opts = {}) {
  const { data } = await api.post(`/message/sendMedia/${instanceName}`, {
    number: toJid, mediatype, caption: brandCaption(caption, opts.footer === true),
    media: mediaUrlOrBase64, fileName: mediatype === 'audio' ? 'song.m4a' : undefined,
  });
  await recordSent(instanceName, toJid, data);
  return data;
}
// WhatsApp list limits (research 2026-10-24): row title ≤24 chars, row description ≤72 chars —
// isse zyada par WhatsApp list bigaad/reject kar sakta hai. Har caller ke rows yahi guzrenge.
export function clampListTitle(s, max = 24) {
  const str = String(s ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
export function clampListDesc(s, max = 72) {
  const str = String(s ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}
// Interactive list — client support patchy hai; caller hamesha text fallback saath bhejega.
// Safety net: sections/rows ki titles+descriptions WhatsApp limits par clamp karke bhejo.
export async function sendList(instanceName, toJid, { title, description, buttonText, sections, footer = false }) {
  const safeSections = (sections || []).map((sec) => ({
    ...sec,
    rows: (sec.rows || []).map((r) => ({ ...r, title: clampListTitle(r.title), description: r.description ? clampListDesc(r.description) : r.description })),
  }));
  const { data } = await api.post(`/message/sendList/${instanceName}`, {
    number: toJid, title, description: brandText(description, footer === true), buttonText, footerText: '⚡ Powered by RazzScale AI', sections: safeSections,
  });
  await recordSent(instanceName, toJid, data);
  return data;
}
// Typing/recording presence — user ko "typing…" dikhta hai, taaki lambi processes me woh ruka rahe.
export async function sendPresence(instanceName, toJid, presence = 'composing', delayMs = 30000) {
  try {
    const { data } = await api.post(`/chat/sendPresence/${instanceName}`, {
      number: toJid, presence, delay: delayMs,
    });
    return data;
  } catch { return null; } // presence fail ho to main flow kabhi na ruke
}
