# Context-Awareness Parsing Roadmap

Living tracker for making WinSTT's context capture feed **clean, segregated, helpful**
context to the two consumers — the dictation **LLM** (cleanup/compose) and the
**Whisper ASR** `initial_prompt` — across every major app.

Owned by: `electron/lib/context-snapshot.ts` (formatter + pruning),
`electron/lib/context-reader.ts` (capture orchestration),
`electron/native/src/winstt-context.c` (UIA capture),
`electron/lib/initial-prompt.ts` (ASR-tail sanitiser).
Debug with the **Context Playground** (tray → "Context Playground (debug)").

---

## Decision: GLOBAL role-based parser, NOT 24 per-app parsers

**There is no off-the-shelf library for this.** (Researched 2026-05-30.)
Mozilla Readability / Boilerpipe are HTML-DOM only and don't apply to a Windows
UIA tree. PyPI `uiautomation` only gives raw tree access. Windows Agent Arena is
a benchmark, not an extractor. The "context-aware" dictation tools (Wispr Flow,
superwhisper, VoiceInk, Lemon) all roll their own — and crucially, **none dump
the whole accessibility tree**: Wispr's own docs say it "reads **limited text
near your cursor**"; superwhisper captures selected-text + focused-input +
window-title. The focused element IS the segmentation.

So we build our own, but **app-agnostic**. Per-app special-casing is a LAST
resort, only for apps that genuinely can't be handled by the global rules.
Hardcoding 24 parsers would be unmaintainable and break on every app redesign.

### The tiered strategy

1. **Focused-field-first (SHIPPED 2026-05-30).** When the focused element yields
   a substantial body (`focusedFieldIsRich`, ≥40 de-noised chars via caret-split
   or whole-text), that IS the context. Drop the full-window axHtml tree (it's
   redundant page chrome — inbox lists, tab strips, bookmark bars). De-noise with
   `denoiseForLlm` (strip `\p{C}\p{So}`/￼/dingbats, keep line structure).
   → Covers every app that exposes its editable field via UIA TextPattern
   (Gmail, Outlook web, editors, most chat boxes). Gmail: 25KB → ~0.3KB.

2. **Terminal/console suppression (SHIPPED 2026-05-30).** `looksLikeTerminal`
   (element name matches `terminal`/`console`) → ASR tail emptied, LLM gets only
   a "Terminal focused — scrollback omitted" marker. Scrollback is re-render soup.

3. **Role-pruned tree fallback (TODO).** When the focused field is thin (empty
   reply box, canvas, Electron app with poor UIA), fall back to the tree — but
   PRUNE it by control role: keep `doc`/`edit`/`text`/`list`/`item` near the
   focused subtree; drop `toolbar`/`menu`/`tabs`/`status`/`banner`/nav. This is
   the boilerplate-removal equivalent for UIA, done globally by role + landmark,
   not per-app. (Today the tree is emitted whole, only ￼-stripped in the C layer.)

4. **Focused-subtree scoping (TODO, C layer).** Instead of walking the whole
   foreground window, walk only the ancestor "region" of the focused element
   (the nearest `doc`/`pane`/`group` landmark containing focus). Wispr-style.
   Needs `winstt-context.c` work.

5. **OCR fallback (SHIPPED earlier).** Canvas/game/RDP windows with no UIA text.

6. **Per-app overrides (LAST RESORT).** Only if an app defeats tiers 1–5. Keyed
   by `appExe` + `url`. Keep to a tiny, documented set.

---

## App target matrix

Capture each via the Context Playground, paste the JSON, diagnose, and tune the
GLOBAL rules until the LLM fragment is "just the thing I'm acting on + my draft"
and the ASR tail is clean prior-text. Mark ✅ only after a real capture confirms it.

Legend: ⬜ not yet tested · 🟡 captured, needs tuning · ✅ clean · ⛔ blocked (needs C work / per-app)

| # | App | Surface type | UIA expectation | Status | Notes |
|---|-----|--------------|-----------------|--------|-------|
| 1 | Gmail (Chrome) | webmail | 1 | ✅ | LIVE-VERIFIED 2026-05-30: Gmail flattens inbox+thread+composer into ONE doc range, so caret textBefore leaked the whole inbox (incl. one-time codes!). `stripListScrollback` cuts dated inbox rows → fragment = subject+sender+email+draft only (3891→466 chars, zero leaks). Caret cap 4000 keeps long emails. |
| 2 | Cursor | Electron/IDE | terminal OR editor | 🟡 | Terminal suppressed (tier-2). Editor pane = rich field. `appExe=cursor.exe` now resolves. |
| 3 | VS Code | Electron/IDE | editor / terminal | ⬜ | Same engine as Cursor; expect same behaviour. |
| 4 | Discord | Electron, chat | focused message box | ⬜ | Electron a11y can be thin → may hit tier-3/4. |
| 5 | Messenger | web/Electron, chat | focused message box | ⬜ | |
| 6 | Outlook | desktop or web, email | rich focused field | ⬜ | Desktop Outlook has strong UIA TextPattern. |
| 7 | Slack | Electron, chat | focused message box | ⬜ | Known thin a11y; likely needs tier-3 pruning. |
| 8 | Snapchat | desktop/web | ? | ⬜ | |
| 9 | Teams | Electron, chat | focused message box | ⬜ | |
| 10 | Telegram | desktop, chat | focused message box | ⬜ | Native Qt — UIA varies. |
| 11 | WhatsApp | desktop/web, chat | focused message box | ⬜ | Earlier capture got 7580 chars focused. |
| 12 | x.com | Chrome, compose box | rich focused field | ⬜ | Earlier capture got 4422 chars focused. |
| 13 | OneNote | desktop, doc | rich focused field | ⬜ | |
| 14 | Canva | web/canvas | thin focused field | ⛔ | Canvas → likely OCR (tier-5). |
| 15 | ChatGPT | Chrome, prompt box | rich focused field | ⬜ | |
| 16 | claude.ai | Chrome, prompt box | rich focused field | ⬜ | |
| 17 | Zoom | desktop, chat/notes | ? | ⬜ | |
| 18 | Google Sheets | Chrome, grid | thin focused (formula bar?) | ⛔ | Grid is canvas-rendered; cell value via formula bar only. May need per-app. |
| 19 | GitHub | Chrome, textarea/PR | rich focused field | ⬜ | |
| 20 | Figma | canvas | thin focused field | ⛔ | Canvas → OCR (tier-5). |
| 21 | Instagram | Chrome, DM/caption | rich focused field | ⬜ | |
| 22 | Notion | Electron, doc | focused block | ⬜ | Block-based contenteditable; test caret-split. |

(Snapchat desktop availability uncertain; treat as web if applicable.)

---

## How to iterate (the loop)

1. Open the target app, focus the real input, put the caret where you'd dictate.
2. Tray → **Context Playground (debug)** → **Copy JSON** (or the Raw JSON box).
3. Paste here. Diagnose the LLM `promptFragment` and the ASR `asrPromptTail`:
   - Is the fragment "just what I'm acting on + my draft", or polluted with chrome?
   - Did tier-1 fire (no `Visible UI (XML`)? Should it have?
   - Is the ASR tail clean prior-text, or noise/mid-word?
4. Prefer a GLOBAL fix (adjust `focusedFieldIsRich` threshold, `denoiseForLlm`,
   add tier-3 role pruning). Only reach for a per-app override if unavoidable.
5. Add/adjust a test in `context-snapshot.test.ts`; keep the suite green.
6. Update this matrix's Status + Notes.

## Done so far (2026-05-30)
- Tier 1 (focused-field-first + drop tree), Tier 2 (terminal suppression),
  `denoiseForLlm`, ASR-tail faithful display, native `appExe` fix (Toolhelp +
  `wcslen`), Copy button + Raw JSON fallback.
- **Tier 3 (role-pruned tree fallback) — SHIPPED.** `ax-prune.ts`:
  `pruneAxHtmlForLlm` parses the axHtml, anchors on `focus="1"`, climbs to the
  nearest content landmark (doc/pane/group/article holding a substantial body
  besides the thin focused field), keeps content roles + emits node names/text,
  drops chrome subtrees by role, with content-vs-nav list disambiguation
  (locality + name hints). `isCanvasSurface` gate routes Figma/Canva/Sheets to
  OCR. Wired into `context-snapshot.ts` `buildFallbackTreeSection`. 22-app
  fixture regression in `context-app-fixtures.test.ts` (generated from the
  profiling workflow). See `memory/project_context_playground_debug.md`.

## Next levers (not yet done)
- LIVE validation of all 22 apps against real captures (the loop above).
- Tier 4: focused-subtree scoping in `winstt-context.c` (only if a live capture
  shows the JS-side landmark climb is insufficient on a real cold tree).
- Raise `CARET_BEFORE_CHARS` (C) if long emails crop for the LLM in Tier 1.
- `denoiseForLlm` now lives in `ax-prune.ts` (re-exported through context-snapshot
  usage); the old copy in context-snapshot was removed.
