// The WinSTT manager layer. Each manager is an `Arc`-friendly struct holding the
// relevant engine/state, constructed with `new(&AppHandle)` and exposing the
// methods the Tauri command layer (`winstt/commands/*.rs`) calls.
//
// These are the "managed state" objects registered in `initialize_core_logic`
// (lib.rs) via `app_handle.manage(Arc::new(<Manager>::new(app_handle)))`. They
// wrap the pure-logic + transport modules under `winstt/`
// (llm, cloud_stt, context, catalog, settings_schema, tts, wakeword).
//
// DUAL-MANAGER BOUNDARY: `winstt/managers/` = WinSTT feature subsystems (cloud STT,
// TTS, diarization, wakeword, LLM, realtime, context, file-transcribe, downloads);
// `crate::managers/` = the legacy pipeline core (audio, model, transcription,
// history). The dependency edge is one-way — these feature managers reuse the core
// (e.g. `loopback_manager` drives `crate::managers::transcription::TranscriptionManager`),
// never the reverse.

pub mod cloud_stt_manager;
pub mod context_manager;
pub mod diarization_manager;
pub mod file_transcribe_manager;
pub mod llm_manager;
pub mod loopback_manager;
pub mod tts_download_manager;
pub mod tts_manager;
pub mod wakeword_manager;
pub mod word_aligner;
// ── slice: model download ──
/// Per-quant streaming download manager (predownload/pause/resume/cancel/delete +
/// the stt:model-download-* / stt:model-cache-changed broadcasts).
pub mod download_manager;
// ── slice: realtime streaming transcription (live-preview worker) ──
/// Daemon worker that decodes a growing window of the in-flight recording for the live
/// preview, driving the RealtimeAccumulator (committed-watermark + RealtimeSTT stabilizer).
pub mod realtime_manager;

pub use cloud_stt_manager::CloudSttManager;
pub use context_manager::ContextManager;
pub use diarization_manager::DiarizationManager;
pub use download_manager::DownloadManager;
pub use file_transcribe_manager::FileTranscribeManager;
pub use llm_manager::LlmManager;
pub use loopback_manager::LoopbackManager;
pub use realtime_manager::RealtimeManager;
pub use tts_manager::TtsManager;
pub use wakeword_manager::{WakeWordManager, WakeWordModelStatusPayload};
pub use word_aligner::WordAligner;
