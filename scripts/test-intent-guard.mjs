// INTENT GUARD tests (2026-11-11, SELF-AUDIT FIX 1): classifyFreeText ke
// faisle — audit §1.3 ke saare "hijacked" examples ab music NAHI bante,
// aur asal gaano ke naam ab bhi music raste par jate hain. Pure function
// hai — koi network/LLM nahi. DB chhune se bachne ke liye import se pehle
// TEMP sqlite select kiya hai (verify-frontend-flows wala hi tareeka).
// Chalao: node scripts/test-intent-guard.mjs  ->  sab pass to exit 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DB = path.join(os.tmpdir(), `ig-harness-${process.pid}-${Date.now()}.db`);
process.env.DB_MODE = 'sqlite';
process.env.SQLITE_PATH = TEST_DB;

let pass = 0, fail = 0;
const ok = (cond, label) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (cond) pass++; else fail++; };

const { classifyFreeText } = await import(path.join(ROOT, 'src/handlers/masterMenu.js'));
const C = (text) => classifyFreeText(text, text.toLowerCase());
const NOT_MUSIC = (cls) => cls !== 'song' && cls !== 'music';

// ---------- §1.3 ke hijacked examples — ab music NAHI ----------
ok(C('kyun nahi chal raha') === 'question', "'kyun nahi chal raha' → question (kyun spelling pakdi gayi)");
ok(C('kaisi ho') === 'question', "'kaisi ho' → question (kaisi feminine form)");
ok(C('fees kitni hai') === 'question', "'fees kitni hai' → question (kitni form)");
ok(C('tum kaun ho') === 'question', "'tum kaun ho' → question (kaun list me hai)");
ok(C('bot chahiye mujhe') === 'service', "'bot chahiye mujhe' → service (bot akela hi pakka service hai)");
ok(C('app banana hai') === 'service', "'app banana hai' → service");
ok(C('how much for a bot') === 'question', "'how much for a bot' → question (design §4.2 kram: sawal pehle; jawab-line VIP/Boss ka rasta dikhati hai — music NAHI)");
ok(C('i want a bot') === 'service', "'i want a bot' → service");
ok(C('what is this') === 'question', "'what is this' → question (English sawal-shabd)");
ok(C('thank you') === 'smalltalk', "'thank you' → smalltalk");
ok(C('ok') === 'smalltalk', "'ok' → smalltalk");
ok(C('good morning') === 'smalltalk', "'good morning' → smalltalk");
ok(C('call me') === 'smalltalk', "'call me' → smalltalk");
ok(NOT_MUSIC(C('website banegi kya')), "'website banegi kya' → music NAHI");
ok(C('kal se bot band hai') === 'service', "'kal se bot band hai' → service (escalation wali baat music nahi khegi)");
ok(C('mujhe ek website banana hai') === 'service', "'mujhe ek website banana hai' → service");
ok(C('poster chahiye') === 'service', "'poster chahiye' → service (chahiye + noun clause)");
ok(C('mera order kab aayega') === 'question', "'mera order kab aayega' → question (kab pehle parkha jata hai)");

// ---------- Asal gaano ke naam — music raste par HI rahenge ----------
ok(C('Zaroorat') === 'song', "'Zaroorat' → song");
ok(C('tum hi ho') === 'song', "'tum hi ho' → song (3 shabd, vakya-hadd se neeche)");
ok(C('Tum Hi Ho') === 'song', "'Tum Hi Ho' (capital) → song");
ok(C('kesariya') === 'song', "'kesariya' → song");
ok(C('Arijit Singh songs') === 'music', "'Arijit Singh songs' → music (music noun)");
ok(C('Dilnashi dilnashi songs') === 'music', "'Dilnashi dilnashi songs' → music");
ok(C('old hindi songs') === 'music', "'old hindi songs' → music");
ok(C('mujhe music sunna hai') === 'music', "'mujhe music sunna hai' → music");
ok(C('gaana sunao') === 'music', "'gaana sunao' → music");
ok(C('ek gaana lagao') === 'music', "'ek gaana lagao' → music");

// ---------- Vakya / documented edge ----------
// NOTE (design §4.2 rule 4 vs §4.4 ka takraav): 'Mujhe Teri Jaroorat Hai'
// 4 shabd + vakya-nishan (mujhe/hai) hai — bandhe hue niyam ke hisaab se
// ye VAKYA hai, gaane ka naam nahi. User ko home menu milega (jahan se
// 'Zaroorat' ek shabd me likhna ya Music Zone tap karna ek kadam hai).
// §4.4 use music example kehta hai — ye takraav FIX report me darj hai.
ok(C('Mujhe Teri Jaroorat Hai') === 'sentence', "'Mujhe Teri Jaroorat Hai' → sentence (rule 4 — documented, §4.4 takraav report me)");
ok(C('mera phone kharab ho gaya hai') === 'sentence', "'mera phone kharab ho gaya hai' → sentence");
ok(C('theek hai') === 'smalltalk', "'theek hai' → smalltalk");

for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(TEST_DB + suf, { force: true }); } catch { /* ignore */ } }
console.log(`\nNatija: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
