// Selection capture (UIA + clipboard-sandwich fallback) and paste planning.
//
// Owns the capture/paste types and the public `capture_selection_text` entry used
// by the TTS read-aloud hotkey. Extracted verbatim from the transforms module root
// (mirrors selection-capture.ts captureSelection + the paste-plan helpers).

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::winstt::context::{ContextMode, ContextReader, WindowContextSnapshot};
use crate::winstt::managers::ContextManager;

use super::TransformSource;

// ── clipboard-sandwich tuning (mirrors selection-capture.ts constants) ─────────

/// How long we wait for the clipboard to update after the synthetic Ctrl+C.
const CLIPBOARD_POLL_TIMEOUT_MS: u64 = 700;
/// Polling interval — fast enough to feel instant, slow enough not to spin.
const CLIPBOARD_POLL_INTERVAL_MS: u64 = 25;

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
        if let Some(selected) = snap.selected_text.clone() {
            if !selected.trim().is_empty() {
                return TransformCapture {
                    scope: TransformCaptureScope::Selection,
                    source: TransformSource::Uia,
                    text: selected,
                };
            }
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
    //    current clipboard, simulate Ctrl+C, poll for the clipboard to change,
    //    then restore the original clipboard. UIA fails silently in Chromium-
    //    based renderers (Slack, Discord, VS Code) and most the reference apps unless
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
    let original = read_clipboard(app).unwrap_or_default();

    // Simulate Ctrl+C in the focused app. A failure here (no Enigo state) just
    // means the clipboard won't change and we fall through to "empty".
    if let Err(e) = send_copy_keystroke(app) {
        log::debug!("transforms: Ctrl+C copy keystroke failed: {e}");
    }

    let captured = wait_for_clipboard_change(app, &original);

    // No fresh selection landed in the clipboard — restore whatever was there and
    // report empty (mirrors clipboardCaptureFailed → restoreClipboard → EMPTY).
    if captured == original || captured.trim().is_empty() {
        restore_clipboard(app, &original);
        return TransformCapture::empty();
    }

    // Restore the user's original clipboard immediately. The paste-back
    // (crate::clipboard::paste) runs its OWN clipboard sandwich, so the captured
    // selection never has to live on the clipboard past this point — the user's
    // clipboard is left exactly as it was before the transform.
    restore_clipboard(app, &original);
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
    let mut enigo = enigo_state
        .0
        .lock()
        .map_err(|e| format!("Failed to lock Enigo: {e}"))?;

    #[cfg(target_os = "macos")]
    let (modifier_key, c_key) = (Key::Meta, Key::Other(8)); // Cmd + C
    #[cfg(target_os = "windows")]
    let (modifier_key, c_key) = (Key::Control, Key::Other(0x43)); // VK_C
    #[cfg(target_os = "linux")]
    let (modifier_key, c_key) = (Key::Control, Key::Unicode('c'));

    enigo
        .key(modifier_key, Direction::Press)
        .map_err(|e| format!("Failed to press modifier key: {e}"))?;
    enigo
        .key(c_key, Direction::Click)
        .map_err(|e| format!("Failed to click C key: {e}"))?;
    std::thread::sleep(Duration::from_millis(50));
    enigo
        .key(modifier_key, Direction::Release)
        .map_err(|e| format!("Failed to release modifier key: {e}"))?;
    Ok(())
}

/// Poll the clipboard until it changes from `original` or the timeout elapses.
/// Returns the new value (or the current clipboard if nothing changed). Mirrors
/// `waitForClipboardChange`.
fn wait_for_clipboard_change(app: &AppHandle, original: &str) -> String {
    let deadline = Instant::now() + Duration::from_millis(CLIPBOARD_POLL_TIMEOUT_MS);
    while Instant::now() < deadline {
        let current = read_clipboard(app).unwrap_or_default();
        // Fresh = changed AND non-empty (mirrors isFreshClipboard).
        if current != original && !current.is_empty() {
            return current;
        }
        std::thread::sleep(Duration::from_millis(CLIPBOARD_POLL_INTERVAL_MS));
    }
    read_clipboard(app).unwrap_or_default()
}

fn read_clipboard(app: &AppHandle) -> Option<String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().read_text().ok()
}

/// Write `original` back to the clipboard if it held something (mirrors
/// `restoreClipboard` — an empty original is left untouched).
fn restore_clipboard(app: &AppHandle, original: &str) {
    if original.is_empty() {
        return;
    }
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let _ = app.clipboard().write_text(original.to_string());
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
