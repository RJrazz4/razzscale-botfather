import * as evo from './transport.js';
import * as graph from './graph-cloud.js';
import { env } from '../config/env.js';

// Boss (owner) ko khabar bhejne ki bandhi naali (2026-11-06, ⭐ escalation
// niyam): jo kaam bot nahi kar payega, uski khabar seedha Boss ke personal
// WhatsApp par jayegi — deal wahan se Boss close karega. Escalation, leads
// aur aage ke saare owner-alerts yahin se jayenge. Cloud par seedha owner
// ke number par; Evolution par owner ke JID par. Fail = false — caller
// sirf log kare, user ka flow owner-khabar par kabhi na atke.
export async function notifyOwner(inst, body, buttons) {
  try {
    if (inst === evo.CLOUD_INSTANCE) {
      if (buttons?.length) {
        const okBtn = await graph.sendButtons(env.ownerWaNumber, { body, buttons }).catch(() => false);
        if (okBtn) return true;
      }
      const ok = await graph.sendText(env.ownerWaNumber, body).catch(() => false);
      return !!ok;
    }
    await evo.sendText(inst, `${env.ownerWaNumber}@s.whatsapp.net`, body);
    return true;
  } catch { return false; }
}
