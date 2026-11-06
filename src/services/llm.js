import { env, getConfig } from '../config/env.js';
import { usageToday, logUsage } from '../db/pool.js';
import { MASTER_INSTRUCTION } from '../config/instruction.js';

let keyIdx = 0;
export async function freeChat(user, prompt, history = []) {
  const limit = Number(await getConfig('FREE_LLM_DAILY_LIMIT', 100));
  if (await usageToday(user.id, 'llm') >= limit) {
    return 'Aaj ka free AI limit khatm ho gaya hai. Kal phir aana, ya apna khud ka AI Bot bana lo — menu me option 1 hai.';
  }
  const key = env.llmKeys[keyIdx++ % Math.max(env.llmKeys.length, 1)];
  if (!key) return 'AI abhi set nahi hua hai. Thodi der me phir try karo.';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.llmModel,
      messages: [
        { role: 'system', content: MASTER_INSTRUCTION },
        ...history.slice(-6), { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) return 'AI abhi busy hai — ek minute me phir try karo.';
  const json = await res.json();
  await logUsage(user.id, 'llm');
  return json?.choices?.[0]?.message?.content?.trim() || 'Kuch gadbad ho gayi, phir try karo.';
}

// AGENT DECIDE (2026-11-06, Hero ka order: "har page par agentic mode"):
// Form-flows (consult) ke liye chhota decision-brain. freeChat wali hi keys,
// wahi daily limit, wahi usage — sirf system prompt alag (user se baat NAHI,
// sirf JSON faisla). Jawab object me; kuch bhi gadbad (limit, network, kharab
// JSON) ho to null — caller purana form behaviour chala lega, flow kabhi
// agent ki wajah se nahi rukega.
const AGENT_SYSTEM = `You are the decision brain inside a WhatsApp business bot's form flow. You NEVER chat with the user directly. You read the current form step, the answers collected so far, and the user's latest free-text message, then output ONLY a JSON object (no markdown, no extra text):
{"action":"...","value":"...","reply":"..."}
Allowed actions:
- "set_field": the user gave or corrected a form value (a name, a requirement). value = the cleaned value text only. reply = ONE short friendly Hinglish acknowledgement line. If the user's text ALSO contains a question, answer that question briefly inside reply too.
- "choose": the user clearly means one of the numbered choices of the current step. value = that choice number as a string. reply = one short Hinglish line confirming the pick.
- "answer": the user asked a question or said something that needs a spoken reply (price, process, confusion, greeting, complaint). reply = the full answer in Hinglish, max 3 short lines. Facts: we are RazzScale AI; we build WhatsApp/Telegram bots, business workflow automation, websites/online stores, social media workflows and AI agents. Exact price and process for a custom build is decided by Boss RazzScale personally in this same chat after the requirement is confirmed — NEVER invent a price, discount or deadline.
- "unclear": none of the above fits. reply = one short Hinglish line guiding the user back to the current step's options.
Rules: reply language is ALWAYS Hinglish (Roman script). If the user's text IS the answer to the current question (a name, a requirement), use "set_field", not "answer". Output JSON only.`;

export async function agentDecide(user, { step, answers = {}, text }) {
  try {
    const limit = Number(await getConfig('FREE_LLM_DAILY_LIMIT', 100));
    if (await usageToday(user.id, 'llm') >= limit) return null;
    const key = env.llmKeys[keyIdx++ % Math.max(env.llmKeys.length, 1)];
    if (!key) return null;
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: env.llmModel,
        messages: [
          { role: 'system', content: AGENT_SYSTEM },
          { role: 'user', content: `STEP: ${step}\nANSWERS SO FAR: ${JSON.stringify(answers)}\nUSER MESSAGE: ${text}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    await logUsage(user.id, 'llm');
    const raw = json?.choices?.[0]?.message?.content?.trim() || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const d = JSON.parse(m[0]);
    if (!d || !['set_field', 'choose', 'answer', 'unclear'].includes(d.action)) return null;
    return { action: d.action, value: String(d.value || ''), reply: String(d.reply || '').slice(0, 600) };
  } catch { return null; }
}
