// PORT IMPL — WU-3 (app/PORT/10_frontend_port_plan.md §6 "Main window …" — the
// hotkey-capture events). Source: frontend/electron/ipc/hotkey.ts + the renderer
// wrappers in src/shared/api/ipc-client.ts (hotkeyRegister / hotkeyUnregister /
// hotkeyStartRecording / hotkeyStopRecording / onHotkeyPressed / onHotkeyReleased /
// onHotkeyRecordingUpdate / onHotkeyRecordingDone) consumed by
// features/push-to-talk (usePushToTalk) + features/record-hotkey (useKeyRecorder).
//
// TWO distinct hotkey flows the renderer owns (the recorder is driven from the
// renderer via set_microphone, NOT by a backend action binding — that is the WU-3
// fork from Handy's model):
//
//  1. LIVE PTT/TOGGLE hotkey (push-to-talk slice):
//       hotkeyRegister(accelerator)   → register the passive global hotkey
//       hotkeyUnregister(accelerator) → drop it
//     When the registered accelerator is pressed/released the backend emits the
//     PLAIN events `hotkey:pressed` / `hotkey:released` (no payload). The renderer's
//     usePushToTalk then issues `set_microphone(true/false)` (winstt_call_method).
//
//  2. KEY-COMBO CAPTURE (record-hotkey slice — rebinding a hotkey in settings):
//       hotkeyStartRecording() → begin capturing the next combo; stream live keys
//                                via `hotkey:recording-update` { keys: string[] }
//       hotkeyStopRecording()  → finish; emit `hotkey:recording-done` { combo|null }
//     Wraps Handy's existing key-recording listener (shortcut::handy_keys), which
//     already emits a per-key `handy-keys-event`; the WinSTT-shape translation
//     (accumulate held keys → `keys`/`combo`) is wired by the Handy-side bridge
//     documented in libWiring (one small listener; see HotkeyEvents below).
//
// Event NAMES match the adapter ROUTE map (electron-tauri-adapter.ts):
//   HOTKEY_PRESSED          → "hotkey:pressed"
//   HOTKEY_RELEASED         → "hotkey:released"
//   HOTKEY_RECORDING_UPDATE → "hotkey:recording-update"
//   HOTKEY_RECORDING_DONE   → "hotkey:recording-done"
// All four are PLAIN string events (not specta-collected) so the reused renderer's
// listeners are byte-compatible (lib_wiring.md §4b).

use tauri::{AppHandle, Emitter};

/// The transcribe binding the PTT/toggle hotkey drives. The renderer registers an
/// accelerator string against THIS binding so the press/release of that accelerator
/// fires `hotkey:pressed`/`hotkey:released` (instead of Handy directly invoking the
/// TranscribeAction). Keeping the id stable means a single binding row is rebound.
const PTT_BINDING: &str = "transcribe";

/// `hotkey_register` — point the PTT/toggle binding at `accelerator` so its press/
/// release fires the WinSTT hotkey events. WinSTT sends the accelerator as a WinSTT
/// key string; `change_binding` validates + (un)registers it for the active keyboard
/// implementation. An empty accelerator is treated as "unbound" (no-op success) so
/// the renderer's cold-boot register-then-rebind sequence can't error.
///
/// Returns whether the accelerator is now active (the renderer's `hotkeyRegister`
/// wrapper reads a `boolean`, defaulting to `false`).
#[tauri::command]
#[specta::specta]
pub fn hotkey_register(app: AppHandle, accelerator: String) -> bool {
    let accel = accelerator.trim();
    if accel.is_empty() {
        return false;
    }
    // `change_binding` returns a BindingResponse whose `success` field is private;
    // read it back through serde (the struct derives Serialize). An Err (validation
    // failure) is `false`.
    match crate::shortcut::change_binding(app, PTT_BINDING.to_string(), accel.to_string()) {
        Ok(resp) => serde_json::to_value(&resp)
            .ok()
            .and_then(|v| v.get("success").and_then(|s| s.as_bool()))
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// `hotkey_unregister` — drop the PTT/toggle binding's live registration. The
/// renderer calls this on accelerator change (before re-registering the new one)
/// and on unmount. Resolving the binding from settings and unregistering it is
/// idempotent; a missing binding is a silent success.
#[tauri::command]
#[specta::specta]
pub fn hotkey_unregister(app: AppHandle, accelerator: String) {
    let _ = accelerator; // WinSTT keys by accelerator; Handy keys by binding id.
    let binding = crate::settings::get_stored_binding(&app, PTT_BINDING);
    let _ = crate::shortcut::unregister_shortcut(&app, binding);
}

/// `hotkey_start_recording` — begin capturing the next key combo for a rebind. Wraps
/// Handy's key-recording listener; the per-key `handy-keys-event` stream is folded
/// into WinSTT's `hotkey:recording-update` { keys } by the translation bridge
/// (libWiring). Returns whether capture started (`hotkeyStartRecording` reads a bool).
#[tauri::command]
#[specta::specta]
pub fn hotkey_start_recording(app: AppHandle) -> bool {
    // The binding id under capture is irrelevant to the WinSTT combo-capture UI
    // (the renderer picks the target field); use the PTT binding as the carrier.
    crate::shortcut::handy_keys::start_handy_keys_recording(app, PTT_BINDING.to_string()).is_ok()
}

/// `hotkey_stop_recording` — finish combo capture. On stop the translation bridge
/// emits `hotkey:recording-done` { combo } with the captured combo (or `null` if no
/// keys were captured), matching WinSTT's cancel semantics.
#[tauri::command]
#[specta::specta]
pub fn hotkey_stop_recording(app: AppHandle) {
    let _ = crate::shortcut::handy_keys::stop_handy_keys_recording(app);
}

/// Typed emit façade for the four hotkey events. The CALL SITES live in Handy-owned
/// files: `hotkey:pressed`/`released` from the passive PTT shortcut handler (when
/// the PTT binding's accelerator is pressed/released — instead of running the
/// TranscribeAction), and `hotkey:recording-update`/`done` from the key-recording
/// loop translation (folding `handy-keys-event` into the WinSTT shapes). Centralized
/// here so those wiring edits are one-liners and the event shapes can't drift.
pub struct HotkeyEvents;

impl HotkeyEvents {
    /// `hotkey:pressed` — the PTT/toggle accelerator went down (no payload). The
    /// renderer's usePushToTalk decides set_microphone from the recording mode.
    pub fn pressed(app: &AppHandle) {
        let _ = app.emit("hotkey:pressed", ());
    }

    /// `hotkey:released` — the PTT/toggle accelerator came up (no payload). PTT mode
    /// releases the mic; toggle/listen/wakeword ignore it.
    pub fn released(app: &AppHandle) {
        let _ = app.emit("hotkey:released", ());
    }

    /// `hotkey:recording-update` — live snapshot of the currently-held keys during a
    /// combo capture. `onHotkeyRecordingUpdate` reads `.keys`. Keys are the WinSTT
    /// display names (lowercase, e.g. `["ctrl","shift","v"]`).
    pub fn recording_update(app: &AppHandle, keys: &[String]) {
        let _ = app.emit("hotkey:recording-update", serde_json::json!({ "keys": keys }));
    }

    /// `hotkey:recording-done` — capture finished. `combo` is the `+`-joined combo
    /// (e.g. `"ctrl+shift+v"`) or `null` when nothing was captured / cancelled.
    /// `onHotkeyRecordingDone` reads `.combo`.
    pub fn recording_done(app: &AppHandle, combo: Option<&str>) {
        let _ = app.emit("hotkey:recording-done", serde_json::json!({ "combo": combo }));
    }
}
