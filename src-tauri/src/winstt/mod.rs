// WinSTT module tree for the Rust/Tauri app.
//
// Modules here are the active Rust paths.
// They stay grouped by dependency tier so build failures point at the owning
// layer.

// ───────────────────────── pure-logic (no new deps) ─────────────────────────

/// WinSTT's full nested settings tree (9 tabs) as a specta-typed struct.
pub mod settings_schema;

/// Full 65-model STT catalog + quant/EP auto-policy (pure data + string logic).
pub mod catalog;

/// Shared in-flight request cancel registry (cloud STT / LLM / TTS).
pub mod cancel_registry;

/// Shared `std::sync::Mutex` poison-recovery idiom (`MutexExt::lock_recover`).
pub mod sync_ext;

/// Shared audio conditioning for batch STT and streaming wakeword detection.
pub mod audio_conditioning;

/// Event-driven audio device hotplug watcher. Uses native OS notifications when
/// available and keeps renderer device selectors in sync without polling.
pub mod audio_device_watcher;

/// Shared single-flight + warm-state tracking for heavyweight model lifecycles.
pub mod model_swap;

/// RealtimeSTT-faithful preview stabilizer + committed-watermark accumulator.
pub mod realtime_stabilizer;

/// Deterministic snippet / text-expansion engine (fuzzy trigger→expansion with
/// Jaro-Winkler + double-metaphone gates). Applied as the LAST post-processing step before paste.
pub mod snippets;

// ───────────────────────── reqwest / windows-feature ─────────────────────────
/// Cloud STT: reqwest multipart to OpenAI/ElevenLabs.
pub mod cloud_stt;
/// Context-awareness: winstt-context.exe sidecar wrapper + deny-list.
pub mod context;
/// Shared HTTP asset transfers (Range resume, pause/cancel, progress, speed, ETA).
pub mod downloads;
/// System-audio ducking via IAudioEndpointVolume::SetMasterVolumeLevelScalar (graduated 0-100%).
pub mod ducking;
/// Masked-LM (mmBERT) dictionary corrector — the NON-LLM dictation fallback (context-aware vocab
/// snapping when LLM cleanup is off). Model downloads on demand.
pub mod encoder_dict;
/// All-Rust LLM post-processing: prompt composition + Ollama NDJSON streaming + CoT salvage.
pub mod llm;
/// Direct Ollama HTTP client used by the LLM manager.
pub mod ollama_client;
// ───────────────────────── heavy ONNX crates ─────────────────────────
/// Unified ONNX-on-`ort` STT engine: Transcriber trait + per-family engines.
pub mod stt;
/// Local Kokoro (in-process, on our ort) + cloud ElevenLabs TTS.
pub mod tts;
/// sherpa-onnx KWS wake word (open-vocabulary, offline).
pub mod wakeword;

// ───────────────────────── Advanced subsystems ─────────────────────────
/// Speaker diarization: sherpa-onnx embedder + OnlineSpeakerClustering + SpeakerTimeline.
pub mod diarization;
/// WASAPI system-audio loopback capture (listen mode) + slow-tracking AGC.
pub mod loopback;
/// Cross-attention DTW word-level timestamps (karaoke playback).
pub mod word_timestamps;

// ───────────────────────── Tauri command + manager layer ─────────────────────────
/// #[tauri::command] #[specta::specta] wrappers (settings, stt, tts, llm, cloud_stt, wakeword, …).
pub mod commands;
/// Manager structs held in Tauri state (LlmManager, TtsManager, WakeWordManager, …).
pub mod managers;
