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

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, LogicalPosition, Manager};

use super::windows::{ensure_window, placement::work_area_for_point};

/// Label of the tray-menu webview (== Vite entry key == renderer window name).
const TRAY_MENU_LABEL: &str = "tray-menu";

/// Visual gap left above the taskbar. Mirrors `TASKBAR_MARGIN` in the reference
/// `tray-menu-window.ts`: on Windows 11 the taskbar's rounded/translucent top
/// edge extends a few px above the work-area boundary, so a flush menu visually
/// overlaps it. Native context menus leave a small gap; we replicate that.
const TASKBAR_MARGIN: f64 = 8.0;

/// Off-screen parking coordinate (logical px). The tray menu parks here while
/// dismissed so stale on-screen bounds do not make it look open to the
/// position-based visibility checks.
const OFFSCREEN: f64 = -9999.0;

static TRAY_MENU_LIFECYCLE_INSTALLED: AtomicBool = AtomicBool::new(false);

/// One-shot guard for `schedule_tray_menu_warmup` (both startup paths — hidden
/// launch and first main-window show — may request it).
static TRAY_MENU_WARMUP_SCHEDULED: AtomicBool = AtomicBool::new(false);

/// How long after startup handoff to defer tray-menu webview creation, keeping
/// it off the first-paint path (mirrors the removed post-startup prewarm delay).
const TRAY_MENU_WARMUP_DELAY_MS: u64 = 250;

/// Whether the tray-menu webview has finished loading its page. Creating that
/// webview takes ~2s in a packaged build, and a transparent window shown before
/// the page paints is an EMPTY rectangle — the click reads as dead and the next
/// click just toggles the invisible window away, so the menu never appears (the
/// reported "right-click does nothing in the compiled app"). Opens that arrive
/// before the load completes are deferred instead of shown blank.
static TRAY_MENU_PAGE_LOADED: AtomicBool = AtomicBool::new(false);

/// An open requested while the page was still loading, flushed by
/// `mark_tray_menu_page_loaded`.
static TRAY_MENU_OPEN_PENDING: AtomicBool = AtomicBool::new(false);

/// Whether a programmatic tray-menu resize is awaiting its native `Resized`
/// callback. WebView2 transiently emits `Focused(false)` while `set_size` is in
/// flight, so that blur is suppressed by lifecycle state instead of by guessing
/// how long the resize might take. `Resized` is the authoritative completion;
/// `Focused(true)` also clears the state if WebView2 restores focus first.
static TRAY_MENU_RESIZE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// `on_page_load` Started for the tray-menu webview (see `windows::ensure_window`).
pub(crate) fn mark_tray_menu_page_loading() {
    TRAY_MENU_PAGE_LOADED.store(false, Ordering::Release);
}

/// `on_page_load` Finished for the tray-menu webview. Flushes an open that a
/// tray click requested while the page was still loading, so a click that
/// landed on the cold webview still ends with a painted menu instead of
/// nothing.
pub(crate) fn mark_tray_menu_page_loaded(app: &AppHandle) {
    TRAY_MENU_PAGE_LOADED.store(true, Ordering::Release);
    if !TRAY_MENU_OPEN_PENDING.swap(false, Ordering::AcqRel) {
        return;
    }
    let anchor = app
        .try_state::<TrayMenuAnchor>()
        .and_then(|state| state.0.lock().ok().and_then(|g| *g));
    let Some(anchor) = anchor else {
        return;
    };
    if let Err(e) = place_tray_menu(app, anchor) {
        log::warn!("Failed to open deferred tray menu: {e}");
    }
}

/// Called immediately before `resize_window` applies a new tray-menu size.
pub(crate) fn begin_tray_menu_resize() {
    TRAY_MENU_RESIZE_IN_FLIGHT.store(true, Ordering::Release);
}

/// Abort a resize whose `set_size` call failed before a native callback could
/// arrive. Successful resizes are completed by the window lifecycle callbacks.
pub(crate) fn cancel_tray_menu_resize() {
    TRAY_MENU_RESIZE_IN_FLIGHT.store(false, Ordering::Release);
}

fn complete_tray_menu_resize() {
    TRAY_MENU_RESIZE_IN_FLIGHT.store(false, Ordering::Release);
}

const TRAY_MENU_WILL_OPEN_EVENT: &str = "winstt:tray-menu-will-open";
const TRAY_MENU_OPENED_EVENT: &str = "winstt:tray-menu-opened";
const TRAY_MENU_HIDDEN_EVENT: &str = "winstt:tray-menu-hidden";

/// Last anchor point the tray menu was shown at, in LOGICAL screen pixels.
/// Stored so a `tray-menu:resize` (the renderer's ResizeObserver reports the
/// real content size after mount) can re-anchor the now-correctly-sized menu to
/// the same origin instead of leaving it clamped against a stale size.
#[derive(Default)]
pub struct TrayMenuAnchor(pub Mutex<Option<(f64, f64)>>);

/// Clamp the desired top-left so the whole `menu_size` stays inside `work_area`,
/// leaving `TASKBAR_MARGIN` at the bottom.
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
    crate::input::get_cursor_position(app).map_or((0.0, 0.0), |(cx, cy)| (cx as f64, cy as f64))
}

fn dispatch_tray_menu_dom_event(window: &tauri::WebviewWindow, event: &str) {
    let script = format!("window.dispatchEvent(new Event({event:?}));");
    if let Err(e) = window.eval(&script) {
        log::debug!("tray-menu DOM event dispatch failed for {event}: {e}");
    }
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
    let menu_size = window.inner_size().map_or((192.0, 360.0), |s| {
        (s.width as f64 / scale, s.height as f64 / scale)
    });

    let work_area = work_area_for_point(app, anchor);
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
        .is_ok_and(|p| (p.y as f64 / scale) > OFFSCREEN / 2.0)
}

/// Core open placement: ensure the tray-menu window exists, clamp the anchor to
/// the monitor work area, position, show, and focus it.
fn place_tray_menu(app: &AppHandle, anchor: (f64, f64)) -> Result<(), String> {
    install_tray_menu_lifecycle(app);
    let window = ensure_window(app, TRAY_MENU_LABEL)?;
    // A cold webview paints nothing: moving it on screen now would put an empty
    // transparent rectangle under the cursor and arm the toggle, so the next
    // click would "close" a menu the user never saw. Defer to the page-load
    // callback instead — `install_tray_menu_lifecycle`/the startup warmup have
    // already kicked the load off.
    if !TRAY_MENU_PAGE_LOADED.load(Ordering::Acquire) {
        TRAY_MENU_OPEN_PENDING.store(true, Ordering::Release);
        log::debug!("[tray-menu] open deferred until the webview finishes loading");
        return Ok(());
    }
    dispatch_tray_menu_dom_event(&window, TRAY_MENU_WILL_OPEN_EVENT);
    position_tray_menu(app, &window, anchor)?;
    if !window.is_visible().unwrap_or(false) {
        window.show().map_err(|e| e.to_string())?;
    }
    let _ = window.unminimize();
    let _ = window.set_focus();
    // Keep other apps' occlusion trackers from freezing a small window (e.g. a
    // picture-in-picture player) the menu happens to fully cover — see the
    // helper's doc comment.
    #[cfg(target_os = "windows")]
    super::windows::placement::exempt_popup_from_occlusion_tracking(&window);
    dispatch_tray_menu_dom_event(&window, TRAY_MENU_OPENED_EVENT);
    log::debug!(
        "[tray-menu] placed at anchor ({}, {}); position={:?}",
        anchor.0,
        anchor.1,
        window.outer_position().ok()
    );
    Ok(())
}

/// `show_tray_menu` — open the custom HTML tray menu anchored at (x, y) in
/// logical screen px, or at the cursor when omitted. Stores the anchor so a
/// later resize can re-anchor. Mirrors the reference's `showTrayMenuAt`.
#[tauri::command]
#[specta::specta]
pub fn show_tray_menu(app: AppHandle, x: Option<f64>, y: Option<f64>) -> Result<(), String> {
    let anchor = resolve_anchor(&app, x, y);
    if let Some(state) = app.try_state::<TrayMenuAnchor>()
        && let Ok(mut guard) = state.0.lock()
    {
        *guard = Some(anchor);
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
        install_tray_menu_lifecycle(&app);
        let window = ensure_window(&app, TRAY_MENU_LABEL)?;
        return position_tray_menu(&app, &window, anchor);
    }
    Ok(())
}

/// `hide_tray_menu` — hide (not destroy) the tray menu and clear the stored
/// anchor, matching the reference's `hideTrayMenu` (window keep-alive semantics).
#[tauri::command]
#[specta::specta]
pub fn hide_tray_menu(app: AppHandle) -> Result<(), String> {
    TRAY_MENU_OPEN_PENDING.store(false, Ordering::Release);
    if let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) {
        hide_tray_menu_window(&window);
    }
    if let Some(state) = app.try_state::<TrayMenuAnchor>()
        && let Ok(mut guard) = state.0.lock()
    {
        *guard = None;
    }
    Ok(())
}

/// Dismiss the tray menu by parking it off-screen. Keeping it shown avoids the
/// Windows show animation on the next open; the position check is the source of
/// truth for whether the popup is open.
fn hide_tray_menu_window(window: &tauri::WebviewWindow) {
    // A dismiss also cancels an open still waiting on the page load, so the
    // menu can't pop up after the user has clicked away.
    TRAY_MENU_OPEN_PENDING.store(false, Ordering::Release);
    complete_tray_menu_resize();
    dispatch_tray_menu_dom_event(window, TRAY_MENU_HIDDEN_EVENT);
    let _ = window.set_position(LogicalPosition::new(OFFSCREEN, OFFSCREEN));
}

/// Hide the tray menu directly (no command roundtrip). Used by the blur/resize
/// window-event handler the tray-click wiring installs. Clears the stored anchor.
fn hide_tray_menu_internal(app: &AppHandle) {
    TRAY_MENU_OPEN_PENDING.store(false, Ordering::Release);
    if let Some(window) = app.get_webview_window(TRAY_MENU_LABEL) {
        hide_tray_menu_window(&window);
    }
    if let Some(state) = app.try_state::<TrayMenuAnchor>()
        && let Ok(mut guard) = state.0.lock()
    {
        *guard = None;
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
        .map_or(1.0, |m| m.scale_factor());
    let logical = (physical_x / scale, physical_y / scale);
    if let Some(state) = app.try_state::<TrayMenuAnchor>()
        && let Ok(mut guard) = state.0.lock()
    {
        *guard = Some(logical);
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
        .is_some_and(|w| is_tray_menu_on_screen(&w));
    // A deferred open counts as "already open" so the second click of a
    // double-click cancels it instead of racing the page load.
    let opening = TRAY_MENU_OPEN_PENDING.load(Ordering::Acquire);
    log::debug!(
        "[tray-menu] toggle at physical ({physical_x}, {physical_y}); on_screen={on_screen} opening={opening}"
    );
    if on_screen || opening {
        hide_tray_menu_internal(app);
    } else {
        show_tray_menu_at_physical(app, physical_x, physical_y);
    }
}

/// Warm the tray-menu webview shortly after startup so the FIRST tray
/// right-click reveals an already-loaded menu. Without this the webview is
/// created cold inside that first click: the transparent window is positioned
/// on screen while WebView2 is still loading the page, so nothing paints — the
/// click looks dead, and the toggle/blur logic then eats the next click(s)
/// until the page has loaded. (The post-startup prewarm that used to do this
/// was removed in the alpha.8 rollup; this restores the tray-menu half, and
/// `windows::schedule_secondary_window_warmup` restores the other always-warm
/// surfaces.)
pub(crate) fn schedule_tray_menu_warmup(app: &AppHandle) {
    if TRAY_MENU_WARMUP_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(TRAY_MENU_WARMUP_DELAY_MS));
        let app_for_main = app.clone();
        // WebView2 creation must happen on the main thread; the event loop is
        // pumping by now, so this runs right after the current tick.
        if let Err(e) = app.run_on_main_thread(move || {
            install_tray_menu_lifecycle(&app_for_main);
        }) {
            log::warn!("tray-menu warmup scheduling failed: {e}");
        }
    });
}

/// Install the tray-menu window's lifecycle behaviors once, on the first
/// user-driven open. Two parities with the reference's `tray-menu-window.ts`:
///   1. RESIZE → RE-ANCHOR: the renderer's ResizeObserver reports the menu's real
///      `w-fit` content size via TRAY_MENU_RESIZE → `resize_window`. When the OS
///      resize lands, re-place the menu against the stored anchor so the now
///      correctly-sized menu stays glued to the click point (the reference's
///      `reanchorMenuIfVisible`).
///   2. BLUR → HIDE: when the menu loses focus (user clicked elsewhere), dismiss it
///      (the reference's `handleBlur`).
///      acceptable for v1; the renderer also closes the menu on item clicks.
pub fn install_tray_menu_lifecycle(app: &AppHandle) {
    if TRAY_MENU_LIFECYCLE_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }

    // The caller is the first-open path. Create the window here and attach the
    // event hook exactly once; startup never constructs this WebView eagerly.
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
            if let Some(anchor) = anchor
                && let Some(window) = app_handle.get_webview_window(TRAY_MENU_LABEL)
                && is_tray_menu_on_screen(&window)
            {
                let _ = position_tray_menu(&app_handle, &window, anchor);
            }
            complete_tray_menu_resize();
        }
        tauri::WindowEvent::Focused(false) => {
            // Only dismiss-on-blur if the menu is actually on screen. While the
            // window lives parked off-screen it can receive a spurious
            // Focused(false) (e.g. when it was park-shown at startup) — parking
            // it again is harmless, but guarding avoids clearing the anchor on a
            // window that isn't even open.
            if let Some(window) = app_handle.get_webview_window(TRAY_MENU_LABEL)
                && is_tray_menu_on_screen(&window)
            {
                // Suppress only while a programmatic resize is awaiting its
                // native completion callback. Once `Resized` (or restored focus)
                // arrives, the next real click-away dismisses immediately.
                if !TRAY_MENU_RESIZE_IN_FLIGHT.load(Ordering::Acquire) {
                    hide_tray_menu_internal(&app_handle);
                }
            }
        }
        tauri::WindowEvent::Focused(true) => complete_tray_menu_resize(),
        _ => {}
    });

    // Park the window off-screen and show it once so WebView2 loads and the
    // renderer can report its real size before the user's first tray click.
    let _ = window.set_position(LogicalPosition::new(OFFSCREEN, OFFSCREEN));
    let _ = window.show();
}

#[cfg(test)]
mod tests {
    use super::{TASKBAR_MARGIN, clamp_to_work_area};

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
