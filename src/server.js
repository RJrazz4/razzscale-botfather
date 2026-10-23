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
