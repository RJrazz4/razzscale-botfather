// DORMANT MODULE — YouPI PG V2. ENABLE_PAYWALL=false ke jab tak, ye kabhi call nahi hoga.
// Hero ke "paywall ON" bolne par yahan payment link create + webhook verify judega.
export async function createPaymentLink() {
  return { ok: false, reason: 'paywall_disabled' };
}
export async function verifyPaymentWebhook() {
  return { ok: false, reason: 'paywall_disabled' };
}
