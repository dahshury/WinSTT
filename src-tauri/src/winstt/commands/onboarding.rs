// `onboarding_finish` — the backend side of WinSTT's first-run wizard
// (`views/onboarding` + `widgets/onboarding-wizard`). Ports the reference
// `onboarding-window.ts` FINISH handler:
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
// Reuses `settings::read_settings` + the same store key/path so there is exactly
// one `winstt_settings` blob.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

use crate::winstt::commands::settings::{
    SETTINGS_CHANGED_EVENT, WINSTT_SETTINGS_FILE, WINSTT_SETTINGS_KEY,
};
use crate::winstt::settings_schema::OnboardedTrack;

/// While the first-run wizard owns the launch, the app stays MODEL-FREE: the boot
/// STT load + warmup, the LLM/TTS/encoder background warmups, the settings-driven
/// warm/load side-effects, and wakeword arming are all held back. The user
/// shouldn't pay to load (or keep resident) a local model they may be about to
/// replace with a cloud provider — and choosing cloud should leave nothing local
/// loaded. Set at startup from the same predicate that opens the wizard window
/// (`should_show_onboarding`); cleared by `onboarding_finish`, which then runs the
/// deferred warmups via `warm_models_after_onboarding`.
static ONBOARDING_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Mark the onboarding gate active (true while the wizard owns the launch).
pub fn set_onboarding_active(active: bool) {
    ONBOARDING_ACTIVE.store(active, Ordering::SeqCst);
}

/// True while onboarding is in progress — model load/warmup paths consult this to
/// stay dormant until the user has configured a local or cloud model.
pub fn is_onboarding_active() -> bool {
    ONBOARDING_ACTIVE.load(Ordering::SeqCst)
}

/// True while the first-run wizard window is up (created AND visible). Distinct
/// from `is_onboarding_active`, which the recording-mode demo lifts early to enable
/// dictation — this stays true until `onboarding_finish` HIDES the window. Used to
/// gate the main-window / settings entry points so the wizard can't be bypassed via
/// the tray or a renderer command. It keys off the live window instead of the
/// persisted `onboarded` flag.
/// `onboarding_finish` hides the wizard BEFORE it shows the main window, so the
/// completion path is never blocked by this check.
pub fn is_onboarding_in_progress(app: &AppHandle) -> bool {
    app.get_webview_window("onboarding")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

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
fn mark_onboarded(app: &AppHandle, track: OnboardedTrack) -> Result<serde_json::Value, String> {
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
        .map_or(0, |d| d.as_millis() as i64)
}

/// `onboarding_finish` — record the wizard as completed/skipped, broadcast the
/// new settings snapshot, then hide onboarding and surface the main window.
#[tauri::command]
#[specta::specta]
pub fn onboarding_finish(app: AppHandle, args: OnboardingFinishArgs) -> Result<(), String> {
    // 1. Persist the main-owned onboarding flags + broadcast the snapshot so any
    //    live window re-hydrates (and the onboarding gate flips closed).
    match mark_onboarded(&app, track_from_str(&args.track)) {
        Ok(snapshot) => {
            let _ = app.emit(
                SETTINGS_CHANGED_EVENT,
                serde_json::json!({ "settings": snapshot }),
            );
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
    crate::window_state::show_main_window(&app);

    // 3. Onboarding is over (finished OR closed): lift the model gate and warm what
    //    the user configured. A cloud track frees any resident local engine and
    //    needs no local load; a local track loads + warms the selected model. This
    //    also fires the TTS/encoder/LLM background warmups and wakeword arming that
    //    were held back while the wizard was open.
    set_onboarding_active(false);
    crate::bootstrap::state::activate_runtime_after_onboarding(&app);
    Ok(())
}

/// `onboarding_enable_dictation` — light up the real dictation runtime DURING the
/// wizard so the recording-mode step can offer a live "press the hotkey and speak"
/// demo. By this point the user has chosen a model (local pick or cloud keys) and
/// tested their mic, so this is a deliberate, user-reached enable — not the boot
/// auto-warmup the model-free gate exists to suppress. Lifts the gate and activates
/// the runtime (loads + warms the configured model, arms the global hotkey, inits
/// the paste pipeline). Idempotent: once the gate is down, re-entering the step
/// no-ops. `onboarding_finish` still runs its own activation, which is then a cheap
/// no-op because everything is already live.
#[tauri::command]
#[specta::specta]
pub fn onboarding_enable_dictation(app: AppHandle) -> Result<(), String> {
    if !is_onboarding_active() {
        return Ok(());
    }
    set_onboarding_active(false);
    crate::bootstrap::state::activate_runtime_after_onboarding(&app);
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
