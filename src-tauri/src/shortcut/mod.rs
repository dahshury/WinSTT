//! Keyboard shortcut management module
//!
//! This module provides the app's keyboard shortcut interface on top of
//! Tauri's global-shortcut plugin.

mod accelerator_commands;
mod handler;
mod modifier_combo;
mod post_process_commands;
mod settings_commands;
mod tauri_impl;

pub use accelerator_commands::*;
pub use post_process_commands::*;
pub use settings_commands::*;

use log::{error, warn};
use serde::Serialize;
use specta::Type;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

use crate::settings::{self, ShortcutBinding};

static CANCEL_SHORTCUT_REGISTERED: AtomicBool = AtomicBool::new(false);

// Note: commands are accessed through their shortcut implementation module.

/// Initialize shortcuts.
pub fn init_shortcuts(app: &AppHandle) {
    let _ = settings::load_or_create_app_settings(app);
    tauri_impl::init_shortcuts(app);
}

pub(crate) fn escape_cancel_binding() -> ShortcutBinding {
    settings::get_default_settings()
        .bindings
        .get("cancel")
        .cloned()
        .unwrap_or_else(|| ShortcutBinding {
            id: "cancel".to_string(),
            name: "Cancel".to_string(),
            description: "Cancels the active dictation session.".to_string(),
            default_binding: "escape".to_string(),
            current_binding: "escape".to_string(),
        })
}

/// Register the Escape cancel shortcut (called when dictation starts)
pub fn register_cancel_shortcut(app: &AppHandle) {
    if CANCEL_SHORTCUT_REGISTERED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri_impl::register_cancel_shortcut(app);
}

/// Unregister the Escape cancel shortcut (called when dictation fully finishes)
pub fn unregister_cancel_shortcut(app: &AppHandle) {
    if !CANCEL_SHORTCUT_REGISTERED.swap(false, Ordering::SeqCst) {
        return;
    }
    tauri_impl::unregister_cancel_shortcut(app);
}

/// Register a shortcut.
pub fn register_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    if modifier_combo::register_if_modifier_only(app, &binding)? {
        return Ok(());
    }
    let binding = binding_for_tauri_backend(binding);
    tauri_impl::register_shortcut(app, binding)
}

/// Unregister a shortcut.
pub fn unregister_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    if modifier_combo::unregister_if_modifier_only(&binding)? {
        return Ok(());
    }
    let binding = binding_for_tauri_backend(binding);
    tauri_impl::unregister_shortcut(app, binding)
}

fn binding_for_tauri_backend(mut binding: ShortcutBinding) -> ShortcutBinding {
    binding.current_binding = binding_for_active_backend(&binding.id, &binding.current_binding);
    binding
}

pub(crate) fn binding_for_active_backend(id: &str, raw: &str) -> String {
    let raw = raw.trim();
    if id == "transcribe" && modifier_combo::is_modifier_only_accelerator(raw) {
        raw.to_string()
    } else {
        crate::winstt::commands::hotkey::winstt_accel_to_tauri(raw)
    }
}

pub(crate) fn validate_binding_for_active_backend(id: &str, binding: &str) -> Result<(), String> {
    if id == "transcribe" && modifier_combo::is_modifier_only_accelerator(binding) {
        Ok(())
    } else {
        tauri_impl::validate_shortcut(binding)
    }
}

// ============================================================================
// WinSTT-tree hotkeys (transforms / read_aloud / repaste)
// ============================================================================

/// True for the bindings whose accelerator SOURCE OF TRUTH lives in the WinSTT
/// settings tree (`llm.transforms.hotkey`, `tts.hotkey`, `general.repasteHotkey`)
/// rather than in `AppSettings.bindings`. These are armed exclusively through
/// [`reconcile_winstt_hotkeys`] — the init / implementation-switch loops MUST skip
/// them, because those loops would try to register raw WinSTT key names (e.g.
/// `LCtrl+LMeta`) directly against the backend parser and gate on the wrong store.
pub(crate) fn is_winstt_tree_binding(id: &str) -> bool {
    matches!(id, "transforms" | "read_aloud" | "repaste")
}

/// Arm (or disarm) the three WinSTT-tree global hotkeys from the WinSTT settings
/// tree. The single source of truth for each accelerator + its enable flag:
///   * `transforms` → `llm.transforms.hotkey`   (gated on `llm.transforms.enabled`)
///   * `read_aloud` → `tts.hotkey`              (gated on `tts.enabled`)
///   * `repaste`    → `general.repasteHotkey`   (always on when non-empty)
///
/// Called at startup (lib.rs setup), whenever one of those settings changes
/// (`apply_settings_patch`), and after a keyboard-implementation switch — so the
/// hotkeys go live immediately, exactly like the PTT hotkey, with no relaunch.
/// Routes every accelerator through `change_binding`, which translates the WinSTT
/// key names to the active shortcut backend's vocabulary and persists + (re)registers.
pub fn reconcile_winstt_hotkeys(app: &AppHandle) {
    let ws = crate::winstt::commands::settings::read_settings(app);
    reconcile_one(
        app,
        "transforms",
        ws.llm.transforms.enabled,
        &ws.llm.transforms.hotkey,
    );
    reconcile_one(app, "read_aloud", ws.tts.enabled, &ws.tts.hotkey);
    // Re-paste has no enable flag — active whenever a non-empty combo is configured.
    reconcile_one(app, "repaste", true, &ws.general.repaste_hotkey);
}

/// Reconcile a single WinSTT-tree binding: register `accel` when `enabled` and the
/// accelerator is non-empty, otherwise unregister whatever is currently armed.
fn reconcile_one(app: &AppHandle, id: &str, enabled: bool, accel: &str) {
    let accel = accel.trim();
    if enabled && !accel.is_empty() {
        // `change_binding` translates to the backend parser vocabulary, validates,
        // (re)registers, and
        // persists. It unregisters the previous accelerator first, so a rebind never
        // leaves the old combo hijacked.
        if let Err(e) = change_binding(app.clone(), id.to_string(), accel.to_string()) {
            warn!("reconcile_winstt_hotkeys: failed to arm '{}': {}", id, e);
        }
    } else {
        // Disabled / empty: drop any live registration (idempotent by binding id,
        // so a never-registered binding is a silent no-op).
        let binding = settings::get_stored_binding(app, id);
        if let Err(e) = unregister_shortcut(app, binding) {
            // A not-currently-registered binding is the common case; log at debug.
            log::debug!("reconcile_winstt_hotkeys: '{}' not unregistered: {}", id, e);
        }
    }
}

// ============================================================================
// Binding Management Commands
// ============================================================================

#[derive(Serialize, Type)]
pub struct BindingResponse {
    success: bool,
    binding: Option<ShortcutBinding>,
    error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn change_binding(
    app: AppHandle,
    id: String,
    binding: String,
) -> Result<BindingResponse, String> {
    // Reject empty bindings — every shortcut should have a value
    if binding.trim().is_empty() {
        return Err("Binding cannot be empty".to_string());
    }

    let mut settings = settings::get_settings(&app);
    // The renderer sends accelerators in WinSTT/reference key names
    // (`LCtrl+LMeta`, `LCtrl+Space`, ...). Translate to Tauri's token vocabulary
    // at this single chokepoint, except modifier-only PTT combos that the
    // WinSTT-owned Windows listener handles directly.
    let binding = binding_for_active_backend(&id, &binding);

    // Get the binding to modify, or create it from defaults if it doesn't exist
    let binding_to_modify = match settings.bindings.get(&id) {
        Some(binding) => binding.clone(),
        None => {
            // Try to get the default binding for this id
            let default_settings = settings::get_default_settings();
            match default_settings.bindings.get(&id) {
                Some(default_binding) => {
                    warn!(
                        "Binding '{}' not found in settings, creating from defaults",
                        id
                    );
                    default_binding.clone()
                }
                None => {
                    let error_msg = format!("Binding with id '{}' not found in defaults", id);
                    warn!("change_binding error: {}", error_msg);
                    return Ok(BindingResponse {
                        success: false,
                        binding: None,
                        error: Some(error_msg),
                    });
                }
            }
        }
    };

    // Escape cancel is fixed so old persisted hotkey+Backspace-style bindings do not linger.
    if id == "cancel" {
        let b = escape_cancel_binding();
        settings.bindings.insert(id.clone(), b.clone());
        settings::write_settings(&app, settings);
        return Ok(BindingResponse {
            success: true,
            binding: Some(b),
            error: None,
        });
    }

    // Unregister the existing binding
    if let Err(e) = unregister_shortcut(&app, binding_to_modify.clone()) {
        let error_msg = format!("Failed to unregister shortcut: {}", e);
        error!("change_binding error: {}", error_msg);
    }

    // Validate the new shortcut for the active backend.
    if let Err(e) = validate_binding_for_active_backend(&id, &binding) {
        warn!("change_binding validation error: {}", e);
        return Err(e);
    }

    // Create an updated binding
    let mut updated_binding = binding_to_modify;
    updated_binding.current_binding = binding;

    // Register the new binding
    if let Err(e) = register_shortcut(&app, updated_binding.clone()) {
        let error_msg = format!("Failed to register shortcut: {}", e);
        error!("change_binding error: {}", error_msg);
        return Ok(BindingResponse {
            success: false,
            binding: None,
            error: Some(error_msg),
        });
    }

    // Update the binding in the settings
    settings.bindings.insert(id, updated_binding.clone());

    // Save the settings
    settings::write_settings(&app, settings);

    // Return the updated binding
    Ok(BindingResponse {
        success: true,
        binding: Some(updated_binding),
        error: None,
    })
}

#[tauri::command]
#[specta::specta]
pub fn reset_binding(app: AppHandle, id: String) -> Result<BindingResponse, String> {
    let binding = settings::get_stored_binding(&app, &id);
    change_binding(app, id, binding.default_binding)
}

/// Temporarily unregister a binding while the user is editing it in the UI.
/// This avoids firing the action while keys are being recorded.
#[tauri::command]
#[specta::specta]
pub fn suspend_binding(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(b) = settings::get_bindings(&app).get(&id).cloned() {
        if let Err(e) = unregister_shortcut(&app, b) {
            error!("suspend_binding error for id '{}': {}", id, e);
            return Err(e);
        }
    }
    Ok(())
}

/// Re-register the binding after the user has finished editing.
#[tauri::command]
#[specta::specta]
pub fn resume_binding(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(b) = settings::get_bindings(&app).get(&id).cloned() {
        if let Err(e) = register_shortcut(&app, b) {
            error!("resume_binding error for id '{}': {}", id, e);
            return Err(e);
        }
    }
    Ok(())
}

// ============================================================================
// Keyboard Implementation
// ============================================================================

/// Get the current keyboard implementation
#[tauri::command]
#[specta::specta]
pub fn get_keyboard_implementation(_app: AppHandle) -> String {
    "tauri".to_string()
}

#[cfg(test)]
mod tests {
    use super::{binding_for_tauri_backend, ShortcutBinding};

    fn binding(id: &str, current_binding: &str) -> ShortcutBinding {
        ShortcutBinding {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            default_binding: current_binding.to_string(),
            current_binding: current_binding.to_string(),
        }
    }

    #[test]
    fn tauri_backend_binding_normalizes_winstt_specific_modifiers() {
        let normalized = binding_for_tauri_backend(binding("transforms", "LCtrl+LShift+T"));
        assert_eq!(normalized.current_binding, "Ctrl+Shift+T");

        let normalized = binding_for_tauri_backend(binding("repaste", "ctrl_left+shift_left+v"));
        assert_eq!(normalized.current_binding, "Ctrl+Shift+V");
    }

    #[test]
    fn tauri_backend_binding_preserves_modifier_only_ptt() {
        let normalized = binding_for_tauri_backend(binding("transcribe", "LCtrl+LMeta"));
        assert_eq!(normalized.current_binding, "LCtrl+LMeta");
    }
}
