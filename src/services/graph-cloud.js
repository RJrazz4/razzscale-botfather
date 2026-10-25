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

// Meta Cloud API ke DOCUMENTED hard limits (interactive/text) — builders inhe
// enforce karte hain aur validateMessagePayload inhi se payload ki jaanch karta hai.
export const META_LIMITS = {
  textBody: 4096, interactiveBody: 1024, header: 60, footer: 60,
  listButton: 20, listSections: 10, listRowsTotal: 10, listRowsPerSection: 10,
  sectionTitle: 24, rowId: 200, rowTitle: 24, rowDescription: 72,
  buttonsMax: 3, buttonId: 256, buttonTitle: 20,
};

// Pure validator: tay-shuda limits ke khilaf violations ki list (khaali = saaf).
// Harness ka strict mock isi ke samkaksh niyam apne taur par lagata hai (independent
// check) — ye export debugging/live-jaanch ke liye hai.
export function validateMessagePayload(p) {
  const v = [];
  if (!p || typeof p !== 'object') return ['payload_missing'];
  const L = META_LIMITS;
  const len = (s) => String(s ?? '').length;
  if (p.type === 'text') {
    if (!len(p.text?.body)) v.push('text.body_empty');
    if (len(p.text?.body) > L.textBody) v.push(`text.body>${L.textBody}`);
    return v;
  }
  if (p.type === 'audio') {
    if (!p.audio?.link) v.push('audio.link_missing');
    return v;
  }
  if (p.status === 'read') return v; // markRead payload — koi content limit nahi
  if (p.type !== 'interactive' || !p.interactive) return v;
  const i = p.interactive;
  if (!len(i.body?.text)) v.push('interactive.body_empty');
  if (len(i.body?.text) > L.interactiveBody) v.push(`interactive.body>${L.interactiveBody}`);
  if (i.header && len(i.header.text) > L.header) v.push(`header>${L.header}`);
  if (i.footer && len(i.footer.text) > L.footer) v.push(`footer>${L.footer}`);
  if (i.type === 'list') {
    const a = i.action || {};
    if (!len(a.button)) v.push('list.button_empty');
    if (len(a.button) > L.listButton) v.push(`list.button>${L.listButton}`);
    const secs = a.sections || [];
    if (!secs.length) v.push('list.sections_empty');
    if (secs.length > L.listSections) v.push(`list.sections>${L.listSections}`);
    let total = 0;
    const rowIds = new Set();
    secs.forEach((s, si) => {
      if (len(s.title) > L.sectionTitle) v.push(`section[${si}].title>${L.sectionTitle}`);
      const rows = s.rows || [];
      if (!rows.length) v.push(`section[${si}]_empty`);
      if (rows.length > L.listRowsPerSection) v.push(`section[${si}].rows>${L.listRowsPerSection}`);
      rows.forEach((r, ri) => {
        total++;
        if (!len(r.id)) v.push(`row[${si}:${ri}].id_empty`);
        if (len(r.id) > L.rowId) v.push(`row[${si}:${ri}].id>${L.rowId}`);
        if (rowIds.has(r.id)) v.push(`row.id_duplicate:${r.id}`);
        rowIds.add(r.id);
        if (!len(r.title)) v.push(`row[${si}:${ri}].title_empty`);
        if (len(r.title) > L.rowTitle) v.push(`row[${si}:${ri}].title>${L.rowTitle}`);
        if (r.description != null && len(r.description) > L.rowDescription) v.push(`row[${si}:${ri}].description>${L.rowDescription}`);
      });
    });
    if (total > L.listRowsTotal) v.push(`list.rows_total>${L.listRowsTotal}`);
  }
  if (i.type === 'button') {
    const btns = i.action?.buttons || [];
    if (!btns.length) v.push('buttons_empty');
    if (btns.length > L.buttonsMax) v.push(`buttons>${L.buttonsMax}`);
    const ids = new Set(); const titles = new Set();
    btns.forEach((b, bi) => {
      const id = b?.reply?.id; const title = b?.reply?.title;
      if (!len(id)) v.push(`button[${bi}].id_empty`);
      if (len(id) > L.buttonId) v.push(`button[${bi}].id>${L.buttonId}`);
      if (ids.has(id)) v.push(`button.id_duplicate:${id}`);
      ids.add(id);
      if (!len(title)) v.push(`button[${bi}].title_empty`);
      if (len(title) > L.buttonTitle) v.push(`button[${bi}].title>${L.buttonTitle}`);
      if (titles.has(title)) v.push(`button.title_duplicate:${title}`);
      titles.add(title);
    });
  }
  return v;
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
  // Kul rows ka budget 10 (aur per-section bhi ≤10, sections ≤10) — section order
  // barkarar, budget khatm to aage ke rows drop, khaali reh jane wale sections bhi
  // drop. Row id 'id' ya 'rowId' dono chalega (Evolution-wale builders rowId dete
  // hain — transport wahi aage badhata hai). Row id >200 chars ho to woh row skip
  // (id clamp karne se reply-mapping toot jayegi — skip hi sahi ilaaj hai);
  // duplicate row id bhi skip (Meta ki nazar me pehchan ek hi honi chahiye).
  let budget = META_LIMITS.listRowsTotal;
  const seenRowIds = new Set();
  const safeSections = [];
  for (const sec of (sections || []).slice(0, META_LIMITS.listSections)) {
    if (budget <= 0) break;
    const rows = [];
    for (const r of sec.rows || []) {
      if (budget <= 0 || rows.length >= META_LIMITS.listRowsPerSection) break;
      const id = String(r.id ?? r.rowId ?? '');
      if (!id || id.length > META_LIMITS.rowId || seenRowIds.has(id)) continue;
      seenRowIds.add(id);
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
  // Max 3 buttons; id >256 chars ya duplicate id/title wale skip (Meta button
  // titles ki uniqueness mangta hai — clamp ke baad takraav ho to baad wala drop).
  const seenIds = new Set(); const seenTitles = new Set();
  const btns = [];
  for (const b of buttons || []) {
    if (btns.length >= META_LIMITS.buttonsMax) break;
    const id = String(b.id ?? b.rowId ?? '');
    const title = clampStr(b.title || 'OK', 20);
    if (!id || id.length > META_LIMITS.buttonId || seenIds.has(id) || seenTitles.has(title)) continue;
    seenIds.add(id); seenTitles.add(title);
    btns.push({ type: 'reply', reply: { id, title } });
  }
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
// Send failure par STRUCTURED ek line — Meta ke error body se code/message/
// subcode/fbtrace parse karke. Token/Authorization header KABHI log nahi hota
// (sirf Meta ke jawab ke error fields hain). 2026-10-25 ki production ghatna ke
// baad ye pakka hai: koi bhi Graph failure ab andhere me nahi ghulega.
export function sendTypeOf(payload) {
  if (!payload || typeof payload !== 'object') return 'unknown';
  if (payload.status === 'read') return 'read';
  if (payload.type === 'interactive') return payload.interactive?.type === 'list' ? 'list' : 'buttons';
  return payload.type || 'unknown'; // 'text' | 'audio'
}

export function graphErrorLogLine(payload, status, rawBody, netErr) {
  let code = '-'; let message = '-'; let subcode = '-'; let fbtrace = '-';
  if (netErr) { code = 'network_error'; message = String(netErr?.message || netErr).slice(0, 200); }
  else if (rawBody) {
    try {
      const err = JSON.parse(rawBody)?.error;
      if (err) {
        code = err.code ?? '-';
        message = String(err.message ?? '-').slice(0, 200);
        subcode = err.error_subcode ?? '-';
        fbtrace = err.fbtrace_id ?? '-';
      } else message = String(rawBody).slice(0, 200);
    } catch { message = String(rawBody).slice(0, 200); }
  }
  return `[graph-cloud] send failed type=${sendTypeOf(payload)} status=${status} code=${code} message=${message} subcode=${subcode} fbtrace=${fbtrace}`;
}

async function postGraph(payload) {
  if (!graphConfigured()) {
    console.error(`[graph-cloud] send skipped type=${sendTypeOf(payload)} reason=not_configured (WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing)`);
    return false;
  }
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${env.whatsappPhoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.whatsappCloudToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error(graphErrorLogLine(payload, res.status, t));
      return false;
    }
    return true;
  } catch (e) { console.error(graphErrorLogLine(payload, 0, null, e)); return false; }
}

export const sendText = (to, body) => postGraph(buildTextPayload(to, body));
export async function sendList(to, opts) {
  const p = buildListPayload(to, opts);
  if (!p) { console.error('[graph-cloud] send skipped type=list reason=empty_payload (koi valid row nahi)'); return false; }
  return postGraph(p);
}
export async function sendButtons(to, opts) {
  const p = buildButtonsPayload(to, opts);
  if (!p) { console.error('[graph-cloud] send skipped type=buttons reason=empty_payload (koi valid button nahi)'); return false; }
  return postGraph(p);
}
export const sendAudioByLink = (to, url) => postGraph(buildAudioLinkPayload(to, url));
export const markRead = (messageId, typing = false) =>
  (messageId ? postGraph(buildReadPayload(messageId, typing)) : Promise.resolve(false));
