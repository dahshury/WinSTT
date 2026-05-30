// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/05_*.md §A + lib_wiring.md §3,
// frontend/electron/ipc/wakeword. Wraps managers::WakeWordManager.
//
// Wake-word commands. set_wake_word rebuilds the detector from the chosen preset
// (or custom phrase) + sensitivity + timeout; list_wake_word_presets feeds the
// renderer dropdown. The detection itself is armed from the audio consumer feed,
// not a command.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::winstt::managers::WakeWordManager;

/// One wake-word preset for the renderer dropdown.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WakeWordPresetPayload {
    pub name: String,
    pub phrase: String,
}

/// `set_wake_word` — reconfigure the wake word. Empty `name` disables it.
#[tauri::command]
#[specta::specta]
pub fn set_wake_word(
    wakeword: State<'_, Arc<WakeWordManager>>,
    name: String,
    sensitivity: f32,
    timeout_seconds: f32,
) -> Result<(), String> {
    wakeword.set_wake_word(&name, sensitivity, timeout_seconds)
}

/// `list_wake_word_presets` — built-in presets for the dropdown.
#[tauri::command]
#[specta::specta]
pub fn list_wake_word_presets(
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
