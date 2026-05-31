// PORT IMPL — WU-12 (app/PORT/10_frontend_port_plan.md §6 WU-12).
//
// `onboarding_finish` — the backend side of WinSTT's first-run wizard
// (`views/onboarding` + `widgets/onboarding-wizard`). Ports the Electron
// `onboarding-window.ts` FINISH handler, which does TWO things the WU-0 stub in
// `windows.rs` omitted:
//
//   1. Persist the MAIN-owned onboarding flags so the wizard never re-opens:
//        general.onboarded      = true
//        general.onboardedAt    = <now ms>
//        general.onboardedTrack = "" | "local" | "cloud"
//      These three live in `winstt::settings_schema::GeneralSettings` and are
//      DELIBERATELY excluded from the renderer's `winstt_set_settings` patch
//      path (`preserve_main_owned_general`), so the wizard's own
//      `useSyncSettings` round-trips can't write them — only this command can.
//   2. Hide the onboarding window and show + focus `main` (the window transition).
//
// It then broadcasts `settings:changed` with the full snapshot, exactly like the
// settings command, so any open window re-hydrates its Zustand store (and the
// renderer's onboarding gate sees `onboarded = true`).
//
// HARD-RULE-safe: NEW file under winstt/commands/. The orchestrator should
// register THIS `onboarding_finish` in `collect_commands![]` IN PLACE OF the
// WU-0 `windows::onboarding_finish` stub (same command name, fuller behavior).
// Reuses the PUBLIC `settings::read_settings` + the same store key/path so there
// is exactly one `winstt_settings` blob.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

use crate::winstt::settings_schema::OnboardedTrack;

/// Store key + relative file the WinSTT settings blob lives under. MUST match
/// `winstt::commands::settings` (single source of truth for the on-disk shape).
const WINSTT_SETTINGS_KEY: &str = "winstt_settings";
const WINSTT_SETTINGS_FILE: &str = "winstt-settings.json";
/// Same `settings:changed` event the settings command emits — byte-identical
/// `{ settings }` shape so the renderer's `onSettingsChanged` needs no changes.
const SETTINGS_CHANGED_EVENT: &str = "settings:changed";

/// Payload the renderer sends when finishing (or skipping) the wizard. Mirrors
/// `OnboardingWizard.handleFinish({ completed, track })`. `track` is the raw
/// string ("" | "local" | "cloud") so the typed-enum mapping happens here.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingFinishArgs {
    pub completed: bool,
    #[serde(default)]
    pub track: String,
}

fn track_from_str(track: &str) -> OnboardedTrack {
    match track {
        "local" => OnboardedTrack::Local,
        "cloud" => OnboardedTrack::Cloud,
        _ => OnboardedTrack::Unset,
    }
}

/// Persist the three main-owned onboarding flags onto the on-disk `general`
/// section without disturbing any other field. Reads the full snapshot, mutates
/// only `general.onboarded*`, writes it back, and returns the snapshot so the
/// caller can broadcast it.
fn mark_onboarded(
    app: &AppHandle,
    track: OnboardedTrack,
) -> Result<serde_json::Value, String> {
    let mut settings = crate::winstt::commands::settings::read_settings(app);
    settings.general.onboarded = true;
    settings.general.onboarded_at = Some(now_ms());
    settings.general.onboarded_track = track;

    let value = serde_json::to_value(&settings).map_err(|e| e.to_string())?;
    let store = app
        .store(crate::portable::store_path(WINSTT_SETTINGS_FILE))
        .map_err(|e| format!("winstt settings store: {e}"))?;
    store.set(WINSTT_SETTINGS_KEY, value.clone());
    store.save().map_err(|e| e.to_string())?;
    Ok(value)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `onboarding_finish` — record the wizard as completed/skipped, broadcast the
/// new settings snapshot, then hide onboarding and surface the main window.
/// Mirrors Electron's `handleFinish` (frontend/electron/ipc/onboarding-window.ts).
#[tauri::command]
#[specta::specta]
pub fn onboarding_finish(app: AppHandle, args: OnboardingFinishArgs) -> Result<(), String> {
    // 1. Persist the main-owned onboarding flags + broadcast the snapshot so any
    //    live window re-hydrates (and the onboarding gate flips closed).
    match mark_onboarded(&app, track_from_str(&args.track)) {
        Ok(snapshot) => {
            let _ = app.emit(SETTINGS_CHANGED_EVENT, serde_json::json!({ "settings": snapshot }));
        }
        Err(e) => {
            // Persistence failure must not strand the user on the wizard window;
            // log via the Err return but still perform the window transition.
            log::error!("onboarding_finish: failed to persist onboarded flags: {e}");
        }
    }

    // 2. Window transition: hide the wizard, show + focus main.
    if let Some(window) = app.get_webview_window("onboarding") {
        let _ = window.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{track_from_str, OnboardedTrack};

    #[test]
    fn maps_track_strings_to_enum() {
        assert_eq!(track_from_str("local"), OnboardedTrack::Local);
        assert_eq!(track_from_str("cloud"), OnboardedTrack::Cloud);
        assert_eq!(track_from_str(""), OnboardedTrack::Unset);
        assert_eq!(track_from_str("garbage"), OnboardedTrack::Unset);
    }
}
