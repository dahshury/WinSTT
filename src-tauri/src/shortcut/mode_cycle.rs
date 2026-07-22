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
//! its swallowed keys never reach the other hook, so we ask that hook whether the
//! combo is engaged; otherwise this hook's own physical-key tracker is authoritative.
//!
//! The hook only ever ACTS on ArrowUp; every other key is a trivial pass-through,
//! so it does not interfere with the delicate PTT combo swallowing policy.

#[cfg(target_os = "windows")]
mod platform {
    use log::{debug, warn};
    use once_cell::sync::Lazy;
    use std::collections::HashSet;
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

    use super::super::windows_accelerator::{KeyRequirement, parse_requirements};
    use crate::winstt::commands::events::names::RECORDING_MODE_CYCLE;

    /// ArrowUp virtual-key — the "next mode" gesture key.
    const VK_UP: u16 = 0x26;

    static LISTENER: Lazy<Mutex<Option<CycleListener>>> = Lazy::new(|| Mutex::new(None));
    /// Shared state read by the hook procedure. It is published immediately
    /// before installation and marked active only after installation succeeds.
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

    struct CycleShared {
        requirements: Vec<KeyRequirement>,
        hook_active: bool,
        /// Durable physical state for full accelerators. A `WH_KEYBOARD_LL`
        /// callback runs before Windows updates `GetAsyncKeyState`, so consumers
        /// must read this tracker after the callback instead of sampling the OS
        /// state and potentially going back to sleep on a stale key-down value.
        physical_keys: PhysicalComboState,
        events: Sender<()>,
        /// False when ArrowUp is itself part of the transcribe accelerator. The
        /// hook remains installed in that case to publish PTT release callbacks,
        /// but the conflicting cycle gesture is disabled.
        cycle_enabled: bool,
        /// True between the ArrowUp key-down we consumed and its key-up, so
        /// auto-repeat while held fires exactly one cycle per physical press.
        up_active: AtomicBool,
    }

    #[derive(Default)]
    struct PhysicalComboState {
        down: HashSet<u16>,
    }

    impl PhysicalComboState {
        fn set(&mut self, vk: u16, down: bool) {
            if down {
                self.down.insert(vk);
            } else {
                self.down.remove(&vk);
            }
        }

        fn requirement_satisfied(&self, requirement: KeyRequirement) -> bool {
            match requirement {
                KeyRequirement::Exact(vk) => self.down.contains(&vk),
                KeyRequirement::Any(left, right) => {
                    self.down.contains(&left) || self.down.contains(&right)
                }
            }
        }

        fn combo_satisfied(&self, requirements: &[KeyRequirement]) -> bool {
            requirements
                .iter()
                .copied()
                .all(|requirement| self.requirement_satisfied(requirement))
        }

        /// Seed keys that were already held when the hook was installed. From
        /// the first hook callback onward, `set` is the only source of truth.
        fn seed_from_async_state(&mut self, requirements: &[KeyRequirement]) {
            self.down.clear();
            for requirement in requirements {
                match *requirement {
                    KeyRequirement::Exact(vk) => self.seed_vk(vk),
                    KeyRequirement::Any(left, right) => {
                        self.seed_vk(left);
                        self.seed_vk(right);
                    }
                }
            }
        }

        fn seed_vk(&mut self, vk: u16) {
            // SAFETY: one initial state read for a parsed virtual-key. Runtime
            // transitions are tracked from the low-level hook, not from this API.
            let down = (unsafe { GetAsyncKeyState(VIRTUAL_KEY(vk).0 as i32) } as u16 & 0x8000) != 0;
            self.set(vk, down);
        }
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
        // with the accelerator (and swallowing ArrowUp would break PTT). Keep the
        // hook for event-driven PTT release observation, but disable cycling.
        let cycle_enabled = !requirements.iter().any(|r| r.contains(VK_UP));
        if !cycle_enabled {
            debug!("[mode-cycle] transcribe hotkey uses ArrowUp; cycle gesture disabled");
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

        match install(app, requirements, cycle_enabled) {
            Ok(hook) => {
                debug!("[mode-cycle] armed cycle gesture for transcribe hotkey '{accelerator}'");
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

    /// Durable full-accelerator state owned by the low-level hook. `None` means
    /// the hook is unavailable and callers must use their bounded polling fallback.
    pub fn ptt_hook_combo_engaged() -> Option<bool> {
        let shared = HOOK_SHARED.lock().ok()?;
        let shared = shared.as_ref()?;
        if !shared.hook_active {
            return None;
        }
        Some(shared.physical_keys.combo_satisfied(&shared.requirements))
    }

    fn install(
        app: &AppHandle,
        requirements: Vec<KeyRequirement>,
        cycle_enabled: bool,
    ) -> Result<HookHandle, String> {
        let (event_tx, event_rx) = channel::<()>();
        let (ready_tx, ready_rx) = channel::<Result<u32, String>>();

        let hook_thread = thread::Builder::new()
            .name("winstt-mode-cycle-hook".into())
            .spawn(move || run_hook_thread(requirements, cycle_enabled, event_tx, ready_tx))
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
        cycle_enabled: bool,
        events: Sender<()>,
        ready: Sender<Result<u32, String>>,
    ) {
        // Publish shared state BEFORE installing the hook — the proc can fire the
        // moment SetWindowsHookExW returns.
        match HOOK_SHARED.lock() {
            Ok(mut shared) => {
                *shared = Some(CycleShared {
                    requirements,
                    hook_active: false,
                    physical_keys: PhysicalComboState::default(),
                    events,
                    cycle_enabled,
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

        // Snapshot keys held before installation. The hook thread has not begun
        // pumping callbacks yet, so queued transitions will be applied after this
        // seed and become the authoritative state before any waiter is notified.
        if let Ok(mut shared) = HOOK_SHARED.lock()
            && let Some(shared) = shared.as_mut()
        {
            let requirements = shared.requirements.clone();
            shared.physical_keys.seed_from_async_state(&requirements);
            shared.hook_active = true;
        }

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
        // A watchdog that observed the hook as available may be parked without
        // a timeout. Wake it so it can switch to the hook-unavailable fallback.
        super::super::ptt_release_watchdog::physical_key_transition();
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
                if is_down || is_up {
                    record_ptt_key_transition(kb.vkCode as u16, is_down);
                }
                if (is_down || is_up) && handle_arrow_up(is_down) {
                    return LRESULT(1);
                }
            } else if !kb.flags.contains(LLKHF_INJECTED) {
                let msg = wparam.0 as u32;
                if msg == WM_KEYDOWN
                    || msg == WM_SYSKEYDOWN
                    || msg == WM_KEYUP
                    || msg == WM_SYSKEYUP
                {
                    record_ptt_key_transition(
                        kb.vkCode as u16,
                        msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN,
                    );
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
        if !shared.cycle_enabled {
            return false;
        }

        if down {
            let transcribe_held = match super::super::modifier_combo::ptt_hook_combo_engaged() {
                Some(engaged) => engaged,
                None => shared.physical_keys.combo_satisfied(&shared.requirements),
            };
            if !transcribe_held {
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

    fn record_ptt_key_transition(vk: u16, down: bool) {
        // Publish the durable state before waking the watchdog. Release the hook
        // lock first because the waiter immediately queries this state.
        let watched = HOOK_SHARED.lock().is_ok_and(|mut shared| {
            let Some(state) = shared.as_mut() else {
                return false;
            };
            let watched = state.requirements.iter().any(|r| r.contains(vk));
            if watched {
                state.physical_keys.set(vk, down);
            }
            watched
        });
        if watched {
            super::super::ptt_release_watchdog::physical_key_transition();
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{PhysicalComboState, parse_requirements};

        #[test]
        fn full_accelerator_release_is_visible_immediately_from_hook_state() {
            let requirements = parse_requirements("Ctrl+Space").unwrap();
            let mut state = PhysicalComboState::default();
            state.set(0xA2, true); // left Ctrl
            state.set(0x20, true); // Space
            assert!(state.combo_satisfied(&requirements));

            // This is applied inside the low-level key-up callback, before
            // GetAsyncKeyState changes. The waiter must already see released.
            state.set(0x20, false);
            assert!(!state.combo_satisfied(&requirements));
        }

        #[test]
        fn sided_modifier_requirement_tracks_either_physical_key() {
            let requirements = parse_requirements("Ctrl+Space").unwrap();
            let mut state = PhysicalComboState::default();
            state.set(0xA3, true); // right Ctrl satisfies generic Ctrl
            state.set(0x20, true);
            assert!(state.combo_satisfied(&requirements));
            state.set(0xA3, false);
            assert!(!state.combo_satisfied(&requirements));
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use tauri::AppHandle;

    pub fn update(_app: &AppHandle, _accelerator: &str) {}
    pub fn disable() {}
    pub fn ptt_hook_combo_engaged() -> Option<bool> {
        None
    }
}

pub(crate) use platform::{disable, ptt_hook_combo_engaged, update};
