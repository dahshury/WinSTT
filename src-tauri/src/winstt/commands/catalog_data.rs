// PORT IMPL — WU-4 (app/PORT/10_frontend_port_plan.md §6 WU-4). Source:
//   server/src/recorder/domain/catalog.json (the 42-model editorial catalog)
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
// Shapes are byte-identical to the WS payloads the Electron renderer consumed, so `fetchModelCatalog`
// (→ rawModelInfoSchema.safeParse) and `fetchModelsWithState` (→ {models, states, system_info}) run
// VERBATIM through the polyfill adapter.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::winstt::catalog::{self, Accelerator, Family};

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
const CATALOG_JSON: &str = include_str!("catalog_data.json");

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

/// One rich catalog row as the picker consumes it. snake_case on the wire to match
/// `rawModelInfoSchema` (catalog-store.ts) exactly — the renderer does no remapping of the keys.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct CatalogModelInfo {
    pub id: String,
    pub display_name: String,
    /// Always `"onnx_asr"` post-torch-drop (server `_backend_from_str` defaults to it).
    pub backend: String,
    pub family: String,
    pub languages: Vec<String>,
    pub supports_language_detection: bool,
    pub size_label: String,
    pub supports_realtime: bool,
    pub onnx_model_name: Option<String>,
    pub description: String,
    /// Quant suffixes (filtered to the CUDA-compatible set on CUDA EPs; full set otherwise).
    pub available_quantizations: Vec<String>,
    pub size_bytes_by_quantization: BTreeMap<String, u64>,
    /// Shipped catalog rows are always available; custom-scan failures would set false.
    pub available: bool,
    pub error_message: String,
    pub local_path: Option<String>,
    /// 0..1 normalized speed score (log-scaled RTFx). 0.5 = unknown → renderer hides the bar.
    pub speed_score: f64,
    /// 0..1 normalized accuracy score (linear-ramped WER). 0.5 = unknown.
    pub accuracy_score: f64,
}

/// Per-precision cache snapshot, mirroring the renderer's `ModelCacheInfo`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct ModelCacheInfo {
    /// "cached" | "partial" | "not_cached".
    pub state: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    /// 0.0..1.0 (1.0 when cached).
    pub progress: f64,
}

impl ModelCacheInfo {
    fn not_cached() -> Self {
        Self { state: "not_cached".into(), downloaded_bytes: 0, total_bytes: 0, progress: 0.0 }
    }
}

/// Per-model cache + fitness state — mirrors the renderer's `ModelStateEntry` (model-state-store.ts).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct ModelStateEntry {
    pub id: String,
    pub cache: ModelCacheInfo,
    pub cache_by_quantization: BTreeMap<String, ModelCacheInfo>,
    pub available_quantizations: Vec<String>,
    /// The precision the loader will ACTUALLY load under the current device — the badge bridge
    /// (memory project_effective_quantization_bridge). The picker keys "downloaded?" off this.
    pub effective_quantization: String,
    pub estimated_bytes: u64,
    pub comfortable_on_gpu: bool,
    pub comfortable_on_cpu: bool,
}

/// One GPU as the renderer's `SystemInfoEntry.gpus` expects it.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
pub struct SystemInfoGpu {
    pub name: String,
    pub total_vram_bytes: u64,
}

/// System snapshot for fitness heuristics — mirrors the renderer's `SystemInfoEntry`.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
pub struct SystemInfoEntry {
    pub total_ram_bytes: u64,
    pub gpus: Vec<SystemInfoGpu>,
}

/// The full `fetchModelsWithState` payload: `{ models, states, system_info }`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct ModelsWithState {
    pub models: Vec<CatalogModelInfo>,
    pub states: Vec<ModelStateEntry>,
    pub system_info: SystemInfoEntry,
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
    sys.gpus.iter().all(|g| g.total_vram_bytes as f64 >= needed as f64 * GPU_HEADROOM)
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
    // Mirror catalog::picker_quantizations_for: CUDA drops sub-fp16, others keep the full set.
    let avail: Vec<&str> = entry.available_quantizations.iter().map(String::as_str).collect();
    if accel.is_cuda() {
        avail
            .into_iter()
            .filter(|q| catalog::GPU_COMPATIBLE_QUANTIZATIONS.contains(q))
            .map(str::to_string)
            .collect()
    } else {
        avail.into_iter().map(str::to_string).collect()
    }
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
    CatalogModelInfo {
        id: entry.id.clone(),
        display_name: entry.display_name.clone(),
        backend: "onnx_asr".into(),
        family: entry.family.clone(),
        languages: entry.languages.clone(),
        supports_language_detection: entry.supports_language_detection,
        size_label: size_label(entry.param_count),
        supports_realtime: entry.supports_realtime,
        onnx_model_name: Some(entry.onnx_model_name.clone()),
        description: entry.description.clone(),
        available_quantizations: quants,
        size_bytes_by_quantization: sizes,
        available: true,
        error_message: String::new(),
        local_path: None,
        speed_score: speed_score(entry.rtfx),
        accuracy_score: accuracy_score(entry.wer),
    }
}

/// The full rich catalog (CUDA-aware quant filtering). Drives `fetchModelCatalog`.
pub fn catalog_rows(accel: Accelerator) -> Vec<CatalogModelInfo> {
    raw_catalog().iter().map(|e| to_catalog_row(e, accel)).collect()
}

/// Build one model's cache+fitness state. `cache_states` supplies any per-quant snapshots already
/// known to the download manager (in-flight / verified on disk); absent precisions read not_cached.
pub(crate) fn to_state_entry(
    entry: &RawCatalogEntry,
    accel: Accelerator,
    sys: &SystemInfoEntry,
    cache_states: &BTreeMap<String, ModelCacheInfo>,
) -> ModelStateEntry {
    let family = Family::from_str(&entry.family);
    let avail: Vec<&str> = entry.available_quantizations.iter().map(String::as_str).collect();
    let eff = catalog::effective_quantization(
        "auto",
        accel,
        entry.param_count,
        Some(&avail),
        family,
    )
    .to_string();

    let mut by_quant: BTreeMap<String, ModelCacheInfo> = BTreeMap::new();
    for q in &entry.available_quantizations {
        let info = cache_states.get(q).cloned().unwrap_or_else(ModelCacheInfo::not_cached);
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
    let models = raw_catalog().iter().map(|e| to_catalog_row(e, accel)).collect();
    let states = raw_catalog()
        .iter()
        .map(|e| {
            let states = cache_by_model.get(&e.id).unwrap_or(&empty);
            to_state_entry(e, accel, &sys, states)
        })
        .collect();
    ModelsWithState { models, states, system_info: sys }
}

/// Resident-bytes estimate for a single catalog id (used by fit assessment commands).
pub fn estimated_bytes_for(model_id: &str) -> u64 {
    raw_catalog()
        .iter()
        .find(|e| e.id == model_id)
        .map(|e| estimate_runtime_bytes(e.param_count))
        .unwrap_or(0)
}

// ── Cloud STT catalog (openai / elevenlabs) ─────────────────────────────────────────────────────
//
// IMPORTANT: cloud STT models are DELIBERATELY NOT folded into `catalog_rows()` /
// `models_with_state()`. The reused React renderer routes its picker between the LOCAL grid
// (`list_models` → `catalog_rows`, schema `rawModelInfoSchema`) and the CLOUD picker
// (`features/select-cloud-stt-model`, which reads its own hardcoded `CLOUD_CATALOG` — never the
// backend) purely off the `openai:` / `elevenlabs:` prefix (`providerOf`). Cloud rows have none of
// the local-engine editorial fields the local grid requires (per-quant byte sizes, WER/RTFx,
// quant set), so injecting them into `catalog_rows()` would surface malformed local cards.
//
// This block is the BACKEND-SIDE MIRROR of the renderer's `CLOUD_CATALOG` (byte-identical ids /
// defaults), exposed as a specta-typed payload so a future "enumerate cloud STT models" command
// (or settings-validation) has a single source of truth. The authoritative pure table lives in
// `winstt::cloud_stt` (`OPENAI_CLOUD_MODELS` / `ELEVENLABS_CLOUD_MODELS`); this only reshapes it.

/// One cloud STT model as the picker would consume it. snake_case on the wire to match the
/// renderer's `CloudModel` shape. `model` is the prefixed `<provider>:<id>` the picker persists
/// into `settings.model.model`; `id` is the bare provider model id.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct CloudCatalogModel {
    /// Bare provider model id (e.g. `whisper-1`).
    pub id: String,
    /// Prefixed `<provider>:<id>` selectable id (e.g. `openai:whisper-1`).
    pub model: String,
    pub provider: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
}

/// The cloud STT catalog for one provider id (`"openai"` / `"elevenlabs"`); empty for unknown.
pub fn cloud_catalog_rows(provider_id: &str) -> Vec<CloudCatalogModel> {
    use crate::winstt::cloud_stt::{cloud_models_for, CloudSttProvider};

    let Some(provider) = CloudSttProvider::from_id(provider_id) else {
        return Vec::new();
    };
    cloud_models_for(provider)
        .iter()
        .map(|m| CloudCatalogModel {
            id: m.id.to_string(),
            model: format!("{}:{}", provider.id(), m.id),
            provider: provider.id().to_string(),
            display_name: m.display_name.to_string(),
            description: m.description.to_string(),
            is_default: m.is_default,
        })
        .collect()
}

/// The full cloud STT catalog across every provider, flattened. Drives any backend
/// enumerate-cloud-models surface.
pub fn all_cloud_catalog_rows() -> Vec<CloudCatalogModel> {
    let mut rows = cloud_catalog_rows("openai");
    rows.extend(cloud_catalog_rows("elevenlabs"));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_parses_42_rows() {
        assert_eq!(raw_catalog().len(), 42, "embedded catalog must carry all 42 shipped models");
    }

    #[test]
    fn size_label_matches_python() {
        assert_eq!(size_label(37_760_640), "38M");
        assert_eq!(size_label(0), "");
        assert_eq!(size_label(1_000_000_000), "1B");
        assert_eq!(size_label(1_540_000_000), "1.54B");
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
        let tiny = rows.iter().find(|r| r.id == "tiny").expect("whisper tiny present");
        assert_eq!(tiny.backend, "onnx_asr");
        assert!(!tiny.languages.is_empty());
        assert!(!tiny.description.is_empty());
        assert_eq!(tiny.size_label, "38M");
    }

    #[test]
    fn cuda_filters_sub_fp16_quants() {
        let rows = catalog_rows(Accelerator::Cuda);
        for r in &rows {
            for q in &r.available_quantizations {
                assert!(q.is_empty() || q == "fp16", "CUDA must drop sub-fp16: {q}");
            }
        }
    }

    #[test]
    fn cloud_catalog_rows_prefix_ids_and_keep_local_grid_clean() {
        let openai = cloud_catalog_rows("openai");
        assert!(openai.iter().any(|m| m.model == "openai:whisper-1"));
        assert_eq!(openai.iter().filter(|m| m.is_default).count(), 1);
        assert!(openai.iter().all(|m| m.provider == "openai"));

        let el = cloud_catalog_rows("elevenlabs");
        assert!(el.iter().any(|m| m.model == "elevenlabs:scribe_v1"));

        // unknown provider → empty (never panics).
        assert!(cloud_catalog_rows("azure").is_empty());

        // The LOCAL editorial catalog must never carry a cloud-prefixed id.
        let local = catalog_rows(Accelerator::Cpu);
        assert!(
            !local.iter().any(|r| r.id.contains(':')),
            "cloud ids must not leak into the local STT grid"
        );

        assert_eq!(all_cloud_catalog_rows().len(), openai.len() + el.len());
    }

    #[test]
    fn state_effective_quant_is_int8_for_int8_preferred_off_cuda() {
        let entry = raw_catalog()
            .iter()
            .find(|e| e.family == "cohere")
            .expect("cohere present");
        let sys = SystemInfoEntry::default();
        let st = to_state_entry(entry, Accelerator::DirectMl, &sys, &BTreeMap::new());
        // Cohere is int8-preferred off-CUDA and publishes int8 → effective resolves to int8.
        if entry.available_quantizations.iter().any(|q| q == "int8") {
            assert_eq!(st.effective_quantization, "int8");
        }
    }
}
