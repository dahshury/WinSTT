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

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use tauri::{AppHandle, Manager};

use crate::foreground_window::ForegroundWindow as CapturedForeground;
use crate::winstt::sync_ext::MutexExt;

/// Backend-owned preview paste session. The renderer may confirm edited text,
/// but the paste sink only runs while this captured pending session exists.
#[derive(Default)]
pub struct PreviewState {
    pending: Mutex<Option<PendingPreview>>,
}

struct PendingPreview {
    foreground: Option<CapturedForeground>,
    text: String,
}

impl PreviewState {
    fn set(&self, preview: PendingPreview) {
        *self.pending.lock_recover() = Some(preview);
    }

    fn take(&self) -> Option<PendingPreview> {
        self.pending.lock_recover().take()
    }

    /// Drop any captured target without consuming it for a paste (cancel path /
    /// a superseding recording).
    pub fn clear(&self) {
        *self.pending.lock_recover() = None;
    }
}

/// Latching completion for a requested foreground switch. The Windows event
/// hook and the paste pipeline can race freely: once completed, later waiters
/// return immediately; otherwise they park on `Notify` without polling.
#[derive(Clone, Default)]
pub(crate) struct ForegroundRestoreCompletion {
    state: Arc<ForegroundRestoreState>,
}

#[derive(Default)]
struct ForegroundRestoreState {
    completed: AtomicBool,
    completed_notify: tokio::sync::Notify,
}

impl ForegroundRestoreCompletion {
    // `ready`/`complete` drive the Windows foreground-restore hook; off Windows the
    // only caller (`restore_foreground`) is cfg'd out, so allow them to be unused
    // there. (`complete` is still exercised by the cross-platform unit tests.)
    #[allow(dead_code)]
    fn ready() -> Self {
        let completion = Self::default();
        completion.complete();
        completion
    }

    #[allow(dead_code)]
    fn complete(&self) {
        if !self.state.completed.swap(true, Ordering::AcqRel) {
            // There is one consumer per restore. `notify_one` also stores a
            // permit when the callback wins the race with `wait`.
            self.state.completed_notify.notify_one();
        }
    }

    pub(crate) async fn wait(self) {
        loop {
            let completed = self.state.completed_notify.notified();
            if self.state.completed.load(Ordering::Acquire) {
                return;
            }
            completed.await;
        }
    }
}

/// Capture the current foreground window as the paste target and store the
/// finalized transcript that may later be pasted. Call at preview open, BEFORE
/// the overlay takes focus, while the user's app still owns the foreground.
pub fn capture_foreground(app: &AppHandle, text: &str) {
    let foreground = CapturedForeground::current();
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
        .lock_recover()
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

    #[tokio::test]
    async fn foreground_restore_completion_latches_an_early_callback() {
        let completion = ForegroundRestoreCompletion::default();
        completion.complete();
        completion.wait().await;
    }

    #[tokio::test]
    async fn foreground_restore_completion_wakes_a_parked_waiter() {
        let completion = ForegroundRestoreCompletion::default();
        let signal = completion.clone();
        let waiter = completion.wait();
        let callback = async move {
            tokio::task::yield_now().await;
            signal.complete();
        };
        let ((), ()) = tokio::join!(waiter, callback);
    }
}

/// Restore foreground to the captured target HWND on the input thread. Uses the
/// `AttachThreadInput` dance so focus moves reliably even if the overlay no
/// longer owns the foreground.
#[cfg(target_os = "windows")]
pub(crate) fn restore_foreground(foreground: CapturedForeground) -> ForegroundRestoreCompletion {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;

    let Some(target_thread) = foreground.thread_id_if_valid() else {
        return ForegroundRestoreCompletion::ready();
    };
    let target = HWND(foreground.hwnd_raw as *mut core::ffi::c_void);
    // Arm EVENT_SYSTEM_FOREGROUND before asking Windows to switch focus. The
    // watcher owns its hook thread and always tears the hook down, either when
    // this exact HWND arrives or at the short bounded fallback.
    let completion = foreground_event_watch::arm(foreground.hwnd_raw);
    // SAFETY: `thread_id_if_valid` verified the HWND and owning PID immediately
    // above; this block only requests foreground activation.
    unsafe {
        let our_thread = GetCurrentThreadId();
        if target_thread != our_thread {
            let _attach = ThreadInputAttach::new(our_thread, target_thread);
            let _ = SetForegroundWindow(target);
        } else {
            let _ = SetForegroundWindow(target);
        }
    }
    completion
}

/// Dedicated WinEvent-hook thread. Out-of-context WinEvent callbacks are
/// delivered on the installing thread, so it pumps a tiny message loop and
/// unhooks on that same thread. The callback only compares the HWND, latches the
/// completion, and asks its loop to exit.
#[cfg(target_os = "windows")]
mod foreground_event_watch {
    use super::ForegroundRestoreCompletion;
    use std::cell::RefCell;
    use std::sync::mpsc;
    use std::time::Duration;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent};
    use windows::Win32::UI::WindowsAndMessaging::{
        EVENT_SYSTEM_FOREGROUND, GetMessageW, KillTimer, MSG, PM_NOREMOVE, PeekMessageW,
        PostQuitMessage, SetTimer, WINEVENT_OUTOFCONTEXT, WM_TIMER,
    };

    const FOREGROUND_RESTORE_FALLBACK_MS: u32 = 60;
    const HOOK_ARM_TIMEOUT: Duration = Duration::from_millis(60);

    struct ActiveWatch {
        target_hwnd: isize,
        completion: ForegroundRestoreCompletion,
    }

    thread_local! {
        static ACTIVE_WATCH: RefCell<Option<ActiveWatch>> = const { RefCell::new(None) };
    }

    pub(super) fn arm(target_hwnd: isize) -> ForegroundRestoreCompletion {
        let completion = ForegroundRestoreCompletion::default();
        let watcher_completion = completion.clone();
        let (armed_tx, armed_rx) = mpsc::sync_channel(1);

        let spawned = std::thread::Builder::new()
            .name("foreground-restore-watch".to_string())
            .spawn(move || watch(target_hwnd, watcher_completion, armed_tx));
        if let Err(error) = spawned {
            log::warn!("foreground restore: failed to start event watcher: {error}");
            completion.complete();
            return completion;
        }

        match armed_rx.recv_timeout(HOOK_ARM_TIMEOUT) {
            Ok(true) => {}
            Ok(false) => {
                log::debug!("foreground restore: SetWinEventHook failed; using immediate fallback");
                completion.complete();
            }
            Err(error) => {
                log::warn!("foreground restore: event watcher did not arm in time: {error}");
                completion.complete();
            }
        }
        completion
    }

    fn watch(
        target_hwnd: isize,
        completion: ForegroundRestoreCompletion,
        armed: mpsc::SyncSender<bool>,
    ) {
        // SAFETY: this thread owns the message queue and WinEvent hook for their
        // entire lifetime. All cleanup happens below before the thread returns.
        unsafe {
            let mut message = MSG::default();
            // Force creation of this thread's message queue before advertising
            // the hook as armed.
            let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);

            ACTIVE_WATCH.with(|slot| {
                *slot.borrow_mut() = Some(ActiveWatch {
                    target_hwnd,
                    completion: completion.clone(),
                });
            });

            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(on_foreground_changed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if hook.is_invalid() {
                ACTIVE_WATCH.with(|slot| slot.borrow_mut().take());
                completion.complete();
                let _ = armed.send(false);
                return;
            }

            let timer = SetTimer(None, 0, FOREGROUND_RESTORE_FALLBACK_MS, None);
            if timer == 0 {
                // Without the timer, a denied foreground switch might never
                // produce an event and this message loop would wait forever.
                // Report the watcher as unavailable and tear it down now; the
                // paste path's completion is latched by either side.
                completion.complete();
                let _ = armed.send(false);
            } else {
                let _ = armed.send(true);
                loop {
                    let result = GetMessageW(&mut message, None, 0, 0);
                    if result.0 <= 0 || message.message == WM_TIMER {
                        // Timer expiry is the deliberately short bounded fallback
                        // for denied switches and targets already in foreground.
                        completion.complete();
                        break;
                    }
                }
            }

            if timer != 0 {
                let _ = KillTimer(None, timer);
            }
            let _ = UnhookWinEvent(hook);
            ACTIVE_WATCH.with(|slot| slot.borrow_mut().take());
        }
    }

    unsafe extern "system" fn on_foreground_changed(
        _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        _object_id: i32,
        _child_id: i32,
        _event_thread: u32,
        _event_time: u32,
    ) {
        if event != EVENT_SYSTEM_FOREGROUND {
            return;
        }
        ACTIVE_WATCH.with(|slot| {
            let watch = slot.borrow();
            if let Some(watch) = watch.as_ref()
                && hwnd.0 as isize == watch.target_hwnd
            {
                watch.completion.complete();
                // SAFETY: callback runs on the hook thread; this terminates that
                // thread's message loop so it can unhook immediately.
                unsafe { PostQuitMessage(0) };
            }
        });
    }

    #[test]
    fn fallback_stays_short_and_bounded() {
        const { assert!(FOREGROUND_RESTORE_FALLBACK_MS <= 100) };
        const { assert!(FOREGROUND_RESTORE_FALLBACK_MS > 0) };
    }

    #[test]
    fn hook_arm_wait_is_bounded() {
        assert!(HOOK_ARM_TIMEOUT <= Duration::from_millis(100));
    }

    #[test]
    fn foreground_event_matches_only_the_requested_hwnd() {
        fn matches(target: isize, event: u32, actual: isize) -> bool {
            event == EVENT_SYSTEM_FOREGROUND && actual == target
        }

        assert!(matches(42, EVENT_SYSTEM_FOREGROUND, 42));
        assert!(!matches(42, EVENT_SYSTEM_FOREGROUND, 41));
        assert!(!matches(42, EVENT_SYSTEM_FOREGROUND + 1, 42));
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

        // SAFETY: Caller supplies thread ids from Win32 foreground/current-thread queries; Drop
        // detaches the same pair when attachment succeeds.
        let attached = unsafe { AttachThreadInput(from, to, true) }.as_bool();
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
            let restored = restore_foreground(foreground);
            // The WinEvent hook completes on its own thread. Keep paste ordering
            // on Tauri's main thread, but wake on the actual foreground edge
            // (or its bounded fallback) instead of guessing a fixed delay.
            tauri::async_runtime::block_on(restored.wait());
        }
        #[cfg(not(target_os = "windows"))]
        let _ = target;
        if !text_to_paste.is_empty()
            && let Err(e) = crate::clipboard::paste(text_to_paste, app_for_paste.clone())
        {
            log::error!("[preview] confirm paste failed: {e}");
            crate::winstt::commands::events::emit_paste_error(&app_for_paste);
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
