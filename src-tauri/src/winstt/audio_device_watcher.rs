use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

static AUDIO_DEVICE_WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

pub fn install_audio_device_watcher(app: &AppHandle) {
    if AUDIO_DEVICE_WATCHER_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }

    if let Err(err) = platform_impl::spawn(app.clone()) {
        AUDIO_DEVICE_WATCHER_STARTED.store(false, Ordering::Release);
        log::warn!("[devices] failed to start native audio device watcher: {err}");
    }

    #[cfg(any(
        target_os = "linux",
        not(any(target_os = "windows", target_os = "macos", target_os = "linux"))
    ))]
    {
        let _ = app;
        log::info!("[devices] using renderer devicechange events for audio device updates");
    }
}

#[cfg(target_os = "windows")]
mod platform_impl {
    use std::{
        sync::mpsc::{self, Sender},
        thread,
        time::Duration,
    };

    use tauri::AppHandle;
    use windows::{
        core::{implement, Result as WinResult, PCWSTR},
        Win32::{
            Foundation::PROPERTYKEY,
            Media::Audio::{
                EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient,
                IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE,
            },
            System::Com::{CoCreateInstance, CLSCTX_ALL},
        },
    };

    const DEVICECHANGE_DEBOUNCE: Duration = Duration::from_millis(250);

    pub(super) fn spawn(app: AppHandle) -> std::io::Result<()> {
        thread::Builder::new()
            .name("winstt-audio-device-watcher".to_string())
            .spawn(move || run(app))
            .map(|_| ())
    }

    fn run(app: AppHandle) {
        let _com = crate::windows_com::ComApartment::init_multithreaded();
        let (tx, rx) = mpsc::channel();

        let (enumerator, client) = match register_endpoint_notifications(tx) {
            Ok(registered) => registered,
            Err(err) => {
                log::warn!("[devices] CoreAudio endpoint notifications unavailable: {err}");
                return;
            }
        };

        log::info!("[devices] CoreAudio endpoint notifications registered");
        while rx.recv().is_ok() {
            thread::sleep(DEVICECHANGE_DEBOUNCE);
            while rx.try_recv().is_ok() {}
            crate::winstt::commands::audio_devices::refresh_audio_devices_and_emit(&app);
        }

        // This is only reached during process teardown if the callback channel closes.
        // SAFETY: the callback was registered against this enumerator on this thread.
        let _ = unsafe { enumerator.UnregisterEndpointNotificationCallback(&client) };
    }

    fn register_endpoint_notifications(
        tx: Sender<()>,
    ) -> WinResult<(IMMDeviceEnumerator, IMMNotificationClient)> {
        // SAFETY: COM is initialized for the watcher thread before this helper is called.
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let client: IMMNotificationClient = AudioEndpointNotificationClient { tx }.into();
            enumerator.RegisterEndpointNotificationCallback(&client)?;
            Ok((enumerator, client))
        }
    }

    #[implement(IMMNotificationClient)]
    struct AudioEndpointNotificationClient {
        tx: Sender<()>,
    }

    impl AudioEndpointNotificationClient {
        fn notify(&self) -> WinResult<()> {
            let _ = self.tx.send(());
            Ok(())
        }
    }

    impl IMMNotificationClient_Impl for AudioEndpointNotificationClient_Impl {
        fn OnDeviceStateChanged(
            &self,
            _pwstrdeviceid: &PCWSTR,
            _dwnewstate: DEVICE_STATE,
        ) -> WinResult<()> {
            self.notify()
        }

        fn OnDeviceAdded(&self, _pwstrdeviceid: &PCWSTR) -> WinResult<()> {
            self.notify()
        }

        fn OnDeviceRemoved(&self, _pwstrdeviceid: &PCWSTR) -> WinResult<()> {
            self.notify()
        }

        fn OnDefaultDeviceChanged(
            &self,
            _flow: EDataFlow,
            _role: ERole,
            _pwstrdefaultdeviceid: &PCWSTR,
        ) -> WinResult<()> {
            self.notify()
        }

        fn OnPropertyValueChanged(
            &self,
            _pwstrdeviceid: &PCWSTR,
            _key: &PROPERTYKEY,
        ) -> WinResult<()> {
            self.notify()
        }
    }
}

#[cfg(target_os = "macos")]
mod platform_impl {
    use std::{
        ffi::c_void,
        ptr::NonNull,
        sync::mpsc::{self, Sender},
        thread,
        time::Duration,
    };

    use objc2_core_audio::{
        kAudioHardwareNoError, kAudioHardwarePropertyDefaultInputDevice,
        kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
        AudioObjectAddPropertyListener, AudioObjectID, AudioObjectPropertyAddress,
        AudioObjectRemovePropertyListener,
    };
    use tauri::AppHandle;

    const DEVICECHANGE_DEBOUNCE: Duration = Duration::from_millis(250);

    pub(super) fn spawn(app: AppHandle) -> std::io::Result<()> {
        thread::Builder::new()
            .name("winstt-audio-device-watcher".to_string())
            .spawn(move || run(app))
            .map(|_| ())
    }

    fn run(app: AppHandle) {
        let (tx, rx) = mpsc::channel();
        let _listeners = match CoreAudioDeviceListeners::register(tx) {
            Ok(listeners) => listeners,
            Err(status) => {
                log::warn!(
                    "[devices] CoreAudio hardware notifications unavailable: OSStatus {status}"
                );
                return;
            }
        };

        log::info!("[devices] CoreAudio hardware notifications registered");
        while rx.recv().is_ok() {
            thread::sleep(DEVICECHANGE_DEBOUNCE);
            while rx.try_recv().is_ok() {}
            crate::winstt::commands::audio_devices::refresh_audio_devices_and_emit(&app);
        }
    }

    struct CoreAudioDeviceListeners {
        tx: Box<Sender<()>>,
        addresses: Vec<AudioObjectPropertyAddress>,
    }

    impl CoreAudioDeviceListeners {
        fn register(tx: Sender<()>) -> Result<Self, i32> {
            let mut listeners = Self {
                tx: Box::new(tx),
                addresses: Vec::new(),
            };

            for selector in [
                kAudioHardwarePropertyDevices,
                kAudioHardwarePropertyDefaultInputDevice,
                kAudioHardwarePropertyDefaultOutputDevice,
            ] {
                let address = AudioObjectPropertyAddress {
                    mSelector: selector,
                    mScope: kAudioObjectPropertyScopeGlobal,
                    mElement: kAudioObjectPropertyElementMain,
                };
                let status = unsafe {
                    AudioObjectAddPropertyListener(
                        kAudioObjectSystemObject as AudioObjectID,
                        NonNull::from(&address),
                        Some(coreaudio_property_listener),
                        listeners.client_data(),
                    )
                };
                if status != kAudioHardwareNoError {
                    return Err(status);
                }
                listeners.addresses.push(address);
            }

            Ok(listeners)
        }

        fn client_data(&self) -> *mut c_void {
            self.tx.as_ref() as *const Sender<()> as *mut c_void
        }
    }

    impl Drop for CoreAudioDeviceListeners {
        fn drop(&mut self) {
            let client_data = self.client_data();
            for address in self.addresses.drain(..) {
                let _ = unsafe {
                    AudioObjectRemovePropertyListener(
                        kAudioObjectSystemObject as AudioObjectID,
                        NonNull::from(&address),
                        Some(coreaudio_property_listener),
                        client_data,
                    )
                };
            }
        }
    }

    unsafe extern "C-unwind" fn coreaudio_property_listener(
        _object_id: AudioObjectID,
        _number_addresses: u32,
        _addresses: NonNull<AudioObjectPropertyAddress>,
        client_data: *mut c_void,
    ) -> i32 {
        if let Some(tx) = NonNull::new(client_data.cast::<Sender<()>>()) {
            // SAFETY: client_data is created from CoreAudioDeviceListeners::client_data
            // and remains valid until the listener is removed in Drop.
            let _ = unsafe { tx.as_ref() }.send(());
        }
        0
    }
}

#[cfg(target_os = "linux")]
mod platform_impl {
    use tauri::AppHandle;

    pub(super) fn spawn(_app: AppHandle) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform_impl {
    use tauri::AppHandle;

    pub(super) fn spawn(_app: AppHandle) -> std::io::Result<()> {
        Ok(())
    }
}
