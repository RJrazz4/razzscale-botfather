// FOOTER DISCIPLINE (Hero ka order, 2026-10-24 — purana "har message par footer" wala
// viral rule OVERRIDE): footer DEFAULT band hai. Sirf tab lagega jab caller
// explicitly bole (sendText/sendMedia me opts.footer === true).
// Footer ON sirf do jagah: (1) master menu dikhate waqt, (2) music audio deliver hone par.
// Promo link = MASTER BOT ka apna link (env.masterWaLink). NUMBER PRIVACY (2026-10-24):
// Hero ka personal number public footer me NAHI jayega — master number hi public pehchan hai.
import { env } from '../config/env.js';

export const FOOTER = `\n\n⚡ Powered by RazzScale AI\nApna FREE bot banao: ${env.masterWaLink}`;

export function brandText(text, footer = false) {
  if (!text) return footer ? `⚡ Powered by RazzScale AI\nApna FREE bot banao: ${env.masterWaLink}` : text;
  if (!footer) return text;
  return text.includes('Powered by RazzScale AI') ? text : text + FOOTER;
}
export function brandCaption(caption = '', footer = false) {
  if (!footer) return caption;
  return caption.includes('Powered by RazzScale AI') ? caption : (caption + FOOTER).trim();
}
