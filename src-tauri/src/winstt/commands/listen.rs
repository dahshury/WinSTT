// Source: docs/archive/port/05_*.md (Loopback/Diarization)
// + docs/archive/port/10_frontend_port_plan.md (WU-9) + lib_wiring.md §3/§4b,
// server/src/stt_server/control_handler.py `_handle_start_loopback`/`_handle_stop_loopback`.
// Wraps managers::{LoopbackManager, DiarizationManager}.
//
// Listen-mode commands. start_listen turns on WASAPI loopback capture (system
// audio → the same recording pipeline) and diarization; stop_listen turns both
// off. The diarized subtitles + speaker segments are emitted as events.
//
// IPC mapping (app/src/shared/api/native-bridge-adapter.ts):
//   IPC.LOOPBACK_START (`loopback:start`, payload `{ deviceIndex }`) → start_listen
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

use crate::winstt::commands::loopback::resolve_loopback_device_name;
use crate::winstt::commands::settings::read_settings;
use crate::winstt::managers::{DiarizationManager, LoopbackManager};

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
pub fn start_listen(
    app: AppHandle,
    loopback: State<'_, Arc<LoopbackManager>>,
    diarization: State<'_, Arc<DiarizationManager>>,
    device_index: i32,
) -> Result<(), String> {
    // Diarization follows the persisted setting (renderer doesn't pass a flag —
    // it mirrors the reference server which reads `speakerDiarization` itself).
    let diarize = read_settings(&app).general.speaker_diarization;
    diarization.set_enabled(diarize);
    diarization.reset();

    // Resolve the device name BEFORE starting so a stale index degrades to a
    // blank label (the renderer tolerates `""`) instead of failing the start.
    let device_name = resolve_loopback_device_name(device_index).unwrap_or_default();

    loopback.start()?;

    let _ = app.emit(
        "stt:loopback-started",
        serde_json::json!({ "deviceName": device_name }),
    );
    Ok(())
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
    loopback.stop();
    diarization.set_enabled(false);
    let _ = app.emit("stt:loopback-stopped", serde_json::Value::Null);
}
