// PREFETCH + DEAD-NISHAAN + KATAAR PRIORITY — local test (2026-11-07).
// Hero ka logic: list bante hi peeche se download; jo video baar-baar fail
// ho woh list se gayab; user ka pick kataar me hamesha pehle.
// Chalana: node scripts/test-prefetch.mjs
import fs from 'node:fs';

process.env.DB_MODE = 'sqlite';
process.env.SQLITE_PATH = '/tmp/prefetch-test.db';
try { fs.unlinkSync(process.env.SQLITE_PATH); } catch {}

const { prefetchTargets } = await import('../src/services/musicSearch.js');
const { noteDownloadFailure, deadVideoIds } = await import('../src/services/music.js');
const { enqueueJob, claimNext } = await import('../src/services/worker.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// prefetchTargets: sirf YT, page ke kram me, zyada se zyada 3, lambe bahar
const results = [
  { source: 'jiosaavn', id: 'S1', title: 'Saavn Gaana', duration: 240 },
  { source: 'yt', id: 'Y1', title: 'YT Pehla', duration: 200 },
  { source: 'yt', id: 'Y2', title: 'YT Lamha Mix', duration: 3600 },
  { source: 'yt', id: 'Y3', title: 'YT Dusra', duration: 180 },
  { source: 'yt', id: 'Y4', title: 'YT Teesra', duration: 190 },
  { source: 'yt', id: 'Y5', title: 'YT Chautha', duration: 190 },
];
const tg = prefetchTargets(results);
check('targets: 3 YT gaane (Saavn aur 1-ghante wala bahar)', tg.length === 3);
check('targets: kram wahi (Y1, Y3, Y4)', tg.map((x) => x.videoId).join(',') === 'Y1,Y3,Y4');

// Dead nishan: 1 fail = zinda, 2 fail = dead
await noteDownloadFailure('DEAD1');
check('1 fail ke baad dead nahi', !(await deadVideoIds(['DEAD1'])).has('DEAD1'));
await noteDownloadFailure('DEAD1');
check('2 fail ke baad dead hai', (await deadVideoIds(['DEAD1'])).has('DEAD1'));
check('dusra video saaf hai', !(await deadVideoIds(['SAF1'])).has('SAF1'));

// Kataar priority: prefetch pehle kataar me pada ho, phir bhi user ka pick pehle uthega
await enqueueJob('music_prefetch', { videoId: 'PX1', title: 'peeche wala' }, 'prefetch:PX1');
await enqueueJob('music_download', { videoId: 'UX1', title: 'user wala', source: 'yt' }, 'music:test:UX1');
const first = await claimNext();
check('priority: pehla claim user ka pick', first?.type === 'music_download');
const second = await claimNext();
check('priority: dusra claim prefetch', second?.type === 'music_prefetch');


// HAMESHA ka murda-nishan (2026-11-08): fails=99 purana hone par bhi murda
const { noteDeadPermanent } = await import('../src/services/music.js');
await noteDeadPermanent('DEADP');
const { pool: _pool } = await import('../src/db/pool.js');
await _pool.query("update music_dead set updated_at='2020-01-01T00:00:00.000Z' where video_id='DEADP'");
const deadP = await deadVideoIds(['DEADP']);
check('8. hamesha wala nishan 6-ghante muddat ke baad bhi murda', deadP.has('DEADP'));

console.log(`\nNatija: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
