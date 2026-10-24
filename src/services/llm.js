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
