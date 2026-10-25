import * as evo from './evolution.js';
import * as graph from './graph-cloud.js';
import { brandText } from '../middleware/branding.js';
import { getAdForJid, adBlock } from './ads.js';

// Channel TRANSPORT (Hybrid Phase-2, 2026-10-25): handlers (masterMenu / consult /
// worker) Evolution-wale send signatures (inst, to, ...) hi use karte rahte hain —
// inst === CLOUD_INSTANCE ho to send Graph Cloud (Official API) se jata hai, warna
// Evolution se, bilkul pehle jaisa (zero behavior change — delegation 1:1 hai).
// Cloud par Evolution-wali semantics is prakar sambhali gayi hain:
//  - Branding/footer: sendText par brandText bilkul Evolution jaisa; sendList par
//    footer flag ho to interactive footer '⚡ Powered by RazzScale AI' (footer rule:
//    sirf menu + gaana delivery — woh faisla caller ke opts.footer se hi aata hai).
//  - Ads: opts.ad par adBlock Evolution ki tarah jodta hai.
//  - Presence (typing/recording): Cloud par is function se nahi hota — inbound par
//    markRead+typing whatsapp-cloud.js khud karta hai. Yaha no-op (kabhi throw nahi,
//    Evolution presence bhi andar errors swallow karta hai — parity barkarar).
//  - sent_registry: woh Evolution ke fromMe echo ko pehchanne ke liye hai; Cloud par
//    echo aata hi nahi, isliye registry yaha nahi banti.
// Return shape: Evolution data ki jagah success par { cloud: true }, fail par null —
// callers truthiness/.catch hi use karte hain, dono par barabar chalta hai.

export const CLOUD_INSTANCE = 'cloud';
export const isCloud = (inst) => inst === CLOUD_INSTANCE;
export const clampListTitle = evo.clampListTitle;
export const clampListDesc = evo.clampListDesc;

export async function sendText(inst, to, text, opts = {}) {
  if (!isCloud(inst)) return evo.sendText(inst, to, text, opts);
  let finalText = text;
  if (opts.ad) { const ad = await getAdForJid(to).catch(() => null); finalText = text + adBlock(ad); }
  const okSend = await graph.sendText(to, brandText(finalText, opts.footer === true));
  return okSend ? { cloud: true } : null;
}

export async function sendList(inst, to, { title, description, buttonText, sections, footer = false, listBody } = {}) {
  if (!isCloud(inst)) return evo.sendList(inst, to, { title, description, buttonText, sections, footer });
  // Cloud LIST body ke liye KHaas niyam (2026-10-25 production sabak): interactive
  // body ek CHHOTA prompt hota hai — poora text-menu (MENU_TEXT ~670 chars +
  // branding block + wa.me link) usme ghusana hi sabse khatarnak field tha (1024
  // limit ke sabse qareeb, env-link par nirbhar, aur list ke hote hue duplicate).
  // Isliye: caller listBody de to wahi; warna chhota description jaisa hai waisa;
  // lamba description ho to sirf chhota generic prompt. Branding ka hissa sirf
  // footer FIELD me rehta hai — wa.me wala poora footer TEXT sends par hi lagega
  // (brandText wahan pehle jaisa hi chalta hai, footer rule barkarar).
  const rawDesc = String(description || '');
  const body = listBody ?? (rawDesc.length <= 300 ? rawDesc : 'Options neeche hain — ek tap karo 👇');
  const okSend = await graph.sendList(to, {
    header: title,
    body,
    footer: footer === true ? '⚡ Powered by RazzScale AI' : undefined,
    buttonText,
    sections,
  });
  // Parity: Evolution sendList fail par THROW karta hai aur callers usi par text
  // fallback chalate hain (khaas taur par home menu) — Cloud par bhi waisa hi.
  // Fallback ghate to pehle ek line log — warna production me pata hi nahi chalta
  // ki list gayi hi nahi (2026-10-25 wali ghatna ki asal jad yahi thi).
  if (!okSend) {
    console.error('[transport] list send failed → text fallback reason=cloud_list_send_failed');
    throw new Error('cloud_list_send_failed');
  }
  return { cloud: true };
}

export async function sendMedia(inst, to, media, caption = '', mediatype = 'audio', opts = {}) {
  if (!isCloud(inst)) return evo.sendMedia(inst, to, media, caption, mediatype, opts);
  // Cloud par sirf public URL wala audio LINK se ja sakta hai (base64/file-upload is
  // phase me nahi hai). Audio par Cloud caption support nahi karta — gaana delivery ke
  // baad wale actions worker Buttons se bhejta hai, isliye caption yaha drop hota hai.
  if (mediatype === 'audio' && /^https?:\/\//.test(String(media || ''))) {
    const okSend = await graph.sendAudioByLink(to, media);
    return okSend ? { cloud: true } : null;
  }
  console.error('[transport] cloud sendMedia unsupported:', mediatype, String(media || '').slice(0, 40));
  return null;
}

export async function sendPresence(inst, to, presence = 'composing', delayMs = 30000) {
  if (!isCloud(inst)) return evo.sendPresence(inst, to, presence, delayMs);
  return null; // Cloud typing = inbound markRead par; yaha kuch nahi (flow kabhi na ruke)
}
