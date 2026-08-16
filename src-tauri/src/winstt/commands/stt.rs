// STT catalog + picker commands. These wrap the pure `winstt::catalog` policy
// tables (the 65-model catalog, quant/EP resolution, effective-quant badge) and
// surface them to the detached model-picker window. The actual model
// download/switch rides the existing model/transcription managers (the engine
// swap is internal to TranscriptionManager — lib_wiring §7); these commands only
// supply the catalog view + the effective-quantization bridge.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

use crate::command_auth;
use crate::winstt::catalog::{self, Accelerator as CatalogAccelerator};

use super::catalog_data::{self, CatalogModelInfo};
use super::settings::read_settings;
use super::tts_voice;

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
        crate::winstt::stt::Accelerator::WebGpu => CatalogAccelerator::WebGpu,
    }
}

/// `stt_list_models` — the full 65-model RICH catalog (editorial fields the picker renders:
/// backend / languages / description / size_label / per-quant byte sizes / accuracy+speed scores).
/// Backed by the embedded `catalog_data.json` (see `catalog_data.rs`); the per-device quant set is
/// CUDA-filtered. The adapter routes `STT_GET_MODEL_CATALOG` here, and the renderer's
/// `fetchModelCatalog` → `rawModelInfoSchema.safeParse` consumes these rows verbatim.
///
/// NOTE: the WITH_STATE channel needs the `{models,states,system_info}` OBJECT shape instead — that
/// is `stt_list_models_with_state` (commands/runtime.rs). The renderer calls each
/// generated binding directly.
#[tauri::command]
#[specta::specta]
pub fn stt_list_models(app: AppHandle) -> Vec<CatalogModelInfo> {
    let accel = picker_accelerator(&app);
    catalog_data::catalog_rows(accel)
}

/// The ONE refusal every containment failure below collapses to. A verbatim
/// `std::io::Error` would make this command an existence/permission oracle for
/// arbitrary absolute paths, so missing / unreadable / outside-the-folder must be
/// indistinguishable to the caller (same rationale as `tts_prepare_reference_clip`).
const REFERENCE_CLIP_DENIED: &str = "That file is not accessible to this window";

/// True when `path` resolves to a real entry strictly inside `root`. Both sides are
/// canonicalized, so the Windows `\\?\` verbatim prefix is symmetric and `..` or a
/// UNC path cannot escape; `starts_with` compares whole components, so a sibling
/// `reference-voices-evil` is not a match. Mirrors
/// `sound::canonical_existing_path_inside_dir`.
fn canonical_path_inside_dir(path: &Path, root: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let resolved = path.canonicalize().ok()?;
    resolved.starts_with(&root).then_some(resolved)
}

/// `tts_transcribe_reference` — transcribe a cloning reference clip with the currently-loaded STT
/// model, to auto-fill the reference transcript (editable afterwards) for cloning models that need
/// it (Spark). Decodes via the shared symphonia path (wav/mp3/flac/… → 16 kHz mono).
///
/// It does NOT re-validate the clip's length. The only path it accepts is the managed
/// `tts/reference-voices` folder, which nothing but `tts_prepare_reference_clip` writes into, and
/// that command already hard-trims every clip to the selected model's cap — it is the single
/// authority on that number. Re-measuring here compared two DIFFERENT measurements of the same
/// audio: a trimmed clip is stored at exactly `cap` seconds @ 24 kHz, and re-decoding it to 16 kHz
/// appends up to one frame of resampler zero-pad, so every trimmed clip measured ~`cap + 0.06 s`
/// and was refused with the self-contradictory "Reference clip is 30s — please use one under 30s.",
/// leaving Spark to clone with an empty transcript. The decode is bounded by TRUNCATING at the cap
/// instead, which can never refuse a clip the preparer just accepted.
#[tauri::command]
#[specta::specta]
pub fn tts_transcribe_reference(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    transcription: tauri::State<
        '_,
        std::sync::Arc<crate::managers::transcription::TranscriptionManager>,
    >,
    path: String,
) -> Result<String, String> {
    command_auth::authorize_webview(
        &webview,
        "tts",
        "transcribe a voice reference clip",
        tts_voice::TTS_VOICE_ALLOWED_WINDOWS,
        "",
    )?;

    // Confine to the managed clip folder `tts_prepare_reference_clip` writes into —
    // the only place the legitimate caller's `storedPath` can live, and it always
    // exists by the time we get here because that command created it. Resolve the
    // folder BEFORE touching the file, and never report which step failed: this
    // command returns the transcript itself, so an unconfined path would read out
    // the contents of any media the user can open.
    let root = crate::portable::app_data_dir(&app)
        .map_err(|_| REFERENCE_CLIP_DENIED.to_string())?
        .join("tts")
        .join("reference-voices");
    let Some(source) = canonical_path_inside_dir(Path::new(path.trim()), &root) else {
        log::warn!("[tts] blocked reference transcription outside the managed clip folder");
        return Err(REFERENCE_CLIP_DENIED.to_string());
    };

    // One second of headroom over the cap: the preparer stores a trimmed clip at
    // EXACTLY the cap, and this second resample appends a frame of zero-pad, so a
    // budget of exactly the cap would cut real audio off the end of every trimmed
    // clip. Truncating (never erroring) keeps the decode bounded for a clip that
    // somehow predates the cap without ever refusing to transcribe it.
    let budget = tts_voice::reference_clip_budget(&read_settings(&app)).saturating_add(1);
    let clip = crate::winstt::managers::transcode::decode_reference_clip(
        &source,
        crate::winstt::managers::transcode::TARGET_SAMPLE_RATE as u32,
        budget,
    )
    .map_err(|e| {
        log::debug!("[tts] reference decode failed: {e}");
        "That reference clip could not be decoded".to_string()
    })?;
    crate::winstt::tts::catalog::reject_short_reference(clip.seconds())?;
    transcription
        .transcribe(&clip.samples)
        .map_err(|e| format!("transcribe reference: {e}"))
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
    live_resources_snapshot()
}

/// Capture one current host-resource snapshot. Window-opening code reuses this
/// so the prewarmed model-footprint renderer receives the value it should paint
/// before its native window becomes visible.
pub(crate) fn live_resources_snapshot() -> LiveResources {
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
        use windows::Win32::Graphics::Dxgi::{
            CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIAdapter3, IDXGIFactory1,
        };
        use windows::core::Interface;

        let mut gpus = Vec::new();
        // SAFETY: DXGI factory and adapter interfaces are used synchronously on this thread and
        // every fallible COM call is checked before consuming returned data.
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
    // SAFETY: `adapter` is a valid IDXGIAdapter3 interface obtained from DXGI enumeration and
    // `info` is writable storage for the queried memory information.
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
/// Scan the directory for the family-shaped file set (encoder/decoder/...)
/// and add it as a `Family::Custom` catalog row; the resolver treats it like any
/// off-catalog repo. Returns the inferred catalog row on success.
#[tauri::command]
#[specta::specta]
pub fn set_custom_model(_app: AppHandle, path: String) -> Result<CatalogModelInfo, String> {
    // Detect family from the file layout (custom-model scanner port). Until
    // then, reject with a clear message so the UI surfaces "not yet supported".
    let _ = path;
    Err("custom model scanning not yet wired (scanner spike)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_transcription_authorization_matches_the_clip_preparer() {
        // Both halves of the cloning flow read the SAME list, so this pins that they
        // stay in step: whoever may prepare a reference clip may transcribe it, and
        // nobody else. The blocked labels are the low-privilege windows that would
        // otherwise get a read primitive over the managed clip folder.
        command_auth::assert_label_rules(
            &["settings", "model-picker"],
            &[
                "main",
                "overlay",
                "tray-menu",
                "tray-indicator",
                "history",
                "onboarding",
                "context-playground",
            ],
            |caller| command_auth::label_in(caller, tts_voice::TTS_VOICE_ALLOWED_WINDOWS),
        );
    }

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
