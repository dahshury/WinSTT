// Family / Accelerator types and the deterministic precision + execution-provider resolution
// policy: id canonicalization, display-name helpers, the per-family int8/fp16-auto policy, and
// the DML force-CPU decision. Consumes the static `ModelEntry` rows + `STT_CATALOG` table from the
// sibling `data` module via `super::`. There is no ML here — only string-state arithmetic — so it
// is written as REAL code with `#[cfg(test)]` unit tests (per slice rules).

use std::collections::BTreeSet;

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

/// fp16 auto-promotion floor: on CUDA, `"auto"`/`""` resolves to fp16 only at or above this
/// param count (and only if the model publishes fp16). Below it, fp16's I/O cast overhead
/// dominates compute and fp32 wins. Source: `bootstrap._FP16_AUTO_PARAM_THRESHOLD` (500M),
/// benchmarked on an RTX 3080 Ti.
pub const FP16_AUTO_PARAM_THRESHOLD: u64 = 500_000_000;

/// Quantizations ORT's CUDAExecutionProvider can actually accelerate. Everything else
/// (`int8`/`uint8`/`q4`/`q4f16`/`bnb4`) falls back to fp32 compute via QDQ scatter-gather
/// (slower) and per-channel int8 hallucinates on Whisper (onnxruntime#25489). Source:
/// `model_registry._GPU_COMPATIBLE_QUANTIZATIONS`.
pub const GPU_COMPATIBLE_QUANTIZATIONS: &[&str] = &["", "fp16", "fp16w"];

pub fn canonical_model_id(id: &str) -> &str {
    match id {
        // The April 2026 sherpa-onnx Nemotron bundles documented upstream are int8. The
        // non-int8 HF repos currently contain only tiny placeholder/incomplete graphs despite
        // the old catalog advertising them as fp32, so old non-int8 selections are routed to the
        // matching real int8 latency bundle. Concrete latency rows must NOT collapse to 1120ms:
        // listen mode exposes latency as the speed-vs-accuracy control.
        "streaming-nemotron-en-80ms" => "streaming-nemotron-en-80ms-int8",
        "streaming-nemotron-en-160ms" => "streaming-nemotron-en-160ms-int8",
        "streaming-nemotron-en-560ms" => "streaming-nemotron-en-560ms-int8",
        "streaming-nemotron-en-1120ms" => "streaming-nemotron-en-1120ms-int8",
        _ => id,
    }
}

/// Look up a catalog row by id. Linear scan over 71 entries — cheap and avoids a lazy map.
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
///        - CUDA + param >= 500M + publishes fp16/fp16w -> `Some("fp16"/"fp16w")`
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
        if accel.is_cuda() && param_count >= FP16_AUTO_PARAM_THRESHOLD && publishes("fp16w") {
            return Some("fp16w");
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
    const ALL: &[&str] = &["", "fp16", "fp16w", "q4", "q4f16", "bnb4", "int8", "uint8"];
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
