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

pub trait VoiceActivityDetector: Send + Sync {
    /// Primary streaming API: feed one 30-ms frame, get keep/drop decision.
    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>>;

    fn is_voice(&mut self, frame: &[f32]) -> Result<bool> {
        Ok(self.push_frame(frame)?.is_speech())
    }

    fn reset(&mut self) {}
}

mod silero;
mod smoothed;

pub use silero::SileroVad;
pub use smoothed::SmoothedVad;
