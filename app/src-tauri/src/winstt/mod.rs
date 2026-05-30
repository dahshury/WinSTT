// DRAFT PORT — being compiled incrementally. Source: WinSTT port plan (app/PORT/README.md)
//
// Root of the WinSTT port modules. ALL new WinSTT subsystems live under
// `src-tauri/src/winstt/`. Handy's own files stay unmodified except the single
// `pub mod winstt;` line in lib.rs (so upstream merges remain feasible).
//
// COMPILE-LOOP STAGING: modules are declared in waves so each wave can be
// `cargo check`ed green before the next. Order follows app/PORT/lib_wiring.md §9.
//
//   WAVE 1 (active) — pure-logic, ZERO new crates (std + serde/specta already present).
//   WAVE 2 — reqwest/tokio/windows-feature modules (llm, cloud_stt, context, paste_ext, ducking).
//   WAVE 3 — new heavy crates: stt (ort), wakeword (sherpa-onnx), tts (kokoro). Gated by the
//            STT de-risking spike (app/PORT/03_stt_engine.md §11) before the engine swap.

// ───────────────────────── WAVE 1 — pure-logic (no new deps) ─────────────────────────

/// WinSTT's full nested settings tree (9 tabs) as a specta-typed struct.
/// See app/PORT/02_settings.md.
pub mod settings_schema;

/// Full 42-model STT catalog + quant/EP auto-policy (pure data + string logic).
pub mod catalog;

/// Adaptive Silero VAD sensitivity calibrator (SNR-driven, EMA-blended).
pub mod vad_calibrator;

/// Optional parity AND-gate VAD (WebRTC + Silero); VAD = lean-on-Handy ships.
pub mod composite_vad;

/// Dynamic-silence endpoint formula + sentence-classifier trait + noise-break.
/// Ships `NullClassifier` (punctuation heuristic) until the DistilBERT ONNX export exists.
pub mod endpointing;

/// RealtimeSTT-faithful preview stabilizer + committed-watermark accumulator.
pub mod realtime_stabilizer;

// ───────────────────────── WAVE 2 — reqwest / windows-feature (next) ─────────────────────────
// All-Rust LLM post-processing: prompt composition + Ollama NDJSON streaming + CoT salvage.
// pub mod llm;
// Cloud STT: reqwest multipart to OpenAI/ElevenLabs (needs reqwest `multipart` feature).
// pub mod cloud_stt;
// Context-awareness: winstt-context.exe sidecar wrapper + deny-list.
// pub mod context;
// Terminal-aware paste (needs windows Win32_System_ProcessStatus feature).
// pub mod paste_ext;
// System-audio ducking (needs windows Win32_Media_Audio feature).
// pub mod ducking;

// ───────────────────────── WAVE 3 — new heavy crates (gated by STT spike) ─────────────────────────
// Unified ONNX-on-`ort` STT engine: Transcriber trait + per-family engines. NEEDS: ort, ndarray.
// pub mod stt;
// sherpa-onnx KWS wake word. NEEDS: sherpa-onnx (reconcile the draft's `sherpa_rs` → `sherpa-onnx`).
// pub mod wakeword;
// Local Kokoro (in-process) + cloud ElevenLabs TTS. NEEDS: kokoroxide/kokorox, ort.
// pub mod tts;
