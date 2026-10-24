// FRONTEND BRIEF flows verification harness (local, koi asal network nahi —
// builders pure hain; DB hissa TEMP sqlite file par chalta hai (human-mode pause test),
// asal DB kabhi touch nahi hota).
// Chalao: node scripts/verify-frontend-flows.mjs  ->  sab PASS to exit 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Src modules import hone se PEHLE temp test DB select karo (env/pool import-time par padhte hain)
const TEST_DB = path.join(os.tmpdir(), `ff-harness-${process.pid}-${Date.now()}.db`);
process.env.DB_MODE = 'sqlite';
process.env.SQLITE_PATH = TEST_DB;
let fails = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) fails++; };

const mm = await import(path.join(ROOT, 'src/handlers/masterMenu.js'));
const cs = await import(path.join(ROOT, 'src/handlers/consult.js'));
const { env } = await import(path.join(ROOT, 'src/config/env.js'));
const { clampListTitle } = await import(path.join(ROOT, 'src/services/evolution.js'));

const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const masterSrc = src('src/handlers/masterMenu.js');
const consultSrc = src('src/handlers/consult.js');
const workerSrc = src('src/services/worker.js');
const allSrc = masterSrc + consultSrc + workerSrc;

// ---------- 1. Saari lists: ≤10 rows, titles ≤24 (raw + clamp ke baad), rowIds defined ----------
const lists = {
  home: mm.homeRows(),
  zone: mm.zoneRows(),
  svc: cs.svcRows(),
  plat: cs.platRows(),
  feat_empty: cs.featRows([]),
  feat_selected: cs.featRows([1, 5]),
  web: cs.webRows(),
  skip: cs.skipRows(),
  summary: cs.summaryRows(),
};
const emittedRowIds = new Set();
for (const [name, rows] of Object.entries(lists)) {
  ok(Array.isArray(rows) && rows.length > 0, `${name}: rows hain`);
  ok(rows.length <= 10, `${name}: ${rows.length} rows ≤ 10`);
  for (const r of rows) {
    ok(typeof r.rowId === 'string' && r.rowId.length > 0, `${name}: rowId defined (${r.rowId})`);
    ok(String(r.title).length <= 24, `${name}: title ≤24 chars — "${r.title}" (${String(r.title).length})`);
    ok(clampListTitle(r.title) === String(r.title), `${name}: title clamp par nahi badalta — "${r.title}"`);
    if (r.description) ok(String(r.description).length <= 72, `${name}: description ≤72 — (${String(r.description).length})`);
    emittedRowIds.add(r.rowId);
  }
}
// Code-literal rowIds jo builders ke bahar bante hain (music results / empty / spawn / post-audio)
for (const id of ['more', 'nav_back', 'nav_menu', 'cat_search', 'lyrics', 'music_new', 'menu', '1', '2', '3', '4']) emittedRowIds.add(id);

// ---------- 2. Har emitted rowId ke liye handler branch maujood ----------
const handlerChecks = [
  [/^nav_menu$/, /['"]nav_menu['"]/, 'global nav (masterMenu)'],
  [/^nav_back$/, /['"]nav_back['"]/, 'global nav (masterMenu)'],
  [/^menu$/, /['"]menu['"]/, 'menu keyword branch (masterMenu)'],
  [/^mz$/, /t === 'mz'/, 'home action mz'],
  [/^ai$/, /t === 'ai'/, 'home action ai'],
  [/^vip$/, /t === 'vip'/, 'consult entry vip'],
  [/^mk$/, /t === 'mk'/, 'home action mk'],
  [/^cat_(trending|bollywood|punjabi|phonk|devotional|discover)$/, null, 'CATEGORIES map (masterMenu)'],
  [/^cat_search$/, /t === 'cat_search'/, 'zone search branch'],
  [/^more$/, /'more'/, 'music_pick more branch'],
  [/^lyrics$/, /lower === 'lyrics'/, 'lyrics branch'],
  [/^music_new$/, /music_new/, 'TAP_MAP / branches'],
  [/^vip_svc_\d$/, /vip_svc_/, 'consult regex'],
  [/^soc_plat_\d$/, /soc_plat_/, 'consult regex'],
  [/^soc_feat_\d$/, /soc_feat_/, 'consult regex'],
  [/^soc_feat_done$/, /soc_feat_done/, 'consult done branch'],
  [/^web_type_\d$/, /web_type_/, 'consult regex'],
  [/^q_skip$/, /q_skip/, 'consult skip'],
  [/^cf_(confirm|edit|cancel)$/, /cf_/, 'consult confirm/edit/cancel'],
  [/^[1-4]$/, /BOT_TYPES|Number\(t\)/, 'number-based handlers (spawn/music pick)'],
];
for (const id of emittedRowIds) {
  const chk = handlerChecks.find(([re]) => re.test(id));
  if (!chk) { ok(false, `rowId '${id}': handler pattern map me hi nahi`); continue; }
  if (id.startsWith('cat_') && id !== 'cat_search') {
    ok(Boolean(mm.CATEGORIES[id]), `rowId '${id}': CATEGORIES me query defined`);
  } else {
    ok(chk[1] ? chk[1].test(allSrc) : false, `rowId '${id}': handler maujood — ${chk[2]}`);
  }
}

// ---------- 3. Categories: har key ka REAL preset query ----------
const wantCats = ['cat_trending', 'cat_bollywood', 'cat_punjabi', 'cat_phonk', 'cat_devotional', 'cat_discover'];
ok(JSON.stringify(Object.keys(mm.CATEGORIES).sort()) === JSON.stringify([...wantCats].sort()), 'CATEGORIES ki 6 keys brief wali hi hain');
for (const k of wantCats) ok(typeof mm.CATEGORIES[k].query === 'string' && mm.CATEGORIES[k].query.length > 3, `${k}: query defined — "${mm.CATEGORIES[k].query}"`);

// ---------- 4. Summary builder: khaali = har jagah "nahi diya", bhara = kahin nahi ----------
const empty = cs.buildSummary({});
for (const needle of ['*Service:* nahi diya', '*Business:* nahi diya', '*Requirement:* nahi diya']) {
  ok(empty.includes(needle), `empty summary: "${needle}" line hai`);
}
const socEmpty = cs.buildSummary({ service: cs.SVC_LABELS[4] });
ok(socEmpty.includes('Platform:') && socEmpty.includes('nahi diya'), 'social summary: platform missing = "nahi diya"');
const full = cs.buildSummary({
  service: cs.SVC_LABELS[4], platform: 'YouTube', features: [1, 3],
  business: 'Sharma Store', requirement: 'Roz ek video chahiye',
});
ok(!full.includes('nahi diya'), 'full summary: "nahi diya" kahin nahi');
ok(full.includes('AI content generation') && full.includes('Scheduling'), 'full summary: feature labels sahi bane');

// ---------- 5. Confirm = HUMAN MODE (2026-10-24): Lead ID + isi chat me insaan ----------
// Purana wa.me personal-number handoff GAYA — confirm par lead save + contact pause +
// customer ko human-mode message. Personal number kisi public text me NAHI.
const leadId = cs.newLeadId();
ok(/^RS-[0-9A-Z]+$/.test(leadId), `Lead ID format — ${leadId}`);
const cm = cs.buildConfirmedMessage(leadId, { service: 'Website / Online Business', business: 'A B Store', requirement: 'Site chahiye' });
ok(cm.includes(leadId), 'confirmed message me Lead ID hai');
ok(!/wa\.me/.test(cm), 'confirmed message me koi wa.me link NAHI (baat isi chat me hogi)');
ok(!cm.includes('917205191890') && !cm.includes('72051 91890'), 'confirmed message me personal number NAHI');
ok(/insaan/i.test(cm) && /peeche hat/i.test(cm), 'confirmed message: Boss (insaan) + bot peeche hat gaya — saaf likha hai');
ok(!/ownerWaNumber/.test(consultSrc), 'consult ab ownerWaNumber use NAHI karta');
ok(/pauseForHuman/.test(consultSrc) && /paused_contacts/.test(consultSrc), 'consult confirm par pauseForHuman (paused_contacts) lagta hai');
// Asal DB test (temp sqlite): pauseForHuman entry banata hai — human mode pakka
const { pool } = await import(path.join(ROOT, 'src/db/pool.js'));
await cs.pauseForHuman('919999999999@s.whatsapp.net', 'consult_handoff');
const { rows: pauseRows } = await pool.query('select jid, reason from paused_contacts where jid=$1', ['919999999999@s.whatsapp.net']);
ok(pauseRows.length === 1 && pauseRows[0].reason === 'consult_handoff', 'test DB: confirm ke baad paused_contacts me us jid ki entry hai');

// ---------- 6. Leads schema dono jagah ----------
ok(/create table if not exists leads/.test(src('src/db/sqlite.js')), 'sqlite SCHEMA me leads table hai');
ok(/create table if not exists leads/.test(src('db/schema.sql')), 'pg schema.sql me leads table hai');

// ---------- 7. Master Instruction wired hai ----------
const llmSrc = src('src/services/llm.js');
ok(/MASTER_INSTRUCTION/.test(llmSrc), 'llm.js MASTER_INSTRUCTION use karta hai');
const { MASTER_INSTRUCTION } = await import(path.join(ROOT, 'src/config/instruction.js'));
ok(MASTER_INSTRUCTION.includes('RazzScale') && MASTER_INSTRUCTION.includes('72051 91890'), 'instruction me brand + Boss number hai');
ok(/OTP/.test(MASTER_INSTRUCTION) && /vaada/i.test(MASTER_INSTRUCTION), 'instruction me forbidden list (OTP/vaada) hai');
ok(!/Tum RazzScale AI ke friendly assistant ho/.test(llmSrc), 'purana 1-line generic prompt gaya');

// ---------- 8. Worker: fail par YouTube link + busy-state transitions ----------
ok(/sendMusicFailure/.test(workerSrc) && /youtube\.com\/watch\?v=/.test(workerSrc), 'worker failure par YouTube link bhejta hai');
ok(/moveBusyState/.test(workerSrc) && /music_done/.test(workerSrc) && /music_zone/.test(workerSrc), 'worker busy state ko done/zone par le jata hai');
ok(/music_busy/.test(masterSrc), 'masterMenu me double-pick guard (music_busy) hai');

// ---------- 9. LIVE PRESENCE (2026-10-24): helper + worker/masterMenu wiring ----------
const evoSrc = src('src/services/evolution.js');
ok(/export async function sendPresence/.test(evoSrc) && /\/chat\/sendPresence\//.test(evoSrc), 'evolution.js: sendPresence helper + Evolution endpoint hai');
ok(/'composing'/.test(workerSrc) && /'recording'/.test(workerSrc) && /'paused'/.test(workerSrc), 'worker: music/ai jobs par composing + recording + paused presence hai');
ok(/sendPresence\(inst, from, 'composing'/.test(masterSrc), 'masterMenu: search enqueue par quick composing');
ok(/sendPresence\(inst, from, 'recording'/.test(masterSrc), 'masterMenu: gaana pick par recording');

// ---------- 10. NUMBER PRIVACY: public surfaces par personal number NAHI ----------
const brandingSrc = src('src/middleware/branding.js');
const vipSrc = src('src/handlers/vip.js');
ok(!/917205191890/.test(brandingSrc) && !/72051 91890/.test(brandingSrc), 'branding footer me personal number NAHI');
ok(/masterWaLink/.test(brandingSrc), 'branding footer masterWaLink (master bot) use karta hai');
ok(!/917205191890/.test(vipSrc) && !/72051 91890/.test(vipSrc), 'vip.js pitch/link me personal number NAHI');
ok(/masterWaLink/.test(vipSrc), 'vip.js ka link masterWaLink par hai');
ok(!/72051 91890/.test(masterSrc), 'masterMenu MENU_TEXT me personal number NAHI');
ok(env.masterWaLink.includes('918249388815'), 'env.masterWaLink master bot number (…88815) par hai');
// ⚠️ FLAG (jaanboojh kar barkarar — Hero decide karega, khud se NAHI badla):
// Master Instruction (AI chat ki rooh) ke andar Boss wali line ab bhi personal number par hai.
ok(MASTER_INSTRUCTION.includes('72051 91890'), 'FLAG barkarar: instruction ke andar Boss line me personal number hai (Hero ka faisla pending)');

// ---------- 11. FAST MUSIC v2 (2026-10-24): seedha JioSaavn source ----------
const js = await import(path.join(ROOT, 'src/services/jiosaavn.js'));
// Decryption test vector — probe 2026-10-24 ka ASAL gaana (Tum Hi Ho, aRZbUYD7):
// encrypted_media_url -> yahi CDN URL banna chahiye (quality suffix ke bina base hisaa)
const TV_ENC = 'ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDyRofh8YQPTqjR2tIxTYXqGEQHgqnNfsetouo4rsD0s4RZKObWAyHrEhw7tS9a8Gtq';
const tvUrl = js.decryptMediaUrl(TV_ENC);
ok(tvUrl === 'https://aac.saavncdn.com/430/5c5ea5cc00e3bff45616013226f376fe_96.mp4', 'jiosaavn decrypt: test vector se asal CDN URL banta hai');
ok(js.decryptMediaUrl('garbage!!!') === null && js.decryptMediaUrl('') === null, 'jiosaavn decrypt: kharab input par null (guess nahi)');
ok(js.withQuality(tvUrl, 320).endsWith('_320.mp4') && js.withQuality(tvUrl, 160).endsWith('_160.mp4'), 'jiosaavn quality swap: _320/_160 suffix sahi banta hai');
ok(js.preferredUrl(tvUrl, { '320kbps': 'true' }).endsWith('_320.mp4'), 'jiosaavn preferredUrl: 320kbps flag par 320');
ok(js.preferredUrl(tvUrl, { '320kbps': 'false' }).endsWith('_160.mp4'), 'jiosaavn preferredUrl: flag na ho to 160');
// Cache faisle (pure): URL 45 min ke andar 'use', purana ho to 'refresh'; metadata 24h
const NOW = Date.parse('2026-10-24T10:00:00.000Z');
const freshRow = { download_url: 'https://x/_160.mp4', url_fetched_at: new Date(NOW - 10 * 60_000).toISOString(), updated_at: new Date(NOW - 3600_000).toISOString() };
const staleUrlRow = { ...freshRow, url_fetched_at: new Date(NOW - 50 * 60_000).toISOString() };
const staleMetaRow = { ...freshRow, updated_at: new Date(NOW - 25 * 3600_000).toISOString() };
ok(js.decideUrlAction(freshRow, NOW) === 'use', 'saavn cache: 10 min purana URL = use');
ok(js.decideUrlAction(staleUrlRow, NOW) === 'refresh', 'saavn cache: 50 min purana URL = refresh (time-limited URL wali samajhdari)');
ok(js.decideUrlAction(null, NOW) === 'refresh' && js.decideUrlAction({}, NOW) === 'refresh', 'saavn cache: row/URL na ho to refresh');
ok(js.isMetaFresh(freshRow, NOW) === true && js.isMetaFresh(staleMetaRow, NOW) === false, 'saavn cache: metadata TTL 24h sahi');
// mapSong shape — masterMenu UI (title/duration) + lyrics parser (Artist — Song) dono ke hisaab se
const mapped = js.mapSong({ id: 'abc123', song: 'Tum Hi Ho', singers: 'Arijit Singh', duration: '262', image: 'https://c.saavncdn.com/x/150x150.jpg', perma_url: 'https://www.jiosaavn.com/song/x' });
ok(mapped.source === 'jiosaavn' && mapped.id === 'abc123' && mapped.duration === 262 && mapped.durationSec === 262, 'mapSong: source/id/duration sahi');
ok(mapped.title === 'Arijit Singh — Tum Hi Ho' && mapped.image.includes('500x500'), 'mapSong: title Artist — Song + image 500x500');
// Source routing (source-pattern checks)
ok(/searchSongsSaavn\(query, 8\)/.test(masterSrc) && /searchSongs\(query, 8\)/.test(masterSrc), 'masterMenu: pehle saavn search, fallback YT search — dono wired');
ok(/source: pick\.source/.test(masterSrc) && /songId:/.test(masterSrc), 'masterMenu: pick payload me source + songId jata hai');
ok(/deliverSaavnTrack/.test(workerSrc) && /p\.source === 'jiosaavn'/.test(workerSrc), 'worker: jiosaavn picks par saavn delivery chain');
ok(/saavn:/.test(workerSrc) && /getFreshUrl/.test(workerSrc), 'worker: vault key saavn:<id> + getFreshUrl use hota hai');
ok(/create table if not exists saavn_cache/.test(src('src/db/sqlite.js')), 'sqlite schema me saavn_cache table hai');
ok(/create table if not exists saavn_cache/.test(src('db/schema.sql')), 'pg schema.sql me saavn_cache table hai');
ok(/startTrendingPrecache/.test(src('src/server.js')), 'server.js boot par trending pre-cache hook hai');

// temp test DB saaf karo
for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(TEST_DB + suf, { force: true }); } catch { /* ignore */ } }

console.log(fails ? `\n❌ ${fails} FAIL` : '\n✅ SAB PASS');
process.exit(fails ? 1 : 0);
