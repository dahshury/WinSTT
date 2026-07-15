// HWND pinning for stale-context rejection (research report R5b).
//
// The dictation pipeline captures context (for the LLM post-process step) only
// AFTER the decode finishes — by which point the user may have alt-tabbed away
// from the window they were dictating into. Without pinning, `capture_fragment`
// would read whatever is focused NOW, feeding the LLM context from the wrong
// window (the documented Superwhisper window-switch failure).
//
// The fix, mirroring Superwhisper's timing discipline: capture the foreground
// HWND + process id ONCE at recording start (all modes — PTT / toggle / wake-word
// — share `TranscribeAction::start`, so pinning there covers every mode), then
// pass that pinned HWND to the sidecar at capture time. If the pinned window is
// gone (IsWindow fails) or its HWND was recycled to a different process by
// capture time, we refuse context rather than capturing the wrong window.
//
// One slot is enough: dictation is serialized by the coordinator, so at most one
// session is capturing context at a time. Each `TranscribeAction::start` (every
// utterance, including a toggle session's 2nd..N utterances) re-pins to the
// window that utterance was dictated into.

use std::sync::Mutex;

use crate::foreground_window::ForegroundWindow as PinnedForeground;
use once_cell::sync::Lazy;

/// The foreground window pinned at recording start. `None` before the first
/// dictation, or after an explicit clear. HWND is stored as its raw pointer value
/// (`isize`) plus the owning process id so a recycled HWND (same numeric handle,
/// different process) is rejected at validation time.
static PINNED: Lazy<Mutex<Option<PinnedForeground>>> = Lazy::new(|| Mutex::new(None));

/// Pin the current foreground window as the dictation target. Call at recording
/// start (`TranscribeAction::start`), BEFORE any overlay work can steal focus, so
/// the pinned HWND is the user's app — not our overlay. On non-Windows there is no
/// UIA sidecar, so this stores `None` and context capture stays foreground-less.
pub(super) fn pin() -> Option<u64> {
    let pinned = PinnedForeground::current();
    match pinned {
        Some(fg) => log::debug!(
            "context: pinned foreground hwnd={:#x} pid={} at recording start",
            fg.hwnd_raw,
            fg.process_id
        ),
        None => log::debug!("context: no foreground window to pin at recording start"),
    }
    *PINNED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = pinned;
    pinned.map(|foreground| foreground.hwnd_raw as u64)
}

/// Drop the pin (start failure / cancellation). A stale pin is harmless — it is
/// re-validated at read time and superseded by the next `pin()` — but clearing on
/// a failed start keeps the slot honest.
pub(super) fn clear() {
    *PINNED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

/// Resolve the pinned HWND for a context capture, re-validating it against the
/// live window state. Returns:
/// - `Some(hwnd)` — the pinned window still exists and still belongs to the same
///   process; the sidecar should scope its capture to this HWND (`--hwnd`).
/// - `None` — no window was pinned, OR the pinned window is gone / its HWND was
///   recycled to a different process. The caller MUST skip context capture rather
///   than fall back to the current foreground (that is the stale-window bug).
///
/// The `Option<u64>` return matches the sidecar-scope argument threaded through
/// `ContextManager` (`0`/`None` means "no scope"); here `None` is a hard skip, so
/// the caller distinguishes "no pin" from "capture foreground" itself.
pub(super) fn validated_hwnd() -> Option<u64> {
    let pinned = (*PINNED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner))?;
    if pinned.is_valid() {
        Some(pinned.hwnd_raw as u64)
    } else {
        log::debug!(
            "context: pinned foreground hwnd={:#x} pid={} is no longer valid; skipping context capture",
            pinned.hwnd_raw,
            pinned.process_id
        );
        None
    }
}

/// Restore the recording-start target after a mouse click activates the overlay.
/// The Alt+S path leaves focus alone; this is only needed for the clickable pill
/// action so the eventual raw-text paste still lands in the dictation target.
pub(super) fn restore_focus() {
    #[cfg(target_os = "windows")]
    {
        let pinned = *PINNED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(foreground) = pinned.filter(|foreground| foreground.is_valid()) {
            crate::winstt::commands::preview::restore_foreground(foreground);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The static slot is process-global; these tests mutate it, so keep them from
    // interleaving with each other.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn set_pin(pinned: Option<PinnedForeground>) {
        *PINNED
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = pinned;
    }

    #[test]
    fn no_pin_yields_none() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set_pin(None);
        assert_eq!(validated_hwnd(), None);
    }

    #[test]
    fn clear_drops_the_pin() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set_pin(Some(PinnedForeground {
            hwnd_raw: 0x1234,
            process_id: 42,
        }));
        clear();
        assert_eq!(validated_hwnd(), None);
    }

    // A dead / bogus HWND must never resolve to a scope — the caller would
    // otherwise capture the wrong window. On Windows an obviously-invalid handle
    // (`IsWindow` false) validates to false; on non-Windows `validate` is always
    // false, so both platforms exercise the "skip context" branch here.
    #[test]
    fn dead_hwnd_yields_none_context() {
        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set_pin(Some(PinnedForeground {
            // 0xFFFF_FFF0 is not a live window handle in this test process.
            hwnd_raw: 0xFFFF_FFF0u32 as isize,
            process_id: u32::MAX,
        }));
        assert_eq!(
            validated_hwnd(),
            None,
            "a dead / recycled HWND must yield no context scope"
        );
        set_pin(None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn live_hwnd_of_wrong_process_is_rejected() {
        // The desktop window is a real HWND owned by another process; pinning it
        // with our own (wrong) pid must fail the PID re-check even though
        // `IsWindow` passes.
        use windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow;

        let _guard = TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // SAFETY: GetDesktopWindow returns a valid, always-live HWND.
        let desktop = unsafe { GetDesktopWindow() };
        let raw = desktop.0 as isize;
        set_pin(Some(PinnedForeground {
            hwnd_raw: raw,
            // A process id that cannot own the desktop window.
            process_id: 0xDEAD_BEEF,
        }));
        assert_eq!(
            validated_hwnd(),
            None,
            "a live HWND whose PID no longer matches must be rejected"
        );
        set_pin(None);
    }
}
