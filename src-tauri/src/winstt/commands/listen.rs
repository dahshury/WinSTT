// Reference: server/src/stt_server/control_handler.py
// `_handle_start_loopback`/`_handle_stop_loopback`.
// Wraps managers::{LoopbackManager, DiarizationManager}.
//
// Listen-mode commands. start_listen turns on WASAPI loopback capture (system
// audio → the same recording pipeline) and diarization; stop_listen turns both
// off. The diarized subtitles + speaker segments are emitted as events.
//
// IPC mapping (app/src/shared/api/native-bridge-adapter.ts):
//   IPC.LOOPBACK_START (`loopback:start`, payload `{ deviceIndex, modelId }`) → start_listen
//   IPC.LOOPBACK_STOP  (`loopback:stop`)                             → stop_listen
//
// The renderer never passes a `diarize` flag (the reference server reads the
// `speakerDiarization` setting server-side); so start_listen reads it from the
// persisted WinSTT settings (`general.speaker_diarization`), matching the
// the reference split-of-concerns exactly.
//
// EVENTS (plain string events, lib_wiring §4b — byte-identical to WinSTT's IPC so
// the reused renderer's `onLoopbackStarted`/`onLoopbackStopped` listeners in
// `features/listen-mode/api/use-listen-mode.ts` work unchanged):
//   `stt:loopback-started` { deviceName }   (onTyped → d.deviceName)
//   `stt:loopback-stopped` ()               (plain `on`)

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use crate::winstt::catalog;
use crate::winstt::commands::dictation::SttEvents;
use crate::winstt::commands::events::names;
use crate::winstt::commands::loopback::resolve_loopback_device;
use crate::winstt::commands::runtime::{probe_cache_states, system_info_snapshot};
use crate::winstt::commands::settings::read_settings;
use crate::winstt::commands::stt::picker_accelerator;
use crate::winstt::managers::{DiarizationManager, DownloadManager, LoopbackManager};
use crate::winstt::stt::cache_probe::engine_kind_for;

/// `start_listen` — begin loopback capture on `device_index` (the positional
/// ordinal from `loopback_list_devices`) and arm diarization when the persisted
/// `general.speaker_diarization` setting is on.
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
    diarization: State<'_, Arc<DiarizationManager>>,
    downloads: State<'_, Arc<DownloadManager>>,
    device_index: i32,
    model_id: String,
) -> Result<(), String> {
    let model_id =
        ensure_cached_native_streaming_model(&app, downloads.inner().as_ref(), model_id.trim())
            .await?;

    // Diarization follows the persisted setting (renderer doesn't pass a flag —
    // it mirrors the reference server which reads `speakerDiarization` itself).
    let diarize = read_settings(&app).general.speaker_diarization;
    diarization.set_enabled(diarize);
    diarization.reset();

    let selected_device = resolve_loopback_device(device_index)
        .ok_or_else(|| format!("loopback device index {device_index} is no longer available"))?;

    let started_device = loopback.start(Some(selected_device.id), model_id)?;
    let device_name = if started_device.name.trim().is_empty() {
        selected_device.name
    } else {
        started_device.name
    };

    SttEvents::recording_start(&app);
    let _ = app.emit(
        names::LOOPBACK_STARTED,
        serde_json::json!({ "deviceName": device_name }),
    );
    Ok(())
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

/// `stop_listen` — stop loopback capture + diarization. Emits
/// `stt:loopback-stopped` so the renderer clears the listen pill. Idempotent
/// (mirrors the reference server, which only emits when capture was active — but
/// the renderer's `setListening(false)` is itself idempotent, so an extra emit on
/// an already-stopped session is harmless).
#[tauri::command]
#[specta::specta]
pub fn stop_listen(
    app: AppHandle,
    loopback: State<'_, Arc<LoopbackManager>>,
    diarization: State<'_, Arc<DiarizationManager>>,
) {
    let was_capturing = loopback.is_capturing();
    loopback.stop();
    diarization.set_enabled(false);
    if was_capturing {
        SttEvents::vad_stop(&app);
        SttEvents::recording_stop(&app);
    }
    let _ = app.emit(names::LOOPBACK_STOPPED, serde_json::Value::Null);
}
