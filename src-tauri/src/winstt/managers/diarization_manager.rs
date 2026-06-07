// Reference: onnx-asr/src/onnx_asr/diarization.py, server diarization_stream.py + domain/speaker_timeline.py.
//
// DiarizationManager owns the per-utterance `SessionDiarizer` and the continuous
// `SpeakerTimeline` used by listen mode. The sherpa-onnx speaker-embedding session
// + pyannote-segmentation graph are the heavy ML internals (gated behind the KWS
// spike); this manager is the lifecycle + state + event-emit shell.
//
// Emits the specta-typed `SpeakerSegmentsPayload` (diarized segments). The
// renderer event-name contract is unchanged from WinSTT's the reference IPC.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

/// One speaker-attributed segment (seconds). Mirrors WinSTT's diarized segment.
#[derive(Clone, Debug)]
pub struct SpeakerSegment {
    pub speaker: i32,
    pub start: f32,
    pub end: f32,
    pub text: String,
}

pub struct DiarizationManager {
    app: AppHandle,
    /// True while listen-mode diarization is running (runtime-toggleable, even
    /// for an in-flight session — mirrors the idempotent enable in WinSTT).
    enabled: AtomicBool,
}

impl DiarizationManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            enabled: AtomicBool::new(false),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    /// Toggle diarization (idempotent for in-flight sessions). Returns the new
    /// state. The embedding session is lazily created on first enable.
    pub fn set_enabled(&self, enabled: bool) -> bool {
        self.enabled.store(enabled, Ordering::Release);
        // SPIKE: lazily create / release the sherpa-onnx embedding session +
        // pyannote-seg graph here (05_*.md). Until the ort IoBinding wiring for
        // the embedder lands, the session is unset and `assign_speakers` returns
        // a single speaker — listen mode still produces (un-diarized) subtitles.
        enabled
    }

    /// Reset the speaker timeline (new listen session). No-op until the embedder
    /// is wired.
    pub fn reset(&self) {
        // SPIKE: clear OnlineSpeakerClustering centroids + SpeakerTimeline.
    }

    /// Assign speaker ids to a freshly transcribed utterance window. Until the
    /// embedder is wired, all words are attributed to speaker 0 (the documented
    /// degrade path: un-diarized but correct text).
    pub fn assign_speakers(&self, start: f32, end: f32, text: &str) -> Vec<SpeakerSegment> {
        // SPIKE: extract speaker embeddings over the window, cluster against the
        // running centroids (OnlineSpeakerClustering), split the text at speaker
        // change points (assign_speakers_to_words). Default: one speaker segment.
        vec![SpeakerSegment {
            speaker: 0,
            start,
            end,
            text: text.to_string(),
        }]
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}
