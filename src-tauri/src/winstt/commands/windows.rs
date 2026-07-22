// Window-management commands for the WinSTT window topology. Each WinSTT
// the reference BrowserWindow becomes a Tauri WebviewWindow loading its own HTML
// entry (main at "/", secondary windows at "windows/<name>.html"). The chrome
// (size, transparency, decorations, always-on-top, skip-taskbar) is translated
// 1:1 from the reference window creators.
//
// Creation policy (matches the reference's keep-alive semantics):
//   - `main` is created eagerly in lib.rs setup (NOT here).
//   - settings/history/onboarding/pickers/overlay/tray-menu are created LAZILY on
//     first `open_window` and HIDDEN (not destroyed) on `close_window`, so re-open
//     preserves renderer state.
//   - optional context-playground is created lazily but DESTROYED on close,
//     resetting its live-capture renderer state.
//
// Two placement regimes (ported from the reference window creators):
//   - PLAIN windows (settings/history/onboarding and optional context-playground): created at
//     a fixed size, CENTERED (settings on the main pill, the rest on the primary
//     display), opaque backgroundColor, shown + focused. Hide-on-close except for
//     the debug-only context-playground, which is destroy-on-close.
//   - PICKER windows (model-picker/model-footprint): a frameless transparent popup
//     anchored around the chip/row that opened it. The renderer sends the trigger's
//     viewport rect in `open_window`; we convert it to screen space via the OPENER
//     window's bounds, clamp the popup into the display work area, and:
//       * model-picker → fills the work area as a full-screen click-to-dismiss
//         backdrop, then EMITS `model-picker:anchor` with the window-local panel
//         rect so the renderer positions the visible panel (it stays invisible
//         until that event lands — this is why a naive `open_window` showed an
//         empty transparent window).
//       * model-footprint → the window IS sized to the popup bounds; no anchor
//         event is needed.
//
// HARD-RULE-safe: this is a NEW file under winstt/commands/. The orchestrator
// registers open_window/close_window/resize_window/anchor_window in lib.rs
// `collect_commands![]` and the 9 labels live in capabilities/default.json.
// Per-picker anchor/size is held in module-level statics (no `.manage()` needed).
//
// This module is split into siblings under `windows/`:
//   - `settings_modal` — the settings-modal fade/opacity state machine.
//   - `placement` — monitor work-area geometry + picker placement.
// The public surface (`ensure_window`, the modal lifecycle, and the 9
// `#[tauri::command]` fns) stays here so every external path is byte-for-byte
// unchanged; the submodules' entry points are re-used below.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder,
};

use crate::winstt::observability::IssueBuilder;
use crate::winstt::sync_ext::MutexExt;

pub(crate) mod placement;
mod settings_modal;

use placement::{
    anchor_from_rect, center_window, close_model_picker_with_animation,
    complete_model_picker_close, emit_model_picker_anchor_snapshot, place_picker, resolve_opener,
};
use settings_modal::close_main_modal_window;

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

/// Window specs (main is created in lib.rs setup; listed here for resize).
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
    // Settings — frameless TRANSPARENT window centered on the main pill; the
    // renderer draws the entire window visual (rounded card + border + shadow)
    // and animates it in/out as ONE unit, so the window is invisible until the
    // renderer reveals fully-ready content (no opaque frame can ever appear
    // before the tab content). 940×680 = the 900×640 card + a 20px transparent
    // gutter for the CSS shadow. Reworked into a MODAL CHILD of the pill
    // (owner = main, set in `ensure_window`): it sits above the pill, can't be
    // dismissed independently, and the pill is input-disabled while it's open
    // (`set_main_modal`) so the two read as one window. `skip_taskbar: true`
    // keeps a single taskbar/alt-tab entry. `shadow: false` — a DWM shadow on a
    // transparent undecorated window draws a SQUARE outline that ignores the
    // CSS rounding; the shadow is painted by the renderer instead.
    WindowSpec {
        label: "settings",
        url: "windows/settings.html",
        title: "WinSTT Settings",
        width: 940.0,
        height: 680.0,
        min_width: 940.0,
        min_height: 680.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: false,
        skip_taskbar: true,
        shadow: false,
        ignore_cursor: false,
        background: None,
    },
    // What's New — a dedicated modal child rather than an in-page dialog. The
    // main pill is only 420x150, so a renderer-owned modal there is necessarily
    // clipped to that tiny native viewport. This window gives the release notes
    // a 640x680 card plus a transparent gutter for its rounded shell/shadow.
    WindowSpec {
        label: "whats-new",
        url: "windows/whats-new.html",
        title: "WinSTT — What's New",
        width: 680.0,
        height: 720.0,
        min_width: 680.0,
        min_height: 720.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: false,
        skip_taskbar: true,
        shadow: false,
        ignore_cursor: false,
        background: None,
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
    // Tray-indicator pill — a small transparent, click-through, non-focusable
    // popup anchored over the notification-area corner. Shows the current recording
    // mode / post-processing preset on a global-hotkey switch and animates in/out.
    // Coexists with the `overlay` pill (both can be on screen), so it is its OWN
    // window. `ignore_cursor: true` (purely informational — never interactive) and
    // built non-focusable in `ensure_window` so showing it never steals keyboard
    // focus from the user's active app.
    WindowSpec {
        label: "tray-indicator",
        url: "windows/tray-indicator.html",
        title: "WinSTT — Mode",
        width: 320.0,
        height: 132.0,
        min_width: 1.0,
        min_height: 1.0,
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
        // Initial size only — the renderer's ResizeObserver immediately resizes
        // the window to the menu's true (capped) content size. Kept close to the
        // compact menu shell width so there's no oversized first frame.
        width: 196.0,
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
    // Model-footprint — a tiny NON-FOCUSABLE hover panel, sized to its content
    // like the device picker and anchored above the footer GPU/CPU chip. It hosts
    // the model-footprint breakdown that's too tall for the 420×150 main window.
    // `ensure_window` builds it `focusable(false)` and click-through so showing
    // it cannot steal focus or pointer ownership from the chip that keeps the
    // hover open. It is content-sized (not a full-screen backdrop).
    WindowSpec {
        label: "model-footprint",
        url: "windows/model-footprint.html",
        title: "WinSTT — Model Footprint",
        // 280×420 content plus a 6px transparent compositor gutter per edge.
        width: 292.0,
        height: 432.0,
        min_width: 1.0,
        min_height: 1.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        ignore_cursor: true,
        background: None,
    },
    // Onboarding — renderer-owned frameless window, matching Settings: the
    // native viewport is transparent and provides a 20px gutter around the
    // rounded CSS shell and its shadow. The extra 40px preserves the original
    // 720×620 usable shell while retaining the existing resize behavior.
    WindowSpec {
        label: "onboarding",
        url: "windows/onboarding.html",
        title: "Welcome to WinSTT",
        width: 760.0,
        height: 660.0,
        min_width: 640.0,
        min_height: 600.0,
        resizable: true,
        decorations: false,
        transparent: true,
        always_on_top: false,
        skip_taskbar: false,
        shadow: false,
        ignore_cursor: false,
        background: None,
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
    // Context-playground — debug-only decorated/resizable window.
    // Ported from context-playground-window.ts (600×780, min 440×420).
    // Present in dev (debug_assertions) or with the `context-playground`
    // feature; dropped from `spec_for`/`open_window` in shipping builds. It is NOT
    // opened only on demand. Pairs with `CONTEXT_PLAYGROUND_ENABLED`
    // (= `import.meta.env.DEV`) in debug-flags.ts.
    #[cfg(any(debug_assertions, feature = "context-playground"))]
    WindowSpec {
        label: "context-playground",
        url: "windows/context-playground.html",
        title: "WinSTT — Context Playground (debug)",
        width: 600.0,
        height: 780.0,
        min_width: 440.0,
        min_height: 420.0,
        resizable: true,
        decorations: true,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        ignore_cursor: false,
        background: SUBSTRATE,
    },
];

fn spec_for(label: &str) -> Option<&'static WindowSpec> {
    WINDOW_SPECS.iter().find(|s| s.label == label)
}

fn known_window_label(label: &str) -> Result<&'static str, String> {
    spec_for(label)
        .map(|s| s.label)
        .ok_or_else(|| format!("unknown window '{label}'"))
}

/// Is this a transparent anchored popup (model-picker / model-footprint)?
fn is_picker(label: &str) -> bool {
    label == "model-picker" || label == "model-footprint"
}

#[derive(Clone, Copy, Debug)]
enum WindowOperation {
    Open,
    Close,
    Resize,
    Anchor,
}

impl WindowOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Close => "close",
            Self::Resize => "resize",
            Self::Anchor => "anchor",
        }
    }
}

fn is_window_operation_allowed(caller: &str, operation: WindowOperation, target: &str) -> bool {
    match operation {
        WindowOperation::Open => match target {
            // Main app surfaces that legitimately open secondary work surfaces.
            // `onboarding` is allowed too: its final overview step deep-links into
            // Settings so the user can configure a capability right away.
            "settings" => matches!(caller, "main" | "tray-menu" | "onboarding"),
            "whats-new" => caller == "main",
            "history" | "onboarding" => caller == "main",
            // `onboarding` opens the SAME detached picker the settings Main-model
            // selector uses, so the wizard's model choice goes through the one
            // canonical swap/reload + download-gating path instead of a bespoke one.
            "model-picker" => matches!(caller, "main" | "settings" | "onboarding"),
            // The footer GPU/CPU chip (main window) opens the footprint hover panel.
            "model-footprint" => caller == "main",
            #[cfg(any(debug_assertions, feature = "context-playground"))]
            "context-playground" => caller == "tray-menu",
            // `tray-menu` is opened by the tray command, `overlay` by recording
            // lifecycle code, and `main` is owned by setup/show_main_window.
            _ => false,
        },
        WindowOperation::Close => match target {
            "main" | "overlay" => false,
            "settings" | "whats-new" | "history" | "onboarding" => caller == target,
            "model-picker" => matches!(caller, "main" | "settings" | "model-picker"),
            // Closed from the main window (chip pointer-out) or by itself.
            "model-footprint" => matches!(caller, "main" | "model-footprint"),
            "tray-menu" => caller == "tray-menu",
            #[cfg(any(debug_assertions, feature = "context-playground"))]
            "context-playground" => caller == "context-playground",
            _ => false,
        },
        WindowOperation::Resize => match target {
            "model-picker" => caller == "model-picker",
            // The footprint window's ResizeObserver hugs its own window to content.
            "model-footprint" => caller == "model-footprint",
            "tray-menu" => caller == "tray-menu",
            _ => false,
        },
        WindowOperation::Anchor => {
            target == caller
                && matches!(
                    target,
                    "settings" | "history" | "onboarding" | "model-picker" | "tray-menu"
                )
        }
    }
}

fn authorize_window_operation(
    caller: &tauri::WebviewWindow,
    operation: WindowOperation,
    target: &str,
) -> Result<(), String> {
    let caller_label = caller.label();
    if is_window_operation_allowed(caller_label, operation, target) {
        return Ok(());
    }
    log::warn!(
        "blocked window {}: caller='{caller_label}' target='{target}'",
        operation.as_str()
    );
    Err(format!(
        "window '{caller_label}' may not {} '{target}'",
        operation.as_str()
    ))
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

#[derive(Clone)]
pub(super) struct PickerMode {
    kind: String,
    feature: Option<String>,
    target: Option<String>,
}

impl Default for PickerMode {
    fn default() -> Self {
        Self {
            kind: "stt".to_string(),
            feature: None,
            target: None,
        }
    }
}

#[derive(Clone)]
struct PickerState {
    anchor: Option<PickerAnchor>,
    width: f64,
    height: f64,
    mode: PickerMode,
    /// True from close-animation start until the next anchored open. A picker
    /// in this grace is still `is_visible()` (the renderer acknowledges after
    /// the faded frame composites), so placement
    /// triggers like `resize_window` must NOT re-place it: `place_model_picker`
    /// re-shows the window and cancels the pending hide, reopening the picker.
    closing: bool,
}

static PICKER_STATE: Mutex<Option<HashMap<&'static str, PickerState>>> = Mutex::new(None);

/// Default seed footprint per picker (the renderer overrides it on first resize).
fn picker_default_size(label: &str) -> (f64, f64) {
    match label {
        "model-picker" => (600.0, 560.0),
        // Seed footprint near its content size so the first frame isn't oversized
        // before the renderer's ResizeObserver hugs the window to the breakdown.
        // Keep in sync with FOOTPRINT_WINDOW_GUTTER_PX in footprint-size.ts.
        "model-footprint" => (292.0, 432.0),
        _ => (320.0, 360.0),
    }
}

fn model_picker_size_for_kind(kind: &str) -> (f64, f64) {
    match kind {
        "llm-ollama" => (620.0, 620.0),
        "llm-openrouter" => (580.0, 620.0),
        // Compact device list (keep in sync with `OUTPUT_DEVICE_PICKER_*` in the
        // renderer's `picker-helpers.ts`); Rust widens it to the trigger width.
        "output-device" => (320.0, 320.0),
        _ => picker_default_size("model-picker"),
    }
}

fn with_picker_state<R>(label: &'static str, f: impl FnOnce(&mut PickerState) -> R) -> R {
    let mut guard = PICKER_STATE.lock_recover();
    let map = guard.get_or_insert_with(HashMap::new);
    let (w, h) = picker_default_size(label);
    let entry = map.entry(label).or_insert(PickerState {
        anchor: None,
        width: w,
        height: h,
        mode: PickerMode::default(),
        closing: false,
    });
    f(entry)
}

fn update_picker_size(state: &mut PickerState, width: f64, height: f64) -> (bool, bool) {
    let next_width = width.max(1.0).ceil();
    let next_height = height.max(1.0).ceil();
    let changed = state.width != next_width || state.height != next_height;
    if changed {
        state.width = next_width;
        state.height = next_height;
    }
    (state.closing, changed)
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

    let mut builder = crate::startup::configure_webview_window_builder(
        WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(spec.url.into()))
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
            .visible(false),
    );

    if let Some((r, g, b, a)) = spec.background {
        builder = builder.background_color(tauri::webview::Color(r, g, b, a));
    } else if spec.transparent {
        // Force the WebView2 default background fully transparent. Without an
        // explicit alpha-0 color, a transparent window repaints its transparent
        // regions with the webview's opaque default (white) the moment it gains
        // focus — the preview-before-pasting pill makes the overlay interactive,
        // so clicking/typing in it flashed a white rectangle BEHIND the opaque
        // (bg-black) island. Pinning the default background to transparent keeps
        // focus repaints transparent on every transparent popup.
        builder = builder.background_color(tauri::webview::Color(0, 0, 0, 0));
    }

    // The footprint panel is a hover affordance: build it non-focusable so
    // showing it on hover never pulls keyboard focus off the user's active app
    // (every other window activates on show via `set_focus`). The tray-indicator
    // pill is purely informational and must likewise never steal focus.
    if spec.label == "model-footprint" || spec.label == "tray-indicator" {
        builder = builder.focusable(false);
    }

    // Make modal surfaces children owned by the main pill. On Windows `parent()`
    // sets `main` as the OWNER window: the modal is always above it in the z-order,
    // is hidden when the pill is minimized, and is destroyed with it — exactly the
    // "they're the same thing" relationship we want. The pill is built in lib.rs
    // `setup` before secondary windows can be opened, so it normally exists here. A failure to
    // parent (e.g. main somehow gone) degrades to a plain centered window — still
    // modal via `set_main_modal`, just not OS-owned.
    if matches!(spec.label, "settings" | "whats-new") {
        match app.get_webview_window("main") {
            // `parent()` consumes the builder and doesn't hand it back on error, so
            // there's nothing to degrade to — surface the failure (it only happens
            // if the pill is genuinely gone, which never occurs in practice).
            Some(main) => {
                builder = builder
                    .parent(&main)
                    .map_err(|e| format!("parent {} to main failed: {e}", spec.label))?;
            }
            None => {
                log::warn!(
                    "ensure_window: main window missing; {} created without owner",
                    spec.label
                )
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
            if diag_label == "overlay" {
                match payload.event() {
                    tauri::webview::PageLoadEvent::Started => {
                        crate::winstt::commands::overlay::mark_overlay_page_loading();
                    }
                    tauri::webview::PageLoadEvent::Finished => {
                        crate::winstt::commands::overlay::mark_overlay_page_loaded();
                    }
                }
            }
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
            .map_or_else(|_| "<none>".into(), |u| u.to_string())
    );

    if spec.label == "model-picker" {
        let picker_label = spec.label;
        let app_handle = app.clone();
        window.on_window_event(move |event| {
            let Some(window) = app_handle.get_webview_window(picker_label) else {
                return;
            };
            if !window.is_visible().unwrap_or(false) {
                return;
            }
            match event {
                // Showing a hidden WebView2 can resume its renderer after the
                // immediate placement emit. Native focus is the reliable
                // lifecycle callback that proves this open reached the window;
                // replay the current anchor without timer-based retries.
                tauri::WindowEvent::Focused(true) => {
                    emit_model_picker_anchor_snapshot(&app_handle, &window);
                }
                tauri::WindowEvent::Focused(false) => {
                    close_model_picker_with_animation(&app_handle, &window);
                }
                _ => {}
            }
        });
    }

    // On Linux, Tao unwraps the native GTK window for cursor-ignore requests.
    // On Linux, defer overlay click-through setup until the show path calls
    // `set_ignore_cursor_events` after `show()`, when the native window is realized.
    if spec.ignore_cursor {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = window.set_ignore_cursor_events(true);
        }
    }

    // The overlay is the only window that runs with a `SetWindowRgn` hit region,
    // which drops it into the legacy frame pipeline — without this, clicking the
    // pill paints the classic caption bar behind it (see the doc comment on
    // `suppress_overlay_frame_paint`).
    #[cfg(target_os = "windows")]
    if spec.label == "overlay" {
        crate::winstt::commands::overlay::suppress_overlay_frame_paint(&window);
    }
    Ok(window)
}

/// Native lifecycle path for first-run setup and returning-user permission
/// recovery. It intentionally bypasses renderer command authorization because
/// the backend is the caller, while preserving the same placement/show/focus
/// behavior as `open_window("onboarding")`.
pub(crate) fn show_onboarding_window_internal(app: &AppHandle) -> Result<(), String> {
    let window = ensure_window(app, "onboarding")?;
    center_window(app, &window, false);
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|e| e.to_string())
}

// ── Settings modal (pill input gate) ────────────────────────────────────────

// Enable/disable the main pill's input while the Settings modal is up.
pub(crate) fn set_main_modal(app: &AppHandle, modal_active: bool) {
    if let Some(main) = app.get_webview_window("main")
        && let Err(e) = main.set_enabled(!modal_active)
    {
        log::warn!("set_main_modal({modal_active}): {e}");
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// `winstt_diag` — webview → backend log bridge. The secondary windows (settings /
/// model-picker / …) are separate webviews whose console + uncaught errors are
/// invisible to the Rust log, so a blank/non-rendering window leaves no trace. The
/// renderer entries install `window.onerror` + an "mounted" beacon that call this,
/// surfacing renderer crashes (the usual cause of a blank secondary window) in
/// winstt.log where we can see them. Diagnostic; harmless to keep.
#[tauri::command]
#[specta::specta]
pub fn winstt_diag(app: AppHandle, label: String, level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[webview:{label}] {message}"),
        "warn" => log::warn!("[webview:{label}] {message}"),
        _ => log::debug!("[webview:{label}] {message}"),
    }
    let startup_probe_timeout = message.contains("startup probes exceeded");
    if level == "error" || startup_probe_timeout {
        let mut issue = IssueBuilder::new(
            "renderer",
            "webview_diag",
            if startup_probe_timeout {
                "Renderer startup probes exceeded the readiness timeout"
            } else {
                "Renderer reported a webview error"
            },
        )
        .detail(message)
        .severity(if level == "error" { "error" } else { "warn" })
        .user_visible(false)
        .context("label", label)
        .context("level", level);
        if startup_probe_timeout {
            issue = issue.kind("timeout").context("phase", "startup");
        }
        issue.record_without_log(Some(&app));
    }
}

/// `open_window` — create-if-needed, then show + focus the labelled window.
///
/// For the anchored pickers the renderer passes the trigger's viewport rect
/// (`x`/`y`/`width`/`height`); we convert it to a screen anchor via the CALLING
/// window (`webview`) and place the popup. For the plain windows the rect is
/// absent and we center + show. This command must remain async: a synchronous
/// Tauri command may execute on the IPC/UI path, where first-use WebView
/// construction can block the event loop. The async command body runs on
/// Tauri's worker runtime and lets Wry marshal native creation safely.
#[tauri::command]
#[specta::specta]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri IPC command exposes optional window geometry as generated binding parameters"
)]
pub async fn open_window(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    name: String,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    picker_kind: Option<String>,
    picker_feature: Option<String>,
    picker_target: Option<String>,
) -> Result<(), String> {
    log::debug!("open_window('{name}') invoked");
    // Resolve the static label so it can key the picker-state map / emit.
    let label = known_window_label(&name)?;
    #[cfg(any(debug_assertions, feature = "context-playground"))]
    let close_tray_after_context_open =
        label == "context-playground" && webview.label() == "tray-menu";
    authorize_window_operation(&webview, WindowOperation::Open, label)?;
    // While the first-run wizard is up, only the wizard itself may open Settings —
    // its final overview step deep-links into specific sections. Every other caller
    // (the system-tray menu in particular) is blocked so onboarding can't be
    // bypassed into Settings. Silent no-op so a stray tray click just does nothing.
    if label == "settings"
        && webview.label() != "onboarding"
        && crate::winstt::commands::onboarding::is_onboarding_in_progress(&app)
    {
        return Ok(());
    }
    if label == "onboarding" {
        crate::bootstrap::state::deactivate_runtime_for_onboarding(&app);
    }
    // Settings and What's New share the main pill's single modal lock. Never
    // allow both to be visible at once: closing either would otherwise re-enable
    // the pill beneath the other. Focus the existing modal and leave the newly
    // requested one for a later interaction/startup.
    if matches!(label, "settings" | "whats-new") {
        for other_label in ["settings", "whats-new"] {
            if other_label == label {
                continue;
            }
            if let Some(other) = app.get_webview_window(other_label)
                && other.is_visible().unwrap_or(false)
            {
                let _ = other.unminimize();
                let _ = other.set_focus();
                return Ok(());
            }
        }
    }
    let window = ensure_window(&app, label)
        .inspect_err(|e| log::error!("open_window('{name}') ensure_window failed: {e}"))?;

    if is_picker(label) {
        if label == "model-picker" {
            let next_kind = picker_kind
                .as_deref()
                .filter(|kind| {
                    matches!(
                        *kind,
                        "llm-ollama"
                            | "llm-openrouter"
                            | "stt"
                            | "stt-realtime"
                            | "stt-cloud"
                            | "tts"
                            | "output-device"
                    )
                })
                .unwrap_or("stt");
            let (default_width, default_height) = model_picker_size_for_kind(next_kind);
            with_picker_state(label, |s| {
                s.mode = PickerMode {
                    kind: next_kind.to_string(),
                    feature: picker_feature.clone(),
                    target: picker_target.clone(),
                };
                s.width = default_width;
                s.height = default_height;
            });
        }

        // Stash the trigger anchor (converted to screen space via the opener =
        // the calling window).
        if let (Some(x), Some(y), Some(w), Some(h)) = (x, y, width, height)
            && let Some(opener) = resolve_opener(&app, &webview, label)
        {
            let anchor = anchor_from_rect(&opener, x, y, w, h);
            with_picker_state(label, |s| s.anchor = Some(anchor));
        }
        if label == "model-footprint" {
            let snapshot = super::stt::live_resources_snapshot();
            if let Err(error) =
                window.emit(super::events::names::MODEL_FOOTPRINT_RESOURCES, snapshot)
            {
                log::warn!("failed to seed model-footprint resources: {error}");
            }
        }
        place_picker(&app, label, &window);
        return Ok(());
    }

    // Plain window: center (settings on the main pill, others on the primary
    // display), then show + focus. `settings` centers on main per the reference.
    // Plain window: center, then show + focus. The window is opaque (SUBSTRATE
    // background) so it shows cleanly without a white flash; no native opacity
    // animation (see settings_modal.rs for why the layered fade was removed).
    let was_visible = window.is_visible().unwrap_or(false);
    let show_result = (|| {
        center_window(&app, &window, matches!(label, "settings" | "whats-new"));
        window.show().map_err(|e| e.to_string())?;
        let _ = window.unminimize();
        let _ = window.set_focus();
        // Main modals disable the pill after taking focus so it cannot be
        // focused/clicked underneath. Close paths re-enable it.
        if matches!(label, "settings" | "whats-new") {
            set_main_modal(&app, true);
            // Tell the keep-alive settings renderer it just came on screen so it
            // replays its enter animation. WebView2 does not reliably deliver
            // `focus`/`visibilitychange` across a native hide/show cycle, so this
            // explicit signal is the deterministic trigger. Show FIRST so a
            // suspended webview has resumed before the event (same ordering as
            // the model-picker anchor emit). The payload says whether the window
            // was ALREADY visible: a re-invoked open (tray click while open, or
            // mid-close-fade) must cancel any pending renderer-side hide and
            // repair to open, but never restart the animation over live content.
            if label == "settings" {
                let _ = app.emit(
                    crate::winstt::commands::events::names::SETTINGS_WINDOW_SHOWN,
                    was_visible,
                );
            }
        }
        Ok(())
    })();

    show_result.inspect_err(|_: &String| {
        #[cfg(any(debug_assertions, feature = "context-playground"))]
        if label == "context-playground" {
            crate::winstt::commands::context_playground::stop_context_playground_polling();
            let _ = window.destroy();
        }
    })?;

    #[cfg(any(debug_assertions, feature = "context-playground"))]
    if close_tray_after_context_open {
        let _ = crate::winstt::commands::tray_menu::hide_tray_menu(app);
    }

    Ok(())
}

/// Internal Rust lifecycle close path. Use this for native close events and
/// backend-owned cleanup after the caller has already been established by code.
pub(crate) fn close_window_internal(app: &AppHandle, name: &str) -> Result<(), String> {
    let label = known_window_label(name)?;
    if label == "main" {
        return Err("main window cannot be closed through close_window".into());
    }

    // Tray menu close uses its dedicated keep-alive path so the webview state is
    // preserved while the OS still sees a real hidden/shown popup for blur.
    if label == "tray-menu" {
        return crate::winstt::commands::tray_menu::hide_tray_menu(app.clone());
    }
    if matches!(label, "settings" | "whats-new") {
        if let Some(window) = app.get_webview_window(label) {
            return close_main_modal_window(app.clone(), window);
        }
        set_main_modal(app, false);
        return Ok(());
    }
    #[cfg(any(debug_assertions, feature = "context-playground"))]
    if label == "context-playground" {
        crate::winstt::commands::context_playground::stop_context_playground_polling();
        if let Some(window) = app.get_webview_window(label) {
            window.destroy().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(label) {
        if label == "model-picker" {
            close_model_picker_with_animation(app, &window);
            return Ok(());
        }
        window.hide().map_err(|e| e.to_string())?;
    }
    // A closed picker forgets its anchor so a stray resize can't re-show it.
    if is_picker(label) {
        with_picker_state(label, |s| s.anchor = None);
    }
    Ok(())
}

/// `close_window` — HIDE the labelled keep-alive windows so re-open keeps state.
/// Debug-only context-playground is destroyed on close to force a fresh
/// live-capture renderer on next open.
#[tauri::command]
#[specta::specta]
pub fn close_window(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    name: String,
) -> Result<(), String> {
    let label = known_window_label(&name)?;
    authorize_window_operation(&webview, WindowOperation::Close, label)?;
    close_window_internal(&app, label)
}

/// `close_self_window` — hide the CALLING window (resolved from its own webview
/// label), the Rust-side equivalent of the renderer's `getCurrentWindow().hide()`.
/// Self-closing secondary windows route their close button here instead of a bare
/// webview hide so main-pill modals can release the input lock as they close. For
/// non-modal callers this is a plain hide, identical to the old behaviour.
#[tauri::command]
#[specta::specta]
pub fn close_self_window(app: AppHandle, webview: tauri::WebviewWindow) -> Result<(), String> {
    let label = webview.label().to_string();
    if matches!(label.as_str(), "settings" | "whats-new") {
        return close_main_modal_window(app, webview);
    }
    webview.hide().map_err(|e| e.to_string())?;
    Ok(())
}

/// `window_model_picker_ready` — renderer-ready handshake for anchor delivery.
/// The model-picker invokes this after its lifecycle listeners are registered.
/// If an open raced renderer startup, this sends the latest stored anchor
/// exactly once. Future opens arrive through the installed listener.
#[tauri::command]
#[specta::specta]
pub fn window_model_picker_ready(
    app: AppHandle,
    webview: tauri::WebviewWindow,
) -> Result<(), String> {
    if webview.label() != "model-picker" {
        return Err("window_model_picker_ready is restricted to model-picker".into());
    }
    emit_model_picker_anchor_snapshot(&app, &webview);
    Ok(())
}

/// `window_model_picker_close_complete` — renderer acknowledgement carrying
/// the close generation whose CSS exit animation actually completed.
#[tauri::command]
#[specta::specta]
pub fn window_model_picker_close_complete(
    webview: tauri::WebviewWindow,
    sequence: u64,
) -> Result<(), String> {
    if webview.label() != "model-picker" {
        return Err("window_model_picker_close_complete is restricted to model-picker".into());
    }
    complete_model_picker_close(&webview, sequence)
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
pub fn resize_window(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    name: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = known_window_label(&name)?;
    authorize_window_operation(&webview, WindowOperation::Resize, label)?;

    if is_picker(label) {
        let (closing, size_changed) =
            with_picker_state(label, |s| update_picker_size(s, width, height));
        // Never re-place during the close grace: the window is still visible
        // (the hide is delayed so the faded frame composits) and
        // `place_model_picker` would re-show it + cancel the pending hide —
        // a closed picker that immediately reopens. Repeated ResizeObserver
        // reports of the SAME size are also ignored: set_size would trigger a
        // new observer report and create a visible resize/re-anchor loop.
        if size_changed
            && !closing
            && let Some(window) = app.get_webview_window(label)
            && window.is_visible().unwrap_or(false)
        {
            place_picker(&app, label, &window);
        }
        return Ok(());
    }

    if let Some(window) = app.get_webview_window(label) {
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
            // `set_size` on the tray menu makes WebView2 transiently drop focus;
            // mark the resize in flight FIRST so the blur-hide handler can wait
            // for the native `Resized` callback instead of using a time window.
            if label == "tray-menu" {
                crate::winstt::commands::tray_menu::begin_tray_menu_resize();
            }
            if let Err(error) =
                window.set_size(LogicalSize::new(f64::from(next_w), f64::from(next_h)))
            {
                if label == "tray-menu" {
                    crate::winstt::commands::tray_menu::cancel_tray_menu_resize();
                }
                return Err(error.to_string());
            }

            // The tray menu is `w-fit` and only reports its true content size after
            // mount (TRAY_MENU_RESIZE). Re-anchor it from the stored click point so it
            // stays glued there with the now-correct size instead of remaining clamped
            // against its initial (larger) footprint — mirrors the reference's resize →
            // re-anchor in tray-menu-window.ts. Only fires when the size ACTUALLY
            // changed, so a steady-state ResizeObserver storm no longer re-anchors.
            if label == "tray-menu" {
                let _ = crate::winstt::commands::tray_menu::reanchor_tray_menu(app);
            }
        }
    }
    Ok(())
}

/// `anchor_window` — move the labelled window's top-left to (x, y) in logical
/// screen px. Used to place a detached window next to its trigger directly.
#[tauri::command]
#[specta::specta]
pub fn anchor_window(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    name: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let label = known_window_label(&name)?;
    authorize_window_operation(&webview, WindowOperation::Anchor, label)?;

    if let Some(window) = app.get_webview_window(label) {
        window
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        PickerMode, PickerState, WindowOperation, is_picker, is_window_operation_allowed,
        known_window_label, spec_for, update_picker_size,
    };

    #[test]
    fn known_labels_resolve() {
        for label in [
            "settings",
            "whats-new",
            "onboarding",
            "history",
            "model-picker",
            "model-footprint",
            "tray-menu",
            "overlay",
            #[cfg(any(debug_assertions, feature = "context-playground"))]
            "context-playground",
        ] {
            assert!(spec_for(label).is_some(), "missing spec for {label}");
        }
        assert!(spec_for("nope").is_none());
    }

    #[test]
    fn onboarding_uses_renderer_owned_window_chrome() {
        let spec = spec_for("onboarding").expect("onboarding spec");

        assert!(!spec.decorations);
        assert!(spec.transparent);
        assert!(!spec.shadow);
        assert!(spec.background.is_none());
    }

    #[test]
    fn whats_new_has_a_dedicated_full_size_modal_viewport() {
        let main = spec_for("main").expect("main spec");
        let whats_new = spec_for("whats-new").expect("what's-new spec");

        assert!(whats_new.width > main.width);
        assert!(whats_new.height > main.height);
        assert_eq!((whats_new.width, whats_new.height), (680.0, 720.0));
        assert!(!whats_new.decorations);
        assert!(whats_new.transparent);
        assert!(whats_new.skip_taskbar);
    }

    #[test]
    fn only_pickers_are_pickers() {
        assert!(is_picker("model-picker"));
        assert!(is_picker("model-footprint"));
        assert!(!is_picker("settings"));
        assert!(!is_picker("whats-new"));
        assert!(!is_picker("history"));
    }

    #[test]
    fn picker_size_updates_are_idempotent() {
        let mut state = PickerState {
            anchor: None,
            width: 280.0,
            height: 420.0,
            mode: PickerMode::default(),
            closing: false,
        };

        assert_eq!(update_picker_size(&mut state, 280.0, 420.0), (false, false));
        assert_eq!(update_picker_size(&mut state, 280.1, 460.1), (false, true));
        assert_eq!((state.width, state.height), (281.0, 461.0));
        assert_eq!(update_picker_size(&mut state, 280.1, 460.1), (false, false));
    }

    #[test]
    fn model_footprint_window_chrome_is_click_through() {
        let spec = spec_for("model-footprint").expect("model-footprint spec");

        assert!(spec.ignore_cursor);
        assert_eq!((spec.width, spec.height), (292.0, 432.0));
        assert!(!spec.resizable);
        assert!(!spec.decorations);
    }

    #[test]
    fn known_window_label_rejects_unknown_targets() {
        assert_eq!(known_window_label("settings"), Ok("settings"));
        assert!(known_window_label("arbitrary-window").is_err());
    }

    fn assert_window_rules(rules: &[(&str, WindowOperation, &str)], expected: bool) {
        for (caller, operation, target) in rules {
            assert_eq!(
                is_window_operation_allowed(caller, *operation, target),
                expected,
                "{caller} should {}be allowed to {} {target}",
                if expected { "" } else { "not " },
                operation.as_str()
            );
        }
    }

    #[test]
    fn window_open_authorization_allows_current_renderer_flows() {
        assert_window_rules(
            &[
                ("main", WindowOperation::Open, "settings"),
                ("main", WindowOperation::Open, "whats-new"),
                ("tray-menu", WindowOperation::Open, "settings"),
                // The onboarding overview step deep-links into Settings sections.
                ("onboarding", WindowOperation::Open, "settings"),
                ("main", WindowOperation::Open, "model-picker"),
                ("settings", WindowOperation::Open, "model-picker"),
                ("onboarding", WindowOperation::Open, "model-picker"),
                ("main", WindowOperation::Open, "model-footprint"),
                #[cfg(any(debug_assertions, feature = "context-playground"))]
                ("tray-menu", WindowOperation::Open, "context-playground"),
            ],
            true,
        );
    }

    #[test]
    fn window_authorization_blocks_cross_window_control() {
        assert_window_rules(
            &[
                ("model-picker", WindowOperation::Open, "settings"),
                ("settings", WindowOperation::Open, "model-footprint"),
                ("tray-menu", WindowOperation::Open, "overlay"),
                ("main", WindowOperation::Resize, "tray-menu"),
                ("model-picker", WindowOperation::Resize, "settings"),
                ("overlay", WindowOperation::Close, "settings"),
                ("settings", WindowOperation::Close, "tray-menu"),
                ("tray-menu", WindowOperation::Close, "main"),
                ("main", WindowOperation::Close, "overlay"),
            ],
            false,
        );
    }

    #[cfg(any(debug_assertions, feature = "context-playground"))]
    #[test]
    fn context_playground_is_a_normal_visible_window() {
        let spec = spec_for("context-playground").expect("context playground spec");

        assert!(spec.resizable);
        assert!(spec.decorations);
        assert!(!spec.transparent);
        assert!(!spec.always_on_top);
        assert!(!spec.skip_taskbar);
    }

    #[test]
    fn window_resize_and_anchor_authorization_is_self_scoped() {
        assert_window_rules(
            &[
                ("tray-menu", WindowOperation::Resize, "tray-menu"),
                ("model-picker", WindowOperation::Resize, "model-picker"),
                (
                    "model-footprint",
                    WindowOperation::Resize,
                    "model-footprint",
                ),
                ("model-picker", WindowOperation::Anchor, "model-picker"),
            ],
            true,
        );
        assert_window_rules(
            &[("model-picker", WindowOperation::Anchor, "model-footprint")],
            false,
        );
    }

    #[test]
    fn window_close_authorization_allows_current_renderer_flows() {
        assert_window_rules(
            &[
                ("main", WindowOperation::Close, "model-picker"),
                ("model-picker", WindowOperation::Close, "model-picker"),
                ("settings", WindowOperation::Close, "model-picker"),
                ("main", WindowOperation::Close, "model-footprint"),
                ("model-footprint", WindowOperation::Close, "model-footprint"),
                ("tray-menu", WindowOperation::Close, "tray-menu"),
                ("settings", WindowOperation::Close, "settings"),
                ("whats-new", WindowOperation::Close, "whats-new"),
            ],
            true,
        );
        #[cfg(any(debug_assertions, feature = "context-playground"))]
        assert_window_rules(
            &[(
                "context-playground",
                WindowOperation::Close,
                "context-playground",
            )],
            true,
        );
    }
}
