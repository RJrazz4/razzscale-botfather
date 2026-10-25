import * as evo from '../services/transport.js';
import { setFlow, logUsage, pool } from '../db/pool.js';

// VIP CONSULTATION (FRONTEND BRIEF V1.0, docs/FRONTEND-BRIEF-PLAN.md):
// Guided consultation state machine — service chuno → (branch: social platforms/features
// ya website type) → 2 sawal → summary (confirm/edit/cancel) → lead + HUMAN MODE.
// NUMBER PRIVACY (2026-10-24): confirm par koi wa.me personal-number link NAHI jata —
// lead save hoti hai, contact 12h ke liye pause ho jata hai, aur Boss (insaan) ISI chat me
// khud baat karta hai. Personal number kisi public message me nahi jata.
// masterMenu sirf yahan route karta hai; saari consult logic is file me hai.
// Har screen: static list builder (speed — koi search/LLM nahi) + numbered text fallback.
// Row budget (WhatsApp limit 10 rows/list) plan doc §3 ke hisaab se hai.

export const CONSULT_STATES = ['consult_svc', 'consult_plat', 'consult_feat', 'consult_web', 'consult_q1', 'consult_q2', 'consult_summary'];
const FLOW_TTL = 1800; // consultation lambi hoti hai — default 600s kam padta

// ---------- Static data (labels summary me pure naam se aate hain) ----------
export const SVC_LABELS = {
  1: 'WhatsApp / Telegram Bot',
  2: 'Business Workflow Automation',
  3: 'Website / Online Business',
  4: 'Social Media Workflow',
  5: 'AI Agent / Assistant',
  6: 'Custom Requirement',
};
export const PLAT_LABELS = { 1: 'YouTube', 2: 'Instagram', 3: 'Facebook', 4: 'Telegram', 5: 'Multiple Platforms' };
export const FEATURE_LABELS = {
  1: 'AI content generation',
  2: 'Video / reel creation',
  3: 'Scheduling',
  4: 'Publishing',
  5: 'Captions, SEO and hashtags',
  6: 'Analytics / reporting',
  7: 'Full workflow automation',
};
export const WEB_LABELS = {
  1: 'Business Website',
  2: 'E-commerce Website',
  3: 'Customer Support Chatbot',
  4: 'Voice AI Agent',
  5: 'Internal Business Tool',
  6: 'Custom Software / Other',
};

// ---------- List builders (PURE — harness inse hi assert karta hai) ----------
const MENU_ROW = { rowId: 'nav_menu', title: '🏠 Main Menu', description: 'Home par wapas' };

export function svcRows() {
  return [
    { rowId: 'vip_svc_1', title: 'WhatsApp / TG Bot', description: 'WhatsApp / Telegram Bot' },
    { rowId: 'vip_svc_2', title: 'Business Workflow', description: 'Business Workflow Automation' },
    { rowId: 'vip_svc_3', title: 'Website / Online Biz', description: 'Website / Online Business' },
    { rowId: 'vip_svc_4', title: 'Social Media Workflow', description: 'Social media ka pura kaam' },
    { rowId: 'vip_svc_5', title: 'AI Agent / Assistant', description: 'AI Agent / Assistant' },
    { rowId: 'vip_svc_6', title: 'Custom Requirement', description: 'Kuch aur chahiye' },
    { ...MENU_ROW },
  ];
}
export function platRows() {
  return [
    { rowId: 'soc_plat_1', title: 'YouTube', description: 'YouTube channel ke liye' },
    { rowId: 'soc_plat_2', title: 'Instagram', description: 'Instagram ke liye' },
    { rowId: 'soc_plat_3', title: 'Facebook', description: 'Facebook ke liye' },
    { rowId: 'soc_plat_4', title: 'Telegram', description: 'Telegram ke liye' },
    { rowId: 'soc_plat_5', title: 'Multiple Platforms', description: 'Ek se zyada platforms' },
    { ...MENU_ROW },
  ];
}
const FEAT_ROW_TITLES = {
  1: 'AI Content banana', 2: 'Video / Reel banana', 3: 'Scheduling', 4: 'Publishing',
  5: 'Captions / SEO / Tags', 6: 'Analytics / Report',
};
// List budget: 6 feature rows + Done + Menu = 8. 7th feature (Full workflow) list se bahar hai —
// screen ke text me 'full' likhne ka saaf option diya jata hai (plan §9.3).
export function featRows(selected = []) {
  const rows = [1, 2, 3, 4, 5, 6].map((n) => ({
    rowId: `soc_feat_${n}`,
    title: `${selected.includes(n) ? '✅ ' : ''}${FEAT_ROW_TITLES[n]}`,
    description: FEATURE_LABELS[n],
  }));
  rows.push({ rowId: 'soc_feat_done', title: '✔️ Ho gaya — aage', description: 'Selection pakka, aage badho' });
  rows.push({ ...MENU_ROW });
  return rows;
}
export function webRows() {
  return [
    { rowId: 'web_type_1', title: 'Business Website', description: 'Business Website' },
    { rowId: 'web_type_2', title: 'E-commerce Website', description: 'Online store / dukaan' },
    { rowId: 'web_type_3', title: 'Support Chatbot', description: 'Customer Support Chatbot' },
    { rowId: 'web_type_4', title: 'Voice AI Agent', description: 'Voice AI Agent' },
    { rowId: 'web_type_5', title: 'Internal Tool', description: 'Internal Business Tool' },
    { rowId: 'web_type_6', title: 'Custom / Other', description: 'Custom Software / Other' },
    { ...MENU_ROW },
  ];
}
export function skipRows() {
  return [
    { rowId: 'q_skip', title: '⏭️ Skip karo', description: 'Bina jawab diye aage' },
    { ...MENU_ROW },
  ];
}
export function summaryRows() {
  return [
    { rowId: 'cf_confirm', title: '✅ Confirm karo', description: 'Pakka hai — Boss yahin baat karenge' },
    { rowId: 'cf_edit', title: '✏️ Edit karo', description: 'Jawab badalne hain' },
    { rowId: 'cf_cancel', title: '❌ Cancel karo', description: 'Ye requirement radd' },
    { ...MENU_ROW },
  ];
}

// ---------- Summary / handoff builders (PURE) ----------
const NA = 'nahi diya';
export function buildSummary(a = {}) {
  const lines = ['📋 *Tumhari Requirement — Summary*', '', `🔧 *Service:* ${a.service || NA}`];
  if (a.platform !== undefined || a.service === SVC_LABELS[4]) lines.push(`📱 *Platform:* ${a.platform || NA}`);
  if (a.features !== undefined || a.service === SVC_LABELS[4]) {
    const f = (a.features || []).map((n) => FEATURE_LABELS[n]).filter(Boolean);
    lines.push(`✨ *Features:* ${f.length ? f.join(', ') : NA}`);
  }
  if (a.webType !== undefined || a.service === SVC_LABELS[3]) lines.push(`🌐 *Website type:* ${a.webType || NA}`);
  lines.push(`🏢 *Business:* ${a.business || NA}`);
  lines.push(`📝 *Requirement:* ${a.requirement || NA}`);
  lines.push('', 'Sahi hai to *Confirm* karo — galti ho to *Edit*, band karna ho to *Cancel*.');
  return lines.join('\n');
}
// Confirm ke baad ka message (PURE builder): Lead ID + human mode ki saaf jankari.
// Koi link NAHI, koi number NAHI — baat isi chat me aage badhegi, insaan ke saath.
export function buildConfirmedMessage(leadId, a = {}) {
  return [
    `Ho gaya! ✅ Tumhara *Lead ID: ${leadId}*`,
    '',
    'Tumhari requirement pakki ho gayi hai. 👍',
    'Ab isi chat me *Boss (insaan) khud* tumse baat karenge — jo bhi kehna hai, bas yahin likh do.',
    'Bot is chat me peeche hat gaya hai — beech me nahi ayega. 🙏',
  ].join('\n');
}

// HUMAN MODE: contact ko paused_contacts me daalo (auto-pause wala hi table/mechanism —
// sessionRouter 12h baad lazy-expire karta hai). Is dauraan bot is chat me chup rehta hai
// aur dost/owner usi number se haath se aaram se baat kar sakta hai.
export async function pauseForHuman(jid, reason = 'consult_handoff') {
  await pool.query(
    `insert into paused_contacts (jid, paused_at, reason) values ($1,$2,$3)
     on conflict (jid) do update set paused_at=excluded.paused_at, reason=excluded.reason`,
    [jid, new Date().toISOString(), reason]);
}
export function newLeadId() {
  return `RS-${Date.now().toString(36).toUpperCase()}`;
}

// ---------- Screen senders (text fallback + list, dono) ----------
async function sendSvc(inst, from) {
  await evo.sendText(inst, from, '🚀 *VIP Action Automation*\n\nKaunsi service chahiye? Number likho ya list se tap karo:\n\n' +
    Object.entries(SVC_LABELS).map(([n, l]) => `${n}. ${l}`).join('\n'));
  await evo.sendList(inst, from, {
    title: '🚀 VIP Services', buttonText: 'Service Chuno',
    description: 'Kaunsi service chahiye? Tap karo 👇',
    sections: [{ title: 'Services', rows: svcRows() }],
  }).catch(() => {});
}
async function sendPlat(inst, from) {
  await evo.sendText(inst, from, '📱 *Kaunsa platform?*\n\n' +
    Object.entries(PLAT_LABELS).map(([n, l]) => `${n}. ${l}`).join('\n') + '\n\nNumber likho ya list se tap karo.');
  await evo.sendList(inst, from, {
    title: '📱 Platform Chuno', buttonText: 'Platform Chuno',
    description: 'Social media — kaunsa platform? 👇',
    sections: [{ title: 'Platforms', rows: platRows() }],
  }).catch(() => {});
}
async function sendFeat(inst, from, selected = []) {
  const sel = selected.map((n) => FEATURE_LABELS[n]).filter(Boolean);
  await evo.sendText(inst, from,
    `✨ *Kaunsi cheezein chahiye?* Tap karke chuno — dobara tap karne se hat-ti hai.\n\nAbhi chuna hua: ${sel.length ? sel.join(', ') : 'kuch nahi'}\n\n📌 *"Full workflow automation"* bhi chahiye to *full* likh do (list me jagah ki limit hai, isliye woh row nahi hai).\nHo jaye to list me *"Ho gaya"* tap karo ya *done* likho.`);
  await evo.sendList(inst, from, {
    title: '✨ Features Chuno', buttonText: 'Features Dekho',
    description: 'Jo chahiye woh tap karo 👇',
    sections: [{ title: 'Features', rows: featRows(selected) }],
  }).catch(() => {});
}
async function sendWeb(inst, from) {
  await evo.sendText(inst, from, '🌐 *Kis type ki website / tool?*\n\n' +
    Object.entries(WEB_LABELS).map(([n, l]) => `${n}. ${l}`).join('\n') + '\n\nNumber likho ya list se tap karo.');
  await evo.sendList(inst, from, {
    title: '🌐 Type Chuno', buttonText: 'Type Chuno',
    description: 'Kis type ka kaam hai? 👇',
    sections: [{ title: 'Types', rows: webRows() }],
  }).catch(() => {});
}
async function sendQ(inst, from, which, prev) {
  const q = which === 1
    ? '❓ *Sawal 1/2:* Tumhare business ka naam kya hai?'
    : '❓ *Sawal 2/2:* Apni requirement 1-2 line me likh do — kya banwana hai, kis ke liye?';
  const note = prev ? `\n(Pehle wala jawab: "${prev}" — naya likhoge to wahi lagega, *skip* karoge to purana hi rahega.)` : '\nJawab na dena ho to *skip* likho ya list se Skip tap karo.';
  await evo.sendText(inst, from, q + note);
  await evo.sendList(inst, from, {
    title: which === 1 ? '❓ Sawal 1/2' : '❓ Sawal 2/2', buttonText: 'Options',
    description: 'Jawab likho, ya skip karo 👇',
    sections: [{ title: 'Options', rows: skipRows() }],
  }).catch(() => {});
}
async function sendSummary(inst, from, a) {
  await evo.sendText(inst, from, buildSummary(a));
  await evo.sendList(inst, from, {
    title: '📋 Summary', buttonText: 'Pakka Karo',
    description: 'Summary sahi hai? 👇',
    sections: [{ title: 'Confirm', rows: summaryRows() }],
  }).catch(() => {});
}

// ---------- State machine ----------
// ctx: { user, from, t, lower, flow, state, inst, goHome } — masterMenu route karke deta hai.
// Return true = message consume ho gaya; false = ye consult ka nahi hai, aage route karo.
export async function handleConsult(ctx) {
  const { user, from, t, lower, flow, state, inst } = ctx;
  const inConsult = CONSULT_STATES.includes(state);
  const isEntry = t === 'vip';
  const isConsultAction = /^(vip_svc_|soc_plat_|soc_feat_|web_type_|cf_|q_skip)/.test(t);
  if (!inConsult && !isEntry && !isConsultAction) return false;

  const a = { ...(flow?.answers || {}) };
  const save = (step, answers) => setFlow(user.id, 'master', { step, answers: answers ?? a }, FLOW_TTL);

  if (isEntry) { await setFlow(user.id, 'master', { step: 'consult_svc', answers: {} }, FLOW_TTL); await sendSvc(inst, from); return true; }

  // Edit ke liye pichli screen ka back-chain consult ke andar hi hai
  // (nav_back global hai — masterMenu BACK map se consult ki pichli screen par bhejta hai,
  //  yahan sirf tab aata hai jab state consult_* ho ya action consult ka ho)
  switch (state) {
    case 'consult_svc': {
      const n = Number((t.match(/^vip_svc_(\d)$/) || [])[1] || t);
      if (!SVC_LABELS[n]) { await sendSvc(inst, from); return true; }
      a.service = SVC_LABELS[n];
      if (n === 3) { await save('consult_web', a); await sendWeb(inst, from); }
      else if (n === 4) { await save('consult_plat', a); await sendPlat(inst, from); }
      else { await save('consult_q1', a); await sendQ(inst, from, 1, a.business); }
      return true;
    }
    case 'consult_plat': {
      const n = Number((t.match(/^soc_plat_(\d)$/) || [])[1] || t);
      if (!PLAT_LABELS[n]) { await sendPlat(inst, from); return true; }
      a.platform = PLAT_LABELS[n];
      if (!Array.isArray(a.features)) a.features = [];
      await save('consult_feat', a);
      await sendFeat(inst, from, a.features);
      return true;
    }
    case 'consult_feat': {
      if (t === 'soc_feat_done' || lower === 'done') {
        await save('consult_q1', a);
        await sendQ(inst, from, 1, a.business);
        return true;
      }
      let n = Number((t.match(/^soc_feat_(\d)$/) || [])[1] || t);
      if (lower === 'full') n = 7;
      if (FEATURE_LABELS[n]) {
        const sel = new Set(Array.isArray(a.features) ? a.features : []);
        if (sel.has(n)) sel.delete(n); else sel.add(n);
        a.features = [...sel].sort((x, y) => x - y);
        await save('consult_feat', a);
        await sendFeat(inst, from, a.features);
        return true;
      }
      await sendFeat(inst, from, Array.isArray(a.features) ? a.features : []);
      return true;
    }
    case 'consult_web': {
      const n = Number((t.match(/^web_type_(\d)$/) || [])[1] || t);
      if (!WEB_LABELS[n]) { await sendWeb(inst, from); return true; }
      a.webType = WEB_LABELS[n];
      await save('consult_q1', a);
      await sendQ(inst, from, 1, a.business);
      return true;
    }
    case 'consult_q1': {
      if (t === 'q_skip' || lower === 'skip') { /* purana business (edit case) jaisa hai waisa */ }
      else if (t) a.business = t.slice(0, 120);
      await save('consult_q2', a);
      await sendQ(inst, from, 2, a.requirement);
      return true;
    }
    case 'consult_q2': {
      if (t === 'q_skip' || lower === 'skip') { /* purana requirement rakho */ }
      else if (t) a.requirement = t.slice(0, 300);
      await save('consult_summary', a);
      await sendSummary(inst, from, a);
      return true;
    }
    case 'consult_summary': {
      if (t === 'cf_confirm') {
        const leadId = newLeadId();
        await pool.query(
          'insert into leads (id, jid, user_id, service, answers) values ($1,$2,$3,$4,$5)',
          [leadId, from, user.id, a.service || null, JSON.stringify(a)]).catch((e) => console.error('[consult] lead insert:', e?.message || e));
        await logUsage(user.id, 'consult_lead').catch(() => {});
        // HUMAN MODE ON: is contact ke liye bot 12h peeche — Boss isi chat me khud baat karega.
        // (Manual reply par auto-pause pehle se tha; ab confirm par pehle se hi pause lag jata hai.)
        await pauseForHuman(from).catch((e) => console.error('[consult] human-mode pause:', e?.message || e));
        await setFlow(user.id, 'master', { step: 'menu' });
        await evo.sendText(inst, from, buildConfirmedMessage(leadId, a));
        return true;
      }
      if (t === 'cf_edit') { await save('consult_q1', a); await sendQ(inst, from, 1, a.business); return true; }
      if (t === 'cf_cancel') {
        await setFlow(user.id, 'master', { step: 'menu' });
        await evo.sendText(inst, from, 'Theek hai, ye requirement radd kar di 🙏 Jab chaho, VIP section se dobara shuru kar sakte ho.');
        if (ctx.goHome) await ctx.goHome();
        return true;
      }
      await sendSummary(inst, from, a);
      return true;
    }
    default:
      // consult action kisi aur state se aaya (purani chat ki list) — service list se shuru karo
      await setFlow(user.id, 'master', { step: 'consult_svc', answers: {} }, FLOW_TTL);
      await sendSvc(inst, from);
      return true;
  }
}

// nav_back ke liye: consult state se pichli screen dobara bhejna (state wahin rehta hai,
// user wahan se apna chunaav badal sakta hai). masterMenu BACK map isey bulata hai.
export async function resendConsultScreen(ctx) {
  const { from, flow, state, inst } = ctx;
  const a = flow?.answers || {};
  switch (state) {
    case 'consult_svc': await sendSvc(inst, from); return true;
    case 'consult_plat': await sendPlat(inst, from); return true;
    case 'consult_feat': await sendFeat(inst, from, Array.isArray(a.features) ? a.features : []); return true;
    case 'consult_web': await sendWeb(inst, from); return true;
    case 'consult_q1': await sendQ(inst, from, 1, a.business); return true;
    case 'consult_q2': await sendQ(inst, from, 2, a.requirement); return true;
    case 'consult_summary': await sendSummary(inst, from, a); return true;
    default: return false;
  }
}

// nav_back par consult states ka step-back: state khud ek kadam peeche set hota hai
// (answers barkarar), phir resendConsultScreen nayi state ki screen bhejta hai.
export const CONSULT_BACK = {
  consult_svc: 'menu',
  consult_plat: 'consult_svc',
  consult_feat: 'consult_plat',
  consult_web: 'consult_svc',
  consult_q1: 'consult_svc', // branch screens (plat/web) answers-driven hain; svc list se dobara sahi branch khulta hai
  consult_q2: 'consult_q1',
  consult_summary: 'consult_q2',
};
