import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// SQLite layer (Architecture V2.1) — pg-compatible adapter.
// Handlers hamesha pool.query(sql, params) -> { rows } wale shape se baat karte hain;
// ye adapter $n placeholders, now(), interval, ::casts aur jsonb ko SQLite me translate karta hai.
// process.env seedha padha jata hai (env.js -> pool.js -> sqlite.js import chain me cycle na aaye).

export const dbMode = (process.env.DB_MODE || 'supabase').toLowerCase();
export const sqlitePath = process.env.SQLITE_PATH || './data/botfather.db';

const JSON_COLUMNS = new Set(['state', 'results', 'value']); // pg jsonb columns — read par object bankar milte the

const SCHEMA = `
create table if not exists global_config (
  key text primary key, value text not null, updated_at text not null default (datetime('now'))
);
insert or ignore into global_config (key, value) values
  ('ENABLE_PAYWALL','false'), ('PREMIUM_PRICE_INR','999'),
  ('MAX_ACTIVE_SESSIONS','40'), ('FREE_LLM_DAILY_LIMIT','100'), ('SCHEMA_VERSION','1');

create table if not exists users (
  id text primary key default (lower(hex(randomblob(16)))),
  wa_id text not null unique, display_name text,
  plan_status text not null default 'free', referred_by text, source text not null default 'direct',
  created_at text not null default (datetime('now')), last_seen_at text not null default (datetime('now'))
);
create table if not exists sessions (
  id text primary key default (lower(hex(randomblob(16)))),
  user_id text not null, instance_name text not null unique, bot_type text not null,
  status text not null default 'created', phone_number text, webhook_secret text not null,
  pair_issued_at text, created_at text not null default (datetime('now')), connected_at text, last_event_at text
);
create index if not exists idx_sessions_user on sessions(user_id);
create unique index if not exists uniq_pending_spawn_per_user
  on sessions(user_id) where status in ('created','awaiting_pair');
create index if not exists idx_sessions_instance on sessions(instance_name);
create table if not exists pending_messages (
  id integer primary key autoincrement, session_id text not null,
  from_wa text not null, body_text text, created_at text not null default (datetime('now'))
);
create table if not exists flow_state (
  user_id text not null, scope text not null, state text not null default '{}',
  expires_at text, primary key (user_id, scope)
);
create table if not exists usage_events (
  id integer primary key autoincrement, user_id text, feature text not null,
  units integer not null default 1, created_at text not null default (datetime('now'))
);
create index if not exists idx_usage_user_day on usage_events(user_id, created_at);
create table if not exists music_cache (
  query_hash text primary key, query_text text not null, results text not null,
  file_id text, created_at text not null default (datetime('now'))
);
create table if not exists payments (
  id text primary key default (lower(hex(randomblob(16)))), user_id text,
  amount_inr integer not null, status text not null default 'created', gateway_ref text,
  created_at text not null default (datetime('now')), paid_at text
);
create table if not exists active_ads (
  id text primary key default (lower(hex(randomblob(16)))), text text not null, link_url text,
  is_active integer not null default 1, priority integer not null default 0,
  starts_at text, ends_at text, created_at text not null default (datetime('now'))
);
insert or ignore into active_ads (id, text, link_url, priority) values
  ('seed-ad-1', '🚀 Pro Feature: Apne bot se Bulk Messages + Auto Lead Generation chalao — VIP Tools menu me dekho!', null, 10);

-- V2.1 naye tables (plan §2.1)
create table if not exists media_vault (
  video_id text primary key, title text, file_id text not null, message_id integer,
  size integer, created_at text not null default (datetime('now'))
);
create table if not exists jobs (
  id integer primary key autoincrement, type text not null, payload text,
  status text not null default 'pending', attempts integer not null default 0,
  idempotency_key text unique, result text,
  created_at text not null default (datetime('now')), updated_at text not null default (datetime('now'))
);
create table if not exists paused_contacts (
  jid text primary key, paused_at text not null, reason text
);
create table if not exists sent_registry (
  message_id text primary key, instance_name text, jid text, sent_at text not null
);
create index if not exists idx_sent_registry_at on sent_registry(sent_at);
create table if not exists processed_messages (
  id text primary key, ts text not null
);
create table if not exists ad_impressions (
  jid text not null, day text not null, count integer not null default 0,
  primary key (jid, day)
);
create table if not exists vault_meta (key text primary key, value text);

-- Plan §2.1 ke naam maujood canonical tables par views ke roop me (state ek hi jagah rehta hai)
create view if not exists chat_state as select user_id, scope, state, expires_at from flow_state;
create view if not exists subbots as select * from sessions;
create view if not exists settings as select key, value, updated_at from global_config;
`;

let _db = null;
export function getDb() {
  if (_db) return _db;
  const dir = path.dirname(path.resolve(sqlitePath));
  fs.mkdirSync(dir, { recursive: true });
  _db = new Database(sqlitePath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA);
  _db.pragma('user_version = 1'); // schema_version — aage ke migrations isi par badhenge
  return _db;
}

// Boot se pehle: local .db missing/empty ho to restoreFn (Telegram vault) se latest backup le aao.
// Non-fatal — restore fail ho to fresh DB se boot hoga.
export async function prepareDatabase(restoreFn) {
  if (dbMode !== 'sqlite') return false;
  try {
    if (fs.existsSync(sqlitePath) && fs.statSync(sqlitePath).size > 0) return false;
    if (!restoreFn) return false;
    const ok = await restoreFn(sqlitePath);
    if (ok) console.log('[sqlite] DB vault se restore ho gayi');
    return !!ok;
  } catch (e) { console.error('[sqlite] prepareDatabase:', e?.message || e); return false; }
}

// better-sqlite3 ka safe online backup (live file ki raw copy NAHI — plan §2.3)
export async function backupToFile(destPath) {
  const db = getDb();
  fs.mkdirSync(path.dirname(path.resolve(destPath)), { recursive: true });
  if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
  await db.backup(destPath);
  return destPath;
}

// ---------- pg -> SQLite translation ----------
function translate(text, params) {
  let sql = String(text);
  // setFlow shape: now() + ($n || ' seconds')::interval  ->  datetime('now', $n || ' seconds')
  // (modifier string apne aap signed hoti hai — '600 seconds' / '-5 seconds' dono chalte hain;
  //  '+' || $n wala roop negative TTL par '+-5 seconds' banakar NULL de deta tha)
  sql = sql.replace(/now\(\)\s*\+\s*\(\s*\$(\d+)\s*\|\|\s*' seconds'\)::interval/gi,
    "datetime('now', $$$1 || ' seconds')");
  // now() - interval '10 minutes'
  sql = sql.replace(/now\(\)\s*-\s*interval\s*'([^']+)'/gi, "datetime('now', '-$1')");
  sql = sql.replace(/date_trunc\('day',\s*now\(\)\)/gi, "date('now')");
  sql = sql.replace(/now\(\)/gi, "datetime('now')");
  sql = sql.replace(/::(int|integer|bigint|smallint|jsonb|json|text|uuid|timestamptz|timestamp|boolean|bool|float|numeric|real)\b/gi, '');
  sql = sql.replace(/\btrue\b/gi, '1').replace(/\bfalse\b/gi, '0');
  // $n -> ? (har occurrence ke liye value dobara bind hoti hai — pg reuse semantics)
  const values = [];
  sql = sql.replace(/\$(\d+)/g, (_, n) => { values.push(bindValue(params[Number(n) - 1])); return '?'; });
  const hasParams = /\$\d+/.test(String(text));
  return { sql, values: hasParams ? values : (params || []).map(bindValue) };
}
function bindValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
}
function parseRow(row) {
  if (!row) return row;
  for (const k of Object.keys(row)) {
    if (JSON_COLUMNS.has(k) && typeof row[k] === 'string') {
      try { row[k] = JSON.parse(row[k]); } catch { /* plain text hi rehne do */ }
    }
  }
  return row;
}

async function sqliteQuery(text, params = []) {
  const raw = String(text).trim().toLowerCase();
  if (raw === 'begin' || raw === 'commit' || raw === 'rollback') {
    const db = getDb();
    if (raw === 'begin' && !db.inTransaction) db.exec('BEGIN');
    if (raw === 'commit' && db.inTransaction) db.exec('COMMIT');
    if (raw === 'rollback' && db.inTransaction) db.exec('ROLLBACK');
    return { rows: [] };
  }
  if (/pg_advisory/.test(raw)) return { rows: [] }; // single-process sync engine me lock ki zaroorat nahi
  const { sql, values } = translate(text, params);
  const stmt = getDb().prepare(sql);
  if (/returning/i.test(sql) || stmt.reader) {
    const rows = stmt.all(...values).map(parseRow);
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(...values);
  return { rows: [], rowCount: info.changes };
}

export function createSqlitePool() {
  return {
    query: (text, params) => sqliteQuery(text, params),
    // spawner ke transaction block ke liye pg-client jaisa surface (release no-op)
    connect: async () => ({
      query: (text, params) => sqliteQuery(text, params),
      release: () => {},
    }),
  };
}
