// PORT IMPL — WU-0 (app/PORT/10_frontend_port_plan.md §4b + lib_wiring.md).
//
// Window-management commands for the 9-window WinSTT topology. Each WinSTT
// the reference BrowserWindow becomes a Tauri WebviewWindow loading its own HTML
// entry (main at "/", the 8 secondary at "windows/<name>.html"). The chrome
// (size, transparency, decorations, always-on-top, skip-taskbar) is translated
// 1:1 from frontend/electron/main.ts + electron/ipc/*-window.ts.
//
// Creation policy (matches the reference's keep-alive semantics):
//   - `main` is created eagerly in lib.rs setup (NOT here).
//   - settings/history/onboarding/pickers/overlay/tray-menu/context-playground
//     are created LAZILY on first `open_window` and HIDDEN (not destroyed) on
//     `close_window`, so re-open preserves renderer state.
//
// Two placement regimes (ported from the reference window creators):
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindowBuilder,
};

/// Per-window chrome/geometry spec, ported from the reference window creators.
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
    /// the reference `backgroundColor: "#09090b"` on the framed windows — prevents a
    /// white flash before the renderer paints.
    background: Option<(u8, u8, u8, u8)>,
}

/// WinSTT's dark substrate (`#09090b`), used as the opaque window background to
/// kill the white flash on the framed windows (settings/onboarding/…). Matches
/// the reference `backgroundColor`.
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
    // from main.ts createSettingsWindow(), but reworked into a MODAL CHILD of the
    // pill (owner = main, set in `ensure_window`): it sits above the pill, can't be
    // dismissed independently, and the pill is input-disabled while it's open
    // (`set_main_modal`) so the two read as one window. `skip_taskbar: true` keeps a
    // single taskbar/alt-tab entry (the owner relationship already hides it, this is
    // explicit). Not `always_on_top` — a modal floats above its OWNER, not all apps.
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
        skip_taskbar: true,
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
    // AUDIT #6: only present in debug builds. A 600×780 debug-only window must never
    // be prewarmed (or even creatable) in release; gating the WINDOW_SPECS entry drops
    // it from the prewarm loop, `spec_for`, and `open_window` in shipping builds. Pairs
    // with `CONTEXT_PLAYGROUND_ENABLED=false` in the renderer's debug-flags.ts.
    #[cfg(debug_assertions)]
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
// trigger with the now-correct size — exactly like the reference pickers.

/// Anchor = the screen-space rect of the chip/row that opened the picker.
#[derive(Clone, Copy)]
struct PickerAnchor {
    /// Screen X of the trigger's left edge (logical px).
    screen_left: f64,
    /// Screen X of the trigger's right edge (logical px).
    screen_right: f64,
    /// Screen Y of the trigger's top edge (logical px).
    screen_top: f64,
    /// Screen Y of the trigger's bottom edge (logical px).
    screen_bottom: f64,
}

#[derive(Clone, Copy)]
struct PickerState {
    anchor: Option<PickerAnchor>,
    width: f64,
    height: f64,
}

static PICKER_STATE: Mutex<Option<HashMap<&'static str, PickerState>>> = Mutex::new(None);

/// Monotonic open/close counter for the model-picker. Every open and every
/// hide/reset bumps it; the delayed re-emit (see `place_model_picker`) captures
/// the value at schedule time and only fires while it's still current — so a
/// close (or a reopen at a new anchor) during the 250ms wait invalidates a stray
/// re-emit that would otherwise re-plant a stale panel rect.
static MODEL_PICKER_SEQ: AtomicU64 = AtomicU64::new(0);
static SETTINGS_FADE_SEQ: AtomicU64 = AtomicU64::new(0);
static SETTINGS_OPACITY_BITS: AtomicU64 = AtomicU64::new(1.0f64.to_bits());

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
/// `ANCHOR_GAP` in the reference pickers.
const ANCHOR_GAP: f64 = 6.0;
const MODEL_PICKER_CLOSE_MS: u64 = 150;
const SETTINGS_FADE_MS: u64 = 150;
const SETTINGS_FADE_TICK_MS: u64 = 16;
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

fn settings_fade_alpha(progress: f64) -> f64 {
    let t = progress.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(3)
}

fn settings_fade_alpha_in(progress: f64) -> f64 {
    progress.clamp(0.0, 1.0).powi(3)
}

fn settings_opacity_byte(opacity: f64) -> u8 {
    (opacity.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn settings_fade_should_seed_hidden(label: &str, is_visible: bool) -> bool {
    label == "settings" && !is_visible
}

fn settings_current_opacity() -> f64 {
    f64::from_bits(SETTINGS_OPACITY_BITS.load(Ordering::SeqCst)).clamp(0.0, 1.0)
}

fn remember_settings_opacity(opacity: f64) {
    SETTINGS_OPACITY_BITS.store(opacity.clamp(0.0, 1.0).to_bits(), Ordering::SeqCst);
}

#[cfg(target_os = "windows")]
fn set_settings_window_opacity(window: &tauri::WebviewWindow, opacity: f64) -> Result<(), String> {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA,
        WS_EX_LAYERED,
    };

    remember_settings_opacity(opacity);
    let alpha = settings_opacity_byte(opacity);
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let layered_style = ex_style | WS_EX_LAYERED.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, layered_style);
        SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn set_settings_window_opacity(_window: &tauri::WebviewWindow, opacity: f64) -> Result<(), String> {
    remember_settings_opacity(opacity);
    Ok(())
}

fn start_settings_opacity_fade<F>(
    window: tauri::WebviewWindow,
    to: f64,
    easing: fn(f64) -> f64,
    on_complete: F,
) where
    F: FnOnce() + Send + 'static,
{
    let seq = SETTINGS_FADE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let from = settings_current_opacity();
    let to = to.clamp(0.0, 1.0);

    if (from - to).abs() <= f64::EPSILON {
        let _ = set_settings_window_opacity(&window, to);
        on_complete();
        return;
    }

    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        let mut on_complete = Some(on_complete);
        loop {
            if SETTINGS_FADE_SEQ.load(Ordering::SeqCst) != seq {
                return;
            }

            let elapsed = start.elapsed().as_millis() as f64;
            let progress = (elapsed / SETTINGS_FADE_MS as f64).min(1.0);
            let opacity = from + (to - from) * easing(progress);
            let _ = set_settings_window_opacity(&window, opacity);

            if progress >= 1.0 {
                let _ = set_settings_window_opacity(&window, to);
                if let Some(done) = on_complete.take() {
                    done();
                }
                return;
            }

            std::thread::sleep(std::time::Duration::from_millis(SETTINGS_FADE_TICK_MS));
        }
    });
}

fn animate_settings_open(window: tauri::WebviewWindow) {
    start_settings_opacity_fade(window, 1.0, settings_fade_alpha, || {});
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

    // Make Settings a modal child owned by the main pill. On Windows `parent()`
    // sets `main` as the OWNER window: Settings is always above it in the z-order,
    // is hidden when the pill is minimized, and is destroyed with it — exactly the
    // "they're the same thing" relationship we want. The pill is built in lib.rs
    // `setup` BEFORE `prewarm_windows`, so it always exists here. A failure to
    // parent (e.g. main somehow gone) degrades to a plain centered window — still
    // modal via `set_main_modal`, just not OS-owned.
    if spec.label == "settings" {
        match app.get_webview_window("main") {
            // `parent()` consumes the builder and doesn't hand it back on error, so
            // there's nothing to degrade to — surface the failure (it only happens
            // if the pill is genuinely gone, which never occurs in practice).
            Some(main) => {
                builder = builder
                    .parent(&main)
                    .map_err(|e| format!("parent settings to main failed: {e}"))?;
            }
            None => {
                log::warn!("ensure_window: main window missing; settings created without owner")
            }
        }
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
            log::debug!(
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

    log::debug!(
        "[webview-built:{label}] url={}",
        window
            .url()
            .map(|u| u.to_string())
            .unwrap_or_else(|_| "<none>".into())
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

/// Tell the model-picker renderer to drop its last panel rect (emits a `null`
/// `model-picker:anchor`). Called while the window is HIDDEN, so a reopen can't
/// flash the previous open's position before the fresh anchor lands: by the time
/// the window reshows, the panel is invisible and the new anchor reveals it in
/// place. Race-free precisely because it happens off-screen, not at show time.
fn reset_model_picker_panel(app: &AppHandle) {
    // Bump first so any in-flight delayed re-emit from the prior open is stale.
    MODEL_PICKER_SEQ.fetch_add(1, Ordering::SeqCst);
    let _ = app.emit("model-picker:anchor", serde_json::Value::Null);
}

fn close_model_picker_with_animation(app: &AppHandle, window: &tauri::WebviewWindow) {
    let seq = MODEL_PICKER_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("model-picker:closing", serde_json::Value::Null);

    let app2 = app.clone();
    let window2 = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(MODEL_PICKER_CLOSE_MS));
        if MODEL_PICKER_SEQ.load(Ordering::SeqCst) != seq {
            return;
        }
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            if MODEL_PICKER_SEQ.load(Ordering::SeqCst) != seq {
                return;
            }
            let _ = window2.hide();
            with_picker_state("model-picker", |s| s.anchor = None);
            reset_model_picker_panel(&app3);
        });
    });
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
    // panel reveals promptly even on a cold first open (mirrors the reference's
    // `deferShowUntilLoaded`). Cheap, idempotent — the renderer just sets the
    // same rect again.
    // This open's sequence number. The delayed re-emit below fires only while
    // it's still current — a close or reopen in the meantime bumps the counter
    // and cancels the stray re-emit (which would re-plant a stale panel).
    let seq = MODEL_PICKER_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(250));
        if MODEL_PICKER_SEQ.load(Ordering::SeqCst) == seq {
            let _ = app2.emit("model-picker:anchor", payload);
        }
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
/// screen-space anchor (logical px). Mirrors the reference's `anchorFromRect`.
fn anchor_from_rect(
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

/// Windows prewarmed EAGERLY (on the critical startup path), before any deferral.
/// These are the most-likely-opened secondaries — the recording `overlay` (shown on
/// the very first dictation) and the `tray-menu` (a right-click away). Building them
/// up front keeps the first interaction flicker-free. Everything else in WINDOW_SPECS
/// is deferred (see `prewarm_windows`).
const EAGER_PREWARM: &[&str] = &["overlay", "tray-menu"];

/// Pre-create (hidden) the secondary windows so `open_window` only ever has to SHOW an
/// already-built window. Building a `WebviewWindow` lazily *inside* the synchronous
/// `open_window` command handler hangs on Windows: WebView2 creation needs the main
/// thread's message loop to pump, but the command IS running on the main thread and
/// blocking it — so the window object is created yet its page never navigates/loads
/// (blank window, "nothing happens"). So we MUST still build them eagerly (off the
/// command path), just NOT all synchronously before the pill paints.
///
/// AUDIT #6: the original implementation built ALL 8 secondary WebView2 windows
/// synchronously in `setup()` BEFORE `show_main_window`, so the pill couldn't paint
/// until every one finished — the cost the splash existed to hide. We now split it:
///   - `overlay` + `tray-menu` are built eagerly (most-likely-opened first).
///   - settings / model-picker / device-picker / onboarding / history /
///     context-playground are DEFERRED to an idle `run_on_main_thread` callback that
///     runs after the main loop is pumping (i.e. after the pill is up). They still
///     build eagerly off the command path — NOT lazily inside `open_window` (which
///     hangs, see above) — just later. `open_window` → `ensure_window` is idempotent,
///     so a first-open that races the deferred build just creates it a beat early.
///
/// `prewarm_windows` itself must be called AFTER `show_main_window` in lib.rs so the
/// pill paints first. Idempotent — `ensure_window` early-returns for any window that
/// already exists, so nothing is rebuilt.
pub(crate) fn prewarm_windows(app: &AppHandle) {
    // 1) Eager: the windows the user is most likely to hit first.
    for label in EAGER_PREWARM {
        match ensure_window(app, label) {
            Ok(_) => log::debug!("[prewarm] '{label}' pre-created (hidden, eager)"),
            Err(e) => log::warn!("[prewarm] '{label}' failed: {e}"),
        }
    }

    // 2) Deferred: the rest, off the critical path. `run_on_main_thread` schedules the
    //    closure on the event loop, so it runs once `setup` has returned and the loop is
    //    pumping — i.e. after the pill is visible. WebView2 creation still happens on the
    //    main thread (required) but no longer blocks first paint.
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        for spec in WINDOW_SPECS {
            if spec.label == "main" {
                continue; // created in lib.rs setup
            }
            if EAGER_PREWARM.contains(&spec.label) {
                continue; // already built eagerly above
            }
            match ensure_window(&app, spec.label) {
                Ok(_) => log::debug!("[prewarm] '{}' pre-created (hidden, deferred)", spec.label),
                Err(e) => log::warn!("[prewarm] '{}' failed: {e}", spec.label),
            }
        }
    });
}

// ── Settings modal (pill input gate) ────────────────────────────────────────

/// Enable/disable the main pill's input while the Settings modal is up. Pairs the
/// OS owner relationship (set in `ensure_window`) with the Win32 modal idiom
/// (`set_enabled(false)` ⇒ clicks/focus on the owner just flash the modal) so the
/// pill can't be focused while Settings is open and the two behave as one window.
/// Re-enabled on every Settings close path (`close_self_window` / `close_window` /
/// the native `CloseRequested` in lib.rs). No-op if the pill is gone. Harmless on
/// non-Windows (`set_enabled` is cross-platform).
pub(crate) fn set_main_modal(app: &AppHandle, modal_active: bool) {
    if let Some(main) = app.get_webview_window("main") {
        if let Err(e) = main.set_enabled(!modal_active) {
            log::warn!("set_main_modal({modal_active}): {e}");
        }
    }
}

fn close_settings_window(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if !window.is_visible().unwrap_or(false) {
        set_main_modal(&app, false);
        let _ = set_settings_window_opacity(&window, 0.0);
        return Ok(());
    }

    let fade_window = window.clone();
    start_settings_opacity_fade(fade_window, 0.0, settings_fade_alpha_in, move || {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Preserve the Win32 modal teardown ordering: re-enable the owner before
            // hiding the child so Windows can reactivate the pill immediately.
            set_main_modal(&app2, false);
            let _ = window.hide();
            if let Some(main) = app2.get_webview_window("main") {
                let _ = main.set_focus();
            }
        });
    });
    Ok(())
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
        _ => log::debug!("[webview:{label}] {message}"),
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
    log::debug!("open_window('{name}') invoked");
    // Resolve the static label so it can key the picker-state map / emit.
    let label: &'static str = match spec_for(&name) {
        Some(spec) => spec.label,
        None => return Err(format!("unknown window '{name}'")),
    };

    let window = ensure_window(&app, label)
        .inspect_err(|e| log::error!("open_window('{name}') ensure_window failed: {e}"))?;

    if is_picker(label) {
        // Picker open is a TOGGLE: a second open while visible closes it (the
        // chip/row toggles its own popup), matching the reference pickers.
        if window.is_visible().unwrap_or(false) {
            if label == "model-picker" {
                close_model_picker_with_animation(&app, &window);
            } else {
                let _ = window.hide();
                with_picker_state(label, |s| s.anchor = None);
            }
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
    // display), then show + focus. `settings` centers on main per the reference.
    center_window(&app, &window, label == "settings");
    let was_visible = window.is_visible().unwrap_or(false);
    if settings_fade_should_seed_hidden(label, was_visible) {
        let _ = set_settings_window_opacity(&window, 0.0);
    }
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    // Settings is a modal child of the pill: disable the pill (after Settings has
    // grabbed focus) so it can't be focused/clicked while open. Re-enabled when
    // Settings closes (close_self_window / close_window / CloseRequested).
    if label == "settings" {
        set_main_modal(&app, true);
        animate_settings_open(window.clone());
    }
    Ok(())
}

/// `close_window` — HIDE (not destroy) the labelled window so re-open keeps state.
#[tauri::command]
#[specta::specta]
pub fn close_window(app: AppHandle, name: String) -> Result<(), String> {
    // The tray-menu is kept always-shown and parked OFF-SCREEN (see tray_menu.rs
    // OFFSCREEN) so re-open is a flicker-free reposition. The renderer's primary
    // dismiss — a menu-item click — routes here via TRAY_MENU_CLOSE; a real hide()
    // would leave it OS-hidden, and place_tray_menu no longer calls show() once it
    // has been pre-shown, so the menu would never reappear. Park it instead, mirroring
    // the reference's tray-menu:close → hideTrayMenu → moveOffscreen.
    if name == "tray-menu" {
        return crate::winstt::commands::tray_menu::hide_tray_menu(app);
    }
    if name == "settings" {
        if let Some(window) = app.get_webview_window(&name) {
            return close_settings_window(app, window);
        }
        set_main_modal(&app, false);
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(&name) {
        if name == "model-picker" {
            close_model_picker_with_animation(&app, &window);
            return Ok(());
        }
        window.hide().map_err(|e| e.to_string())?;
    }
    // A closed picker forgets its anchor so a stray resize can't re-show it.
    if let Some(label) = spec_for(&name).map(|s| s.label) {
        if is_picker(label) {
            with_picker_state(label, |s| s.anchor = None);
            if label == "model-picker" {
                reset_model_picker_panel(&app);
            }
        }
        // The device-picker is a tray-menu submenu: choosing a device (or Esc)
        // collapses the WHOLE menu, matching the reference's device-picker
        // `handleClose` (hideDevicePicker + hideTrayMenu).
        if label == "device-picker" {
            let _ = crate::winstt::commands::tray_menu::hide_tray_menu(app.clone());
        }
    }
    Ok(())
}

/// `close_self_window` — hide the CALLING window (resolved from its own webview
/// label), the Rust-side equivalent of the renderer's `getCurrentWindow().hide()`.
/// The self-closing secondary windows (settings / onboarding) route their close
/// button here instead of a bare webview hide so the Settings modal can release the
/// pill's input lock as it closes — the renderer hide path never reached Rust, so
/// the pill would otherwise stay disabled forever. For non-settings callers this is
/// a plain hide, identical to the old behaviour.
#[tauri::command]
#[specta::specta]
pub fn close_self_window(app: AppHandle, webview: tauri::WebviewWindow) -> Result<(), String> {
    let label = webview.label().to_string();
    if label == "settings" {
        return close_settings_window(app, webview);
    }
    webview.hide().map_err(|e| e.to_string())?;
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
        // NO-OP GUARD (the reference's `sizeUnchanged` in tray-menu-window.ts): the
        // renderer's ResizeObserver fires on EVERY reflow — hover, focus ring,
        // sub-pixel layout — and frequently reports the SAME content size. Without
        // this guard each repeat calls `set_size`, which emits a `Resized` event,
        // which re-anchors, which can jitter the window. Round to integer logical
        // px (the OS window granularity) and skip when the size hasn't changed.
        let next_w = width.max(1.0).ceil() as u32;
        let next_h = height.max(1.0).ceil() as u32;
        let scale = window.scale_factor().unwrap_or(1.0);
        let current = window.inner_size().ok().map(|s| {
            (
                (s.width as f64 / scale).round() as u32,
                (s.height as f64 / scale).round() as u32,
            )
        });
        if current != Some((next_w, next_h)) {
            window
                .set_size(LogicalSize::new(f64::from(next_w), f64::from(next_h)))
                .map_err(|e| e.to_string())?;

            // The tray menu is `w-fit` and only reports its true content size after
            // mount (TRAY_MENU_RESIZE). Re-anchor it from the stored click point so it
            // stays glued there with the now-correct size instead of remaining clamped
            // against its initial (larger) footprint — mirrors the reference's resize →
            // re-anchor in tray-menu-window.ts. Only fires when the size ACTUALLY
            // changed, so a steady-state ResizeObserver storm no longer re-anchors.
            if label == Some("tray-menu") {
                let _ = crate::winstt::commands::tray_menu::reanchor_tray_menu(app.clone());
            }
        }
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
        compute_panel, compute_x_axis, compute_y_axis, is_picker, settings_fade_alpha,
        settings_fade_should_seed_hidden, settings_opacity_byte, spec_for, PickerAnchor,
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
    fn settings_open_fade_uses_cubic_ease_out() {
        assert_eq!(settings_fade_alpha(0.0), 0.0);
        assert_eq!(settings_fade_alpha(1.0), 1.0);

        let halfway = settings_fade_alpha(0.5);
        assert!(
            (halfway - 0.875).abs() < f64::EPSILON,
            "expected cubic ease-out halfway alpha, got {halfway}"
        );
    }

    #[test]
    fn settings_opacity_maps_to_win32_alpha_byte() {
        assert_eq!(settings_opacity_byte(-1.0), 0);
        assert_eq!(settings_opacity_byte(0.0), 0);
        assert_eq!(settings_opacity_byte(0.5), 128);
        assert_eq!(settings_opacity_byte(1.0), 255);
        assert_eq!(settings_opacity_byte(2.0), 255);
    }

    #[test]
    fn settings_hidden_window_is_seeded_transparent_before_show() {
        assert!(settings_fade_should_seed_hidden("settings", false));
        assert!(!settings_fade_should_seed_hidden("settings", true));
        assert!(!settings_fade_should_seed_hidden("history", false));
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
    }
}
