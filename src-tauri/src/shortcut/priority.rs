use tauri::AppHandle;

#[cfg(windows)]
const PACKAGED_HOTKEY_OWNER_MUTEX: &str = "Local\\WinSTT.PackagedHotkeyOwner.v1";

#[cfg(all(windows, debug_assertions))]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(all(windows, debug_assertions))]
const DEV_PRIORITY_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

#[cfg(all(windows, debug_assertions))]
static DEV_PRIORITY_WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

#[cfg(all(windows, debug_assertions))]
static DEV_HOTKEYS_YIELDED: AtomicBool = AtomicBool::new(false);

#[cfg(all(windows, not(debug_assertions)))]
static PACKAGED_HOTKEY_OWNER: once_cell::sync::OnceCell<OwnedHandle> =
    once_cell::sync::OnceCell::new();

#[cfg(all(windows, not(debug_assertions)))]
struct OwnedHandle(usize);

#[cfg(all(windows, not(debug_assertions)))]
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};

        let handle = HANDLE(self.0 as *mut core::ffi::c_void);
        let _ = unsafe { CloseHandle(handle) };
    }
}

pub(crate) fn announce_packaged_hotkey_owner() {
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use windows::core::PCWSTR;
        use windows::Win32::System::Threading::CreateMutexW;

        let name = wide_owner_mutex_name();
        match unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) } {
            Ok(handle) => {
                let _ = PACKAGED_HOTKEY_OWNER.set(OwnedHandle(handle.0 as usize));
            }
            Err(err) => {
                eprintln!("failed to announce packaged WinSTT hotkey owner: {err}");
            }
        }
    }
}

pub(crate) fn ensure_dev_priority_watcher(app: &AppHandle) {
    #[cfg(all(windows, debug_assertions))]
    {
        if dev_hotkeys_forced() || DEV_PRIORITY_WATCHER_STARTED.swap(true, Ordering::SeqCst) {
            return;
        }

        let app = app.clone();
        let _ = std::thread::Builder::new()
            .name("winstt-dev-hotkey-priority".into())
            .spawn(move || loop {
                refresh_dev_hotkey_priority(&app);
                std::thread::sleep(DEV_PRIORITY_POLL_INTERVAL);
            });
    }

    #[cfg(not(all(windows, debug_assertions)))]
    {
        let _ = app;
    }
}

pub(crate) fn refresh_dev_hotkey_priority(app: &AppHandle) -> bool {
    #[cfg(all(windows, debug_assertions))]
    {
        if dev_hotkeys_forced() {
            DEV_HOTKEYS_YIELDED.store(false, Ordering::SeqCst);
            return false;
        }

        let should_yield = packaged_hotkey_owner_exists();
        let was_yielded = DEV_HOTKEYS_YIELDED.swap(should_yield, Ordering::SeqCst);
        match (was_yielded, should_yield) {
            (false, true) => {
                log::info!("Packaged WinSTT is running; dev build is yielding global hotkeys");
                super::disarm_all_shortcuts(app);
            }
            (true, false) => {
                log::info!(
                    "Packaged WinSTT hotkey owner exited; dev build is re-arming global hotkeys"
                );
                super::init_shortcuts(app);
                super::reconcile_winstt_hotkeys(app);
            }
            _ => {}
        }
        should_yield
    }

    #[cfg(not(all(windows, debug_assertions)))]
    {
        let _ = app;
        false
    }
}

pub(crate) fn dev_hotkey_dispatch_is_suppressed() -> bool {
    #[cfg(all(windows, debug_assertions))]
    {
        !dev_hotkeys_forced()
            && (DEV_HOTKEYS_YIELDED.load(Ordering::SeqCst) || packaged_hotkey_owner_exists())
    }

    #[cfg(not(all(windows, debug_assertions)))]
    {
        false
    }
}

#[cfg(all(windows, debug_assertions))]
fn dev_hotkeys_forced() -> bool {
    std::env::var("WINSTT_DEV_HOTKEYS").is_ok_and(|value| {
        !matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        )
    })
}

#[cfg(all(windows, debug_assertions))]
fn packaged_hotkey_owner_exists() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};

    let name = wide_owner_mutex_name();
    match unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, PCWSTR(name.as_ptr())) } {
        Ok(handle) => {
            let _ = unsafe { CloseHandle(handle) };
            true
        }
        Err(_) => false,
    }
}

#[cfg(windows)]
fn wide_owner_mutex_name() -> Vec<u16> {
    PACKAGED_HOTKEY_OWNER_MUTEX
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}
