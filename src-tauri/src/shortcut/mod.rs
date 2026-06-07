//! Keyboard shortcut management module
//!
//! This module provides a unified interface for keyboard shortcuts with
//! multiple backend implementations:
//!
//! - `tauri`: Uses Tauri's built-in global-shortcut plugin
//! - `handy_keys`: Uses the handy-keys library for more control
//!
//! The active implementation is determined by the `keyboard_implementation`
//! setting and can be changed at runtime.

mod accelerator_commands;
mod handler;
pub mod handy_keys;
mod post_process_commands;
mod settings_commands;
mod tauri_impl;

pub use accelerator_commands::*;
pub use post_process_commands::*;
pub use settings_commands::*;

use log::{error, info, warn};
use serde::Serialize;
use specta::Type;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::{self, get_settings, KeyboardImplementation, ShortcutBinding};

static CANCEL_SHORTCUT_REGISTERED: AtomicBool = AtomicBool::new(false);

// Note: Commands are accessed via shortcut::handy_keys:: in lib.rs

/// Initialize shortcuts using the configured implementation
pub fn init_shortcuts(app: &AppHandle) {
    let user_settings = settings::load_or_create_app_settings(app);

    // Check which implementation to use
    match user_settings.keyboard_implementation {
        KeyboardImplementation::Tauri => {
            tauri_impl::init_shortcuts(app);
        }
        KeyboardImplementation::HandyKeys => {
            if let Err(e) = handy_keys::init_shortcuts(app) {
                error!("Failed to initialize handy-keys shortcuts: {}", e);
                // Fall back to Tauri implementation and persist this fallback
                warn!("Falling back to Tauri global shortcut implementation and saving fallback to settings");

                // Update settings to persist the fallback so we don't retry HandyKeys on next launch
                let mut settings = settings::get_settings(app);
                settings.keyboard_implementation = KeyboardImplementation::Tauri;
                settings::write_settings(app, settings);

                tauri_impl::init_shortcuts(app);
            }
        }
    }
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
    let settings = get_settings(app);
    match settings.keyboard_implementation {
        KeyboardImplementation::Tauri => tauri_impl::register_cancel_shortcut(app),
        KeyboardImplementation::HandyKeys => handy_keys::register_cancel_shortcut(app),
    }
}

/// Unregister the Escape cancel shortcut (called when dictation fully finishes)
pub fn unregister_cancel_shortcut(app: &AppHandle) {
    if !CANCEL_SHORTCUT_REGISTERED.swap(false, Ordering::SeqCst) {
        return;
    }
    let settings = get_settings(app);
    match settings.keyboard_implementation {
        KeyboardImplementation::Tauri => tauri_impl::unregister_cancel_shortcut(app),
        KeyboardImplementation::HandyKeys => handy_keys::unregister_cancel_shortcut(app),
    }
}

/// Register a shortcut using the appropriate implementation
pub fn register_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    let settings = get_settings(app);
    match settings.keyboard_implementation {
        KeyboardImplementation::Tauri => tauri_impl::register_shortcut(app, binding),
        KeyboardImplementation::HandyKeys => handy_keys::register_shortcut(app, binding),
    }
}

/// Unregister a shortcut using the appropriate implementation
pub fn unregister_shortcut(app: &AppHandle, binding: ShortcutBinding) -> Result<(), String> {
    let settings = get_settings(app);
    match settings.keyboard_implementation {
        KeyboardImplementation::Tauri => tauri_impl::unregister_shortcut(app, binding),
        KeyboardImplementation::HandyKeys => handy_keys::unregister_shortcut(app, binding),
    }
}

// ============================================================================
// WinSTT-tree hotkeys (transforms / read_aloud / repaste)
// ============================================================================

/// True for the bindings whose accelerator SOURCE OF TRUTH lives in the WinSTT
/// settings tree (`llm.transforms.hotkey`, `tts.hotkey`, `general.repasteHotkey`)
/// rather than in `AppSettings.bindings`. These are armed exclusively through
/// [`reconcile_winstt_hotkeys`] — the init / implementation-switch loops MUST skip
/// them, because those loops would try to register the raw WinSTT key names (e.g.
/// `LCtrl+LMeta`, which handy-keys' parser rejects) and gate on the wrong store.
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
        // `change_binding` translates (winstt→handy), validates, (re)registers, and
        // persists. It unregisters the previous accelerator first, so a rebind never
        // leaves the old combo hijacked.
        if let Err(e) = change_binding(app.clone(), id.to_string(), accel.to_string()) {
            warn!("reconcile_winstt_hotkeys: failed to arm '{}': {}", id, e);
        }
    } else {
        // Disabled / empty: drop any live registration (idempotent — handy keys by
        // binding id, so a never-registered binding is a silent no-op).
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
    // WinSTT fork: the renderer sends accelerators in WinSTT/the reference key names
    // (`LCtrl+LMeta`, `LCtrl+Space`, …). Translate to the active backend's token
    // vocabulary at this single chokepoint — covering PTT, TTS, transforms, repaste,
    // and settings rebinds. Without this, side-aware WinSTT names are fed to parsers
    // that do not understand them.
    let binding = normalize_accel_for_implementation(&binding, settings.keyboard_implementation);

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

    // Validate the new shortcut for the current keyboard implementation
    if let Err(e) = validate_shortcut_for_implementation(&binding, settings.keyboard_implementation)
    {
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
// Keyboard Implementation Switching
// ============================================================================

/// Result of changing keyboard implementation
#[derive(Serialize, Type)]
pub struct ImplementationChangeResult {
    pub success: bool,
    /// List of binding IDs that were reset to defaults due to incompatibility
    pub reset_bindings: Vec<String>,
}

/// Change the keyboard implementation with runtime switching.
/// This will unregister all shortcuts from the old implementation,
/// validate shortcuts for the new implementation (resetting invalid ones to defaults),
/// and register them with the new implementation.
#[tauri::command]
#[specta::specta]
pub fn change_keyboard_implementation_setting(
    app: AppHandle,
    implementation: String,
) -> Result<ImplementationChangeResult, String> {
    let current_settings = settings::get_settings(&app);
    let current_impl = current_settings.keyboard_implementation;
    let new_impl = parse_keyboard_implementation(&implementation);

    // If same implementation, nothing to do
    if current_impl == new_impl {
        return Ok(ImplementationChangeResult {
            success: true,
            reset_bindings: vec![],
        });
    }

    info!(
        "Switching keyboard implementation from {:?} to {:?}",
        current_impl, new_impl
    );

    // Unregister all shortcuts from the current implementation
    unregister_all_shortcuts(&app, current_impl);

    // Update the setting
    let mut settings = settings::get_settings(&app);
    settings.keyboard_implementation = new_impl;
    settings::write_settings(&app, settings);

    // Initialize new implementation if needed (HandyKeys needs state)
    if new_impl == KeyboardImplementation::HandyKeys && initialize_handy_keys_with_rollback(&app)? {
        // Shortcuts already registered during init (which skips the WinSTT-tree
        // hotkeys) — arm those from the WinSTT settings tree now.
        reconcile_winstt_hotkeys(&app);
        return Ok(ImplementationChangeResult {
            success: true,
            reset_bindings: vec![],
        });
    }

    // Register all shortcuts with new implementation, resetting invalid ones
    let reset_bindings = register_all_shortcuts_for_implementation(&app, new_impl);

    // Arm the WinSTT-tree hotkeys (skipped by the loop above) from their settings tree.
    reconcile_winstt_hotkeys(&app);

    // Emit event to notify frontend of the change
    let _ = app.emit(
        "settings-changed",
        serde_json::json!({
            "setting": "keyboard_implementation",
            "value": implementation,
            "reset_bindings": reset_bindings
        }),
    );

    info!("Keyboard implementation switched to {:?}", new_impl);

    Ok(ImplementationChangeResult {
        success: true,
        reset_bindings,
    })
}

/// Get the current keyboard implementation
#[tauri::command]
#[specta::specta]
pub fn get_keyboard_implementation(app: AppHandle) -> String {
    let settings = settings::get_settings(&app);
    match settings.keyboard_implementation {
        KeyboardImplementation::Tauri => "tauri".to_string(),
        KeyboardImplementation::HandyKeys => "handy_keys".to_string(),
    }
}

// ============================================================================
// Validation Helpers
// ============================================================================

/// Validate a shortcut for a specific implementation
fn validate_shortcut_for_implementation(
    raw: &str,
    implementation: KeyboardImplementation,
) -> Result<(), String> {
    match implementation {
        KeyboardImplementation::Tauri => tauri_impl::validate_shortcut(raw),
        KeyboardImplementation::HandyKeys => handy_keys::validate_shortcut(raw),
    }
}

fn normalize_accel_for_implementation(raw: &str, implementation: KeyboardImplementation) -> String {
    match implementation {
        KeyboardImplementation::Tauri => {
            crate::winstt::commands::hotkey::winstt_accel_to_tauri(raw)
        }
        KeyboardImplementation::HandyKeys => {
            crate::winstt::commands::hotkey::winstt_accel_to_handy(raw)
        }
    }
}

/// Parse a keyboard implementation string into the enum
fn parse_keyboard_implementation(s: &str) -> KeyboardImplementation {
    match s {
        "tauri" => KeyboardImplementation::Tauri,
        "handy_keys" => KeyboardImplementation::HandyKeys,
        other => {
            warn!(
                "Invalid keyboard implementation '{}', defaulting to tauri",
                other
            );
            KeyboardImplementation::Tauri
        }
    }
}

/// Unregister all shortcuts for the current implementation
fn unregister_all_shortcuts(app: &AppHandle, implementation: KeyboardImplementation) {
    let bindings = settings::get_bindings(app);

    for (id, binding) in bindings {
        // Skip cancel shortcut as it's dynamically registered
        if id == "cancel" {
            continue;
        }

        let result = match implementation {
            KeyboardImplementation::Tauri => tauri_impl::unregister_shortcut(app, binding),
            KeyboardImplementation::HandyKeys => handy_keys::unregister_shortcut(app, binding),
        };

        if let Err(e) = result {
            warn!(
                "Failed to unregister shortcut '{}' during switch: {}",
                id, e
            );
        }
    }
}

/// Register all shortcuts for a specific implementation, validating and resetting invalid ones
fn register_all_shortcuts_for_implementation(
    app: &AppHandle,
    implementation: KeyboardImplementation,
) -> Vec<String> {
    let mut reset_bindings = Vec::new();
    let default_bindings = settings::get_default_settings().bindings;
    let mut current_settings = settings::get_settings(app);

    for (id, default_binding) in &default_bindings {
        // Skip cancel shortcut as it's dynamically registered
        if id == "cancel" {
            continue;
        }
        // Skip the WinSTT-tree hotkeys — armed via `reconcile_winstt_hotkeys` (called
        // after the switch), which reads their accelerators from the WinSTT settings
        // tree and translates the key names. Registering them here would use the raw
        // (untranslatable) AppSettings copy.
        if is_winstt_tree_binding(id) {
            continue;
        }

        // Skip post-processing shortcut when the feature is disabled
        if id == "transcribe_with_post_process" && !current_settings.post_process_enabled {
            continue;
        }

        let mut binding = current_settings
            .bindings
            .get(id)
            .cloned()
            .unwrap_or_else(|| default_binding.clone());

        // Validate the shortcut for the target implementation
        if let Err(e) =
            validate_shortcut_for_implementation(&binding.current_binding, implementation)
        {
            info!(
                "Shortcut '{}' ({}) is invalid for {:?}: {}. Resetting to default.",
                id, binding.current_binding, implementation, e
            );

            // Reset to default
            binding.current_binding = default_binding.current_binding.clone();
            current_settings
                .bindings
                .insert(id.clone(), binding.clone());
            reset_bindings.push(id.clone());
        }

        // Register with the appropriate implementation
        let result = match implementation {
            KeyboardImplementation::Tauri => tauri_impl::register_shortcut(app, binding),
            KeyboardImplementation::HandyKeys => handy_keys::register_shortcut(app, binding),
        };

        if let Err(e) = result {
            error!(
                "Failed to register shortcut '{}' for {:?}: {}",
                id, implementation, e
            );
        }
    }

    // Save settings if any bindings were reset
    if !reset_bindings.is_empty() {
        settings::write_settings(app, current_settings);
    }

    reset_bindings
}

/// Initialize HandyKeys if not already initialized, with rollback on failure
fn initialize_handy_keys_with_rollback(app: &AppHandle) -> Result<bool, String> {
    if app.try_state::<handy_keys::HandyKeysState>().is_some() {
        return Ok(false); // Already initialized, caller should continue
    }

    if let Err(e) = handy_keys::init_shortcuts(app) {
        error!("Failed to initialize HandyKeys: {}", e);
        // Rollback to Tauri
        let mut settings = settings::get_settings(app);
        settings.keyboard_implementation = KeyboardImplementation::Tauri;
        settings::write_settings(app, settings);
        tauri_impl::init_shortcuts(app);
        return Err(format!(
            "Failed to initialize HandyKeys: {}. Reverted to Tauri.",
            e
        ));
    }

    // init_shortcuts already registered shortcuts
    Ok(true)
}
