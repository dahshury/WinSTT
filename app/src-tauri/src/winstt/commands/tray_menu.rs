// PORT IMPL — WU-12 (app/PORT/10_frontend_port_plan.md §6 WU-12 + §4b).
//
// Tray-menu window placement. WinSTT's tray menu is NOT a native OS menu — it is
// a custom transparent HTML BrowserWindow (`views/tray-menu`) the user pops open
// from the tray icon, anchored at the icon/cursor location and clamped to the
// monitor work area. This file ports the Electron `tray-menu-window.ts` logic
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

use std::sync::Mutex;
use tauri::{AppHandle, LogicalPosition, Manager, PhysicalPosition, PhysicalSize};

use super::windows::ensure_window;

/// Label of the tray-menu webview (== Vite entry key == renderer window name).
const TRAY_MENU_LABEL: &str = "tray-menu";

/// Visual gap left above the taskbar. Mirrors `TASKBAR_MARGIN` in the Electron
/// `tray-menu-window.ts`: on Windows 11 the taskbar's rounded/translucent top
/// edge extends a few px above the work-area boundary, so a flush menu visually
/// overlaps it. Native context menus leave a small gap; we replicate that.
const TASKBAR_MARGIN: f64 = 8.0;

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
/// leaving `TASKBAR_MARGIN` at the bottom. Byte-for-byte port of the Electron
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

/// Core placement: ensure the tray-menu window exists, read its CURRENT logical
/// size, clamp the anchor to the monitor work area, position + show + focus it.
fn place_tray_menu(app: &AppHandle, anchor: (f64, f64)) -> Result<(), String> {
    let window = ensure_window(app, TRAY_MENU_LABEL)?;

    // Use the window's live logical inner size so the clamp matches what the
    // renderer's ResizeObserver has reported (the menu is `w-fit` and reports
    // its real size right after mount via TRAY_MENU_RESIZE → resize_window).
    let scale = window.scale_factor().unwrap_or(1.0);
    let menu_size = window
        .inner_size()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((280.0, 360.0));

    let work_area = monitor_rect_for_point(app, anchor);
    let (px, py) = clamp_to_work_area(anchor, menu_size, work_area);

    window
        .set_position(LogicalPosition::new(px, py))
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

/// `show_tray_menu` — open the custom HTML tray menu anchored at (x, y) in
/// logical screen px, or at the cursor when omitted. Stores the anchor so a
/// later resize can re-anchor. Mirrors Electron's `showTrayMenuAt`.
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
/// anchor, matching Electron's `hideTrayMenu` (window keep-alive semantics).
#[tauri::command]
#[specta::specta]
pub fn hide_tray_menu(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    if let Some(state) = app.try_state::<TrayMenuAnchor>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = None;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{clamp_to_work_area, TASKBAR_MARGIN};

    #[test]
    fn clamps_into_work_area_bottom_with_taskbar_margin() {
        // Desired bottom-right that would overflow → pulled in by menu size +
        // the taskbar margin (matches Electron clampToWorkArea semantics).
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
