use log::warn;
use std::collections::HashMap;
use tauri::AppHandle;

use super::defaults::*;
use super::types::{
    AppSettings, ClipboardHandling, OrtAcceleratorSetting, PasteMethod, ShortcutBinding,
    WhisperAcceleratorSetting,
};

pub fn get_default_settings() -> AppSettings {
    // Source the transcribe default from the schema constant on EVERY platform so
    // both stores present the same key. The constant is itself platform-specific
    // (`LCtrl+LMeta` on Windows, a full accelerator elsewhere — Tauri's global
    // shortcut backend rejects modifier-only combos). The transcribe binding is
    // ultimately overridden from the WinSTT tree (`hotkey.pushToTalkKey`) at init,
    // but keeping this in agreement avoids a stale/divergent fallback default.
    let default_shortcut = crate::winstt::settings_schema::DEFAULT_PUSH_TO_TALK_KEY;

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
    // would parse the raw WinSTT key names directly). They are armed exclusively through
    // `shortcut::reconcile_winstt_hotkeys`, which routes every accelerator through
    // `winstt_accel_to_tauri` and gates on the feature flag.
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
    bindings.insert(
        "post_processing_profile_swap".to_string(),
        ShortcutBinding {
            id: "post_processing_profile_swap".to_string(),
            name: "Post Processing Profile Swap".to_string(),
            description: "Cycles through saved post-processing profiles.".to_string(),
            default_binding: "LCtrl+LShift+P".to_string(),
            current_binding: "LCtrl+LShift+P".to_string(),
        },
    );

    AppSettings {
        bindings,
        update_checks_enabled: default_update_checks_enabled(),
        selected_output_device: None,
        debug_mode: false,
        log_level: default_log_level(),
        paste_method: PasteMethod::default(),
        clipboard_handling: ClipboardHandling::default(),
        mute_while_recording: false,
        append_trailing_space: false,
        show_tray_icon: default_show_tray_icon(),
        paste_delay_ms: default_paste_delay_ms(),
        typing_tool: default_typing_tool(),
        whisper_accelerator: WhisperAcceleratorSetting::default(),
        ort_accelerator: OrtAcceleratorSetting::default(),
        whisper_gpu_device: default_whisper_gpu_device(),
    }
}

pub fn get_settings(app: &AppHandle) -> AppSettings {
    crate::winstt::commands::settings::read_settings(app).core
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
    // (for example, a caller requesting an unknown binding id).
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
