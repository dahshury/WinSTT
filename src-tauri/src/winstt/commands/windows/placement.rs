// Monitor work-area geometry + picker placement for the WinSTT window topology.
//
// Self-contained geometry: monitor work-area lookup, plain-window centering, the
// pure `compute_*` panel math, and the `place_*` emitters that anchor the
// transparent pickers. The placement emitters key off the shared `PICKER_STATE`
// in the parent module via `with_picker_state`; everything else here is pure.
//
// Extracted verbatim from the original `windows.rs` (no logic changes).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
};

use super::{with_picker_state, PickerAnchor, PickerState};

// ── Picker placement sequencing ─────────────────────────────────────────────

/// Monotonic open/close counter for the model-picker. Every open and every
/// hide/reset bumps it; the delayed re-emit (see `place_model_picker`) captures
/// the value at schedule time and only fires while it's still current — so a
/// close (or a reopen at a new anchor) during the 250ms wait invalidates a stray
/// re-emit that would otherwise re-plant a stale panel rect.
static MODEL_PICKER_SEQ: AtomicU64 = AtomicU64::new(0);

// ── Monitor work-area helpers (logical px) ──────────────────────────────────
// Deliberately uses `position()`+`size()` rather than `work_area()`: the latter
// forces `dpi::PhysicalRect`, which is not present in the pinned `dpi 0.1.2`.
// The fixed `TASKBAR_MARGIN` accounts for the taskbar gap instead — same
// approach the tray-menu placement uses.

const TASKBAR_MARGIN: f64 = 8.0;
/// Gap between the popup's bottom edge and the trigger that opened it. Mirrors
/// `ANCHOR_GAP` in the reference pickers.
const ANCHOR_GAP: f64 = 6.0;
// Keep in sync with `--dropdown-close-dur` in `src/app/styles/globals.css` and
// `MODEL_PICKER_CLOSE_MS` in the detached model-picker renderer.
const MODEL_PICKER_CLOSE_MS: u64 = 150;
const MODEL_PICKER_ANCHOR_REEMIT_MS: &[u64] = &[75, 250, 700];
/// Smallest usable model-picker height before we pin it to the screen top.
const MODEL_MIN_HEIGHT: f64 = 160.0;
/// Smallest usable device-picker height before we pin it to the screen top.
const DEVICE_MIN_HEIGHT: f64 = 140.0;

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

/// Logical-pixel monitor rect (x, y, width, height) for a point.
fn work_area_for_point(app: &AppHandle, point: (f64, f64)) -> (f64, f64, f64, f64) {
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
    (0.0, 0.0, 1920.0, 1080.0)
}

/// Outer position of a window in LOGICAL px (used to convert a child window's
/// viewport-space rect into screen space, like the reference's `senderWin.getBounds()`).
fn outer_position_logical(window: &tauri::WebviewWindow) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .outer_position()
        .map(|p| (p.x as f64 / scale, p.y as f64 / scale))
        .unwrap_or((0.0, 0.0))
}

// ── Centering (plain windows) ───────────────────────────────────────────────

/// Center `window` over the main pill if it's visible, else on the primary
/// display work area. Mirrors `openSettingsWindow`'s center-relative-to-main and
/// the onboarding/history/playground center-on-primary-display behavior.
pub(super) fn center_window(app: &AppHandle, window: &tauri::WebviewWindow, center_on_main: bool) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let (w, h) = window
        .inner_size()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((692.0, 560.0));

    if center_on_main {
        if let Some(main) = app.get_webview_window("main") {
            if main.is_visible().unwrap_or(false) {
                let mscale = main.scale_factor().unwrap_or(1.0);
                let (mx, my) = outer_position_logical(&main);
                let (mw, mh) = main
                    .outer_size()
                    .map(|s| (s.width as f64 / mscale, s.height as f64 / mscale))
                    .unwrap_or((420.0, 150.0));
                let x = (mx + (mw - w) / 2.0).round();
                let y = (my + (mh - h) / 2.0).round();
                // CLAMP into the monitor the pill is on. These windows are frameless
                // (no titlebar to drag them back), so a window centered on a pill near a
                // screen edge MUST NOT spill off-screen — clamp the top-left so the whole
                // window stays inside the work area.
                let work = work_area_for_point(app, (mx + mw / 2.0, my + mh / 2.0));
                let (cx, cy) = clamp_into_work_area(x, y, w, h, work);
                let _ = window.set_position(LogicalPosition::new(cx, cy));
                return;
            }
        }
    }

    // Center on the primary display work area.
    let (wx, wy, ww, wh) = work_area_for_point(app, (0.0, 0.0));
    let x = (wx + (ww - w) / 2.0).round();
    let y = (wy + (wh - h) / 2.0).round();
    let (cx, cy) = clamp_into_work_area(x, y, w, h, (wx, wy, ww, wh));
    let _ = window.set_position(LogicalPosition::new(cx, cy));
}

/// Clamp a window's top-left so the ENTIRE window (w×h) stays inside the work area
/// `(wx, wy, ww, wh)`. Prevents a frameless window from landing partly/fully
/// off-screen where it can't be dragged back.
fn clamp_into_work_area(x: f64, y: f64, w: f64, h: f64, work: (f64, f64, f64, f64)) -> (f64, f64) {
    let (wx, wy, ww, wh) = work;
    let max_x = (wx + ww - w).max(wx);
    let max_y = (wy + wh - h).max(wy);
    (x.clamp(wx, max_x), y.clamp(wy, max_y))
}

// ── Picker geometry (ported from the reference pickers) ──────────────────────

struct PanelBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    origin: &'static str,
}

/// Y-axis placement: open toward whichever side (above OR below the trigger) has
/// more room, gluing the popup `ANCHOR_GAP` away from that trigger edge and
/// shrinking the height to the available room. Ties favour ABOVE (the historical
/// behaviour). When neither side has comfortable room (`min_height`) the trigger
/// is hogging the screen, so we pin to the work-area top as a last resort.
fn compute_y_axis(
    anchor: PickerAnchor,
    desired_height: f64,
    work_y: f64,
    work_h: f64,
    min_height: f64,
) -> (f64, f64) {
    let ceiling = work_h - TASKBAR_MARGIN;
    let room_above = anchor.screen_top - work_y - ANCHOR_GAP;
    let room_below = work_y + work_h - anchor.screen_bottom - ANCHOR_GAP;
    if room_below > room_above && room_below >= min_height {
        // Below has strictly more room (and fits): drop the popup under the trigger.
        let height = desired_height.min(room_below).min(ceiling);
        (anchor.screen_bottom + ANCHOR_GAP, height)
    } else if room_above >= min_height {
        // Above wins (or ties) and fits: glue the popup bottom above the trigger.
        let height = desired_height.min(room_above).min(ceiling);
        (anchor.screen_top - height - ANCHOR_GAP, height)
    } else {
        (work_y, desired_height.min(ceiling))
    }
}

/// X-axis placement: right-align the popup to the trigger's right edge, clamped
/// into the work area.
fn compute_x_axis(anchor: PickerAnchor, width: f64, work_x: f64, work_w: f64) -> f64 {
    let desired_x = anchor.screen_right - width;
    let max_x = work_x + work_w - width;
    desired_x.max(work_x).min(max_x.max(work_x))
}

fn compute_transform_origin(anchor: PickerAnchor, panel: &PanelBounds) -> &'static str {
    let anchor_center_x = (anchor.screen_left + anchor.screen_right) / 2.0;
    let anchor_center_y = (anchor.screen_top + anchor.screen_bottom) / 2.0;
    let panel_center_x = panel.x + panel.width / 2.0;
    let panel_center_y = panel.y + panel.height / 2.0;
    let vertical = if anchor_center_y < panel_center_y {
        "top"
    } else {
        "bottom"
    };
    let horizontal = if anchor_center_x < panel_center_x {
        "left"
    } else {
        "right"
    };
    match (vertical, horizontal) {
        ("top", "left") => "top-left",
        ("top", "right") => "top-right",
        ("bottom", "left") => "bottom-left",
        _ => "bottom-right",
    }
}

pub(super) fn visible_picker_open_should_toggle(label: &str) -> bool {
    label != "model-picker"
}

/// Compute the on-screen popup rect (logical px) from the anchor + desired size,
/// clamped into the monitor work area. `min_height` differs per picker.
fn compute_panel(
    anchor: PickerAnchor,
    desired: (f64, f64),
    work: (f64, f64, f64, f64),
    min_height: f64,
) -> PanelBounds {
    let (work_x, work_y, work_w, work_h) = work;
    let width = desired.0.min(work_w);
    let (y, height) = compute_y_axis(anchor, desired.1, work_y, work_h, min_height);
    let x = compute_x_axis(anchor, width, work_x, work_w);
    let mut panel = PanelBounds {
        x,
        y: y.max(work_y),
        width,
        height,
        origin: "top-left",
    };
    panel.origin = compute_transform_origin(anchor, &panel);
    panel
}

pub(super) fn close_model_picker_with_animation(app: &AppHandle, window: &tauri::WebviewWindow) {
    let seq = MODEL_PICKER_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("model-picker:closing", serde_json::Value::Null);

    let app2 = app.clone();
    let window2 = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(MODEL_PICKER_CLOSE_MS));
        if MODEL_PICKER_SEQ.load(Ordering::SeqCst) != seq {
            return;
        }
        let _ = app2.run_on_main_thread(move || {
            if MODEL_PICKER_SEQ.load(Ordering::SeqCst) != seq {
                return;
            }
            let _ = window2.hide();
            with_picker_state("model-picker", |s| s.anchor = None);
        });
    });
}

/// Place + show the MODEL picker: the window fills the display work area as a
/// transparent backdrop, and we emit `model-picker:anchor` with the window-local
/// panel rect so the renderer draws the visible panel around the chip.
fn place_model_picker(app: &AppHandle, window: &tauri::WebviewWindow, state: PickerState) {
    let Some(anchor) = state.anchor else {
        // A full-screen transparent model-picker without a panel looks like the
        // app hung and captures input. Keep it hidden until a real anchored open.
        log::warn!("model-picker open requested without an anchor; keeping it hidden");
        MODEL_PICKER_SEQ.fetch_add(1, Ordering::SeqCst);
        let _ = window.hide();
        return;
    };
    // Treat open as a repair/re-anchor operation. This cancels any delayed hide
    // from a close animation before it can race a fresh click.
    let seq = MODEL_PICKER_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let work = work_area_for_point(app, (anchor.screen_left, anchor.screen_top));
    let (work_x, work_y, work_w, work_h) = work;
    let panel = compute_panel(anchor, (state.width, state.height), work, MODEL_MIN_HEIGHT);

    // The window fills the whole work area; the panel is positioned inside it.
    let _ = window.set_position(LogicalPosition::new(work_x, work_y));
    let _ = window.set_size(LogicalSize::new(work_w, work_h));

    let payload = serde_json::json!({
        "x": panel.x - work_x,
        "y": panel.y - work_y,
        "width": panel.width,
        "height": panel.height,
        "origin": panel.origin,
        "mode": {
            "kind": state.mode.kind,
            "feature": state.mode.feature,
            "target": state.mode.target,
        },
    });

    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
    // Window-local panel coords = screen coords minus the work-area origin.
    // Show first so a hidden/suspended WebView2 has resumed before the event.
    let _ = app.emit("model-picker:anchor", payload.clone());

    // First-open and long-idle race: the listener may not have registered
    // or the hidden webview may need a beat after show. Duplicate anchors are
    // cheap and idempotent; the sequence guard cancels stale retries after close.
    let app2 = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        for delay_ms in MODEL_PICKER_ANCHOR_REEMIT_MS {
            let target = Duration::from_millis(*delay_ms);
            let elapsed = started.elapsed();
            if target > elapsed {
                std::thread::sleep(target - elapsed);
            }
            if MODEL_PICKER_SEQ.load(Ordering::SeqCst) != seq {
                return;
            }
            let _ = app2.emit("model-picker:anchor", payload.clone());
        }
    });
}

/// Place + show the DEVICE picker: the window IS sized to the popup bounds
/// (the renderer fills it with `h-screen w-screen items-end`), so no anchor
/// event is needed — just position + size + show.
fn place_device_picker(app: &AppHandle, window: &tauri::WebviewWindow, state: PickerState) {
    let Some(anchor) = state.anchor else {
        // A transparent always-on-top device picker without an anchor has no
        // visible panel, but still captures input. Keep it hidden until a tray
        // row supplies a real rect.
        log::warn!("device-picker open requested without an anchor; keeping it hidden");
        let _ = window.hide();
        return;
    };
    let work = work_area_for_point(app, (anchor.screen_left, anchor.screen_top));
    let panel = compute_panel(anchor, (state.width, state.height), work, DEVICE_MIN_HEIGHT);

    let _ = window.set_position(LogicalPosition::new(panel.x, panel.y));
    let _ = window.set_size(LogicalSize::new(panel.width, panel.height));
    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();
}

pub(super) fn place_picker(app: &AppHandle, label: &'static str, window: &tauri::WebviewWindow) {
    let state = with_picker_state(label, |s| s.clone());
    if label == "model-picker" {
        place_model_picker(app, window, state);
    } else {
        place_device_picker(app, window, state);
    }
}

/// Convert a trigger rect reported in the OPENER window's viewport coords into a
/// screen-space anchor (logical px). Mirrors the reference's `anchorFromRect`.
pub(super) fn anchor_from_rect(
    opener: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> PickerAnchor {
    let (ox, oy) = outer_position_logical(opener);
    let screen_left = ox + x;
    let screen_top = oy + y;
    PickerAnchor {
        screen_left,
        screen_right: screen_left + width,
        screen_top,
        screen_bottom: screen_top + height,
    }
}

/// Resolve the OPENER window — the one whose viewport the trigger rect is
/// measured in. We prefer the calling webview (Tauri injects it as the command's
/// `WebviewWindow` param — the exact analogue of the reference's `event.sender`), so
/// the picker anchors correctly whether the chip was clicked in the main pill OR
/// the settings window (ModelSettingsPanel opens the same picker). Falls back to
/// a sensible default window if the caller's webview can't be resolved.
pub(super) fn resolve_opener(
    app: &AppHandle,
    caller: &tauri::WebviewWindow,
    picker: &str,
) -> Option<tauri::WebviewWindow> {
    // The caller is itself the opener unless it IS the picker window (which can
    // happen for a re-emit); never anchor a picker to itself.
    if caller.label() != picker {
        return Some(caller.clone());
    }
    let fallback = if picker == "model-picker" {
        "main"
    } else {
        "tray-menu"
    };
    app.get_webview_window(fallback)
}

#[cfg(test)]
mod tests {
    use super::super::PickerAnchor;
    use super::{
        compute_panel, compute_x_axis, compute_y_axis, visible_picker_open_should_toggle,
        ANCHOR_GAP, MODEL_MIN_HEIGHT, TASKBAR_MARGIN,
    };

    #[test]
    fn model_picker_visible_open_repairs_instead_of_toggling() {
        assert!(!visible_picker_open_should_toggle("model-picker"));
        assert!(visible_picker_open_should_toggle("device-picker"));
    }

    #[test]
    fn y_axis_glues_above_trigger_when_more_room_above() {
        // Trigger low on the screen: far more room above than below → open above.
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 100.0,
            screen_top: 900.0,
            screen_bottom: 952.0,
        };
        let (y, h) = compute_y_axis(anchor, 560.0, 0.0, 1080.0, MODEL_MIN_HEIGHT);
        // Bottom glued ANCHOR_GAP above the trigger top.
        assert_eq!(y + h + ANCHOR_GAP, anchor.screen_top);
        assert_eq!(h, 560.0);
    }

    #[test]
    fn y_axis_opens_below_when_more_room_below() {
        // Trigger near the top: little room above, lots below → open below.
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 100.0,
            screen_top: 40.0,
            screen_bottom: 92.0,
        };
        let (y, h) = compute_y_axis(anchor, 560.0, 0.0, 1080.0, MODEL_MIN_HEIGHT);
        // Top glued ANCHOR_GAP below the trigger bottom.
        assert_eq!(y, anchor.screen_bottom + ANCHOR_GAP);
        assert_eq!(h, 560.0);
    }

    #[test]
    fn y_axis_shrinks_to_ceiling() {
        // Trigger pinned at the very bottom: room is above, height clamps to ceiling.
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 100.0,
            screen_top: 1080.0,
            screen_bottom: 1132.0,
        };
        let (_y, h) = compute_y_axis(anchor, 5000.0, 0.0, 1080.0, MODEL_MIN_HEIGHT);
        assert_eq!(h, 1080.0 - TASKBAR_MARGIN);
    }

    #[test]
    fn x_axis_right_aligns_and_clamps() {
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 500.0,
            screen_top: 900.0,
            screen_bottom: 952.0,
        };
        // Right-aligned to the trigger's right edge.
        assert_eq!(compute_x_axis(anchor, 200.0, 0.0, 1920.0), 300.0);
        // Clamped to the work-area left when the trigger is near the left edge.
        let near_left = PickerAnchor {
            screen_left: 0.0,
            screen_right: 50.0,
            screen_top: 900.0,
            screen_bottom: 952.0,
        };
        assert_eq!(compute_x_axis(near_left, 200.0, 0.0, 1920.0), 0.0);
    }

    #[test]
    fn panel_stays_inside_work_area() {
        let anchor = PickerAnchor {
            screen_left: 1900.0,
            screen_right: 1920.0,
            screen_top: 1070.0,
            screen_bottom: 1122.0,
        };
        let panel = compute_panel(
            anchor,
            (600.0, 560.0),
            (0.0, 0.0, 1920.0, 1080.0),
            MODEL_MIN_HEIGHT,
        );
        assert!(panel.x >= 0.0);
        assert!(panel.x + panel.width <= 1920.0 + 0.01);
        assert!(panel.y >= 0.0);
        assert_eq!(panel.origin, "bottom-right");
    }

    #[test]
    fn panel_origin_tracks_closest_trigger_edge_when_clamped_left() {
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 50.0,
            screen_top: 900.0,
            screen_bottom: 952.0,
        };
        let panel = compute_panel(
            anchor,
            (600.0, 560.0),
            (0.0, 0.0, 1920.0, 1080.0),
            MODEL_MIN_HEIGHT,
        );
        assert_eq!(panel.x, 0.0);
        assert_eq!(panel.origin, "bottom-left");
    }

    #[test]
    fn panel_origin_tracks_below_trigger_placement() {
        let anchor = PickerAnchor {
            screen_left: 400.0,
            screen_right: 500.0,
            screen_top: 40.0,
            screen_bottom: 92.0,
        };
        let panel = compute_panel(
            anchor,
            (300.0, 560.0),
            (0.0, 0.0, 1920.0, 1080.0),
            MODEL_MIN_HEIGHT,
        );
        assert_eq!(panel.y, anchor.screen_bottom + ANCHOR_GAP);
        assert_eq!(panel.origin, "top-right");
    }
}
