//! Tauri global-shortcut implementation
//!
//! This module provides shortcut functionality using Tauri's built-in
//! global-shortcut plugin.

use log::{debug, error, warn};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::settings::{self, ShortcutBinding};

use super::handler::handle_shortcut_event;

#[cfg(target_os = "windows")]
fn validate_windows_reserved(tokens: &[String]) -> Result<(), String> {
    let has = |token: &str| tokens.iter().any(|part| part == token);
    let has_any = |candidates: &[&str]| candidates.iter().any(|token| has(token));

    if has_any(&["win", "windows", "super", "meta", "command", "cmd"]) {
        return Err("Windows-key shortcuts are reserved by the operating system".into());
    }
    if has("f12") {
        return Err("F12 is reserved by Windows for debuggers".into());
    }
    if has_any(&["printscreen", "printscrn", "prtsc", "snapshot"]) {
        return Err("Print Screen shortcuts are reserved by Windows".into());
    }

    let ctrl = has_any(&["ctrl", "control"]);
    let alt = has_any(&["alt", "option"]);
    let shift = has("shift");
    if (ctrl && alt && has("delete"))
        || (alt && has("tab"))
        || (alt && has("f4"))
        || (ctrl && has_any(&["escape", "esc"]))
        || (ctrl && shift && has_any(&["escape", "esc"]))
    {
        return Err("this shortcut is reserved by Windows".into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn validate_windows_reserved(_tokens: &[String]) -> Result<(), String> {
    Ok(())
}

/// Initialize shortcuts using Tauri's global-shortcut plugin
pub fn init_shortcuts(app: &AppHandle) {
    let default_bindings = settings::get_default_settings().bindings;
    let user_settings = settings::get_settings(app);

    // Register all default shortcuts, applying user customizations
    for (id, default_binding) in default_bindings {
        if id == "cancel" {
            continue; // Skip cancel shortcut, it will be registered dynamically
        }
        // Skip the WinSTT-tree hotkeys (transforms / read_aloud / repaste) — armed via
        // `shortcut::reconcile_winstt_hotkeys` from the WinSTT settings tree.
        if crate::shortcut::is_winstt_tree_binding(&id) {
            continue;
        }
        let binding = user_settings
            .bindings
            .get(&id)
            .cloned()
            .unwrap_or(default_binding);

        let binding = if id == "transcribe" {
            let ptt = crate::winstt::commands::settings::read_settings_raw(app)
                .hotkey
                .push_to_talk_key;
            ShortcutBinding {
                current_binding: crate::shortcut::binding_for_active_backend(&id, &ptt),
                ..binding
            }
        } else {
            binding
        };

        if let Err(e) = super::register_shortcut(app, binding) {
            error!("Failed to register shortcut {} during init: {}", id, e);
        }
    }
}

/// Validate a shortcut string for the Tauri global-shortcut implementation.
/// Tauri requires at least one non-modifier key and doesn't support the fn key.
/// Modifier-only PTT shortcuts are handled before this point by WinSTT's
/// Windows modifier listener.
pub fn validate_shortcut(raw: &str) -> Result<(), String> {
    if raw.trim().is_empty() {
        return Err("Shortcut cannot be empty".into());
    }

    let modifiers = [
        "ctrl", "control", "shift", "alt", "option", "meta", "command", "cmd", "super", "win",
        "windows",
    ];

    // Check for fn key which Tauri doesn't support
    let parts: Vec<String> = raw.split('+').map(|p| p.trim().to_lowercase()).collect();
    for part in &parts {
        if part == "fn" || part == "function" {
            return Err("The 'fn' key is not supported by Tauri global shortcuts".into());
        }
    }

    validate_windows_reserved(&parts)?;

    let has_non_modifier = parts.iter().any(|part| !modifiers.contains(&part.as_str()));

    if has_non_modifier {
        Ok(())
    } else {
        Err("Tauri shortcuts must include a main key (letter, number, F-key, etc.) in addition to modifiers".into())
    }
}

/// Register a shortcut using Tauri's global-shortcut plugin
pub fn register_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    // Validate for Tauri requirements
    if let Err(e) = validate_shortcut(&binding.current_binding) {
        warn!(
            "register_tauri_shortcut validation error for binding '{}': {}",
            binding.current_binding, e
        );
        return Err(e);
    }

    let shortcut = match binding.current_binding.parse::<Shortcut>() {
        Ok(s) => s,
        Err(e) => {
            let error_msg = format!(
                "Failed to parse shortcut '{}': {}",
                binding.current_binding, e
            );
            error!("register_tauri_shortcut parse error: {}", error_msg);
            return Err(error_msg);
        }
    };

    // Prevent duplicate registrations that would silently shadow one another
    if app.global_shortcut().is_registered(shortcut) {
        let error_msg = format!("Shortcut '{}' is already in use", binding.current_binding);
        warn!("register_tauri_shortcut duplicate error: {}", error_msg);
        return Err(error_msg);
    }

    let binding_id_for_closure = binding.id.clone();

    app.global_shortcut()
        .on_shortcut(shortcut, move |app_handle, scut, event| {
            if scut == &shortcut {
                let shortcut_string = scut.into_string();
                let is_pressed = event.state == ShortcutState::Pressed;
                handle_shortcut_event(
                    app_handle,
                    &binding_id_for_closure,
                    &shortcut_string,
                    is_pressed,
                );
            }
        })
        .map_err(|e| {
            let error_msg = format!(
                "Couldn't register shortcut '{}': {}",
                binding.current_binding, e
            );
            error!("register_tauri_shortcut registration error: {}", error_msg);
            error_msg
        })?;

    Ok(())
}

/// Report whether this exact accelerator is currently registered with Tauri.
/// Callers use this only after confirming that the requested binding matches the
/// persisted binding id, so an already-active registration is a safe no-op.
pub fn is_registered(app: &AppHandle, binding: &ShortcutBinding) -> Result<bool, String> {
    let shortcut = binding.current_binding.parse::<Shortcut>().map_err(|e| {
        format!(
            "Failed to parse shortcut '{}': {e}",
            binding.current_binding
        )
    })?;
    Ok(app.global_shortcut().is_registered(shortcut))
}

/// Unregister a shortcut from Tauri's global-shortcut plugin
pub fn unregister_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    let shortcut = match binding.current_binding.parse::<Shortcut>() {
        Ok(s) => s,
        Err(e) => {
            let error_msg = format!(
                "Failed to parse shortcut '{}' for unregistration: {}",
                binding.current_binding, e
            );
            error!("unregister_tauri_shortcut parse error: {}", error_msg);
            return Err(error_msg);
        }
    };

    if !app.global_shortcut().is_registered(shortcut) {
        debug!(
            "unregister_tauri_shortcut no-op for unregistered shortcut '{}'",
            binding.current_binding
        );
        return Ok(());
    }

    app.global_shortcut().unregister(shortcut).map_err(|e| {
        let error_msg = format!(
            "Failed to unregister shortcut '{}': {}",
            binding.current_binding, e
        );
        error!("unregister_tauri_shortcut error: {}", error_msg);
        error_msg
    })?;

    Ok(())
}

/// Register the Escape cancel shortcut (called when dictation starts)
pub fn register_cancel_shortcut(app: &AppHandle) {
    // Cancel shortcut is disabled on Linux due to instability with dynamic shortcut registration
    #[cfg(target_os = "linux")]
    {
        let _ = app;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let cancel_binding = super::escape_cancel_binding();
            if let Err(e) = register_shortcut(&app_clone, cancel_binding) {
                error!("Failed to register cancel shortcut: {}", e);
            }
        });
    }
}

/// Unregister the Escape cancel shortcut (called when dictation fully finishes)
pub fn unregister_cancel_shortcut(app: &AppHandle) {
    // Cancel shortcut is disabled on Linux due to instability with dynamic shortcut registration
    #[cfg(target_os = "linux")]
    {
        let _ = app;
    }

    #[cfg(not(target_os = "linux"))]
    {
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let cancel_binding = super::escape_cancel_binding();
            // We ignore errors here as it might already be unregistered.
            let _ = unregister_shortcut(&app_clone, cancel_binding);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::validate_shortcut;

    #[cfg(target_os = "windows")]
    #[test]
    fn rejects_windows_reserved_shortcuts() {
        for accel in [
            "F12",
            "Ctrl+Alt+Delete",
            "Alt+Tab",
            "Alt+F4",
            "Ctrl+Escape",
            "Ctrl+Shift+Escape",
            "PrintScreen",
            "Super+K",
        ] {
            assert!(
                validate_shortcut(accel).is_err(),
                "expected '{accel}' to be reserved"
            );
        }
    }
}
