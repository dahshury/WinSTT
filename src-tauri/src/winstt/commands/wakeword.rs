// Wraps managers::WakeWordManager.
//
// Wake-word commands. wakeword_set_model rebuilds the detector from the chosen preset
// (or custom phrase) + sensitivity + timeout; wakeword_list_presets feeds the
// renderer dropdown. The detection itself is armed from the audio consumer feed,
// not a command.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::winstt::managers::{WakeWordManager, WakeWordModelStatusPayload};

/// One wake-word preset for the renderer dropdown.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WakeWordPresetPayload {
    pub name: String,
    pub phrase: String,
}

/// `wakeword_set_model` — reconfigure the wake word. Empty `name` disables it.
#[tauri::command]
#[specta::specta]
pub fn wakeword_set_model(
    wakeword: State<'_, Arc<WakeWordManager>>,
    name: String,
    sensitivity: f32,
    timeout_seconds: f32,
) -> Result<(), String> {
    wakeword.set_wake_word(&name, sensitivity, timeout_seconds)
}

/// `wakeword_list_presets` — built-in presets for the dropdown.
#[tauri::command]
#[specta::specta]
pub fn wakeword_list_presets(
    wakeword: State<'_, Arc<WakeWordManager>>,
) -> Vec<WakeWordPresetPayload> {
    wakeword
        .list_presets()
        .into_iter()
        .map(|p| WakeWordPresetPayload {
            name: p.name,
            phrase: p.phrase,
        })
        .collect()
}

#[tauri::command]
#[specta::specta]
pub fn wakeword_model_status(
    wakeword: State<'_, Arc<WakeWordManager>>,
) -> WakeWordModelStatusPayload {
    wakeword.sync_selection_from_settings();
    wakeword.model_status()
}

#[tauri::command]
#[specta::specta]
pub fn wakeword_start_model_download(
    wakeword: State<'_, Arc<WakeWordManager>>,
) -> WakeWordModelStatusPayload {
    wakeword.sync_selection_from_settings();
    let _ = wakeword.start_model_bundle_download_if_missing();
    wakeword.model_status()
}

#[tauri::command]
#[specta::specta]
pub fn wakeword_pause_model_download(
    wakeword: State<'_, Arc<WakeWordManager>>,
) -> WakeWordModelStatusPayload {
    wakeword.pause_model_bundle_download()
}

#[tauri::command]
#[specta::specta]
pub fn wakeword_resume_model_download(
    wakeword: State<'_, Arc<WakeWordManager>>,
) -> WakeWordModelStatusPayload {
    wakeword.sync_selection_from_settings();
    wakeword.resume_model_bundle_download()
}

#[tauri::command]
#[specta::specta]
pub fn wakeword_cancel_model_download(
    wakeword: State<'_, Arc<WakeWordManager>>,
) -> WakeWordModelStatusPayload {
    wakeword.sync_selection_from_settings();
    wakeword.cancel_model_bundle_download()
}
