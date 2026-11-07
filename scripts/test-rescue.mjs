// CROSS-SOURCE RESCUE ke pehchan-niyam — local test (2026-11-07).
// Jad usool: galat gaana bhejna fail se bura hai — sakht mel par hi rescue.
// Chalana: node scripts/test-rescue.mjs

const { rescueQueryFromTitle, pickSaavnRescue, pickAltUpload, scoreYtTrack } = await import('../src/services/musicSearch.js');
const { foldText } = await import('../src/services/jiosaavn.js');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// Khoj-shabd ki safai
const q1 = rescueQueryFromTitle('Yahowa Mujhe Teri Zaroorat Hay || Anil Samuel || New Hindi Urdu Masihi Geet');
check('Yahowa query: pehla shabd yahowa', q1.split(' ')[0] === 'yahowa');
check('Yahowa query: artist ka naam bahar (anil nahi)', !q1.includes('anil'));

const q2 = rescueQueryFromTitle('Zaroorat 8K Full Video Song | Ek Villain | Mithoon | Mustafa Zahid');
check('Zaroorat query: sirf ek saaf shabd', q2 === foldText('zaroorat'));

const q3 = rescueQueryFromTitle('Arijit Singh — Tum Hi Ho (Official Video)');
check('Dash wale title me gaane wala hissa', q3 === `${foldText('tum')} ${foldText('hi')} ${foldText('ho')}`);

// Devanagari hook pehle ho to Latin wala asal-naam hissa khoj bane
// (16:22 wala asal case: Kanhaiya Mittal ka bhajan)
const q4 = rescueQueryFromTitle('ओ सांवरे || O Saanware Mujhe Teri Jarurat Hai || Kanhaiya Mittal || Khatu Janamdin Special Bhajan');
check('Bhajan query: saanware shabd hai', q4.includes('saanware'));
check('Bhajan query: jarurat shabd hai', q4.includes('jarurat'));
check('Bhajan query: kanhaiya (artist) bahar', !q4.includes('kanhaiya'));

// Sakht mel: Yahowa wala gaana dusre "Mujhe Teri Zaroorat" se rescue NAHI hoga
const yahowaCandidates = [
  { id: 'S_KANHAIYA', song: 'Mujhe Teri Zaroorat Hai', artist: 'Kanhaiya Mittal' },
];
check('Yahowa -> Kanhaiya wala gaana rescue NAHI (galat gaana)', pickSaavnRescue('Yahowa Mujhe Teri Zaroorat Hay || Anil Samuel', yahowaCandidates) === null);

// Sahi mel: Zaroorat YT fail -> Saavn ka wahi Zaroorat
const zarooratCandidates = [
  { id: 'S_ZAR', song: 'Zaroorat', artist: 'Mustafa Zahid' },
  { id: 'S_OTHER', song: 'Zaroori Tha', artist: 'Rahat Fateh Ali Khan' },
];
check('Zaroorat -> Saavn Zaroorat hi mile', pickSaavnRescue('Zaroorat 8K Full Video Song | Ek Villain', zarooratCandidates)?.id === 'S_ZAR');

// Sahi mel: Tum Hi Ho
const tumCandidates = [{ id: 'S_THH', song: 'Tum Hi Ho', artist: 'Arijit Singh' }];
check('Tum Hi Ho -> Saavn Tum Hi Ho mile', pickSaavnRescue('Tum Hi Ho (Aashiqui 2) — Arijit Singh', tumCandidates)?.id === 'S_THH');

// Khaali/be-mel par null
check('be-mel par null', pickSaavnRescue('Phonk Music Drift', [{ id: 'S_X', song: 'Tum Hi Ho', artist: 'Arijit Singh' }]) === null);
check('khaali candidates par null', pickSaavnRescue('Tum Hi Ho', []) === null);

// Dusra upload: fail wala khud bahar, lambe mix bahar, pehla saaf natija mile
const altList = [
  { id: 'FAILED1', title: 'Wahi Gaana (kharab upload)', duration: 300 },
  { id: 'LONG1', title: 'Wahi Gaana 1 Hour Mix', duration: 3600 },
  { id: 'GOOD1', title: 'Wahi Gaana Dusra Upload', duration: 280 },
];
check('dusra upload: kharab + lamba chhod kar GOOD1', pickAltUpload(altList, 'FAILED1')?.id === 'GOOD1');
check('dusra upload: sab fail-wale hi hon to null', pickAltUpload([{ id: 'FAILED1', duration: 200 }], 'FAILED1') === null);

// Kai uploads (rescue v3): bahar-wale ids + lambe chhod kar, kram se, n tak
const { pickAltUploads } = await import('../src/services/musicSearch.js');
const many = [
  { id: 'A', duration: 200 }, { id: 'B', duration: 4000 }, { id: 'C', duration: 220 },
  { id: 'D', duration: 240 }, { id: 'E', duration: 260 },
];
check('kai uploads: A bahar, B lamba — C,D milen (n=2)', JSON.stringify(pickAltUploads(many, ['A'], 2).map((r) => r.id)) === '["C","D"]');
check('kai uploads: sab bahar hon to khaali', pickAltUploads(many, ['A', 'B', 'C', 'D', 'E'], 3).length === 0);

// yt-dlp hathiyaar: JS-runtime flag SIRF modern (pehchane hue) binary par;
// IPv4 dono par. Anjaan production binary par purane surakshit arguments hi.
const { downloadArgs, initYtdlp, ytdlpStatus } = await import('../src/services/music.js');
const aModern = downloadArgs('android', '/tmp/x.mp4', 'VID1', true);
check('modern args: --js-runtimes node hai', aModern.includes('--js-runtimes') && aModern.includes('node'));
check('modern args: -4 (IPv4) hai', aModern.includes('-4'));
const aLegacy = downloadArgs('android', '/tmp/x.mp4', 'VID1', false);
check('legacy args: --js-runtimes NAHI (anjaan binary surakshit)', !aLegacy.includes('--js-runtimes'));
check('legacy args: -4 (IPv4) hai', aLegacy.includes('-4'));

// CLICKBAIT PARAKH (2026-11-07 raat): nakli keyword-bhara upload official se neeche
const clickbait = { id: 'CB1', title: 'MUJHE TERI JARURAT HAI | Zaroorat Song | Ek Villain | Mithoon | Mustafa Zahid | New Hindi Song 2024', channel: 'Local Uploader', viewCount: 52000, duration: 246 };
const official = { id: 'OF1', title: 'Zaroorat Full Video Song | Ek Villain | Mustafa Zahid', channel: 'T-Series', viewCount: 48000000, duration: 290 };
check('clickbait: stuffed title official se neeche', scoreYtTrack(clickbait, 'Mujhe Teri Jarurat Hai', 0) < scoreYtTrack(official, 'Mujhe Teri Jarurat Hai', 1));
const altSorted = pickAltUploads([clickbait, official], ['FAILED1'], 2, 'Mujhe Teri Jarurat Hai');
check('rescue alt-pick: official pehle', altSorted[0]?.id === 'OF1');

initYtdlp();
check('init ke baad status modern (repo wala tools binary)', ytdlpStatus().modern === true);

console.log(`\nNatija: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
