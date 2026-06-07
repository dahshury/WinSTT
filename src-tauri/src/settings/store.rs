use log::{debug, warn};
use std::collections::HashMap;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use super::defaults::*;
use super::types::{
    AppSettings, AutoSubmitKey, ClipboardHandling, KeyboardImplementation, ModelUnloadTimeout,
    OrtAcceleratorSetting, PasteMethod, PostProcessProvider, ShortcutBinding,
    WhisperAcceleratorSetting,
};

pub const SETTINGS_STORE_PATH: &str = "settings_store.json";

pub fn get_default_settings() -> AppSettings {
    #[cfg(target_os = "windows")]
    let default_shortcut = "ctrl+space";
    #[cfg(target_os = "macos")]
    let default_shortcut = "option+space";
    #[cfg(target_os = "linux")]
    let default_shortcut = "ctrl+space";
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let default_shortcut = "alt+space";

    let mut bindings = HashMap::new();
    bindings.insert(
        "transcribe".to_string(),
        ShortcutBinding {
            id: "transcribe".to_string(),
            name: "Transcribe".to_string(),
            description: "Converts your speech into text.".to_string(),
            default_binding: default_shortcut.to_string(),
            current_binding: default_shortcut.to_string(),
        },
    );
    #[cfg(target_os = "windows")]
    let default_post_process_shortcut = "ctrl+shift+space";
    #[cfg(target_os = "macos")]
    let default_post_process_shortcut = "option+shift+space";
    #[cfg(target_os = "linux")]
    let default_post_process_shortcut = "ctrl+shift+space";
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let default_post_process_shortcut = "alt+shift+space";

    bindings.insert(
        "transcribe_with_post_process".to_string(),
        ShortcutBinding {
            id: "transcribe_with_post_process".to_string(),
            name: "Transcribe with Post-Processing".to_string(),
            description: "Converts your speech into text and applies AI post-processing."
                .to_string(),
            default_binding: default_post_process_shortcut.to_string(),
            current_binding: default_post_process_shortcut.to_string(),
        },
    );
    bindings.insert(
        "transforms".to_string(),
        ShortcutBinding {
            id: "transforms".to_string(),
            name: "Transform Selection".to_string(),
            description: "Rewrites the selected text with the configured LLM.".to_string(),
            default_binding: "LCtrl+LShift+T".to_string(),
            current_binding: "LCtrl+LShift+T".to_string(),
        },
    );
    bindings.insert(
        "cancel".to_string(),
        ShortcutBinding {
            id: "cancel".to_string(),
            name: "Cancel".to_string(),
            description: "Cancels the active dictation session.".to_string(),
            default_binding: "escape".to_string(),
            current_binding: "escape".to_string(),
        },
    );
    // WinSTT-tree hotkeys: their accelerator SOURCE OF TRUTH lives in the WinSTT
    // settings tree (`tts.hotkey`, `general.repasteHotkey`) — like `transforms`
    // (`llm.transforms.hotkey`). These rows exist so `change_binding` / `reset_binding`
    // can resolve a default, but they are NEVER registered by the init loops (which
    // would parse the raw WinSTT key names — `LMeta` is unknown to handy-keys). They
    // are armed exclusively through `shortcut::reconcile_winstt_hotkeys`, which routes
    // every accelerator through `winstt_accel_to_handy` and gates on the feature flag.
    bindings.insert(
        "read_aloud".to_string(),
        ShortcutBinding {
            id: "read_aloud".to_string(),
            name: "Read Selection Aloud".to_string(),
            description: "Speaks the currently selected text using TTS.".to_string(),
            default_binding: "LCtrl+Space".to_string(),
            current_binding: "LCtrl+Space".to_string(),
        },
    );
    bindings.insert(
        "repaste".to_string(),
        ShortcutBinding {
            id: "repaste".to_string(),
            name: "Re-paste Last Transcription".to_string(),
            description: "Pastes the most recent transcription again.".to_string(),
            default_binding: "LCtrl+LShift+V".to_string(),
            current_binding: "LCtrl+LShift+V".to_string(),
        },
    );

    AppSettings {
        bindings,
        audio_feedback: false,
        audio_feedback_volume: default_audio_feedback_volume(),
        sound_theme: default_sound_theme(),
        update_checks_enabled: default_update_checks_enabled(),
        selected_model: "".to_string(),
        selected_microphone: None,
        clamshell_microphone: None,
        selected_output_device: None,
        translate_to_english: false,
        selected_language: "auto".to_string(),
        overlay_position: default_overlay_position(),
        debug_mode: false,
        log_level: default_log_level(),
        custom_words: Vec::new(),
        model_unload_timeout: ModelUnloadTimeout::default(),
        word_correction_threshold: default_word_correction_threshold(),
        paste_method: PasteMethod::default(),
        clipboard_handling: ClipboardHandling::default(),
        auto_submit: default_auto_submit(),
        auto_submit_key: AutoSubmitKey::default(),
        post_process_enabled: default_post_process_enabled(),
        post_process_provider_id: default_post_process_provider_id(),
        post_process_providers: default_post_process_providers(),
        post_process_api_keys: default_post_process_api_keys(),
        post_process_models: default_post_process_models(),
        post_process_prompts: default_post_process_prompts(),
        post_process_selected_prompt_id: None,
        mute_while_recording: false,
        append_trailing_space: false,
        app_language: default_app_language(),
        experimental_enabled: false,
        keyboard_implementation: KeyboardImplementation::default(),
        show_tray_icon: default_show_tray_icon(),
        paste_delay_ms: default_paste_delay_ms(),
        typing_tool: default_typing_tool(),
        external_script_path: None,
        whisper_accelerator: WhisperAcceleratorSetting::default(),
        ort_accelerator: OrtAcceleratorSetting::default(),
        whisper_gpu_device: default_whisper_gpu_device(),
    }
}

impl AppSettings {
    pub fn active_post_process_provider(&self) -> Option<&PostProcessProvider> {
        self.post_process_providers
            .iter()
            .find(|provider| provider.id == self.post_process_provider_id)
    }
}

/// Read the LEGACY `settings_store.json` `AppSettings` blob directly, WITHOUT
/// touching the WinSTT store. Returns `None` when the legacy file is absent or
/// the `settings` key can't be parsed. Used exactly once by the single-store
/// migration in `winstt::commands::settings::seed_defaults` to seed the embedded
/// `WinsttSettings.core` from a pre-migration install. Secrets in the returned
/// value are plaintext (the legacy store never sealed them); the migration seals
/// them on write.
pub fn load_legacy_app_settings(app: &AppHandle) -> Option<AppSettings> {
    let store = app
        .store(crate::portable::store_path(SETTINGS_STORE_PATH))
        .ok()?;
    let value = store.get("settings")?;
    match serde_json::from_value::<AppSettings>(value) {
        Ok(mut settings) => {
            // Backfill any bindings / providers added since the legacy store was last
            // written so the migrated `core` is complete.
            let default_settings = get_default_settings();
            for (key, binding) in default_settings.bindings {
                settings.bindings.entry(key).or_insert(binding);
            }
            ensure_post_process_defaults(&mut settings);
            Some(settings)
        }
        Err(e) => {
            warn!("Failed to parse legacy settings_store.json: {}", e);
            None
        }
    }
}

/// SINGLE-STORE BRIDGE: `AppSettings` is no longer a separately-persisted file —
/// it is a derived view over `WinsttSettings.core` (persisted in
/// `winstt-settings.json`). This reads the embedded `core`, backfills any newly
/// added default bindings / post-process providers (the merge the old loader did),
/// and returns it with secrets OPENED (the WinSTT read path decrypts them).
pub fn load_or_create_app_settings(app: &AppHandle) -> AppSettings {
    // The WinSTT store is seeded/migrated in lib.rs setup before this runs; reading
    // it here also tolerates a not-yet-seeded store (defaults).
    get_settings(app)
}

pub fn get_settings(app: &AppHandle) -> AppSettings {
    // `read_settings` opens the secret fields (incl. the embedded post-process API
    // keys), so the returned `core` is plaintext — exactly what every legacy reader
    // expects from the old store.
    let mut settings = crate::winstt::commands::settings::read_settings(app).core;
    let default_settings = get_default_settings();
    let mut updated = false;
    for (key, binding) in default_settings.bindings {
        if let std::collections::hash_map::Entry::Vacant(entry) =
            settings.bindings.entry(key.clone())
        {
            debug!("Adding missing binding: {}", key);
            entry.insert(binding);
            updated = true;
        }
    }
    if ensure_post_process_defaults(&mut settings) {
        updated = true;
    }
    if updated {
        // Persist the backfilled bindings / providers back into the single store so
        // the merge isn't recomputed on every read.
        write_settings(app, settings.clone());
    }
    settings
}

pub fn write_settings(app: &AppHandle, settings: AppSettings) {
    // Route the mutation back into the single store: read the current WinSTT tree
    // (raw — secrets still sealed so we don't re-seal already-sealed string secrets),
    // graft the new `core` on, re-seal, and persist. We open+reseal here via the
    // WinSTT persistence API so the embedded post-process API keys land encrypted.
    if let Err(e) = crate::winstt::commands::settings::write_core_settings(app, settings) {
        warn!("Failed to persist settings to disk: {}", e);
    }
}

pub fn get_bindings(app: &AppHandle) -> HashMap<String, ShortcutBinding> {
    let settings = get_settings(app);

    settings.bindings
}

pub fn get_stored_binding(app: &AppHandle, id: &str) -> ShortcutBinding {
    let bindings = get_bindings(app);

    // Fall back to a benign empty binding when `id` is absent from the persisted store
    // (e.g. a newly-added binding whose default predates the user's settings_store.json).
    // The previous `.unwrap()` here panicked the whole app at startup in that case.
    bindings
        .get(id)
        .cloned()
        .unwrap_or_else(|| ShortcutBinding {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            default_binding: String::new(),
            current_binding: String::new(),
        })
}

#[cfg(test)]
mod tests {
    use super::super::types::SecretMap;
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn default_settings_disable_auto_submit() {
        let settings = get_default_settings();
        assert!(!settings.auto_submit);
        assert_eq!(settings.auto_submit_key, AutoSubmitKey::Enter);
    }

    #[test]
    fn debug_output_redacts_api_keys() {
        let mut settings = get_default_settings();
        settings
            .post_process_api_keys
            .insert("openai".to_string(), "sk-proj-secret-key-12345".to_string());
        settings.post_process_api_keys.insert(
            "anthropic".to_string(),
            "sk-ant-secret-key-67890".to_string(),
        );
        settings
            .post_process_api_keys
            .insert("empty_provider".to_string(), "".to_string());

        let debug_output = format!("{:?}", settings);

        assert!(!debug_output.contains("sk-proj-secret-key-12345"));
        assert!(!debug_output.contains("sk-ant-secret-key-67890"));
        assert!(debug_output.contains("[REDACTED]"));
    }

    #[test]
    fn secret_map_debug_redacts_values() {
        let map = SecretMap::new(HashMap::from([("key".into(), "secret".into())]));
        let out = format!("{:?}", map);
        assert!(!out.contains("secret"));
        assert!(out.contains("[REDACTED]"));
    }
}
