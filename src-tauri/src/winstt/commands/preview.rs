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

/// Foreground (paste-target) window captured at preview open, stashed for
/// `confirm_paste` to restore. `HWND` isn't `Send`, so we keep the raw pointer
/// value (`isize`) and reconstruct the handle on the input thread.
#[derive(Default)]
pub struct PreviewState {
    foreground: Mutex<Option<isize>>,
}

impl PreviewState {
    fn set(&self, hwnd_raw: isize) {
        *self.foreground.lock().unwrap_or_else(|e| e.into_inner()) = Some(hwnd_raw);
    }

    fn take(&self) -> Option<isize> {
        self.foreground
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
    }

    /// Drop any captured target without consuming it for a paste (cancel path /
    /// a superseding recording).
    pub fn clear(&self) {
        *self.foreground.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Capture the current foreground window as the paste target. Call at preview
/// open, BEFORE the overlay takes focus, while the user's app still owns the
/// foreground. No-op off Windows.
pub fn capture_foreground(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let raw = unsafe { GetForegroundWindow() }.0 as isize;
        if raw != 0 {
            if let Some(state) = app.try_state::<PreviewState>() {
                state.set(raw);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

/// Restore foreground to the captured target HWND on the input thread. Uses the
/// `AttachThreadInput` dance so focus moves reliably even if the overlay no
/// longer owns the foreground.
#[cfg(target_os = "windows")]
fn restore_foreground(hwnd_raw: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, SetForegroundWindow};

    let target = HWND(hwnd_raw as *mut core::ffi::c_void);
    unsafe {
        let our_thread = GetCurrentThreadId();
        let target_thread = GetWindowThreadProcessId(target, None);
        if target_thread != 0 && target_thread != our_thread {
            let _ = AttachThreadInput(our_thread, target_thread, true);
            let _ = SetForegroundWindow(target);
            let _ = AttachThreadInput(our_thread, target_thread, false);
        } else {
            let _ = SetForegroundWindow(target);
        }
    }
}

/// Send: restore the captured target window to the foreground, paste `text` into
/// it (honoring the configured paste method / trailing space / auto-submit), then
/// tear down the preview overlay. Mirrors the auto-paste epilogue in
/// `TranscribeAction::stop` that this feature deferred.
#[tauri::command]
#[specta::specta]
pub async fn confirm_paste(app: AppHandle, text: String) -> Result<(), String> {
    let target = app
        .try_state::<PreviewState>()
        .and_then(|state| state.take());
    let app_for_paste = app.clone();
    app.run_on_main_thread(move || {
        #[cfg(target_os = "windows")]
        if let Some(raw) = target {
            restore_foreground(raw);
            // Let the foreground switch settle before synthesizing Ctrl+V.
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
        #[cfg(not(target_os = "windows"))]
        let _ = target;
        if let Err(e) = crate::clipboard::paste(text, app_for_paste.clone()) {
            log::error!("[preview] confirm paste failed: {e}");
            let _ = app_for_paste.emit("paste-error", ());
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
