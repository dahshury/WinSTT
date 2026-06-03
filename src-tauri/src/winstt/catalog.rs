// DRAFT PORT — not yet compiled. Source: WinSTT server/src/recorder/domain/catalog.json
//   + server/src/recorder/domain/model_registry.py (ModelCatalog, _GPU_COMPATIBLE_QUANTIZATIONS,
//     _DML_INCOMPATIBLE_FAMILIES, gpu_filter_quantizations)
//   + server/src/recorder/bootstrap.py (_resolve_quantization, _FP16_AUTO_PARAM_THRESHOLD,
//     _INT8_PREFERRED_FAMILIES, _override_dml_to_cpu_for_incompatible_family)
//   + server/src/stt_server/control_handler.py (_effective_quant_for — the picker badge bridge)
//
// This module is DETERMINISTIC DATA + pure resolution logic. It is the Rust port of WinSTT's
// STT model catalog and the per-family precision/EP policy that the picker badge and the ort
// loader must AGREE on. There is no ML here — only a const table and string-state arithmetic —
// so it is written as REAL code with `#[cfg(test)]` unit tests (per slice rules).
//
// INVARIANTS (carried verbatim from WinSTT memory + server source):
//   * `DML_INCOMPATIBLE_FAMILIES` MUST EQUAL `INT8_PREFERRED_FAMILIES`
//     (memory: project_onnx_asr_single_source_of_truth — "invariant == _INT8_PREFERRED_FAMILIES").
//     Both = {NeMo, Cohere, GigaAM, Kaldi, TOne, SenseVoice, Dolphin}.
//   * fp16-auto only fires on CUDA for models with >= 500M params that publish fp16.
//   * On non-CUDA (CPU / DirectML / ROCm / CoreML), int8-preferred families auto-resolve to int8.
//   * On CUDA, sub-fp16 quants (int8/q4/q4f16/bnb4/uint8) are filtered out — they fall back to
//     fp32 compute via QDQ scatter-gather AND per-channel int8 hallucinates (onnxruntime#25489).
//   * Silero VAD is CPU-only (handled in the VAD slice, NOT here — noted for cross-reference).
//   * Canary/Cohere `<|startofcontext|>` prompt slot is UNTRAINED — no initial-prompt bias for
//     them (handled in the engine slice, NOT here — noted for cross-reference).
//
// The const `STT_CATALOG` below has exactly 42 entries (whisper 15, moonshine 10, nemo 8,
// kaldi 3, gigaam 2, cohere 1, sense_voice 1, t-one 1, dolphin 1). Every entry has
// `supports_realtime = true` in WinSTT today, but the field is kept per-row so it can diverge.

#![allow(dead_code)]

use std::collections::BTreeSet;

/// ASR model family. Drives the per-family precision + execution-provider policy.
///
/// Mirrors the string `family` field in `catalog.json`. `Custom` is the runtime sentinel
/// applied to user-dropped models (`CUSTOM_MODEL_FAMILY = "custom"` in WinSTT) — it never
/// appears in the shipped catalog table but is needed by the loader code path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Family {
    Whisper,
    Moonshine,
    Cohere,
    Nemo,
    SenseVoice,
    GigaAm,
    Kaldi,
    TOne,
    Dolphin,
    /// Runtime sentinel for user custom models (not in the shipped catalog).
    Custom,
}

impl Family {
    /// The exact lowercase string used in `catalog.json` (and on the WS wire / picker).
    pub const fn as_str(self) -> &'static str {
        match self {
            Family::Whisper => "whisper",
            Family::Moonshine => "moonshine",
            Family::Cohere => "cohere",
            Family::Nemo => "nemo",
            Family::SenseVoice => "sense_voice",
            Family::GigaAm => "gigaam",
            Family::Kaldi => "kaldi",
            Family::TOne => "t-one",
            Family::Dolphin => "dolphin",
            Family::Custom => "custom",
        }
    }

    /// Parse the catalog `family` slug back into the enum. Unknown slugs map to `Custom`
    /// (the permissive bucket), matching WinSTT's tolerance for off-catalog repos.
    #[expect(
        clippy::should_implement_trait,
        reason = "inherent from_str predates/differs from std FromStr; renaming is an API change"
    )]
    pub fn from_str(s: &str) -> Family {
        match s {
            "whisper" => Family::Whisper,
            "moonshine" => Family::Moonshine,
            "cohere" => Family::Cohere,
            "nemo" => Family::Nemo,
            "sense_voice" => Family::SenseVoice,
            "gigaam" => Family::GigaAm,
            "kaldi" => Family::Kaldi,
            "t-one" => Family::TOne,
            "dolphin" => Family::Dolphin,
            _ => Family::Custom,
        }
    }

    /// `true` for families whose default-export ONNX graph crashes ORT-DirectML's
    /// `MLOperatorAuthorImpl` reshape kernel (`ERROR_FATAL_APP_EXIT`) at every quantization,
    /// AND that prefer int8 over fp32 on every non-CUDA backend.
    ///
    /// These two properties are the SAME set in WinSTT (see module-level invariant), so a
    /// single predicate backs both `DML_INCOMPATIBLE_FAMILIES` and `INT8_PREFERRED_FAMILIES`.
    /// Source: `model_registry._DML_INCOMPATIBLE_FAMILIES` == `bootstrap._INT8_PREFERRED_FAMILIES`.
    pub const fn is_dml_incompatible_and_int8_preferred(self) -> bool {
        matches!(
            self,
            Family::Nemo
                | Family::Cohere
                | Family::GigaAm
                | Family::Kaldi
                | Family::TOne
                | Family::SenseVoice
                | Family::Dolphin
        )
    }

    /// Alias for readability at call sites that mean "force CPU on DML/ROCm/CoreML".
    #[inline]
    pub const fn is_dml_incompatible(self) -> bool {
        self.is_dml_incompatible_and_int8_preferred()
    }

    /// Alias for readability at call sites that mean "auto-prefer int8 off-CUDA".
    #[inline]
    pub const fn prefers_int8_off_cuda(self) -> bool {
        self.is_dml_incompatible_and_int8_preferred()
    }

    /// Whether decoder-bias prompting (`<|startofprev|>` / initial-prompt) is meaningful.
    ///
    /// Only Whisper benefits. Moonshine has no prompt slot (no-op). Canary/Cohere have the
    /// `<|startofcontext|>` token in vocab but it is UNTRAINED — filling it truncates /
    /// hallucinates, so prompt-bias is deliberately NOT wired for them. Cross-references the
    /// engine slice; included here so the catalog can answer "should I even build a prompt?".
    /// Source: memory project_context_prompt_poisons_whisper + project_canary_cohere_prompt_slot_untrained.
    pub const fn supports_initial_prompt_bias(self) -> bool {
        matches!(self, Family::Whisper)
    }
}

/// One catalog row. The Rust analogue of WinSTT's `ModelInfo` (the slice subset the engine +
/// picker policy actually need; editorial fields like `wer`/`rtfx`/`size_bytes_by_quantization`
/// live in the picker payload and are intentionally NOT modeled here to keep this table a
/// load-bearing engine table rather than a UI mirror).
#[derive(Debug, Clone, Copy)]
pub struct ModelEntry {
    /// Stable catalog id (e.g. `"tiny"`, `"nemo-canary-1b-v2"`, `"alphacep/vosk-model-ru"`).
    pub id: &'static str,
    /// Human-facing label.
    pub display_name: &'static str,
    pub family: Family,
    /// HuggingFace repo id OR a bare onnx-asr alias (Moonshine/NeMo/GigaAM/etc. use aliases;
    /// Whisper/Cohere/SenseVoice/Kaldi-Vosk use slashed HF repos). The onnx-asr resolver is the
    /// single source of truth for which files this maps to — see PORT/01_stt_catalog.md.
    pub onnx_model_name: &'static str,
    /// ONNX quantization suffixes the upstream repo actually ships. The empty string `""` is the
    /// default (un-suffixed fp32) export. Order is preserved from `catalog.json`.
    pub available_quantizations: &'static [&'static str],
    /// Approximate parameter count. Drives the fp16-auto threshold (>= 500M) and the
    /// hardware-fitness estimate. `0` means "unknown" (custom models).
    pub param_count: u64,
    /// `true` for every shipped catalog entry today (kept per-row so it can diverge later).
    pub supports_realtime: bool,
}

/// fp16 auto-promotion floor: on CUDA, `"auto"`/`""` resolves to fp16 only at or above this
/// param count (and only if the model publishes fp16). Below it, fp16's I/O cast overhead
/// dominates compute and fp32 wins. Source: `bootstrap._FP16_AUTO_PARAM_THRESHOLD` (500M),
/// benchmarked on an RTX 3080 Ti.
pub const FP16_AUTO_PARAM_THRESHOLD: u64 = 500_000_000;

/// Quantizations ORT's CUDAExecutionProvider can actually accelerate. Everything else
/// (`int8`/`uint8`/`q4`/`q4f16`/`bnb4`) falls back to fp32 compute via QDQ scatter-gather
/// (slower) and per-channel int8 hallucinates on Whisper (onnxruntime#25489). Source:
/// `model_registry._GPU_COMPATIBLE_QUANTIZATIONS`.
pub const GPU_COMPATIBLE_QUANTIZATIONS: &[&str] = &["", "fp16"];

/// The full STT catalog: 42 shipped models. Verbatim from `catalog.json` (id / display_name /
/// family / onnx_model_name / available_quantizations / param_count / supports_realtime).
///
/// Counts (asserted in tests): whisper 15, moonshine 10, nemo 8, kaldi 3, gigaam 2,
/// cohere 1, sense_voice 1, t-one 1, dolphin 1.
pub const STT_CATALOG: &[ModelEntry] = &[
    // ── Whisper family (15) ──────────────────────────────────────────────────────────────
    ModelEntry {
        id: "tiny",
        display_name: "Whisper Tiny",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-tiny",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 37_760_640,
        supports_realtime: true,
    },
    ModelEntry {
        id: "base",
        display_name: "Whisper Base",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-base",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 72_593_920,
        supports_realtime: true,
    },
    ModelEntry {
        id: "small",
        display_name: "Whisper Small",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-small",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 241_734_912,
        supports_realtime: true,
    },
    ModelEntry {
        id: "medium",
        display_name: "Whisper Medium",
        family: Family::Whisper,
        onnx_model_name: "Xenova/whisper-medium",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 769_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "large-v3",
        display_name: "Whisper Large v3",
        family: Family::Whisper,
        onnx_model_name: "Xenova/whisper-large-v3",
        available_quantizations: &[""],
        param_count: 1_550_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "large-v3-turbo",
        display_name: "Whisper Large v3 Turbo",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-large-v3-turbo",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 795_766_657,
        supports_realtime: true,
    },
    ModelEntry {
        id: "tiny.en",
        display_name: "Whisper Tiny (EN)",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-tiny.en",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 37_760_256,
        supports_realtime: true,
    },
    ModelEntry {
        id: "base.en",
        display_name: "Whisper Base (EN)",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-base.en",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 74_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "small.en",
        display_name: "Whisper Small (EN)",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/whisper-small.en",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 244_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "medium.en",
        display_name: "Whisper Medium (EN)",
        family: Family::Whisper,
        onnx_model_name: "Xenova/whisper-medium.en",
        available_quantizations: &["", "fp16", "q4", "bnb4"],
        param_count: 769_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "breeze-asr-25",
        display_name: "Breeze ASR 25",
        family: Family::Whisper,
        onnx_model_name: "xeonchen/Breeze-ASR-25-ONNX",
        available_quantizations: &[""],
        param_count: 1_545_107_214,
        supports_realtime: true,
    },
    ModelEntry {
        id: "crisper-whisper",
        display_name: "CrisperWhisper",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/CrisperWhisper-ONNX",
        available_quantizations: &[""],
        param_count: 1_543_304_960,
        supports_realtime: true,
    },
    ModelEntry {
        id: "lite-whisper-large-v3-turbo",
        display_name: "Lite-Whisper Large v3 Turbo",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/lite-whisper-large-v3-turbo-ONNX",
        available_quantizations: &["", "fp16"],
        param_count: 534_359_083,
        supports_realtime: true,
    },
    ModelEntry {
        id: "lite-whisper-large-v3-turbo-acc",
        display_name: "Lite-Whisper Large v3 Turbo (Accelerated)",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/lite-whisper-large-v3-turbo-acc-ONNX",
        available_quantizations: &["", "fp16"],
        param_count: 581_299_243,
        supports_realtime: true,
    },
    ModelEntry {
        id: "lite-whisper-large-v3-turbo-fast",
        display_name: "Lite-Whisper Large v3 Turbo (Fast)",
        family: Family::Whisper,
        onnx_model_name: "onnx-community/lite-whisper-large-v3-turbo-fast-ONNX",
        available_quantizations: &["", "fp16"],
        param_count: 473_840_689,
        supports_realtime: true,
    },
    // ── Moonshine family (10) ────────────────────────────────────────────────────────────
    ModelEntry {
        id: "moonshine-tiny",
        display_name: "Moonshine Tiny",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 27_092_835,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-base",
        display_name: "Moonshine Base",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-base",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 61_514_019,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-tiny-ko",
        display_name: "Moonshine Tiny (KO)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny-ko",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 27_092_835,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-tiny-ar",
        display_name: "Moonshine Tiny (AR)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny-ar",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 27_092_835,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-tiny-vi",
        display_name: "Moonshine Tiny (VI)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny-vi",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 27_092_835,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-base-zh",
        display_name: "Moonshine Base (ZH)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-base-zh",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 61_514_019,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-base-ja",
        display_name: "Moonshine Base (JA)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-base-ja",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 61_514_019,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-base-ko",
        display_name: "Moonshine Base (KO)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-base-ko",
        available_quantizations: &["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"],
        param_count: 61_514_019,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-tiny-uk",
        display_name: "Moonshine Tiny (UK)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny-uk",
        available_quantizations: &[""],
        param_count: 27_600_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "moonshine-tiny-fr",
        display_name: "Moonshine Tiny (FR)",
        family: Family::Moonshine,
        onnx_model_name: "moonshine-tiny-fr",
        available_quantizations: &[""],
        param_count: 27_600_000,
        supports_realtime: true,
    },
    // ── Cohere family (1) ────────────────────────────────────────────────────────────────
    ModelEntry {
        id: "cohere-transcribe",
        display_name: "Cohere Transcribe",
        family: Family::Cohere,
        onnx_model_name: "cohere-transcribe",
        available_quantizations: &["", "fp16", "q4", "q4f16"],
        param_count: 2_000_000_000,
        supports_realtime: true,
    },
    // ── SenseVoice family (1) ────────────────────────────────────────────────────────────
    ModelEntry {
        id: "sense-voice-small",
        display_name: "SenseVoice Small",
        family: Family::SenseVoice,
        onnx_model_name: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
        available_quantizations: &["int8"],
        param_count: 234_000_000,
        supports_realtime: true,
    },
    // ── NeMo family (8) ──────────────────────────────────────────────────────────────────
    ModelEntry {
        id: "nemo-parakeet-ctc-0.6b",
        display_name: "NeMo Parakeet CTC 0.6B",
        family: Family::Nemo,
        onnx_model_name: "nemo-parakeet-ctc-0.6b",
        available_quantizations: &["", "int8"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-parakeet-rnnt-0.6b",
        display_name: "NeMo Parakeet RNNT 0.6B",
        family: Family::Nemo,
        onnx_model_name: "nemo-parakeet-rnnt-0.6b",
        available_quantizations: &["", "int8"],
        param_count: 600_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-parakeet-tdt-0.6b-v3",
        display_name: "NeMo Parakeet TDT 0.6B v3",
        family: Family::Nemo,
        onnx_model_name: "nemo-parakeet-tdt-0.6b-v3",
        available_quantizations: &["", "int8"],
        param_count: 626_983_558,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-canary-1b-v2",
        display_name: "NeMo Canary 1B v2",
        family: Family::Nemo,
        onnx_model_name: "nemo-canary-1b-v2",
        available_quantizations: &["", "int8"],
        param_count: 978_000_000,
        supports_realtime: true,
    },
    // ── Native streaming (sherpa-onnx OnlineRecognizer; cache-aware chunked, CPU). The id contains
    //    "streaming" so `engine_kind_for` routes to the *Streaming EngineKind. ──
    ModelEntry {
        id: "streaming-zipformer-en",
        display_name: "Streaming Zipformer (English)",
        family: Family::Kaldi,
        onnx_model_name: "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26",
        available_quantizations: &["", "int8"],
        param_count: 66_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-ctc-en",
        display_name: "Streaming NeMo FastConformer CTC (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-ctc-en-80ms",
        available_quantizations: &[""],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "streaming-nemo-rnnt-en",
        display_name: "Streaming NeMo FastConformer RNN-T (English)",
        family: Family::Nemo,
        onnx_model_name: "csukuangfj/sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms",
        available_quantizations: &[""],
        param_count: 114_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-canary-180m-flash",
        display_name: "NeMo Canary 180M Flash",
        family: Family::Nemo,
        onnx_model_name: "istupakov/canary-180m-flash-onnx",
        available_quantizations: &["", "int8"],
        param_count: 194_168_492,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-canary-1b-flash",
        display_name: "NeMo Canary 1B Flash",
        family: Family::Nemo,
        onnx_model_name: "istupakov/canary-1b-flash-onnx",
        available_quantizations: &["", "int8"],
        param_count: 883_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-fastconformer-ru-ctc",
        display_name: "NeMo FastConformer RU CTC",
        family: Family::Nemo,
        onnx_model_name: "nemo-fastconformer-ru-ctc",
        available_quantizations: &["", "int8"],
        param_count: 109_270_705,
        supports_realtime: true,
    },
    ModelEntry {
        id: "nemo-fastconformer-ru-rnnt",
        display_name: "NeMo FastConformer RU RNNT",
        family: Family::Nemo,
        onnx_model_name: "nemo-fastconformer-ru-rnnt",
        available_quantizations: &["", "int8"],
        param_count: 114_078_382,
        supports_realtime: true,
    },
    // ── GigaAM family (2) ────────────────────────────────────────────────────────────────
    ModelEntry {
        id: "gigaam-v3-e2e-ctc",
        display_name: "GigaAM v3 E2E CTC",
        family: Family::GigaAm,
        onnx_model_name: "gigaam-v3-e2e-ctc",
        available_quantizations: &["", "int8"],
        param_count: 243_000_000,
        supports_realtime: true,
    },
    ModelEntry {
        id: "gigaam-v3-e2e-rnnt",
        display_name: "GigaAM v3 E2E RNNT",
        family: Family::GigaAm,
        onnx_model_name: "gigaam-v3-e2e-rnnt",
        available_quantizations: &["", "int8"],
        param_count: 243_000_000,
        supports_realtime: true,
    },
    // ── Kaldi family (3) — Vosk + Zipformer ──────────────────────────────────────────────
    // NOTE: Kaldi/Vosk uses the `.` quant separator (`encoder.int8.onnx`) vs onnx-community's
    // `_` separator — handled in the model-cache / file-resolution slice, NOT here.
    ModelEntry {
        id: "alphacep/vosk-model-ru",
        display_name: "Vosk Russian",
        family: Family::Kaldi,
        onnx_model_name: "alphacep/vosk-model-ru",
        available_quantizations: &["", "int8"],
        param_count: 65_016_922,
        supports_realtime: true,
    },
    ModelEntry {
        id: "alphacep/vosk-model-small-ru",
        display_name: "Vosk Russian (Small)",
        family: Family::Kaldi,
        onnx_model_name: "alphacep/vosk-model-small-ru",
        available_quantizations: &["", "int8"],
        param_count: 22_986_644,
        supports_realtime: true,
    },
    ModelEntry {
        id: "zipformer-en",
        display_name: "Zipformer English",
        family: Family::Kaldi,
        onnx_model_name: "zipformer-en",
        available_quantizations: &[""],
        param_count: 70_000_000,
        supports_realtime: true,
    },
    // ── T-One family (1) ─────────────────────────────────────────────────────────────────
    ModelEntry {
        id: "t-tech/t-one",
        display_name: "T-One",
        family: Family::TOne,
        onnx_model_name: "t-tech/t-one",
        available_quantizations: &[""],
        param_count: 71_697_827,
        supports_realtime: true,
    },
    // ── Dolphin family (1) ───────────────────────────────────────────────────────────────
    ModelEntry {
        id: "dolphin-base-ctc",
        display_name: "Dolphin Base CTC",
        family: Family::Dolphin,
        onnx_model_name: "dolphin-base-ctc",
        // int8-only: Dolphin's default-export int8 graph is the only viable build (the fp32
        // default-export int8 DML segfaults — memory project_onnx_asr_single_source_of_truth).
        available_quantizations: &["int8"],
        param_count: 140_000_000,
        supports_realtime: true,
    },
];

/// Look up a catalog row by id. Linear scan over 42 entries — cheap and avoids a lazy map.
pub fn find(id: &str) -> Option<&'static ModelEntry> {
    STT_CATALOG.iter().find(|m| m.id == id)
}

/// The published quantization list for `id`. Thin wrapper over the catalog field; kept as a named
/// accessor so call sites read intent and so any future per-model correction has one chokepoint.
/// Unknown ids default to `[""]` (fp32 default export — the permissive off-catalog assumption).
pub fn quantizations_for_id(id: &str) -> &'static [&'static str] {
    find(id).map(|m| m.available_quantizations).unwrap_or(&[""])
}

/// `true` when the active execution provider is the real CUDA EP (NVIDIA). DirectML / ROCm /
/// CoreML are NOT cuda — those route incompatible families to CPU instead of quant-filtering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accelerator {
    Cuda,
    DirectMl,
    Rocm,
    CoreMl,
    OpenVino,
    Cpu,
}

impl Accelerator {
    #[inline]
    pub const fn is_cuda(self) -> bool {
        matches!(self, Accelerator::Cuda)
    }

    /// DML / ROCm / CoreML: the GPU EPs that crash DML-incompatible families. (OpenVINO is left
    /// out — WinSTT's override set is `not in {cuda, cpu}`; OpenVINO behaves like a GPU EP here
    /// and is treated the same way for the force-CPU decision.)
    #[inline]
    pub const fn is_non_cuda_gpu(self) -> bool {
        matches!(
            self,
            Accelerator::DirectMl | Accelerator::Rocm | Accelerator::CoreMl | Accelerator::OpenVino
        )
    }
}

/// Drop sub-fp16 quants from a published `'static` list when running on CUDA (preserves order;
/// keeps `""` and `fp16`). Mirror of `model_registry.gpu_filter_quantizations` — used by the
/// picker so the UI never offers a quant that is slower AND less accurate on CUDA. Inputs are the
/// catalog's `&'static [&'static str]` slices, so the filtered items stay `'static`.
pub fn gpu_filter_quantizations(quants: &'static [&'static str]) -> Vec<&'static str> {
    quants
        .iter()
        .copied()
        .filter(|q| GPU_COMPATIBLE_QUANTIZATIONS.contains(q))
        .collect()
}

/// The quantizations the PICKER should offer for `entry` under `accel`. On CUDA, sub-fp16 quants
/// are dropped; every other EP keeps the full published list (DML-incompatible families route to
/// CPU where all quants are valid, so they are NOT filtered). Mirror of `ModelCatalog._quants_for`.
pub fn picker_quantizations_for(entry: &ModelEntry, accel: Accelerator) -> Vec<&'static str> {
    let published = quantizations_for_id(entry.id);
    if accel.is_cuda() {
        gpu_filter_quantizations(published)
    } else {
        published.to_vec()
    }
}

/// Result of resolving a requested quantization to what the loader should actually fetch.
/// `None` == fp32/default export (the un-suffixed `.onnx`). The string `""` from WinSTT's
/// `_effective_quant_for` maps to `None` here.
pub type ResolvedQuant = Option<&'static str>;

/// Port of `bootstrap._resolve_quantization`. Deterministic precision policy.
///
/// `requested`: the user setting (`"auto"` / `""` / a concrete quant like `"int8"` / `"fp16"`).
/// `available`: the model's published quant set (`None` == off-catalog; permissive).
/// Returns the quant the onnx loader should request, or `None` for fp32-default.
///
/// Branches (verbatim from the Python):
///   1. `"auto"`/`""`:
///        - CUDA + param >= 500M + publishes fp16  -> `Some("fp16")`
///        - non-CUDA + int8-preferred family + publishes int8 -> `Some("int8")`
///        - else -> `None` (fp32 default)
///   2. concrete quant the model does NOT publish -> `None` (warn + fp32; never ask for a
///      missing file, which would cascade to a `tiny` fallback).
///   3. concrete sub-fp16 on CUDA -> `None` (fp32; QDQ fallback + int8 hallucination).
///   4. otherwise -> `Some(requested)` (pass-through; fp16 hits the in-load decoder repair path).
pub fn resolve_quantization(
    requested: &str,
    accel: Accelerator,
    param_count: u64,
    available: Option<&[&str]>,
    family: Family,
) -> ResolvedQuant {
    let quant = requested.trim();
    let publishes = |q: &str| -> bool { available.is_none_or(|set| set.contains(&q)) };

    // Branch 1: auto / empty.
    if quant.is_empty() || quant == "auto" {
        if accel.is_cuda() && param_count >= FP16_AUTO_PARAM_THRESHOLD && publishes("fp16") {
            return Some("fp16");
        }
        // ACCURACY-FIRST: the natural fp32 export (None) when published — do NOT silently
        // downgrade to int8 (that trades accuracy for speed/size, the USER's call; the picker
        // exposes every published quant off-CUDA). int8-only models fall back to int8.
        let _ = family;
        if publishes("") {
            return None;
        }
        if publishes("int8") {
            return Some("int8");
        }
        return None;
    }

    // Branch 2: concrete quant the model doesn't publish -> fp32 fallback.
    if !publishes(quant) {
        return None;
    }

    // Branch 3: concrete sub-fp16 on CUDA -> fp32 fallback.
    if accel.is_cuda() && !GPU_COMPATIBLE_QUANTIZATIONS.contains(&quant) {
        return None;
    }

    // Branch 4: pass-through. Return the 'static slice that matches (catalog-backed) so the
    // caller gets a 'static str; fall back to leaking-free static lookup over the union of all
    // known quant strings.
    static_quant(quant)
}

/// The precision the picker BADGE should show for a model under the current settings — i.e. the
/// string form of `resolve_quantization` where `None` collapses to `""`. Mirror of
/// `control_handler._effective_quant_for`. This is the bridge that keeps "badge says cached" and
/// "swap actually downloads" in agreement.
pub fn effective_quantization(
    requested: &str,
    accel: Accelerator,
    param_count: u64,
    available: Option<&[&str]>,
    family: Family,
) -> &'static str {
    resolve_quantization(requested, accel, param_count, available, family).unwrap_or("")
}

/// Whether the DML-to-CPU override fires for `family` under `accel`: DML-incompatible families on
/// a non-CUDA GPU EP must be forced to the CPU execution provider (their ONNX encoder crashes the
/// MLOperatorAuthorImpl reshape kernel). CUDA and CPU pass through unchanged. Mirror of
/// `bootstrap._override_dml_to_cpu_for_incompatible_family` (the decision half — the provider-list
/// rewrite belongs to the engine slice).
pub fn must_force_cpu(family: Family, accel: Accelerator) -> bool {
    if !family.is_dml_incompatible() {
        return false;
    }
    accel.is_non_cuda_gpu()
}

/// Map a known quant string to its `'static` form, so resolution can return `&'static str`
/// without leaking. The universe of quant suffixes is small and closed.
fn static_quant(q: &str) -> Option<&'static str> {
    const ALL: &[&str] = &["", "fp16", "q4", "q4f16", "bnb4", "int8", "uint8"];
    ALL.iter().copied().find(|s| *s == q)
}

/// The set of families that are both DML-incompatible AND int8-preferred — exposed so the
/// invariant ("these two lists are the same") can be asserted at runtime and in tests, and so
/// other slices can iterate the canonical set rather than re-deriving it.
pub fn dml_incompatible_int8_preferred_families() -> BTreeSet<Family> {
    [
        Family::Nemo,
        Family::Cohere,
        Family::GigaAm,
        Family::Kaldi,
        Family::TOne,
        Family::SenseVoice,
        Family::Dolphin,
    ]
    .into_iter()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_total_count_is_42() {
        assert_eq!(
            STT_CATALOG.len(),
            42,
            "catalog.json ships exactly 42 STT models"
        );
    }

    #[test]
    fn per_family_counts_match_catalog_json() {
        let count = |f: Family| STT_CATALOG.iter().filter(|m| m.family == f).count();
        assert_eq!(count(Family::Whisper), 15, "whisper count");
        assert_eq!(count(Family::Moonshine), 10, "moonshine count");
        assert_eq!(count(Family::Nemo), 8, "nemo count");
        assert_eq!(count(Family::Kaldi), 3, "kaldi count");
        assert_eq!(count(Family::GigaAm), 2, "gigaam count");
        assert_eq!(count(Family::Cohere), 1, "cohere count");
        assert_eq!(count(Family::SenseVoice), 1, "sense_voice count");
        assert_eq!(count(Family::TOne), 1, "t-one count");
        assert_eq!(count(Family::Dolphin), 1, "dolphin count");
        assert_eq!(
            count(Family::Custom),
            0,
            "custom never appears in the shipped catalog"
        );
        // The nine family counts must sum to the catalog total.
        let summed = 15 + 10 + 8 + 3 + 2 + 1 + 1 + 1 + 1;
        assert_eq!(summed, STT_CATALOG.len());
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = BTreeSet::new();
        for m in STT_CATALOG {
            assert!(seen.insert(m.id), "duplicate catalog id: {}", m.id);
        }
    }

    #[test]
    fn every_model_has_a_repo_and_at_least_one_quant() {
        for m in STT_CATALOG {
            assert!(
                !m.onnx_model_name.is_empty(),
                "{} missing onnx_model_name",
                m.id
            );
            let quants = quantizations_for_id(m.id);
            assert!(
                !quants.is_empty(),
                "{} must publish at least one quant",
                m.id
            );
        }
    }

    #[test]
    fn all_shipped_models_support_realtime() {
        // WinSTT ships every catalog row with supports_realtime=true today. If this ever
        // changes upstream, this test is the early-warning canary.
        for m in STT_CATALOG {
            assert!(m.supports_realtime, "{} unexpectedly not realtime", m.id);
        }
    }

    /// THE LOAD-BEARING INVARIANT: DML_INCOMPATIBLE_FAMILIES == INT8_PREFERRED_FAMILIES.
    /// Memory project_onnx_asr_single_source_of_truth: "invariant == _INT8_PREFERRED_FAMILIES".
    #[test]
    fn dml_incompatible_equals_int8_preferred() {
        let expected = dml_incompatible_int8_preferred_families();
        // Both predicates are backed by the SAME method, so for every family the two flags
        // must agree, and the agreeing set must equal the canonical 7-family set.
        let mut dml = BTreeSet::new();
        let mut int8 = BTreeSet::new();
        for f in [
            Family::Whisper,
            Family::Moonshine,
            Family::Cohere,
            Family::Nemo,
            Family::SenseVoice,
            Family::GigaAm,
            Family::Kaldi,
            Family::TOne,
            Family::Dolphin,
            Family::Custom,
        ] {
            assert_eq!(
                f.is_dml_incompatible(),
                f.prefers_int8_off_cuda(),
                "family {:?}: DML-incompat and int8-preferred must be identical",
                f
            );
            if f.is_dml_incompatible() {
                dml.insert(f);
            }
            if f.prefers_int8_off_cuda() {
                int8.insert(f);
            }
        }
        assert_eq!(
            dml, int8,
            "the two family lists must be byte-identical sets"
        );
        assert_eq!(
            dml, expected,
            "the set must equal the canonical 7-family list"
        );
        assert_eq!(
            dml.len(),
            7,
            "exactly 7 families are DML-incompatible / int8-preferred"
        );
        // Whisper / Moonshine / Custom must NOT be in the set.
        assert!(!dml.contains(&Family::Whisper));
        assert!(!dml.contains(&Family::Moonshine));
        assert!(!dml.contains(&Family::Custom));
    }

    #[test]
    fn family_str_roundtrips() {
        for f in [
            Family::Whisper,
            Family::Moonshine,
            Family::Cohere,
            Family::Nemo,
            Family::SenseVoice,
            Family::GigaAm,
            Family::Kaldi,
            Family::TOne,
            Family::Dolphin,
            Family::Custom,
        ] {
            assert_eq!(Family::from_str(f.as_str()), f, "roundtrip {:?}", f);
        }
        // Unknown slug falls into the permissive Custom bucket.
        assert_eq!(Family::from_str("totally-unknown"), Family::Custom);
        // Exact slug spellings (the wire format) — guard against typos.
        assert_eq!(Family::SenseVoice.as_str(), "sense_voice");
        assert_eq!(Family::TOne.as_str(), "t-one");
        assert_eq!(Family::GigaAm.as_str(), "gigaam");
    }

    #[test]
    fn dolphin_quants_are_int8_only() {
        // catalog.json ships Dolphin with available_quantizations == ["int8"] (default-export
        // int8 DML segfaults; int8 is the only viable build).
        assert_eq!(quantizations_for_id("dolphin-base-ctc"), &["int8"]);
    }

    // ── _resolve_quantization branch coverage ────────────────────────────────────────────

    #[test]
    fn auto_on_cuda_picks_fp16_only_for_large_models_that_publish_it() {
        // large-v3-turbo: 795M, publishes fp16 -> fp16 on CUDA.
        let turbo = find("large-v3-turbo").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cuda,
                turbo.param_count,
                Some(turbo.available_quantizations),
                turbo.family
            ),
            Some("fp16")
        );
        // tiny: 37M, publishes fp16 but is BELOW the 500M floor -> fp32 (None).
        let tiny = find("tiny").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cuda,
                tiny.param_count,
                Some(tiny.available_quantizations),
                tiny.family
            ),
            None
        );
        // large-v3: 1.55B but publishes ONLY "" (no fp16) -> fp32 (None) even though huge.
        let lv3 = find("large-v3").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cuda,
                lv3.param_count,
                Some(lv3.available_quantizations),
                lv3.family
            ),
            None
        );
    }

    #[test]
    fn auto_off_cuda_picks_int8_for_int8_preferred_families() {
        // Cohere on DirectML -> int8 (int8-preferred family, publishes "" + fp16 + q4 + q4f16...
        // NOTE: cohere does NOT publish int8 in the catalog, so it must FALL THROUGH to fp32).
        let cohere = find("cohere-transcribe").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::DirectMl,
                cohere.param_count,
                Some(cohere.available_quantizations),
                cohere.family
            ),
            None,
            "cohere doesn't publish int8 -> auto must not invent it"
        );
        // NeMo Canary 1B v2 on DirectML -> ACCURACY-FIRST: None (the natural fp32 export). int8 IS
        // published but is NOT auto-selected — the user picks it in the picker for speed/size.
        let canary = find("nemo-canary-1b-v2").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::DirectMl,
                canary.param_count,
                Some(canary.available_quantizations),
                canary.family
            ),
            None
        );
        // Same on plain CPU.
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cpu,
                canary.param_count,
                Some(canary.available_quantizations),
                canary.family
            ),
            None
        );
        // GigaAM CTC on CPU -> fp32 (None), accuracy-first.
        let giga = find("gigaam-v3-e2e-ctc").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cpu,
                giga.param_count,
                Some(giga.available_quantizations),
                giga.family
            ),
            None
        );
    }

    #[test]
    fn auto_off_cuda_does_not_int8_whisper_or_moonshine() {
        // Whisper small.en on CPU -> fp32 (not an int8-preferred family).
        let small_en = find("small.en").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cpu,
                small_en.param_count,
                Some(small_en.available_quantizations),
                small_en.family
            ),
            None
        );
        // Moonshine on DirectML -> fp32 even though it publishes int8 (not int8-preferred family).
        let moon = find("moonshine-base").unwrap();
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::DirectMl,
                moon.param_count,
                Some(moon.available_quantizations),
                moon.family
            ),
            None
        );
    }

    #[test]
    fn concrete_quant_not_published_falls_back_to_fp32() {
        // Whisper tiny does not publish int8 -> requesting int8 yields fp32 (None), never a
        // ModelFileNotFoundError cascade.
        let tiny = find("tiny").unwrap();
        assert_eq!(
            resolve_quantization(
                "int8",
                Accelerator::Cpu,
                tiny.param_count,
                Some(tiny.available_quantizations),
                tiny.family
            ),
            None
        );
    }

    #[test]
    fn concrete_sub_fp16_on_cuda_falls_back_to_fp32() {
        // Moonshine publishes int8, but on CUDA sub-fp16 is filtered -> fp32.
        let moon = find("moonshine-base").unwrap();
        assert_eq!(
            resolve_quantization(
                "int8",
                Accelerator::Cuda,
                moon.param_count,
                Some(moon.available_quantizations),
                moon.family
            ),
            None
        );
        // q4 on CUDA for whisper -> fp32.
        let tiny = find("tiny").unwrap();
        assert_eq!(
            resolve_quantization(
                "q4",
                Accelerator::Cuda,
                tiny.param_count,
                Some(tiny.available_quantizations),
                tiny.family
            ),
            None
        );
    }

    #[test]
    fn concrete_quant_passes_through_off_cuda_and_for_fp16_on_cuda() {
        // int8 on CPU for a model that publishes it -> int8 (pass-through).
        let moon = find("moonshine-base").unwrap();
        assert_eq!(
            resolve_quantization(
                "int8",
                Accelerator::Cpu,
                moon.param_count,
                Some(moon.available_quantizations),
                moon.family
            ),
            Some("int8")
        );
        // fp16 on CUDA -> fp16 (in GPU_COMPATIBLE set; hits the decoder repair path).
        let turbo = find("large-v3-turbo").unwrap();
        assert_eq!(
            resolve_quantization(
                "fp16",
                Accelerator::Cuda,
                turbo.param_count,
                Some(turbo.available_quantizations),
                turbo.family
            ),
            Some("fp16")
        );
    }

    #[test]
    fn effective_quantization_collapses_none_to_empty_string() {
        let tiny = find("tiny").unwrap();
        assert_eq!(
            effective_quantization(
                "auto",
                Accelerator::Cpu,
                tiny.param_count,
                Some(tiny.available_quantizations),
                tiny.family
            ),
            ""
        );
        let turbo = find("large-v3-turbo").unwrap();
        assert_eq!(
            effective_quantization(
                "auto",
                Accelerator::Cuda,
                turbo.param_count,
                Some(turbo.available_quantizations),
                turbo.family
            ),
            "fp16"
        );
    }

    #[test]
    fn off_catalog_repo_is_permissive_about_quants() {
        // available=None (off-catalog HF repo) -> any concrete quant passes (the historical
        // assume-it-exists behaviour), and auto on CUDA still respects the param + fp16 gates.
        assert_eq!(
            resolve_quantization("int8", Accelerator::Cpu, 100, None, Family::Custom),
            Some("int8")
        );
        // auto + huge + non-int8-family + off-catalog on CUDA: publishes("fp16") is true when
        // available is None, so fp16 fires.
        assert_eq!(
            resolve_quantization(
                "auto",
                Accelerator::Cuda,
                600_000_000,
                None,
                Family::Whisper
            ),
            Some("fp16")
        );
    }

    // ── picker quant filtering ───────────────────────────────────────────────────────────

    #[test]
    fn picker_filters_sub_fp16_only_on_cuda() {
        let moon = find("moonshine-base").unwrap(); // ["","fp16","q4","bnb4","int8","uint8","q4f16"]
                                                    // CUDA: only "" and fp16 survive (order preserved).
        assert_eq!(
            picker_quantizations_for(moon, Accelerator::Cuda),
            vec!["", "fp16"]
        );
        // DirectML: full list kept (model routes to CPU EP, all quants valid).
        assert_eq!(
            picker_quantizations_for(moon, Accelerator::DirectMl),
            vec!["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"]
        );
        // CPU: full list kept.
        assert_eq!(
            picker_quantizations_for(moon, Accelerator::Cpu),
            vec!["", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16"]
        );
    }

    // ── DML force-CPU decision ───────────────────────────────────────────────────────────

    #[test]
    fn force_cpu_only_for_incompatible_families_on_non_cuda_gpu() {
        // NeMo on DirectML -> force CPU.
        assert!(must_force_cpu(Family::Nemo, Accelerator::DirectMl));
        // NeMo on CUDA -> NOT forced (CUDA is fine).
        assert!(!must_force_cpu(Family::Nemo, Accelerator::Cuda));
        // NeMo on CPU -> already CPU, no override.
        assert!(!must_force_cpu(Family::Nemo, Accelerator::Cpu));
        // Whisper on DirectML -> keeps its GPU EP.
        assert!(!must_force_cpu(Family::Whisper, Accelerator::DirectMl));
        // Moonshine on DirectML -> keeps GPU EP.
        assert!(!must_force_cpu(Family::Moonshine, Accelerator::DirectMl));
        // Dolphin on ROCm -> force CPU.
        assert!(must_force_cpu(Family::Dolphin, Accelerator::Rocm));
        // SenseVoice on CoreML -> force CPU.
        assert!(must_force_cpu(Family::SenseVoice, Accelerator::CoreMl));
    }

    #[test]
    fn initial_prompt_bias_only_for_whisper() {
        assert!(Family::Whisper.supports_initial_prompt_bias());
        // Canary (Nemo) + Cohere context slot is untrained -> no prompt bias.
        assert!(!Family::Nemo.supports_initial_prompt_bias());
        assert!(!Family::Cohere.supports_initial_prompt_bias());
        // Moonshine has no prompt slot.
        assert!(!Family::Moonshine.supports_initial_prompt_bias());
    }
}
