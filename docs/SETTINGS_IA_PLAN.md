# WinSTT Settings — from-scratch IA plan

Derived from a full audit of all 11 tabs (`.settings-audit.md`). This plan is the
source of truth for the reorg. **Store keys and i18n control-keys do NOT change** —
only *which panel renders which control* and the *tab list* change. Cross-namespace
i18n references are fine (already proven with the transform hotkey).

## The problem (from the audit)

- Settings are sliced on **3+ axes at once**: by resource (Model), by IO device
  (Audio), by pipeline stage (Processing/quality), by feature (Dictionary, Snippets,
  History, TTS), by scope (General, Integrations, About). Anything that doesn't fit
  one axis (hotkeys, LLM post-processing) has multiple plausible homes.
- **~25 cross-tab couplings.** `general.recordingMode` gates controls on Audio,
  Model, and Processing. VAD keys (`audio.*`) are edited on *both* Audio and
  Processing. The output device is stored in `general.outputDeviceId` but rendered in
  Audio. Model-tab realtime controls write `quality.*` keys. Recording sound is in
  General but is conceptually output feedback.
- **"General" is a grab-bag**: input (recording mode) + appearance (visualizer) +
  output (sound, ducking) + system (startup, crash) all in one tab.
- Hotkeys are buried under "Audio" (a device concept) and some appear/disappear based
  on a *different* tab's feature being enabled.

## The principle

Organize by the **user's mental model**, on **one consistent axis**: the transcript's
journey — **Capture → Recognize → Process → Output** — plus cross-cutting tabs that
genuinely don't sit on the pipeline (Shortcuts, Appearance, Data, App). Two sub-rules:
**proximity** (a setting lives next to what it configures) and the **consolidation
exception** (cross-cutting concerns — keyboard shortcuts above all — get exactly one
home, because users reason about them as a set and they need conflict-checking).

A key win: co-locating coupled settings *removes* cross-tab gating. Recording mode +
input device + VAD + endpointing all land on one **Recording** tab, so the gating that
spanned three tabs becomes local.

## Target tabs (sidebar order, grouped by separators)

### — Pipeline —

**1. Recording** · `Mic01Icon` · *How audio is captured and how recording starts/stops*
- Recording **mode** (PTT / Toggle / Listen / Wake word) — hero control  ← from General
  - mode sub-controls: Stop-only-on-hotkey (toggle), Loopback device (listen),
    Wake word + Sensitivity + Follow-up timeout (wakeword)  ← from General
- **Input device** + **Clamshell microphone**  ← from Audio
- **Endpointing**: VAD (Silero / WebRTC / Post-speech-silence), **Smart Endpoint** +
  Detection speed, **Sentence Pauses** (end/unknown/mid)  ← from Processing(quality)
- **Advanced**: Microphone release  ← from Audio

**2. Model** · `CpuChargeIcon` · *The recognition engine*
- STT **Source** (local/cloud) + model picker + quantization + Language +
  Translate-to-English + Initial prompt + Model unload timeout  ← stays
- **Realtime** model + Use-main-model + Update interval  ← stays
- **Compute device** (shared by local STT + local TTS)  ← stays
- **Speaker diarization**  ← from General
- (stops hosting the LLM + TTS slots — those move to Processing / Output)

**3. Processing** · `MagicWand01Icon` · *Text cleanup & transforms after recognition*
- **Dictation post-processing** (LLM): provider / model / tone / modifiers  ← from LLM tab
- **Text transformation** (LLM): provider / model / tone / modifiers  ← from LLM tab
- **Context awareness** + deny-list  ← from Processing(quality)
- **Formatting**: Uppercase first letter / End with period / Remove filler words  ← from Processing(quality)
- **LLM Playground** (header action)  ← from LLM tab
- Tab title: rename `llm.title` usage → "Processing" (settings tab label)

**4. Vocabulary** · `TextIcon` · *Phrase substitution lists*  [Dictionary + Snippets merged]
- **Dictionary** terms + Correction strictness  ← from Dictionary tab
- **Snippets**  ← from Snippets tab

**5. Output** · `VolumeHighIcon` · *Emitting text, audio feedback, and speech*
- **Paste behavior**: Auto-submit + Submit key  ← from Processing(quality)
- **File transcription** format  ← from Processing(quality)
- **Output device**  ← from Audio (key already `general.outputDeviceId`)
- **Recording sound** + Sound library  ← from General
- **Reduce system audio while dictating** (ducking)  ← from General
- **Text-to-Speech** (full feature)  ← from Model-tab TTS slot

### — Controls & Appearance —

**6. Shortcuts** · `KeyboardIcon` · *All global hotkeys*
- Push-to-Talk key, Re-paste key, Text-to-speech key, Text-transformation key  ← from Audio
- Shortcuts legend  ← from Audio

**7. Appearance** · `DashboardCircleIcon` · *Display & visuals*
- Display **language**  ← from General
- **Visualizer** style + all shape controls  ← from General
- **Recording overlay** (off+size) + Overlay layout + Live transcription display  ← from General

### — Data & App —

**8. History** · `ChartHistogramIcon` — unchanged (history views + max-entries + retention)

**9. Integrations** · `PlugSocketIcon` — unchanged (OpenAI / ElevenLabs / OpenRouter keys + Ollama endpoint)

**10. About** · `InformationCircleIcon` · *App info + system prefs*
- Version / Updates / License / Third-party notices  ← stays
- **Start on login**, **Send crash reports**, **Pre-release updates**  ← system bits from General
- **Reset all defaults**  ← from General

## Tabs that dissolve

- **General** → fully redistributed (Recording / Appearance / Output / About). Gone.
- **Audio** → Recording (devices+release) + Shortcuts (hotkeys) + Output (output device). Gone.
- **Processing(quality)** → Recording (VAD/endpoint/pauses) + Processing (context+formatting) + Output (paste+file). Gone as a separate "quality" panel; the name "Processing" is reused for the LLM-centric tab.
- **Dictionary** + **Snippets** → Vocabulary. Gone as separate tabs.
- **LLM** (slot) → becomes the standalone **Processing** tab.
- **TTS** (slot) → moves into **Output**.

Net: 11 → **10** tabs, all on one axis.

## Implementation strategy

Store slices stay (`general.*`, `quality.*`, `audio.*`, `llm.*`, `tts.*`, …) — FSD
store slicing is independent of UI tabs. Only panel composition + the tab list change.

**Phase 1 (parallelizable — each writes a NEW file, only READS old panels):**
build the new self-contained widget panels — `recording-settings`,
`appearance-settings`, `shortcuts-settings`, `output-settings`, `vocabulary-settings`.
Each composes existing exported control components where they exist and copies inline
control JSX (+ its imports/helpers) where they don't.

**Phase 2 (sequential, done by the orchestrator):**
- Extend `ProcessingSettingsPanel` (= current LLM panel) with Formatting + Context sections.
- Extend `ModelSettingsPanel` with Speaker diarization; stop rendering LLM + TTS slots.
- Extend `AboutSettingsPanel` with start-on-login / crash / reset-all.
- Rewire `SettingsPage.tsx` tab list + `SettingsSidebar` links/groups.
- Add new `settings.tab*` i18n labels (10 tabs) across all 20 locales.
- Update `settings-search` keywords.
- Delete obsolete panels (General, Audio, Quality, Dictionary, Snippets standalone).
- Run gates: `eslint`, `tsc`, `check:i18n`, settings tests. Fix integration issues.
- **Manual smoke test required** (agents can't run the app): open each tab, toggle a
  control per section, confirm persistence + no console errors.

## i18n note

All control-level keys stay in their current namespaces (audio/general/hotkey/llm/
tts/quality/dictionary/snippets/integrations/about). Panels reference whatever
namespaces they need via multiple `useTranslations(...)` calls. Only **tab labels**
(`settings.tab*` + tooltips) are added/renamed — that's the sole 20-locale touch.
