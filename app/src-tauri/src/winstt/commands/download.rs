// PORT IMPL — WU-4 (app/PORT/10_frontend_port_plan.md §6 WU-4). Source:
//   frontend/src/shared/api/ipc-client.ts (predownloadModelQuant / pauseModelDownload /
//     resumeModelDownload / cancelModelDownloadQuant / deleteModelQuantization /
//     deleteModelCache / cancelDownload — the exact arg shapes)
//   + frontend/electron/ipc/stt-models.ts (the channel handlers these mapped to).
//
// The per-quant download command surface. Each command pulls the `DownloadManager` from Tauri
// state and forwards the call. The manager owns the keyed in-flight registry + the four
// `stt:model-download-*` / `stt:model-cache-changed` broadcasts (download_manager.rs).
//
// IPC mapping (app/src/shared/api/electron-tauri-adapter.ts ROUTE):
//   IPC.STT_PREDOWNLOAD_QUANT       (`stt:predownload-quant`,        { modelId, quantization }) → predownload_quant
//   IPC.STT_DOWNLOAD_PAUSE          (`stt:download-pause`,           { modelId, quantization }) → download_pause_quant
//   IPC.STT_DOWNLOAD_RESUME         (`stt:download-resume`,          { modelId, quantization }) → download_resume_quant
//   IPC.STT_DOWNLOAD_CANCEL_QUANT   (`stt:download-cancel-quant`,    { modelId, quantization }) → download_cancel_quant
//   IPC.STT_DELETE_MODEL_QUANTIZATION (`stt:delete-model-quantization`, { modelId, quantization }) → delete_model_quantization
//   IPC.STT_DELETE_MODEL_CACHE      (`stt:delete-model-cache`,       positional modelId)        → delete_model_cache
//   IPC.STT_CANCEL_DOWNLOAD         (`stt:cancel-download`)                                      → cancel_download
//
// NOTE on arg shape: every `{ modelId, quantization }` channel deserializes into the camelCase
// Tauri params (`model_id`, `quantization`). `STT_DELETE_MODEL_CACHE` is the lone positional-string
// channel — the adapter's `POSITIONAL_STRING_PARAM` map wraps it as `{ modelId }`.

use std::sync::Arc;

use tauri::State;

use crate::winstt::managers::DownloadManager;

/// `predownload_quant` — start a byte-level pause/resume capable download for one
/// `(model_id, quantization)` tuple, INTO the HF cache without changing the loaded model.
/// Emits `stt:model-download-start` immediately so the badge flips to "downloading".
#[tauri::command]
#[specta::specta]
pub fn predownload_quant(
    downloads: State<'_, Arc<DownloadManager>>,
    model_id: String,
    quantization: String,
) {
    downloads.predownload_quant(model_id, quantization);
}

/// `download_pause_quant` — pause the in-flight per-quant download (.partial preserved on disk for
/// the next Range-resume). The renderer flips the badge optimistically; this confirms it.
#[tauri::command]
#[specta::specta]
pub fn download_pause_quant(
    downloads: State<'_, Arc<DownloadManager>>,
    model_id: String,
    quantization: String,
) {
    downloads.pause_quant(&model_id, &quantization);
}

/// `download_resume_quant` — resume a paused per-quant download (skips already-cached files).
#[tauri::command]
#[specta::specta]
pub fn download_resume_quant(
    downloads: State<'_, Arc<DownloadManager>>,
    model_id: String,
    quantization: String,
) {
    downloads.resume_quant(model_id, quantization);
}

/// `download_cancel_quant` — cancel an in-flight per-quant download; the current file's `.partial`
/// is unlinked, previously-completed files are kept (delete_model_quantization wipes those too).
#[tauri::command]
#[specta::specta]
pub fn download_cancel_quant(
    downloads: State<'_, Arc<DownloadManager>>,
    model_id: String,
    quantization: String,
) {
    downloads.cancel_quant(&model_id, &quantization);
}

/// `delete_model_quantization` — drop just the weight files matching `quantization` from the HF
/// cache of `model_id` (other quants intact). Re-broadcasts `stt:model-cache-changed`.
#[tauri::command]
#[specta::specta]
pub fn delete_model_quantization(
    downloads: State<'_, Arc<DownloadManager>>,
    model_id: String,
    quantization: String,
) {
    downloads.delete_quantization(&model_id, &quantization);
}

/// `delete_model_cache` — wipe the entire HF snapshot directory for `model_id`. Positional-string
/// channel (`POSITIONAL_STRING_PARAM` → `{ modelId }`). Re-broadcasts cache-changed.
#[tauri::command]
#[specta::specta]
pub fn delete_model_cache(downloads: State<'_, Arc<DownloadManager>>, model_id: String) {
    downloads.delete_model_cache(&model_id);
}

/// `cancel_download` — cancel the legacy single-slot whole-model swap-download (no quantization).
/// The renderer's `cancelDownload()` sends NO args (matches the param-less signature). This is the
/// command the adapter's `STT_CANCEL_DOWNLOAD` channel must route to; lib.rs currently registers
/// Handy's `commands::models::cancel_download` (which needs a `model_id` and would reject the
/// arg-less call) — see the lib-wiring report to repoint it here. Renamed `winstt_cancel_download`
/// to avoid the duplicate-command-name clash with Handy's during registration.
#[tauri::command]
#[specta::specta]
pub fn winstt_cancel_download(downloads: State<'_, Arc<DownloadManager>>) {
    downloads.cancel_download();
}
