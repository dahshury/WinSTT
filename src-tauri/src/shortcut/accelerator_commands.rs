//! Whisper / ORT accelerator + GPU-device Tauri commands and accelerator
//! availability, plus the local [`apply_and_reload_accelerator`] helper (write
//! settings, re-apply globals, unload the model so it reloads with the new
//! backend on next transcription).

use tauri::{AppHandle, Manager};

use crate::settings;

/// Save accelerator settings, re-apply globals, and unload the model so it
/// reloads with the new backend on next transcription.
fn apply_and_reload_accelerator(app: &AppHandle, s: settings::AppSettings) {
    settings::write_settings(app, s);
    crate::managers::transcription::apply_accelerator_settings(app);

    let tm = app.state::<std::sync::Arc<crate::managers::transcription::TranscriptionManager>>();
    if tm.is_model_loaded() {
        if let Err(e) = tm.unload_model() {
            log::warn!("Failed to unload model after accelerator change: {e}");
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn change_whisper_gpu_device(app: AppHandle, device: i32) -> Result<(), String> {
    let mut s = settings::get_settings(&app);
    s.whisper_gpu_device = device;
    apply_and_reload_accelerator(&app, s);
    Ok(())
}

/// Return which accelerators are compiled into this build.
///
/// Returns static, compile-time capability lists — no hardware probe, and
/// `gpu_devices` is always empty — so it is cheap; it stays on the blocking
/// pool only to keep the Tauri command async.
#[tauri::command]
#[specta::specta]
pub async fn get_available_accelerators(
) -> Result<crate::managers::transcription::AvailableAccelerators, String> {
    tauri::async_runtime::spawn_blocking(crate::managers::transcription::get_available_accelerators)
        .await
        .map_err(|err| format!("get_available_accelerators worker failed: {err}"))
}
