#[cfg(target_os = "windows")]
mod platform {
    use log::{debug, warn};
    use once_cell::sync::Lazy;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Condvar, Mutex, Weak};
    use std::thread;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};

    use super::super::windows_accelerator::{KeyRequirement, parse_requirements};
    use crate::TranscriptionCoordinator;
    use crate::managers::audio::AudioRecordingManager;
    use crate::winstt::settings_schema::RecordingMode;

    /// Used only when neither WinSTT low-level keyboard hook could be installed.
    /// `GetAsyncKeyState` has no callback API, so bounded timed observation is the
    /// only available safety net on that exceptional OS-hook failure path.
    const HOOK_UNAVAILABLE_POLL_INTERVAL: Duration = Duration::from_millis(10);
    const START_WAIT_TIMEOUT: Duration = Duration::from_secs(2);

    type RecordingSignal = (Mutex<u64>, Condvar);

    static WATCHDOG_TOKEN: AtomicU64 = AtomicU64::new(0);
    /// Physical-key callbacks and disarm both pulse this condition variable. The
    /// epoch makes a notification impossible to lose between checking the key
    /// state/token and entering the wait.
    static KEY_TRANSITION_SIGNAL: Lazy<RecordingSignal> =
        Lazy::new(|| (Mutex::new(0), Condvar::new()));
    /// The currently armed recorder signal, retained weakly so `disarm()` can wake
    /// a task that is still awaiting asynchronous recorder startup.
    static CURRENT_RECORDING_SIGNAL: Lazy<Mutex<Option<Weak<RecordingSignal>>>> =
        Lazy::new(|| Mutex::new(None));

    pub fn arm(app: &AppHandle, event_accelerator: &str) {
        let configured = crate::winstt::commands::settings::read_settings_raw(app)
            .hotkey
            .push_to_talk_key;
        let accelerator = if configured.trim().is_empty() {
            event_accelerator.to_string()
        } else {
            configured
        };
        let requirements = match parse_requirements(&accelerator) {
            Some(requirements) => requirements,
            None => {
                warn!(
                    "[shortcut] ptt_release_watchdog_unavailable accelerator='{}'",
                    accelerator
                );
                return;
            }
        };
        let Some(audio) = app.try_state::<Arc<AudioRecordingManager>>() else {
            return;
        };
        let audio = Arc::clone(&audio);
        let recording_signal = audio.recording_transition_signal();
        if let Ok(mut current) = CURRENT_RECORDING_SIGNAL.lock() {
            *current = Some(Arc::downgrade(&recording_signal));
        }

        if hook_combo_engaged().is_none() {
            warn!(
                "[shortcut] PTT low-level hook unavailable; release watchdog is using GetAsyncKeyState fallback"
            );
        }

        let token = WATCHDOG_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
        pulse(&KEY_TRANSITION_SIGNAL);
        let app = app.clone();
        if let Err(err) = thread::Builder::new()
            .name("winstt-ptt-release-watchdog".into())
            .spawn(move || {
                run(
                    app,
                    audio,
                    recording_signal,
                    token,
                    accelerator,
                    requirements,
                )
            })
        {
            warn!("[shortcut] failed to start PTT release watchdog: {err}");
        }
    }

    pub fn disarm() {
        WATCHDOG_TOKEN.fetch_add(1, Ordering::SeqCst);
        pulse(&KEY_TRANSITION_SIGNAL);
        let recording_signal = CURRENT_RECORDING_SIGNAL
            .lock()
            .ok()
            .and_then(|current| current.as_ref().and_then(Weak::upgrade));
        if let Some(signal) = recording_signal {
            pulse(&signal);
        }
    }

    /// Called directly by the installed `WH_KEYBOARD_LL` hooks for a physical
    /// transition of a key that belongs to the active PTT accelerator.
    pub fn physical_key_transition() {
        pulse(&KEY_TRANSITION_SIGNAL);
    }

    fn run(
        app: AppHandle,
        audio: Arc<AudioRecordingManager>,
        recording_signal: Arc<RecordingSignal>,
        token: u64,
        accelerator: String,
        requirements: Vec<KeyRequirement>,
    ) {
        let Some(generation) =
            wait_for_recording_start(&app, &audio, &recording_signal, token, &accelerator)
        else {
            return;
        };

        let (epoch, wake) = &*KEY_TRANSITION_SIGNAL;
        let mut observed_epoch = *lock_recover(epoch);
        loop {
            if !watchdog_is_current(&app, &audio, token, generation) {
                return;
            }

            // The modifier-only hook is authoritative for swallowed combos. For
            // full accelerators, the mode-cycle hook publishes its own durable
            // physical state before waking us. Only hook absence falls back to
            // sampling GetAsyncKeyState on a bounded cadence.
            let hook_combo_engaged = hook_combo_engaged();
            let combo_engaged =
                hook_combo_engaged.unwrap_or_else(|| requirements.iter().all(|key| key.is_down()));
            if !combo_engaged {
                debug!(
                    "[shortcut] ptt_release_watchdog_stop accelerator='{accelerator}' generation={generation}"
                );
                if let Some(coordinator) = app.try_state::<TranscriptionCoordinator>() {
                    coordinator.send_input("transcribe", "ptt-release-watchdog", false, true);
                }
                crate::winstt::commands::hotkey::HotkeyEvents::released(&app);
                disarm();
                return;
            }

            // Never hold the signal mutex while consulting recorder/settings
            // state. Recording startup takes those locks before pulsing its
            // transition signal, so overlapping them here would invert the lock
            // order and deadlock. The epoch comparison closes the check-to-wait
            // race without nesting either lock.
            let guard = lock_recover(epoch);
            if *guard != observed_epoch {
                observed_epoch = *guard;
                drop(guard);
                continue;
            }
            let guard = if hook_combo_engaged.is_some() {
                wait_recover(wake, guard)
            } else {
                // Exceptional fallback only: Windows exposes no waitable object for
                // GetAsyncKeyState. This timed Condvar wait remains instantly
                // interruptible by `disarm()` (unlike the former thread::sleep).
                wait_timeout_recover(wake, guard, HOOK_UNAVAILABLE_POLL_INTERVAL)
            };
            observed_epoch = *guard;
            drop(guard);
        }
    }

    fn wait_for_recording_start(
        app: &AppHandle,
        audio: &AudioRecordingManager,
        signal: &RecordingSignal,
        token: u64,
        accelerator: &str,
    ) -> Option<u64> {
        let deadline = Instant::now() + START_WAIT_TIMEOUT;
        let (epoch, wake) = signal;
        let mut observed_epoch = *lock_recover(epoch);
        loop {
            // These predicates acquire app/audio locks. Do not hold `epoch`
            // while reading them: recording startup holds audio state before it
            // pulses this signal. Re-locking and comparing the epoch below makes
            // a transition between this check and the wait impossible to lose.
            if WATCHDOG_TOKEN.load(Ordering::SeqCst) != token
                || recording_mode(app) != Some(RecordingMode::Ptt)
            {
                return None;
            }
            if audio.is_recording() {
                return Some(audio.recording_generation());
            }

            let now = Instant::now();
            if now >= deadline {
                debug!("[shortcut] ptt_release_watchdog_no_recording accelerator='{accelerator}'");
                return None;
            }
            let guard = lock_recover(epoch);
            if *guard != observed_epoch {
                observed_epoch = *guard;
                drop(guard);
                continue;
            }
            let guard = wait_timeout_recover(wake, guard, deadline.saturating_duration_since(now));
            observed_epoch = *guard;
            drop(guard);
        }
    }

    fn watchdog_is_current(
        app: &AppHandle,
        audio: &AudioRecordingManager,
        token: u64,
        generation: u64,
    ) -> bool {
        WATCHDOG_TOKEN.load(Ordering::SeqCst) == token
            && recording_mode(app) == Some(RecordingMode::Ptt)
            && audio.is_active_recording_generation(generation)
    }

    /// Prefer the modifier-only hook because it swallows those events before
    /// the full-accelerator hook can observe them. Otherwise use the latter's
    /// durable physical tracker. `None` preserves the bounded OS-state fallback.
    fn hook_combo_engaged() -> Option<bool> {
        super::super::modifier_combo::ptt_hook_combo_engaged()
            .or_else(super::super::mode_cycle::ptt_hook_combo_engaged)
    }

    fn pulse(signal: &RecordingSignal) {
        let (epoch, wake) = signal;
        let mut epoch = lock_recover(epoch);
        *epoch = epoch.wrapping_add(1);
        drop(epoch);
        wake.notify_all();
    }

    fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wait_recover<'a, T>(
        wake: &Condvar,
        guard: std::sync::MutexGuard<'a, T>,
    ) -> std::sync::MutexGuard<'a, T> {
        wake.wait(guard)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn wait_timeout_recover<'a, T>(
        wake: &Condvar,
        guard: std::sync::MutexGuard<'a, T>,
        timeout: Duration,
    ) -> std::sync::MutexGuard<'a, T> {
        match wake.wait_timeout(guard, timeout) {
            Ok((guard, _)) => guard,
            Err(poisoned) => poisoned.into_inner().0,
        }
    }

    fn recording_mode(app: &AppHandle) -> Option<RecordingMode> {
        Some(crate::winstt::commands::settings::recording_mode(app))
    }

    #[cfg(test)]
    mod tests {
        use super::{RecordingSignal, lock_recover, pulse, wait_timeout_recover};
        use std::sync::{Arc, Condvar, Mutex, mpsc};
        use std::time::{Duration, Instant};

        #[test]
        fn callback_pulse_wakes_waiter_without_poll_tick() {
            let signal: Arc<RecordingSignal> = Arc::new((Mutex::new(0), Condvar::new()));
            let waiter_signal = Arc::clone(&signal);
            let (done_tx, done_rx) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::channel();
            let thread = std::thread::spawn(move || {
                let (epoch, wake) = &*waiter_signal;
                let guard = epoch.lock().unwrap();
                let started = Instant::now();
                ready_tx.send(()).unwrap();
                let _guard = wait_timeout_recover(wake, guard, Duration::from_secs(2));
                done_tx.send(started.elapsed()).unwrap();
            });

            ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            pulse(&signal);
            let elapsed = done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            assert!(elapsed < Duration::from_millis(500));
            thread.join().unwrap();
        }

        #[test]
        fn pulse_between_predicate_and_wait_is_not_lost() {
            let signal: Arc<RecordingSignal> = Arc::new((Mutex::new(0), Condvar::new()));
            let state = Arc::new(Mutex::new(false));
            let waiter_signal = Arc::clone(&signal);
            let waiter_state = Arc::clone(&state);
            let (checked_tx, checked_rx) = mpsc::channel();
            let (continue_tx, continue_rx) = mpsc::channel();
            let (done_tx, done_rx) = mpsc::channel();

            let thread = std::thread::spawn(move || {
                let (epoch, wake) = &*waiter_signal;
                let mut observed_epoch = *lock_recover(epoch);
                loop {
                    // Predicate lock and signal lock are deliberately never held
                    // together, matching the recorder-state handshake above.
                    if *lock_recover(&waiter_state) {
                        done_tx.send(()).unwrap();
                        return;
                    }
                    checked_tx.send(()).unwrap();
                    continue_rx.recv().unwrap();

                    let guard = lock_recover(epoch);
                    if *guard != observed_epoch {
                        observed_epoch = *guard;
                        drop(guard);
                        continue;
                    }
                    let guard = wait_timeout_recover(wake, guard, Duration::from_secs(2));
                    observed_epoch = *guard;
                    drop(guard);
                }
            });

            // Pulse after the predicate read but before the waiter locks the
            // signal. An unguarded Condvar wait would miss this notification.
            checked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            *state.lock().unwrap() = true;
            pulse(&signal);
            continue_tx.send(()).unwrap();

            done_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            thread.join().unwrap();
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use tauri::AppHandle;

    pub fn arm(_app: &AppHandle, _event_accelerator: &str) {}

    pub fn disarm() {}
}

#[cfg(target_os = "windows")]
pub(crate) use platform::physical_key_transition;
pub(crate) use platform::{arm, disarm};
