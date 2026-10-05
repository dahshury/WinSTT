//! Silero VAD v6 (snakers4/silero-vad v6.2, MIT) driven directly on ONNX Runtime.
//!
//! v5+ models differ from the v4 graph this replaced: a single `state` tensor `[2, 1, 128]`
//! instead of separate LSTM `h`/`c`, a FIXED 512-sample window at 16 kHz, and the previous
//! window's last 64 samples prepended as context (`input` is `[1, 64 + 512]`). The app's
//! capture/segmentation pipelines frame audio in 30 ms (480-sample) steps, so this wrapper
//! accumulates frames and runs the model on every completed 512-sample window, reporting the
//! most recent window's probability for each pushed frame. That lags the 30 ms frame grid by at
//! most one window (32 ms), which the smoothing pre-roll and the segmentation silence padding
//! both absorb.
//!
//! v6.2 also has an absolute LEVEL floor that v4/v5/v6.0 did not: speech below roughly
//! -40 dBFS (a laptop mic across the room, a low-gain headset) scores near zero no matter how
//! clean it is — in the 2026-10 benchmark whole far-field sessions at -45 dBFS dropped to 12-18%
//! recall. So the model input (ONLY the copy fed to the model, never the captured audio) goes
//! through a peak-hold AGC that lifts quiet input toward [`AGC_TARGET_PEAK`] by at most
//! [`AGC_MAX_GAIN`] and never attenuates. That restored far-field recall to ~0.99 while keeping
//! v6.2's low false-trigger rate on noise, music and room tone (see `agc_gain`).

use anyhow::{Context, Result};
use std::path::Path;

use ort::session::{Session, builder::GraphOptimizationLevel};
use ort::value::TensorRef;

use super::{VAD_FRAME_SAMPLES, VadFrame, VoiceActivityDetector};
use crate::audio_toolkit::constants;

/// Model window at 16 kHz (fixed by the v5+ graph).
const WINDOW: usize = 512;
/// Trailing samples of the previous window prepended to each inference.
const CONTEXT: usize = 64;
/// `state` / `stateN` element count: `[2, 1, 128]`.
const STATE_LEN: usize = 2 * 128;

/// AGC target for the window peak envelope (-12 dBFS). Normal close-talk speech already peaks
/// above this, so its gain stays 1.0 and the model sees the raw signal.
const AGC_TARGET_PEAK: f32 = 0.25;
/// AGC ceiling (+24 dB): enough to lift -45 dBFS far-field speech over v6.2's level floor while
/// keeping a -60 dBFS room tone well below it.
const AGC_MAX_GAIN: f32 = 16.0;
/// Per-window decay of the peak-hold envelope: a 2 s half-life (0.5^(32 ms / 2 s)), so the gain
/// recovers slowly after loud speech instead of pumping between words.
const AGC_ENVELOPE_DECAY: f32 = 0.988_970_9;

/// Gain for the current peak envelope: lift toward `AGC_TARGET_PEAK`, never attenuate, cap at
/// `AGC_MAX_GAIN` (digital silence gets the cap, harmlessly).
fn agc_gain(envelope: f32) -> f32 {
    if envelope > 0.0 {
        (AGC_TARGET_PEAK / envelope).clamp(1.0, AGC_MAX_GAIN)
    } else {
        AGC_MAX_GAIN
    }
}

pub struct SileroVad {
    session: Session,
    /// Whether the graph takes the `sr` input (the dual-rate export does; 16 kHz-only ones don't).
    takes_sr: bool,
    threshold: f32,
    state: Vec<f32>,
    /// `[context | window]` scratch fed to the model; the first `CONTEXT` samples carry over.
    input: Vec<f32>,
    /// Samples received but not yet part of a completed window.
    pending: Vec<f32>,
    /// Probability of the most recent completed window (reported until the next one completes).
    last_prob: f32,
    /// Peak-hold envelope driving the input AGC (see module docs).
    envelope: f32,
}

impl SileroVad {
    pub fn new<P: AsRef<Path>>(model_path: P, threshold: f32) -> Result<Self> {
        if !(0.0..=1.0).contains(&threshold) {
            anyhow::bail!("threshold must be between 0.0 and 1.0");
        }
        let path = model_path.as_ref();
        // CPU only, single-threaded: the model is ~0.3M params and runs once per 32 ms, so a
        // thread pool only adds wake-up overhead (and the CUDA EP deadlocks; see settings schema).
        let build = || -> ort::Result<Session> {
            Session::builder()?
                .with_optimization_level(GraphOptimizationLevel::Level3)?
                .with_intra_threads(1)?
                .with_inter_threads(1)?
                .commit_from_file(path)
        };
        let session = build().map_err(|e| {
            anyhow::anyhow!("Failed to create VAD session ({}): {e}", path.display())
        })?;
        let names: Vec<String> = session
            .inputs()
            .iter()
            .map(|i| i.name().to_string())
            .collect();
        if !names.iter().any(|n| n == "state") {
            anyhow::bail!(
                "{} is not a Silero VAD v5+ model (inputs: {names:?})",
                path.display()
            );
        }
        let takes_sr = names.iter().any(|n| n == "sr");

        Ok(Self {
            session,
            takes_sr,
            threshold,
            state: vec![0.0; STATE_LEN],
            input: vec![0.0; CONTEXT + WINDOW],
            pending: Vec::with_capacity(WINDOW + VAD_FRAME_SAMPLES),
            last_prob: 0.0,
            envelope: 0.0,
        })
    }

    /// Clear the recurrent state, context and partial window so a CACHED instance can be reused
    /// across recordings without carrying speech context from the previous one — reusing a warm
    /// session skips the per-decode ONNX session rebuild for long-form segmentation.
    pub fn reset(&mut self) {
        self.state.fill(0.0);
        self.input.fill(0.0);
        self.pending.clear();
        self.last_prob = 0.0;
        self.envelope = 0.0;
    }

    /// Update the probability threshold without rebuilding the ONNX session.
    /// Settings hot-swap this value while the recorder is open.
    pub fn set_threshold(&mut self, threshold: f32) {
        self.threshold = threshold.clamp(0.0, 1.0);
    }

    /// Feed any number of 16 kHz samples and return the speech probability of the most recent
    /// completed 512-sample window (0.0 before the first window completes).
    pub fn speech_prob(&mut self, samples: &[f32]) -> Result<f32> {
        self.pending.extend_from_slice(samples);
        let mut consumed = 0;
        while self.pending.len() - consumed >= WINDOW {
            let window = &self.pending[consumed..consumed + WINDOW];
            let peak = window.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            self.envelope = peak.max(self.envelope * AGC_ENVELOPE_DECAY);
            let gain = agc_gain(self.envelope);
            for (dst, &src) in self.input[CONTEXT..].iter_mut().zip(window) {
                *dst = (src * gain).clamp(-1.0, 1.0);
            }
            self.last_prob = self.infer()?;
            // The window's tail becomes the next inference's context.
            self.input.copy_within(WINDOW.., 0);
            consumed += WINDOW;
        }
        self.pending.drain(..consumed);
        Ok(self.last_prob)
    }

    fn infer(&mut self) -> Result<f32> {
        let input = TensorRef::from_array_view(([1usize, CONTEXT + WINDOW], &self.input[..]))?;
        let state = TensorRef::from_array_view(([2usize, 1, 128], &self.state[..]))?;
        let sr = [constants::WHISPER_SAMPLE_RATE as i64];
        let outputs = if self.takes_sr {
            let sr = TensorRef::from_array_view(((), &sr[..]))?;
            self.session
                .run(ort::inputs!["input" => input, "state" => state, "sr" => sr])
        } else {
            self.session
                .run(ort::inputs!["input" => input, "state" => state])
        }
        .context("Silero VAD inference")?;

        let (_, state_n) = outputs["stateN"].try_extract_tensor::<f32>()?;
        if state_n.len() != STATE_LEN {
            anyhow::bail!("unexpected Silero stateN length {}", state_n.len());
        }
        self.state.copy_from_slice(state_n);
        let (_, prob) = outputs["output"].try_extract_tensor::<f32>()?;
        prob.first()
            .copied()
            .context("Silero VAD returned an empty output")
    }
}

impl VoiceActivityDetector for SileroVad {
    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
        if frame.len() != VAD_FRAME_SAMPLES {
            anyhow::bail!("expected {VAD_FRAME_SAMPLES} samples, got {}", frame.len());
        }

        if self.speech_prob(frame)? > self.threshold {
            Ok(VadFrame::Speech(frame))
        } else {
            Ok(VadFrame::Noise)
        }
    }

    fn reset(&mut self) {
        SileroVad::reset(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agc_lifts_quiet_input_but_never_attenuates() {
        // Loud speech (peaks at/above target): untouched.
        assert_eq!(agc_gain(0.9), 1.0);
        assert_eq!(agc_gain(AGC_TARGET_PEAK), 1.0);
        // -45 dBFS-ish far-field speech (peak ~0.02): lifted toward the target.
        let g = agc_gain(0.02);
        assert!((g - AGC_TARGET_PEAK / 0.02).abs() < 1e-4 && g <= AGC_MAX_GAIN);
        // Room tone / digital silence: capped.
        assert_eq!(agc_gain(1e-4), AGC_MAX_GAIN);
        assert_eq!(agc_gain(0.0), AGC_MAX_GAIN);
    }

    #[test]
    fn agc_envelope_decay_is_a_two_second_half_life() {
        let windows_per_2s = 2.0 * constants::WHISPER_SAMPLE_RATE as f32 / WINDOW as f32;
        assert!((AGC_ENVELOPE_DECAY.powf(windows_per_2s) - 0.5).abs() < 1e-3);
    }
}
