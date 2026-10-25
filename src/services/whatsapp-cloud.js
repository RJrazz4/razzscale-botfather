import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { pool, upsertUser } from '../db/pool.js';
import * as graph from './graph-cloud.js';
import { handleMasterMessage } from '../handlers/masterMenu.js';

// WhatsApp Cloud API (Official) webhook — Hybrid Phase-2 (2026-10-25):
// inbound par ab FIXED text reply NAHI jata — asal BotFather brain
// (handlers/masterMenu.js ka wahi router jo Evolution par chalta hai) process
// karta hai, aur jawab transport/graph-cloud se INTERACTIVE List/Buttons me
// jata hai. Evolution wala rasta isse bilkul alag aur barkarar hai.
// Maryada (locked): koi template / business-initiated send nahi — reply sirf
// inbound ke jawab me (24h window by construction). Saare env optional;
// config na ho to sends chup-chaap fail hote hain, boot kabhi nahi rukta.
// Token/secret kabhi log nahi hote.

// Phase-1 ka fixed text — ab bheja NAHI jata (brain live hai); export isliye
// barkarar hai ki us samay ki cheezein/tests ispar tike the.
export const AUTO_REPLY_TEXT = "RazzScale AI ✅ Official WhatsApp API live hai. Menu ke liye 'hi' likhein.";

// Graph sends tabhi mumkin jab token + phone number id dono hon
export function cloudConfigured() {
  return graph.graphConfigured();
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
// Interactive replies (button/list) par selectionId = tap kiye hue row/button ka id —
// router ke liye yahi "text" ka kaam karta hai (Evolution normalizer bhi rowId ko
// hi text banata hai, isliye handlers dono channels par ek jaise chalte hain).
export function extractMessages(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field && change.field !== 'messages') continue;
      const value = change?.value || {};
      const phoneNumberId = value?.metadata?.phone_number_id || null;
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
      for (const m of value?.messages || []) {
        const from = m?.from ? String(m.from) : null;
        const reply = m?.interactive?.button_reply || m?.interactive?.list_reply || null;
        const contact = contacts.find((c) => String(c?.wa_id) === from);
        out.push({
          wabaId: entry?.id ? String(entry.id) : null,
          phoneNumberId: phoneNumberId ? String(phoneNumberId) : null,
          from,
          messageId: m?.id ? String(m.id) : null,
          type: m?.type ? String(m.type) : null,
          text: m?.text?.body != null ? String(m.text.body) : null,
          selectionId: reply?.id != null ? String(reply.id) : null,
          selectionTitle: reply?.title != null ? String(reply.title) : null,
          pushName: contact?.profile?.name ? String(contact.profile.name) : null,
          timestamp: m?.timestamp ? String(m.timestamp) : null,
          raw: m,
        });
      }
    }
  }
  return out;
}

// Router ke liye canonical events: text message -> kind 'text'; interactive tap ->
// kind 'selection' aur text = selection id. Baaki types (image/audio/status events)
// kind 'other' — woh sirf store/log honge, route nahi.
export function normalizeCloudEvents(body) {
  return extractMessages(body).map((m) => {
    let kind = 'other';
    let text = null;
    if (m.type === 'text' && m.text) { kind = 'text'; text = m.text; }
    else if (m.type === 'interactive' && m.selectionId) { kind = 'selection'; text = m.selectionId; }
    return {
      channel: 'cloud', from: m.from, messageId: m.messageId, type: m.type,
      kind, text, pushName: m.pushName, raw: m.raw,
    };
  });
}

async function storeEvent(evt) {
  try {
    await pool.query(
      'insert into whatsapp_events (wa_id, message_id, type, body_text, payload) values ($1,$2,$3,$4,$5)',
      [evt.from, evt.messageId, evt.type, evt.text, JSON.stringify(evt.raw || evt)]);
  } catch (e) { console.error('[whatsapp-cloud] store:', e?.message || e); }
}

// Dedupe (Evolution wali processed_messages wali hi vidhi): Meta webhook retry par
// ek hi message do baar process nahi hoga. Claim fail ho to message drop mat karo.
async function claimMessage(messageId) {
  if (!messageId) return true;
  try {
    const { rows } = await pool.query(
      'insert into processed_messages (id, ts) values ($1,$2) on conflict (id) do nothing returning id',
      [messageId, new Date().toISOString()]);
    return rows.length > 0;
  } catch { return true; }
}

// Human mode (consult confirm par pauseForHuman paused_contacts me entry dalta hai):
// paused contact par bot chup rahega — Boss isi chat me khud baat karta hai.
// 12h lazy expiry sessionRouter wali hi hai.
const PAUSE_MS = 12 * 3600_000;
async function isPaused(jid) {
  try {
    const { rows } = await pool.query('select paused_at from paused_contacts where jid=$1', [jid]);
    if (!rows[0]) return false;
    if (Date.now() - new Date(rows[0].paused_at).getTime() >= PAUSE_MS) {
      await pool.query('delete from paused_contacts where jid=$1', [jid]).catch(() => {});
      return false;
    }
    return true;
  } catch { return false; }
}

// Graph API se ek text bhejo (ab graph-cloud se — purana export compat ke liye).
export async function sendCloudText(to, text) {
  return graph.sendText(to, text);
}

// Ack ke baad ki asal processing — error yaha HTTP response ko kabhi nahi bigaadta.
// Har message: dedupe claim -> whatsapp_events store -> blue tick/typing ->
// (paused ho to sirf store) -> upsertUser -> asal router (channel 'cloud').
export async function processWhatsAppPayload(body) {
  const evts = normalizeCloudEvents(body);
  if (!evts.length) {
    console.log('[whatsapp-cloud] webhook event (message nahi — status/other, ignore)');
    return;
  }
  for (const ev of evts) {
    try {
      console.log(`[whatsapp-cloud] inbound from=${ev.from} type=${ev.type} kind=${ev.kind} id=${ev.messageId} text=${(ev.text || '').slice(0, 80)}`);
      if (!(await claimMessage(ev.messageId))) {
        console.log('[whatsapp-cloud] duplicate message — skip');
        continue;
      }
      await storeEvent(ev);
      graph.markRead(ev.messageId, true).catch(() => {}); // blue tick + typing, fail = koi baat nahi
      if (!ev.from || !ev.text) continue; // media/other: sirf log/store, route nahi
      if (await isPaused(ev.from)) {
        console.log('[whatsapp-cloud] human mode (paused) — route skip');
        continue;
      }
      const user = await upsertUser(ev.from, ev.pushName, 'direct');
      await handleMasterMessage({ user, from: ev.from, text: ev.text, pushName: ev.pushName, msgId: ev.messageId, channel: 'cloud' });
    } catch (e) { console.error('[whatsapp-cloud] process msg:', e?.message || e); }
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
  processWhatsAppPayload(req.body || {}).catch((e) => console.error('[whatsapp-cloud] process:', e?.message || e));
}

// server.js bootstrap yahi call karta hai — Evolution routes ko haath nahi lagta.
export function registerWhatsAppCloudRoutes(app) {
  app.get('/webhook/whatsapp', handleWhatsAppVerify);
  app.post('/webhook/whatsapp', handleWhatsAppWebhook);
  console.log(`[whatsapp-cloud] webhook routes ready — brain router ON, graph sends ${cloudConfigured() ? 'ON' : 'OFF (WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing)'}, signature ${env.whatsappAppSecret ? 'ON' : 'OFF (dev phase)'}`);
}
