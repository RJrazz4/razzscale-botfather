// SMART MUSIC MEMORY — local test (SQLite mode, temp DB).
// Chalana: node scripts/test-music-memory.mjs
// Spec test cases 1-5 + 7 (backup/restore = platform/SQLite file copy, yahan nahi).
import fs from 'node:fs';

process.env.DB_MODE = 'sqlite';
process.env.SQLITE_PATH = '/tmp/music-memory-test.db';
try { fs.unlinkSync(process.env.SQLITE_PATH); } catch {}

const { recordPick, findRepeat, markSent, ensureMusicHistory, getRecent } = await import('../src/services/musicMemory.js');
const { pool } = await import('../src/db/pool.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const A = 'user-A', B = 'user-B';
await ensureMusicHistory();

// Case 1+3: naya gaana, phir alag spelling se wahi maango
await recordPick({ userId: A, waId: '91AAA', pick: { source: 'jiosaavn', id: 'S1', song: 'Zaroorat', title: 'Mustafa Zahid — Zaroorat', artist: 'Mustafa Zahid', durationSec: 260 }, query: 'Zaroorat Ek Villain' });
// NAIA NIYAM (2026-11-07 raat): sirf pick kiya, bheja NAHI gaya = repeat NAHI.
// (Yahowa wala jhootha "pehle bhi sun chuke ho" isi se band hua.)
let hit = await findRepeat(A, 'Zaroorat');
check('0. sirf selected (kabhi bheja nahi) = koi repeat hit nahi', hit === null);
await markSent(A, 'jiosaavn', 'S1');
hit = await findRepeat(A, 'Mujhe Teri Jarurat Hai');
check('1/3. spelling variant (Jarurat) par repeat hit', !!hit && hit.provider_id === 'S1');
hit = await findRepeat(A, 'Zaroorat Ek Villain');
check('1b. film-naam wali query par bhi hit (last_query mel)', !!hit && hit.provider_id === 'S1');
hit = await findRepeat(A, 'Zaroorat');
check('1c. seedha naam par hit', !!hit && hit.provider_id === 'S1');

// Case 2: wahi gaana dobara pick -> ek hi row, ginati 2
await recordPick({ userId: A, waId: '91AAA', pick: { source: 'jiosaavn', id: 'S1', song: 'Zaroorat', title: 'Mustafa Zahid — Zaroorat', artist: 'Mustafa Zahid', durationSec: 260 }, query: 'zaroorat' });
let rows = (await pool.query('select * from listening_history where user_id=$1 and provider_id=$2', [A, 'S1'])).rows;
check('2. dobara pick = ek row, request_count 2', rows.length === 1 && rows[0].request_count === 2);

// Status: selected -> sent (sunne ki pushti NAHI banti)
await markSent(A, 'jiosaavn', 'S1');
rows = (await pool.query('select status from listening_history where user_id=$1 and provider_id=$2', [A, 'S1'])).rows;
check('5b. markSent ke baad status sent', rows[0]?.status === 'sent');

// Case 4: ek hi title, do artist — artist wali query sahi row de
await recordPick({ userId: A, waId: '91AAA', pick: { source: 'jiosaavn', id: 'S2', song: 'Tum Hi Ho', title: 'Arijit Singh — Tum Hi Ho', artist: 'Arijit Singh' }, query: 'Tum Hi Ho' });
await recordPick({ userId: A, waId: '91AAA', pick: { source: 'yt', id: 'YT9', title: 'Tum Hi Ho — Atif Aslam', channel: 'Atif Aslam', url: 'https://www.youtube.com/watch?v=YT9' }, query: 'Tum Hi Ho Atif' });
await markSent(A, 'jiosaavn', 'S2');
await markSent(A, 'yt', 'YT9');
hit = await findRepeat(A, 'Tum Hi Ho Arijit Singh');
check('4a. artist wali query = Arijit wali row', !!hit && hit.provider_id === 'S2');
hit = await findRepeat(A, 'Tum Hi Ho Atif Aslam');
check('4b. artist wali query = Atif wali row', !!hit && hit.provider_id === 'YT9');

// Case 5d: title me lofi hai; bina mange lofi khud se nahi milega (spec §3)
const D = 'user-D';
await recordPick({ userId: D, waId: '91DDD', pick: { source: 'yt', id: 'YT7', title: 'Kesariya (Lofi) — Pritam', channel: 'Pritam', url: 'https://www.youtube.com/watch?v=YT7' }, query: 'Kesariya Lofi' });
await markSent(D, 'yt', 'YT7');
hit = await findRepeat(D, 'Kesariya');
check('5d. lofi history par saadi query = koi hit nahi', hit === null);
hit = await findRepeat(D, 'Kesariya Lofi');
check('5e. lofi query = lofi row hi mile', !!hit && hit.provider_id === 'YT7');

// Case 5: history me sirf remix hai; original ki query par auto-delivery NAHI
const C = 'user-C';
await recordPick({ userId: C, waId: '91CCC', pick: { source: 'yt', id: 'YT5', title: 'Chaiyya Chaiyya Remix — DJ Shadow', channel: 'DJ Shadow', url: 'https://www.youtube.com/watch?v=YT5' }, query: 'Chaiyya Chaiyya Remix' });
await markSent(C, 'yt', 'YT5');
hit = await findRepeat(C, 'Chaiyya Chaiyya');
check('5. remix history par original query = koi hit nahi', hit === null);
hit = await findRepeat(C, 'Chaiyya Chaiyya Remix');
check('5c. remix query = remix row hi mile', !!hit && hit.provider_id === 'YT5');

// Case 7: dusre user ki history kabhi nahi milti
hit = await findRepeat(B, 'Zaroorat');
check('7. dusra user = koi hit nahi (privacy)', hit === null);
hit = await findRepeat(B, 'Tum Hi Ho Arijit Singh');
check('7b. dusra user, artist ke saath bhi nahi', hit === null);

// Alag gaana: koi jhootha hit nahi
hit = await findRepeat(A, 'Kesariya Brahmastra');
check('9. bilkul alag gaana = koi hit nahi (aam search chalega)', hit === null);

// Recently Played: kram = sabse tazaa pehle; dusre user ki list khaali
let recent = await getRecent(A, 8);
check('10. Recently Played me A ke 3 gaane, tazaa (YT9) sabse upar', recent.length === 3 && recent[0].provider_id === 'YT9');
recent = await getRecent(B, 8);
check('10b. dusre user ki Recently Played khaali', recent.length === 0);

console.log(`\nNatija: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
