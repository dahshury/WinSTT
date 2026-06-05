# 11 — Handy Pattern Audit (WinSTT Rust/Tauri port vs upstream Handy)

**Auditor pass:** 2026-05-31. **Reference (clean Handy):** `E:/DL/Projects/handy_winstt/src-tauri/src/`.
**Subject (the port):** `E:/DL/Projects/WinSTT/app/src-tauri/src/`.
**Scope:** flag every place the port is WORSE, DIVERGENT, or a SHORTCUT vs Handy's architecture/design patterns. Do NOT fix — the orchestrator workflows the fixes.

> **Framing.** Per `app/PORT/PROGRESS.md`, the port is parked at the "WIRING + SPIKE" phase: the whole backend *compiles, links, and the exe boots*, but most WinSTT subsystems are deliberately stubbed (`SPIKE`) and the manager/event/action *wiring into the live pipeline was never completed*. The findings below are exactly the unfinished wiring + the shortcuts that make the app build-green but functionally hollow. The single thing that DOES work end-to-end is Handy's own dictation pipeline (transcribe-rs via `TranscribeAction`) — but it is fully disconnected from the WinSTT renderer's events and settings (Findings C1, C2, C3).

---

## Severity summary

| ID | Severity | Area | One-line |
|----|----------|------|----------|
| **C1** | CRITICAL | Event emission | None of the WinSTT STT lifecycle/level events (`recording-start/stop`, `vad-*`, `audio-level`, `full-sentence`, `transcription-*`) are ever emitted → overlay pill, visualizer, and final-transcript UI are dead during dictation. |
| **C2** | CRITICAL | Settings flow | WinSTT settings persist to a SEPARATE store key with NO bridge to Handy's `AppSettings`, which is what the live dictation pipeline actually reads → every WinSTT setting (mode, language, mute, paste, model, accelerator…) is a no-op on real behavior. |
| **C3** | CRITICAL | Shortcuts / hotkey events | `hotkey:pressed/released` and `hotkey:recording-update/done` are never emitted (`shortcut/handler.rs` is byte-identical to Handy) → renderer PTT bridge never fires; in-app hotkey rebinding is broken. |
| **C4** | CRITICAL | Manager pattern | `DownloadManager` is constructed/used by 6 commands as `State<Arc<DownloadManager>>` but is **never `.manage()`d** → every download command panics at runtime on State injection. |
| **C5** | CRITICAL | Window management | The WinSTT custom HTML tray menu is never wired: lib.rs still uses Handy's NATIVE tray (`show_menu_on_left_click` + `on_menu_event`), `TrayMenuAnchor` is never managed, no `on_tray_icon_event` opens `show_tray_menu`. |
| **H1** | HIGH | Command pattern | `DownloadManager::run_quant_download` always completes as `cancelled` and `delete_*` never deletes files → model download/delete from the picker are no-ops (commands succeed, nothing happens). |
| **H2** | HIGH | Command pattern | `FileTranscribeManager::decode_audio_to_pcm` always returns `Err` → every file transcription fails ("file audio decode not yet wired"). Queue/pause/progress machinery is real but transcribes nothing. |
| **H3** | HIGH | Coordinator / modes | New modes (listen, wakeword) are NOT driven: `LoopbackManager::start` is a stub (no WASAPI capture) and `WakeWordManager::feed_chunk` is never called from the (byte-identical) audio consumer → listen mode captures no audio, wakeword never triggers. |
| **H4** | HIGH | Event emission | All 8 specta-typed events in `collect_events!` are registered but **never `.emit()`d** (only referenced in comments) → diverges from Handy's `HistoryUpdatePayload` pattern (which IS emitted). |
| **H5** | HIGH | Manager / TTS | `TtsManager::reload_engine` is never called → TTS is permanently the default local Kokoro with default config; cloud source, configured voice/device never applied. Plus no asset-download path → `tts_init` fails "assets missing" on a clean install. |
| **M1** | MEDIUM | Command pattern | Stub commands returning fake/empty data: `tts_list_cloud_voices`, `tts_cloud_subscription`, `tts_download_estimate`, `tts_install_pause/cancel` (all SPIKE returning defaults/empty). |
| **M2** | MEDIUM | Manager / diarization | `DiarizationManager` always attributes one speaker (embedder stub) → listen-mode subtitles never diarized. |
| **M3** | MEDIUM | Manager / word-ts | `WordAligner::try_load_engine` always returns `None` → `align_words` always returns `[]`; history karaoke highlight never works. |
| **M4** | MEDIUM | Threading/locking | `.lock().expect("… poisoned")` in `DownloadManager` / `FileTranscribeManager` are poison-panic hazards (vs Handy's careful `try_state`/`unwrap_or` on internal locks). Low blast radius but a divergence. |
| **M5** | MEDIUM | Settings flow | Secrets (`llm.openrouterApiKey`, `openai.apiKey`, `elevenlabs.apiKey`) are persisted in **plaintext** (encryption is a SPIKE) — Handy redacts via `SecretMap`/safeStorage. |
| **L1** | LOW | Command pattern | `EmitChunkSink.is_cancelled()` is wired to a private always-`false` `Arc<Mutex<bool>>` not the manager's cancel set → mid-synthesis cancel is ignored (sentence boundary still honors it). |
| **L2** | LOW | Lifecycle | `winstt/stt/build_engine` only supports `WhisperHf`; all other families return `Unsupported`. Not in the live path yet (engine-swap step 3 not done), so latent — flag for when the swap lands. |
| **L3** | LOW | Window management | `windows.rs::onboarding_finish` is `#[allow(dead_code)]` (superseded by another command of the same name) — dead duplicate; confirm the live one transitions windows. |

---

## CRITICAL findings (functional breakage)

### C1 — WinSTT dictation events never emitted (overlay/visualizer/transcript dead)
- **Handy does:** the recording pipeline emits as it runs — `mic-level` from the cpal consumer (`audio_toolkit/audio/recorder.rs` → `overlay::emit_levels`), tray/overlay state transitions from `TranscribeAction`, and `HistoryUpdatePayload::Added` on save. The renderer's HUD is driven by these producer-side emits.
- **Ours does:** `winstt/commands/dictation.rs` defines `SttEvents::{recording_start, recording_stop, vad_start, vad_stop, transcription_start, full_sentence, no_audio_detected, transcription_failed, audio_level, realtime_text}` (clean façades), with a doc comment that the "EMIT CALL SITES live inside Handy-owned files (the transcription coordinator / audio consumer / VAD loop)." **But those Handy files were never edited** — `actions.rs`, `transcription_coordinator.rs`, `shortcut/handler.rs`, `managers/audio.rs`, and `audio_toolkit/audio/recorder.rs` are all **byte-identical to upstream Handy** (verified via `diff`). Grep confirms only `session_aborted`, `connection_change`, `server_status` are ever called; the other 10 emitters are never invoked.
- **Why worse/broken:** the reused WinSTT renderer subscribes to `stt:recording-start`, `stt:audio-level`, `stt:full-sentence`, `stt:vad-start`, etc. (adapter ROUTE map in `app/src/shared/api/electron-tauri-adapter.ts`). Since none fire, the overlay pill never shows, the live visualizer never moves, and the finalized transcript never displays — even though Handy's pipeline does record/transcribe/paste under the hood.
- **Where:** definitions `app/src-tauri/src/winstt/commands/dictation.rs:213-302`; missing call sites in `actions.rs` (`TranscribeAction::start`/`stop`), `audio_toolkit/audio/recorder.rs::run_consumer` (level + vad), `transcription_coordinator.rs`.
- **Fix (1:1):** edit the Handy-owned producers to call `SttEvents::*` at the equivalent points Handy emits its own: `recording_start` + `transcription_start(audio_base64)` in `TranscribeAction::start/stop`; `audio_level` and `vad_start/vad_stop` in `run_consumer` (alongside Handy's `emit_levels`/VAD frame handling); `full_sentence`/`no_audio_detected`/`transcription_failed` at the terminal branches of `process_transcription_output`. These are the exact one-liner seams the façade was built for.

### C2 — WinSTT settings are disconnected from the live (Handy) settings the pipeline reads
- **Handy does:** one settings schema (`settings::AppSettings`) persisted via `tauri-plugin-store` under the `settings` key; `TranscribeAction`, the recorder, paste, tray, and accelerator all read it via `get_settings(app)`. Per-setting `change_*` commands (`shortcut/mod.rs`) apply side effects immediately (hot-swap).
- **Ours does:** `winstt/commands/settings.rs` persists the full `WinsttSettings` tree under a **separate** key `winstt_settings` (file `winstt-settings.json`). `winstt_set_settings` validates, diffs restart-need, persists, and broadcasts `settings:changed` — but it **does not bridge any field into Handy's `AppSettings`**, and **nothing on the backend reacts** to apply side effects. There is no listener that maps WinSTT settings → Handy settings (`grep` for `crate::settings::write_settings` in `winstt/` is empty).
- **Why worse/broken:** the only engine that actually transcribes (Handy's `TranscribeAction`) reads Handy's `AppSettings`. So WinSTT-UI changes to recording mode, language, translate, mute-while-recording, paste method, model selection, accelerator, post-process, etc. have **zero effect** on dictation. The WinSTT settings store is write-only decoration. This is the structural opposite of Handy's "settings drive behavior."
- **Where:** `app/src-tauri/src/winstt/commands/settings.rs:26` (`WINSTT_SETTINGS_KEY`), `:135-203` (`winstt_set_settings` / `apply_settings_patch` — persist+broadcast only, no apply).
- **Fix (1:1):** add a settings-bridge applier in `apply_settings_patch` (or a `settings:changed` backend listener) that maps each WinSTT field to its Handy counterpart and calls the existing Handy `change_*` side-effecting paths / `write_settings`, mirroring how Handy's per-setting commands apply. At minimum: recordingMode→push_to_talk/binding, language/translate, muteWhileRecording, paste method, selected model (→`switch_active_model`), accelerator (→`apply_accelerator_settings`). Until the WinSTT engine swap lands (PROGRESS step 3), this bridge is the only way WinSTT settings reach the live engine.

### C3 — PTT hotkey events + hotkey rebinding never fire
- **Handy does:** a global shortcut fires → `shortcut/handler.rs::handle_shortcut_event` routes transcribe-bindings to the coordinator → `TranscribeAction`. Key-capture recording emits `handy-keys-event` per key (`shortcut/handy_keys.rs`).
- **Ours does:** `winstt/commands/hotkey.rs` registers the PTT accelerator against the `transcribe` binding via `change_binding`, and defines `HotkeyEvents::{pressed, released, recording_update, recording_done}` with a doc note that the call sites "live in Handy-owned files." **But `shortcut/handler.rs` is byte-identical to Handy** — pressing the accelerator runs Handy's `TranscribeAction`, and `HotkeyEvents::*` are **never called** (grep confirms zero call sites). The `handy-keys-event → hotkey:recording-update/done` translation bridge was never written.
- **Why worse/broken:** (a) The renderer's `usePushToTalk` waits on `hotkey:pressed/released` to call `set_microphone` — it never receives them, so the renderer's PTT path is dead (recording happens only via Handy's parallel path, which doesn't emit the WinSTT UI events either — see C1). (b) `useKeyRecorder` (settings hotkey rebind) waits on `hotkey:recording-update/done` — never emitted → **rebinding a hotkey in settings silently never completes.**
- **Where:** `app/src-tauri/src/winstt/commands/hotkey.rs:110-138` (façade, uncalled); missing call sites in `shortcut/handler.rs` and a `handy-keys-event` listener bridge.
- **Fix (1:1):** in `handle_shortcut_event`, for the PTT binding emit `HotkeyEvents::pressed/released` (the WU-3 fork: let the renderer drive `set_microphone`, instead of — or in addition to — Handy's direct `TranscribeAction`). Add a listener that folds `handy-keys-event` into `hotkey:recording-update { keys }` / `hotkey:recording-done { combo }`.

### C4 — `DownloadManager` is never registered in managed state → download commands panic
- **Handy does:** every manager used by a command is `Arc::new(...)` + `app.manage(...)` in `initialize_core_logic`; `State<Arc<M>>` injection then resolves.
- **Ours does:** `lib.rs::initialize_core_logic` manages exactly 9 WinSTT managers (`LlmManager, CloudSttManager, ContextManager, TtsManager, WakeWordManager, DiarizationManager, LoopbackManager, WordAligner, FileTranscribeManager`) — **`DownloadManager` is NOT among them** (`grep` confirms it's never `.manage()`d anywhere). Yet `winstt/commands/download.rs` takes `downloads: State<'_, Arc<DownloadManager>>` in 6 commands (`predownload_quant`, `download_pause_quant`, `download_resume_quant`, `download_cancel_quant`, `delete_model_quantization`, `delete_model_cache`).
- **Why worse/broken:** Tauri's `State<T>` injection **panics** if `T` isn't managed. So every per-quant download/delete command will panic the command worker when invoked from the picker. This is a hard runtime crash, not a graceful degrade.
- **Where:** `lib.rs:170-187` (the `.manage` block — DownloadManager absent); `winstt/commands/download.rs:35,47,58,70,82,94`.
- **Fix (1:1):** add `app_handle.manage(Arc::new(DownloadManager::new(app_handle)));` to the WinSTT manager block in `initialize_core_logic` (10th manager).

### C5 — WinSTT custom tray menu never wired (still Handy's native tray)
- **Handy does:** native Tauri tray menu via `TrayIconBuilder…on_menu_event(match event.id …)` + `show_menu_on_left_click(true)`.
- **Ours does:** `winstt/commands/tray_menu.rs` implements the full WinSTT custom-HTML tray-menu placement (`show_tray_menu/reanchor_tray_menu/hide_tray_menu`, clamp-to-work-area, `TrayMenuAnchor` state). Its own doc block lists the required lib.rs wiring: DROP `show_menu_on_left_click(true)` + the native `on_menu_event`, `.manage(TrayMenuAnchor::default())`, and call `show_tray_menu` from an `on_tray_icon_event`. **None of that was done** — `lib.rs:226` still has `show_menu_on_left_click(true)` and the native `on_menu_event` match; `TrayMenuAnchor` is never managed (`grep` confirms); there is no `on_tray_icon_event`.
- **Why worse/broken:** clicking the tray icon shows Handy's native menu (English-only Handy items), not WinSTT's themed HTML menu. The three `*_tray_menu` commands rely on `app.try_state::<TrayMenuAnchor>()` (gracefully `None`, so no panic, but anchor persistence is dead). The WinSTT tray UX is entirely absent.
- **Where:** `lib.rs:215-285` (TrayIconBuilder); `winstt/commands/tray_menu.rs:10-17` (the un-applied wiring spec).
- **Fix (1:1):** apply the wiring the command file documents: replace the native menu with `on_tray_icon_event` → `show_tray_menu(app, x, y)` (icon rect bottom-left), `.manage(TrayMenuAnchor::default())`, and keep "show main window" as an HTML menu item.

---

## HIGH findings

### H1 — Per-quant download/delete are no-ops that report success
- **Ours:** `DownloadManager::run_quant_download` (`managers/download_manager.rs:218-232`) is a SPIKE that **always calls `finish_quant(.., cancelled=true)`** — no bytes are ever fetched. `delete_quantization` (`:182`) and `delete_model_cache` (`:196`) only manipulate the registry + `emit_cache_changed` — **no files are deleted** (`std::fs` removal is a SPIKE comment).
- **Worse/broken:** the picker's "download this quant" flips to downloading then immediately to not-cached; "delete" appears to succeed but leaves the cache intact. The control surface + 4 broadcasts are real; only the byte engine + fs delete are missing. (Compounded by C4: the commands panic before even reaching this no-op until DownloadManager is managed.)
- **Fix:** implement the streaming HF fetch (the documented loop: resolve plan → stream → honor paused/cancelled → `emit_progress`) and `std::fs::remove_*` for delete, gated on the `winstt::stt::resolver` cache-path resolution.

### H2 — File transcription always fails (decode stub)
- **Ours:** `FileTranscribeManager::decode_audio_to_pcm` (`managers/file_transcribe_manager.rs:679-683`) is a SPIKE that **always returns `Err("file audio decode not yet wired (symphonia spike)")`**, so `process_file` marks every row `Error`. The sequential queue, PTT auto-pause, per-row pause/resume, busy broadcast, and auto-clear are all genuinely implemented around it.
- **Worse/broken:** drag-drop file transcription is 100% broken (every file errors). This is a faithful queue port with a hollow center.
- **Fix:** implement `decode_audio_to_pcm` with symphonia (wav/mp3/mp4/aac/flac/ogg) → mono → resample to 16 kHz, per the file header.

### H3 — Listen + wakeword modes never receive audio
- **Ours:** `LoopbackManager::start` (`managers/loopback_manager.rs:93-108`) is a SPIKE — it flips `capturing=true` but spawns NO WASAPI worker, so no system audio is captured. `WakeWordManager::feed_chunk` (`managers/wakeword_manager.rs:135`) is the detection step but is **never called** from the audio consumer (`recorder.rs` is byte-identical to Handy; `grep feed_chunk` finds no call site). The SlowAgc + arming state + keyword-spec assembly are real.
- **Worse/broken:** `start_listen` emits `stt:loopback-started` and the pill shows, but no transcription ever occurs (no audio source). Wakeword detection is permanently inert regardless of config.
- **Fix:** implement the WASAPI loopback capture loop pushing AGC'd 16 kHz blocks into the recording consumer; call `WakeWordManager::feed_chunk` from `run_consumer` when armed (with the `sherpa` KWS feature).

### H4 — Specta typed events registered but never emitted (pattern divergence)
- **Handy does:** `HistoryUpdatePayload` derives `tauri_specta::Event`, is in `collect_events!`, AND is actually emitted (`payload.emit(&app)` in `managers/history.rs`).
- **Ours does:** 8 typed events (`RealtimeStabilizedPayload, RealtimeUpdatePayload, WakeWordDetectedPayload, SpeakerSegmentsPayload, WordAlignmentPayload, VadSensitivityAdaptedPayload, TtsLifecyclePayload, FileTranscribeProgressPayload`) are in `collect_events!` (`lib.rs:563-573`) but **none are ever `.emit()`d** — the managers emit *plain string* events instead (e.g. wakeword emits `wake_word_detected` via `app.emit`, not `WakeWordDetectedPayload::emit`). The typed events only appear in `events.rs` and doc comments.
- **Worse/broken:** any renderer code generated against `bindings.ts` typed event listeners for these will never fire. The collected events also widen the generated bindings with dead surface. It's a half-applied pattern: typed registration without typed emission.
- **Fix:** either emit the typed events from their producers (Handy's pattern), or remove them from `collect_events!` and keep the plain-string path consistently. Pick one; don't register-without-emit.

### H5 — TTS engine never reconfigured from settings; no asset download
- **Ours:** `TtsManager::reload_engine` (`managers/tts_manager.rs:103`) exists but is **never called** (`grep` confirms). So the engine is permanently `KokoroLocalEngine::new(LocalTtsConfig::default())` — the configured `tts.source` (cloud vs local), voice, cache dir, and device are never applied. Separately, `tts_init`/`tts_install_resume` call `warm_up()`, which **requires assets already on disk** (`kokoro.rs:319 assets_present()`), but **no code downloads the Kokoro model files** (`tts_download_estimate`/`tts_install_pause`/`tts_install_cancel` are SPIKE no-ops).
- **Worse/broken:** on a clean install, `tts_init` returns `Err("kokoro assets missing")` and TTS never works locally; even with assets, cloud TTS and non-default voices/devices are unreachable.
- **Fix:** call `reload_engine` from `tts_init` (and on a `tts.*` settings change) with the config derived from settings; wire the resumable asset download (the `06_tts.md` shared downloader) before `warm_up`.

---

## MEDIUM findings

### M1 — Cloud-TTS / install commands return fake/empty data
`tts_list_cloud_voices` returns `Ok(vec![])`, `tts_cloud_subscription` returns `CloudSubscription::default()`, `tts_download_estimate` returns `DownloadEstimate::default()`, `tts_install_pause/cancel` are empty (`winstt/commands/tts.rs:189-234`). These compile and "succeed" but supply no data → the cloud voice picker is always empty, quota hints blank, install controls inert. Implement the ElevenLabs `GET /v2/voices` + `/v1/user/subscription` fetches and the asset-downloader signaling.

### M2 — Diarization always one speaker
`DiarizationManager::assign_speakers` (`managers/diarization_manager.rs:64-74`) always returns a single speaker-0 segment (embedder is a SPIKE). Listen-mode subtitles are produced un-diarized. Documented degrade, but flag: speaker segmentation never works until the sherpa embedding session is wired.

### M3 — Word-timestamp alignment always empty
`WordAligner::try_load_engine` (`managers/word_aligner.rs:70-77`) always returns `None`, so `align_words` returns `[]`. The `align_words` command correctly resolves the WAV + transcript (real), but karaoke highlight in history never lights up. Wire the `whisper-tiny_timestamped` cross-attention DTW engine.

### M4 — Poison-panic `.lock().expect()` in WinSTT managers
`DownloadManager` (7 sites) and `FileTranscribeManager` (`worker_gate`, `last_broadcast_active`, `state`) use `.lock().expect("… poisoned")`. A panic inside any critical section poisons the lock and turns every subsequent access into a process abort — versus Handy's internal locks which tend to `unwrap` only where a poison is genuinely unrecoverable, and `try_state`/`unwrap_or` at the edges. Low blast radius (internal state), but a robustness divergence; prefer recovering with `unwrap_or_else(|e| e.into_inner())` or `lock().ok()`-guarded paths.

### M5 — API keys persisted in plaintext
`apply_settings_patch` has a SPIKE (`settings.rs:182-187`) — `SECRET_KEYS` (`llm.openrouterApiKey`, `openai.apiKey`, `elevenlabs.apiKey`) are written to `winstt-settings.json` **unencrypted**. Handy redacts secrets (`SecretMap`) and the WinSTT Electron app used safeStorage. Route secrets through Tauri `keyring`/safeStorage before persist.

---

## LOW findings

### L1 — `EmitChunkSink` cancel flag is disconnected
`managers/tts_manager.rs:335-348`: `EmitChunkSink.cancelled` is a fresh `Arc<Mutex<bool>>(false)` that's never linked to the manager's cancel set (the `_mgr` ctor param is unused). So `sink.is_cancelled()` is always `false` — mid-sentence cancel during a long synthesis is ignored (the sentence-boundary `self.is_cancelled(request_id)` check in `read_aloud` still catches it between sentences). Wire the sink to the manager's per-request cancel state.

### L2 — STT engine factory only supports WhisperHf (latent)
`winstt/stt/mod.rs:407-427`: `build_engine` returns `Unsupported` for every non-Whisper family (Moonshine/Cohere/NeMo/Kaldi/GigaAM/T-One/Dolphin/SenseVoice). Not yet in the live path (the engine swap — PROGRESS step 3 — hasn't replaced transcribe-rs), so dictation currently uses Handy's transcribe-rs and this is dormant. Flag for the swap: until the family engines land, switching the picker to any non-Whisper model would fail.

### L3 — Dead duplicate `onboarding_finish`
`windows.rs:273-283` `onboarding_finish` is `#[allow(dead_code)]` (the live one is `winstt::commands::onboarding::onboarding_finish`, registered in `collect_commands!`). Harmless dead code; confirm the live command actually hides onboarding + shows main (the adapter routes `ONBOARDING_FINISH` → `onboarding_finish`).

---

## What the port got RIGHT (so the fix workflow doesn't regress it)

- **Manager construction/Arc/.manage** — the 9 managed WinSTT managers follow Handy's `Arc::new(M::new(app))` + `.manage()` pattern faithfully, in the right order (deps first: `WordAligner`/`FileTranscribeManager` take `model_manager`/`transcription_manager` clones). Only `DownloadManager` is missing (C4).
- **`open_window` itself is correct** — `windows.rs::ensure_window`→`open_window` lazily builds the WebviewWindow from a 1:1 chrome spec, shows + focuses it; capabilities (`default.json`) list all 9 labels; the 9 HTML entries exist in `windows/` and build to `dist/windows/`; the adapter routes `WINDOW_OPEN_SETTINGS`→`open_window {name:"settings"}` correctly. **If "opening settings doesn't open" reproduces, it is most likely a renderer-side issue** (adapter `install()` not run before the click, the `windows/settings.html` entry failing to load in the webview, or a JS error in that entry), **not the Rust window command** — that path traces cleanly. Recommend verifying the adapter is installed in the settings entry and that `dist/windows/settings.html` loads under `file://` / dev URL.
- **Settings persistence + validation** — `winstt_set_settings` is NOT a thin setter: it does partial-section merge (avoiding the clobber bug), Zod-equivalent cross-field validation, restart-need diffing, broadcast of the full snapshot. Genuinely good (its only gaps are C2 bridge + M5 encryption).
- **Catalog** — `list_models` returns the real embedded 408-row catalog with EP-aware quant policy (not a stub).
- **LLM/Cloud-STT/Context managers** — `LlmManager` (Ollama streaming + caps cache + cancel), `CloudSttManager` (multipart upload + typed error taxonomy + verify), `ContextManager` (sidecar spawn + watchdog + bounded read) are real implementations.
- **Kokoro local engine** — `winstt/tts/kokoro.rs` genuinely loads ORT, parses the voice pack, runs inference; `phonemize.rs` shells espeak-ng. Works given assets + the reload/download wiring (H5).
- **`panic = "unwind"` / catch_unwind preserved** — `Cargo.toml [profile.release]` is byte-identical to Handy; the coordinator's `catch_unwind` boundary is intact (no engine swap yet).
- **Coordinator + Handy dictation path** — byte-identical to upstream and functional (this is why the exe records/transcribes/pastes at all). The divergences are everything layered *around* it (C1/C2/C3).

---

## Recommended fix order (drives the workflow)

1. **C4** (1-line `.manage` — unblocks all download commands from panicking).
2. **C1 + C3** (emit the SttEvents/HotkeyEvents from the Handy-owned producers — restores the entire dictation HUD + PTT + rebind).
3. **C2** (settings bridge — makes WinSTT settings actually affect behavior).
4. **C5** (tray-menu wiring — restores WinSTT tray UX).
5. **H1/H2/H3/H5** (fill the download / file-decode / loopback+wakeword / TTS-reload+assets engines).
6. **H4 + M1–M5 + L1–L3** (typed-event consistency, cloud-TTS data, secret encryption, cancel-flag, cleanup).
7. (Separate track) **L2** lands with PROGRESS step 3, the transcribe-rs → `winstt::stt` engine swap.
