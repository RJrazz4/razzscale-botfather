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
  // List-selection replies (KDMusic-style tappable results): Evolution/Baileys versions me
  // shape badalta hai — selectedRowId hi rowId hai ('3' = pick, 'more' = more-flow).
  // Jo shape mile use text ki jagah rakh do; na mile to normal text path chalega.
  let listRowId = msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.listResponseMessage?.selectedRowId || '';
  if (!listRowId && msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
    try {
      const pj = JSON.parse(msg.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
      listRowId = pj.id || pj.selected_id || pj.rowId || '';
    } catch { /* paramsJson parse na ho to ignore */ }
  }
  const text = msg.conversation || msg.extendedTextMessage?.text ||
    listRowId ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.templateButtonReplyMessage?.selectedId || '';
  return {
    instanceName, ev, data,
    text: String(text || '').trim(),
    from: String(key.remoteJid || '').replace('@s.whatsapp.net', ''),
    chatJid: String(key.remoteJid || ''),
    msgId: key.id ? String(key.id) : null,
    isGroup: String(key.remoteJid || '').includes('@g.us'),
    fromMe: key.fromMe === true,
    pushName: data?.pushName || null,
    connState: data?.state || data?.status || null,
    qrBase64: data?.qrcode?.base64 || data?.qr?.base64 || null,
  };
}

// --- V2.1: webhook dedup — ek hi WhatsApp message (redelivery) do baar process nahi hoga ---
async function isDuplicate(msgId) {
  if (!msgId) return false;
  try {
    const { rows } = await pool.query(
      'insert into processed_messages (id, ts) values ($1,$2) on conflict (id) do nothing returning id',
      [msgId, new Date().toISOString()]);
    if (Math.random() < 0.01) { // kabhi-kabhi 24h se purane saaf karo
      const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
      await pool.query('delete from processed_messages where ts < $1', [cutoff]).catch(() => {});
    }
    return rows.length === 0;
  } catch { return false; } // dedup table fail ho to message drop mat karo
}

// --- V2.1: Manual Chat Auto-Pause (plan §5) ---
const PAUSE_MS = 12 * 3600_000; // 12 ghante baad lazy auto-resume
async function isPaused(jid) {
  try {
    const { rows } = await pool.query('select paused_at from paused_contacts where jid=$1', [jid]);
    if (!rows[0]) return false;
    const age = Date.now() - new Date(rows[0].paused_at).getTime();
    if (age >= PAUSE_MS) { // lazy expiry — sleeping service par timer bharosa nahi
      await pool.query('delete from paused_contacts where jid=$1', [jid]).catch(() => {});
      return false;
    }
    return true;
  } catch { return false; }
}
async function setPause(jid, reason) {
  await pool.query(
    `insert into paused_contacts (jid, paused_at, reason) values ($1,$2,$3)
     on conflict (jid) do update set paused_at=excluded.paused_at, reason=excluded.reason`,
    [jid, new Date().toISOString(), reason]).catch(() => {});
}
async function clearPause(jid) {
  await pool.query('delete from paused_contacts where jid=$1', [jid]).catch(() => {});
}

// Master number se aaya fromMe message: bot ka apna send (registry me hai) -> ignore;
// warna owner ne phone se khud likha hai -> us contact ke liye bot pause.
async function handleOwnerManual(x) {
  const chatNumber = x.chatJid.replace('@s.whatsapp.net', '');
  if (!chatNumber || !/^\d+$/.test(chatNumber)) return;
  const masterNumber = (env.masterWaLink.match(/(\d{10,})/) || [])[1];
  if (chatNumber === masterNumber) return; // self-chat ("Message yourself") — pause ka koi matlab nahi
  if (x.msgId) {
    const { rows } = await pool.query('select message_id from sent_registry where message_id=$1', [x.msgId]).catch(() => ({ rows: [] }));
    if (rows[0]) return; // bot ka apna bheja message — pause NAHI lagega (Review flaw #1 ka ilaaj)
  }
  const cmd = (x.text || '').trim().toLowerCase();
  if (cmd === '/bot on') { await clearPause(chatNumber); return; }
  if (cmd === '/bot off') { await setPause(chatNumber, 'manual_off'); return; }
  await setPause(chatNumber, 'manual_chat');
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
  if (await isDuplicate(x.msgId)) return; // webhook redelivery dedup
  if (x.fromMe) {
    // Master par fromMe = bot ke sends (registry se pehchan) ya owner ki manual chat (auto-pause)
    if (inst === env.masterInstance && !x.isGroup) await handleOwnerManual(x).catch(() => {});
    return; // self-loop guard (sub-bots par bhi)
  }
  if (x.isGroup || !x.from || !x.text) return; // group guard

  if (inst === env.masterInstance) {
    if (x.from === (env.masterWaLink.match(/(\d{10,})/) || [])[1]) return; // apna number skip
    if (await isPaused(x.from)) return; // owner khud baat kar raha hai — bot chup rahega
    const user = await upsertUser(x.from, x.pushName, 'direct');
    await handleMasterMessage({ user, from: x.from, text: x.text, pushName: x.pushName, msgId: x.msgId });
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
