# RAZZSCALE BOTFATHER — CONSOLIDATED MASTER PLAN
_Ek hi jagah pura sach. Taiyaar: 2026-10-24 (Strider, Hero ke orders par). Purane alag-alag plans (MASTER-PLAN.md, FRONTEND-BRIEF-PLAN.md, hybrid logic) ka mila-jula FINAL naksha. Jahan purani baat isse takraye, YAHI wala chalega._

## 1. Product ek line me
WhatsApp par ek premium dukaan (RazzScale AI BotFather): saamne music + free seva, peeche automation ki dukaan — har feature TAP se khulta hai, type karna sirf wahan jahan bina type kaam na ho (gaane ka naam, AI se baat, apni requirement).

## 2. Jo LIVE hai (2026-10-24)
- **Tap-first frontend:** Music-first home menu (Music Zone → AI Chat → VIP → Apna Bot Banao), Music Zone categories (Trending/Bollywood/Punjabi/Phonk/Devotional/Discover = asal preset searches), har list ke saath number/keyword fallback, Back/Main Menu har jagah, koi dead end nahi.
- **VIP consultation:** service chuno → (Social: platform + features / Website: type) → 2 chhote sawal → Summary (jo na diya ho: "nahi diya") → Confirm/Edit/Cancel → Confirm par Lead ID + **human mode** (bot us chat se peeche, insaan baat karega).
- **AI Chat:** continuous mode; dimag = Master Instruction (abhi DRAFT text — Hero ki apni lines pending).
- **Features:** kaam ke dauraan typing…/recording… live signal; public jagah par personal number NAHI (footer/menu/VIP/handoff sab master number par); download fail par YouTube link.
- **Neeche ki machine (V2.1):** SQLite + Telegram tijori (validated restore — kharab file kabhi andar nahi), input router + async worker, sent-registry auto-pause (owner haath se likhe to bot 12h peeche), ad daily cap, webhook dedup, self-heal.
- **Number sach:** master number dost ka hai (testing); asal privacy design se aati hai, chhupane se nahi.

## 3. HYBRID MODEL (Hero, 2026-10-24 — logic approve-pending, code deploy NAHI)
- **Official WhatsApp Cloud API = saamne ki dukaan:** native lists/buttons har phone par, Business Profile (naam, logo, verified tick), 24h service window me jawab muft. Router 100% deterministic — menu/navigation par LLM token ZERO; AI sirf AI-Chat state me.
- **Evolution API = peeche ka engine:** sub-bot spawning, pairing/QR, bhaari media ki taiyaari, presence signals. User ke saamne kabhi nahi — pairing code bhi Official wali chat me hi milega.
- **Ek router, do darwaze:** Cloud webhook (/webhook/cloud) aur Evolution webhook dono ek hi common event {kaun, kya dabाया, action ID} banakar usi live router/state-machine ko dete hain — action IDs 1:1 wahi.
- **Kadve sach (locked):** (1) Ek number dono par ek saath NAHI chal sakta → front ke liye NAYA dedicated number lagega; dost ka number engine/test par rahega. (2) Template/marketing messages par per-message charge; user-shuru chats window me muft. (3) Official par 'recording' signal nahi (typing hai). (4) Gaana Official wali chat se hi jayega (dusri chat = confusion).
- **Agla kadam (Hero ki manual approval ke baad hi):** Meta Business setup (Hero ke documents/login wale kadam Strider guide karega) → server par /webhook/cloud darwaza → naye number par front cutover. Tab tak live bot jaisa hai waisa.

## 4. FAST MUSIC v2 (Hero, 2026-10-24 — BUILD HO GAYA, LOCAL VERIFIED; deploy parent karega)
- **Primary search: seedha JioSaavn SOURCE** (www.jiosaavn.com/api.php) — koi wrapper NAHI. ⚠️ Wajah: pehle socha gaya wrapper **saavn.dev probe me mara hua mila** (empty reply), jabki source khud 1–2s me asal JSON deta hai; Hero ne option confirm kiya — bina bichauliye ke, seedha source.
- **Chain (sab probe-verified 2026-10-24):** `search.getResults` → gaane ki ID + `encrypted_media_url` → open-source ecosystem ka documented DES decrypt (key '38346591', EDE3-ECB tareeke se) → asal CDN URL → quality swap _96→_160/_320 teeno par asal audio bytes mile. `song.getDetails` (batch pids bhi) se ID par taaza URL kabhi bhi.
- **24h cache:** gaane ka metadata + URL local cache (saavn_cache) me 24h. ⚠️ Sudhaar (design me pakka): JioSaavn ke download URL time-limited hote hain — isliye URL 45 minute se purana ho to bhejne se pehle gaane ki ID se taaza URL ayega; metadata 24h rahega.
- **Trending 50 pre-cache:** server start ke ~30s baad + roz ek baar — launch data → 'Trending' chart playlist (probe me 48 gaane mile) ke metadata/URL pehle se cache me. Poore gaane pehle se download NAHI (free server ki seema) — pehli asli request par gaana tijori (vault) me jaakar hamesha ke liye fast.
- **Delivery chain:** pehle tijori (vault, key `saavn:<id>`) → phir taaza URL seedha send (disk par save kiye bina; 16MB se bada ho to pehle quality girakar) → buffer download → yt-dlp fallback SABSE aakhir me. 'Recording…' signal ke saath, nishana 2–3 second.
- **Risk note:** JioSaavn ka api.php bhi ek unofficial raasta hai — badal/band ho sakta hai; isiliye fallback chain kabhi nahi tootegi (vault + yt-dlp hamesha peeche khade). Kuch gaane DRM/Pro-only hote hain (URL nahi banta) — woh search list me dikhte hi nahi, taaki user dead gaana na chune.

## 5. Paise/Disha
- Launch FREE; paywall toggle dormant (ENABLE_PAYWALL=false) — Hero ke bole bina ON nahi.
- Funnel: muft music/seva → bharosa → VIP consultation → Lead ID ke saath insaani baat → Boss (Hero) kaam band karta hai. Bot action-wala kaam KHUD kabhi nahi karta/vaada nahi karta (Master Instruction ki rooh).

## 6. Khule faisle (sirf Hero ke)
1. Master Instruction ki Boss-line: AI ke jawab me personal number jaye ya human-mode line ("isi chat me likho")? — options bhej diye gaye hain.
2. Hybrid front ke liye naya number kab lena hai (Phase-1 wahi se shuru).
3. Master Instruction me Hero ki apni lines (draft abhi live hai).

## 7. Kabhi nahi badlega
- Tap-only ka niyam (upar §1). Footer sirf menu + gaana delivery par. No nakli data, no jhoota "ho gaya" dawa. Live-check bina koi offer/claim nahi. Zero-cost server line (pehle kamaai tak Render free).
