//! Recurring microphone/accessibility permission preflight.
//!
//! Permission state is checked before device-dependent startup work, whenever
//! the main window regains focus, and when the application resumes. A denied
//! permission suspends interactive audio/hotkey/model work and surfaces the
//! existing onboarding window in a focused recovery mode. Once access returns,
//! the deferred runtime is activated and returning users go straight back to
//! the main window; first-run users continue the normal wizard.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};

static PERMISSION_RECOVERY_ACTIVE: AtomicBool = AtomicBool::new(false);
static PREFLIGHT_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PermissionPlatform {
    Macos,
    Windows,
    Other,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PermissionGrantState {
    NotRequired,
    Granted,
    Required,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPreflightStatus {
    pub platform: PermissionPlatform,
    pub microphone: PermissionGrantState,
    pub accessibility: PermissionGrantState,
    pub ready: bool,
}

impl PermissionPreflightStatus {
    fn new(
        platform: PermissionPlatform,
        microphone: PermissionGrantState,
        accessibility: PermissionGrantState,
    ) -> Self {
        Self {
            platform,
            microphone,
            accessibility,
            ready: microphone != PermissionGrantState::Required
                && accessibility != PermissionGrantState::Required,
        }
    }
}

pub fn is_recovery_active() -> bool {
    PERMISSION_RECOVERY_ACTIVE.load(Ordering::Acquire)
}

async fn read_status() -> PermissionPreflightStatus {
    #[cfg(target_os = "macos")]
    {
        let accessibility = tauri_plugin_macos_permissions::check_accessibility_permission().await;
        let microphone = tauri_plugin_macos_permissions::check_microphone_permission().await;
        PermissionPreflightStatus::new(
            PermissionPlatform::Macos,
            if microphone {
                PermissionGrantState::Granted
            } else {
                PermissionGrantState::Required
            },
            if accessibility {
                PermissionGrantState::Granted
            } else {
                PermissionGrantState::Required
            },
        )
    }

    #[cfg(target_os = "windows")]
    {
        let status = crate::commands::audio::get_windows_microphone_permission_status();
        // Windows registry policy can be absent/unknown on older builds and
        // managed machines. Match the OS behavior: only an explicit Deny blocks
        // startup; unknown is allowed to proceed and the real capture path can
        // still report a device-specific failure.
        let microphone = if status.supported
            && status.overall_access == crate::commands::audio::PermissionAccess::Denied
        {
            PermissionGrantState::Required
        } else {
            PermissionGrantState::Granted
        };
        PermissionPreflightStatus::new(
            PermissionPlatform::Windows,
            microphone,
            PermissionGrantState::NotRequired,
        )
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        PermissionPreflightStatus::new(
            PermissionPlatform::Other,
            PermissionGrantState::NotRequired,
            PermissionGrantState::NotRequired,
        )
    }
}

fn apply_status(app: &AppHandle, status: &PermissionPreflightStatus) {
    let onboarded = crate::winstt::commands::settings::read_settings_raw(app)
        .general
        .onboarded;

    if status.ready {
        crate::winstt::audio_device_watcher::install_audio_device_watcher(app);

        // First-run onboarding deliberately keeps the runtime dormant until the
        // wizard reaches its normal activation point. Permission recovery is
        // different: the user is already configured, so restore the exact runtime
        // that was suspended when access disappeared.
        if onboarded && PERMISSION_RECOVERY_ACTIVE.swap(false, Ordering::AcqRel) {
            crate::winstt::commands::onboarding::set_onboarding_active(false);
            crate::bootstrap::state::activate_runtime_after_onboarding(app);
            if let Some(window) = app.get_webview_window("onboarding") {
                let _ = window.hide();
            }
            crate::window_state::show_main_window(app);
            log::info!("[permissions] access restored; interactive runtime resumed");
        }
        return;
    }

    if !crate::winstt::commands::onboarding::is_onboarding_active() {
        crate::bootstrap::state::deactivate_runtime_for_onboarding(app);
    }
    if onboarded {
        let already_recovering = PERMISSION_RECOVERY_ACTIVE.swap(true, Ordering::AcqRel);
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.hide();
        }
        // Do not steal focus back from the OS privacy panel while the recovery
        // UI polls after a request. The first transition owns focus; subsequent
        // denied checks only update state.
        if !already_recovering
            && let Err(err) = crate::winstt::commands::windows::show_onboarding_window_internal(app)
        {
            log::error!("[permissions] failed to show recovery window: {err}");
        }
        if !already_recovering {
            log::warn!("[permissions] required access missing; interactive runtime suspended");
        }
    }
}

/// Establish the startup gate before device watchers, microphone streams, VAD,
/// or model warmups are scheduled. Called once from the deferred startup thread.
pub(crate) fn initialize_startup_gate(app: &AppHandle) -> PermissionPreflightStatus {
    let status = tauri::async_runtime::block_on(read_status());
    let onboarded = crate::winstt::commands::settings::read_settings_raw(app)
        .general
        .onboarded;
    let recovering = onboarded && !status.ready;
    PERMISSION_RECOVERY_ACTIVE.store(recovering, Ordering::Release);
    crate::winstt::commands::onboarding::set_onboarding_active(!onboarded || !status.ready);
    status
}

/// Debounced native lifecycle hook used by focus/resume events. Keeping this in
/// Rust means recurrence still works if a webview was suspended while the app was
/// in the background.
pub(crate) fn schedule_recurring_preflight(app: &AppHandle) {
    if PREFLIGHT_IN_FLIGHT.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let status = read_status().await;
        apply_status(&app, &status);
        PREFLIGHT_IN_FLIGHT.store(false, Ordering::Release);
    });
}

fn authorize_caller(webview: &tauri::WebviewWindow) -> Result<(), String> {
    match webview.label() {
        "main" | "onboarding" => Ok(()),
        label => Err(format!(
            "window '{label}' is not authorized to run the permission preflight"
        )),
    }
}

/// Check current permission state and apply the recovery/runtime transition.
#[tauri::command]
#[specta::specta]
pub async fn permission_run_preflight(
    app: AppHandle,
    webview: tauri::WebviewWindow,
) -> Result<PermissionPreflightStatus, String> {
    authorize_caller(&webview)?;
    let status = read_status().await;
    apply_status(&app, &status);
    Ok(status)
}

/// Ask the OS for microphone access (macOS) or open the relevant privacy panel
/// (Windows), then return the latest non-assumed status.
#[tauri::command]
#[specta::specta]
pub async fn permission_request_microphone(
    app: AppHandle,
    webview: tauri::WebviewWindow,
) -> Result<PermissionPreflightStatus, String> {
    authorize_caller(&webview)?;
    #[cfg(target_os = "macos")]
    tauri_plugin_macos_permissions::request_microphone_permission().await?;
    #[cfg(target_os = "windows")]
    crate::commands::audio::open_microphone_privacy_settings()?;

    let status = read_status().await;
    apply_status(&app, &status);
    Ok(status)
}

/// Ask macOS for accessibility access. Other platforms do not require it.
#[tauri::command]
#[specta::specta]
pub async fn permission_request_accessibility(
    app: AppHandle,
    webview: tauri::WebviewWindow,
) -> Result<PermissionPreflightStatus, String> {
    authorize_caller(&webview)?;
    #[cfg(target_os = "macos")]
    tauri_plugin_macos_permissions::request_accessibility_permission().await;

    let status = read_status().await;
    apply_status(&app, &status);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::{PermissionGrantState, PermissionPlatform, PermissionPreflightStatus};

    #[test]
    fn readiness_requires_every_supported_permission() {
        let blocked = PermissionPreflightStatus::new(
            PermissionPlatform::Macos,
            PermissionGrantState::Granted,
            PermissionGrantState::Required,
        );
        assert!(!blocked.ready);

        let ready = PermissionPreflightStatus::new(
            PermissionPlatform::Windows,
            PermissionGrantState::Granted,
            PermissionGrantState::NotRequired,
        );
        assert!(ready.ready);
    }
}
