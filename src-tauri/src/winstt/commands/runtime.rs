// Runtime info + fitness command surface. Reference:
//   frontend/src/shared/api/ipc-client.ts (fetchRuntimeInfo / fetchModelsWithState /
//     assessDictationFit / assessOllamaFitOnServer + the RuntimeInfoPayload /
//     ModelsWithStatePayload / FitAssessmentEntry shapes)
//   + frontend/electron/ipc/stt-runtime.ts / stt-models.ts (the channel handlers)
//   + server/src/recorder/infrastructure/model_state.py + fit_assessment.py.
//
// The runtime / fitness command surface for the picker. These read the catalog + the loaded-model
// state + the persisted device, none of which needs the recorder loaded (so they answer instantly
// during cold start — the renderer's `pre_ready` contract).
//
// IPC mapping (app/src/shared/api/native-bridge-adapter.ts ROUTE):
//   IPC.STT_GET_RUNTIME_INFO        (`stt:get-runtime-info`)                         → get_runtime_info
//   IPC.STT_LIST_MODELS_WITH_STATE  (`stt:list-models-with-state`)                   → stt_list_models_with_state  (⚠ adapter ROUTE fix)
//   IPC.STT_ASSESS_DICTATION_FIT    (`stt:assess-dictation-fit`, { modelId, quantization, device }) → assess_dictation_fit
//   IPC.STT_ASSESS_OLLAMA_FIT       (`stt:assess-ollama-fit`,    { sizeBytes })      → assess_ollama_fit
//   IPC.GPU_GET_INFO                (`gpu:get-info`)                                 → gpu_get_info
//
// The fit assessment commands are intentionally best-effort: the renderer mirrors the SAME formulas
// client-side (entities/system-resources/lib/fit-assessor.ts) and uses `invokeOrDefault(..., null)`,
// so returning `None` is a valid contract — the picker renders per-row badges from its mirror and
// only the actual selection-click round-trips here. Until the real footprint math lands they return
// `None` (the client mirror covers the UI); the wiring + payload types are real.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use crate::managers::transcription::TranscriptionManager;
use crate::winstt::catalog::{self as catalog, Accelerator};
use crate::winstt::managers::DownloadManager;
use crate::winstt::stt::cache_probe::{CacheState, ProbeModel};

use super::catalog_data::{self, ModelCacheInfo, ModelsWithState, SystemInfoEntry};
use super::settings::read_settings;
use super::stt::picker_accelerator;

/// Active-runtime snapshot — byte-identical to the renderer's `RuntimeInfoPayload` (ipc-client.ts):
/// drives the GPU/CPU chip + the `useSyncActiveModel` reconciliation.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct RuntimeInfoPayload {
    /// "cpu" | "directml" | "cuda" | "auto" (the resolved EP label).
    pub device: String,
    pub is_gpu: bool,
    /// The currently-loaded MAIN model id (`None` until a model loads).
    pub model: Option<String>,
    /// Active ORT execution providers (e.g. ["DmlExecutionProvider","CPUExecutionProvider"]).
    pub providers: Vec<String>,
    /// The currently-loaded REALTIME model id (`None` when realtime isn't loaded).
    pub realtime_model: Option<String>,
}

/// Map the resolved accelerator to (device label, is_gpu, provider list) the renderer chip reads.
fn accel_runtime(accel: Accelerator) -> (&'static str, bool, Vec<String>) {
    match accel {
        Accelerator::Cpu => ("cpu", false, vec!["CPUExecutionProvider".into()]),
        Accelerator::DirectMl => (
            "directml",
            true,
            vec!["DmlExecutionProvider".into(), "CPUExecutionProvider".into()],
        ),
        Accelerator::Cuda => (
            "cuda",
            true,
            vec![
                "CUDAExecutionProvider".into(),
                "CPUExecutionProvider".into(),
            ],
        ),
        Accelerator::CoreMl => (
            "coreml",
            true,
            vec![
                "CoreMLExecutionProvider".into(),
                "CPUExecutionProvider".into(),
            ],
        ),
        Accelerator::Rocm => (
            "rocm",
            true,
            vec![
                "ROCMExecutionProvider".into(),
                "CPUExecutionProvider".into(),
            ],
        ),
        Accelerator::OpenVino => (
            "openvino",
            true,
            vec![
                "OpenVINOExecutionProvider".into(),
                "CPUExecutionProvider".into(),
            ],
        ),
    }
}

/// `get_runtime_info` — the active EP + loaded-model snapshot the GPU/CPU chip and the active-model
/// reconciliation (`useSyncActiveModel`) read. Reads the loaded model from the TranscriptionManager
/// (falling back to the persisted `model.model` when nothing is loaded yet), and the EP from the
/// persisted device. The real per-session provider list is a compile-loop refinement (ort exposes it
/// at session-create); the device-derived list is correct for the shipped flavors.
#[tauri::command]
#[specta::specta]
pub fn get_runtime_info(
    app: AppHandle,
    transcription: State<'_, Arc<TranscriptionManager>>,
) -> RuntimeInfoPayload {
    runtime_info_snapshot(&app, transcription.inner().as_ref())
}

/// Build the active-EP + loaded-model snapshot. Shared by the `get_runtime_info` command and the
/// swap orchestration (which pushes a fresh `stt:runtime-info` after each completed swap). Prefers
/// the actually-loaded model; falls back to the persisted setting so the cold-boot chip shows the
/// user's chosen model before the engine finishes loading.
pub fn runtime_info_snapshot(
    app: &AppHandle,
    transcription: &TranscriptionManager,
) -> RuntimeInfoPayload {
    let accel = picker_accelerator(app);
    let (device, is_gpu, providers) = accel_runtime(accel);
    let settings = read_settings(app);
    let loaded = transcription.get_current_model();
    let model = loaded.or_else(|| {
        let m = settings.model.model.clone();
        if m.is_empty() {
            None
        } else {
            Some(m)
        }
    });
    let realtime_model = {
        let rt = settings.model.realtime_model.clone();
        if rt.is_empty() {
            None
        } else {
            Some(rt)
        }
    };
    RuntimeInfoPayload {
        device: device.to_string(),
        is_gpu,
        model,
        providers,
        realtime_model,
    }
}

/// `stt_list_models_with_state` — the `{ models, states, system_info }` payload `fetchModelsWithState`
/// consumes (model-state-store.ts). `states[*].cache_by_quantization` is keyed per precision and the
/// `effective_quantization` badge bridge tells the picker WHICH precision's cache state to trust.
///
/// Cache states are sourced from a REAL probe of the HuggingFace cache (the same cache the resolver
/// downloads into) overlaid with the DownloadManager's in-flight registry; system_info is the
/// live-resources snapshot reshaped to `SystemInfoEntry`. The effective-quant bridge keys the
/// overall badge off the precision the loader will ACTUALLY load, so "Downloaded" never lies into a
/// silent re-download.
///
/// Async (audit #7): this `await`s the HF cache scan via `DownloadManager::cache_snapshot_async`
/// rather than `block_on`-ing it on the command thread, so the whole-catalog cache walk (the Rust
/// re-incarnation of the documented Python `list_models_onnx_parse_loop_starvation` bug) no longer
/// blocks the IPC pump. The scan is memoized with a short TTL (invalidated on `model-cache-changed`)
/// so the picker's repeated calls reuse one walk, and the per-`.onnx` external-data verify was moved
/// off this list path (it runs lazily on load only). Async Tauri commands register identically in
/// `generate_handler!` — no `lib.rs` change is needed.
#[tauri::command]
#[specta::specta]
pub async fn stt_list_models_with_state(
    app: AppHandle,
    downloads: State<'_, Arc<DownloadManager>>,
) -> Result<ModelsWithState, ()> {
    let accel = picker_accelerator(&app);
    let cache_by_model = probe_cache_states(downloads.inner().as_ref()).await;
    let sys = system_info_snapshot();
    // Async Tauri commands MUST return `Result` (the framework requires `Result<T, E>` for the async
    // command shape with a borrowed `State<'_, _>`). `()` as the error type serializes to `null`;
    // we never return `Err` here so the renderer always receives the `Ok(ModelsWithState)` payload —
    // `TAURI_INVOKE` unwraps the `Ok` so the renderer-side type/value is unchanged.
    Ok(catalog_data::models_with_state(accel, sys, &cache_by_model))
}

/// Build the `ProbeModel` list from the catalog const table, `await` the DownloadManager's HF cache
/// probe (TTL-memoized), and reshape `(CacheState, downloaded, total)` → the renderer's
/// `ModelCacheInfo`.
pub(crate) async fn probe_cache_states(
    downloads: &DownloadManager,
) -> BTreeMap<String, BTreeMap<String, ModelCacheInfo>> {
    let probe_models: Vec<ProbeModel> = catalog::STT_CATALOG
        .iter()
        .map(|m| ProbeModel {
            id: m.id.to_string(),
            family: m.family.as_str().to_string(),
            onnx_name: m.onnx_model_name.to_string(),
            quantizations: m
                .available_quantizations
                .iter()
                .map(|q| q.to_string())
                .collect(),
        })
        .collect();

    let snapshot = downloads.cache_snapshot_async(&probe_models).await;
    let mut out: BTreeMap<String, BTreeMap<String, ModelCacheInfo>> = BTreeMap::new();
    for (model_id, by_quant) in snapshot {
        let mut quant_map: BTreeMap<String, ModelCacheInfo> = BTreeMap::new();
        for (quant, (state, downloaded, total)) in by_quant {
            quant_map.insert(quant, cache_info_from(state, downloaded, total));
        }
        out.insert(model_id, quant_map);
    }
    out
}

/// `(CacheState, downloaded, total)` → renderer `ModelCacheInfo`. `cached` reports progress 1.0;
/// `partial` reports the on-disk fraction; `not_cached` is zeroed.
fn cache_info_from(state: CacheState, downloaded: u64, total: u64) -> ModelCacheInfo {
    match state {
        CacheState::Cached => ModelCacheInfo {
            state: "cached".into(),
            downloaded_bytes: downloaded,
            total_bytes: total.max(downloaded),
            progress: 1.0,
        },
        CacheState::Partial => {
            let progress = if total > 0 {
                (downloaded as f64 / total as f64).min(0.999)
            } else {
                0.0
            };
            ModelCacheInfo {
                state: "partial".into(),
                downloaded_bytes: downloaded,
                total_bytes: total,
                progress,
            }
        }
        CacheState::NotCached => ModelCacheInfo {
            state: "not_cached".into(),
            downloaded_bytes: 0,
            total_bytes: 0,
            progress: 0.0,
        },
    }
}

/// Live system snapshot for the fitness fields. SPIKE: `sysinfo` for RAM + DXGI for VRAM. Zeros are
/// a valid "unknown" answer (the fit heuristics skip warnings when RAM/VRAM read 0).
pub(crate) fn system_info_snapshot() -> SystemInfoEntry {
    // Real total RAM via sysinfo (fixes the model-download dialog's "RAM: unknown") + real DXGI
    // GPU enumeration for `gpus` (powers the settings device picker + VRAM fitness). A zero/empty
    // result is a valid "unknown" the fit heuristics skip; a non-empty list makes the picker offer
    // the GPU/Auto option instead of lying "CPU only".
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let gpus = enumerate_gpus()
        .into_iter()
        .map(|g| catalog_data::SystemInfoGpu {
            name: g.name,
            total_vram_bytes: g.total_vram_bytes,
        })
        .collect();
    SystemInfoEntry {
        total_ram_bytes: sys.total_memory(), // bytes in sysinfo 0.30+
        gpus,
    }
}

/// Server-authoritative fit assessment — mirrors the renderer's `FitAssessmentEntry`. Returned as
/// `Option` because the renderer has a full client-side mirror and tolerates `None`
/// (`invokeOrDefault(..., null)`); the per-row badges render from the mirror regardless.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct FitAssessmentEntry {
    pub severity: String,
    pub target: String,
    pub required_bytes: u64,
    pub available_bytes: u64,
    pub reasons: Vec<String>,
}

/// `assess_dictation_fit` — best-effort server fit for `(model_id, quantization, device)`. Returns
/// `None` (client mirror covers it) until the real footprint+host math lands.
#[tauri::command]
#[specta::specta]
pub fn assess_dictation_fit(
    _app: AppHandle,
    model_id: String,
    quantization: Option<String>,
    device: Option<String>,
) -> Option<FitAssessmentEntry> {
    let _ = (model_id, quantization, device);
    None
}

/// `assess_ollama_fit` — best-effort server fit for an Ollama model of `size_bytes`. `None` until
/// the host snapshot is wired; the renderer's `assessOllamaFitClient` mirror covers the UI.
#[tauri::command]
#[specta::specta]
pub fn assess_ollama_fit(_app: AppHandle, size_bytes: u64) -> Option<FitAssessmentEntry> {
    let _ = size_bytes;
    None
}

/// One GPU as the renderer's `GpuInfo` rows expect. `gpu_get_info` powers the device-picker /
/// quality settings GPU chip. SPIKE: enumerate adapters via DXGI; empty list = "no GPU detected".
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
pub struct GpuInfoEntry {
    pub name: String,
    pub total_vram_bytes: u64,
}

/// `gpu_get_info` — the detected GPU list (drives the GPU chip + the "DirectML available?" hint).
/// Real DXGI adapter enumeration: a non-empty list means a DirectML-capable GPU exists, so the
/// settings device picker stops lying ("no GPU") and offers the Auto/GPU option, agreeing with the
/// main-window chip. Empty (true no-GPU box, or DXGI unavailable) → renderer shows "CPU only".
#[tauri::command]
#[specta::specta]
pub fn gpu_get_info(_app: AppHandle) -> Vec<GpuInfoEntry> {
    enumerate_gpus()
}

/// Enumerate physical GPU adapters via DXGI (skips the Microsoft Basic Render Driver / WARP
/// software adapter). The single shipped binary already registers the DirectML EP on Windows; this
/// just tells the UI (and VRAM fitness) whether a real GPU is present so the device choice is
/// correct out of the box. Empty on non-Windows or if the DXGI factory can't be created.
fn enumerate_gpus() -> Vec<GpuInfoEntry> {
    #[cfg(windows)]
    {
        use windows::Win32::Graphics::Dxgi::{
            CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
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
                // Skip the software/WARP adapter (Microsoft Basic Render Driver).
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
                // Optimus / virtual-display drivers (e.g. spacedesk) can surface ONE physical GPU
                // as two DXGI adapters. Dedupe by (name, vram) so the device picker lists one
                // entry per real GPU instead of "NVIDIA … ×2".
                if gpus.iter().any(|g: &GpuInfoEntry| {
                    g.name == name && g.total_vram_bytes == total_vram_bytes
                }) {
                    continue;
                }
                gpus.push(GpuInfoEntry {
                    name,
                    total_vram_bytes,
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

/// The largest detected GPU's total VRAM in bytes (0 if no GPU / non-Windows). The load-path
/// RAM/VRAM-aware auto-quant selector (`stt::fit_aware_auto_quant`) uses this to size the DirectML
/// budget. DXGI exposes only the static dedicated cap (not live free VRAM), which is the right
/// "can this model fit" upper bound for the auto choice.
pub(crate) fn detected_max_vram_bytes() -> u64 {
    enumerate_gpus()
        .iter()
        .map(|g| g.total_vram_bytes)
        .max()
        .unwrap_or(0)
}

/// Whether the persisted device intent is GPU (helper reused by the runtime chip + tests).
pub fn persisted_device_is_gpu(app: &AppHandle) -> bool {
    !matches!(
        crate::winstt::stt::resolve_accelerator(read_settings(app).model.device),
        crate::winstt::stt::Accelerator::Cpu
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accel_labels_match_renderer_chip() {
        let (d, gpu, providers) = accel_runtime(Accelerator::DirectMl);
        assert_eq!(d, "directml");
        assert!(gpu);
        assert!(providers.iter().any(|p| p == "DmlExecutionProvider"));

        let (d, gpu, _) = accel_runtime(Accelerator::Cpu);
        assert_eq!(d, "cpu");
        assert!(!gpu);
    }
}
