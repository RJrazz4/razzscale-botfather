import express from 'express';
import { env } from './config/env.js';
import { handleEvolutionWebhook } from './handlers/sessionRouter.js';
import { sweepZombies } from './services/spawner.js';
import * as evo from './services/evolution.js';
import { pool } from './db/pool.js';


// Bootstrap: deploy ke baad master instance khud ban jayega (koi manual API call nahi)
async function bootstrapMaster() {
  try {
    const list = await evo.fetchInstances();
    const names = (Array.isArray(list) ? list : []).map(i => i.name || i.instance?.instanceName);
    if (!names.includes(env.masterInstance)) {
      const secret = process.env.MASTER_WEBHOOK_SECRET || 'master-secret';
      await evo.createInstance(env.masterInstance, `${process.env.PUBLIC_BASE_URL}/webhook/evolution/${secret}`, secret);
      console.log('[bootstrap] master instance created');
    }
  } catch (e) { console.error('[bootstrap]', e?.message || e); }
}


const app = express();
app.use(express.json({ limit: '25mb' }));
app.get('/health', (req, res) => res.json({ ok: true, service: 'razzscale-botfather' }));


// Admin: pairing code nikalne ke liye (sirf ADMIN_SECRET se) — Hero ko code dene ke kaam aayega
app.get('/admin/pair-master', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.key !== process.env.ADMIN_SECRET) return res.status(401).json({ ok: false });
  try {
    const number = (process.env.MASTER_PHONE || '918249388815').replace(/\D/g, '');
    const conn = await evo.connectPairing(env.masterInstance, number);
    res.json({ ok: true, pairingCode: conn?.pairingCode || null, qr: conn?.code || null });
  } catch (e) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});


// TEMPORARY admin: master WhatsApp instance ka clean-slate reset (logout -> delete -> create -> 10s wait).
// Bad-socket ("Invalid buffer") state se recover karne ke liye. Sirf ADMIN_SECRET se, sirf ek baar call karo.
let masterReset = { running: false, done: false, log: [] };
app.get('/admin/reset-master-x4Kp7Qm2Zv9', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.key !== process.env.ADMIN_SECRET) return res.status(401).json({ ok: false });
  if (req.query.status === '1') return res.json({ ok: true, state: masterReset });
  if (masterReset.running) return res.json({ ok: true, note: 'already running', state: masterReset });
  masterReset = { running: true, done: false, log: [] };
  const base = process.env.EVOLUTION_BASE_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const inst = process.env.MASTER_INSTANCE || 'razzscale-master';
  const step = async (method, path, body) => {
    try {
      const r = await fetch(base + path, { method, headers: { apikey: key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      masterReset.log.push(method + ' ' + path + ' -> ' + r.status + ' ' + t.slice(0, 220));
    } catch (e) { masterReset.log.push(method + ' ' + path + ' -> ERROR ' + String((e && e.message) || e)); }
  };
  try {
    await step('POST', '/instance/logout/' + inst);
    await step('DELETE', '/instance/delete/' + inst);
    await step('POST', '/instance/create', { instanceName: inst, qrcode: true, integration: 'WHATSAPP-BAILEYS' });
    masterReset.log.push('waiting 10s for socket init...');
    await new Promise((r) => setTimeout(r, 10000));
    await step('GET', '/instance/fetchInstances');
  } finally {
    masterReset.running = false;
    masterReset.done = true;
  }
  res.json({ ok: true, state: masterReset });
});


// TEMPORARY: QR-pairing page (master ko QR scan se link karo)
app.get('/pair-display-x4Kp7Qm2Zv9', async (req, res) => {
  try {
    const base = process.env.EVOLUTION_BASE_URL;
    const key = process.env.EVOLUTION_API_KEY;
    const inst = process.env.MASTER_INSTANCE || 'razzscale-master';
    const r = await fetch(base + '/instance/connect/' + inst, { headers: { apikey: key } });
    const data = await r.json();
    const img = data.base64 || (data.qrcode && data.qrcode.base64) || '';
    res.set('Content-Type', 'text/html');
    res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>RazzScale Master QR</title></head><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:20px"><h2>RazzScale Master QR</h2><p>Master phone (8249388815) se WhatsApp → Linked Devices → Link a Device → ye QR scan karo</p>' + (img ? '<img src="' + img + '" style="width:320px;height:320px;background:#fff;padding:10px"/>' : '<p>QR taiyaar ho raha hai…</p>') + '<p><button onclick="location.reload()" style="font-size:22px;padding:16px 32px;margin-top:18px;cursor:pointer;border:none;border-radius:10px;background:#25D366;color:#fff;font-weight:bold">🔄 Naya QR lao</button></p><p style="color:#aaa">Page khud refresh nahi hoga — naya QR chahiye to button dabao.</p></body></html>');
  } catch (e) { res.status(500).send('error — refresh karo'); }
});


app.post('/webhook/evolution/:secret?', async (req, res) => {
  res.sendStatus(200);
  try {
    const instanceName = req.body?.instance || req.body?.instanceName || req.body?.data?.instance;
    if (!instanceName) return;
    await handleEvolutionWebhook(instanceName, req.body, req.params.secret || null);
  } catch (e) { console.error('[webhook]', e?.message || e); }
});


// Zombie session sweeper — har 2 min
setInterval(() => { sweepZombies().then(n => { if (n) console.log(`[sweeper] ${n} zombie sessions failed`); }).catch(() => {}); }, 120_000);


app.listen(env.port, () => { console.log(`RazzScale BotFather listening on :${env.port}`); bootstrapMaster(); });
