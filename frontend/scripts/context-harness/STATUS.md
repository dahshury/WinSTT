# Context-Awareness Expansion — Status

Single source of truth for the dictation context-awareness work (capture → LLM compose prompt + Whisper initial_prompt). Consolidates the now-deleted scratch (`_PLAN.md`, `_DESIGN_OUTPUT.md`, `_TODO_apps.md`, inspector dumps). Durable detail also lives in `memory/project_context_harness.md` and `memory/project_context_json_restructure.md`.

Last verified: 2026-06-01. Gates: **`bun typecheck` 0 · 427 tests pass / 0 fail · biome clean · electron bundle compiles.**

---

## ✅ DONE (verified)

### 1. Context payload is flat JSON
`formatContextForPrompt` (`electron/lib/context-snapshot.ts`) emits a flat JSON object instead of labeled flat text — keys (all optional, empty ones omitted): `app · ide · url · window · field · selection · beforeCaret/afterCaret (or fieldText) · screen · screenOcr · clipboard · note`. `withContextPrefix` (`electron/ipc/llm.ts`) rules reference those JSON keys. `extractAsrPromptTail` (Whisper) is independent and untouched.

### 2. Depth — ~100 turns / long emails reach the model
- **Native** `electron/native/src/winstt-context.c`: `MAX_CONTEXT_CHARS 6000→24000`, `CARET_BEFORE_CHARS 4000→21000`, `CARET_AFTER_CHARS 1000→2000`. Rebuilt via `node scripts/native/build-winstt-context.cjs`.
- **Memory-safety:** the 3 context buffers + the selection `tmp` were **stack arrays** (~96 KB each at 24000) → converted to `static` (BSS) to avoid stack overflow. (Surfaced by an adversarial-review agent.)
- **Consumer buffer** `electron/lib/context-reader.ts`: `MAX_BUFFER_BYTES 1MB→4MB`. **Non-negotiable rule: raise the native cap ⇒ raise the consumer `maxBuffer`** — else a ~2.7 MB capture overflows Node `execFile` and the snapshot **silently drops to empty**.
- **LLM backstop** `context-snapshot.ts`: `CARET_BEFORE_LLM_MAX = 24000` (`clipTail` keeps the most-recent tail nearest the caret).
- **Proven live:** an 80-turn Discord DM (scrolled up) → native `--split` returned **9,457 chars** of `textBefore` (old cap truncated at ~6000).
- **Caveat:** apps virtualize their lists, so capture sees only the rendered slice; deep history must be on-screen. Product stays side-effect-free (no auto-scroll).

### 3. Multi-user awareness
- `withContextPrefix` instructs the model: a multi-speaker thread where `Alice:` / `@handle` / `by Bob:` denote the speaker and `You:` is the user — attribute prior turns, write as the user.
- Captured threads already carry per-author labels. Proven multi-author captures: **discord-server** (Master/Fancy/OoS), **facebook-feed** (multi-commenter post).

### 4. Harness — 8/8 surfaces capture clean
`scripts/context-harness/` drives the user's logged-in debug Chrome (CDP) and captures exactly what dictation sees.

| id | url | composeSelector | beforeCaret carries |
|---|---|---|---|
| gmail | mail.google.com | `[aria-label="Message Body"][role=textbox]` | full email being replied to |
| discord | discord.com/channels/@me | `div[role=textbox][aria-label^=Message]` | DM thread |
| discord-server | (fallback guild) | `div[role=textbox][aria-label^=Message]` | multi-author server channel (#general) |
| x | x.com/home | `[data-testid=tweetTextarea_0]` | home timeline |
| x-reply | x.com/home → tweet | `[data-testid=tweetTextarea_0]` | the tweet being replied to |
| facebook | facebook.com/messages | `div[role=textbox][contenteditable=true]` | Messenger conversation |
| facebook-feed | facebook.com | `div[role=textbox][contenteditable=true]` (`Comment as…`) | post + comment thread |
| whatsapp | web.whatsapp.com | `div[contenteditable=true][role=textbox]` | chat thread |

- **focus-miss guard** (`capture.ts` `ensureComposeFocused`): re-clicks + DOM `.focus()` the compose selector right before the UIA read; reports honest `✗ FOCUS MISS` instead of a false `✓` (Lexical/Draft editors don't focus on click alone). `focusMiss = !domFocused || elementName empty || elementName===windowTitle`.
- one Chrome **window** per app (CDP `Target.createTarget({newWindow:true})`); HWND-by-title (occlusion-proof); `--hwnd`-scoped UIA read (no OS-foreground forcing).

---

## 🔜 WHAT'S LEFT / follow-ups

1. **Apply in-product:** restart `bun dev` so the rebuilt `winstt-context.exe` + recompiled electron main (the `context-reader` 4MB `maxBuffer`) load — the native/reader changes are inert until then.
2. **Structured multi-user fields (deferred, optional):** add `participants[]` + `self` + `composeMode`/`replyTo`, and — behind a confidence gate — `conversation[{author,text}]`. Mine authors at the `ax-prune` layer BEFORE `denoiseForLlm` flattens newlines. Build only if real use shows the LLM failing on flat attribution (avoids fragile per-app parsing). General structure-first splitter + language-neutral fallback was specced; never per-app regex.
3. **Edge-case fixtures (specced, not all written):** empty composer; reply-vs-compose; very-long-thread **clip-DIRECTION** assertion (guard `clipTail` keeps the tail); RTL/LTR mixed; system/noise (calls/joins/reactions/ads/engagement counts); not-logged-in/skeleton; same-display-name participants.
4. **discord-server fixture caveat:** harness falls back to a hardcoded guild (`1497315608285544509`, "Project Bavard") because this account's servers live in collapsed folders the CDP rail won't surface; it tries the live rail snowflake first + self-heals. Repoint that id if the server is left/deleted. **Product path unaffected** — server channels use the same composer selector as DMs (which passes).
5. **App coverage roadmap (Wispr Flow parity)** — see the table below.

---

## 🗺️ App coverage roadmap (Wispr-Flow-parity target)

Two layers: the **product** (`winstt-context.exe`) reads the Windows UIA tree of *whatever window is focused* — web OR native — so it captures from any app that exposes a UIA text field, today. The **harness** is the WEB-only automated test/tuning tool; "harness-verified" means we've proven the capture for that app. So an app can be product-capturable before it's harness-verified.

Status legend: **✅ verified** (harness-proven) · **🟢 web-ready** (generic UIA/CDP path should work; add an `apps.ts` recipe to verify) · **🟦 native** (desktop UIA path — works in-product when focused; no web harness) · **🟧 canvas/OCR** (content painted to `<canvas>`; little/no UIA text → falls back to screenshot OCR, lower fidelity) · **⬜ planned**.

| App (user's list) | Surface | Status | Notes |
|---|---|---|---|
| Gmail | web | ✅ verified | reply composer + full email |
| Discord | web + native | ✅ verified | DM + server channel (multi-author) |
| Messenger / Facebook | web | ✅ verified | Messenger + feed-comment |
| WhatsApp | web + native | ✅ verified | web verified; native app via UIA |
| X (x.com) | web | ✅ verified | compose + reply |
| Outlook | web + native | 🟢/🟦 planned | outlook.com recipe; native via UIA |
| Slack | web + native | 🟢/🟦 planned | add `apps.ts` recipe |
| Teams | web + native | 🟢/🟦 planned | add recipe |
| Telegram | web (web.telegram.org) + native | 🟢/🟦 planned | add recipe |
| Snapchat | web (limited) + native | 🟢/🟦 planned | web composer limited |
| Instagram | web | 🟢 planned | DMs/comments recipe |
| ChatGPT | web | 🟢 planned | prompt composer |
| Claude.ai | web | 🟢 planned | prompt composer |
| GitHub | web | 🟢 planned | issue/PR/comment boxes |
| Notion | web + native | 🟢/🟦 planned | block editor |
| OneNote | web + native | 🟦/🟧 planned | native UIA; web canvas-ish |
| Zoom | native (+ web) | 🟦 planned | chat panel via UIA; little web text |
| Cursor | native (IDE) | 🟦 **IDE path live** | `cursor.exe` already in IDE matchers (code context, backticked identifiers) |
| VS Code | native (IDE) | 🟦 **IDE path live** | `code.exe` already in IDE matchers |
| Google Sheets | web | 🟧 planned | grid painted to canvas → OCR fallback |
| Figma | web | 🟧 planned | canvas surface → OCR fallback |
| Canva | web | 🟧 planned | canvas surface → OCR fallback |

**How to promote a 🟢 to ✅:** add a `HarnessApp` entry to `apps.ts` (DOM-inspect the live app via a throwaway CDP script → `composeSelector` + a `focus()` recipe mirroring the existing ones), then `bun run context:harness <id>` until `focusMiss:false`. Native (🟦) and canvas/OCR (🟧) apps are product-capturable when focused but need a separate Windows-UIA test driver (later phase) — the web harness can't drive them.

---

## Files changed (this effort)
- `electron/lib/context-snapshot.ts` — flat-JSON payload + `CARET_BEFORE_LLM_MAX=24000`
- `electron/ipc/llm.ts` — JSON-key rules + multi-speaker line
- `electron/lib/context-reader.ts` — `MAX_BUFFER_BYTES` 1MB→4MB
- `electron/native/src/winstt-context.c` — depth caps + `static` buffers  (+ rebuilt `electron/native/bin/winstt-context.exe`)
- tests: `context-snapshot.test.ts`, `llm.test.ts`, `context-reader.test.ts`
- `scripts/context-harness/` — the harness (`apps.ts`, `capture.ts`, `run.ts`, `resolve-hwnd.ps1`, `README.md`, this `STATUS.md`)

## Run the harness
```
cd frontend && bun run context:harness gmail discord discord-server x x-reply facebook facebook-feed whatsapp
```
Needs the debug Chrome up: `chrome.exe --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=C:/Users/MASTE/chrome-debug-profile` and logged into the apps. Output → `out/<id>/{screenshot.png,rawSnapshot.json,promptFragment.txt,asrPromptTail.txt,prunedTree.txt}` + `summary.json` — **gitignored, regenerable, and contains private captures** (cleaned between runs).
