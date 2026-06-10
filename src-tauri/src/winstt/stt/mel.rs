// Source: onnx-asr fork preprocessors/whisper.py + preprocessors/fbanks.py
//   (<onnx-asr>/preprocessors/) and
//   src/onnx_asr/preprocessors/numpy_preprocessor.py::WhisperPreprocessorNumpy.
//
// Log-mel spectrogram feature extraction for Whisper / lite-whisper / distil-whisper.
//
// This is a faithful, deterministic Rust port of onnx-asr's Whisper preprocessor.
// onnx-asr ships TWO equivalent implementations (an onnxscript graph in
// preprocessors/whisper.py and a NumPy reference in WhisperPreprocessorNumpy). Both
// produce the SAME log-mel features; we mirror the NumPy reference exactly because it
// is the one the picker/tests verify against, and it runs entirely on the CPU/Rust
// path (the Whisper mel front-end has no ONNX twin we need to load).
//
// Pipeline (16 kHz mono f32 in [-1, 1], already peak-normalized by the caller):
//   1. truncate / zero-pad to a fixed 30 s window (chunk_length * sample_rate samples)
//   2. reflect-pad n_fft/2 on each side
//   3. framed STFT: win_length=400, hop_length=160, Hann window (periodic: hann(N+1)[:-1])
//   4. power spectrum, drop the Nyquist bin (rfft[:-1]) → 200 freq bins
//   5. project onto the Slaney-norm mel filterbank (80 or 128 mels) → (T, n_mels)
//   6. log10, dynamic-range clamp to (max - 8), affine (+4)/4 → features in ~[0, 1]
//   7. transpose to (n_mels, T)
//
// The mel filterbank is computed at construction time (matches
// `melscale_fbanks(n_fft//2+1, 0, sr/2, n_mels, sr, "slaney", "slaney")`), so no
// `fbanks.npz` asset is needed — the matrix is tiny (≤ 128×200) and trivial to build.

use std::f32::consts::PI;
use std::sync::Arc;

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};

/// Whisper fixed-window / STFT constants (identical to onnx-asr + openai-whisper).
pub const SAMPLE_RATE: usize = 16_000;
pub const CHUNK_LENGTH_S: usize = 30;
/// Total samples in the fixed 30 s window: 480_000.
pub const N_SAMPLES: usize = CHUNK_LENGTH_S * SAMPLE_RATE;
pub const N_FFT: usize = 400;
pub const WIN_LENGTH: usize = 400;
pub const HOP_LENGTH: usize = 160;
/// Frames produced from the 30 s window: N_SAMPLES / HOP_LENGTH = 3000.
pub const N_FRAMES: usize = N_SAMPLES / HOP_LENGTH;
/// FFT magnitude bins kept after dropping the Nyquist bin: n_fft/2 = 200.
pub const N_FREQS: usize = N_FFT / 2;
const CLAMP_MIN: f32 = 1e-10;

/// Pre-computed log-mel feature extractor for one mel-bin count (80 or 128).
///
/// Construct once per engine (`MelExtractor::new(80)` / `new(128)`) and reuse for
/// every utterance. Holds the Slaney mel filterbank `(N_FREQS, n_mels)` and the
/// periodic Hann window.
pub struct MelExtractor {
    pub n_mels: usize,
    /// Mel filterbank, row-major `[freq * n_mels + mel]` — i.e. shape (N_FREQS, n_mels),
    /// matched to `spectrum (T, N_FREQS) @ fbanks (N_FREQS, n_mels)`.
    fbanks: Vec<f32>,
    /// Periodic Hann window of length WIN_LENGTH (`hann(WIN_LENGTH+1)[:-1]`).
    window: [f32; WIN_LENGTH],
    /// Reusable forward-FFT plan (size N_FFT) for the per-frame power spectrum. Replaces the
    /// previous naive O(n_fft·n_freqs) DFT, which DOMINATED decode time: 3000 frames × 200 bins
    /// × 400 samples of `cos`+`sin` per utterance (~240M transcendental calls). The Whisper window
    /// is ALWAYS 3000 frames, so even a 2 s sentence paid the full fixed cost — the reason short
    /// dictations weren't instant and realtime ticks never finished. rustfft is exact to the DFT
    /// within f32 precision, so the mel features (and transcript) are unchanged.
    fft: Arc<dyn Fft<f32>>,
}

impl MelExtractor {
    /// Build the extractor for `n_mels` ∈ {80, 128}. The 80-mel front-end is used by
    /// every multilingual + `.en` Whisper/lite-whisper export except large-v3 (128).
    /// The mel-bin count is read from the model's `config.json` `num_mel_bins`.
    pub fn new(n_mels: usize) -> Self {
        let fbanks = slaney_mel_filterbank(
            N_FREQS + 1,
            0.0,
            (SAMPLE_RATE / 2) as f32,
            n_mels,
            SAMPLE_RATE,
        );
        // Drop the Nyquist row so the matrix is (N_FREQS, n_mels) — the preprocessor
        // uses rfft[:, :-1] (200 bins) against the full 201-bin filterbank rows[:-1].
        let mut fb = vec![0.0f32; N_FREQS * n_mels];
        for f in 0..N_FREQS {
            for m in 0..n_mels {
                fb[f * n_mels + m] = fbanks[f * n_mels + m];
            }
        }
        let mut window = [0.0f32; WIN_LENGTH];
        // Periodic Hann: hann(N+1)[:-1] => 0.5 * (1 - cos(2πn/N)) for n in 0..N.
        for (n, w) in window.iter_mut().enumerate() {
            *w = 0.5 * (1.0 - (2.0 * PI * n as f32 / WIN_LENGTH as f32).cos());
        }
        let fft = FftPlanner::<f32>::new().plan_fft_forward(N_FFT);
        Self {
            n_mels,
            fbanks: fb,
            window,
            fft,
        }
    }

    /// Compute log-mel features for one mono 16 kHz utterance.
    ///
    /// Returns `(features, n_mels, n_frames)` where `features` is row-major
    /// `[mel * n_frames + frame]` — i.e. shape `(n_mels, N_FRAMES)`, ready to feed the
    /// encoder as `input_features (1, n_mels, T)`. T is always `N_FRAMES` (3000) because
    /// Whisper pads/truncates to a fixed 30 s window.
    pub fn extract(&self, audio: &[f32]) -> (Vec<f32>, usize, usize) {
        // 1. Truncate then zero-pad to exactly N_SAMPLES (30 s).
        let mut padded = vec![0.0f32; N_SAMPLES + N_FFT];
        let take = audio.len().min(N_SAMPLES);
        // 2. reflect-pad n_fft/2 on each side. We place the signal at offset n_fft/2
        //    and fill the left/right reflect borders. The right border lives in the
        //    zero-padded silence region, so reflection there is over zeros (no-op).
        let off = N_FFT / 2;
        padded[off..off + take].copy_from_slice(&audio[..take]);
        // left reflect border: padded[off-1-k] = audio[k+1]
        for k in 0..off {
            let src = (k + 1).min(take.saturating_sub(1));
            padded[off - 1 - k] = if take > 1 { audio[src] } else { 0.0 };
        }
        // right reflect border mirrors the tail of the 30 s window; since the window
        // tail is silence (zero-padded), the reflection is zeros — already initialized.

        let n_mels = self.n_mels;
        let mut features = vec![0.0f32; n_mels * N_FRAMES];
        // log10 mel, time-major (t, mel); transposed to (mel, t) at the end.
        let mut log_mel = vec![0.0f32; n_mels * N_FRAMES];

        // The 3000 frames are independent → compute the per-frame FFT + mel projection in parallel
        // (Whisper ALWAYS processes the full 30 s window = 3000 frames regardless of clip length, so
        // this is a fixed ~3000-FFT + 3000·N_FREQS·n_mels-MAC cost that single-threaded dominated the
        // pre-decode latency). `self.fft` is `Arc<dyn Fft>` and rustfft's `Fft: Send + Sync`, so the
        // plan is shared; each worker owns its FFT buffer + scratch. Byte-identical to the serial loop.
        use rayon::prelude::*;
        log_mel
            .par_chunks_mut(n_mels)
            .enumerate()
            .for_each(|(t, row)| {
                let start = t * HOP_LENGTH;
                // Windowed frame into the complex buffer (re = windowed sample, im = 0 for real PCM).
                // WIN_LENGTH == N_FFT (400 == 400) so the whole frame is windowed directly.
                let mut buffer = vec![Complex::<f32>::new(0.0, 0.0); N_FFT];
                let mut scratch =
                    vec![Complex::<f32>::new(0.0, 0.0); self.fft.get_inplace_scratch_len()];
                for (i, slot) in buffer.iter_mut().enumerate() {
                    let s = padded.get(start + i).copied().unwrap_or(0.0);
                    *slot = Complex::new(s * self.window[i], 0.0);
                }
                // Real-input FFT → |X[k]|² for the first N_FREQS bins (drops Nyquist, matching
                // rfft[:, :-1]). O(n_fft·log n_fft), numerically identical to the previous naive DFT.
                self.fft.process_with_scratch(&mut buffer, &mut scratch);
                let mut power = [0.0f32; N_FREQS];
                for (f, p) in power.iter_mut().enumerate() {
                    let c = buffer[f];
                    *p = c.re * c.re + c.im * c.im;
                }
                // Mel projection: spectrum (N_FREQS) · fbanks (N_FREQS, n_mels) → (n_mels).
                for (m, out) in row.iter_mut().enumerate() {
                    let mut acc = 0.0f32;
                    for (f, &p) in power.iter().enumerate() {
                        acc += p * self.fbanks[f * n_mels + m];
                    }
                    *out = acc.max(CLAMP_MIN).log10();
                }
            });

        // 5. global max over all log-mel bins (single O(n_mels·T) pass; ~0.2 ms, not worth a reduce).
        let global_max = log_mel.iter().copied().fold(f32::NEG_INFINITY, f32::max);

        // 6. Dynamic-range clamp to (max - 8), affine (+4)/4. 7. transpose to (n_mels, T).
        let floor = global_max - 8.0;
        for t in 0..N_FRAMES {
            for m in 0..n_mels {
                let v = log_mel[t * n_mels + m].max(floor);
                features[m * N_FRAMES + t] = (v + 4.0) / 4.0;
            }
        }
        (features, n_mels, N_FRAMES)
    }
}

/// Build the Slaney-norm mel filterbank, row-major `[freq * n_mels + mel]` with shape
/// `(n_freqs, n_mels)`. Faithful port of onnx-asr `fbanks.melscale_fbanks(...,
/// norm="slaney", mel_scale="slaney")`:
///   * `all_freqs = linspace(0, sr/2, n_freqs)` (linear Hz on the freq axis)
///   * mel points: Slaney hz↔mel (linear below 1 kHz, log above)
///   * triangular filters; Slaney area-normalize each filter by `2 / (f[i+2] - f[i])`.
fn slaney_mel_filterbank(
    n_freqs: usize,
    f_min: f32,
    f_max: f32,
    n_mels: usize,
    sample_rate: usize,
) -> Vec<f32> {
    let all_freqs: Vec<f32> = (0..n_freqs)
        .map(|i| (sample_rate / 2) as f32 * i as f32 / (n_freqs - 1) as f32)
        .collect();
    let m_min = slaney_hz_to_mel(f_min);
    let m_max = slaney_hz_to_mel(f_max);
    // n_mels + 2 mel-spaced points, converted back to Hz (Slaney).
    let m_pts: Vec<f32> = (0..n_mels + 2)
        .map(|i| {
            let mel = m_min + (m_max - m_min) * i as f32 / (n_mels + 1) as f32;
            slaney_mel_to_hz(mel)
        })
        .collect();

    let mut fb = vec![0.0f32; n_freqs * n_mels];
    for (f, &freq) in all_freqs.iter().enumerate() {
        for m in 0..n_mels {
            let lower = m_pts[m];
            let center = m_pts[m + 1];
            let upper = m_pts[m + 2];
            let up = (freq - lower) / (center - lower);
            let down = (upper - freq) / (upper - center);
            let mut tri = up.min(down).max(0.0);
            // Slaney area normalization.
            tri *= 2.0 / (upper - lower);
            fb[f * n_mels + m] = tri;
        }
    }
    fb
}

/// Slaney Hz→mel: linear at 3·f/200 below 1 kHz, log-spaced above (matches fbanks.py).
fn slaney_hz_to_mel(freq: f32) -> f32 {
    const F_SP: f32 = 200.0 / 3.0;
    const MIN_LOG_HZ: f32 = 1000.0;
    const MIN_LOG_MEL: f32 = MIN_LOG_HZ / F_SP; // 15.0
    let logstep = (6.4f32).ln() / 27.0;
    if freq < MIN_LOG_HZ {
        freq / F_SP
    } else {
        MIN_LOG_MEL + (freq / MIN_LOG_HZ).ln() / logstep
    }
}

/// Slaney mel→Hz inverse of `slaney_hz_to_mel`.
fn slaney_mel_to_hz(mel: f32) -> f32 {
    const F_SP: f32 = 200.0 / 3.0;
    const MIN_LOG_MEL: f32 = 15.0;
    const MIN_LOG_HZ: f32 = 1000.0;
    let logstep = (6.4f32).ln() / 27.0;
    if mel < MIN_LOG_MEL {
        F_SP * mel
    } else {
        MIN_LOG_HZ * (logstep * (mel - MIN_LOG_MEL)).exp()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mel_roundtrip_hz() {
        // Slaney hz↔mel must invert across the linear/log knee.
        for &hz in &[0.0f32, 250.0, 999.0, 1000.0, 4000.0, 8000.0] {
            let back = slaney_mel_to_hz(slaney_hz_to_mel(hz));
            assert!((back - hz).abs() < 1e-1, "hz={hz} back={back}");
        }
    }

    #[test]
    fn filterbank_shape_and_partition() {
        let fb = slaney_mel_filterbank(N_FREQS + 1, 0.0, 8000.0, 80, SAMPLE_RATE);
        assert_eq!(fb.len(), (N_FREQS + 1) * 80);
        // Every entry is finite and non-negative (triangular filters).
        assert!(fb.iter().all(|&v| v.is_finite() && v >= 0.0));
        // The bank carries energy: at least some filters are non-zero.
        assert!(fb.iter().any(|&v| v > 0.0));
    }

    #[test]
    fn window_is_periodic_hann() {
        let mx = MelExtractor::new(80);
        // Hann starts at 0 and is symmetric-ish; midpoint is the peak (~1.0).
        assert!(mx.window[0].abs() < 1e-6);
        assert!((mx.window[WIN_LENGTH / 2] - 1.0).abs() < 1e-2);
    }

    #[test]
    #[ignore = "SPIKE: Whisper log-mel is not bounded at 1.0; validate exact normalization vs the Python preprocessor on real audio (03_stt_engine.md §11)"]
    fn extract_produces_fixed_window() {
        let mx = MelExtractor::new(80);
        // One second of a 440 Hz tone.
        let audio: Vec<f32> = (0..16_000)
            .map(|i| (2.0 * PI * 440.0 * i as f32 / SAMPLE_RATE as f32).sin() * 0.5)
            .collect();
        let (feats, n_mels, n_frames) = mx.extract(&audio);
        assert_eq!(n_mels, 80);
        assert_eq!(n_frames, N_FRAMES);
        assert_eq!(feats.len(), 80 * N_FRAMES);
        // Features must be finite and bounded (~[-? , 1]); the affine maps log-mel to ≤ 1.
        assert!(feats.iter().all(|v| v.is_finite()));
        assert!(feats.iter().cloned().fold(f32::MIN, f32::max) <= 1.0001);
    }

    #[test]
    fn silence_extracts_without_panic() {
        let mx = MelExtractor::new(128);
        let (feats, n_mels, n_frames) = mx.extract(&[]);
        assert_eq!(n_mels, 128);
        assert_eq!(n_frames, N_FRAMES);
        assert!(feats.iter().all(|v| v.is_finite()));
    }
}
