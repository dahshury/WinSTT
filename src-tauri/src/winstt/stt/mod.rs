// Unified ort-ONNX STT engine: the public `Transcriber` trait, the family/engine taxonomy, and
// the per-family engines. A Rust re-port of onnx-asr onto raw `ort` 2.x. Source: the onnx-asr
// fork (E:/DL/Projects/onnx-asr/src/onnx_asr/) and the WinSTT server
// (server/src/recorder/infrastructure/{onnxasr_transcriber,device,bootstrap}.py); porting notes
// in docs/archive/port/03_stt_engine.md.
//
// Load-bearing invariants (docs/archive/port/03_stt_engine.md §10):
//   * Silero VAD is CPU-only (CUDA/DML deadlock) — enforced in the VAD slice, not here.
//   * Several families' graphs crash on DirectML → forced to the CPU EP. The list is per-engine
//     and empirically measured (see `EngineKind::is_dml_incompatible`), NOT a blanket family ban.
//   * Canary / Cohere's `<|startofcontext|>` prompt slot is UNTRAINED → never inject an initial-
//     prompt bias for those families (`EngineKind::supports_initial_prompt`).
//   * `panic = "unwind"` stays load-bearing — `transcribe()` is wrapped in `catch_unwind` by the
//     caller (transcription_coordinator); engines must be panic-safe, the coordinator catches.

#![allow(dead_code)] // public engine surface is defined ahead of some call sites.

use std::path::PathBuf;

// ── engine submodules ──
/// WinSTT-owned STT backend trait (audit #14): the boundary the inherited Handy pipeline core
/// (`crate::managers::transcription`) calls into for every WinSTT-specific load/decode/cloud step,
/// so the core stops reaching sideways into `crate::winstt::*` (restores the one-way dep edge).
pub mod backend;
/// On-disk HF-cache probe (per-model per-quant cached/partial/not_cached) for the picker badges.
pub mod cache_probe;
/// Non-Whisper families: CTC (SenseVoice/GigaAM/Dolphin/Kaldi), RNNT/TDT (Parakeet/zipformer), AED (Canary/Cohere).
pub mod families;
/// In-file fp16 decoder protobuf repair (prost) + external-data refetch detection.
pub mod fp16_patch;
/// Embedded GigaAM v3 analysis window [320] + 64-mel filterbank [161,64] (from onnx_asr fbanks.npz).
pub mod gigaam_v3_consts;
/// Log-mel feature extraction (Slaney 80/128-mel) shared by Whisper-family engines.
pub mod mel;
/// Moonshine ONNX engine (raw-audio encoder + 3-graph decoder KV-cache, SentencePiece tokenizer).
pub mod moonshine;
/// HF snapshot resolver + download + sharded-data completeness + per-quant cache.
pub mod resolver;
/// Native streaming engines via sherpa-onnx's `OnlineRecognizer` (Zipformer/NeMo cache-aware).
pub mod streaming;
/// Unlimited-length FINAL decode via Silero-VAD segmentation (beats Whisper's 30 s window etc.).
pub mod vad_segment;
/// Whisper / lite-whisper / distil-whisper ONNX engine (encoder + merged-decoder KV-cache).
pub mod whisper;
/// Hand-rolled Whisper BPE/byte tokenizer + special-token table + segment parser.
pub mod whisper_tokenizer;

pub use backend::{BackendRoute, ResolvedSpec, SttBackend, WinsttSttBackend};
pub use whisper::WhisperEngine;

// ---------------------------------------------------------------------------
// Result / error types
// ---------------------------------------------------------------------------

/// Errors surfaced by the unified STT engine. Mirrors the Python
/// `TranscriptionError` taxonomy plus the resolver / load failure modes that
/// `onnxasr_transcriber._load_model_with_fp16_repair` recovers from.
#[derive(Debug, thiserror::Error)]
pub enum SttError {
    /// HF snapshot / local-dir resolution failed (missing file, bad repo id,
    /// or an incomplete `.onnx_data` shard set). Carries whether a refetch was
    /// already attempted so the caller doesn't loop.
    #[error("model resolve failed: {0}")]
    Resolve(String),

    /// An `ort` session failed to create. The fp16-Whisper subgraph defect and
    /// the missing-external-data cases are detected here and routed to the
    /// in-place patch / refetch recovery (see 03_stt_engine.md §6.1, §6.5).
    #[error("session create failed: {0}")]
    SessionCreate(String),

    /// Inference (encode/decode) raised. DirectML reshape-kernel crashes on the
    /// DML-incompatible families surface here when the CPU override was missed.
    #[error("inference failed: {0}")]
    Inference(String),

    /// Whisper greedy decode hit the 448-token cap without EOS and collapsed to a
    /// repeated-token wall. This is not usable text; callers should treat it as
    /// a failed decode rather than pasting it.
    #[error("degenerate Whisper decode: {0}")]
    DegenerateDecode(String),

    /// Tokenizer parse / decode failure (vocab.json, tokenizer.json, tokens.txt,
    /// or ONNX `custom_metadata_map` CMVN vectors).
    #[error("tokenizer error: {0}")]
    Tokenizer(String),

    /// The requested capability isn't supported by the resolved engine
    /// (e.g. word timestamps on a non-cross-attention export, streaming on a
    /// batch-only model).
    #[error("unsupported: {0}")]
    Unsupported(&'static str),
}

pub type SttResult<T> = Result<T, SttError>;

// ---------------------------------------------------------------------------
// Quantization / accelerator
// ---------------------------------------------------------------------------

/// The precision tier actually loaded. Maps to the HF file suffix
/// (`""` → default fp32 export, `fp16`, `int8`, `q4`, `q4f16`, `bnb4`, `uint8`).
/// `None`/`Default` means "the unsuffixed export on disk".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Quantization {
    #[default]
    Default, // ""  — unsuffixed export
    Fp16,
    Int8,
    Q4,
    Q4f16,
    Bnb4,
    Uint8,
}

impl Quantization {
    /// HF file suffix WITHOUT the separator (`""` for `Default`). The separator
    /// (`_` for onnx-community, `.` for Kaldi/sherpa) is chosen at glob time —
    /// see `resolver` spec §2 and `_file_quantization`.
    pub fn suffix(self) -> &'static str {
        match self {
            Quantization::Default => "",
            Quantization::Fp16 => "fp16",
            Quantization::Int8 => "int8",
            Quantization::Q4 => "q4",
            Quantization::Q4f16 => "q4f16",
            Quantization::Bnb4 => "bnb4",
            Quantization::Uint8 => "uint8",
        }
    }

    pub fn parse(s: &str) -> Option<Quantization> {
        Some(match s.trim() {
            "" => Quantization::Default,
            "fp16" => Quantization::Fp16,
            "int8" => Quantization::Int8,
            "q4" => Quantization::Q4,
            "q4f16" => Quantization::Q4f16,
            "bnb4" => Quantization::Bnb4,
            "uint8" => Quantization::Uint8,
            _ => return None,
        })
    }
}

/// Resolved ORT execution-provider intent. The user-facing setting
/// (`auto` / `cuda` / `directml` / `cpu` …) is collapsed to one of these by
/// `resolve_accelerator` (ported in 03_stt_engine.md §9).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Accelerator {
    Cpu,
    Cuda,
    DirectMl,
    CoreMl,
    Rocm,
    OpenVino,
}

/// Resolve `model.device` to the primary STT accelerator for this target.
///
/// CPU-first cross-platform milestone: the shipped Windows target uses DirectML for `auto`;
/// non-Windows defaults to CPU unless a validated provider feature is built for that target.
pub fn resolve_accelerator(device: crate::winstt::settings_schema::DeviceType) -> Accelerator {
    use crate::winstt::settings_schema::DeviceType;

    match device {
        DeviceType::Cpu => Accelerator::Cpu,
        DeviceType::Auto if cfg!(windows) => Accelerator::DirectMl,
        DeviceType::Auto if cfg!(all(target_os = "macos", feature = "coreml")) => {
            Accelerator::CoreMl
        }
        DeviceType::Auto if cfg!(all(target_os = "linux", feature = "cuda")) => Accelerator::Cuda,
        DeviceType::Auto if cfg!(all(target_os = "linux", feature = "rocm")) => Accelerator::Rocm,
        DeviceType::Auto => Accelerator::Cpu,
    }
}

/// Expand a primary accelerator to the ORT provider preference list.
/// CPU is included as the op/session fallback for non-CPU providers.
pub fn providers_for_accelerator(primary: Accelerator) -> Vec<Accelerator> {
    match primary {
        Accelerator::Cpu => vec![Accelerator::Cpu],
        other => vec![other, Accelerator::Cpu],
    }
}

// ---------------------------------------------------------------------------
// Shared ORT session/provider helpers (used by whisper.rs, moonshine.rs, families.rs)
// ---------------------------------------------------------------------------

/// Best-effort logical CPU count for `with_intra_threads` / `pick_intra_op_threads`.
/// Falls back to 4 when the platform can't report it.
pub(crate) fn num_cpus_best_effort() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Map our `Accelerator` list to ort `ExecutionProviderDispatch`es. CPU is always appended as
/// the op-level fallback. Platform/provider EPs are compiled only behind their target/feature
/// cfgs; unavailable accelerators are skipped and fall through to CPU at session creation.
pub(crate) fn execution_providers(
    providers: &[Accelerator],
) -> Vec<ort::ep::ExecutionProviderDispatch> {
    let mut out: Vec<ort::ep::ExecutionProviderDispatch> = Vec::new();
    for acc in providers {
        match acc {
            Accelerator::DirectMl => {
                #[cfg(windows)]
                {
                    out.push(ort::ep::DirectML::default().build());
                }
            }
            Accelerator::Cuda => {
                #[cfg(feature = "cuda")]
                {
                    out.push(ort::ep::CUDA::default().build());
                }
            }
            Accelerator::CoreMl => {
                #[cfg(all(target_os = "macos", feature = "coreml"))]
                {
                    out.push(ort::ep::CoreML::default().build());
                }
            }
            Accelerator::Rocm => {
                #[cfg(feature = "rocm")]
                {
                    out.push(ort::ep::ROCm::default().build());
                }
            }
            Accelerator::OpenVino => {
                #[cfg(feature = "openvino")]
                {
                    out.push(ort::ep::OpenVINO::default().build());
                }
            }
            _ => {}
        }
    }
    out.push(ort::ep::CPU::default().build());
    out
}

/// The ORT provider-name string for an `Accelerator` (diagnostics / logging).
pub(crate) fn provider_label(a: &Accelerator) -> String {
    match a {
        Accelerator::Cpu => "CPUExecutionProvider",
        Accelerator::Cuda => "CUDAExecutionProvider",
        Accelerator::DirectMl => "DmlExecutionProvider",
        Accelerator::CoreMl => "CoreMLExecutionProvider",
        Accelerator::Rocm => "ROCMExecutionProvider",
        Accelerator::OpenVino => "OpenVINOExecutionProvider",
    }
    .to_string()
}

/// Canonical sort key for `{past_key_values|present}.N.{decoder|encoder}.{key|value}` KV-cache
/// tensor names → `(layer index, sub-tensor rank)`, giving a total order independent of graph
/// iteration order. Strips whichever prefix is present, so it serves both the `past_key_values.`
/// (decoder inputs) and `present.` (decoder outputs) forms.
pub(crate) fn kv_sort_key(name: &str) -> (i64, i64) {
    let rest = name
        .trim_start_matches("past_key_values.")
        .trim_start_matches("present.");
    let mut parts = rest.split('.');
    let layer = parts
        .next()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(i64::MAX);
    let sub = match (parts.next(), parts.next()) {
        (Some("decoder"), Some("key")) => 0,
        (Some("decoder"), Some("value")) => 1,
        (Some("encoder"), Some("key")) => 2,
        (Some("encoder"), Some("value")) => 3,
        _ => 4,
    };
    (layer, sub)
}

// ---------------------------------------------------------------------------
// Family taxonomy
// ---------------------------------------------------------------------------

/// The decode-loop archetype an engine uses. Distinct from the catalog `family`
/// string (`whisper`/`moonshine`/`nemo`/`cohere`/`kaldi`/`gigaam`/`t-one`/
/// `sense_voice`/`dolphin`/`custom`) because several catalog families share a
/// decode loop (e.g. Vosk + Zipformer = transducer; Dolphin + SenseVoice = bare
/// CTC over a self-contained graph). Runtime provider routing is keyed to this
/// engine kind; catalog `family` remains input metadata for model resolution.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineKind {
    /// Optimum split encoder + `decoder_model_merged.onnx` with `use_cache_branch`
    /// and IoBinding KV-cache. Covers whisper-*, lite-whisper-*, distil-whisper-*,
    /// breeze-asr-25. Word timestamps when the export exposes `cross_attentions.*`.
    WhisperHf,
    /// onnxruntime-exported Whisper-base (single `whisper-base-ort` repo).
    WhisperOrt,
    /// 3-graph raw-audio encoder/decoder (`decoder_model.onnx` +
    /// `decoder_with_past_model.onnx`, no merged graph, no `use_cache_branch`).
    Moonshine,
    /// Conformer encoder + merged Transformer decoder; SentencePiece byte-fallback
    /// tokenizer; KV-cache branch implicit in past-tensor shapes (no flag input);
    /// fp16 KV-cache dtype must match the decoder's declared `past_key_values` type.
    CohereAsr,
    /// NeMo Conformer single-graph CTC (`model.onnx` → `logprobs`).
    NemoCtc,
    /// NeMo Conformer RNN-T (encoder + decoder_joint, stateful predictor).
    NemoRnnt,
    /// NeMo Conformer TDT (RNN-T joint that also emits a duration head → step).
    NemoTdt,
    /// NeMo Conformer AED (Canary): encoder + decoder with `decoder_mems`,
    /// static 10-token control prompt, native `target_language` translate.
    NemoAed,
    /// Kaldi / Vosk / icefall-Zipformer stateless-2-context transducer
    /// (encoder + decoder + joiner, `(-1, blank, *ctx)[-2:]` decoder context).
    KaldiTransducer,
    /// GigaAM v2/v3 CTC and RNN-T (NeMo-shaped graphs, GigaAM mel front-end).
    GigaamCtc,
    GigaamRnnt,
    /// T-One single-graph streaming CTC (Russian telephony).
    ToneCtc,
    /// Self-contained CTC graph + CMVN-in-metadata + FBANK/LFR front-end.
    /// Dolphin (`lob_probs`, blank=0) and SenseVoice (4 control tokens, base64
    /// vocab option) share the archetype but differ in front-end detail.
    DolphinCtc,
    SenseVoiceCtc,
    /// sherpa-onnx `OnlineRecognizer` streaming NeMo FastConformer **CTC** (single `model.onnx`).
    /// Cache-aware chunked streaming handled inside the sherpa runtime.
    NemoCtcStreaming,
    /// sherpa-onnx `OnlineRecognizer` streaming NeMo FastConformer **RNN-T** (encoder/decoder/joiner).
    NemoRnntStreaming,
    /// sherpa-onnx `OnlineRecognizer` streaming **Zipformer2 transducer** (encoder/decoder/joiner).
    KaldiTransducerStreaming,
}

impl EngineKind {
    /// Initial-prompt (decoder-bias) is ONLY meaningful for Whisper-family
    /// exports. Moonshine has no prompt slot; Canary/Cohere expose a
    /// `<|startofcontext|>` token that is UNTRAINED (filling it truncates /
    /// hallucinates) — so they are excluded. See memory
    /// `project_canary_cohere_prompt_slot_untrained` + `project_context_prompt_poisons_whisper`.
    pub fn supports_initial_prompt(self) -> bool {
        matches!(self, EngineKind::WhisperHf | EngineKind::WhisperOrt)
    }

    /// Native translate-to-English path. Whisper mutates the static decoder
    /// prompt (`<|transcribe|>` → `<|translate|>`); Canary uses the
    /// `target_language="en"` kwarg. Everything else is a no-op.
    pub fn supports_translate(self) -> bool {
        matches!(
            self,
            EngineKind::WhisperHf | EngineKind::WhisperOrt | EngineKind::NemoAed
        )
    }

    /// Cross-attention word-DTW is only available on Whisper `*_timestamped`
    /// exports; the engine still has to confirm `cross_attentions.*` outputs
    /// exist at load time (see `Transcriber::supports_word_timestamps`).
    pub fn may_support_word_timestamps(self) -> bool {
        matches!(self, EngineKind::WhisperHf)
    }

    /// Whether this engine's ONNX graph CRASHES/HANGS on DirectML (or other non-CUDA
    /// GPU EPs) in ORT 1.24 — **empirically measured** via the DirectML benchmark harness,
    /// NOT inherited from the reference's blanket family list. the reference excluded the whole
    /// `nemo`/`gigaam`/`t-one`/`kaldi`/`sense_voice`/`dolphin` families after testing ONE
    /// AED model, but only these actually fail on DML:
    ///   * `NemoAed` (Canary): conformer-encoder `Reshape` kernel crash (MLOperatorAuthorImpl).
    ///   * `CohereAsr`: `MultiHeadAttention` kernel crash.
    ///   * `KaldiTransducer` (zipformer/vosk), `SenseVoiceCtc`, `DolphinCtc`: silent hang/crash.
    ///   * Sherpa streaming Conformer/Zipformer graphs: CPU-pinned because DirectML is unstable
    ///     for the stateful streaming sessions.
    ///
    /// The NeMo CTC/TDT (parakeet) + GigaAM CTC + T-One CTC graphs RUN CORRECTLY and **2–3×
    /// FASTER on DirectML than CPU** (parakeet-ctc 73 vs 223ms, parakeet-tdt 144 vs 270ms,
    /// gigaam-ctc 51 vs 134ms, t-one 913 vs 1916ms) — so they are NOT here and keep the GPU EP.
    /// Whisper keeps GPU (IoBinding); Moonshine is CPU-pinned separately (perf for a tiny model).
    /// int8 stays the auto quant for these — int8-on-DML beats fp32-on-DML here.
    pub fn is_dml_incompatible(self) -> bool {
        matches!(
            self,
            EngineKind::NemoAed
                | EngineKind::CohereAsr
                | EngineKind::KaldiTransducer
                | EngineKind::SenseVoiceCtc
                | EngineKind::DolphinCtc
                | EngineKind::NemoCtcStreaming
                | EngineKind::NemoRnntStreaming
                | EngineKind::KaldiTransducerStreaming
        )
    }

    /// Works on DirectML but is FASTER on CPU at THIS quant → routed to CPU as a PERF choice
    /// (distinct from `is_dml_incompatible`, which is a crash). EMPIRICALLY per-(engine, quant):
    /// the RNN-T transducers run a per-ENCODER-FRAME predictor/joint loop (hundreds of tiny ops).
    /// On DirectML each is a kernel launch, AND a QUANTIZED (int8/QDQ) graph additionally demotes
    /// its QuantizeLinear/DequantizeLinear nodes to CPU per-op — so QUANTIZED RNN-T loses to CPU
    /// (parakeet-rnnt int8: CPU 252 vs DML 361ms; gigaam-rnnt int8 ≈ tie). But FLOAT RNN-T (fp32/
    /// fp16, no QDQ demotion) WINS on DML (parakeet-rnnt fp32: DML 120 vs CPU 322; gigaam-rnnt fp32:
    /// DML 126 vs CPU 211). So: quantized RNN-T → CPU, float RNN-T → DML. The CTC/TDT single-pass
    /// engines win on DML at EVERY quant (gigaam-ctc fp32 32ms / int8 51ms both « CPU), so excluded.
    pub fn dml_slower_than_cpu(self, quant: Quantization) -> bool {
        matches!(self, EngineKind::NemoRnnt | EngineKind::GigaamRnnt)
            && matches!(
                quant,
                Quantization::Int8
                    | Quantization::Q4
                    | Quantization::Q4f16
                    | Quantization::Bnb4
                    | Quantization::Uint8
            )
    }

    /// True iff this kind has a cache-aware/stateful streaming ONNX graph we drive chunk-by-chunk
    /// (carrying encoder/predictor state across `Transcriber::stream_accept`), so the realtime
    /// worker feeds only NEW samples per tick instead of re-decoding a growing window. Today only
    /// T-One — its PUBLISHED graph IS the streaming graph (single stateful session). The streaming
    /// FastConformer/Zipformer variants join this as they land. The OFFLINE graphs
    /// (NemoCtc/NemoRnnt/KaldiTransducer/Gigaam*/…) are NOT here — they re-encode the whole clip, so
    /// they use the committed-watermark window-redecode preview + the VAD-segment final.
    pub fn supports_native_streaming(self) -> bool {
        matches!(
            self,
            EngineKind::ToneCtc
                | EngineKind::NemoCtcStreaming
                | EngineKind::NemoRnntStreaming
                | EngineKind::KaldiTransducerStreaming
        )
    }

    /// True iff decode quality depends on cross-chunk CONTEXT (an autoregressive attention decoder /
    /// a fixed receptive window) — so a properly VAD-segmented decode is the AUTHORITATIVE final and
    /// the chunked realtime preview must NOT be reused as the paste. These are the attention
    /// encoder-decoder families. The frame-synchronous CTC / transducer / non-autoregressive
    /// families have no cross-utterance text dependence, so their realtime output CAN be reused as
    /// the final (the reuse-vs-retranscribe policy keys off this).
    pub fn needs_past_context(self) -> bool {
        matches!(
            self,
            EngineKind::WhisperHf
                | EngineKind::WhisperOrt
                | EngineKind::NemoAed
                | EngineKind::CohereAsr
        )
    }

    /// True when the latest realtime preview can safely be promoted to the final paste.
    /// Context-dependent attention decoders still need a fresh full-context final decode.
    pub fn final_reuse_safe(self) -> bool {
        !self.needs_past_context()
    }
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/// Per-call decode options. All optional; defaults reproduce the Python
/// `recognize()` default behavior (greedy, no timestamps, model auto-detects
/// language when multilingual). Fields the resolved engine doesn't honor are
/// silently ignored (Moonshine ignores `language`; Cohere ignores
/// `initial_prompt_text`; etc.).
#[derive(Clone, Debug, Default)]
pub struct TranscribeOptions {
    /// Whisper/NeMo/SenseVoice language hint (`"en"`, `"ru"`, `""` = auto).
    pub language: Option<String>,
    /// Translate source → English (Whisper prompt mutation / Canary kwarg).
    pub translate: bool,
    /// Decoder-bias text — Whisper-only (`supports_initial_prompt`). NEVER set
    /// for Canary/Cohere. Must be sanitized upstream (see context slice).
    pub initial_prompt_text: Option<String>,
    /// Emit `<|t|>` segment timestamps (Whisper) — drops `<|notimestamps|>`.
    pub return_timestamps: bool,
    /// Emit per-word timings via cross-attention DTW (Whisper `*_timestamped`).
    pub return_word_timestamps: bool,
    /// Greedy when 1 (default). Whisper-only beam (`_winstt_beam_size`).
    pub beam_size: u32,
}

/// One word with start/end seconds (cross-attention DTW result).
#[derive(Clone, Debug, PartialEq)]
pub struct WordResult {
    pub text: String,
    pub start: f32,
    pub end: f32,
}

/// One `(start_s, end_s, text)` Whisper segment.
#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

/// Full transcription result. Mirrors `TimestampedResult` from `asr.py`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Transcription {
    pub text: String,
    pub segments: Option<Vec<Segment>>,
    pub words: Option<Vec<WordResult>>,
}

/// One native-streaming update from a cache-aware engine.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NativeStreamUpdate {
    pub text: String,
    pub is_final: bool,
}

impl NativeStreamUpdate {
    pub fn interim(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_final: false,
        }
    }
}

// ---------------------------------------------------------------------------
// The core trait
// ---------------------------------------------------------------------------

/// Unified speech-to-text engine. Every family-specific struct implements this.
///
/// Contract:
/// * `transcribe` takes mono 16 kHz f32 PCM in `[-1, 1]`. Peak-normalize to 0.95
///   happens in the CALLER (`transcription_coordinator`), NOT here — mirroring
///   the single `_peak_normalize` chokepoint in Python. Engines receive
///   already-conditioned audio and must NOT add denoising / pre-emphasis / dither
///   (see memory `project_stt_premodel_conditioning_policy`).
/// * Implementations must be `Send` (loaded engine lives behind a `Mutex` in the
///   coordinator) but need NOT be `Sync` (single inference at a time, guarded by
///   `_infer_lock`).
/// * Engines must be panic-tolerant in the sense that internal allocation failures
///   should return `SttError` where feasible, but the COORDINATOR owns the
///   `catch_unwind` boundary (load-bearing `panic = "unwind"`), so a hard ORT
///   panic is acceptable and recovered upstream.
pub trait Transcriber: Send {
    /// Which decode archetype this engine is (for capability routing / logging).
    fn kind(&self) -> EngineKind;

    /// The HF repo id / alias this engine was loaded from (for cache + logs).
    fn model_name(&self) -> &str;

    /// True once all ORT sessions are created and the tokenizer is parsed.
    fn is_ready(&self) -> bool;

    /// ORT EPs actually active on the primary session (post-fallback). Lets the
    /// coordinator report whether the GPU path engaged.
    fn active_providers(&self) -> &[String];

    /// True iff this loaded export exposes `cross_attentions.*` decoder outputs
    /// (confirmed at load, not just from `EngineKind`).
    fn supports_word_timestamps(&self) -> bool {
        false
    }

    /// Transcribe one utterance. `audio` is mono 16 kHz f32 PCM.
    ///
    /// DRAFT: body lives behind the de-risking spike. See 03_stt_engine.md §4–§6.
    fn transcribe(&mut self, audio: &[f32], opts: &TranscribeOptions) -> SttResult<Transcription>;

    /// Run a best-effort dummy inference to initialize provider kernels/caches.
    /// Engines can override this when full transcription on synthetic silence is
    /// a poor health check.
    fn warmup(&mut self, audio: &[f32], opts: &TranscribeOptions) -> SttResult<()> {
        self.transcribe(audio, opts).map(|_| ())
    }

    // ── Native-streaming hooks (default = batch-only no-ops) ──────────────────────────────
    // A cache-aware engine (T-One, streaming FastConformer/Zipformer) carries encoder/predictor
    // state across chunks, so the realtime worker can feed only the NEW samples each tick via
    // `stream_accept` instead of re-decoding a growing window. Batch-only engines keep the default
    // window-redecode path. The engine owns chunk buffering/alignment internally.

    /// True iff this engine implements the streaming hooks below (carries cross-chunk state).
    fn supports_native_streaming(&self) -> bool {
        false
    }

    /// Feed the next 16 kHz PCM chunk, advance cached state, return the incremental text so far.
    /// Only valid when `supports_native_streaming()`; default errors.
    fn stream_accept(&mut self, _pcm: &[f32]) -> SttResult<NativeStreamUpdate> {
        Err(SttError::Unsupported(
            "stream_accept on a batch-only engine",
        ))
    }

    /// Flush the streaming tail (drain right-context) and return the final text. Default empty.
    fn stream_finalize(&mut self) -> SttResult<String> {
        Ok(String::new())
    }

    /// Zero all carried streaming state for a new utterance. Default no-op.
    fn stream_reset(&mut self) {}

    /// Release every ORT session (idempotent). Mirrors `BaseAsr.close()` —
    /// nulls sessions + forces drop so the C++ destructors fire before any
    /// subsequent model load on Windows (avoids the DLL-unload race). Rust's
    /// `Drop` handles most of this, but an explicit hook lets the coordinator
    /// unload-before-load during a model swap.
    fn shutdown(&mut self) {}
}

// ---------------------------------------------------------------------------
// Engine construction surface (resolver → load)
// ---------------------------------------------------------------------------

/// Resolved file set for ONE model at ONE quantization. Produced by the resolver
/// (03_stt_engine.md §2). Keys are the logical names each engine's loader looks
/// up (`encoder`, `decoder`, `vocab`, `tokenizer`, `model`, `joiner`, …).
#[derive(Clone, Debug, Default)]
pub struct ResolvedModel {
    pub files: std::collections::BTreeMap<String, PathBuf>,
    /// The quantization that was actually resolved on disk (after int8-preferred
    /// / DML fallback resolution). The picker badge must check THIS, not the raw
    /// requested quant (memory `project_effective_quantization_bridge`).
    pub effective_quantization: Quantization,
}

/// Everything an engine needs to build its ORT sessions.
pub struct EngineConfig {
    pub model_name: String,
    pub family: String,
    pub kind: EngineKind,
    pub resolved: ResolvedModel,
    /// Final provider list AFTER `resolve_accelerator` + the DML-incompatible
    /// override. `[CPUExecutionProvider]` for the forced-CPU families.
    pub providers: Vec<Accelerator>,
    /// Whether this load needs the Whisper fp16 `ORT_ENABLE_EXTENDED` downgrade
    /// (gated on the whisper family AND fp16 — see 03_stt_engine.md §6.2).
    pub whisper_fp16_workaround: bool,
}

/// Factory: build the right `Transcriber` for a resolved model. Dispatch table in
/// 03_stt_engine.md §3. The Whisper-family arm (`WhisperHf`, covering whisper /
/// lite-whisper / distil-whisper / breeze) is implemented; the remaining family
/// engines (Moonshine / Cohere / NeMo / Kaldi / GigaAM / T-One / Dolphin / SenseVoice)
/// are owned by their respective slices and land as they're ported.
pub fn build_engine(cfg: EngineConfig) -> SttResult<Box<dyn Transcriber>> {
    match cfg.kind {
        // Whisper family (whisper / lite-whisper / distil / crisper) — PROVEN via the STT spike.
        EngineKind::WhisperHf => Ok(Box::new(whisper::WhisperEngine::load(&cfg)?)),
        // Own engine files not yet ported.
        EngineKind::WhisperOrt => Err(SttError::Unsupported(
            "WhisperOrt engine not yet ported (PORT/03 §4.1 whisper_ort)",
        )),
        EngineKind::Moonshine => Ok(Box::new(moonshine::MoonshineEngine::load(&cfg)?)),
        // All other families dispatch through `families::build_family_engine` (SenseVoice /
        // Dolphin / NeMo {Ctc,Rnnt,Tdt,Aed} / Kaldi / GigaAM / Cohere). Their numerics are
        // drafted but spike-gated — the LIVE path only enables a family after it's validated
        // (see `engine_kind_for` whitelist in managers/transcription.rs); the spike harness
        // (`stt_spike --catalog`) reaches them directly to drive that validation.
        _ => families::build_family_engine(cfg),
    }
}

// ---------------------------------------------------------------------------
// Pure-logic helpers (VERIFIED by hand + unit-tested). These are the safe
// deterministic ports; everything ML stays a stub above.
// ---------------------------------------------------------------------------

/// Port of `asr._vocab_is_uppercase`: report whether ≳90% of the vocab's cased
/// tokens are UPPERCASE — identifies icefall/Kaldi LibriSpeech BPE vocabs
/// (e.g. `sherpa-onnx-zipformer-en`) whose ALL-CAPS output must be lowercased
/// for dictation. Special markers (`<…>`) and uncased tokens (digits, `▁`, CJK)
/// are ignored; a vocab with no cased real tokens returns false.
pub fn vocab_is_uppercase<'a>(tokens: impl IntoIterator<Item = &'a str>) -> bool {
    let mut cased_total = 0usize;
    let mut upper = 0usize;
    for t in tokens {
        let is_marker = t.starts_with('<') && t.ends_with('>');
        // "cased" == lowercasing changes it differently than uppercasing
        // (i.e. it has at least one cased letter). Mirrors Python `t.lower() != t.upper()`.
        let has_case = t.to_lowercase() != t.to_uppercase();
        if has_case && !is_marker {
            cased_total += 1;
            if t == t.to_uppercase() {
                upper += 1;
            }
        }
    }
    if cased_total == 0 {
        return false;
    }
    (upper as f64) / (cased_total as f64) > 0.9
}

/// Port of the int8-preferred / fp16-auto resolution from
/// `bootstrap._resolve_quantization`, reduced to the (already EP-resolved)
/// decision. `param_count` gates fp16 auto-promotion (≥500M on CUDA only);
/// `available` is the catalog's published quant set (`None` = unknown / off-catalog,
/// permissive). Returns the quant to actually load.
///
/// NOTE: the FULL function also rejects sub-fp16 quants on CUDA and warns on
/// unpublished concrete quants — those branches are specified in 03_stt_engine.md §7
/// and folded into the resolver; this helper covers the AUTO path that the unit
/// test pins.
pub fn resolve_quantization_auto(
    requested: Quantization,
    accelerator: Accelerator,
    family: &str,
    param_count: u64,
    available: Option<&[Quantization]>,
) -> Quantization {
    const FP16_AUTO_PARAM_THRESHOLD: u64 = 500_000_000;
    let publishes = |q: Quantization| available.is_none_or(|a| a.contains(&q));

    // Only the AUTO path ("" / Default) auto-resolves; concrete requests pass
    // through the fuller resolver (see spec §7). Here `Default` IS the auto sentinel.
    if requested != Quantization::Default {
        return requested;
    }
    let _ = family; // accuracy-first default no longer keys off the int8-preferred family list
    if accelerator == Accelerator::Cuda
        && param_count >= FP16_AUTO_PARAM_THRESHOLD
        && publishes(Quantization::Fp16)
    {
        return Quantization::Fp16;
    }
    // ACCURACY-FIRST default: load the model's NATURAL unsuffixed (fp32) export when it's
    // published — do NOT silently downgrade to int8. int8 trades accuracy for speed/size and is
    // the USER's call (the picker exposes every published quant off-CUDA). This also tends to be
    // FASTER on DirectML (gigaam-ctc fp32 32ms < int8 51ms — DML doesn't accelerate int8/QDQ).
    // int8-only models (sense_voice/dolphin publish no fp32) fall back to int8.
    if publishes(Quantization::Default) {
        return Quantization::Default;
    }
    if publishes(Quantization::Int8) {
        return Quantization::Int8;
    }
    Quantization::Default
}

/// Runtime footprint bytes-per-param at each quant — mirrors the renderer fit-assessor
/// `BYTES_PER_PARAM_BY_QUANT` (fp32 4, fp16 2, int8/uint8 1.2, 4-bit 0.75).
fn bytes_per_param(q: Quantization) -> f64 {
    match q {
        Quantization::Default => 4.0,
        Quantization::Fp16 => 2.0,
        Quantization::Int8 | Quantization::Uint8 => 1.2,
        Quantization::Q4 | Quantization::Q4f16 | Quantization::Bnb4 => 0.75,
    }
}

/// Accuracy/faithfulness weight (higher = more accurate) — mirrors the picker's
/// `QUANTIZATION_WEIGHT` ("" 32, fp16 16, int8/uint8 8, q4f16 6, bnb4/q4 4).
fn accuracy_weight(q: Quantization) -> u32 {
    match q {
        Quantization::Default => 32,
        Quantization::Fp16 => 16,
        Quantization::Int8 | Quantization::Uint8 => 8,
        Quantization::Q4f16 => 6,
        Quantization::Bnb4 | Quantization::Q4 => 4,
    }
}

/// RAM/VRAM-aware AUTO quant: the HIGHEST-ACCURACY published quant whose runtime footprint
/// (`param_count × bytes_per_param`) FITS the user's hardware — degrading fp32→fp16→int8→q4 only as
/// needed. This is the smart "auto" the user asked for (NOT a blind int8, NOT a blind fp32): a roomy
/// box keeps fp32 (best accuracy); a tight box steps down to what fits. The fit BUDGET is the device
/// the (engine, quant) actually runs on (per `override_dml_to_cpu_for_kind`): VRAM for a DML engine,
/// available system RAM for a CPU engine. Budgets in bytes (0 = unknown → permissive, never blocks).
/// If nothing fits, the most-compact published quant. Concrete user picks bypass this (explicit).
pub fn fit_aware_auto_quant(
    available: &[Quantization],
    kind: EngineKind,
    primary: Accelerator,
    param_count: u64,
    available_ram_bytes: u64,
    vram_bytes: u64,
) -> Quantization {
    const GPU_HEADROOM: f64 = 1.5; // matches catalog_data GPU_HEADROOM
    const RAM_USABLE_FRACTION: f64 = 0.7; // matches fit-assessor cpuBudget
                                          // Accuracy order best→worst.
    const ORDER: &[Quantization] = &[
        Quantization::Default,
        Quantization::Fp16,
        Quantization::Int8,
        Quantization::Uint8,
        Quantization::Q4f16,
        Quantization::Bnb4,
        Quantization::Q4,
    ];
    for &q in ORDER {
        if !available.contains(&q) {
            continue;
        }
        let footprint = (param_count as f64) * bytes_per_param(q);
        // Resolve the ACTUAL device for (kind, q) under the user's primary: CPU-device → always CPU
        // (RAM budget); GPU primary → the per-(engine,quant) override decides DML vs CPU. Only a
        // VRAM-backed EP (DirectML/CUDA) uses the VRAM budget.
        let routed = override_dml_to_cpu_for_kind(providers_for_accelerator(primary), kind, q);
        let on_gpu = matches!(
            routed.first(),
            Some(Accelerator::DirectMl) | Some(Accelerator::Cuda)
        );
        let fits = if on_gpu {
            vram_bytes == 0 || footprint * GPU_HEADROOM <= vram_bytes as f64
        } else {
            available_ram_bytes == 0
                || footprint <= available_ram_bytes as f64 * RAM_USABLE_FRACTION
        };
        if fits {
            return q;
        }
    }
    // Nothing fits the budget — fall back to the most-compact (lowest-accuracy-weight) published quant.
    available
        .iter()
        .copied()
        .min_by_key(|q| accuracy_weight(*q))
        .unwrap_or(Quantization::Default)
}

/// EngineKind-based DML→CPU override. This is the runtime provider-routing policy:
/// the reference blanket-excluded whole families; we measured per-engine with the
/// DirectML benchmark harness and route to CPU only when DML CRASHES
/// (`is_dml_incompatible`: AED decoders + unstable sherpa graphs) OR is SLOWER than CPU
/// (`dml_slower_than_cpu`: the RNN-T predictor-loop transducers). The NeMo CTC/TDT +
/// GigaAM-CTC + T-One graphs run 2–3× faster on DML, so they keep the GPU EP.
/// Only fires for non-CUDA GPU EPs; CUDA/CPU/None pass through.
pub fn override_dml_to_cpu_for_kind(
    providers: Vec<Accelerator>,
    kind: EngineKind,
    quant: Quantization,
) -> Vec<Accelerator> {
    if !kind.is_dml_incompatible() && !kind.dml_slower_than_cpu(quant) {
        return providers;
    }
    match providers.first().copied() {
        Some(Accelerator::Cuda) | Some(Accelerator::Cpu) | None => providers,
        Some(
            Accelerator::DirectMl | Accelerator::Rocm | Accelerator::CoreMl | Accelerator::OpenVino,
        ) => vec![Accelerator::Cpu],
    }
}

/// CTC greedy collapse: argmax already done → ids; drop `blank_id`, collapse
/// consecutive repeats. Pure port of `sense_voice._ctc_greedy_decode` /
/// the `_AsrWithCtcDecoding` collapse. Returns the surviving token ids.
pub fn ctc_greedy_collapse(ids: &[i64], blank_id: i64) -> Vec<i64> {
    // Collapsed output is always <= input length — exact upper bound, no reallocs.
    let mut out = Vec::with_capacity(ids.len());
    let mut prev: i64 = -1;
    for &t in ids {
        if t != blank_id && t != prev {
            out.push(t);
        }
        prev = t;
    }
    out
}

/// `intra_op_num_threads` pick from `onnxasr_transcriber._pick_intra_op_threads`:
/// CPU EP uses physical cores capped at 16; GPU EP uses 2 feeder threads.
/// (0 = "all cores" is 49–84% SLOWER — never use the default.)
pub fn pick_intra_op_threads(is_gpu: bool, cpu_count: usize) -> usize {
    // Benchmark compatibility override: `SPIKE_INTRA_THREADS` is the existing env var used to
    // sweep the intra-op thread count without recompiling (0 = let ORT auto-pick = physical cores,
    // matching onnx-asr's default).
    if let Ok(Ok(n)) = std::env::var("SPIKE_INTRA_THREADS").map(|v| v.trim().parse::<usize>()) {
        return n;
    }
    if is_gpu {
        // GPU EP does the compute; CPU threads only feed it. 2 is enough (more contend).
        return 2;
    }
    // CPU EP: use PHYSICAL cores (matches onnx-asr / onnxruntime's own default, which kept
    // pace with us — the old hard `min(logical, 8)` cap left ~12% on the table on this 24-logical
    // box: 16 threads beat 8). `get_physical()` avoids HT over-subscription; capped at 16 for
    // diminishing returns on big servers, and never exceeds the logical count (sanity).
    num_cpus::get_physical().min(cpu_count).clamp(1, 16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uppercase_vocab_detected_for_kaldi_caps() {
        // sherpa-onnx-zipformer-en style: all-caps real tokens + markers.
        let vocab = ["<blk>", "<unk>", "THE", "QUICK", "BROWN", "FOX", "▁", "123"];
        assert!(vocab_is_uppercase(vocab));
    }

    #[test]
    fn mixed_case_vocab_not_flagged() {
        let vocab = ["<blk>", "the", "Quick", "brown", "Fox", "▁hello"];
        assert!(!vocab_is_uppercase(vocab));
    }

    #[test]
    fn cjk_only_vocab_not_flagged() {
        // No cased letters at all → false (matches Python: cased list empty).
        let vocab = ["<blk>", "你", "好", "▁", "。"];
        assert!(!vocab_is_uppercase(vocab));
    }

    #[test]
    fn ctc_collapse_drops_blanks_and_repeats() {
        // blank=0; "a a _ a b b" → "a a b"
        assert_eq!(ctc_greedy_collapse(&[1, 1, 0, 1, 2, 2], 0), vec![1, 1, 2]);
    }

    #[test]
    fn ctc_collapse_empty() {
        assert!(ctc_greedy_collapse(&[], 0).is_empty());
        assert!(ctc_greedy_collapse(&[0, 0, 0], 0).is_empty());
    }

    #[test]
    fn auto_resolves_accuracy_first_to_fp32_when_published() {
        // nemo on DirectML (non-CUDA): ACCURACY-FIRST → the natural fp32 export when published,
        // NOT a silent int8 downgrade (the user picks int8 in the picker for speed/size).
        let q = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::DirectMl,
            "nemo",
            600_000_000,
            Some(&[Quantization::Default, Quantization::Int8]),
        );
        assert_eq!(q, Quantization::Default);
        // int8-only models (no fp32 published, e.g. sense_voice/dolphin) fall back to int8.
        let q_int8_only = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::DirectMl,
            "dolphin",
            100_000_000,
            Some(&[Quantization::Int8]),
        );
        assert_eq!(q_int8_only, Quantization::Int8);
    }

    #[test]
    fn int8_not_forced_when_unpublished() {
        // t-one publishes only "" → stays Default even though int8-preferred.
        let q = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::Cpu,
            "t-one",
            71_700_000,
            Some(&[Quantization::Default]),
        );
        assert_eq!(q, Quantization::Default);
    }

    #[test]
    fn fp16_auto_only_for_large_on_cuda() {
        // whisper large-v3-turbo (795M) on CUDA, publishes fp16 → fp16.
        let big = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::Cuda,
            "whisper",
            795_800_000,
            Some(&[Quantization::Default, Quantization::Fp16]),
        );
        assert_eq!(big, Quantization::Fp16);
        // whisper tiny (37M) on CUDA → stays Default (cast overhead dominates).
        let small = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::Cuda,
            "whisper",
            37_800_000,
            Some(&[Quantization::Default, Quantization::Fp16]),
        );
        assert_eq!(small, Quantization::Default);
    }

    #[test]
    fn fp16_auto_never_on_cpu_for_whisper() {
        // Large whisper on CPU/DML → Default (CPU EP has no fp16 kernels;
        // whisper is NOT int8-preferred so it doesn't pick int8 either).
        let q = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::DirectMl,
            "whisper",
            1_550_000_000,
            Some(&[Quantization::Default, Quantization::Fp16]),
        );
        assert_eq!(q, Quantization::Default);
    }

    #[test]
    fn cpu_device_resolves_to_cpu_accelerator() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Cpu),
            Accelerator::Cpu
        );
    }

    #[cfg(windows)]
    #[test]
    fn auto_device_resolves_to_directml_on_windows() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Auto),
            Accelerator::DirectMl
        );
    }

    #[cfg(all(
        not(windows),
        not(all(target_os = "macos", feature = "coreml")),
        not(all(target_os = "linux", feature = "cuda")),
        not(all(target_os = "linux", feature = "rocm"))
    ))]
    #[test]
    fn auto_device_resolves_to_cpu_without_non_windows_gpu_features() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Auto),
            Accelerator::Cpu
        );
    }

    #[cfg(all(target_os = "macos", feature = "coreml"))]
    #[test]
    fn auto_device_resolves_to_coreml_on_macos_coreml_builds() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Auto),
            Accelerator::CoreMl
        );
    }

    #[cfg(all(target_os = "linux", feature = "cuda"))]
    #[test]
    fn auto_device_resolves_to_cuda_on_linux_cuda_builds() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Auto),
            Accelerator::Cuda
        );
    }

    #[cfg(all(target_os = "linux", not(feature = "cuda"), feature = "rocm"))]
    #[test]
    fn auto_device_resolves_to_rocm_on_linux_rocm_builds() {
        assert_eq!(
            resolve_accelerator(crate::winstt::settings_schema::DeviceType::Auto),
            Accelerator::Rocm
        );
    }

    #[test]
    fn provider_preference_list_keeps_cpu_fallback_only_when_needed() {
        assert_eq!(
            providers_for_accelerator(Accelerator::Cpu),
            vec![Accelerator::Cpu]
        );
        assert_eq!(
            providers_for_accelerator(Accelerator::DirectMl),
            vec![Accelerator::DirectMl, Accelerator::Cpu]
        );
    }

    #[test]
    fn dml_incompatible_engine_forced_to_cpu() {
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                EngineKind::NemoAed,
                Quantization::Default
            ),
            vec![Accelerator::Cpu]
        );
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                EngineKind::NemoCtcStreaming,
                Quantization::Default
            ),
            vec![Accelerator::Cpu]
        );
        // Engine kinds measured as DML-safe keep DML.
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                EngineKind::NemoCtc,
                Quantization::Default
            ),
            vec![Accelerator::DirectMl, Accelerator::Cpu]
        );
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                EngineKind::ToneCtc,
                Quantization::Default
            ),
            vec![Accelerator::DirectMl, Accelerator::Cpu]
        );
        // CUDA passes through even for an incompatible engine.
        assert_eq!(
            override_dml_to_cpu_for_kind(
                vec![Accelerator::Cuda, Accelerator::Cpu],
                EngineKind::CohereAsr,
                Quantization::Default
            ),
            vec![Accelerator::Cuda, Accelerator::Cpu]
        );
    }

    #[test]
    fn engine_kind_capability_gates() {
        assert!(EngineKind::WhisperHf.supports_initial_prompt());
        assert!(!EngineKind::Moonshine.supports_initial_prompt());
        // Canary/Cohere prompt slot is UNTRAINED → no initial prompt.
        assert!(!EngineKind::CohereAsr.supports_initial_prompt());
        assert!(!EngineKind::NemoAed.supports_initial_prompt());
        // Translate: whisper + canary only.
        assert!(EngineKind::NemoAed.supports_translate());
        assert!(!EngineKind::CohereAsr.supports_translate());
        // Word timestamps possible only on WhisperHf (still load-confirmed).
        assert!(EngineKind::WhisperHf.may_support_word_timestamps());
        assert!(!EngineKind::WhisperOrt.may_support_word_timestamps());
        // Native streaming is a strict subset of final-reuse-safe models.
        assert!(EngineKind::ToneCtc.supports_native_streaming());
        assert!(EngineKind::NemoCtcStreaming.supports_native_streaming());
        assert!(EngineKind::NemoRnntStreaming.supports_native_streaming());
        assert!(EngineKind::KaldiTransducerStreaming.supports_native_streaming());
        assert!(!EngineKind::NemoCtc.supports_native_streaming());
        assert!(EngineKind::ToneCtc.final_reuse_safe());
        assert!(EngineKind::GigaamCtc.final_reuse_safe());
        assert!(!EngineKind::WhisperHf.final_reuse_safe());
        assert!(!EngineKind::NemoAed.final_reuse_safe());
    }

    #[test]
    fn intra_op_threads_policy() {
        assert_eq!(pick_intra_op_threads(true, 16), 2); // GPU
        let physical = num_cpus::get_physical();
        assert_eq!(
            pick_intra_op_threads(false, 16),
            physical.min(16).clamp(1, 16)
        );
        assert_eq!(
            pick_intra_op_threads(false, 4),
            physical.min(4).clamp(1, 16)
        );
        assert_eq!(pick_intra_op_threads(false, 0), 1); // floor
    }
}
