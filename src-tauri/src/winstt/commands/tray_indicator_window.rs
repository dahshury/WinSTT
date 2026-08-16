// Tray-indicator pill: a small transparent popup that animates in over the
// notification-area corner (bottom-right, above the taskbar) to announce a
// recording-mode switch or a post-processing preset change made from a global
// hotkey while the settings window is not focused.
//
// This is the THIRD floating surface alongside the recording overlay pill and the
// dynamic island. It is a SEPARATE window from `overlay` so it can be on screen at
// the same time as an active transcription / TTS island — the two must never
// collide (see `lift_above_overlay`).
//
// Division of labor mirrors the overlay: the renderer (windows/tray-indicator.html
// → TrayIndicatorPage) owns ALL content + enter/exit animation, driven by the
// `settings:changed` broadcast it already receives. The backend only decides
// WHETHER to show (focus gate), WHERE (corner anchor + anti-collision), and
// performs the native show/hide. The renderer calls `tray_indicator_show` when it
// detects a change and `tray_indicator_hide` after its exit animation.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

/// A display rectangle in LOGICAL px, as `(x, y, width, height)`.
type LogicalRect = (f64, f64, f64, f64);
/// `(full_monitor_rect, work_area_rect)` for a display, each a [`LogicalRect`].
type MonitorRects = (LogicalRect, LogicalRect);

/// Window label == Vite entry key == WINDOW_SPECS spec label.
pub(crate) const TRAY_INDICATOR_LABEL: &str = "tray-indicator";

/// Window envelope (logical px). The visible pill hugs the bottom-right of this
/// box; the extra transparent room above/left is the runway for the slide-in.
pub(crate) const TRAY_INDICATOR_WIDTH: f64 = 320.0;
pub(crate) const TRAY_INDICATOR_HEIGHT: f64 = 132.0;

/// Gap between the pill envelope and the work-area edges at the tray corner.
const CORNER_MARGIN: f64 = 6.0;
/// Minimum gap forced between this pill and the recording overlay when they would
/// otherwise overlap.
const ANTI_COLLISION_GAP: f64 = 12.0;
const OFFSCREEN_POS: f64 = -10_000.0;

/// Desired native visibility — a hide that loses a race with a newer show checks
/// this before actually hiding.
static DESIRED_VISIBLE: AtomicBool = AtomicBool::new(false);

fn ensure_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    match crate::winstt::commands::windows::ensure_window(app, TRAY_INDICATOR_LABEL) {
        Ok(w) => Some(w),
        Err(_) => app.get_webview_window(TRAY_INDICATOR_LABEL),
    }
}

/// Guards the one-time NSPanel conversion of the tray-indicator window (macOS).
#[cfg(target_os = "macos")]
static PANEL_CONVERTED: AtomicBool = AtomicBool::new(false);

/// macOS: a non-activating, floating NSPanel subclass for the tray-indicator pill.
///
/// Like the recording overlay, this corner pill is an always-on-top floating
/// surface that must appear over the user's active app WITHOUT stealing focus.
/// `tauri-nspanel` swizzles the tao NSWindow into this class so it can float over
/// every Space / full-screen app and never becomes the key window — the macOS
/// analogue of the Windows `force_topmost` + `SWP_NOACTIVATE` treatment below.
#[cfg(target_os = "macos")]
mod macos_panel {
    // The `tauri_panel!` expansion calls `WebviewWindow::app_handle()`, which is a
    // `tauri::Manager` method — the trait must be in scope in THIS module (the
    // file-level import does not reach into a child `mod`).
    use tauri::Manager;

    tauri_nspanel::tauri_panel!(WinsttTrayIndicatorPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true,
            hides_on_deactivate: false,
        }
    });
}

/// Convert the tray-indicator window into a non-activating floating NSPanel
/// (idempotent). On failure, log and keep the normal always-on-top window.
#[cfg(target_os = "macos")]
fn ensure_tray_indicator_is_panel(window: &tauri::WebviewWindow) {
    if PANEL_CONVERTED.load(Ordering::SeqCst) {
        return;
    }
    let win = window.clone();
    // NSWindow class swizzling + AppKit configuration must run on the main thread.
    let _ = window.run_on_main_thread(move || {
        if PANEL_CONVERTED.swap(true, Ordering::SeqCst) {
            return;
        }
        use tauri_nspanel::{CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt};
        match win.to_panel::<macos_panel::WinsttTrayIndicatorPanel>() {
            Ok(panel) => {
                panel.set_style_mask(StyleMask::new().borderless().nonactivating_panel().value());
                panel.set_level(PanelLevel::Floating.into());
                panel.set_floating_panel(true);
                panel.set_collection_behavior(
                    CollectionBehavior::new()
                        .can_join_all_spaces()
                        .full_screen_auxiliary()
                        .stationary()
                        .value(),
                );
            }
            Err(error) => {
                PANEL_CONVERTED.store(false, Ordering::SeqCst);
                log::warn!(
                    "[tray-indicator] NSPanel conversion failed; keeping normal window: {error}"
                );
            }
        }
    });
}

/// Purely informational surfaces: they either cannot take focus at all or are
/// click-through, so seeing one focused would never mean "the user is looking at
/// the control they just used".
const NON_INTERACTIVE_WINDOWS: [&str; 3] = ["tray-indicator", "overlay", "model-footprint"];

/// The pill announces a switch the user could not otherwise see, so it is
/// suppressed whenever an interactive WinSTT window HAS FOCUS — changing the mode
/// in Settings, or with the main pill's own push-to-talk button, is already
/// visible on screen and a corner pill just repeats it. Windows that are open but
/// in the background (or closed) still get the pill, which is the global-hotkey
/// case this surface exists for.
///
/// Checked across every interactive window rather than Settings alone: Settings is
/// a modal CHILD of `main`, so which of the two owns focus at broadcast time is
/// not something the caller should have to reason about.
fn winstt_surface_is_focused(app: &AppHandle) -> bool {
    app.webview_windows().iter().any(|(label, window)| {
        !NON_INTERACTIVE_WINDOWS.contains(&label.as_str())
            && window.is_visible().unwrap_or(false)
            && window.is_focused().unwrap_or(false)
    })
}

/// Show the tray-indicator pill anchored at the notification-area corner. Returns
/// `true` if it was actually shown, `false` when suppressed (a WinSTT window is
/// focused, so the switch is already visible).
#[tauri::command]
#[specta::specta]
pub fn tray_indicator_show(app: AppHandle) -> Result<bool, String> {
    if winstt_surface_is_focused(&app) {
        return Ok(false);
    }
    let Some(window) = ensure_window(&app) else {
        return Ok(false);
    };
    // macOS: convert to a non-activating floating NSPanel on first show (idempotent;
    // no-op elsewhere) so the corner pill floats over the active app without stealing
    // focus, matching the recording overlay's panel treatment.
    #[cfg(target_os = "macos")]
    ensure_tray_indicator_is_panel(&window);

    let (mut x, mut y) = corner_anchor(&app);
    if let Some((lx, ly)) = lift_above_overlay(&app, x, y) {
        x = lx;
        y = ly;
    }

    DESIRED_VISIBLE.store(true, Ordering::SeqCst);
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    let _ = set_window_opacity(&window, 1.0);
    let _ = window.show();
    #[cfg(target_os = "windows")]
    force_topmost(&window);
    Ok(true)
}

/// Hide the pill. The renderer calls this after its exit animation completes.
#[tauri::command]
#[specta::specta]
pub fn tray_indicator_hide(app: AppHandle) -> Result<(), String> {
    DESIRED_VISIBLE.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(TRAY_INDICATOR_LABEL) {
        // A newer show may have landed while the renderer's exit animation played.
        if DESIRED_VISIBLE.load(Ordering::SeqCst) {
            return Ok(());
        }
        let _ = set_window_opacity(&window, 0.0);
        let _ = window.set_position(tauri::LogicalPosition::new(OFFSCREEN_POS, OFFSCREEN_POS));
        let _ = window.hide();
    }
    Ok(())
}

/// Top-left position (logical px) that places the pill envelope's visible corner
/// against the taskbar's notification area. Chooses the corner nearest the tray
/// from the taskbar edge; defaults to bottom-right.
fn corner_anchor(app: &AppHandle) -> (f64, f64) {
    let (full, work) = monitor_rects(app);
    let (wx, wy, ww, wh) = work;
    let (fx, fy, _fw, fh) = full;

    // Which edge does the taskbar occupy? (work area is inset on that side.)
    let taskbar_bottom = (fy + fh) - (wy + wh) > 1.0;
    let taskbar_top = wy - fy > 1.0;
    let taskbar_left = wx - fx > 1.0;
    // right taskbar is the remaining case.

    // Horizontal: for top/bottom taskbars the tray sits at the right end; for a
    // left taskbar the tray column is on the left; for a right taskbar, the right.
    let x = if taskbar_left {
        wx + CORNER_MARGIN
    } else {
        (wx + ww) - TRAY_INDICATOR_WIDTH - CORNER_MARGIN
    };
    // Vertical: bottom taskbar / side taskbars → bottom corner; top taskbar → top.
    let y = if taskbar_top {
        wy + CORNER_MARGIN
    } else {
        let _ = taskbar_bottom;
        (wy + wh) - TRAY_INDICATOR_HEIGHT - CORNER_MARGIN
    };
    (x, y)
}

/// If the recording overlay is currently visible and its rect intersects the pill
/// at `(x, y)`, return a lifted position placing the pill fully ABOVE the overlay
/// (forced no-collision). Returns `None` when there is no overlap.
fn lift_above_overlay(app: &AppHandle, x: f64, y: f64) -> Option<(f64, f64)> {
    let overlay = app.get_webview_window("overlay")?;
    if !overlay.is_visible().unwrap_or(false) {
        return None;
    }
    let scale = overlay.scale_factor().unwrap_or(1.0);
    let pos = overlay.outer_position().ok()?;
    let size = overlay.outer_size().ok()?;
    let ox = pos.x as f64 / scale;
    let oy = pos.y as f64 / scale;
    let ow = size.width as f64 / scale;
    let oh = size.height as f64 / scale;

    let intersects = x < ox + ow
        && x + TRAY_INDICATOR_WIDTH > ox
        && y < oy + oh
        && y + TRAY_INDICATOR_HEIGHT > oy;
    if !intersects {
        return None;
    }

    // Park the pill just above the overlay's top edge, clamped into the work area.
    let (_, (_, wy, _, _)) = monitor_rects(app);
    let lifted_y = (oy - TRAY_INDICATOR_HEIGHT - ANTI_COLLISION_GAP).max(wy + CORNER_MARGIN);
    Some((x, lifted_y))
}

/// `(full_monitor_rect, work_area_rect)` for the primary display in LOGICAL px,
/// each as `(x, y, width, height)`.
#[cfg(target_os = "windows")]
fn monitor_rects(app: &AppHandle) -> MonitorRects {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromPoint,
    };

    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map_or(1.0, |m| m.scale_factor());

    // SAFETY: standard monitor-info query for the primary display.
    let info = unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut mi).as_bool() {
            Some(mi)
        } else {
            None
        }
    };

    if let Some(mi) = info {
        let to_rect = |r: windows::Win32::Foundation::RECT| {
            (
                r.left as f64 / scale,
                r.top as f64 / scale,
                (r.right - r.left) as f64 / scale,
                (r.bottom - r.top) as f64 / scale,
            )
        };
        return (to_rect(mi.rcMonitor), to_rect(mi.rcWork));
    }
    primary_fallback(app)
}

#[cfg(not(target_os = "windows"))]
fn monitor_rects(app: &AppHandle) -> MonitorRects {
    primary_fallback(app)
}

/// Fallback when the work area can't be queried: use the full monitor and assume a
/// conventional bottom taskbar inset so the pill still clears it.
fn primary_fallback(app: &AppHandle) -> MonitorRects {
    const ASSUMED_TASKBAR: f64 = 48.0;
    if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let scale = monitor.scale_factor();
        let mx = monitor.position().x as f64 / scale;
        let my = monitor.position().y as f64 / scale;
        let mw = monitor.size().width as f64 / scale;
        let mh = monitor.size().height as f64 / scale;
        let full = (mx, my, mw, mh);
        let work = (mx, my, mw, (mh - ASSUMED_TASKBAR).max(0.0));
        return (full, work);
    }
    let r = (0.0, 0.0, 1280.0, 720.0);
    (r, (0.0, 0.0, 1280.0, 720.0 - ASSUMED_TASKBAR))
}

#[cfg(target_os = "windows")]
fn set_window_opacity(window: &tauri::WebviewWindow, opacity: f64) -> Result<(), String> {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongPtrW, LWA_ALPHA, SetLayeredWindowAttributes, SetWindowLongPtrW,
        WS_EX_LAYERED,
    };

    let alpha = (opacity.clamp(0.0, 1.0) * 255.0).round() as u8;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    // SAFETY: `hwnd` is the native handle for the Tauri window; the style + opacity
    // calls are checked and take no ownership.
    unsafe {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_LAYERED.0 as isize);
        SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn set_window_opacity(_window: &tauri::WebviewWindow, _opacity: f64) -> Result<(), String> {
    Ok(())
}

/// Keep the pill above the topmost band without stealing focus from the user's
/// active app (SWP_NOACTIVATE), mirroring the overlay's z-order enforcement.
#[cfg(target_os = "windows")]
fn force_topmost(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetWindowPos,
    };
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(hwnd) = w.hwnd() {
            // SAFETY: reordering our own window to the topmost band, no move/resize.
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
