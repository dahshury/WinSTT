// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/01_stt_catalog.md +
// 03_stt_engine.md + lib_wiring.md §3, frontend/electron/ipc/stt-models / model-picker.
//
// STT catalog + picker commands. These wrap the pure `winstt::catalog` policy
// tables (the 42-model catalog, quant/EP resolution, effective-quant badge) and
// surface them to the detached model-picker window. The actual model
// download/switch rides Handy's existing model/transcription managers (the engine
// swap is internal to TranscriptionManager — lib_wiring §7); these commands only
// supply the catalog view + the effective-quantization bridge.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

use crate::winstt::catalog::{self, Accelerator};

use super::catalog_data::{self, CatalogModelInfo};
use super::settings::read_settings;
use crate::winstt::settings_schema::DeviceType;

/// One GPU as the renderer's `LiveResourcesEntry.gpus` (ipc-client.ts `LiveGpuEntry`) expects it.
/// snake_case on the wire — the renderer reads `total_vram_bytes` / `free_vram_bytes` directly.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
pub struct LiveGpuEntry {
    pub name: String,
    pub total_vram_bytes: u64,
    pub free_vram_bytes: u64,
    pub used_vram_bytes: u64,
    pub utilization_percent: f64,
}

/// Live host snapshot — byte-identical to the renderer's `LiveResourcesEntry` (ipc-client.ts) so
/// the picker's client-side fit mirror (`assessDictationFitClient`) reads it verbatim. A zeroed
/// snapshot is valid (the fit assessors degrade to `unknown_footprint`); real numbers are a
/// compile-loop spike (`sysinfo` + DXGI VRAM) deferred to avoid adding a crate mid-port.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
pub struct LiveResources {
    pub cpu_count_logical: u32,
    pub cpu_count_physical: u32,
    pub cpu_percent: f64,
    pub gpus: Vec<LiveGpuEntry>,
    pub ram_available_bytes: u64,
    pub ram_total_bytes: u64,
}

/// Resolve the picker's accelerator from the persisted `model.device`. `Auto`
/// resolves to the shipped GPU flavor (DirectML on Windows) — the precise EP is
/// probed at session-create; for the picker policy we only need cuda-vs-not, and
/// Windows ships DirectML (not CUDA), so Auto → DirectMl here.
pub fn picker_accelerator(app: &AppHandle) -> Accelerator {
    let settings = read_settings(app);
    match settings.model.device {
        DeviceType::Cpu => Accelerator::Cpu,
        DeviceType::Auto => {
            if cfg!(windows) {
                Accelerator::DirectMl
            } else {
                Accelerator::Cpu
            }
        }
    }
}

/// `list_models` — the full 42-model RICH catalog (editorial fields the picker renders:
/// backend / languages / description / size_label / per-quant byte sizes / accuracy+speed scores).
/// Backed by the embedded `catalog_data.json` (see `catalog_data.rs`); the per-device quant set is
/// CUDA-filtered. The adapter routes `STT_GET_MODEL_CATALOG` here, and the renderer's
/// `fetchModelCatalog` → `rawModelInfoSchema.safeParse` consumes these rows verbatim.
///
/// NOTE: the WITH_STATE channel needs the `{models,states,system_info}` OBJECT shape instead — that
/// is `list_models_with_state` (commands/runtime.rs). The WU-0 adapter currently routes BOTH
/// `STT_GET_MODEL_CATALOG` and `STT_LIST_MODELS_WITH_STATE` → `list_models`; the latter must be
/// repointed to `list_models_with_state` (see WU-4 libWiringNeeded note).
#[tauri::command]
#[specta::specta]
pub fn list_models(app: AppHandle) -> Vec<CatalogModelInfo> {
    let accel = picker_accelerator(&app);
    catalog_data::catalog_rows(accel)
}

/// `picker_quantizations_for` — the quant suffixes the picker should offer for a
/// model under the current device (CUDA drops sub-fp16; others keep the full set).
#[tauri::command]
#[specta::specta]
pub fn picker_quantizations_for(app: AppHandle, model_id: String) -> Vec<String> {
    let accel = picker_accelerator(&app);
    match catalog::find(&model_id) {
        Some(entry) => crate::winstt::catalog::picker_quantizations_for(entry, accel)
            .iter()
            .map(|s| s.to_string())
            .collect(),
        None => Vec::new(),
    }
}

/// `get_live_resources` — CPU/RAM/GPU host snapshot for the picker fitness hints. Returns the
/// renderer's `LiveResourcesEntry` shape (ipc-client.ts). `forceRefresh` is accepted (and ignored
/// for now) so the wrapper's `{ forceRefresh }` arg deserializes cleanly.
/// SPIKE: populate via `sysinfo` (RAM/CPU) + DXGI adapter VRAM. Zeros until then — the renderer's
/// fit assessors degrade to `unknown_footprint` (no false warnings).
#[tauri::command]
#[specta::specta]
pub fn get_live_resources(_app: AppHandle, force_refresh: Option<bool>) -> LiveResources {
    let _ = force_refresh;
    LiveResources::default()
}

/// `set_custom_model` — register/scan a user-supplied ONNX model directory.
/// SPIKE: scan the directory for the family-shaped file set (encoder/decoder/...)
/// and add it as a `Family::Custom` catalog row; the resolver treats it like any
/// off-catalog repo. Returns the inferred catalog row on success.
#[tauri::command]
#[specta::specta]
pub fn set_custom_model(_app: AppHandle, path: String) -> Result<CatalogModelInfo, String> {
    // SPIKE: detect family from the file layout (custom-model scanner port). Until
    // then, reject with a clear message so the UI surfaces "not yet supported".
    let _ = path;
    Err("custom model scanning not yet wired (scanner spike)".to_string())
}
