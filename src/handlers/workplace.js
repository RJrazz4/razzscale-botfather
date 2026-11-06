import * as evo from '../services/transport.js';
import { setFlow, logUsage, pool } from '../db/pool.js';
import { env } from '../config/env.js';
import { agentDecide } from '../services/llm.js';
import { enqueueJob } from '../services/worker.js';
import { notifyOwner } from '../services/owner.js';

// WORKPLACE v1 — LIKHAI (MASTER PLAN Track B, 2026-11-06)
// Niyam (Hero, ⭐ filter): sirf HALKA kaam. Order → halka/bhaari ki naap →
// halka kaam jobs line (worker, 'likhai_work') me banta hai → taiyaar kaam
// pehle BOSS (owner number) ke paas approval ke liye → Boss 'Bhej do' tap
// kare to customer ko usi chat me delivery. Bhaari kaam = wahin VIP rasta.
// Kaam ka record = jobs table ki row (idempotency_key 'work:<orderId>',
// payload = order + stage, result = taiyaar likhai). Koi nayi table nahi.
// Stages: queued → (worker result bhar deta hai) → delivered / rejected.

export const WORK_STATES = ['work_type', 'work_brief', 'work_confirm'];
const FLOW_TTL = 1800;

export const WORK_KINDS = {
  work_k1: 'Caption (social media post ke liye)',
  work_k2: 'Business message (WhatsApp par bhejne ke liye)',
  work_k3: 'Product ki tafseel (description)',
  work_k4: 'Chhoti script (video / reel ke liye)',
  work_k5: 'Kuch aur likhai',
};
const KIND_KEYS = Object.keys(WORK_KINDS);
const KIND_NUM_LABELS = Object.fromEntries(KIND_KEYS.map((k, i) => [i + 1, WORK_KINDS[k]]));
// Bhaari kaam ke pakke shabd — brief me ye dikhe to seedha VIP rasta
// (agent se pehle ki sasti, pakki chaal). Web darwaza (webDoor.js) bhi yahi
// list use karta hai — ek hi filter, dono darwaze.
export const HEAVY_WORDS = ['bot ban', 'bot chahiye', 'website', 'app ban', 'automation', 'software', 'crm', 'dashboard', 'video series', 'har roz video', 'daily video', 'poora system'];

export function isOwner(from) {
  return String(from || '').replace(/\D/g, '') === env.ownerWaNumber;
}

const MENU_ROW = { rowId: 'nav_menu', title: '🏠 Main Menu', description: 'Home par wapas' };
function kindRows() {
  return [...KIND_KEYS.map((k) => ({ rowId: k, title: WORK_KINDS[k].split(' (')[0], description: WORK_KINDS[k] })), { ...MENU_ROW }];
}

// ---------- Screen senders (list-first — wahi bandha duplicate-screen pattern) ----------
async function listFirst(inst, from, listArgs, textFallback) {
  const ok = await evo.sendList(inst, from, listArgs).then(() => true).catch(() => false);
  if (!ok && textFallback) await evo.sendText(inst, from, textFallback);
  return ok;
}
async function sendWorkTypes(inst, from) {
  await listFirst(inst, from, {
    title: '✍️ Kaam Karwao', buttonText: 'Kaam Chuno',
    description: 'Kis type ki likhai chahiye? Tap karo 👇',
    sections: [{ title: 'Likhai ke kaam', rows: kindRows() }],
  }, '✍️ *Kaam Karwao — likhai wala kaam*\n\nKya likhwana hai? Number likho ya list se tap karo:\n\n' +
    KIND_KEYS.map((k, i) => `${i + 1}. ${WORK_KINDS[k]}`).join('\n'));
}
async function sendWorkBrief(inst, from, kindLabel) {
  await evo.sendText(inst, from,
    `✍️ *${kindLabel}*\n\nAb tafseel batao — kiske liye hai, kya khaas baat aani chahiye? 1-3 line me likh do.\n\nExample: "Meri mithaas ki dukaan ke liye Diwali offer ka caption — 20% off wali baat ke saath, khushi wala mahaul."`);
}
async function sendWorkConfirm(inst, from, w) {
  await evo.sendText(inst, from,
    `📋 *Order ki jaanch*\n\n📝 *Kaam:* ${w.kind}\n📄 *Tafseel:* ${w.brief}\n\nPakka ho to *Pakka Karo* tap karo — kaam shuru ho jayega. Taiyaar hone par ek quality jaanch ke baad yahin milega.`);
  await evo.sendList(inst, from, {
    title: '📋 Order Confirm', buttonText: 'Pakka Karo',
    description: 'Order sahi hai? 👇',
    sections: [{ title: 'Confirm', rows: [
      { rowId: 'wk_confirm', title: '✅ Pakka — kaam shuru karo', description: 'Order de do' },
      { rowId: 'wk_cancel', title: '❌ Radd karo', description: 'Ye order nahi chahiye' },
      { ...MENU_ROW },
    ] }],
  }).catch(() => {});
}

// ---------- Owner (Boss) approval ----------
// Boss ke khud ke chat me chalta hai — isiliye masterMenu me SABSE pehle
// bulaaya jata hai, kisi bhi state se upar. Customer isse kabhi nahi chala
// sakta (number ki pehchan env.ownerWaNumber se hoti hai).
export async function handleOwnerWork(ctx) {
  const { from, t, lower, inst } = ctx;
  if (!isOwner(from)) return false;

  if (lower === 'worklist') {
    const { rows } = await pool.query(
      "select * from jobs where type='likhai_work' order by id desc limit 20").catch(() => ({ rows: [] }));
    const pending = rows.filter((j) => {
      let p = {}; try { p = typeof j.payload === 'string' ? JSON.parse(j.payload) : (j.payload || {}); } catch { /* khali */ }
      return j.result && !['delivered', 'rejected'].includes(p.stage);
    }).slice(0, 5);
    if (!pending.length) { await evo.sendText(inst, from, 'Koi pending approval nahi hai 👍'); return true; }
    const lines = pending.map((j) => {
      let p = {}; try { p = typeof j.payload === 'string' ? JSON.parse(j.payload) : (j.payload || {}); } catch { /* khali */ }
      return `• *${p.orderId}* — ${p.workKind || 'likhai'}\n  "${String(p.brief || '').slice(0, 60)}"\n  Approval ke liye: work_ok_${p.orderId} / radd: work_no_${p.orderId}`;
    });
    await evo.sendText(inst, from, `✍️ *Pending approvals (${pending.length}):*\n\n${lines.join('\n\n')}`);
    return true;
  }

  const m = t.match(/^work_(ok|no)_(.+)$/);
  if (!m) return false;
  const [, act, orderId] = m;
  const { rows } = await pool.query('select * from jobs where idempotency_key=$1', [`work:${orderId}`]).catch(() => ({ rows: [] }));
  const job = rows[0];
  if (!job || job.type !== 'likhai_work') { await evo.sendText(inst, from, 'Ye order nahi mila 🤔'); return true; }
  let payload = {}; try { payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : (job.payload || {}); } catch { /* khali */ }
  const saveStage = async (stage) => {
    payload.stage = stage;
    await pool.query('update jobs set payload=$2 where id=$1', [job.id, JSON.stringify(payload)]).catch(() => {});
  };

  if (act === 'no') {
    if (payload.stage !== 'rejected') {
      await saveStage('rejected');
      await evo.sendText(payload.instance, payload.to,
        '🙏 Maaf karo — tumhara kaam abhi pakka nahi ho paya. Thodi aur tafseel ke saath dobara bata do, ya VIP section se Boss se seedha baat kar lo.').catch(() => {});
    }
    await evo.sendText(inst, from, `❌ Order ${orderId} radd kar diya — customer ko khabar bhej di.`);
    return true;
  }
  // act === 'ok'
  if (payload.stage === 'delivered') { await evo.sendText(inst, from, 'Ye kaam pehle hi customer ko ja chuka hai ✅'); return true; }
  if (!job.result) { await evo.sendText(inst, from, 'Kaam abhi taiyaar nahi hua hai — thodi der me phir try karo.'); return true; }
  try {
    await evo.sendText(payload.instance, payload.to,
      `✍️ *Tumhara kaam taiyaar hai!*\n\n${job.result}\n\n— RazzScale AI 🙏\nAur kuch chahiye to bas likh do.`);
  } catch {
    await evo.sendText(inst, from, '⚠️ Customer ko abhi bhejna nahi ho paya (uska chat window band hoga). Woh jab message kare, tum phir wahi button tap kar dena — ya "worklist" likho.');
    return true;
  }
  await saveStage('delivered');
  await evo.sendText(inst, from, `✅ Order ${orderId} customer ko bhej diya.`);
  return true;
}

// ---------- Customer order flow ----------
// ctx: masterMenu wala hi { user, from, t, lower, flow, state, inst, goHome }
export async function handleWork(ctx) {
  const { user, from, t, lower, flow, state, inst } = ctx;
  const inWork = WORK_STATES.includes(state);
  const isEntry = t === 'work';
  if (!inWork && !isEntry) return false;

  const w = { ...(flow?.work || {}) };
  const save = (step, work) => setFlow(user.id, 'master', { step, work: work ?? w }, FLOW_TTL);

  if (isEntry) { await setFlow(user.id, 'master', { step: 'work_type', work: {} }, FLOW_TTL); await sendWorkTypes(inst, from); return true; }

  switch (state) {
    case 'work_type': {
      let n = Number((t.match(/^work_k(\d)$/) || [])[1] || t);
      if (!KIND_NUM_LABELS[n]) {
        // AGENT MODE: shabdon se kaam ki type pehchano
        await evo.sendPresence(inst, from, 'composing', 20000).catch(() => {});
        const list = Object.entries(KIND_NUM_LABELS).map(([k, l]) => `${k}=${l}`).join(', ');
        const d = await agentDecide(user, { step: `work_type (choose one: ${list})`, answers: w, text: t });
        if (d?.reply) await evo.sendText(inst, from, d.reply);
        if (d?.action === 'choose' && KIND_NUM_LABELS[Number(d.value)]) n = Number(d.value);
        else { await sendWorkTypes(inst, from); return true; }
      }
      w.kind = KIND_NUM_LABELS[n];
      await save('work_brief', w);
      await sendWorkBrief(inst, from, w.kind);
      return true;
    }
    case 'work_brief': {
      if (!t) { await sendWorkBrief(inst, from, w.kind); return true; }
      // ⭐ HALKA/BHAARI FILTER: bhaari shabd dikhe to wahin VIP rasta —
      // jhootha order kabhi nahi banega.
      if (HEAVY_WORDS.some((h) => lower.includes(h))) {
        await setFlow(user.id, 'master', { step: 'menu' });
        await evo.sendText(inst, from,
          'Ye wala kaam *bhaari* hai — ye humare khaas VIP raste se hota hai, jahan *Boss RazzScale khud* tumhare liye tumhara apna agent/system banate hain. 🚀\n\nHome menu se *VIP Automation* wala rasta lo — wahan apni baat bata do, Boss isi chat me khud baat karenge.');
        // ⭐ Escalation: bhaari maang ki khabar Boss ko bhi (deal wahan pakegi)
        await notifyOwner(inst,
          `🔔 *Bhaari kaam ki maang (Workplace se VIP bheja)*\n👤 Customer: +${String(from).replace(/\D/g, '')}\n📝 Brief: "${t.slice(0, 200)}"`)
          .catch(() => {});
        if (ctx.goHome) await ctx.goHome();
        return true;
      }
      w.brief = t.slice(0, 600);
      await save('work_confirm', w);
      await sendWorkConfirm(inst, from, w);
      return true;
    }
    case 'work_confirm': {
      if (t === 'wk_confirm' || ['pakka', 'haan', 'confirm', 'yes', 'shuru karo'].includes(lower)) {
        const orderId = `WK-${Date.now().toString(36).toUpperCase()}`;
        const res = await enqueueJob('likhai_work',
          { instance: inst, to: from, userId: user.id, orderId, workKind: w.kind, brief: w.brief, stage: 'queued' },
          `work:${orderId}`);
        await logUsage(user.id, 'work_order').catch(() => {});
        await setFlow(user.id, 'master', { step: 'menu' });
        await evo.sendText(inst, from, res.queued || res.existing
          ? `👍 *Order mil gaya!* (Order ID: ${orderId})\nKaam ban raha hai — taiyaar hote hi ek quality jaanch ke baad yahin milega. Aam taur par kuch minutes lagte hain 🙏`
          : 'Abhi order nahi lag paya 😔 — ek minute me dobara try karo.');
        return true;
      }
      if (t === 'wk_cancel' || ['cancel', 'radd', 'band karo', 'nahi chahiye'].includes(lower)) {
        await setFlow(user.id, 'master', { step: 'menu' });
        await evo.sendText(inst, from, 'Theek hai, order radd kar diya 🙏 Jab chaho, menu se *Kaam Karwao* wala rasta dobara lo.');
        if (ctx.goHome) await ctx.goHome();
        return true;
      }
      await sendWorkConfirm(inst, from, w);
      return true;
    }
    default:
      await sendWorkTypes(inst, from);
      return true;
  }
}

// nav_back ke liye pichli screen dobara bhejna (masterMenu BACK map bulata hai)
export async function resendWorkScreen(ctx) {
  const { from, flow, state, inst } = ctx;
  const w = flow?.work || {};
  switch (state) {
    case 'work_type': await sendWorkTypes(inst, from); return true;
    case 'work_brief': await sendWorkBrief(inst, from, w.kind); return true;
    case 'work_confirm': await sendWorkConfirm(inst, from, w); return true;
    default: return false;
  }
}
export const WORK_BACK = { work_type: 'menu', work_brief: 'work_type', work_confirm: 'work_brief' };
