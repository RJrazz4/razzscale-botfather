import { env, getConfig } from '../config/env.js';
import { usageToday, logUsage } from '../db/pool.js';
import { MASTER_INSTRUCTION } from '../config/instruction.js';

let keyIdx = 0;

// PROVIDER ROTATION (2026-11-06, Hero: "do account se rotate karke
// chalega"): pehle dimag ek hi raste par tika tha — woh atka to poora AI
// "busy". Ab do hisse ghumte hain: (1) providers — pehle AgentRouter,
// atak jaye to OpenRouter; (2) har provider ke andar uski chaabiyan aur
// model ek-ek karke. Har provider ki chaabi SIRF usi ke raste par jati
// hai. Har nakami provider+model+status ke saath log hoti hai (chaabi
// kabhi log nahi hoti) taaki jad turant dikhe, andhere me na rahe.
async function llmCall(messages, timeoutMs) {
  if (!env.llmProviders.length) return null;
  for (const provider of env.llmProviders) {
    for (const model of provider.models) {
      const key = provider.keys[keyIdx++ % provider.keys.length];
      try {
        const res = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ model, messages }),
        });
        if (!res.ok) {
          const errTxt = await res.text().catch(() => '');
          console.error('[llm] failed:', provider.name, model, res.status, errTxt.slice(0, 200));
          continue;
        }
        const json = await res.json();
        const content = json?.choices?.[0]?.message?.content?.trim();
        if (content) return content;
        console.error('[llm] empty content:', provider.name, model);
      } catch (e) {
        console.error('[llm] call error:', provider.name, model, e?.message || e);
      }
    }
  }
  return null;
}

export async function freeChat(user, prompt, history = []) {
  const limit = Number(await getConfig('FREE_LLM_DAILY_LIMIT', 100));
  if (await usageToday(user.id, 'llm') >= limit) {
    return 'Aaj ka free AI limit khatm ho gaya hai. Kal phir aana, ya apna khud ka AI Bot bana lo — menu me option 1 hai.';
  }
  if (!env.llmKeys.length) return 'AI abhi set nahi hua hai. Thodi der me phir try karo.';
  const content = await llmCall([
    { role: 'system', content: MASTER_INSTRUCTION },
    ...history.slice(-6), { role: 'user', content: prompt },
  ], 30000);
  if (!content) return 'AI abhi busy hai — ek minute me phir try karo.';
  await logUsage(user.id, 'llm');
  return content;
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
    if (!env.llmKeys.length) return null;
    const content = await llmCall([
      { role: 'system', content: AGENT_SYSTEM },
      { role: 'user', content: `STEP: ${step}\nANSWERS SO FAR: ${JSON.stringify(answers)}\nUSER MESSAGE: ${text}` },
    ], 15000);
    if (!content) return null;
    await logUsage(user.id, 'llm');
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const d = JSON.parse(m[0]);
    if (!d || !['set_field', 'choose', 'answer', 'unclear'].includes(d.action)) return null;
    return { action: d.action, value: String(d.value || ''), reply: String(d.reply || '').slice(0, 600) };
  } catch { return null; }
}

// WORK WRITE (2026-11-06): Workplace v1 (likhai) ka asal kaam banane wala.
// freeChat wali hi keys/limit/usage ('llm' pool) — sirf system prompt alag:
// ye user se baat NAHI karta, seedha TAIYAAR likhai deta hai jo customer ko
// waisi ki waisi bheji ja sake. Brief dhundhla ho to 'CLARIFY:' wali ek line
// (worker customer se wahi sawal poochega). Fail par null.
const WORK_SYSTEM = `You are a professional Hindi/Hinglish copywriter inside RazzScale AI's workplace. You receive a writing order (kind + brief) and output ONLY the finished writing, ready to send to the customer as-is. No explanations, no "here is your text", no placeholders like [name]. Match the language of the brief (Hinglish Roman by default; Devanagari only if the brief is in Devanagari). Keep it natural, human and useful — never robotic, never a template feel. If the brief is too vague to write anything real, output a single line starting with "CLARIFY:" followed by the one question that must be asked first.`;
export async function workWrite(user, { kind, brief, business }) {
  try {
    const limit = Number(await getConfig('FREE_LLM_DAILY_LIMIT', 100));
    if (await usageToday(user.id, 'llm') >= limit) return null;
    if (!env.llmKeys.length) return null;
    const content = await llmCall([
      { role: 'system', content: WORK_SYSTEM },
      { role: 'user', content: `KIND: ${kind}\nBUSINESS: ${business || 'nahi diya'}\nBRIEF: ${brief}` },
    ], 60000);
    if (!content) return null;
    await logUsage(user.id, 'llm');
    return content;
  } catch { return null; }
}
