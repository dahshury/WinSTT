// The rich model catalog. Reference shapes:
//   server/src/recorder/domain/catalog.json (the 69-model editorial catalog)
//   + server/src/recorder/domain/model_registry.py (_serialize_model / _size_label /
//     _accuracy_score / _speed_score / _backend_from_str)
//   + server/src/recorder/infrastructure/model_state.py (model_state_dict / fitness)
//   + server/src/stt_server/control_handler.py (_effective_quant_for — the picker badge bridge).
//
// This module is the RICH catalog the detached model-picker actually renders. The thin
// `winstt::catalog::STT_CATALOG` const (loader policy table) carries only the engine fields;
// the renderer's `rawModelInfoSchema` (entities/model-catalog/model/catalog-store.ts) REQUIRES
// the editorial fields (backend, languages, description, size_label, supports_language_detection,
// per-quant byte sizes, accuracy/speed scores). Those live in catalog.json, which we embed via
// `include_str!` (colocated `catalog_data.json`, refreshed from the server copy) and parse once.
//
// Shapes are byte-identical to the WS payloads the reference renderer consumed, so `fetchModelCatalog`
// (→ rawModelInfoSchema.safeParse) and `fetchModelsWithState` (→ {models, states, system_info}) run
// VERBATIM through the polyfill adapter.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::winstt::catalog::{self, Accelerator};

mod cloud;
mod dto;

pub use cloud::{all_cloud_catalog_rows, cloud_catalog_rows, CloudCatalogModel};
pub use dto::{
    CatalogModelInfo, ModelCacheInfo, ModelStateEntry, ModelsWithState, SystemInfoEntry,
    SystemInfoGpu,
};

/// Raw catalog.json row (editorial source of truth). `wer`/`rtfx` are present on every shipped row
/// (asserted upstream); the rest map 1:1 to the renderer's `rawModelInfoSchema`.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct RawCatalogEntry {
    id: String,
    display_name: String,
    family: String,
    onnx_model_name: String,
    description: String,
    languages: Vec<String>,
    supports_language_detection: bool,
    supports_realtime: bool,
    param_count: u64,
    #[serde(default)]
    available_quantizations: Vec<String>,
    #[serde(default)]
    size_bytes_by_quantization: BTreeMap<String, u64>,
    #[serde(default)]
    wer: f64,
    #[serde(default)]
    rtfx: f64,
}

#[derive(Clone, Debug, Deserialize)]
struct RawCatalogFile {
    models: Vec<RawCatalogEntry>,
}

/// The embedded editorial catalog (refreshed from server/src/recorder/domain/catalog.json).
const CATALOG_JSON: &str = include_str!("catalog_data/catalog_data.json");

fn raw_catalog() -> &'static [RawCatalogEntry] {
    static PARSED: OnceLock<Vec<RawCatalogEntry>> = OnceLock::new();
    PARSED
        .get_or_init(|| {
            serde_json::from_str::<RawCatalogFile>(CATALOG_JSON)
                .map(|f| f.models)
                .unwrap_or_default()
        })
        .as_slice()
}

// ── Editorial-field derivations (ports of model_registry.py) ───────────────────────────────────

/// `_size_label`: sub-billion → `{N}M`, ≥1B → `{N.NN}B`. Empty for unknown (0) params.
pub fn size_label(params: u64) -> String {
    if params == 0 {
        return String::new();
    }
    if params >= 1_000_000_000 {
        let b = params as f64 / 1_000_000_000.0;
        if (b - b.round()).abs() < f64::EPSILON {
            return format!("{}B", b.round() as u64);
        }
        // round to 2dp, drop trailing zeros ({:g} parity).
        let rounded = (b * 100.0).round() / 100.0;
        let s = format!("{rounded}");
        return format!("{s}B");
    }
    let m = (params as f64 / 1_000_000.0).round() as u64;
    format!("{m}M")
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// `_accuracy_score`: 0.5 sentinel for unknown (`wer<=0`); else linear ramp anchored at 30% WER.
pub fn accuracy_score(wer: f64) -> f64 {
    if wer <= 0.0 {
        return 0.5;
    }
    round3(clamp(1.0 - wer / 30.0, 0.05, 0.99))
}

/// `_speed_score`: 0.5 sentinel for unknown (`rtfx<=0`); else log10-scaled over the 1x..2000x span.
pub fn speed_score(rtfx: f64) -> f64 {
    if rtfx <= 0.0 {
        return 0.5;
    }
    round3(clamp((rtfx + 1.0).log10() / 2001.0_f64.log10(), 0.05, 0.99))
}

fn streaming_wer_estimate(id: &str) -> Option<f64> {
    if id == "streaming-zipformer-en" {
        return Some(9.5);
    }
    if id.starts_with("streaming-nemo-ctc-en") {
        return Some(if id.contains("1040ms") {
            8.0
        } else if id.contains("480ms") {
            8.2
        } else {
            8.5
        });
    }
    if id.starts_with("streaming-nemo-rnnt-en") {
        return Some(if id.contains("1040ms") {
            6.3
        } else if id.contains("480ms") {
            6.5
        } else {
            6.8
        });
    }
    if id.starts_with("streaming-parakeet-unified-en") {
        return Some(if id.contains("1120ms") {
            4.3
        } else if id.contains("560ms") {
            4.5
        } else {
            4.7
        });
    }
    if id.starts_with("streaming-nemotron-en") {
        return Some(if id.contains("1120ms") {
            3.9
        } else if id.contains("560ms") {
            4.0
        } else if id.contains("160ms") {
            4.1
        } else {
            4.2
        });
    }
    None
}

fn streaming_rtfx_estimate(id: &str) -> Option<f64> {
    if id == "streaming-zipformer-en" {
        return Some(1100.0);
    }
    if id.starts_with("streaming-nemo-ctc-en") {
        let base = if id.contains("1040ms") {
            900.0
        } else if id.contains("480ms") {
            820.0
        } else {
            700.0
        };
        return Some(if id.contains("int8") {
            base * 1.45
        } else {
            base
        });
    }
    if id.starts_with("streaming-nemo-rnnt-en") {
        let base = if id.contains("1040ms") {
            780.0
        } else if id.contains("480ms") {
            700.0
        } else {
            600.0
        };
        return Some(if id.contains("int8") {
            base * 1.45
        } else {
            base
        });
    }
    if id.starts_with("streaming-parakeet-unified-en") {
        let base = if id.contains("1120ms") {
            300.0
        } else if id.contains("560ms") {
            260.0
        } else {
            220.0
        };
        return Some(if id.contains("int8") {
            base * 1.95
        } else {
            base
        });
    }
    if id.starts_with("streaming-nemotron-en") {
        return Some(if id.contains("1120ms") {
            700.0
        } else if id.contains("560ms") {
            640.0
        } else if id.contains("160ms") {
            560.0
        } else {
            520.0
        });
    }
    None
}

fn effective_wer(entry: &RawCatalogEntry, native_streaming: bool) -> f64 {
    if entry.wer > 0.0 || !native_streaming {
        return entry.wer;
    }
    streaming_wer_estimate(&entry.id).unwrap_or(entry.wer)
}

fn effective_rtfx(entry: &RawCatalogEntry, native_streaming: bool) -> f64 {
    if entry.rtfx > 0.0 || !native_streaming {
        return entry.rtfx;
    }
    streaming_rtfx_estimate(&entry.id).unwrap_or(entry.rtfx)
}

fn streaming_description(id: &str) -> Option<&'static str> {
    if id == "streaming-zipformer-en" {
        return Some("Compact native-streaming English model for the fastest live preview.");
    }
    if id.starts_with("streaming-nemo-ctc-en") {
        return Some("Very low-latency English CTC stream for lightweight live transcription.");
    }
    if id.starts_with("streaming-nemo-rnnt-en") {
        return Some("Balanced English transducer stream with cleaner partials than the CTC path.");
    }
    if id.starts_with("streaming-parakeet-unified-en") {
        return Some(
            "High-accuracy English Parakeet stream for reusable live text on stronger CPUs.",
        );
    }
    if id.starts_with("streaming-nemotron-en") {
        return Some("Highest-quality English native stream for reusable final dictation text.");
    }
    None
}

fn catalog_description(entry: &RawCatalogEntry) -> String {
    if let Some(description) = streaming_description(&entry.id) {
        return description.to_string();
    }
    entry.description.clone()
}

// ── Fitness heuristics (port of model_state.py) ────────────────────────────────────────────────

const BYTES_PER_PARAM_INT8: f64 = 1.5;
const GPU_HEADROOM: f64 = 1.5;
const CPU_HEADROOM: f64 = 2.0;

fn estimate_runtime_bytes(param_count: u64) -> u64 {
    if param_count == 0 {
        return 0;
    }
    (param_count as f64 * BYTES_PER_PARAM_INT8) as u64
}

fn is_comfortable_on_gpu(param_count: u64, sys: &SystemInfoEntry) -> bool {
    if sys.gpus.is_empty() {
        return false;
    }
    let needed = estimate_runtime_bytes(param_count);
    if needed == 0 {
        return true;
    }
    sys.gpus
        .iter()
        .all(|g| g.total_vram_bytes as f64 >= needed as f64 * GPU_HEADROOM)
}

fn is_comfortable_on_cpu(param_count: u64, sys: &SystemInfoEntry) -> bool {
    let needed = estimate_runtime_bytes(param_count);
    if needed == 0 || sys.total_ram_bytes == 0 {
        return true;
    }
    sys.total_ram_bytes as f64 >= needed as f64 * CPU_HEADROOM
}

// ── Public builders (the two commands consume these) ───────────────────────────────────────────

fn family_quants_for(entry: &RawCatalogEntry, accel: Accelerator) -> Vec<String> {
    // Mirror catalog::picker_quantizations_for: CUDA drops sub-fp16 for ORT-loaded rows. Native
    // sherpa streaming rows run through sherpa's CPU provider, so keep their published int8 rows.
    let avail: Vec<&str> = entry
        .available_quantizations
        .iter()
        .map(String::as_str)
        .collect();
    let kind = engine_kind_for(entry);
    if accel.is_cuda() && !kind.supports_native_streaming() {
        avail
            .into_iter()
            .filter(|q| catalog::GPU_COMPATIBLE_QUANTIZATIONS.contains(q))
            .map(str::to_string)
            .collect()
    } else {
        avail.into_iter().map(str::to_string).collect()
    }
}

fn engine_kind_for(entry: &RawCatalogEntry) -> crate::winstt::stt::EngineKind {
    crate::winstt::stt::cache_probe::engine_kind_for(
        &entry.id,
        &entry.family,
        &entry.onnx_model_name,
    )
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

fn display_name_without_language_qualifier(display_name: &str) -> String {
    let trimmed = display_name.trim();
    let Some(open) = trimmed.rfind(" (") else {
        return display_name_without_streaming_latency(trimmed);
    };
    if !trimmed.ends_with(')') {
        return display_name_without_streaming_latency(trimmed);
    }
    let qualifier = trimmed[open + 2..trimmed.len() - 1].trim();
    let without_language = if LANGUAGE_DISPLAY_QUALIFIERS
        .iter()
        .any(|known| known.eq_ignore_ascii_case(qualifier))
    {
        trimmed[..open].trim_end()
    } else {
        trimmed
    };
    display_name_without_streaming_latency(without_language)
}

fn is_streaming_latency_token(token: &str) -> bool {
    let Some(value) = token
        .strip_suffix("ms")
        .or_else(|| token.strip_suffix("MS"))
    else {
        return false;
    };
    !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit())
}

fn display_name_without_streaming_latency(display_name: &str) -> String {
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

/// One rich catalog row (CUDA-filtered quant set + size map), ready for `fetchModelCatalog`.
fn to_catalog_row(entry: &RawCatalogEntry, accel: Accelerator) -> CatalogModelInfo {
    let quants = family_quants_for(entry, accel);
    let sizes: BTreeMap<String, u64> = entry
        .size_bytes_by_quantization
        .iter()
        .filter(|(q, _)| quants.contains(*q))
        .map(|(q, b)| (q.clone(), *b))
        .collect();
    let kind = engine_kind_for(entry);
    let native_streaming = kind.supports_native_streaming();
    let preview_capable = entry.supports_realtime;
    CatalogModelInfo {
        id: entry.id.clone(),
        display_name: display_name_without_language_qualifier(&entry.display_name),
        backend: "onnx_asr".into(),
        family: entry.family.clone(),
        languages: entry.languages.clone(),
        supports_language_detection: entry.supports_language_detection,
        size_label: size_label(entry.param_count),
        supports_realtime: preview_capable,
        preview_capable,
        native_streaming,
        final_reuse_safe: kind.final_reuse_safe(),
        onnx_model_name: Some(entry.onnx_model_name.clone()),
        description: catalog_description(entry),
        available_quantizations: quants,
        size_bytes_by_quantization: sizes,
        available: true,
        error_message: String::new(),
        local_path: None,
        speed_score: speed_score(effective_rtfx(entry, native_streaming)),
        accuracy_score: accuracy_score(effective_wer(entry, native_streaming)),
    }
}

fn is_visible_local_catalog_entry(entry: &RawCatalogEntry) -> bool {
    // The April 2026 sherpa-onnx Nemotron ONNX release documents int8 bundles only. The
    // non-int8 rows were imported with fp32 size labels, but their repos currently contain
    // tiny/incomplete graphs, so keep them out of the picker while catalog::find() still maps
    // old persisted ids to the real 1120ms int8 row.
    !entry.id.starts_with("streaming-nemotron-en-") || entry.id.ends_with("-int8")
}

/// The full rich catalog (CUDA-aware quant filtering). Drives `fetchModelCatalog`.
pub fn catalog_rows(accel: Accelerator) -> Vec<CatalogModelInfo> {
    raw_catalog()
        .iter()
        .filter(|e| is_visible_local_catalog_entry(e))
        .map(|e| to_catalog_row(e, accel))
        .collect()
}

/// Re-anchor a `partial` cache fraction that was probed straight off disk to the catalog's KNOWN
/// per-quant download size.
///
/// `cache_probe` sums only the bytes already on disk and has no way to learn a file's REMOTE size
/// from the cache alone, so it reports a partial as `total == downloaded`. `cache_info_from` then
/// renders that as a flat `(downloaded/downloaded).min(0.999)` = 99% for EVERY partial, however
/// little is actually present — and that bogus 99% also seeds the live bar on resume (the renderer's
/// `quantDownloadSeedFromCache`), so the user sees "99%" that jumps to "another percentage" the
/// instant real progress events (measured against the true total) arrive.
///
/// When the catalog carries a credible size for this quant we use it as the denominator so the badge
/// shows TRUE progress and matches what resume will show. No-op when a live in-flight handle already
/// supplied a real total (`total > downloaded`, the overlay path), when the catalog has no size for
/// the quant (off-catalog/custom repo), or when that size isn't larger than what's already on disk.
fn reanchor_partial_to_catalog_size(info: &mut ModelCacheInfo, known_total: Option<u64>) {
    if info.state != "partial" || info.total_bytes > info.downloaded_bytes {
        return;
    }
    let Some(known_total) = known_total else {
        return;
    };
    if known_total > info.downloaded_bytes {
        info.total_bytes = known_total;
        // Keep the 99% ceiling `cache_info_from` uses — 100% is reserved for a fully `cached` quant.
        info.progress = (info.downloaded_bytes as f64 / known_total as f64).min(0.999);
    }
}

/// Build one model's cache+fitness state. `cache_states` supplies any per-quant snapshots already
/// known to the download manager (in-flight / verified on disk); absent precisions read not_cached.
pub(crate) fn to_state_entry(
    entry: &RawCatalogEntry,
    accel: Accelerator,
    sys: &SystemInfoEntry,
    cache_states: &BTreeMap<String, ModelCacheInfo>,
    available_ram_bytes: u64,
    vram_bytes: u64,
) -> ModelStateEntry {
    // `effective_quantization` MUST agree with what the LOAD path (backend::resolve_catalog) will
    // actually pick for "auto", so the picker marks the badge that loads. Both paths now route the
    // SAME kind-based RAM/VRAM-aware resolver (`stt::fit_aware_auto_quant`) over the same inputs —
    // NOT the family-based accuracy-first `catalog::effective_quantization` (which diverged).
    let kind = crate::winstt::stt::cache_probe::engine_kind_for(
        &entry.id,
        &entry.family,
        &entry.onnx_model_name,
    );
    let available: Vec<crate::winstt::stt::Quantization> = entry
        .available_quantizations
        .iter()
        .filter_map(|s| crate::winstt::stt::Quantization::parse(s))
        .collect();
    // catalog::Accelerator → stt::Accelerator (distinct same-variant enums).
    let primary = match accel {
        Accelerator::Cpu => crate::winstt::stt::Accelerator::Cpu,
        Accelerator::Cuda => crate::winstt::stt::Accelerator::Cuda,
        Accelerator::DirectMl => crate::winstt::stt::Accelerator::DirectMl,
        Accelerator::CoreMl => crate::winstt::stt::Accelerator::CoreMl,
        Accelerator::Rocm => crate::winstt::stt::Accelerator::Rocm,
        Accelerator::OpenVino => crate::winstt::stt::Accelerator::OpenVino,
    };
    let eff = crate::winstt::stt::fit_aware_auto_quant(
        &available,
        kind,
        primary,
        entry.param_count,
        available_ram_bytes,
        vram_bytes,
    )
    .suffix()
    .to_string();

    let mut by_quant: BTreeMap<String, ModelCacheInfo> = BTreeMap::new();
    for q in &entry.available_quantizations {
        let mut info = cache_states
            .get(q)
            .cloned()
            .unwrap_or_else(ModelCacheInfo::not_cached);
        reanchor_partial_to_catalog_size(
            &mut info,
            entry.size_bytes_by_quantization.get(q).copied(),
        );
        by_quant.insert(q.clone(), info);
    }
    // Overall = the EFFECTIVE precision's state (memory project_effective_quantization_bridge);
    // fall back to not_cached when the effective precision has no entry (legacy aliases).
    let overall = by_quant
        .get(&eff)
        .cloned()
        .unwrap_or_else(ModelCacheInfo::not_cached);

    ModelStateEntry {
        id: entry.id.clone(),
        cache: overall,
        cache_by_quantization: by_quant,
        available_quantizations: entry.available_quantizations.clone(),
        effective_quantization: eff,
        estimated_bytes: estimate_runtime_bytes(entry.param_count),
        comfortable_on_gpu: is_comfortable_on_gpu(entry.param_count, sys),
        comfortable_on_cpu: is_comfortable_on_cpu(entry.param_count, sys),
    }
}

/// Build the full `{ models, states, system_info }` payload. `cache_by_model` carries any live cache
/// snapshots (model_id → quant → info) the download manager has; everything else reads not_cached.
pub fn models_with_state(
    accel: Accelerator,
    sys: SystemInfoEntry,
    cache_by_model: &BTreeMap<String, BTreeMap<String, ModelCacheInfo>>,
) -> ModelsWithState {
    let empty: BTreeMap<String, ModelCacheInfo> = BTreeMap::new();
    // Live RAM/VRAM read ONCE here (not per entry): to_state_entry runs ~42× over the catalog and
    // the RAM/VRAM-aware "auto" resolver needs the same live budget for every row.
    let available_ram_bytes = {
        let mut s = sysinfo::System::new();
        s.refresh_memory();
        s.available_memory()
    };
    let vram_bytes = crate::winstt::commands::runtime::detected_max_vram_bytes();
    let visible_entries: Vec<_> = raw_catalog()
        .iter()
        .filter(|e| is_visible_local_catalog_entry(e))
        .collect();
    let models = visible_entries
        .iter()
        .map(|e| to_catalog_row(e, accel))
        .collect();
    let states = visible_entries
        .iter()
        .map(|e| {
            let states = cache_by_model.get(&e.id).unwrap_or(&empty);
            to_state_entry(e, accel, &sys, states, available_ram_bytes, vram_bytes)
        })
        .collect();
    ModelsWithState {
        models,
        states,
        system_info: sys,
    }
}

/// Resident-bytes estimate for a single catalog id (used by fit assessment commands).
pub fn estimated_bytes_for(model_id: &str) -> u64 {
    raw_catalog()
        .iter()
        .find(|e| e.id == model_id)
        .map_or(0, |e| estimate_runtime_bytes(e.param_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_parses_73_rows() {
        assert_eq!(
            raw_catalog().len(),
            73,
            "embedded catalog must carry all 73 shipped models"
        );
    }

    #[test]
    fn size_label_matches_python() {
        assert_eq!(size_label(37_760_640), "38M");
        assert_eq!(size_label(0), "");
        assert_eq!(size_label(1_000_000_000), "1B");
        assert_eq!(size_label(1_540_000_000), "1.54B");
    }

    fn partial_info(downloaded: u64, total: u64) -> ModelCacheInfo {
        ModelCacheInfo {
            state: "partial".into(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            progress: if total > 0 {
                (downloaded as f64 / total as f64).min(0.999)
            } else {
                0.0
            },
        }
    }

    #[test]
    fn reanchor_replaces_bogus_99_with_real_fraction() {
        // Off-disk partial probe reports total == downloaded → cache_info_from rendered a flat 99%.
        let mut info = partial_info(150_000_000, 150_000_000);
        assert!(
            (info.progress - 0.999).abs() < 1e-9,
            "precondition: flat 99%"
        );
        reanchor_partial_to_catalog_size(&mut info, Some(663_048_980));
        assert_eq!(info.total_bytes, 663_048_980);
        assert!(
            (info.progress - 150_000_000.0 / 663_048_980.0).abs() < 1e-6,
            "progress re-anchored to the catalog total, not a flat 99%"
        );
    }

    #[test]
    fn reanchor_leaves_live_download_total_alone() {
        // A live in-flight handle already supplied a real total (> downloaded) via the overlay; the
        // live bar is authoritative, so the catalog size must NOT clobber it.
        let mut info = partial_info(100_000_000, 663_048_980);
        let before = info.progress;
        reanchor_partial_to_catalog_size(&mut info, Some(999_999_999));
        assert_eq!(info.total_bytes, 663_048_980, "live total preserved");
        assert!(
            (info.progress - before).abs() < 1e-12,
            "live progress preserved"
        );
    }

    #[test]
    fn reanchor_noop_without_catalog_size_or_for_non_partial() {
        // No catalog size (off-catalog/custom repo) → unfixable, leave the placeholder as-is.
        let mut info = partial_info(150_000_000, 150_000_000);
        reanchor_partial_to_catalog_size(&mut info, None);
        assert_eq!(info.total_bytes, 150_000_000);
        // Cached/not_cached are never touched.
        let mut cached = ModelCacheInfo {
            state: "cached".into(),
            downloaded_bytes: 663_048_980,
            total_bytes: 663_048_980,
            progress: 1.0,
        };
        reanchor_partial_to_catalog_size(&mut cached, Some(700_000_000));
        assert_eq!(cached.total_bytes, 663_048_980);
        assert!((cached.progress - 1.0).abs() < 1e-12);
    }

    #[test]
    fn scores_use_unknown_sentinel() {
        assert_eq!(accuracy_score(0.0), 0.5);
        assert_eq!(speed_score(0.0), 0.5);
        assert!(accuracy_score(30.0) >= 0.05 && accuracy_score(30.0) <= 0.99);
        assert!(speed_score(2000.0) > 0.5);
    }

    #[test]
    fn rich_rows_carry_editorial_fields() {
        let rows = catalog_rows(Accelerator::Cpu);
        let tiny = rows
            .iter()
            .find(|r| r.id == "tiny")
            .expect("whisper tiny present");
        assert_eq!(tiny.backend, "onnx_asr");
        assert!(!tiny.languages.is_empty());
        assert!(!tiny.description.is_empty());
        assert_eq!(tiny.size_label, "38M");
        assert_eq!(tiny.supports_realtime, tiny.preview_capable);
    }

    #[test]
    fn canary_rows_keep_languages_but_do_not_advertise_auto_detection() {
        let rows = catalog_rows(Accelerator::Cpu);
        for id in [
            "nemo-canary-1b-v2",
            "nemo-canary-180m-flash",
            "nemo-canary-1b-flash",
        ] {
            let row = rows
                .iter()
                .find(|r| r.id == id)
                .unwrap_or_else(|| panic!("{id} present"));
            assert!(
                row.languages.iter().any(|language| language == "de"),
                "{id} should remain selectable for German transcription"
            );
            assert!(
                !row.supports_language_detection,
                "{id} must not expose auto-detect until the local runtime supports it"
            );
        }
    }

    #[test]
    fn runtime_language_ignored_rows_do_not_advertise_auto_detection() {
        let rows = catalog_rows(Accelerator::Cpu);
        for id in ["nemo-parakeet-tdt-0.6b-v3", "dolphin-base-ctc"] {
            let row = rows
                .iter()
                .find(|r| r.id == id)
                .unwrap_or_else(|| panic!("{id} present"));
            assert!(
                row.languages.len() > 1,
                "{id} should still document its supported source languages"
            );
            assert!(
                !row.supports_language_detection,
                "{id} must not expose auto-detect because the local runtime ignores language options"
            );
        }
    }

    #[test]
    fn rich_rows_split_preview_native_streaming_and_final_reuse() {
        let rows = catalog_rows(Accelerator::Cpu);
        assert!(rows
            .iter()
            .all(|r| r.supports_realtime == r.preview_capable));

        let tiny = rows
            .iter()
            .find(|r| r.id == "tiny")
            .expect("whisper tiny present");
        assert!(tiny.preview_capable);
        assert!(!tiny.native_streaming);
        assert!(!tiny.final_reuse_safe);

        let gigaam_ctc = rows
            .iter()
            .find(|r| r.id == "gigaam-v3-e2e-ctc")
            .expect("gigaam ctc present");
        assert!(gigaam_ctc.preview_capable);
        assert!(!gigaam_ctc.native_streaming);
        assert!(gigaam_ctc.final_reuse_safe);

        let t_one = rows
            .iter()
            .find(|r| r.id == "t-tech/t-one")
            .expect("t-one present");
        assert!(t_one.native_streaming);
        assert!(t_one.final_reuse_safe);

        let streaming_rows: Vec<_> = rows
            .iter()
            .filter(|r| r.id.starts_with("streaming-"))
            .collect();
        assert_eq!(streaming_rows.len(), 23);
        for row in streaming_rows {
            let id = &row.id;
            assert!(row.preview_capable, "{id} must be preview-capable");
            assert!(row.native_streaming, "{id} must be native streaming");
            assert!(row.final_reuse_safe, "{id} final text must be reusable");
        }
    }

    #[test]
    fn native_streaming_rows_have_visible_perf_and_human_descriptions() {
        let rows = catalog_rows(Accelerator::Cpu);
        let streaming_rows: Vec<_> = rows
            .iter()
            .filter(|r| r.id.starts_with("streaming-"))
            .collect();
        assert_eq!(streaming_rows.len(), 23);
        for row in streaming_rows {
            let id = &row.id;
            assert!(
                row.accuracy_score > 0.5,
                "{id} must expose a non-neutral accuracy score"
            );
            assert!(
                row.speed_score > 0.5,
                "{id} must expose a non-neutral speed score"
            );
            assert!(
                !row.description.trim().is_empty(),
                "{id} must have a card description"
            );
            assert!(
                !row.description.to_ascii_lowercase().contains(" export"),
                "{id} should not expose export mechanics as the card description"
            );
        }
    }

    #[test]
    fn catalog_rows_strip_language_and_streaming_latency_display_qualifiers() {
        let rows = catalog_rows(Accelerator::Cpu);
        let streaming = rows
            .iter()
            .find(|r| r.id == "streaming-zipformer-en")
            .expect("streaming zipformer row present");
        assert_eq!(streaming.display_name, "Streaming Zipformer");

        let streaming_rnnt = rows
            .iter()
            .find(|r| r.id == "streaming-nemo-rnnt-en-1040ms-int8")
            .expect("streaming rnnt row present");
        assert_eq!(
            streaming_rnnt.display_name,
            "Streaming NeMo FastConformer RNN-T"
        );

        assert!(
            rows.iter()
                .all(|r| !r.id.starts_with("streaming-nemotron-en-") || r.id.ends_with("-int8")),
            "non-int8 Nemotron rows should stay hidden until a complete fp32 export is available"
        );

        let streaming_nemotron = rows
            .iter()
            .find(|r| r.id == "streaming-nemotron-en-1120ms-int8")
            .expect("streaming nemotron row present");
        assert_eq!(streaming_nemotron.display_name, "Streaming Nemotron");
        assert_eq!(
            streaming_nemotron.available_quantizations.as_slice(),
            ["int8"]
        );

        let tiny_en = rows
            .iter()
            .find(|r| r.id == "tiny.en")
            .expect("english-only whisper row present");
        assert_eq!(tiny_en.display_name, "Whisper Tiny");

        let accelerated = rows
            .iter()
            .find(|r| r.id == "lite-whisper-large-v3-turbo-acc")
            .expect("accelerated lite-whisper row present");
        assert_eq!(
            accelerated.display_name,
            "Lite-Whisper Large v3 Turbo (Accelerated)"
        );
    }

    #[test]
    fn cuda_filters_sub_fp16_quants() {
        let rows = catalog_rows(Accelerator::Cuda);
        for r in &rows {
            for q in &r.available_quantizations {
                assert!(
                    r.native_streaming || q.is_empty() || q == "fp16" || q == "fp16w",
                    "CUDA must drop sub-fp16 for non-streaming rows: {q}"
                );
            }
        }
        let streaming_int8 = rows
            .iter()
            .find(|r| r.id == "streaming-nemo-ctc-en-80ms-int8")
            .expect("streaming int8 row present on CUDA");
        assert_eq!(streaming_int8.available_quantizations.as_slice(), ["int8"]);
    }

    #[test]
    fn cloud_catalog_rows_prefix_ids_and_keep_local_grid_clean() {
        let el = cloud_catalog_rows("elevenlabs");
        assert!(el.iter().any(|m| m.model == "elevenlabs:scribe_v1"));
        assert_eq!(el.iter().filter(|m| m.is_default).count(), 1);
        assert!(el.iter().all(|m| m.provider == "elevenlabs"));

        // OpenAI was removed; OpenRouter is dynamic — neither contributes curated rows.
        assert!(cloud_catalog_rows("openai").is_empty());
        assert!(cloud_catalog_rows("openrouter").is_empty());

        // unknown provider → empty (never panics).
        assert!(cloud_catalog_rows("azure").is_empty());

        // The LOCAL editorial catalog must never carry a cloud-prefixed id.
        let local = catalog_rows(Accelerator::Cpu);
        assert!(
            !local.iter().any(|r| r.id.contains(':')),
            "cloud ids must not leak into the local STT grid"
        );

        assert_eq!(all_cloud_catalog_rows().len(), el.len());
    }

    #[test]
    fn state_effective_quant_matches_ram_aware_load_pick() {
        // The DTO's effective_quantization (the picker's MARK source) MUST equal the kind-based
        // RAM/VRAM-aware pick the LOAD path (backend::resolve_catalog) makes for "auto" — same
        // resolver, same inputs — so the picker marks the badge that actually loads.
        let entry = raw_catalog()
            .iter()
            .find(|e| e.family == "cohere")
            .expect("cohere present");
        let sys = SystemInfoEntry::default();
        // Generous budget so the fit check is exercised (vs. the ram==0/vram==0 "everything fits").
        let ram = 64u64 * 1024 * 1024 * 1024;
        let vram = 24u64 * 1024 * 1024 * 1024;
        let st = to_state_entry(
            entry,
            Accelerator::DirectMl,
            &sys,
            &BTreeMap::new(),
            ram,
            vram,
        );

        let kind = crate::winstt::stt::cache_probe::engine_kind_for(
            &entry.id,
            &entry.family,
            &entry.onnx_model_name,
        );
        let available: Vec<crate::winstt::stt::Quantization> = entry
            .available_quantizations
            .iter()
            .filter_map(|s| crate::winstt::stt::Quantization::parse(s))
            .collect();
        let expected = crate::winstt::stt::fit_aware_auto_quant(
            &available,
            kind,
            crate::winstt::stt::Accelerator::DirectMl,
            entry.param_count,
            ram,
            vram,
        )
        .suffix()
        .to_string();
        assert_eq!(st.effective_quantization, expected);
    }
}
