// The specta/serde-derived wire DTO structs shared with the renderer schemas
// (`rawModelInfoSchema` / `model-state-store.ts`) — pure data, derive-only, no logic except
// `ModelCacheInfo::not_cached`. Imported by both the core pipeline (`mod.rs`) and `runtime.rs`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

/// One rich catalog row as the picker consumes it. snake_case on the wire to match
/// `rawModelInfoSchema` (catalog-store.ts) exactly — the renderer does no remapping of the keys.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct CatalogModelInfo {
    pub id: String,
    pub display_name: String,
    pub family: String,
    pub languages: Vec<String>,
    pub supports_language_detection: bool,
    pub size_label: String,
    /// Legacy alias for `preview_capable`. Kept for older renderer builds.
    pub supports_realtime: bool,
    /// Whether this model can drive the live preview UI at all. This may be a
    /// simulated rolling/window re-decode path rather than native streaming.
    pub preview_capable: bool,
    /// Whether the loaded engine consumes only new audio through a stateful/native
    /// streaming decoder (`Transcriber::stream_accept`).
    pub native_streaming: bool,
    /// Whether realtime text can be promoted to final paste without a fresh
    /// full-context final decode.
    pub final_reuse_safe: bool,
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
    pub(super) fn not_cached() -> Self {
        Self {
            state: "not_cached".into(),
            downloaded_bytes: 0,
            total_bytes: 0,
            progress: 0.0,
        }
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
    /// Where each PUBLISHED quant actually runs under the current accelerator: "gpu" (a
    /// VRAM-backed EP — DirectML/CUDA) or "cpu" (RAM-backed). Computed from the per-engine
    /// device pin matrix (`override_dml_to_cpu_for_kind`), so CPU-pinned engines (Cohere,
    /// Kaldi transducers) and per-quant DML demotions report "cpu" even on GPU hosts. The
    /// renderer's fit filter picks the RAM-vs-VRAM pool from this (older servers omit it;
    /// the renderer falls back to its GPU-compatible-quant heuristic).
    pub device_by_quantization: BTreeMap<String, String>,
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

/// The exact set of `CatalogModelInfo` wire keys (snake_case), sorted, serialized to the
/// committed parity fixture (`spec/fixtures/catalog-model-info.fields.json`). This is the byte
/// bridge that keeps this struct and the renderer's `rawModelInfoSchema` (catalog-store.ts) from
/// drifting: the Rust test `catalog_dto_fields_match_committed` asserts the fixture is current, and
/// the TS test `catalog-model-info.parity.test.ts` asserts the zod schema's keys reproduce it — so
/// a field added on one side without the other fails CI. Derived from a real serialized instance
/// (not a hand-list) so the fixture cannot lie about what the struct emits. Regenerate via
/// `cargo run --example export_catalog_parity_fixtures`.
pub fn catalog_dto_fields_json() -> Result<String, serde_json::Error> {
    // A zeroed sample: `serde` emits every field (no `skip_serializing_if` on the struct), so the
    // object's key set is exactly the wire surface — `Option` fields serialize as a present `null`.
    let sample = CatalogModelInfo {
        id: String::new(),
        display_name: String::new(),
        family: String::new(),
        languages: Vec::new(),
        supports_language_detection: false,
        size_label: String::new(),
        supports_realtime: false,
        preview_capable: false,
        native_streaming: false,
        final_reuse_safe: false,
        onnx_model_name: None,
        description: String::new(),
        available_quantizations: Vec::new(),
        size_bytes_by_quantization: BTreeMap::new(),
        available: false,
        error_message: String::new(),
        local_path: None,
        speed_score: 0.0,
        accuracy_score: 0.0,
    };
    let serde_json::Value::Object(map) = serde_json::to_value(&sample)? else {
        unreachable!("a struct always serializes to a JSON object");
    };
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    let mut json = serde_json::to_string_pretty(&keys)?;
    json.push('\n');
    Ok(json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_dto_fields_match_committed() {
        // The committed fixture is the byte bridge to the renderer's rawModelInfoSchema. If this
        // fails, a field was added/removed/renamed on CatalogModelInfo — regenerate with
        // `cargo run --example export_catalog_parity_fixtures` and update the zod schema to match.
        let committed = include_str!("../../../../../spec/fixtures/catalog-model-info.fields.json");
        let generated = catalog_dto_fields_json().expect("serialize dto fields");
        assert_eq!(
            committed, generated,
            "spec/fixtures/catalog-model-info.fields.json is stale — rerun export_catalog_parity_fixtures"
        );
    }
}
