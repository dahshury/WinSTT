// PORT IMPL — WU-3 hotkey (app/PORT/10_frontend_port_plan.md §6). Source:
// frontend/electron/ipc/hotkey.ts + the renderer wrappers in
// src/shared/api/ipc-client.ts (hotkeyRegister / hotkeyUnregister /
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
//     ── CRITICAL fork ── the transcribe binding does NOT run Handy's coordinator
//     directly; `handle_shortcut_event` calls `dispatch_transcribe_hotkey` here so
//     the press/release becomes WinSTT events. The renderer (which knows the
//     recording MODE: ptt/toggle/listen/wakeword) is the authority over whether a
//     press starts/stops the mic. See libOther for the one-line handler.rs edit.
//
//  2. KEY-COMBO CAPTURE (record-hotkey slice — rebinding a hotkey in settings):
//       hotkeyStartRecording() → begin capturing the next combo; stream live keys
//                                via `hotkey:recording-update` { keys: string[] }
//       hotkeyStopRecording()  → finish; emit `hotkey:recording-done` { combo|null }
//     Wraps Handy's key-recording listener (shortcut::handy_keys), which emits a
//     per-key `handy-keys-event`. The CaptureBridge below folds those into WinSTT's
//     accumulated `{keys}`/`{combo}` shape (peak-held set, WinSTT key names, Escape
//     cancels) so the reused renderer's useKeyRecorder works byte-for-byte.
//
// Event NAMES match the adapter ROUTE map (electron-tauri-adapter.ts):
//   HOTKEY_PRESSED          → "hotkey:pressed"
//   HOTKEY_RELEASED         → "hotkey:released"
//   HOTKEY_RECORDING_UPDATE → "hotkey:recording-update"
//   HOTKEY_RECORDING_DONE   → "hotkey:recording-done"
// All four are PLAIN string events (not specta-collected) so the reused renderer's
// listeners are byte-compatible (lib_wiring.md §4b).

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Listener, Manager};

/// The transcribe binding the PTT/toggle hotkey drives. The renderer registers an
/// accelerator string against THIS binding so the press/release of that accelerator
/// fires `hotkey:pressed`/`hotkey:released` (instead of Handy directly invoking the
/// TranscribeAction). Keeping the id stable means a single binding row is rebound.
const PTT_BINDING: &str = "transcribe";

/// `hotkey_register` — point the PTT/toggle binding at `accelerator` so its press/
/// release fires the WinSTT hotkey events. WinSTT sends the accelerator as a WinSTT
/// key string (e.g. `LCtrl+LMeta`). handy-keys' parser does NOT accept every WinSTT
/// name (above all `LMeta`/`RMeta` — see `winstt_accel_to_handy`), so the translation
/// to handy's token vocabulary happens inside `change_binding`, which then validates
/// + (un)registers it. An empty accelerator is treated as "unbound" (no-op success)
/// so the renderer's cold-boot register-then-rebind sequence can't error.
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

// ── 1. PTT/TOGGLE press-dispatch (the handle_shortcut_event fork) ───────────────

/// Dispatch a transcribe-binding press/release as the WinSTT hotkey events the
/// renderer's `usePushToTalk` listens for. Called from `handle_shortcut_event`
/// (shortcut/handler.rs) INSTEAD of routing the transcribe binding straight into
/// the TranscriptionCoordinator: the renderer is the recording-MODE authority
/// (ptt vs toggle vs listen vs wakeword), so it decides — via `set_microphone` —
/// whether each press starts/stops the mic. This makes the four WinSTT recording
/// modes share ONE passive hotkey, exactly like the Electron build.
///
/// REPORTED (libOther): the call site in `handle_shortcut_event` is the one-line
/// fork — when `is_transcribe_binding(binding_id)`, call THIS instead of
/// `coordinator.send_input(...)`.
pub fn dispatch_transcribe_hotkey(app: &AppHandle, is_pressed: bool) {
    if is_pressed {
        HotkeyEvents::pressed(app);
    } else {
        HotkeyEvents::released(app);
    }
}

// ── 2. KEY-COMBO CAPTURE (record-hotkey) ────────────────────────────────────────

/// Folds Handy's per-key `handy-keys-event` stream into WinSTT's combo-capture
/// shape. Tracks the currently-held key set (for live `recording-update`) and the
/// PEAK set (the largest combo seen — what `recording-done` reports), matching the
/// Electron recorder's "peak snapshot" semantics (hotkey.ts updatePeakSnapshot).
#[derive(Default)]
pub struct CaptureBridge {
    inner: Mutex<CaptureState>,
}

#[derive(Default)]
struct CaptureState {
    active: bool,
    /// Currently-held keys, in WinSTT names + modifier-first order.
    held: Vec<String>,
    /// Largest combo observed this capture (the result on stop).
    peak: Vec<String>,
    /// True once the user cancelled with Escape (done → combo: null).
    cancelled: bool,
    /// The `handy-keys-event` listener id, so it can be detached on stop.
    listener: Option<tauri::EventId>,
}

impl CaptureBridge {
    /// Begin a capture: reset state, attach the `handy-keys-event` translation
    /// listener. The listener accumulates held keys and emits `recording-update`.
    fn begin(&self, app: &AppHandle) {
        // Detach any stale listener from a previous (un-stopped) capture first.
        self.detach(app);

        {
            let mut st = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            st.active = true;
            st.held.clear();
            st.peak.clear();
            st.cancelled = false;
        }

        let app_for_listener = app.clone();
        let id = app.listen("handy-keys-event", move |event| {
            handle_handy_key_event(&app_for_listener, event.payload());
        });

        let mut st = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        st.listener = Some(id);
    }

    /// Finish a capture: detach the listener, emit `recording-done` with the peak
    /// combo (or `null` if nothing captured / cancelled).
    fn finish(&self, app: &AppHandle) {
        self.detach(app);
        let (cancelled, peak) = {
            let mut st = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            st.active = false;
            (st.cancelled, std::mem::take(&mut st.peak))
        };
        if cancelled || peak.is_empty() {
            HotkeyEvents::recording_done(app, None);
        } else {
            let combo = peak.join("+");
            HotkeyEvents::recording_done(app, Some(&combo));
        }
    }

    fn detach(&self, app: &AppHandle) {
        let id = {
            let mut st = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            st.listener.take()
        };
        if let Some(id) = id {
            app.unlisten(id);
        }
    }
}

/// One `handy-keys-event` payload (matches FrontendKeyEvent in shortcut/handy_keys.rs).
#[derive(serde::Deserialize)]
struct HandyKeyEventPayload {
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    is_key_down: bool,
    /// The side-aware Handy combo string (`to_handy_string()` — e.g.
    /// "ctrl_left+super_left" or "ctrl_left+r"). Side info lives ONLY here (the
    /// flat `modifiers` field drops L/R), so we rebuild the WinSTT combo from this.
    #[serde(default)]
    hotkey_string: String,
}

/// Per-event translation: parse the Handy combo string → WinSTT names, update the
/// held set, track the peak, and emit a live `recording-update`. Escape cancels.
fn handle_handy_key_event(app: &AppHandle, raw: &str) {
    let Ok(payload) = serde_json::from_str::<HandyKeyEventPayload>(raw) else {
        return;
    };

    // Escape (key-down) cancels the capture, exactly like Electron's
    // handleRecordingKeyDown(Escape) → recording-done { combo: null }.
    if payload.is_key_down && payload.key.as_deref() == Some("escape") {
        if let Some(bridge) = app.try_state::<CaptureBridge>() {
            let mut st = bridge.inner.lock().unwrap_or_else(|e| e.into_inner());
            st.cancelled = true;
        }
        // Emit a done(null) immediately; the renderer's stop call is idempotent.
        HotkeyEvents::recording_done(app, None);
        return;
    }

    let names = handy_string_to_winstt_names(&payload.hotkey_string);

    if let Some(bridge) = app.try_state::<CaptureBridge>() {
        let snapshot = {
            let mut st = bridge.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !st.active {
                return;
            }
            st.held = names.clone();
            // Peak = the largest combo seen (modifiers-then-key, capped naturally
            // by the OS at a handful of simultaneous keys). Mirrors Electron's
            // updatePeakSnapshot (size > peak.length).
            if st.held.len() > st.peak.len() {
                st.peak = st.held.clone();
            }
            st.held.clone()
        };
        HotkeyEvents::recording_update(app, &snapshot);
    }
}

/// Convert a side-aware Handy combo string ("ctrl_left+super_left+r") into the
/// WinSTT internal key names the renderer expects (["LCtrl","LMeta","R"]), in
/// modifier-first order. Mirrors keycodes.ts KEYCODE_TO_NAME + sortKeycodes.
fn handy_string_to_winstt_names(handy: &str) -> Vec<String> {
    let mut mods: Vec<(u8, String)> = Vec::new();
    let mut key: Option<String> = None;

    for token in handy.split('+') {
        let t = token.trim().to_ascii_lowercase();
        if t.is_empty() {
            continue;
        }
        match t.as_str() {
            // Modifiers (rank mirrors keycodes.ts MODIFIER_ORDER 0..7).
            "ctrl" | "ctrl_left" | "lctrl" | "control" => mods.push((0, "LCtrl".into())),
            "ctrl_right" | "rctrl" => mods.push((1, "RCtrl".into())),
            "alt" | "alt_left" | "lalt" | "opt" | "option" => mods.push((2, "LAlt".into())),
            "alt_right" | "ralt" | "altgr" => mods.push((3, "RAlt".into())),
            "shift" | "shift_left" | "lshift" => mods.push((4, "LShift".into())),
            "shift_right" | "rshift" => mods.push((5, "RShift".into())),
            "super" | "super_left" | "command" | "command_left" | "cmd" | "meta" | "win"
            | "lmeta" => mods.push((6, "LMeta".into())),
            "super_right" | "command_right" | "rmeta" => mods.push((7, "RMeta".into())),
            // Mouse buttons: the hotkey recorder is KEYBOARD-ONLY (a dictation hotkey can't
            // be a mouse click). handy-keys can surface MouseLeft/Right/Middle/X1/X2 (its
            // global hook sees the mouse too), so DROP them — otherwise a stray left-click
            // during capture gets recorded as the combo (user-reported "captured mouse left").
            "mouseleft" | "leftclick" | "lmb" | "mouse1" | "mouseright" | "rightclick" | "rmb"
            | "mouse2" | "mousemiddle" | "middleclick" | "mmb" | "mouse3" | "mousex1" | "mouse4"
            | "xbutton1" | "back" | "mousex2" | "mouse5" | "xbutton2" | "forward" => {}
            // Otherwise it's the main key — translate to its WinSTT display name.
            other => key = Some(handy_key_to_winstt_name(other)),
        }
    }

    mods.sort_by_key(|(rank, _)| *rank);
    mods.dedup_by(|a, b| a.1 == b.1);
    let mut out: Vec<String> = mods.into_iter().map(|(_, n)| n).collect();
    if let Some(k) = key {
        out.push(k);
    }
    out
}

/// Map a lowercase Handy key name to the WinSTT display name (KEYCODE_TO_NAME).
/// Single letters → uppercase; named keys → CamelCase WinSTT label.
fn handy_key_to_winstt_name(key: &str) -> String {
    match key {
        "space" => "Space".into(),
        "tab" => "Tab".into(),
        "return" | "enter" => "Enter".into(),
        "escape" | "esc" => "Escape".into(),
        "delete" | "backspace" => "Backspace".into(),
        "forwarddelete" | "del" => "Delete".into(),
        "insert" | "ins" => "Insert".into(),
        "home" => "Home".into(),
        "end" => "End".into(),
        "pageup" => "PageUp".into(),
        "pagedown" => "PageDown".into(),
        "left" | "leftarrow" => "ArrowLeft".into(),
        "right" | "rightarrow" => "ArrowRight".into(),
        "up" | "uparrow" => "ArrowUp".into(),
        "down" | "downarrow" => "ArrowDown".into(),
        // Single ASCII letter → uppercase (matches KEYCODE_TO_NAME["A".."Z"]).
        s if s.len() == 1 && s.chars().all(|c| c.is_ascii_alphabetic()) => s.to_ascii_uppercase(),
        // Digits + everything else pass through verbatim (KEYCODE_TO_NAME["0".."9"]).
        s => s.to_string(),
    }
}

/// Translate a WinSTT accelerator string (Electron/keycodes.ts display names, e.g.
/// `LCtrl+LMeta`, `LMeta+LShift+E`, `LCtrl+LShift+V`) into the token vocabulary that
/// handy-keys' parser accepts. This is the INVERSE of `handy_string_to_winstt_names`,
/// and is applied at the single chokepoint `shortcut::change_binding`.
///
/// Why it is MANDATORY: the renderer persists hotkeys with WinSTT names, where the
/// Windows key is `LMeta`/`RMeta`. handy-keys' `Modifiers::parse_single` has NO
/// `lmeta`/`rmeta` token (it wants `super_left` / `meta_left` / `lcmd`), so an
/// un-translated `LMeta` falls through to `Key::from_str` → `Unknown key: LMeta` and
/// the WHOLE binding fails to register — silently killing the PTT/dictation hotkey
/// (`LCtrl+LMeta`) and the TTS read-aloud hotkey (`LMeta+LShift+E`). A few named keys
/// also differ (`ArrowLeft` vs handy `left`; WinSTT `Delete` is handy `forwarddelete`,
/// WinSTT `Backspace` is handy `backspace`/`delete`), so map those too. Every other
/// token (letters, digits, Space, Tab, Enter, Escape, F-keys, punctuation, and the
/// already-sided `LCtrl`/`LShift`/`LAlt` which handy DOES know) is a valid handy token
/// once lowercased and passes through. Idempotent (handy-canonical input is unchanged).
pub fn winstt_accel_to_handy(accel: &str) -> String {
    accel
        .split('+')
        .filter_map(|tok| {
            let t = tok.trim();
            if t.is_empty() {
                return None;
            }
            Some(
                match t.to_ascii_lowercase().as_str() {
                    // Modifiers → handy side-aware canonical names.
                    "lctrl" | "ctrl_left" => "ctrl_left",
                    "rctrl" | "ctrl_right" => "ctrl_right",
                    "ctrl" | "control" => "ctrl",
                    "lshift" | "shift_left" => "shift_left",
                    "rshift" | "shift_right" => "shift_right",
                    "shift" => "shift",
                    "lalt" | "alt_left" => "alt_left",
                    "ralt" | "alt_right" | "altgr" => "alt_right",
                    "alt" | "opt" | "option" => "alt",
                    // THE FIX: WinSTT `LMeta`/`RMeta` (Windows key) → handy's `super_*`.
                    "lmeta" | "super_left" | "meta_left" | "lcmd" => "super_left",
                    "rmeta" | "super_right" | "meta_right" | "rcmd" => "super_right",
                    "meta" | "super" | "win" | "windows" | "cmd" | "command" => "super",
                    // Named keys whose WinSTT display name differs from handy's token.
                    "arrowleft" => "left",
                    "arrowright" => "right",
                    "arrowup" => "up",
                    "arrowdown" => "down",
                    "delete" => "forwarddelete",
                    // Letters/digits/Space/Tab/Enter/Escape/Backspace/F-keys/punctuation
                    // are valid handy tokens once lowercased — pass through verbatim.
                    other => other,
                }
                .to_string(),
            )
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// `hotkey_start_recording` — begin capturing the next key combo for a rebind. Wraps
/// Handy's key-recording listener AND installs the CaptureBridge translation so the
/// per-key `handy-keys-event` stream becomes WinSTT's `hotkey:recording-update`
/// {keys}. Returns whether capture started (`hotkeyStartRecording` reads a bool).
#[tauri::command]
#[specta::specta]
pub fn hotkey_start_recording(app: AppHandle) -> bool {
    // Install/refresh the translation bridge BEFORE starting the Handy listener so
    // no early key event is dropped.
    if let Some(bridge) = app.try_state::<CaptureBridge>() {
        bridge.begin(&app);
    }
    // Suspend the live PTT binding during capture so pressing the CURRENT combo to
    // rebind it can't ALSO fire hotkey:pressed → start a dictation recording.
    // Mirrors Electron hotkey.ts handleStartRecording (`setIsActive(false)` +
    // routing every keydown to the recorder instead of activation). Re-armed on stop.
    let _ = crate::shortcut::suspend_binding(app.clone(), PTT_BINDING.to_string());
    // The binding id under capture is irrelevant to the WinSTT combo-capture UI
    // (the renderer picks the target field); use the PTT binding as the carrier.
    let started =
        crate::shortcut::handy_keys::start_handy_keys_recording(app.clone(), PTT_BINDING.to_string())
            .is_ok();
    if !started {
        // Roll back the bridge + re-arm the binding so a failed start doesn't leave a
        // dangling listener or a suspended hotkey.
        if let Some(bridge) = app.try_state::<CaptureBridge>() {
            bridge.detach(&app);
        }
        let _ = crate::shortcut::resume_binding(app.clone(), PTT_BINDING.to_string());
    }
    started
}

/// `hotkey_stop_recording` — finish combo capture. Detaches the Handy listener AND
/// the translation bridge, re-arms the suspended PTT binding, then emits
/// `hotkey:recording-done` { combo } with the captured peak combo (or `null` if
/// nothing was captured / cancelled).
#[tauri::command]
#[specta::specta]
pub fn hotkey_stop_recording(app: AppHandle) {
    let _ = crate::shortcut::handy_keys::stop_handy_keys_recording(app.clone());
    // Re-arm the PTT binding that `hotkey_start_recording` suspended.
    let _ = crate::shortcut::resume_binding(app.clone(), PTT_BINDING.to_string());
    if let Some(bridge) = app.try_state::<CaptureBridge>() {
        bridge.finish(&app);
    }
}

/// Typed emit façade for the four hotkey events. The CALL SITES live in Handy-owned
/// files: `hotkey:pressed`/`released` from `dispatch_transcribe_hotkey` (invoked by
/// `handle_shortcut_event` for the transcribe binding — instead of running the
/// TranscribeAction), and `hotkey:recording-update`/`done` from the CaptureBridge
/// translation. Centralized here so those wiring edits are one-liners and the event
/// shapes can't drift.
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
    /// display names (e.g. `["LCtrl","LShift","V"]`), modifier-first.
    pub fn recording_update(app: &AppHandle, keys: &[String]) {
        let _ = app.emit("hotkey:recording-update", serde_json::json!({ "keys": keys }));
    }

    /// `hotkey:recording-done` — capture finished. `combo` is the `+`-joined combo
    /// (e.g. `"LCtrl+LShift+V"`) or `null` when nothing was captured / cancelled.
    /// `onHotkeyRecordingDone` reads `.combo`.
    pub fn recording_done(app: &AppHandle, combo: Option<&str>) {
        let _ = app.emit("hotkey:recording-done", serde_json::json!({ "combo": combo }));
    }
}

#[cfg(test)]
mod tests {
    use super::{handy_key_to_winstt_name, handy_string_to_winstt_names, winstt_accel_to_handy};

    #[test]
    fn lmeta_combo_translates_to_handy_super() {
        // The actual bug: `LCtrl+LMeta` (default PTT) must become a combo handy-keys
        // parses (modifiers-only super_left), NOT leave `LMeta` as an unknown key.
        assert_eq!(winstt_accel_to_handy("LCtrl+LMeta"), "ctrl_left+super_left");
        // TTS read-aloud default `LMeta+LShift+E`.
        assert_eq!(
            winstt_accel_to_handy("LMeta+LShift+E"),
            "super_left+shift_left+e"
        );
    }

    #[test]
    fn winstt_accel_roundtrips_through_handy_names() {
        // winstt_accel_to_handy is the inverse of handy_string_to_winstt_names.
        for combo in ["LCtrl+LMeta", "LCtrl+LShift+V", "RCtrl+V", "LCtrl+LShift+R"] {
            let handy = winstt_accel_to_handy(combo);
            let back = handy_string_to_winstt_names(&handy).join("+");
            assert_eq!(back, combo, "round-trip failed for {combo}");
        }
    }

    #[test]
    fn winstt_accel_is_idempotent_on_handy_canonical() {
        let once = winstt_accel_to_handy("LCtrl+LMeta");
        assert_eq!(winstt_accel_to_handy(&once), once);
    }

    #[test]
    fn winstt_accel_maps_divergent_key_names() {
        assert_eq!(winstt_accel_to_handy("LCtrl+ArrowUp"), "ctrl_left+up");
        assert_eq!(winstt_accel_to_handy("Delete"), "forwarddelete");
        assert_eq!(winstt_accel_to_handy("LCtrl+Space"), "ctrl_left+space");
    }

    #[test]
    fn default_ptt_combo_roundtrips_to_winstt_names() {
        // handy `to_handy_string()` for LCtrl+LMeta is "ctrl_left+super_left".
        let names = handy_string_to_winstt_names("ctrl_left+super_left");
        assert_eq!(names, vec!["LCtrl", "LMeta"]);
    }

    #[test]
    fn compound_and_key_combo() {
        let names = handy_string_to_winstt_names("ctrl+shift+r");
        assert_eq!(names, vec!["LCtrl", "LShift", "R"]);
    }

    #[test]
    fn modifiers_sort_first_and_in_order() {
        // Out-of-order input → modifier-first canonical order (Ctrl<Alt<Shift<Meta).
        let names = handy_string_to_winstt_names("super_left+shift+ctrl_left+space");
        assert_eq!(names, vec!["LCtrl", "LShift", "LMeta", "Space"]);
    }

    #[test]
    fn right_side_modifiers() {
        let names = handy_string_to_winstt_names("ctrl_right+v");
        assert_eq!(names, vec!["RCtrl", "V"]);
    }

    #[test]
    fn key_name_mapping() {
        assert_eq!(handy_key_to_winstt_name("a"), "A");
        assert_eq!(handy_key_to_winstt_name("space"), "Space");
        assert_eq!(handy_key_to_winstt_name("uparrow"), "ArrowUp");
        assert_eq!(handy_key_to_winstt_name("5"), "5");
    }

    #[test]
    fn empty_combo_is_empty() {
        assert!(handy_string_to_winstt_names("").is_empty());
    }
}
