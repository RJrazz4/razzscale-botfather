# FRONTEND BRIEF — IMPLEMENTATION PLAN (naksha)

**Source:** Hero ke dusre AI ka "RAZZSCALE AI BOTFATHER — FRONTEND IMPLEMENTATION BRIEF V1.0" (reviewed + build order 2026-10-24).
**Scope:** brief ki har screen → humare flow-state / action-ID mapping. Code isi nakshay ke hisaab se bana hai.
**Status:** IMPLEMENTED (local). Deploy is phase me NAHI.

---

## 1. Brief ki screens → humare states

| # | Brief screen | Flow state (scope 'master') | Entry action(s) | Pehle se tha / naya |
|---|---|---|---|---|
| 1 | Welcome / Home Menu | `menu` | greeting keywords, `nav_menu`, session start | THA (decorative menu + list) → **NAYA order**: music-first, 4 rows |
| 2 | Music Zone | `music_zone` | `mz` / text `1` / keyword `music` | **NAYA** — category list |
| 3 | Music Category Results | `music_pick` (from='category') | `cat_<key>` tap | THA pipeline (search+pick) → category = preset query |
| 4 | Track Details / Playback | `music_busy` → `music_done` | number / result rowId | THA (worker delivery) → **NAYA** busy guard + fail par YouTube link |
| 5 | AI Chat Entry | `ai_chat` | `ai` / text `2` / keyword `chat` | THA (job queue) → continuous mode + Master Instruction wired |
| 6 | VIP Action Automation | `consult_svc` | `vip` / text `3` / purana `m5` | **NAYA state machine** (`src/handlers/consult.js`); purana static pitch (`vip_pick`) backward-compat me rehta hai |
| 7 | Social Media Automation | `consult_plat` → `consult_feat` | `vip_svc_4` | **NAYA** (consult ke andar) |
| 8 | Website / Custom AI Agent | `consult_web` | `vip_svc_3` | **NAYA** (consult ke andar) |
| 9 | Project Summary & Confirmation | `consult_q1` → `consult_q2` → `consult_summary` | auto (sawalon ke baad) | **NAYA** |
| 10 | Owner WhatsApp Handoff | confirm ke baad, state `menu` | `cf_confirm` | **NAYA** — Lead ID + prefilled wa.me link |
| 11 | Error / Empty / Loading / Back / Cancel | sab states | `nav_back`, `nav_menu`, `cf_cancel` | Empty state music me **NAYA**; baaki maujooda patterns |

Image Generation (purana menu option 4) brief ke home me NAHI hai — feature mara nahi hai: action `image`
(purana `m4`) par Meta AI redirect barkarar; text fallback MENU_TEXT me hint line hai.

## 2. Action ID registry (har interactive element = defined ID)

- **Home:** `mz` Music Zone · `ai` AI Chat · `vip` VIP Consultation · `mk` Apna Bot Banao
- **Categories:** `cat_trending` `cat_bollywood` `cat_punjabi` `cat_phonk` `cat_devotional` `cat_discover` `cat_search`
- **Nav (har jagah):** `nav_back` · `nav_menu` — global, state dispatch se PEHLE handle hote hain
- **Music results:** `'1'..'8'` (dikhaye hue numbers) · `more` · post-audio: `lyrics` · `music_new` · `menu` (teeno pehle se)
- **Spawn:** bot-type rows `'1'..'4'` (state-scoped, pehle se)
- **Consult:** `vip_svc_1..6` · `soc_plat_1..5` · `soc_feat_1..7` + `soc_feat_done` · `web_type_1..6` · `q_skip` · `cf_confirm` `cf_edit` `cf_cancel`
- **Purane rowIds (purani chats me pade hue) → naye equivalents (dead end kahin nahi):**
  `m1`→`mk` · `m2`→`mz` · `m3`→`ai` · `m4`→`image` · `m5`→`vip` · (purana `music_new` bhi ab `mz` par map)

## 3. WhatsApp platform limits (design inhी par bandha hai)

- Ek list message = **max 10 rows total** (saari sections milakar) — nav rows gin kar budget rakha hai.
- Row title **≤24 chars**, description **≤72 chars** — `clampListTitle/clampListDesc` sendList ke andar pehle se enforce hai; builders bhi chhote titles rakhte hain.
- List har client par render nahi hoti → **har list ke saath text fallback lazmi** (numbered/keyword inputs har state me chalte hain).
- Message-edit nahi hota — har screen ek naya message hai (isiliye state hamesha DB flow me).

**Row budget per screen:** Home 4 (nav nahi chahiye) · Music Zone 8 (6 categories + Search + Main Menu) · Category/search results list:
hamesha sirf **pehla page (3 tracks)** + More (agar ho) + Back + Main Menu = ≤6 — page badhne par list NAHI bhejta (chat spam rokne ke
liye; numbered text hi page dikhata hai, number-tap har dikhaye track par chalta hai) · Post-audio 3 · Consult svc 7 (6+Menu) ·
Social plat 6 (5+Menu) · Social feat: sirf pehle 6 features + Done + Menu = 8 (7th feature "Full workflow" text keyword se bhi
chun sakte hain — feat list ke neeche text me saaf likha hai) · Web types 7 (6+Menu) · Sawal screens 2 (Skip + Menu) · Summary 4
(Confirm/Edit/Cancel/Menu).

## 4. Category → REAL preset search (nakli catalog NAHI)

| Action | Preset query (existing `searchSongs(q, 8)`) |
|---|---|
| `cat_trending` | `latest trending songs india` |
| `cat_bollywood` | `bollywood latest hits` |
| `cat_punjabi` | `punjabi latest hits` |
| `cat_phonk` | `phonk music` |
| `cat_devotional` | `bhakti bhajan` |
| `cat_discover` | `viral songs india` |
| `cat_search` | typed search prompt (maujooda `music_query` state) |

"Imaandari" note: yt-dlp search ke results hain — "Trending" ka label search-based hai, koi official charts API nahi.
Results असली YouTube tracks hi hain; download/vault pipeline maujooda hai.

## 5. Music flow (states)

```
music_zone --cat_*--> [search] --> music_pick --number--> music_busy --worker ok--> music_done
     ^                        |            |                      |                      |
     |                        |            +-- more (pages)       +-- fail: text +        +-- lyrics / music_new / menu
     +------- nav_back -------+            +-- nav_back -> zone   YouTube link + actions
music_query (typed search) --text--> [search] --> music_pick (from='search'; nav_back -> music_query prompt)
music_pick par 0 results -> EMPTY state: saaf message + list [cat_search, nav_back(zone), nav_menu]
music_busy: koi bhi music input -> sirf "Gaana aa raha hai…" (dusra job NAHI); nav/menu chalega
```

## 6. Consult flow (states — handlers/consult.js)

```
vip -> consult_svc
  vip_svc_1/2/5/6 (Bot / Workflow / AI Agent / Custom) -----> consult_q1
  vip_svc_3 (Website) -> consult_web --web_type_*--> consult_q1
  vip_svc_4 (Social)  -> consult_plat --soc_plat_*--> consult_feat --soc_feat_* (toggle) --soc_feat_done--> consult_q1
consult_q1: "Business ka naam?" (text ya q_skip) -> consult_q2: "Requirement 1-2 line me" (text ya q_skip)
consult_q2 -> consult_summary: saaf summary, missing = "nahi diya" (andaza kabhi nahi)
  cf_confirm -> leads table me row + Lead ID (RS-<base36>) + handoff message (wa.me link, prefilled:
                Lead ID + service + summary, URL-encoded) + imaandari line (link khulega, Send wahan dabana hoga)
  cf_edit    -> consult_q1 dobara (purane jawab state me bhare hue; text jawab naye se replace, skip = purana rakho)
  cf_cancel  -> "radd kar diya" + home menu
Nav: consult_* se nav_back -> ek kadam peeche (svc list / plat list / feat / web / q1 / q2 chain), nav_menu -> home.
```

**Lead storage:** `leads` table dono schemas me (`src/db/sqlite.js` SCHEMA + `db/schema.sql`):
`id text pk` (= Lead ID hi), `jid`, `user_id`, `service`, `answers` (json), `created_at`.
**Owner number:** config se — `env.ownerWaNumber` (env var `OWNER_WA_NUMBER`, default wahi number jo vip.js
me pehle se hai). masterWaLink master BOT ka apna link hai, owner handoff ke liye NAHI (alag cheez hai).

## 7. Speed logic (Hero ka "0.1 second" usool)

- Home / Music Zone / category / service — saare list builders **pure static functions** hain: koi search, koi LLM,
  koi extra DB call unke pehle nahi. Menu path par sirf session upsert + flow read/write (router ka maujooda <1s usool).
- Bhaari kaam (search, download, LLM) hamesha pehle ki tarah worker queue / async me — handler sirf ack deta hai.
- Imaandari: 0.1s = bot-side turant shuruaat. WhatsApp delivery ki asal speed network/Evolution par nirbhar hai.

## 8. Pehle se bana hai (chheda NAHI)

Music engine + vault + disk cache (`services/music.js`), worker + jobs + dedup/idempotency (`services/worker.js`),
webhook dedup + auto-pause + sent-registry (`handlers/sessionRouter.js`), footer rules (`middleware/branding.js` —
footer sirf menu + gaana delivery par), ad cap (`services/ads.js`), spawner + sub-bots (`services/spawner.js`,
`bots/index.js`), paywall dormant (`middleware/paywall.js`). AI chat job maujood hai — is build me sirf uska
system prompt Master Instruction se badla hai (`config/instruction.js` → `services/llm.js`).

## 9. Brief se alag jo karna pada (platform/sach ki wajah se)

1. Brief ke home me **Image Gen gayab** tha aur **Apna Bot Banao bhi nahi tha** — Hero ke faisle se `mk`
   home me barkarar hai; Image `image` action + text hint par zinda hai (home ki 4-row saaf rakhi).
2. Brief "frontend only / mock adapter" kehta hai — live bot par mock/nakli data mana hai (brief ki apni
   honesty rule), isliye categories asal preset searches par chalti hain, mock catalog NAHI bana.
3. Social features **7 hain, list budget 8** (6 features + Done + Menu) — 7th feature list se bahar,
   text keyword se available; features screen ke text me ye saaf likha hai.
4. Purana VIP static pitch flow (`vip_pick`, menu `5`) hataaya NAHI gaya — purani chats/states ke liye
   backward-compat me chal raha hai; naya entry consult hai.
5. Flow TTL maujooda 600s tha — lambe flows (consult/music) ke liye setFlow calls par 1800s rakha hai.
6. Master Instruction abhi **DRAFT** hai (Hero ki apni lines pending) — task ke order par wahi text
   `config/instruction.js` me laga hai; report me flag hai.
7. Master Instruction ke andar ke menu references (draft me purane 5-option menu ke hisaab se the)
   naye music-first home ke hisaab se align kiye gaye hain — warna bot user ko galat option batata.
   Baaki instruction text draft jaisa hi hai.
