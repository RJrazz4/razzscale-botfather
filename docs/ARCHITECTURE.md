# ARCHITECTURE — RazzScale AI BotFather

## Folder Structure
```
razzscale-bot/
├── MASTER-PLAN.md            # Hero ka locked plan
├── docs/
│   └── ARCHITECTURE.md       # ye file (structure + schema summary)
├── db/
│   └── schema.sql            # Postgres schema (Supabase-ready)
├── src/
│   ├── server.js             # Express app: webhook router (master + per-session)
│   ├── config/
│   │   └── env.js            # env + global_config reader (ENABLE_PAYWALL, cache 30s)
│   ├── db/
│   │   └── pool.js           # pg pool + helpers (getUser, upsertSession, getConfig)
│   ├── services/
│   │   ├── evolution.js      # Evolution API client (create instance, webhook, pairing, send)
│   │   ├── spawner.js        # Sub-bot spawn state machine (CREATED→AWAITING_PAIR→CONNECTED→ACTIVE)
│   │   ├── music.js          # yt-dlp search (top-3) + audio download/cache
│   │   └── llm.js            # Free LLM chat (OpenRouter free models + failover + per-user rate limit)
│   ├── middleware/
│   │   ├── branding.js       # HAR outgoing message par footer (⚡ Powered by RazzScale AI + link)
│   │   └── paywall.js        # Feature gate: ENABLE_PAYWALL=false → sab free; true → plan_status check
│   ├── handlers/
│   │   ├── masterMenu.js     # Master Bot menu state machine (Hi → 4 options)
│   │   └── sessionRouter.js  # Incoming sub-bot msgs → bot_type ke handler par route
│   ├── bots/
│   │   ├── supportBot.js     # Auto-Reply/Support workflow (owner ke rules + fallback)
│   │   ├── aiBot.js          # AI Assistant workflow
│   │   ├── musicBot.js       # Music workflow (search→select→audio)
│   │   └── leadBot.js        # Lead Gen workflow (capture → sheet/DB → owner notify)
│   └── payments/
│       └── youpi.js          # DORMANT — YouPI PG V2 (flag-gated; abhi kabhi trigger nahi)
├── scripts/
│   └── seed-config.sql       # global_config defaults (ENABLE_PAYWALL=false …)
├── .env.example
├── package.json
└── README.md
```

## Design notes (Strider improvements)
1. **Gateway = Evolution API (primary).** OpenWA library-per-process hai; Evolution ek REST service hai — instance create/QR/pairing/webhook sab API se, multi-session ke liye bana hai.
2. **Menu = interactive-first, text-fallback hamesha.** Unofficial clients par list/button kabhi kabhi render nahi hote; har interactive ke saath numbered text menu bhi jayega ("1 likho" hamesha chalega).
3. **Spawn = state machine.** QR/pairing bhejna hi kaafi nahi — session CONNECT hone par hi bot_type bind + greeting jayegi; pehle se DB me status track hoga (warna aadhe-spawn hue bots ghumte rahenge).
4. **Ek VPS par session ceiling.** Har Baileys session RAM khata hai (~100–300MB). MAX_ACTIVE_SESSIONS cap + queue rakha hai — free launch par ye sabse pehle tootne wali cheez hai.
5. **Har send ek hi darwaze se.** branding.js wrapper ke bina koi send nahi — footer kabhi bhool nahi sakta, aur kal ko format ek jagah se badlega.

## Ox Alpha Bug-Hunt (2026-10-23) — 16 bugs, Strider Final Filter
FIXED abhi (Step-1): webhook secret verify · pending messages buffer+replay · QRCODE_UPDATED par QR owner ko · pairing resend ("naya code") · zombie sweeper (10 min) · duplicate-spawn partial unique index · spawn confirm step (number mera hai → HAAN) · greeting idempotency (conditional UPDATE) · payload normalizer · advisory-lock cap · media 16MB cap + download semaphore (3).
SELF-FOUND (Ox Alpha se bhi choota): spawner v1 me phone_number DB me save hi nahi ho raha tha — greeting kabhi jaati hi nahi. Fixed.
REJECTED: "flow-TTL orphan row" — humare flow me sessions row wizard ke AAKHRI step par banti hai, orphan ban hi nahi sakta.
STEP-2 PARKED (jaankari ke saath): webhook queue (BullMQ) crash-safety ke liye · multi-process par config-cache invalidation.

## Monetization Upgrades (Hero, 2026-10-23)
- **active_ads table + ads.js:** feature-use wale outgoing messages (AI chat, sub-bot replies) me footer ke upar 1–2 line ka sponsored/teaser ad — DB se kabhi bhi badla ja sakta hai (priority + date window + is_active).
- **VIP funnel (handlers/vip.js):** Menu option 5 = "🚀 Advanced Automation & VIP Tools" → 5 VIP features ki list → koi bhi select kare to dopamine pitch + Hero ke PERSONAL WhatsApp (wa.me/917205191890, pre-filled text sahi encode ke saath) ka deep link. Master Bot alag number par safe; garam clients seedha personal chat par close honge. Paywall ON hone par gate-hit bhi yahi pitch dega.
