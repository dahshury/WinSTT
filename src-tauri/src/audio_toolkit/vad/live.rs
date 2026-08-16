use anyhow::Result;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering},
};

use super::{SileroVad, VadFrame, VoiceActivityDetector};

const DEFAULT_SENSITIVITY: f64 = 0.7;
const DEFAULT_WEBRTC_SENSITIVITY: i64 = 3;

/// Hot-swappable VAD controls shared by the settings command and the recorder
/// worker. Atomics keep the capture path lock-free and avoid rebuilding Silero's
/// ONNX session for a slider change.
#[derive(Debug)]
pub struct VadRuntimeConfig {
    silero_enabled: AtomicBool,
    silero_threshold_bits: AtomicU32,
    webrtc_sensitivity: AtomicU8,
}

impl VadRuntimeConfig {
    pub fn new(silero_enabled: bool, sensitivity: f64, webrtc_sensitivity: i64) -> Self {
        let config = Self {
            silero_enabled: AtomicBool::new(silero_enabled),
            silero_threshold_bits: AtomicU32::new(0),
            webrtc_sensitivity: AtomicU8::new(0),
        };
        config.update(silero_enabled, sensitivity, webrtc_sensitivity);
        config
    }

    pub fn update(&self, silero_enabled: bool, sensitivity: f64, webrtc_sensitivity: i64) {
        let sensitivity = if sensitivity.is_finite() {
            sensitivity
        } else {
            DEFAULT_SENSITIVITY
        }
        .clamp(0.0, 1.0);
        self.silero_enabled.store(silero_enabled, Ordering::Relaxed);
        self.silero_threshold_bits
            .store((1.0 - sensitivity as f32).to_bits(), Ordering::Relaxed);
        self.webrtc_sensitivity.store(
            webrtc_sensitivity.clamp(0, DEFAULT_WEBRTC_SENSITIVITY) as u8,
            Ordering::Relaxed,
        );
    }

    fn snapshot(&self) -> (bool, f32, u8) {
        (
            self.silero_enabled.load(Ordering::Relaxed),
            f32::from_bits(self.silero_threshold_bits.load(Ordering::Relaxed)),
            self.webrtc_sensitivity.load(Ordering::Relaxed),
        )
    }
}

/// A live-configurable detector. The WebRTC sensitivity control is applied as
/// a cheap DC-immune energy pre-gate before Silero; disabling Silero leaves that
/// fast gate active, so endpointing remains usable instead of treating every
/// frame as speech.
pub struct LiveVad {
    silero: SileroVad,
    config: Arc<VadRuntimeConfig>,
}

impl LiveVad {
    pub fn new(silero: SileroVad, config: Arc<VadRuntimeConfig>) -> Self {
        Self { silero, config }
    }
}

fn frame_ac_energy(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let n = frame.len() as f32;
    let mean = frame.iter().copied().sum::<f32>() / n;
    (frame
        .iter()
        .map(|&sample| {
            let centered = sample - mean;
            centered * centered
        })
        .sum::<f32>()
        / n)
        .sqrt()
}

fn energy_floor(sensitivity: u8) -> f32 {
    // Mirrors WebRTC VAD's four aggressiveness levels: larger values reject
    // progressively more low-energy room noise.
    const FLOORS: [f32; 4] = [0.0002, 0.0005, 0.001, 0.002];
    FLOORS[usize::from(sensitivity.min(3))]
}

impl VoiceActivityDetector for LiveVad {
    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
        let (silero_enabled, threshold, webrtc_sensitivity) = self.config.snapshot();
        if frame_ac_energy(frame) < energy_floor(webrtc_sensitivity) {
            return Ok(VadFrame::Noise);
        }
        if !silero_enabled {
            return Ok(VadFrame::Speech(frame));
        }
        self.silero.set_threshold(threshold);
        self.silero.push_frame(frame)
    }

    fn reset(&mut self) {
        self.silero.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_config_clamps_and_converts_sensitivity() {
        let config = VadRuntimeConfig::new(true, 2.0, 9);
        assert_eq!(config.snapshot(), (true, 0.0, 3));
        config.update(false, f64::NAN, -3);
        let (enabled, threshold, aggressiveness) = config.snapshot();
        assert!(!enabled);
        assert!((threshold - 0.3).abs() < f32::EPSILON);
        assert_eq!(aggressiveness, 0);
    }

    #[test]
    fn aggressiveness_raises_energy_floor() {
        assert!(energy_floor(0) < energy_floor(1));
        assert!(energy_floor(1) < energy_floor(2));
        assert!(energy_floor(2) < energy_floor(3));
    }
}
