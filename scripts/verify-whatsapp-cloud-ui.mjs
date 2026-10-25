// WhatsApp Cloud UI (Hybrid Phase-2) verification harness — LOCAL, koi asal network
// nahi: global fetch MOCK hai (Graph API + JioSaavn + lyrics.ovh teeno ke canned
// jawab), DB TEMP sqlite file par. Asal DB/token kabhi touch nahi hota.
// Kya-kya pakka hota hai:
//  1) graph-cloud builders: payload shapes + hard limits (rows ≤10, title ≤24,
//     desc ≤72, button title ≤20, max 3 buttons, body ≤1024)
//  2) inbound normalizer: text / list_reply / button_reply / statuses-ignore
//  3) End-to-end (asal router + asal worker, mocked bahari duniya):
//     'hi' -> HOME LIST (mz/ai/vip/mk + footer) -> category tap -> results LIST ->
//     gaana tap -> audio LINK send + post-song BUTTONS -> lyrics tap -> lyrics text
//     VIP: svc -> web type -> Q1/Q2 -> summary -> confirm (Lead ID + human pause)
//     AI chat: entry -> sawal -> job se jawab text
//     Duplicate message id -> doosri baar koi send NAHI; paused contact -> chup.
// Chalao: node scripts/verify-whatsapp-cloud-ui.mjs  ->  sab PASS to exit 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Src modules import hone se PEHLE test env (env/pool import-time par padhte hain)
const TEST_DB = path.join(os.tmpdir(), `wa-ui-${process.pid}-${Date.now()}.db`);
process.env.DB_MODE = 'sqlite';
process.env.SQLITE_PATH = TEST_DB;
process.env.WHATSAPP_CLOUD_TOKEN = 'test-token-ui';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1469812529540875';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'verify-ui';
process.env.WHATSAPP_APP_SECRET = '';
process.env.OPENROUTER_API_KEY = ''; // AI chat ka no-key deterministic jawab chahiye

let fails = 0, passes = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); cond ? passes++ : fails++; };

// ---------- Mock fetch: Graph / JioSaavn / lyrics.ovh / HEAD ----------
const graphCalls = []; // saare Graph POST payloads, kram se
// Frontend harness wala ASAL test vector (Tum Hi Ho) — decrypt offline chalta hai
const TV_ENC = 'ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDyRofh8YQPTqjR2tIxTYXqGEQHgqnNfsetouo4rsD0s4RZKObWAyHrEhw7tS9a8Gtq';
const TV_SONG = {
  id: 'aRZbUYD7', song: 'Tum Hi Ho', singers: 'Arijit Singh', duration: '262',
  image: 'https://c.saavncdn.com/430/x-150x150.jpg', perma_url: 'https://www.jiosaavn.com/song/tum-hi-ho/x',
  '320kbps': 'true', encrypted_media_url: TV_ENC,
};
const SONG2 = {
  id: 'kEs2bXYZ', song: 'Kesariya', singers: 'Pritam', duration: '268',
  image: 'https://c.saavncdn.com/431/y-150x150.jpg', perma_url: 'https://www.jiosaavn.com/song/kesariya/y',
  '320kbps': 'false', encrypted_media_url: TV_ENC,
};
const jsonRes = (obj, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => obj, text: async () => JSON.stringify(obj),
  headers: { get: () => null },
});
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('graph.facebook.com')) {
    graphCalls.push(JSON.parse(opts.body));
    return jsonRes({ messages: [{ id: 'wamid.outbound' }] });
  }
  if (opts.method === 'HEAD') { // CDN size probe — chhoti file (3MB < 16MB cap)
    return { ok: true, status: 200, headers: { get: (h) => (h === 'content-length' ? '3000000' : null) }, text: async () => '' };
  }
  if (u.includes('jiosaavn.com')) {
    if (u.includes('search.getResults')) return jsonRes({ results: [TV_SONG, SONG2] });
    if (u.includes('song.getDetails')) return jsonRes({ [TV_SONG.id]: TV_SONG, [SONG2.id]: SONG2 });
    return jsonRes({});
  }
  if (u.includes('api.lyrics.ovh')) return jsonRes({ lyrics: 'Tum hi ho, ab tum hi ho\nZindagi ab tum hi ho' });
  throw new Error(`mock fetch: unexpected URL ${u.slice(0, 80)}`);
};

const graph = await import(path.join(ROOT, 'src/services/graph-cloud.js'));
const wc = await import(path.join(ROOT, 'src/services/whatsapp-cloud.js'));
const { pool, getFlow } = await import(path.join(ROOT, 'src/db/pool.js'));
const { startWorker } = await import(path.join(ROOT, 'src/services/worker.js'));

// ---------- 1. Builders: shapes + clamps ----------
const bigList = graph.buildListPayload('91999', {
  header: 'H', body: 'B'.repeat(2000), footer: 'F', buttonText: 'X'.repeat(30),
  sections: [
    { title: 'S1', rows: Array.from({ length: 7 }, (_, i) => ({ rowId: `r${i}`, title: 'T'.repeat(30), description: 'D'.repeat(100) })) },
    { title: 'S2', rows: Array.from({ length: 6 }, (_, i) => ({ rowId: `s${i}`, title: 'Song' })) },
  ],
});
const allRows = bigList.interactive.action.sections.flatMap((s) => s.rows);
ok(bigList.type === 'interactive' && bigList.interactive.type === 'list' && bigList.messaging_product === 'whatsapp', 'list payload: shape (interactive/list)');
ok(allRows.length === 10, `list payload: kul rows 13 -> cap 10 (mila ${allRows.length})`);
ok(allRows.every((r) => r.title.length <= 24), 'list payload: har row title ≤24 (30-char clamp)');
ok(allRows.every((r) => !r.description || r.description.length <= 72), 'list payload: har row description ≤72 (100-char clamp)');
ok(bigList.interactive.body.text.length === 1024, 'list payload: body 2000 -> clamp 1024');
ok(bigList.interactive.action.button.length === 20, 'list payload: buttonText clamp 20');
ok(allRows[0].id === 'r0', 'list payload: rowId -> id mapping sahi');
ok(graph.buildListPayload('91999', { body: 'x', sections: [] }) === null, 'list payload: rows na hon to null (caller fallback chalega)');

const btns = graph.buildButtonsPayload('91999', {
  body: 'Pick', buttons: [
    { id: 'a', title: 'A'.repeat(30) }, { id: 'b', title: 'Do' },
    { id: 'c', title: 'Teen' }, { id: 'd', title: 'Chaar (zyada)' }, { id: 'e', title: 'Paanch' },
  ],
});
ok(btns.interactive.type === 'button' && btns.interactive.action.buttons.length === 3, 'buttons payload: 5 -> max 3 buttons');
ok(btns.interactive.action.buttons.every((b) => b.type === 'reply' && b.reply.title.length <= 20), 'buttons payload: reply shape + title ≤20 clamp');
ok(btns.interactive.action.buttons.map((b) => b.reply.id).join(',') === 'a,b,c', 'buttons payload: pehle 3 hi, order barkarar');
ok(graph.buildButtonsPayload('91999', { body: 'x', buttons: [] }) === null, 'buttons payload: khaali par null');

const tp = graph.buildTextPayload('91999', 'L'.repeat(2000));
ok(tp.type === 'text' && tp.text.body.length === 2000, 'text payload: 2000-char body kata NAHI (limit 4096 — lyrics ke liye)');
const ap = graph.buildAudioLinkPayload('91999', 'https://aac.saavncdn.com/x_320.mp4');
ok(ap.type === 'audio' && ap.audio.link.includes('_320.mp4'), 'audio payload: type audio + link');
const rp = graph.buildReadPayload('wamid.1', true);
ok(rp.status === 'read' && rp.typing_indicator?.type === 'text', 'read payload: status read + typing indicator');
ok(graph.graphConfigured() === true, 'graphConfigured: test token/ID set -> true');

// ---------- 2. Normalizer ----------
const payloadText = (from, id, body) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1435508757935515', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: '1469812529540875' },
    contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
    messages: [{ from, id, timestamp: '1729833600', type: 'text', text: { body } }],
  } }] }],
});
const payloadReply = (from, id, kind, selId) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1435508757935515', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: '1469812529540875' },
    contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
    messages: [{ from, id, timestamp: '1729833600', type: 'interactive',
      interactive: { type: kind, [kind]: { id: selId, title: 'tap' } } }],
  } }] }],
});
const nText = wc.normalizeCloudEvents(payloadText('919111111111', 'wamid.N1', 'hi'));
ok(nText.length === 1 && nText[0].kind === 'text' && nText[0].text === 'hi' && nText[0].channel === 'cloud'
  && nText[0].pushName === 'Test User', 'normalizer: text message -> kind text + pushName');
const nList = wc.normalizeCloudEvents(payloadReply('919111111111', 'wamid.N2', 'list_reply', 'mz'));
ok(nList[0].kind === 'selection' && nList[0].text === 'mz', 'normalizer: list_reply -> selection, text = row id');
const nBtn = wc.normalizeCloudEvents(payloadReply('919111111111', 'wamid.N3', 'button_reply', 'lyrics'));
ok(nBtn[0].kind === 'selection' && nBtn[0].text === 'lyrics', 'normalizer: button_reply -> selection, text = button id');
const nStatus = wc.normalizeCloudEvents({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.X', status: 'read' }] } }] }] });
ok(nStatus.length === 0, 'normalizer: statuses-only payload -> 0 events');

// ---------- 3. End-to-end (asal router + worker, mocked bahari duniya) ----------
startWorker();
const sendsTo = (num) => graphCalls.filter((c) => c.to === num);
const listsTo = (num) => sendsTo(num).filter((c) => c.type === 'interactive' && c.interactive?.type === 'list');
const listRowIds = (call) => (call?.interactive?.action?.sections || []).flatMap((s) => s.rows.map((r) => r.id));
async function userIdOf(num) {
  const { rows } = await pool.query('select id from users where wa_id=$1', [num]);
  return rows[0]?.id;
}
async function waitJob(type, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { rows } = await pool.query('select * from jobs where type=$1 order by id desc limit 1', [type]);
    if (rows[0] && (rows[0].status === 'done' || rows[0].status === 'failed')) return rows[0];
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

// --- User A: music ka poora safar ---
const A = '919111111111';
await wc.processWhatsAppPayload(payloadText(A, 'wamid.A1', 'hi'));
const homeList = listsTo(A)[0];
ok(Boolean(homeList), "A 'hi': HOME LIST gaya (fixed text NAHI)");
ok(JSON.stringify(listRowIds(homeList)) === JSON.stringify(['mz', 'ai', 'vip', 'mk']), "A 'hi': home rows order mz/ai/vip/mk (frontend home jaisa)");
ok(homeList.interactive.footer?.text?.includes('Powered by RazzScale AI'), "A 'hi': menu par footer hai (footer rule)");
ok(graphCalls.some((c) => c.status === 'read' && c.message_id === 'wamid.A1'), "A 'hi': markRead (blue tick) gaya");
const { rows: evRows } = await pool.query('select * from whatsapp_events where message_id=$1', ['wamid.A1']);
ok(evRows.length === 1 && evRows[0].wa_id === A && evRows[0].body_text === 'hi', "A 'hi': whatsapp_events me store hua");

const beforeDup = graphCalls.length;
await wc.processWhatsAppPayload(payloadText(A, 'wamid.A1', 'hi')); // Meta retry jaisa duplicate
ok(graphCalls.length === beforeDup, 'A duplicate: wahi message id doosri baar -> koi send NAHI (dedupe)');

await wc.processWhatsAppPayload(payloadReply(A, 'wamid.A2', 'list_reply', 'mz'));
const zoneList = listsTo(A).at(-1);
ok(listRowIds(zoneList).includes('cat_trending') && listRowIds(zoneList).includes('cat_search'), "A 'mz': Music Zone list (categories + search)");

await wc.processWhatsAppPayload(payloadReply(A, 'wamid.A3', 'list_reply', 'cat_trending'));
ok(sendsTo(A).some((c) => c.type === 'text' && c.text.body.includes('dhoondh raha hoon')), 'A category: search ack text gaya');
const resList = listsTo(A).at(-1);
ok(listRowIds(resList)[0] === '1' && listRowIds(resList).includes('nav_back') && listRowIds(resList).includes('nav_menu'),
  'A category: results LIST (rows 1.. + back/menu)');
ok(resList.interactive.action.sections[0].rows[0].title.length <= 24, 'A category: result row title ≤24 (lamba gaana naam clamp)');
const aFlow1 = await getFlow(await userIdOf(A), 'master');
ok(aFlow1?.step === 'music_pick' && aFlow1.results?.length === 2, 'A category: flow music_pick + 2 results');

await wc.processWhatsAppPayload(payloadReply(A, 'wamid.A4', 'list_reply', '1'));
const musicJob = await waitJob('music_download');
ok(musicJob?.status === 'done', `A pick: music_download job done (status=${musicJob?.status})`);
const audioCall = sendsTo(A).find((c) => c.type === 'audio');
ok(Boolean(audioCall) && audioCall.audio.link.includes('aac.saavncdn.com') && /_(320|160)\.mp4/.test(audioCall.audio.link),
  'A pick: gaana AUDIO LINK se gaya (fresh decrypted CDN URL)');
const btnCall = sendsTo(A).filter((c) => c.type === 'interactive' && c.interactive?.type === 'button').at(-1);
ok(Boolean(btnCall) && JSON.stringify(btnCall.interactive.action.buttons.map((b) => b.reply.id)) === JSON.stringify(['lyrics', 'music_new', 'menu']),
  'A pick: audio ke baad BUTTONS (Lyrics / Naya gaana / Menu)');
const aFlow2 = await getFlow(await userIdOf(A), 'master');
ok(aFlow2?.step === 'music_done' && /Tum Hi Ho/.test(aFlow2.lastTitle || ''), 'A pick: flow music_done + lastTitle yaad');

await wc.processWhatsAppPayload(payloadReply(A, 'wamid.A5', 'button_reply', 'lyrics'));
const lyrJob = await waitJob('lyrics');
ok(lyrJob?.status === 'done', 'A lyrics: lyrics job done');
ok(sendsTo(A).some((c) => c.type === 'text' && c.text.body.includes('Tum hi ho, ab tum hi ho')), 'A lyrics: lyrics text user tak gaya');

// --- User B: VIP consultation (list -> summary -> confirm -> human pause) ---
const B = '919222222222';
await wc.processWhatsAppPayload(payloadText(B, 'wamid.B1', 'hi'));
await wc.processWhatsAppPayload(payloadReply(B, 'wamid.B2', 'list_reply', 'vip'));
ok(listRowIds(listsTo(B).at(-1)).includes('vip_svc_1'), 'B vip: service LIST khuli');
await wc.processWhatsAppPayload(payloadReply(B, 'wamid.B3', 'list_reply', 'vip_svc_3'));
ok(listRowIds(listsTo(B).at(-1)).includes('web_type_1'), 'B svc=Website: website-type LIST khuli');
await wc.processWhatsAppPayload(payloadReply(B, 'wamid.B4', 'list_reply', 'web_type_1'));
await wc.processWhatsAppPayload(payloadText(B, 'wamid.B5', 'Sharma Store'));
await wc.processWhatsAppPayload(payloadText(B, 'wamid.B6', 'Bakery ke liye website chahiye'));
const sumText = sendsTo(B).filter((c) => c.type === 'text').at(-1);
ok(sumText?.text.body.includes('Sharma Store') && sumText?.text.body.includes('Business Website'), 'B summary: jawabon ke saath summary text');
ok(listRowIds(listsTo(B).at(-1)).includes('cf_confirm'), 'B summary: confirm/edit/cancel LIST');
await wc.processWhatsAppPayload(payloadReply(B, 'wamid.B7', 'list_reply', 'cf_confirm'));
const confText = sendsTo(B).filter((c) => c.type === 'text').at(-1);
ok(/Lead ID: RS-[0-9A-Z]+/.test(confText?.text.body || ''), 'B confirm: Lead ID wala message gaya');
ok(!/wa\.me|72051\s?91890/.test(confText?.text.body || ''), 'B confirm: koi link/personal number NAHI (privacy rule)');
const { rows: pauseRows } = await pool.query('select jid from paused_contacts where jid=$1', [B]);
ok(pauseRows.length === 1, 'B confirm: human-mode pause lag gaya (paused_contacts)');
const beforePauseSend = sendsTo(B).length;
await wc.processWhatsAppPayload(payloadText(B, 'wamid.B8', 'hello, koi hai?'));
ok(sendsTo(B).length === beforePauseSend, 'B paused: human mode me bot CHUP (koi send nahi)');

// --- User C: AI chat continuous ---
const C = '919333333333';
await wc.processWhatsAppPayload(payloadText(C, 'wamid.C1', 'hi'));
await wc.processWhatsAppPayload(payloadReply(C, 'wamid.C2', 'list_reply', 'ai'));
ok(sendsTo(C).some((c) => c.type === 'text' && c.text.body.includes('AI Chat shuru')), 'C ai: AI chat intro text gaya');
await wc.processWhatsAppPayload(payloadText(C, 'wamid.C3', 'tum kaun ho'));
const aiJob = await waitJob('ai_chat');
ok(aiJob?.status === 'done', 'C ai: ai_chat job done');
ok(sendsTo(C).some((c) => c.type === 'text' && c.text.body.includes('AI abhi set nahi')), 'C ai: LLM jawab (no-key fallback text) user tak gaya');

// temp test DB saaf karo
for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(TEST_DB + suf, { force: true }); } catch { /* ignore */ } }

console.log(`\n${passes} PASS / ${fails} FAIL`);
console.log(fails ? '❌ FAIL hain' : '✅ SAB PASS');
process.exit(fails ? 1 : 0);
