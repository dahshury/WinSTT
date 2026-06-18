// Hotkey command surface. The renderer owns recording-mode behavior; the backend
// only registers global shortcuts and emits press/release events for the selected
// PTT/toggle accelerator.

use tauri::{AppHandle, Emitter, Manager};

/// The transcribe binding the PTT/toggle hotkey drives. The renderer registers an
/// accelerator string against this binding so press/release fires
/// `hotkey:pressed`/`hotkey:released`.
const PTT_BINDING: &str = "transcribe";

/// Register the PTT/toggle accelerator. The renderer sends WinSTT key names
/// (`LCtrl+LMeta`, `LCtrl+Space`, etc.); `shortcut::change_binding` translates
/// normal shortcuts to Tauri's vocabulary and routes modifier-only PTT combos to
/// the WinSTT-owned Windows modifier listener.
#[tauri::command]
#[specta::specta]
pub fn hotkey_register(app: AppHandle, accelerator: String) -> bool {
    if crate::winstt::commands::onboarding::is_onboarding_active() {
        log::debug!("[hotkey] registration ignored while onboarding is active");
        return false;
    }

    let accel = accelerator.trim();
    if accel.is_empty() {
        return false;
    }
    match crate::shortcut::change_binding(app, PTT_BINDING.to_string(), accel.to_string()) {
        Ok(resp) => serde_json::to_value(&resp)
            .ok()
            .and_then(|v| v.get("success").and_then(|s| s.as_bool()))
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// Unregister the PTT/toggle accelerator. The binding is resolved from settings,
/// so the accelerator payload is accepted for API compatibility but not needed.
#[tauri::command]
#[specta::specta]
pub fn hotkey_unregister(app: AppHandle, accelerator: String) {
    let _ = accelerator;
    let binding = crate::settings::get_stored_binding(&app, PTT_BINDING);
    let _ = crate::shortcut::unregister_shortcut(&app, binding);
}

/// Dispatch a transcribe-binding press/release as the WinSTT hotkey events the
/// renderer's `usePushToTalk` listens for.
pub fn dispatch_transcribe_hotkey(app: &AppHandle, is_pressed: bool) {
    if is_pressed {
        HotkeyEvents::pressed(app);
    } else {
        HotkeyEvents::released(app);
    }
}

/// Translate WinSTT/reference accelerator names into `global-hotkey` / Tauri's
/// parser vocabulary. Tauri does not preserve left/right modifier side. The
/// modifier-only PTT path bypasses this translation so side-specific combos like
/// `LCtrl+LMeta` can be handled by WinSTT's Windows listener.
pub fn winstt_accel_to_tauri(accel: &str) -> String {
    let mut ctrl = false;
    let mut shift = false;
    let mut alt = false;
    let mut super_key = false;
    let mut keys = Vec::new();

    for tok in accel.split('+') {
        let t = tok.trim();
        if t.is_empty() {
            continue;
        }
        match t.to_ascii_lowercase().as_str() {
            "lctrl" | "rctrl" | "ctrl_left" | "ctrl_right" | "ctrl" | "control" => {
                ctrl = true;
            }
            "lshift" | "rshift" | "shift_left" | "shift_right" | "shift" => {
                shift = true;
            }
            "lalt" | "ralt" | "alt_left" | "alt_right" | "altgr" | "alt" | "opt" | "option" => {
                alt = true;
            }
            "lmeta" | "rmeta" | "super_left" | "super_right" | "meta_left" | "meta_right"
            | "meta" | "super" | "win" | "windows" | "cmd" | "command" => {
                super_key = true;
            }
            "arrowleft" | "left" => keys.push("ArrowLeft".to_string()),
            "arrowright" | "right" => keys.push("ArrowRight".to_string()),
            "arrowup" | "up" => keys.push("ArrowUp".to_string()),
            "arrowdown" | "down" => keys.push("ArrowDown".to_string()),
            "forwarddelete" => keys.push("Delete".to_string()),
            "backspace" => keys.push("Backspace".to_string()),
            "escape" | "esc" => keys.push("Escape".to_string()),
            "space" => keys.push("Space".to_string()),
            "tab" => keys.push("Tab".to_string()),
            "enter" | "return" => keys.push("Enter".to_string()),
            s if s.len() == 1 && s.chars().all(|c| c.is_ascii_alphabetic()) => {
                keys.push(s.to_ascii_uppercase());
            }
            other => keys.push(other.to_string()),
        }
    }

    let mut out = Vec::new();
    if ctrl {
        out.push("Ctrl".to_string());
    }
    if shift {
        out.push("Shift".to_string());
    }
    if alt {
        out.push("Alt".to_string());
    }
    if super_key {
        out.push("Super".to_string());
    }
    out.extend(keys);
    out.join("+")
}

/// Begin combo capture for the settings UI. Actual key capture happens in the
/// renderer while the settings window has focus; the backend only suspends live
/// shortcuts so the user's recording keystrokes do not trigger actions.
#[tauri::command]
#[specta::specta]
pub fn hotkey_start_recording(app: AppHandle, webview: tauri::WebviewWindow) -> bool {
    if webview.label() != "settings" {
        log::warn!(
            "[hotkey] ignoring hotkey_start_recording from '{}' webview",
            webview.label()
        );
        return false;
    }

    let _ = crate::shortcut::suspend_binding(app.clone(), PTT_BINDING.to_string());
    for id in ["transforms", "read_aloud", "repaste"] {
        let _ = crate::shortcut::suspend_binding(app.clone(), id.to_string());
    }
    true
}

/// Finish combo capture and re-arm suspended shortcuts.
#[tauri::command]
#[specta::specta]
pub fn hotkey_stop_recording(app: AppHandle, webview: tauri::WebviewWindow) {
    if webview.label() != "settings" {
        log::warn!(
            "[hotkey] ignoring hotkey_stop_recording from '{}' webview",
            webview.label()
        );
        return;
    }

    if !crate::winstt::commands::onboarding::is_onboarding_active() {
        let _ = crate::shortcut::resume_binding(app.clone(), PTT_BINDING.to_string());
        crate::shortcut::reconcile_winstt_hotkeys(&app);
    }
}

/// Typed emit facade for hotkey events.
pub struct HotkeyEvents;

impl HotkeyEvents {
    pub fn pressed(app: &AppHandle) {
        let _ = app.emit("hotkey:pressed", ());
    }

    pub fn released(app: &AppHandle) {
        let _ = app.emit("hotkey:released", ());
    }

    pub fn recording_update(app: &AppHandle, keys: &[String]) {
        if let Some(settings) = app.get_webview_window("settings") {
            let _ = settings.emit(
                "hotkey:recording-update",
                serde_json::json!({ "keys": keys }),
            );
        }
    }

    pub fn recording_done(app: &AppHandle, combo: Option<&str>) {
        if let Some(settings) = app.get_webview_window("settings") {
            let _ = settings.emit(
                "hotkey:recording-done",
                serde_json::json!({ "combo": combo }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::winstt_accel_to_tauri;

    #[test]
    fn winstt_accel_maps_to_tauri_global_hotkey_names() {
        assert_eq!(winstt_accel_to_tauri("LCtrl+LShift+V"), "Ctrl+Shift+V");
        assert_eq!(winstt_accel_to_tauri("LCtrl+LAlt+D"), "Ctrl+Alt+D");
        assert_eq!(winstt_accel_to_tauri("LCtrl+LMeta"), "Ctrl+Super");
        assert_eq!(winstt_accel_to_tauri("ctrl_left+space"), "Ctrl+Space");
        assert_eq!(winstt_accel_to_tauri("forwarddelete"), "Delete");
    }

    #[test]
    fn side_specific_modifiers_are_collapsed_for_tauri() {
        assert_eq!(winstt_accel_to_tauri("LCtrl+RCtrl+A"), "Ctrl+A");
        assert_eq!(winstt_accel_to_tauri("LMeta+RMeta+Space"), "Super+Space");
    }

    #[test]
    fn named_keys_are_normalized() {
        assert_eq!(winstt_accel_to_tauri("LCtrl+ArrowUp"), "Ctrl+ArrowUp");
        assert_eq!(winstt_accel_to_tauri("LCtrl+Escape"), "Ctrl+Escape");
    }
}
