# Cross-Platform Context-Awareness Strategy

> Research date: 2026-06-15. Sources cited inline. Companion to
> [`CONTEXT_AWARENESS_PROGRESS.md`](./CONTEXT_AWARENESS_PROGRESS.md) (the
> Windows-only status quo this plan supersedes).

## 0. The question

The current context-awareness engine (`winstt_context.exe` + the CDP/UIA harness)
is **100% Windows-bound**: it is built on Windows UI Automation, a Windows-only COM
API. It does not run on macOS or Linux. Before investing more, what is the
*global* architecture that (a) works on Windows + macOS + Linux and (b) gives clean,
structured, who-said-what context across all the target apps?

## 1. How the competitors actually do it (verified)

| Product | Platforms | Capture mechanism | Conversation / who-said-what? |
|---|---|---|---|
| **Wispr Flow** | mac, Win, iOS, Android | OS **accessibility API** for focused-field + app identity + proper nouns near cursor; clipboard-paste insertion; **optional** screen-OCR (opt-in, privacy incident → "Privacy Mode") | Only special-cased per app (**Slack, Apple Messages** thread reading). Not universal. |
| **superwhisper** | mac, iOS, **Win (Dec 2025)** | **Accessibility API only** — focused field + window title + selection + recent clipboard. **No screen recording.** | **No.** Grabs the focused field, not a threaded transcript. |
| **Lemon** (heylemon.ai) | macOS only | Accessibility API + **on-demand** screenshot + **OAuth integrations** (Gmail/Cal/Drive) | No. Single-user command agent. |
| **Aqua / Willow** | mac, Win, iOS | Focused-field + app-identity (+ optional screen-read) | No. |
| **Talon** | Win, mac, Linux/X11 | Deep accessibility-API control | No (voice *control*, not context). |
| **Otter / Granola** | mac/Win/web | **Meeting-audio diarization** (voiceprints / Me-vs-Them) | **Yes — but walled inside a meeting's audio transcript**, not across apps. |
| **Cluely / Recall** | mac, Win | Continuous **screen-OCR** (+ system-audio) → LLM | No per-speaker structure. |

### The market gap (our wedge)
**Nobody has solved clean structured "who-said-what across arbitrary apps."**
The field splits into three non-overlapping buckets:
- **(a)** focused-field / accessibility dictation (Wispr, superwhisper, Lemon, Aqua, Willow, Talon) — knows the active field, **zero speaker model**;
- **(b)** screen-OCR / vision (Cluely, Recall) — reads pixels, **no identity structure**;
- **(c)** meeting-audio diarization (Otter, Granola) — real speaker IDs, but **locked inside one meeting's audio**.

Speaker/authorship attribution and cross-app structured context live in *separate
products*. Fusing them — exactly the hard thing we already de-risked on Windows — is
unoccupied territory. **That is the defensible differentiator, not the platform API.**

### Two facts that decide the architecture
1. **superwhisper shipped a Windows port with feature parity (Dec 2025).** Direct
   evidence that **macOS AX is not meaningfully better than Windows UIA** for the
   focused-field + selection job. We don't need to "move to Mac" for quality.
2. **Conversation-turn structure only reaches the accessibility tree if the web app
   authored it** — and ChatGPT/Gemini/Gmail-inline often *don't*. This is true on
   **every** OS (Win UIA, mac AXWebArea, Linux AT-SPI). The turns live in the **DOM**
   (`data-message-author-role`, `<user-query>`/`<model-response>`, `conversation-turn`),
   which the a11y tree is only a lossy projection of. **No OS accessibility API can fix
   this — only the DOM can.** This is precisely the "structural limit" we hit on
   ChatGPT/Gemini in the Windows build.

## 2. The capture-strategy families (with verdicts)

| Strategy | Portability | Web who-said-what | Native-app coverage | Cost / risk |
|---|---|---|---|---|
| **A. Per-OS accessibility** (UIA / AXUIElement / AT-SPI2) | 3 separate impls | **Partial→poor** (apps must author turns) | **Good** | macOS TCC prompt; Linux/Wayland flaky |
| **B. Browser extension + DOM** | **1 codebase, all OSes** | **Excellent** (DOM = ground truth) | **None** (web only) | per-site adapter maintenance; Safari needs App-Store wrapper |
| **C. Screen-OCR / local VLM** | cross-platform | poor (OCR loses attribution; small VLMs unreliable + slow) | **Universal** | privacy (Recall-style leaks); latency |
| **D. App official APIs** | cross-platform | excellent (full thread) | n/a | **no "focus" concept**; OAuth/ToS/economics bad |

**Conclusion:** no single family wins. The right design is a **capability-tiered set of
providers** behind one contract, with a router that picks the best available tier for
the focused app — and the existing portable Rust core (normalizer + OTP scrub + prompt
formatter) as the funnel everything flows through.

## 3. Target architecture — "Context Providers" behind a portable core

```
                    focused app/window
                            │
                 ┌──────────▼───────────┐
                 │   Provider Router     │  picks best available tier per app
                 └──────────┬───────────┘
        ┌──────────┬────────┼─────────┬──────────────┐
        ▼          ▼        ▼          ▼              ▼
   A. Native    B. Browser  C. Screen  (D. App-API   (clipboard /
   a11y         extension   OCR/VLM     enrichment,   selection
   (UIA/AX/     DOM provider fallback   opt-in)       baseline)
    AT-SPI)     (web apps)  (last resort)
        └──────────┴────────┼─────────┴──────────────┘
                            ▼
        ┌───────────────────────────────────────────┐
        │  PORTABLE RUST CORE  (already built)        │
        │  • flat JSON contract (Author: text lines)  │
        │  • json_scrub_secret_codes (OTP redaction)  │
        │  • format_context_for_prompt_json           │
        │  • speaker-turn reconstruction              │
        └───────────────────────────────────────────┘
                            ▼
                   LLM reply / dictation
```

**Provider trait (one contract, many backends):**
```rust
trait ContextProvider {
    fn can_handle(&self, focus: &FocusInfo) -> Confidence; // app/url/window match
    fn capture(&self, focus: &FocusInfo) -> Result<RawContext>; // → flat JSON
}
```
Every provider returns the **same `RawContext`** that `context.rs` already normalizes,
scrubs, and formats. The router scores providers by `can_handle` (Tier B for a matched
web app, Tier A for native, Tier C as floor) and merges (e.g. Tier-B thread + Tier-A
draft field).

### Why this is the answer
- **It makes us cross-platform** — the Tauri shell already is; only the *capture* layer
  is Windows-bound. Tier B is OS-independent by construction; Tier A is the only part
  that needs per-OS work; the whole normalize/scrub/format core is already portable Rust.
- **It fixes the surfaces we documented as unfixable.** ChatGPT/Gemini/Gmail-inline turns
  are unreachable via *any* accessibility API but trivially available in the DOM. The
  browser-extension provider turns our biggest structural limits into clean captures.
- **It leans into the market gap.** Tier B's role-tagged DOM turns + the existing
  speaker-reconstruction core is the who-said-what-across-apps capability nobody else has.

## 4. Provider details

### Tier B — Browser-extension DOM provider  ★ keystone, build first
- **One MV3 content-script extension**, per-site adapters with selector fallback chains:
  - ChatGPT `[data-message-author-role="user|assistant"]` → `[data-testid^="conversation-turn-"]`
  - Claude `[data-testid="conversation-turn"]` (+ `human-turn-input`)
  - Gemini `<user-query>.query-text` / `<model-response> .markdown`
  - Gmail bodies (gmail.js-style in-DOM read); Discord/X anchor on `aria-label`/`role`/`data-*` (hashed classes).
- **Bridge = token-authenticated localhost WebSocket** (WinSTT runs the server; extension
  connects). Chosen over Native Messaging: no per-browser/per-OS host-manifest registration,
  no 1 MB cap (full transcript), and live WS traffic keeps the MV3 service worker warm
  (Chrome 116+). Bind `127.0.0.1` only + per-launch token.
- **Coverage:** all 9 web targets on Chromium + Firefox (Win/Linux ≈100%). Safari needs
  `safari-web-extension-converter` + App-Store distribution (defer).
- **Does NOT cover** native desktop apps → Tier A.

### Tier A — Native accessibility provider (per-OS, behind the trait)
- **Windows: UIA** — already built (`winstt_context.rs`). Wrap behind the trait.
- **macOS: AXUIElement / NSAccessibility** — `AXFocusedUIElement`, `AXSelectedText`,
  `AXWebArea` + `AXTextMarkerRange`. Crates: `accessibility` / `accessibility-sys` +
  `objc2-app-kit`. Needs the **TCC Accessibility** prompt (signed app).
- **Linux: AT-SPI2 over D-Bus** — crate `atspi`. Works (Chromium needs
  `--force-renderer-accessibility`); **Wayland is fragile** (reliable only on GNOME 48+),
  X11 fine. Treat as best-effort.
- Note: `accesskit` is for *exposing* our own app — **not** for reading others. Don't use it here.

### Tier C — Screen-OCR / VLM fallback (cross-platform, on-demand only)
- Capture: **`scap`** (ScreenCaptureKit/PipeWire/WGC — best Wayland story) or **`xcap`**
  (simple X11/Win/mac stills). macOS Screen-Recording TCC + Wayland portal consent.
- OCR: native **Windows.Media.Ocr** / **Apple Vision** (offline, fast); **Tesseract** on Linux.
- **Quality ceiling = flat, possibly-misattributed text.** OCR loses sender attribution;
  small local VLMs (Moondream/Florence-2/Qwen2.5-VL-3B) are slow (multi-second) and
  unreliable at spatial who-said-what today. **Strictly the last resort**, gated on the
  dictation trigger (never periodic), with the OTP scrub + per-app denylist for
  banking/password managers.

### Tier D — App-API enrichment (optional, narrow)
- **Not a global tier** — no "focus" concept, per-service OAuth, ToS-risky (Discord
  self-bot is bannable), impossible (WhatsApp personal), or absurd economics (X API).
- **Only worthwhile** scoped to opt-in **Gmail / Outlook (Graph) / Slack** to *backfill
  truncated thread bodies* once the focus tier already identified the thread. Defer.

## 5. Privacy (portable, already partly built)
- `json_scrub_secret_codes` (OTP/verification-code redaction) is **OS-independent Rust**
  in the core — it already protects every provider's output. Keep it as the single choke
  point. (Open item: extend the English-keyword anchor to non-English codes — the WhatsApp
  Arabic delivery-code residual.)
- Tier C adds the biggest new risk (screenshots capture secrets): on-demand only, local
  processing, per-app denylist, OCR-then-discard, scrub before any LLM. Explicit opt-in.

## 6. Phased plan

**Phase 0 — Refactor to the provider contract (Windows, no behavior change).**
Extract `ContextProvider` trait; wrap the existing UIA path as `WindowsA11yProvider`; route
through it. Pure refactor; keeps all current Windows behavior + tests green.

**Phase 1 — Browser-extension DOM provider (the keystone; cross-platform immediately).**
MV3 extension + per-site adapters (start ChatGPT/Claude/Gemini/Gmail — the surfaces the
a11y path can't do) + localhost-WebSocket bridge in the Tauri core + normalize through the
existing `context.rs`. This alone fixes ChatGPT/Gemini/Gmail-inline **and** runs on all
three OSes. Retire the brittle CDP/UIA web harness for these apps.

**Phase 2 — macOS native provider (Tier A).** AXUIElement impl behind the trait for native
apps + focused-field/selection. Ship macOS dictation with parity to superwhisper's baseline,
plus Tier B for web. (Requires the Tauri app to build/sign on macOS + TCC onboarding UX.)

**Phase 3 — Linux native provider + screen-OCR fallback (Tier C).** AT-SPI2 provider
(X11-first, Wayland best-effort) + the on-demand OCR floor for unsupported apps.

**Phase 4 (optional) — App-API enrichment** for Gmail/Outlook/Slack power users.

## 7. The one-line reframe
We have been fighting Windows UIA to extract DOM structure it fundamentally cannot expose —
and the research confirms **no OS's accessibility API can**. The fix is to put each provider
where the structure actually lives: the **DOM** (browser extension) for web apps, **native
accessibility** for desktop apps, **OCR** as the floor — all funneling into the portable
Rust core we already built. That single move makes us cross-platform *and* fixes the exact
surfaces we'd marked "structural limit."
