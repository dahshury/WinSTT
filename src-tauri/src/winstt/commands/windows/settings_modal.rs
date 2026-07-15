// Main-pill modal lifecycle (Settings and What's New).
//
// These windows are MODAL CHILDREN of the main pill: while one is open the pill is
// input-disabled (`set_main_modal`, in the parent module). Closing re-enables the
// pill and HIDES (not destroys) the child so its renderer can remain warm.
//
// There is deliberately NO native window-opacity animation here. The window is
// opaque (`SUBSTRATE` background) so it shows without a white flash, and any enter
// animation is done in the renderer (CSS) — the previous native `WS_EX_LAYERED`
// alpha fade was removed because layered-window alpha is not honored on a window's
// first show on Windows, which produced a one-frame full-opacity flash ("double
// open animation") that was impossible to fix reliably from the native side.

use tauri::{AppHandle, Manager};

use super::set_main_modal;

/// Close a modal child of the main pill: re-enable the owner BEFORE hiding the
/// child (the Win32 modal teardown order), then return focus to the pill.
pub(super) fn close_main_modal_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    set_main_modal(&app, false);
    let _ = window.hide();
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
    Ok(())
}
