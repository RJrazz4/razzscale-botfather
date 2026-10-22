# RazzScale AI BotFather — Step 1

**Kya bana hai:** Master Bot menu (4 options) + Auto-Session Spawner (bot type → Evolution instance → pairing code → connect par bot live) + branded sender + paywall toggle gate (abhi OFF = sab free) + music search/audio + free AI chat + Meta AI image redirect.

## Chalane ke kadam
1. Postgres me `db/schema.sql` chalao (ya Supabase SQL editor me paste karo).
2. Evolution API self-host karo (Docker: atendai/evolution-api) — `.env` me `EVOLUTION_BASE_URL` + `EVOLUTION_API_KEY` bharo.
3. Master instance banao (naam `.env` ke `MASTER_INSTANCE` jaisa) aur uska webhook `PUBLIC_BASE_URL/webhook/evolution` par lagao. Baki saare instances ke webhooks spawner khud lagata hai.
4. `npm install && npm start`
5. Master number par "Hi" bhejo — menu aayega.

## Note
- Menu interactive list ke saath numbered-text fallback hamesha rakhta hai (unofficial clients par list kabhi kabhi fail hoti hai).
- Har outgoing message `branding.js` se hokar jata hai — footer (⚡ Powered by RazzScale AI + Master link) hardcode.
- Paywall: `global_config` me `ENABLE_PAYWALL=false`. ON karna = ek UPDATE query; YouPI module `src/payments/youpi.js` me dormant hai.
