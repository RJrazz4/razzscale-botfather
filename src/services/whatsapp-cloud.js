import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { pool } from '../db/pool.js';

// WhatsApp Cloud API (Official) webhook module — Hybrid Phase-1 (2026-10-25).
// Evolution (Baileys) wale raste se bilkul alag, uske parallel chalta hai:
//   GET  /webhook/whatsapp  — Meta webhook verification (hub.challenge)
//   POST /webhook/whatsapp  — inbound events: turant 200 ack, messages log + DB store,
//                             aur (config ho to) fixed auto-reply.
// Saare env optional hain — token/ID na ho to module disabled rehta hai aur
// boot kabhi fail nahi hota. Token/secret kabhi log nahi hote.
// 24h window ki maryada: reply SIRF inbound message ke jawab me jata hai;
// koi outbound/template send is module me hai hi nahi.

export const AUTO_REPLY_TEXT = "RazzScale AI ✅ Official WhatsApp API live hai. Menu ke liye 'hi' likhein.";
const GRAPH_VERSION = 'v21.0';

// Auto-reply tabhi mumkin jab token + phone number id dono hon
export function cloudConfigured() {
  return Boolean(env.whatsappCloudToken && env.whatsappPhoneNumberId);
}

// X-Hub-Signature-256 = "sha256=" + HMAC_SHA256(rawBody, appSecret) ka hex.
// App secret set hi na ho to dev-phase accept (true) — caller bhi yahi guard rakhta hai.
export function verifySignature(rawBody, signatureHeader) {
  const secret = env.whatsappAppSecret;
  if (!secret) return true;
  if (!rawBody || !signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(String(signatureHeader), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// Meta payload -> saade message records. Statuses/other fields ignore hote hain.
export function extractMessages(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field && change.field !== 'messages') continue;
      const value = change?.value || {};
      const phoneNumberId = value?.metadata?.phone_number_id || null;
      for (const m of value?.messages || []) {
        out.push({
          wabaId: entry?.id ? String(entry.id) : null,
          phoneNumberId: phoneNumberId ? String(phoneNumberId) : null,
          from: m?.from ? String(m.from) : null,
          messageId: m?.id ? String(m.id) : null,
          type: m?.type ? String(m.type) : null,
          text: m?.text?.body != null ? String(m.text.body) : null,
          timestamp: m?.timestamp ? String(m.timestamp) : null,
          raw: m,
        });
      }
    }
  }
  return out;
}

async function storeEvent(evt) {
  try {
    await pool.query(
      'insert into whatsapp_events (wa_id, message_id, type, body_text, payload) values ($1,$2,$3,$4,$5)',
      [evt.from, evt.messageId, evt.type, evt.text, JSON.stringify(evt.raw || evt)]);
  } catch (e) { console.error('[whatsapp-cloud] store:', e?.message || e); }
}

// Graph API se ek text bhejo. Kabhi throw nahi karta — fail sirf log hota hai.
export async function sendCloudText(to, text) {
  if (!cloudConfigured()) return false;
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${env.whatsappPhoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.whatsappCloudToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual',
        to: String(to), type: 'text', text: { body: String(text) },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[whatsapp-cloud] send failed:', res.status, t.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) { console.error('[whatsapp-cloud] send:', e?.message || e); return false; }
}

// Ack ke baad ki asal processing — error yaha HTTP response ko kabhi nahi bigaadta.
async function processPayload(body) {
  const msgs = extractMessages(body);
  if (!msgs.length) {
    console.log('[whatsapp-cloud] webhook event (message nahi — status/other, ignore)');
    return;
  }
  for (const m of msgs) {
    console.log(`[whatsapp-cloud] inbound from=${m.from} type=${m.type} id=${m.messageId} text=${(m.text || '').slice(0, 80)}`);
    await storeEvent(m);
    // 24h customer-service window: reply sirf inbound TEXT ke jawab me.
    if (m.from && m.type === 'text') await sendCloudText(m.from, AUTO_REPLY_TEXT);
  }
}

// GET /webhook/whatsapp — Meta ka verification handshake
export function handleWhatsAppVerify(req, res) {
  const mode = req.query?.['hub.mode'];
  const token = req.query?.['hub.verify_token'];
  const challenge = req.query?.['hub.challenge'];
  if (mode === 'subscribe' && env.whatsappWebhookVerifyToken && token === env.whatsappWebhookVerifyToken) {
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }
  return res.sendStatus(403);
}

// POST /webhook/whatsapp — signature (secret ho to) -> turant 200 -> phir processing
export function handleWhatsAppWebhook(req, res) {
  if (env.whatsappAppSecret) {
    const raw = req.rawBody || (req.body ? Buffer.from(JSON.stringify(req.body)) : Buffer.alloc(0));
    if (!verifySignature(raw, req.headers?.['x-hub-signature-256'])) {
      console.error('[whatsapp-cloud] signature verify FAIL — 401');
      return res.sendStatus(401);
    }
  }
  res.sendStatus(200); // turant ack — Meta ka timeout/retry chakra na mare
  processPayload(req.body || {}).catch((e) => console.error('[whatsapp-cloud] process:', e?.message || e));
}

// server.js bootstrap yahi call karta hai — Evolution routes ko haath nahi lagta.
export function registerWhatsAppCloudRoutes(app) {
  app.get('/webhook/whatsapp', handleWhatsAppVerify);
  app.post('/webhook/whatsapp', handleWhatsAppWebhook);
  console.log(`[whatsapp-cloud] webhook routes ready — auto-reply ${cloudConfigured() ? 'ON' : 'OFF (WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing)'}, signature ${env.whatsappAppSecret ? 'ON' : 'OFF (dev phase)'}`);
}
