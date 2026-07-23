// Overlay visibility commands.
//
// The WinSTT recording pill is the `overlay` WebviewWindow (windows/overlay.html,
// WINDOW_SPECS[overlay] in winstt/commands/windows.rs) — not the legacy
// `recording_overlay` window. The OverlayPage renderer paints the dynamic-island
// pill ENTIRELY from IPC events it already receives (stt:recording-start /
// realtime-update / stt:audio-level / …) through its own Zustand stores. So the
// backend's only job here is to SHOW / HIDE / POSITION that transparent window in
// lock-step with the recording lifecycle — exactly what the reference's showOverlay()/
// hideOverlay() do (the renderer owns all the content; we own the OS window).
//
// Show-gating mirrors the reference's `isOverlaySuppressedBySettings`:
//   - general.showRecordingOverlay == false  → never show
//   - general.recordingMode == "listen"      → never show (listen is passive)
//   - resolved overlayPosition == "none"     → hard "do not show"
// Position mirrors `computeOverlayPosition`:
//   - dynamic-island OR overlayPosition=="top" → docked flush to physical top
//     bezel of the primary display, horizontally centered.
//   - floating-bottom                          → centered in work area, 60px gap
//     above the taskbar.
//
use std::sync::{
    Condvar, Mutex, PoisonError,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::winstt::commands::settings::read_settings;
use crate::winstt::settings_schema::{OverlayMode, OverlayPosition, RecordingMode};

/// Label of the WinSTT overlay webview (== Vite entry key == windows.rs spec label).
const OVERLAY_LABEL: &str = "overlay";

/// Monotonic "show generation". Bumped on every `place_and_show`; the deferred-hide
/// thread captures the value at hide time and only actually hides the OS window if
/// no NEWER show landed in the grace window. This is the Rust analogue of the reference's
/// `desired` state guard — it prevents a rapid press→release→press cycle from having
/// the previous session's grace-timer hide the freshly-shown pill.
static OVERLAY_SHOW_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Desired native visibility. Generation alone cancels old hide retries after a
/// newer show, but the fresh-show opacity ramp also needs to know if a hide
/// landed during its 80ms renderer-paint delay.
static OVERLAY_DESIRED_VISIBLE: AtomicBool = AtomicBool::new(false);

/// Native hit regions are accepted only while the overlay is intentionally
/// visible. Hide disables this before the renderer's close animation can report
/// stale rects back to Rust.
static OVERLAY_HIT_REGIONS_ENABLED: AtomicBool = AtomicBool::new(false);
/// Serializes the generation predicate with native show/hide/reveal calls. An
/// atomic predicate alone leaves a check-then-act gap where a stale renderer
/// acknowledgement can pass its check, a new generation can show, and the stale
/// acknowledgement can then hide that new window.
static OVERLAY_NATIVE_VISIBILITY_LOCK: Mutex<()> = Mutex::new(());
/// A fresh native show stays transparent until the renderer reports its first
/// non-empty painted hit region. Zero means there is no reveal outstanding.
static OVERLAY_PENDING_REVEAL_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct OverlayPageLoadState {
    generation: u64,
    loaded_generation: Option<u64>,
}

impl OverlayPageLoadState {
    fn begin_navigation(&mut self) {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.loaded_generation = None;
    }

    fn finish_navigation(&mut self) {
        // Be defensive if a platform emits Finished without Started.
        if self.generation == 0 {
            self.generation = 1;
        }
        self.loaded_generation = Some(self.generation);
    }

    fn current_navigation_is_loaded(&self) -> bool {
        self.generation != 0 && self.loaded_generation == Some(self.generation)
    }
}

/// Page readiness is scoped to the current navigation rather than remaining
/// sticky forever after the first WebView load. This matters when WebView2
/// recreates or reloads the overlay page in the same process.
static OVERLAY_PAGE_LOAD_STATE: (Mutex<OverlayPageLoadState>, Condvar) = (
    Mutex::new(OverlayPageLoadState {
        generation: 0,
        loaded_generation: None,
    }),
    Condvar::new(),
);
static LATEST_OVERLAY_HIT_REGIONS: Mutex<Vec<OverlayHitRect>> = Mutex::new(Vec::new());

/// The transparent overlay window can host both the STT pill and the TTS
/// read-aloud island. Track each owner separately so hiding one does not tear
/// down the other.
static RECORDING_OVERLAY_ACTIVE: AtomicBool = AtomicBool::new(false);
static TTS_OVERLAY_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Overlay window inner size (logical px). Mirrors WINDOW_SPECS[overlay].
const OVERLAY_WIDTH: f64 = 720.0;
const OVERLAY_HEIGHT: f64 = 240.0;
const FLOATING_BOTTOM_HIDE_GRACE_MS: u64 = 220;
const DYNAMIC_ISLAND_HIDE_GRACE_MS: u64 = 400;
const OVERLAY_REVEAL_FAILSAFE_MS: u64 = 500;
const OVERLAY_OFFSCREEN_POS: f64 = -10_000.0;

/// Grown overlay height while the editable preview-before-pasting pill is open.
/// The split enhance layout (top transcript/diff half + bottom AI-controls half)
/// needs more room than the passive 240px recording pill; restored to
/// `OVERLAY_HEIGHT` on confirm/cancel. The island/floating surface self-size to
/// their content (fitContent / measured) — this is just the window envelope that
/// must be tall enough not to clip the tallest preview state.
const PREVIEW_OVERLAY_HEIGHT: f64 = 660.0;

/// Gap above the work-area bottom edge for the floating-bottom layout. Matches
/// the reference's `y = height - winHeight - 60` (computeOverlayPosition).
const FLOATING_BOTTOM_GAP: f64 = 60.0;

/// Renderer-measured rectangle, in overlay-window CSS/logical pixels, that
/// should remain native-hit-testable. Native overlay implementations use this
/// as the interactive region so transparent pixels outside the actual pill
/// surfaces do not block the app underneath while the overlay is interactive.
#[derive(Clone, Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OverlayHitRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Resolved screen-edge for the overlay. Ports `resolveOverlayPosition`: "auto"
/// degrades to `none` on Linux (unless WINSTT_FORCE_OVERLAY) and `bottom`
/// elsewhere; explicit none/top/bottom pass through.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ResolvedPosition {
    None,
    Top,
    Bottom,
}

/// Truthy env-flag check (1/true/yes/on, case-insensitive). Empty / 0 / false /
/// no / off / unset → false. Ports `isForceOverlayEnvFlagSet`.
fn is_force_overlay_env_value_set(value: &str) -> bool {
    !matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "" | "0" | "false" | "no" | "off"
    )
}

fn is_force_overlay_env_flag_set() -> bool {
    match std::env::var("WINSTT_FORCE_OVERLAY") {
        Ok(v) => is_force_overlay_env_value_set(&v),
        Err(_) => false,
    }
}

/// Linux escape hatch for the now-default-on overlay (item 10): true only when
/// `WINSTT_FORCE_OVERLAY` is PRESENT and set to a falsey value (0/false/no/off).
/// An unset or truthy value keeps the default-on floating pill; a falsey value
/// opts the resolved `auto` position back out to `none`.
#[cfg(target_os = "linux")]
fn overlay_force_flag_is_falsey() -> bool {
    match std::env::var("WINSTT_FORCE_OVERLAY") {
        Ok(v) => !is_force_overlay_env_value_set(&v),
        Err(_) => false,
    }
}

/// Resolve `general.overlayPosition` to a concrete edge. Ports `resolveOverlayPosition`.
fn resolve_overlay_position(position: OverlayPosition) -> ResolvedPosition {
    match position {
        OverlayPosition::None => ResolvedPosition::None,
        OverlayPosition::Top => ResolvedPosition::Top,
        OverlayPosition::Bottom => ResolvedPosition::Bottom,
        OverlayPosition::Auto => {
            // item 10: the floating pill is enabled by DEFAULT on every platform
            // now — including Linux, where `auto` previously degraded to `none`
            // (invisible OOB) unless a force-env flag was set. Linux keeps the env
            // var as an escape hatch, but its meaning is now "opt OUT": a falsey
            // `WINSTT_FORCE_OVERLAY` resolves back to `none`.
            #[cfg(target_os = "linux")]
            {
                let _ = is_force_overlay_env_flag_set;
                if overlay_force_flag_is_falsey() {
                    ResolvedPosition::None
                } else {
                    ResolvedPosition::Bottom
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                let _ = is_force_overlay_env_flag_set;
                ResolvedPosition::Bottom
            }
        }
    }
}

/// The overlay's three suppression gates (the reference `isOverlaySuppressedBySettings`):
/// disabled toggle, listen mode, or a resolved `none` edge. Returns the resolved
/// edge when NOT suppressed (so the caller can position without recomputing).
fn overlay_show_decision(app: &AppHandle) -> Option<ResolvedPosition> {
    let general = read_settings(app).general;
    if !general.show_recording_overlay {
        return None;
    }
    if general.recording_mode == RecordingMode::Listen {
        return None;
    }
    let resolved = resolve_overlay_position(general.overlay_position);
    if resolved == ResolvedPosition::None {
        return None;
    }
    Some(resolved)
}

/// Compute the overlay top-left in LOGICAL screen px for the resolved layout.
/// Ports `computeOverlayPosition`: dynamic-island / top → physical-top-bezel
/// anchor (uses monitor bounds, not work area); floating-bottom → work-area
/// centered, `FLOATING_BOTTOM_GAP` above the taskbar.
fn compute_overlay_position(
    app: &AppHandle,
    mode: OverlayMode,
    edge: ResolvedPosition,
) -> Option<(f64, f64)> {
    compute_overlay_position_h(app, mode, edge, OVERLAY_HEIGHT)
}

/// Like [`compute_overlay_position`] but for an arbitrary window `height` — the
/// preview pill grows the overlay, and the floating-bottom anchor must subtract
/// the LIVE height (not the 240 constant) to stay above the taskbar.
fn compute_overlay_position_h(
    app: &AppHandle,
    mode: OverlayMode,
    edge: ResolvedPosition,
    height: f64,
) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let mx = monitor.position().x as f64 / scale;
    let my = monitor.position().y as f64 / scale;
    let mw = monitor.size().width as f64 / scale;
    let mh = monitor.size().height as f64 / scale;

    let want_top = edge == ResolvedPosition::Top || mode == OverlayMode::DynamicIsland;
    let x = mx + ((mw - OVERLAY_WIDTH) / 2.0).round();
    let y = if want_top {
        my
    } else {
        my + mh - height - FLOATING_BOTTOM_GAP
    };
    Some((x, y))
}

/// Frame used while STT and TTS overlap: one transparent window spans from the
/// top bezel to the normal floating-bottom baseline so TTS can keep the top
/// island while STT uses the bottom pill.
fn compute_stacked_overlay_frame(app: &AppHandle) -> Option<(f64, f64, f64)> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    let mx = monitor.position().x as f64 / scale;
    let my = monitor.position().y as f64 / scale;
    let mw = monitor.size().width as f64 / scale;
    let mh = monitor.size().height as f64 / scale;

    let x = mx + ((mw - OVERLAY_WIDTH) / 2.0).round();
    let height = (mh - FLOATING_BOTTOM_GAP).max(OVERLAY_HEIGHT).min(mh);
    Some((x, my, height.round()))
}

fn ensure_overlay_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    match crate::winstt::commands::windows::ensure_window(app, OVERLAY_LABEL) {
        Ok(w) => Some(w),
        Err(_) => app.get_webview_window(OVERLAY_LABEL),
    }
}

/// Guards the one-time NSPanel conversion of the overlay window (macOS). The pill
/// is shown many times per session; converting more than once would re-swizzle the
/// live NSWindow class, so `ensure_overlay_is_panel` is made idempotent by this flag.
#[cfg(target_os = "macos")]
static OVERLAY_PANEL_CONVERTED: AtomicBool = AtomicBool::new(false);

/// macOS: a non-activating, floating NSPanel subclass for the overlay window.
///
/// `tauri-nspanel` swizzles the tao NSWindow into this class (`to_panel`), giving
/// us the AppKit affordances a plain Tauri window lacks: the pill can float over
/// full-screen apps and every Space, and — crucially — never becomes the key
/// window, so revealing it mid-dictation cannot steal keyboard focus from the app
/// the user is typing into. This is the macOS analogue of the Windows
/// `focused(false)` + `HWND_TOPMOST` (`force_overlay_topmost`) treatment.
#[cfg(target_os = "macos")]
mod macos_panel {
    // The `tauri_panel!` expansion calls `WebviewWindow::app_handle()`, which is a
    // `tauri::Manager` method — the trait must be in scope in THIS module (the
    // file-level import does not reach into a child `mod`).
    use tauri::Manager;

    tauri_nspanel::tauri_panel!(WinsttOverlayPanel {
        config: {
            // Override `-[NSWindow canBecomeKeyWindow]` → the panel can never take
            // key status, so show/click never activates WinSTT or pulls focus.
            can_become_key_window: false,
            is_floating_panel: true,
            // Stay on screen when WinSTT is not the active app (the whole point:
            // the pill floats over whatever the user is actually working in).
            hides_on_deactivate: false,
        }
    });
}

/// Convert the overlay window into a non-activating floating NSPanel (idempotent).
/// On any failure this logs and leaves the normal always-on-top window in place —
/// the pill still works, it just lacks the panel-only floating/non-key niceties.
#[cfg(target_os = "macos")]
fn ensure_overlay_is_panel(window: &tauri::WebviewWindow) {
    if OVERLAY_PANEL_CONVERTED.load(Ordering::SeqCst) {
        return;
    }
    let win = window.clone();
    // NSWindow class swizzling + AppKit configuration must run on the main thread.
    let _ = window.run_on_main_thread(move || {
        // Re-check under the main thread so two racing shows convert exactly once.
        if OVERLAY_PANEL_CONVERTED.swap(true, Ordering::SeqCst) {
            return;
        }
        use tauri_nspanel::{CollectionBehavior, PanelLevel, StyleMask, WebviewWindowExt};
        match win.to_panel::<macos_panel::WinsttOverlayPanel>() {
            Ok(panel) => {
                // Non-activating, borderless style mask → the panel never activates
                // the app on interaction and carries no title bar / frame.
                panel.set_style_mask(StyleMask::new().borderless().nonactivating_panel().value());
                // Float above normal windows; mirrors the Windows topmost band.
                panel.set_level(PanelLevel::Floating.into());
                panel.set_floating_panel(true);
                // Visible on every Space, over full-screen apps, and unmoved by
                // Mission Control — the pill must track the user everywhere.
                panel.set_collection_behavior(
                    CollectionBehavior::new()
                        .can_join_all_spaces()
                        .full_screen_auxiliary()
                        .stationary()
                        .value(),
                );
            }
            Err(error) => {
                // Fall back to the normal window; allow a later show to retry.
                OVERLAY_PANEL_CONVERTED.store(false, Ordering::SeqCst);
                log::warn!("[overlay] NSPanel conversion failed; keeping normal window: {error}");
            }
        }
    });
}

pub(crate) fn mark_overlay_page_loading() {
    let (lock, cvar) = &OVERLAY_PAGE_LOAD_STATE;
    let mut state = lock.lock().unwrap_or_else(PoisonError::into_inner);
    state.begin_navigation();
    cvar.notify_all();
}

pub(crate) fn mark_overlay_page_loaded() {
    let (lock, cvar) = &OVERLAY_PAGE_LOAD_STATE;
    let mut state = lock.lock().unwrap_or_else(PoisonError::into_inner);
    state.finish_navigation();
    cvar.notify_all();
}

pub(crate) fn wait_for_overlay_page_loaded(timeout: Duration) -> bool {
    let started = Instant::now();
    let (lock, cvar) = &OVERLAY_PAGE_LOAD_STATE;
    let mut state = lock.lock().unwrap_or_else(PoisonError::into_inner);
    while !state.current_navigation_is_loaded() {
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            break;
        }
        state = cvar
            .wait_timeout(state, timeout - elapsed)
            .unwrap_or_else(PoisonError::into_inner)
            .0;
    }
    state.current_navigation_is_loaded()
}

#[cfg_attr(
    not(target_os = "windows"),
    expect(
        dead_code,
        reason = "overlay opacity byte is consumed by Windows-only overlay code"
    )
)]
fn overlay_opacity_byte(opacity: f64) -> u8 {
    (opacity.clamp(0.0, 1.0) * 255.0).round() as u8
}

#[cfg(target_os = "windows")]
fn set_overlay_window_opacity(window: &tauri::WebviewWindow, opacity: f64) -> Result<(), String> {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongPtrW, LWA_ALPHA, SetLayeredWindowAttributes, SetWindowLongPtrW,
        WS_EX_LAYERED,
    };

    let alpha = overlay_opacity_byte(opacity);
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    // SAFETY: `hwnd` is the native handle for the Tauri window; the style and opacity calls do
    // not take ownership and all fallible calls are checked.
    unsafe {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let layered_style = ex_style | WS_EX_LAYERED.0 as isize;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, layered_style);
        SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// CSS opacity-transition duration for the non-Windows document-root fade. Kept
/// shorter than the smallest hide grace (`FLOATING_BOTTOM_HIDE_GRACE_MS`) so the
/// fade-to-zero always completes before the window is actually hidden. Gated to
/// non-Windows: the Windows path drives opacity through the layered-window API and
/// never reads this, so a module-wide const would be dead code there.
#[cfg(not(target_os = "windows"))]
const OVERLAY_OPACITY_TRANSITION_MS: u64 = 120;

#[cfg(not(target_os = "windows"))]
fn set_overlay_window_opacity(window: &tauri::WebviewWindow, opacity: f64) -> Result<(), String> {
    // There is no `SetLayeredWindowAttributes` off Windows, and Tauri v2 exposes no
    // cross-platform per-window opacity API. Instead of a silent no-op, drive the
    // same fade envelope the Windows layered-window path gives us straight in the
    // webview: set the document root's CSS opacity. The OverlayPage paints the pill
    // from its Zustand stores, so fading the whole document (a) hides the very first
    // pre-paint frame on show — matching the Windows "start at 0, ramp to 1" ramp
    // (`place_and_show_at`) — and (b) composes cleanly over the renderer's own
    // enter/exit animation. eval failures (e.g. the webview not yet loaded on a
    // race-ahead first show) are surfaced to the caller, which already ignores them.
    let clamped = opacity.clamp(0.0, 1.0);
    let script = format!(
        "(function(){{var r=document.documentElement;if(r){{r.style.transition='opacity {OVERLAY_OPACITY_TRANSITION_MS}ms linear';r.style.opacity='{clamped}';}}}})();"
    );
    window.eval(&script).map_err(|e| e.to_string())
}

fn overlay_hide_should_wait_for_renderer(mode: OverlayMode) -> bool {
    mode == OverlayMode::DynamicIsland
}

fn overlay_hide_grace_ms(mode: OverlayMode, force_renderer_grace: bool) -> u64 {
    if force_renderer_grace || overlay_hide_should_wait_for_renderer(mode) {
        DYNAMIC_ISLAND_HIDE_GRACE_MS
    } else {
        FLOATING_BOTTOM_HIDE_GRACE_MS
    }
}

fn apply_overlay_hide(window: &tauri::WebviewWindow) {
    let _ = set_overlay_window_opacity(window, 0.0);
    // Restore click-through only now, AFTER the window is fully transparent.
    // Toggling the flag earlier (while the island's exit animation is still on
    // screen) makes tao rewrite GWL_EXSTYLE and issue a SWP_FRAMECHANGED
    // SetWindowPos, which invalidates the whole native frame; WebView2 repaints
    // the invalidated area with its white clear color before the next composite,
    // and SetWindowRgn clips that to the pill's hit region — a sharp white
    // rectangle flashing behind the closing island.
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.set_position(tauri::LogicalPosition::new(
        OVERLAY_OFFSCREEN_POS,
        OVERLAY_OFFSCREEN_POS,
    ));
    set_empty_overlay_hit_region(window);
    let _ = window.hide();
}

fn overlay_hide_is_still_desired(generation: u64) -> bool {
    !OVERLAY_DESIRED_VISIBLE.load(Ordering::SeqCst)
        && OVERLAY_SHOW_GENERATION.load(Ordering::SeqCst) == generation
}

fn overlay_reveal_is_still_desired(generation: u64) -> bool {
    OVERLAY_DESIRED_VISIBLE.load(Ordering::SeqCst)
        && OVERLAY_SHOW_GENERATION.load(Ordering::SeqCst) == generation
        && OVERLAY_PENDING_REVEAL_GENERATION.load(Ordering::SeqCst) == generation
}

/// Caller must hold `OVERLAY_NATIVE_VISIBILITY_LOCK`, keeping the predicate and
/// native opacity transition atomic with respect to every hide/show path.
fn reveal_overlay_if_current_locked(window: &tauri::WebviewWindow, generation: u64) {
    if !overlay_reveal_is_still_desired(generation) {
        return;
    }
    let _ = set_overlay_window_opacity(window, 1.0);
    OVERLAY_PENDING_REVEAL_GENERATION.store(0, Ordering::SeqCst);
}

/// Position + reveal the overlay window without re-activating it (showInactive
/// parity → no focus steal, so the user's target app stays the keyboard sink).
/// `reason` ("recording" | "tts") is forwarded to the renderer's `overlay:show`
/// event (informational; the OverlayPage paints from its Zustand stores either way).
fn place_and_show_at(app: &AppHandle, height: f64, position: Option<(f64, f64)>, reason: &str) {
    // The overlay is normally prewarmed shortly after the main pill paints. Keep
    // this idempotent ensure as a fallback for a recording that beats the prewarm.
    let Some(window) = ensure_overlay_window(app) else {
        return;
    };
    // macOS: make the overlay a non-activating floating NSPanel the first time it
    // is shown (idempotent; no-op on other platforms). Done here rather than at
    // window creation (windows.rs) so the conversion hooks the exact surface the
    // pipeline reveals without touching the shared window-spec module.
    #[cfg(target_os = "macos")]
    ensure_overlay_is_panel(&window);
    let _native_visibility = OVERLAY_NATIVE_VISIBILITY_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    // Mark a fresh show so any in-flight deferred-hide thread cancels itself.
    let generation = OVERLAY_SHOW_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    OVERLAY_DESIRED_VISIBLE.store(true, Ordering::SeqCst);
    OVERLAY_HIT_REGIONS_ENABLED.store(true, Ordering::SeqCst);
    let was_visible = window.is_visible().unwrap_or(false);
    // Reset to the caller's footprint; preview and STT+TTS overlap both grow the
    // window, and the next owner must not inherit that size.
    let _ = window.set_size(tauri::LogicalSize::new(OVERLAY_WIDTH, height));
    // Clear the native window region ONLY on a fresh show. `SetWindowRgn` clips
    // RENDERING, not just hit-testing (see `set_overlay_hit_regions`), so wiping
    // it to empty on a RE-show of an already-visible overlay blanks the live pill
    // until the renderer next reports a region — and the renderer dedupes
    // identical payloads, so an unchanged pill stays invisible until its content
    // resizes. That is exactly the dictation `transcribing → post-processing`
    // re-show (`show_recording_overlay` is called again when the LLM clean-up is
    // about to run): the island vanished after "Transcribing" and only popped
    // back when the thinking indicator changed the pill's size. On a fresh show
    // the renderer may have already painted and reported a TTS island while the
    // native window was hidden. Apply that cached region first; otherwise start
    // empty while the renderer paints and reports its first visible region. On a
    // re-show the existing region already matches the on-screen pill, so leave it
    // untouched and let the renderer's ResizeObserver morph it smoothly.
    let already_painted = if was_visible || apply_latest_overlay_hit_regions(&window) {
        true
    } else {
        set_empty_overlay_hit_region(&window);
        false
    };
    if let Some((x, y)) = position {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
    if !was_visible {
        let _ = set_overlay_window_opacity(&window, 0.0);
    }
    // `show()` alone (no `set_focus`) keeps the pill from stealing keyboard focus
    // mid-dictation — the window is created with `focused(false)` + skip_taskbar +
    // ignore_cursor (WINDOW_SPECS[overlay]), so showing it does not activate it.
    let _ = window.show();
    // Recording and TTS both expose controls inside the overlay window (STT
    // cancel X; TTS pause/resume/stop/speed), so the native window must capture
    // cursor events while visible. The window is created `ignore_cursor: true`;
    // if we leave that flag on, clicks fall through before the DOM button can
    // receive them.
    let _ = window.set_ignore_cursor_events(ignore_cursor_events_for_show_reason(reason));
    // On Windows, re-assert TOPMOST after showing (matches the legacy overlay path;
    // a fresh show can land below other always-on-top windows otherwise).
    #[cfg(target_os = "windows")]
    force_overlay_topmost(&window);
    // Tell the renderer the overlay window is now on screen (parity with the legacy
    // `overlay:show` event; the OverlayPage also self-clears on visibilitychange).
    let _ = window.emit(crate::winstt::commands::events::names::OVERLAY_SHOW, reason);
    if already_painted {
        OVERLAY_PENDING_REVEAL_GENERATION.store(0, Ordering::SeqCst);
        let _ = set_overlay_window_opacity(&window, 1.0);
        return;
    }
    // The renderer's first non-empty hit-region report is the authoritative
    // painted callback. Keep the native window transparent until that arrives;
    // the one-shot timer below is only a recovery path for a dead renderer/IPC.
    OVERLAY_PENDING_REVEAL_GENERATION.store(generation, Ordering::SeqCst);
    let win = window;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(OVERLAY_REVEAL_FAILSAFE_MS));
        let _native_visibility = OVERLAY_NATIVE_VISIBILITY_LOCK
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        reveal_overlay_if_current_locked(&win, generation);
    });
}

fn place_and_show(app: &AppHandle, mode: OverlayMode, edge: ResolvedPosition, reason: &str) {
    place_and_show_at(
        app,
        OVERLAY_HEIGHT,
        compute_overlay_position(app, mode, edge),
        reason,
    );
}

fn place_and_show_stacked(app: &AppHandle, reason: &str) {
    match compute_stacked_overlay_frame(app) {
        Some((x, y, height)) => place_and_show_at(app, height, Some((x, y)), reason),
        None => place_and_show(
            app,
            OverlayMode::DynamicIsland,
            ResolvedPosition::Top,
            reason,
        ),
    }
}

/// Return the native cursor-ignore value for a newly-shown overlay.
/// `true` means OS-level click-through; `false` means the WebView can receive
/// mouse/touch input for its visible controls.
fn ignore_cursor_events_for_show_reason(reason: &str) -> bool {
    !matches!(reason, "recording" | "tts" | "preview")
}

/// Suppress the legacy non-client frame paint on the overlay window.
///
/// tao gives every top-level window `WS_CAPTION | WS_SYSMENU` in its real
/// `GWL_STYLE` (decorations(false) only strips them for `AdjustWindowRectEx`),
/// and rewrites that style on every window-flag diff — including the
/// `set_ignore_cursor_events` flips in the overlay show/hide paths — so the
/// caption style cannot be stripped once and stay gone. Normally the caption
/// is invisible because tao's `WM_NCCALCSIZE` handling leaves no non-client
/// area, but `SetWindowRgn` (the hit-region mechanism in
/// `apply_overlay_hit_regions`) drops the window out of DWM frame rendering
/// into the legacy frame pipeline. From there, every activation repaints the
/// classic caption bar into the window's redirection bitmap — and clicking the
/// island always activates the window, because WebView2 focuses itself on
/// mouse-down (so even `WS_EX_NOACTIVATE` cannot prevent it; verified live).
/// Those opaque caption pixels then linger behind the pill as a light "bar"
/// wherever the hit region extends past the island's painted surface.
///
/// Fix: subclass the hwnd and (a) swallow `WM_NCPAINT` and the undocumented
/// themed-caption repaints, (b) forward `WM_NCACTIVATE` with `lparam = -1`,
/// which tells `DefWindowProc` to skip the frame repaint. tao's own subclass
/// still receives `WM_NCACTIVATE` (it only reads `wparam`), so focus events
/// are unaffected.
#[cfg(target_os = "windows")]
pub(crate) fn suppress_overlay_frame_paint(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{WM_NCACTIVATE, WM_NCPAINT};

    // Undocumented "user allowed height" caption/frame repaints sent to themed
    // windows; classic frameless-window hygiene swallows them alongside NCPAINT.
    const WM_NCUAHDRAWCAPTION: u32 = 0x00AE;
    const WM_NCUAHDRAWFRAME: u32 = 0x00AF;
    const SUBCLASS_ID: usize = 0x574e_4652; // "WNFR" — WinSTT no-frame subclass

    unsafe extern "system" fn no_frame_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        _ref_data: usize,
    ) -> LRESULT {
        match msg {
            WM_NCPAINT | WM_NCUAHDRAWCAPTION | WM_NCUAHDRAWFRAME => LRESULT(0),
            // SAFETY: forwarding down the subclass chain with the documented
            // "do not repaint" lparam sentinel.
            WM_NCACTIVATE => unsafe { DefSubclassProc(hwnd, msg, wparam, LPARAM(-1)) },
            // SAFETY: default forwarding down the subclass chain.
            _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
        }
    }

    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(hwnd) = w.hwnd() {
            // SAFETY: `hwnd` belongs to this process and we are on its thread
            // (SetWindowSubclass requires the window's own thread). Installing
            // the same id twice only updates ref_data, so this is idempotent.
            unsafe {
                let _ = SetWindowSubclass(hwnd, Some(no_frame_proc), SUBCLASS_ID, 0);
            }
        }
    });
}

/// Force the overlay topmost via Win32 (more reliable than always_on_top alone).
#[cfg(target_os = "windows")]
fn force_overlay_topmost(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetWindowPos,
    };
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(hwnd) = w.hwnd() {
            // SAFETY: `hwnd` belongs to the cloned Tauri window and the call only updates z-order.
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

// ── Public lifecycle API (called from the recording pipeline — see libOther) ────

#[cfg(target_os = "windows")]
fn overlay_rect_to_physical(
    rect: &OverlayHitRect,
    scale_factor: f64,
) -> Option<(i32, i32, i32, i32)> {
    if rect.width <= 0.0 || rect.height <= 0.0 {
        return None;
    }
    let left = (rect.x * scale_factor).floor().max(0.0) as i32;
    let top = (rect.y * scale_factor).floor().max(0.0) as i32;
    let right = ((rect.x + rect.width) * scale_factor).ceil().max(0.0) as i32;
    let bottom = ((rect.y + rect.height) * scale_factor).ceil().max(0.0) as i32;
    if right <= left || bottom <= top {
        return None;
    }
    Some((left, top, right, bottom))
}

#[cfg(target_os = "windows")]
fn apply_overlay_hit_regions(
    window: &tauri::WebviewWindow,
    rects: &[OverlayHitRect],
) -> Result<(), String> {
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, RGN_OR, SetWindowRgn,
    };

    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);

    // Empty region = visible overlay can never capture a stale transparent box.
    // The renderer sends a non-empty region as soon as a pill surface is present.
    // SAFETY: Creates a standalone GDI region handle that is either transferred to the window or
    // explicitly deleted on failure.
    let combined = unsafe { CreateRectRgn(0, 0, 0, 0) };
    if combined.is_invalid() {
        return Err("failed to create overlay hit region".into());
    }

    for rect in rects.iter().take(16) {
        let Some((left, top, right, bottom)) = overlay_rect_to_physical(rect, scale) else {
            continue;
        };
        // SAFETY: Coordinates were normalized to a non-empty physical rectangle.
        let part = unsafe { CreateRectRgn(left, top, right, bottom) };
        if part.is_invalid() {
            continue;
        }
        // SAFETY: Both region handles are valid; `part` is deleted after it is combined.
        unsafe {
            let _ = CombineRgn(Some(combined), Some(combined), Some(part), RGN_OR);
            let _ = DeleteObject(part.into());
        }
    }

    // SAFETY: Transfers ownership of `combined` to the window on success.
    let ok = unsafe { SetWindowRgn(hwnd, Some(combined), true) };
    if ok == 0 {
        // SAFETY: SetWindowRgn failed, so ownership was not transferred and the handle must be freed.
        unsafe {
            let _ = DeleteObject(combined.into());
        }
        return Err("failed to apply overlay hit region".into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn apply_overlay_hit_regions(
    _window: &tauri::WebviewWindow,
    _rects: &[OverlayHitRect],
) -> Result<(), String> {
    Ok(())
}

fn set_empty_overlay_hit_region(window: &tauri::WebviewWindow) {
    if let Err(error) = apply_overlay_hit_regions(window, &[]) {
        log::warn!("[overlay] failed to clear overlay hit region: {error}");
    }
}

fn remember_overlay_hit_regions(rects: &[OverlayHitRect]) {
    if let Ok(mut latest) = LATEST_OVERLAY_HIT_REGIONS.lock() {
        *latest = rects.to_vec();
    }
}

fn apply_latest_overlay_hit_regions(window: &tauri::WebviewWindow) -> bool {
    let rects = LATEST_OVERLAY_HIT_REGIONS
        .lock()
        .map(|latest| latest.clone())
        .unwrap_or_default();
    if rects.is_empty() {
        return false;
    }
    if let Err(error) = apply_overlay_hit_regions(window, &rects) {
        log::warn!("[overlay] failed to apply cached overlay hit region: {error}");
        return false;
    }
    true
}

/// Renderer feedback loop for native hit-testing. The overlay window is larger
/// than the visual pill so the renderer has layout room, but this command clips
/// the native window to only the currently painted pill/control rectangles.
#[tauri::command]
#[specta::specta]
pub fn set_overlay_hit_regions(app: AppHandle, rects: Vec<OverlayHitRect>) -> Result<(), String> {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return Ok(());
    };
    remember_overlay_hit_regions(&rects);
    let _native_visibility = OVERLAY_NATIVE_VISIBILITY_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if !OVERLAY_HIT_REGIONS_ENABLED.load(Ordering::SeqCst) {
        // During the close grace window, keep the last painted region alive.
        // SetWindowRgn clips rendering, not just hit-testing, so clearing here
        // would cut off the renderer's exit animation.
        return Ok(());
    }
    apply_overlay_hit_regions(&window, &rects)?;
    if !rects.is_empty() {
        let generation = OVERLAY_PENDING_REVEAL_GENERATION.load(Ordering::SeqCst);
        if generation != 0 {
            reveal_overlay_if_current_locked(&window, generation);
        }
    }
    Ok(())
}

/// Renderer acknowledgement that every painted overlay hit region has completed
/// its exit transition. The generation makes a delayed acknowledgement harmless
/// across rapid hide -> show -> hide cycles.
#[tauri::command]
#[specta::specta]
pub fn overlay_ack_hide_transition(app: AppHandle, generation: String) -> Result<(), String> {
    let generation = generation
        .parse::<u64>()
        .map_err(|_| "invalid overlay hide generation".to_string())?;
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return Ok(());
    };
    let _native_visibility = OVERLAY_NATIVE_VISIBILITY_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if !overlay_hide_is_still_desired(generation) {
        return Ok(());
    }
    OVERLAY_PENDING_REVEAL_GENERATION.store(0, Ordering::SeqCst);
    apply_overlay_hide(&window);
    Ok(())
}

/// Show the WinSTT recording overlay, honoring the suppression gates + position.
/// No-op (and HIDES any stray pill) when suppressed. Mirrors the reference `showOverlay`.
pub fn show_recording_overlay(app: &AppHandle) {
    let Some(edge) = overlay_show_decision(app) else {
        RECORDING_OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
        if TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
            place_and_show(
                app,
                OverlayMode::DynamicIsland,
                ResolvedPosition::Top,
                "tts",
            );
        } else {
            hide_overlay_window(app);
        }
        return;
    };
    RECORDING_OVERLAY_ACTIVE.store(true, Ordering::SeqCst);
    if TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show_stacked(app, "recording");
        return;
    }
    let mode = read_settings(app).general.overlay_mode;
    place_and_show(app, mode, edge, "recording");
}

/// Reserve the top island for a TTS request before audio starts. If STT is
/// visible, immediately expand the shared overlay into the top+bottom layout;
/// otherwise the window remains hidden until playback actually begins.
pub fn reserve_tts_overlay(app: &AppHandle) {
    TTS_OVERLAY_ACTIVE.store(true, Ordering::SeqCst);
    if RECORDING_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show_stacked(app, "tts");
    } else {
        place_and_show(
            app,
            OverlayMode::DynamicIsland,
            ResolvedPosition::Top,
            "tts",
        );
    }
}

pub fn tts_overlay_is_active() -> bool {
    TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst)
}

/// Show the overlay window for a TTS read-aloud. The read-aloud island
/// (`TtsIslandLayer`) is ALWAYS top-anchored regardless of the recording
/// overlay's mode/position, and it's the only way to pause / stop / change the
/// speed of a read — so we FORCE it top-centered and DON'T apply the recording
/// overlay's suppression gates (mirrors the reference's forced read-aloud pill).
/// The renderer paints the island purely from `ttsStatus`, so this only has to
/// reveal + position the window; hide is the owner-aware `hide_tts_overlay`
/// path so an active STT pill can stay visible underneath.
pub fn show_tts_overlay(app: &AppHandle) {
    TTS_OVERLAY_ACTIVE.store(true, Ordering::SeqCst);
    if RECORDING_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show_stacked(app, "tts");
        return;
    }
    place_and_show(
        app,
        OverlayMode::DynamicIsland,
        ResolvedPosition::Top,
        "tts",
    );
}

/// Hide the TTS owner of the shared overlay. If STT is still active, keep the
/// window visible and hand it back to the STT layout instead of hiding it.
pub fn hide_tts_overlay(app: &AppHandle) {
    TTS_OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
    if !RECORDING_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        hide_overlay_window_with_options(app, true);
        return;
    }
    let Some(edge) = overlay_show_decision(app) else {
        RECORDING_OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
        hide_overlay_window(app);
        return;
    };
    let mode = read_settings(app).general.overlay_mode;
    place_and_show(app, mode, edge, "recording");
}

/// Hide the STT owner of the shared overlay. If TTS is still active, preserve
/// the read-aloud island instead of tearing down the whole window.
pub fn hide_recording_overlay(app: &AppHandle) {
    RECORDING_OVERLAY_ACTIVE.store(false, Ordering::SeqCst);
    if TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show(
            app,
            OverlayMode::DynamicIsland,
            ResolvedPosition::Top,
            "tts",
        );
    } else {
        hide_overlay_window(app);
    }
}

/// Hide the shared overlay window. The renderer acknowledges when its painted
/// hit regions finish exiting; the mode-specific timer is a single hard
/// fallback for an unavailable or wedged renderer.
fn hide_overlay_window(app: &AppHandle) {
    hide_overlay_window_with_options(app, false);
}

fn hide_overlay_window_with_options(app: &AppHandle, force_renderer_grace: bool) {
    let _native_visibility = OVERLAY_NATIVE_VISIBILITY_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    OVERLAY_DESIRED_VISIBLE.store(false, Ordering::SeqCst);
    OVERLAY_HIT_REGIONS_ENABLED.store(false, Ordering::SeqCst);
    OVERLAY_PENDING_REVEAL_GENERATION.store(0, Ordering::SeqCst);
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    // Click-through is deliberately NOT restored here: flipping the cursor flag
    // makes tao rewrite the window ex-style + fire a SWP_FRAMECHANGED repaint,
    // which flashed a white rectangle (the region-clipped WebView2 clear color)
    // behind the island while its exit animation was still playing. The restore
    // happens in `apply_overlay_hide` after opacity reaches 0, so a stale
    // transparent overlay still can never keep capturing the cursor once the
    // window is actually gone; during the short exit grace the pill is still
    // on screen, so it owning the cursor over its own rect is correct.
    // Snapshot the current generation; only hide if no newer show lands during the
    // grace window (the press→release→press race guard — the reference's `desired`).
    let generation = OVERLAY_SHOW_GENERATION.load(Ordering::SeqCst);
    let _ = window.emit(
        crate::winstt::commands::events::names::OVERLAY_HIDE,
        generation.to_string(),
    );
    let mode = read_settings(app).general.overlay_mode;
    let grace_ms = overlay_hide_grace_ms(mode, force_renderer_grace);
    let win = window;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(grace_ms));
        let _native_visibility = OVERLAY_NATIVE_VISIBILITY_LOCK
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if overlay_hide_is_still_desired(generation) {
            apply_overlay_hide(&win);
        }
    });
}

/// Re-anchor a CURRENTLY-VISIBLE overlay after a live `general.overlayMode` /
/// `general.overlayPosition` change. Ports `repositionIfVisible`: no-op when the
/// pill is hidden (the next `show_recording_overlay` reads the new layout). A flip
/// to `overlayPosition == "none"` is handled by the caller (hide directly).
pub fn reposition_overlay_if_visible(app: &AppHandle) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    if RECORDING_OVERLAY_ACTIVE.load(Ordering::SeqCst) && TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst)
    {
        place_and_show_stacked(app, "recording");
        return;
    }
    if TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show(
            app,
            OverlayMode::DynamicIsland,
            ResolvedPosition::Top,
            "tts",
        );
        return;
    }
    // Recompute against the (possibly suppressed) current settings: if the live
    // change suppressed the overlay, hide it; otherwise re-anchor in place.
    let Some(edge) = overlay_show_decision(app) else {
        hide_recording_overlay(app);
        return;
    };
    let mode = read_settings(app).general.overlay_mode;
    if let Some((x, y)) = compute_overlay_position(app, mode, edge) {
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
}

/// Whether the recording pill is currently un-suppressed (settings allow showing
/// it). The preview-before-pasting gate consults this — no pill means no preview.
pub fn overlay_is_active(app: &AppHandle) -> bool {
    overlay_show_decision(app).is_some()
}

/// Grow + reposition the overlay for the editable preview pill and make it
/// INTERACTIVE (cursor-capturing) so its textarea/buttons work. Unlike the
/// recording pill show path we do NOT force `set_focus` — clicking the textarea
/// activates the window, and the paste target was already captured (see
/// `winstt::commands::preview::capture_foreground`) BEFORE this call. The
/// renderer keeps the pill revealed via `isPreviewActive`; teardown is
/// `exit_preview_overlay`.
pub fn enter_preview_overlay(app: &AppHandle) {
    RECORDING_OVERLAY_ACTIVE.store(true, Ordering::SeqCst);
    if TTS_OVERLAY_ACTIVE.load(Ordering::SeqCst) {
        place_and_show_stacked(app, "preview");
        return;
    }
    let mode = read_settings(app).general.overlay_mode;
    let edge = overlay_show_decision(app).unwrap_or(ResolvedPosition::Top);
    place_and_show_at(
        app,
        PREVIEW_OVERLAY_HEIGHT,
        compute_overlay_position_h(app, mode, edge, PREVIEW_OVERLAY_HEIGHT),
        "preview",
    );
}

/// Tear down the preview pill: restore the passive geometry, then either hide
/// the shared window or hand it back to the active TTS owner.
/// Called by `confirm_paste` / `cancel_preview`.
pub fn exit_preview_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = window.set_size(tauri::LogicalSize::new(OVERLAY_WIDTH, OVERLAY_HEIGHT));
    }
    hide_recording_overlay(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_position_resolves_per_platform() {
        let resolved = resolve_overlay_position(OverlayPosition::Auto);
        #[cfg(target_os = "linux")]
        {
            // Linux now defaults to the visible bottom pill (item 10 OOB
            // visibility); only a FALSEY WINSTT_FORCE_OVERLAY opts back out to none.
            if overlay_force_flag_is_falsey() {
                assert!(matches!(resolved, ResolvedPosition::None));
            } else {
                assert!(matches!(resolved, ResolvedPosition::Bottom));
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            assert!(matches!(resolved, ResolvedPosition::Bottom));
        }
    }

    #[test]
    fn explicit_positions_pass_through() {
        assert!(matches!(
            resolve_overlay_position(OverlayPosition::None),
            ResolvedPosition::None
        ));
        assert!(matches!(
            resolve_overlay_position(OverlayPosition::Top),
            ResolvedPosition::Top
        ));
        assert!(matches!(
            resolve_overlay_position(OverlayPosition::Bottom),
            ResolvedPosition::Bottom
        ));
    }

    #[test]
    fn force_env_flag_truthiness() {
        assert!(is_force_overlay_env_value_set("1"));
        assert!(is_force_overlay_env_value_set("true"));
        assert!(!is_force_overlay_env_value_set("off"));
        assert!(!is_force_overlay_env_value_set(""));
    }

    #[test]
    fn recording_show_captures_cursor_for_cancel_button() {
        assert!(!ignore_cursor_events_for_show_reason("recording"));
    }

    #[test]
    fn tts_show_captures_cursor_for_island_controls() {
        assert!(!ignore_cursor_events_for_show_reason("tts"));
    }

    #[test]
    fn preview_show_captures_cursor_for_editor_controls() {
        assert!(!ignore_cursor_events_for_show_reason("preview"));
    }

    #[test]
    fn unknown_show_reason_stays_click_through() {
        assert!(ignore_cursor_events_for_show_reason("unknown"));
    }

    #[test]
    fn only_dynamic_island_waits_for_renderer_hide_by_default() {
        assert!(overlay_hide_should_wait_for_renderer(
            OverlayMode::DynamicIsland
        ));
        assert!(!overlay_hide_should_wait_for_renderer(
            OverlayMode::FloatingBottom
        ));
    }

    #[test]
    fn tts_can_force_dynamic_hide_grace() {
        assert_eq!(
            overlay_hide_grace_ms(OverlayMode::FloatingBottom, true),
            DYNAMIC_ISLAND_HIDE_GRACE_MS
        );
    }

    #[test]
    fn page_readiness_is_invalidated_by_each_navigation() {
        let mut state = OverlayPageLoadState::default();
        assert!(!state.current_navigation_is_loaded());

        state.begin_navigation();
        assert!(!state.current_navigation_is_loaded());
        state.finish_navigation();
        assert!(state.current_navigation_is_loaded());

        let first_generation = state.generation;
        state.begin_navigation();
        assert!(state.generation > first_generation);
        assert!(!state.current_navigation_is_loaded());
        state.finish_navigation();
        assert!(state.current_navigation_is_loaded());
    }
}
