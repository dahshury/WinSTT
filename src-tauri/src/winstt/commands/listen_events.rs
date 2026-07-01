// PLAIN-event emit helpers for the WinSTT listen channels. These are
// deliberately PLAIN `app.emit(name, json)` (lib_wiring §4b) rather than
// specta-typed `collect_events!` payloads so the reused renderer's listeners
// consume FIXED camelCase shapes via `onCast`/`onTyped` extractors in
// `shared/api/ipc-client.ts` unchanged.
//
// CALL SITE (this helper is the seam, not the trigger):
//   * `emit_device_switch_failed` — call from `managers/audio.rs`'s selected-index
//     fallback when the user's `input_device_index` can't be resolved to a live
//     cpal device. Renderer: `onDeviceSwitchFailed` reverts the UI selection to
//     `fallbackIndex` (null → "System default"), persists it immediately, refreshes
//     the device list, and surfaces a translated toast.
//
// REMOVED (dead end-to-end): the cross-utterance adaptive `vad_sensitivity_adapted`
// path. Its backend `VadCalibrator` was implemented + tested but never instantiated
// or driven by the recorder, and there is no live-VAD sensitivity setter to drive,
// so the whole module + the renderer listener + the `stt:vad-sensitivity-adapted`
// route were deleted. Per-device sensitivity seeding on device switch survives
// renderer-side (`useVadCalibration`).

use tauri::{AppHandle, Emitter};

/// `stt:device-switch-failed` { requestedIndex, errorMessage, fallbackIndex }.
///
/// Emitted when a selected `input_device_index` can't be resolved to a live cpal
/// device and the recorder falls back to the OS default input. The renderer's
/// `onDeviceSwitchFailed` reverts the UI selection to `fallback_index`, persists it
/// immediately (bypassing the settings debounce), refreshes the device list, and
/// surfaces a translated toast.
///
/// `fallback_index` is `None` (→ renderer "System default") at the only producer:
/// the fallback re-resolves the OS default on every stream open rather than pinning
/// a concrete index, so reporting null keeps the persisted selection honest as
/// auto-route. The parameter stays generic so a future concrete-index producer can
/// report one without touching the renderer contract.
pub fn emit_device_switch_failed(
    app: &AppHandle,
    requested_index: i64,
    error_message: &str,
    fallback_index: Option<i64>,
) {
    let _ = app.emit(
        "stt:device-switch-failed",
        serde_json::json!({
            "requestedIndex": requested_index,
            "errorMessage": error_message,
            "fallbackIndex": fallback_index,
        }),
    );
}
