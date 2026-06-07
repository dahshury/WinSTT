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
    /// Always `"onnx_asr"` post-torch-drop (server `_backend_from_str` defaults to it).
    pub backend: String,
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
