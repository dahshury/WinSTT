// Reference: server/src/stt_server/control_handler.py
// `_handle_start_loopback`/`_handle_stop_loopback`.
// Wraps managers::LoopbackManager.
//
// Listen-mode commands. start_listen turns on WASAPI loopback capture (system
// audio → the same recording pipeline); stop_listen turns it off.
//
// Generated renderer command mapping:
//   startListen({ deviceIndex, modelId }) → start_listen
//   stopListen() → stop_listen
//
// EVENTS (plain string events, lib_wiring §4b — byte-identical to WinSTT's IPC so
// the reused renderer's `onLoopbackStarted`/`onLoopbackStopped` listeners in
// `features/listen-mode/api/use-listen-mode.ts` work unchanged):
//   `stt:loopback-started` { deviceName }   (onTyped → d.deviceName)
//   `stt:loopback-stopped` ()               (plain `on`)

use std::sync::Arc;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::winstt::catalog;
use crate::winstt::commands::dictation::SttEvents;
use crate::winstt::commands::events::names;
use crate::winstt::commands::loopback::resolve_loopback_device;
use crate::winstt::commands::runtime::{probe_cache_states, system_info_snapshot};
use crate::winstt::commands::stt::picker_accelerator;
use crate::winstt::managers::{DownloadManager, LoopbackManager};
use crate::winstt::stt::cache_probe::engine_kind_for;

/// `start_listen` — begin loopback capture on `device_index` (the positional
/// ordinal from `loopback_list_devices`).
///
/// Emits `stt:loopback-started { deviceName }` on success so the renderer's
/// `useListenMode` shows the active device name in the listen pill. The native
/// WASAPI loop is a compile-loop spike (see `LoopbackManager::start`); the
/// command owns the device-name resolution + the started event.
#[tauri::command]
#[specta::specta]
pub async fn start_listen(
    app: AppHandle,
    loopback: State<'_, Arc<LoopbackManager>>,
    downloads: State<'_, Arc<DownloadManager>>,
    device_index: i32,
    model_id: String,
    capture_microphone: bool,
) -> Result<(), String> {
    if crate::winstt::commands::onboarding::is_onboarding_active() {
        return Err("Onboarding is active; listen mode is disabled".to_string());
    }

    let model_id =
        ensure_cached_native_streaming_model(&app, downloads.inner().as_ref(), model_id.trim())
            .await?;

    let selected_device = resolve_loopback_device(device_index)
        .ok_or_else(|| format!("loopback device index {device_index} is no longer available"))?;

    let loopback_manager = loopback.inner().clone();
    let selected_device_id = selected_device.id.clone();
    let model_id_for_start = model_id;
    let started_device = tauri::async_runtime::spawn_blocking(move || {
        loopback_manager.start(
            Some(selected_device_id),
            model_id_for_start,
            capture_microphone,
        )
    })
    .await
    .map_err(|e| format!("failed to start listen mode worker: {e}"))??;
    let device_name = if started_device.name.trim().is_empty() {
        selected_device.name
    } else {
        started_device.name
    };

    set_main_window_listen_mode(&app, true);
    SttEvents::recording_start(&app);
    let _ = app.emit(
        names::LOOPBACK_STARTED,
        serde_json::json!({ "deviceName": device_name }),
    );
    Ok(())
}

fn set_main_window_listen_mode(app: &AppHandle, enabled: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(err) = window.set_always_on_top(enabled) {
        log::warn!("[listen] failed to set main window always-on-top={enabled}: {err}");
    }
    if enabled {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

async fn ensure_cached_native_streaming_model(
    app: &AppHandle,
    downloads: &DownloadManager,
    model_id: &str,
) -> Result<String, String> {
    if model_id.is_empty() {
        return Err("Listen mode requires a downloaded realtime STT model.".to_string());
    }

    let canonical = catalog::canonical_model_id(model_id);
    let entry = catalog::find(canonical)
        .ok_or_else(|| format!("'{model_id}' is not a local WinSTT model"))?;
    let kind = engine_kind_for(entry.id, entry.family.as_str(), entry.onnx_model_name);
    if !kind.supports_native_streaming() {
        return Err(format!(
            "'{}' is not a native-streaming realtime model",
            entry.display_name
        ));
    }

    let cache_by_model = probe_cache_states(downloads).await;
    let state = super::catalog_data::models_with_state(
        picker_accelerator(app),
        system_info_snapshot(),
        &cache_by_model,
    )
    .states
    .into_iter()
    .find(|s| s.id == canonical)
    .ok_or_else(|| format!("No cache state was available for '{canonical}'"))?;

    if state.cache.state != "cached" {
        return Err(format!(
            "Listen mode requires '{}' to be downloaded before it can start",
            entry.display_name
        ));
    }

    Ok(canonical.to_string())
}

/// `stop_listen` — stop loopback capture. Emits
/// `stt:loopback-stopped` so the renderer clears the listen pill. Idempotent
/// (mirrors the reference server, which only emits when capture was active — but
/// the renderer's `setListening(false)` is itself idempotent, so an extra emit on
/// an already-stopped session is harmless).
#[tauri::command]
#[specta::specta]
pub fn stop_listen(app: AppHandle, loopback: State<'_, Arc<LoopbackManager>>) {
    stop_listen_runtime(&app, loopback.inner().as_ref());
}

/// Live transcript state of the CURRENT listen session for the History tab's
/// live session card: committed caption lines plus the in-flight preview.
/// `active` is false when no session is running (the card hides).
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ListenSessionSnapshot {
    pub active: bool,
    pub lines: Vec<String>,
    pub live_preview: String,
}

/// `listen_session_snapshot` — poll surface for the History tab's live
/// session card (small clone; no events to subscribe to cross-window).
#[tauri::command]
#[specta::specta]
pub fn listen_session_snapshot(
    loopback: State<'_, Arc<LoopbackManager>>,
) -> ListenSessionSnapshot {
    let (active, lines, live_preview) = loopback.session_snapshot();
    ListenSessionSnapshot {
        active,
        lines,
        live_preview,
    }
}

/// `finalize_listen_session` — cut the session-so-far into its own history
/// row WITHOUT stopping the session (no silence or mode switch needed); the
/// running session continues accumulating from empty. Returns whether a row
/// was saved (false when idle or nothing committed yet). The row lands via
/// the standard history `Added` event, so every history surface refreshes.
#[tauri::command]
#[specta::specta]
pub async fn finalize_listen_session(
    loopback: State<'_, Arc<LoopbackManager>>,
) -> Result<bool, String> {
    let loopback = loopback.inner().clone();
    // SQLite write + event emit — hop off the async pump.
    tauri::async_runtime::spawn_blocking(move || loopback.finalize_session())
        .await
        .map_err(|e| format!("finalize task panicked: {e}"))
}

pub(crate) fn stop_listen_runtime(app: &AppHandle, loopback: &LoopbackManager) {
    let was_capturing = loopback.is_capturing();
    loopback.stop();
    set_main_window_listen_mode(app, false);
    if was_capturing {
        SttEvents::vad_stop(app);
        SttEvents::recording_stop(app);
    }
    let _ = app.emit(names::LOOPBACK_STOPPED, serde_json::Value::Null);
}
