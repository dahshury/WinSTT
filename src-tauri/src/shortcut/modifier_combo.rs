#[cfg(target_os = "windows")]
mod platform {
    use log::{debug, error, info, warn};
    use once_cell::sync::Lazy;
    use std::sync::mpsc::{Receiver, Sender, channel};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use std::thread::{self, JoinHandle};
    use std::time::Duration;
    use tauri::AppHandle;
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT,
        KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN,
        VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG,
        PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
        WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    use crate::settings::ShortcutBinding;

    const PTT_BINDING: &str = "transcribe";
    const POLL_INTERVAL: Duration = Duration::from_millis(8);
    /// Unassigned virtual key injected as a click to mark a Win press as "used"
    /// so its release can't open the Start menu (same trick PowerToys uses).
    const VK_DISGUISE: u16 = 0xE8;

    static LISTENER: Lazy<Mutex<Option<ListenerHandle>>> = Lazy::new(|| Mutex::new(None));
    /// Shared state for the low-level keyboard hook. `Some` exactly while the hook
    /// backend is installed; the hook procedure and the release watchdog read it.
    static HOOK_SHARED: Lazy<Mutex<Option<HookShared>>> = Lazy::new(|| Mutex::new(None));

    struct ListenerHandle {
        accelerator: String,
        _backend: ListenerBackend,
    }

    /// RAII holder: the handles are never read, only dropped — their `Drop` stops
    /// the hook/polling threads when the listener is replaced or unregistered.
    enum ListenerBackend {
        /// Blocking WH_KEYBOARD_LL hook: the combo is consumed system-wide, so the
        /// foreground app and the OS (Start menu!) never see the held modifiers.
        Hook(#[allow(dead_code)] HookHandle),
        /// GetAsyncKeyState polling: observes only — the combo leaks to other apps.
        /// Fallback for when the hook cannot be installed.
        Poll(#[allow(dead_code)] PollHandle),
    }

    // ── polling backend (fallback) ─────────────────────────────────────────────

    struct PollHandle {
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for PollHandle {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    // ── hook backend ───────────────────────────────────────────────────────────

    struct HookHandle {
        hook_thread_id: u32,
        hook_thread: Option<JoinHandle<()>>,
        dispatch_thread: Option<JoinHandle<()>>,
    }

    impl Drop for HookHandle {
        fn drop(&mut self) {
            // WM_QUIT ends the hook thread's message pump; it unhooks and clears
            // HOOK_SHARED, which closes the event channel and ends the dispatcher
            // (the dispatcher sends a final "released" if the combo was engaged).
            // SAFETY: posting a thread message to the pump thread we spawned.
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

        // Prefer the blocking hook: the combo is consumed system-wide (nothing is
        // forwarded to the foreground app / the OS while PTT is held). Fall back to
        // the observe-only polling listener when the hook cannot be installed.
        let backend = match start_hook_listener(app, &combo) {
            Ok(handle) => {
                info!(
                    "registered modifier-only PTT shortcut '{}' (blocking keyboard hook)",
                    binding.current_binding
                );
                ListenerBackend::Hook(handle)
            }
            Err(err) => {
                warn!(
                    "modifier-only PTT hook unavailable ({err}); falling back to polling listener — the combo will still reach other apps"
                );
                ListenerBackend::Poll(start_poll_listener(app, combo)?)
            }
        };

        debug!(
            "registered modifier-only PTT shortcut '{}'",
            binding.current_binding
        );
        *listener = Some(ListenerHandle {
            accelerator: binding.current_binding.clone(),
            _backend: backend,
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

    /// Whether the blocking PTT hook currently sees any combo key physically held.
    /// `None` when the hook backend is not active (polling fallback, or a full
    /// hotkey handled by the Tauri backend). Callers that poll `GetAsyncKeyState`
    /// (the PTT release watchdog) MUST prefer this — the hook swallows the combo's
    /// physical events, so the async key state never sees them go down.
    pub fn ptt_hook_combo_key_down() -> Option<bool> {
        let guard = HOOK_SHARED.lock().ok()?;
        let shared = guard.as_ref()?;
        Some(shared.tracker.any_key_down())
    }

    /// Whether the blocking PTT hook currently sees the FULL combo engaged (every
    /// required modifier physically down). `None` when the hook backend is not
    /// active. The cycle-gesture hook (`mode_cycle`) prefers this over
    /// `GetAsyncKeyState` because the combo hook swallows the modifier-only PTT
    /// keys before they reach the async key state — so polling would report "not
    /// held" for exactly the modifier-only combos this path exists to serve.
    pub fn ptt_hook_combo_engaged() -> Option<bool> {
        let guard = HOOK_SHARED.lock().ok()?;
        let shared = guard.as_ref()?;
        Some(shared.tracker.combo_satisfied())
    }

    // ── polling listener (observe-only fallback) ───────────────────────────────

    fn start_poll_listener(app: &AppHandle, combo: ModifierCombo) -> Result<PollHandle, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let app = app.clone();
        let thread = thread::Builder::new()
            .name("winstt-ptt-modifier-hotkey".into())
            .spawn(move || run_listener(app, combo, thread_stop))
            .map_err(|err| format!("failed to start modifier-combo listener: {err}"))?;
        Ok(PollHandle {
            stop,
            thread: Some(thread),
        })
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

    // ── blocking hook listener ─────────────────────────────────────────────────

    /// Combo press/release transitions produced by [`ComboTracker`] and consumed by
    /// the dispatcher thread (which runs the PTT action off the hook thread).
    enum HookEvent {
        /// The full combo just engaged. `leaked_vks` are combo keys whose key-DOWNs
        /// already passed through to the OS before the combo completed (a lone
        /// Ctrl press can't be swallowed — it might be the start of Ctrl+C).
        Activated {
            leaked_vks: Vec<u16>,
        },
        Deactivated,
    }

    /// Pure decision core for the blocking hook — no OS calls, unit-testable.
    ///
    /// Swallowing policy: a lone combo modifier passes through (it may be part of a
    /// normal shortcut), but the key-down that COMPLETES the combo — and every combo
    /// key event after that — is swallowed. Keys engaged in the combo stay "poisoned"
    /// (still swallowed) until their physical release, even after the combo breaks,
    /// so a released-out-of-order Win key can't re-assert itself via auto-repeat and
    /// arm the Start menu.
    struct ComboTracker {
        /// One entry per required modifier; inner list = acceptable VKs (L/R variants).
        groups: Vec<Vec<u16>>,
        all_vks: Vec<u16>,
        physical_down: Vec<u16>,
        poisoned: Vec<u16>,
        leaked: Vec<u16>,
        active: bool,
    }

    impl ComboTracker {
        fn new(groups: Vec<Vec<u16>>) -> Self {
            let all_vks = groups.iter().flatten().copied().collect();
            Self {
                groups,
                all_vks,
                physical_down: Vec::new(),
                poisoned: Vec::new(),
                leaked: Vec::new(),
                active: false,
            }
        }

        fn combo_satisfied(&self) -> bool {
            self.groups
                .iter()
                .all(|group| group.iter().any(|vk| self.physical_down.contains(vk)))
        }

        fn any_key_down(&self) -> bool {
            !self.physical_down.is_empty()
        }

        /// Process a PHYSICAL key event for `vk`. Returns `(swallow, transition)`.
        fn process(&mut self, vk: u16, down: bool) -> (bool, Option<HookEvent>) {
            if !self.all_vks.contains(&vk) {
                return (false, None);
            }

            if down {
                if !self.physical_down.contains(&vk) {
                    self.physical_down.push(vk);
                }
                if self.active {
                    // Combo engaged: swallow repeats and late presses of combo keys.
                    if !self.poisoned.contains(&vk) {
                        self.poisoned.push(vk);
                    }
                    return (true, None);
                }
                if self.poisoned.contains(&vk) {
                    // Auto-repeat of a key still held after the combo broke.
                    return (true, None);
                }
                if self.combo_satisfied() {
                    self.active = true;
                    let leaked_vks = std::mem::take(&mut self.leaked);
                    for &leaked in &leaked_vks {
                        if !self.poisoned.contains(&leaked) {
                            self.poisoned.push(leaked);
                        }
                    }
                    if !self.poisoned.contains(&vk) {
                        self.poisoned.push(vk);
                    }
                    return (true, Some(HookEvent::Activated { leaked_vks }));
                }
                // Lone modifier: pass through, but remember that it leaked so it can
                // be lifted out of the logical key state if the combo completes.
                if !self.leaked.contains(&vk) {
                    self.leaked.push(vk);
                }
                (false, None)
            } else {
                self.physical_down.retain(|&down_vk| down_vk != vk);
                self.leaked.retain(|&leaked_vk| leaked_vk != vk);
                let was_poisoned = self.poisoned.contains(&vk);
                self.poisoned.retain(|&poisoned_vk| poisoned_vk != vk);

                let transition = if self.active && !self.combo_satisfied() {
                    self.active = false;
                    Some(HookEvent::Deactivated)
                } else {
                    None
                };
                // Swallow the release of keys we swallowed the press/hold of; a key
                // that passed through as a lone modifier gets its release passed too.
                (was_poisoned, transition)
            }
        }
    }

    struct HookShared {
        tracker: ComboTracker,
        events: Sender<HookEvent>,
    }

    fn combo_groups(combo: &ModifierCombo) -> Vec<Vec<u16>> {
        combo
            .requirements
            .iter()
            .map(|requirement| match requirement {
                ModifierRequirement::Exact(vk) => vec![vk.0],
                ModifierRequirement::Any(left, right) => vec![left.0, right.0],
            })
            .collect()
    }

    fn start_hook_listener(app: &AppHandle, combo: &ModifierCombo) -> Result<HookHandle, String> {
        let (event_tx, event_rx) = channel::<HookEvent>();
        let (ready_tx, ready_rx) = channel::<Result<u32, String>>();
        let groups = combo_groups(combo);

        let hook_thread = thread::Builder::new()
            .name("winstt-ptt-keyboard-hook".into())
            .spawn(move || run_hook_thread(groups, event_tx, ready_tx))
            .map_err(|err| format!("failed to start keyboard-hook thread: {err}"))?;

        let hook_thread_id = match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(thread_id)) => thread_id,
            Ok(Err(err)) => {
                let _ = hook_thread.join();
                return Err(err);
            }
            Err(_) => return Err("keyboard-hook thread did not report readiness".into()),
        };

        let dispatch_app = app.clone();
        let label = combo.label.clone();
        let dispatch_thread = thread::Builder::new()
            .name("winstt-ptt-hook-dispatch".into())
            .spawn(move || run_hook_dispatcher(dispatch_app, label, event_rx));
        let dispatch_thread = match dispatch_thread {
            Ok(thread) => thread,
            Err(err) => {
                // Tear the hook down again so we don't leave a swallowing hook with
                // nobody dispatching PTT events.
                // SAFETY: posting a thread message to the pump thread spawned above.
                let _ =
                    unsafe { PostThreadMessageW(hook_thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
                let _ = hook_thread.join();
                return Err(format!("failed to start hook dispatcher: {err}"));
            }
        };

        Ok(HookHandle {
            hook_thread_id,
            hook_thread: Some(hook_thread),
            dispatch_thread: Some(dispatch_thread),
        })
    }

    fn run_hook_thread(
        groups: Vec<Vec<u16>>,
        events: Sender<HookEvent>,
        ready: Sender<Result<u32, String>>,
    ) {
        // Publish the shared state BEFORE installing the hook: the hook procedure can
        // fire the moment SetWindowsHookExW returns.
        match HOOK_SHARED.lock() {
            Ok(mut shared) => {
                *shared = Some(HookShared {
                    tracker: ComboTracker::new(groups),
                    events,
                });
            }
            Err(_) => {
                let _ = ready.send(Err("hook shared-state lock poisoned".into()));
                return;
            }
        }

        // SAFETY: standard WH_KEYBOARD_LL installation; the callback lives for the
        // program's lifetime and this thread pumps messages while the hook is set.
        let hook = match unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(ptt_hook_proc), None, 0) }
        {
            Ok(hook) => hook,
            Err(err) => {
                if let Ok(mut shared) = HOOK_SHARED.lock() {
                    shared.take();
                }
                let _ = ready.send(Err(format!("SetWindowsHookExW failed: {err}")));
                return;
            }
        };

        // SAFETY: plain read of the current thread id for the WM_QUIT teardown post.
        let _ = ready.send(Ok(unsafe { GetCurrentThreadId() }));

        let mut msg = MSG::default();
        // SAFETY: standard message pump; returns 0 on WM_QUIT and -1 on error.
        while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
            // SAFETY: forwarding messages retrieved by GetMessageW above.
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        // SAFETY: unhooking the hook installed above on the same thread.
        let _ = unsafe { UnhookWindowsHookEx(hook) };
        // Dropping the shared state closes the event channel → the dispatcher exits
        // (emitting a final release if the combo was still engaged).
        if let Ok(mut shared) = HOOK_SHARED.lock() {
            shared.take();
        }
    }

    fn run_hook_dispatcher(app: AppHandle, label: String, events: Receiver<HookEvent>) {
        let mut engaged = false;
        while let Ok(event) = events.recv() {
            match event {
                HookEvent::Activated { leaked_vks } => {
                    neutralize_leaked_modifiers(&leaked_vks);
                    engaged = true;
                    dispatch(&app, &label, true);
                }
                HookEvent::Deactivated => {
                    engaged = false;
                    dispatch(&app, &label, false);
                }
            }
        }
        // Channel closed (rebind/unregister) while the combo was still held: end the
        // PTT session instead of wedging the recorder.
        if engaged {
            dispatch(&app, &label, false);
        }
    }

    /// Low-level keyboard hook: swallows the PTT combo's PHYSICAL events per the
    /// [`ComboTracker`] policy. Injected events (our own cleanup SendInput, enigo
    /// typing, other automation) always pass through — only real keystrokes count.
    unsafe extern "system" fn ptt_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            // SAFETY: for WH_KEYBOARD_LL with code == HC_ACTION, lparam points to a
            // valid KBDLLHOOKSTRUCT for the duration of the call.
            let kb = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            if !kb.flags.contains(LLKHF_INJECTED) {
                let msg = wparam.0 as u32;
                let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                if (is_down || is_up) && swallow_physical_event(kb.vkCode as u16, is_down) {
                    return LRESULT(1);
                }
            }
        }
        // SAFETY: standard hook-chain forwarding.
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    /// Feed one physical key event to the tracker; returns whether to swallow it.
    /// Kept minimal — this runs inside the low-level hook, which Windows expects to
    /// return quickly (transitions are handed to the dispatcher thread via channel).
    fn swallow_physical_event(vk: u16, down: bool) -> bool {
        let Ok(mut guard) = HOOK_SHARED.lock() else {
            return false;
        };
        let Some(shared) = guard.as_mut() else {
            return false;
        };
        let (swallow, transition) = shared.tracker.process(vk, down);
        if let Some(transition) = transition {
            let _ = shared.events.send(transition);
        }
        swallow
    }

    /// The first modifier of a combo reaches the OS before the combo completes (a
    /// lone Ctrl/Win press can't be swallowed — it might be the start of a normal
    /// shortcut). Once the combo engages, lift those leaked modifiers back OUT of
    /// the logical keyboard state: apps stop seeing Ctrl/Win held during dictation,
    /// and a disguise click keeps a leaked Win-down/up pair from opening Start.
    fn neutralize_leaked_modifiers(leaked_vks: &[u16]) {
        if leaked_vks.is_empty() {
            return;
        }
        let mut inputs = Vec::with_capacity(leaked_vks.len() + 2);
        if leaked_vks
            .iter()
            .any(|&vk| vk == VK_LWIN.0 || vk == VK_RWIN.0)
        {
            inputs.push(key_input(VK_DISGUISE, KEYBD_EVENT_FLAGS(0)));
            inputs.push(key_input(VK_DISGUISE, KEYEVENTF_KEYUP));
        }
        for &vk in leaked_vks {
            inputs.push(key_input(vk, KEYEVENTF_KEYUP));
        }
        // SAFETY: `inputs` is a valid array of INPUT values for SendInput.
        unsafe {
            let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    // ── shared parsing / input helpers ─────────────────────────────────────────

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

    fn key_input(vk: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk),
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    /// Polling-fallback Start-menu suppression: a disguise click marks the physical
    /// Win press as "used" so its release doesn't open Start. (The hook backend
    /// doesn't need this — the Win key-down is swallowed before the OS sees it.)
    fn suppress_start_menu_for_win_combo() {
        let inputs = [
            key_input(VK_DISGUISE, KEYBD_EVENT_FLAGS(0)),
            key_input(VK_DISGUISE, KEYEVENTF_KEYUP),
        ];
        // SAFETY: `inputs` is a valid array of INPUT values for SendInput.
        unsafe {
            let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{ComboTracker, HookEvent, is_modifier_only_accelerator};

        const VK_LCTRL: u16 = 0xA2;
        const VK_RCTRL: u16 = 0xA3;
        const VK_LWIN: u16 = 0x5B;

        fn ctrl_win_tracker() -> ComboTracker {
            ComboTracker::new(vec![vec![VK_LCTRL, VK_RCTRL], vec![VK_LWIN]])
        }

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

        #[test]
        fn lone_modifier_passes_through() {
            let mut tracker = ctrl_win_tracker();
            let (swallow, transition) = tracker.process(VK_LCTRL, true);
            assert!(!swallow);
            assert!(transition.is_none());
            // Its release passes through too (normal Ctrl+C usage stays intact).
            let (swallow, transition) = tracker.process(VK_LCTRL, false);
            assert!(!swallow);
            assert!(transition.is_none());
        }

        #[test]
        fn completing_key_is_swallowed_and_reports_leak() {
            let mut tracker = ctrl_win_tracker();
            let _ = tracker.process(VK_LCTRL, true); // leaks through
            let (swallow, transition) = tracker.process(VK_LWIN, true);
            assert!(swallow);
            match transition {
                Some(HookEvent::Activated { leaked_vks }) => assert_eq!(leaked_vks, vec![VK_LCTRL]),
                _ => panic!("expected activation"),
            }
        }

        #[test]
        fn repeats_and_releases_are_swallowed_while_engaged() {
            let mut tracker = ctrl_win_tracker();
            let _ = tracker.process(VK_LCTRL, true);
            let _ = tracker.process(VK_LWIN, true);

            // Auto-repeats of both keys are swallowed.
            assert!(tracker.process(VK_LCTRL, true).0);
            assert!(tracker.process(VK_LWIN, true).0);

            // Releasing Win breaks the combo (deactivation) and the up is swallowed.
            let (swallow, transition) = tracker.process(VK_LWIN, false);
            assert!(swallow);
            assert!(matches!(transition, Some(HookEvent::Deactivated)));

            // Ctrl is still physically held but poisoned: repeat + release swallowed.
            assert!(tracker.process(VK_LCTRL, true).0);
            let (swallow, transition) = tracker.process(VK_LCTRL, false);
            assert!(swallow);
            assert!(transition.is_none());

            // After full release a fresh Ctrl press passes through again.
            assert!(!tracker.process(VK_LCTRL, true).0);
        }

        #[test]
        fn re_press_while_other_key_held_reactivates() {
            let mut tracker = ctrl_win_tracker();
            let _ = tracker.process(VK_LCTRL, true);
            let _ = tracker.process(VK_LWIN, true);
            let _ = tracker.process(VK_LWIN, false); // deactivates; Ctrl stays poisoned

            let (swallow, transition) = tracker.process(VK_LWIN, true);
            assert!(swallow);
            match transition {
                // Ctrl never un-leaked (it stayed poisoned), so nothing new leaked.
                Some(HookEvent::Activated { leaked_vks }) => assert!(leaked_vks.is_empty()),
                _ => panic!("expected reactivation"),
            }
        }

        #[test]
        fn any_group_accepts_either_side() {
            let mut tracker = ctrl_win_tracker();
            let _ = tracker.process(VK_RCTRL, true);
            let (swallow, transition) = tracker.process(VK_LWIN, true);
            assert!(swallow);
            match transition {
                Some(HookEvent::Activated { leaked_vks }) => assert_eq!(leaked_vks, vec![VK_RCTRL]),
                _ => panic!("expected activation via right ctrl"),
            }
        }

        #[test]
        fn win_first_leak_is_reported_for_start_menu_disguise() {
            let mut tracker = ctrl_win_tracker();
            let _ = tracker.process(VK_LWIN, true); // Win leaks (arms Start menu)
            let (_, transition) = tracker.process(VK_LCTRL, true);
            match transition {
                Some(HookEvent::Activated { leaked_vks }) => assert_eq!(leaked_vks, vec![VK_LWIN]),
                _ => panic!("expected activation"),
            }
        }

        #[test]
        fn non_combo_keys_are_never_swallowed() {
            let mut tracker = ctrl_win_tracker();
            let _ = tracker.process(VK_LCTRL, true);
            let _ = tracker.process(VK_LWIN, true); // engaged
            assert!(!tracker.process(0x43, true).0); // 'C' key passes through
            assert!(!tracker.process(0x43, false).0);
        }

        #[test]
        fn tracker_reports_physical_hold_for_watchdog() {
            let mut tracker = ctrl_win_tracker();
            assert!(!tracker.any_key_down());
            let _ = tracker.process(VK_LCTRL, true);
            let _ = tracker.process(VK_LWIN, true);
            assert!(tracker.any_key_down());
            let _ = tracker.process(VK_LWIN, false);
            assert!(tracker.any_key_down()); // Ctrl still physically held
            let _ = tracker.process(VK_LCTRL, false);
            assert!(!tracker.any_key_down());
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

    pub fn ptt_hook_combo_key_down() -> Option<bool> {
        None
    }

    pub fn ptt_hook_combo_engaged() -> Option<bool> {
        None
    }
}

pub(crate) use platform::{
    is_modifier_only_accelerator, ptt_hook_combo_engaged, ptt_hook_combo_key_down,
    register_if_modifier_only, unregister_if_modifier_only,
};
