#[cfg(target_os = "macos")]
use std::process::Command;

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, AtomicI8, Ordering};
#[cfg(target_os = "windows")]
use std::time::Duration;
#[cfg(target_os = "windows")]
use tauri::Manager;

#[cfg(target_os = "windows")]
const WINDOWS_LID_UNKNOWN: i8 = -1;
#[cfg(target_os = "windows")]
const WINDOWS_LID_OPEN: i8 = 0;
#[cfg(target_os = "windows")]
const WINDOWS_LID_CLOSED: i8 = 1;
#[cfg(target_os = "windows")]
const WINDOWS_LID_NOT_PRESENT: i8 = 2;

#[cfg(target_os = "windows")]
static WINDOWS_LID_STATE: AtomicI8 = AtomicI8::new(WINDOWS_LID_UNKNOWN);
#[cfg(target_os = "windows")]
static WINDOWS_LID_MONITOR_STARTED: AtomicBool = AtomicBool::new(false);

/// Checks if the MacBook is in clamshell mode (lid closed with external display)
///
/// This queries the macOS IORegistry for the AppleClamshellState key.
/// Returns true if the lid is closed, false if open.
#[cfg(target_os = "macos")]
pub fn is_clamshell() -> Result<bool, String> {
    let output = Command::new("ioreg")
        .args(["-r", "-k", "AppleClamshellState", "-d", "4"])
        .output()
        .map_err(|e| format!("Failed to execute ioreg: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "ioreg command failed with status: {}",
            output.status
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Look for "AppleClamshellState" = Yes in the output
    Ok(stdout.contains("\"AppleClamshellState\" = Yes"))
}

/// Checks if a Windows laptop lid is currently closed.
///
/// Windows reports lid transitions through `GUID_LIDSWITCH_STATE_CHANGE`; the
/// startup monitor below caches that state. Unknown/open/no-lid states are treated
/// as not clamshell so the primary microphone remains the safe fallback.
#[cfg(target_os = "windows")]
pub fn is_clamshell() -> Result<bool, String> {
    Ok(matches!(
        WINDOWS_LID_STATE.load(Ordering::SeqCst),
        WINDOWS_LID_CLOSED
    ))
}

/// Checks if the Mac is a laptop by detecting battery presence
///
/// This uses pmset to check for battery information.
/// Returns true if a battery is detected (laptop), false otherwise (desktop)
#[cfg(target_os = "macos")]
#[tauri::command]
#[specta::specta]
pub fn is_laptop() -> Result<bool, String> {
    let output = Command::new("pmset")
        .arg("-g")
        .arg("batt")
        .output()
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Check if InternalBattery is present (laptops have batteries, desktops typically don't)
    Ok(stdout.contains("InternalBattery"))
}

/// Checks if Windows reports a built-in lid switch.
#[cfg(target_os = "windows")]
#[tauri::command]
#[specta::specta]
pub fn is_laptop() -> Result<bool, String> {
    windows_has_lid()
}

/// Stub implementation for Linux and other unsupported platforms.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn is_clamshell() -> Result<bool, String> {
    Ok(false)
}

/// Stub implementation for Linux and other unsupported platforms.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
#[specta::specta]
pub fn is_laptop() -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(target_os = "windows"))]
pub fn install_lid_state_monitor(_app: &tauri::AppHandle) {}

#[cfg(target_os = "windows")]
pub fn install_lid_state_monitor(app: &tauri::AppHandle) {
    if WINDOWS_LID_MONITOR_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    match windows_has_lid() {
        Ok(true) => {}
        Ok(false) => {
            WINDOWS_LID_STATE.store(WINDOWS_LID_NOT_PRESENT, Ordering::SeqCst);
            log::debug!("[clamshell] Windows lid switch not present");
            return;
        }
        Err(err) => {
            log::warn!("[clamshell] failed to query Windows power capabilities: {err}");
            WINDOWS_LID_STATE.store(WINDOWS_LID_UNKNOWN, Ordering::SeqCst);
        }
    }

    if let Err(err) = std::thread::Builder::new()
        .name("winstt-lid-message-loop".into())
        .spawn(run_windows_lid_message_loop)
    {
        log::warn!("[clamshell] failed to start Windows lid message loop: {err}");
    }

    let app = app.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("winstt-lid-reconfigure".into())
        .spawn(move || watch_windows_lid_reconfigure(app))
    {
        log::warn!("[clamshell] failed to start Windows lid reconfigure loop: {err}");
    }
}

#[cfg(target_os = "windows")]
fn windows_has_lid() -> Result<bool, String> {
    use windows::Win32::System::Power::{GetPwrCapabilities, SYSTEM_POWER_CAPABILITIES};

    let mut caps = SYSTEM_POWER_CAPABILITIES::default();
    if unsafe { GetPwrCapabilities(&mut caps) } {
        Ok(caps.LidPresent)
    } else {
        Err(windows::core::Error::from_thread().to_string())
    }
}

#[cfg(target_os = "windows")]
fn watch_windows_lid_reconfigure(app: tauri::AppHandle) {
    let mut previous = WINDOWS_LID_STATE.load(Ordering::SeqCst);

    loop {
        std::thread::sleep(Duration::from_secs(5));

        let current = WINDOWS_LID_STATE.load(Ordering::SeqCst);
        if current == previous {
            continue;
        }
        previous = current;

        if !matches!(current, WINDOWS_LID_OPEN | WINDOWS_LID_CLOSED) {
            continue;
        }

        let settings = crate::winstt::commands::settings::read_settings_raw(&app);
        let legacy_settings = crate::settings::get_settings(&app);
        if settings.audio.clamshell_microphone.is_none()
            && legacy_settings.clamshell_microphone.is_none()
        {
            continue;
        }

        let Some(audio_manager) =
            app.try_state::<std::sync::Arc<crate::managers::audio::AudioRecordingManager>>()
        else {
            continue;
        };
        if let Err(err) = audio_manager.update_selected_device() {
            log::warn!("[clamshell] failed to apply Windows lid microphone change: {err}");
        }
    }
}

#[cfg(target_os = "windows")]
fn run_windows_lid_message_loop() {
    use windows::core::w;
    use windows::Win32::Foundation::{HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Power::RegisterPowerSettingNotification;
    use windows::Win32::System::SystemServices::GUID_LIDSWITCH_STATE_CHANGE;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, DEVICE_NOTIFY_WINDOW_HANDLE, HWND_MESSAGE, MSG, PBT_POWERSETTINGCHANGE,
        WINDOW_EX_STYLE, WINDOW_STYLE, WM_POWERBROADCAST, WNDCLASSW,
    };

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_POWERBROADCAST && wparam.0 as u32 == PBT_POWERSETTINGCHANGE {
            update_lid_state_from_power_broadcast(lparam);
            return LRESULT(1);
        }

        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    unsafe fn update_lid_state_from_power_broadcast(lparam: LPARAM) {
        use windows::Win32::System::Power::POWERBROADCAST_SETTING;
        use windows::Win32::System::SystemServices::GUID_LIDSWITCH_STATE_CHANGE;

        let setting = lparam.0 as *const POWERBROADCAST_SETTING;
        if setting.is_null() {
            return;
        }

        let setting = unsafe { &*setting };
        if setting.PowerSetting != GUID_LIDSWITCH_STATE_CHANGE || setting.DataLength == 0 {
            return;
        }

        match setting.Data[0] {
            0 => WINDOWS_LID_STATE.store(WINDOWS_LID_CLOSED, Ordering::SeqCst),
            1 => WINDOWS_LID_STATE.store(WINDOWS_LID_OPEN, Ordering::SeqCst),
            other => log::debug!("[clamshell] unknown Windows lid state payload: {other}"),
        }
    }

    unsafe {
        let class_name = w!("WinSTTLidMonitorWindow");
        let hmodule = match GetModuleHandleW(None) {
            Ok(hmodule) => hmodule,
            Err(err) => {
                log::warn!("[clamshell] GetModuleHandleW failed: {err}");
                return;
            }
        };
        let hinstance = HINSTANCE(hmodule.0);

        let window_class = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance,
            lpszClassName: class_name,
            ..Default::default()
        };
        if RegisterClassW(&window_class) == 0 {
            log::warn!(
                "[clamshell] RegisterClassW failed: {}",
                windows::core::Error::from_thread()
            );
            return;
        }

        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinstance),
            None,
        ) {
            Ok(hwnd) => hwnd,
            Err(err) => {
                log::warn!("[clamshell] CreateWindowExW failed: {err}");
                return;
            }
        };

        let _notification = match RegisterPowerSettingNotification(
            HANDLE(hwnd.0),
            &GUID_LIDSWITCH_STATE_CHANGE,
            DEVICE_NOTIFY_WINDOW_HANDLE,
        ) {
            Ok(notification) => notification,
            Err(err) => {
                log::warn!("[clamshell] RegisterPowerSettingNotification failed: {err}");
                return;
            }
        };

        log::debug!("[clamshell] Windows lid state monitor installed");

        let mut msg = MSG::default();
        loop {
            let result = GetMessageW(&mut msg, None, 0, 0);
            if result.0 <= 0 {
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    fn test_clamshell_check() {
        // This will run on macOS and should not panic
        let result = is_clamshell();
        assert!(result.is_ok());
        let _ = result.unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_is_laptop() {
        let result = is_laptop();
        assert!(result.is_ok());
        if let Ok(is_laptop) = result {
            println!("Is laptop: {}", is_laptop);
        }
    }
}
