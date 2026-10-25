import 'dotenv/config';
import { pool } from '../db/pool.js';

export const env = {
  port: process.env.PORT || 8787,
  evolutionBase: (process.env.EVOLUTION_BASE_URL || 'http://localhost:8080').replace(/\/$/, ''),
  evolutionKey: process.env.EVOLUTION_API_KEY || '',
  masterInstance: process.env.MASTER_INSTANCE || 'razzscale-master',
  // Master BOT ka apna PUBLIC link — saare public surfaces (footer, VIP pitch) par yahi
  // jata hai. Personal number public messages me KABHI nahi (privacy rule, 2026-10-24).
  masterWaLink: process.env.MASTER_WA_LINK || 'https://wa.me/918249388815',
  // Owner (Boss) ka PERSONAL number — VIP handoff isi par jata hai. masterWaLink se alag hai
  // (woh master BOT ka apna link hai). Default wahi number jo handlers/vip.js me pehle se hai.
  ownerWaNumber: (process.env.OWNER_WA_NUMBER || '917205191890').replace(/\D/g, ''),
  adminWaId: process.env.ADMIN_WA_ID || '',
  llmKeys: [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY2].filter(Boolean),
  llmModel: process.env.FREE_LLM_MODEL || 'google/gemma-3-27b-it:free',
  ytdlp: process.env.YTDLP_BIN || 'yt-dlp',
  musicTmp: process.env.MUSIC_TMP_DIR || '/tmp/razz-music',
  ffmpeg: process.env.FFMPEG_BIN || 'ffmpeg',
  // Architecture V2.1 — DB + Telegram Vault
  dbMode: (process.env.DB_MODE || 'supabase').toLowerCase(), // 'sqlite' | 'supabase'
  sqlitePath: process.env.SQLITE_PATH || './data/botfather.db',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '', // sirf env se — kabhi log/print nahi
  telegramVaultChatId: process.env.TELEGRAM_VAULT_CHAT_ID || '',
  // WhatsApp Cloud API (Official, Hybrid Phase-1) — saare optional; koi na ho to
  // whatsapp-cloud module chup-chaap disabled rehta hai, boot kabhi fail nahi hota.
  // Token/secret sirf env se — kabhi log/print nahi.
  whatsappCloudToken: process.env.WHATSAPP_CLOUD_TOKEN || '',
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  whatsappWabaId: process.env.WHATSAPP_WABA_ID || '',
  whatsappWebhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET || '',
};

// global_config cache (30s) — ENABLE_PAYWALL yahi se padha jata hai
let cache = { at: 0, map: {} };
export async function getConfig(key, fallback) {
  if (Date.now() - cache.at > 30_000) {
    const { rows } = await pool.query('select key, value from global_config');
    cache = { at: Date.now(), map: Object.fromEntries(rows.map(r => [r.key, r.value])) };
  }
  return key in cache.map ? cache.map[key] : fallback;
}
export const paywallEnabled = () => getConfig('ENABLE_PAYWALL', false);
