// Selection capture (UIA + clipboard-sandwich fallback) and paste planning.
//
// Owns the capture/paste types and the public `capture_selection_text` entry used
// by the TTS read-aloud hotkey. Extracted verbatim from the transforms module root
// (mirrors selection-capture.ts captureSelection + the paste-plan helpers).

use std::sync::Arc;
#[cfg(target_os = "windows")]
use std::sync::{Condvar, LazyLock, Mutex, Once, PoisonError};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::winstt::context::{ContextMode, ContextReader, WindowContextSnapshot};
use crate::winstt::managers::ContextManager;

use super::TransformSource;

// ── clipboard-sandwich tuning (mirrors selection-capture.ts constants) ─────────

/// How long we wait for the clipboard to update after the synthetic Ctrl+C.
const CLIPBOARD_UPDATE_TIMEOUT_MS: u64 = 700;
/// Polling interval used only when native clipboard-change notifications are
/// unavailable (non-Windows, or a failed Windows listener installation).
const CLIPBOARD_FALLBACK_POLL_INTERVAL_MS: u64 = 10;
/// Do not let first-use listener initialization wedge selection capture if the
/// Windows message thread fails before publishing readiness. The capture path
/// can always fall back to its bounded clipboard read loop.
const CLIPBOARD_LISTENER_READY_TIMEOUT: Duration = Duration::from_secs(2);
/// Keep Ctrl/Cmd held just long enough for apps that sample modifier state
/// asynchronously; the clipboard update waiter owns the real post-copy wait.
const COPY_MODIFIER_HOLD_MS: u64 = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TransformCaptureScope {
    Selection,
    FocusedField,
}

#[derive(Clone, Debug)]
pub(super) struct TransformCapture {
    pub(super) scope: TransformCaptureScope,
    pub(super) source: TransformSource,
    pub(super) text: String,
}

impl TransformCapture {
    pub(super) fn empty() -> Self {
        Self {
            scope: TransformCaptureScope::Selection,
            source: TransformSource::Empty,
            text: String::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum TransformPastePlan {
    ReplaceFocusedField(String),
    ReplaceSelection(String),
}

// ── selection capture (UIA + clipboard-sandwich fallback) ──────────────────────

/// Capture the user's current selection. UIA (`--selection` via the context
/// sidecar) is the primary path; the clipboard-sandwich is the fallback. Returns
/// the captured text plus whether it came from a true selection or the whole
/// focused field; an empty capture yields [`TransformCapture::empty`]. Mirrors
/// `captureSelection` in selection-capture.ts.
pub(super) fn capture_selection(context: &ContextManager, app: &AppHandle) -> TransformCapture {
    // 1. UIA selection (side-effect-free) via the context sidecar. Mirrors
    //    tryUiaSelection: the sidecar's `--selection` mode reports the live
    //    TextPattern selection in `selected_text`, falling back to `focused_text`
    //    when the control only exposes the focused value. The latter is a
    //    full-field transform, so paste-back must select-all first.
    if context.is_available() {
        let snap = ContextReader::read(context, ContextMode::Selection);
        if let Some(selected) = snap.selected_text.clone()
            && !selected.trim().is_empty()
        {
            return TransformCapture {
                scope: TransformCaptureScope::Selection,
                source: TransformSource::Uia,
                text: selected,
            };
        }
        if !snap.focused_text.trim().is_empty() {
            return TransformCapture {
                scope: TransformCaptureScope::FocusedField,
                source: TransformSource::Uia,
                text: snap.focused_text,
            };
        }
    }

    // 2. Clipboard-sandwich fallback (mirrors captureViaClipboard): save the
    //    current clipboard, subscribe to clipboard changes, simulate Ctrl+C,
    //    then restore the original clipboard. UIA fails silently in Chromium-
    //    based renderers (Slack, Discord, VS Code) and most modern apps unless
    //    accessibility is force-enabled — this trick covers those.
    capture_via_clipboard(app)
}

/// Capture the current selection for a NON-transform consumer (the TTS read-aloud
/// global hotkey). Resolves the `ContextManager` from managed state and returns
/// just the selected text (`""` when nothing is selected / no context manager).
/// Runs the SAME UIA → clipboard-sandwich path as the transforms pipeline, so the
/// hotkey behaves identically to "Speak selection". BLOCKING (the clipboard
/// sandwich simulates Ctrl+C) — call it off the hotkey thread.
pub fn capture_selection_text(app: &AppHandle) -> String {
    match app.try_state::<Arc<ContextManager>>() {
        Some(ctx) => {
            let ctx = ctx.inner().clone();
            capture_selection(ctx.as_ref(), app).text
        }
        None => String::new(),
    }
}

fn capture_via_clipboard(app: &AppHandle) -> TransformCapture {
    // Full-fidelity snapshot (raw formats on Windows, text+image elsewhere) so a
    // copied image / file list survives the Ctrl+C sandwich; the plain-text read
    // below only feeds native change detection (or the bounded non-Windows fallback).
    let snapshot = crate::clipboard_snapshot::capture(app);
    let original = read_clipboard(app).unwrap_or_default();

    // Subscribe BEFORE Ctrl+C so even an app that updates the clipboard
    // synchronously during input dispatch cannot beat the waiter. On Windows
    // this snapshots the process-wide WM_CLIPBOARDUPDATE generation; elsewhere
    // it is a no-op and the bounded fallback below remains in use.
    let clipboard_updates = arm_clipboard_update_wait();

    // Simulate Ctrl+C in the focused app. A failure here (no Enigo state) just
    // means the clipboard won't change and we fall through to "empty".
    if let Err(e) = send_copy_keystroke(app) {
        log::debug!("transforms: Ctrl+C copy keystroke failed: {e}");
    }

    let captured = wait_for_clipboard_change(app, &original, clipboard_updates);

    // No fresh selection landed in the clipboard — restore whatever was there and
    // report empty (mirrors clipboardCaptureFailed → restoreClipboard → EMPTY).
    if captured == original || captured.trim().is_empty() {
        crate::clipboard_snapshot::restore(app, &snapshot);
        return TransformCapture::empty();
    }

    // Restore the user's original clipboard immediately. The paste-back
    // (crate::clipboard::paste) runs its OWN clipboard sandwich, so the captured
    // selection never has to live on the clipboard past this point — the user's
    // clipboard is left exactly as it was before the transform.
    crate::clipboard_snapshot::restore(app, &snapshot);
    TransformCapture {
        scope: TransformCaptureScope::Selection,
        source: TransformSource::Clipboard,
        text: captured,
    }
}

/// Send a synthetic Ctrl+C (Cmd+C on macOS) through the managed Enigo instance so
/// the focused app copies its current selection. Uses platform virtual key codes
/// (layout-independent) to mirror the native `winstt-paste.exe --copy` helper.
///
/// The Enigo keystroke is dispatched on the MAIN thread (input synthesis must not run on the
/// async-runtime / spawn_blocking worker — the same main-thread paste discipline actions.rs
/// keeps). `capture_via_clipboard` runs on a `spawn_blocking` thread, so it can block on the
/// keystroke completing here; we round-trip a oneshot channel and wait for the result.
fn send_copy_keystroke(app: &AppHandle) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app_for_main = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(send_copy_keystroke_on_main(&app_for_main));
    })
    .map_err(|e| format!("failed to schedule copy keystroke on main thread: {e}"))?;
    // Bounded wait so a stalled main thread can't wedge the transform pipeline forever.
    match rx.recv_timeout(Duration::from_secs(2)) {
        Ok(result) => result,
        Err(_) => Err("copy keystroke timed out on main thread".to_string()),
    }
}

/// The actual Enigo Ctrl+C synthesis — MUST run on the main thread (called only via
/// `send_copy_keystroke`'s `run_on_main_thread`).
fn send_copy_keystroke_on_main(app: &AppHandle) -> Result<(), String> {
    use enigo::{Direction, Key, Keyboard};

    let enigo_state = app
        .try_state::<crate::input::EnigoState>()
        .ok_or("Enigo state not initialized")?;
    let mut enigo = enigo_state.0.lock();

    #[cfg(target_os = "macos")]
    let (modifier_key, c_key) = (Key::Meta, Key::Other(8)); // Cmd + C
    #[cfg(target_os = "windows")]
    let (modifier_key, c_key) = (Key::Control, Key::Other(0x43)); // VK_C
    #[cfg(target_os = "linux")]
    let (modifier_key, c_key) = (Key::Control, Key::Unicode('c'));

    let mut modifier = CopyModifierGuard::press(&mut enigo, modifier_key)?;
    modifier
        .keyboard()
        .key(c_key, Direction::Click)
        .map_err(|e| format!("Failed to click C key: {e}"))?;
    std::thread::sleep(Duration::from_millis(COPY_MODIFIER_HOLD_MS));
    modifier.release()?;
    Ok(())
}

/// Owns a synthesized modifier press. Any early return or unwind after the key
/// goes down still attempts a release, preventing a failed Ctrl+C from leaving
/// Ctrl/Cmd logically held in the foreground application.
struct CopyModifierGuard<'a> {
    enigo: &'a mut enigo::Enigo,
    key: enigo::Key,
    armed: bool,
}

impl<'a> CopyModifierGuard<'a> {
    fn press(enigo: &'a mut enigo::Enigo, key: enigo::Key) -> Result<Self, String> {
        use enigo::{Direction, Keyboard};

        enigo
            .key(key, Direction::Press)
            .map_err(|e| format!("Failed to press modifier key: {e}"))?;
        Ok(Self {
            enigo,
            key,
            armed: true,
        })
    }

    fn keyboard(&mut self) -> &mut enigo::Enigo {
        self.enigo
    }

    fn release(mut self) -> Result<(), String> {
        use enigo::{Direction, Keyboard};

        let result = self
            .enigo
            .key(self.key, Direction::Release)
            .map_err(|e| format!("Failed to release modifier key: {e}"));
        if result.is_ok() {
            self.armed = false;
        }
        result
    }
}

impl Drop for CopyModifierGuard<'_> {
    fn drop(&mut self) {
        use enigo::{Direction, Keyboard};

        if self.armed
            && let Err(error) = self.enigo.key(self.key, Direction::Release)
        {
            log::warn!("transforms: best-effort modifier release failed: {error}");
        }
    }
}

#[cfg(target_os = "windows")]
static CLIPBOARD_UPDATE_SIGNAL: LazyLock<(Mutex<u64>, Condvar)> =
    LazyLock::new(|| (Mutex::new(0), Condvar::new()));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClipboardListenerStatus {
    Starting,
    Ready,
    Failed,
}

#[cfg(target_os = "windows")]
struct ClipboardListenerReadiness {
    status: Mutex<ClipboardListenerStatus>,
    changed: Condvar,
}

#[cfg(target_os = "windows")]
impl ClipboardListenerReadiness {
    fn new() -> Self {
        Self {
            status: Mutex::new(ClipboardListenerStatus::Starting),
            changed: Condvar::new(),
        }
    }

    fn publish(&self, status: ClipboardListenerStatus) {
        *self.status.lock().unwrap_or_else(PoisonError::into_inner) = status;
        self.changed.notify_all();
    }

    fn wait_for_ready(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut status = self.status.lock().unwrap_or_else(PoisonError::into_inner);
        while *status == ClipboardListenerStatus::Starting {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (next, wait) = self
                .changed
                .wait_timeout(status, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            status = next;
            if wait.timed_out() && *status == ClipboardListenerStatus::Starting {
                return false;
            }
        }
        *status == ClipboardListenerStatus::Ready
    }

    fn is_starting(&self) -> bool {
        *self.status.lock().unwrap_or_else(PoisonError::into_inner)
            == ClipboardListenerStatus::Starting
    }
}

/// Mutable, latched readiness for the process-wide clipboard listener. A caller
/// may time out and use polling for that capture without freezing readiness at
/// false: a late successful arm is published here for every subsequent capture.
#[cfg(target_os = "windows")]
static CLIPBOARD_UPDATE_LISTENER_READINESS: LazyLock<ClipboardListenerReadiness> =
    LazyLock::new(ClipboardListenerReadiness::new);
#[cfg(target_os = "windows")]
static CLIPBOARD_UPDATE_LISTENER_START: Once = Once::new();

#[cfg(target_os = "windows")]
#[derive(Clone, Copy)]
struct ClipboardUpdateWait {
    generation: u64,
}

#[cfg(not(target_os = "windows"))]
type ClipboardUpdateWait = ();

#[cfg(target_os = "windows")]
fn arm_clipboard_update_wait() -> Option<ClipboardUpdateWait> {
    CLIPBOARD_UPDATE_LISTENER_START.call_once(|| {
        if let Err(error) = std::thread::Builder::new()
            .name("winstt-clipboard-listener".to_string())
            .spawn(run_clipboard_update_listener)
        {
            log::warn!("transforms: failed to spawn clipboard listener: {error}");
            CLIPBOARD_UPDATE_LISTENER_READINESS.publish(ClipboardListenerStatus::Failed);
        }
    });
    if !CLIPBOARD_UPDATE_LISTENER_READINESS.wait_for_ready(CLIPBOARD_LISTENER_READY_TIMEOUT) {
        if CLIPBOARD_UPDATE_LISTENER_READINESS.is_starting() {
            log::warn!("transforms: clipboard listener readiness timed out; using fallback");
        }
        return None;
    }
    let generation = *CLIPBOARD_UPDATE_SIGNAL
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    Some(ClipboardUpdateWait { generation })
}

#[cfg(not(target_os = "windows"))]
fn arm_clipboard_update_wait() -> Option<ClipboardUpdateWait> {
    None
}

/// Wait for Windows' WM_CLIPBOARDUPDATE callback, then read and validate the
/// new text. A bounded polling fallback is retained for non-Windows platforms
/// and the rare case where installing the Windows listener fails.
fn wait_for_clipboard_change(
    app: &AppHandle,
    original: &str,
    updates: Option<ClipboardUpdateWait>,
) -> String {
    #[cfg(target_os = "windows")]
    if let Some(updates) = updates {
        return wait_for_windows_clipboard_update(app, original, updates);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = updates;

    let deadline = Instant::now() + Duration::from_millis(CLIPBOARD_UPDATE_TIMEOUT_MS);
    while Instant::now() < deadline {
        let current = read_clipboard(app).unwrap_or_default();
        // Fresh = changed AND non-empty (mirrors isFreshClipboard).
        if current != original && !current.is_empty() {
            return current;
        }
        std::thread::sleep(Duration::from_millis(CLIPBOARD_FALLBACK_POLL_INTERVAL_MS));
    }
    read_clipboard(app).unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn wait_for_windows_clipboard_update(
    app: &AppHandle,
    original: &str,
    updates: ClipboardUpdateWait,
) -> String {
    let deadline = Instant::now() + Duration::from_millis(CLIPBOARD_UPDATE_TIMEOUT_MS);
    let (generation_lock, changed) = &*CLIPBOARD_UPDATE_SIGNAL;
    let mut generation = generation_lock
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let mut observed = updates.generation;

    loop {
        while *generation == observed {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return read_clipboard(app).unwrap_or_default();
            }
            let (next, wait) = changed
                .wait_timeout(generation, remaining)
                .unwrap_or_else(PoisonError::into_inner);
            generation = next;
            if wait.timed_out() && *generation == observed {
                return read_clipboard(app).unwrap_or_default();
            }
        }

        observed = *generation;
        drop(generation);
        let current = read_clipboard(app).unwrap_or_default();
        if current != original && !current.is_empty() {
            return current;
        }
        generation = generation_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
    }
}

/// Own the Windows clipboard-format listener on a dedicated message thread.
/// The window is process-long-lived; each capture independently subscribes by
/// snapshotting [`CLIPBOARD_UPDATE_SIGNAL`]'s generation before sending Ctrl+C.
#[cfg(target_os = "windows")]
fn run_clipboard_update_listener() {
    use windows::Win32::System::DataExchange::{
        AddClipboardFormatListener, RemoveClipboardFormatListener,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetMessageW, HWND_MESSAGE, MSG, WINDOW_EX_STYLE,
        WINDOW_STYLE, WM_CLIPBOARDUPDATE,
    };
    use windows::core::w;

    // SAFETY: The message-only HWND uses Windows' predefined STATIC class and
    // is created, listened on, and destroyed by this thread only.
    unsafe {
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        ) {
            Ok(hwnd) => hwnd,
            Err(error) => {
                log::warn!("transforms: CreateWindowExW for clipboard listener failed: {error}");
                CLIPBOARD_UPDATE_LISTENER_READINESS.publish(ClipboardListenerStatus::Failed);
                return;
            }
        };

        if let Err(error) = AddClipboardFormatListener(hwnd) {
            log::warn!("transforms: AddClipboardFormatListener failed: {error}");
            let _ = DestroyWindow(hwnd);
            CLIPBOARD_UPDATE_LISTENER_READINESS.publish(ClipboardListenerStatus::Failed);
            return;
        }
        CLIPBOARD_UPDATE_LISTENER_READINESS.publish(ClipboardListenerStatus::Ready);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, Some(hwnd), WM_CLIPBOARDUPDATE, WM_CLIPBOARDUPDATE).0 > 0 {
            let (generation, changed) = &*CLIPBOARD_UPDATE_SIGNAL;
            let mut generation = generation.lock().unwrap_or_else(PoisonError::into_inner);
            *generation = generation.wrapping_add(1);
            changed.notify_all();
        }
        let _ = RemoveClipboardFormatListener(hwnd);
        let _ = DestroyWindow(hwnd);
        CLIPBOARD_UPDATE_LISTENER_READINESS.publish(ClipboardListenerStatus::Failed);
    }
}

fn read_clipboard(app: &AppHandle) -> Option<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().ok()
}

fn replace_unique_occurrence(haystack: &str, needle: &str, replacement: &str) -> Option<String> {
    if needle.is_empty() {
        return None;
    }
    let mut matches = haystack.match_indices(needle);
    let (start, _) = matches.next()?;
    if matches.next().is_some() {
        return None;
    }

    let mut out = String::with_capacity(haystack.len() - needle.len() + replacement.len());
    out.push_str(&haystack[..start]);
    out.push_str(replacement);
    out.push_str(&haystack[start + needle.len()..]);
    Some(out)
}

fn field_replacement_for_lost_selection(
    focused_text: &str,
    captured_text: &str,
    transformed: &str,
) -> Option<String> {
    if focused_text.trim().is_empty() || captured_text.trim().is_empty() {
        return None;
    }
    if focused_text == captured_text {
        return Some(transformed.to_string());
    }
    replace_unique_occurrence(focused_text, captured_text, transformed)
}

pub(super) fn plan_transform_paste(
    capture: &TransformCapture,
    transformed: &str,
    current: Option<&WindowContextSnapshot>,
) -> TransformPastePlan {
    if capture.scope == TransformCaptureScope::FocusedField {
        return TransformPastePlan::ReplaceFocusedField(transformed.to_string());
    }

    let Some(snapshot) = current else {
        return TransformPastePlan::ReplaceSelection(transformed.to_string());
    };
    let selected = snapshot.selected_text.as_deref().unwrap_or("");
    if selected == capture.text {
        return TransformPastePlan::ReplaceSelection(transformed.to_string());
    }
    if let Some(field_text) =
        field_replacement_for_lost_selection(&snapshot.focused_text, &capture.text, transformed)
    {
        return TransformPastePlan::ReplaceFocusedField(field_text);
    }
    TransformPastePlan::ReplaceSelection(transformed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transform_capture(scope: TransformCaptureScope, text: &str) -> TransformCapture {
        TransformCapture {
            scope,
            source: TransformSource::Uia,
            text: text.to_string(),
        }
    }

    fn paste_snapshot(focused_text: &str, selected_text: Option<&str>) -> WindowContextSnapshot {
        WindowContextSnapshot {
            focused_text: focused_text.to_string(),
            selected_text: selected_text.map(str::to_string),
            ..Default::default()
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn listener_readiness_can_latch_success_after_a_timeout() {
        let readiness = ClipboardListenerReadiness::new();

        assert!(!readiness.wait_for_ready(Duration::ZERO));
        assert!(readiness.is_starting());

        readiness.publish(ClipboardListenerStatus::Ready);
        assert!(readiness.wait_for_ready(Duration::ZERO));
    }

    #[test]
    fn focused_field_capture_replaces_whole_field() {
        let capture = transform_capture(TransformCaptureScope::FocusedField, "old field");
        assert_eq!(
            plan_transform_paste(&capture, "new field", None),
            TransformPastePlan::ReplaceFocusedField("new field".into())
        );
    }

    #[test]
    fn active_original_selection_keeps_normal_replace_paste() {
        let capture = transform_capture(TransformCaptureScope::Selection, "selected text");
        let snapshot = paste_snapshot("before selected text after", Some("selected text"));
        assert_eq!(
            plan_transform_paste(&capture, "replacement", Some(&snapshot)),
            TransformPastePlan::ReplaceSelection("replacement".into())
        );
    }

    #[test]
    fn lost_selection_reconstructs_focused_field_when_source_is_unique() {
        let capture = transform_capture(TransformCaptureScope::Selection, "selected text");
        let snapshot = paste_snapshot("before selected text after", None);
        assert_eq!(
            plan_transform_paste(&capture, "replacement", Some(&snapshot)),
            TransformPastePlan::ReplaceFocusedField("before replacement after".into())
        );
    }

    #[test]
    fn lost_selection_replaces_whole_field_when_field_equals_source() {
        let capture = transform_capture(TransformCaptureScope::Selection, "selected text");
        let snapshot = paste_snapshot("selected text", None);
        assert_eq!(
            plan_transform_paste(&capture, "replacement", Some(&snapshot)),
            TransformPastePlan::ReplaceFocusedField("replacement".into())
        );
    }

    #[test]
    fn lost_selection_does_not_guess_when_source_repeats() {
        let capture = transform_capture(TransformCaptureScope::Selection, "same");
        let snapshot = paste_snapshot("same and same", None);
        assert_eq!(
            plan_transform_paste(&capture, "replacement", Some(&snapshot)),
            TransformPastePlan::ReplaceSelection("replacement".into())
        );
    }
}
