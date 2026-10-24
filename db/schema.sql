-- RazzScale AI BotFather — Postgres schema (Supabase / koi bhi Postgres)
create extension if not exists pgcrypto;

-- Global switches (Master Toggle yahi rehta hai)
create table if not exists global_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into global_config (key, value) values
  ('ENABLE_PAYWALL', 'false'::jsonb),
  ('PREMIUM_PRICE_INR', '999'::jsonb),
  ('MAX_ACTIVE_SESSIONS', '40'::jsonb),
  ('FREE_LLM_DAILY_LIMIT', '100'::jsonb)
on conflict (key) do nothing;

-- Users (Master Bot ke users; har user = ek WhatsApp number)
create table if not exists users (
  id                 uuid primary key default gen_random_uuid(),
  wa_id              text not null unique,            -- 91XXXXXXXXXX (JID ka number part)
  display_name       text,
  plan_status        text not null default 'free' check (plan_status in ('free','premium')),
  referred_by        uuid references users(id),        -- viral loop tracking
  source             text not null default 'direct',   -- direct | subbot:<session_id> | channel
  created_at         timestamptz not null default now(),
  last_seen_at       timestamptz not null default now()
);

-- Sub-bot sessions (har user ka apna spawned bot)
create table if not exists sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  instance_name  text not null unique,                 -- Evolution instance name (rz-<userIdShort>)
  bot_type       text not null check (bot_type in ('support','ai','music','leadgen')),
  status         text not null default 'created'
                 check (status in ('created','awaiting_pair','connected','active','suspended','banned','deleted','failed')),
  phone_number   text,                                 -- sub-bot ka apna number (pair hone ke baad)
  webhook_secret text not null,
  pair_issued_at timestamptz,
  created_at     timestamptz not null default now(),
  connected_at   timestamptz,
  last_event_at  timestamptz
);
create index if not exists idx_sessions_user on sessions(user_id);
-- Ek user ka ek hi pending spawn (duplicate-spawn race ka bandobast)
create unique index if not exists uniq_pending_spawn_per_user
  on sessions(user_id) where status in ('created','awaiting_pair');
-- Connect hone se pehle aaye messages yahan buffer honge, activation par replay
create table if not exists pending_messages (
  id bigserial primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  from_wa text not null, body_text text,
  created_at timestamptz not null default now()
);
create index if not exists idx_sessions_instance on sessions(instance_name);

-- Menu/flow state (music top-3 selection, bot-create wizard, etc.)
create table if not exists flow_state (
  user_id    uuid not null references users(id) on delete cascade,
  scope      text not null,                            -- 'master' | session uuid
  state      jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  primary key (user_id, scope)
);

-- Usage / rate-limit ledger (free pool ki hifazat)
create table if not exists usage_events (
  id         bigserial primary key,
  user_id    uuid references users(id) on delete cascade,
  feature    text not null,                            -- 'llm' | 'music' | 'spawn' | 'image_redirect'
  units      int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists idx_usage_user_day on usage_events(user_id, created_at);

-- Music cache (popular gaane dobara download nahi)
create table if not exists music_cache (
  query_hash  text primary key,
  query_text  text not null,
  results     jsonb not null,                          -- top-3 [{id,title,duration,url}]
  file_id     text,                                    -- downloaded audio ka storage ref (nullable)
  created_at  timestamptz not null default now()
);

-- Payments (DORMANT — YouPI PG V2; table ready, module flag-gated off)
create table if not exists payments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id),
  amount_inr   int not null,
  status       text not null default 'created' check (status in ('created','pending','paid','failed','refunded')),
  gateway_ref  text,
  created_at   timestamptz not null default now(),
  paid_at      timestamptz
);

-- Dynamic Ad Engine (Hero, 2026-10-23): DB se control hone wale sponsored/teaser ads.
-- Feature-use wale messages me footer ke UPAR 1-2 line ka ad jata hai.
create table if not exists active_ads (
  id          uuid primary key default gen_random_uuid(),
  text        text not null,                          -- 1-2 lines (sponsored msg / pro teaser)
  link_url    text,                                   -- optional (tap karne par)
  is_active   boolean not null default true,
  priority    int not null default 0,                 -- zyada priority = pehle dikhega
  starts_at   timestamptz,
  ends_at     timestamptz,
  created_at  timestamptz not null default now()
);
insert into active_ads (text, link_url, priority) values
  ('🚀 Pro Feature: Apne bot se Bulk Messages + Auto Lead Generation chalao — VIP Tools menu me dekho!', null, 10)
on conflict do nothing;

-- ============ Architecture V2.1 tables (SQLite mode canonical hai; pg fallback ke liye yaha bhi) ============
-- Telegram media vault: gaana ek baar fetch -> file_id yaha, dobara yt-dlp nahi
create table if not exists media_vault (
  video_id   text primary key,
  title      text,
  file_id    text not null,
  message_id bigint,
  size       bigint,
  created_at timestamptz not null default now()
);
-- Async jobs (router/worker) — idempotency_key unique: ek kaam do baar nahi bhejta
create table if not exists jobs (
  id              bigserial primary key,
  type            text not null,
  payload         jsonb,
  status          text not null default 'pending',
  attempts        int not null default 0,
  idempotency_key text unique,
  result          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_jobs_status on jobs(status, id);
-- Manual chat auto-pause (owner master number se khud likhe to us contact ke liye bot band)
create table if not exists paused_contacts (
  jid       text primary key,
  paused_at timestamptz not null default now(),
  reason    text
);
-- Bot ke bheje messages ki registry (fromMe pehchan: bot ka send vs owner ka manual)
create table if not exists sent_registry (
  message_id   text primary key,
  instance_name text,
  jid          text,
  sent_at      timestamptz not null default now()
);
-- Webhook dedup (redelivered message do baar process nahi)
create table if not exists processed_messages (
  id text primary key,
  ts timestamptz not null default now()
);
-- Ad daily cap ginoti (per contact per day; footer cap se bahar hai)
create table if not exists ad_impressions (
  jid   text not null,
  day   date not null,
  count int not null default 0,
  primary key (jid, day)
);
-- VIP consultation leads (FRONTEND BRIEF): confirm par ek row; id = Lead ID (RS-<base36>)
create table if not exists leads (
  id         text primary key,
  jid        text,
  user_id    text,
  service    text,
  answers    jsonb,
  created_at timestamptz not null default now()
);
