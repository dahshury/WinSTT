// Source: docs/port/lib_wiring.md §4a.
//
// Specta-typed events the WinSTT port emits. Each derives the same set as Handy's
// `HistoryUpdatePayload` (Clone + Serialize + Deserialize + specta::Type +
// tauri_specta::Event) so it can be registered in `collect_events![]` and emitted
// type-safely via the `Event` trait (`Payload { .. }.emit(&app)`).
//
// lib_wiring.md §4a lists these under `winstt::stt::*` / `winstt::wakeword::*`,
// but those modules predate this slice; centralizing them here keeps the heavy
// engine/wakeword modules free of specta deps. The orchestrator collects them as
// `winstt::commands::events::*` (note in modDecls/libWiring).
//
// NOTE: high-frequency streaming channels (llm-reasoning-delta, tts://chunk,
// stt-cloud-error, file-transcribe-progress, wake_word_detected, realtime-*) are
// emitted as PLAIN string events from the managers (matching WinSTT's IPC shape
// so the reused renderer's listeners work unchanged — lib_wiring §4b). The typed
// events below are the structured payloads the renderer consumes type-safely.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

/// Realtime preview after stabilization (committed-watermark accumulator).
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeStabilizedPayload {
    pub text: String,
}

/// Raw realtime preview (pre-stabilization) — drives the noise-break heuristic.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeUpdatePayload {
    pub text: String,
}

/// Wake-word detected (INACTIVE → LISTENING transition cue).
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct WakeWordDetectedPayload {
    pub word: String,
    pub word_index: i32,
}

/// Diarized speaker segments for a listen-mode window.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSegment {
    pub speaker: i32,
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSegmentsPayload {
    pub segments: Vec<SpeakerSegment>,
}

/// One word with start/end seconds — the `align_words` result for history playback.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct WordTiming {
    pub text: String,
    pub start: f32,
    pub end: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct WordAlignmentPayload {
    pub entry_id: String,
    pub words: Vec<WordTiming>,
}

/// Per-device VAD sensitivity calibration result (renderer persists it).
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct VadSensitivityAdaptedPayload {
    pub device_id: String,
    pub sensitivity: f32,
}

/// TTS lifecycle event (started / completed / failed / download-progress).
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TtsLifecyclePayload {
    pub request_id: String,
    /// "started" | "completed" | "failed" | "download-progress"
    pub phase: String,
    pub message: Option<String>,
    /// 0.0..1.0 for download-progress.
    pub progress: Option<f32>,
}

/// Per-file/per-chunk file-transcription progress.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct FileTranscribeProgressPayload {
    pub id: String,
    pub path: String,
    pub status: String,
    pub progress: f32,
    pub text: Option<String>,
    pub error: Option<String>,
}
