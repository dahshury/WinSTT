use tauri::AppHandle;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

#[cfg(windows)]
const PACKAGED_HOTKEY_OWNER_MUTEX: &str = "Local\\WinSTT.PackagedHotkeyOwner.v1";

#[cfg(windows)]
const PACKAGED_HOTKEY_OWNER_READY_EVENT: &str = "Local\\WinSTT.PackagedHotkeyOwnerReady.v2";

#[cfg(all(windows, debug_assertions))]
use std::sync::atomic::{AtomicBool, Ordering};

/// Compatibility probe for packaged builds predating the ready event.
///
/// Cooperating builds wake the dev watcher immediately and then leave it
/// blocked on the owner mutex until process exit. The timeout is deliberately
/// bounded to one probe per second and is reached only while no cooperating
/// owner has signalled; it preserves hotkey handoff for already-shipped builds
/// that only publish the v1 mutex.
#[cfg(all(windows, debug_assertions))]
const DEV_LEGACY_PRIORITY_PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// Old packages cannot announce a late startup. Probe for them only during a
/// short compatibility window after the dev watcher starts. If one is found,
/// keep following that specific legacy marker until it disappears; otherwise
/// switch permanently to the event wait. An old package launched after this
/// window is intentionally outside the compatibility guarantee.
#[cfg(all(windows, debug_assertions))]
const DEV_LEGACY_DISCOVERY_WINDOW: std::time::Duration = std::time::Duration::from_secs(15);

#[cfg(all(windows, debug_assertions))]
static DEV_PRIORITY_WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

#[cfg(all(windows, debug_assertions))]
static DEV_HOTKEYS_YIELDED: AtomicBool = AtomicBool::new(false);

#[cfg(all(windows, not(debug_assertions)))]
static PACKAGED_HOTKEY_OWNER: once_cell::sync::OnceCell<KernelHandle> =
    once_cell::sync::OnceCell::new();

#[cfg(windows)]
struct KernelHandle(OwnedHandle);

#[cfg(windows)]
impl KernelHandle {
    fn from_owned_win32(handle: windows::Win32::Foundation::HANDLE) -> Self {
        // SAFETY: callers pass a fresh owned handle returned by a successful
        // Win32 create/open call; `OwnedHandle` becomes its sole closer.
        Self(unsafe { OwnedHandle::from_raw_handle(handle.0) })
    }

    fn raw(&self) -> windows::Win32::Foundation::HANDLE {
        windows::Win32::Foundation::HANDLE(self.0.as_raw_handle())
    }
}

pub(crate) fn announce_packaged_hotkey_owner() {
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use windows::Win32::Foundation::{WAIT_ABANDONED_0, WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
        use windows::core::PCWSTR;

        let name = wide_owner_mutex_name();
        // Acquire explicitly instead of relying on CreateMutexW's initial-owner
        // flag, which is ignored when the named mutex already exists. That
        // distinction matters during overlap with an old, unowned v1 marker.
        match unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) } {
            Ok(handle) => {
                let owner = KernelHandle::from_owned_win32(handle);
                let acquired = unsafe { WaitForSingleObject(owner.raw(), 0) };
                if acquired == WAIT_OBJECT_0 || acquired == WAIT_ABANDONED_0 {
                    if PACKAGED_HOTKEY_OWNER.set(owner).is_ok() {
                        signal_packaged_hotkey_owner_ready();
                    }
                } else if acquired != WAIT_TIMEOUT {
                    eprintln!("failed to acquire packaged WinSTT hotkey owner mutex: {acquired:?}");
                }
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
            .spawn(move || {
                let ready_event = match create_packaged_hotkey_owner_ready_event() {
                    Ok(handle) => Some(handle),
                    Err(err) => {
                        log::warn!(
                            "Could not create packaged hotkey-owner ready event; using legacy compatibility probe: {err}"
                        );
                        None
                    }
                };
                let legacy_discovery_deadline =
                    std::time::Instant::now() + DEV_LEGACY_DISCOVERY_WINDOW;
                loop {
                    let yielded = refresh_dev_hotkey_priority(&app);
                    let following_legacy_owner = if yielded {
                        match wait_for_packaged_hotkey_owner_exit() {
                            PackagedOwnerWait::Exited => {
                                // The mutex handle becomes signaled the instant
                                // its owner exits, so restore dev hotkeys without
                                // waiting for a compatibility probe.
                                refresh_dev_hotkey_priority(&app);
                                continue;
                            }
                            PackagedOwnerWait::LegacyUnownedMarker => true,
                            PackagedOwnerWait::Unavailable => false,
                        }
                    } else {
                        false
                    };

                    if let Some(ready_event) = ready_event.as_ref() {
                        let compatibility_timeout = following_legacy_owner
                            .then_some(DEV_LEGACY_PRIORITY_PROBE_INTERVAL)
                            .or_else(|| {
                                legacy_discovery_deadline
                                    .checked_duration_since(std::time::Instant::now())
                                    .map(|remaining| {
                                        remaining.min(DEV_LEGACY_PRIORITY_PROBE_INTERVAL)
                                    })
                            });
                        wait_for_packaged_hotkey_owner_ready(
                            ready_event,
                            compatibility_timeout,
                        );
                    } else {
                        std::thread::sleep(DEV_LEGACY_PRIORITY_PROBE_INTERVAL);
                    }
                }
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
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
    use windows::core::PCWSTR;

    let name = wide_owner_mutex_name();
    match unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, PCWSTR(name.as_ptr())) } {
        Ok(handle) => {
            let _ = unsafe { CloseHandle(handle) };
            true
        }
        Err(_) => false,
    }
}

#[cfg(all(windows, debug_assertions))]
enum PackagedOwnerWait {
    Exited,
    LegacyUnownedMarker,
    Unavailable,
}

#[cfg(all(windows, debug_assertions))]
fn wait_for_packaged_hotkey_owner_exit() -> PackagedOwnerWait {
    use windows::Win32::Foundation::{CloseHandle, WAIT_ABANDONED_0, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        INFINITE, MUTEX_MODIFY_STATE, OpenMutexW, ReleaseMutex, SYNCHRONIZATION_SYNCHRONIZE,
        WaitForSingleObject,
    };
    use windows::core::PCWSTR;

    let name = wide_owner_mutex_name();
    let Ok(handle) = (unsafe {
        OpenMutexW(
            SYNCHRONIZATION_SYNCHRONIZE | MUTEX_MODIFY_STATE,
            false,
            PCWSTR(name.as_ptr()),
        )
    }) else {
        return PackagedOwnerWait::Unavailable;
    };
    let result = unsafe { WaitForSingleObject(handle, INFINITE) };
    // Waiting acquires a mutex. Release it before closing in both the normal
    // and abandoned-owner cases. Only abandonment proves the packaged owner
    // actually exited; WAIT_OBJECT_0 is the legacy unowned-marker behavior.
    if result == WAIT_OBJECT_0 || result == WAIT_ABANDONED_0 {
        let _ = unsafe { ReleaseMutex(handle) };
    }
    let _ = unsafe { CloseHandle(handle) };
    if result == WAIT_ABANDONED_0 {
        PackagedOwnerWait::Exited
    } else if result == WAIT_OBJECT_0 {
        PackagedOwnerWait::LegacyUnownedMarker
    } else {
        log::warn!("Waiting for packaged hotkey-owner mutex failed: {result:?}");
        PackagedOwnerWait::Unavailable
    }
}

#[cfg(all(windows, debug_assertions))]
fn create_packaged_hotkey_owner_ready_event() -> windows::core::Result<KernelHandle> {
    use windows::Win32::System::Threading::CreateEventW;
    use windows::core::PCWSTR;

    let name = wide_owner_ready_event_name();
    // Auto-reset makes each startup notification consumable exactly once. The
    // dev process creates and retains this handle before its first owner probe,
    // closing the check-then-wait race with a concurrently starting package.
    let handle = unsafe { CreateEventW(None, false, false, PCWSTR(name.as_ptr()))? };
    Ok(KernelHandle::from_owned_win32(handle))
}

#[cfg(all(windows, debug_assertions))]
fn wait_for_packaged_hotkey_owner_ready(
    ready_event: &KernelHandle,
    compatibility_timeout: Option<std::time::Duration>,
) {
    use windows::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::{INFINITE, WaitForSingleObject};

    let timeout_ms = compatibility_timeout.map_or(INFINITE, |timeout| {
        u32::try_from(timeout.as_millis().max(1))
            .expect("legacy priority probe interval must fit in a Win32 timeout")
    });
    let result = unsafe { WaitForSingleObject(ready_event.raw(), timeout_ms) };
    if result != WAIT_OBJECT_0 && result != WAIT_TIMEOUT {
        log::warn!("Waiting for packaged hotkey-owner ready event failed: {result:?}");
    }
}

#[cfg(all(windows, not(debug_assertions)))]
fn signal_packaged_hotkey_owner_ready() {
    use windows::Win32::System::Threading::{CreateEventW, SetEvent};
    use windows::core::PCWSTR;

    let name = wide_owner_ready_event_name();
    match unsafe { CreateEventW(None, false, false, PCWSTR(name.as_ptr())) } {
        Ok(handle) => {
            let event = KernelHandle::from_owned_win32(handle);
            // SAFETY: `event` owns a valid event handle for the duration of
            // the call; Win32 permits signaling it from this process thread.
            if let Err(err) = unsafe { SetEvent(event.raw()) } {
                eprintln!("failed to signal packaged WinSTT hotkey owner readiness: {err}");
            }
        }
        Err(err) => {
            eprintln!("failed to open packaged WinSTT hotkey owner ready event: {err}");
        }
    }
}

#[cfg(windows)]
fn wide_owner_mutex_name() -> Vec<u16> {
    PACKAGED_HOTKEY_OWNER_MUTEX
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn wide_owner_ready_event_name() -> Vec<u16> {
    PACKAGED_HOTKEY_OWNER_READY_EVENT
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}
