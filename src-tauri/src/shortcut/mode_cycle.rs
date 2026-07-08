//! Recording-mode cycle gesture: hold the transcribe (PTT) hotkey and tap
//! ArrowUp to advance to the next recording mode (ptt → toggle → listen →
//! wakeword → ptt). The `HotkeyShortcutsLegend` in the settings UI draws exactly
//! this gesture; this module is what actually makes it fire.
//!
//! Why a dedicated low-level keyboard hook instead of extending an existing path:
//!   - The transcribe hotkey has TWO backends. A modifier-only combo (`LCtrl+LMeta`)
//!     is owned by the blocking `WH_KEYBOARD_LL` hook in [`super::modifier_combo`];
//!     a full accelerator (`Ctrl+Space`, `F2`) is owned by Tauri's global-shortcut
//!     plugin (`RegisterHotKey`), which installs NO always-on keyboard hook.
//!   - To make "held + ArrowUp" work universally AND to SWALLOW the ArrowUp (so it
//!     doesn't scroll/move the caret in the focused app), we need a keyboard hook
//!     that is present regardless of which backend owns the transcribe combo.
//!
//! Held-state is resolved per backend: when the modifier-only combo hook is active
//! its swallowed keys never reach `GetAsyncKeyState`, so we ask that hook whether
//! the combo is engaged; otherwise we poll the parsed accelerator keys directly.
//!
//! The hook only ever ACTS on ArrowUp; every other key is a trivial pass-through,
//! so it does not interfere with the delicate PTT combo swallowing policy.

#[cfg(target_os = "windows")]
mod platform {
    use log::{debug, info, warn};
    use once_cell::sync::Lazy;
    use std::sync::mpsc::{Receiver, Sender, channel};
    use std::sync::{Mutex, atomic::AtomicBool};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VIRTUAL_KEY};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG,
        PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
        WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    use crate::winstt::commands::events::names::RECORDING_MODE_CYCLE;

    /// ArrowUp virtual-key — the "next mode" gesture key.
    const VK_UP: u16 = 0x26;

    static LISTENER: Lazy<Mutex<Option<CycleListener>>> = Lazy::new(|| Mutex::new(None));
    /// Shared state read by the hook procedure. `Some` exactly while the hook is
    /// installed.
    static HOOK_SHARED: Lazy<Mutex<Option<CycleShared>>> = Lazy::new(|| Mutex::new(None));

    struct CycleListener {
        accelerator: String,
        _hook: HookHandle,
    }

    struct HookHandle {
        hook_thread_id: u32,
        hook_thread: Option<JoinHandle<()>>,
        dispatch_thread: Option<JoinHandle<()>>,
    }

    impl Drop for HookHandle {
        fn drop(&mut self) {
            // SAFETY: posting a thread message to the pump thread we spawned; it
            // unhooks and clears HOOK_SHARED, closing the channel so the dispatcher
            // exits too.
            let _ =
                unsafe { PostThreadMessageW(self.hook_thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            if let Some(thread) = self.hook_thread.take() {
                let _ = thread.join();
            }
            if let Some(thread) = self.dispatch_thread.take() {
                let _ = thread.join();
            }
        }
    }

    #[derive(Clone, Copy)]
    enum KeyRequirement {
        Exact(u16),
        Any(u16, u16),
    }

    impl KeyRequirement {
        fn is_down(self) -> bool {
            match self {
                Self::Exact(vk) => vk_is_down(vk),
                Self::Any(l, r) => vk_is_down(l) || vk_is_down(r),
            }
        }

        fn contains(self, vk: u16) -> bool {
            match self {
                Self::Exact(v) => v == vk,
                Self::Any(l, r) => l == vk || r == vk,
            }
        }
    }

    struct CycleShared {
        requirements: Vec<KeyRequirement>,
        events: Sender<()>,
        /// True between the ArrowUp key-down we consumed and its key-up, so
        /// auto-repeat while held fires exactly one cycle per physical press.
        up_active: AtomicBool,
    }

    /// Install / update / tear down the cycle hook to match the transcribe
    /// accelerator. Idempotent: re-passing the same accelerator is a no-op.
    pub fn update(app: &AppHandle, accelerator: &str) {
        let accelerator = accelerator.trim();
        let Some(requirements) = parse_requirements(accelerator) else {
            debug!("[mode-cycle] unparseable accelerator '{accelerator}'; gesture disabled");
            disable();
            return;
        };

        // If the transcribe hotkey ITSELF uses ArrowUp, the gesture would collide
        // with the accelerator (and swallowing ArrowUp would break PTT). Skip it.
        if requirements.iter().any(|r| r.contains(VK_UP)) {
            debug!("[mode-cycle] transcribe hotkey uses ArrowUp; gesture disabled");
            disable();
            return;
        }

        let mut listener = match LISTENER.lock() {
            Ok(guard) => guard,
            Err(_) => {
                warn!("[mode-cycle] listener lock poisoned");
                return;
            }
        };
        if listener
            .as_ref()
            .is_some_and(|l| l.accelerator == accelerator)
        {
            return;
        }
        // Drop the old hook first so only one is ever installed.
        listener.take();

        match install(app, requirements) {
            Ok(hook) => {
                info!("[mode-cycle] armed cycle gesture for transcribe hotkey '{accelerator}'");
                *listener = Some(CycleListener {
                    accelerator: accelerator.to_string(),
                    _hook: hook,
                });
            }
            Err(err) => warn!("[mode-cycle] failed to arm cycle gesture: {err}"),
        }
    }

    pub fn disable() {
        if let Ok(mut listener) = LISTENER.lock() {
            listener.take();
        }
    }

    fn install(app: &AppHandle, requirements: Vec<KeyRequirement>) -> Result<HookHandle, String> {
        let (event_tx, event_rx) = channel::<()>();
        let (ready_tx, ready_rx) = channel::<Result<u32, String>>();

        let hook_thread = thread::Builder::new()
            .name("winstt-mode-cycle-hook".into())
            .spawn(move || run_hook_thread(requirements, event_tx, ready_tx))
            .map_err(|err| format!("failed to start cycle-hook thread: {err}"))?;

        let hook_thread_id = match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(id)) => id,
            Ok(Err(err)) => {
                let _ = hook_thread.join();
                return Err(err);
            }
            Err(_) => return Err("cycle-hook thread did not report readiness".into()),
        };

        let dispatch_app = app.clone();
        let dispatch_thread = thread::Builder::new()
            .name("winstt-mode-cycle-dispatch".into())
            .spawn(move || run_dispatcher(dispatch_app, event_rx))
            .map_err(|err| {
                // SAFETY: tear the hook down so we don't leave a swallowing hook
                // with nobody dispatching.
                let _ =
                    unsafe { PostThreadMessageW(hook_thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
                format!("failed to start cycle dispatcher: {err}")
            })?;

        Ok(HookHandle {
            hook_thread_id,
            hook_thread: Some(hook_thread),
            dispatch_thread: Some(dispatch_thread),
        })
    }

    fn run_hook_thread(
        requirements: Vec<KeyRequirement>,
        events: Sender<()>,
        ready: Sender<Result<u32, String>>,
    ) {
        // Publish shared state BEFORE installing the hook — the proc can fire the
        // moment SetWindowsHookExW returns.
        match HOOK_SHARED.lock() {
            Ok(mut shared) => {
                *shared = Some(CycleShared {
                    requirements,
                    events,
                    up_active: AtomicBool::new(false),
                });
            }
            Err(_) => {
                let _ = ready.send(Err("cycle hook shared-state lock poisoned".into()));
                return;
            }
        }

        // SAFETY: standard WH_KEYBOARD_LL installation; the callback lives for this
        // thread's message-pump lifetime.
        let hook =
            match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(cycle_hook_proc), None, 0) } {
                Ok(hook) => hook,
                Err(err) => {
                    if let Ok(mut shared) = HOOK_SHARED.lock() {
                        shared.take();
                    }
                    let _ = ready.send(Err(format!("SetWindowsHookExW failed: {err}")));
                    return;
                }
            };

        // SAFETY: plain current-thread id read for the WM_QUIT teardown post.
        let _ = ready.send(Ok(unsafe { GetCurrentThreadId() }));

        let mut msg = MSG::default();
        // SAFETY: standard message pump; returns 0 on WM_QUIT.
        while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
            // SAFETY: forwarding messages retrieved by GetMessageW above.
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        // SAFETY: unhooking the hook installed above on the same thread.
        let _ = unsafe { UnhookWindowsHookEx(hook) };
        if let Ok(mut shared) = HOOK_SHARED.lock() {
            shared.take();
        }
    }

    fn run_dispatcher(app: AppHandle, events: Receiver<()>) {
        while events.recv().is_ok() {
            // Mirror `handle_shortcut_event`'s dispatch gates: a packaged instance
            // owning hotkeys, or the first-run wizard, must not also cycle here.
            if super::super::dev_hotkey_dispatch_is_suppressed() {
                continue;
            }
            if crate::winstt::commands::onboarding::is_onboarding_active() {
                continue;
            }
            let _ = app.emit(RECORDING_MODE_CYCLE, ());
        }
    }

    /// Low-level keyboard hook. Only ArrowUp is ever consumed; every other key is a
    /// pass-through, so this coexists with the PTT combo hook without touching its
    /// swallowing policy. Injected events (our own SendInput, automation) always
    /// pass through.
    unsafe extern "system" fn cycle_hook_proc(
        code: i32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            // SAFETY: for HC_ACTION, lparam is a valid KBDLLHOOKSTRUCT for the call.
            let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            if !kb.flags.contains(LLKHF_INJECTED) && kb.vkCode as u16 == VK_UP {
                let msg = wparam.0 as u32;
                let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                if (is_down || is_up) && handle_arrow_up(is_down) {
                    return LRESULT(1);
                }
            }
        }
        // SAFETY: standard hook-chain forwarding.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    /// Returns whether to swallow this ArrowUp event. Kept minimal — runs inside the
    /// low-level hook, which Windows expects to return quickly.
    fn handle_arrow_up(down: bool) -> bool {
        let Ok(guard) = HOOK_SHARED.lock() else {
            return false;
        };
        let Some(shared) = guard.as_ref() else {
            return false;
        };

        if down {
            if !transcribe_held(&shared.requirements) {
                // Plain ArrowUp — not part of the gesture; let it through.
                return false;
            }
            // Swallow the press (and any auto-repeat), firing the cycle exactly once
            // per physical hold.
            if !shared
                .up_active
                .swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                let _ = shared.events.send(());
            }
            true
        } else {
            // Swallow the release only if we consumed the matching press.
            shared
                .up_active
                .swap(false, std::sync::atomic::Ordering::SeqCst)
        }
    }

    /// Whether the transcribe hotkey is physically held right now.
    fn transcribe_held(requirements: &[KeyRequirement]) -> bool {
        match super::super::modifier_combo::ptt_hook_combo_engaged() {
            // Modifier-only combo backend owns (and swallows) the keys — trust its
            // tracker rather than the async key state.
            Some(engaged) => engaged,
            // Full accelerator (or no backend): the physical keys reach async state.
            None => requirements.iter().all(|r| r.is_down()),
        }
    }

    fn vk_is_down(vk: u16) -> bool {
        // SAFETY: reads the current async state for the requested virtual-key.
        (unsafe { GetAsyncKeyState(VIRTUAL_KEY(vk).0 as i32) } as u16 & 0x8000) != 0
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
        let exact = |code| Some(KeyRequirement::Exact(code));
        let any = |l, r| Some(KeyRequirement::Any(l, r));
        match token.to_ascii_lowercase().as_str() {
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
                    .then_some(KeyRequirement::Exact(0x6F + n))
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
        use super::{VK_UP, parse_requirements};

        #[test]
        fn parses_modifier_only_and_full() {
            assert_eq!(parse_requirements("LCtrl+LMeta").unwrap().len(), 2);
            assert_eq!(parse_requirements("Ctrl+Space").unwrap().len(), 2);
            assert_eq!(parse_requirements("F2").unwrap().len(), 1);
        }

        #[test]
        fn detects_arrowup_in_accelerator() {
            let reqs = parse_requirements("LCtrl+ArrowUp").unwrap();
            assert!(reqs.iter().any(|r| r.contains(VK_UP)));
            let reqs = parse_requirements("LCtrl+LMeta").unwrap();
            assert!(!reqs.iter().any(|r| r.contains(VK_UP)));
        }

        #[test]
        fn rejects_unknown_tokens() {
            assert!(parse_requirements("LCtrl+NotAKey").is_none());
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use tauri::AppHandle;

    pub fn update(_app: &AppHandle, _accelerator: &str) {}
    pub fn disable() {}
}

pub(crate) use platform::{disable, update};
