// Window-management commands for the WinSTT window topology. Each WinSTT
// the reference BrowserWindow becomes a Tauri WebviewWindow loading its own HTML
// entry (main at "/", secondary windows at "windows/<name>.html"). The chrome
// (size, transparency, decorations, always-on-top, skip-taskbar) is translated
// 1:1 from frontend/electron/main.ts + electron/ipc/*-window.ts.
//
// Creation policy (matches the reference's keep-alive semantics):
//   - `main` is created eagerly in lib.rs setup (NOT here).
//   - settings/history/onboarding/pickers/overlay/tray-menu are created LAZILY on
//     first `open_window` and HIDDEN (not destroyed) on `close_window`, so re-open
//     preserves renderer state.
//   - optional context-playground is created lazily but DESTROYED on close, matching
//     the Electron debug window and resetting its live-capture renderer state.
//
// Two placement regimes (ported from the reference window creators):
//   - PLAIN windows (settings/history/onboarding and optional context-playground): created at
//     a fixed size, CENTERED (settings on the main pill, the rest on the primary
//     display), opaque backgroundColor, shown + focused. Hide-on-close except for
//     the debug-only context-playground, which is destroy-on-close.
//   - PICKER windows (model-picker/device-picker): a frameless transparent popup
//     anchored around the chip/row that opened it. The renderer sends the trigger's
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
//
// This module is split into siblings under `windows/`:
//   - `settings_modal` — the settings-modal fade/opacity state machine.
//   - `placement` — monitor work-area geometry + picker placement.
// The public surface (`ensure_window`, the prewarm/modal lifecycle, and the 7
// `#[tauri::command]` fns) stays here so every external path is byte-for-byte
// unchanged; the submodules' entry points are re-used below.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::winstt::sync_ext::MutexExt;

mod placement;
mod settings_modal;

use placement::{
    anchor_from_rect, center_window, close_model_picker_with_animation, place_picker,
    resolve_opener, visible_picker_open_should_toggle,
};
use settings_modal::close_settings_window;

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
    // Settings — 692×560 frameless, opaque, centered on the main pill. Ported
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
        width: 692.0,
        height: 560.0,
        min_width: 692.0,
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
        // Initial size only — the renderer's ResizeObserver immediately resizes
        // the window to the menu's true (capped) content size. Kept close to the
        // compact menu width so there's no oversized first frame.
        width: 192.0,
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
    // Context-playground — debug-only decorated/resizable window.
    // Ported from context-playground-window.ts (600×780, min 440×420).
    // AUDIT #6: present in dev (debug_assertions) or with the `context-playground`
    // feature; dropped from `spec_for`/`open_window` in shipping builds. It is NOT
    // in POST_STARTUP_PREWARM_LABELS, so it is never prewarmed. Pairs with
    // `CONTEXT_PLAYGROUND_ENABLED` (= `import.meta.env.DEV`) in debug-flags.ts.
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

/// Is this a transparent anchored popup (model-picker / device-picker)?
fn is_picker(label: &str) -> bool {
    label == "model-picker" || label == "device-picker"
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
            "settings" => matches!(caller, "main" | "tray-menu"),
            "history" | "onboarding" => caller == "main",
            "model-picker" => matches!(caller, "main" | "settings"),
            "device-picker" => caller == "tray-menu",
            #[cfg(any(debug_assertions, feature = "context-playground"))]
            "context-playground" => caller == "tray-menu",
            // `tray-menu` is opened by the tray command, `overlay` by recording
            // lifecycle code, and `main` is owned by setup/show_main_window.
            _ => false,
        },
        WindowOperation::Close => match target {
            "main" | "overlay" => false,
            "settings" | "history" | "onboarding" => caller == target,
            "model-picker" => matches!(caller, "main" | "settings" | "model-picker"),
            "device-picker" => matches!(caller, "tray-menu" | "device-picker"),
            "tray-menu" => caller == "tray-menu",
            #[cfg(any(debug_assertions, feature = "context-playground"))]
            "context-playground" => caller == "context-playground",
            _ => false,
        },
        WindowOperation::Resize => match target {
            "model-picker" => caller == "model-picker",
            "device-picker" => caller == "device-picker",
            "tray-menu" => caller == "tray-menu",
            _ => false,
        },
        WindowOperation::Anchor => {
            target == caller
                && matches!(
                    target,
                    "settings"
                        | "history"
                        | "onboarding"
                        | "model-picker"
                        | "device-picker"
                        | "tray-menu"
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
}

static PICKER_STATE: Mutex<Option<HashMap<&'static str, PickerState>>> = Mutex::new(None);

/// Default seed footprint per picker (the renderer overrides it on first resize).
fn picker_default_size(label: &str) -> (f64, f64) {
    match label {
        "model-picker" => (600.0, 560.0),
        _ => (320.0, 360.0),
    }
}

fn model_picker_size_for_kind(kind: &str) -> (f64, f64) {
    match kind {
        "llm-ollama" => (620.0, 620.0),
        "llm-openrouter" => (580.0, 620.0),
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
    });
    f(entry)
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
            if diag_label == "overlay"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                crate::winstt::commands::overlay::mark_overlay_page_loaded();
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
            .map(|u| u.to_string())
            .unwrap_or_else(|_| "<none>".into())
    );

    if spec.label == "model-picker" || spec.label == "device-picker" {
        let picker_label = spec.label;
        let app_handle = app.clone();
        window.on_window_event(move |event| {
            if !matches!(event, tauri::WindowEvent::Focused(false)) {
                return;
            }
            let Some(window) = app_handle.get_webview_window(picker_label) else {
                return;
            };
            if !window.is_visible().unwrap_or(false) {
                return;
            }
            if picker_label == "model-picker" {
                close_model_picker_with_animation(&app_handle, &window);
            } else {
                let _ = close_window_internal(&app_handle, picker_label);
            }
        });
    }

    // On Linux, Tao unwraps the native GTK window for cursor-ignore requests.
    // Hidden prewarmed windows are not realized yet, so defer overlay click-through
    // setup until the show path calls `set_ignore_cursor_events` after `show()`.
    if spec.ignore_cursor {
        #[cfg(not(target_os = "linux"))]
        {
            let _ = window.set_ignore_cursor_events(true);
        }
    }
    Ok(window)
}

const POST_STARTUP_PREWARM_DELAY_MS: u64 = 250;
static POST_STARTUP_PREWARM_SCHEDULED: AtomicBool = AtomicBool::new(false);

/// Secondary windows worth prewarming shortly after first paint.
///
/// `overlay` is included here so the first PTT session only has to reveal an
/// already-loaded transparent webview, avoiding the first-use black rectangle.
/// `tray-menu` has a custom off-screen lifecycle warmup. Lower-probability
/// windows stay lazy.
const POST_STARTUP_PREWARM_LABELS: &[&str] = &["overlay", "settings", "model-picker"];

/// Pre-create hidden secondary windows after the main pill paints, so first
/// interaction paths usually show an already-loaded webview. This keeps WebView2
/// creation off startup's first-paint path while avoiding lazy creation inside
/// command handlers, which can hang on Windows while the main thread is blocked.
/// Idempotent: `ensure_window` early-returns for any window that already exists.
pub(crate) fn prewarm_windows(app: &AppHandle) {
    // Deferred off the critical path. `run_on_main_thread` schedules the
    //    closure on the event loop, so it runs once `setup` has returned and the loop is
    //    pumping — i.e. after the pill is visible. WebView2 creation still happens on the
    //    main thread (required) but no longer blocks first paint.
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        for spec in WINDOW_SPECS {
            if spec.label == "main" {
                continue; // created in lib.rs setup
            }
            if !POST_STARTUP_PREWARM_LABELS.contains(&spec.label) {
                continue;
            }
            let started = Instant::now();
            match ensure_window(&app, spec.label) {
                Ok(_) => {
                    log::debug!("[prewarm] '{}' pre-created (hidden, deferred)", spec.label);
                    if crate::startup_profile_enabled() {
                        log::info!(
                            "[startup] prewarmed window '{}': {} ms",
                            spec.label,
                            started.elapsed().as_millis()
                        );
                    }
                }
                Err(e) => log::warn!("[prewarm] '{}' failed: {e}", spec.label),
            }
        }
    });
}

// ── Settings modal (pill input gate) ────────────────────────────────────────

/// Schedule noncritical secondary WebView2 creation after the main window is visible.
/// Required startup model warmups keep their normal priority; this only moves
/// hidden utility windows off the first-paint path.
pub(crate) fn schedule_post_startup_prewarm(app: &AppHandle) {
    if POST_STARTUP_PREWARM_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(POST_STARTUP_PREWARM_DELAY_MS));

        let app_for_main = app.clone();
        if let Err(e) = app.run_on_main_thread(move || {
            let started = Instant::now();
            if crate::startup_profile_enabled() {
                log::info!("[startup] post-startup prewarm started");
            }
            crate::winstt::commands::tray_menu::install_tray_menu_lifecycle(&app_for_main);
            prewarm_windows(&app_for_main);
            crate::log_startup_duration("post-startup prewarm scheduled", started);
        }) {
            log::warn!("post-startup prewarm scheduling failed: {e}");
        }
    });
}

// Enable/disable the main pill's input while the Settings modal is up.
pub(crate) fn set_main_modal(app: &AppHandle, modal_active: bool) {
    if let Some(main) = app.get_webview_window("main") {
        if let Err(e) = main.set_enabled(!modal_active) {
            log::warn!("set_main_modal({modal_active}): {e}");
        }
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
pub fn winstt_diag(label: String, level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[webview:{label}] {message}"),
        "warn" => log::warn!("[webview:{label}] {message}"),
        _ => log::debug!("[webview:{label}] {message}"),
    }
}

/// `settings_window_ready` — emitted by the settings renderer once its page is
/// committed. Retained as a no-op for renderer/binding compatibility; the settings
/// window no longer uses a native opacity fade gated on this signal (the window is
/// opaque and shows directly), so there is nothing to do here.
#[tauri::command]
#[specta::specta]
pub fn settings_window_ready(_app: AppHandle) -> Result<(), String> {
    Ok(())
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

    let window = ensure_window(&app, label)
        .inspect_err(|e| log::error!("open_window('{name}') ensure_window failed: {e}"))?;

    if is_picker(label) {
        if label == "model-picker" {
            let next_kind = picker_kind
                .as_deref()
                .filter(|kind| matches!(*kind, "llm-ollama" | "llm-openrouter" | "stt"))
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

        // Device picker open is a toggle. The model picker is a full-screen
        // transparent backdrop with a renderer-owned panel, so a visible open
        // should repair/re-anchor a stale invisible backdrop instead of closing.
        if window.is_visible().unwrap_or(false) && visible_picker_open_should_toggle(label) {
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
    // display), then show + focus. `settings` centers on main per the reference.
    // Plain window: center, then show + focus. The window is opaque (SUBSTRATE
    // background) so it shows cleanly without a white flash; no native opacity
    // animation (see settings_modal.rs for why the layered fade was removed).
    let show_result = (|| {
        center_window(&app, &window, label == "settings");
        window.show().map_err(|e| e.to_string())?;
        let _ = window.unminimize();
        let _ = window.set_focus();
        // Settings is a modal child of the pill: disable the pill (after Settings has
        // grabbed focus) so it can't be focused/clicked while open. Re-enabled when
        // Settings closes (close_self_window / close_window / CloseRequested).
        if label == "settings" {
            set_main_modal(&app, true);
        }
        Ok(())
    })();

    if let Err(e) = show_result {
        #[cfg(any(debug_assertions, feature = "context-playground"))]
        if label == "context-playground" {
            crate::winstt::commands::context_playground::stop_context_playground_polling();
            let _ = window.destroy();
        }
        return Err(e);
    }

    #[cfg(any(debug_assertions, feature = "context-playground"))]
    if close_tray_after_context_open {
        let _ = crate::winstt::commands::tray_menu::hide_tray_menu(app.clone());
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
    if label == "settings" {
        if let Some(window) = app.get_webview_window(label) {
            return close_settings_window(app.clone(), window);
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
    // The device-picker is a tray-menu submenu: choosing a device (or Esc)
    // collapses the WHOLE menu, matching the reference's device-picker
    // `handleClose` (hideDevicePicker + hideTrayMenu).
    if label == "device-picker" {
        let _ = crate::winstt::commands::tray_menu::hide_tray_menu(app.clone());
    }
    Ok(())
}

/// `close_window` — HIDE the labelled keep-alive windows so re-open keeps state.
/// Debug-only context-playground is destroyed on close to mirror the Electron
/// reference and force a fresh live-capture renderer on next open.
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
            window
                .set_size(LogicalSize::new(f64::from(next_w), f64::from(next_h)))
                .map_err(|e| e.to_string())?;

            // The tray menu is `w-fit` and only reports its true content size after
            // mount (TRAY_MENU_RESIZE). Re-anchor it from the stored click point so it
            // stays glued there with the now-correct size instead of remaining clamped
            // against its initial (larger) footprint — mirrors the reference's resize →
            // re-anchor in tray-menu-window.ts. Only fires when the size ACTUALLY
            // changed, so a steady-state ResizeObserver storm no longer re-anchors.
            if label == "tray-menu" {
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
        is_picker, is_window_operation_allowed, known_window_label, spec_for, WindowOperation,
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
            #[cfg(any(debug_assertions, feature = "context-playground"))]
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
                ("tray-menu", WindowOperation::Open, "settings"),
                ("main", WindowOperation::Open, "model-picker"),
                ("settings", WindowOperation::Open, "model-picker"),
                ("tray-menu", WindowOperation::Open, "device-picker"),
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
                ("settings", WindowOperation::Open, "device-picker"),
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
                ("device-picker", WindowOperation::Resize, "device-picker"),
                ("model-picker", WindowOperation::Anchor, "model-picker"),
            ],
            true,
        );
        assert_window_rules(
            &[("model-picker", WindowOperation::Anchor, "device-picker")],
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
                ("tray-menu", WindowOperation::Close, "device-picker"),
                ("device-picker", WindowOperation::Close, "device-picker"),
                ("tray-menu", WindowOperation::Close, "tray-menu"),
                ("settings", WindowOperation::Close, "settings"),
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
