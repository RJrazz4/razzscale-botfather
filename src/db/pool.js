import 'dotenv/config';

// DB layer selector (Architecture V2.1): DB_MODE=sqlite -> local SQLite (better-sqlite3 adapter),
// warna default Supabase/Postgres (pg). Saare helpers aur query shapes dono modes me ek jaise chalte hain.
export const dbMode = (process.env.DB_MODE || 'supabase').toLowerCase();
let poolImpl;
if (dbMode === 'sqlite') {
  const { createSqlitePool } = await import('./sqlite.js');
  poolImpl = createSqlitePool();
} else {
  const pg = (await import('pg')).default;
  poolImpl = new pg.Pool({ connectionString: process.env.DATABASE_URL });
}
export const pool = poolImpl;

export async function upsertUser(waId, displayName, source = 'direct', referredBy = null) {
  const { rows } = await pool.query(
    `insert into users (wa_id, display_name, source, referred_by)
     values ($1,$2,$3,$4)
     on conflict (wa_id) do update set last_seen_at = now(),
       display_name = coalesce(excluded.display_name, users.display_name)
     returning *`,
    [waId, displayName || null, source, referredBy]);
  return rows[0];
}
export async function getSessionByInstance(instanceName) {
  const { rows } = await pool.query('select * from sessions where instance_name = $1', [instanceName]);
  return rows[0] || null;
}
export async function setFlow(userId, scope, state, ttlSec = 600) {
  await pool.query(
    `insert into flow_state (user_id, scope, state, expires_at)
     values ($1,$2,$3, now() + ($4 || ' seconds')::interval)
     on conflict (user_id, scope) do update set state = excluded.state, expires_at = excluded.expires_at`,
    [userId, scope, JSON.stringify(state), String(ttlSec)]);
}
export async function getFlow(userId, scope) {
  const { rows } = await pool.query(
    'select state from flow_state where user_id=$1 and scope=$2 and (expires_at is null or expires_at > now())',
    [userId, scope]);
  return rows[0]?.state || null;
}
export async function logUsage(userId, feature, units = 1) {
  await pool.query('insert into usage_events (user_id, feature, units) values ($1,$2,$3)', [userId, feature, units]);
}
export async function usageToday(userId, feature) {
  const { rows } = await pool.query(
    `select coalesce(sum(units),0)::int as n from usage_events
     where user_id=$1 and feature=$2 and created_at >= date_trunc('day', now())`, [userId, feature]);
  return rows[0].n;
}
