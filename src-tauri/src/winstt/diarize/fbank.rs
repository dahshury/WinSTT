// Kaldi-compatible 80-dim log-mel fbank for the WeSpeaker speaker embedder — Rust
// port of `examples/diarization-playground/js/dsp/fbank.js` (validated there against
// the committed python `kaldi_native_fbank` reference dump, MAD ≈ 1.1e-3).
//
// Configuration (playground recon, NOT the generic sherpa defaults):
//   * snip_edges = TRUE  — frame t starts exactly at t*160; no centering/reflection;
//     num_frames = floor((n - 400)/160) + 1.
//   * kaldi mel scale (1127·ln(1+f/700)) over [20 Hz, 8000 Hz] (Nyquist, not 7600).
//   * povey window (hann^0.85), per-frame DC removal, pre-emphasis 0.97
//     (frame[0] pre-emphasized against itself), zero-pad 400 → 512, power spectrum.
//   * log floor 1.1920929e-7 (f32::EPSILON), i.e. log(max(mel, EPS)).
//
// This is intentionally SEPARATE from `stt::families::frontend::compute_kaldi_fbank`
// (symmetric-padded snip_edges=false, f_max 7600) — each validated pipeline keeps the
// exact DSP it was validated with. NO CMN here; the cascade applies per-utterance CMN
// over the pooled span (WeSpeaker ships `feature_normalize_type = "global-mean"`).

use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

pub const SAMPLE_RATE: usize = 16_000;
pub const FEAT_DIM: usize = 80;
pub const FRAME_LENGTH: usize = 400; // 25 ms
pub const FRAME_SHIFT: usize = 160; // 10 ms
const N_FFT: usize = 512;
const N_FFT_BINS: usize = N_FFT / 2 + 1; // 257
const PREEMPH: f32 = 0.97;
const LOW_FREQ: f32 = 20.0;
const HIGH_FREQ: f32 = 8000.0;
const LOG_FLOOR: f32 = f32::EPSILON; // 1.1920929e-7

#[inline]
fn hz_to_mel(f: f32) -> f32 {
    1127.0 * (1.0 + f / 700.0).ln()
}

/// One triangular mel filter's non-zero support: fft-bin range + weights.
struct MelFilter {
    start: usize,
    weights: Vec<f32>,
}

fn build_povey_window() -> Vec<f32> {
    (0..FRAME_LENGTH)
        .map(|n| {
            let hann = 0.5
                - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / (FRAME_LENGTH as f32 - 1.0)).cos();
            hann.powf(0.85)
        })
        .collect()
}

/// 80 kaldi-mel triangular filters over [20, 8000] Hz; 82 equally-spaced mel edges,
/// filter m spans edges [m, m+2] with peak at m+1. Bin center freq = k·16000/512.
fn build_mel_bank() -> Vec<MelFilter> {
    let mel_low = hz_to_mel(LOW_FREQ);
    let mel_high = hz_to_mel(HIGH_FREQ);
    let num_edges = FEAT_DIM + 2; // 82
    let mel_step = (mel_high - mel_low) / (num_edges - 1) as f32;
    let edges: Vec<f32> = (0..num_edges)
        .map(|i| mel_low + i as f32 * mel_step)
        .collect();

    let bin_mel: Vec<f32> = (0..N_FFT_BINS)
        .map(|k| hz_to_mel(k as f32 * SAMPLE_RATE as f32 / N_FFT as f32))
        .collect();

    (0..FEAT_DIM)
        .map(|m| {
            let left = edges[m];
            let center = edges[m + 1];
            let right = edges[m + 2];
            let mut start = usize::MAX;
            let mut weights = Vec::new();
            for (k, &mel) in bin_mel.iter().enumerate() {
                let w = if mel > left && mel < right {
                    if mel <= center {
                        (mel - left) / (center - left)
                    } else {
                        (right - mel) / (right - center)
                    }
                } else {
                    0.0
                };
                if w > 0.0 {
                    if start == usize::MAX {
                        start = k;
                    }
                    weights.push(w);
                } else if start != usize::MAX {
                    break; // past the triangle's support
                }
            }
            MelFilter {
                start: if start == usize::MAX { 0 } else { start },
                weights,
            }
        })
        .collect()
}

/// Fbank extractor with precomputed window/filterbank/FFT plan and reusable scratch.
pub struct Fbank {
    window: Vec<f32>,
    mel_bank: Vec<MelFilter>,
    fft: Arc<dyn Fft<f32>>,
    scratch_frame: Vec<f32>,
    scratch_fft: Vec<Complex32>,
    scratch_power: Vec<f32>,
}

impl Fbank {
    pub fn new() -> Self {
        let mut planner = FftPlanner::<f32>::new();
        Self {
            window: build_povey_window(),
            mel_bank: build_mel_bank(),
            fft: planner.plan_fft_forward(N_FFT),
            scratch_frame: vec![0.0; FRAME_LENGTH],
            scratch_fft: vec![Complex32::default(); N_FFT],
            scratch_power: vec![0.0; N_FFT_BINS],
        }
    }

    /// snip_edges=true frame count for a sample count.
    pub fn num_frames(num_samples: usize) -> usize {
        if num_samples < FRAME_LENGTH {
            0
        } else {
            (num_samples - FRAME_LENGTH) / FRAME_SHIFT + 1
        }
    }

    /// Full feature matrix for `pcm` ([-1,1] f32 @ 16 kHz), row-major `(num_frames * 80)`.
    pub fn compute(&mut self, pcm: &[f32]) -> Vec<f32> {
        let num_frames = Self::num_frames(pcm.len());
        let mut out = vec![0.0f32; num_frames * FEAT_DIM];
        for t in 0..num_frames {
            let start = t * FRAME_SHIFT;
            let frame = &mut self.scratch_frame;

            // 1. Load + DC removal (subtract the frame's own mean).
            let mut mean = 0.0f32;
            for i in 0..FRAME_LENGTH {
                let v = pcm[start + i];
                frame[i] = v;
                mean += v;
            }
            mean /= FRAME_LENGTH as f32;
            for v in frame.iter_mut() {
                *v -= mean;
            }

            // 2. Pre-emphasis, high-to-low so frame[i-1] is still the original value;
            //    kaldi pre-emphasizes sample 0 against itself.
            for i in (1..FRAME_LENGTH).rev() {
                frame[i] -= PREEMPH * frame[i - 1];
            }
            frame[0] -= PREEMPH * frame[0];

            // 3. Povey window + zero-pad to 512 → FFT → power spectrum.
            for (i, c) in self.scratch_fft.iter_mut().enumerate() {
                *c = if i < FRAME_LENGTH {
                    Complex32::new(frame[i] * self.window[i], 0.0)
                } else {
                    Complex32::default()
                };
            }
            self.fft.process(&mut self.scratch_fft);
            for (k, p) in self.scratch_power.iter_mut().enumerate() {
                let c = self.scratch_fft[k];
                *p = c.re * c.re + c.im * c.im;
            }

            // 4. Mel filterbank + log with floor.
            let base = t * FEAT_DIM;
            for (m, filt) in self.mel_bank.iter().enumerate() {
                let mut energy = 0.0f32;
                for (j, &w) in filt.weights.iter().enumerate() {
                    energy += w * self.scratch_power[filt.start + j];
                }
                out[base + m] = energy.max(LOG_FLOOR).ln();
            }
        }
        out
    }
}

impl Default for Fbank {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-utterance CMN: subtract each dim's time-mean across the given frame span,
/// in place on a `(num_frames * 80)` row-major buffer. Applied by the cascade only
/// for WeSpeaker (`feature_normalize_type = "global-mean"`).
pub fn apply_cmn(feats: &mut [f32], num_frames: usize) {
    if num_frames == 0 {
        return;
    }
    let mut means = [0.0f64; FEAT_DIM];
    for t in 0..num_frames {
        let base = t * FEAT_DIM;
        for (d, m) in means.iter_mut().enumerate() {
            *m += f64::from(feats[base + d]);
        }
    }
    for m in means.iter_mut() {
        *m /= num_frames as f64;
    }
    for t in 0..num_frames {
        let base = t * FEAT_DIM;
        for (d, m) in means.iter().enumerate() {
            feats[base + d] -= *m as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn frame_count_matches_snip_edges_true() {
        assert_eq!(Fbank::num_frames(0), 0);
        assert_eq!(Fbank::num_frames(399), 0);
        assert_eq!(Fbank::num_frames(400), 1);
        assert_eq!(Fbank::num_frames(64_000), 398); // the reference [5,9]s slice
    }

    #[test]
    fn cmn_zeroes_column_means() {
        let mut feats = vec![0.0f32; 3 * FEAT_DIM];
        for t in 0..3 {
            for d in 0..FEAT_DIM {
                feats[t * FEAT_DIM + d] = (t as f32) + (d as f32) * 0.5;
            }
        }
        apply_cmn(&mut feats, 3);
        for d in 0..FEAT_DIM {
            let mean: f32 = (0..3).map(|t| feats[t * FEAT_DIM + d]).sum::<f32>() / 3.0;
            assert!(mean.abs() < 1e-4, "dim {d} mean {mean}");
        }
    }

    /// Compare against the playground's committed python `kaldi_native_fbank`
    /// reference dump: [5,9] s slice of test-2spk.wav, CMN over the slice, first
    /// 20 frames, MAD < 2e-2 (SPEC §10.1). Skips silently when the example assets
    /// are absent (e.g. a source distribution without examples/).
    #[test]
    fn fbank_matches_playground_reference() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../examples/diarization-playground/assets");
        let wav_path = root.join("test-2spk.wav");
        let ref_path = root.join("reference/fbank_test.json");
        if !wav_path.exists() || !ref_path.exists() {
            eprintln!("skipping: playground reference assets not present");
            return;
        }

        let mut reader = hound::WavReader::open(&wav_path).expect("open wav");
        let spec = reader.spec();
        assert_eq!(spec.sample_rate, 16_000, "reference wav must be 16 kHz");
        assert_eq!(spec.channels, 1, "reference wav must be mono");
        let pcm: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Int => reader
                .samples::<i16>()
                .map(|s| s.expect("sample") as f32 / 32768.0)
                .collect(),
            hound::SampleFormat::Float => reader
                .samples::<f32>()
                .map(|s| s.expect("sample"))
                .collect(),
        };

        let a = 5 * 16_000;
        let b = 9 * 16_000;
        let slice = &pcm[a..b];

        let reference: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&ref_path).expect("read ref"))
                .expect("parse ref");
        let ref_frames = reference["frames"].as_u64().expect("frames") as usize;
        let ref_dim = reference["dim"].as_u64().expect("dim") as usize;
        let ref_rows = reference["data"].as_array().expect("data");

        let mut fbank = Fbank::new();
        let mut feats = fbank.compute(slice);
        let num_frames = Fbank::num_frames(slice.len());
        assert_eq!(num_frames, ref_frames, "frame count mismatch");
        assert_eq!(FEAT_DIM, ref_dim, "feat dim mismatch");

        // The dump is CMN-normalized over the whole slice (mean_normalized: true).
        apply_cmn(&mut feats, num_frames);

        let mut abs_sum = 0.0f64;
        let mut count = 0usize;
        for (r, row) in ref_rows.iter().enumerate() {
            let row = row.as_array().expect("row");
            for (d, v) in row.iter().enumerate() {
                let expected = v.as_f64().expect("val");
                let got = f64::from(feats[r * FEAT_DIM + d]);
                abs_sum += (got - expected).abs();
                count += 1;
            }
        }
        let mad = abs_sum / count as f64;
        assert!(mad < 2e-2, "fbank MAD {mad:.4e} >= 2e-2");
    }
}
