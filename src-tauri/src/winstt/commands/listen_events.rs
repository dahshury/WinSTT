// Reference: frontend/electron/ipc/relay.ts
// (DATA_EVENT_HANDLERS — the exact camelCase shapes the renderer consumes).
//
// PLAIN-event emit helpers for the WinSTT diarization channel. These are
// deliberately PLAIN `app.emit(name, json)` (lib_wiring §4b) rather than
// specta-typed `collect_events!` payloads so the reused renderer's listeners
// consume FIXED camelCase shapes via `onCast`/`onTyped` extractors in
// `shared/api/ipc-client.ts` unchanged, and the diarization manager stays free
// of specta derives.
//
// CALL SITE (for the compile loop — this helper is the seam, not the trigger):
//   * `emit_speaker_segments` — call from `DiarizationManager` after a diarized
//     utterance. Renderer: `onSpeakerSegments` colors the just-committed words.
//     NOTE: relay.ts dispatches `speaker_segments` strictly AFTER the matching
//     `fullSentence` so the segments land on the correct transcript item — the
//     transcription-coordinator must emit the sentence text before calling this.
//
// REMOVED (dead, no producer wired): `emit_vad_sensitivity_adapted` (its source,
// `vad_calibrator::VadCalibrator`, is implemented + tested but never instantiated
// or driven by the recorder) and `emit_device_switch_failed` (a natural producer
// exists in `managers/audio.rs`'s selected-index fallback but is unwired). See the
// removed-dead-feature follow-ups; the renderer-side hooks remain harmless no-ops.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// One diarized segment in the renderer's listen shape. The renderer's
/// `onSpeakerSegments` reads `{ start, end, speaker }`; `text` is carried for
/// parity with the per-utterance caption path but is ignored by listen mode.
#[derive(Clone, Debug, Serialize)]
pub struct EmitSpeakerSegment {
    pub speaker: i32,
    pub start: f32,
    pub end: f32,
    pub text: String,
}

/// `stt:speaker-segments` { segments: [{ start, end, speaker, text }] }.
///
/// Mirrors relay.ts's `speaker_segments` handler. MUST be emitted AFTER the
/// matching `fullSentence` so the renderer attaches the colors to the right item.
pub fn emit_speaker_segments(app: &AppHandle, segments: Vec<EmitSpeakerSegment>) {
    let _ = app.emit(
        "stt:speaker-segments",
        serde_json::json!({ "segments": segments }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speaker_segment_serializes_with_listen_keys() {
        let s = EmitSpeakerSegment {
            speaker: 1,
            start: 0.0,
            end: 1.5,
            text: "hi".into(),
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v.get("speaker").and_then(|x| x.as_i64()), Some(1));
        assert!(v.get("start").is_some());
        assert!(v.get("end").is_some());
    }
}
