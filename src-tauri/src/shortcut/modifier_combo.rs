#[cfg(target_os = "windows")]
mod platform {
    use log::{debug, error};
    use once_cell::sync::Lazy;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use std::thread::{self, JoinHandle};
    use std::time::Duration;
    use tauri::AppHandle;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_RCONTROL,
        VK_RMENU, VK_RSHIFT, VK_RWIN,
    };

    use crate::settings::ShortcutBinding;

    const PTT_BINDING: &str = "transcribe";
    const POLL_INTERVAL: Duration = Duration::from_millis(8);

    static LISTENER: Lazy<Mutex<Option<ListenerHandle>>> = Lazy::new(|| Mutex::new(None));

    struct ListenerHandle {
        accelerator: String,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    #[derive(Clone, Debug)]
    struct ModifierCombo {
        requirements: Vec<ModifierRequirement>,
        uses_win_key: bool,
        label: String,
    }

    #[derive(Clone, Debug)]
    enum ModifierRequirement {
        Exact(VIRTUAL_KEY),
        Any(VIRTUAL_KEY, VIRTUAL_KEY),
    }

    impl ModifierRequirement {
        fn is_down(&self) -> bool {
            match self {
                Self::Exact(vk) => vk_is_down(*vk),
                Self::Any(left, right) => vk_is_down(*left) || vk_is_down(*right),
            }
        }
    }

    impl Drop for ListenerHandle {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    pub fn is_modifier_only_accelerator(raw: &str) -> bool {
        matches!(parse_modifier_combo(raw), Ok(Some(_)))
    }

    pub fn register_if_modifier_only(
        app: &AppHandle,
        binding: &ShortcutBinding,
    ) -> Result<bool, String> {
        if binding.id != PTT_BINDING {
            return Ok(false);
        }

        let Some(combo) = parse_modifier_combo(&binding.current_binding)? else {
            return Ok(false);
        };

        let mut listener = LISTENER
            .lock()
            .map_err(|_| "modifier-combo listener lock poisoned".to_string())?;
        if listener
            .as_ref()
            .is_some_and(|handle| same_accelerator(&handle.accelerator, &binding.current_binding))
        {
            return Ok(true);
        }

        listener.take();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let app = app.clone();
        let accelerator = binding.current_binding.clone();
        let thread_combo = combo.clone();
        let thread = thread::Builder::new()
            .name("winstt-ptt-modifier-hotkey".into())
            .spawn(move || run_listener(app, thread_combo, thread_stop))
            .map_err(|err| format!("failed to start modifier-combo listener: {err}"))?;

        debug!(
            "registered modifier-only PTT shortcut '{}'",
            binding.current_binding
        );
        *listener = Some(ListenerHandle {
            accelerator,
            stop,
            thread: Some(thread),
        });
        Ok(true)
    }

    pub fn unregister_if_modifier_only(binding: &ShortcutBinding) -> Result<bool, String> {
        if binding.id != PTT_BINDING || !is_modifier_only_accelerator(&binding.current_binding) {
            return Ok(false);
        }

        let mut listener = LISTENER
            .lock()
            .map_err(|_| "modifier-combo listener lock poisoned".to_string())?;
        listener.take();
        debug!(
            "unregistered modifier-only PTT shortcut '{}'",
            binding.current_binding
        );
        Ok(true)
    }

    fn run_listener(app: AppHandle, combo: ModifierCombo, stop: Arc<AtomicBool>) {
        let mut pressed = false;
        while !stop.load(Ordering::SeqCst) {
            let down = combo.requirements.iter().all(ModifierRequirement::is_down);
            if down != pressed {
                pressed = down;
                if down && combo.uses_win_key {
                    suppress_start_menu_for_win_combo();
                }
                dispatch(&app, &combo.label, down);
            }
            thread::sleep(POLL_INTERVAL);
        }

        if pressed {
            dispatch(&app, &combo.label, false);
        }
    }

    fn dispatch(app: &AppHandle, accelerator: &str, is_pressed: bool) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            super::super::handler::handle_shortcut_event(app, PTT_BINDING, accelerator, is_pressed);
        }));
        if let Err(err) = result {
            error!("modifier-combo listener recovered from hotkey dispatch panic: {err:?}");
        }
    }

    fn parse_modifier_combo(raw: &str) -> Result<Option<ModifierCombo>, String> {
        let mut requirements = Vec::new();
        let mut labels = Vec::new();
        let mut uses_win_key = false;

        for token in raw
            .split('+')
            .map(str::trim)
            .filter(|part| !part.is_empty())
        {
            let Some((requirement, label, is_win_key)) = parse_modifier_token(token) else {
                return Ok(None);
            };
            if !labels.iter().any(|existing| existing == label) {
                requirements.push(requirement);
                labels.push(label.to_string());
            }
            uses_win_key |= is_win_key;
        }

        if requirements.is_empty() {
            return Err("Shortcut cannot be empty".into());
        }

        Ok(Some(ModifierCombo {
            requirements,
            uses_win_key,
            label: labels.join("+"),
        }))
    }

    fn parse_modifier_token(token: &str) -> Option<(ModifierRequirement, &'static str, bool)> {
        match token.to_ascii_lowercase().as_str() {
            "lctrl" | "ctrl_left" | "controlleft" | "control_left" => {
                Some((ModifierRequirement::Exact(VK_LCONTROL), "LCtrl", false))
            }
            "rctrl" | "ctrl_right" | "controlright" | "control_right" => {
                Some((ModifierRequirement::Exact(VK_RCONTROL), "RCtrl", false))
            }
            "ctrl" | "control" => Some((
                ModifierRequirement::Any(VK_LCONTROL, VK_RCONTROL),
                "Ctrl",
                false,
            )),
            "lalt" | "alt_left" | "altleft" | "option_left" | "optionleft" => {
                Some((ModifierRequirement::Exact(VK_LMENU), "LAlt", false))
            }
            "ralt" | "alt_right" | "altright" | "altgr" | "option_right" | "optionright" => {
                Some((ModifierRequirement::Exact(VK_RMENU), "RAlt", false))
            }
            "alt" | "option" | "opt" => {
                Some((ModifierRequirement::Any(VK_LMENU, VK_RMENU), "Alt", false))
            }
            "lshift" | "shift_left" | "shiftleft" => {
                Some((ModifierRequirement::Exact(VK_LSHIFT), "LShift", false))
            }
            "rshift" | "shift_right" | "shiftright" => {
                Some((ModifierRequirement::Exact(VK_RSHIFT), "RShift", false))
            }
            "shift" => Some((
                ModifierRequirement::Any(VK_LSHIFT, VK_RSHIFT),
                "Shift",
                false,
            )),
            "lmeta" | "lwin" | "win_left" | "winleft" | "super_left" | "superleft"
            | "meta_left" | "metaleft" => {
                Some((ModifierRequirement::Exact(VK_LWIN), "LMeta", true))
            }
            "rmeta" | "rwin" | "win_right" | "winright" | "super_right" | "superright"
            | "meta_right" | "metaright" => {
                Some((ModifierRequirement::Exact(VK_RWIN), "RMeta", true))
            }
            "meta" | "super" | "win" | "windows" | "cmd" | "command" => {
                Some((ModifierRequirement::Any(VK_LWIN, VK_RWIN), "Meta", true))
            }
            _ => None,
        }
    }

    fn same_accelerator(a: &str, b: &str) -> bool {
        a.split('+')
            .map(|part| part.trim().to_ascii_lowercase())
            .filter(|part| !part.is_empty())
            .eq(b
                .split('+')
                .map(|part| part.trim().to_ascii_lowercase())
                .filter(|part| !part.is_empty()))
    }

    fn vk_is_down(vk: VIRTUAL_KEY) -> bool {
        // SAFETY: GetAsyncKeyState reads the current state for the requested virtual-key code.
        (unsafe { GetAsyncKeyState(vk.0 as i32) } as u16 & 0x8000) != 0
    }

    fn suppress_start_menu_for_win_combo() {
        const VK_DISGUISE: u16 = 0xE8;

        let mk = |flags: KEYBD_EVENT_FLAGS| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(VK_DISGUISE),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [mk(KEYBD_EVENT_FLAGS(0)), mk(KEYEVENTF_KEYUP)];
        // SAFETY: `inputs` is a valid array of INPUT values for SendInput.
        unsafe {
            let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::is_modifier_only_accelerator;

        #[test]
        fn detects_modifier_only_accelerators() {
            assert!(is_modifier_only_accelerator("LCtrl+LMeta"));
            assert!(is_modifier_only_accelerator("Ctrl+Super"));
            assert!(is_modifier_only_accelerator("LShift+RAlt+RMeta"));
        }

        #[test]
        fn ignores_shortcuts_with_main_keys() {
            assert!(!is_modifier_only_accelerator("LCtrl+LMeta+D"));
            assert!(!is_modifier_only_accelerator("Ctrl+Space"));
            assert!(!is_modifier_only_accelerator("F2"));
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use tauri::AppHandle;

    use crate::settings::ShortcutBinding;

    pub fn is_modifier_only_accelerator(raw: &str) -> bool {
        let mut saw_token = false;
        for part in raw
            .split('+')
            .map(str::trim)
            .filter(|part| !part.is_empty())
        {
            saw_token = true;
            if !matches!(
                part.to_ascii_lowercase().as_str(),
                "lctrl"
                    | "rctrl"
                    | "ctrl"
                    | "control"
                    | "lalt"
                    | "ralt"
                    | "alt"
                    | "option"
                    | "lshift"
                    | "rshift"
                    | "shift"
                    | "lmeta"
                    | "rmeta"
                    | "meta"
                    | "super"
                    | "win"
                    | "windows"
                    | "cmd"
                    | "command"
            ) {
                return false;
            }
        }
        saw_token
    }

    pub fn register_if_modifier_only(
        _app: &AppHandle,
        binding: &ShortcutBinding,
    ) -> Result<bool, String> {
        if binding.id == "transcribe" && is_modifier_only_accelerator(&binding.current_binding) {
            return Err(
                "modifier-only PTT shortcuts are unavailable on this platform; choose a full hotkey with a non-modifier key".into(),
            );
        }
        Ok(false)
    }

    pub fn unregister_if_modifier_only(_binding: &ShortcutBinding) -> Result<bool, String> {
        Ok(false)
    }
}

pub(crate) use platform::{
    is_modifier_only_accelerator, register_if_modifier_only, unregister_if_modifier_only,
};
