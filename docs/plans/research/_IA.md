# WinSTT Docs — Information Architecture

> Synthesised from `inventory-*.md` (per-feature code reality) + `example-*.md` (epicenter,
> openwhispr, thewhisper, voicetypr, whisper.cpp doc-pattern analyses). This is the recommended
> page tree for the fumadocs site at `docs/content/docs/`.

## Guiding principles (distilled from the example repos)

- **Problem-first, not feature-first.** whisper.cpp groups by hardware vendor; we group by *what the
  user is trying to do* (dictate, transcribe a file, clean up text). thewhisper's "support matrix
  early" + voicetypr's "competitor positioning in hero" set the tone for the landing page.
- **Progressive disclosure** (epicenter): hero → concept → quick start → settings → reference →
  advanced/troubleshooting → architecture. Every concept links deeper with a `→` card.
- **One screenshot per concept, framed in window chrome.** Every settings page leads with its tab
  screenshot; every feature page shows the live UI before explaining mechanics (thewhisper §5.3).
- **Tables beat prose** for catalogs, quantizations, defaults, restart-requirements, conditional
  visibility (whisper.cpp memory table, epicenter cost table).
- **Honest about limits + restart/startup-only gotchas** surfaced as callouts (voicetypr blockquotes).
- **Match depth across pages** — fix voicetypr's "installation detailed, usage vague" anti-pattern.

## Sidebar order (`meta.json`)

```
Getting Started
  index (Overview / hero)
  quick-start          [NEW]
  install              [NEW]
  recording-modes
Using WinSTT
  dictation            [NEW]
  file-transcription   [NEW]
  text-to-speech       [NEW]  (was settings/tts)
  transcription-history
  dictionary
  snippets             [NEW]
Settings (reference)
  settings/index
  settings/model
  settings/audio
  settings/quality
  settings/general
  settings/hotkey
  settings/llm
  settings/tts        (thin → redirects/links to Using > text-to-speech, OR keep as the reference tab)
  settings/integrations [NEW]
Models
  models/index
  models/whisper
  models/nemo
  models/other
  models/compute-types
---
Help
  troubleshooting
  faq
  debug-mode
  manual-model-install
  cli
  verify-releases
---
Architecture
  architecture/index, server, frontend, ipc, events
---
  acknowledgments
```

---

## Page-by-page spec

Legend: **[KEEP]** existing page, content refreshed · **[NEW]** create · **[SPLIT]** content carved
out of an existing page · screenshot names are files in `docs/public/screenshots/`.

### Getting Started

**`index.mdx` — Overview / Hero** **[KEEP, rework]**
Purpose: 10-second "what is this, why care". Competitor-positioned hero (openwhispr/voicetypr),
privacy-by-design block (already strong), key-feature BentoGrid.
Must cover: one-line pitch + "local-first, no cloud, no telemetry"; the existing 9-card feature grid →
upgrade to a `BentoGrid` with the `main` screenshot or animated `AppMock` as the hero tile.
Screenshots: **`main`** (or `AppMock`) hero; **`overlay`** small inset to tease live dictation.

**`quick-start.mdx`** **[NEW]**
Purpose: download → first dictation in under 2 minutes (thewhisper §6.1 "no 50-line setup").
Must cover: `StepFlow` — (1) download installer, (2) launch + onboarding, (3) pick a model, (4) press
PTT and speak, (5) text appears at cursor. End-user oriented (NOT dev-setup, which stays separate).
Screenshots: **`onboarding`** (step 2), **`model-picker`** (step 3), **`overlay`** + **`main`** (step 4).

**`install.mdx`** **[NEW — absorbs CPU/GPU flavor table from index]**
Purpose: which installer to download and system requirements.
Must cover: DirectML vs CPU flavor `ModelTable` (size, ORT wheel, when-to-use — straight from
root CLAUDE.md), Windows version reqs, auto-fallback note, link to `verify-releases`.
Screenshots: none required (table-driven); optional **`tray-menu`** to show post-install presence.

**`recording-modes.mdx`** **[KEEP, rework]**
Purpose: the four trigger strategies (PTT / Toggle / Listen / Wakeword) and when to use each.
Must cover: per-mode `FeatureCard` with the recording-mode color chips (PTT #3b82f6, Toggle #facc15,
Listen #22c55e, Wakeword #f97316 — from `inventory-hotkeys`); shared-pipeline note ("all four feed
one paste endpoint, only the start trigger differs"); per-mode controls table; STARTUP_ONLY badges.
Screenshots: **`settings-general`** (PTT default), **`settings-general-listen`**,
**`settings-general-wakeword`** to show how the General tab morphs per mode; **`overlay`** for the pill.

### Using WinSTT

**`dictation.mdx`** **[NEW — the missing "core loop" page]**
Purpose: the end-to-end dictation pipeline (record → transcribe → optional LLM cleanup → paste).
Must cover: paste mechanics (clipboard+Ctrl+V primary, per-char fallback), auto-submit, re-paste
hotkey, context-awareness (caret split), live-transcription display options. Cross-links to
quality, llm, hotkey reference pages.
Screenshots: **`overlay`**, **`overlay-floating`**, **`overlay-dynamic-island`**, **`main`**.

**`file-transcription.mdx`** **[NEW — SPLIT from settings/general]**
Purpose: drag-drop / batch transcribe audio files to TXT or SRT.
Must cover: supported formats, TXT vs SRT (timecodes), output format setting, where files land.
Screenshots: **`settings-quality`** (File Transcription Format control sits in Quality tab).

**`text-to-speech.mdx`** **[NEW — promote from settings/tts]**
Purpose: read selected text aloud with Kokoro-82M (54 voices / 9 langs).
Must cover: enable → on-demand ~190 MB pack download, voice picker + previews, speed, TTS hotkey
(LMeta+LShift+E, hold+Backspace to stop), device routing, "device follows model.device" note.
Screenshots: **`section-tts`**, **`settings-tts`** (if a dedicated About/Desktop tab), device routing → **`device-picker`**.

**`transcription-history.mdx`** **[KEEP, rework]**
Purpose: the local dashboard — stats, heatmap, searchable log, word-highlight playback.
Must cover: 4 stat tiles, activity heatmap (metric + calendar selector, gregorian/hijri), date-range
presets, playback w/ karaoke word-highlight, retention policy (callout: "never = keep forever, not
don't save"), max-entries, cloud-STT-has-no-audio gotcha.
Screenshots: **`settings-history`** (panel), **`history`** (the history window/table).

**`dictionary.mdx`** **[KEEP, rework]**
Purpose: teach custom vocabulary + deterministic replacement pairs.
Must cover: vocab-only vs replacement-pair table (timing: vocab→LLM prompt, replacement→after LLM),
auto-add proper-noun suggestions strip, fuzzy correction threshold (0.18 default), interplay with
LLM-on/off.
Screenshots: **`settings-dictionary`**.

**`snippets.mdx`** **[NEW — SPLIT out of dictionary; currently undocumented]**
Purpose: text expansion — short spoken trigger → longer text, fuzzy-matched.
Must cover: trigger + expansion fields, fuzzy matching, no-dedup/first-match-wins, clear-all.
Screenshots: **`settings-snippets`**.

### Settings (reference tier)

**`settings/index.mdx`** **[KEEP]** — Settings landing: a `BentoGrid` linking each tab, screenshot
montage. Screenshot: **`settings-general`** as representative thumbnail.

**`settings/model.mdx`** **[KEEP, rework]**
Purpose: STT model selection, quantization, device, realtime, translate.
Must cover: Source (local vs cloud), Model Selector, the 7-row quantization `ModelTable` (Auto/fp16/
int8/uint8/q4/q4f16/bnb4 — size + speed), Language, Device (auto/cpu), Unload Timeout, Translate to
English, Realtime Model + "locked-to-main" behavior, Update Interval. Conditional-visibility table.
Screenshots: **`settings-model`**, **`model-picker`**, **`model-dropdown`**, **`section-realtime`**.

**`settings/audio.mdx`** **[KEEP, rework]**
Purpose: input/output device, VAD tuning, mic lifecycle.
Must cover: input/output device, Silero sensitivity (note: trip = 1−sensitivity), WebRTC sensitivity
(inverse range), post-speech silence, AND-logic VAD pipeline diagram (`StepFlow`/numbered),
microphone-release policy (STARTUP_ONLY callout), clamshell mic, restart-requirements table,
not-in-UI table (sampleRate/bufferSize). Conditional: most VAD controls Listen/Wakeword-only.
Screenshots: **`settings-audio`**, **`device-picker`**.

**`settings/quality.mdx`** **[KEEP, rework]**
Purpose: endpoint timing, smart-endpoint, formatting, paste behavior.
Must cover: Context Awareness, VAD tuning (mirror), Smart Endpoint (DistilBERT) + speed multiplier,
sentence-pause heuristics (end/unknown/mid), formatting toggles (disabled when LLM cleanup on),
file-transcription format, auto-submit + key. Mutual-exclusion callout (Smart Endpoint ⊥ LLM).
Schema-only-settings table.
Screenshots: **`settings-quality`**.

**`settings/general.mdx`** **[KEEP, rework — file-transcription content moves out]**
Purpose: recording mode, display, startup, sound.
Must cover: recording mode switcher, recording sound + custom sound library, display language,
visualizer type + bar count, overlay mode/size/position, live-transcription display, start-on-login /
start-minimized / minimize-to-tray, crash reports (restart-required), reset-to-defaults.
Screenshots: **`settings-general`**, all five **`visualizer-*`** (`bar`/`grid`/`radial`/`wave`/`aura`)
in a `BentoGrid` gallery, **`overlay-floating`** + **`overlay-dynamic-island`** for overlay mode.

**`settings/hotkey.mdx`** **[KEEP, rework]**
Purpose: the four global hotkeys + combo actions.
Must cover: PTT key (default LCtrl+LMeta, max 3 keys, hidden in Listen), re-paste (LCtrl+LShift+V,
exclusive globalShortcut), TTS hotkey (LMeta+LShift+E), transform hotkey; while-held combos
(+ArrowUp cycle mode, +Backspace cancel); conflict-resolution policy (PTT anchor). Heavy `Kbd` chips.
Screenshots: **`settings-audio`** (hotkey recorder lives in Audio tab per inventory) — note the
discrepancy; embed a `Kbd`-chip `ShortcutLegend` component instead of relying on a screenshot.

**`settings/llm.mdx`** **[KEEP, rework]**
Purpose: LLM dictation cleanup + hotkey-triggered transforms.
Must cover: dictation toggle (⊥ Smart Endpoint), provider (Ollama / OpenRouter / Apple Intelligence),
model + thinking/reasoning/verbosity, tone presets (1-of-5) + independent modifiers (summarize/concise/
reorder/restructure/reword/translate) + custom modifiers, context awareness + deny-list, warmup banner,
playground; transforms = same + global hotkey + custom prompts. Preset-composition explainer
(Polish base → tone → modifiers → translate-last → schema clamp). Endpoint + timeout (note: timeout
persisted but NOT enforced).
Screenshots: **`section-llm`**.

**`settings/tts.mdx`** **[KEEP as thin reference OR redirect]** — keep a short reference stub that
points to **Using → Text-to-Speech**; avoid duplicate maintenance. Screenshot: **`section-tts`**.

**`settings/integrations.mdx`** **[NEW — currently undocumented]**
Purpose: cloud STT (OpenAI, ElevenLabs) + LLM provider keys.
Must cover: LLM endpoint (shared Ollama base), OpenAI key (Bearer, `/v1/models` verify), ElevenLabs
(`xi-api-key` header, `/v1/user`), OpenRouter key (LLM-only, not STT); 600 ms debounced verify,
status-pill states, DPAPI/safeStorage encryption, confirm-on-removal-of-active-key, "audio never
touches Python server for cloud" privacy note.
Screenshots: **`settings-integrations`**.

### Models

**`models/index.mdx`** **[KEEP, rework]**
Purpose: catalog overview — 40+ models, 7 families.
Must cover: family `ModelTable` (Whisper / Lite-Whisper / NeMo / Cohere / Moonshine / GigaAM /
Kaldi-Vosk / Canary), how to pick, link to per-family pages + compute-types. Honest leaderboard note
(Cohere #1) and gaps (Hindi, East-Asian) per project memory if user-facing.
Screenshots: **`model-picker`** (the detached picker window), **`model-dropdown`**.

**`models/whisper.mdx`** / **`nemo.mdx`** / **`other.mdx`** **[KEEP]** — per-family deep dives;
each a `ModelTable` of variants + size/quant/lang support. No new screenshots needed.

**`models/compute-types.mdx`** **[KEEP, rework]**
Purpose: the quantization + EP story (CPU vs DirectML), what each quant means.
Must cover: the same 7-row quantization table as settings/model, DirectML-vs-CPU benchmark numbers
(from CLAUDE.md), auto-fallback, "int8/CUDA is a trap" framing kept user-friendly.
Screenshots: none (table + benchmark-driven).

### Help

**`troubleshooting.mdx`** **[KEEP, rework]** — symptom→fix `ModelTable`/accordion; GPU fallback,
mic stuck, reconnecting-forever, no-audio-on-playback. Screenshots: **`tray-menu`** (restart server),
**`device-picker`** (mic selection fix).

**`faq.mdx`** **[KEEP]** — Q&A. Privacy, offline, languages, cloud-optionality. No screenshots.

**`debug-mode.mdx`** **[KEEP]** — diag bundle, logs, debug overlay. Screenshot: **`tray-menu`**.

**`manual-model-install.mdx`** **[KEEP]** — air-gapped/manual HF download steps. Screenshot:
**`model-picker`** (where manually-placed models appear).

**`cli.mdx`** **[KEEP]** — server CLI flags reference. No screenshots (code blocks).

**`verify-releases.mdx`** **[KEEP]** — minisign verification steps. No screenshots.

### Architecture (developer tier — keep as-is structurally)

**`architecture/{index,server,frontend,ipc,events}.mdx`** **[KEEP]** — hexagonal server, FSD frontend,
dual-channel WS, IPC + event contracts. ASCII diagrams (epicenter pattern) over heavy SVG. Optional
**`main`** screenshot in frontend.mdx to anchor the renderer description.

**`dev-setup.mdx`** **[KEEP]** — dev environment (bun/uv commands). Stays separate from `quick-start`
(end-user). Could move under Architecture or keep at top — recommend moving it near Architecture so the
top of the sidebar is end-user-first.

**`acknowledgments.mdx`** **[KEEP]** — upstream credits with links (thewhisper §5.8 / openwhispr §6).

---

## Screenshot → page assignment matrix

| Screenshot | Primary page | Secondary uses |
|---|---|---|
| `main` | index (hero) | quick-start, dictation, architecture/frontend |
| `onboarding` | quick-start | install |
| `overlay` | dictation | index inset, recording-modes |
| `overlay-floating` | settings/general (overlay mode) | dictation |
| `overlay-dynamic-island` | settings/general (overlay mode) | dictation |
| `tray-menu` | install | troubleshooting, debug-mode |
| `device-picker` | settings/audio | text-to-speech, troubleshooting |
| `model-picker` | models/index | settings/model, quick-start, manual-model-install |
| `model-dropdown` | settings/model | models/index |
| `settings-general` | settings/general | recording-modes, settings/index |
| `settings-general-listen` | recording-modes (Listen) | settings/general |
| `settings-general-wakeword` | recording-modes (Wakeword) | settings/general |
| `settings-model` | settings/model | — |
| `section-realtime` | settings/model (realtime) | — |
| `settings-audio` | settings/audio | settings/hotkey |
| `settings-quality` | settings/quality | file-transcription |
| `settings-dictionary` | dictionary | — |
| `settings-snippets` | snippets | — |
| `settings-history` | transcription-history | — |
| `history` | transcription-history | index feature card |
| `settings-integrations` | settings/integrations | — |
| `section-llm` | settings/llm | — |
| `section-tts` | text-to-speech | settings/tts stub |
| `settings-tts` | text-to-speech | — |
| `settings-about` | (footer/About) — link in index or a small About page | — |
| `visualizer-bar` | settings/general gallery | index |
| `visualizer-grid` | settings/general gallery | — |
| `visualizer-radial` | settings/general gallery | — |
| `visualizer-wave` | settings/general gallery | — |
| `visualizer-aura` | settings/general gallery | — |

> Gap: `settings-about` has no obvious home — recommend a tiny About blurb in `index` or a
> dedicated `about.mdx` under Help (version, links, license). No screenshot lacks a target otherwise.

## NEW pages summary (8)

1. `quick-start.mdx` — end-user 2-minute path
2. `install.mdx` — installer flavor table + requirements
3. `dictation.mdx` — the core record→paste loop
4. `file-transcription.mdx` — TXT/SRT batch (split from general)
5. `text-to-speech.mdx` — promote TTS to a usage page
6. `snippets.mdx` — text expansion (was undocumented)
7. `settings/integrations.mdx` — cloud STT + provider keys (was undocumented)
8. (optional) `about.mdx` — home for `settings-about` screenshot + version/license
