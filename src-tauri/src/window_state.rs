//! Main-pill geometry persistence and visibility: store consts, load/save/restore
//! position, monitor-bounds check, show_main_window, permission-onboarding force-show.

use tauri::{AppHandle, Manager};

use crate::splash;

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
    show_main_window_with_restore(app, false);
}

/// Reveal the main pill from a system-tray interaction.
///
/// Tauri reveals hidden Windows windows with `ShowWindow(SW_SHOW)`, which skips
/// the shell's restore semantics. Tray restores use `SW_RESTORE` instead so the
/// operating system owns the transition and its timing. Other lifecycle reveals
/// (startup/splash, onboarding) keep their existing handoff behavior.
pub(crate) fn show_main_window_from_tray(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let app_handle = app.clone();
        let fallback_app = app.clone();
        if let Err(e) = app.run_on_main_thread(move || {
            show_main_window_with_restore(&app_handle, true);
        }) {
            log::warn!("Failed to schedule the native tray restore: {e}");
            show_main_window_with_restore(&fallback_app, false);
        }
    }

    #[cfg(not(target_os = "windows"))]
    show_main_window_with_restore(app, false);
}

fn show_main_window_with_restore(app: &AppHandle, restore_from_tray: bool) {
    // Hand off from the splash: the real window is about to be visible. Idempotent
    // and a no-op if the page-load handler already closed it (mirrors the reference's
    // showOnce → closeSplashWindow).
    if let Some(main_window) = app.get_webview_window("main") {
        if let Err(e) = main_window.unminimize() {
            log::error!("Failed to unminimize webview window: {}", e);
        }
        show_main_window_surface(&main_window, restore_from_tray);
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
        return;
    }

    splash::close_splash_window(app);

    let webview_labels = app.webview_windows().keys().cloned().collect::<Vec<_>>();
    log::error!(
        "Main window not found. Webview labels: {:?}",
        webview_labels
    );
}

fn show_main_window_surface(
    main_window: &tauri::WebviewWindow,
    #[allow(unused_variables)] restore_from_tray: bool,
) {
    #[cfg(target_os = "windows")]
    if restore_from_tray && !main_window.is_visible().unwrap_or(false) {
        use windows::Win32::UI::WindowsAndMessaging::{SW_RESTORE, ShowWindow};

        if let Ok(hwnd) = main_window.hwnd() {
            // SAFETY: `show_main_window_from_tray` dispatches this function to
            // Tauri's main thread, which owns the top-level HWND. SW_RESTORE lets
            // Windows/DWM apply the user's native window-transition policy.
            unsafe {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }

            // The native call bypasses Tao's cached WindowFlags. Synchronize the
            // framework after the HWND is already visible; its SW_SHOW is then an
            // idempotent state update rather than a second transition.
            if let Err(e) = main_window.show() {
                log::error!("Failed to synchronize restored window visibility: {e}");
            }
            return;
        }
        log::warn!("Could not access the native main window; falling back to Tauri show");
    }

    if let Err(e) = main_window.show() {
        log::error!("Failed to show webview window: {}", e);
    }
}
