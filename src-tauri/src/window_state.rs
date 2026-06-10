//! Main-pill geometry persistence and visibility: store consts, load/save/restore
//! position, monitor-bounds check, show_main_window, permission-onboarding force-show.

use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use crate::commands;
use crate::{splash, winstt};

/// Dedicated store for window geometry persisted across runs. Kept separate from
/// the settings store so it never collides with a user-facing setting and can be
/// cleared independently. Only the MAIN pill is tracked — every secondary window
/// (overlay, settings modal, pickers, …) is positioned dynamically each time.
const WINDOW_STATE_STORE: &str = "window-state.json";
const MAIN_POSITION_KEY: &str = "main_position";

/// Read the persisted main-pill position (physical pixels), if any.
fn load_main_window_position(app: &AppHandle) -> Option<(i32, i32)> {
    use tauri_plugin_store::StoreExt;
    let store = app
        .store(crate::portable::store_path(WINDOW_STATE_STORE))
        .ok()?;
    let value = store.get(MAIN_POSITION_KEY)?;
    let x = value.get("x")?.as_i64()? as i32;
    let y = value.get("y")?.as_i64()? as i32;
    Some((x, y))
}

/// Persist the main-pill position (physical pixels). A plain `set` is enough: the
/// store plugin debounce-saves to disk, so a drag that fires dozens of `Moved`
/// events only writes once after the movement settles, and the graceful-exit
/// flush captures a move made right before quitting.
pub(crate) fn save_main_window_position(app: &AppHandle, x: i32, y: i32) {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(crate::portable::store_path(WINDOW_STATE_STORE)) else {
        return;
    };
    store.set(MAIN_POSITION_KEY, serde_json::json!({ "x": x, "y": y }));
}

/// True if the point `(x, y)` (physical) falls inside any currently-connected
/// monitor. Guards against restoring the pill onto a display that has since been
/// unplugged, which would otherwise strand it off-screen.
fn position_on_any_monitor(window: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    monitors.iter().any(|monitor| {
        let pos = monitor.position();
        let size = monitor.size();
        let right = pos.x + size.width as i32;
        let bottom = pos.y + size.height as i32;
        x >= pos.x && x < right && y >= pos.y && y < bottom
    })
}

/// Restore the saved main-pill position after the window is built. The builder
/// already centered it (the first-run / no-saved-state default); this overrides
/// that with the remembered spot when one exists AND is still on-screen. Runs
/// while the window is still `visible(false)`, so there is no visible jump.
pub(crate) fn restore_main_window_position(app: &AppHandle, window: &tauri::WebviewWindow) {
    let Some((x, y)) = load_main_window_position(app) else {
        return;
    };
    if !position_on_any_monitor(window, x, y) {
        log::info!("Saved main window position ({x}, {y}) is off-screen; keeping it centered.");
        return;
    }
    if let Err(e) = window.set_position(tauri::PhysicalPosition::new(x, y)) {
        log::warn!("Failed to restore main window position: {e}");
    }
}

pub(crate) fn show_main_window(app: &AppHandle) {
    // Hand off from the splash: the real window is about to be visible. Idempotent
    // and a no-op if the page-load handler already closed it (mirrors the reference's
    // showOnce → closeSplashWindow).
    if let Some(main_window) = app.get_webview_window("main") {
        if let Err(e) = main_window.unminimize() {
            log::error!("Failed to unminimize webview window: {}", e);
        }
        if let Err(e) = main_window.show() {
            log::error!("Failed to show webview window: {}", e);
        }
        // Hand off from the splash after the real window is visible, so the
        // splash fade-out runs over a painted renderer instead of blank desktop.
        splash::close_splash_window(app);
        // Force the pill ABOVE every other app's window. On Windows `set_focus()`
        // alone is unreliable when another process owns the foreground
        // (SetForegroundWindow is restricted to the foreground-owning process), so
        // the window comes up *behind* whatever the user was typing into — the
        // reported "doesn't get above the others" bug. Briefly toggling
        // always-on-top reliably raises it; the pill isn't an always-on-top window,
        // so we drop the flag again immediately after.
        #[cfg(target_os = "windows")]
        {
            let _ = main_window.set_always_on_top(true);
            let _ = main_window.set_always_on_top(false);
        }
        if let Err(e) = main_window.set_focus() {
            log::error!("Failed to focus webview window: {}", e);
        }
        #[cfg(target_os = "macos")]
        {
            if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
                log::error!("Failed to set activation policy to Regular: {}", e);
            }
        }
        winstt::commands::windows::schedule_post_startup_prewarm(app);
        return;
    }

    splash::close_splash_window(app);

    let webview_labels = app.webview_windows().keys().cloned().collect::<Vec<_>>();
    log::error!(
        "Main window not found. Webview labels: {:?}",
        webview_labels
    );
}

#[allow(unused_variables)]
pub(crate) fn should_force_show_permissions_window(app: &AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        let status = commands::audio::get_windows_microphone_permission_status();
        if status.supported && status.overall_access == commands::audio::PermissionAccess::Denied {
            log::info!(
                "Windows microphone permissions are denied; forcing main window visible for onboarding"
            );
            return true;
        }
    }

    false
}
