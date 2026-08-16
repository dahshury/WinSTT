// Family / Accelerator types and the catalog helpers the picker relies on: id canonicalization,
// display-name helpers, the per-family DML-incompatible/int8-preferred classification, and the
// CUDA sub-fp16 picker filter. Consumes the static `ModelEntry` rows + `STT_CATALOG` table from the
// sibling `data` module via `super::`. There is no ML here — only string-state arithmetic.
//
// NOTE: the deterministic requested->effective precision resolver lives in `stt::quant_resolve`
// (the RAM/VRAM fit-aware, kind-based resolver the load path and picker badge actually use). The
// old family-based accuracy-first port that used to live here was fully superseded and removed.

use super::data::{ModelEntry, STT_CATALOG};

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
    Granite,
    Nemo,
    SenseVoice,
    GigaAm,
    Kaldi,
    TOne,
    Dolphin,
    /// Qwen3-ASR (Qwen3 LLM decoder + audio encoder; init/step ONNX graphs, raw fp16 embed table).
    Qwen3,
    /// VibeVoice-ASR (BitNet): dual ConvNeXt tokenizer over raw 24 kHz audio + ternarized
    /// Qwen2.5-1.5B decoder (qwen3-style init/step graphs, raw fp16 embed table).
    VibeVoice,
    /// Audio8-ASR (`arkasr`): Qwen3-ASR audio tower + MLP adapter → 8-layer Qwen-style causal LM,
    /// with the adapter and token-embedding lookup running host-side from raw NumPy weights and a
    /// prefill/decode pair driving a static 512-position KV cache.
    Audio8,
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
            Family::Granite => "granite",
            Family::Nemo => "nemo",
            Family::SenseVoice => "sense_voice",
            Family::GigaAm => "gigaam",
            Family::Kaldi => "kaldi",
            Family::TOne => "t-one",
            Family::Dolphin => "dolphin",
            Family::Qwen3 => "qwen3",
            Family::VibeVoice => "vibevoice",
            Family::Audio8 => "audio8",
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
            "granite" => Family::Granite,
            "nemo" => Family::Nemo,
            "sense_voice" => Family::SenseVoice,
            "gigaam" => Family::GigaAm,
            "kaldi" => Family::Kaldi,
            "t-one" => Family::TOne,
            "dolphin" => Family::Dolphin,
            "qwen3" => Family::Qwen3,
            "vibevoice" => Family::VibeVoice,
            "audio8" => Family::Audio8,
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

/// Quantizations ORT's CUDAExecutionProvider can actually accelerate. Everything else
/// (`int8`/`uint8`/`q4`/`q4f16`/`bnb4`) falls back to fp32 compute via QDQ scatter-gather
/// (slower) and per-channel int8 hallucinates on Whisper (onnxruntime#25489). Source:
/// `model_registry._GPU_COMPATIBLE_QUANTIZATIONS`.
pub const GPU_COMPATIBLE_QUANTIZATIONS: &[&str] = &["", "fp16", "fp16w"];

pub fn canonical_model_id(id: &str) -> &str {
    match id {
        // The English-only Nemotron (April 2026) was REPLACED by the multilingual Nemotron-3.5
        // (June 2026), which includes English plus 100+ languages. Migrate every persisted old
        // English-Nemotron selection (all latencies + precisions) to the shipped 1120 ms
        // multilingual int8 bundle so a returning user keeps a working choice. NOTE: the multilingual
        // 320/560 ms ids (`streaming-nemotron-3.5-multi-{320,560}ms-int8`) are now SHIPPED latency
        // rows, not deprecated — they must NOT be aliased away here.
        "streaming-nemotron-en-80ms"
        | "streaming-nemotron-en-160ms"
        | "streaming-nemotron-en-560ms"
        | "streaming-nemotron-en-1120ms"
        | "streaming-nemotron-en-80ms-int8"
        | "streaming-nemotron-en-160ms-int8"
        | "streaming-nemotron-en-560ms-int8"
        | "streaming-nemotron-en-1120ms-int8" => "streaming-nemotron-3.5-multi-1120ms-int8",
        // Granite Speech 4.1-2b was REPLACED by the 4.1-2b-plus re-export (same AR architecture +
        // graph layout, better training data). Migrate any persisted old-id selection so a user who
        // had the previous model keeps a working choice instead of falling back to `tiny`.
        "granite-speech-4.1-2b" => "granite-speech-4.1-2b-plus",
        _ => id,
    }
}

/// Look up a catalog row by id. Linear scan over 73 entries — cheap and avoids a lazy map.
pub fn find(id: &str) -> Option<&'static ModelEntry> {
    let id = canonical_model_id(id);
    STT_CATALOG.iter().find(|m| m.id == id)
}

const LANGUAGE_DISPLAY_QUALIFIERS: &[&str] = &[
    "english",
    "en",
    "russian",
    "ru",
    "arabic",
    "ar",
    "chinese",
    "zh",
    "japanese",
    "ja",
    "korean",
    "ko",
    "french",
    "fr",
    "german",
    "de",
    "spanish",
    "es",
    "italian",
    "it",
    "portuguese",
    "pt",
    "hindi",
    "hi",
    "ukrainian",
    "uk",
    "vietnamese",
    "vi",
    "multilingual",
];

fn is_streaming_latency_token(token: &str) -> bool {
    let Some(value) = token
        .strip_suffix("ms")
        .or_else(|| token.strip_suffix("MS"))
    else {
        return false;
    };
    !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit())
}

fn strip_streaming_latency(display_name: &str) -> String {
    let mut out = Vec::new();
    let mut skip_quant_after_latency = false;
    for token in display_name.split_whitespace() {
        if skip_quant_after_latency && token.eq_ignore_ascii_case("int8") {
            skip_quant_after_latency = false;
            continue;
        }
        skip_quant_after_latency = false;
        if is_streaming_latency_token(token) {
            skip_quant_after_latency = true;
            continue;
        }
        out.push(token);
    }
    out.join(" ")
}

pub fn display_name_without_export_qualifiers(display_name: &str) -> String {
    let trimmed = display_name.trim();
    let without_language = if let Some(open) = trimmed.rfind(" (") {
        if trimmed.ends_with(')') {
            let qualifier = trimmed[open + 2..trimmed.len() - 1].trim();
            if LANGUAGE_DISPLAY_QUALIFIERS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(qualifier))
            {
                trimmed[..open].trim_end()
            } else {
                trimmed
            }
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    strip_streaming_latency(without_language)
}

pub fn display_name_for_id(id: &str) -> String {
    let id = canonical_model_id(id);
    find(id).map_or_else(
        || id.to_string(),
        |m| display_name_without_export_qualifiers(m.display_name),
    )
}

/// The published quantization list for `id`. Thin wrapper over the catalog field; kept as a named
/// accessor so call sites read intent and so any future per-model correction has one chokepoint.
/// Unknown ids default to `[""]` (fp32 default export — the permissive off-catalog assumption).
pub fn quantizations_for_id(id: &str) -> &'static [&'static str] {
    find(id).map_or(&[""], |m| m.available_quantizations)
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
    WebGpu,
    Cpu,
}

impl Accelerator {
    #[inline]
    pub const fn is_cuda(self) -> bool {
        matches!(self, Accelerator::Cuda)
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
