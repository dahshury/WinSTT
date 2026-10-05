// Nemotron-3-Diarization streaming engine (NVIDIA, OpenMDW-1.1) on the
// `joosthel/Nemotron-3-Diarization-ONNX` export.
//
// One end-to-end streaming Sortformer replaces the old segmentation → embedding →
// clustering cascade: a 31-layer RoPE Transformer reads the arrival-order speaker
// cache (AOSC) + FIFO + the new chunk and emits per-10 ms sigmoid activities for up
// to 8 speakers, already numbered in order of first arrival — so a speaker keeps
// its channel for the whole session and no clustering stage exists at all.
//
// Per chunk (transformers `Nemotron3DiarizationForAudioFrameClassification.forward`,
// streaming mode):
//   1. log-mel: 16 kHz, pre-emphasis 0.97, 512-pt FFT of a symmetric 400-pt Hann
//      window (zero-padded, centered), hop 160, `center=True` zero padding, 128
//      Slaney mels (0–8 kHz), ln(x + 2⁻²⁴), no normalization, no dither — computed
//      incrementally here (`MelStream`), frame-for-frame identical to the
//      full-utterance featurizer;
//   2. `model.int8.onnx(chunk_mel, chunk_mel_length, context_embeds, context_length)`
//      → `logits [(C + ⌈T/8⌉)·8, 8]` and the pre-encoder `embeds [C + ⌈T/8⌉, 512]`,
//      where the context is speaker-cache ++ FIFO embeddings;
//   3. `SpeakerCache::update` — FIFO push/pop + score-based cache compression, a
//      line-by-line port of `Nemotron3DiarizationSpeakerCache`;
//   4. threshold 0.5 at 10 ms → per-speaker segments on the session timeline.
//
// The graph accepts any chunk geometry; `StreamingProfile` picks it. Sessions stay
// CPU by default for the same reason the cascade did (the diarizer must never
// destabilize the STT engine sharing the GPU).

use std::path::Path;
use std::sync::Arc;

use ndarray::{Array0, Array3};
use ort::session::Session;
use ort::value::Tensor;
use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

use crate::winstt::stt::Accelerator;

const SR: usize = 16_000;
const HOP: usize = 160;
const N_FFT: usize = 512;
const WIN: usize = 400;
const N_FREQS: usize = N_FFT / 2 + 1;
const N_MELS: usize = 128;
const PREEMPHASIS: f32 = 0.97;
const LOG_GUARD: f32 = 5.960_464_5e-8; // 2^-24

/// Mel frames per encoder frame (the 8× subsampling front-end).
const SUBSAMPLING: usize = 8;
const HIDDEN: usize = 512;
/// Output speaker channels, numbered in order of first arrival.
pub const MAX_SPEAKERS: usize = 8;

// Speaker-cache constants (`config.streaming_config`; asserted against constants.npz).
const SPKCACHE_LEN: usize = 264;
const SILENCE_FRAMES_PER_SPEAKER: usize = 1;
const PRED_SCORE_THRESHOLD: f32 = 0.25;
const LATEST_FRAMES_SCORE_BOOST: f32 = 0.05;
const STRONG_BOOST_RATE: f64 = 0.75;
const WEAK_BOOST_RATE: f64 = 1.5;
const MIN_POSITIVE_SCORES_RATE: f64 = 0.5;

/// Seconds per output frame (one mel hop).
pub const FRAME_SEC: f64 = HOP as f64 / SR as f64;
/// Speaker-activity threshold (`extract_speaker_dict`'s default).
const ACTIVITY_THRESHOLD: f32 = 0.5;
/// Same-speaker gaps up to this many 10 ms frames are bridged on the timeline, and
/// segments shorter than `MIN_SEGMENT_FRAMES` are dropped. A sweep over 13 eval
/// clips (2–10 speakers, five languages) put a 0.5 s bridge clearly ahead of raw
/// thresholding (pooled DER 16.6 % → 14.6 % offline); a turn's within-sentence
/// pauses otherwise fragment it into slivers.
const BRIDGE_GAP_FRAMES: usize = 50;
const MIN_SEGMENT_FRAMES: usize = 10;
/// Timeline entries older than this (behind the session end) are pruned; caption
/// spans only ever query the recent past.
const TIMELINE_KEEP_SEC: f64 = 300.0;

/// Chunk geometry in 80 ms encoder frames. Input-buffer latency is
/// `(chunk + right_context) × 80 ms`; every step attends over
/// `264 (cache) + fifo + chunk + right_context` frames, so compute per second of
/// audio scales with `(264 + fifo + chunk + rc) / chunk`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamingProfile {
    pub chunk: usize,
    pub right_context: usize,
    pub fifo: usize,
    pub update_period: usize,
}

impl StreamingProfile {
    /// Model-card offline profile (30.4 s latency) — `config.json` defaults.
    pub const OFFLINE: Self = Self {
        chunk: 340,
        right_context: 40,
        fifo: 40,
        update_period: 300,
    };
    /// Model-card "low latency" profile (1.04 s).
    pub const LOW_LATENCY: Self = Self {
        chunk: 9,
        right_context: 4,
        fifo: 264,
        update_period: 222,
    };
    /// Listen-mode profile: 2.0 s chunks + 0.56 s look-ahead (2.56 s input latency).
    /// Caption rows commit on a 12–20 s roll and the turn splitter already tolerates
    /// a lagging diarizer, so a few seconds of label latency cost nothing visible,
    /// while each step's 396 tokens per 2 s of audio (vs `LOW_LATENCY`'s 541 per
    /// 0.72 s) cut encoder work ~3.8× so it can ride alongside live STT.
    pub const LIVE: Self = Self {
        chunk: 25,
        right_context: 7,
        fifo: 100,
        update_period: 100,
    };

    pub fn latency_sec(&self) -> f64 {
        ((self.chunk + self.right_context) * SUBSAMPLING) as f64 * FRAME_SEC
    }
}

/// One labeled span of the session timeline.
#[derive(Clone, Debug, PartialEq)]
pub struct SpeakerSegment {
    pub start: f64,
    pub end: f64,
    /// Speaker channel (0-based, arrival order, stable for the session).
    pub speaker: i32,
}

// ---------------------------------------------------------------------------
// Incremental log-mel featurizer.
// ---------------------------------------------------------------------------

/// Streaming NeMo log-mel. Mel frame `t` is centered on sample `t·160` and reads the
/// pre-emphasized samples `[t·160 − 256, t·160 + 256)` (zeros before the start), so it
/// is emitted as soon as those samples exist — identical to the full-utterance
/// `center=True` featurizer except for the frames `finish` pads past the true end,
/// exactly as the full pass does.
struct MelStream {
    window: Vec<f32>,
    /// Slaney filterbank, row-major `(N_FREQS, N_MELS)`.
    filterbank: Vec<f32>,
    fft: Arc<dyn Fft<f32>>,
    fft_buf: Vec<Complex32>,
    /// Pre-emphasized samples starting at absolute sample `buf_base`.
    buf: Vec<f32>,
    buf_base: usize,
    prev_raw: Option<f32>,
    num_samples: usize,
    next_frame: usize,
}

impl MelStream {
    fn new() -> Self {
        use std::f32::consts::PI;
        let mut window = vec![0f32; N_FFT];
        let pad = (N_FFT - WIN) / 2;
        for k in 0..WIN {
            // numpy.hanning(400) — symmetric, zero-padded and centered to 512.
            window[pad + k] = 0.5 - 0.5 * (2.0 * PI * k as f32 / (WIN as f32 - 1.0)).cos();
        }
        let fb = crate::winstt::stt::families::frontend::build_nemo_mel_filterbank(N_MELS);
        let filterbank = fb.iter().copied().collect();
        Self {
            window,
            filterbank,
            fft: FftPlanner::<f32>::new().plan_fft_forward(N_FFT),
            fft_buf: vec![Complex32::new(0.0, 0.0); N_FFT],
            buf: Vec::new(),
            buf_base: 0,
            prev_raw: None,
            num_samples: 0,
            next_frame: 0,
        }
    }

    fn reset(&mut self) {
        self.buf.clear();
        self.buf_base = 0;
        self.prev_raw = None;
        self.num_samples = 0;
        self.next_frame = 0;
    }

    /// Append raw samples; push every newly complete mel frame onto `out` (row-major).
    fn push(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        self.buf.reserve(samples.len());
        for &x in samples {
            let y = match self.prev_raw {
                Some(prev) => x - PREEMPHASIS * prev,
                None => x, // y[0] = x[0]
            };
            self.prev_raw = Some(x);
            self.buf.push(y);
        }
        self.num_samples += samples.len();
        while self.next_frame * HOP + N_FFT / 2 <= self.num_samples {
            self.emit_frame(out);
        }
        self.trim();
    }

    /// End of stream: emit the remaining `1 + n/160` frames (zero-padded past the
    /// end like `center=True`), the very last one zeroed — the reference featurizer's
    /// attention mask always marks it invalid. Returns the total frame count.
    fn finish(&mut self, out: &mut Vec<f32>) -> usize {
        let total = 1 + self.num_samples / HOP;
        while self.next_frame + 1 < total {
            self.emit_frame(out);
        }
        if self.next_frame < total {
            out.extend(std::iter::repeat_n(0.0, N_MELS));
            self.next_frame += 1;
        }
        total
    }

    fn emit_frame(&mut self, out: &mut Vec<f32>) {
        let first = (self.next_frame * HOP) as isize - (N_FFT / 2) as isize;
        for (i, slot) in self.fft_buf.iter_mut().enumerate() {
            let abs = first + i as isize;
            let x = if abs < self.buf_base as isize {
                0.0 // before the stream start (centered padding)
            } else {
                self.buf
                    .get(abs as usize - self.buf_base)
                    .copied()
                    .unwrap_or(0.0) // past the end (only reachable from `finish`)
            };
            *slot = Complex32::new(x * self.window[i], 0.0);
        }
        self.fft.process(&mut self.fft_buf);
        let base = out.len();
        out.resize(base + N_MELS, 0.0);
        let row = &mut out[base..];
        for (f, c) in self.fft_buf.iter().take(N_FREQS).enumerate() {
            let p = c.re * c.re + c.im * c.im;
            let weights = &self.filterbank[f * N_MELS..(f + 1) * N_MELS];
            for (acc, &w) in row.iter_mut().zip(weights) {
                *acc += p * w;
            }
        }
        for v in row.iter_mut() {
            *v = (*v + LOG_GUARD).ln();
        }
        self.next_frame += 1;
    }

    /// Keep only the samples the next frame can still read.
    fn trim(&mut self) {
        let keep_from = (self.next_frame * HOP).saturating_sub(N_FFT / 2);
        if keep_from > self.buf_base {
            let drop = (keep_from - self.buf_base).min(self.buf.len());
            self.buf.drain(..drop);
            self.buf_base += drop;
        }
    }
}

// ---------------------------------------------------------------------------
// Arrival-order speaker cache + FIFO.
// ---------------------------------------------------------------------------

fn sigmoid(x: f32) -> f32 {
    let z = (-x.abs()).exp();
    if x >= 0.0 {
        1.0 / (1.0 + z)
    } else {
        z / (1.0 + z)
    }
}

/// Indices of the `k` largest `scores`, ties broken toward the lower index (the
/// reference port's deterministic replacement for torch's unspecified tie order).
fn stable_topk(scores: &[f32], k: usize) -> Vec<usize> {
    let mut order: Vec<usize> = (0..scores.len()).collect();
    order.sort_by(|&a, &b| {
        scores[b]
            .partial_cmp(&scores[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    order.truncate(k);
    order
}

/// Port of `Nemotron3DiarizationSpeakerCache` (batch 1): `embeds`/`probs` hold the
/// speaker cache (≤ 264 frames), `fifo` the most recent un-cached frames.
struct SpeakerCache {
    fifo_len: usize,
    update_period: usize,
    min_positive: usize,
    strong_boosted: usize,
    weak_boosted: usize,
    silence: Vec<f32>,
    embeds: Vec<f32>,
    probs: Vec<f32>,
    fifo: Vec<f32>,
    is_compressed: bool,
}

impl SpeakerCache {
    fn new(profile: StreamingProfile, silence: Vec<f32>) -> Self {
        let budget = (SPKCACHE_LEN / MAX_SPEAKERS - SILENCE_FRAMES_PER_SPEAKER) as f64;
        Self {
            fifo_len: profile.fifo,
            update_period: profile.update_period,
            min_positive: (budget * MIN_POSITIVE_SCORES_RATE).floor() as usize,
            strong_boosted: (budget * STRONG_BOOST_RATE).floor() as usize,
            weak_boosted: (budget * WEAK_BOOST_RATE).floor() as usize,
            silence,
            embeds: Vec::new(),
            probs: Vec::new(),
            fifo: Vec::new(),
            is_compressed: false,
        }
    }

    fn reset(&mut self) {
        self.embeds.clear();
        self.probs.clear();
        self.fifo.clear();
        self.is_compressed = false;
    }

    fn num_cache(&self) -> usize {
        self.embeds.len() / HIDDEN
    }

    fn num_fifo(&self) -> usize {
        self.fifo.len() / HIDDEN
    }

    /// Context for the next step: cache ++ FIFO embeddings, `(frames, 512)` row-major.
    fn context(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.embeds.len() + self.fifo.len());
        out.extend_from_slice(&self.embeds);
        out.extend_from_slice(&self.fifo);
        out
    }

    /// `input_embeds`: the step's full embeds (context ++ chunk ++ look-ahead);
    /// `logits`: its 10 ms logits; `num_chunk_frames`: encoder frames that join the FIFO.
    fn update(&mut self, input_embeds: &[f32], logits: &[f32], num_chunk_frames: usize) {
        let num_cache = self.num_cache();
        let num_fifo = self.num_fifo();
        // Speaker probabilities at the encoder frame rate (avg-pool 8 of the sigmoids).
        let pooled_frames = logits.len() / (SUBSAMPLING * MAX_SPEAKERS);
        let mut probs = vec![0f32; pooled_frames * MAX_SPEAKERS];
        for (f, row) in probs.chunks_exact_mut(MAX_SPEAKERS).enumerate() {
            for (s, slot) in row.iter_mut().enumerate() {
                let mut acc = 0f32;
                for k in 0..SUBSAMPLING {
                    acc += sigmoid(logits[(f * SUBSAMPLING + k) * MAX_SPEAKERS + s]);
                }
                *slot = acc / SUBSAMPLING as f32;
            }
        }

        let chunk_start = num_cache + num_fifo;
        let mut fifo = std::mem::take(&mut self.fifo);
        fifo.extend_from_slice(
            &input_embeds[chunk_start * HIDDEN..(chunk_start + num_chunk_frames) * HIDDEN],
        );
        let fifo_frames = fifo.len() / HIDDEN;

        let popped = if fifo_frames <= self.fifo_len {
            0
        } else {
            self.update_period
                .max(fifo_frames - self.fifo_len)
                .min(fifo_frames)
        };
        if popped > 0 {
            let mut cache_embeds = std::mem::take(&mut self.embeds);
            cache_embeds.extend_from_slice(&fifo[..popped * HIDDEN]);
            let mut cache_probs = if self.is_compressed {
                std::mem::take(&mut self.probs)
            } else {
                probs[..num_cache * MAX_SPEAKERS].to_vec()
            };
            cache_probs.extend_from_slice(
                &probs[num_cache * MAX_SPEAKERS..(num_cache + popped) * MAX_SPEAKERS],
            );
            fifo.drain(..popped * HIDDEN);
            if cache_embeds.len() / HIDDEN > SPKCACHE_LEN {
                (cache_embeds, cache_probs) = self.compress(&cache_embeds, &cache_probs);
                self.is_compressed = true;
            }
            self.embeds = cache_embeds;
            self.probs = cache_probs;
        }
        self.fifo = fifo;
    }

    /// Per-frame, per-speaker importance (`_get_frame_scores`): log-likelihood ratio
    /// of "only this speaker" vs silence; non-speech frames −∞, and non-positive
    /// frames −∞ for speakers with enough positive ones.
    fn frame_scores(&self, probs: &[f32]) -> Vec<f32> {
        let n = probs.len() / MAX_SPEAKERS;
        let ln_half = 0.5f32.ln();
        let mut scores = vec![0f32; probs.len()];
        for f in 0..n {
            let row = &probs[f * MAX_SPEAKERS..(f + 1) * MAX_SPEAKERS];
            let log_comp: Vec<f32> = row
                .iter()
                .map(|&p| (1.0 - p).max(PRED_SCORE_THRESHOLD).ln())
                .collect();
            let sum_comp: f32 = log_comp.iter().sum();
            for s in 0..MAX_SPEAKERS {
                let p = row[s];
                scores[f * MAX_SPEAKERS + s] = if p > 0.5 {
                    p.max(PRED_SCORE_THRESHOLD).ln() - log_comp[s] + sum_comp - ln_half
                } else {
                    f32::NEG_INFINITY
                };
            }
        }
        for s in 0..MAX_SPEAKERS {
            let positives = (0..n)
                .filter(|&f| scores[f * MAX_SPEAKERS + s] > 0.0)
                .count();
            if positives >= self.min_positive {
                for f in 0..n {
                    let v = &mut scores[f * MAX_SPEAKERS + s];
                    if probs[f * MAX_SPEAKERS + s] > 0.5 && *v <= 0.0 {
                        *v = f32::NEG_INFINITY;
                    }
                }
            }
        }
        scores
    }

    /// Keep the `SPKCACHE_LEN` most important frames (`_compress`): per-speaker
    /// top-k boosts, one +∞ silence frame per speaker, then a global top-k over the
    /// speaker-major flattened scores, re-sorted into time order.
    fn compress(&self, embeds: &[f32], probs: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let n = probs.len() / MAX_SPEAKERS;
        let mut scores = self.frame_scores(probs);
        for v in scores.iter_mut().skip(SPKCACHE_LEN * MAX_SPEAKERS) {
            *v += LATEST_FRAMES_SCORE_BOOST;
        }
        let ln_half = 0.5f32.ln();
        for (k, boost) in [
            (self.strong_boosted, -2.0 * ln_half),
            (self.weak_boosted, -ln_half),
        ] {
            if k == 0 {
                continue;
            }
            for s in 0..MAX_SPEAKERS {
                let column: Vec<f32> = (0..n).map(|f| scores[f * MAX_SPEAKERS + s]).collect();
                for f in stable_topk(&column, k.min(n)) {
                    scores[f * MAX_SPEAKERS + s] += boost;
                }
            }
        }
        // Speaker-major flatten with the +∞ silence frame(s) appended per speaker.
        let scored = n + SILENCE_FRAMES_PER_SPEAKER;
        let mut flat = vec![f32::INFINITY; scored * MAX_SPEAKERS];
        for s in 0..MAX_SPEAKERS {
            for f in 0..n {
                flat[s * scored + f] = scores[f * MAX_SPEAKERS + s];
            }
        }
        let sentinel = scored * MAX_SPEAKERS;
        let mut picked: Vec<usize> = stable_topk(&flat, SPKCACHE_LEN)
            .into_iter()
            .map(|i| {
                if flat[i] == f32::NEG_INFINITY {
                    sentinel
                } else {
                    i
                }
            })
            .collect();
        picked.sort_unstable();

        let mut out_embeds = Vec::with_capacity(SPKCACHE_LEN * HIDDEN);
        let mut out_probs = Vec::with_capacity(SPKCACHE_LEN * MAX_SPEAKERS);
        for idx in picked {
            let frame = if idx == sentinel {
                n
            } else {
                (idx % scored).min(n)
            };
            if frame == n {
                out_embeds.extend_from_slice(&self.silence);
                out_probs.extend(std::iter::repeat_n(0.0, MAX_SPEAKERS));
            } else {
                out_embeds.extend_from_slice(&embeds[frame * HIDDEN..(frame + 1) * HIDDEN]);
                out_probs
                    .extend_from_slice(&probs[frame * MAX_SPEAKERS..(frame + 1) * MAX_SPEAKERS]);
            }
        }
        (out_embeds, out_probs)
    }
}

// ---------------------------------------------------------------------------
// Probabilities → timeline.
// ---------------------------------------------------------------------------

/// Per-speaker thresholded activity at 10 ms, with same-speaker gap bridging and a
/// minimum segment length, folded into session-clock segments.
#[derive(Default)]
struct Timeline {
    committed: Vec<SpeakerSegment>,
    /// Per speaker: the open (possibly still growing) run as `[start, end)` frames.
    open: [Option<(usize, usize)>; MAX_SPEAKERS],
    seen: [bool; MAX_SPEAKERS],
}

impl Timeline {
    fn reset(&mut self) {
        *self = Self::default();
    }

    /// Fold frame `t`'s probabilities (`MAX_SPEAKERS` values) in.
    fn push_frame(&mut self, t: usize, probs: &[f32], anchor: f64) {
        for (s, &p) in probs.iter().enumerate().take(MAX_SPEAKERS) {
            if p <= ACTIVITY_THRESHOLD {
                continue;
            }
            match &mut self.open[s] {
                Some((_, end)) if t <= *end + BRIDGE_GAP_FRAMES => *end = t + 1,
                slot => {
                    if let Some((a, b)) = slot.take() {
                        Self::commit(&mut self.committed, &mut self.seen, s, a, b, anchor);
                    }
                    *slot = Some((t, t + 1));
                }
            }
        }
    }

    fn commit(
        committed: &mut Vec<SpeakerSegment>,
        seen: &mut [bool; MAX_SPEAKERS],
        speaker: usize,
        start: usize,
        end: usize,
        anchor: f64,
    ) {
        if end - start < MIN_SEGMENT_FRAMES {
            return;
        }
        seen[speaker] = true;
        committed.push(SpeakerSegment {
            start: anchor + start as f64 * FRAME_SEC,
            end: anchor + end as f64 * FRAME_SEC,
            speaker: speaker as i32,
        });
    }

    fn speaker_count(&self) -> usize {
        (0..MAX_SPEAKERS)
            .filter(|&s| {
                self.seen[s] || self.open[s].is_some_and(|(a, b)| b - a >= MIN_SEGMENT_FRAMES)
            })
            .count()
    }

    fn prune_before(&mut self, cutoff: f64) {
        if cutoff > 0.0 {
            self.committed.retain(|s| s.end >= cutoff);
        }
    }

    fn snapshot(&self, anchor: f64) -> Vec<SpeakerSegment> {
        let mut out = self.committed.clone();
        for (s, open) in self.open.iter().enumerate() {
            if let Some((a, b)) = *open
                && b - a >= MIN_SEGMENT_FRAMES
            {
                out.push(SpeakerSegment {
                    start: anchor + a as f64 * FRAME_SEC,
                    end: anchor + b as f64 * FRAME_SEC,
                    speaker: s as i32,
                });
            }
        }
        out.sort_by(|a, b| {
            a.start
                .partial_cmp(&b.start)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.speaker.cmp(&b.speaker))
        });
        out
    }
}

// ---------------------------------------------------------------------------
// constants.npz
// ---------------------------------------------------------------------------

/// Read one array from an `np.savez` archive (stored entries) as raw little-endian
/// bytes plus its header dict.
fn read_npy(npz: &Path, name: &str) -> Result<(String, Vec<u8>), String> {
    use std::io::Read;
    let file = std::fs::File::open(npz).map_err(|e| format!("open {}: {e}", npz.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("npz {name}: {e}"))?;
    let mut entry = archive
        .by_name(&format!("{name}.npy"))
        .map_err(|e| format!("npz entry {name}: {e}"))?;
    let mut bytes = Vec::new();
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| format!("npz read {name}: {e}"))?;
    if bytes.len() < 10 || &bytes[..6] != b"\x93NUMPY" {
        return Err(format!("npz {name}: not a .npy entry"));
    }
    let (header_len, offset) = match bytes[6] {
        1 => (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10),
        _ if bytes.len() >= 12 => (
            u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize,
            12,
        ),
        _ => return Err(format!("npz {name}: truncated header")),
    };
    let data_start = offset + header_len;
    if bytes.len() < data_start {
        return Err(format!("npz {name}: truncated"));
    }
    let header = String::from_utf8_lossy(&bytes[offset..data_start]).into_owned();
    Ok((header, bytes[data_start..].to_vec()))
}

/// `silence_embeds` (512 × f32) after checking the export's geometry constants
/// match the ones this engine is compiled against.
fn load_constants(npz: &Path) -> Result<Vec<f32>, String> {
    for (name, expected) in [
        ("hidden_size", HIDDEN),
        ("num_speakers", MAX_SPEAKERS),
        ("subsampling_factor", SUBSAMPLING),
        ("speaker_cache_length", SPKCACHE_LEN),
        (
            "speaker_cache_silence_frames_per_speaker",
            SILENCE_FRAMES_PER_SPEAKER,
        ),
    ] {
        let (header, data) = read_npy(npz, name)?;
        if !header.contains("'<i8'") || data.len() != 8 {
            return Err(format!("constants.npz {name}: unexpected dtype ({header})"));
        }
        let value = i64::from_le_bytes(data[..8].try_into().map_err(|_| "npz int")?);
        if value != expected as i64 {
            return Err(format!(
                "constants.npz {name} = {value}, engine expects {expected}"
            ));
        }
    }
    let (header, data) = read_npy(npz, "silence_embeds")?;
    if !header.contains("'<f4'") || data.len() != HIDDEN * 4 {
        return Err(format!(
            "constants.npz silence_embeds: unexpected layout ({header})"
        ));
    }
    Ok(data
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

// ---------------------------------------------------------------------------
// The engine.
// ---------------------------------------------------------------------------

pub struct NemotronDiarizer {
    session: Session,
    profile: StreamingProfile,
    mel: MelStream,
    cache: SpeakerCache,
    timeline: Timeline,

    /// Session-clock time of mel frame 0 (the first accepted chunk's start).
    anchor: Option<f64>,
    /// Session-clock time just past the last accepted sample.
    session_end: f64,
    /// Mel frames from absolute frame `mel_base` onward, row-major `(_, 128)`.
    mel_frames: Vec<f32>,
    mel_base: usize,
    /// First encoder frame of the next chunk.
    next_chunk: usize,
    finished: bool,
    /// Mel-frame bound on emitted rows: unbounded while streaming, `1 + n/160` once
    /// `finish` has padded the tail.
    emit_limit: usize,
    chunks_processed: u64,
    /// Optional per-10 ms probability log (parity tooling only).
    probs_log: Option<Vec<f32>>,
}

impl NemotronDiarizer {
    /// Build the step session from `model.int8.onnx` / `model.onnx` plus the export's
    /// `constants.npz`, then warm it with one dummy chunk.
    pub fn new(
        model: &Path,
        constants: &Path,
        profile: StreamingProfile,
        accelerator: Accelerator,
        intra_threads: usize,
    ) -> Result<Self, String> {
        use ort::session::builder::GraphOptimizationLevel;

        let silence = load_constants(constants)?;
        let dml = accelerator == Accelerator::DirectMl;
        let session = crate::winstt::stt::configure_session(
            GraphOptimizationLevel::Level3,
            Some(intra_threads.max(1)),
            dml,
            Some(&[accelerator]),
        )?
        .commit_from_file(model)
        .map_err(|e| format!("diarize session ({}): {e}", model.display()))?;
        for want in [
            "chunk_mel",
            "chunk_mel_length",
            "context_embeds",
            "context_length",
        ] {
            if !session.inputs().iter().any(|i| i.name() == want) {
                return Err(format!("diarize model has no `{want}` input"));
            }
        }
        let mut engine = Self {
            session,
            profile,
            mel: MelStream::new(),
            cache: SpeakerCache::new(profile, silence),
            timeline: Timeline::default(),
            anchor: None,
            session_end: 0.0,
            mel_frames: Vec::new(),
            mel_base: 0,
            next_chunk: 0,
            finished: false,
            emit_limit: usize::MAX,
            chunks_processed: 0,
            probs_log: None,
        };
        engine.warm()?;
        Ok(engine)
    }

    /// One full-geometry step with a full context so the first live chunk doesn't
    /// pay graph-initialization latency.
    fn warm(&mut self) -> Result<(), String> {
        let mel_len = (self.profile.chunk + self.profile.right_context) * SUBSAMPLING;
        let mel = vec![-16.0f32; mel_len * N_MELS];
        let context = vec![0.0f32; (SPKCACHE_LEN + self.profile.fifo) * HIDDEN];
        self.run_step(&mel, mel_len, &context)?;
        Ok(())
    }

    pub fn profile(&self) -> StreamingProfile {
        self.profile
    }

    /// Record every emitted 10 ms probability row (parity tooling).
    pub fn record_probabilities(&mut self, on: bool) {
        self.probs_log = on.then(Vec::new);
    }

    /// The recorded `(frames, 8)` probabilities, row-major.
    pub fn recorded_probabilities(&self) -> &[f32] {
        self.probs_log.as_deref().unwrap_or(&[])
    }

    /// Reset all per-session state (a new Listen session starts).
    pub fn reset(&mut self) {
        self.mel.reset();
        self.cache.reset();
        self.timeline.reset();
        self.anchor = None;
        self.session_end = 0.0;
        self.mel_frames.clear();
        self.mel_base = 0;
        self.next_chunk = 0;
        self.finished = false;
        self.emit_limit = usize::MAX;
        self.chunks_processed = 0;
        if let Some(log) = &mut self.probs_log {
            log.clear();
        }
    }

    /// Distinct speakers that have produced a kept segment this session.
    pub fn speaker_count(&self) -> usize {
        self.timeline.speaker_count()
    }

    pub fn chunks_processed(&self) -> u64 {
        self.chunks_processed
    }

    /// Ingest one 16 kHz mono chunk covering `[abs_time_sec, abs_time_sec + len/SR)`.
    /// A forward gap vs the expected continuation is zero-filled so dropped audio
    /// reads as silence instead of shifting later frames in time.
    pub fn accept_audio(&mut self, chunk: &[f32], abs_time_sec: f64) {
        if chunk.is_empty() || self.finished {
            return;
        }
        let anchor = *self.anchor.get_or_insert(abs_time_sec);
        let expected = anchor + self.mel.num_samples as f64 / SR as f64;
        let gap = ((abs_time_sec - expected) * SR as f64).round();
        if gap >= 1.0 {
            let zeros = vec![0.0f32; gap as usize];
            self.mel.push(&zeros, &mut self.mel_frames);
        }
        self.mel.push(chunk, &mut self.mel_frames);
        self.session_end = anchor + self.mel.num_samples as f64 / SR as f64;
    }

    /// Run every chunk whose audio + look-ahead has fully arrived. Returns how many ran.
    pub fn process_ready_chunks(&mut self) -> Result<usize, String> {
        let mut ran = 0;
        let step = self.profile.chunk;
        let right_context = self.profile.right_context;
        let need = |start: usize| (start + step + right_context) * SUBSAMPLING;
        while !self.finished && need(self.next_chunk) <= self.mel.next_frame {
            let start = self.next_chunk;
            let mel_len = need(start) - start * SUBSAMPLING;
            self.step(start, step, mel_len, mel_len)?;
            ran += 1;
        }
        if ran > 0 {
            self.timeline
                .prune_before(self.session_end - TIMELINE_KEEP_SEC);
        }
        Ok(ran)
    }

    /// End of stream: pad like a full-utterance pass and score every remaining frame
    /// (the offline loop's tail). Further audio is ignored until `reset`.
    pub fn finish(&mut self) -> Result<usize, String> {
        if self.finished || self.anchor.is_none() {
            return Ok(0);
        }
        let mut ran = self.process_ready_chunks()?;
        let total_mel = self.mel.finish(&mut self.mel_frames);
        let valid_mel = total_mel - 1;
        self.emit_limit = total_mel;
        let num_embeds = total_mel.div_ceil(SUBSAMPLING);
        while self.next_chunk < num_embeds {
            let start = self.next_chunk;
            let end = (start + self.profile.chunk).min(num_embeds);
            let mel_end = ((end + self.profile.right_context) * SUBSAMPLING).min(total_mel);
            let mel_len = mel_end - start * SUBSAMPLING;
            let valid_len = mel_end.min(valid_mel).saturating_sub(start * SUBSAMPLING);
            self.step(start, end - start, mel_len, valid_len)?;
            ran += 1;
        }
        self.finished = true;
        Ok(ran)
    }

    /// Snapshot of the session timeline (kept segments, including in-progress runs).
    pub fn timeline_snapshot(&self) -> Vec<SpeakerSegment> {
        self.timeline.snapshot(self.anchor.unwrap_or(0.0))
    }

    /// One encoder step over chunk `[start, start + num_frames)` (encoder frames),
    /// fed `mel_len` mel frames of which `valid_len` are real.
    fn step(
        &mut self,
        start: usize,
        num_frames: usize,
        mel_len: usize,
        valid_len: usize,
    ) -> Result<(), String> {
        let mel_start = start * SUBSAMPLING;
        let lo = (mel_start - self.mel_base) * N_MELS;
        let chunk_mel = self.mel_frames[lo..lo + mel_len * N_MELS].to_vec();
        let context = self.cache.context();
        let context_frames = context.len() / HIDDEN;
        let (logits, embeds) = self.run_step(&chunk_mel, valid_len, &context)?;
        self.cache.update(&embeds, &logits, num_frames);

        // Chunk frames' 10 ms probabilities → timeline. Only the tail chunks scored
        // by `finish` can run past the end: the reference keeps `1 + n/160` rows
        // (logged for parity); the trailing invalid frame stays off the timeline.
        let anchor = self.anchor.unwrap_or(0.0);
        let first = context_frames * SUBSAMPLING;
        let rows = (num_frames * SUBSAMPLING).min(self.emit_limit.saturating_sub(mel_start));
        let mut probs = [0f32; MAX_SPEAKERS];
        for r in 0..rows {
            let base = (first + r) * MAX_SPEAKERS;
            for (s, p) in probs.iter_mut().enumerate() {
                *p = sigmoid(logits[base + s]);
            }
            if mel_start + r + 1 < self.emit_limit {
                self.timeline.push_frame(mel_start + r, &probs, anchor);
            }
            if let Some(log) = &mut self.probs_log {
                log.extend_from_slice(&probs);
            }
        }

        self.next_chunk = start + num_frames;
        self.chunks_processed += 1;
        // Mel frames before the next chunk are never read again.
        let keep_from = self.next_chunk * SUBSAMPLING;
        if keep_from > self.mel_base {
            let drop = ((keep_from - self.mel_base) * N_MELS).min(self.mel_frames.len());
            self.mel_frames.drain(..drop);
            self.mel_base += drop / N_MELS;
        }
        Ok(())
    }

    fn run_step(
        &mut self,
        chunk_mel: &[f32],
        valid_len: usize,
        context: &[f32],
    ) -> Result<(Vec<f32>, Vec<f32>), String> {
        let mel_len = chunk_mel.len() / N_MELS;
        let context_len = context.len() / HIDDEN;
        let mel = Array3::from_shape_vec((1, mel_len, N_MELS), chunk_mel.to_vec())
            .map_err(|e| format!("mel shape: {e}"))?;
        let ctx = Array3::from_shape_vec((1, context_len, HIDDEN), context.to_vec())
            .map_err(|e| format!("context shape: {e}"))?;
        fn to_err(what: &'static str) -> impl Fn(ort::Error) -> String {
            move |e| format!("diarize {what}: {e}")
        }
        let inputs = ort::inputs![
            "chunk_mel" => Tensor::from_array(mel).map_err(to_err("mel tensor"))?,
            "chunk_mel_length" => Tensor::from_array(Array0::from_elem((), valid_len as i64))
                .map_err(to_err("mel length"))?,
            "context_embeds" => Tensor::from_array(ctx).map_err(to_err("context tensor"))?,
            "context_length" => Tensor::from_array(Array0::from_elem((), context_len as i64))
                .map_err(to_err("context length"))?,
        ];
        let outputs = self.session.run(inputs).map_err(to_err("run"))?;
        let (_, logits) = outputs["logits"]
            .try_extract_tensor::<f32>()
            .map_err(to_err("logits"))?;
        let (_, embeds) = outputs["embeds"]
            .try_extract_tensor::<f32>()
            .map_err(to_err("embeds"))?;
        let enc_frames = context_len + mel_len.div_ceil(SUBSAMPLING);
        if logits.len() != enc_frames * SUBSAMPLING * MAX_SPEAKERS
            || embeds.len() != enc_frames * HIDDEN
        {
            return Err(format!(
                "diarize output shape mismatch: logits {} embeds {} for {enc_frames} frames",
                logits.len(),
                embeds.len()
            ));
        }
        Ok((logits.to_vec(), embeds.to_vec()))
    }
}

// ---------------------------------------------------------------------------
// Span queries over a timeline snapshot (Listen-mode caption labeling).
// ---------------------------------------------------------------------------

/// Majority speaker (by labeled overlap duration) over `[start, end]` of a timeline
/// snapshot. Unknown (-1) spans never vote. Returns `None` when nothing labeled
/// overlaps the span.
pub fn dominant_speaker(segments: &[SpeakerSegment], start: f64, end: f64) -> Option<i32> {
    let votes = speaker_votes(segments, start, end);
    votes
        .into_iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(speaker, _)| speaker)
}

/// When `[start, end]` contains a speaker TURN — at least two distinct labeled
/// speakers each overlapping the span by ≥ `min_each_sec` — returns the boundary
/// time: the earliest in-span start of a qualifying segment belonging to a
/// DIFFERENT speaker than the span's first qualifying voice. The listen consumer
/// splits the caption at this time (commit the prefix under the first speaker,
/// keep the suffix live), so rows separate per speaker instead of mixing two voices
/// into one majority-labeled block. `None` while the span is single-voiced.
pub fn span_turn_boundary(
    segments: &[SpeakerSegment],
    start: f64,
    end: f64,
    min_each_sec: f64,
) -> Option<f64> {
    let votes = speaker_votes(segments, start, end);
    let qualified: std::collections::BTreeSet<i32> = votes
        .iter()
        .filter(|&(_, &sec)| sec >= min_each_sec)
        .map(|(&speaker, _)| speaker)
        .collect();
    if qualified.len() < 2 {
        return None;
    }
    // Earliest in-span start per qualifying speaker.
    let mut earliest: std::collections::BTreeMap<i32, f64> = Default::default();
    for seg in segments {
        if !qualified.contains(&seg.speaker) {
            continue;
        }
        let ov = seg.end.min(end) - seg.start.max(start);
        if ov <= 0.0 {
            continue;
        }
        let in_span_start = seg.start.max(start);
        earliest
            .entry(seg.speaker)
            .and_modify(|t| *t = t.min(in_span_start))
            .or_insert(in_span_start);
    }
    let (&first_speaker, _) = earliest
        .iter()
        .min_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))?;
    earliest
        .iter()
        .filter(|&(&speaker, _)| speaker != first_speaker)
        .map(|(_, &t)| t)
        .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
}

/// Labeled overlap seconds per speaker over `[start, end]` (unknown never votes).
fn speaker_votes(
    segments: &[SpeakerSegment],
    start: f64,
    end: f64,
) -> std::collections::BTreeMap<i32, f64> {
    let mut votes: std::collections::BTreeMap<i32, f64> = std::collections::BTreeMap::new();
    for seg in segments {
        if seg.speaker < 0 {
            continue;
        }
        let ov = seg.end.min(end) - seg.start.max(start);
        if ov > 0.0 {
            *votes.entry(seg.speaker).or_insert(0.0) += ov;
        }
    }
    votes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winstt::stt::families::frontend::{
        NemoNorm, build_nemo_mel_filterbank, nemo_features_with_normalization,
    };

    fn seg(start: f64, end: f64, speaker: i32) -> SpeakerSegment {
        SpeakerSegment {
            start,
            end,
            speaker,
        }
    }

    /// Deterministic speech-like test signal (chirp + noise-ish harmonics).
    fn signal(n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f32 / SR as f32;
                0.3 * (2.0 * std::f32::consts::PI * (180.0 + 400.0 * t) * t).sin()
                    + 0.05 * ((i * 7919 % 1013) as f32 / 1013.0 - 0.5)
            })
            .collect()
    }

    #[test]
    fn streaming_mel_matches_full_utterance_featurizer() {
        // Tails of 123 and 50 samples past a hop: the last valid frame either streams
        // (its window ends 96 samples past the hop) or has to wait for `finish`.
        for (extra, waits) in [(123usize, false), (50, true)] {
            let x = signal(SR * 3 + extra);
            let reference = nemo_features_with_normalization(
                &x,
                &build_nemo_mel_filterbank(N_MELS),
                NemoNorm::None,
            );
            let mut mel = MelStream::new();
            let mut out = Vec::new();
            // Odd feed sizes exercise the frame-boundary bookkeeping and buffer trimming.
            for piece in x.chunks(337) {
                mel.push(piece, &mut out);
            }
            let streamed = out.len() / N_MELS;
            let total = mel.finish(&mut out);
            assert_eq!(total, 1 + x.len() / HOP);
            assert_eq!(out.len(), total * N_MELS);
            assert_eq!(reference.nrows(), total - 1);
            assert_eq!(streamed + usize::from(waits), reference.nrows());
            let mut max_err = 0f32;
            for t in 0..reference.nrows() {
                for m in 0..N_MELS {
                    max_err = max_err.max((out[t * N_MELS + m] - reference[[t, m]]).abs());
                }
            }
            assert!(max_err < 1e-4, "max |Δ| = {max_err}");
            assert!(out[(total - 1) * N_MELS..].iter().all(|&v| v == 0.0));
        }
    }

    #[test]
    fn stable_topk_breaks_ties_toward_lower_index() {
        let scores = [3.0, 5.0, 3.0, f32::NEG_INFINITY, 5.0, f32::INFINITY];
        assert_eq!(stable_topk(&scores, 4), vec![5, 1, 4, 0]);
    }

    fn cache_for(profile: StreamingProfile) -> SpeakerCache {
        SpeakerCache::new(profile, vec![0.5; HIDDEN])
    }

    /// Embeds whose first value encodes the frame id; logits put `speaker` on.
    fn step_inputs(
        cache: &SpeakerCache,
        n: usize,
        first_id: usize,
        speaker: usize,
    ) -> (Vec<f32>, Vec<f32>) {
        let mut embeds = cache.context();
        for f in 0..n {
            let mut row = vec![0f32; HIDDEN];
            row[0] = (first_id + f) as f32;
            embeds.extend(row);
        }
        let frames = embeds.len() / HIDDEN;
        let mut logits = vec![-8f32; frames * SUBSAMPLING * MAX_SPEAKERS];
        for f in 0..frames {
            for k in 0..SUBSAMPLING {
                logits[(f * SUBSAMPLING + k) * MAX_SPEAKERS + speaker] = 8.0;
            }
        }
        (embeds, logits)
    }

    #[test]
    fn fifo_overflow_moves_frames_into_the_cache() {
        let profile = StreamingProfile {
            chunk: 10,
            right_context: 0,
            fifo: 20,
            update_period: 15,
        };
        let mut cache = cache_for(profile);
        let (e, l) = step_inputs(&cache, 10, 0, 0);
        cache.update(&e, &l, 10);
        assert_eq!((cache.num_cache(), cache.num_fifo()), (0, 10));
        let (e, l) = step_inputs(&cache, 10, 10, 0);
        cache.update(&e, &l, 10);
        assert_eq!((cache.num_cache(), cache.num_fifo()), (0, 20));
        // 30 > fifo 20 → pop max(15, 10) = 15 oldest frames into the cache.
        let (e, l) = step_inputs(&cache, 10, 20, 0);
        cache.update(&e, &l, 10);
        assert_eq!((cache.num_cache(), cache.num_fifo()), (15, 15));
        assert_eq!(cache.embeds[0], 0.0);
        assert_eq!(cache.embeds[14 * HIDDEN], 14.0);
        assert_eq!(cache.fifo[0], 15.0);
        assert!(!cache.is_compressed);
    }

    #[test]
    fn compression_keeps_cache_length_and_silence_for_absent_speakers() {
        let profile = StreamingProfile {
            chunk: 100,
            right_context: 0,
            fifo: 0,
            update_period: 100,
        };
        let mut cache = cache_for(profile);
        for i in 0..4 {
            let (e, l) = step_inputs(&cache, 100, i * 100, i % 2);
            cache.update(&e, &l, 100);
        }
        assert!(cache.is_compressed);
        assert_eq!(cache.num_cache(), SPKCACHE_LEN);
        assert_eq!(cache.num_fifo(), 0);
        // Every speaker slot carries exactly one +∞ silence frame (the silence
        // embedding, all 0.5, zero probabilities); with ≥ 256 scored speech frames
        // nothing else falls back to silence.
        let is_silence = |f: usize| cache.embeds[f * HIDDEN + 1] == 0.5;
        let silence_rows = (0..SPKCACHE_LEN).filter(|&f| is_silence(f)).count();
        assert_eq!(silence_rows, MAX_SPEAKERS);
        for f in (0..SPKCACHE_LEN).filter(|&f| is_silence(f)) {
            assert!(
                cache.probs[f * MAX_SPEAKERS..(f + 1) * MAX_SPEAKERS]
                    .iter()
                    .all(|&p| p == 0.0)
            );
        }
        // The cache is speaker-major (arrival order): speaker 0's kept frames, its
        // silence frame, then speaker 1's — each block in time order. The second
        // compression kept every frame of the newest speaker (latest-frame boost).
        let mut blocks: Vec<Vec<f32>> = vec![Vec::new()];
        for f in 0..SPKCACHE_LEN {
            if is_silence(f) {
                blocks.push(Vec::new());
            } else {
                blocks.last_mut().unwrap().push(cache.embeds[f * HIDDEN]);
            }
        }
        assert!(blocks.iter().all(|b| b.windows(2).all(|w| w[0] < w[1])));
        assert_eq!(
            blocks[1].len(),
            100,
            "speaker 1 = the newest chunk, fully kept"
        );
        assert_eq!(blocks[1][0], 300.0);
        assert_eq!(blocks[0].len(), SPKCACHE_LEN - MAX_SPEAKERS - 100);
    }

    #[test]
    fn frame_scores_reject_non_speech() {
        let cache = cache_for(StreamingProfile::LIVE);
        let mut probs = vec![0.0f32; 2 * MAX_SPEAKERS];
        probs[0] = 0.9; // frame 0: speaker 0 alone
        probs[MAX_SPEAKERS] = 0.4; // frame 1: below 0.5 → non-speech
        let scores = cache.frame_scores(&probs);
        let expected = 0.9f32.ln() - 0.25f32.ln() + 0.25f32.ln() + 7.0 * 1.0f32.ln() - 0.5f32.ln();
        assert!((scores[0] - expected).abs() < 1e-5);
        assert_eq!(scores[MAX_SPEAKERS], f32::NEG_INFINITY);
        assert_eq!(scores[1], f32::NEG_INFINITY);
    }

    #[test]
    fn timeline_bridges_short_gaps_and_drops_slivers() {
        let mut t = Timeline::default();
        let on = |s: usize| {
            let mut p = [0f32; MAX_SPEAKERS];
            p[s] = 0.9;
            p
        };
        let off = [0f32; MAX_SPEAKERS];
        // Speaker 0: 0..50, gap of 10 frames (bridged), 60..100.
        for f in 0..100 {
            let p = if (50..60).contains(&f) { off } else { on(0) };
            t.push_frame(f, &p, 10.0);
        }
        // Speaker 1: a 5-frame blip (dropped), then far later a real turn.
        for f in 100..105 {
            t.push_frame(f, &on(1), 10.0);
        }
        for f in 105..200 {
            t.push_frame(f, &off, 10.0);
        }
        for f in 200..300 {
            t.push_frame(f, &on(1), 10.0);
        }
        let snap = t.snapshot(10.0);
        assert_eq!(snap.len(), 2, "{snap:?}");
        assert_eq!(snap[0].speaker, 0);
        assert!((snap[0].start - 10.0).abs() < 1e-9 && (snap[0].end - 11.0).abs() < 1e-9);
        assert_eq!(snap[1].speaker, 1);
        assert!((snap[1].start - 12.0).abs() < 1e-9 && (snap[1].end - 13.0).abs() < 1e-9);
        assert_eq!(t.speaker_count(), 2);
        // Both runs are still open (no later activity closed them): pruning only
        // ever drops committed history.
        t.prune_before(20.0);
        assert_eq!(t.snapshot(10.0).len(), 2);
        // Speaker 0 speaking again far later commits its first run.
        for f in 300..320 {
            t.push_frame(f, &on(0), 10.0);
        }
        assert_eq!(t.committed.len(), 1);
        t.prune_before(20.0);
        assert!(t.committed.is_empty());
    }

    #[test]
    fn profiles_report_input_latency() {
        assert!((StreamingProfile::OFFLINE.latency_sec() - 30.4).abs() < 1e-9);
        assert!((StreamingProfile::LOW_LATENCY.latency_sec() - 1.04).abs() < 1e-9);
        assert!(StreamingProfile::LIVE.latency_sec() < 3.0);
    }

    #[test]
    fn turn_boundary_requires_two_meaningful_speakers() {
        // Speaker 1 only has 0.3s in-span — below the 0.8s floor → no break yet.
        let segs = vec![seg(0.0, 3.0, 0), seg(3.0, 3.3, 1)];
        assert_eq!(span_turn_boundary(&segs, 0.0, 3.3, 0.8), None);
        // Extend speaker 1 past the floor → boundary at the second voice's start.
        let segs2 = vec![seg(0.0, 3.0, 0), seg(3.0, 4.2, 1)];
        assert_eq!(span_turn_boundary(&segs2, 0.0, 4.2, 0.8), Some(3.0));
        // Same speaker throughout → never a break.
        assert_eq!(span_turn_boundary(&segs2, 0.0, 2.9, 0.8), None);
        // Unknown activity never counts as a second speaker.
        let segs3 = vec![seg(0.0, 3.0, 0), seg(3.0, 5.0, -1)];
        assert_eq!(span_turn_boundary(&segs3, 0.0, 5.0, 0.8), None);
        // A span starting mid-way through speaker 0's turn clamps the boundary
        // to the second voice's in-span start, not its absolute segment start.
        let segs4 = vec![seg(0.0, 6.0, 0), seg(6.0, 8.0, 1)];
        assert_eq!(span_turn_boundary(&segs4, 4.0, 8.0, 0.8), Some(6.0));
        // Overlapped speech (both active) still yields the later voice's entry.
        let segs5 = vec![seg(0.0, 6.0, 0), seg(5.0, 8.0, 1)];
        assert_eq!(span_turn_boundary(&segs5, 0.0, 8.0, 0.8), Some(5.0));
    }

    #[test]
    fn dominant_speaker_votes_by_labeled_overlap() {
        let segs = vec![seg(0.0, 2.0, 0), seg(2.0, 2.5, 1), seg(2.5, 3.0, -1)];
        assert_eq!(dominant_speaker(&segs, 0.0, 3.0), Some(0));
        assert_eq!(dominant_speaker(&segs, 1.9, 2.6), Some(1));
        assert_eq!(dominant_speaker(&segs, 2.5, 3.0), None); // only unknown overlaps
        assert_eq!(dominant_speaker(&segs, 5.0, 6.0), None);
    }
}
