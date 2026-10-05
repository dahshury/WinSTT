// Moonshine v2 streaming ASR ("Ergodic Streaming Encoder", moonshine-ai/moonshine-streaming-*).
//
// Reference: the official C++ runtime (github.com/moonshine-ai/moonshine
// `core/moonshine-streaming-model.cpp`) and its public exporter
// (`language-bindings/python/src/moonshine_voice/lora/export.py`), which split the model into the
// FIVE graphs this engine drives:
//
//   * `frontend.onnx`   : raw 16 kHz PCM chunk + carried state (`sample_buffer` [1,79],
//                         `sample_len` [1], `conv1_buffer` [1,d,4], `conv2_buffer` [1,2d,4],
//                         `frame_count` [1]) → `features` [1,T,d] (50 Hz) + the updated state.
//                         Two causal stride-2 convolutions; carrying their last four input frames
//                         makes chunked output identical to a whole-utterance pass PROVIDED every
//                         chunk is a whole number of 640-sample (8-frame) hops, which keeps both
//                         strides in phase and leaves each convolution its 4 frames of state.
//   * `encoder.onnx`    : features [1,W,d] → encoded [1,W,d]. Sliding-window attention with NO
//                         positional embeddings, windows baked into the graph. Each layer sees
//                         `past` frames behind and `future` frames ahead, so a frame is final once
//                         `total_lookahead` (Σ future) frames follow it, and re-running the encoder
//                         over `[emitted - total_left_context, total)` reproduces the full-utterance
//                         output for the newly stable frames exactly.
//   * `adapter.onnx`    : encoded slice + `pos_offset` → decoder memory (learned absolute positions,
//                         offset by the frames already emitted).
//   * `cross_kv.onnx`   : memory [1,M,dd] → `k_cross`/`v_cross` [depth,1,heads,M,head_dim].
//   * `decoder_kv.onnx` : `token` [1,L] + `k_self`/`v_self` [depth,1,heads,C,head_dim] (C may be 0)
//                         + `out_k_cross`/`out_v_cross` → `logits` [1,L,vocab] + `out_k_self`/
//                         `out_v_self` (the cross K/V pass straight through and are NOT requested).
//
// Decoding follows the C++ runtime: whenever the memory grows the transcript is re-decoded from
// BOS against the new cross K/V, but speculatively — BOS + the previous hypothesis go through the
// decoder in ONE batched call, the longest prefix whose argmax reproduces the previous tokens is
// accepted, and only the tail is decoded token by token. In steady streaming that is one batched
// call plus a couple of single-token steps per tick.
//
// Long-form: the adapter's learned position table (4096 frames = 82 s) and the model's training
// distribution both bound one decode, so the stream is cut into utterances internally — an energy
// endpointer commits a segment at a pause (a long one while the segment is short, shorter ones as
// it ages) and a 28 s hard cap re-cuts at the quietest point of the last few seconds. Each committed segment's text is
// kept and the model state is reset, exactly like the C++ transcriber's per-line reset. Because
// `transcribe()` runs the same stream over the whole buffer, batch and streaming decodes agree.
//
// Exports: `Masterx/moonshine-streaming-<size>[-<lang>]-ONNX`, produced from the MIT-licensed
// moonshine-ai/moonshine-streaming-* safetensors with the public exporter (plus a per-channel int8
// tier). `streaming_config.json` carries the dims and the baked windows.

use std::borrow::Cow;
use std::path::Path;
use std::time::Instant;

use ort::memory::Allocator;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::{HasSelectedOutputs, OutputSelector, RunOptions, Session, SessionInputValue};
use ort::value::{DynValue, Tensor, TensorRef};

use super::moonshine::MoonshineTokenizer;
use super::{
    Accelerator, EngineConfig, EngineKind, NativeStreamUpdate, SttError, SttResult,
    TranscribeOptions, Transcriber, Transcription, configure_session,
    num_cpus_best_effort as num_cpus, provider_label,
};

const SAMPLE_RATE: usize = 16_000;
/// Analysis/feed hop: 40 ms = 8 frontend frames = two 50 Hz encoder features. The frontend must be
/// fed whole hops: the frame count has to be a multiple of 4 to keep both stride-2 convolutions in
/// phase across calls, and at least 8 so each convolution leaves the 4 frames of state the next
/// call expects (a 4-frame call would hand back a 2-frame `conv2_buffer`).
const HOP: usize = 640;
/// Endpointer frames per second (one per hop).
const HOPS_PER_SECOND: usize = SAMPLE_RATE / HOP;
/// Seconds of audio per encoder feature (50 Hz).
const FEATURE_SECONDS: f32 = 0.02;
/// The C++ runtime's token budget: ~6.5 tokens per second of audio.
const TOKENS_PER_SECOND: f32 = 6.5;
/// Absolute ceiling on one segment's decode (the C++ transcriber caps at 256 as well).
const MAX_TOKENS: usize = 256;
/// Re-decode only when at least this many new memory frames (100 ms) arrived since the last decode;
/// the encoder/adapter still run every tick, so nothing is lost — the text simply refreshes at
/// ≤ 10 Hz instead of once per caller tick.
const DECODE_MIN_NEW_FRAMES: usize = 5;
/// Live (speculative) decodes may use at most this share of real time: the next one waits until
/// the audio that arrived since the last covers `last decode wall time / duty`. A live re-decode
/// costs more as the segment grows (up to the 28 s cap), and without this a bigger model on a slow
/// CPU falls behind the microphone. Only the refresh rate of the live text changes; committed text
/// is always a full decode.
const LIVE_DECODE_MAX_DUTY: f32 = 0.5;

/// Endpointer tuning (40 ms frames). Segments are kept LONG: the decoder only sees its own
/// segment, so cutting at every breath costs accuracy (measured on FLEURS Japanese: cutting at
/// 0.6 s pauses after 1 s doubled the CER of a whole-utterance decode, mostly from mid-sentence
/// cuts and "thank you" hallucinations on noise-only slivers). A segment of at least
/// `MIN_SEGMENT_FRAMES` is committed after a `LONG_PAUSE_FRAMES` silence; past `SOFT_CAP_FRAMES`
/// a `PAUSE_FRAMES` silence suffices, past `SHORT_CAP_FRAMES` a `SHORT_PAUSE_FRAMES` one, and at
/// `HARD_CAP_FRAMES` the segment is re-cut at the quietest point of the last
/// `RECUT_SEARCH_FRAMES`. 28 s keeps every decode inside the model's ~30 s training clips, the
/// 4096-frame (82 s) adapter position table and the 256-token budget.
const LONG_PAUSE_FRAMES: usize = HOPS_PER_SECOND * 6 / 5; // 1.2 s
const PAUSE_FRAMES: usize = HOPS_PER_SECOND * 3 / 5; // 0.6 s
const SHORT_PAUSE_FRAMES: usize = 4; // 0.16 s
const MIN_SEGMENT_FRAMES: usize = HOPS_PER_SECOND; // 1 s
const SOFT_CAP_FRAMES: usize = HOPS_PER_SECOND * 12;
const SHORT_CAP_FRAMES: usize = HOPS_PER_SECOND * 20;
const HARD_CAP_FRAMES: usize = HOPS_PER_SECOND * 28;
const RECUT_SEARCH_FRAMES: usize = HOPS_PER_SECOND * 5;
/// The noise floor is the quietest frame of the last 3 s (minimum statistics): speech always
/// has inter-syllable dips inside that window, steady noise (fans, hum) becomes the floor.
const FLOOR_WINDOW_FRAMES: usize = HOPS_PER_SECOND * 3;
/// A frame is speech when it sits this far above the noise floor (and above the absolute gate).
/// Kept low on purpose: dropping a segment loses words for good, and noisy field recordings
/// (FLEURS) carry speech only ~6-10 dB over the floor. The gate only rejects near-digital
/// silence; quiet low-gain mics still peak around -50 dBFS.
const SPEECH_OVER_FLOOR_DB: f32 = 6.0;
const SPEECH_ABS_GATE_DB: f32 = -65.0;
/// A segment is decoded only with at least this much speech (200 ms) — a noise-only sliver would
/// otherwise come back as a hallucinated phrase.
const MIN_SPEECH_FRAMES: usize = 5;

/// Dims + windows from `streaming_config.json`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StreamingConfig {
    pub encoder_dim: usize,
    pub decoder_dim: usize,
    pub depth: usize,
    pub nheads: usize,
    pub head_dim: usize,
    pub bos_id: i64,
    pub eos_id: i64,
    pub total_lookahead: usize,
    pub total_left_context: usize,
    pub sample_buffer_len: usize,
    pub conv1_channels: usize,
    pub conv2_channels: usize,
    pub max_positions: usize,
}

impl StreamingConfig {
    pub(crate) fn parse(raw: &str) -> SttResult<Self> {
        let v: serde_json::Value = serde_json::from_str(raw)
            .map_err(|e| SttError::Inference(format!("streaming_config.json: {e}")))?;
        let u = |k: &str| -> SttResult<usize> {
            v.get(k)
                .and_then(serde_json::Value::as_u64)
                .map(|n| n as usize)
                .ok_or_else(|| SttError::Inference(format!("streaming_config.json: missing '{k}'")))
        };
        let shape = |k: &str| -> Option<Vec<usize>> {
            v.get("frontend_state_shapes")?
                .get(k)?
                .as_array()?
                .iter()
                .map(|d| d.as_u64().map(|n| n as usize))
                .collect()
        };
        let depth = u("depth")?;
        let encoder_dim = u("encoder_dim")?;
        let frame_len = u("frame_len").unwrap_or(80);
        let sample_buffer_len = shape("sample_buffer")
            .and_then(|s| s.get(1).copied())
            .unwrap_or(frame_len - 1);
        let conv1_channels = shape("conv1_buffer")
            .and_then(|s| s.get(1).copied())
            .unwrap_or(encoder_dim);
        let conv2_channels = shape("conv2_buffer")
            .and_then(|s| s.get(1).copied())
            .unwrap_or(encoder_dim * 2);
        // Older exports carry only `total_lookahead`; their windows are all 16 frames behind,
        // which is also what the C++ runtime assumes (`16 * depth`).
        let total_left_context = u("total_left_context").unwrap_or(16 * depth);
        Ok(Self {
            encoder_dim,
            decoder_dim: u("decoder_dim")?,
            depth,
            nheads: u("nheads")?,
            head_dim: u("head_dim")?,
            bos_id: u("bos_id").map_or(1, |n| n as i64),
            eos_id: u("eos_id").map_or(2, |n| n as i64),
            total_lookahead: u("total_lookahead")?,
            total_left_context,
            sample_buffer_len,
            conv1_channels,
            conv2_channels,
            max_positions: u("max_position_embeddings").unwrap_or(4096),
        })
    }
}

/// Energy endpointer over 40 ms frames with a minimum-statistics noise floor.
#[derive(Clone, Debug)]
struct Endpointer {
    /// dB of the last `FLOOR_WINDOW_FRAMES` frames (across segments: room noise persists).
    history: std::collections::VecDeque<f32>,
    frame_db: Vec<f32>,
    speech_frames: usize,
    silence_run: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Cut {
    /// Commit everything fed so far.
    Pause,
    /// Commit the first `n` frames; the rest starts the next segment.
    At(usize),
}

impl Endpointer {
    fn new() -> Self {
        Self {
            history: std::collections::VecDeque::with_capacity(FLOOR_WINDOW_FRAMES + 1),
            frame_db: Vec::new(),
            speech_frames: 0,
            silence_run: 0,
        }
    }

    fn reset_segment(&mut self) {
        self.frame_db.clear();
        self.speech_frames = 0;
        self.silence_run = 0;
    }

    /// Whether the current segment holds enough speech to be worth decoding.
    fn has_speech(&self) -> bool {
        self.speech_frames >= MIN_SPEECH_FRAMES
    }

    fn push(&mut self, frame: &[f32]) -> Option<Cut> {
        let energy = frame
            .iter()
            .map(|&s| f64::from(s) * f64::from(s))
            .sum::<f64>()
            / frame.len().max(1) as f64;
        let db = (10.0 * (energy + 1e-18).log10()) as f32;
        if self.history.len() == FLOOR_WINDOW_FRAMES {
            self.history.pop_front();
        }
        self.history.push_back(db);
        let floor = self.history.iter().copied().fold(f32::INFINITY, f32::min);
        let speech = db > (floor + SPEECH_OVER_FLOOR_DB).max(SPEECH_ABS_GATE_DB);
        self.frame_db.push(db);
        if speech {
            self.speech_frames += 1;
            self.silence_run = 0;
        } else {
            self.silence_run += 1;
        }
        let n = self.frame_db.len();
        if self.speech_frames > 0 && n >= MIN_SEGMENT_FRAMES {
            let need = if n >= SHORT_CAP_FRAMES {
                SHORT_PAUSE_FRAMES
            } else if n >= SOFT_CAP_FRAMES {
                PAUSE_FRAMES
            } else {
                LONG_PAUSE_FRAMES
            };
            if self.silence_run >= need {
                return Some(Cut::Pause);
            }
        }
        if n >= HARD_CAP_FRAMES {
            return Some(Cut::At(self.quietest_cut(n)));
        }
        None
    }

    /// Frame index (exclusive end of the committed part) at the quietest 3-frame neighbourhood of
    /// the last `RECUT_SEARCH_FRAMES`.
    fn quietest_cut(&self, n: usize) -> usize {
        let lo = MIN_SEGMENT_FRAMES.max(n.saturating_sub(RECUT_SEARCH_FRAMES));
        let mut best = (f32::INFINITY, n);
        for i in lo..n {
            let a = self.frame_db[i.saturating_sub(1)];
            let b = self.frame_db[i];
            let c = self.frame_db[(i + 1).min(n - 1)];
            let m = (a + b + c) / 3.0;
            if m < best.0 {
                best = (m, i + 1);
            }
        }
        best.1.clamp(1, n)
    }
}

/// Per-segment model state.
struct Segment {
    sample_buffer: Vec<f32>,
    sample_len: i64,
    conv1: Vec<f32>,
    conv2: Vec<f32>,
    frame_count: i64,
    /// Encoder features, row-major `[n_features, encoder_dim]`.
    features: Vec<f32>,
    n_features: usize,
    /// Features already encoded into memory.
    emitted: usize,
    /// Decoder memory, row-major `[mem_len, decoder_dim]`.
    memory: Vec<f32>,
    mem_len: usize,
    cross: Option<(DynValue, DynValue)>,
    cross_len: usize,
    tokens: Vec<i64>,
    decoded_mem_len: usize,
    /// The segment's audio (whole hops), kept so a hard cap can re-cut it.
    pcm: Vec<f32>,
}

impl Segment {
    fn new(cfg: &StreamingConfig) -> Self {
        Self {
            sample_buffer: vec![0.0; cfg.sample_buffer_len],
            sample_len: 0,
            conv1: vec![0.0; cfg.conv1_channels * 4],
            conv2: vec![0.0; cfg.conv2_channels * 4],
            frame_count: 0,
            features: Vec::new(),
            n_features: 0,
            emitted: 0,
            memory: Vec::new(),
            mem_len: 0,
            cross: None,
            cross_len: 0,
            tokens: Vec::new(),
            decoded_mem_len: 0,
            pcm: Vec::new(),
        }
    }
}

struct StreamState {
    seg: Segment,
    endpointer: Endpointer,
    /// Samples not yet forming a whole hop.
    pending: Vec<f32>,
    /// Text of the committed segments.
    committed: Vec<String>,
    /// Wall time of the last live decode (throttles the next, see `LIVE_DECODE_MAX_DUTY`).
    last_live_decode_secs: f32,
}

/// A loaded Moonshine v2 streaming engine (`EngineKind::MoonshineStreaming`).
pub struct MoonshineStreamingEngine {
    model_name: String,
    providers: Vec<String>,
    frontend: Session,
    encoder: Session,
    adapter: Session,
    cross_kv: Session,
    decoder: Session,
    decoder_run_options: RunOptions<HasSelectedOutputs>,
    cfg: StreamingConfig,
    tokenizer: MoonshineTokenizer,
    stream: StreamState,
}

fn inference(context: &'static str) -> impl Fn(ort::Error) -> SttError {
    move |e| SttError::Inference(format!("moonshine-streaming {context}: {e}"))
}

impl MoonshineStreamingEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<Self> {
        let files = &cfg.resolved.files;
        let get = |k: &str| -> SttResult<&Path> {
            files.get(k).map(|p| p.as_path()).ok_or_else(|| {
                SttError::Resolve(format!("moonshine-streaming: missing resolved file '{k}'"))
            })
        };
        let config_raw = std::fs::read_to_string(get("streaming_config")?)
            .map_err(|e| SttError::Inference(format!("read streaming_config.json: {e}")))?;
        let scfg = StreamingConfig::parse(&config_raw)?;
        let tokenizer = MoonshineTokenizer::load(
            get("tokenizer")?,
            files.get("tokenizer_config").map(|p| p.as_path()),
        )?;

        // CPU-pinned like Moonshine v1. The exported encoder does not run on DirectML at all
        // (ORT 1.24 DML EP rejects its attention-head Reshape at every window length), and the
        // per-token decoder step is a few milliseconds of work that DML's per-op launch plus the
        // host round-trip for the logits are not expected to beat anyway.
        let intra = super::pick_intra_op_threads(false, num_cpus());
        let build = |key: &str| -> SttResult<Session> {
            let path = get(key)?;
            let mut builder = configure_session(
                GraphOptimizationLevel::All,
                Some(intra),
                false,
                Some(&[Accelerator::Cpu]),
            )
            .map_err(SttError::SessionCreate)?;
            builder
                .commit_from_file(path)
                .map_err(|e| SttError::SessionCreate(format!("commit {}: {e}", path.display())))
        };
        let frontend = build("frontend")?;
        let encoder = build("encoder")?;
        let adapter = build("adapter")?;
        let cross_kv = build("cross_kv")?;
        let decoder = build("decoder_kv")?;
        // Skip the pass-through cross K/V outputs: they are the inputs unchanged, and requesting
        // them would copy the whole cross cache on every token.
        let decoder_run_options = RunOptions::new()
            .map_err(inference("run options"))?
            .with_outputs(
                OutputSelector::no_default()
                    .with("logits")
                    .with("out_k_self")
                    .with("out_v_self"),
            );
        let stream = StreamState {
            seg: Segment::new(&scfg),
            endpointer: Endpointer::new(),
            pending: Vec::new(),
            committed: Vec::new(),
            last_live_decode_secs: 0.0,
        };
        Ok(Self {
            model_name: cfg.model_name.clone(),
            providers: [Accelerator::Cpu].iter().map(provider_label).collect(),
            frontend,
            encoder,
            adapter,
            cross_kv,
            decoder,
            decoder_run_options,
            cfg: scfg,
            tokenizer,
            stream,
        })
    }

    /// Run the frontend over whole hops of `pcm`, appending features to the segment.
    fn run_frontend(&mut self, pcm: &[f32]) -> SttResult<()> {
        debug_assert!(pcm.len().is_multiple_of(HOP));
        if pcm.is_empty() {
            return Ok(());
        }
        let c = &self.cfg;
        let seg = &mut self.stream.seg;
        let mut outputs = self
            .frontend
            .run(ort::inputs![
                "audio_chunk" => TensorRef::from_array_view(([1usize, pcm.len()], pcm))
                    .map_err(inference("audio tensor"))?,
                "sample_buffer" => TensorRef::from_array_view(([1usize, c.sample_buffer_len], seg.sample_buffer.as_slice()))
                    .map_err(inference("sample_buffer tensor"))?,
                "sample_len" => Tensor::from_array(([1usize], vec![seg.sample_len]))
                    .map_err(inference("sample_len tensor"))?,
                "conv1_buffer" => TensorRef::from_array_view(([1usize, c.conv1_channels, 4], seg.conv1.as_slice()))
                    .map_err(inference("conv1 tensor"))?,
                "conv2_buffer" => TensorRef::from_array_view(([1usize, c.conv2_channels, 4], seg.conv2.as_slice()))
                    .map_err(inference("conv2 tensor"))?,
                "frame_count" => Tensor::from_array(([1usize], vec![seg.frame_count]))
                    .map_err(inference("frame_count tensor"))?,
            ])
            .map_err(inference("frontend run"))?;
        let f32_out =
            |outputs: &mut ort::session::SessionOutputs<'_>, name: &str| -> SttResult<Vec<f32>> {
                let v = outputs
                    .get(name)
                    .ok_or_else(|| SttError::Inference(format!("frontend produced no {name}")))?;
                let (_, data) = v
                    .try_extract_tensor::<f32>()
                    .map_err(inference("frontend extract"))?;
                Ok(data.to_vec())
            };
        let i64_out =
            |outputs: &mut ort::session::SessionOutputs<'_>, name: &str| -> SttResult<i64> {
                let v = outputs
                    .get(name)
                    .ok_or_else(|| SttError::Inference(format!("frontend produced no {name}")))?;
                let (_, data) = v
                    .try_extract_tensor::<i64>()
                    .map_err(inference("frontend extract"))?;
                Ok(data.first().copied().unwrap_or(0))
            };
        let features = f32_out(&mut outputs, "features")?;
        seg.sample_buffer = f32_out(&mut outputs, "sample_buffer_out")?;
        seg.sample_len = i64_out(&mut outputs, "sample_len_out")?;
        seg.conv1 = f32_out(&mut outputs, "conv1_buffer_out")?;
        seg.conv2 = f32_out(&mut outputs, "conv2_buffer_out")?;
        seg.frame_count = i64_out(&mut outputs, "frame_count_out")?;
        seg.n_features += features.len() / c.encoder_dim;
        seg.features.extend_from_slice(&features);
        Ok(())
    }

    /// Encode newly stable features into decoder memory. Returns whether memory grew.
    fn encode(&mut self, is_final: bool) -> SttResult<bool> {
        let c = &self.cfg;
        let seg = &mut self.stream.seg;
        let total = seg.n_features;
        let stable = if is_final {
            total
        } else {
            total.saturating_sub(c.total_lookahead)
        };
        // Never run past the adapter's learned position table.
        let stable = stable.min(c.max_positions);
        if stable <= seg.emitted {
            return Ok(false);
        }
        let new = stable - seg.emitted;
        let start = seg.emitted.saturating_sub(c.total_left_context);
        let end = total.min(c.max_positions + c.total_lookahead);
        let rows = end - start;
        if rows < 2 {
            // The exported time axis starts at 2. Only a 20 ms segment (one feature, nothing
            // emitted) lands here; it carries no speech worth decoding.
            return Ok(false);
        }
        let window = &seg.features[start * c.encoder_dim..end * c.encoder_dim];
        let outputs = self
            .encoder
            .run(ort::inputs![
                "features" => TensorRef::from_array_view(([1usize, rows, c.encoder_dim], window))
                    .map_err(inference("features tensor"))?,
            ])
            .map_err(inference("encoder run"))?;
        let (_, encoded) = outputs["encoded"]
            .try_extract_tensor::<f32>()
            .map_err(inference("encoded extract"))?;
        let off = (seg.emitted - start) * c.encoder_dim;
        let slice = encoded[off..off + new * c.encoder_dim].to_vec();
        drop(outputs);
        let outputs = self
            .adapter
            .run(ort::inputs![
                "encoded" => Tensor::from_array(([1usize, new, c.encoder_dim], slice))
                    .map_err(inference("encoded tensor"))?,
                "pos_offset" => Tensor::from_array(([1usize], vec![seg.emitted as i64]))
                    .map_err(inference("pos_offset tensor"))?,
            ])
            .map_err(inference("adapter run"))?;
        let (_, memory) = outputs["memory"]
            .try_extract_tensor::<f32>()
            .map_err(inference("memory extract"))?;
        seg.memory.extend_from_slice(memory);
        seg.mem_len += new;
        seg.emitted = stable;
        Ok(true)
    }

    fn empty_kv(&self) -> SttResult<DynValue> {
        let c = &self.cfg;
        Tensor::<f32>::new(
            &Allocator::default(),
            [c.depth, 1usize, c.nheads, 0usize, c.head_dim],
        )
        .map(|t| t.into_dyn())
        .map_err(inference("empty kv"))
    }

    /// One decoder call: returns `(logits rows [L, vocab] flattened, vocab, k_self, v_self)`.
    fn run_decoder(
        &mut self,
        tokens: &[i64],
        k_self: &DynValue,
        v_self: &DynValue,
    ) -> SttResult<(Vec<f32>, usize, DynValue, DynValue)> {
        let (k_cross, v_cross) = self
            .stream
            .seg
            .cross
            .as_ref()
            .ok_or_else(|| SttError::Inference("moonshine-streaming: no cross K/V".into()))?;
        let inputs: Vec<(Cow<'_, str>, SessionInputValue<'_>)> = vec![
            (
                Cow::Borrowed("token"),
                Tensor::from_array(([1usize, tokens.len()], tokens.to_vec()))
                    .map(SessionInputValue::from)
                    .map_err(inference("token tensor"))?,
            ),
            (Cow::Borrowed("k_self"), SessionInputValue::from(k_self)),
            (Cow::Borrowed("v_self"), SessionInputValue::from(v_self)),
            (
                Cow::Borrowed("out_k_cross"),
                SessionInputValue::from(k_cross),
            ),
            (
                Cow::Borrowed("out_v_cross"),
                SessionInputValue::from(v_cross),
            ),
        ];
        let mut outputs = self
            .decoder
            .run_with_options(inputs, &self.decoder_run_options)
            .map_err(inference("decoder run"))?;
        let (shape, logits) = outputs["logits"]
            .try_extract_tensor::<f32>()
            .map_err(inference("logits extract"))?;
        let vocab = shape.last().copied().unwrap_or(0).max(1) as usize;
        let logits = logits.to_vec();
        let k = outputs
            .remove("out_k_self")
            .ok_or_else(|| SttError::Inference("decoder produced no out_k_self".into()))?;
        let v = outputs
            .remove("out_v_self")
            .ok_or_else(|| SttError::Inference("decoder produced no out_v_self".into()))?;
        Ok((logits, vocab, k, v))
    }

    /// Keep the first `keep` positions of a `[depth,1,heads,C,head_dim]` self-attention cache.
    fn trim_kv(&self, kv: &DynValue, keep: usize) -> SttResult<DynValue> {
        let c = &self.cfg;
        let (shape, data) = kv
            .try_extract_tensor::<f32>()
            .map_err(inference("kv extract"))?;
        let len = shape.get(3).copied().unwrap_or(0).max(0) as usize;
        if keep >= len {
            return Tensor::from_array((shape.to_vec(), data.to_vec()))
                .map(|t| t.into_dyn())
                .map_err(inference("kv copy"));
        }
        if keep == 0 {
            return self.empty_kv();
        }
        let blocks = c.depth * c.nheads;
        let mut out = Vec::with_capacity(blocks * keep * c.head_dim);
        for b in 0..blocks {
            let base = b * len * c.head_dim;
            out.extend_from_slice(&data[base..base + keep * c.head_dim]);
        }
        Tensor::from_array(([c.depth, 1usize, c.nheads, keep, c.head_dim], out))
            .map(|t| t.into_dyn())
            .map_err(inference("kv trim"))
    }

    /// Re-decode the segment against its current memory (speculative prefix reuse).
    fn decode(&mut self) -> SttResult<()> {
        let mem_len = self.stream.seg.mem_len;
        if mem_len == 0 {
            self.stream.seg.tokens.clear();
            return Ok(());
        }
        let c = self.cfg.clone();
        if self.stream.seg.cross_len != mem_len {
            let seg = &mut self.stream.seg;
            let mut outputs = self
                .cross_kv
                .run(ort::inputs![
                    "memory" => TensorRef::from_array_view(([1usize, mem_len, c.decoder_dim], seg.memory.as_slice()))
                        .map_err(inference("memory tensor"))?,
                ])
                .map_err(inference("cross_kv run"))?;
            let k = outputs
                .remove("k_cross")
                .ok_or_else(|| SttError::Inference("cross_kv produced no k_cross".into()))?;
            let v = outputs
                .remove("v_cross")
                .ok_or_else(|| SttError::Inference("cross_kv produced no v_cross".into()))?;
            seg.cross = Some((k, v));
            seg.cross_len = mem_len;
        }
        let duration = mem_len as f32 * FEATURE_SECONDS;
        let max_tokens = ((duration * TOKENS_PER_SECOND).ceil() as usize + 4).min(MAX_TOKENS);

        let prev = std::mem::take(&mut self.stream.seg.tokens);
        let mut feed = Vec::with_capacity(prev.len() + 1);
        feed.push(c.bos_id);
        feed.extend_from_slice(&prev);
        let empty = self.empty_kv()?;
        let (logits, vocab, mut k, mut v) = self.run_decoder(&feed, &empty, &empty)?;
        let argmax_row = |row: usize| -> i64 {
            super::families::argmax_1d(&logits[row * vocab..(row + 1) * vocab]).0 as i64
        };
        let mut out: Vec<i64> = Vec::with_capacity(prev.len() + 8);
        let mut next = None;
        for (i, &p) in prev.iter().enumerate() {
            let pred = argmax_row(i);
            if pred == p && out.len() < max_tokens {
                out.push(p);
            } else {
                next = Some(pred);
                break;
            }
        }
        let mut next = match next {
            // Diverged: keep BOS + the accepted prefix in the cache (causal, so those entries are
            // exactly what a fresh decode of that prefix would hold).
            Some(pred) => {
                k = self.trim_kv(&k, out.len() + 1)?;
                v = self.trim_kv(&v, out.len() + 1)?;
                pred
            }
            None => argmax_row(prev.len()),
        };
        while out.len() < max_tokens && next != c.eos_id {
            out.push(next);
            let (logits, vocab, k2, v2) = self.run_decoder(&[next], &k, &v)?;
            k = k2;
            v = v2;
            next = super::families::argmax_1d(&logits[logits.len() - vocab..]).0 as i64;
        }
        let seg = &mut self.stream.seg;
        seg.tokens = out;
        seg.decoded_mem_len = mem_len;
        Ok(())
    }

    /// Finish the current segment: flush the encoder, decode (when it held speech), commit text.
    fn commit_segment(&mut self, had_speech: bool) -> SttResult<()> {
        // Flush the frontend's sub-hop remainder (never more than one hop of zero padding).
        self.encode(true)?;
        if had_speech && self.stream.seg.decoded_mem_len != self.stream.seg.mem_len {
            self.decode()?;
        }
        if had_speech {
            let text = self.segment_text();
            if !text.trim().is_empty() {
                self.stream.committed.push(text.trim().to_string());
            }
        }
        self.stream.seg = Segment::new(&self.cfg);
        self.stream.endpointer.reset_segment();
        Ok(())
    }

    fn segment_text(&self) -> String {
        self.tokenizer.decode_text(&self.stream.seg.tokens)
    }

    fn current_text(&self) -> String {
        let mut parts: Vec<String> = self.stream.committed.clone();
        if self.stream.endpointer.has_speech() {
            let live = self.segment_text();
            if !live.trim().is_empty() {
                parts.push(live.trim().to_string());
            }
        }
        join_segments(&parts)
    }

    /// Feed whole hops through the endpointer + frontend, committing segments at cuts.
    fn feed_hops(&mut self, hops: &[f32]) -> SttResult<()> {
        let mut start = 0;
        let mut i = 0;
        while i < hops.len() {
            let frame = &hops[i..i + HOP];
            self.stream.seg.pcm.extend_from_slice(frame);
            let cut = self.stream.endpointer.push(frame);
            i += HOP;
            match cut {
                None => {}
                Some(Cut::Pause) => {
                    self.run_frontend(&hops[start..i])?;
                    start = i;
                    let speech = self.stream.endpointer.has_speech();
                    self.commit_segment(speech)?;
                }
                Some(Cut::At(frames)) => {
                    // Re-run the segment up to the cut from scratch (the causal frontend makes the
                    // prefix identical; only the lookahead tail of the encoder changes), commit it,
                    // and replay the remainder into a fresh segment.
                    let seg_pcm = std::mem::take(&mut self.stream.seg.pcm);
                    let prev_tokens = std::mem::take(&mut self.stream.seg.tokens);
                    // A capped stretch of room noise is dropped, not decoded.
                    let speech = self.stream.endpointer.has_speech();
                    let cut_samples = (frames * HOP).min(seg_pcm.len());
                    self.stream.seg = Segment::new(&self.cfg);
                    // Seed the speculative decode with the running hypothesis.
                    self.stream.seg.tokens = prev_tokens;
                    self.run_frontend(&seg_pcm[..cut_samples])?;
                    self.commit_segment(speech)?;
                    start = i;
                    let rest = &seg_pcm[cut_samples..];
                    for frame in rest.chunks_exact(HOP) {
                        self.stream.seg.pcm.extend_from_slice(frame);
                        // Replayed frames only rebuild endpointer state. A pause inside the replay
                        // is not acted on here; if the silence continues, the next live frame
                        // re-triggers it (the run length carries over).
                        let _ = self.stream.endpointer.push(frame);
                    }
                    self.run_frontend(&rest[..rest.len() / HOP * HOP])?;
                }
            }
        }
        self.run_frontend(&hops[start..])?;
        Ok(())
    }

    fn accept(&mut self, pcm: &[f32]) -> SttResult<()> {
        self.stream.pending.extend_from_slice(pcm);
        let whole = self.stream.pending.len() / HOP * HOP;
        if whole == 0 {
            return Ok(());
        }
        let hops: Vec<f32> = self.stream.pending.drain(..whole).collect();
        self.feed_hops(&hops)?;
        if self.encode(false)? {
            let seg = &self.stream.seg;
            let new_frames = seg.mem_len.saturating_sub(seg.decoded_mem_len);
            let new_secs = new_frames as f32 * FEATURE_SECONDS;
            if self.stream.endpointer.has_speech()
                && new_frames >= DECODE_MIN_NEW_FRAMES
                && new_secs * LIVE_DECODE_MAX_DUTY >= self.stream.last_live_decode_secs
            {
                let started = Instant::now();
                self.decode()?;
                self.stream.last_live_decode_secs = started.elapsed().as_secs_f32();
            }
        }
        Ok(())
    }

    fn finalize(&mut self) -> SttResult<String> {
        if !self.stream.pending.is_empty() {
            let mut tail = std::mem::take(&mut self.stream.pending);
            tail.resize(tail.len().div_ceil(HOP) * HOP, 0.0);
            self.feed_hops(&tail)?;
        }
        let speech = self.stream.endpointer.has_speech();
        self.commit_segment(speech)?;
        Ok(join_segments(&self.stream.committed))
    }

    fn reset(&mut self) {
        self.stream = StreamState {
            seg: Segment::new(&self.cfg),
            endpointer: Endpointer::new(),
            pending: Vec::new(),
            committed: Vec::new(),
            last_live_decode_secs: 0.0,
        };
    }
}

/// Is `c` written without inter-word spaces (CJK ideographs, kana, Thai…)?
fn is_spaceless_script(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF   // Hiragana + Katakana
        | 0x3400..=0x4DBF // CJK Ext A
        | 0x4E00..=0x9FFF // CJK Unified
        | 0xF900..=0xFAFF // CJK Compatibility
        | 0x3000..=0x303F // CJK punctuation
        | 0xFF00..=0xFFEF // full-width forms
        | 0x0E00..=0x0E7F // Thai
    )
}

/// Join committed segment texts: a space between words, none between spaceless-script runs.
fn join_segments(parts: &[String]) -> String {
    let mut out = String::new();
    for p in parts.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        if let (Some(a), Some(b)) = (out.chars().last(), p.chars().next())
            && !(is_spaceless_script(a) && is_spaceless_script(b))
        {
            out.push(' ');
        }
        out.push_str(p);
    }
    out
}

impl Transcriber for MoonshineStreamingEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::MoonshineStreaming
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    fn is_ready(&self) -> bool {
        true
    }

    fn active_providers(&self) -> &[String] {
        &self.providers
    }

    fn transcribe(&mut self, audio: &[f32], _opts: &TranscribeOptions) -> SttResult<Transcription> {
        self.reset();
        // Intermediate decodes are skipped: only the segment commits decode, so a batch call costs
        // one decode per utterance.
        self.stream.pending.extend_from_slice(audio);
        let text = self.finalize();
        self.reset();
        Ok(Transcription {
            text: text?,
            ..Default::default()
        })
    }

    fn supports_native_streaming(&self) -> bool {
        true
    }

    fn stream_accept(&mut self, pcm: &[f32]) -> SttResult<NativeStreamUpdate> {
        if !pcm.is_empty() {
            self.accept(pcm)?;
        }
        Ok(NativeStreamUpdate::interim(self.current_text()))
    }

    fn stream_finalize(&mut self) -> SttResult<String> {
        self.finalize()
    }

    fn stream_reset(&mut self) {
        self.reset();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exported_streaming_config() {
        let raw = r#"{"encoder_dim": 320, "decoder_dim": 320, "depth": 6, "nheads": 8,
            "head_dim": 40, "vocab_size": 32768, "bos_id": 1, "eos_id": 2, "frame_len": 80,
            "total_lookahead": 16, "d_model_frontend": 320, "c1": 640, "c2": 320,
            "frontend_state_shapes": {"sample_buffer": [1, 79], "sample_len": [1],
              "conv1_buffer": [1, 320, 4], "conv2_buffer": [1, 640, 4], "frame_count": [1]},
            "windows": [[16,4],[16,4],[16,0],[16,0],[16,4],[16,4]],
            "total_left_context": 96, "max_position_embeddings": 4096}"#;
        let c = StreamingConfig::parse(raw).unwrap();
        assert_eq!(c.encoder_dim, 320);
        assert_eq!(c.depth, 6);
        assert_eq!(c.total_lookahead, 16);
        assert_eq!(c.total_left_context, 96);
        assert_eq!(c.sample_buffer_len, 79);
        assert_eq!(c.conv1_channels, 320);
        assert_eq!(c.conv2_channels, 640);
        assert_eq!(c.max_positions, 4096);
    }

    #[test]
    fn legacy_config_defaults_left_context_to_sixteen_per_layer() {
        let raw = r#"{"encoder_dim": 768, "decoder_dim": 640, "depth": 14, "nheads": 10,
            "head_dim": 64, "total_lookahead": 16}"#;
        let c = StreamingConfig::parse(raw).unwrap();
        assert_eq!(c.total_left_context, 16 * 14);
        assert_eq!(c.conv2_channels, 768 * 2);
        assert_eq!((c.bos_id, c.eos_id), (1, 2));
    }

    fn tone(frames: usize, amp: f32) -> Vec<f32> {
        (0..frames * HOP)
            .map(|i| amp * (i as f32 * 0.07).sin())
            .collect()
    }

    /// Syllable-like audio: 6 loud frames, 2 frames ~16 dB down, repeating.
    fn speechy(frames: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|f| tone(1, if f % 8 < 6 { 0.3 } else { 0.05 }))
            .collect()
    }

    fn first_cut(ep: &mut Endpointer, audio: &[f32]) -> Option<(usize, Cut)> {
        audio
            .chunks_exact(HOP)
            .enumerate()
            .find_map(|(i, f)| ep.push(f).map(|c| (i, c)))
    }

    #[test]
    fn endpointer_commits_after_a_long_pause_following_speech() {
        let mut ep = Endpointer::new();
        let mut audio = tone(5, 0.0005);
        // 78 frames end on a loud frame, so the silence run starts with the pause itself.
        audio.extend(speechy(78));
        audio.extend(tone(LONG_PAUSE_FRAMES + 2, 0.0005));
        let (at, cut) = first_cut(&mut ep, &audio).expect("a pause cut");
        assert_eq!(cut, Cut::Pause);
        assert_eq!(at, 5 + 78 + LONG_PAUSE_FRAMES - 1);
        assert!(ep.has_speech());
    }

    #[test]
    fn endpointer_keeps_short_segments_across_a_breath() {
        // A 0.6 s pause inside a 3 s utterance is a breath, not an utterance boundary.
        let mut ep = Endpointer::new();
        let mut audio = speechy(40);
        audio.extend(tone(PAUSE_FRAMES + 2, 0.0005));
        audio.extend(speechy(40));
        assert_eq!(first_cut(&mut ep, &audio), None);
    }

    #[test]
    fn endpointer_never_decodes_silence_or_steady_noise() {
        let mut ep = Endpointer::new();
        let audio = tone(HARD_CAP_FRAMES - 1, 0.0001);
        assert_eq!(first_cut(&mut ep, &audio), None);
        assert!(!ep.has_speech());
        // A steady hum well above the absolute gate becomes the floor, not speech.
        let mut ep = Endpointer::new();
        let hum = tone(HARD_CAP_FRAMES - 1, 0.05);
        let _ = first_cut(&mut ep, &hum);
        assert!(
            !ep.has_speech(),
            "{} hum frames counted as speech",
            ep.speech_frames
        );
    }

    #[test]
    fn endpointer_hard_caps_continuous_speech_at_the_quietest_frame() {
        let mut ep = Endpointer::new();
        // `lead` ends on a loud frame; one inter-syllable dip is made deeper (and stays shorter
        // than even the short pause) ~60 frames before the cap.
        let lead = HARD_CAP_FRAMES - 62;
        assert_eq!(lead % 8, 6);
        let mut audio = speechy(lead);
        audio.extend(tone(2, 0.01));
        audio.extend(speechy(100));
        match first_cut(&mut ep, &audio) {
            Some((_, Cut::At(n))) => {
                assert!((lead..=lead + 2).contains(&n), "cut at {n}, dip at {lead}");
            }
            other => panic!("expected a hard-cap cut, got {other:?}"),
        }
    }

    #[test]
    fn joins_words_with_spaces_and_cjk_without() {
        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            join_segments(&p(&["Hello there.", "How are you?"])),
            "Hello there. How are you?"
        );
        assert_eq!(
            join_segments(&p(&["今日は。", "元気です。"])),
            "今日は。元気です。"
        );
        assert_eq!(join_segments(&p(&["", " a ", "b"])), "a b");
    }
}
