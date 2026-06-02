// DRAFT PORT — not yet compiled. Source: onnx-asr fork (E:/DL/Projects/onnx-asr/src/onnx_asr/),
// WinSTT server (server/src/recorder/infrastructure/onnxasr_transcriber.py, device.py, bootstrap.py).
//
// Unified ort-ONNX STT engine — public trait surface + family enum + per-family engine STUBS.
//
// This module is the Rust re-port of onnx-asr onto raw `ort` 2.x. It deliberately
// contains ONLY interface stubs (signatures + doc contracts + a few pure-logic helpers
// with tests). The heavy decode loops, IoBinding KV-cache wiring, and per-model
// numerical fixes are SPECIFIED — not implemented — in `app/PORT/03_stt_engine.md`,
// gated behind the mandatory de-risking spike described there.
//
// Why stubs and not a full impl: every line of the decode loops depends on exact ORT
// tensor shapes / dtypes / IoBinding semantics that can only be verified against a real
// `ort` session. Writing speculative bodies now would be guesswork that the compile loop
// would have to rewrite anyway. The pure-logic pieces that CAN be verified by hand
// (vocab-uppercase detection, CTC greedy collapse, int8/fp16 resolution, DML-incompat
// routing, the alignment-heads dimension table) are implemented with `#[cfg(test)]` tests.
//
// Honored invariants (see 03_stt_engine.md §10 for the full list):
//   * Silero VAD = CPU-only (CUDA/DML deadlock) — enforced in the VAD slice, not here.
//   * NeMo / Cohere / GigaAM / Kaldi / SenseVoice / Dolphin / T-One = DirectML-incompatible
//     → forced to CPU EP (`DmlIncompatibleFamily`).
//   * Canary / Cohere `<|startofcontext|>` prompt slot is UNTRAINED → never inject an
//     initial-prompt bias for those families (`EngineKind::supports_initial_prompt`).
//   * `panic = "unwind"` stays load-bearing — `transcribe()` is wrapped in `catch_unwind`
//     by the caller (transcription_coordinator); engines must be panic-safe but the
//     coordinator owns the catch.

#![allow(dead_code)] // DRAFT: surface defined ahead of the implementations / call sites.

use std::path::PathBuf;

// ── engine submodules ──
/// Log-mel feature extraction (Slaney 80/128-mel) shared by Whisper-family engines.
pub mod mel;
/// Hand-rolled Whisper BPE/byte tokenizer + special-token table + segment parser.
pub mod whisper_tokenizer;
/// Whisper / lite-whisper / distil-whisper ONNX engine (encoder + merged-decoder KV-cache).
pub mod whisper;
/// Moonshine ONNX engine (raw-audio encoder + 3-graph decoder KV-cache, SentencePiece tokenizer).
pub mod moonshine;
/// HF snapshot resolver + download + sharded-data completeness + per-quant cache.
pub mod resolver;
/// On-disk HF-cache probe (per-model per-quant cached/partial/not_cached) for the picker badges.
pub mod cache_probe;
/// In-file fp16 decoder protobuf repair (prost) + external-data refetch detection.
pub mod fp16_patch;
/// Non-Whisper families: CTC (SenseVoice/GigaAM/Dolphin/Kaldi), RNNT/TDT (Parakeet/zipformer), AED (Canary/Cohere).
pub mod families;
/// Embedded GigaAM v3 analysis window [320] + 64-mel filterbank [161,64] (from onnx_asr fbanks.npz).
pub mod gigaam_v3_consts;
/// WinSTT-owned STT backend trait (audit #14): the boundary the inherited Handy pipeline core
/// (`crate::managers::transcription`) calls into for every WinSTT-specific load/decode/cloud step,
/// so the core stops reaching sideways into `crate::winstt::*` (restores the one-way dep edge).
pub mod backend;

pub use whisper::WhisperEngine;
pub use backend::{BackendRoute, ResolvedSpec, SttBackend, WinsttSttBackend};

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

// ---------------------------------------------------------------------------
// Family taxonomy
// ---------------------------------------------------------------------------

/// The decode-loop archetype an engine uses. Distinct from the catalog `family`
/// string (`whisper`/`moonshine`/`nemo`/`cohere`/`kaldi`/`gigaam`/`t-one`/
/// `sense_voice`/`dolphin`/`custom`) because several catalog families share a
/// decode loop (e.g. Vosk + Zipformer = transducer; Dolphin + SenseVoice = bare
/// CTC over a self-contained graph). The catalog `family` still drives the
/// int8-preferred / DML-incompatible POLICY (see `FamilyPolicy`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineKind {
    /// Optimum split encoder + `decoder_model_merged.onnx` with `use_cache_branch`
    /// + IoBinding KV-cache. Covers whisper-*, lite-whisper-*, distil-whisper-*,
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
}

/// Catalog-family policy flags (separate from `EngineKind` because they key off
/// the catalog `family` STRING, which the quant/EP resolution already does).
/// Mirrors `bootstrap._INT8_PREFERRED_FAMILIES` and
/// `model_registry._DML_INCOMPATIBLE_FAMILIES` (currently the SAME set —
/// kept as two predicates so they can diverge if a future model needs it).
pub struct FamilyPolicy;

impl FamilyPolicy {
    /// Families loaded as int8 on every non-CUDA backend when int8 is published
    /// (mirrors Handy/transcribe-rs loading these as `Quantization::Int8`).
    pub const INT8_PREFERRED: &'static [&'static str] = &[
        "nemo",
        "cohere",
        "gigaam",
        "kaldi",
        "t-one",
        "sense_voice",
        "dolphin",
    ];

    /// Families whose ONNX encoders crash DirectML's `MLOperatorAuthorImpl`
    /// reshape kernel → forced to `CPUExecutionProvider` even when the user
    /// picked DML/ROCm/CoreML. Whisper / Moonshine / custom keep the GPU EP.
    pub const DML_INCOMPATIBLE: &'static [&'static str] = &[
        "nemo",
        "cohere",
        "gigaam",
        "kaldi",
        "t-one",
        "sense_voice",
        "dolphin",
    ];

    pub fn is_int8_preferred(family: &str) -> bool {
        Self::INT8_PREFERRED.contains(&family)
    }

    pub fn is_dml_incompatible(family: &str) -> bool {
        Self::DML_INCOMPATIBLE.contains(&family)
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
        EngineKind::WhisperOrt => {
            Err(SttError::Unsupported("WhisperOrt engine not yet ported (PORT/03 §4.1 whisper_ort)"))
        }
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
    let publishes = |q: Quantization| available.map_or(true, |a| a.contains(&q));

    // Only the AUTO path ("" / Default) auto-resolves; concrete requests pass
    // through the fuller resolver (see spec §7). Here `Default` IS the auto sentinel.
    if requested != Quantization::Default {
        return requested;
    }
    if accelerator == Accelerator::Cuda
        && param_count >= FP16_AUTO_PARAM_THRESHOLD
        && publishes(Quantization::Fp16)
    {
        return Quantization::Fp16;
    }
    if accelerator != Accelerator::Cuda
        && FamilyPolicy::is_int8_preferred(family)
        && publishes(Quantization::Int8)
    {
        return Quantization::Int8;
    }
    Quantization::Default
}

/// Override a GPU provider list to CPU for the DML-incompatible families.
/// Mirrors `bootstrap._override_dml_to_cpu_for_incompatible_family`: only fires
/// for DML/ROCm/CoreML (NOT cuda/cpu); Whisper/Moonshine pass through.
pub fn override_dml_to_cpu_for_family(
    providers: Vec<Accelerator>,
    family: &str,
) -> Vec<Accelerator> {
    if !FamilyPolicy::is_dml_incompatible(family) {
        return providers;
    }
    let head = providers.first().copied();
    match head {
        Some(Accelerator::Cuda) | Some(Accelerator::Cpu) | None => providers,
        Some(Accelerator::DirectMl) | Some(Accelerator::Rocm) | Some(Accelerator::CoreMl) => {
            vec![Accelerator::Cpu]
        }
        Some(Accelerator::OpenVino) => vec![Accelerator::Cpu],
    }
}

/// CTC greedy collapse: argmax already done → ids; drop `blank_id`, collapse
/// consecutive repeats. Pure port of `sense_voice._ctc_greedy_decode` /
/// the `_AsrWithCtcDecoding` collapse. Returns the surviving token ids.
pub fn ctc_greedy_collapse(ids: &[i64], blank_id: i64) -> Vec<i64> {
    let mut out = Vec::new();
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
/// CPU EP → min(cpu_count, 8) to dodge E-core collapse on hybrid CPUs; GPU EP → 2.
/// (0 = "all cores" is 49–84% SLOWER — never use the default.)
pub fn pick_intra_op_threads(is_gpu: bool, cpu_count: usize) -> usize {
    if is_gpu {
        2
    } else {
        cpu_count.min(8).max(1)
    }
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
    fn int8_preferred_family_on_cpu_resolves_int8() {
        // nemo on DirectML (non-CUDA) with int8 published → int8.
        let q = resolve_quantization_auto(
            Quantization::Default,
            Accelerator::DirectMl,
            "nemo",
            600_000_000,
            Some(&[Quantization::Default, Quantization::Int8]),
        );
        assert_eq!(q, Quantization::Int8);
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
    fn dml_incompatible_family_forced_to_cpu() {
        assert_eq!(
            override_dml_to_cpu_for_family(vec![Accelerator::DirectMl, Accelerator::Cpu], "nemo"),
            vec![Accelerator::Cpu]
        );
        // Whisper keeps DML.
        assert_eq!(
            override_dml_to_cpu_for_family(
                vec![Accelerator::DirectMl, Accelerator::Cpu],
                "whisper"
            ),
            vec![Accelerator::DirectMl, Accelerator::Cpu]
        );
        // CUDA passes through even for an incompatible family.
        assert_eq!(
            override_dml_to_cpu_for_family(vec![Accelerator::Cuda, Accelerator::Cpu], "cohere"),
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
    }

    #[test]
    fn intra_op_threads_policy() {
        assert_eq!(pick_intra_op_threads(true, 16), 2); // GPU
        assert_eq!(pick_intra_op_threads(false, 16), 8); // CPU capped at 8
        assert_eq!(pick_intra_op_threads(false, 4), 4); // CPU under cap
        assert_eq!(pick_intra_op_threads(false, 0), 1); // floor
    }
}
