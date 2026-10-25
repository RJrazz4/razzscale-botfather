// WhatsApp Cloud API webhook module ki verification (2026-10-25):
//  GET verify (sahi token -> challenge, galat -> 403), X-Hub-Signature-256 (sahi -> 200 + event
//  store, galat/missing -> 401), sample Meta text-message payload -> whatsapp_events row.
// DB hissa TEMP sqlite file par — asal DB/network kabhi touch nahi hota (auto-reply OFF:
// WHATSAPP_CLOUD_TOKEN / PHONE_NUMBER_ID khaali, isliye koi asal Graph call nahi hota).
// Chalao: node scripts/verify-whatsapp-cloud.mjs  ->  sab PASS to exit 0.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Src modules import hone se PEHLE test env select karo (env/pool import-time par padhte hain)
const TEST_DB = path.join(os.tmpdir(), `wa-cloud-${process.pid}-${Date.now()}.db`);
process.env.DB_MODE = 'sqlite';
process.env.SQLITE_PATH = TEST_DB;
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-me-123';
process.env.WHATSAPP_APP_SECRET = 'app-secret-xyz';
process.env.WHATSAPP_CLOUD_TOKEN = '';
process.env.WHATSAPP_PHONE_NUMBER_ID = '';

let fails = 0, passes = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); cond ? passes++ : fails++; };

const express = (await import('express')).default;
const wc = await import(path.join(ROOT, 'src/services/whatsapp-cloud.js'));
const { pool } = await import(path.join(ROOT, 'src/db/pool.js'));

const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(raw).digest('hex');

// ---------- 1. Pure helpers ----------
const sample = {
  object: 'whatsapp_business_account',
  entry: [{
    id: '1435508757935515',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '917656824415', phone_number_id: '1469812529540875' },
        contacts: [{ profile: { name: 'Test User' }, wa_id: '919876543210' }],
        messages: [{ from: '919876543210', id: 'wamid.SELFTEST1', timestamp: '1729833600', type: 'text', text: { body: 'hi' } }],
      },
    }],
  }],
};
const msgs = wc.extractMessages(sample);
ok(msgs.length === 1 && msgs[0].from === '919876543210' && msgs[0].text === 'hi' && msgs[0].type === 'text'
  && msgs[0].messageId === 'wamid.SELFTEST1' && msgs[0].phoneNumberId === '1469812529540875',
  'extractMessages: sample payload se 1 text message sahi nikla');
ok(wc.extractMessages({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.X', status: 'read' }] } }] }] }).length === 0,
  'extractMessages: statuses-only payload -> 0 messages');
ok(wc.cloudConfigured() === false, 'cloudConfigured: token/ID khaali -> false (auto-reply OFF, koi network nahi)');
ok(wc.AUTO_REPLY_TEXT.includes('RazzScale AI') && wc.AUTO_REPLY_TEXT.includes("Menu ke liye 'hi'"), 'AUTO_REPLY_TEXT task wala fixed text hai');

// ---------- 2. HTTP level: asli express app, asal signature ----------
const app = express();
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } })); // server.js wala hi pattern
wc.registerWhatsAppCloudRoutes(app);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const goodGet = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=CH-987`);
ok(goodGet.status === 200 && (await goodGet.text()) === 'CH-987', 'GET verify: sahi token -> 200 + challenge plain text');
const badGet = await fetch(`${base}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=galat&hub.challenge=CH-987`);
ok(badGet.status === 403, 'GET verify: galat token -> 403');
const noModeGet = await fetch(`${base}/webhook/whatsapp?hub.verify_token=verify-me-123&hub.challenge=CH-987`);
ok(noModeGet.status === 403, 'GET verify: hub.mode missing -> 403');

const raw = JSON.stringify(sample);
const goodPost = await fetch(`${base}/webhook/whatsapp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(raw) }, body: raw,
});
ok(goodPost.status === 200, 'POST: sahi signature -> 200');
// ack turant jata hai, store uske baad — thoda intezaar karke DB check
let rows = [];
for (let i = 0; i < 20 && !rows.length; i++) {
  await new Promise((r) => setTimeout(r, 100));
  ({ rows } = await pool.query('select wa_id, message_id, type, body_text, payload from whatsapp_events'));
}
ok(rows.length === 1 && rows[0].wa_id === '919876543210' && rows[0].body_text === 'hi'
  && rows[0].type === 'text' && rows[0].message_id === 'wamid.SELFTEST1',
  'POST: whatsapp_events me 1 row store hua (wa_id/text/type/message_id sahi)');
ok(typeof rows[0]?.payload === 'string' && rows[0].payload.includes('wamid.SELFTEST1'), 'POST: payload (raw message JSON) store hua');

const badPost = await fetch(`${base}/webhook/whatsapp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' }, body: raw,
});
ok(badPost.status === 401, 'POST: galat signature -> 401');
const noSigPost = await fetch(`${base}/webhook/whatsapp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
});
ok(noSigPost.status === 401, 'POST: signature header missing (secret set) -> 401');
const tampered = await fetch(`${base}/webhook/whatsapp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(raw) }, body: raw.replace('hi', 'HI!'),
});
ok(tampered.status === 401, 'POST: body tamper (purani signature) -> 401');
const { rows: after } = await pool.query('select count(*) as n from whatsapp_events');
ok(Number(after[0].n) === 1, 'POST: nakli/tampered posts se koi extra row NAHI bana');

server.close();
for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(TEST_DB + suf, { force: true }); } catch { /* ignore */ } }

console.log(`\n${passes} PASS / ${fails} FAIL`);
console.log(fails ? '❌ FAIL hain' : '✅ SAB PASS');
process.exit(fails ? 1 : 0);
