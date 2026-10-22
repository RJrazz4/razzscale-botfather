# ZERO-COST DEPLOYMENT MAP (Hero, 2026-10-23)
- **Database:** Supabase free project — botfather tables (public schema) + Evolution (apna schema) ek hi Postgres me.
- **Gateway (Evolution API):** Hugging Face Spaces (Docker, free CPU — 16GB RAM, port 7860). Render ke 512MB me Evolution nahi sambhalta; HF par aaram se chalega. 48h idle par sota hai — bot traffic/ping se jaga rahega.
- **BotFather (Node):** Render free Web Service (GitHub repo se auto-deploy). 15 min idle par sota hai; pehle message par ~30-50s me jagta hai (launch ke liye theek).
- **Code:** GitHub repo (RJrazz4) — Render wahi se pull karega.
- Master instance bot ke startup par khud banta hai (bootstrap). Pairing code: GET /admin/pair-master?key=<ADMIN_SECRET>.
