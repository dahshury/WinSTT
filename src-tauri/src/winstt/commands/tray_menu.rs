// PORT IMPL — WU-12 (docs/archive/port/10_frontend_port_plan.md §6 WU-12 + §4b).
//
// Tray-menu window placement. WinSTT's tray menu is NOT a native OS menu — it is
// a custom transparent HTML BrowserWindow (`views/tray-menu`) the user pops open
// from the tray icon, anchored at the icon/cursor location and clamped to the
// monitor work area. This file ports the reference `tray-menu-window.ts` logic
// (`showTrayMenuAt` + `clampToWorkArea` + `hideTrayMenu`) onto the Tauri 9-window
// topology that `winstt/commands/windows.rs` already creates.
//
// Wiring (reported for lib.rs, NOT edited here per HARD RULE):
//   - register `show_tray_menu` / `hide_tray_menu` in `collect_commands![]`.
//   - `.manage(TrayMenuAnchor::default())` so a resize can re-anchor.
//   - in the TrayIconBuilder, DROP `show_menu_on_left_click(true)` + the native
//     `on_menu_event` menu, and instead call `show_tray_menu(app, None, None)`
//     from an `on_tray_icon_event` handler on left/right click (the WinSTT tray
//     opens the custom HTML menu — left-click main-show stays a separate item
//     inside the menu). See WU-12 notes in lib_wiring.md.
//
// HARD-RULE-safe: NEW file under winstt/commands/. Reuses windows::ensure_window
// (made pub(crate)) so the same lazily-created `tray-menu` webview is positioned.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, Manager, PhysicalPosition, PhysicalSize};

use super::windows::ensure_window;

/// Label of the tray-menu webview (== Vite entry key == renderer window name).
const TRAY_MENU_LABEL: &str = "tray-menu";

/// Visual gap left above the taskbar. Mirrors `TASKBAR_MARGIN` in the reference
/// `tray-menu-window.ts`: on Windows 11 the taskbar's rounded/translucent top
/// edge extends a few px above the work-area boundary, so a flush menu visually
/// overlaps it. Native context menus leave a small gap; we replicate that.
const TASKBAR_MARGIN: f64 = 8.0;

/// Off-screen parking coordinate (logical px). Mirrors the reference tray menu's
/// `OFFSCREEN = -9999`: instead of OS `hide()`/`show()` (which triggers a
/// show/repaint animation → the user's "hard flicker"), we keep the window
/// *always shown* and merely PARK it off-screen when dismissed and MOVE it on
/// screen when opened. The window paints exactly once, off-screen, and every
/// subsequent open/close is a pure reposition with no visibility transition.
const OFFSCREEN: f64 = -9999.0;

/// True once the tray menu has been parked-shown off-screen at least once, so
/// `place_tray_menu` knows the webview has already painted and a reposition is
/// all that's required (no `show()` flicker). Set by `install_tray_menu_lifecycle`.
static TRAY_MENU_PRESHOWN: AtomicBool = AtomicBool::new(false);
static TRAY_MENU_LIFECYCLE_INSTALLED: AtomicBool = AtomicBool::new(false);

/// Last anchor point the tray menu was shown at, in LOGICAL screen pixels.
/// Stored so a `tray-menu:resize` (the renderer's ResizeObserver reports the
/// real content size after mount) can re-anchor the now-correctly-sized menu to
/// the same origin instead of leaving it clamped against a stale size.
#[derive(Default)]
pub struct TrayMenuAnchor(pub Mutex<Option<(f64, f64)>>);

/// Find the monitor whose bounds contain the given logical point, falling back
/// to the primary monitor. Ported from `overlay.rs::get_monitor_with_cursor`
/// (which is private to that module) — deliberately uses `position()`+`size()`
/// rather than `work_area()` (the latter forces `dpi::PhysicalRect`, which is
/// not present in the pinned `dpi 0.1.2`; the fixed `TASKBAR_MARGIN` covers the
/// taskbar gap instead).
fn monitor_for_point(app: &AppHandle, point: (f64, f64)) -> Option<tauri::Monitor> {
    let (px, py) = point;
    if let Ok(monitors) = app.available_monitors() {
        for monitor in monitors {
            let scale = monitor.scale_factor();
            let mx = monitor.position().x as f64 / scale;
            let my = monitor.position().y as f64 / scale;
            let mw = monitor.size().width as f64 / scale;
            let mh = monitor.size().height as f64 / scale;
            if px >= mx && px < mx + mw && py >= my && py < my + mh {
                return Some(monitor);
            }
        }
    }
    app.primary_monitor().ok().flatten()
}

/// Logical-pixel monitor rect (x, y, width, height) for a point. Used as the
/// clamp box for the tray menu so it never spills off-screen.
fn monitor_rect_for_point(app: &AppHandle, point: (f64, f64)) -> (f64, f64, f64, f64) {
    if let Some(monitor) = monitor_for_point(app, point) {
        let scale = monitor.scale_factor();
        let PhysicalPosition { x, y } = *monitor.position();
        let PhysicalSize { width, height } = *monitor.size();
        return (
            x as f64 / scale,
            y as f64 / scale,
            width as f64 / scale,
            height as f64 / scale,
        );
    }
    // No monitor info: a generous default so we still place SOMETHING on-screen.
    (0.0, 0.0, 1920.0, 1080.0)
}

/// Clamp the desired top-left so the whole `menu_size` stays inside `work_area`,
/// leaving `TASKBAR_MARGIN` at the bottom. Byte-for-byte port of the reference
/// `clampToWorkArea` (frontend/electron/ipc/tray-menu-window.ts).
fn clamp_to_work_area(
    desired: (f64, f64),
    menu_size: (f64, f64),
    work_area: (f64, f64, f64, f64),
) -> (f64, f64) {
    let (dx, dy) = desired;
    let (mw, mh) = menu_size;
    let (wx, wy, ww, wh) = work_area;
    let max_x = wx + ww - mw;
    let max_y = wy + wh - mh - TASKBAR_MARGIN;
    let clamped_x = dx.max(wx).min(max_x);
    let clamped_y = dy.max(wy).min(max_y);
    (clamped_x, clamped_y)
}

/// Resolve the anchor point: explicit (x, y) if supplied, else the OS cursor
/// position (logical px). The tray icon click handler in lib.rs passes the icon
/// rect's bottom-left; renderer-driven re-opens pass nothing.
fn resolve_anchor(app: &AppHandle, x: Option<f64>, y: Option<f64>) -> (f64, f64) {
    if let (Some(x), Some(y)) = (x, y) {
        return (x, y);
    }
    crate::input::get_cursor_position(app)
        .map(|(cx, cy)| (cx as f64, cy as f64))
        .unwrap_or((0.0, 0.0))
}

/// Clamp the anchor against the live menu size + monitor work area and move the
/// tray-menu window there. Shared by `place_tray_menu` (open path) and the
/// resize-reanchor handler (reposition only, no show/focus → no flicker).
fn position_tray_menu(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    anchor: (f64, f64),
) -> Result<(), String> {
    // Use the window's live logical inner size so the clamp matches what the
    // renderer's ResizeObserver has reported (the menu is width-capped —
    // `w-max max-w-[…]` — and reports its real size right after mount via
    // TRAY_MENU_RESIZE → resize_window).
    let scale = window.scale_factor().unwrap_or(1.0);
    let menu_size = window
        .inner_size()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((192.0, 360.0));

    let work_area = monitor_rect_for_point(app, anchor);
    let (px, py) = clamp_to_work_area(anchor, menu_size, work_area);

    window
        .set_position(LogicalPosition::new(px, py))
        .map_err(|e| e.to_string())
}

/// Is the tray menu currently ON SCREEN? Because the window is kept always-shown
/// (parked off-screen when dismissed — see `OFFSCREEN`), visibility can no longer
/// be derived from `is_visible()`; instead we look at its position. Mirrors the
/// the reference `isMenuVisible` (which checks `posY !== OFFSCREEN`).
fn is_tray_menu_on_screen(window: &tauri::WebviewWindow) -> bool {
    // Defense-in-depth: a HIDDEN window keeps its last on-screen position, so the
    // position test alone could misclassify it as visible. Require BOTH actually-shown
    // AND parked on-screen. (With the park-offscreen model the window stays shown, so
    // is_visible() is normally true; this only guards against any residual hide() path.)
    if !window.is_visible().unwrap_or(false) {
        return false;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .outer_position()
        .map(|p| (p.y as f64 / scale) > OFFSCREEN / 2.0)
        .unwrap_or(false)
}

/// Core placement: ensure the tray-menu window exists, clamp the anchor to the
/// monitor work area, position + focus it.
///
/// The window is created hidden in setup and PARK-SHOWN off-screen once (in
/// `install_tray_menu_lifecycle`) so it has already painted at full content size.
/// Opening it is therefore a pure reposition — no `show()` (which on Windows
/// fires an OS show animation + a transparent-surface repaint, the source of the
/// "hard flicker"). The first open before the pre-show has landed falls back to a
/// real `show()` so the menu still appears.
fn place_tray_menu(app: &AppHandle, anchor: (f64, f64)) -> Result<(), String> {
    install_tray_menu_lifecycle(app);
    let window = ensure_window(app, TRAY_MENU_LABEL)?;
    position_tray_menu(app, &window, anchor)?;
    // If the window was never park-shown yet (cold first open before the
    // lifecycle pre-show ran), show it for real; otherwise it is already shown
    // off-screen and the reposition above brought it on screen flicker-free.
    if !TRAY_MENU_PRESHOWN.load(Ordering::SeqCst) {
        window.show().map_err(|e| e.to_string())?;
    }
    let _ = window.set_focus();
    Ok(())
}

/// `show_tray_menu` — open the custom HTML tray menu anchored at (x, y) in
/// logical screen px, or at the cursor when omitted. Stores the anchor so a
/// later resize can re-anchor. Mirrors the reference's `showTrayMenuAt`.
#[tauri::command]
#[specta::specta]
pub fn show_tray_menu(app: AppHandle, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    let anchor = resolve_anchor(&app, x, y);
    if let Some(state) = app.try_state::<TrayMenuAnchor>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(anchor);
        }
    }
    place_tray_menu(&app, anchor)
}

/// `reanchor_tray_menu` — re-run placement from the stored anchor. The
/// `tray-menu:resize` path calls this (via the resize handler) so the menu,
/// once it knows its true content size, stays glued to the original click point
/// instead of remaining clamped against its initial (larger) size. No-op when
/// the menu was never shown.
#[tauri::command]
#[specta::specta]
pub fn reanchor_tray_menu(app: AppHandle) -> Result<(), String> {
    let anchor = app
        .try_state::<TrayMenuAnchor>()
        .and_then(|state| state.0.lock().ok().and_then(|g| *g));
    if let Some(anchor) = anchor {
        return place_tray_menu(&app, anchor);
    }
    Ok(())
}

/// `hide_tray_menu` — hide (not destroy) the tray menu and clear the stored
/// anchor, matching the reference's `hideTrayMenu` (window keep-alive semantics).
#[tauri::command]
#[specta::specta]
pub fn hide_tray_menu(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) {
        park_tray_menu_offscreen(&window);
    }
    if let Some(state) = app.try_state::<TrayMenuAnchor>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = None;
        }
    }
    Ok(())
}

/// Dismiss the tray menu by MOVING it off-screen (the reference's `moveOffscreen`),
/// NOT `hide()`. Keeping the window shown-but-parked means re-opening is a pure
/// reposition with no OS show animation / transparent-surface repaint — the fix
/// for the open flicker. Before the lifecycle pre-show has run the window may
/// still be genuinely hidden; parking it is harmless in that case.
fn park_tray_menu_offscreen(window: &tauri::WebviewWindow) {
    let _ = window.set_position(LogicalPosition::new(OFFSCREEN, OFFSCREEN));
}

/// Hide the tray menu directly (no command roundtrip). Used by the blur/resize
/// window-event handler the tray-click wiring installs. Clears the stored anchor.
fn hide_tray_menu_internal(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) {
        park_tray_menu_offscreen(&window);
    }
    if let Some(state) = app.try_state::<TrayMenuAnchor>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = None;
        }
    }
}

/// Open the tray menu from a TRAY-ICON click. The Tauri `TrayIconEvent::Click`
/// reports the cursor `position` in PHYSICAL pixels relative to the icon; the menu
/// placement works in LOGICAL screen px, so convert via the primary monitor's
/// scale factor before anchoring at that point. Called from `on_tray_icon_event`
/// in lib.rs (REPORTED in libOther). Errors are logged, never propagated (a tray
/// click must never panic the app). The cursor lands at the bottom of the screen
/// near the tray, so `clamp_to_work_area` (called by `place_tray_menu`) pulls the
/// menu up into the work area above the taskbar.
pub fn show_tray_menu_at_physical(app: &AppHandle, physical_x: f64, physical_y: f64) {
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let logical = (physical_x / scale, physical_y / scale);
    if let Some(state) = app.try_state::<TrayMenuAnchor>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(logical);
        }
    }
    if let Err(e) = place_tray_menu(app, logical) {
        log::warn!("Failed to open tray menu from tray click: {e}");
    }
}

/// Toggle the tray menu from a tray-icon click: hide if it's already visible,
/// otherwise open it anchored at the click point. Mirrors the desktop convention
/// where clicking the tray icon again dismisses the popup. Called from
/// `on_tray_icon_event` (REPORTED in libOther).
pub fn toggle_tray_menu_at_physical(app: &AppHandle, physical_x: f64, physical_y: f64) {
    // The window is kept always-shown and parked off-screen when dismissed, so
    // "is it open?" is a POSITION test, not `is_visible()` (which is always true).
    let on_screen = app
        .get_webview_window(TRAY_MENU_LABEL)
        .map(|w| is_tray_menu_on_screen(&w))
        .unwrap_or(false);
    if on_screen {
        hide_tray_menu_internal(app);
    } else {
        show_tray_menu_at_physical(app, physical_x, physical_y);
    }
}

/// Install the tray-menu window's lifecycle behaviors ONCE (called from lib.rs
/// setup — REPORTED in libOther). Two parities with the reference's
/// `tray-menu-window.ts`:
///   1. RESIZE → RE-ANCHOR: the renderer's ResizeObserver reports the menu's real
///      `w-fit` content size via TRAY_MENU_RESIZE → `resize_window`. When the OS
///      resize lands, re-place the menu against the stored anchor so the now
///      correctly-sized menu stays glued to the click point (the reference's
///      `reanchorMenuIfVisible`).
///   2. BLUR → HIDE: when the menu loses focus (user clicked elsewhere), dismiss it
///      (the reference's `handleBlur`). The detached device-picker child is allowed to
///      steal focus — the reference suppresses blur-hide for that, but here the picker is
///      a separate always-on-top window and the menu staying open under it is
///      acceptable for v1; the renderer also closes the menu on item clicks.
pub fn install_tray_menu_lifecycle(app: &AppHandle) {
    if TRAY_MENU_LIFECYCLE_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }

    // The window is created lazily on first open; defer wiring until then by
    // re-checking on each open is over-engineered — instead create it now (hidden)
    // so the event hook is attached exactly once.
    let Ok(window) = ensure_window(app, TRAY_MENU_LABEL) else {
        TRAY_MENU_LIFECYCLE_INSTALLED.store(false, Ordering::SeqCst);
        log::warn!("tray-menu window unavailable; skipping lifecycle wiring");
        return;
    };
    let app_handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(_) => {
            // Re-anchor only while the menu is ON SCREEN, against the stored anchor.
            // Reposition ONLY (no show/focus) so the reanchor can't flicker focus.
            let anchor = app_handle
                .try_state::<TrayMenuAnchor>()
                .and_then(|state| state.0.lock().ok().and_then(|g| *g));
            if let Some(anchor) = anchor {
                if let Some(window) = app_handle.get_webview_window(TRAY_MENU_LABEL) {
                    if is_tray_menu_on_screen(&window) {
                        let _ = position_tray_menu(&app_handle, &window, anchor);
                    }
                }
            }
        }
        tauri::WindowEvent::Focused(false) => {
            // Only dismiss-on-blur if the menu is actually on screen. While the
            // window lives parked off-screen it can receive a spurious
            // Focused(false) (e.g. when it was park-shown at startup) — parking
            // it again is harmless, but guarding avoids clearing the anchor on a
            // window that isn't even open.
            if let Some(window) = app_handle.get_webview_window(TRAY_MENU_LABEL) {
                if is_tray_menu_on_screen(&window) {
                    // SUPPRESS blur-hide when focus went to the device-picker SUBMENU —
                    // it's a legitimate always-on-top child of the tray menu, so opening
                    // the mic selector must NOT collapse the menu (the reference's handleBlur
                    // ignores the device-picker child). Choosing a device / Esc closes the
                    // picker via close_window("device-picker") → hide_tray_menu, which
                    // collapses the whole menu — so it still dismisses correctly afterward.
                    let picker_open = app_handle
                        .get_webview_window("device-picker")
                        .map(|p| p.is_visible().unwrap_or(false))
                        .unwrap_or(false);
                    if !picker_open {
                        hide_tray_menu_internal(&app_handle);
                    }
                }
            }
        }
        _ => {}
    });

    // PRE-SHOW OFF-SCREEN (the reference parity: applyTrayMenuStyles → win.showInactive()).
    // Park the window off-screen and show it ONCE at startup so its transparent
    // webview surface composes and the React tree mounts + reports its real
    // content size (TRAY_MENU_RESIZE → resize_window → OS resize) while invisible.
    // By the time the user first right-clicks the tray, the window is already at
    // its final content size and merely needs repositioning — eliminating both the
    // OS show animation flicker AND the visible "grow/jump" from the post-mount
    // resize landing after the window was already on screen.
    let _ = window.set_position(LogicalPosition::new(OFFSCREEN, OFFSCREEN));
    if let Err(e) = window.show() {
        log::warn!("tray-menu pre-show (offscreen) failed: {e}");
    } else {
        TRAY_MENU_PRESHOWN.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::{clamp_to_work_area, TASKBAR_MARGIN};

    #[test]
    fn clamps_into_work_area_bottom_with_taskbar_margin() {
        // Desired bottom-right that would overflow → pulled in by menu size +
        // the taskbar margin (matches the reference clampToWorkArea semantics).
        let work_area = (0.0, 0.0, 1920.0, 1080.0);
        let menu = (280.0, 360.0);
        let (x, y) = clamp_to_work_area((1900.0, 1070.0), menu, work_area);
        assert_eq!(x, 1920.0 - 280.0);
        assert_eq!(y, 1080.0 - 360.0 - TASKBAR_MARGIN);
    }

    #[test]
    fn clamps_into_work_area_top_left() {
        let work_area = (100.0, 50.0, 1920.0, 1080.0);
        let (x, y) = clamp_to_work_area((-30.0, -10.0), (280.0, 360.0), work_area);
        assert_eq!(x, 100.0);
        assert_eq!(y, 50.0);
    }

    #[test]
    fn passes_through_when_inside() {
        let work_area = (0.0, 0.0, 1920.0, 1080.0);
        let (x, y) = clamp_to_work_area((500.0, 400.0), (280.0, 360.0), work_area);
        assert_eq!(x, 500.0);
        assert_eq!(y, 400.0);
    }
}
