#[cfg(target_os = "windows")]
mod platform {
    use log::{debug, warn};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};

    use super::super::windows_accelerator::{KeyRequirement, parse_requirements};
    use crate::TranscriptionCoordinator;
    use crate::managers::audio::AudioRecordingManager;
    use crate::winstt::settings_schema::RecordingMode;

    const POLL_INTERVAL: Duration = Duration::from_millis(10);
    const START_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
    const REQUIRED_UP_POLLS: u8 = 2;

    static WATCHDOG_TOKEN: AtomicU64 = AtomicU64::new(0);

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

        let token = WATCHDOG_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
        let app = app.clone();
        if let Err(err) = thread::Builder::new()
            .name("winstt-ptt-release-watchdog".into())
            .spawn(move || run(app, token, accelerator, requirements))
        {
            warn!("[shortcut] failed to start PTT release watchdog: {err}");
        }
    }

    pub fn disarm() {
        WATCHDOG_TOKEN.fetch_add(1, Ordering::SeqCst);
    }

    fn run(app: AppHandle, token: u64, accelerator: String, requirements: Vec<KeyRequirement>) {
        let started = Instant::now();
        let generation = loop {
            if WATCHDOG_TOKEN.load(Ordering::SeqCst) != token {
                return;
            }
            if recording_mode(&app) != Some(RecordingMode::Ptt) {
                return;
            }
            let Some(audio) = app.try_state::<Arc<AudioRecordingManager>>() else {
                return;
            };
            if audio.is_recording() {
                break audio.recording_generation();
            }
            if started.elapsed() >= START_WAIT_TIMEOUT {
                debug!("[shortcut] ptt_release_watchdog_no_recording accelerator='{accelerator}'");
                return;
            }
            thread::sleep(POLL_INTERVAL);
        };

        let mut up_polls = 0u8;
        loop {
            if WATCHDOG_TOKEN.load(Ordering::SeqCst) != token {
                return;
            }
            if recording_mode(&app) != Some(RecordingMode::Ptt) {
                return;
            }

            let Some(audio) = app.try_state::<Arc<AudioRecordingManager>>() else {
                return;
            };
            if !audio.is_recording() || audio.recording_generation() != generation {
                return;
            }

            // When the blocking keyboard hook owns the PTT combo, its swallowed
            // physical events never reach the async key state — GetAsyncKeyState
            // would report "all up" instantly and kill every session. Ask the hook
            // for the real physical hold state; fall back to key polling otherwise.
            let all_up = match super::super::modifier_combo::ptt_hook_combo_key_down() {
                Some(any_down) => !any_down,
                None => requirements.iter().all(|key| !key.is_down()),
            };
            if all_up {
                up_polls = up_polls.saturating_add(1);
                if up_polls >= REQUIRED_UP_POLLS {
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
            } else {
                up_polls = 0;
            }

            thread::sleep(POLL_INTERVAL);
        }
    }

    fn recording_mode(app: &AppHandle) -> Option<RecordingMode> {
        Some(crate::winstt::commands::settings::recording_mode(app))
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use tauri::AppHandle;

    pub fn arm(_app: &AppHandle, _event_accelerator: &str) {}

    pub fn disarm() {}
}

pub(crate) use platform::{arm, disarm};
