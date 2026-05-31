// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/lib_wiring.md §3.
//
// The WinSTT Tauri command layer. Every `#[tauri::command] #[specta::specta]` fn
// here wraps a manager (winstt/managers/*.rs) or a pure module (catalog,
// settings_schema, cloud_stt, llm, tts, context). Every payload type derives
// `specta::Type, serde::{Serialize, Deserialize}, Clone` so tauri-specta emits TS
// bindings + invoke routing.
//
// Commands are grouped by feature; the orchestrator appends each `winstt::commands::<group>::<fn>`
// to `collect_commands![]` in lib.rs (the full list is in lib_wiring.md §3).

pub mod settings;
/// Secret-at-rest seal/open (`enc:v1:` envelope) for the three secret settings
/// (`llm.openrouterApiKey` + the two `integrations.*.apiKey`). The Rust analogue
/// of Electron's `safeStorage` wrapper (frontend/electron/lib/secret-storage.ts):
/// `winstt_set_settings` seals on write, `read_settings` opens on read so every
/// internal consumer (LLM / cloud-STT / verify) and the renderer see plaintext.
pub mod secret_storage;
pub mod stt;

// ── slice: model catalog + picker + download (app/PORT/10_frontend_port_plan.md §6 — WU-4) ──
/// The RICH editorial catalog (embedded catalog_data.json → CatalogModelInfo + ModelStateEntry
/// + ModelsWithState) the detached picker renders. Pure data; no commands. Consumed by stt::list_models
/// and runtime::list_models_with_state.
pub mod catalog_data;
/// Per-quant download commands (predownload_quant / download_pause_quant / download_resume_quant /
/// download_cancel_quant / delete_model_quantization / delete_model_cache / cancel_download) → the
/// DownloadManager (managers::download_manager). Registered in lib.rs collect_commands![].
pub mod download;
/// Runtime + fitness commands (get_runtime_info / list_models_with_state / assess_dictation_fit /
/// assess_ollama_fit / gpu_get_info). Registered in lib.rs collect_commands![].
pub mod runtime;
/// PLAIN-event emit façade for the model-swap lifecycle + runtime-info push (stt:model-swap-started/
/// completed/failed + stt:runtime-info). No commands — called by the engine-swap path inside
/// TranscriptionManager (lib_wiring §7). NOT collected.
pub mod swap_events;

// ── slice: dictation core + hotkey (app/PORT/10_frontend_port_plan.md §6 — WU-3) ──
/// STT_SET/GET_PARAMETER + STT_CALL_METHOD + STT_RELOAD_MODEL command seam the
/// reused renderer drives, plus the SttEvents lifecycle/level emit façade
/// (recording/vad/full-sentence/no-audio/audio-level/connection/server-status/
/// session-aborted) + `winstt_emit_ready`. Registered in lib.rs collect_commands![].
pub mod dictation;
/// HOTKEY_REGISTER/UNREGISTER + key-combo capture (START/STOP_RECORDING) commands
/// + the HotkeyEvents emit façade (hotkey:pressed/released/recording-update/done).
pub mod hotkey;
/// Recording-overlay visibility: show/hide/reposition the WinSTT `overlay` window
/// (windows/overlay.html — the renderer dynamic-island pill) in lock-step with the
/// recording lifecycle. Ports frontend/electron/ipc/overlay.ts (showOverlay /
/// hideOverlay / computeOverlayPosition / suppression gates). No commands — called
/// from the recording pipeline (TranscribeAction + cancel) and settings live-change.
pub mod overlay;
/// User-initiated dictation cancel: `cancel_current_operation` (STT_ABORT_OPERATION
/// → overlay X / cancel combo). Wraps the centralized `utils::cancel_current_operation`
/// + emits `stt:session-aborted`. Registered in lib.rs collect_commands![].
pub mod cancel;
pub mod tts;
pub mod llm;
// ── slice: LLM/Ollama long-tail (app/PORT/10_frontend_port_plan.md — WU-6) ──
/// Ollama public-library scraper: ollama_fetch_library / ollama_fetch_tags /
/// ollama_search_library (no JSON API → HTML scrape, mirrors ollama-registry.ts).
pub mod ollama_library;
/// Ollama pull-cancel registry + warmup-status command: ollama_cancel_pull /
/// llm_get_warmup_status (+ pull-progress/warmup payload types).
pub mod ollama_pull;
pub mod cloud_stt;
// ── slice: WU-7 cloud-STT + credential verification (10_frontend_port_plan.md §6 WU-7) ──
/// The ONE renderer verify seam (`INTEGRATIONS_VERIFY` → `verify_integration_credential`):
/// unified OpenAI / ElevenLabs / OpenRouter probe returning `{ ok, code?, message? }`.
pub mod verify;
pub mod wakeword;
pub mod listen;
// ── slice: loopback device list (app/PORT/10_frontend_port_plan.md WU-9) ──
/// `loopback_list_devices` — enumerate WASAPI loopback output devices for the
/// listen-mode device picker. Registered in lib.rs collect_commands![].
pub mod loopback;
/// PLAIN-event emit helpers for the WU-9 listen channels (vad-sensitivity-adapted,
/// device-switch-failed, speaker-segments). No commands — called by the producers
/// (calibrator consumer / device-switch path / DiarizationManager). NOT collected.
pub mod listen_events;
// ── slice: audio input devices (app/PORT/10_frontend_port_plan.md WU-9 — entities/audio-device) ──
/// `get_audio_devices` — enumerate audio INPUT devices in the WinSTT spec
/// `AudioDevice` shape for the renderer's mic pickers. Registered in lib.rs
/// collect_commands![].
pub mod audio_devices;
pub mod wordts;
pub mod file_transcribe;
pub mod context;
/// Recording-sound library + active-chime bytes: sound_library_add / sound_library_read_file /
/// sound_library_remove + sound_get_data (SOUND_GET_DATA — the renderer's Web Audio preloader).
pub mod sound;

// ── slice: custom-models folder (app/PORT/10_frontend_port_plan.md §6 — WU-11) ──
/// `open_custom_models_folder` — return the per-user custom-models dir
/// (`<appData>/models/custom`) for the opener-plugin route (CUSTOM_MODELS_OPEN_FOLDER).
/// Registered in lib.rs collect_commands![].
pub mod custom_models;

// ── slice: history (app/PORT/10_frontend_port_plan.md §6 — WU-10) ──
/// History command surface: backs BOTH the dedicated history window (SQLite-store
/// channels, NUMBER id — history_list/recent/delete_row/toggle/load_audio_by_row/
/// add) AND the settings-panel karaoke table (legacy electron-store channels,
/// STRING id — history_get_all/clear/delete/load_audio) with Handy's single
/// `managers::history` (one on-disk source of truth, reshaped per channel group).
/// Plus `install_history_event_bridge` (collected `HistoryUpdatePayload` →
/// WinSTT-shaped plain events history:added/deleted + history:row-*). The
/// align-audio channel maps to the existing `winstt::commands::wordts::align_words`.
/// Registered in lib.rs collect_commands![] + a one-time bridge call in
/// initialize_core_logic.
pub mod history;

// ── slice: about / diagnostics (app/PORT/10_frontend_port_plan.md §1b/§6 — WU-11) ──
/// About-panel metadata + bundled LICENSE / THIRD_PARTY_NOTICES readers
/// (about_get_license / about_get_notices / about_get_app_info). Registered in
/// lib.rs collect_commands![].
pub mod about;

/// Diagnostics: log-folder path + a deflate zip bundle of logs + system-info
/// (diag_open_logs_folder / diag_save_bundle). Registered in lib.rs collect_commands![].
pub mod diag;

// ── slice: transforms + context-playground (app/PORT/10_frontend_port_plan.md §6 — WU-13) ──
/// Transforms apply/preview pipeline (`apply_transform` / `apply_transform_preview`)
/// + the `transforms:applied` / `transforms:failed` renderer feedback events.
pub mod transforms;

/// DEBUG-ONLY context-awareness playground backend: live poll loop +
/// `context-playground:report` push (`context_playground_set_live` /
/// `context_playground_arm_deep` / `context_playground_capture`). The whole file
/// is `#![cfg(feature = "context-playground")]`, so it vanishes from shipped builds.
pub mod context_playground;

// ── slice: window management (app/PORT/10_frontend_port_plan.md §4b — WU-0) ──
/// The 9-window WinSTT topology: open_window / close_window / resize_window /
/// anchor_window / onboarding_finish. Lazy-create + hide-on-close (Electron
/// keep-alive semantics). Registered in lib.rs collect_commands![].
pub mod windows;

// ── slice: tray-menu placement (app/PORT/10_frontend_port_plan.md §6 — WU-12) ──
/// WinSTT's custom HTML tray menu (`views/tray-menu`): show_tray_menu /
/// reanchor_tray_menu / hide_tray_menu. Anchors the transparent BrowserWindow
/// at the tray-icon/cursor point, clamped to the monitor work area (ports the
/// Electron `tray-menu-window.ts` placement). Registered in lib.rs
/// collect_commands![]; needs `.manage(TrayMenuAnchor::default())`.
pub mod tray_menu;

// ── slice: onboarding wizard finish (app/PORT/10_frontend_port_plan.md §6 — WU-12) ──
/// `onboarding_finish` — persists the MAIN-owned onboarding flags
/// (general.onboarded / onboardedAt / onboardedTrack), broadcasts
/// `settings:changed`, then hides the wizard + shows main. Ports the Electron
/// `onboarding-window.ts` FINISH handler (the WU-0 `windows::onboarding_finish`
/// stub does the window transition only). Register THIS in lib.rs
/// collect_commands![] IN PLACE OF `windows::onboarding_finish`.
pub mod onboarding;

/// The specta-typed events the WinSTT port emits (registered in
/// `collect_events![]`). Re-exported here so lib.rs has one import site.
pub mod events;
