use anyhow::Result;

use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;

/// Silero VAD speech threshold shared by every VAD-gated pipeline (the mic recorder
/// in `managers/audio.rs` and the listen-mode loopback consumer in
/// `winstt/managers/loopback_manager.rs`) so both gate on the SAME sensitivity. A
/// single owner avoids the two paths silently drifting apart.
pub const VAD_SPEECH_THRESHOLD: f32 = 0.3;

/// Silero analysis frame size at 16 kHz (30 ms). The Silero VAD operates on 30 ms
/// frames; capture sides emit 30 ms chunks and consumers re-frame defensively.
pub const VAD_FRAME_SAMPLES: usize = (WHISPER_SAMPLE_RATE as usize) * 30 / 1000;

pub enum VadFrame<'a> {
    /// Speech – may aggregate several frames (prefill + current + hangover)
    Speech(&'a [f32]),
    /// Non-speech (silence, noise). Down-stream code can ignore it.
    Noise,
}

impl<'a> VadFrame<'a> {
    #[inline]
    pub fn is_speech(&self) -> bool {
        matches!(self, VadFrame::Speech(_))
    }
}

/// Per-frame verdict for the LABELED capture API (`push_frame_labeled`). Unlike
/// `VadFrame` — which drops noise and aggregates pre-roll into a Speech payload — this
/// carries no samples: the caller keeps EVERY frame and only wants a per-frame speech
/// label plus how many ALREADY-appended entries to retroactively flip to speech.
///
/// `retro_frames` is non-zero ONLY on the exact frame that triggers speech onset, where
/// it equals the number of buffered pre-roll frames the smoother would have prepended.
/// Each of those pre-roll frames was already appended (labeled `false`) on an earlier
/// `push_frame_labeled` call, so the caller flips the preceding `retro_frames` mask
/// entries. Mask granularity is `VAD_FRAME_SAMPLES`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SpeechLabel {
    pub is_speech: bool,
    pub retro_frames: usize,
}

pub trait VoiceActivityDetector: Send + Sync {
    /// Primary streaming API: feed one 30-ms frame, get keep/drop decision.
    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>>;

    /// Labeled variant for capture pipelines that keep EVERY frame plus a per-frame speech
    /// mask (rather than dropping noise like `push_frame`). Must advance the SAME internal
    /// state `push_frame` would for this frame — the two APIs are alternatives, not
    /// composable. The default derives `is_speech` from `push_frame` with `retro_frames = 0`;
    /// smoothing detectors override it to report their pre-roll count on the onset frame.
    fn push_frame_labeled(&mut self, frame: &[f32]) -> Result<SpeechLabel> {
        Ok(SpeechLabel {
            is_speech: self.push_frame(frame)?.is_speech(),
            retro_frames: 0,
        })
    }

    fn is_voice(&mut self, frame: &[f32]) -> Result<bool> {
        Ok(self.push_frame(frame)?.is_speech())
    }

    fn reset(&mut self) {}
}

mod silero;
mod smoothed;

pub use silero::SileroVad;
pub use smoothed::SmoothedVad;

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal detector to exercise the DEFAULT `push_frame_labeled` impl: it derives
    /// from `push_frame` and must report `retro_frames == 0` for every frame.
    struct BoolVad(bool);
    impl VoiceActivityDetector for BoolVad {
        fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
            Ok(if self.0 {
                VadFrame::Speech(frame)
            } else {
                VadFrame::Noise
            })
        }
    }

    #[test]
    fn default_labeled_derives_from_push_frame_with_zero_retro() {
        let frame = [0.1f32; VAD_FRAME_SAMPLES];
        let mut speech = BoolVad(true);
        assert_eq!(
            speech.push_frame_labeled(&frame).unwrap(),
            SpeechLabel {
                is_speech: true,
                retro_frames: 0
            }
        );
        let mut noise = BoolVad(false);
        assert_eq!(
            noise.push_frame_labeled(&frame).unwrap(),
            SpeechLabel {
                is_speech: false,
                retro_frames: 0
            }
        );
    }
}
