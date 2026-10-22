import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { env, getConfig } from '../config/env.js';
import * as evo from './evolution.js';

export const BOT_GREETINGS = {
  support:  'Namaste! Main aapka Support Bot hoon. Apna sawaal likhiye, main turant jawab dunga.',
  ai:       'Hi! Main aapka AI Assistant hoon. Kuch bhi pucho, main madad karunga.',
  music:    'Namaste! Gaana sunna hai? Bas gaane ka naam bhej do.',
  leadgen:  'Namaste! Hamari services me interest ke liye dhanyavaad. Apna naam aur requirement bhej dijiye.',
};

export async function spawnSubBot({ user, botType, ownerPhone }) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(727272)'); // count+insert atomic (cap race fix)
    // Duplicate spawn reuse: pehle se pending hai to wahi session, naya code
    const { rows: pending } = await client.query(
      `select * from sessions where user_id=$1 and status in ('created','awaiting_pair') limit 1`, [user.id]);
    if (pending[0]) {
      await client.query('commit');
      const conn = await evo.connectPairing(pending[0].instance_name, ownerPhone);
      await pool.query('update sessions set pair_issued_at=now(), phone_number=$2 where id=$1', [pending[0].id, ownerPhone]);
      return { ok: true, session: pending[0], pairingCode: conn?.pairingCode || null, reused: true };
    }
    const maxActive = Number(await getConfig('MAX_ACTIVE_SESSIONS', 40));
    const { rows: cnt } = await client.query(
      `select count(*)::int as n from sessions where status in ('awaiting_pair','connected','active')`);
    if (cnt[0].n >= maxActive) { await client.query('rollback'); return { ok: false, reason: 'capacity_full' }; }

    const instanceName = `rz-${user.id.replace(/-/g, '').slice(0, 10)}-${Date.now().toString(36)}`;
    const webhookSecret = crypto.randomBytes(12).toString('hex');
    const webhookUrl = `${process.env.PUBLIC_BASE_URL}/webhook/evolution/${webhookSecret}`;
    const { rows } = await client.query(
      `insert into sessions (user_id, instance_name, bot_type, webhook_secret, status, phone_number, pair_issued_at)
       values ($1,$2,$3,$4,'created',$5,now()) returning *`,
      [user.id, instanceName, botType, webhookSecret, ownerPhone]);
    const session = rows[0];
    await client.query('commit');

    await evo.createInstance(instanceName, webhookUrl, webhookSecret);
    const conn = await evo.connectPairing(instanceName, ownerPhone);
    await pool.query(`update sessions set status='awaiting_pair' where id=$1`, [session.id]);
    return { ok: true, session, pairingCode: conn?.pairingCode || null, qr: conn?.code || conn?.qrcode?.base64 || null };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally { client.release(); }
}

export async function resendPairing(session) {
  const conn = await evo.connectPairing(session.instance_name, session.phone_number);
  await pool.query('update sessions set pair_issued_at=now() where id=$1', [session.id]);
  return conn?.pairingCode || null;
}

// CONNECTION_UPDATE: conditional update = greeting sirf EK baar (redelivery-safe)
export async function onConnectionUpdate(instanceName, state) {
  if (state === 'open') {
    const { rows } = await pool.query(
      `update sessions set status='active', connected_at=coalesce(connected_at, now()), last_event_at=now()
       where instance_name=$1 and status in ('awaiting_pair','connected') returning *`, [instanceName]);
    const session = rows[0];
    if (!session) return null; // pehle hi active tha — duplicate event, greeting dobara nahi
    if (session.phone_number) {
      await evo.sendText(instanceName, session.phone_number, BOT_GREETINGS[session.bot_type] || BOT_GREETINGS.ai).catch(() => {});
    }
    return session;
  }
  if (state === 'close') {
    await pool.query(`update sessions set status='suspended', last_event_at=now() where instance_name=$1 and status='active'`, [instanceName]);
  }
  return null;
}

// Zombie sweeper: 10 min se purane created/awaiting_pair ko fail karke slot khali karo
export async function sweepZombies() {
  const { rows } = await pool.query(
    `update sessions set status='failed'
     where status in ('created','awaiting_pair') and created_at < now() - interval '10 minutes' returning instance_name`);
  for (const r of rows) { await evo.deleteInstance(r.instance_name).catch(() => {}); }
  return rows.length;
}
