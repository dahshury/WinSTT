/// A Windows foreground handle paired with its owning process so recycled HWNDs
/// can be rejected before focus or context operations.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ForegroundWindow {
    pub(crate) hwnd_raw: isize,
    pub(crate) process_id: u32,
}

impl ForegroundWindow {
    #[cfg(target_os = "windows")]
    pub(crate) fn current() -> Option<Self> {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };

        // SAFETY: reads the current foreground HWND and its owning PID only.
        let hwnd = unsafe { GetForegroundWindow() };
        let hwnd_raw = hwnd.0 as isize;
        if hwnd_raw == 0 {
            return None;
        }
        let mut process_id = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        }
        (process_id != 0).then_some(Self {
            hwnd_raw,
            process_id,
        })
    }

    #[cfg(not(target_os = "windows"))]
    pub(crate) fn current() -> Option<Self> {
        None
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn thread_id_if_valid(self) -> Option<u32> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};

        let hwnd = HWND(self.hwnd_raw as *mut core::ffi::c_void);
        // SAFETY: validates the raw handle and reads its owning PID only.
        unsafe {
            if !IsWindow(Some(hwnd)).as_bool() {
                return None;
            }
            let mut process_id = 0u32;
            let thread_id = GetWindowThreadProcessId(hwnd, Some(&mut process_id));
            (thread_id != 0 && process_id == self.process_id).then_some(thread_id)
        }
    }

    #[cfg(not(target_os = "windows"))]
    pub(crate) fn thread_id_if_valid(self) -> Option<u32> {
        None
    }

    pub(crate) fn is_valid(self) -> bool {
        self.thread_id_if_valid().is_some()
    }
}
