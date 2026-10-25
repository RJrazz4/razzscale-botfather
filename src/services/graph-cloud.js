import { env } from '../config/env.js';

// WhatsApp Cloud API (Official) OUTBOUND client — graph.facebook.com par seedha fetch.
// whatsapp-cloud.js (inbound webhook) ka jod hai: Cloud channel ke saare sends YAHIN
// se jate hain. Design maryada:
//  - Koi template / business-initiated send NAHI — ye client sirf inbound ke jawab me
//    bulaya jata hai (24h customer-service window by construction).
//  - Kabhi throw nahi karta; config (token/phone-id) na ho to false. Token kabhi log nahi.
//  - Interactive payload builders PURE hain aur WhatsApp ke hard limits andar hi
//    enforce karte hain (list ≤10 rows kul, row title ≤24, row desc ≤72, button
//    title ≤20, max 3 reply buttons, interactive body ≤1024, header/footer ≤60).

export const GRAPH_VERSION = 'v26.0';

export function graphConfigured() {
  return Boolean(env.whatsappCloudToken && env.whatsappPhoneNumberId);
}

// ---------- Pure builders (harness inhi ko test karta hai) ----------
export function clampStr(s, max) {
  const str = String(s ?? '');
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

export function buildTextPayload(to, body) {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual',
    to: String(to), type: 'text',
    // Text message ki asal limit 4096 hai — interactive body wali 1024 yahan NAHI
    // lagti (lyrics ke ~1500-char chunks isi raste se jate hain, katne nahi chahiye).
    text: { body: clampStr(body, 4096) },
  };
}

export function buildListPayload(to, { header, body, footer, buttonText, sections } = {}) {
  // Kul rows ka budget 10 — section order barkarar, budget khatm to aage ke rows drop,
  // khaali reh jane wale sections bhi drop. Row id 'id' ya 'rowId' dono chalega
  // (Evolution-wale builders rowId dete hain — transport wahi aage badhata hai).
  let budget = 10;
  const safeSections = [];
  for (const sec of sections || []) {
    if (budget <= 0) break;
    const rows = [];
    for (const r of sec.rows || []) {
      if (budget <= 0) break;
      const id = String(r.id ?? r.rowId ?? '');
      if (!id) continue;
      const row = { id, title: clampStr(r.title || 'Option', 24) };
      if (r.description) row.description = clampStr(r.description, 72);
      rows.push(row);
      budget--;
    }
    if (rows.length) safeSections.push({ title: clampStr(sec.title || 'Options', 24), rows });
  }
  if (!safeSections.length) return null;
  const interactive = {
    type: 'list',
    body: { text: clampStr(body || 'Chuno 👇', 1024) },
    action: { button: clampStr(buttonText || 'Dekho', 20), sections: safeSections },
  };
  if (header) interactive.header = { type: 'text', text: clampStr(header, 60) };
  if (footer) interactive.footer = { text: clampStr(footer, 60) };
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to), type: 'interactive', interactive };
}

export function buildButtonsPayload(to, { header, body, footer, buttons } = {}) {
  const btns = (buttons || []).slice(0, 3)
    .map((b) => ({ type: 'reply', reply: { id: String(b.id ?? b.rowId ?? ''), title: clampStr(b.title || 'OK', 20) } }))
    .filter((b) => b.reply.id);
  if (!btns.length) return null;
  const interactive = {
    type: 'button',
    body: { text: clampStr(body || 'Chuno 👇', 1024) },
    action: { buttons: btns },
  };
  if (header) interactive.header = { type: 'text', text: clampStr(header, 60) };
  if (footer) interactive.footer = { text: clampStr(footer, 60) };
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(to), type: 'interactive', interactive };
}

export function buildAudioLinkPayload(to, url) {
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual',
    to: String(to), type: 'audio', audio: { link: String(url) },
  };
}

// Read receipt (+ optional typing indicator — jawab banne tak "typing…" dikhta hai).
export function buildReadPayload(messageId, typing = false) {
  const p = { messaging_product: 'whatsapp', status: 'read', message_id: String(messageId) };
  if (typing) p.typing_indicator = { type: 'text' };
  return p;
}

// ---------- Sender (ek hi Graph POST — fail par false, kabhi throw nahi) ----------
async function postGraph(payload) {
  if (!graphConfigured()) return false;
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${env.whatsappPhoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.whatsappCloudToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[graph-cloud] send failed:', res.status, t.slice(0, 250));
      return false;
    }
    return true;
  } catch (e) { console.error('[graph-cloud] send:', e?.message || e); return false; }
}

export const sendText = (to, body) => postGraph(buildTextPayload(to, body));
export async function sendList(to, opts) { const p = buildListPayload(to, opts); return p ? postGraph(p) : false; }
export async function sendButtons(to, opts) { const p = buildButtonsPayload(to, opts); return p ? postGraph(p) : false; }
export const sendAudioByLink = (to, url) => postGraph(buildAudioLinkPayload(to, url));
export const markRead = (messageId, typing = false) =>
  (messageId ? postGraph(buildReadPayload(messageId, typing)) : Promise.resolve(false));
