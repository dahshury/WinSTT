// PORT IMPL — WU-0 (app/PORT/10_frontend_port_plan.md §4b + lib_wiring.md).
//
// Window-management commands for the 9-window WinSTT topology. Each WinSTT
// Electron BrowserWindow becomes a Tauri WebviewWindow loading its own HTML
// entry (main at "/", the 8 secondary at "windows/<name>.html"). The chrome
// (size, transparency, decorations, always-on-top, skip-taskbar) is translated
// 1:1 from frontend/electron/main.ts + electron/ipc/*-window.ts.
//
// Creation policy (matches Electron's keep-alive semantics):
//   - `main` is created eagerly in lib.rs setup (NOT here).
//   - settings/history/onboarding/pickers/overlay/tray-menu/context-playground
//     are created LAZILY on first `open_window` and HIDDEN (not destroyed) on
//     `close_window`, so re-open preserves renderer state.
//
// Two placement regimes (ported from the Electron window creators):
//   - PLAIN windows (settings/history/onboarding/context-playground): created at
//     a fixed size, CENTERED (settings on the main pill, the rest on the primary
//     display), opaque backgroundColor, shown + focused. Hide-on-close.
//   - PICKER windows (model-picker/device-picker): a frameless transparent popup
//     anchored above the chip/row that opened it. The renderer sends the trigger's
//     viewport rect in `open_window`; we convert it to screen space via the OPENER
//     window's bounds, clamp the popup into the display work area, and:
//       * model-picker → fills the work area as a full-screen click-to-dismiss
//         backdrop, then EMITS `model-picker:anchor` with the window-local panel
//         rect so the renderer positions the visible panel (it stays invisible
//         until that event lands — this is why a naive `open_window` showed an
//         empty transparent window).
//       * device-picker → the window IS sized to the popup bounds (the renderer
//         fills it with `h-screen w-screen items-end`); no anchor event needed.
//
// HARD-RULE-safe: this is a NEW file under winstt/commands/. The orchestrator
// registers open_window/close_window/resize_window/anchor_window in lib.rs
// `collect_commands![]` and the 9 labels live in capabilities/default.json.
// Per-picker anchor/size is held in module-level statics (no `.manage()` needed).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindowBuilder,
};

/// Per-window chrome/geometry spec, ported from the Electron window creators.
struct WindowSpec {
    /// Tauri window label == the Vite entry key == the renderer's window name.
    label: &'static str,
    /// HTML entry relative to the frontendDist root ("windows/<x>.html").
    url: &'static str,
    title: &'static str,
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
    resizable: bool,
    decorations: bool,
    transparent: bool,
    always_on_top: bool,
    skip_taskbar: bool,
    shadow: bool,
    /// Whether the window starts mouse-click-through (overlay only).
    ignore_cursor: bool,
    /// Opaque background color (None for transparent popups). Mirrors the
    /// Electron `backgroundColor: "#09090b"` on the framed windows — prevents a
    /// white flash before the renderer paints.
    background: Option<(u8, u8, u8, u8)>,
}

/// WinSTT's dark substrate (`#09090b`), used as the opaque window background to
/// kill the white flash on the framed windows (settings/onboarding/…). Matches
/// the Electron `backgroundColor`.
const SUBSTRATE: Option<(u8, u8, u8, u8)> = Some((9, 9, 11, 255));

/// The 9-window table (main is created in lib.rs setup; listed here for resize).
const WINDOW_SPECS: &[WindowSpec] = &[
    WindowSpec {
        label: "main",
        url: "/",
        title: "WinSTT",
        width: 420.0,
        height: 150.0,
        min_width: 420.0,
        min_height: 150.0,
        resizable: false,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        ignore_cursor: false,
        background: None,
    },
    // Settings — 700×560 frameless, opaque, centered on the main pill. Ported
    // from main.ts createSettingsWindow().
    WindowSpec {
        label: "settings",
        url: "windows/settings.html",
        title: "WinSTT Settings",
        width: 700.0,
        height: 560.0,
        min_width: 700.0,
        min_height: 560.0,
        resizable: false,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        ignore_cursor: false,
        background: SUBSTRATE,
    },
    WindowSpec {
        label: "overlay",
        url: "windows/overlay.html",
        title: "WinSTT — Overlay",
        width: 720.0,
        height: 240.0,
        min_width: 720.0,
        min_height: 240.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        ignore_cursor: true,
        background: None,
    },
    WindowSpec {
        label: "tray-menu",
        url: "windows/tray-menu.html",
        title: "WinSTT",
        width: 280.0,
        height: 360.0,
        min_width: 1.0,
        min_height: 1.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        ignore_cursor: false,
        background: None,
    },
    // Model-picker — full-screen transparent backdrop. The visible panel is
    // positioned by the renderer via the `model-picker:anchor` event; the window
    // is resized to the display work area on open. Ported from
    // model-picker-window.ts (DEFAULT_WIDTH/HEIGHT are just the seed footprint).
    WindowSpec {
        label: "model-picker",
        url: "windows/model-picker.html",
        title: "WinSTT — Model Picker",
        width: 600.0,
        height: 560.0,
        min_width: 1.0,
        min_height: 1.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        ignore_cursor: false,
        background: None,
    },
    // Device-picker — frameless transparent popup sized to the device list,
    // anchored above the mic row in the tray menu. Ported from
    // device-picker-window.ts.
    WindowSpec {
        label: "device-picker",
        url: "windows/device-picker.html",
        title: "WinSTT — Devices",
        width: 320.0,
        height: 360.0,
        min_width: 1.0,
        min_height: 1.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        ignore_cursor: false,
        background: None,
    },
    // Onboarding — 720×620 framed/resizable, opaque, centered on the primary
    // display. Ported from onboarding-window.ts (ONBOARDING_WIDTH/HEIGHT +
    // minWidth 600 / minHeight 560 / resizable: true).
    WindowSpec {
        label: "onboarding",
        url: "windows/onboarding.html",
        title: "Welcome to WinSTT",
        width: 720.0,
        height: 620.0,
        min_width: 600.0,
        min_height: 560.0,
        resizable: true,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        ignore_cursor: false,
        background: SUBSTRATE,
    },
    WindowSpec {
        label: "history",
        url: "windows/history.html",
        title: "WinSTT — History",
        width: 900.0,
        height: 640.0,
        min_width: 600.0,
        min_height: 420.0,
        resizable: true,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        ignore_cursor: false,
        background: SUBSTRATE,
    },
    // Context-playground — debug-only framed/resizable window, always-on-top.
    // Ported from context-playground-window.ts (600×780, min 440×420).
    WindowSpec {
        label: "context-playground",
        url: "windows/context-playground.html",
        title: "WinSTT — Context Playground (debug)",
        width: 600.0,
        height: 780.0,
        min_width: 440.0,
        min_height: 420.0,
        resizable: true,
        decorations: false,
        transparent: false,
        always_on_top: true,
        skip_taskbar: false,
        shadow: true,
        ignore_cursor: false,
        background: SUBSTRATE,
    },
];

fn spec_for(label: &str) -> Option<&'static WindowSpec> {
    WINDOW_SPECS.iter().find(|s| s.label == label)
}

/// Is this a transparent anchored popup (model-picker / device-picker)?
fn is_picker(label: &str) -> bool {
    label == "model-picker" || label == "device-picker"
}

// ── Picker placement state ──────────────────────────────────────────────────
// The renderer reports a DESIRED footprint via `resize_window`; the trigger rect
// arrives via `open_window`. We keep both per-picker so a `resize_window` (the
// renderer's ResizeObserver fires after mount) re-anchors the popup to the same
// trigger with the now-correct size — exactly like the Electron pickers.

/// Anchor = the screen-space rect of the chip/row that opened the picker.
#[derive(Clone, Copy)]
struct PickerAnchor {
    /// Screen X of the trigger's left edge (logical px).
    screen_left: f64,
    /// Screen X of the trigger's right edge (logical px).
    screen_right: f64,
    /// Screen Y of the trigger's top edge (logical px).
    screen_top: f64,
}

#[derive(Clone, Copy)]
struct PickerState {
    anchor: Option<PickerAnchor>,
    width: f64,
    height: f64,
}

static PICKER_STATE: Mutex<Option<HashMap<&'static str, PickerState>>> = Mutex::new(None);

/// Default seed footprint per picker (the renderer overrides it on first resize).
fn picker_default_size(label: &str) -> (f64, f64) {
    match label {
        "model-picker" => (600.0, 560.0),
        _ => (320.0, 360.0),
    }
}

fn with_picker_state<R>(label: &'static str, f: impl FnOnce(&mut PickerState) -> R) -> R {
    let mut guard = PICKER_STATE.lock().expect("picker-state mutex poisoned");
    let map = guard.get_or_insert_with(HashMap::new);
    let (w, h) = picker_default_size(label);
    let entry = map.entry(label).or_insert(PickerState {
        anchor: None,
        width: w,
        height: h,
    });
    f(entry)
}

// ── Monitor work-area helpers (logical px) ──────────────────────────────────
// Deliberately uses `position()`+`size()` rather than `work_area()`: the latter
// forces `dpi::PhysicalRect`, which is not present in the pinned `dpi 0.1.2`.
// The fixed `TASKBAR_MARGIN` accounts for the taskbar gap instead — same
// approach the tray-menu placement uses.

const TASKBAR_MARGIN: f64 = 8.0;
/// Gap between the popup's bottom edge and the trigger that opened it. Mirrors
/// `ANCHOR_GAP` in the Electron pickers.
const ANCHOR_GAP: f64 = 6.0;
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
/// viewport-space rect into screen space, like Electron's `senderWin.getBounds()`).
fn outer_position_logical(window: &tauri::WebviewWindow) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .outer_position()
        .map(|p| (p.x as f64 / scale, p.y as f64 / scale))
        .unwrap_or((0.0, 0.0))
}

/// Ensure the labelled window exists (creating it lazily from its spec) and
/// return a handle. `main` is never (re)created here — it's owned by setup.
///
/// `pub(crate)` so the tray-menu command (`winstt/commands/tray_menu.rs`) can
/// lazily materialize the same `tray-menu` webview before anchoring it.
pub(crate) fn ensure_window(app: &AppHandle, label: &str) -> Result<tauri::WebviewWindow, String> {
    if let Some(existing) = app.get_webview_window(label) {
        return Ok(existing);
    }
    let spec = spec_for(label).ok_or_else(|| format!("unknown window '{label}'"))?;
    if label == "main" {
        return Err("main window must already exist".into());
    }

    let mut builder = WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.into()))
        .title(spec.title)
        .inner_size(spec.width, spec.height)
        .min_inner_size(spec.min_width, spec.min_height)
        .resizable(spec.resizable)
        .maximizable(false)
        .decorations(spec.decorations)
        .transparent(spec.transparent)
        .always_on_top(spec.always_on_top)
        .skip_taskbar(spec.skip_taskbar)
        .shadow(spec.shadow)
        .focused(false)
        .visible(false);

    if let Some((r, g, b, a)) = spec.background {
        builder = builder.background_color(tauri::webview::Color(r, g, b, a));
    }

    if let Some(data_dir) = crate::portable::data_dir() {
        // CRITICAL: every webview in the process MUST share ONE WebView2 user-data
        // folder — WebView2 allows only a single user-data-folder per process, and a
        // second webview requesting a DIFFERENT folder silently fails to load its
        // content (the window is created but its JS never runs → blank window). The
        // main window uses `data_dir/webview` (lib.rs setup), so every secondary
        // window MUST use the SAME path, NOT a per-label `webview-{label}` dir.
        builder = builder.data_directory(data_dir.join("webview"));
    }

    // DIAGNOSTIC: log when this webview actually LOADS its page (fires regardless of
    // whether the page's JS/invoke works), so we can tell "page never navigated/loaded"
    // apart from "page loaded but its invokes are blocked". Tauri `on_page_load`.
    {
        let diag_label = spec.label;
        builder = builder.on_page_load(move |_w, payload| {
            log::info!(
                "[webview-load:{diag_label}] {:?} url={}",
                payload.event(),
                payload.url()
            );
        });
    }

    let window = builder.build().map_err(|e| {
        log::error!("ensure_window: failed to build '{label}': {e}");
        e.to_string()
    })?;

    log::info!(
        "[webview-built:{label}] url={}",
        window.url().map(|u| u.to_string()).unwrap_or_else(|_| "<none>".into())
    );

    if spec.ignore_cursor {
        let _ = window.set_ignore_cursor_events(true);
    }
    Ok(window)
}

// ── Centering (plain windows) ───────────────────────────────────────────────

/// Center `window` over the main pill if it's visible, else on the primary
/// display work area. Mirrors `openSettingsWindow`'s center-relative-to-main and
/// the onboarding/history/playground center-on-primary-display behavior.
fn center_window(app: &AppHandle, window: &tauri::WebviewWindow, center_on_main: bool) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let (w, h) = window
        .inner_size()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((700.0, 560.0));

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
                let _ = window.set_position(LogicalPosition::new(x, y));
                return;
            }
        }
    }

    // Center on the primary display work area.
    let (wx, wy, ww, wh) = work_area_for_point(app, (0.0, 0.0));
    let x = (wx + (ww - w) / 2.0).round();
    let y = (wy + (wh - h) / 2.0).round();
    let _ = window.set_position(LogicalPosition::new(x, y));
}

// ── Picker geometry (ported from the Electron pickers) ──────────────────────

struct PanelBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Y-axis placement: glue the popup bottom `ANCHOR_GAP` above the trigger,
/// shrinking the height to the room above when the full height won't fit; if
/// there's basically no room above, pin to the work-area top.
fn compute_y_axis(
    anchor: PickerAnchor,
    desired_height: f64,
    work_y: f64,
    work_h: f64,
    min_height: f64,
) -> (f64, f64) {
    let room = anchor.screen_top - work_y - ANCHOR_GAP;
    let ceiling = work_h - TASKBAR_MARGIN;
    if room >= min_height {
        let height = desired_height.min(room).min(ceiling);
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
    PanelBounds {
        x,
        y: y.max(work_y),
        width,
        height,
    }
}

/// Place + show the MODEL picker: the window fills the display work area as a
/// transparent backdrop, and we emit `model-picker:anchor` with the window-local
/// panel rect so the renderer draws the visible panel above the chip.
fn place_model_picker(app: &AppHandle, window: &tauri::WebviewWindow, state: PickerState) {
    let Some(anchor) = state.anchor else {
        // No anchor yet (e.g. resize before open) — just show it; the next open
        // supplies the anchor.
        let _ = window.show();
        return;
    };
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
    });

    // Window-local panel coords = screen coords minus the work-area origin. A
    // GLOBAL emit (the established pattern in this codebase — the renderer
    // listens with a global `listen`); the model-picker webview is the only
    // window subscribed to `model-picker:anchor`, so a broadcast is exact.
    let _ = app.emit("model-picker:anchor", payload.clone());

    let _ = window.show();
    let _ = window.set_always_on_top(true);
    let _ = window.set_focus();

    // First-open race: on the lazy create the webview may not have registered
    // its `model-picker:anchor` listener yet when we emit above, so the panel
    // would stay invisible until the renderer's own mount-time
    // `MODEL_PICKER_RESIZE` round-trips. Re-emit once after a short delay so the
    // panel reveals promptly even on a cold first open (mirrors Electron's
    // `deferShowUntilLoaded`). Cheap, idempotent — the renderer just sets the
    // same rect again.
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let _ = app2.emit("model-picker:anchor", payload);
    });
}

/// Place + show the DEVICE picker: the window IS sized to the popup bounds
/// (the renderer fills it with `h-screen w-screen items-end`), so no anchor
/// event is needed — just position + size + show.
fn place_device_picker(app: &AppHandle, window: &tauri::WebviewWindow, state: PickerState) {
    let Some(anchor) = state.anchor else {
        let _ = window.show();
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

fn place_picker(app: &AppHandle, label: &'static str, window: &tauri::WebviewWindow) {
    let state = with_picker_state(label, |s| *s);
    if label == "model-picker" {
        place_model_picker(app, window, state);
    } else {
        place_device_picker(app, window, state);
    }
}

/// Convert a trigger rect reported in the OPENER window's viewport coords into a
/// screen-space anchor (logical px). Mirrors Electron's `anchorFromRect`.
fn anchor_from_rect(
    opener: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    _height: f64,
) -> PickerAnchor {
    let (ox, oy) = outer_position_logical(opener);
    let screen_left = ox + x;
    PickerAnchor {
        screen_left,
        screen_right: screen_left + width,
        screen_top: oy + y,
    }
}

/// Resolve the OPENER window — the one whose viewport the trigger rect is
/// measured in. We prefer the calling webview (Tauri injects it as the command's
/// `WebviewWindow` param — the exact analogue of Electron's `event.sender`), so
/// the picker anchors correctly whether the chip was clicked in the main pill OR
/// the settings window (ModelSettingsPanel opens the same picker). Falls back to
/// a sensible default window if the caller's webview can't be resolved.
fn resolve_opener(
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

/// Pre-create (hidden) every secondary window at STARTUP so `open_window` only ever
/// has to SHOW an already-built window. Building a `WebviewWindow` lazily *inside* the
/// synchronous `open_window` command handler hangs on Windows: WebView2 creation needs
/// the main thread's message loop to pump, but the command IS running on the main
/// thread and blocking it — so the window object is created yet its page never
/// navigates/loads (blank window, "nothing happens"). The tray-menu + recording
/// overlay already work precisely because they're built in `setup` (off the command
/// path). This mirrors Handy, which creates its windows eagerly at startup and only
/// `show()`/`hide()`s them thereafter. Idempotent — `ensure_window` early-returns for
/// any window that already exists, so tray-menu/overlay aren't rebuilt.
pub(crate) fn prewarm_windows(app: &AppHandle) {
    for spec in WINDOW_SPECS {
        if spec.label == "main" {
            continue; // created in lib.rs setup
        }
        match ensure_window(app, spec.label) {
            Ok(_) => log::info!("[prewarm] '{}' pre-created (hidden)", spec.label),
            Err(e) => log::warn!("[prewarm] '{}' failed: {e}", spec.label),
        }
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// `winstt_diag` — webview → backend log bridge. The secondary windows (settings /
/// model-picker / …) are separate webviews whose console + uncaught errors are
/// invisible to the Rust log, so a blank/non-rendering window leaves no trace. The
/// renderer entries install `window.onerror` + an "mounted" beacon that call this,
/// surfacing renderer crashes (the usual cause of a blank secondary window) in
/// handy.log where we can see them. Diagnostic; harmless to keep.
#[tauri::command]
#[specta::specta]
pub fn winstt_diag(label: String, level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[webview:{label}] {message}"),
        "warn" => log::warn!("[webview:{label}] {message}"),
        _ => log::info!("[webview:{label}] {message}"),
    }
}

/// `open_window` — create-if-needed, then show + focus the labelled window.
///
/// For the anchored pickers the renderer passes the trigger's viewport rect
/// (`x`/`y`/`width`/`height`); we convert it to a screen anchor via the CALLING
/// window (`webview`) and place the popup. For the plain windows the rect is
/// absent and we center + show.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub fn open_window(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    name: String,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    log::info!("open_window('{name}') invoked");
    // Resolve the static label so it can key the picker-state map / emit.
    let label: &'static str = match spec_for(&name) {
        Some(spec) => spec.label,
        None => return Err(format!("unknown window '{name}'")),
    };

    let window = ensure_window(&app, label)
        .inspect_err(|e| log::error!("open_window('{name}') ensure_window failed: {e}"))?;

    if is_picker(label) {
        // Picker open is a TOGGLE: a second open while visible closes it (the
        // chip/row toggles its own popup), matching the Electron pickers.
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            with_picker_state(label, |s| s.anchor = None);
            return Ok(());
        }

        // Stash the trigger anchor (converted to screen space via the opener =
        // the calling window).
        if let (Some(x), Some(y), Some(w), Some(h)) = (x, y, width, height) {
            if let Some(opener) = resolve_opener(&app, &webview, label) {
                let anchor = anchor_from_rect(&opener, x, y, w, h);
                with_picker_state(label, |s| s.anchor = Some(anchor));
            }
        }
        place_picker(&app, label, &window);
        return Ok(());
    }

    // Plain window: center (settings on the main pill, others on the primary
    // display), then show + focus. `settings` centers on main per Electron.
    center_window(&app, &window, label == "settings");
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

/// `close_window` — HIDE (not destroy) the labelled window so re-open keeps state.
#[tauri::command]
#[specta::specta]
pub fn close_window(app: AppHandle, name: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&name) {
        window.hide().map_err(|e| e.to_string())?;
    }
    // A closed picker forgets its anchor so a stray resize can't re-show it.
    if let Some(label) = spec_for(&name).map(|s| s.label) {
        if is_picker(label) {
            with_picker_state(label, |s| s.anchor = None);
        }
        // The device-picker is a tray-menu submenu: choosing a device (or Esc)
        // collapses the WHOLE menu, matching Electron's device-picker
        // `handleClose` (hideDevicePicker + hideTrayMenu).
        if label == "device-picker" {
            let _ = crate::winstt::commands::tray_menu::hide_tray_menu(app.clone());
        }
    }
    Ok(())
}

/// `resize_window` — set the desired footprint of the labelled window.
///
/// For the pickers the renderer's ResizeObserver reports the real content size
/// after mount; we store it and, if the popup is currently up, re-place it so it
/// stays glued to the same trigger with the now-correct size (and the model
/// picker re-emits its anchor). For other dynamically-sized windows we just set
/// the inner size.
#[tauri::command]
#[specta::specta]
pub fn resize_window(app: AppHandle, name: String, width: f64, height: f64) -> Result<(), String> {
    let label: Option<&'static str> = spec_for(&name).map(|s| s.label);

    if let Some(label) = label {
        if is_picker(label) {
            with_picker_state(label, |s| {
                s.width = width.max(1.0).ceil();
                s.height = height.max(1.0).ceil();
            });
            if let Some(window) = app.get_webview_window(label) {
                if window.is_visible().unwrap_or(false) {
                    place_picker(&app, label, &window);
                }
            }
            return Ok(());
        }
    }

    if let Some(window) = app.get_webview_window(&name) {
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }

    // The tray menu is `w-fit` and only reports its true content size after
    // mount (TRAY_MENU_RESIZE). Re-anchor it from the stored click point so it
    // stays glued there with the now-correct size instead of remaining clamped
    // against its initial (larger) footprint — mirrors Electron's resize →
    // re-anchor in tray-menu-window.ts.
    if label == Some("tray-menu") {
        let _ = crate::winstt::commands::tray_menu::reanchor_tray_menu(app.clone());
    }
    Ok(())
}

/// `anchor_window` — move the labelled window's top-left to (x, y) in logical
/// screen px. Used to place a detached window next to its trigger directly.
#[tauri::command]
#[specta::specta]
pub fn anchor_window(app: AppHandle, name: String, x: f64, y: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&name) {
        window
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Payload the renderer sends when finishing (or skipping) the onboarding wizard.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingFinishArgs {
    pub completed: bool,
    #[serde(default)]
    pub track: String,
}

/// `onboarding_finish` — hide the onboarding window and show main. Persisting
/// the `general.onboarded` flag rides the existing settings command; this
/// command only handles the window transition (mirrors ONBOARDING_FINISH).
#[allow(dead_code)] // superseded by winstt::commands::onboarding::onboarding_finish (de-command'd to avoid dup name)
pub fn onboarding_finish(app: AppHandle, _args: OnboardingFinishArgs) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("onboarding") {
        let _ = window.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        compute_panel, compute_x_axis, compute_y_axis, is_picker, spec_for, PickerAnchor,
        ANCHOR_GAP, MODEL_MIN_HEIGHT, TASKBAR_MARGIN,
    };

    #[test]
    fn known_labels_resolve() {
        for label in [
            "settings",
            "onboarding",
            "history",
            "model-picker",
            "device-picker",
            "tray-menu",
            "overlay",
            "context-playground",
        ] {
            assert!(spec_for(label).is_some(), "missing spec for {label}");
        }
        assert!(spec_for("nope").is_none());
    }

    #[test]
    fn only_pickers_are_pickers() {
        assert!(is_picker("model-picker"));
        assert!(is_picker("device-picker"));
        assert!(!is_picker("settings"));
        assert!(!is_picker("history"));
    }

    #[test]
    fn y_axis_glues_above_trigger_when_room() {
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 100.0,
            screen_top: 900.0,
        };
        let (y, h) = compute_y_axis(anchor, 560.0, 0.0, 1080.0, MODEL_MIN_HEIGHT);
        // Bottom glued ANCHOR_GAP above the trigger top.
        assert_eq!(y + h + ANCHOR_GAP, anchor.screen_top);
        assert_eq!(h, 560.0);
    }

    #[test]
    fn y_axis_pins_to_top_when_no_room() {
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 100.0,
            screen_top: 40.0,
        };
        let (y, _h) = compute_y_axis(anchor, 560.0, 0.0, 1080.0, MODEL_MIN_HEIGHT);
        assert_eq!(y, 0.0);
    }

    #[test]
    fn y_axis_shrinks_to_ceiling() {
        let anchor = PickerAnchor {
            screen_left: 0.0,
            screen_right: 100.0,
            screen_top: 1080.0,
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
        };
        // Right-aligned to the trigger's right edge.
        assert_eq!(compute_x_axis(anchor, 200.0, 0.0, 1920.0), 300.0);
        // Clamped to the work-area left when the trigger is near the left edge.
        let near_left = PickerAnchor {
            screen_left: 0.0,
            screen_right: 50.0,
            screen_top: 900.0,
        };
        assert_eq!(compute_x_axis(near_left, 200.0, 0.0, 1920.0), 0.0);
    }

    #[test]
    fn panel_stays_inside_work_area() {
        let anchor = PickerAnchor {
            screen_left: 1900.0,
            screen_right: 1920.0,
            screen_top: 1070.0,
        };
        let panel = compute_panel(anchor, (600.0, 560.0), (0.0, 0.0, 1920.0, 1080.0), MODEL_MIN_HEIGHT);
        assert!(panel.x >= 0.0);
        assert!(panel.x + panel.width <= 1920.0 + 0.01);
        assert!(panel.y >= 0.0);
    }
}
