// Preview-before-pasting: confirm/cancel commands + paste-target capture.
//
// When `general.preview_before_pasting` is on, `TranscribeAction::stop` holds
// the finalized text back from the auto-paste and shows the editable preview
// pill (the overlay made interactive + grown — see `winstt::commands::overlay`).
// The renderer then drives Send → `confirm_paste` (restore the captured target
// window to the foreground, paste, tear down) or dismiss → `cancel_preview`
// (tear down, no paste).
//
// Focus model: the editable preview textarea takes keyboard focus, so the target
// app loses the foreground while the user edits. We capture the target HWND at
// preview-open (`capture_foreground`, called from `actions.rs` while the target
// still owns the foreground) and restore it here before pasting. Because our
// overlay owns the foreground at confirm time, `SetForegroundWindow` back to the
// target is permitted; the `AttachThreadInput` attach is belt-and-suspenders.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// Backend-owned preview paste session. The renderer may confirm edited text,
/// but the paste sink only runs while this captured pending session exists.
#[derive(Default)]
pub struct PreviewState {
    pending: Mutex<Option<PendingPreview>>,
}

#[derive(Clone, Copy)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct CapturedForeground {
    hwnd_raw: isize,
    process_id: u32,
}

struct PendingPreview {
    foreground: Option<CapturedForeground>,
    text: String,
}

impl PreviewState {
    fn set(&self, preview: PendingPreview) {
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(preview);
    }

    fn take(&self) -> Option<PendingPreview> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    /// Drop any captured target without consuming it for a paste (cancel path /
    /// a superseding recording).
    pub fn clear(&self) {
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[cfg(target_os = "windows")]
fn current_foreground() -> Option<CapturedForeground> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    // SAFETY: reads the current foreground HWND only; no ownership transfer.
    let hwnd = unsafe { GetForegroundWindow() };
    let raw = hwnd.0 as isize;
    if raw == 0 {
        return None;
    }
    let mut process_id = 0u32;
    // SAFETY: `hwnd` is the handle returned by GetForegroundWindow and
    // `process_id` is a valid out pointer for the duration of the call.
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
    }
    if process_id == 0 {
        return None;
    }
    Some(CapturedForeground {
        hwnd_raw: raw,
        process_id,
    })
}

#[cfg(not(target_os = "windows"))]
fn current_foreground() -> Option<CapturedForeground> {
    None
}

/// Capture the current foreground window as the paste target and store the
/// finalized transcript that may later be pasted. Call at preview open, BEFORE
/// the overlay takes focus, while the user's app still owns the foreground.
pub fn capture_foreground(app: &AppHandle, text: &str) {
    let foreground = current_foreground();
    if let Some(state) = app.try_state::<PreviewState>() {
        state.set(PendingPreview {
            foreground,
            text: text.to_string(),
        });
    }
}

#[cfg(test)]
pub(crate) fn pending_preview_text_for_test(state: &PreviewState) -> Option<String> {
    state
        .pending
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|preview| preview.text.clone())
}

#[cfg(test)]
pub(crate) fn take_pending_preview_text_for_test(state: &PreviewState) -> Option<String> {
    state.take().map(|preview| preview.text)
}

#[cfg(test)]
pub(crate) fn set_pending_preview_for_test(state: &PreviewState, text: &str) {
    state.set(PendingPreview {
        foreground: None,
        text: text.to_string(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_state_consumes_pending_session() {
        let state = PreviewState::default();
        set_pending_preview_for_test(&state, "backend transcript");
        assert_eq!(
            pending_preview_text_for_test(&state).as_deref(),
            Some("backend transcript")
        );
        assert_eq!(
            take_pending_preview_text_for_test(&state).as_deref(),
            Some("backend transcript")
        );
        assert!(pending_preview_text_for_test(&state).is_none());
    }
}

/// Restore foreground to the captured target HWND on the input thread. Uses the
/// `AttachThreadInput` dance so focus moves reliably even if the overlay no
/// longer owns the foreground.
#[cfg(target_os = "windows")]
fn restore_foreground(foreground: CapturedForeground) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
    };

    let target = HWND(foreground.hwnd_raw as *mut core::ffi::c_void);
    // SAFETY: validates the raw HWND before reuse, then only requests foreground
    // activation. The stored PID must still match to avoid focusing a recycled
    // HWND that now belongs to another process.
    unsafe {
        if !IsWindow(Some(target)).as_bool() {
            return;
        }
        let mut process_id = 0u32;
        let our_thread = GetCurrentThreadId();
        let target_thread = GetWindowThreadProcessId(target, Some(&mut process_id));
        if target_thread == 0 || process_id != foreground.process_id {
            return;
        }
        if target_thread != 0 && target_thread != our_thread {
            let _attach = ThreadInputAttach::new(our_thread, target_thread);
            let _ = SetForegroundWindow(target);
        } else {
            let _ = SetForegroundWindow(target);
        }
    }
}

#[cfg(target_os = "windows")]
struct ThreadInputAttach {
    from: u32,
    to: u32,
    attached: bool,
}

#[cfg(target_os = "windows")]
impl ThreadInputAttach {
    unsafe fn new(from: u32, to: u32) -> Self {
        use windows::Win32::System::Threading::AttachThreadInput;

        let attached = AttachThreadInput(from, to, true).as_bool();
        Self { from, to, attached }
    }
}

#[cfg(target_os = "windows")]
impl Drop for ThreadInputAttach {
    fn drop(&mut self) {
        if !self.attached {
            return;
        }
        // SAFETY: detaches the same thread pair successfully attached by `new`.
        unsafe {
            let _ = windows::Win32::System::Threading::AttachThreadInput(self.from, self.to, false);
        }
    }
}

/// Send: restore the captured target window to the foreground, paste the
/// user-confirmed preview text into it (honoring the configured paste method /
/// trailing space / auto-submit), then tear down the preview overlay. Mirrors
/// the auto-paste epilogue in `TranscribeAction::stop` that this feature
/// deferred.
#[tauri::command]
#[specta::specta]
pub async fn confirm_paste(app: AppHandle, text: String) -> Result<(), String> {
    let preview = match app
        .try_state::<PreviewState>()
        .and_then(|state| state.take())
    {
        Some(preview) => preview,
        None => {
            crate::winstt::commands::overlay::exit_preview_overlay(&app);
            crate::tray::change_tray_icon(&app, crate::tray::TrayIconState::Idle);
            return Err("no pending preview paste".to_string());
        }
    };
    if text != preview.text {
        log::debug!("[preview] confirming edited preview text");
    }
    let target = preview.foreground;
    let text_to_paste = text;
    let app_for_paste = app.clone();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "windows")]
        if let Some(foreground) = target {
            restore_foreground(foreground);
            // Let the foreground switch settle before synthesizing Ctrl+V.
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
        #[cfg(not(target_os = "windows"))]
        let _ = target;
        if !text_to_paste.is_empty() {
            if let Err(e) = crate::clipboard::paste(text_to_paste, app_for_paste.clone()) {
                log::error!("[preview] confirm paste failed: {e}");
                let _ = app_for_paste.emit("paste-error", ());
            }
        }
        // Tear down AFTER the paste so the geometry/focus changes can't race the
        // Ctrl+V into the just-restored target window.
        crate::winstt::commands::overlay::exit_preview_overlay(&app_for_paste);
        crate::tray::change_tray_icon(&app_for_paste, crate::tray::TrayIconState::Idle);
    })
    .map_err(|e| format!("failed to schedule confirm paste: {e}"))?;
    Ok(())
}

/// Dismiss the preview WITHOUT pasting (Esc / dismiss button, or a superseding
/// recording). Tears down the preview overlay and drops the captured target.
#[tauri::command]
#[specta::specta]
pub async fn cancel_preview(app: AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<PreviewState>() {
        state.clear();
    }
    crate::winstt::commands::overlay::exit_preview_overlay(&app);
    crate::tray::change_tray_icon(&app, crate::tray::TrayIconState::Idle);
    Ok(())
}
