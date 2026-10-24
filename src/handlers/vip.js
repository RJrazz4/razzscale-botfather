import { env } from '../config/env.js';

// VIP FUNNEL (Hero, 2026-10-23): Advanced features sirf DIKHTE hain — asal setup ke liye
// founder (insaan) se baat hoti hai.
// NUMBER PRIVACY (2026-10-24): personal number public pitch me NAHI jayega — link MASTER
// BOT ka apna hai (env.masterWaLink). Asal baat human mode me hoti hai (consult confirm
// par bot pause ho jata hai, Boss usi chat me khud jawab deta hai).
export const VIP_FEATURES = [
  'Bulk Messaging System',
  'Automated Lead Generation',
  'Order / Booking System',
  'Custom Trained Business AI',
  'White-Label Bot (Branding Hata Kar)',
];

// NOTE: wa.me text ko sahi se encode kiya gaya hai (underscores wala raw text chat me badsurat dikhta)
export const VIP_WA_LINK =
  env.masterWaLink + '?text=' + encodeURIComponent('Hi RazzScale, mujhe VIP Automation chahiye');

export function vipMenuText() {
  return `🚀 *Advanced Automation & VIP Tools*\n\nYe hamare high-level tools hain — bade businesses ke liye:\n\n${VIP_FEATURES.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nKaun sa chahiye? Number likho (1-5) — main tumhe seedha founder se judwa dunga.`;
}

export function vipPitchText(feature) {
  return `🔥 *${feature}* — ye koi aam feature nahi hai.\n\nYe system un businesses ke liye banta hai jo scale kar rahe hain: setup hum khud karte hain, tumhare business ke hisaab se custom. Bot par ye khud activate nahi hota — iske liye seedha humare founder se baat hoti hai, wahi tumhe price aur poora plan denge (₹999 se shuru, custom deal bhi banta hai).\n\n👇 Ek tap me RazzScale ki chat par jao — message pehle se likha hua milega, bas bhej dena. Wahan insaan khud baat karega:\n${VIP_WA_LINK}`;
}
