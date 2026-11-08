// SONG LENGTH CAP — local test (2026-11-07).
// Jad: Phonk category me 1-ghante wale mix list me aa rahe the — woh na
// download hote hain, na WhatsApp (16MB) par bheje ja sakte hain.
// Chalana: node scripts/test-song-length.mjs
process.env.DB_MODE = 'sqlite';
process.env.SQLITE_PATH = '/tmp/song-length-test.db';

const { isSongLength } = await import('../src/services/musicSearch.js');
const { MAX_SONG_SEC } = await import('../src/services/jiosaavn.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

check('cap = 600s (10 minute)', MAX_SONG_SEC === 600);
check('61:20 wala phonk mix (3680s) BAND', isSongLength({ duration: 3680 }) === false);
check('61:17 night drive mix BAND', isSongLength({ duration: 3677 }) === false);
check('aam gaana 3:45 (225s) chalega', isSongLength({ duration: 225 }) === true);
check('saavn track 700s BAND (durationSec)', isSongLength({ durationSec: 700 }) === false);
check('saavn track 599s chalega', isSongLength({ durationSec: 599 }) === true);
check('theek 600s chalega (boundary)', isSongLength({ duration: 600 }) === true);
check('601s BAND (boundary)', isSongLength({ duration: 601 }) === false);
check('duration na pata ho to roko mat', isSongLength({}) === true && isSongLength({ duration: null }) === true);


// SACCHAI GATE (2026-11-08): list ki lambai vs asal file ki lambai
const { isDurationLie, probeDurationSec } = await import('../src/services/music.js');
check('7:17 likha, andar 4:06 = JHOOTH pakda', isDurationLie(437, 246) === true);
check('4:50 likha, asal 4:45 = theek', isDurationLie(290, 285) === false);
check('lambai pata hi nahi (0) = jhooth nahi', isDurationLie(0, 246) === false);
check('asal naap na lagi (null) = jhooth nahi', isDurationLie(437, null) === false);
// asal file par naap: 3s ki test file banao aur parkho
import { execFile as _ef } from 'node:child_process';
import { promisify as _pr } from 'node:util';
const _run = _pr(_ef);
const { default: ffmpegStatic } = await import('ffmpeg-static');
await _run(ffmpegStatic, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '/tmp/dur-test.m4a']).catch(() => {});
const probed = await probeDurationSec('/tmp/dur-test.m4a').catch(() => null);
check('probeDurationSec 3s wali file ~3 naapta hai', probed !== null && Math.abs(probed - 3) < 1.5);

console.log(`\nNatija: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
