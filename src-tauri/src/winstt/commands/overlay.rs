// PORT IMPL — WU-3 overlay visibility (docs/archive/port/10_frontend_port_plan.md §6).
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

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

/// Native hit regions are accepted only while the overlay is intentionally
/// visible. Hide disables this before the renderer's close animation can report
/// stale rects back to Rust.
static OVERLAY_HIT_REGIONS_ENABLED: AtomicBool = AtomicBool::new(false);

/// The transparent overlay window can host both the STT pill and the TTS
/// read-aloud island. Track each owner separately so hiding one does not tear
/// down the other.
static RECORDING_OVERLAY_ACTIVE: AtomicBool = AtomicBool::new(false);
static TTS_OVERLAY_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Overlay window inner size (logical px). Mirrors WINDOW_SPECS[overlay].
const OVERLAY_WIDTH: f64 = 720.0;
const OVERLAY_HEIGHT: f64 = 240.0;
const OVERLAY_HIDE_GRACE_MS: u64 = 400;

/// Grown overlay height while the editable preview-before-pasting pill is open.
/// The multi-view edit/enhance/review content needs more room than the passive
/// 240px recording pill; restored to `OVERLAY_HEIGHT` on confirm/cancel.
const PREVIEW_OVERLAY_HEIGHT: f64 = 520.0;

/// Gap above the work-area bottom edge for the floating-bottom layout. Matches
/// the reference's `y = height - winHeight - 60` (computeOverlayPosition).
const FLOATING_BOTTOM_GAP: f64 = 60.0;

/// Renderer-measured rectangle, in overlay-window CSS/logical pixels, that
/// should remain native-hit-testable. Windows applies this as the overlay HWND's
/// region, so transparent pixels outside the actual pill surfaces do not block
/// the app underneath while the overlay is interactive.
#[derive(Clone, Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OverlayHitRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

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

/// Frame used while STT and TTS overlap: one transparent window spans from the
/// top bezel to the normal floating-bottom baseline so TTS can keep the top
/// island while STT uses the bottom pill.
fn compute_stacked_overlay_frame(app: &AppHandle) -> Option<(f64, f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let mx = monitor.position().x as f64 / scale;
    let my = monitor.position().y as f64 / scale;
    let mw = monitor.size().width as f64 / scale;
    let mh = monitor.size().height as f64 / scale;

    let x = mx + ((mw - OVERLAY_WIDTH) / 2.0).round();
    let height = (mh - FLOATING_BOTTOM_GAP).max(OVERLAY_HEIGHT).min(mh);
    Some((x, my, height.round()))
}

fn ensure_overlay_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    match crate::winstt::commands::windows::ensure_window(app, OVERLAY_LABEL) {
        Ok(w) => Some(w),
        Err(_) => app.get_webview_window(OVERLAY_LABEL),
    }
}

/// Position + reveal the overlay window without re-activating it (showInactive
/// parity → no focus steal, so the user's target app stays the keyboard sink).
/// `reason` ("recording" | "tts") is forwarded to the renderer's `show-overlay`
/// event (informational; the OverlayPage paints from its Zustand stores either way).
fn place_and_show_at(app: &AppHandle, height: f64, position: Option<(f64, f64)>, reason: &str) {
    // The overlay is normally prewarmed shortly after the main pill paints. Keep
    // this idempotent ensure as a fallback for a recording that beats the prewarm.
    let Some(window) = ensure_overlay_window(app) else {
        return;
    };
    // Mark a fresh show so any in-flight deferred-hide thread cancels itself.
    OVERLAY_SHOW_GENERATION.fetch_add(1, Ordering::SeqCst);
    OVERLAY_HIT_REGIONS_ENABLED.store(true, Ordering::SeqCst);
    // Reset to the caller's footprint; preview and STT+TTS overlap both grow the
    // window, and the next owner must not inherit that size.
    let _ = window.set_size(tauri::LogicalSize::new(OVERLAY_WIDTH, height));
    set_empty_overlay_hit_region(&window);
    if let Some((x, y)) = position {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    // `show()` alone (no `set_focus`) keeps the pill from stealing keyboard focus
    // mid-dictation — the window is created with `focused(false)` + skip_taskbar +
    // ignore_cursor (WINDOW_SPECS[overlay]), so showing it does not activate it.
    let _ = window.show();
    // Recording and TTS both expose controls inside the overlay window (STT
    // cancel X; TTS pause/resume/stop/speed), so the native window must capture
    // cursor events while visible. The window is created `ignore_cursor: true`;
    // if we leave that flag on, clicks fall through before the DOM button can
    // receive them.
    let _ = window.set_ignore_cursor_events(ignore_cursor_events_for_show_reason(reason));
    // On Windows, re-assert TOPMOST after showing (matches Handy's overlay path;
    // a fresh show can land below other always-on-top windows otherwise).
    #[cfg(target_os = "windows")]
    force_overlay_topmost(&window);
    // Tell the renderer the overlay window is now on screen (parity with Handy's
    // `show-overlay` event; the OverlayPage also self-clears on visibilitychange).
    let _ = window.emit("show-overlay", reason);
}

fn place_and_show(app: &AppHandle, mode: OverlayMode, edge: ResolvedPosition, reason: &str) {
    place_and_show_at(
        app,
        OVERLAY_HEIGHT,
        compute_overlay_position(app, mode, edge),
        reason,
    );
}

fn place_and_show_stacked(app: &AppHandle, reason: &str) {
    match compute_stacked_overlay_frame(app) {
        Some((x, y, height)) => place_and_show_at(app, height, Some((x, y)), reason),
        None => place_and_show(
            app,
            OverlayMode::DynamicIsland,
            ResolvedPosition::Top,
            reason,
        ),
    }
}

/// Return the native cursor-ignore value for a newly-shown overlay.
/// `true` means OS-level click-through; `false` means the WebView can receive
/// mouse/touch input for its visible controls.
fn ignore_cursor_events_for_show_reason(reason: &str) -> bool {
    !matches!(reason, "recording" | "tts" | "preview")
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

#[cfg(target_os = "windows")]
fn overlay_rect_to_physical(
    rect: &OverlayHitRect,
    scale_factor: f64,
) -> Option<(i32, i32, i32, i32)> {
    if rect.width <= 0.0 || rect.height <= 0.0 {
        return None;
    }
    let left = (rect.x * scale_factor).floor().max(0.0) as i32;
    let top = (rect.y * scale_factor).floor().max(0.0) as i32;
    let right = ((rect.x + rect.width) * scale_factor).ceil().max(0.0) as i32;
    let bottom = ((rect.y + rect.height) * scale_factor).ceil().max(0.0) as i32;
    if right <= left || bottom <= top {
        return None;
    }
    Some((left, top, right, bottom))
}

#[cfg(target_os = "windows")]
fn apply_overlay_hit_regions(
    window: &tauri::WebviewWindow,
    rects: &[OverlayHitRect],
) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
    };

    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);

    // Empty region = visible overlay can never capture a stale transparent box.
    // The renderer sends a non-empty region as soon as a pill surface is present.
    let combined = unsafe { CreateRectRgn(0, 0, 0, 0) };
    if combined.is_invalid() {
        return Err("failed to create overlay hit region".into());
    }

    for rect in rects.iter().take(16) {
        let Some((left, top, right, bottom)) = overlay_rect_to_physical(rect, scale) else {
            continue;
        };
        let part = unsafe { CreateRectRgn(left, top, right, bottom) };
        if part.is_invalid() {
            continue;
        }
        unsafe {
            let _ = CombineRgn(Some(combined), Some(combined), Some(part), RGN_OR);
            let _ = DeleteObject(part.into());
        }
    }

    let ok = unsafe { SetWindowRgn(hwnd, Some(combined), true) };
    if ok == 0 {
        unsafe {
            let _ = DeleteObject(combined.into());
        }
        return Err("failed to apply overlay hit region".into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn apply_overlay_hit_regions(
    _window: &tauri::WebviewWindow,
    _rects: &[OverlayHitRect],
) -> Result<(), String> {
    Ok(())
}

fn set_empty_overlay_hit_region(window: &tauri::WebviewWindow) {
    if let Err(error) = apply_overlay_hit_regions(window, &[]) {
        log::warn!("[overlay] failed to clear overlay hit region: {error}");
    }
}

/// Renderer feedback loop for native hit-testing. The overlay window is larger
/// than the visual pill so the renderer has layout room, but this command clips
/// the native window to only the currently painted pill/control rectangles.
#[tauri::command]
#[specta::specta]
pub fn set_overlay_hit_regions(app: AppHandle, rects: Vec<OverlayHitRect>) -> Result<(), String> {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return Ok(());
    };
    if !OVERLAY_HIT_REGIONS_ENABLED.load(Ordering::SeqCst) {
        // During the close grace window, keep the last painted region alive.
        // SetWindowRgn clips rendering, not just hit-testing, so clearing here
        // would cut off the renderer's exit animation.
        return Ok(());
    }
    apply_overlay_hit_regions(&window, &rects)
}

/// Show the WinSTT recording overlay, honoring the suppression gates + position.
/// No-op (and HIDES any stray pill) when suppressed. Mirrors the reference `showOverlay`.
pub fn show_recording_overlay(app: &AppHandle) {
    let Some(edge) = overlay_show_decision(app) else {
        RECORDING_OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
        if TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
            place_and_show(
                app,
                OverlayMode::DynamicIsland,
                ResolvedPosition::Top,
                "tts",
            );
        } else {
            hide_overlay_window(app);
        }
        return;
    };
    RECORDING_OVERLAY_ACTIVE.store(true, Ordering::SeqCst);
    if TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show_stacked(app, "recording");
        return;
    }
    let mode = read_settings(app).general.overlay_mode;
    place_and_show(app, mode, edge, "recording");
}

/// Reserve the top island for a TTS request before audio starts. If STT is
/// visible, immediately expand the shared overlay into the top+bottom layout;
/// otherwise the window remains hidden until playback actually begins.
pub fn reserve_tts_overlay(app: &AppHandle) {
    TTS_OVERLAY_ACTIVE.store(true, Ordering::SeqCst);
    if RECORDING_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show_stacked(app, "tts");
    }
}

pub fn tts_overlay_is_active() -> bool {
    TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst)
}

/// Show the overlay window for a TTS read-aloud. The read-aloud island
/// (`TtsIslandLayer`) is ALWAYS top-anchored regardless of the recording
/// overlay's mode/position, and it's the only way to pause / stop / change the
/// speed of a read — so we FORCE it top-centered and DON'T apply the recording
/// overlay's suppression gates (mirrors the reference's forced read-aloud pill).
/// The renderer paints the island purely from `ttsStatus`, so this only has to
/// reveal + position the window; hide is the owner-aware `hide_tts_overlay`
/// path so an active STT pill can stay visible underneath.
pub fn show_tts_overlay(app: &AppHandle) {
    TTS_OVERLAY_ACTIVE.store(true, Ordering::SeqCst);
    if RECORDING_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show_stacked(app, "tts");
        return;
    }
    place_and_show(
        app,
        OverlayMode::DynamicIsland,
        ResolvedPosition::Top,
        "tts",
    );
}

/// Hide the TTS owner of the shared overlay. If STT is still active, keep the
/// window visible and hand it back to the STT layout instead of hiding it.
pub fn hide_tts_overlay(app: &AppHandle) {
    TTS_OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
    if !RECORDING_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        hide_overlay_window(app);
        return;
    }
    let Some(edge) = overlay_show_decision(app) else {
        RECORDING_OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
        hide_overlay_window(app);
        return;
    };
    let mode = read_settings(app).general.overlay_mode;
    place_and_show(app, mode, edge, "recording");
}

/// Hide the STT owner of the shared overlay. If TTS is still active, preserve
/// the read-aloud island instead of tearing down the whole window.
pub fn hide_recording_overlay(app: &AppHandle) {
    RECORDING_OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
    if TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show(
            app,
            OverlayMode::DynamicIsland,
            ResolvedPosition::Top,
            "tts",
        );
    } else {
        hide_overlay_window(app);
    }
}

/// Hide the shared overlay window. Emits `hide-overlay` first so the renderer
/// can play its slide-up exit, then hides the OS window after a short grace so the
/// animation has time to land (mirrors the reference's DYNAMIC_ISLAND_HIDE_GRACE_MS).
fn hide_overlay_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    OVERLAY_HIT_REGIONS_ENABLED.store(false, Ordering::SeqCst);
    let _ = window.emit("hide-overlay", ());
    // Restore click-through while hidden so a stale transparent overlay can never
    // keep capturing the cursor after the session/read has ended.
    let _ = window.set_ignore_cursor_events(true);
    // Snapshot the current generation; only hide if no newer show lands during the
    // grace window (the press→release→press race guard — the reference's `desired`).
    let generation = OVERLAY_SHOW_GENERATION.load(Ordering::SeqCst);
    let win = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(OVERLAY_HIDE_GRACE_MS));
        if OVERLAY_SHOW_GENERATION.load(Ordering::SeqCst) == generation {
            set_empty_overlay_hit_region(&win);
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
    if RECORDING_OVERLAY_ACTIVE.load(Ordering::SeqCst) && TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst)
    {
        place_and_show_stacked(app, "recording");
        return;
    }
    if TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show(
            app,
            OverlayMode::DynamicIsland,
            ResolvedPosition::Top,
            "tts",
        );
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
/// recording pill show path we do NOT force `set_focus` — clicking the textarea
/// activates the window, and the paste target was already captured (see
/// `winstt::commands::preview::capture_foreground`) BEFORE this call. The
/// renderer keeps the pill revealed via `isPreviewActive`; teardown is
/// `exit_preview_overlay`.
pub fn enter_preview_overlay(app: &AppHandle) {
    RECORDING_OVERLAY_ACTIVE.store(true, Ordering::SeqCst);
    if TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show_stacked(app, "preview");
        return;
    }
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    OVERLAY_SHOW_GENERATION.fetch_add(1, Ordering::SeqCst);
    OVERLAY_HIT_REGIONS_ENABLED.store(true, Ordering::SeqCst);
    let _ = window.set_size(tauri::LogicalSize::new(
        OVERLAY_WIDTH,
        PREVIEW_OVERLAY_HEIGHT,
    ));
    set_empty_overlay_hit_region(&window);
    let mode = read_settings(app).general.overlay_mode;
    let edge = overlay_show_decision(app).unwrap_or(ResolvedPosition::Top);
    if let Some((x, y)) = compute_overlay_position_h(app, mode, edge, PREVIEW_OVERLAY_HEIGHT) {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    let _ = window.show();
    // Capture the cursor so the preview is clickable/typeable; this is the same
    // native switch the shown recording and TTS pills use for their controls.
    let _ = window.set_ignore_cursor_events(false);
    #[cfg(target_os = "windows")]
    force_overlay_topmost(&window);
    let _ = window.emit("show-overlay", "preview");
}

/// Tear down the preview pill: restore the passive geometry, then either hide
/// the shared window or hand it back to the active TTS owner.
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

    #[test]
    fn recording_show_captures_cursor_for_cancel_button() {
        assert!(!ignore_cursor_events_for_show_reason("recording"));
    }

    #[test]
    fn tts_show_captures_cursor_for_island_controls() {
        assert!(!ignore_cursor_events_for_show_reason("tts"));
    }

    #[test]
    fn preview_show_captures_cursor_for_editor_controls() {
        assert!(!ignore_cursor_events_for_show_reason("preview"));
    }

    #[test]
    fn unknown_show_reason_stays_click_through() {
        assert!(ignore_cursor_events_for_show_reason("unknown"));
    }
}
