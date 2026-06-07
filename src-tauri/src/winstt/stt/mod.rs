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

// ── split-out concern submodules ──
// foo.rs->foo/ directory split (mechanical, behavior-preserving). Each holds a self-contained
// cluster that was inline here; the flat re-exports below preserve every `crate::winstt::stt::X`
// path and sibling `super::X` reference EXACTLY. Leaf dependency order: device <- engine_kind <-
// quant_resolve.
/// Quantization + Accelerator types, EP resolution, and the shared ORT session/provider helpers.
mod device;
/// The EngineKind decode-archetype taxonomy enum and its capability/provider-routing policy methods.
mod engine_kind;
/// Pure quant/fit/device-routing decision helpers (+ deterministic CTC/thread/vocab) with tests.
mod quant_resolve;

pub use device::{providers_for_accelerator, resolve_accelerator, Accelerator, Quantization};
pub use engine_kind::EngineKind;
pub use quant_resolve::{
    ctc_greedy_collapse, fit_aware_auto_quant, override_dml_to_cpu_for_kind, pick_intra_op_threads,
    resolve_quantization_auto, vocab_is_uppercase,
};
// Crate-internal session/provider helpers — keep `pub(crate)` (NOT `pub`) to avoid widening the
// public API surface (used by whisper.rs / moonshine.rs / families.rs via `super::`).
pub(crate) use device::{execution_providers, kv_sort_key, num_cpus_best_effort, provider_label};

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
    /// Candidate language hints used when `language` is None. Empty means unconstrained auto.
    pub language_candidates: Vec<String>,
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
