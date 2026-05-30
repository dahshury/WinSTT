// DRAFT PORT — not yet compiled. Source: frontend/electron/native/src/winstt-paste.c
// + frontend/electron/lib/paste.ts
//
// Terminal-aware paste extension. Handy's `clipboard.rs::paste` already does
// the clipboard-sandwich Ctrl+V (and supports an explicit CtrlShiftV
// PasteMethod), but it does NOT auto-detect when the foreground window is a
// terminal that swallows plain Ctrl+V. winstt-paste.exe does
// (TERMINAL_CLASSES / TERMINAL_EXES via GetForegroundWindow + GetClassNameW +
// QueryFullProcessImageNameW). This module ports that detection to Rust so the
// Rust paste path can pick Ctrl+Shift+V for terminals WITHOUT editing
// clipboard.rs.
//
// Also ports paste.ts's safety machinery as a PURE state machine:
//   - circuit breaker: PASTE_TIMEOUT_MS (2500) trip → PASTE_COOLDOWN_MS
//     (30_000) silent-drop window (AV / accessibility hook stalls the OS
//     input queue);
//   - inter-paste pacing: PASTE_MIN_GAP_MS (350);
//   - clipboard sandwich delays: SETTLE (60) / RESTORE (120);
//   - paste-guard tail: PASTE_GUARD_TAIL_MS (50).
//
// The terminal detection (table membership) and the breaker/pacing math are
// fully implemented + tested. The Win32 GetForegroundWindow/GetClassNameW/
// QueryFullProcessImageNameW calls are a thin sketch (DRAFT) — wire during the
// compile loop using the `windows` crate (already a dep; the UI/WindowsAnd-
// Messaging + Foundation features Handy enables cover GetForegroundWindow /
// GetClassNameW; QueryFullProcessImageNameW needs Win32_System_Threading).

// ──────────────────── terminal detection tables ───────────────────────
//
// Verbatim from winstt-paste.c. Matched case-insensitively.

/// Window class names that require Ctrl+Shift+V (their Ctrl+V is mapped to
/// something else, e.g. SIGINT-adjacent shortcuts). Mirrors TERMINAL_CLASSES.
const TERMINAL_CLASSES: &[&str] = &[
    "ConsoleWindowClass",
    "CASCADIA_HOSTING_WINDOW_CLASS",
    "mintty",
    "VirtualConsoleClass",
    "PuTTY",
    "Alacritty",
    "org.wezfurlong.wezterm",
    "Hyper",
    "TMobaXterm",
];

/// Process exe basenames that are terminals even when their window class isn't
/// recognized. Mirrors TERMINAL_EXES.
const TERMINAL_EXES: &[&str] = &[
    "termius.exe",
    "tabby.exe",
    "wave.exe",
    "rio.exe",
    "windowsterminal.exe",
];

/// True when a window class name is a known terminal class (case-insensitive).
/// Mirrors is_terminal_class.
pub fn is_terminal_class(class_name: &str) -> bool {
    TERMINAL_CLASSES
        .iter()
        .any(|c| c.eq_ignore_ascii_case(class_name))
}

/// True when an exe basename is a known terminal exe (case-insensitive).
/// Mirrors is_terminal_exe.
pub fn is_terminal_exe(exe_name: &str) -> bool {
    let base = exe_name.rsplit(['\\', '/']).next().unwrap_or(exe_name);
    TERMINAL_EXES.iter().any(|e| e.eq_ignore_ascii_case(base))
}

/// Decide whether the foreground (class, exe) pair is a terminal. Class is
/// checked first (cheaper + more specific), then the exe fallback. Mirrors the
/// winstt-paste.c main(): `terminal = is_terminal_class(...) || (!terminal &&
/// is_terminal_exe(...))`.
pub fn is_terminal_foreground(class_name: &str, exe_name: &str) -> bool {
    is_terminal_class(class_name) || is_terminal_exe(exe_name)
}

/// The paste keystroke to send. WinSTT only ever auto-picks between these two:
/// plain Ctrl+V everywhere, Ctrl+Shift+V for terminals. (Direct typing is the
/// separate `--type` fallback, modeled in the fallback chain below.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteKeystroke {
    CtrlV,
    CtrlShiftV,
}

/// Pick the paste keystroke for a foreground window. Mirrors the auto-pick in
/// winstt-paste.c (Ctrl+Shift+V for terminals, Ctrl+V otherwise).
pub fn keystroke_for_foreground(class_name: &str, exe_name: &str) -> PasteKeystroke {
    if is_terminal_foreground(class_name, exe_name) {
        PasteKeystroke::CtrlShiftV
    } else {
        PasteKeystroke::CtrlV
    }
}

// ── foreground-window probe sketch (DRAFT — wire during compile loop) ──
//
// #[cfg(windows)]
// pub fn probe_foreground() -> ForegroundInfo {
//   use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetClassNameW, GetWindowThreadProcessId};
//   use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW,
//       PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_NAME_WIN32};
//   unsafe {
//     let hwnd = GetForegroundWindow();
//     let mut class_buf = [0u16; 256];
//     let n = GetClassNameW(hwnd, &mut class_buf);
//     let class = String::from_utf16_lossy(&class_buf[..n as usize]);
//     let mut pid = 0u32;
//     GetWindowThreadProcessId(hwnd, Some(&mut pid));
//     let exe = open_and_query_image_name(pid);   // QueryFullProcessImageNameW → basename
//     ForegroundInfo { class, exe }
//   }
// }
// #[cfg(not(windows))]
// pub fn probe_foreground() -> ForegroundInfo { ForegroundInfo::default() }
//
// QueryFullProcessImageNameW needs the Win32_System_Threading feature added to
// the `windows` dep in Cargo.toml (see crateDeps). Mirror winstt-context.c's
// dual resolver (OpenProcess first; PROCESS_QUERY_LIMITED_INFORMATION) — an
// elevated foreground window may deny the handle, in which case fall back to a
// Toolhelp32 snapshot like get_process_exe in winstt-context.c.

/// Foreground window descriptor. Filled by the Win32 probe; injected as a fake
/// in tests so the keystroke logic is testable without a desktop.
#[derive(Debug, Clone, Default)]
pub struct ForegroundInfo {
    pub class: String,
    pub exe: String,
}

impl ForegroundInfo {
    pub fn keystroke(&self) -> PasteKeystroke {
        keystroke_for_foreground(&self.class, &self.exe)
    }
}

// ───────────────────────── fallback chain ─────────────────────────────
//
// paste.ts's tryClipboardThenTyping: primary clipboard+Ctrl+V, then the
// per-char `--type` (KEYEVENTF_UNICODE) fallback when Ctrl+V is swallowed
// (Vim normal mode, some IMEs, DirectInput games). Modeled as an ordered
// strategy list so the manager runs them in turn until one succeeds.

/// One attempt in the paste fallback chain. Mirrors the primary/fallback
/// split in tryClipboardThenTyping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteStrategy {
    /// Clipboard sandwich + the chosen keystroke (Ctrl+V or Ctrl+Shift+V).
    ClipboardKeystroke(PasteKeystroke),
    /// Per-char SendInput KEYEVENTF_UNICODE (`--type`); clipboard untouched.
    DirectType,
}

/// Build the ordered fallback chain for a foreground window: primary
/// clipboard+auto-keystroke, then direct typing. Mirrors tryClipboardThenTyping.
pub fn build_fallback_chain(foreground: &ForegroundInfo) -> Vec<PasteStrategy> {
    vec![
        PasteStrategy::ClipboardKeystroke(foreground.keystroke()),
        PasteStrategy::DirectType,
    ]
}

// ─────────────── circuit-breaker + pacing (pure) ──────────────────────
//
// Ported from paste.ts. The breaker drops pastes silently for a cooldown
// window after a timeout (an AV / accessibility hook stalling the OS input
// queue would otherwise hang every subsequent paste). Pacing enforces a
// minimum gap between pastes. Driven by a monotonic-millis clock the caller
// supplies (Instant::elapsed in prod, a fake clock in tests).

/// paste.ts constants, in milliseconds.
pub const PASTE_TIMEOUT_MS: u64 = 2500;
pub const PASTE_COOLDOWN_MS: u64 = 30_000;
pub const PASTE_MIN_GAP_MS: u64 = 350;
pub const CLIPBOARD_SETTLE_DELAY_MS: u64 = 60;
pub const CLIPBOARD_RESTORE_DELAY_MS: u64 = 120;
pub const PASTE_GUARD_TAIL_MS: u64 = 50;

/// Why a paste was refused (for logging / tests). Mirrors the silent-drop
/// reasons in paste.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteRefusal {
    /// In the cooldown window after a timeout trip.
    CircuitOpen,
    /// Too soon after the previous paste (< PASTE_MIN_GAP_MS).
    Paced,
}

/// The decision the breaker returns when asked to gate a paste.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteGate {
    Allow,
    Refuse(PasteRefusal),
}

/// Pure circuit-breaker + pacer. The manager owns one instance and calls
/// `gate(now)` before each paste; on a timeout it calls `trip(now)`; on
/// success `record_success(now)`.
#[derive(Debug, Default)]
pub struct PasteBreaker {
    /// Monotonic-millis timestamp the cooldown lasts until (0 = closed).
    cooldown_until: u64,
    /// Monotonic-millis timestamp of the last successful/attempted paste.
    last_paste_at: Option<u64>,
}

impl PasteBreaker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decide whether a paste may proceed at `now` (monotonic millis).
    /// Order: circuit-open check first (a tripped breaker overrides pacing),
    /// then the min-gap pacing. Mirrors paste.ts's enqueuePaste guards.
    pub fn gate(&self, now: u64) -> PasteGate {
        if now < self.cooldown_until {
            return PasteGate::Refuse(PasteRefusal::CircuitOpen);
        }
        if let Some(last) = self.last_paste_at {
            if now.saturating_sub(last) < PASTE_MIN_GAP_MS {
                return PasteGate::Refuse(PasteRefusal::Paced);
            }
        }
        PasteGate::Allow
    }

    /// Open the breaker for PASTE_COOLDOWN_MS after a paste timed out. Mirrors
    /// the cooldown set in paste.ts's finishBinaryRun timeout path.
    pub fn trip(&mut self, now: u64) {
        self.cooldown_until = now + PASTE_COOLDOWN_MS;
    }

    /// Record a paste attempt's timestamp for pacing. Call on both success and
    /// (non-timeout) completion so back-to-back pastes are spaced.
    pub fn record_success(&mut self, now: u64) {
        self.last_paste_at = Some(now);
    }

    /// Whether the breaker is currently open (in cooldown) at `now`.
    pub fn is_open(&self, now: u64) -> bool {
        now < self.cooldown_until
    }
}

/// The serialized paste-sandwich timeline a single paste runs through, in
/// milliseconds. The manager sleeps these between steps; modeled here so the
/// timing contract is a single source of truth and testable. Mirrors the
/// 6-step sandwich in paste.ts (capture → write → settle → keystroke →
/// restore-delay → restore) plus the guard tail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SandwichTiming {
    pub settle_ms: u64,
    pub restore_ms: u64,
    pub guard_tail_ms: u64,
    pub hard_timeout_ms: u64,
}

pub fn sandwich_timing() -> SandwichTiming {
    SandwichTiming {
        settle_ms: CLIPBOARD_SETTLE_DELAY_MS,
        restore_ms: CLIPBOARD_RESTORE_DELAY_MS,
        guard_tail_ms: PASTE_GUARD_TAIL_MS,
        hard_timeout_ms: PASTE_TIMEOUT_MS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── terminal detection ──

    #[test]
    fn terminal_classes_case_insensitive() {
        assert!(is_terminal_class("ConsoleWindowClass"));
        assert!(is_terminal_class("consolewindowclass"));
        assert!(is_terminal_class("CASCADIA_HOSTING_WINDOW_CLASS"));
        assert!(is_terminal_class("org.wezfurlong.wezterm"));
        assert!(!is_terminal_class("Chrome_WidgetWin_1"));
    }

    #[test]
    fn terminal_exes_match_basename() {
        assert!(is_terminal_exe("WindowsTerminal.exe"));
        assert!(is_terminal_exe("windowsterminal.exe"));
        assert!(is_terminal_exe("C:\\Program Files\\Tabby\\tabby.exe"));
        assert!(!is_terminal_exe("notepad.exe"));
    }

    #[test]
    fn foreground_terminal_picks_ctrl_shift_v() {
        // class-matched terminal
        assert_eq!(
            keystroke_for_foreground("mintty", "git-bash.exe"),
            PasteKeystroke::CtrlShiftV
        );
        // exe-matched terminal (class not recognized)
        assert_eq!(
            keystroke_for_foreground("SomeHostingClass", "WindowsTerminal.exe"),
            PasteKeystroke::CtrlShiftV
        );
        // ordinary app → Ctrl+V
        assert_eq!(
            keystroke_for_foreground("Notepad", "notepad.exe"),
            PasteKeystroke::CtrlV
        );
    }

    #[test]
    fn foreground_info_keystroke() {
        let term = ForegroundInfo {
            class: "Alacritty".into(),
            exe: "alacritty.exe".into(),
        };
        assert_eq!(term.keystroke(), PasteKeystroke::CtrlShiftV);
    }

    // ── fallback chain ──

    #[test]
    fn fallback_chain_primary_then_direct_type() {
        let fg = ForegroundInfo {
            class: "Notepad".into(),
            exe: "notepad.exe".into(),
        };
        let chain = build_fallback_chain(&fg);
        assert_eq!(
            chain,
            vec![
                PasteStrategy::ClipboardKeystroke(PasteKeystroke::CtrlV),
                PasteStrategy::DirectType
            ]
        );
    }

    #[test]
    fn fallback_chain_terminal_uses_ctrl_shift_v_primary() {
        let fg = ForegroundInfo {
            class: "ConsoleWindowClass".into(),
            exe: "conhost.exe".into(),
        };
        let chain = build_fallback_chain(&fg);
        assert_eq!(
            chain[0],
            PasteStrategy::ClipboardKeystroke(PasteKeystroke::CtrlShiftV)
        );
    }

    // ── circuit breaker ──

    #[test]
    fn breaker_allows_when_closed_and_unpaced() {
        let b = PasteBreaker::new();
        assert_eq!(b.gate(1000), PasteGate::Allow);
    }

    #[test]
    fn breaker_opens_for_cooldown_after_trip() {
        let mut b = PasteBreaker::new();
        b.trip(1000);
        assert!(b.is_open(1000));
        assert_eq!(b.gate(1000), PasteGate::Refuse(PasteRefusal::CircuitOpen));
        // still open just before cooldown end
        assert_eq!(
            b.gate(1000 + PASTE_COOLDOWN_MS - 1),
            PasteGate::Refuse(PasteRefusal::CircuitOpen)
        );
        // closed at/after cooldown end
        assert!(!b.is_open(1000 + PASTE_COOLDOWN_MS));
        assert_eq!(b.gate(1000 + PASTE_COOLDOWN_MS), PasteGate::Allow);
    }

    #[test]
    fn breaker_paces_back_to_back_pastes() {
        let mut b = PasteBreaker::new();
        b.record_success(5000);
        // too soon
        assert_eq!(b.gate(5000 + 100), PasteGate::Refuse(PasteRefusal::Paced));
        assert_eq!(
            b.gate(5000 + PASTE_MIN_GAP_MS - 1),
            PasteGate::Refuse(PasteRefusal::Paced)
        );
        // far enough apart
        assert_eq!(b.gate(5000 + PASTE_MIN_GAP_MS), PasteGate::Allow);
    }

    #[test]
    fn circuit_open_overrides_pacing() {
        let mut b = PasteBreaker::new();
        b.record_success(5000);
        b.trip(5000);
        // even if pacing would allow, the open circuit refuses first
        assert_eq!(
            b.gate(5000 + PASTE_COOLDOWN_MS - 1),
            PasteGate::Refuse(PasteRefusal::CircuitOpen)
        );
    }

    #[test]
    fn sandwich_timing_matches_constants() {
        let t = sandwich_timing();
        assert_eq!(t.settle_ms, 60);
        assert_eq!(t.restore_ms, 120);
        assert_eq!(t.guard_tail_ms, 50);
        assert_eq!(t.hard_timeout_ms, 2500);
    }
}
