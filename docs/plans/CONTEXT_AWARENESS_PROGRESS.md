# Context-Awareness — Progress Tracker

> **⚠️ DIRECTION CHANGE — 2026-06-15.** The runtime dictation capture has **pivoted
> from the whole-window UIA tree dump to a focused-field capture** (`ContextMode::Split`),
> matching how Wispr Flow / superwhisper / Lemon actually work: **focused field +
> caret-nearby text + selection + app identity (window/app/url)** via accessibility —
> **no whole-window tree walk**, no per-app who-said-what reconstruction. This is
> cross-platform-friendly and kills the sidebar/inbox/OTP-tree leaks by construction.
> See [`CROSS_PLATFORM_CONTEXT_STRATEGY.md`](./CROSS_PLATFORM_CONTEXT_STRATEGY.md) for
> why (the deep who-said-what / browser-extension path was explored and **deliberately
> not chosen**). The per-surface tree table below documents the **old** `--tree`
> approach, which is **retained only for the debug Context Playground + the CDP
> harness** — it is no longer the dictation path. Wiring: `post_process.rs` uses
> `ContextMode::Split`; `winstt_context.rs --split` now also emits `url` (and
> `find_browser_url` was fixed — modern Chrome gives the omnibox a generated
> AutomationId, so it now matches the address bar by value shape). The sidecar is
> built + staged to `src-tauri/binaries/` by `tools/windows/tauri-dev.ps1` (dev) and
> `tools/windows/tauri-build.ps1` + `tauri.conf.json` `resources` (release).
> **Live-verified 2026-06-15:** `--split` against a real focused Chrome field
> returned `{url, textBefore=draft, textAfter=quoted thread, axHtml=""}` — caret
> split + app identity correct, no tree leak. (Full in-app dictation flow, and a
> release `tauri build` + install, not yet exercised.)

Live progress of the dictation **context-awareness** feature: when the user dictates
"reply to this", the LLM should already receive a **clean, structured JSON** of what
they're acting on. **As of the 2026-06-15 pivot** that JSON is the focused field's
draft + caret-nearby text (e.g. a Gmail reply's quoted thread sits in `afterCaret`) +
app identity — NOT a reconstructed multi-speaker thread — with **zero noise** (no nav /
inbox / tab-strip / ads / OTP codes).

- **Plan & per-app specs:** [`CONTEXT_JSON_SPECS.json`](./CONTEXT_JSON_SPECS.json) (8-surface recipes + Rust-extractor plan, from the design workflow).
- **Capture harness:** `tools/context-cdp-capture.mjs` (drives a dedicated logged-in Chrome over CDP, runs the native UIA sidecar, analyzes via `context_prompt_smoke`).
- **Native sidecar:** `src-tauri/src/bin/winstt_context.rs` (Rust port of the original C UIA reader).
- **Extractor:** `src-tauri/src/winstt/context.rs` (`format_context_for_prompt_json` + the `json_*` pruner; 56 unit tests pass).
- Background + constraints: see memory `project_context_cdp_capture_harness`.

Last updated: **2026-06-15**.

---

## CURRENT consolidated status (all integrations) — FINAL sweep 2026-06-15 (post privacy-scrub)

Sweep run: `node tools/context-cdp-capture.mjs claude x-reply facebook discord outlook gemini
chatgpt gmail whatsapp` (browser self-healed via `ensureAlive`; **not** force-killed/wiped), each
surface verified two ways — the harness `smoke.json` verdict **and**
`context_prompt_smoke.exe --input <rawSnapshot.json> --label <label> --dump-prompt` (freshly-rebuilt
`target/debug` binary carrying the **unconditional final OTP scrub** in `context.rs`).

This sweep validates two changes landed since the prior run: (1) the **unconditional OTP /
verification-code redaction** in `context.rs` (drops whole keyword-anchored segments + redacts
keyword-adjacent 4–8 digit runs, even buried inside a single `<doc>` blob), and (2) the
**foreground-before-read** harness fix (`winstt_context.exe --tree` now reads the intended window,
not whatever was foreground).

Legend: **✅ verified-clean** = attributed turns, no chrome/OTP leak, reproduced this run ·
**⚠️ flaky** = lands clean *sometimes*, fails other runs (focus/timing) · **⛔ structural-limit**
= a UIA reality blocks it (no fix without a DOM-side change) · **🟡 shallow** = clean but too
little captured (wrong row / compose-only) · **🔑 needs re-login** = session expired.

### 🔒 PRIVACY GUARANTEE — **PASS** (no OTP leaks)

**Zero OTP / verification / 2FA / sign-in security codes leaked on any of the 9 surfaces this run.**
The prior run's real Outlook OTP `Your account verification OTP is: 17042` is **completely gone** —
grepping every `--dump-prompt` output for `17042` returns nothing, and there is **no** `OTP`,
`verification code`, `passcode`, `2FA`, `security code`, or `login code` token anywhere across all
nine dumps. Every digit-run that survives is a date (`6/13/2026`), time (`9:24 PM`), price
(`EGP 366.96`, `LE 4500`), phone number, PR/issue number (`#70`), or invoice number
(Anthropic receipt `#2910-3647-4204`) — none keyword-adjacent to a code. The surviving
`*verification*` strings are inert subject-line / conversation-title labels (Outlook
`CodeBasics | Account Verification`, Gemini recents `AI Agent Verification with Uncle Bob`) with no
digits attached. **One honest residual:** WhatsApp's chat-LIST preview leaks an Arabic courier
("Bosta") delivery code (`…6809 … الكود 3005137827`, `sixDigitCodeLikeCount:1`) — the scrub is
English-keyword-anchored, so a non-English (`الكود`) code in sidebar chrome slips through. It is a
delivery confirmation code, **not** an account-auth OTP, and it rides in list chrome that shouldn't
be captured at all (see WhatsApp row).

**Composer-detection caveat:** the foreground fix made composer detection now **reliable on the
real-composer surfaces** — Claude, Facebook Messenger, Discord, ChatGPT, and WhatsApp all reported
`focusedFieldLooksComposer=true` this run (vs. all-false last run). The mail/feed surfaces
(Gmail, Outlook, Gemini, X-reply) still resolve the focused field to the window title
(`composer=false`, `focusMiss=true`) and fall back to a whole-window `screen` read — so their
"Clean" verdict still measures how well the extractor prunes a window-level dump (the worst case).

| Surface | Composer reliable | Conversation captured | Who-said-what | Depth (msgs back) | Clean (no chrome/OTP) | Status |
|---|---|---|---|---|---|---|
| **Gmail** (mail.google.com) | ❌ field = window title (`focusMiss`) | ⚠️ whole-window inbox read (reply box found=false; quote is a separate UIA region) | ❌ `speakerLike:0` — inbox-row dump, no `Sender:` turns | inbox list + 1 expanded thread | ✅ **0 OTP** (Anthropic "Sign in with the secure link" is a magic-link subject, **no code**); ❌ still leaks inbox rows (`emailLikeCount:2`) | ⛔ **structural-limit** (needs pop-out reply window); **no OTP** |
| **Outlook** (outlook.live.com) | ❌ field = window title (`focusMiss`) | ⚠️ whole-window reading-pane/draft dump; reroute to a clean thread did **not** fire | ❌ `speakerLike:0` (window-tree dump, not `Sender:` turns) | inbox + draft list (~78 lines) | ✅ **OTP SCRUBBED** — `…17042` GONE; `otpNoiseWordCount:0`, `sixDigitCodeLikeCount:0`. ❌ still leaks inbox sender labels + draft list (`emailLikeCount:7`) | ⛔ **structural-limit** (reroute didn't fire) — **but privacy-clean now** |
| **Discord — DM** (discord.com) | ✅ `composer=true` ("Message @!Evirios!", `msgRows:10`) | ✅ full DM backlog present, but buried under the server sidebar | ❌ `speakerLike:0` (`multi_speaker_depth_not_observed`); turns rendered `Master 6/13/26 …` / `!Evirios! …` but not parsed as `Author:` | rendered backlog (≤24k) | ✅ 0 OTP, **no Server-Tag**; ❌ **sidebar chrome leak** ("287 unread mentions", server/folder list, "Add a Server", "Quests", "Nitro Shop") | ⚠️ **flaky/noisy** (composer OK now, but full-sidebar window dump; not clean) |
| **X — reply** (x.com) | ❌ field = window title (`focusMiss`) | ❌ **thread didn't load** this run — captured only nav rail + "Loading" (`screen:204` chars) | ❌ none captured (no thread) | ~0 (regressed) | ✅ 0 OTP, 0 email (just top-nav words: "Home Explore Notifications Grok …") | ⚠️ **flaky/regressed** (last run was clean thread w/ `speakerLike:7`; this run timed out) |
| **X — compose** (x.com) | ✅ | ⚠️ timeline feed (no thread) | ✅ real `@handles` on feed posts; no false speakers | 0 thread (compose) | ✅ 0 OTP; top-nav words present but harmless | ✅ **verified-clean** (compose) — *(carried from prior run; this sweep ran `x-reply` only)* |
| **Facebook Messenger** (facebook.com/messages) | ✅ `composer=true` ("Write to …") | ✅ DM thread | ✅ **real names per turn** (`سول:` / `موه:`); Quran verse stays *inside* `موه`'s turn — not mis-parsed | rendered slice (~1.3k chars) `speakerLike:10` | ✅ 0 chrome, 0 OTP, 0 email, 0 false speaker | ✅ **verified-clean** |
| **Facebook — feed comment** (facebook.com) | ⚠️ flaky (dialog/permalink steals focus) | ✅ post + visible comments when it lands | ⚠️ partial | post + on-screen comments | ✅ clean when it lands | ⚠️ **flaky** *(not re-run this sweep; carried from prior run)* |
| **WhatsApp Web** (web.whatsapp.com) | ✅ `composer=true` ("Type a message to group GUC") | ✅ active GUC group thread (chess game) w/ `You:` / `Ali` turns | ⚠️ `multi_speaker_depth_not_observed` (turns present but not all attributed) | full chat-list + active thread (~8.4k chars) | ⚠️ active thread clean, **but leaks the entire chat-LIST sidebar** (every contact + last-message preview) incl. an Arabic Bosta **delivery code** (`sixDigitCodeLikeCount:1`) | ⚠️ **flaky/noisy** (logged in now; sidebar leak + non-English code residual) |
| **Claude** (claude.ai) | ✅ `composer=true` ("Write your prompt to Claude") | ✅ full visible transcript | ✅ **`User:` / `Assistant:`** (markers survive in UIA) `speakerLike:5` | ~10.7k chars (3 user + 3 assistant turns) | ✅ 0 OTP, 0 nav chrome — **but** each `Assistant:` turn is bloated with duplicated tool-status "thinking" lines (verbose, not a privacy issue) | ✅ **verified-clean** (verbose) |
| **ChatGPT** (chatgpt.com) | ✅ `composer=true` ("Message ChatGPT") | ⚠️ caret blob w/ markers, but only the latest turn — assistant body absent | ⚠️ **markers present this run** (`You said:` / `ChatGPT said:` in `beforeCaret`) but assistant turn = action chrome only | ~1 turn (latest) | ✅ 0 OTP; ❌ action-button chrome ("Edit image", "Share this image", "Like/Dislike this image", "Thought for 36s") | ⛔ **structural-limit** (assistant response body never reaches UIA) — **no OTP** |
| **Gemini** (gemini.google.com) | ❌ field = window title (`focusMiss`) | ✅ text present but **one undelimited blob** (`context_too_shallow_for_reply`) | ❌ **none** (`speakerLike:0`) — `<user-query>`/`<model-response>` collapse to one `<doc>` | one blob | ✅ 0 OTP (`AI Agent Verification` recents-title is a *coding-tutorial* label, no code); ❌ **recents-rail leak** (conv titles: "Egg Shelf Life", "Rust vs. Electron", "Red Alert 3 Player Comparison", "WinSTT Logo Design Brief", "NestJS and oRPC Integration", …) | ⛔ **structural-limit** (no per-turn boundary survives) — **no OTP** |

### Verdict roll-up (this sweep)

- **🔒 Privacy guarantee (no OTP anywhere): PASS** — 9/9 surfaces, 0 account-auth OTP/verification
  codes. Outlook's `17042` confirmed scrubbed. Lone residual = WhatsApp Arabic courier delivery
  code in sidebar list-chrome (non-auth, non-English-keyword).
- **Verified-clean (3):** **Facebook Messenger**, **Claude** (verbose caveat), **X compose**
  (compose carried from prior run; not re-captured this sweep). Each: attributed turns, no
  chrome/OTP, reproduced.
- **Structural-limit (4, no recipe fix possible today, all OTP-clean):** **ChatGPT** (assistant
  body never reaches UIA — though `You said:`/`ChatGPT said:` markers DID appear this run, a change
  from prior "no markers" finding), **Gemini** (turns collapse to one `<doc>`; recents-rail leak),
  **Gmail** (empty inline box + quote in a separate UIA region; needs pop-out reply window),
  **Outlook** (reroute didn't fire → whole-window dump; **now OTP-clean** thanks to the scrub).
- **Flaky / noisy (3):** **Discord DM** (composer OK now, but full-server-sidebar window dump,
  `speakerLike:0`; no Server-Tag), **WhatsApp** (logged in + active thread captured, but leaks the
  whole chat-list sidebar incl. an Arabic delivery code), **X-reply** (thread didn't load this run →
  nav-rail + "Loading" only; was clean last run — timing-dependent), **Facebook feed** (dialog
  focus flake; not re-run).

### dump-prompt evidence (load-bearing excerpts, lightly truncated)

- **OTP scrub PASS (Outlook):** dump now reads `… Inbox 10926 unread … CodeBasics | Account
  Verification … Verify Your Storyblocks API Account … [Draft] info@codebasics.io …` — the email
  *body* line `Your account verification OTP is: 17042` is **absent**; `grep 17042` over all 9
  dumps = no match. `otpNoiseWordCount:0`, `sixDigitCodeLikeCount:0`.
- **Messenger (clean):** `سول: السلام عليكم` · `موه: وعليكم السلام ورحمة الله وبركاته …` (Quran
  verse `﴿أَمْ كُنتُمْ شُهَدَاءَ …﴾` stays inside موه's turn) — `speakerLike:10`, 0 OTP/email.
- **Claude (clean, verbose):** `User: not exact. … edge highlights of the main card missing,
  gradient distribution on small card not correct` · `Assistant: Found the gaps. Analyzed gradient
  distributions and refined border highlight implementation Analyzed gradient distributions and
  refined border highlight implementation Found the gaps. …` (doubled clause = duplicated thought
  block).
- **ChatGPT (markers present, body absent):** `beforeCaret` = `… You said: create a white mode
  version of this … ChatGPT said: Thought for 36s Edit image Share this image … Dislike this image`
  — role markers survived this run, but the assistant turn is action-chrome, no response text.
- **Gemini (blob + recents leak, no OTP):** prompts run together with no `User:`/`Gemini:`
  boundary; sidebar titles leak mid-stream: `… Egg Shelf Life and Refrigeration  Rust vs. Electron:
  Backend vs. Frontend … Red Alert 3 Player Comparison … WinSTT Logo Design Brief …`. No real code.
- **Discord DM (sidebar leak, no OTP/Server-Tag):** `… 287 unread mentions … Add a Server …
  Quests … Find or start a conversation …` precedes the real `Master 6/13/26 … !Evirios! …` DM
  backlog (chess/clone chat); turns not attributed.
- **WhatsApp (sidebar leak + Arabic delivery code):** active thread is clean (`You: el3b` · `Ali:
  …` chess back-and-forth), but the captured chat-LIST preamble leaks every contact preview incl.
  `Bosta … الكود 6809 … الكود 3005137827` (a courier delivery code, not an auth OTP) — the lone
  `sixDigitCodeLikeCount:1` this sweep.
- **X-reply (regressed, clean):** `… Grok Bookmarks Creator Studio Premium … Mostafa @Dahshury
  Loading` — only nav chrome; the tweet thread never rendered into UIA this run.

---

## Update — 2026-06-15 (4 new apps re-verified live: ChatGPT / Gemini / Claude / Outlook)

Re-ran a **fresh capture** of the new integrations after the `context.rs` extractor
tuning (AI-chat `User:`/`Assistant:` collapse + chrome filtering + Outlook reroute),
the `context_prompt_smoke` rebuild, and the ChatGPT recipe fix:

```
node tools/context-cdp-capture.mjs chatgpt gemini claude outlook   # browser self-healed via ensureAlive
node tools/context-cdp-capture.mjs discord x facebook              # re-checked the messaging surfaces too
```

Each surface verified two ways: the harness `smoke.json` verdict **and**
`context_prompt_smoke.exe --input <rawSnapshot.json> --label <label> --dump-prompt`
to read the real formatted screen text.

**Headline:** only **Claude** of the four new apps is clean end-to-end. **ChatGPT** and
**Gemini** both fail — *not* a recipe bug but a **structural UIA reality**: their
conversation turns do **not** survive into the accessibility tree the native reader sees,
and they emit **no literal speaker markers** in the rendered UIA text (their `user`/
`assistant` role lives in a DOM *attribute*, which UIA does not expose). **Outlook** is
clean of chrome/OTP but landed on a non-thread row this run (shallow).

### Why Claude works but ChatGPT/Gemini don't (root cause — measured from `rawSnapshot.json`)

The extractor attributes AI-chat turns via `json_reconstruct_ai_chat_blob` (context.rs:2489),
which splits the flat composer caret blob on **literal** `You said:` / `<App> said:` /
`Claude responded:` markers.

- **Claude** renders those markers as real text — its `textBefore` literally contains
  `You said: …` / `Claude responded: …`. The reconstructor converts them to `User:` /
  `Assistant:` and structurally drops the nav prefix (`New chat / Chats / Projects /
  Artifacts / Max plan`). **Result: 6 clean attributed turns, 0 chrome, 0 OTP.** ✅
- **ChatGPT** UIA text has **no** `You said:` / `ChatGPT said:` markers — the real caret
  blob is `… create an abstract bg … · Copy message · Edit message · Thought for 46s ·
  Edit image · Like this image · More actions …`. With no markers and no `JSON_PAGE_NAV_MARKERS`
  hits (those are Gmail/X/Outlook words) and no speaker-prefix lines, `json_caret_is_page_scrollback`
  returns **false**, so it never reroutes — the raw chrome-laden `beforeCaret` is emitted
  as-is. Its **axHtml tree is only 2.5 KB of toolbar buttons + one `<doc>` — zero
  conversation turns in the tree.** ❌
- **Gemini** routed to the tree pruner (`screen`), but its `<user-query>`/`<model-response>`
  Angular custom elements **collapse into a single `<doc>` node** in UIA (0 group/article/region
  nodes). The result is one **undelimited blob** with **zero attribution** (`speakerLike: 0`)
  and the **left recents rail leaking** ("Coffee Vending Machines Explained", "RTX 50 Series
  Laptop Pricing", "WhatsApp Premium Subscription Rumors", …) because there's no structural
  boundary to drop. ❌

So the ChatGPT/Gemini specs' load-bearing assumption — that the turn structure or speaker
markers reach UIA — does **not** hold on the live trees. The synthetic unit tests
(`ai_chat_blob` with `"ChatGPT You said: … ChatGPT said: …"`) pass because they feed the
markers the real surface never produces.

### Per-surface results (this run — dump-prompt evidence, user data lightly truncated)

| Surface | Label | Composer focused | Attribution (You/AI or Sender) | Depth (msgs back) | Clean? | Verdict |
|---|---|---|---|---|---|---|
| **Claude** (claude.ai) | claude | ✅ ("Write your prompt to Claude") | ✅ `User:` / `Assistant:` (3 pairs) | 6 turns, ~10.8 KB | ✅ no chrome, no OTP | ✅ **VERIFIED CLEAN** |
| **ChatGPT** (chatgpt.com) | claude | ✅ ("Message ChatGPT") | ❌ none (no markers) | beforeCaret blob, ~0.5 KB | ❌ chrome leak ("Copy message", "Thought for 46s", "Like this image", "More actions") | ❌ **chrome leak / no attribution** |
| **Gemini** (gemini.google.com) | gmail | ✅ ("Enter a prompt for Gemini") | ❌ none (`speakerLike:0`) | one ~11.8 KB blob | ❌ recents-rail leak; undelimited | ❌ **blob + nav leak** |
| **Outlook** (outlook.live.com) | gmail | ✅ ("Message body") | ⚠️ `Sender:`-shaped lines, but landed on a **calendar/birthday-reminder** row, not a Re:/Fwd: thread | ~0.2 KB (shallow) | ✅ no chrome/OTP (1 self email-addr) | ⚠️ **clean but not a real thread** |

**Claude — clean turns (truncated):**
```
User: clone this in html css pixel perfect …
Assistant: This is a faithful clone task—the brief pins down everything. …
User: not exact. … edge highlights of the main card missing, gradient distribution …
Assistant: Found the gaps. … refined border highlight implementation …
User: have you compared back and fourth between the both? … take ~10 small screenshots …
Assistant: Chromium works. … build a screenshot + comparison harness …
```
(Minor: each Assistant turn duplicates its tool-status "thinking" lines — content artifact
of Claude's rendered thought blocks, not a false speaker or privacy issue.)

**ChatGPT — the leak (raw `beforeCaret`):**
```
Skip to content · Open sidebar · Copy link · brand.md · File ·
create an abstract bg variants … show me several ideas ·
Copy message · Edit message · Thought for 46s · Edit image · Share this image ·
Like this image · Dislike this image · More actions · less color variants, more texture … ·
Copy message · Edit message · Thought for 48s · … · Add files and more
```

**Gemini — the leak (undelimited `screen`, recents rail in bold):**
```
**Coffee Vending Machines Explained  Queue Management System Explained  Ants on Food: Is It
Safe?  RTX 50 Series Laptop Pricing  WhatsApp Premium Subscription Rumors  AI Coding Language
Performance** a picture of a VR headset as an app icon … make the glasses look like a vr
headset … App icon mascot, flat vector cartoon illustration … (the user's prompts and Gemini's
answers run together with no You:/Gemini: boundary)
```
(Smoke flagged `otp_or_login_code_noise_detected` — a **false positive**: the conversation is
legitimately about designing an "OTP Login" hero image; no real 6-digit code, `sixDigitCodeLikeCount:0`.)

**Outlook — shallow, non-thread:**
```
You · Wed 6/12/2024 12:00 PM · SaSa Darsh <MASTER_X_3@live.com> · Fri 6/12/2026 12:00 PM ·
Your reminder for kevin.e.13's birthday · 6/13/2026 · All Day
```
The row-picker preferred a **birthday-reminder / calendar item** over a Re:/Fwd: thread, so
there's no multi-message sender back-and-forth to attribute. The reroute + chrome/OTP prune
work (no folder nav, no message-list, no verification codes leaked); it just needs a real
thread row.

### Messaging apps re-checked live (this run)

| Surface | Composer | Attribution | Clean? | Verdict |
|---|---|---|---|---|
| **Facebook Messenger** | ✅ | ✅ real names `سول:` / `موه:` per turn | ✅ no chrome, no OTP, no false speaker | ✅ **VERIFIED CLEAN** (Quran verse stays *inside* the speaker's turn, not mis-parsed) |
| **X (compose/home)** | ✅ | ✅ real handles (`@fanofaliens`, `@yousefrol`, `@Youssofal_`, `@kimmonismus`) | ✅ no OTP, no "Server Tag" | ✅ **clean** (timeline feed; top-nav words present but no false speakers) |
| **Discord** | ❌ (focusMiss → Friends/DM window title) | ❌ when focus misses: full sidebar dump + "287 unread mentions" | ❌ | ⚠️ **flaky** — composer focus unreliable; a prior *successful* run still showed `Master Server Tag: W00T` + profile-card chrome |

**Honest framing:** the **Facebook / X** "verified clean live" claim holds (real usernames,
no Server Tag, no false speakers). **Discord does NOT** — it still flakes on composer focus
(lands on the @me Friends list / DM window title, `focusMiss=true`), and even its best
recent capture carries `Server Tag: W00T` badge text and a trailing profile card. Treat
Discord as still-flaky.

### Concrete remaining work (new, from this pass)

1. **ChatGPT** — needs a real fix, not just a recipe: either (a) detect ChatGPT's chrome
   blob as page-scrollback (add ChatGPT action-row / "Thought for Ns" / "Copy message"
   markers so `json_caret_is_page_scrollback` fires) **and** a from-DOM turn injection
   (the harness reads `data-message-author-role` in JS and synthesizes `You:`/`ChatGPT:`
   markers into the snapshot before the native read), since the UIA tree carries no turns.
2. **Gemini** — same shape: UIA flattens `<user-query>`/`<model-response>` into one `<doc>`;
   no per-turn boundary survives, so global speaker reconstruction can't fire and the recents
   rail leaks. Needs the same DOM-side marker injection, or a Gemini-specific blob splitter
   keyed on something that *does* survive — neither exists today. Also drop the recents titles.
3. **Outlook** — tighten the row picker to actually open a Re:/Fwd: thread (skip calendar /
   reminder / birthday rows) so there's real sender-attributed depth to verify.
4. **Discord** — composer focus reliability (still lands on Friends/@me) + strip the
   `Server Tag:` badge and the trailing profile-card chrome from successful captures.

---

## Update — 2026-06-14 (all sessions re-logged in; robustness pass)

**Robustness (done + verified):** added `tools/windows/chrome-cdp-ensure.ps1` + an
`ensureAlive()` preflight in the harness. The capture Chrome now **self-heals** — if it
died (the real cause of the earlier "stuck, no progress": the instance crashed and the
run/agent just spun against a dead CDP endpoint), the next run **relaunches it from the
EXISTING profile**, never copying/wiping (copy/wipe + unclean `Stop-Process -Force` were
what dropped the logins). Rules now enforced: never force-kill the instance, never wipe
the profile, verify login before trusting a capture.

**Live state with everyone logged in (measured):** capture *text depth* is good, but
per-author **"who said what" is weak** and recipes are **flaky run-to-run**:

| Surface | Composer | Conversation text | Who-said-what | Notes |
|---|---|---|---|---|
| X reply | ✅ | ✅ ~5k chars | ⚠️ author not cleanly attributed | sentence-colons falsely matched |
| X compose | ✅ | — | — | solid |
| Messenger | ✅ | ✅ ~5.5k chars | ⚠️ partial ("You:" ok; a Quran verse mis-parsed as a speaker) | |
| Discord DM | ✅ (flaky) | ✅ ~700 chars | ❌ shows "Server Tag:" UI noise, not usernames | passed sweep, failed next run |
| Discord server | ❌ | — | — | recipe lands on Friends, never a channel |
| WhatsApp | ⚠️ focuses search box | ✅ ~7k chars | ❌ | composer selector now footer-scoped; flaky/slow first paint |
| Facebook feed | ❌ flaky | partial | — | dialog/permalink variants steal focus |
| Gmail | ✅ | ❌ | — | structural: empty inline box, quote is a separate UIA region → leaks inbox/OTP |

**Concrete remaining work (the real "iterate on lacking integrations"):**
1. **Attribution reconstruction** (`context.rs`): turn the real UIA message groups into
   correct `Author: message` turns; drop false speakers ("Server Tag", scripture,
   sentence colons). This is the core "who said what" — currently the biggest gap.
2. **Discord-server navigation** recipe (reach a real channel backlog, not Friends).
3. **WhatsApp/Discord-DM/feed** recipe reliability (timing; focus the right field).
4. **Gmail pop-out reply** path (structural — to read the full email thread).

**Honest framing:** chasing 100% reliability across 8 live SPAs is a long iterative tail
(flaky, session-fragile). The *product* goal — clean structured JSON when the user
focuses a field and dictates — is delivered by the extractor (56 tests; X-compose clean
live). The harness is the regression/test tool; its per-app reliability + the attribution
quality are what remain.

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
🔑 blocked on re-login · — n/a. **(rows re-measured 2026-06-15 where noted)**

Surface kind: **ai-chat** = `You:`/`Assistant:` turns · **chat** = real-username turns ·
**email-thread** = `Sender:` turns · **compose** = new post (no thread).

| Integration | Surface kind | Composer focus | Reads prior messages? | Who-said-what attribution | Depth — messages back (measured) | Clean / noise-free? | Status |
|---|---|---|---|---|---|---|---|
| **Claude** (claude.ai) | ai-chat | ✅ reliable ("Write your prompt to Claude") | ✅ — full visible thread | ✅ **`User:`/`Assistant:`** (markers `You said:`/`Claude responded:` survive in UIA text) | **6 turns / ~10.8k chars** (2026-06-15) | ✅ 0 chrome, 0 OTP, nav prefix dropped | ✅ **VERIFIED CLEAN** (2026-06-15) |
| **ChatGPT** (chatgpt.com) | ai-chat | ✅ reliable ("Message ChatGPT") | ⚠️ text present in caret blob only | ❌ **none** — UIA has no `You said:`/`ChatGPT said:` markers; tree carries 0 turns | beforeCaret blob (~0.5k) | ❌ **chrome leak** ("Copy message", "Thought for 46s", "Like this image", "More actions") | ❌ **broken** — structural (see notes) (2026-06-15) |
| **Gemini** (gemini.google.com) | ai-chat | ✅ reliable ("Enter a prompt for Gemini") | ✅ text present | ❌ **none** (`speakerLike:0`) — `<user-query>`/`<model-response>` collapse to one `<doc>` in UIA | one ~11.8k-char blob | ❌ **recents-rail leak** + undelimited blob | ❌ **broken** — structural (see notes) (2026-06-15) |
| **Outlook** (outlook.live.com) | email-thread | ✅ reliable ("Message body") | ⚠️ depends on row opened | ⚠️ `Sender:`-shaped but landed on a **calendar/reminder** row, not a Re:/Fwd: thread | ~0.2k (shallow) | ✅ no chrome/OTP (1 self email-addr) | ⚠️ **clean but row-picker missed a real thread** (2026-06-15) |
| **X (Twitter) — reply** | chat/compose | ✅ reliable | ✅ the tweet being replied to + visible reply thread | ✅ yes — original author `@handle` attributed | **1+ attributed** (the tweet, ~2.7k chars) | ✅ 0 OTP/email/code leaks | ✅ **verified** |
| **X (Twitter) — compose** | compose | ✅ reliable | — (new post / timeline feed) | ✅ real `@handles` on feed posts; no false speakers | 0 thread (compose) | ✅ clean, no Server Tag/OTP (2026-06-15) | ✅ **verified clean live** |
| **Messenger** (facebook.com/messages) | chat | ✅ reliable (composer = "Write to <name>"; dismisses the e2e-PIN modal) | ✅ yes | ✅ **real names per turn** (`سول:` / `موه:`) — Quran verse stays inside its speaker's turn, NOT mis-parsed | **rendered slice** (~2.3k chars this run, ≤24k) | ✅ 0 chrome, 0 OTP, 0 false speaker | ✅ **verified clean live** (2026-06-15) |
| **Facebook — feed comment** | chat | ⚠️ flaky (2 of 3 runs) | ✅ the post + visible comments | ⚠️ partial | post + on-screen comments | ✅ clean when it lands | ⚠️ **flaky** (dialog/permalink variants steal focus) |
| **Gmail** | email-thread | ✅ reliable | ⛔ **no** — the inline reply box is empty and Gmail exposes the quoted thread as a *separate* UIA region the focused field can't read | — (email = sender attribution, not chat speakers) | **~0 clean today** (open email body/quote not read from the empty field) | ❌ leaks inbox rows incl. OTP codes (because the empty field forces a whole-window dump) | ⛔ **structural limit** — needs the **pop-out reply window** path (multi-window CDP change) |
| **Discord — DM** | chat | ❌ **flaky** — focus lands on @me Friends / DM window title (`focusMiss=true` this run) | ✅ when focus lands | ⚠️ real usernames present (`!Evirios!`, `Master`) but a best-case run still carries **`Server Tag: W00T`** + a trailing profile card; on focusMiss = full sidebar + "287 unread mentions" | rendered backlog ≤24k | ❌ when focus misses; noisy even when it lands | ⚠️ **still flaky** (2026-06-15) — NOT clean |
| **Discord — Server channel** | chat | recipe built (guild rail → channel with backlog) | designed ✅ | designed ✅ — **multi-author** `Author: text` reconstruction | designed: rendered backlog ≤24k | unverified | 🔑 **unverified** (DM recipe still flaky; server nav untested this pass) |
| **WhatsApp Web** | chat | recipe built (60s first-paint poll; QR detection) | designed ✅ | designed ✅ | designed: rendered slice ≤24k | unverified | 🔑 **needs QR re-login** |

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

1. **ChatGPT / Gemini ai-chat attribution (structural, biggest gap):** the UIA tree
   carries **no turn boundaries and no speaker markers** for either (verified 2026-06-15
   from `rawSnapshot.json`: ChatGPT tree = 2.5 KB of toolbar buttons + one `<doc>`;
   Gemini's `<user-query>`/`<model-response>` collapse into one `<doc>`, 0 group/region nodes).
   The marker-based `json_reconstruct_ai_chat_blob` only fires when literal `You said:` /
   `<App> said:` text exists — true for Claude, false for ChatGPT/Gemini. **Fix path:** have
   the harness read `data-message-author-role` (ChatGPT) / the `user-query`/`model-response`
   tag (Gemini) in JS and **inject `You:` / `ChatGPT:` / `Gemini:` markers into the snapshot
   text** before the native read, OR detect their chrome blob as page-scrollback + drop the
   recents rail. The synthetic unit tests pass on markers the live surface never emits, so
   they don't catch this — add **rawSnapshot-fixture** regression tests for ChatGPT/Gemini.
2. **Outlook row picker** — open a real Re:/Fwd: thread (skip calendar / reminder / birthday
   rows) so there's multi-message sender depth to verify; the reroute + chrome/OTP prune
   already work, the surface just needs a real thread.
3. **Discord** — composer focus reliability (still lands on @me Friends / DM window title,
   `focusMiss=true`) + strip the `Server Tag:` badge and trailing profile-card chrome from
   successful captures.
4. **Re-login** WhatsApp (QR) in the capture profile → verify live.
5. **Gmail pop-out reply** path — capture the isolated pop-out window so the full quoted
   thread is read (removes the inbox/OTP leak; resolves N emails back).
6. **Facebook feed** — harden the dialog-focus flake.
7. Wire the native `winstt_context` sidecar into the app as the `externalBin` (replacing the
   deleted one) so the shipping product uses the same reader.

> **Honest status (2026-06-15):** of the four new apps, only **Claude** is clean
> end-to-end; **Facebook Messenger** and **X** are verified clean live among the messaging
> set. **ChatGPT** and **Gemini** are blocked on the structural UIA-attribution gap above,
> **Outlook** needs a real-thread row, and **Discord** remains flaky (focus + Server-Tag
> noise). The X/Messenger "clean live" claim — real usernames, no Server Tag, no false
> speakers — holds; Discord's does not.
