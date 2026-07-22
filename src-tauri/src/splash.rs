// Startup splash window.
//
// Why this exists: the Tauri main pill is created `visible(false)` in lib.rs
// setup and shown only after core initialization and the renderer-ready
// handshake. That setup costs a noticeable beat on cold start during which the
// user sees nothing — exactly the gap the reference app covered with an
// in-process splash BrowserWindow (the NSIS `portable.splashImage` BMP was
// extraction-only + unreliable; see memory project_portable_splash_inapp_window).
//
// Design (matches the reference splash exactly):
//   - 196×196 frameless, transparent, always-on-top, skip-taskbar, NOT focusable
//     (never steals focus), click-through (set_ignore_cursor_events), no native
//     shadow (the icon draws its own), centered on the primary display.
//   - Loads the static `splash.html` shipped in `public/` (→ dist root). Pure
//     HTML/CSS, no React entry, no IPC surface — paints in one frame. It pulls
//     the high-resolution, visualizer-free mark from `/splash-icon.png`.
//   - Created the instant setup starts; kept up by a ready-watcher (spawn_ready_watcher)
//     until the app is genuinely ready — the renderer has painted (on_page_load
//     Finished → mark_renderer_painted), the React tree has acknowledged its first
//     mount (mark_renderer_boot_done), AND the STT engine has finished its boot
//     warmup (mark_stt_boot_done) before a visible handoff. Keeping WebView2 hidden
//     during DirectML session creation avoids a Windows GPU/compositor deadlock.
//     READY_TIMEOUT_MS and SPLASH_MAX_LIFETIME_MS remain failure backstops.

use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Splash window label. Not in the WINDOW_SPECS table (windows.rs) because it is
/// a transient startup-only window with no IPC and no lazy `open_window` path.
pub const SPLASH_LABEL: &str = "splash";

/// Hard backstop: the ready-watcher normally hands off to the real window within a
/// few seconds, but if the main page never loads (broken boot) a click-through
/// always-on-top window would otherwise stay on screen forever. Mirrors the
/// reference `SPLASH_MAX_LIFETIME_MS`.
const SPLASH_MAX_LIFETIME_MS: u64 = 60_000;

/// How long the ready-watcher waits for renderer + model readiness before showing
/// the window as a fallback. A cold DirectML model can legitimately need more than
/// five seconds while the hidden renderer loads in parallel.
const READY_TIMEOUT_MS: u64 = 15_000;
/// Hard backstop for a crashed splash renderer or an animation that never emits
/// `animationend`. Normal closes complete through the renderer acknowledgement.
const SPLASH_CLOSE_FAILSAFE_MS: u64 = 1_500;
const SPLASH_PAINT_WAIT_TIMEOUT_MS: u64 = 5_000;
/// Keep startup work off the CPU briefly after WebView2 reports the local page
/// loaded. This gives the compositor several frames to present the icon at 0%
/// before the first progress tick or model-runtime work begins.
const SPLASH_INITIAL_ZERO_HOLD_MS: u64 = 75;
const STARTUP_PROGRESS_TOTAL_PHASES: usize = 32;

/// Set once the MAIN window's renderer reports `on_page_load(Finished)` — i.e. the
/// React pill has actually painted ("the application fully loads"). The single
/// source the ready-watcher waits on (via `READY_SIGNAL`).
static RENDERER_PAINTED: AtomicBool = AtomicBool::new(false);

/// Set once the MAIN React tree has mounted and completed its first critical IPC
/// round trips. `on_page_load(Finished)` only proves that WebView loaded the HTML;
/// it can fire before the actual app providers have loaded settings/devices.
static RENDERER_BOOT_DONE: AtomicBool = AtomicBool::new(false);

/// Set once the boot STT thread (`initiate_model_load` + `warmup`, spawned in
/// `initialize_core_logic`) finishes — i.e. the engine is loaded + warm, OR there
/// was nothing to load (cloud id / first run with no model / load failed; `warmup`
/// returns promptly in all of those). The single-process analog of the reference's
/// server-readiness signal and a gate for visible startup handoff.
static STT_BOOT_DONE: AtomicBool = AtomicBool::new(false);
static STARTUP_PROGRESS_PHASE: AtomicUsize = AtomicUsize::new(0);
static SPLASH_PAGE_READY: AtomicBool = AtomicBool::new(false);

/// Guards the callback-first CSS fade-out so repeated handoff/backstop calls do
/// not start duplicate close generations against the same transient window.
static SPLASH_CLOSING: AtomicBool = AtomicBool::new(false);
/// Monotonic close generation. Both the renderer acknowledgement and the
/// failsafe carry this value so a delayed completion cannot affect a later
/// splash instance.
static SPLASH_CLOSE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Generation currently executing `destroy()`. The claim is made only inside
/// the deferred UI task, so a failed callback-side dispatch never suppresses
/// the failsafe retry.
static SPLASH_CLOSE_FINISHING: AtomicU64 = AtomicU64::new(0);

/// Wakes the blocking readiness waiters (`wait_until_painted`, the ready
/// watcher) the instant a readiness flag flips — every flag setter calls
/// [`pulse_ready_signal`] — so they sleep on the event instead of a poll tick.
/// The deadlines those waiters keep are failure backstops, not cadences.
static READY_SIGNAL: (Mutex<()>, Condvar) = (Mutex::new(()), Condvar::new());

/// Wake every readiness waiter. Acquires (and drops) the signal mutex first so
/// a waiter that just checked its flag and is about to park cannot miss the
/// notification — the classic condvar store-then-notify handshake.
fn pulse_ready_signal() {
    let (lock, cvar) = &READY_SIGNAL;
    drop(lock.lock().unwrap_or_else(PoisonError::into_inner));
    cvar.notify_all();
}

fn startup_percent_for_phase(phase: usize) -> u64 {
    let bounded_phase = phase.min(STARTUP_PROGRESS_TOTAL_PHASES);
    let percent = (bounded_phase as f64 / STARTUP_PROGRESS_TOTAL_PHASES as f64) * 100.0;
    percent.round() as u64
}

fn startup_progress_payload(label: &str, phase: usize, percent: u64) -> serde_json::Value {
    json!({
        "label": label,
        "phase": phase,
        "total": STARTUP_PROGRESS_TOTAL_PHASES,
        "percent": percent,
    })
}

fn splash_progress_script(payload: &serde_json::Value, complete: bool) -> String {
    format!(
        r#"
(() => {{
	const payload = {payload};
	const complete = {complete};
	const value = Number(payload.percent);
	if (!Number.isFinite(value)) {{
		return;
	}}
	const previous = Number(window.__winsttSplashProgressValue ?? -1);
	if (Number.isFinite(previous) && value < previous) {{
		return;
	}}
	window.__winsttSplashProgressValue = value;
	const clamped = Math.max(0, Math.min(100, value));
	const bar = document.querySelector('.bar');
	const progressText = document.getElementById('progress-text');
	const progress = document.getElementById('splash-progress');
	if (bar) {{
		bar.style.width = `${{clamped}}%`;
	}}
	if (progressText) {{
		progressText.textContent = `${{Math.round(complete ? 100 : clamped)}}%`;
	}}
	if (progress) {{
		progress.setAttribute('aria-valuenow', String(Math.round(complete ? 100 : clamped)));
	}}
}})();
"#,
        payload = payload,
        complete = complete
    )
}

fn apply_startup_progress_to_splash(app: &AppHandle, payload: &serde_json::Value, complete: bool) {
    if !SPLASH_PAGE_READY.load(Ordering::SeqCst) {
        return;
    }
    let Some(window) = app.get_webview_window(SPLASH_LABEL) else {
        return;
    };
    let script = splash_progress_script(payload, complete);
    if let Err(e) = window.eval(&script) {
        log::debug!("[splash] progress eval failed: {e}");
    }
}

fn replay_startup_progress(app: &AppHandle) {
    crate::startup::log_since_launch("splash page painted");
    SPLASH_PAGE_READY.store(true, Ordering::SeqCst);
    // Startup is gated on this page load, so the normal first render is 0%.
    // Replaying the current value remains defensive for a paint-timeout fallback
    // or a page reload: progress must never move backwards.
    let phase = STARTUP_PROGRESS_PHASE.load(Ordering::SeqCst);
    let payload =
        startup_progress_payload("Starting WinSTT", phase, startup_percent_for_phase(phase));
    apply_startup_progress_to_splash(app, &payload, false);
    pulse_ready_signal();
}

pub fn emit_startup_progress(app: &AppHandle, label: &str) {
    let phase = STARTUP_PROGRESS_PHASE.fetch_add(1, Ordering::SeqCst) + 1;
    let payload = startup_progress_payload(label, phase, startup_percent_for_phase(phase));
    let _ = app.emit(
        crate::winstt::commands::events::names::STARTUP_PROGRESS,
        payload.clone(),
    );
    apply_startup_progress_to_splash(app, &payload, false);
}

pub fn emit_startup_complete(app: &AppHandle, label: &str) {
    let phase = STARTUP_PROGRESS_PHASE.load(Ordering::SeqCst);
    let payload = startup_progress_payload(label, phase, 100);
    let _ = app.emit(
        crate::winstt::commands::events::names::STARTUP_COMPLETE,
        payload.clone(),
    );
    apply_startup_progress_to_splash(app, &payload, true);
}

pub fn reset_startup_progress() {
    STARTUP_PROGRESS_PHASE.store(0, Ordering::SeqCst);
    SPLASH_PAGE_READY.store(false, Ordering::SeqCst);
    RENDERER_PAINTED.store(false, Ordering::SeqCst);
    RENDERER_BOOT_DONE.store(false, Ordering::SeqCst);
    STT_BOOT_DONE.store(false, Ordering::SeqCst);
}

pub fn wait_until_painted() -> bool {
    let started = Instant::now();
    let timeout = Duration::from_millis(SPLASH_PAINT_WAIT_TIMEOUT_MS);
    let (lock, cvar) = &READY_SIGNAL;
    let mut guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
    // Event-driven: `replay_startup_progress` pulses the signal when the splash
    // page paints; the timeout is only the broken-boot backstop.
    while !SPLASH_PAGE_READY.load(Ordering::SeqCst) {
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            log::warn!("[splash] timed out waiting for splash paint; continuing startup");
            return false;
        }
        guard = cvar
            .wait_timeout(guard, timeout - elapsed)
            .unwrap_or_else(PoisonError::into_inner)
            .0;
    }
    drop(guard);
    std::thread::sleep(Duration::from_millis(SPLASH_INITIAL_ZERO_HOLD_MS));
    true
}

#[derive(Clone, Copy, Debug)]
struct ReadySnapshot {
    renderer_painted: bool,
    renderer_boot_done: bool,
    stt_boot_done: bool,
}

impl ReadySnapshot {
    fn handoff_ready(self, show_window: bool) -> bool {
        self.renderer_painted && self.renderer_boot_done && (!show_window || self.stt_boot_done)
    }
}

fn ready_snapshot() -> ReadySnapshot {
    ReadySnapshot {
        renderer_painted: RENDERER_PAINTED.load(Ordering::SeqCst),
        renderer_boot_done: RENDERER_BOOT_DONE.load(Ordering::SeqCst),
        stt_boot_done: STT_BOOT_DONE.load(Ordering::SeqCst),
    }
}

/// Record that the main renderer has painted. Called from the main window's
/// `on_page_load(Finished)` handler. Idempotent.
pub fn mark_renderer_painted(app: &AppHandle) {
    if RENDERER_PAINTED.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::startup::log_since_launch("main renderer painted");
    emit_startup_progress(app, "main renderer painted");
    pulse_ready_signal();
}

/// Record that the main renderer finished its first bootstrap pass. Called by
/// `winstt_emit_ready` after the renderer has primed startup IPC state.
/// Idempotent.
pub fn mark_renderer_boot_done(app: &AppHandle) {
    if RENDERER_BOOT_DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::startup::log_since_launch("main renderer bootstrap ready");
    emit_startup_progress(app, "main renderer bootstrap ready");
    pulse_ready_signal();
}

/// Record that the STT engine has finished its boot load+warm (or had nothing to
/// load). Called at the tail of the boot thread in `initialize_core_logic`.
/// Idempotent.
pub fn mark_stt_boot_done(app: &AppHandle) {
    if STT_BOOT_DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::startup::log_since_launch("STT boot/warmup complete");
    emit_startup_progress(app, "STT boot/warmup complete");
    pulse_ready_signal();
}

/// Whether the one-time startup STT load+warm pass has settled. Runtime-info
/// folds this into its model-readiness bit so a renderer snapshot cannot land
/// in the tiny handoff gap between loading and warmup.
pub fn is_stt_boot_done() -> bool {
    STT_BOOT_DONE.load(Ordering::SeqCst)
}

/// Whether a splash window currently exists. Used by the setup hook to decide
/// between the ready-watcher hand-off and an immediate show (no splash was created
/// when launching straight to the tray via the `--start-hidden` CLI flag).
pub fn is_active(app: &AppHandle) -> bool {
    app.get_webview_window(SPLASH_LABEL).is_some()
}

/// Keep the splash up until the renderer and model runtime are genuinely ready,
/// then hand off to the real window. Start-hidden launches only wait for renderer
/// readiness because they never expose WebView2 during the model build.
///
/// Why this exists: the previous code called `show_main_window` (which closes the
/// splash) synchronously inside `setup`, before the event loop pumped — so the
/// splash was torn down at the very start of boot, before the renderer painted,
/// flashing a blank pill. This watcher waits off the main thread for renderer paint,
/// renderer boot, and (for visible launches) STT warmup before showing the pill.
///
/// `show_window`: `true` for a normal/visible launch (show the pill + close the
/// splash once ready); `false` when launching straight to the tray (start-hidden) —
/// we only drop the splash once the hidden renderer has painted, never showing a
/// window.
pub fn spawn_ready_watcher(app: &AppHandle, show_window: bool) {
    let app = app.clone();
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        let deadline = std::time::Duration::from_millis(READY_TIMEOUT_MS);
        // Event-driven: every `mark_*` readiness setter pulses READY_SIGNAL, so
        // the reveal fires the instant the last flag flips — no poll tick. The
        // deadline is only the broken-boot fallback.
        let (lock, cvar) = &READY_SIGNAL;
        let mut snapshot;
        let timed_out;
        let mut guard = lock.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            snapshot = ready_snapshot();
            if snapshot.handoff_ready(show_window) {
                timed_out = false;
                break;
            }
            let elapsed = start.elapsed();
            if elapsed >= deadline {
                timed_out = true;
                break;
            }
            guard = cvar
                .wait_timeout(guard, deadline - elapsed)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        drop(guard);
        if timed_out {
            log::warn!(
                "[splash] ready-watcher timed out after {READY_TIMEOUT_MS}ms; renderer_painted={}, renderer_boot_done={}, stt_boot_done={}",
                snapshot.renderer_painted,
                snapshot.renderer_boot_done,
                snapshot.stt_boot_done
            );
        }
        crate::startup::log_since_launch(if timed_out {
            "reveal dispatched (timeout fallback)"
        } else {
            "reveal dispatched"
        });
        emit_startup_complete(
            &app,
            if timed_out {
                "startup ready (timeout fallback)"
            } else {
                "startup ready"
            },
        );
        // Window ops must run on the main thread on Windows; the event loop is live
        // by now (paint/timeout can only happen after `setup` returns).
        let app_for_main = app.clone();
        let res = app.run_on_main_thread(move || {
            if show_window {
                // Shows the main pill AND closes the splash (the handoff).
                // Do not reload on a timeout: WebView2 may still be navigating its
                // initial about:blank document to the Vite URL. Reloading at that
                // point can cancel the real navigation and strand the app forever
                // on an inert blank document. Showing the window lets the in-flight
                // load finish naturally and keeps the timeout fallback non-destructive.
                crate::show_main_window(&app_for_main);
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
    reset_startup_progress();
    SPLASH_CLOSING.store(false, Ordering::SeqCst);
    SPLASH_CLOSE_FINISHING.store(0, Ordering::SeqCst);

    let app_for_page_load = app.clone();
    let mut builder = crate::startup::configure_webview_window_builder(
        WebviewWindowBuilder::new(app, SPLASH_LABEL, WebviewUrl::App("splash.html".into()))
            .title("WinSTT")
            .inner_size(196.0, 196.0)
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
            .on_page_load(move |_window, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                    replay_startup_progress(&app_for_page_load);
                }
            })
            .visible(false),
    );

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
            log::debug!("[splash] shown");

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
        let sequence = SPLASH_CLOSE_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
        let script = format!(
            "document.body.dataset.closeSequence = '{sequence}'; document.body.classList.add('is-closing');"
        );
        // Keep WebView2 script evaluation off the UI thread. Wry may execute a
        // main-thread dispatch inline; doing that while the startup handoff is
        // already servicing a window message can block the sole Tao event loop.
        // The renderer callback remains the normal completion path.
        let spawn_result = std::thread::Builder::new()
            .name("splash-close-coordinator".into())
            .spawn(move || {
                if let Err(e) = window.eval(&script) {
                    log::warn!("[splash] close animation eval failed: {e}");
                    if let Err(schedule_error) = schedule_splash_close(&window, sequence) {
                        log::warn!(
                            "[splash] immediate destroy scheduling failed: {schedule_error}"
                        );
                    }
                }

                // A renderer crash, navigation, or suppressed animation must
                // not strand the click-through always-on-top splash. This is a
                // one-shot deadline, not a polling cadence; the callback wins.
                std::thread::sleep(Duration::from_millis(SPLASH_CLOSE_FAILSAFE_MS));
                if let Err(e) = schedule_splash_close(&window, sequence) {
                    log::warn!("[splash] failsafe destroy scheduling failed: {e}");
                }
            });
        if let Err(error) = spawn_result {
            SPLASH_CLOSING.store(false, Ordering::SeqCst);
            log::warn!("[splash] close coordinator could not start: {error}");
        }
    }
}

/// Queue destruction onto a later event-loop turn. A renderer acknowledgement
/// is itself handled on the UI thread; calling `destroy()` synchronously from
/// that IPC handler deadlocks WebView2 while it waits for the command response.
///
/// Tauri deliberately executes `run_on_main_thread` inline when its caller is
/// already on the main thread, so calling it directly here would not defer
/// anything. Crossing a helper thread first forces Tauri to post through the
/// event-loop proxy and guarantees the IPC handler returns before destruction.
pub(crate) fn schedule_splash_close(
    window: &tauri::WebviewWindow,
    sequence: u64,
) -> Result<(), String> {
    if !SPLASH_CLOSING.load(Ordering::SeqCst)
        || SPLASH_CLOSE_SEQUENCE.load(Ordering::SeqCst) != sequence
    {
        return Ok(());
    }
    let window = window.clone();
    std::thread::Builder::new()
        .name("splash-close-dispatch".into())
        .spawn(move || {
            let window_for_task = window.clone();
            if let Err(error) = window.run_on_main_thread(move || {
                finish_splash_close(&window_for_task, sequence);
            }) {
                log::warn!("[splash] deferred destroy dispatch failed: {error}");
            }
        })
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn finish_splash_close(window: &tauri::WebviewWindow, sequence: u64) {
    if !SPLASH_CLOSING.load(Ordering::SeqCst)
        || SPLASH_CLOSE_SEQUENCE.load(Ordering::SeqCst) != sequence
        || SPLASH_CLOSE_FINISHING
            .compare_exchange(0, sequence, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
    {
        return;
    }
    let result = window.destroy().map_err(|e| e.to_string());
    if result.is_ok() {
        log::debug!("[splash] destroyed");
        if SPLASH_CLOSE_SEQUENCE.load(Ordering::SeqCst) == sequence {
            SPLASH_CLOSING.store(false, Ordering::SeqCst);
        }
    }
    let _ =
        SPLASH_CLOSE_FINISHING.compare_exchange(sequence, 0, Ordering::SeqCst, Ordering::SeqCst);
    if let Err(error) = result {
        log::warn!("[splash] destroy failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{ReadySnapshot, startup_percent_for_phase};

    #[test]
    fn startup_progress_scale_begins_at_zero() {
        assert_eq!(startup_percent_for_phase(0), 0);
        assert!(startup_percent_for_phase(1) > 0);
    }

    #[test]
    fn visible_renderer_handoff_waits_for_stt_warmup() {
        let ready = ReadySnapshot {
            renderer_painted: true,
            renderer_boot_done: true,
            stt_boot_done: false,
        };

        assert!(!ready.handoff_ready(true));
        assert!(ready.handoff_ready(false));
    }

    #[test]
    fn renderer_handoff_requires_paint_and_boot_acknowledgement() {
        let not_painted = ReadySnapshot {
            renderer_painted: false,
            renderer_boot_done: true,
            stt_boot_done: true,
        };
        let not_booted = ReadySnapshot {
            renderer_painted: true,
            renderer_boot_done: false,
            stt_boot_done: true,
        };

        assert!(!not_painted.handoff_ready(true));
        assert!(!not_booted.handoff_ready(true));
    }
}
