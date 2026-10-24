import fs from 'node:fs';
import path from 'node:path';

// Telegram Vault (Architecture V2.1, plan §2): private channel = media storage + DB backup ghar.
// Token sirf env (TELEGRAM_BOT_TOKEN) se aata hai — kabhi log nahi hota.
// Token na ho to HAR function graceful no-op hai — bot bina vault ke bhi pura chalta hai.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const VAULT_CHAT = process.env.TELEGRAM_VAULT_CHAT_ID || '';
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
let warned = false;
// Restore par reject hui pinned file ka message_id — agla successful backup use
// unpin karke hata dega (warna har boot par wahi kharab file wapas aati rahegi).
let rejectedPinnedMsgId = null;
export function getRejectedPinnedMsgId() { return rejectedPinnedMsgId; }

export function vaultEnabled() { return Boolean(TOKEN && VAULT_CHAT && API); }
function off() {
  if (!warned) { warned = true; console.log('[telegram] vault disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_VAULT_CHAT_ID missing) — no-op mode'); }
  return false;
}

async function tgCall(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) throw new Error(`telegram ${method} failed: ${json?.description || res.status}`);
  return json.result;
}

// File ko vault channel (ya kisi chat) me document ke roop me bhejo -> { file_id, message_id }
export async function uploadFile(chatId, filePath, caption = '') {
  if (!vaultEnabled()) return off() && null;
  try {
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([buf]), path.basename(filePath));
    const res = await fetch(`${API}/sendDocument`, { method: 'POST', body: form });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) throw new Error(`telegram sendDocument failed: ${json?.description || res.status}`);
    const doc = json.result?.document || json.result?.audio || json.result?.video || {};
    return { file_id: doc.file_id || null, message_id: json.result?.message_id || null };
  } catch (e) { console.error('[telegram] uploadFile:', e?.message || e); return null; }
}

// file_id se file download karke destPath par rakho -> true/false
export async function downloadByFileId(fileId, destPath) {
  if (!vaultEnabled()) return off() && false;
  try {
    const file = await tgCall('getFile', { file_id: fileId });
    if (!file?.file_path) return false;
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(path.resolve(destPath)), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return true;
  } catch (e) { console.error('[telegram] downloadByFileId:', e?.message || e); return false; }
}

// Boot restore helper (server.js -> sqlite.prepareDatabase): pinned .db download karke destPath par rakho.
// Pinned file ko live DB banane se PEHLE validate karte hain — pinned message asal SQLite na ho
// (galat/ purani test file pin ho gayi ho) to reject; warna ek kharab file har boot par wapas aakar
// "file is not a database" se bot ko maar deti hai.
export async function restoreDbFile(destPath) {
  if (!vaultEnabled()) return off() && false;
  try {
    const chat = await tgCall('getChat', { chat_id: VAULT_CHAT });
    const pinned = chat?.pinned_message;
    const doc = pinned?.document;
    if (!doc?.file_id) return false;
    const tmp = destPath + '.restore-tmp';
    const ok = await downloadByFileId(doc.file_id, tmp);
    if (!ok) return false;
    const { validateSqliteFile } = await import('../db/sqlite.js');
    if (!validateSqliteFile(tmp)) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      if (pinned.message_id) rejectedPinnedMsgId = pinned.message_id;
      console.error('[telegram] pinned backup invalid — fresh DB se shuru');
      return false;
    }
    // Purane DB ke bache hue sidecar nayi file ko kharab na karein
    for (const suf of ['-wal', '-shm']) { try { fs.unlinkSync(destPath + suf); } catch { /* na ho to ignore */ } }
    fs.renameSync(tmp, destPath);
    console.log('[telegram] DB backup pinned message se restore hua');
    return true;
  } catch (e) { console.error('[telegram] restoreDbFile:', e?.message || e); return false; }
}

// DB backup: safe snapshot (sqlite backup API) -> vault upload -> naya pin, purana unpin.
// Sirf DB_MODE=sqlite me; state vault_meta table me (sqlite direct, lazy import — cycle-free).
export async function backupDatabase() {
  if (!vaultEnabled()) return off() && false;
  if ((process.env.DB_MODE || 'supabase').toLowerCase() !== 'sqlite') return false;
  const tmp = path.join('/tmp', `botfather-backup-${Date.now()}.db`);
  try {
    const { getDb, backupToFile, validateSqliteFile } = await import('../db/sqlite.js');
    const db = getDb();
    // Snapshot se pehle jobs saaf (plan §2.3 fix #3): running ko failed mark, khatm hue hatao —
    // restore ke baad koi job dobara nahi chalega. processed_messages (dedup) barkarar rehta hai.
    db.prepare("update jobs set status='failed' where status='running'").run();
    db.prepare("delete from jobs where status in ('done','failed')").run();
    await backupToFile(tmp);
    // Snapshot khud validate karo — invalid file kabhi vault me upload/pin NAHI hogi
    // (warna wahi kharab file har restore par wapas aayegi).
    if (!validateSqliteFile(tmp)) {
      console.error('[telegram] backup snapshot invalid — upload/pin nahi hoga');
      return false;
    }
    const up = await uploadFile(VAULT_CHAT, tmp, `DB backup ${new Date().toISOString()}`);
    if (!up?.message_id) return false;
    const prev = db.prepare('select value from vault_meta where key = ?').get('last_backup_msg')?.value;
    await tgCall('pinChatMessage', { chat_id: VAULT_CHAT, message_id: up.message_id, disable_notification: true });
    // Purana pin hatao — pichla backup bhi, aur restore par reject hui kharab pinned file bhi
    // (usi ko replace karna is fix ka maksad hai; warna woh har boot par wapas aati).
    const toUnpin = new Set();
    if (prev) toUnpin.add(Number(prev));
    if (rejectedPinnedMsgId) toUnpin.add(Number(rejectedPinnedMsgId));
    for (const mid of toUnpin) {
      if (mid && mid !== up.message_id) {
        await tgCall('unpinChatMessage', { chat_id: VAULT_CHAT, message_id: mid }).catch(() => {});
      }
    }
    rejectedPinnedMsgId = null;
    db.prepare('insert into vault_meta (key, value) values (?,?) on conflict(key) do update set value=excluded.value')
      .run('last_backup_msg', String(up.message_id));
    console.log('[telegram] DB backup vault me pin ho gaya');
    return true;
  } catch (e) { console.error('[telegram] backupDatabase:', e?.message || e); return false; }
  finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

// Critical writes (naya sub-bot, settings change) ke baad turant backup — fire-and-forget safe.
export async function backupNow() { return backupDatabase(); }
