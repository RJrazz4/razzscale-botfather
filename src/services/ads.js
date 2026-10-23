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

// Per-contact daily cap (V2.1, plan §5 fix #7): ek contact ko ek din me max 10 ad lines —
// uske baad message bina ad ke jayega (viral footer hamesha rehta hai, woh cap se bahar hai).
export const AD_DAILY_CAP = 10;
export async function getAdForJid(jid) {
  const ad = await getActiveAd();
  if (!ad || !jid) return ad;
  const day = new Date().toISOString().slice(0, 10); // UTC day
  try {
    const { rows } = await pool.query('select count from ad_impressions where jid=$1 and day=$2', [String(jid), day]);
    if ((rows[0]?.count || 0) >= AD_DAILY_CAP) return null;
    await pool.query(
      `insert into ad_impressions (jid, day, count) values ($1,$2,1)
       on conflict (jid, day) do update set count = ad_impressions.count + 1`, [String(jid), day]);
    return ad;
  } catch { return ad; } // impressions table na ho (purana pg schema) to purana uncapped behavior
}
