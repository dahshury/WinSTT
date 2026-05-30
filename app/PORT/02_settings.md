# 02 — Settings (port slice)

Ports WinSTT's ~150-field nested settings tree to a single specta-typed Rust
struct, `WinsttSettings`, in
[`src-tauri/src/winstt/settings_schema.rs`](../src-tauri/src/winstt/settings_schema.rs).

- **Authoritative source:** WinSTT's Zod schema
  `frontend/src/shared/config/settings-schema.ts` (`appSettingsSchema`).
  The OpenAPI spec is **stale** — it lacks the entire `tts` section, most
  `audio.*` / `general.*` fields, and `model.translateToEnglish` /
  `model.modelUnloadTimeout`, and it still carries dead fields
  (`model.computeType`, `model.accelerator`, `model.beamSize`,
  `quality.batchSize`, `general.visualizerColor`). **Do not use the spec.**
- **Why nested (not flat like Handy):** the reused React renderer reads
  `settings.model.realtimeModel`, `settings.general.liveTranscriptionDisplay`,
  etc. Keeping the 9-tab nesting means the renderer maps onto the Tauri
  `get_settings` / `set_settings` payload 1:1 with no transform layer. (Handy's
  own `AppSettings` is flat; we deliberately diverge here because we inherit
  WinSTT's renderer, not Handy's.)
- **Wire format:** every struct is `#[serde(rename_all = "camelCase")]`, every
  enum carries an explicit serde spelling. The JSON keys are byte-identical to
  what WinSTT's electron-store persisted, so existing `settings.json` migrates.

> ⚠️ Drift note vs the verified inventory `01_settings_schema.md`: that doc
> (written 2026-05-29) still lists `model.computeType` and `tts.device`. Both
> have since been **removed** from the live Zod schema (WinSTT is ONNX-only —
> memory `feedback_onnx_only_no_realtimestt_remnants`; TTS shares `model.device`
> — memory `project_tts_device_follows_model_device`). The Rust struct follows
> the **current** Zod schema, which is authoritative.

---

## The 9 sub-structs (tab → Rust type)

| Tab | Rust type | # fields | Notes |
|---|---|---|---|
| model | `ModelSettings` | 10 | STT engine + decode config |
| quality | `QualitySettings` | 11 | realtime + endpointing tuning |
| audio | `AudioSettings` | 14 | mic / VAD / capture |
| general | `GeneralSettings` | 50 | the catch-all tab (overlay, visualizer, wakeword, history, context, onboarding…) |
| hotkey | `HotkeySettings` | 1 | PTT key |
| dictionary | `Vec<DictionaryEntry>` | n | vocab-bias + replacement pairs |
| snippets | `Vec<SnippetEntry>` | n | text-expansion pairs |
| llm | `LlmSettings` | 5 + nested | shared infra + per-feature `dictation`/`transforms` |
| tts | `TtsSettings` | 7 + `cloud` | Kokoro local / ElevenLabs cloud |
| integrations | `IntegrationsSettings` | `openai` + `elevenlabs` | cloud STT credentials (secrets) |

`WinsttSettings::default()` reproduces `appSettingsSchema.parse({})` exactly;
the `#[cfg(test)]` suite asserts every default value against the Zod schema and
verifies the camelCase wire format + the empty-`{}`-hydrates-to-defaults
guarantee.

---

## Field inventory (defaults from the Zod schema)

### `model` — `ModelSettings`

| Field (camelCase) | Rust type | Default | Swap |
|---|---|---|---|
| `model` | `String` | `"tiny"` | HOT (engine swap) |
| `realtimeModel` | `String` | `"tiny"` | HOT |
| `language` | `String` | `"en"` (`""`=auto) | HOT |
| `device` | `DeviceType` | `auto` | **STARTUP** (ORT EP bind) |
| `backend` | `TranscriberBackend` | `faster_whisper`† | HOT |
| `onnxQuantization` | `String` | `""` | HOT |
| `initialPrompt` | `String` | `""` | HOT‡ |
| `initialPromptRealtime` | `String` | `""` | HOT |
| `translateToEnglish` | `bool` | `false` | HOT |
| `modelUnloadTimeout` | `ModelUnloadTimeout` | `min5` | HOT |

† The unified `ort` engine ignores `backend` for routing (it derives the family
from the model id); the field is kept only for settings round-trip parity.
‡ **Invariant:** Canary/Cohere ignore the prompt slot (untrained) — don't bias
them (memory `project_canary_cohere_prompt_slot_untrained`).
Model id may be `<provider>:<id>` for cloud STT (`openai:whisper-1`) — there is
no separate cloud section; the load path routes on the prefix.

### `quality` — `QualitySettings`

| Field | Type | Default | Range | Swap |
|---|---|---|---|---|
| `useMainModelForRealtime` | `bool` | `false` | — | **STARTUP** |
| `realtimeProcessingPause` | `f64` | `0.02` | — | **STARTUP** |
| `initRealtimeAfterSeconds` | `f64` | `0.2` | — | **STARTUP** |
| `earlyTranscriptionOnSilence` | `f64` | `0.2` | — | **STARTUP** |
| `ensureSentenceStartingUppercase` | `bool` | `true` | — | HOT |
| `ensureSentenceEndsWithPeriod` | `bool` | `true` | — | HOT |
| `smartEndpoint` | `bool` | `true` | — | HOT |
| `smartEndpointSpeed` | `f64` | `2.0` | 0.5–3.0 | HOT |
| `endOfSentenceDetectionPause` | `f64` | `0.45` | 0.1–5.0 | HOT |
| `midSentenceDetectionPause` | `f64` | `2.0` | 0.1–10.0 | HOT |
| `unknownSentenceDetectionPause` | `f64` | `1.3` | 0.1–5.0 | HOT |

### `audio` — `AudioSettings`

| Field | Type | Default | Range | Swap |
|---|---|---|---|---|
| `inputDeviceIndex` | `Option<i64>` | `null` | — | HOT |
| `sampleRate` | `i64` | `16000` | — | STARTUP (CLI) |
| `bufferSize` | `i64` | `512` | — | STARTUP (CLI) |
| `sileroSensitivity` | `f64` | `0.7` | 0–1 | HOT (Silero VAD **CPU-only** invariant) |
| `sileroUseOnnx` | `bool` | `false` | — | STARTUP (CLI) |
| `sileroDeactivityDetection` | `bool` | `true` | — | HOT (persist-only) |
| `webrtcSensitivity` | `i64` | `3` | 0–3 | HOT (`set_mode`) |
| `postSpeechSilenceDuration` | `f64` | `0.7` | — | HOT |
| `minGapBetweenRecordings` | `f64` | `0` | — | HOT |
| `preRecordingBufferDuration` | `f64` | `1.0` | — | STARTUP |
| `sileroSensitivityByDeviceName` | `HashMap<String,f64>` | `{}` | per-device | HOT (re-applied on device switch) |
| `clamshellMicrophone` | `Option<i64>` | `null` | — | STARTUP |
| `microphoneRelease` | `MicrophoneRelease` | `immediate` | — | HOT |
| `extraRecordingBufferMs` | `i64` | `0` | 0–2000 | HOT |

### `general` — `GeneralSettings` (50 fields)

Highlights (full set in the struct; all HOT unless flagged):

| Field | Type | Default | Swap |
|---|---|---|---|
| `autoStart` / `minimizeToTray` / `startMinimized` | `bool` | `false`/`true`/`false` | HOT |
| `systemAudioReductionWhileDictating` | `i64` | `0` (0–100, step 20) | HOT |
| `recordingSound` / `recordingSoundPath` | `bool`/`String` | `true`/`""` | HOT |
| `recordingSoundLibrary` | `Vec<SoundLibraryEntry>` | `[]` | HOT |
| `fileTranscriptionFormat` | `FileTranscriptionFormat` | `txt` | HOT |
| `fileTranscriptionSaveLocation` | `FileSaveLocation` | `auto` | HOT |
| `recordingMode` | `RecordingMode` | `ptt` | **CONDITIONAL** (wakeword boundary) |
| `manualToggleStop` | `bool` | `false` | HOT |
| `repasteHotkey` | `String` | `"LCtrl+LShift+V"` | HOT |
| `loopbackDeviceIndex` | `Option<i64>` | `null` | HOT |
| `wakeWord` / `wakeWordSensitivity` / `wakeWordTimeout` | `String`/`f64`/`f64` | `"alexa"`/`0.6`/`5` | **CONDITIONAL** (in wakeword mode) |
| `showRecordingOverlay` | `bool` | `true` | **CONDITIONAL** (effective-realtime) |
| `overlayMode` | `OverlayMode` | `floating-bottom` | HOT |
| `overlayPosition` | `OverlayPosition` | `auto` | HOT |
| `visualizerSize` | `VisualizerSize` | `xs` | HOT |
| `liveTranscriptionDisplay` | `LiveTranscriptionDisplay` | `both` | **CONDITIONAL** (effective-realtime) |
| `visualizerType` | `VisualizerType` | `bar` | HOT |
| `visualizerBarCount` | `i64` | `9` (3–21) | HOT |
| `visualizerRadial*` / `visualizerGrid*` / `visualizerWave*` / `visualizerAura*` | mixed | per-shape defaults | HOT |
| `contextAwareness` | `bool` | `false` | HOT |
| `contextDenyList` | `Vec<String>` | seeded password-manager list | HOT |
| `speakerDiarization` | `bool` | `false` | HOT (runtime toggle) |
| `sendCrashReports` | `bool` | `true` | **STARTUP** (Sentry init once) |
| `receivePrereleaseUpdates` | `bool` | `false` | HOT |
| `onboarded` / `onboardedAt` / `onboardedTrack` | `bool`/`Option<i64>`/`OnboardedTrack` | `false`/`null`/`""` | MAIN-owned (not user controls) |
| `outputDeviceId` | `String` | `""` | HOT |
| `autoSubmit` / `autoSubmitKey` | `bool`/`AutoSubmitKey` | `false`/`enter` | HOT |
| `historyMaxEntries` | `i64` | `1000` (10–10000) | HOT |
| `recordingRetention` | `RecordingRetention` | `cap` | HOT |
| `wordCorrectionThreshold` | `f64` | `0.18` (0–1) | HOT |
| `filterFillers` / `customFillerWords` | `bool`/`Vec<String>` | `true`/`[]` | HOT |

The visualizer per-shape knobs (radial dot-count/radius; grid rows/cols/speed;
wave line-width/smoothing/color-shift; aura shape/blur/bloom/color-shift) are
all renderer-only UI state — HOT, never restart.

### `hotkey` — `HotkeySettings`

| Field | Type | Default | Swap |
|---|---|---|---|
| `pushToTalkKey` | `String` | `"LCtrl+LMeta"` | HOT (passive) |

### `dictionary` / `snippets`

- `DictionaryEntry { id, term, replacement? }` — `replacement` absent ⇒
  vocab-bias word; present ⇒ deterministic whole-word replacement after LLM cleanup.
- `SnippetEntry { id, trigger, expansion }`.

Both default `[]`. (Zod `.catch([])` on `dictionary` to survive the pre-v10
shape migration — see the persistence-layer note below.)

### `llm` — `LlmSettings`

Shared infra: `endpoint` (`"http://localhost:11434"`), `openrouterApiKey`
(**SECRET**), `timeout` (`5000` ms; persisted, not network-applied).

Per-feature `dictation` and `transforms` each flatten an `LlmFeatureBase`
(`provider` ollama / `model` / `openrouterModel` / `openrouterFallbackModel` /
`reasoningEffort` medium / `verbosity` medium / `maxOutputTokens` null /
`thinkingEffort` medium) plus `enabled` (false), `presets`
(`[{key:"neutral"}]`), `customModifiers` (`[]`). `transforms` additionally has
`hotkey` (`"LCtrl+LShift+T"`) and `prompts` (`Vec<Transform>`).

`LlmFeatureBase` is `#[serde(flatten)]`-ed into both so the JSON is
`llm.dictation.provider`, `llm.dictation.openrouterModel`, … (matching Zod's
`...llmFeatureBaseShape` spread). All HOT.

Preset cross-field rules (no dup keys; ≤1 tone key; `level` only for
summarize/concise; `targetLang` only for translate) are **enforced at the
application layer**, not by the Rust types — the same way Zod's `.refine()`
runs at parse time. The settings-apply command should re-validate.

### `tts` — `TtsSettings` (not in OpenAPI)

`enabled` (false), `voice` (`"af_heart"`), `lang` (`"en-us"`), `speed` (`1.0`,
0.5–2.0), `hotkey` (`"LMeta+LShift+E"`), `source` (`local`), nested `cloud`
(`voice ""`, `model "eleven_multilingual_v2"`, `stability 0.5`,
`similarity 0.75`, `style 0`, `speed 1.0`, `speakerBoost true`). All HOT.
No per-TTS device — TTS shares `model.device`. Cloud TTS reuses
`integrations.elevenlabs.apiKey` (no new secret here).

### `integrations` — `IntegrationsSettings`

`openai` and `elevenlabs`, each a `ProviderIntegrationStatus { apiKey
(**SECRET**), verified (Option<bool>=null), lastVerifiedAt (Option<i64>=null) }`.

---

## Hot-swap vs restart (the `STARTUP_ONLY_KEYS` set)

The struct exposes the classification as machine-readable consts (mirrors
WinSTT's `STARTUP_ONLY_KEYS_LIST` in `electron/ipc/settings.ts`, minus the
retired `model.computeType`):

```rust
pub const STARTUP_ONLY_KEYS: &[&str] = &[
    "model.device",
    "quality.useMainModelForRealtime",
    "quality.realtimeProcessingPause",
    "quality.initRealtimeAfterSeconds",
    "quality.earlyTranscriptionOnSilence",
    "general.sendCrashReports",
];
pub const WAKEWORD_CONFIG_KEYS: &[&str] = &[ /* recordingMode + wakeWord{,Sensitivity,Timeout} */ ];
pub const REALTIME_EFFECTIVE_KEYS: &[&str] = &[ "general.liveTranscriptionDisplay", "general.showRecordingOverlay" ];
```

A settings change restarts the engine **only** when:
1. a `STARTUP_ONLY_KEYS` path changed (unconditional — `is_startup_only(path)`); **or**
2. a `WAKEWORD_CONFIG_KEYS` path changed while in / crossing wakeword mode
   (state-dependent — handled by the apply layer); **or**
3. a `REALTIME_EFFECTIVE_KEYS` path flipped whether realtime is *effectively*
   enabled (state-dependent).

Everything else is hot-swapped in place. The hot-swap mechanism itself (which
in-place reconfigure each field triggers — engine swap / VAD `set_mode` / audio
source reconfigure / idle-unload retune) is a **slice-03 / lib-wiring concern**;
this slice only classifies and tags. See memory
`project_hot_swap_settings_consolidation`.

> Why so few startup-only keys: WinSTT deliberately drove the list down to the
> handful with no in-place reconfigure path (ORT EP/device bind at session
> create; the realtime-pipeline bootstrap config; Sentry's one-shot init).

---

## Secrets (encrypted at rest)

```rust
pub const SECRET_KEYS: &[&str] = &[
    "llm.openrouterApiKey",
    "integrations.openai.apiKey",
    "integrations.elevenlabs.apiKey",
];
```

On the struct these fields are plaintext (`String`). They MUST be encrypted at
rest by the persistence layer, the same way WinSTT's
`electron/lib/secret-storage.ts` wrote `enc:v1:<base64>` via Electron
`safeStorage` (DPAPI on Windows).

**Port mechanism (recommended):** Handy already has the pattern — a `SecretMap`
newtype with a redacting `Debug` impl (`src-tauri/src/settings.rs`). Two viable
approaches for the compile-loop wiring (slice lib-wiring decides):

- **Reuse Handy's `safeStorage`-equivalent at the store boundary.** On save,
  walk `SECRET_KEYS`, encrypt each leaf (`tauri-plugin-stronghold`, the OS
  keychain via `keyring`, or DPAPI on Windows), and write the ciphertext;
  on load, decrypt transparently. The renderer always sees plaintext over IPC
  (it never touches the on-disk blob), exactly like WinSTT.
- **Never log secrets.** If `WinsttSettings` is ever `Debug`-printed, route the
  secret fields through a redacting wrapper (copy Handy's `SecretMap` Debug
  impl) — Handy has a regression test for this; add an equivalent.

Crate choice for the actual encryption is deferred to lib-wiring (no new crate
is named here because none is required by *this* slice — it only declares which
paths are secret).

---

## Recipe: add a setting (specta command per setting)

WinSTT's renderer drives everything through Tauri `invoke` (replacing Electron
IPC). The full settings tree round-trips through two specta commands; an
individual setting almost never needs its own command — it rides the tree.

### A. The two core commands (already implied by this struct)

```rust
// src-tauri/src/winstt/settings_commands.rs  (slice lib-wiring)
use crate::winstt::settings_schema::WinsttSettings;

#[tauri::command]
#[specta::specta]
pub fn winstt_get_settings(app: tauri::AppHandle) -> WinsttSettings { /* load + decrypt secrets */ }

#[tauri::command]
#[specta::specta]
pub fn winstt_set_settings(app: tauri::AppHandle, value: WinsttSettings) -> Result<(), String> {
    // 1. validate preset cross-field rules (the Zod .refine equivalents)
    // 2. diff against current → compute restart need via is_startup_only / wakeword / realtime
    // 3. encrypt SECRET_KEYS, persist, broadcast updated tree to all windows
}
```

Register both in the `tauri_specta::Builder` collect list so the TS bindings
regenerate (the renderer imports the generated `WinsttSettings` type and the
`commands` object). See `lib_wiring.md`.

### B. Adding ONE new field

1. **Add the field to the right sub-struct** in `settings_schema.rs` with
   `#[serde(default = "…")]` (or `#[serde(default)]` for a type-default value).
   Pick the Rust type that matches the Zod type (`bool`/`String`/`f64`/`i64`/
   `Option<…>`/`Vec<…>`/an enum). camelCase JSON is automatic via the
   container's `rename_all`.
2. **Add the matching default fn** (if not a type default) and set it in the
   sub-struct's `Default` impl. Add an assertion in `defaults_match_zod_schema`.
3. **Classify it:** if it has no in-place reconfigure path, add its dot-path to
   `STARTUP_ONLY_KEYS`; otherwise leave it (hot-swap). If it's a secret, add it
   to `SECRET_KEYS`. If it's a new enum, give it explicit `#[serde(rename…)]`
   spellings and add a `enum_serialization_spellings` assertion.
4. **Regenerate TS bindings** (`tauri_specta` export) so the renderer's
   `WinsttSettings` type gains the field. No new command needed — it rides
   `winstt_get_settings` / `winstt_set_settings`.
5. **Wire the hot-swap (if any)** in the settings-apply layer — the actual
   in-place reconfigure is a slice-03/04 concern; this slice only tags it.

### C. When a field DOES warrant its own command

Only for high-frequency, single-field writes that shouldn't serialize the whole
tree (e.g. a live VAD-sensitivity slider drag, mirroring WinSTT's `set_parameter`
fast-path). Add a narrow `#[tauri::command] #[specta::specta] fn
winstt_set_silero_sensitivity(value: f64)` and register it. Keep the field in
`WinsttSettings` as the source of truth; the narrow command just patches +
hot-applies it. Don't proliferate these — the tree round-trip is the default.

---

## What's intentionally NOT here

- **The persistence/encryption layer** (store path, secret encrypt/decrypt,
  migration of WinSTT's `SCHEMA_VERSION 11` electron-store blob) — lib-wiring.
- **The hot-swap reconfigure plumbing** (engine swap, VAD set_mode, audio
  reconfigure) — slices 03/04 + lib-wiring.
- **Preset/transform cross-field validation** runtime — the apply command
  (`winstt_set_settings`) re-checks the Zod `.refine()` rules; the types only
  shape the data.
- **Runtime-only enums** (`RecorderState`, `ServerStatus`, `ModelFamily`,
  fit-assessment) — those are event/payload types, not persisted settings; they
  belong to the engine/IPC slices, not this struct.
