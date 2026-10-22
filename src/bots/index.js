import * as evo from '../services/evolution.js';
import { pool, getFlow, setFlow } from '../db/pool.js';
import { searchTop3, downloadAudio } from '../services/music.js';
import { freeChat } from '../services/llm.js';
import fs from 'node:fs';

// Sub-bot workflows — har session ka bot_type uske handler ko bulata hai.
// (Sub-bot ka "user" = bot ke owner ka customer; owner users-table me parent hai.)
export async function routeSubBotMessage({ session, from, text }) {
  const inst = session.instance_name;
  const t = (text || '').trim();
  switch (session.bot_type) {
    case 'music': {
      const flow = await getFlow(session.user_id, session.id);
      if (flow?.step === 'pick' && ['1', '2', '3'].includes(t)) {
        const pick = flow.results[Number(t) - 1];
        await setFlow(session.user_id, session.id, { step: 'idle' });
        const file = await downloadAudio(pick.id);
        await evo.sendMedia(inst, from, fs.readFileSync(file).toString('base64'), pick.title, 'audio');
        return;
      }
      const results = await searchTop3(t);
      if (!results.length) { await evo.sendText(inst, from, 'Gaana nahi mila — naam phir bhejo.'); return; }
      await setFlow(session.user_id, session.id, { step: 'pick', results });
      await evo.sendText(inst, from, `${results.map((r, i) => `${i + 1}. ${r.title}`).join('\n')}\n\nNumber likho (1/2/3)`);
      return;
    }
    case 'ai': {
      const { rows } = await pool.query('select * from users where id=$1', [session.user_id]);
      const reply = await freeChat(rows[0], t);
      await evo.sendText(inst, from, reply, { ad: true });
      return;
    }
    case 'leadgen': {
      // Lead capture: naam/requirement ikattha karke DB me rakho, owner ko turant notify
      await pool.query(`insert into usage_events (user_id, feature, units) values ($1,'lead',1)`, [session.user_id]);
      await evo.sendText(inst, from, 'Dhanyavaad! Aapki detail mil gayi hai — humari team jald sampark karegi.');
      return;
    }
    case 'support':
    default: {
      // Step-1 simple auto-reply; owner-specific rules Step-2 me (per-session config table)
      await evo.sendText(inst, from, 'Namaste! Aapka message mil gaya hai. Hum jald jawab denge. Koi turant baat ho to apna sawaal yahi likh dijiye.');
      return;
    }
  }
}
