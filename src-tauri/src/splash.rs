// Startup splash window — ported 1:1 from the reference in-app splash
// (frontend/electron/lib/splash-window.ts + splash-html.ts).
//
// Why this exists: the Tauri main pill is created `visible(false)` in lib.rs
// setup and only `show()`n after `initialize_core_logic` + `prewarm_windows`
// (which eagerly builds the 8 secondary WebView2 windows) + Enigo init run on
// the main thread. That setup costs a noticeable beat on cold start during which
// the user sees nothing — exactly the gap the reference app covered with an
// in-process splash BrowserWindow (the NSIS `portable.splashImage` BMP was
// extraction-only + unreliable; see memory project_portable_splash_inapp_window).
//
// Design (matches the reference splash exactly):
//   - 300×320 frameless, transparent, always-on-top, skip-taskbar, NOT focusable
//     (never steals focus), click-through (set_ignore_cursor_events), no native
//     shadow (the card draws its own), centered on the primary display.
//   - Loads the static `splash.html` shipped in `public/` (→ dist root). Pure
//     HTML/CSS, no React entry, no IPC surface — paints in one frame. It pulls
//     the brand mark from `/icon.png` (same app asset the renderer uses).
//   - Created the instant setup starts; kept up by a ready-watcher (spawn_ready_watcher)
//     until the app is genuinely ready — the renderer has painted (on_page_load
//     Finished → mark_renderer_painted) AND the STT engine has finished its boot
//     load+warm (mark_stt_boot_done) — then handed off to the real window, with a
//     READY_TIMEOUT_MS fallback and a SPLASH_MAX_LIFETIME_MS hard backstop so a
//     broken boot can never strand a click-through window on screen. This mirrors
//     the reference's `showOnce` (did-finish-load + server-ready, 15 s fallback);
//     it must NOT be closed synchronously during setup (that flashed a blank pill).

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Splash window label. Not in the WINDOW_SPECS table (windows.rs) because it is
/// a transient startup-only window with no IPC and no lazy `open_window` path.
pub const SPLASH_LABEL: &str = "splash";

/// Hard backstop: the ready-watcher normally hands off to the real window within a
/// few seconds, but if the main page never loads (broken boot) a click-through
/// always-on-top window would otherwise stay on screen forever. Mirrors the
/// reference `SPLASH_MAX_LIFETIME_MS`.
const SPLASH_MAX_LIFETIME_MS: u64 = 60_000;

/// How long the ready-watcher waits for full renderer/backend readiness before
/// giving up and showing the window anyway. Mirrors the reference app's startup
/// fallback and stays well below `SPLASH_MAX_LIFETIME_MS` so the hard backstop
/// never wins the handoff race.
const READY_TIMEOUT_MS: u64 = 15_000;
const SPLASH_CLOSE_ANIMATION_MS: u64 = 180;

/// Set once the MAIN window's renderer reports `on_page_load(Finished)` — i.e. the
/// React pill has actually painted ("the application fully loads"). The single
/// source the ready-watcher polls; the reference gates its `showOnce` on the
/// equivalent Electron `did-finish-load`.
static RENDERER_PAINTED: AtomicBool = AtomicBool::new(false);

/// Set once the MAIN React tree has mounted and completed its first critical IPC
/// round trips. `on_page_load(Finished)` only proves that WebView loaded the HTML;
/// it can fire before the actual app providers have loaded settings/devices.
static RENDERER_BOOT_DONE: AtomicBool = AtomicBool::new(false);

/// Set once the boot STT thread (`initiate_model_load` + `warmup`, spawned in
/// `initialize_core_logic`) finishes — i.e. the engine is loaded + warm, OR there
/// was nothing to load (cloud id / first run with no model / load failed; `warmup`
/// returns promptly in all of those). The single-process analog of the reference's
/// `server-ready` event ("the backend is up and warm").
static STT_BOOT_DONE: AtomicBool = AtomicBool::new(false);

/// Guards the tiny CSS fade-out delay so repeated handoff/backstop calls don't
/// spawn duplicate destroy timers against the same transient window.
static SPLASH_CLOSING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug)]
struct ReadySnapshot {
    renderer_painted: bool,
    renderer_boot_done: bool,
    stt_boot_done: bool,
}

impl ReadySnapshot {
    fn renderer_ready(self) -> bool {
        self.renderer_painted && self.renderer_boot_done
    }
}

fn ready_snapshot() -> ReadySnapshot {
    ReadySnapshot {
        renderer_painted: RENDERER_PAINTED.load(Ordering::SeqCst),
        renderer_boot_done: RENDERER_BOOT_DONE.load(Ordering::SeqCst),
        stt_boot_done: STT_BOOT_DONE.load(Ordering::SeqCst),
    }
}

fn reload_main_renderer(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(e) = window.eval("window.location.reload();") {
        log::warn!("[splash] main renderer recovery reload failed: {e}");
    } else {
        log::warn!("[splash] main renderer recovery reload requested");
    }
}

/// Record that the main renderer has painted. Called from the main window's
/// `on_page_load(Finished)` handler. Idempotent.
pub fn mark_renderer_painted() {
    RENDERER_PAINTED.store(true, Ordering::SeqCst);
}

/// Record that the main renderer finished its first bootstrap pass. Called by
/// `winstt_emit_ready` after the renderer has primed startup IPC state.
/// Idempotent.
pub fn mark_renderer_boot_done() {
    RENDERER_BOOT_DONE.store(true, Ordering::SeqCst);
}

/// Record that the STT engine has finished its boot load+warm (or had nothing to
/// load). Called at the tail of the boot thread in `initialize_core_logic`.
/// Idempotent.
pub fn mark_stt_boot_done() {
    STT_BOOT_DONE.store(true, Ordering::SeqCst);
}

/// Whether a splash window currently exists. Used by the setup hook to decide
/// between the ready-watcher hand-off and an immediate show (no splash was created
/// when launching straight to the tray via the `--start-hidden` CLI flag).
pub fn is_active(app: &AppHandle) -> bool {
    app.get_webview_window(SPLASH_LABEL).is_some()
}

/// Keep the splash up until the app is genuinely READY, then hand off to the real
/// window — the single-process analog of the reference's `showOnce`, which gates the
/// main window's first show on `did-finish-load` + `server-ready` (15 s fallback).
///
/// Why this exists: the previous code called `show_main_window` (which closes the
/// splash) synchronously inside `setup`, before the event loop pumped — so the
/// splash was torn down at the very start of boot, before the renderer painted and
/// long before the engine warmed, flashing a blank pill. This watcher waits off the
/// main thread for renderer paint, renderer boot, and STT boot signals (or the
/// timeout) and only then shows the pill.
///
/// `show_window`: `true` for a normal/visible launch (show the pill + close the
/// splash once ready); `false` when launching straight to the tray (start-hidden) —
/// we only drop the splash once the hidden renderer has painted, never showing a
/// window. In the start-hidden case the STT boot is irrelevant (no window to warm
/// behind), so we wait on the paint signal alone.
pub fn spawn_ready_watcher(app: &AppHandle, show_window: bool) {
    let app = app.clone();
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        let deadline = std::time::Duration::from_millis(READY_TIMEOUT_MS);
        let mut snapshot;
        let timed_out;
        loop {
            snapshot = ready_snapshot();
            // STT boot only matters when a window will actually appear (so the user's
            // first dictation is warm behind the still-covered splash). With no
            // window, renderer readiness alone is enough to drop the splash.
            let stt_ready = !show_window || snapshot.stt_boot_done;
            if snapshot.renderer_ready() && stt_ready {
                timed_out = false;
                break;
            }
            if start.elapsed() >= deadline {
                timed_out = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        if timed_out {
            log::warn!(
                "[splash] ready-watcher timed out after {READY_TIMEOUT_MS}ms; renderer_painted={}, renderer_boot_done={}, stt_boot_done={}",
                snapshot.renderer_painted,
                snapshot.renderer_boot_done,
                snapshot.stt_boot_done
            );
        }
        let recover_renderer = show_window && timed_out && !snapshot.renderer_ready();
        // Window ops must run on the main thread on Windows; the event loop is live
        // by now (paint/timeout can only happen after `setup` returns).
        let app_for_main = app.clone();
        let res = app.run_on_main_thread(move || {
            if show_window {
                // Shows the main pill AND closes the splash (the handoff).
                crate::show_main_window(&app_for_main);
                if recover_renderer {
                    reload_main_renderer(&app_for_main);
                }
            } else {
                close_splash_window(&app_for_main);
            }
        });
        if let Err(e) = res {
            log::warn!("[splash] ready-watcher failed to dispatch to main thread: {e}");
        }
    });
}

/// Create + show the splash immediately. Idempotent — a second call while one is
/// already up is a no-op (mirrors the reference `createSplashWindow`).
pub fn create_splash_window(app: &AppHandle) {
    if app.get_webview_window(SPLASH_LABEL).is_some() {
        return;
    }
    SPLASH_CLOSING.store(false, Ordering::SeqCst);

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
            // click-through below). Matches the reference `focusable: false`.
            .focused(false)
            // The card draws its own shadow; DWM's rectangular shadow around the
            // transparent bounds would be visible noise (same as the overlay).
            .shadow(false)
            // Center on the primary display (the reference `center: true`).
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
            // is behind it (the reference `setIgnoreMouseEvents(true)`).
            #[cfg(not(target_os = "linux"))]
            let _ = window.set_ignore_cursor_events(true);
            // Show WITHOUT activating (we built it unfocused + the renderer pill
            // should grab focus, not the splash).
            let _ = window.show();
            // Tao's Linux backend can receive the cursor-ignore request before GTK
            // has realized the native window if it is sent before `show()`.
            #[cfg(target_os = "linux")]
            let _ = window.set_ignore_cursor_events(true);
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
/// the reference `closeSplashWindow`). Uses `destroy()` NOT `close()`: the app's global
/// `on_window_event` handler intercepts `CloseRequested` for every non-`main` window
/// and downgrades it to `prevent_close()` + `hide()` — so `close()` would leave the
/// splash alive (hidden, holding a WebView2 instance) for the whole session.
/// `destroy()` force-removes it without emitting `CloseRequested`.
pub fn close_splash_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SPLASH_LABEL) {
        if SPLASH_CLOSING.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Err(e) = window.eval("document.body.classList.add('is-closing');") {
            log::warn!("[splash] close animation eval failed: {e}");
        }
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(SPLASH_CLOSE_ANIMATION_MS));
            if let Err(e) = window.destroy() {
                log::warn!("[splash] destroy failed: {e}");
                SPLASH_CLOSING.store(false, Ordering::SeqCst);
            } else {
                log::info!("[splash] destroyed");
                SPLASH_CLOSING.store(false, Ordering::SeqCst);
            }
        });
    }
}
