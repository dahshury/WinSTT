# Context-Awareness — Progress Tracker

Live progress of the dictation **context-awareness** feature: when the user dictates
"reply to this", the LLM should already receive a **clean, structured JSON** of what
they're acting on — the conversation, previous messages, who-said-what, the reply
target, and the current draft — with **zero noise** (no nav / inbox / tab-strip / ads /
OTP codes).

- **Plan & per-app specs:** [`CONTEXT_JSON_SPECS.json`](./CONTEXT_JSON_SPECS.json) (8-surface recipes + Rust-extractor plan, from the design workflow).
- **Capture harness:** `tools/context-cdp-capture.mjs` (drives a dedicated logged-in Chrome over CDP, runs the native UIA sidecar, analyzes via `context_prompt_smoke`).
- **Native sidecar:** `src-tauri/src/bin/winstt_context.rs` (Rust port of the original C UIA reader).
- **Extractor:** `src-tauri/src/winstt/context.rs` (`format_context_for_prompt_json` + the `json_*` pruner; 56 unit tests pass).
- Background + constraints: see memory `project_context_cdp_capture_harness`.

Last updated: **2026-06-14**.

---

## How "messages back" actually works (read this first)

The capture reads the **Windows UI Automation tree of whatever is rendered on screen
at capture time**. Two hard limits define depth for *every* app:

1. **Rendered-slice only.** Chat/social apps **virtualize** their lists — only the
   messages currently scrolled into view exist in the accessibility tree. The capture
   sees that visible slice (typically the **last ~20–50 messages**, depending on window
   height). It does **not** auto-scroll to load older history — the product is
   deliberately side-effect-free. Deeper history is captured only if it's already
   on-screen.
2. **~24,000-char cap.** The native reader caps caret/context at ~24,000 chars
   (`CARET_BEFORE ≈ 21k`, `MAX_CONTEXT ≈ 24k`). Long threads are clipped to the most
   recent text nearest the caret.

So "N messages back" = **"as many as are rendered above the composer, up to ~24k
chars."** The numbers in the table are what was *measured in a real capture*, not a
hard ceiling.

---

## Progress table

Legend: ✅ verified live · ⚠️ works but flaky · ⛔ blocked by a structural limit ·
🔑 blocked on re-login · — n/a.

| Integration | Surface(s) supported | Composer focus | Reads prior messages? | Who-said-what (multi-speaker)? | Depth — messages back (measured) | Clean / noise-free? | Status |
|---|---|---|---|---|---|---|---|
| **X (Twitter) — reply** | reply box under a tweet | ✅ reliable | ✅ the tweet being replied to + visible reply thread | ✅ yes — original author attributed | **1+ attributed** (the tweet, ~2.7k chars) | ✅ 0 OTP/email/code leaks | ✅ **verified** |
| **X (Twitter) — compose** | home "What's happening" box | ✅ reliable | — (new post, no thread) | — | 0 (compose) | ✅ clean | ✅ **verified** |
| **Messenger** (facebook.com/messages) | DM conversation | ✅ mostly reliable (composer = "Write to <name>"; dismisses the e2e-PIN modal) | ✅ yes — ~5.5k chars of the thread | ⚠️ partial — thread text captured, but per-line author attribution did not fire in last run | **rendered slice** (~last several msgs, ≤24k chars) | ✅ mostly (1 borderline OTP from a notification node) | ⚠️ **mostly reliable** |
| **Facebook — feed comment** | comment box on a feed post | ⚠️ flaky (2 of 3 runs) | ✅ the post + visible comments | ⚠️ partial | post + on-screen comments | ✅ clean when it lands | ⚠️ **flaky** (dialog/permalink variants steal focus) |
| **Gmail** | reading-pane reply | ✅ reliable | ⛔ **no** — the inline reply box is empty and Gmail exposes the quoted thread as a *separate* UIA region the focused field can't read | — (email = sender attribution, not chat speakers) | **~0 clean today** (open email body/quote not read from the empty field) | ❌ leaks inbox rows incl. OTP codes (because the empty field forces a whole-window dump) | ⛔ **structural limit** — needs the **pop-out reply window** path (multi-window CDP change) |
| **Discord — DM** | 1:1 DM message box | recipe built (dismisses "Open in app" interstitial) | designed ✅ | designed ✅ (2-party) | designed: rendered backlog ≤24k | unverified | 🔑 **needs re-login** (capture profile logged out) |
| **Discord — Server channel** | #channel message box (multi-author) | recipe built (guild rail → channel with backlog) | designed ✅ | designed ✅ — **multi-author** `Author: text` reconstruction | designed: rendered backlog ≤24k | unverified | 🔑 **needs re-login** |
| **WhatsApp Web** | chat composer | recipe built (60s first-paint poll; QR detection) | designed ✅ | designed ✅ | designed: rendered slice ≤24k | unverified | 🔑 **needs QR re-login** |

### Direct answers to the questions asked

- **Discord — DMs only, or servers too?** **Both.** There are two recipes: `discord` (1:1 DM) and `discord-server` (navigates the guild rail to a text channel with a real backlog). The Rust extractor's speaker reconstruction handles **multi-author server channels** (`Author: text` per turn) as well as 2-party DMs. *Caveat: both are currently unverified live because the capture profile's Discord session logged out — pending re-login.*
- **Discord — multi-speaker + how many back?** Multi-speaker: **yes by design** (server channels attribute each turn to its author). Depth: the **rendered backlog** (the messages visible in the channel/DM at capture, typically the last ~20–50), capped at ~24k chars; no auto-scroll.
- **Gmail — how many emails back in the thread?** **Currently effectively 0 cleanly.** The reading-pane inline reply box is empty at capture, and the quoted "On … wrote:" chain lives in a separate UIA region the focused field doesn't expose — so the resolver can't read the back-and-forth, and falls back to dumping the window (which drags in inbox OTP rows). Resolving the full email thread needs the **pop-out reply window** (isolates thread + composer, no inbox) — scoped as the next change.
- **Messenger / Facebook — multi-speaker + depth?** Messenger captures the **thread text** (~5.5k chars of prior messages in the last run) and the composer focuses reliably; per-line **author attribution is inconsistent** (didn't fire last run). Facebook **feed** captures the post + visible comments but is **flaky** (focus occasionally lands on a dialog Close button). Depth for both = the rendered on-screen slice (≤24k chars).
- **X — depth?** Reply: resolves **the tweet being replied to** (+ any visible reply thread), with the original author attributed (multi-speaker ✅). Compose: no thread (new post).

---

## Foundation status (done & verified)

- ✅ **Native UIA sidecar** rebuilt in Rust (`winstt_context.rs`) after the C original was deleted — faithful 1:1 port recovered from git history; builds clean; byte-shape-identical output.
- ✅ **Extractor clean-JSON fix** — root cause was *branch routing*: rich-but-page-spanning caret text (Gmail/X) bypassed the tree-pruner. Fixed with `json_caret_is_page_scrollback` + reroute, noise-regex extensions, and a compose-vs-thread guard. **56 context unit tests pass**; clippy clean. Proven live: X compose/reply capture clean JSON (0 leaks).
- ✅ **False-positive bug fixed** — lingering SPA service workers were zombie-ing new capture windows into a dead `about:blank` context, so the sidecar fell back to reading the *foreground* window (yielding fake passes). Now cleared per-app + HWND failures write an explicit error instead of a foreground read.
- ✅ **Capture infrastructure** — dedicated CDP Chrome (logged in once, isolated from the user's main Chrome), occlusion handling, HWND-by-title resolution.

## Next steps (to close the table)

1. **Re-login** Discord + WhatsApp in the capture profile → verify those 3 surfaces live (depth + multi-speaker).
2. **Gmail pop-out reply** path — capture the isolated pop-out window so the full quoted thread is read (removes the inbox/OTP leak; resolves N emails back).
3. **Messenger/feed** — harden per-line author attribution + the feed dialog-focus flake.
4. Wire the native `winstt_context` sidecar into the app as the `externalBin` (replacing the deleted one) so the shipping product uses the same reader.
