// PORT IMPL — WU-3 overlay visibility (app/PORT/10_frontend_port_plan.md §6).
//
// Source of truth: frontend/electron/ipc/overlay.ts (showOverlay / hideOverlay /
// computeOverlayPosition / isOverlaySuppressedBySettings / repositionIfVisible).
//
// The WinSTT recording pill is the `overlay` WebviewWindow (windows/overlay.html,
// WINDOW_SPECS[overlay] in winstt/commands/windows.rs) — NOT Handy's
// `recording_overlay` window. The OverlayPage renderer paints the dynamic-island
// pill ENTIRELY from IPC events it already receives (stt:recording-start /
// realtime-update / stt:audio-level / …) through its own Zustand stores. So the
// backend's only job here is to SHOW / HIDE / POSITION that transparent window in
// lock-step with the recording lifecycle — exactly what the reference's showOverlay()/
// hideOverlay() do (the renderer owns all the content; we own the OS window).
//
// Show-gating mirrors the reference's `isOverlaySuppressedBySettings`:
//   - general.showRecordingOverlay == false  → never show
//   - general.recordingMode == "listen"      → never show (listen is passive)
//   - resolved overlayPosition == "none"     → hard "do not show"
// Position mirrors `computeOverlayPosition`:
//   - dynamic-island OR overlayPosition=="top" → docked flush to physical top
//     bezel of the primary display, horizontally centered.
//   - floating-bottom                          → centered in work area, 60px gap
//     above the taskbar.
//
// Wiring (REPORTED for lib.rs / handler — NOT edited here per HARD RULE):
//   - The recording lifecycle (TranscribeAction::start/stop + cancel) must call
//     `winstt::commands::overlay::show_recording_overlay(app)` /
//     `hide_recording_overlay(app)` instead of Handy's `crate::overlay::*` so the
//     RIGHT window (the renderer pill) is toggled. See libOther.
//   - `general.overlayPosition` / `general.overlayMode` live-change → call
//     `reposition_overlay_if_visible(app)`; flip to "none" → `hide_recording_overlay`.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager};

use crate::winstt::commands::settings::read_settings;
use crate::winstt::settings_schema::{OverlayMode, OverlayPosition, RecordingMode};

/// Label of the WinSTT overlay webview (== Vite entry key == windows.rs spec label).
const OVERLAY_LABEL: &str = "overlay";

/// Monotonic "show generation". Bumped on every `place_and_show`; the deferred-hide
/// thread captures the value at hide time and only actually hides the OS window if
/// no NEWER show landed in the grace window. This is the Rust analogue of the reference's
/// `desired` state guard — it prevents a rapid press→release→press cycle from having
/// the previous session's grace-timer hide the freshly-shown pill.
static OVERLAY_SHOW_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Overlay window inner size (logical px). Mirrors WINDOW_SPECS[overlay].
const OVERLAY_WIDTH: f64 = 720.0;
const OVERLAY_HEIGHT: f64 = 240.0;

/// Grown overlay height while the editable preview-before-pasting pill is open.
/// The multi-view edit/enhance/review content needs more room than the passive
/// 240px recording pill; restored to `OVERLAY_HEIGHT` on confirm/cancel.
const PREVIEW_OVERLAY_HEIGHT: f64 = 520.0;

/// Gap above the work-area bottom edge for the floating-bottom layout. Matches
/// the reference's `y = height - winHeight - 60` (computeOverlayPosition).
const FLOATING_BOTTOM_GAP: f64 = 60.0;

/// Resolved screen-edge for the overlay. Ports `resolveOverlayPosition`: "auto"
/// degrades to `none` on Linux (unless WINSTT_FORCE_OVERLAY) and `bottom`
/// elsewhere; explicit none/top/bottom pass through.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ResolvedPosition {
    None,
    Top,
    Bottom,
}

/// Truthy env-flag check (1/true/yes/on, case-insensitive). Empty / 0 / false /
/// no / off / unset → false. Ports `isForceOverlayEnvFlagSet`.
fn is_force_overlay_env_flag_set() -> bool {
    match std::env::var("WINSTT_FORCE_OVERLAY") {
        Ok(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        ),
        Err(_) => false,
    }
}

/// Resolve `general.overlayPosition` to a concrete edge. Ports `resolveOverlayPosition`.
fn resolve_overlay_position(position: OverlayPosition) -> ResolvedPosition {
    match position {
        OverlayPosition::None => ResolvedPosition::None,
        OverlayPosition::Top => ResolvedPosition::Top,
        OverlayPosition::Bottom => ResolvedPosition::Bottom,
        OverlayPosition::Auto => {
            #[cfg(target_os = "linux")]
            {
                if is_force_overlay_env_flag_set() {
                    ResolvedPosition::Bottom
                } else {
                    ResolvedPosition::None
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = is_force_overlay_env_flag_set;
                ResolvedPosition::Bottom
            }
        }
    }
}

/// The overlay's three suppression gates (the reference `isOverlaySuppressedBySettings`):
/// disabled toggle, listen mode, or a resolved `none` edge. Returns the resolved
/// edge when NOT suppressed (so the caller can position without recomputing).
fn overlay_show_decision(app: &AppHandle) -> Option<ResolvedPosition> {
    let general = read_settings(app).general;
    if !general.show_recording_overlay {
        return None;
    }
    if general.recording_mode == RecordingMode::Listen {
        return None;
    }
    let resolved = resolve_overlay_position(general.overlay_position);
    if resolved == ResolvedPosition::None {
        return None;
    }
    Some(resolved)
}

/// Compute the overlay top-left in LOGICAL screen px for the resolved layout.
/// Ports `computeOverlayPosition`: dynamic-island / top → physical-top-bezel
/// anchor (uses monitor bounds, not work area); floating-bottom → work-area
/// centered, `FLOATING_BOTTOM_GAP` above the taskbar.
fn compute_overlay_position(
    app: &AppHandle,
    mode: OverlayMode,
    edge: ResolvedPosition,
) -> Option<(f64, f64)> {
    compute_overlay_position_h(app, mode, edge, OVERLAY_HEIGHT)
}

/// Like [`compute_overlay_position`] but for an arbitrary window `height` — the
/// preview pill grows the overlay, and the floating-bottom anchor must subtract
/// the LIVE height (not the 240 constant) to stay above the taskbar.
fn compute_overlay_position_h(
    app: &AppHandle,
    mode: OverlayMode,
    edge: ResolvedPosition,
    height: f64,
) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let mx = monitor.position().x as f64 / scale;
    let my = monitor.position().y as f64 / scale;
    let mw = monitor.size().width as f64 / scale;
    let mh = monitor.size().height as f64 / scale;

    let want_top = edge == ResolvedPosition::Top || mode == OverlayMode::DynamicIsland;
    let x = mx + ((mw - OVERLAY_WIDTH) / 2.0).round();
    let y = if want_top {
        my
    } else {
        my + mh - height - FLOATING_BOTTOM_GAP
    };
    Some((x, y))
}

/// Position + reveal the overlay window without re-activating it (showInactive
/// parity → no focus steal, so the user's target app stays the keyboard sink).
/// `reason` ("recording" | "tts") is forwarded to the renderer's `show-overlay`
/// event (informational; the OverlayPage paints from its Zustand stores either way).
fn place_and_show(app: &AppHandle, mode: OverlayMode, edge: ResolvedPosition, reason: &str) {
    // Lazily materialize the overlay window from its WINDOW_SPECS entry the first
    // time a recording starts (the reference creates it eagerly at boot; here we create
    // on demand so a never-recorded session never pays the webview cost). Falls
    // back to a plain lookup if `ensure_window` ever fails.
    let window = match crate::winstt::commands::windows::ensure_window(app, OVERLAY_LABEL) {
        Ok(w) => w,
        Err(_) => {
            let Some(w) = app.get_webview_window(OVERLAY_LABEL) else {
                return;
            };
            w
        }
    };
    // Mark a fresh show so any in-flight deferred-hide thread cancels itself.
    OVERLAY_SHOW_GENERATION.fetch_add(1, Ordering::SeqCst);
    // Reset to the passive pill size — a previous (abandoned) preview may have
    // grown the window; the recording/tts pills must always start at 720×240.
    let _ = window.set_size(tauri::LogicalSize::new(OVERLAY_WIDTH, OVERLAY_HEIGHT));
    if let Some((x, y)) = compute_overlay_position(app, mode, edge) {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    // `show()` alone (no `set_focus`) keeps the pill from stealing keyboard focus
    // mid-dictation — the window is created with `focused(false)` + skip_taskbar +
    // ignore_cursor (WINDOW_SPECS[overlay]), so showing it does not activate it.
    let _ = window.show();
    // Click-through policy depends on WHY we're showing:
    //   - recording pill is PASSIVE — the user dictates into the app underneath, so
    //     the window must NOT capture the cursor (stays click-through).
    //   - TTS read-aloud island is INTERACTIVE — its pause/resume/stop/speed buttons
    //     must be clickable, so the window must capture the cursor. (The window is
    //     created `ignore_cursor: true`, so without this the TTS buttons were dead —
    //     clicks fell straight through the island.)
    let _ = window.set_ignore_cursor_events(reason != "tts");
    // On Windows, re-assert TOPMOST after showing (matches Handy's overlay path;
    // a fresh show can land below other always-on-top windows otherwise).
    #[cfg(target_os = "windows")]
    force_overlay_topmost(&window);
    // Tell the renderer the overlay window is now on screen (parity with Handy's
    // `show-overlay` event; the OverlayPage also self-clears on visibilitychange).
    let _ = window.emit("show-overlay", reason);
}

/// Force the overlay topmost via Win32 (more reliable than always_on_top alone).
#[cfg(target_os = "windows")]
fn force_overlay_topmost(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(hwnd) = w.hwnd() {
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }
    });
}

// ── Public lifecycle API (called from the recording pipeline — see libOther) ────

/// Show the WinSTT recording overlay, honoring the suppression gates + position.
/// No-op (and HIDES any stray pill) when suppressed. Mirrors the reference `showOverlay`.
pub fn show_recording_overlay(app: &AppHandle) {
    let Some(edge) = overlay_show_decision(app) else {
        // Suppressed: make sure no stale pill is on screen.
        hide_recording_overlay(app);
        return;
    };
    let mode = read_settings(app).general.overlay_mode;
    place_and_show(app, mode, edge, "recording");
}

/// Show the overlay window for a TTS read-aloud. The read-aloud island
/// (`TtsIslandLayer`) is ALWAYS top-anchored regardless of the recording
/// overlay's mode/position, and it's the only way to pause / stop / change the
/// speed of a read — so we FORCE it top-centered and DON'T apply the recording
/// overlay's suppression gates (mirrors the reference's forced read-aloud pill).
/// The renderer paints the island purely from `ttsStatus`, so this only has to
/// reveal + position the window; hide is the shared `hide_recording_overlay`
/// (its show-generation guard correctly yields to a recording that takes over).
pub fn show_tts_overlay(app: &AppHandle) {
    place_and_show(
        app,
        OverlayMode::DynamicIsland,
        ResolvedPosition::Top,
        "tts",
    );
}

/// Hide the WinSTT recording overlay. Emits `hide-overlay` first so the renderer
/// can play its slide-up exit, then hides the OS window after a short grace so the
/// animation has time to land (mirrors the reference's DYNAMIC_ISLAND_HIDE_GRACE_MS).
pub fn hide_recording_overlay(app: &AppHandle) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    let _ = window.emit("hide-overlay", ());
    // Restore click-through: a TTS read made the window interactive (cursor-capturing)
    // for its buttons; once it's going away the overlay must not keep capturing the
    // cursor (and the next recording pill must be passive again).
    let _ = window.set_ignore_cursor_events(true);
    // Snapshot the current generation; only hide if no newer show lands during the
    // grace window (the press→release→press race guard — the reference's `desired`).
    let generation = OVERLAY_SHOW_GENERATION.load(Ordering::SeqCst);
    let win = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        if OVERLAY_SHOW_GENERATION.load(Ordering::SeqCst) == generation {
            let _ = win.hide();
        }
    });
}

/// Re-anchor a CURRENTLY-VISIBLE overlay after a live `general.overlayMode` /
/// `general.overlayPosition` change. Ports `repositionIfVisible`: no-op when the
/// pill is hidden (the next `show_recording_overlay` reads the new layout). A flip
/// to `overlayPosition == "none"` is handled by the caller (hide directly).
pub fn reposition_overlay_if_visible(app: &AppHandle) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    // Recompute against the (possibly suppressed) current settings: if the live
    // change suppressed the overlay, hide it; otherwise re-anchor in place.
    let Some(edge) = overlay_show_decision(app) else {
        hide_recording_overlay(app);
        return;
    };
    let mode = read_settings(app).general.overlay_mode;
    if let Some((x, y)) = compute_overlay_position(app, mode, edge) {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
}

/// Whether the recording pill is currently un-suppressed (settings allow showing
/// it). The preview-before-pasting gate consults this — no pill means no preview.
pub fn overlay_is_active(app: &AppHandle) -> bool {
    overlay_show_decision(app).is_some()
}

/// Grow + reposition the overlay for the editable preview pill and make it
/// INTERACTIVE (cursor-capturing) so its textarea/buttons work. Unlike the
/// passive recording pill we do NOT force `set_focus` — clicking the textarea
/// activates the window, and the paste target was already captured (see
/// `winstt::commands::preview::capture_foreground`) BEFORE this call. The
/// renderer keeps the pill revealed via `isPreviewActive`; teardown is
/// `exit_preview_overlay`.
pub fn enter_preview_overlay(app: &AppHandle) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    OVERLAY_SHOW_GENERATION.fetch_add(1, Ordering::SeqCst);
    let _ = window.set_size(tauri::LogicalSize::new(
        OVERLAY_WIDTH,
        PREVIEW_OVERLAY_HEIGHT,
    ));
    let mode = read_settings(app).general.overlay_mode;
    let edge = overlay_show_decision(app).unwrap_or(ResolvedPosition::Top);
    if let Some((x, y)) = compute_overlay_position_h(app, mode, edge, PREVIEW_OVERLAY_HEIGHT) {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    let _ = window.show();
    // Capture the cursor so the preview is clickable/typeable (the recording
    // pill stays click-through; this is the same switch the TTS island uses).
    let _ = window.set_ignore_cursor_events(false);
    #[cfg(target_os = "windows")]
    force_overlay_topmost(&window);
    let _ = window.emit("show-overlay", "preview");
}

/// Tear down the preview pill: restore the passive 720×240 geometry + position,
/// then hide via the shared grace-timer path (which also restores click-through).
/// Called by `confirm_paste` / `cancel_preview`.
pub fn exit_preview_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.set_size(tauri::LogicalSize::new(OVERLAY_WIDTH, OVERLAY_HEIGHT));
    }
    hide_recording_overlay(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_position_resolves_per_platform() {
        let resolved = resolve_overlay_position(OverlayPosition::Auto);
        #[cfg(target_os = "linux")]
        {
            // Without the env flag, Linux auto → none (paste-pipeline safety).
            if !is_force_overlay_env_flag_set() {
                assert!(matches!(resolved, ResolvedPosition::None));
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            assert!(matches!(resolved, ResolvedPosition::Bottom));
        }
    }

    #[test]
    fn explicit_positions_pass_through() {
        assert!(matches!(
            resolve_overlay_position(OverlayPosition::None),
            ResolvedPosition::None
        ));
        assert!(matches!(
            resolve_overlay_position(OverlayPosition::Top),
            ResolvedPosition::Top
        ));
        assert!(matches!(
            resolve_overlay_position(OverlayPosition::Bottom),
            ResolvedPosition::Bottom
        ));
    }

    #[test]
    fn force_env_flag_truthiness() {
        std::env::set_var("WINSTT_FORCE_OVERLAY", "1");
        assert!(is_force_overlay_env_flag_set());
        std::env::set_var("WINSTT_FORCE_OVERLAY", "off");
        assert!(!is_force_overlay_env_flag_set());
        std::env::remove_var("WINSTT_FORCE_OVERLAY");
        assert!(!is_force_overlay_env_flag_set());
    }
}
