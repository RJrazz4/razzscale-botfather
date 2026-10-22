import { pool, getSessionByInstance, upsertUser } from '../db/pool.js';
import { handleMasterMessage } from './masterMenu.js';
import { routeSubBotMessage } from '../bots/index.js';
import { onConnectionUpdate } from '../services/spawner.js';
import * as evo from '../services/evolution.js';
import { env } from '../config/env.js';

// Normalizer — Evolution ke versions me payload ki nesting badalti hai; yaha ek canonical shape banta hai.
function normalize(body) {
  const instanceName = body?.instance || body?.instanceName || body?.data?.instance || null;
  const ev = String(body?.event || '').toLowerCase();
  let data = body?.data || {};
  if (Array.isArray(data)) data = data[0] || {};
  const msg = data?.message || {};
  const key = data?.key || {};
  const text = msg.conversation || msg.extendedTextMessage?.text ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.buttonsResponseMessage?.selectedButtonId || '';
  return {
    instanceName, ev, data,
    text: String(text || '').trim(),
    from: String(key.remoteJid || '').replace('@s.whatsapp.net', ''),
    isGroup: String(key.remoteJid || '').includes('@g.us'),
    fromMe: key.fromMe === true,
    pushName: data?.pushName || null,
    connState: data?.state || data?.status || null,
    qrBase64: data?.qrcode?.base64 || data?.qr?.base64 || null,
  };
}

export async function handleEvolutionWebhook(instanceName, body, secret) {
  const x = normalize(body);
  const inst = instanceName || x.instanceName;
  if (!inst) return;

  // Master webhook: env wala secret (route param) match ho tabhi aage
  if (inst === env.masterInstance) {
    const ms = process.env.MASTER_WEBHOOK_SECRET;
    if (ms && secret && secret !== ms) return;
  }
  // Sub-bot webhook: secret verify
  if (inst !== env.masterInstance) {
    const session0 = await getSessionByInstance(inst);
    if (!session0) return;
    if (!secret || secret !== session0.webhook_secret) return; // spoofed request drop
  }

  // QR fallback: pairing fail ho to QR owner ko Master se bhejo (slot atakta nahi)
  if (x.ev.includes('qrcode')) {
    if (inst !== env.masterInstance && x.qrBase64) {
      const s = await getSessionByInstance(inst);
      if (s) {
        const { rows } = await pool.query('select wa_id from users where id=$1', [s.user_id]);
        if (rows[0]) await evo.sendMedia(env.masterInstance, rows[0].wa_id, x.qrBase64,
          'Pairing code kaam nahi kiya to ye QR scan kar lo (WhatsApp → Linked Devices).', 'image').catch(() => {});
      }
    }
    return;
  }
  if (x.ev.includes('connection')) {
    if (inst !== env.masterInstance) {
      const activated = await onConnectionUpdate(inst, x.connState);
      if (activated) {
        // Connect se pehle buffer hue messages ka replay
        const { rows: pend } = await pool.query(
          'select * from pending_messages where session_id=$1 order by id', [activated.id]);
        for (const p of pend) {
          await routeSubBotMessage({ session: activated, from: p.from_wa, text: p.body_text }).catch(() => {});
        }
        if (pend.length) await pool.query('delete from pending_messages where session_id=$1', [activated.id]);
      }
    }
    return;
  }
  if (!x.ev.includes('messages')) return;
  if (x.fromMe || x.isGroup || !x.from || !x.text) return; // self-loop + group guard

  if (inst === env.masterInstance) {
    if (x.from === (env.masterWaLink.match(/(\d{10,})/) || [])[1]) return; // apna number skip
    const user = await upsertUser(x.from, x.pushName, 'direct');
    await handleMasterMessage({ user, from: x.from, text: x.text, pushName: x.pushName });
    return;
  }
  const session = await getSessionByInstance(inst);
  if (!session) return;
  if (session.status !== 'active') {
    // Buffer karo, drop nahi (activation par replay hoga)
    await pool.query('insert into pending_messages (session_id, from_wa, body_text) values ($1,$2,$3)',
      [session.id, x.from, x.text]);
    return;
  }
  if (x.from === session.phone_number) return; // owner khud bot number se — loop guard
  await routeSubBotMessage({ session, from: x.from, text: x.text });
}
