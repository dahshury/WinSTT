// Startup splash window — ported 1:1 from the Electron in-app splash
// (frontend/electron/lib/splash-window.ts + splash-html.ts).
//
// Why this exists: the Tauri main pill is created `visible(false)` in lib.rs
// setup and only `show()`n after `initialize_core_logic` + `prewarm_windows`
// (which eagerly builds the 8 secondary WebView2 windows) + Enigo init run on
// the main thread. That setup costs a noticeable beat on cold start during which
// the user sees nothing — exactly the gap the Electron app covered with an
// in-process splash BrowserWindow (the NSIS `portable.splashImage` BMP was
// extraction-only + unreliable; see memory project_portable_splash_inapp_window).
//
// Design (matches the Electron splash exactly):
//   - 300×320 frameless, transparent, always-on-top, skip-taskbar, NOT focusable
//     (never steals focus), click-through (set_ignore_cursor_events), no native
//     shadow (the card draws its own), centered on the primary display.
//   - Loads the static `splash.html` shipped in `public/` (→ dist root). Pure
//     HTML/CSS, no React entry, no IPC surface — paints in one frame. It pulls
//     the brand mark from `/icon.png` (same app asset the renderer uses).
//   - Created the instant setup starts; closed when the main window's page
//     finishes loading (on_page_load Finished in lib.rs), with a hard backstop
//     timeout so a broken boot can never strand a click-through window on screen.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Splash window label. Not in the WINDOW_SPECS table (windows.rs) because it is
/// a transient startup-only window with no IPC and no lazy `open_window` path.
pub const SPLASH_LABEL: &str = "splash";

/// Hard backstop: the main window's `on_page_load` Finished normally closes the
/// splash within ~1–2 s, but if the main page never loads (broken boot) a
/// click-through always-on-top window would otherwise stay on screen forever.
/// Mirrors the Electron `SPLASH_MAX_LIFETIME_MS`.
const SPLASH_MAX_LIFETIME_MS: u64 = 30_000;

/// Create + show the splash immediately. Idempotent — a second call while one is
/// already up is a no-op (mirrors Electron `createSplashWindow`).
pub fn create_splash_window(app: &AppHandle) {
    if app.get_webview_window(SPLASH_LABEL).is_some() {
        return;
    }

    let mut builder =
        WebviewWindowBuilder::new(app, SPLASH_LABEL, WebviewUrl::App("splash.html".into()))
            .title("WinSTT")
            .inner_size(300.0, 320.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .closable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            // Never steal focus from whatever the user is doing (pairs with the
            // click-through below). Matches Electron `focusable: false`.
            .focused(false)
            // The card draws its own shadow; DWM's rectangular shadow around the
            // transparent bounds would be visible noise (same as the overlay).
            .shadow(false)
            // Center on the primary display (Electron `center: true`).
            .center()
            .visible(false);

    // CRITICAL: share the ONE WebView2 user-data folder every other window uses
    // (portable mode). A second webview requesting a DIFFERENT folder silently
    // fails to load its content. See windows.rs ensure_window.
    if let Some(data_dir) = crate::portable::data_dir() {
        builder = builder.data_directory(data_dir.join("webview"));
    }

    match builder.build() {
        Ok(window) => {
            // Purely decorative — never trap a click. The transparent margin
            // around the card would otherwise swallow clicks aimed at whatever
            // is behind it (Electron `setIgnoreMouseEvents(true)`).
            let _ = window.set_ignore_cursor_events(true);
            // Show WITHOUT activating (we built it unfocused + the renderer pill
            // should grab focus, not the splash).
            let _ = window.show();
            let _ = window.set_always_on_top(true);
            log::info!("[splash] shown");

            // Hard backstop — drop the splash after SPLASH_MAX_LIFETIME_MS even if
            // the main window never reports a page load.
            let app_for_timeout = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(SPLASH_MAX_LIFETIME_MS));
                close_splash_window(&app_for_timeout);
            });
        }
        Err(e) => log::warn!("[splash] failed to create: {e}"),
    }
}

/// Tear the splash down. Idempotent and safe to call when none is open (mirrors
/// Electron `closeSplashWindow`). Uses `destroy()` NOT `close()`: the app's global
/// `on_window_event` handler intercepts `CloseRequested` for every non-`main` window
/// and downgrades it to `prevent_close()` + `hide()` — so `close()` would leave the
/// splash alive (hidden, holding a WebView2 instance) for the whole session.
/// `destroy()` force-removes it without emitting `CloseRequested`.
pub fn close_splash_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SPLASH_LABEL) {
        if let Err(e) = window.destroy() {
            log::warn!("[splash] destroy failed: {e}");
        } else {
            log::info!("[splash] destroyed");
        }
    }
}
