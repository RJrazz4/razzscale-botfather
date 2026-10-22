import { env } from '../config/env.js';

// NON-NEGOTIABLE VIRAL RULE: har outgoing message ek hi darwaze se jayega.
// Footer text messages me append hota hai; media ke caption me jata hai.
export const FOOTER = `\n\n⚡ Powered by RazzScale AI\nApna FREE bot banao: ${env.masterWaLink}`;

export function brandText(text) {
  if (!text) return `⚡ Powered by RazzScale AI\n${env.masterWaLink}`;
  return text.includes('Powered by RazzScale AI') ? text : text + FOOTER;
}
export function brandCaption(caption = '') {
  return caption.includes('Powered by RazzScale AI') ? caption : (caption + FOOTER).trim();
}
