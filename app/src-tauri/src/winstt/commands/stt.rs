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

use crate::winstt::catalog::{
    self, effective_quantization, Accelerator, ModelEntry, STT_CATALOG,
};

use super::settings::read_settings;
use crate::winstt::settings_schema::DeviceType;

/// One catalog row as the picker consumes it. Mirrors WinSTT's `ModelInfo`
/// slice (engine + picker fields). `effective_quantization` is the badge bridge
/// (what actually loads under the current device) — see memory
/// `project_effective_quantization_bridge`.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    pub family: String,
    pub onnx_model_name: String,
    pub available_quantizations: Vec<String>,
    pub effective_quantization: String,
    pub param_count: u64,
    pub supports_realtime: bool,
}

/// Live hardware resources surfaced to the picker (so it can warn before a swap).
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveResources {
    pub ram_total_bytes: u64,
    pub ram_available_bytes: u64,
    pub vram_total_bytes: u64,
    pub disk_free_bytes: u64,
}

/// Resolve the picker's accelerator from the persisted `model.device`. `Auto`
/// resolves to the shipped GPU flavor (DirectML on Windows) — the precise EP is
/// probed at session-create; for the picker policy we only need cuda-vs-not, and
/// Windows ships DirectML (not CUDA), so Auto → DirectMl here.
fn picker_accelerator(app: &AppHandle) -> Accelerator {
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

fn to_model_info(entry: &ModelEntry, accel: Accelerator) -> ModelInfo {
    let available: Vec<&str> = catalog::picker_quantizations_for(entry, accel);
    // The user's requested quant comes from settings (model.onnxQuantization);
    // here we report the AUTO effective quant ("" / "auto" request) which is what
    // the badge needs for the "is the on-disk export the one that loads" check.
    let eff = effective_quantization(
        "auto",
        accel,
        entry.param_count,
        Some(entry.available_quantizations),
        entry.family,
    );
    ModelInfo {
        id: entry.id.to_string(),
        display_name: entry.display_name.to_string(),
        family: entry.family.as_str().to_string(),
        onnx_model_name: entry.onnx_model_name.to_string(),
        available_quantizations: available.iter().map(|s| s.to_string()).collect(),
        effective_quantization: eff.to_string(),
        param_count: entry.param_count,
        supports_realtime: entry.supports_realtime,
    }
}

/// `list_models` — the full 42-model catalog with per-device effective-quant badges.
#[tauri::command]
#[specta::specta]
pub fn list_models(app: AppHandle) -> Vec<ModelInfo> {
    let accel = picker_accelerator(&app);
    STT_CATALOG.iter().map(|e| to_model_info(e, accel)).collect()
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

/// `get_live_resources` — RAM/VRAM/disk for the picker fitness hints.
/// SPIKE: wire to the `windows` ProcessStatus / sysinfo for real numbers; the
/// picker degrades to "unknown" (zeros) cleanly.
#[tauri::command]
#[specta::specta]
pub fn get_live_resources(_app: AppHandle) -> LiveResources {
    // SPIKE: populate via GlobalMemoryStatusEx (windows Win32_System_ProcessStatus)
    // + DXGI adapter VRAM + the cache dir's free space. Zeros until then.
    LiveResources::default()
}

/// `set_custom_model` — register/scan a user-supplied ONNX model directory.
/// SPIKE: scan the directory for the family-shaped file set (encoder/decoder/...)
/// and add it as a `Family::Custom` catalog row; the resolver treats it like any
/// off-catalog repo. Returns the inferred ModelInfo on success.
#[tauri::command]
#[specta::specta]
pub fn set_custom_model(_app: AppHandle, path: String) -> Result<ModelInfo, String> {
    // SPIKE: detect family from the file layout (custom-model scanner port). Until
    // then, reject with a clear message so the UI surfaces "not yet supported".
    let _ = path;
    Err("custom model scanning not yet wired (scanner spike)".to_string())
}
