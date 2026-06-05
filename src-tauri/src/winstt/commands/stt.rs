// Source: docs/archive/port/01_stt_catalog.md +
// 03_stt_engine.md + lib_wiring.md §3, frontend/electron/ipc/stt-models / model-picker.
//
// STT catalog + picker commands. These wrap the pure `winstt::catalog` policy
// tables (the 65-model catalog, quant/EP resolution, effective-quant badge) and
// surface them to the detached model-picker window. The actual model
// download/switch rides Handy's existing model/transcription managers (the engine
// swap is internal to TranscriptionManager — lib_wiring §7); these commands only
// supply the catalog view + the effective-quantization bridge.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Mutex;
use tauri::AppHandle;

use crate::winstt::catalog::{self, Accelerator as CatalogAccelerator};

use super::catalog_data::{self, CatalogModelInfo};
use super::settings::read_settings;

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
/// snapshot is valid (the fit assessors degrade to `unknown_footprint`).
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
pub struct LiveResources {
    pub cpu_count_logical: u32,
    pub cpu_count_physical: u32,
    pub cpu_percent: f64,
    pub gpus: Vec<LiveGpuEntry>,
    pub ram_available_bytes: u64,
    pub ram_total_bytes: u64,
}

static LIVE_SYSTEM: Lazy<Mutex<sysinfo::System>> = Lazy::new(|| {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    Mutex::new(sys)
});

/// Resolve the picker's accelerator from the persisted `model.device`, sharing the same
/// platform-aware STT resolver as the engine load path.
pub fn picker_accelerator(app: &AppHandle) -> CatalogAccelerator {
    let settings = read_settings(app);
    catalog_accelerator(crate::winstt::stt::resolve_accelerator(
        settings.model.device,
    ))
}

pub(crate) fn catalog_accelerator(accel: crate::winstt::stt::Accelerator) -> CatalogAccelerator {
    match accel {
        crate::winstt::stt::Accelerator::Cpu => CatalogAccelerator::Cpu,
        crate::winstt::stt::Accelerator::Cuda => CatalogAccelerator::Cuda,
        crate::winstt::stt::Accelerator::DirectMl => CatalogAccelerator::DirectMl,
        crate::winstt::stt::Accelerator::CoreMl => CatalogAccelerator::CoreMl,
        crate::winstt::stt::Accelerator::Rocm => CatalogAccelerator::Rocm,
        crate::winstt::stt::Accelerator::OpenVino => CatalogAccelerator::OpenVino,
    }
}

/// `list_models` — the full 65-model RICH catalog (editorial fields the picker renders:
/// backend / languages / description / size_label / per-quant byte sizes / accuracy+speed scores).
/// Backed by the embedded `catalog_data.json` (see `catalog_data.rs`); the per-device quant set is
/// CUDA-filtered. The adapter routes `STT_GET_MODEL_CATALOG` here, and the renderer's
/// `fetchModelCatalog` → `rawModelInfoSchema.safeParse` consumes these rows verbatim.
///
/// NOTE: the WITH_STATE channel needs the `{models,states,system_info}` OBJECT shape instead — that
/// is `list_models_with_state` (commands/runtime.rs). The adapter routes `STT_GET_MODEL_CATALOG`
/// here and `STT_LIST_MODELS_WITH_STATE` → `list_models_with_state` (native-bridge-adapter.ts ROUTE).
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
/// renderer's `LiveResourcesEntry` shape (ipc-client.ts). `forceRefresh` is accepted for the
/// renderer's polling contract; the snapshot itself is cheap enough to refresh on every call.
#[tauri::command]
#[specta::specta]
pub fn get_live_resources(_app: AppHandle, force_refresh: Option<bool>) -> LiveResources {
    let _ = force_refresh;
    let (ram_available_bytes, ram_total_bytes, cpu_percent) = live_cpu_ram_snapshot();
    LiveResources {
        cpu_count_logical: num_cpus::get() as u32,
        cpu_count_physical: num_cpus::get_physical() as u32,
        cpu_percent,
        gpus: live_gpu_entries(),
        ram_available_bytes,
        ram_total_bytes,
    }
}

fn live_cpu_ram_snapshot() -> (u64, u64, f64) {
    let mut sys = LIVE_SYSTEM
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    (
        sys.available_memory(),
        sys.total_memory(),
        f64::from(sys.global_cpu_usage()),
    )
}

fn live_gpu_entries() -> Vec<LiveGpuEntry> {
    #[cfg(windows)]
    {
        use windows::core::Interface;
        use windows::Win32::Graphics::Dxgi::{
            CreateDXGIFactory1, IDXGIAdapter3, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
        };

        let mut gpus = Vec::new();
        unsafe {
            let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
                Ok(f) => f,
                Err(_) => return gpus,
            };
            let mut idx = 0u32;
            while let Ok(adapter) = factory.EnumAdapters1(idx) {
                idx += 1;
                let desc = match adapter.GetDesc1() {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                    continue;
                }
                let end = desc
                    .Description
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(desc.Description.len());
                let name = String::from_utf16_lossy(&desc.Description[..end]);
                if name.trim().is_empty() {
                    continue;
                }
                let total_vram_bytes = desc.DedicatedVideoMemory as u64;
                if gpus.iter().any(|g: &LiveGpuEntry| {
                    g.name == name && g.total_vram_bytes == total_vram_bytes
                }) {
                    continue;
                }
                let (free_vram_bytes, used_vram_bytes) =
                    query_adapter_vram(&adapter.cast::<IDXGIAdapter3>().ok(), total_vram_bytes);
                let utilization_percent = if total_vram_bytes > 0 {
                    (used_vram_bytes as f64 / total_vram_bytes as f64) * 100.0
                } else {
                    0.0
                };
                gpus.push(LiveGpuEntry {
                    name,
                    total_vram_bytes,
                    free_vram_bytes,
                    used_vram_bytes,
                    utilization_percent,
                });
            }
        }
        gpus
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn query_adapter_vram(
    adapter: &Option<windows::Win32::Graphics::Dxgi::IDXGIAdapter3>,
    total_vram_bytes: u64,
) -> (u64, u64) {
    use windows::Win32::Graphics::Dxgi::{
        DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_QUERY_VIDEO_MEMORY_INFO,
    };

    let Some(adapter) = adapter else {
        return (total_vram_bytes, 0);
    };
    let mut info = DXGI_QUERY_VIDEO_MEMORY_INFO::default();
    let ok = unsafe {
        adapter
            .QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &mut info)
            .is_ok()
    };
    if !ok {
        return (total_vram_bytes, 0);
    }
    let budget = info.Budget.min(total_vram_bytes);
    let current_usage = info.CurrentUsage.min(budget);
    let free_vram_bytes = budget.saturating_sub(current_usage);
    let used_vram_bytes = total_vram_bytes.saturating_sub(free_vram_bytes);
    (free_vram_bytes, used_vram_bytes)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_accelerator_maps_stt_variants() {
        assert_eq!(
            catalog_accelerator(crate::winstt::stt::Accelerator::Cpu),
            CatalogAccelerator::Cpu
        );
        assert_eq!(
            catalog_accelerator(crate::winstt::stt::Accelerator::DirectMl),
            CatalogAccelerator::DirectMl
        );
    }
}
