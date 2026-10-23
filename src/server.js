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


// TEMPORARY admin: Evolution ops for the master instance — state check + clean recreate WITH number.
// Sirf ADMIN_SECRET se. op=state | op=instances | op=reset2
app.get('/admin/evo-ops-x4Kp7Qm2Zv9', async (req, res) => {
  if (!process.env.ADMIN_SECRET || req.query.key !== process.env.ADMIN_SECRET) return res.status(401).json({ ok: false });
  const base = process.env.EVOLUTION_BASE_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const inst = process.env.MASTER_INSTANCE || 'razzscale-master';
  const out = [];
  const call = async (method, path, body) => {
    try {
      const r = await fetch(base + path, { method, headers: { apikey: key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = t; }
      out.push({ op: method + ' ' + path, status: r.status, body: j });
    } catch (e) { out.push({ op: method + ' ' + path, error: String((e && e.message) || e) }); }
  };
  try {
    const op = req.query.op || 'state';
    if (op === 'state') {
      await call('GET', '/instance/connectionState/' + inst);
    } else if (op === 'instances') {
      await call('GET', '/instance/fetchInstances');
    } else if (op === 'reset2') {
      await call('POST', '/instance/logout/' + inst);
      await call('DELETE', '/instance/delete/' + inst);
      await call('POST', '/instance/create', { instanceName: inst, number: '918249388815', qrcode: true, integration: 'WHATSAPP-BAILEYS' });
      await new Promise((r) => setTimeout(r, 15000));
      await call('GET', '/instance/connectionState/' + inst);
    } else {
      return res.status(400).json({ ok: false, error: 'unknown op' });
    }
  } catch (e) { return res.status(500).json({ ok: false, error: String((e && e.message) || e) }); }
  res.json({ ok: true, results: out });
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
