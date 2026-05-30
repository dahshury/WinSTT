# lib_wiring.md — wiring the WinSTT port into Handy's `src-tauri/src/lib.rs`

> **Status:** plan, not yet applied. Nothing here compiles until Rust is installed and the
> per-subsystem specs (`03_*` STT engine, `05_*` wake/diar, `06_tts`, `07_*`) are turned into real
> impls in the compile loop. This document is the **single registration map**: every `mod` line,
> every `.manage(...)`, every `collect_commands![]` entry, every event, and every `ACTION_MAP` /
> binding addition the port introduces — grounded in the real `lib.rs` registration site
> (read 2026-05-31) so the compile loop is mechanical, not exploratory.

The HARD RULE is unchanged: **new code only under `src-tauri/src/winstt/`**. But wiring is, by
definition, edits to Handy-owned files (`lib.rs`, `Cargo.toml`, `actions.rs`, `settings.rs`,
`tauri.conf.json`). Those edits are listed here exhaustively and kept to **append-only / one-liner**
changes wherever possible so a future `git merge` from the Handy remote stays trivial.

---

## 0. The Handy-owned files this port must touch (and how much)

| File | Edit class | What | Why it can't be avoided |
|---|---|---|---|
| `Cargo.toml` | **modify** 1 line + append deps | bump per-OS `transcribe-rs` 0.3.3→0.3.8, add direct `ort = =2.0.0-rc.12`, add the new crates (see §8) | exactly one `ort` must link; new crates must be declared (`00_cargo_additions.md`) |
| `src/lib.rs` | **append** `pub mod winstt;` (1 line) | mount the entire port module tree | the crate root must see `winstt` |
| `src/lib.rs` | **append** to `collect_commands![]` | register ~55 new specta commands (§3) | tauri-specta only generates TS bindings + invoke routing for collected commands |
| `src/lib.rs` | **append** to `collect_events![]` | register the specta-typed events (§4) | `mount_events` + TS `events` only fire for collected event structs |
| `src/lib.rs` | **edit** `initialize_core_logic` | `app.manage(Arc<...>)` the new managers (§2) | managers must be in Tauri state for commands/actions to `state::<...>()` them |
| `src/actions.rs` | **append** to `ACTION_MAP` (Lazy block) | new `ShortcutAction`s: wakeword/listen/tts/repaste/transforms (§5) | passive uiohook actions resolve via `ACTION_MAP.get(binding_id)` |
| `src/settings.rs` | **append** to `default_bindings()` | default `ShortcutBinding`s for the new actions (§5) | the binding map keys must exist before the shortcut handler can register them |
| `src/llm_client.rs` | **append** 2 fields | `#[serde(flatten)] extra_body: Value` + per-request `Referer`/`X-Title` headers | OpenRouter response-healing + WinSTT rebrand attribution (`07_*`, wiringNotes) |
| `tauri.conf.json` | **append** `bundle.externalBin` | `"binaries/winstt-context"` sidecar (§6) | context-awareness ships the C UIA helper as an isolated process |

Everything else is purely additive under `winstt/`.

---

## 1. Module declarations (`winstt/mod.rs` + `lib.rs`)

### 1a. `lib.rs` — one line

Add alongside the existing `mod ...;` block (lines 1–21):

```rust
pub mod winstt;
```

### 1b. `winstt/mod.rs` — REPAIR REQUIRED ⚠️

`winstt/mod.rs` currently declares **only**: `settings_schema`, the vad slice
(`vad_calibrator`, `composite_vad`, `endpointing`, `realtime_stabilizer`), and the llm-cloud slice
(`llm`, `cloud_stt`, `context`, `paste_ext`, `ducking`). The **catalog / stt / wakeword / tts**
slices' `pub mod` lines were lost to a write-conflict (each slice rewrote `mod.rs` and the last
writer won). Files exist on disk (`catalog.rs`, `stt/mod.rs`, `wakeword.rs`, `tts/mod.rs`) but are
**not declared**, so they won't compile in. First wiring action — append these four lines to
`winstt/mod.rs`:

```rust
// ── slice: catalog (app/PORT/01_stt_catalog.md) ──
/// The 42-model STT catalog + quantization/EP resolution policy tables.
pub mod catalog;

// ── slice: stt-engine (app/PORT/03_stt_engine.md) ──
/// ort-2.x ONNX engine: Transcriber trait, EngineKind, build_engine() factory.
pub mod stt;

// ── slice: wake-diar-loop-wordts (app/PORT/05_*.md) ──
/// sherpa-onnx KWS wake-word detector + presets + keyword-file builder.
pub mod wakeword;

// ── slice: tts (app/PORT/06_tts.md) ──
/// In-process Kokoro (local) + ElevenLabs (cloud) TtsEngine + TtsManager.
pub mod tts;
```

After this, the full module tree is:
`settings_schema · catalog · stt · vad_calibrator · composite_vad · endpointing ·
realtime_stabilizer · wakeword · tts · llm · cloud_stt · context · paste_ext · ducking`.

### 1c. New manager files to create during the compile loop

The specs describe managers that aren't files yet (they live as traits/stubs inside the slice
modules). Create these under `winstt/` when wiring (keeps the HARD RULE intact):

- `winstt/managers/wakeword_manager.rs` — `WakeWordManager` (owns `wakeword::WakeWordDetector`)
- `winstt/managers/tts_manager.rs` — re-export of `tts::TtsManager` if a Tauri-state wrapper is needed
- `winstt/managers/llm_manager.rs` — `LlmManager` (reqwest client + Ollama capability cache)
- `winstt/managers/cloud_stt_manager.rs` — `CloudSttManager` (in-flight transcribe tokens)
- `winstt/managers/context_manager.rs` — `ContextManager` (sidecar path + reader)
- `winstt/managers/diarization_manager.rs`, `loopback_manager.rs`, `word_aligner.rs` — `05_*` advanced
- `winstt/managers/file_transcribe_manager.rs` — `07_*` file-transcription queue

(Plus `pub mod managers;` in `winstt/mod.rs` and `pub mod ...;` in `winstt/managers/mod.rs`.)

---

## 2. Managers → Tauri managed state (`initialize_core_logic`, lib.rs ~L140–167)

Handy already builds + `.manage()`s four `Arc<...>` managers (recording, model, transcription,
history) and one `TranscriptionCoordinator` (managed in `setup`, L541). The port **does not replace**
these — it (a) swaps the **engine internals** of `TranscriptionManager` (replace `LoadedEngine`'s
transcribe-rs engines with `winstt::stt::Box<dyn Transcriber>` from `build_engine()`; this is an
edit *inside* the manager's transcribe path, not a re-registration), and (b) adds new managers.

Insert into `initialize_core_logic` after the existing `app_handle.manage(...)` block (L163–166):

```rust
// ── WinSTT managers ──
use crate::winstt::managers::{
    WakeWordManager, LlmManager, CloudSttManager, ContextManager,
    DiarizationManager, LoopbackManager, WordAligner, FileTranscribeManager,
};
use crate::winstt::tts::TtsManager;

let llm_manager      = Arc::new(LlmManager::new(app_handle));
let cloud_stt_manager= Arc::new(CloudSttManager::new(app_handle));
let context_manager  = Arc::new(ContextManager::new(app_handle));   // resolves sidecar path
let tts_manager      = Arc::new(TtsManager::new(app_handle));        // engine picked from tts.source
let wakeword_manager = Arc::new(WakeWordManager::new(app_handle, recording_manager.clone()));
let diar_manager     = Arc::new(DiarizationManager::new(app_handle));
let loopback_manager = Arc::new(LoopbackManager::new(app_handle, recording_manager.clone()));
let word_aligner     = Arc::new(WordAligner::new(app_handle, model_manager.clone()));
let file_tx_manager  = Arc::new(FileTranscribeManager::new(app_handle, transcription_manager.clone()));

app_handle.manage(llm_manager);
app_handle.manage(cloud_stt_manager);
app_handle.manage(context_manager);
app_handle.manage(tts_manager);
app_handle.manage(wakeword_manager);
app_handle.manage(diar_manager);
app_handle.manage(loopback_manager);
app_handle.manage(word_aligner);
app_handle.manage(file_tx_manager);
```

### Manager registry

| Manager | Arc state | Owns | Started by | Source slice |
|---|---|---|---|---|
| `LlmManager` | `Arc<LlmManager>` | reqwest client, Ollama `/api/show` capability cache, active-chat cancel tokens, warmup loop | dictation post-process + `process_text`/`process_transform` commands | `07_*` |
| `CloudSttManager` | `Arc<CloudSttManager>` | in-flight cloud-transcribe cancel tokens | cloud-STT path when `model.sttSource == "cloud"` | `07_*` |
| `ContextManager` | `Arc<ContextManager>` | sidecar exe path + `ContextReader` | dictation context capture + `debug_read_context` | `07_*` |
| `TtsManager` | `Arc<TtsManager>` | local Kokoro **or** cloud EL engine (re-picked on `tts.source` / key change) | `tts_speak*` commands + read-selection hotkey | `06_*` |
| `WakeWordManager` | `Arc<WakeWordManager>` | `WakeWordDetector` (rebuilt on `general.wakeWord` / `wakeWordSensitivity` change), armed from `audio_toolkit` consumer feed | when `general.wakeWord` set; on detect → recorder INACTIVE→LISTENING + `wakeWordTimeout` | `05_*` |
| `DiarizationManager` | `Arc<DiarizationManager>` | `SessionDiarizer` (per-utterance) + `SpeakerTimeline` (listen) — reuses sherpa-rs embedder + pyannote-seg session | listen mode + diarized utterances | `05_*` |
| `LoopbackManager` | `Arc<LoopbackManager>` | WASAPI loopback capture → existing `run_consumer` mpsc as a 2nd producer (option 1, no Handy edits) + AGC | listen mode start | `05_*` |
| `WordAligner` | `Arc<WordAligner>` | lazy `whisper-tiny_timestamped` ort session for cross-attention DTW | `align_words` command (history playback) | `05_*` |
| `FileTranscribeManager` | `Arc<FileTranscribeManager>` | sequential file queue + per-chunk progress (lazy VAD iterator) + PTT pause/resume | drag-drop / `file_transcribe_*` commands | `07_*` |

**Ducking has no manager.** `DuckState` (two-layer save/restore, `winstt/ducking.rs`) lives on the
existing `AudioRecordingManager` via a **new method** added in `winstt/` (extension trait or a method
on a wrapper) — **do not edit** Handy's `set_mute`/`apply_mute`. It reuses the windows-crate features
Handy already enables plus `Win32_Media_Audio` (added in §8).

---

## 3. Commands → `collect_commands![]` (lib.rs L326–429)

Append these to the existing `collect_commands![...]` macro list. **Every command function** is
`#[tauri::command] #[specta::specta]` and lives in a `winstt/commands/*.rs` module (new, under the
HARD-RULE-safe tree). **Every payload type** must `derive(specta::Type)` so the tauri-specta builder
can emit TS bindings (this is the recurring gate flagged by every slice).

```rust
// ── WinSTT settings (slice 02) ──
winstt::commands::settings::winstt_get_settings,        // () -> WinsttSettings
winstt::commands::settings::winstt_set_settings,        // (WinsttSettings) -> Result<(),String>  (re-validates preset cross-field rules, diffs restart-need, encrypts SECRET_KEYS)

// ── STT catalog + picker (slices 01/03) ──
winstt::commands::stt::list_models,                     // -> Vec<ModelInfo> (incl. effective_quantization badge)
winstt::commands::stt::picker_quantizations_for,        // (model_id) -> Vec<Quantization>
winstt::commands::stt::get_live_resources,              // RAM/VRAM/disk for picker
winstt::commands::stt::set_custom_model,                // add/scan custom ONNX model

// ── TTS (slice 06) ──
winstt::commands::tts::tts_speak,                       // (text) -> ()  (emits tts://chunk)
winstt::commands::tts::tts_speak_selection,             // read-selection
winstt::commands::tts::tts_cancel,                      // (request_id)
winstt::commands::tts::tts_cancel_all,
winstt::commands::tts::tts_init,                        // warm-up off-thread (spawn_blocking)
winstt::commands::tts::tts_list_voices,                 // static 54-voice catalog
winstt::commands::tts::tts_list_cloud_voices,           // reqwest GET /v2/voices
winstt::commands::tts::tts_cloud_subscription,
winstt::commands::tts::tts_download_estimate,
winstt::commands::tts::tts_install_pause,
winstt::commands::tts::tts_install_resume,
winstt::commands::tts::tts_install_cancel,
winstt::commands::tts::tts_preview_cloud,

// ── LLM / Ollama / OpenRouter (slice 07) ──
winstt::commands::llm::process_text,                    // dictation cleanup/compose
winstt::commands::llm::process_transform,               // transform-on-selection
winstt::commands::llm::scan_ollama_models,              // /api/tags + /api/show enrich
winstt::commands::llm::scan_openrouter_models,          // /v1/models + /endpoints enrich
winstt::commands::llm::ollama_detect,
winstt::commands::llm::ollama_start,
winstt::commands::llm::ollama_pull,                     // streams pull-progress (NOT OpenAI-compat)
winstt::commands::llm::ollama_delete,
winstt::commands::llm::verify_credential,               // OpenAI / OpenRouter / EL key verify

// ── Cloud STT (slice 07) ──
winstt::commands::cloud_stt::verify_cloud_stt_credential,
winstt::commands::cloud_stt::cloud_stt_cancel,

// ── Wake word (slice 05) ──
winstt::commands::wakeword::set_wake_word,              // rebuilds detector
winstt::commands::wakeword::list_wake_word_presets,

// ── Diarization / listen / word-ts (slice 05) ──
winstt::commands::listen::start_listen,                 // loopback + diarization on
winstt::commands::listen::stop_listen,
winstt::commands::wordts::align_words,                  // (history_entry_id) -> Vec<WordResult> (lazy)

// ── File transcription (slice 07) ──
winstt::commands::file_transcribe::file_transcribe_enqueue,
winstt::commands::file_transcribe::file_transcribe_pause,
winstt::commands::file_transcribe::file_transcribe_resume,
winstt::commands::file_transcribe::file_transcribe_cancel,

// ── Context (slice 07) — feature-gated debug only ──
#[cfg(feature = "context-playground")]
winstt::commands::context::debug_read_context,
```

> **Gate reminder:** `winstt_set_settings` is not a thin setter. It must (a) re-run the Zod
> `.refine` equivalents (no dup preset keys; ≤1 tone key; `level` only for summarize/concise;
> `targetLang` only for translate), (b) diff against current settings to compute restart-need via
> `settings_schema::is_startup_only()` + `WAKEWORD_CONFIG_KEYS` + `REALTIME_EFFECTIVE_KEYS`,
> (c) encrypt `SECRET_KEYS` at rest before persisting. Hot-swappable keys route through the existing
> set-parameter path to the live managers (no process kill).

---

## 4. Events → `collect_events![]` + plain `app.emit`

Handy collects exactly **one** specta event today (lib.rs L430):
`collect_events![managers::history::HistoryUpdatePayload,]`. Two event styles exist and the port
uses both deliberately:

### 4a. Specta-typed events (TS-bound, append to `collect_events![]`)

These carry structured payloads the renderer consumes type-safely. Each payload `derive`s
`specta::Type, serde::Serialize, Clone`.

```rust
collect_events![
    managers::history::HistoryUpdatePayload,
    // ── WinSTT ──
    winstt::stt::RealtimeStabilizedPayload,     // realtime preview (stabilized)
    winstt::stt::RealtimeUpdatePayload,         // realtime preview (raw, for noise-break)
    winstt::wakeword::WakeWordDetectedPayload,  // wake_word_detected
    winstt::tts::TtsChunkPayload,               // tts://chunk transport
    winstt::tts::TtsLifecyclePayload,           // started/completed/failed/download-progress
    winstt::stt::SpeakerSegmentsPayload,        // diarized segments (listen)
    winstt::stt::WordAlignmentPayload,          // align_words result
    winstt::stt::VadSensitivityAdaptedPayload,  // per-device calibration persistence
    winstt::FileTranscribeProgressPayload,      // per-file/per-chunk progress
];
```

### 4b. Plain string events (`app.emit("name", payload)`, NOT collected)

For the LLM streaming + error channels the slices specified as plain emits (matching WinSTT's IPC
shape so the reused renderer's existing listeners work unchanged):

| Event name | Payload | Emitted by | Note |
|---|---|---|---|
| `llm-reasoning-delta` | `{ requestId, delta }` | `LlmManager` streaming | per-NDJSON-chunk reasoning |
| `llm-learned-proper-nouns` | `{ nouns: [...] }` | `LlmManager` | vocab learning |
| `stt-cloud-error` | `{ code, message }` | `CloudSttManager` | single channel, code-discriminated; `aborted` suppressed |
| `recording-error` | (exists in Handy) | — | reuse |
| `realtime-stabilized` / `realtime-update` | text | realtime worker | **ordering matters: stabilized THEN update** (`04_*`) |
| `vad-sensitivity-adapted` | `{ deviceId, sensitivity }` | calibrator | renderer persists per-device |

> The renderer event-name contract is **unchanged from WinSTT's Electron IPC** — only the transport
> swaps (`IPC.TTS_CHUNK` → `tts://chunk` event; `ipcRenderer.on` → Tauri `listen`). The JSON shapes
> are byte-identical so the existing playback queue, realtime accumulator, and reasoning-delta UI
> need no changes (`06_*`/`07_*` wiringNotes).

---

## 5. New `ShortcutAction`s → `ACTION_MAP` + default bindings

Handy's `ACTION_MAP` (`actions.rs` L700–721) is a `Lazy<HashMap<String, Arc<dyn ShortcutAction>>>`
with four entries: `transcribe`, `transcribe_with_post_process`, `cancel`, `test`. Each action impls
`ShortcutAction { start(app, binding_id, shortcut_str); stop(...) }`. Bindings live in
`settings::default_bindings()` (`settings.rs` L725+) as `ShortcutBinding { id, name, description,
default_binding, current_binding }`, resolved at press time by `shortcut::handler` via
`ACTION_MAP.get(binding_id)`.

### 5a. New actions (append to the `ACTION_MAP` Lazy block in `actions.rs`)

Implement each as a struct under `winstt/actions/` (HARD-RULE-safe), `impl ShortcutAction`, then
`map.insert(...)` it. **Do not rewrite `actions.rs`** — append the inserts and add
`use crate::winstt::actions::{...};` at the top.

```rust
map.insert("listen".into(),    Arc::new(winstt::actions::ListenAction)      as Arc<dyn ShortcutAction>);
map.insert("tts_read".into(),  Arc::new(winstt::actions::TtsReadAction)     as Arc<dyn ShortcutAction>);
map.insert("repaste".into(),   Arc::new(winstt::actions::RepasteAction)     as Arc<dyn ShortcutAction>);
// transforms: one action per configured transform OR a single parameterized one keyed by suffix
map.insert("transform".into(), Arc::new(winstt::actions::TransformAction)   as Arc<dyn ShortcutAction>);
// wakeword is NOT a hotkey action — it is armed by WakeWordManager from the audio consumer feed.
// It triggers the SAME recording endpoint as `transcribe` (memory: recording modes share one path).
```

| Action key | Trigger | Behavior | Binding mechanism | Source |
|---|---|---|---|---|
| `listen` | hotkey | toggle continuous listen (loopback + diarization) | passive uiohook (`ShortcutBinding`) | `05_*` |
| `tts_read` | hotkey **LWin+LShift+E** | read selection aloud (single-shot per hold; Backspace=stop) | **`rdev` passive single-shot**, reuse Handy's listener — NOT globalShortcut | `06_*` |
| `repaste` | hotkey **LCtrl+LShift+V** | re-paste last transcription | **exclusive `globalShortcut`** (memory `project_repaste_globalshortcut` — the ONLY globalShortcut; all others passive) | `07_*` / memory |
| `transform` | hotkey | run a configured transform on the selection | passive uiohook | `07_*` |
| (wake word) | **audio** | wake phrase → INACTIVE→LISTENING + `wakeWordTimeout` | armed by `WakeWordManager`, **no binding** | `05_*` |

> **Important caveats from memory:** `repaste` is the *exclusive* Electron-globalShortcut in WinSTT;
> in the Tauri port it maps to `tauri-plugin-global-shortcut` (already a plugin, lib.rs L502) while
> every *other* hotkey stays passive (`rdev`/uiohook equivalent Handy already uses). The `tts_read`
> hotkey is single-shot-per-hold and must respect the paste/recording guards. STT force-stops TTS
> (the `ListenAction`/`TranscribeAction` start must call `tts_manager.cancel_all()`).

### 5b. Default bindings (append to `default_bindings()` in `settings.rs`)

```rust
bindings.insert("tts_read".into(), ShortcutBinding {
    id: "tts_read".into(), name: "Read Selection".into(),
    description: "Reads the selected text aloud.".into(),
    default_binding: "win+shift+e".into(), current_binding: "win+shift+e".into(),
});
bindings.insert("repaste".into(), ShortcutBinding {
    id: "repaste".into(), name: "Re-paste".into(),
    description: "Pastes the last transcription again.".into(),
    default_binding: "ctrl+shift+v".into(), current_binding: "ctrl+shift+v".into(),
});
bindings.insert("listen".into(), ShortcutBinding {
    id: "listen".into(), name: "Listen".into(),
    description: "Transcribes system audio (meetings, videos).".into(),
    default_binding: "".into(), current_binding: "".into(),   // unset by default
});
// transform bindings are created dynamically per configured transform (suffix-keyed),
// mirroring WinSTT's customModifiers — not a single static default.
```

> The settings nesting differs from Handy: WinSTT's hotkeys live under `WinsttSettings.hotkey` and
> the dictation modes under `general.recordingMode` (ptt/toggle/listen/wakeword). The
> `default_bindings()` additions above bridge Handy's flat binding registry; the renderer reads its
> own nested keys via `winstt_get_settings`. Keep both in sync in the set-settings command.

---

## 6. Sidecar registration (`tauri.conf.json`)

Context-awareness ships WinSTT's existing **1121-line `winstt-context.exe`** C UIA helper as a Tauri
`externalBin` sidecar (process isolation = hung-UIA-call safety — the helper's whole design
rationale; `00_*`/`07_*`).

1. Copy `frontend/electron/native/bin/winstt-context.exe` →
   `app/src-tauri/binaries/winstt-context-x86_64-pc-windows-msvc.exe` (target-triple suffix required
   by Tauri).
2. Add to `tauri.conf.json`:
   ```json
   "bundle": { "externalBin": ["binaries/winstt-context"] }
   ```
3. `ContextManager` resolves it via `tauri-plugin-shell` sidecar (transport A) **or**
   `std::process::Command` (transport B, no new dep). Spike (`07_*`) decides which; the 1200ms tokio
   timeout that kills a wedged UIA walk is the acceptance bar.

> The paste helper `winstt-paste.exe` is **not** needed as a sidecar — Handy's `input.rs`/`clipboard.rs`
> already cover keystroke + clipboard paste; `paste_ext.rs` extends them in-process (terminal-aware
> Ctrl+Shift+V + circuit-breaker). Only the **context** helper ships as a sidecar.

---

## 7. Engine swap inside `TranscriptionManager` (not a re-registration)

The single highest-risk wiring is **internal** to Handy's `managers/transcription.rs`: its
`LoadedEngine` enum currently holds transcribe-rs engines (Whisper/Parakeet/Moonshine/SenseVoice/
GigaAM/Canary/Cohere — 6 families, confirmed insufficient for the 42-model catalog). The port
replaces the per-variant engines with a single `winstt::stt::Box<dyn Transcriber>` from
`build_engine()`:

- **Gate:** the §11 STT de-risking spike (`03_*`) must be green (Whisper-fp16 + lite-whisper-fp16 +
  Cohere-fp16-sharded reproduce on real `ort`) **before** this swap is written.
- **Invariants preserved at the manager boundary** (NOT moved into the engine): the
  `catch_unwind`/`AssertUnwindSafe` boundary (load-bearing `panic="unwind"`), peak-normalize-to-0.95
  (single chokepoint in the coordinator), and the loading-guard/condvar lifecycle.
- This is an **edit to a Handy file** but localized to the `transcribe()` body + `LoadedEngine`
  definition. Keep the public manager API (`transcribe`, `initiate_model_load`, `unload_model`,
  `is_model_loaded`) byte-identical so `actions.rs` and the tray menu (lib.rs L222–231) don't change.

---

## 8. Crate deps to add (`Cargo.toml`) — see `00_cargo_additions.md` for full justification

The **one mandatory modify** is line-level: bump the per-OS Windows `transcribe-rs` pin
**0.3.3 → 0.3.8** and add direct `ort = =2.0.0-rc.12` so exactly one `ort` links. The rest are
appends. Aggregate list (versions verified 2026-05 on crates.io):

```
ort = "=2.0.0-rc.12"                              # features: ndarray, copy-dylib; +directml on windows
ndarray = "0.17.2"
tokenizers = { version = "0.22.1", default-features = false, features = ["onig"] }  # DistilBERT + custom models ONLY
sherpa-onnx = "1.13.2"                            # k2-fsa first-party (NOT sherpa-rs); KWS + diarization embed
kokoroxide = "0.1.5"                              # local Kokoro TTS — OR kokorox(GPL)/any-tts; decided by 06_* spike
ollama-rs = "0.3.4"                               # native /api/* (pull-progress) — reqwest covers OpenAI-compat
wasapi = "0.23.0"                                 # loopback capture (windows)
zip = { version = "8.6.0", default-features = false, features = ["deflate"] }
keyring = "4.0.1"                                 # windows-native secret store
symphonia = { version = "0.6.0", default-features = false, features = ["wav","mp3","isomp4","aac","flac","ogg","vorbis"] }
base85 = "2.0.0"                                  # RFC1924 — Whisper alignment-heads table (gzip via existing flate2)
hf-hub = "1.0.0-rc.1"                             # HF snapshot resolver for STT model files
prost = "*"                                       # ONNX-proto edit for the fp16 decoder patch (03_*, §6.1) — pin in compile loop
reqwest                                           # EXISTING — ADD `multipart` feature (cloud_stt) to current ["json","stream"]
futures-util                                      # EXISTING 0.3 — Ollama NDJSON bytes_stream drain
windows = "0.61.3"                                # EXISTING — ADD features: Win32_Media_Audio, Win32_System_Com,
                                                  #   Win32_System_ProcessStatus, Win32_System_Threading,
                                                  #   conditional Win32_UI_Accessibility + Win32_Security_Cryptography
tauri-plugin-shell                                # ADD only if context sidecar uses transport (A)
rdev                                              # EXISTING (Handy) — reuse for tts_read hotkey, do NOT re-add
flate2                                            # EXISTING — reuse for gzip-inflate alignment heads
```

**Evaluated-and-rejected:** `async-openai` (reqwest `llm_client.rs` covers cloud LLM/STT),
`uiautomation` in-process (ship the C sidecar instead), `kokorox` as a cargo dep (GPL-3.0 +
unpublished — sidecar fallback only), `sherpa-rs` (deprecated 3rd-party binding; one slice named
`sherpa-rs 0.6.8` — **reconcile to `sherpa-onnx 1.13.2`** in the compile loop, the deps slice is
authoritative on this).

### Cargo `tree` acceptance gates (run first, before any feature work)
1. `cargo tree -i ort` → **exactly one** `ort 2.0.0-rc.12` node.
2. `cargo tree -i ndarray` → confirm ort rc.12's ndarray major matches `0.17.x` (else pin ours).
3. `cargo tree -i onnxruntime-sys` → count native runtimes across ort + sherpa-onnx + kokoroxide;
   confirm only `ort` copies the loose `onnxruntime.dll` (sidecar sherpa if symbol clash).

---

## 9. Wiring order (do this in the compile loop, top-down)

1. **Cargo deps + `cargo tree` gates** (§8) — nothing builds otherwise; resolve the `ort`/sherpa
   version reconciliation first.
2. **`mod winstt;` + repair `winstt/mod.rs`** (§1) — get the existing draft modules to *parse*
   (settings, catalog, vad, llm pure-logic, tts/stt/wakeword stubs). Run `cargo check` per module;
   fix the unit-test-only code that the slices wrote (they're written to pass, but unrun).
3. **Settings command + managed state** (§2/§3) — `winstt_get_settings`/`winstt_set_settings` so the
   reused renderer can boot against real state.
4. **STT de-risking spike** (`03_*` §11) — **THE GATE**. No decode-loop or engine-swap code ships
   until Whisper-fp16 + lite-whisper-fp16 + Cohere-fp16-sharded reproduce on real `ort`.
5. **Engine swap** (§7) inside `TranscriptionManager` → first end-to-end dictation (README milestone:
   hotkey → speak → paste, DirectML, p50 ≈ 85 ms).
6. **Catalog/picker commands** → model list + download + switch.
7. **VAD calibrator + realtime** (`04_*`) → live preview + adaptive sensitivity.
8. **TTS** (`06_*`, after its phonemizer license spike) + **LLM/Ollama/cloud-STT/context** (`07_*`).
9. **Wake word / diarization / listen / word-ts / file-transcribe** (`05_*`/`07_*`) — advanced v1.

---

## 10. Quick verification checklist (per wiring step)

- [ ] `cargo tree -i ort` shows one node (§8 gate 1).
- [ ] `cargo check` clean after `mod winstt;` + repaired `winstt/mod.rs`.
- [ ] Every new command payload `derive(specta::Type)`; `bun run tauri dev` (debug) regenerates
      `../src/bindings.ts` without error (specta export, lib.rs L432).
- [ ] Every collected event payload `derive(specta::Type, Serialize, Clone)`.
- [ ] New managers appear in `app.state::<Arc<...>>()` from a command without panic.
- [ ] `ACTION_MAP.get("tts_read"|"repaste"|"listen"|"transform")` resolves; bindings present in
      `default_bindings()`.
- [ ] `winstt-context` sidecar resolves at the target triple; 1200ms timeout kills a wedged walk.
- [ ] `panic="unwind"` untouched in the release profile; `catch_unwind` boundary stays in the
      coordinator/manager, not the engine.
