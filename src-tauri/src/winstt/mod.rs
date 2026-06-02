// PORT IMPL — Source: WinSTT port plan (app/PORT/README.md)
//
// Root of the WinSTT port modules. ALL new WinSTT subsystems live under
// `src-tauri/src/winstt/`. Handy's own files stay unmodified except the single
// `pub mod winstt;` line in lib.rs (so upstream merges remain feasible).
//
// Modules are grouped by the dependency tier they belong to (pure-logic,
// reqwest/windows-feature, heavy ONNX crates) — the original compile-loop
// staging order. Order follows app/PORT/lib_wiring.md §9.

// ───────────────────────── pure-logic (no new deps) ─────────────────────────

/// WinSTT's full nested settings tree (9 tabs) as a specta-typed struct.
/// See app/PORT/02_settings.md.
pub mod settings_schema;

/// Full 42-model STT catalog + quant/EP auto-policy (pure data + string logic).
pub mod catalog;

/// Adaptive Silero VAD sensitivity calibrator (SNR-driven, EMA-blended).
pub mod vad_calibrator;

/// STUB: dynamic-silence endpoint formula + sentence-classifier trait + noise-break.
/// Pure logic + tests are complete; NOT yet wired into the recorder pipeline.
/// Ships `NullClassifier` (punctuation heuristic) until the DistilBERT ONNX export exists.
pub mod endpointing;

/// RealtimeSTT-faithful preview stabilizer + committed-watermark accumulator.
pub mod realtime_stabilizer;

/// Deterministic snippet / text-expansion engine (fuzzy trigger→expansion with
/// Jaro-Winkler + double-metaphone gates). Applied as the LAST post-processing step before paste.
pub mod snippets;

// ───────────────────────── reqwest / windows-feature ─────────────────────────
/// All-Rust LLM post-processing: prompt composition + Ollama NDJSON streaming + CoT salvage.
pub mod llm;
/// Cloud STT: reqwest multipart to OpenAI/ElevenLabs.
pub mod cloud_stt;
/// Context-awareness: winstt-context.exe sidecar wrapper + deny-list.
pub mod context;
/// STUB: terminal-aware paste (TERMINAL_CLASSES/EXES → Ctrl+Shift+V) + fallback chain +
/// circuit-breaker. Detection tables + breaker/pacing math are complete; the Win32
/// foreground probe is sketched but NOT yet wired into the paste path.
pub mod paste_ext;
/// System-audio ducking via IAudioEndpointVolume::SetMasterVolumeLevelScalar (graduated 0-100%).
pub mod ducking;

// ───────────────────────── heavy ONNX crates ─────────────────────────
/// Unified ONNX-on-`ort` STT engine: Transcriber trait + per-family engines.
pub mod stt;
/// sherpa-onnx KWS wake word (open-vocabulary, offline).
pub mod wakeword;
/// Local Kokoro (in-process, on our ort) + cloud ElevenLabs TTS.
pub mod tts;

// ───────────────────────── Advanced subsystems ─────────────────────────
/// Speaker diarization: sherpa-onnx embedder + OnlineSpeakerClustering + SpeakerTimeline.
pub mod diarization;
/// WASAPI system-audio loopback capture (listen mode) + slow-tracking AGC.
pub mod loopback;
/// Cross-attention DTW word-level timestamps (karaoke playback).
pub mod word_timestamps;

// ───────────────────────── Tauri command + manager layer ─────────────────────────
/// Manager structs held in Tauri state (LlmManager, TtsManager, WakeWordManager, …).
pub mod managers;
/// #[tauri::command] #[specta::specta] wrappers (settings, stt, tts, llm, cloud_stt, wakeword, …).
pub mod commands;
