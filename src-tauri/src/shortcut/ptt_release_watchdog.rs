#[cfg(target_os = "windows")]
mod platform {
    use log::{debug, info, warn};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY};

    use crate::managers::audio::AudioRecordingManager;
    use crate::winstt::settings_schema::RecordingMode;
    use crate::TranscriptionCoordinator;

    const POLL_INTERVAL: Duration = Duration::from_millis(10);
    const START_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
    const REQUIRED_UP_POLLS: u8 = 2;

    static WATCHDOG_TOKEN: AtomicU64 = AtomicU64::new(0);

    #[derive(Clone, Debug)]
    enum KeyRequirement {
        Exact(VIRTUAL_KEY),
        Any(VIRTUAL_KEY, VIRTUAL_KEY),
    }

    impl KeyRequirement {
        fn is_down(&self) -> bool {
            match self {
                Self::Exact(vk) => vk_is_down(*vk),
                Self::Any(left, right) => vk_is_down(*left) || vk_is_down(*right),
            }
        }
    }

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

            if requirements.iter().all(|key| !key.is_down()) {
                up_polls = up_polls.saturating_add(1);
                if up_polls >= REQUIRED_UP_POLLS {
                    info!(
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

    fn vk_is_down(vk: VIRTUAL_KEY) -> bool {
        // SAFETY: GetAsyncKeyState reads the current state for the requested virtual-key code.
        (unsafe { GetAsyncKeyState(vk.0 as i32) } as u16 & 0x8000) != 0
    }

    fn parse_requirements(accelerator: &str) -> Option<Vec<KeyRequirement>> {
        let mut requirements = Vec::new();
        for token in accelerator
            .split('+')
            .map(str::trim)
            .filter(|part| !part.is_empty())
        {
            requirements.push(parse_token(token)?);
        }
        (!requirements.is_empty()).then_some(requirements)
    }

    fn parse_token(token: &str) -> Option<KeyRequirement> {
        let normalized = token.to_ascii_lowercase();
        let exact = |code| Some(KeyRequirement::Exact(VIRTUAL_KEY(code)));
        let any = |left, right| Some(KeyRequirement::Any(VIRTUAL_KEY(left), VIRTUAL_KEY(right)));

        match normalized.as_str() {
            "lctrl" | "ctrl_left" | "controlleft" | "control_left" => exact(0xA2),
            "rctrl" | "ctrl_right" | "controlright" | "control_right" => exact(0xA3),
            "ctrl" | "control" => any(0xA2, 0xA3),
            "lalt" | "alt_left" | "altleft" | "option_left" | "optionleft" => exact(0xA4),
            "ralt" | "alt_right" | "altright" | "altgr" | "option_right" | "optionright" => {
                exact(0xA5)
            }
            "alt" | "option" | "opt" => any(0xA4, 0xA5),
            "lshift" | "shift_left" | "shiftleft" => exact(0xA0),
            "rshift" | "shift_right" | "shiftright" => exact(0xA1),
            "shift" => any(0xA0, 0xA1),
            "lmeta" | "lwin" | "win_left" | "winleft" | "super_left" | "superleft"
            | "meta_left" | "metaleft" => exact(0x5B),
            "rmeta" | "rwin" | "win_right" | "winright" | "super_right" | "superright"
            | "meta_right" | "metaright" => exact(0x5C),
            "meta" | "super" | "win" | "windows" | "cmd" | "command" => any(0x5B, 0x5C),
            "space" => exact(0x20),
            "tab" => exact(0x09),
            "enter" | "return" => exact(0x0D),
            "escape" | "esc" => exact(0x1B),
            "backspace" => exact(0x08),
            "delete" | "forwarddelete" => exact(0x2E),
            "insert" => exact(0x2D),
            "home" => exact(0x24),
            "end" => exact(0x23),
            "pageup" | "prior" => exact(0x21),
            "pagedown" | "next" => exact(0x22),
            "arrowleft" | "left" => exact(0x25),
            "arrowup" | "up" => exact(0x26),
            "arrowright" | "right" => exact(0x27),
            "arrowdown" | "down" => exact(0x28),
            f if f.len() >= 2 && f.starts_with('f') => {
                let n = f[1..].parse::<u16>().ok()?;
                (1..=24)
                    .contains(&n)
                    .then(|| KeyRequirement::Exact(VIRTUAL_KEY(0x6F + n)))
            }
            key if key.len() == 1 => {
                let ch = key.as_bytes()[0];
                if ch.is_ascii_alphabetic() {
                    exact(ch.to_ascii_uppercase() as u16)
                } else if ch.is_ascii_digit() {
                    exact(ch as u16)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    #[cfg(test)]
    mod tests {
        use super::parse_requirements;

        #[test]
        fn parses_modifier_only_ptt() {
            assert_eq!(parse_requirements("LCtrl+LMeta").unwrap().len(), 2);
        }

        #[test]
        fn parses_full_ptt_shortcut() {
            assert_eq!(parse_requirements("Ctrl+Space").unwrap().len(), 2);
            assert_eq!(parse_requirements("LCtrl+ArrowUp").unwrap().len(), 2);
            assert_eq!(parse_requirements("F2").unwrap().len(), 1);
        }

        #[test]
        fn rejects_unknown_tokens() {
            assert!(parse_requirements("LCtrl+DefinitelyNotAKey").is_none());
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use tauri::AppHandle;

    pub fn arm(_app: &AppHandle, _event_accelerator: &str) {}

    pub fn disarm() {}
}

pub(crate) use platform::{arm, disarm};
