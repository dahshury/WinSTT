// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/lib_wiring.md §1c/§2.
//
// The WinSTT manager layer. Each manager is an `Arc`-friendly struct holding the
// relevant engine/state, constructed with `new(&AppHandle)` and exposing the
// methods the Tauri command layer (`winstt/commands/*.rs`) calls.
//
// These are the "managed state" objects registered in `initialize_core_logic`
// (lib.rs) via `app_handle.manage(Arc::new(<Manager>::new(app_handle)))`. They
// wrap the pure-logic + transport modules already drafted under `winstt/`
// (llm, cloud_stt, context, catalog, settings_schema, tts, wakeword).
//
// HARD RULE: new files only. The orchestrator adds `pub mod managers;` to
// `winstt/mod.rs` and the `.manage(...)` / `collect_commands!` wiring to lib.rs.

pub mod llm_manager;
pub mod cloud_stt_manager;
pub mod context_manager;
pub mod tts_manager;
pub mod wakeword_manager;
pub mod diarization_manager;
pub mod loopback_manager;
pub mod word_aligner;
pub mod file_transcribe_manager;
// ── slice: model download (app/PORT/10_frontend_port_plan.md §6 WU-4) ──
/// Per-quant streaming download manager (predownload/pause/resume/cancel/delete +
/// the stt:model-download-* / stt:model-cache-changed broadcasts).
pub mod download_manager;

pub use cloud_stt_manager::CloudSttManager;
pub use context_manager::ContextManager;
pub use diarization_manager::DiarizationManager;
pub use download_manager::DownloadManager;
pub use file_transcribe_manager::FileTranscribeManager;
pub use llm_manager::LlmManager;
pub use loopback_manager::LoopbackManager;
pub use tts_manager::TtsManager;
pub use wakeword_manager::WakeWordManager;
pub use word_aligner::WordAligner;
