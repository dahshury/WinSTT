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
// HARD-RULE-safe: this is a NEW file under winstt/commands/. The orchestrator
// registers open_window/close_window/resize_window/anchor_window/onboarding_finish
// in lib.rs `collect_commands![]` and adds the 9 labels to capabilities/default.json.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

/// Per-window chrome/geometry spec, ported from the Electron window creators.
struct WindowSpec {
    /// Tauri window label == the Vite entry key == the renderer's window name.
    label: &'static str,
    /// HTML entry relative to the frontendDist root ("windows/<x>.html").
    url: &'static str,
    title: &'static str,
    width: f64,
    height: f64,
    resizable: bool,
    decorations: bool,
    transparent: bool,
    always_on_top: bool,
    skip_taskbar: bool,
    shadow: bool,
    /// Whether the window starts mouse-click-through (overlay only).
    ignore_cursor: bool,
}

/// The 9-window table (main is created in lib.rs setup; listed here for resize).
const WINDOW_SPECS: &[WindowSpec] = &[
    WindowSpec {
        label: "main",
        url: "/",
        title: "WinSTT",
        width: 420.0,
        height: 150.0,
        resizable: false,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        ignore_cursor: false,
    },
    WindowSpec {
        label: "settings",
        url: "windows/settings.html",
        title: "WinSTT — Settings",
        width: 700.0,
        height: 560.0,
        resizable: false,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        ignore_cursor: false,
    },
    WindowSpec {
        label: "overlay",
        url: "windows/overlay.html",
        title: "WinSTT — Overlay",
        width: 720.0,
        height: 240.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        ignore_cursor: true,
    },
    WindowSpec {
        label: "tray-menu",
        url: "windows/tray-menu.html",
        title: "WinSTT",
        width: 280.0,
        height: 360.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        ignore_cursor: false,
    },
    WindowSpec {
        label: "model-picker",
        url: "windows/model-picker.html",
        // Full-screen transparent backdrop + an anchored panel; the renderer
        // places the panel via the `model-picker:anchor` event.
        title: "WinSTT — Model Picker",
        width: 1280.0,
        height: 800.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        ignore_cursor: false,
    },
    WindowSpec {
        label: "device-picker",
        url: "windows/device-picker.html",
        title: "WinSTT — Devices",
        width: 320.0,
        height: 360.0,
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        ignore_cursor: false,
    },
    WindowSpec {
        label: "onboarding",
        url: "windows/onboarding.html",
        title: "Welcome to WinSTT",
        width: 720.0,
        height: 560.0,
        resizable: false,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        ignore_cursor: false,
    },
    WindowSpec {
        label: "history",
        url: "windows/history.html",
        title: "WinSTT — History",
        width: 900.0,
        height: 640.0,
        resizable: true,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        ignore_cursor: false,
    },
    WindowSpec {
        label: "context-playground",
        url: "windows/context-playground.html",
        title: "WinSTT — Context Playground",
        width: 720.0,
        height: 640.0,
        resizable: true,
        decorations: false,
        transparent: false,
        always_on_top: false,
        skip_taskbar: false,
        shadow: true,
        ignore_cursor: false,
    },
];

fn spec_for(label: &str) -> Option<&'static WindowSpec> {
    WINDOW_SPECS.iter().find(|s| s.label == label)
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
        .resizable(spec.resizable)
        .decorations(spec.decorations)
        .transparent(spec.transparent)
        .always_on_top(spec.always_on_top)
        .skip_taskbar(spec.skip_taskbar)
        .shadow(spec.shadow)
        .visible(false);

    if let Some(data_dir) = crate::portable::data_dir() {
        builder = builder.data_directory(data_dir.join(format!("webview-{label}")));
    }

    let window = builder.build().map_err(|e| e.to_string())?;

    if spec.ignore_cursor {
        let _ = window.set_ignore_cursor_events(true);
    }
    Ok(window)
}

/// `open_window` — create-if-needed, then show + focus the labelled window.
#[tauri::command]
#[specta::specta]
pub fn open_window(app: AppHandle, name: String) -> Result<(), String> {
    let window = ensure_window(&app, &name)?;
    window.show().map_err(|e| e.to_string())?;
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
    Ok(())
}

/// `resize_window` — set the inner size of the labelled window (logical px).
/// Used by the dynamically-sized tray-menu / pickers.
#[tauri::command]
#[specta::specta]
pub fn resize_window(app: AppHandle, name: String, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&name) {
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `anchor_window` — move the labelled window's top-left to (x, y) in logical
/// screen px. Used to place the detached pickers next to their trigger.
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
#[tauri::command]
#[specta::specta]
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
