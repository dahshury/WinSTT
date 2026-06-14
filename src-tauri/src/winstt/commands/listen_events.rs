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
//   * `emit_device_switch_failed` — call from `managers/audio.rs`'s selected-index
//     fallback when the user's `input_device_index` can't be resolved to a live
//     cpal device. Renderer: `onDeviceSwitchFailed` reverts the UI selection to
//     `fallbackIndex` (null → "System default"), persists it immediately, refreshes
//     the device list, and surfaces a translated toast.
//
// REMOVED (dead end-to-end): the cross-utterance adaptive `vad_sensitivity_adapted`
// path. Its backend `VadCalibrator` was implemented + tested but never instantiated
// or driven by the recorder, and there is no live-VAD sensitivity setter to drive,
// so the whole module + the renderer listener + the `stt:vad-sensitivity-adapted`
// route were deleted. Per-device sensitivity seeding on device switch survives
// renderer-side (`useVadCalibration`).

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

/// `stt:device-switch-failed` { requestedIndex, errorMessage, fallbackIndex }.
///
/// Emitted when a selected `input_device_index` can't be resolved to a live cpal
/// device and the recorder falls back to the OS default input. The renderer's
/// `onDeviceSwitchFailed` reverts the UI selection to `fallback_index`, persists it
/// immediately (bypassing the settings debounce), refreshes the device list, and
/// surfaces a translated toast.
///
/// `fallback_index` is `None` (→ renderer "System default") at the only producer:
/// the fallback re-resolves the OS default on every stream open rather than pinning
/// a concrete index, so reporting null keeps the persisted selection honest as
/// auto-route. The parameter stays generic so a future concrete-index producer can
/// report one without touching the renderer contract.
pub fn emit_device_switch_failed(
    app: &AppHandle,
    requested_index: i64,
    error_message: &str,
    fallback_index: Option<i64>,
) {
    let _ = app.emit(
        "stt:device-switch-failed",
        serde_json::json!({
            "requestedIndex": requested_index,
            "errorMessage": error_message,
            "fallbackIndex": fallback_index,
        }),
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
