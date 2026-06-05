#[cfg(windows)]
pub(crate) struct ComApartment {
    initialized: bool,
}

#[cfg(windows)]
impl ComApartment {
    pub(crate) fn init_multithreaded() -> Self {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

        // SAFETY: initializes COM for the current thread. A successful call,
        // including S_FALSE for "already initialized", must be balanced by
        // CoUninitialize on the same thread.
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };
        Self { initialized }
    }
}

#[cfg(windows)]
impl Drop for ComApartment {
    fn drop(&mut self) {
        if !self.initialized {
            return;
        }
        // SAFETY: this guard only calls CoUninitialize when the matching
        // CoInitializeEx call succeeded on this same thread.
        unsafe {
            windows::Win32::System::Com::CoUninitialize();
        }
    }
}
