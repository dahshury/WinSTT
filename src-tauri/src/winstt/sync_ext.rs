//! Shared `std::sync::Mutex` poison-recovery idiom.
//!
//! WinSTT holds mutexes across calls into flaky native code (cpal `open`/`start`/`stop`
//! on a Bluetooth headset that drops to A2DP, a virtual "WO Mic"/loopback endpoint, a
//! device yanked mid-recording; ONNX engine swaps; download/extract workers). If any of
//! those faults *panics* while a lock is held, plain `.lock().unwrap()` would poison the
//! mutex and EVERY later lock would itself panic: the recorder could never return to
//! `Idle`, and the panic propagating up the coordinator thread killed the dispatch loop —
//! so the hotkey silently stopped recording until restart. Recovering the poisoned value
//! turns that permanent wedge into a recoverable transient (the next press retries).
//!
//! This trait is the ONE canonical form of that recovery; prefer `.lock_recover()` over
//! ad-hoc `.lock().unwrap_or_else(|e| e.into_inner())` / `.lock().unwrap()` /
//! `.lock().expect(..)` on a `std::sync::Mutex`.

/// Extension that locks a [`std::sync::Mutex`], RECOVERING the inner value if a previous
/// panic poisoned it instead of panicking again.
pub trait MutexExt<T> {
    /// Lock the mutex, returning the guard even if the mutex was poisoned by a prior panic.
    fn lock_recover(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> MutexExt<T> for std::sync::Mutex<T> {
    fn lock_recover(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}
