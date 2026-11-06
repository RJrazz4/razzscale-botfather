import { upsertUser } from '../db/pool.js';
import { CLOUD_INSTANCE } from '../services/transport.js';
import { enqueueJob } from '../services/worker.js';
import { notifyOwner } from '../services/owner.js';
import { WORK_KINDS, HEAVY_WORDS } from './workplace.js';

// WEBSITE DARWAZA (2026-11-06 raat — Hero ka hukm: website = dusra darwaza,
// peeche wahi ek system). tubeclickpro.in se likhai ka order seedha bot ki
// USI jobs line (likhai_work) me jata hai jahan WhatsApp wale order jate
// hain — wahi worker kaam banata hai, wahi Boss-approval (worklist /
// work_ok / work_no) chalta hai. Customer ka users row wa_id = uska
// WhatsApp number hai, isliye kal ko wohi customer WhatsApp par aaye to
// wohi pehchan milegi (upsertUser wa_id par merge karta hai).
// Bhaari kaam yahan bhi nahi banta — web par bhi wahi ⭐ filter: VIP rasta.
// Delivery: taiyaar kaam Boss ke 'Bhej do' par customer ke WhatsApp number
// par jata hai (handleOwnerWork) — isliye form ke baad page customer ko
// hamare WhatsApp par ek 'Hi' bhejne ka deep-link deta hai (24h window
// khul jata hai aur baat bhi jud jati hai).

const BOT_WA_NUMBER = '917656824415'; // RazzScale AI (BSNL, Cloud API)
const ALLOWED_ORIGINS = ['https://tubeclickpro.in', 'https://www.tubeclickpro.in'];

// Halki rate-limit (memory me): form-spam se jobs line na bhare.
// Boss ki approval-gate ke pehle sirf shor hota hai, asal nuksan nahi —
// phir bhi IP par 5/hour aur number par 3/hour ki seema rakhi hai.
const hits = new Map();
function rateOk(key, max, windowMs = 3600_000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr);
  return true;
}

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  if (d.length === 12 && d.startsWith('91')) return d;
  return null;
}

export function registerWebDoorRoutes(app) {
  app.use('/web', (req, res, next) => {
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  app.post('/web/order', async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 60);
      const phone = normalizePhone(b.phone);
      const kindLabel = WORK_KINDS[String(b.kind || '')] || String(b.kindLabel || '').trim();
      const brief = String(b.brief || '').trim().slice(0, 600);
      if (!phone) return res.status(400).json({ ok: false, error: 'Sahi WhatsApp number do (10 digit).' });
      if (!Object.values(WORK_KINDS).includes(kindLabel)) return res.status(400).json({ ok: false, error: 'Kaam ki type chuno.' });
      if (brief.length < 10) return res.status(400).json({ ok: false, error: 'Kaam ki tafseel thodi aur batao (kam se kam 10 akshar).' });
      if (!rateOk(`ip:${req.ip}`, 5) || !rateOk(`ph:${phone}`, 3)) {
        return res.status(429).json({ ok: false, error: 'Bahut zyada order ho gaye — thodi der baad try karo, ya WhatsApp par aa jao.' });
      }
      // ⭐ HALKA/BHAARI FILTER — web par bhi wahi niyam: bhaari = VIP rasta,
      // jhootha order kabhi nahi.
      if (HEAVY_WORDS.some((h) => brief.toLowerCase().includes(h))) {
        await notifyOwner(CLOUD_INSTANCE,
          `🔔 *Bhaari kaam ki maang (Website se — VIP bheja)*\n👤 ${name || 'Customer'}: +${phone}\n📝 Brief: "${brief.slice(0, 200)}"`).catch(() => {});
        return res.json({
          ok: false, heavy: true,
          message: 'Ye kaam bhaari hai — ye Boss RazzScale khud banate hain. WhatsApp par baat kar lo, wahan se aage badhega.',
          waLink: `https://wa.me/${BOT_WA_NUMBER}?text=${encodeURIComponent('Hi! Mujhe apna khud ka system/agent banwana hai. (Website se aaya hoon)')}`,
        });
      }
      const user = await upsertUser(phone, name || null, 'web');
      const orderId = `WK-${Date.now().toString(36).toUpperCase()}`;
      const enq = await enqueueJob('likhai_work',
        { instance: CLOUD_INSTANCE, to: phone, userId: user?.id ?? null, orderId, workKind: kindLabel, brief, stage: 'queued', source: 'web', name },
        `work:${orderId}`);
      if (!enq.queued && !enq.existing) return res.status(500).json({ ok: false, error: 'Order nahi lag paya — ek minute me dobara try karo.' });
      await notifyOwner(CLOUD_INSTANCE,
        `🌐 *Website se naya order* — ${orderId}\n👤 ${name || 'Customer'}: +${phone}\n📝 Kaam: ${kindLabel}\n📋 Brief: "${brief.slice(0, 160)}"\n\nKaam bankar taiyaar hote hi approval buttons yahin aayenge.`).catch(() => {});
      return res.json({
        ok: true, orderId,
        message: 'Order mil gaya! Kaam bankar taiyaar hoga, ek quality jaanch ke baad tumhare WhatsApp par milega.',
        waLink: `https://wa.me/${BOT_WA_NUMBER}?text=${encodeURIComponent(`Hi! Mera website order ${orderId} (${kindLabel}) — taiyaar kaam yahin bhej do.`)}`,
      });
    } catch (e) {
      console.error('[webdoor] order fail:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'Kuch gadbad ho gayi — dobara try karo.' });
    }
  });
}
