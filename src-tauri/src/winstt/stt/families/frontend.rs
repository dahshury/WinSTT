// Audio feature front-ends shared by the non-Whisper STT families:
//   * mel filterbanks + FBANK/LFR/CMVN featurizers (SenseVoice, Kaldi/Zipformer, GigaAM-v3,
//     NeMo-128, Granite AR/NAR).
//
// Self-contained: depends only on ndarray/rayon/rustfft + the embedded
// `crate::winstt::stt::gigaam_v3_consts` window/filterbank tables. Lifted verbatim out of the old
// monolithic `families.rs` (was an inline `mod frontend`).

#![allow(dead_code)] // staged: surface defined ahead of call sites / wiring.

use ndarray::Array2;

pub const SAMPLE_RATE: usize = 16_000;
pub const NUM_MELS: usize = 80;
pub const N_FFT: usize = 400;
pub const HOP: usize = 160;
pub const WIN: usize = 400;
pub const PRE_EMPHASIS: f32 = 0.97;
pub const F_MIN: f32 = 20.0;

/// HTK triangular mel filterbank `(n_fft/2+1, n_mels)`. Port of `_build_mel_filterbank`.
pub fn build_mel_filterbank() -> Array2<f32> {
    let n_freqs = N_FFT / 2 + 1;
    let fmax = SAMPLE_RATE as f32 / 2.0;
    let all_freqs: Vec<f32> = (0..n_freqs)
        .map(|i| (SAMPLE_RATE as f32 / 2.0) * (i as f32) / ((n_freqs - 1) as f32))
        .collect();
    let m_min = 2595.0 * (1.0 + F_MIN / 700.0).log10();
    let m_max = 2595.0 * (1.0 + fmax / 700.0).log10();
    let m_pts: Vec<f32> = (0..NUM_MELS + 2)
        .map(|i| m_min + (m_max - m_min) * (i as f32) / ((NUM_MELS + 1) as f32))
        .collect();
    let f_pts: Vec<f32> = m_pts
        .iter()
        .map(|&m| 700.0 * (10f32.powf(m / 2595.0) - 1.0))
        .collect();
    let f_diff: Vec<f32> = f_pts.windows(2).map(|w| w[1] - w[0]).collect();

    let mut fb = Array2::<f32>::zeros((n_freqs, NUM_MELS));
    for f in 0..n_freqs {
        for m in 0..NUM_MELS {
            let down = -(f_pts[m] - all_freqs[f]) / f_diff[m];
            let up = (f_pts[m + 2] - all_freqs[f]) / f_diff[m + 1];
            let v = down.min(up).max(0.0);
            fb[[f, m]] = v;
        }
    }
    fb
}

/// 80-mel log-magnitude FBANK with Hamming window + pre-emphasis 0.97. snip_edges=True.
/// Returns `(T, n_mels)`. Port of `_compute_fbank`.
pub fn compute_fbank(samples: &[f32], fbanks: &Array2<f32>) -> Array2<f32> {
    if samples.len() < WIN {
        return Array2::<f32>::zeros((0, NUM_MELS));
    }
    let num_frames = 1 + (samples.len() - WIN) / HOP;
    let hamming: Vec<f32> = (0..WIN)
        .map(|n| 0.54 - 0.46 * (2.0 * std::f32::consts::PI * n as f32 / (WIN as f32 - 1.0)).cos())
        .collect();
    let n_freqs = N_FFT / 2 + 1;
    let eps = f32::EPSILON;

    // Per-frame loop is embarrassingly parallel (each frame independent) and DOMINATED
    // long-audio feature extraction (~24k frames for 4 min, single-threaded). Parallelize
    // it across cores with rayon — closes the fbank gap vs onnx-asr's concurrent/numpy
    // preprocessor on the throughput-bound (SenseVoice/GigaAM/NeMo-CTC) families. The
    // rfft_power FFT plan is thread-local, so each rayon worker builds its own once;
    // output is byte-identical to the serial version (same per-frame computation).
    use rayon::prelude::*;
    let mut out_flat = vec![0f32; num_frames * NUM_MELS];
    out_flat
        .par_chunks_mut(NUM_MELS)
        .enumerate()
        .for_each(|(t, row)| {
            let start = t * HOP;
            let mut frame = vec![0f32; WIN];
            // pre-emphasis with edge-pad (offset[0] == samples[start]).
            for i in 0..WIN {
                let cur = samples[start + i];
                let prev = if i == 0 {
                    samples[start]
                } else {
                    samples[start + i - 1]
                };
                frame[i] = (cur - PRE_EMPHASIS * prev) * hamming[i];
            }
            // real FFT magnitude^2 → mel energies → log.
            let power = rfft_power(&frame, N_FFT, n_freqs);
            for (m, slot) in row.iter_mut().enumerate() {
                let mut acc = 0f32;
                for (f, &p) in power.iter().enumerate() {
                    acc += p * fbanks[[f, m]];
                }
                *slot = acc.max(eps).ln();
            }
        });
    Array2::from_shape_vec((num_frames, NUM_MELS), out_flat)
        .expect("fbank shape (num_frames, NUM_MELS) matches out_flat len")
}

/// Real-input power spectrum |X[k]|² for the first `n_freqs` bins, via a cached forward-FFT plan
/// (rustfft). Numerically identical to the previous naive DFT (same forward sign convention
/// X[k]=Σ x[n]·e^{-2πi kn/N}), but O(n_fft·log n_fft) instead of O(n_fft·n_freqs) — the naive
/// version (200 bins × 400 samples × ~1100 frames ≈ 176M cos/sin per clip) DOMINATED every
/// non-Whisper featurizer. This FFT swap gave ~8× per-family speedup, validated against onnx-asr
/// at lowest quant (whisper/sense_voice/nemo/cohere/kaldi/dolphin/gigaam/t-one all byte-identical
/// + within/under 1.3× onnx-asr). One plan is cached per distinct n_fft (400 for compute_fbank,
///   512 for nemo_features) in a thread-local — rfft_power is a free fn with no struct to hold it.
fn rfft_power(frame: &[f32], n_fft: usize, n_freqs: usize) -> Vec<f32> {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::Arc;

    use rustfft::num_complex::Complex32;
    use rustfft::{Fft, FftPlanner};

    thread_local! {
        static PLANS: RefCell<HashMap<usize, Arc<dyn Fft<f32>>>> = RefCell::new(HashMap::new());
    }
    let fft = PLANS.with(|plans| {
        plans
            .borrow_mut()
            .entry(n_fft)
            .or_insert_with(|| FftPlanner::<f32>::new().plan_fft_forward(n_fft))
            .clone()
    });
    let mut buf: Vec<Complex32> = (0..n_fft)
        .map(|i| Complex32::new(frame.get(i).copied().unwrap_or(0.0), 0.0))
        .collect();
    fft.process(&mut buf);
    buf.into_iter()
        .take(n_freqs)
        .map(|c| c.re * c.re + c.im * c.im)
        .collect()
}

// ── Kaldi 80-mel fbank featurizer (KaldiPreprocessorNumpy, kaldi branch) ───────────────
// EXACT port of onnx-asr preprocessors/numpy_preprocessor.py::KaldiPreprocessorNumpy with
// name="kaldi": n_fft=512, win=400, hop=160, 80 mels, snip_edges=False, remove_dc_offset=True,
// preemphasis=0.97, window = numpy.hanning(400)^0.85 (povey). Filterbank from
// preprocessors/kaldi.py: melscale_fbanks(257, low_freq=20, high_freq=-400→7600, 80,
// sr=16000, mel_scale="kaldi") — kaldi mel scale (1127*ln(1+f/700)), HTK-style triangles in
// mel space, fmax=sr/2-400=7600, NO slaney normalization.
//
// Used by Dolphin (EngineKind::DolphinCtc / CtcFrontend::KaldiWithMetaCmvn) for the filterbank
// AND by the Vosk/zipformer transducers for the FRAME PROCESSING (they pair `compute_kaldi_fbank`
// with their own HTK-mel filterbank — `build_zipformer_mel_filterbank` below). SEPARATE from the
// SenseVoice `compute_fbank`/`build_mel_filterbank` (Hamming/n_fft=400/snip_edges=True) which
// other families share — do NOT merge them.
pub fn granite_ar_features(samples: &[f32]) -> Array2<f32> {
    granite_features(samples, None)
}

pub fn granite_nar_features(samples: &[f32]) -> Array2<f32> {
    let mel_frames = 2 * (samples.len() / (2 * KALDI_HOP));
    granite_features(samples, Some(mel_frames))
}

fn granite_features(samples: &[f32], keep_mel_frames: Option<usize>) -> Array2<f32> {
    const N_FFT: usize = 512;
    const WIN: usize = 400;
    const HOP: usize = 160;
    const N_MELS: usize = 80;
    const PAD: isize = (N_FFT / 2) as isize;
    const WIN_OFFSET: usize = (N_FFT - WIN) / 2;

    if samples.is_empty() {
        return Array2::<f32>::zeros((0, 2 * N_MELS));
    }

    let fbanks = build_granite_mel_filterbank();
    let n_freqs = N_FFT / 2 + 1;
    let mut mel_frames = samples.len() / HOP + 1;
    if let Some(keep) = keep_mel_frames {
        mel_frames = mel_frames.min(keep);
    }
    if mel_frames % 2 == 1 {
        mel_frames -= 1;
    }
    if mel_frames == 0 {
        return Array2::<f32>::zeros((0, 2 * N_MELS));
    }

    let hann: Vec<f32> = (0..WIN)
        .map(|n| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / WIN as f32).cos())
        .collect();
    let mut logmel = vec![0f32; mel_frames * N_MELS];

    for t in 0..mel_frames {
        let frame_start = t as isize * HOP as isize - PAD;
        let mut frame = vec![0f32; N_FFT];
        for n in 0..WIN {
            let src = reflect_index(frame_start + (WIN_OFFSET + n) as isize, samples.len());
            frame[WIN_OFFSET + n] = samples[src] * hann[n];
        }
        let power = rfft_power(&frame, N_FFT, n_freqs);
        let row = &mut logmel[t * N_MELS..(t + 1) * N_MELS];
        for (m, slot) in row.iter_mut().enumerate() {
            let mut acc = 0f32;
            for (f, &p) in power.iter().enumerate() {
                acc += p * fbanks[[f, m]];
            }
            *slot = acc.max(1e-10).log10();
        }
    }

    let mx = logmel.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let floor = mx - 8.0;
    for v in &mut logmel {
        *v = v.max(floor) / 4.0 + 1.0;
    }

    let stacked_frames = mel_frames / 2;
    let mut stacked = vec![0f32; stacked_frames * 2 * N_MELS];
    for t in 0..stacked_frames {
        let dst = t * 2 * N_MELS;
        let src = 2 * t * N_MELS;
        stacked[dst..dst + N_MELS].copy_from_slice(&logmel[src..src + N_MELS]);
        stacked[dst + N_MELS..dst + 2 * N_MELS]
            .copy_from_slice(&logmel[src + N_MELS..src + 2 * N_MELS]);
    }

    Array2::from_shape_vec((stacked_frames, 2 * N_MELS), stacked)
        .expect("granite stacked feature shape matches flat len")
}

fn reflect_index(mut idx: isize, len: usize) -> usize {
    if len <= 1 {
        return 0;
    }
    let len = len as isize;
    while idx < 0 || idx >= len {
        if idx < 0 {
            idx = -idx;
        }
        if idx >= len {
            idx = 2 * len - idx - 2;
        }
    }
    idx as usize
}

fn build_granite_mel_filterbank() -> Array2<f32> {
    const N_FFT: usize = 512;
    const N_MELS: usize = 80;
    let n_freqs = N_FFT / 2 + 1;
    let fmax = SAMPLE_RATE as f32 / 2.0;
    let all_freqs: Vec<f32> = (0..n_freqs)
        .map(|i| fmax * (i as f32) / ((n_freqs - 1) as f32))
        .collect();
    let m_min = 2595.0 * (1.0f32 + 0.0 / 700.0).log10();
    let m_max = 2595.0 * (1.0 + fmax / 700.0).log10();
    let m_pts: Vec<f32> = (0..N_MELS + 2)
        .map(|i| m_min + (m_max - m_min) * (i as f32) / ((N_MELS + 1) as f32))
        .collect();
    let f_pts: Vec<f32> = m_pts
        .iter()
        .map(|&m| 700.0 * (10f32.powf(m / 2595.0) - 1.0))
        .collect();
    let f_diff: Vec<f32> = f_pts.windows(2).map(|w| w[1] - w[0]).collect();

    let mut fb = Array2::<f32>::zeros((n_freqs, N_MELS));
    for f in 0..n_freqs {
        for m in 0..N_MELS {
            let down = -(f_pts[m] - all_freqs[f]) / f_diff[m];
            let up = (f_pts[m + 2] - all_freqs[f]) / f_diff[m + 1];
            fb[[f, m]] = down.min(up).max(0.0);
        }
    }
    fb
}

pub const KALDI_N_FFT: usize = 512;
pub const KALDI_WIN: usize = 400;
pub const KALDI_HOP: usize = 160;
pub const KALDI_N_MELS: usize = 80;
pub const KALDI_F_MIN: f32 = 20.0;
// high_freq=-400 → f_max += sr/2 → 7600 (CRITICAL: 8000 gives corr=0.26 garbage; 7600 matches
// fbanks.npz['kaldi'] = sr/2 - 400).
pub const KALDI_F_MAX: f32 = 7600.0;
pub const KALDI_PRE_EMPHASIS: f32 = 0.97;

/// kaldi mel scale: `1127 * ln(1 + f/700)` (preprocessors/fbanks.py::_hz_to_mel, "kaldi").
#[inline]
fn kaldi_hz_to_mel(f: f32) -> f32 {
    1127.0 * (1.0 + f / 700.0).ln()
}

/// Kaldi 80-mel triangular filterbank `(n_fft/2+1=257, 80)`. Port of `melscale_fbanks` with
/// `mel_scale="kaldi"`: all bin frequencies AND the 82 mel vertices live in kaldi-mel space;
/// triangles `max(0, min(up_slope, down_slope))`; NO slaney area normalization (peaks ≈ 1).
/// Used by Dolphin (CtcFrontend::KaldiWithMetaCmvn).
pub fn build_kaldi_mel_filterbank() -> Array2<f32> {
    let n_freqs = KALDI_N_FFT / 2 + 1; // 257
                                       // all_freqs = linspace(0, sample_rate//2, n_freqs) = linspace(0, 8000, 257).
    let all_freqs_mel: Vec<f32> = (0..n_freqs)
        .map(|i| {
            let hz = (SAMPLE_RATE as f32 / 2.0) * (i as f32) / ((n_freqs - 1) as f32);
            kaldi_hz_to_mel(hz)
        })
        .collect();
    let m_min = kaldi_hz_to_mel(KALDI_F_MIN);
    let m_max = kaldi_hz_to_mel(KALDI_F_MAX);
    // m_pts = linspace(m_min, m_max, n_mels+2) — kept in mel space (kaldi branch does NOT
    // convert back to hz).
    let m_pts: Vec<f32> = (0..KALDI_N_MELS + 2)
        .map(|i| m_min + (m_max - m_min) * (i as f32) / ((KALDI_N_MELS + 1) as f32))
        .collect();

    let mut fb = Array2::<f32>::zeros((n_freqs, KALDI_N_MELS));
    for (f, &mel) in all_freqs_mel.iter().enumerate() {
        for m in 0..KALDI_N_MELS {
            let up = (mel - m_pts[m]) / (m_pts[m + 1] - m_pts[m]);
            let down = (m_pts[m + 2] - mel) / (m_pts[m + 2] - m_pts[m + 1]);
            fb[[f, m]] = up.min(down).max(0.0);
        }
    }
    fb
}

/// HTK triangular mel filterbank `(n_fft/2+1=257, 80)` for the Vosk/zipformer Kaldi preprocessor —
/// fmin=20, fmax=7600, n_fft=512. Same `compute_kaldi_fbank` frame pipeline, but the Vosk/icefall
/// zipformer packs were validated bit-exact against onnx-asr's precomputed `fbanks.npz["kaldi"]`
/// using the HTK mel scale (`2595*log10(1+f/700)`, max abs error 3.8e-3 — a float32 generation
/// artifact, negligible after the log-mel/transducer stage; verified by the zipformer-en spike).
/// Kept SEPARATE from `build_kaldi_mel_filterbank` (kaldi-mel-scale, Dolphin) so each validated
/// family uses exactly the bank it was decode-validated with.
pub fn build_zipformer_mel_filterbank() -> Array2<f32> {
    let n_freqs = KALDI_N_FFT / 2 + 1; // 257
    let all_freqs: Vec<f32> = (0..n_freqs)
        .map(|i| (SAMPLE_RATE as f32 / 2.0) * (i as f32) / ((n_freqs - 1) as f32))
        .collect();
    // HTK hz↔mel (base-10), identical knee to `_build_mel_filterbank` but with fmin=20/fmax=7600.
    let hz_to_mel = |f: f32| 2595.0 * (1.0 + f / 700.0).log10();
    let mel_to_hz = |m: f32| 700.0 * (10f32.powf(m / 2595.0) - 1.0);
    let m_min = hz_to_mel(KALDI_F_MIN);
    let m_max = hz_to_mel(KALDI_F_MAX);
    let f_pts: Vec<f32> = (0..KALDI_N_MELS + 2)
        .map(|i| mel_to_hz(m_min + (m_max - m_min) * (i as f32) / ((KALDI_N_MELS + 1) as f32)))
        .collect();
    let mut fb = Array2::<f32>::zeros((n_freqs, KALDI_N_MELS));
    for f in 0..n_freqs {
        for m in 0..KALDI_N_MELS {
            let lower = f_pts[m];
            let center = f_pts[m + 1];
            let upper = f_pts[m + 2];
            let up = (all_freqs[f] - lower) / (center - lower);
            let down = (upper - all_freqs[f]) / (upper - center);
            fb[[f, m]] = up.min(down).max(0.0);
        }
    }
    fb
}

/// Kaldi log-mel fbank → `(T, 80)`. Port of `KaldiPreprocessorNumpy.__call__` (kaldi/snip_edges
/// =False). Steps:
///  1. symmetric-pad samples: pad_left = win//2 - hop//2 = 120, pad_right = win//2 = 200
///     (np.pad mode="symmetric" — mirror including the edge sample).
///  2. num_frames = (orig_len + hop//2) // hop  (features_lens).
///  3. per 400-sample frame: subtract frame mean (DC removal), then pre-emphasis
///     `f[i] - 0.97*f[i-1]` with f[-1]==f[0] (np.pad edge), then ×window (hanning(400)^0.85).
///  4. rfft power at n_fft=512 → 257 bins.
///  5. mel = power · fb ; log(max(mel, f32::EPSILON)).
///
/// `fbanks` is the caller's filterbank: Dolphin passes `build_kaldi_mel_filterbank` (kaldi mel
/// scale); Vosk/zipformer pass `build_zipformer_mel_filterbank` (HTK mel scale). The frame
/// pipeline is identical for both (validated bit-exact against onnx-asr in each port).
pub fn compute_kaldi_fbank(samples: &[f32], fbanks: &Array2<f32>) -> Array2<f32> {
    if samples.is_empty() {
        return Array2::<f32>::zeros((0, KALDI_N_MELS));
    }
    let orig_len = samples.len();
    let pad_left = KALDI_WIN / 2 - KALDI_HOP / 2; // 120
    let pad_right = KALDI_WIN / 2; // 200
    let padded = symmetric_pad(samples, pad_left, pad_right);

    // features_lens = (orig_len + hop//2) // hop.
    let num_frames = (orig_len + KALDI_HOP / 2) / KALDI_HOP;
    if num_frames == 0 {
        return Array2::<f32>::zeros((0, KALDI_N_MELS));
    }

    // povey window: numpy.hanning(400) = 0.5 - 0.5*cos(2πn/399), raised to 0.85.
    let window: Vec<f32> = (0..KALDI_WIN)
        .map(|n| {
            let h = 0.5
                - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / (KALDI_WIN as f32 - 1.0)).cos();
            h.powf(0.85)
        })
        .collect();

    let n_freqs = KALDI_N_FFT / 2 + 1; // 257
    let eps = f32::EPSILON;
    // Frames are independent → compute the (num_frames × KALDI_N_MELS) rows in parallel
    // (rfft_power's FFT plan is thread-local, so each worker builds its own once; output is
    // byte-identical to the serial version). Used by Dolphin + Vosk/zipformer; dominated
    // CPU-side prep on long audio. Mirrors the parallel compute_fbank / nemo_features.
    use rayon::prelude::*;
    let mut out_flat = vec![0f32; num_frames * KALDI_N_MELS];
    out_flat
        .par_chunks_mut(KALDI_N_MELS)
        .enumerate()
        .for_each(|(t, mel_row)| {
            let start = t * KALDI_HOP;
            // 512-long FFT frame: windowed 400 samples in [0,400), zeros in [400,512).
            // (Fresh per-worker buffer → the [400,512) tail stays zero.)
            let mut frame = vec![0f32; KALDI_N_FFT];
            let mut raw = vec![0f32; KALDI_WIN];
            // gather the 400-sample frame from the symmetric-padded buffer.
            for (i, r) in raw.iter_mut().enumerate() {
                *r = padded.get(start + i).copied().unwrap_or(0.0);
            }
            // 1. DC removal: subtract the frame mean.
            let mean: f32 = raw.iter().sum::<f32>() / KALDI_WIN as f32;
            for v in raw.iter_mut() {
                *v -= mean;
            }
            // 2. pre-emphasis on the DC-removed frame: f[i] - 0.97*f[i-1], f[-1]==f[0] (edge).
            //    + window. Compute back-to-front so f[i-1] is still the pre-emphasis input.
            for i in (0..KALDI_WIN).rev() {
                let prev = if i == 0 { raw[0] } else { raw[i - 1] };
                frame[i] = (raw[i] - KALDI_PRE_EMPHASIS * prev) * window[i];
            }
            // 3. power spectrum → mel → log.
            let power = rfft_power(&frame, KALDI_N_FFT, n_freqs);
            for (m, slot) in mel_row.iter_mut().enumerate() {
                let mut acc = 0f32;
                for (f, &p) in power.iter().enumerate() {
                    acc += p * fbanks[[f, m]];
                }
                *slot = acc.max(eps).ln();
            }
        });
    Array2::from_shape_vec((num_frames, KALDI_N_MELS), out_flat)
        .expect("kaldi fbank shape (num_frames, KALDI_N_MELS) matches out_flat len")
}

/// Symmetric (mirror) padding of a 1-D signal: `np.pad(x, (pad_left, pad_right), mode="symmetric")`.
/// numpy "symmetric" reflects INCLUDING the edge sample (unlike "reflect"). For pad_left/right that
/// don't exceed the signal length (120/200 vs ≥400-sample clips) a single reflection suffices.
fn symmetric_pad(samples: &[f32], pad_left: usize, pad_right: usize) -> Vec<f32> {
    let n = samples.len();
    let mut out = Vec::with_capacity(n + pad_left + pad_right);
    // left: samples[pad_left-1], samples[pad_left-2], …, samples[0]  (mirror incl. edge).
    for i in (0..pad_left).rev() {
        out.push(samples[i.min(n - 1)]);
    }
    out.extend_from_slice(samples);
    // right: samples[n-1], samples[n-2], …  (mirror incl. edge).
    for i in 0..pad_right {
        let idx = n.saturating_sub(1).saturating_sub(i);
        out.push(samples[idx]);
    }
    out
}

// ── GigaAM v3 64-mel log featurizer (GigaamPreprocessorNumpy, version="v3") ────────────
// onnx-asr preprocessors/numpy_preprocessor.py::GigaamPreprocessorNumpy with name="gigaam_v3":
//   n_fft = sr//50 = 320, win_length = n_fft = 320, hop = sr//100 = 160; NO reflect padding
//   (the v2 branch pads, v3 does NOT); NO pre-emphasis; periodic-Hann-like window of length 320
//   loaded from fbanks.npz ("gigaam_v3_window") — NOT analytic Hamming/Hanning; 64-mel HTK
//   filterbank [161,64] also loaded from fbanks.npz ("gigaam_v3"). Spectrum = |rfft(win·frame,320)|^2
//   (161 bins) → mel = spectrum @ fbanks → log(clip(mel, 1e-9, 1e9)). Output transposed to (64,T).
//   features_lens = (waveforms_lens - win_length)//hop + 1.
// The exact window + filterbank are embedded (crate::winstt::stt::gigaam_v3_consts) for bit-exact
// parity; they are fp16-quantized HTK/periodic-Hann (≈0.0019 off the analytic forms — below the int8
// noise floor, but we ship the stored bytes to be faithful to onnx-asr). SEPARATE featurizer — does
// NOT touch the 80-mel kaldi `compute_fbank` or the 128-mel `nemo_features` used by other families.
pub const GIGAAM_V3_N_FFT: usize = 320;
pub const GIGAAM_V3_WIN: usize = 320;
pub const GIGAAM_V3_HOP: usize = 160;
pub const GIGAAM_V3_N_MELS: usize = 64;
const GIGAAM_V3_N_FREQS: usize = GIGAAM_V3_N_FFT / 2 + 1; // 161
const GIGAAM_V3_CLAMP_MIN: f32 = 1e-9;
const GIGAAM_V3_CLAMP_MAX: f32 = 1e9;

/// GigaAM v3 featurizer → `(T, 64)` log-mel (row-major time-first; the engine transposes to
/// `(1, 64, T)` for `features` / `audio_signal`). `T = 1 + (n - 320)//160`. No normalization
/// (GigaAM normalizes inside the ONNX graph, unlike NeMo's preprocessor-side CMVN).
pub fn gigaam_v3_features(samples: &[f32]) -> Array2<f32> {
    let n = samples.len();
    if n < GIGAAM_V3_WIN {
        return Array2::<f32>::zeros((0, GIGAAM_V3_N_MELS));
    }
    let num_frames = 1 + (n - GIGAAM_V3_WIN) / GIGAAM_V3_HOP;
    let window = &crate::winstt::stt::gigaam_v3_consts::GIGAAM_V3_WINDOW; // [320]
    let fbanks = &crate::winstt::stt::gigaam_v3_consts::GIGAAM_V3_FB; // [161][64]

    // Frames are independent → compute rows in parallel (rfft_power's FFT plan is thread-local;
    // output byte-identical to serial). Mirrors compute_fbank / nemo_features / compute_kaldi_fbank.
    use rayon::prelude::*;
    let mut out_flat = vec![0f32; num_frames * GIGAAM_V3_N_MELS];
    out_flat
        .par_chunks_mut(GIGAAM_V3_N_MELS)
        .enumerate()
        .for_each(|(t, mel_row)| {
            let start = t * GIGAAM_V3_HOP;
            // window the 320-sample frame (no pre-emphasis, no DC removal).
            let mut frame = vec![0f32; GIGAAM_V3_WIN];
            for (i, slot) in frame.iter_mut().enumerate() {
                *slot = samples[start + i] * window[i];
            }
            // |rfft|^2 → 161-bin power spectrum (frame len == n_fft, so no zero-pad needed).
            let power = rfft_power(&frame, GIGAAM_V3_N_FFT, GIGAAM_V3_N_FREQS);
            // mel = power @ fbanks (161×64), then log(clip(mel, 1e-9, 1e9)).
            for (m, slot) in mel_row.iter_mut().enumerate() {
                let mut acc = 0f32;
                for (f, &p) in power.iter().enumerate() {
                    acc += p * fbanks[f][m];
                }
                *slot = acc.clamp(GIGAAM_V3_CLAMP_MIN, GIGAAM_V3_CLAMP_MAX).ln();
            }
        });
    Array2::from_shape_vec((num_frames, GIGAAM_V3_N_MELS), out_flat)
        .expect("gigaam v3 fbank shape (num_frames, GIGAAM_V3_N_MELS) matches out_flat len")
}

// ── NeMo 128-mel log-mel featurizer (NemoPreprocessorNumpy) ───────────────────────────
// n_fft=512, win=400, hop=160, preemph=0.97; 128 Slaney mels (fmin=0, fmax=sr/2);
// log(x + 2^-24); PER-FEATURE (per-mel-bin) normalization over time (unbiased var, +1e-5).
// Source: onnx-asr preprocessors/numpy_preprocessor.py::NemoPreprocessorNumpy. Cohere reuses
// the same 128-mel Slaney bank. SEPARATE from the 80-mel kaldi `compute_fbank` above.
pub const NEMO_N_FFT: usize = 512;
pub const NEMO_WIN: usize = 400;
pub const NEMO_HOP: usize = 160;
pub const NEMO_N_MELS: usize = 128;
const NEMO_LOG_GUARD: f32 = 5.960_464_5e-8; // 2^-24

/// Slaney-normalized mel filterbank `(n_fft/2+1, n_mels)` for NeMo/Cohere (fmin=0, fmax=sr/2).
/// `n_mels` varies per NeMo model (parakeet-ctc=80, canary=128) — read from the model input.
pub fn build_nemo_mel_filterbank(n_mels: usize) -> Array2<f32> {
    let n_freqs = NEMO_N_FFT / 2 + 1; // 257
    let fmax = SAMPLE_RATE as f32 / 2.0;
    let all_freqs: Vec<f32> = (0..n_freqs)
        .map(|i| fmax * i as f32 / (n_freqs - 1) as f32)
        .collect();
    let hz_to_mel = |f: f32| -> f32 {
        const F_SP: f32 = 200.0 / 3.0;
        const MIN_LOG_HZ: f32 = 1000.0;
        const MIN_LOG_MEL: f32 = MIN_LOG_HZ / F_SP; // 15
        let logstep = (6.4f32).ln() / 27.0;
        if f < MIN_LOG_HZ {
            f / F_SP
        } else {
            MIN_LOG_MEL + (f / MIN_LOG_HZ).ln() / logstep
        }
    };
    let mel_to_hz = |m: f32| -> f32 {
        const F_SP: f32 = 200.0 / 3.0;
        const MIN_LOG_MEL: f32 = 15.0;
        const MIN_LOG_HZ: f32 = 1000.0;
        let logstep = (6.4f32).ln() / 27.0;
        if m < MIN_LOG_MEL {
            F_SP * m
        } else {
            MIN_LOG_HZ * (logstep * (m - MIN_LOG_MEL)).exp()
        }
    };
    let m_min = hz_to_mel(0.0);
    let m_max = hz_to_mel(fmax);
    let m_pts: Vec<f32> = (0..n_mels + 2)
        .map(|i| mel_to_hz(m_min + (m_max - m_min) * i as f32 / (n_mels + 1) as f32))
        .collect();
    let mut fb = Array2::<f32>::zeros((n_freqs, n_mels));
    for f in 0..n_freqs {
        for m in 0..n_mels {
            let lower = m_pts[m];
            let center = m_pts[m + 1];
            let upper = m_pts[m + 2];
            let up = (all_freqs[f] - lower) / (center - lower);
            let down = (upper - all_freqs[f]) / (upper - center);
            let mut tri = up.min(down).max(0.0);
            tri *= 2.0 / (upper - lower); // Slaney area normalization
            fb[[f, m]] = tri;
        }
    }
    fb
}

/// NeMo featurizer → `(T, 128)` per-feature-normalized log-mel (T = `samples.len()/hop`, the
/// model's `features_lens`). The engine transposes to `(1, 128, T)` for `audio_signal`.
pub fn nemo_features(samples: &[f32], fbanks: &Array2<f32>) -> Array2<f32> {
    nemo_features_with_normalization(samples, fbanks, "per_feature")
}

pub fn nemo_features_with_normalization(
    samples: &[f32],
    fbanks: &Array2<f32>,
    normalize_type: &str,
) -> Array2<f32> {
    use std::f32::consts::PI;
    let n_mels = fbanks.ncols(); // 80 or 128 — whatever the model declared
    let n = samples.len();
    let num_frames = n / NEMO_HOP; // == features_lens (waveforms_lens // hop)
    if num_frames == 0 {
        return Array2::<f32>::zeros((0, n_mels));
    }
    // 1. pre-emphasis y[i] = x[i] - 0.97*x[i-1], y[0] = x[0].
    let mut y = vec![0f32; n];
    y[0] = samples[0];
    for i in 1..n {
        y[i] = samples[i] - PRE_EMPHASIS * samples[i - 1];
    }
    // 2. zero-pad n_fft//2 each side.
    let pad = NEMO_N_FFT / 2;
    let mut padded = vec![0f32; n + 2 * pad];
    padded[pad..pad + n].copy_from_slice(&y);
    // 3. numpy.hanning(400) = 0.5 - 0.5*cos(2πk/399), zero-padded (centered) to 512.
    let wpad = (NEMO_N_FFT - NEMO_WIN) / 2;
    let mut window = vec![0f32; NEMO_N_FFT];
    for k in 0..NEMO_WIN {
        window[wpad + k] = 0.5 - 0.5 * (2.0 * PI * k as f32 / (NEMO_WIN as f32 - 1.0)).cos();
    }
    // 4. frame (len n_fft, hop) → window → power spectrum → mel → log(x + 2^-24).
    //    Frames are independent → compute the (num_frames × n_mels) log-mel rows in parallel
    //    (rfft_power's FFT plan is thread-local, so each worker builds its own once; output is
    //    byte-identical to the serial version). This is the parakeet/NeMo-CTC/Canary featurizer;
    //    on long audio it dominated CPU-side prep before the (DML) encoder. Mirrors compute_fbank.
    use rayon::prelude::*;
    let n_freqs = NEMO_N_FFT / 2 + 1;
    let mut out_flat = vec![0f32; num_frames * n_mels];
    out_flat
        .par_chunks_mut(n_mels)
        .enumerate()
        .for_each(|(t, row)| {
            let start = t * NEMO_HOP;
            let mut frame = vec![0f32; NEMO_N_FFT];
            for (i, slot) in frame.iter_mut().enumerate() {
                *slot = padded.get(start + i).copied().unwrap_or(0.0) * window[i];
            }
            let power = rfft_power(&frame, NEMO_N_FFT, n_freqs);
            for (m, slot) in row.iter_mut().enumerate() {
                let mut acc = 0f32;
                for (f, &p) in power.iter().enumerate() {
                    acc += p * fbanks[[f, m]];
                }
                *slot = (acc + NEMO_LOG_GUARD).ln();
            }
        });
    let mut log_mel = Array2::from_shape_vec((num_frames, n_mels), out_flat)
        .expect("nemo_features log-mel shape (num_frames, n_mels) matches out_flat len");
    // 5. Optional per-feature (per mel bin) normalization over time:
    //    (x-mean)/(sqrt(unbiased var)+1e-5). Offline NeMo exports use this path; sherpa streaming
    //    Nemotron/FastConformer exports leave normalize_type empty and expect raw log-mel frames.
    if normalize_type == "per_feature" {
        for m in 0..n_mels {
            let mut mean = 0f32;
            for t in 0..num_frames {
                mean += log_mel[[t, m]];
            }
            mean /= num_frames as f32;
            let mut var = 0f32;
            for t in 0..num_frames {
                let d = log_mel[[t, m]] - mean;
                var += d * d;
            }
            let denom = if num_frames > 1 {
                (num_frames - 1) as f32
            } else {
                1.0
            };
            let std = (var / denom).sqrt() + 1e-5;
            for t in 0..num_frames {
                log_mel[[t, m]] = (log_mel[[t, m]] - mean) / std;
            }
        }
    }
    log_mel
}

/// Low-Frame-Rate stacking. `window_size` frames per row, step `window_shift`; the final
/// partial window is right-padded with its last frame. Port of `_apply_lfr`.
pub fn apply_lfr(features: &Array2<f32>, window_size: usize, window_shift: usize) -> Array2<f32> {
    let in_frames = features.nrows();
    let mel_dim = features.ncols();
    if in_frames == 0 {
        return Array2::<f32>::zeros((0, mel_dim * window_size));
    }
    let out_frames = 1 + (in_frames - 1) / window_shift;
    let mut out = Array2::<f32>::zeros((out_frames.max(1), mel_dim * window_size));
    for i in 0..out_frames {
        let start = i * window_shift;
        for w in 0..window_size {
            let src = (start + w).min(in_frames - 1);
            for d in 0..mel_dim {
                out[[i, w * mel_dim + d]] = features[[src, d]];
            }
        }
    }
    out
}

/// `(features + neg_mean) * inv_stddev`, broadcast along time. Port of `_apply_cmvn`.
pub fn apply_cmvn(features: &mut Array2<f32>, neg_mean: &[f32], inv_stddev: &[f32]) {
    let cols = features.ncols();
    if neg_mean.len() != cols || inv_stddev.len() != cols {
        return; // shape mismatch → leave untouched (matches the size==0 guard upstream)
    }
    for mut row in features.rows_mut() {
        for (d, v) in row.iter_mut().enumerate() {
            *v = (*v + neg_mean[d]) * inv_stddev[d];
        }
    }
}

/// Per-mel-bin CMVN `(fbank - mean) * invstd` used by Dolphin (mean/invstd from ONNX metadata).
pub fn apply_dolphin_cmvn(features: &mut Array2<f32>, mean: &[f32], invstd: &[f32]) {
    let cols = features.ncols();
    if mean.len() != cols || invstd.len() != cols {
        return;
    }
    for mut row in features.rows_mut() {
        for (d, v) in row.iter_mut().enumerate() {
            *v = (*v - mean[d]) * invstd[d];
        }
    }
}
