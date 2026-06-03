use crate::TranscriptionCoordinator;
#[cfg(unix)]
use log::debug;
use log::warn;
use tauri::{AppHandle, Manager};

#[cfg(unix)]
use signal_hook::consts::{SIGUSR1, SIGUSR2};
#[cfg(unix)]
use signal_hook::iterator::Signals;
#[cfg(unix)]
use std::thread;

/// Send a transcription input to the coordinator.
/// Used by signal handlers, CLI flags, and any other external trigger.
pub fn send_transcription_input(app: &AppHandle, binding_id: &str, source: &str) {
    if let Some(c) = app.try_state::<TranscriptionCoordinator>() {
        c.send_input(binding_id, source, true, false);
    } else {
        warn!("TranscriptionCoordinator not initialized");
    }
}

#[cfg(unix)]
pub fn setup_signal_handler(app_handle: AppHandle, mut signals: Signals) {
    debug!("Signal handlers registered (SIGUSR1, SIGUSR2)");
    thread::spawn(move || {
        for sig in signals.forever() {
            let (binding_id, signal_name) = match sig {
                SIGUSR1 => ("transcribe_with_post_process", "SIGUSR1"),
                SIGUSR2 => ("transcribe", "SIGUSR2"),
                _ => continue,
            };
            debug!("Received {signal_name}");
            send_transcription_input(&app_handle, binding_id, signal_name);
        }
    });
}

/// Install a Windows console control handler so Ctrl+C / Ctrl+Break / console-close
/// terminate `tauri dev` CLEANLY — exit code 0, no teardown noise.
///
/// Under `tauri dev` the process owns a console. The default control handler hard-kills it
/// with `STATUS_CONTROL_C_EXIT` (0xc000013a), which makes cargo report "process didn't exit
/// successfully". The obvious-looking fix — route Ctrl+C through a *graceful* `app.exit(0)`
/// — actually makes things worse in a console: tearing down WebView2 (a) logs the benign
/// "Failed to unregister class Chrome_WidgetWin_0. Error = 1411" warning during Chromium's
/// DLL detach, and (b) leaves a multi-hundred-ms window in which a SECOND impatient Ctrl+C
/// (the classic `^C^C`) races `ExitProcess` and gets stamped 0xc000013a anyway.
///
/// So a dev-console interrupt does the only thing that is instant, deterministic AND
/// noise-free: `TerminateProcess(self, 0)`. Exit code is exactly 0 (cargo is happy), there
/// is no DLL detach (so no Chromium teardown log), and there is no race window for a second
/// Ctrl+C to land in. The normal QUIT path — closing the pill's X (lib.rs
/// `on_window_event`) — keeps the graceful `app.exit(0)` + store/history-DB flush; only the
/// dev-console interrupt is a hard kill, which is exactly SIGINT semantics. No-op in the
/// packaged exe (no attached console, so the handler never fires).
#[cfg(windows)]
pub fn setup_windows_ctrl_handler() {
    use windows::core::BOOL;
    use windows::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT, CTRL_LOGOFF_EVENT,
        CTRL_SHUTDOWN_EVENT,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};

    unsafe extern "system" fn handler(ctrl_type: u32) -> BOOL {
        match ctrl_type {
            CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT
            | CTRL_SHUTDOWN_EVENT => {
                // Instant, DLL-detach-free exit with code 0. Does not return; the
                // `BOOL(1)` below is unreachable but documents "handled".
                unsafe {
                    let _ = TerminateProcess(GetCurrentProcess(), 0);
                }
                BOOL(1) // handled — suppress the default abrupt termination
            }
            _ => BOOL(0),
        }
    }

    // SAFETY: registering a console control handler whose callback is a 'static fn.
    if let Err(e) = unsafe { SetConsoleCtrlHandler(Some(handler), true) } {
        warn!("Failed to install Windows console Ctrl handler: {e}");
    }
}
