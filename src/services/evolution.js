import axios from 'axios';
import { env } from '../config/env.js';
import { brandText, brandCaption } from '../middleware/branding.js';
import { getActiveAd, adBlock } from './ads.js';

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

// ---------- Sending (SAB branded — koi raw send nahi) ----------
export async function sendText(instanceName, toJid, text, opts = {}) {
  let finalText = text;
  if (opts.ad) { const ad = await getActiveAd().catch(() => null); finalText = text + adBlock(ad); }
  const { data } = await api.post(`/message/sendText/${instanceName}`, {
    number: toJid, text: brandText(finalText), delay: 400, linkPreview: true,
  });
  return data;
}
export async function sendMedia(instanceName, toJid, mediaUrlOrBase64, caption = '', mediatype = 'audio') {
  const { data } = await api.post(`/message/sendMedia/${instanceName}`, {
    number: toJid, mediatype, caption: brandCaption(caption),
    media: mediaUrlOrBase64, fileName: mediatype === 'audio' ? 'song.m4a' : undefined,
  });
  return data;
}
// Interactive list — client support patchy hai; caller hamesha text fallback saath bhejega.
export async function sendList(instanceName, toJid, { title, description, buttonText, sections }) {
  const { data } = await api.post(`/message/sendList/${instanceName}`, {
    number: toJid, title, description: brandText(description), buttonText, footerText: '⚡ Powered by RazzScale AI', sections,
  });
  return data;
}
export async function sendPresence(instanceName, toJid, presence = 'composing', delayMs = 30000) {
  try {
    const { data } = await api.post(`/chat/sendPresence/${instanceName}`, {
      number: toJid, presence, delay: delayMs,
    });
    return data;
  } catch { return null; }
}
