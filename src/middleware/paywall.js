import { paywallEnabled } from '../config/env.js';

// MASTER TOGGLE GATE — abhi ENABLE_PAYWALL=false hai: sab kuch free.
// Jab Hero bolega aur flag true hoga, tab premium-only features plan_status dekhenge.
const PREMIUM_FEATURES = new Set(['spawn_extra_bot', 'leadgen_pro', 'ai_unlimited']);

export async function featureAllowed(user, feature) {
  const on = await paywallEnabled();
  if (!on) return true;                                  // launch phase: 100% free
  if (!PREMIUM_FEATURES.has(feature)) return true;       // basic hamesha free
  return user?.plan_status === 'premium';
}
export const PAYWALL_OFF_MESSAGE =
  'Ye feature abhi sabke liye FREE hai — enjoy karo! ⚡';
// Paywall ON hone par gate-hit bhi VIP funnel par jayega (vip.js ka vipPitchText) —
// handler wahan feature ka naam dekar pitch + personal deep link bhejega.
