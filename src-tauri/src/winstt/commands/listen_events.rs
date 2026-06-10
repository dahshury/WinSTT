// Reference: frontend/electron/ipc/relay.ts
// (DATA_EVENT_HANDLERS — the exact camelCase shapes the renderer consumes).
//
// PLAIN-event emit helpers for the WinSTT listen / device / diarization channels.
// These are deliberately PLAIN `app.emit(name, json)` (lib_wiring §4b) rather than
// specta-typed `collect_events!` payloads, for two reasons:
//
//   1. The renderer's listeners (`features/audio-device-feedback`,
//      `features/vad-calibration`, `features/listen-mode`, `entities/transcription`)
//      consume FIXED camelCase shapes via `onCast`/`onTyped` extractors in
//      `shared/api/ipc-client.ts`. Emitting the exact JSON here keeps the reused
//      renderer byte-identical to its the reference contract.
//   2. The producers (the VAD calibrator, the input-device switch path, the
//      diarization manager) live in pure-logic modules; routing
//      their results through these `AppHandle`-only helpers avoids leaking specta
//      derives into those modules AND avoids the wrong-shape typed
//      `events::VadSensitivityAdaptedPayload { deviceId, sensitivity }` /
//      `events::SpeakerSegmentsPayload` (which carry per-device / per-word fields
//      the renderer's *listen* listeners don't read).
//
// CALL SITES (for the compile loop — these helpers are the seam, not the trigger):
//   * `emit_vad_sensitivity_adapted` — call from wherever the VAD calibrator's
//     `Adaptation` is consumed at recording-stop (the recorder/coordinator that
//     drives `vad_calibrator::VadCalibrator`). Renderer: `onVadSensitivityAdapted`
//     (`features/vad-calibration`) persists it per-device.
//   * `emit_device_switch_failed` — call from the input-device switch path when a
//     queued `input_device_index` change can't be opened. Renderer:
//     `onDeviceSwitchFailed` (`features/audio-device-feedback`) reverts the UI
//     selection to `fallbackIndex` and toasts.
//   * `emit_speaker_segments` — call from `DiarizationManager` after a diarized
//     utterance. Renderer: `onSpeakerSegments` colors the just-committed words.
//     NOTE: relay.ts dispatches `speaker_segments` strictly AFTER the matching
//     `fullSentence` so the segments land on the correct transcript item — the
//     transcription-coordinator must emit the sentence text before calling this.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::winstt::vad_calibrator::Adaptation;

/// `stt:vad-sensitivity-adapted` { newSensitivity, noiseFloorRms, speechPeakRms }.
///
/// Byte-identical to relay.ts's `vad_sensitivity_adapted` handler. The renderer's
/// `VadSensitivityAdaptedEvent` reads `newSensitivity` (+ optional rms fields).
pub fn emit_vad_sensitivity_adapted(app: &AppHandle, adapt: &Adaptation) {
    let _ = app.emit(
        "stt:vad-sensitivity-adapted",
        serde_json::json!({
            "newSensitivity": adapt.new_sensitivity,
            "noiseFloorRms": adapt.noise_floor_rms,
            "speechPeakRms": adapt.speech_peak_rms,
        }),
    );
}

/// `stt:device-switch-failed` { requestedIndex, errorMessage, fallbackIndex }.
///
/// `fallback_index` is `None` when the server falls back to the system default
/// (the renderer maps `null` → "System default"). Mirrors relay.ts's
/// `device_switch_failed` handler exactly.
pub fn emit_device_switch_failed(
    app: &AppHandle,
    requested_index: i32,
    error_message: &str,
    fallback_index: Option<i32>,
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
