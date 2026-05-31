// PORT IMPL — WU-4 (app/PORT/10_frontend_port_plan.md §6 WU-4). Source:
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
// IPC mapping (app/src/shared/api/electron-tauri-adapter.ts ROUTE):
//   IPC.STT_GET_RUNTIME_INFO        (`stt:get-runtime-info`)                         → get_runtime_info
//   IPC.STT_LIST_MODELS_WITH_STATE  (`stt:list-models-with-state`)                   → list_models_with_state  (⚠ adapter ROUTE fix)
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
use crate::winstt::catalog::Accelerator;
use crate::winstt::settings_schema::DeviceType;

use super::catalog_data::{self, ModelsWithState, SystemInfoEntry, ModelCacheInfo};
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
            vec!["CUDAExecutionProvider".into(), "CPUExecutionProvider".into()],
        ),
        Accelerator::CoreMl => (
            "coreml",
            true,
            vec!["CoreMLExecutionProvider".into(), "CPUExecutionProvider".into()],
        ),
        Accelerator::Rocm => (
            "rocm",
            true,
            vec!["ROCMExecutionProvider".into(), "CPUExecutionProvider".into()],
        ),
        Accelerator::OpenVino => (
            "openvino",
            true,
            vec!["OpenVINOExecutionProvider".into(), "CPUExecutionProvider".into()],
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
    let accel = picker_accelerator(&app);
    let (device, is_gpu, providers) = accel_runtime(accel);
    let settings = read_settings(&app);
    // Prefer the actually-loaded model; fall back to the persisted setting so the cold-boot chip
    // shows the user's chosen model before the engine finishes loading.
    let loaded = transcription.get_current_model();
    let model = loaded.or_else(|| {
        let m = settings.model.model.clone();
        if m.is_empty() { None } else { Some(m) }
    });
    RuntimeInfoPayload {
        device: device.to_string(),
        is_gpu,
        model,
        providers,
        // Realtime model load is tracked separately (WU-3); not surfaced here yet.
        realtime_model: None,
    }
}

/// `list_models_with_state` — the `{ models, states, system_info }` payload `fetchModelsWithState`
/// consumes (model-state-store.ts). `states[*].cache_by_quantization` is keyed per precision and the
/// `effective_quantization` badge bridge tells the picker WHICH precision's cache state to trust.
///
/// Cache states are sourced from the embedded catalog + (when wired) the DownloadManager's live
/// snapshots; system_info is the live-resources snapshot reshaped to `SystemInfoEntry`. Until the HF
/// cache probe lands, every precision reads `not_cached` (the picker shows "Not downloaded", which is
/// honest — never the "Downloaded then silently re-download" lie the effective-quant bridge prevents).
#[tauri::command]
#[specta::specta]
pub fn list_models_with_state(app: AppHandle) -> ModelsWithState {
    let accel = picker_accelerator(&app);
    // SPIKE: probe the HF cache per (model, quant) and fill `cache_by_model`. The engine slice's
    // resolver (winstt::stt::resolver) owns the cache-path resolution; the DownloadManager keeps a
    // live overlay for in-flight downloads. Empty map → all not_cached.
    let cache_by_model: BTreeMap<String, BTreeMap<String, ModelCacheInfo>> = BTreeMap::new();
    let sys = system_info_snapshot();
    catalog_data::models_with_state(accel, sys, &cache_by_model)
}

/// Live system snapshot for the fitness fields. SPIKE: `sysinfo` for RAM + DXGI for VRAM. Zeros are
/// a valid "unknown" answer (the fit heuristics skip warnings when RAM/VRAM read 0).
fn system_info_snapshot() -> SystemInfoEntry {
    SystemInfoEntry::default()
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
/// SPIKE: DXGI adapter enumeration. Empty until then (renderer shows "CPU only", which is safe).
#[tauri::command]
#[specta::specta]
pub fn gpu_get_info(app: AppHandle) -> Vec<GpuInfoEntry> {
    // Device intent is known from settings even before VRAM enumeration lands.
    let _ = read_settings(&app).model.device;
    Vec::new()
}

/// Whether the persisted device intent is GPU (helper reused by the runtime chip + tests).
pub fn persisted_device_is_gpu(app: &AppHandle) -> bool {
    !matches!(read_settings(app).model.device, DeviceType::Cpu)
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
