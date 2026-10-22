import { pool } from '../db/pool.js';
// Active ad cache (60s) — sabse zyada priority wala live ad
let cache = { at: 0, ad: null };
export async function getActiveAd() {
  if (Date.now() - cache.at < 60_000) return cache.ad;
  const { rows } = await pool.query(
    `select * from active_ads where is_active = true
       and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at >= now())
     order by priority desc, created_at desc limit 1`);
  cache = { at: Date.now(), ad: rows[0] || null };
  return cache.ad;
}
export function adBlock(ad) {
  if (!ad) return '';
  return `\n\n📢 ${ad.text}${ad.link_url ? `\n${ad.link_url}` : ''}`;
}
