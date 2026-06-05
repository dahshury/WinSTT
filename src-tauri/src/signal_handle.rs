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

/// Terminate the current Windows process with exit code 0 without running DLL detach.
///
/// This is intentionally only used for development-console shutdown paths where a normal
/// graceful WebView2 teardown emits noisy Chromium/Tao warnings even though shutdown
/// succeeded. Packaged app exits keep the graceful Tauri path.
#[cfg(windows)]
pub fn terminate_process_success() -> ! {
    use windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};

    unsafe {
        let _ = TerminateProcess(GetCurrentProcess(), 0);
    }
    std::process::exit(0);
}

/// Install a Windows console control handler so Ctrl+C / Ctrl+Break / console-close
/// terminate `tauri dev` with exit code 0 and without WebView2 teardown noise.
#[cfg(windows)]
pub fn setup_windows_ctrl_handler() {
    use windows::core::BOOL;
    use windows::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT, CTRL_LOGOFF_EVENT,
        CTRL_SHUTDOWN_EVENT,
    };

    unsafe extern "system" fn handler(ctrl_type: u32) -> BOOL {
        match ctrl_type {
            CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT
            | CTRL_SHUTDOWN_EVENT => terminate_process_success(),
            _ => BOOL(0),
        }
    }

    if let Err(e) = unsafe { SetConsoleCtrlHandler(Some(handler), true) } {
        warn!("Failed to install Windows console Ctrl handler: {e}");
    }
}
