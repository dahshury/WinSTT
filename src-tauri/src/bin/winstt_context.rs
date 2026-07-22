// winstt_context — native Rust UIA focused-element + tree reader for WinSTT.
//
// A faithful Rust port of the deleted C sidecar `winstt-context.exe`. It reads
// the Windows UI Automation (UIA) tree of a window and prints a SINGLE-LINE JSON
// object to stdout that the app's parser (`winstt::context::parse_snapshot` +
// `prune_ax_html_for_llm`) consumes. The output contract is BYTE-shape-identical
// to the original C binary so the parser, smoke harness, and captured fixtures
// keep matching.
//
// Modes (mutually exclusive; default = focused):
//   (default)   — focused element text via TextPattern → ValuePattern (focusedText).
//   --selection — only the user's selected text (focusedText).
//   --split     — caret-aware split: textBefore / textAfter around the caret,
//                 PLUS the browser url (focused-field context for dictation —
//                 the competitor-parity capture: focused field + app identity,
//                 NO whole-window tree walk, so no sidebar/inbox/OTP-tree leak).
//   --tree      — Wispr-style: caret split + full UIA subtree axHtml + appExe + url.
//   --hwnd <DECIMAL> — scope the read to that top-level window HWND (else
//                      GetForegroundWindow()).
//   --serve     — persistent warm sidecar: COM/UIA are initialized ONCE, then one
//                 request per line is read from stdin and one response per line is
//                 written to stdout. Request:  {"id":N,"mode":"focused|selection|
//                 split|tree","hwnd":<u64 optional>}. Response: the same snapshot
//                 fields plus a leading "id", or {"id":N,"error":"bad_request"} for
//                 an unparseable line. Kills cold-spawn latency from the hot path
//                 (report R5a). One-shot flags keep working unchanged.
//
// Output (stdout, single line, UTF-8 JSON):
//   {"windowTitle":"...","elementName":"...","focusedText":"...",
//    "textBefore":"...","textAfter":"...","appExe":"...","url":"...","axHtml":"..."}
//   (serve mode prepends "id"; a password-focused field appends "isPassword":true
//    and withholds ALL text fields — window/app metadata only, report R6.)
//
// Caps + the 750ms watchdog mirror the C source (MAX_CONTEXT_CHARS = 24000;
// MAX_AXHTML_CHARS = 150000; TREE_WALK_BUDGET_MS = 600; WATCHDOG_TIMEOUT_MS = 750).
// In --serve the watchdog is armed PER REQUEST (a wedged UIA call exits the
// process so the manager respawns; one bad request can't hang the warm server).
//
// On macOS the reader uses the Accessibility API (AXUIElement); on Linux it uses
// AT-SPI (atspi + zbus). Both emit the SAME single-line JSON snapshot shape so the
// manager + parser are platform-agnostic. Other platforms print an empty snapshot.

#![cfg_attr(
    not(windows),
    expect(
        unused,
        reason = "the shared Windows UIA caps/consts are unused on the macOS/Linux \
                  sidecar builds, which use the AX-API / AT-SPI readers below"
    )
)]

// ─────────────────────────── shared caps ──────────────────────────────

/// Whole-field + caret context budget (chars). Matches MAX_CONTEXT_CHARS.
const MAX_CONTEXT_CHARS: usize = 24_000;
/// Tail before the caret (the continuation-deciding slice). CARET_BEFORE_CHARS.
///
/// A PROXIMITY bound, deliberately small. Page-hosted fields (Chromium/Gmail)
/// expose the WHOLE page as one UIA document, so "text before the caret" can be
/// the entire inbox/chat scrollback. This cap keeps only the caret's near
/// neighborhood; `read_caret_split` additionally clamps it to the on-screen
/// (visible) region. The industry-standard "nearby text" scope, not the whole
/// document — see the context-awareness research (Tier 1, bounded neighborhood).
const CARET_BEFORE_CHARS: i32 = 2_000;
/// Lookahead after the caret. CARET_AFTER_CHARS.
const CARET_AFTER_CHARS: i32 = 2_000;
/// Total axHtml budget (chars). MAX_AXHTML_CHARS.
const MAX_AXHTML_CHARS: usize = 150_000;
/// Max tree depth before emitting a `<...truncated/>` marker. MAX_TREE_DEPTH.
const MAX_TREE_DEPTH: i32 = 9;
/// Element-count backstop for the walk. MAX_TREE_ELEMENTS.
const MAX_TREE_ELEMENTS: usize = 300;
/// Per-element incidental name/value cap (chars). MAX_ELEMENT_VALUE_CHARS.
const MAX_ELEMENT_VALUE_CHARS: usize = 200;
/// Focused/Document/Edit CONTENT element cap (chars). MAX_CONTENT_VALUE_CHARS.
const MAX_CONTENT_VALUE_CHARS: usize = 50_000;
/// Cooperative tree-walk deadline (ms); the watchdog is the hard backstop.
const TREE_WALK_BUDGET_MS: u64 = 600;
/// Hard watchdog (ms) — kills the process if a UIA call wedges.
const WATCHDOG_TIMEOUT_MS: u64 = 750;
/// Below this much captured content text a browser walk is retried once.
const COLD_TREE_CONTENT_THRESHOLD: usize = 200;
/// Hard cap on Tier-2 OCR text (chars). Report R3: a bounded background blob,
/// not a document dump — keeps the LLM payload small on canvas/remote surfaces.
const MAX_OCR_CHARS: usize = 8_000;

fn main() {
    #[cfg(windows)]
    windows_impl::run();
    #[cfg(target_os = "macos")]
    macos_impl::run();
    #[cfg(target_os = "linux")]
    linux_impl::run();
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        // No accessibility backend on this platform — emit the cheap empty shape.
        print!(
            "{{\"windowTitle\":\"\",\"elementName\":\"\",\"focusedText\":\"\",\
             \"textBefore\":\"\",\"textAfter\":\"\",\"appExe\":\"\",\
             \"url\":\"\",\"axHtml\":\"\"}}"
        );
    }
}

// ─────────────── shared non-Windows snapshot plumbing ───────────────
//
// The macOS (AX-API) and Linux (AT-SPI) readers emit the SAME single-line JSON
// snapshot shape as the Windows UIA one-shot path, so `parse_snapshot` and every
// downstream context consumer stay platform-agnostic. These helpers hold the
// shared mode parse + escape + emit logic both readers reuse.

/// The capture mode for the non-Windows readers (mirrors the Windows `Mode`).
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum NwMode {
    Focused,
    Selection,
    Split,
    Tree,
    Meta,
}

/// Parse the mode from the process args — the same `--selection` / `--split` /
/// `--tree` flags the manager passes (default = focused). `--hwnd` / `--ocr` /
/// `--serve` are Windows-only concepts and ignored here.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn nw_parse_mode() -> NwMode {
    let mut mode = NwMode::Focused;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--selection" => mode = NwMode::Selection,
            "--split" => mode = NwMode::Split,
            "--tree" => mode = NwMode::Tree,
            "--meta" => mode = NwMode::Meta,
            _ => {}
        }
    }
    mode
}

/// The snapshot fields the non-Windows readers populate. `is_password` withholds
/// all text end-to-end (mirrors the Windows password guard); `url` / `ax_html`
/// stay empty (no portable omnibox / tree walk off Windows).
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Default)]
struct NwSnapshot {
    window_title: String,
    element_name: String,
    focused_text: String,
    text_before: String,
    text_after: String,
    app_exe: String,
    url: String,
    ax_html: String,
    is_password: bool,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl NwSnapshot {
    fn empty() -> Self {
        Self::default()
    }

    /// Emit the single-line JSON snapshot to stdout, byte-shape-identical to the
    /// Windows one-shot output (plus the optional trailing `"isPassword":true`).
    fn print(mut self) {
        use std::io::Write;

        nw_truncate_chars(&mut self.focused_text, MAX_CONTEXT_CHARS);
        nw_truncate_chars(&mut self.text_before, MAX_CONTEXT_CHARS);
        nw_truncate_chars(&mut self.text_after, MAX_CONTEXT_CHARS);

        let pw_suffix = if self.is_password {
            ",\"isPassword\":true"
        } else {
            ""
        };
        print!(
            "{{\"windowTitle\":\"{}\",\"elementName\":\"{}\",\"focusedText\":\"{}\",\
             \"textBefore\":\"{}\",\"textAfter\":\"{}\",\"appExe\":\"{}\",\
             \"url\":\"{}\",\"axHtml\":\"{}\"{pw_suffix}}}",
            nw_json_escape(&self.window_title),
            nw_json_escape(&self.element_name),
            nw_json_escape(&self.focused_text),
            nw_json_escape(&self.text_before),
            nw_json_escape(&self.text_after),
            nw_json_escape(&self.app_exe),
            nw_json_escape(&self.url),
            nw_json_escape(&self.ax_html),
        );
        let _ = std::io::stdout().flush();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn nw_truncate_chars(s: &mut String, max: usize) {
    if s.chars().count() > max {
        *s = s.chars().take(max).collect();
    }
}

/// JSON-escape a UTF-8 string body (structural + sub-0x20 control chars), matching
/// the Windows `json_escape` so both platforms produce identical snapshot bytes.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn nw_json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[cfg(windows)]
mod windows_impl {
    use super::*;

    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
        IUIAutomationTextRange, IUIAutomationTreeWalker, IUIAutomationValuePattern,
        UIA_AutomationIdPropertyId, UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId,
        UIA_ComboBoxControlTypeId, UIA_ControlTypePropertyId, UIA_DataItemControlTypeId,
        UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_GroupControlTypeId,
        UIA_HasKeyboardFocusPropertyId, UIA_HeaderControlTypeId, UIA_HeaderItemControlTypeId,
        UIA_HyperlinkControlTypeId, UIA_ImageControlTypeId, UIA_ListControlTypeId,
        UIA_ListItemControlTypeId, UIA_MenuControlTypeId, UIA_MenuItemControlTypeId,
        UIA_PaneControlTypeId, UIA_RadioButtonControlTypeId, UIA_StatusBarControlTypeId,
        UIA_TabControlTypeId, UIA_TabItemControlTypeId, UIA_TableControlTypeId,
        UIA_TextControlTypeId, UIA_TextPatternId, UIA_ToolBarControlTypeId, UIA_TreeControlTypeId,
        UIA_TreeItemControlTypeId, UIA_ValuePatternId, UIA_WindowControlTypeId,
    };
    use windows::Win32::UI::Accessibility::{
        TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start, TextUnit_Character,
        TreeScope_Descendants, TreeScope_Subtree,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
    use windows::core::{BSTR, PCWSTR, w};

    // ─────────────────────── CLI parse + dispatch ─────────────────────────

    struct Cli {
        selection_only: bool,
        split: bool,
        tree: bool,
        meta: bool,
        hwnd: Option<isize>,
        /// `--serve`: persistent JSON-per-line loop over stdin/stdout (COM/UIA
        /// warm once at startup, one request per line). The other flags are the
        /// one-shot CLI modes; both share the same capture code.
        serve: bool,
        /// `--ocr`: opt into the Tier-2 OCR fallback for this one-shot capture
        /// (the serve path carries it per request instead). Off by default.
        ocr: bool,
    }

    fn parse_cli() -> Cli {
        let mut cli = Cli {
            selection_only: false,
            split: false,
            tree: false,
            meta: false,
            hwnd: None,
            serve: false,
            ocr: false,
        };
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--selection" => cli.selection_only = true,
                "--split" => cli.split = true,
                "--tree" => cli.tree = true,
                "--meta" => cli.meta = true,
                "--serve" => cli.serve = true,
                "--ocr" => cli.ocr = true,
                "--hwnd" => {
                    if let Some(v) = args.next() {
                        // Decimal HWND, matching the C `_strtoui64(.., 10)`.
                        if let Ok(value) = v.trim().parse::<u64>()
                            && value > 0
                        {
                            cli.hwnd = Some(value as isize);
                        }
                    }
                }
                _ => {}
            }
        }
        cli
    }

    /// One capture request, resolved from either the one-shot CLI flags or a
    /// `--serve` stdin line. `id` is echoed back in serve mode (0 for one-shot).
    #[derive(Clone, Copy)]
    struct Request {
        id: u64,
        mode: Mode,
        hwnd: Option<isize>,
        /// Tier-2 OCR fallback opt-in (report R3). When set, and UIA capture
        /// yielded no usable text, the pinned window is screenshotted and OCR'd
        /// on-device. Off by default; the manager threads the user's
        /// `contextScreenOcr` setting into this per request. Ignored for a
        /// password-focused field (text is withheld end-to-end).
        ocr: bool,
    }

    /// The mutually-exclusive capture modes (default = focused).
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mode {
        Focused,
        Selection,
        Split,
        Tree,
        Meta,
    }

    impl Mode {
        /// Parse the `"mode"` field of a serve request. Unknown → focused.
        fn parse_mode(s: &str) -> Self {
            match s {
                "selection" => Mode::Selection,
                "split" => Mode::Split,
                "tree" => Mode::Tree,
                "meta" => Mode::Meta,
                _ => Mode::Focused,
            }
        }
    }

    pub fn run() {
        let cli = parse_cli();

        if cli.serve {
            serve();
            return;
        }

        // Hard watchdog: a wedged UIA walk can hang COM. Kill the process after
        // the timeout, mirroring the C ExitProcess(3). main() races it.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(WATCHDOG_TIMEOUT_MS));
            std::process::exit(3);
        });

        let mode = if cli.meta {
            Mode::Meta
        } else if cli.tree {
            Mode::Tree
        } else if cli.split {
            Mode::Split
        } else if cli.selection_only {
            Mode::Selection
        } else {
            Mode::Focused
        };
        let req = Request {
            id: 0,
            mode,
            hwnd: cli.hwnd,
            ocr: cli.ocr,
        };

        // COM apartment (single-threaded, like the C COINIT_APARTMENTTHREADED).
        // SAFETY: Initializes COM for this helper process thread before any UIA COM calls.
        let co = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        // RPC_E_CHANGED_MODE is harmless. Any other hard failure → emit metadata only.
        let com_ok = co.is_ok() || co == windows::Win32::Foundation::RPC_E_CHANGED_MODE;

        let uia = if com_ok {
            // SAFETY: COM was initialized or already in a compatible mode; the UIA instance is
            // used only on this thread and released before CoUninitialize.
            unsafe {
                CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            }
            .ok()
        } else {
            None
        };

        // One-shot output keeps the historical 8-field shape (no `id`) so the
        // parser, smoke harness, and captured fixtures keep matching byte-for-byte.
        let out = capture_json(uia.as_ref(), req, false);

        // Drop `uia` (Release) before CoUninitialize.
        drop(uia);
        if com_ok {
            // SAFETY: Balances this thread's successful CoInitializeEx call.
            unsafe { CoUninitialize() };
        }

        print!("{out}");
        use std::io::Write;
        let _ = std::io::stdout().flush();
    }

    /// Persistent `--serve` loop: COM/UIA are initialized ONCE (warm), then one
    /// JSON request per stdin line is captured and one JSON response per stdout
    /// line is written. A wedged UIA call is fenced per request by an in-process
    /// watchdog thread armed around the capture; on fire the whole process exits
    /// (code 3) and the manager respawns — mirroring the one-shot watchdog, but
    /// scoped so a single bad request can't hang the warm server forever.
    fn serve() {
        use std::io::{BufRead, Write};
        use std::sync::{Arc, Condvar, Mutex};

        // COM apartment (single-threaded), initialized once for the process life.
        // SAFETY: Initializes COM for this thread before any UIA COM call; all UIA
        // work below runs on this same thread.
        let co = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        let com_ok = co.is_ok() || co == windows::Win32::Foundation::RPC_E_CHANGED_MODE;
        // SAFETY: guarded by `com_ok`; the UIA instance is used only on this thread.
        let uia = if com_ok {
            unsafe {
                CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            }
            .ok()
        } else {
            None
        };

        // Per-request watchdog: the reader thread arms `deadline` before each
        // capture and disarms it after. A background thread trips ExitProcess if
        // a capture blows past the budget (a wedged UIA call the parent can't see).
        // The condition variable makes arm/disarm/deadline changes immediate; the
        // waiter otherwise sleeps exactly until the currently armed deadline.
        let watchdog = Arc::new((Mutex::new(None::<Instant>), Condvar::new()));
        {
            let watchdog = Arc::clone(&watchdog);
            std::thread::spawn(move || {
                let (deadline, deadline_changed) = &*watchdog;
                let mut current = deadline.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    let Some(armed_until) = *current else {
                        current = deadline_changed
                            .wait(current)
                            .unwrap_or_else(|e| e.into_inner());
                        continue;
                    };

                    let now = Instant::now();
                    if now >= armed_until {
                        // A UIA call has wedged this request. Exit so the manager
                        // respawns a fresh warm server (one retry, then give up).
                        std::process::exit(3);
                    }

                    let (next, _) = deadline_changed
                        .wait_timeout(current, armed_until.saturating_duration_since(now))
                        .unwrap_or_else(|e| e.into_inner());
                    current = next;
                }
            });
        }

        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // Frame one request → response, arming the per-request watchdog only
            // around the (potentially wedging) UIA capture.
            let response = format_serve_response(line, |req| {
                let (deadline, deadline_changed) = &*watchdog;
                *deadline.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(Instant::now() + Duration::from_millis(WATCHDOG_TIMEOUT_MS));
                deadline_changed.notify_one();
                let body = capture_json(uia.as_ref(), req, true);
                *deadline.lock().unwrap_or_else(|e| e.into_inner()) = None;
                deadline_changed.notify_one();
                body
            });
            if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
                break;
            }
        }

        drop(uia);
        if com_ok {
            // SAFETY: Balances this thread's CoInitializeEx call on loop exit.
            unsafe { CoUninitialize() };
        }
    }

    /// Frame one non-empty `--serve` line into its response string: parse it, and
    /// on success run `capture(req)` (which produces the id-prefixed snapshot);
    /// on a malformed line emit a correlated `{"id":N,"error":"bad_request"}`
    /// (id 0 when unrecoverable) so the manager survives and stays in sync. Split
    /// out from the loop so the framing + bad-JSON survival is unit-testable
    /// without COM/UIA or a spawned process.
    fn format_serve_response<F: FnOnce(Request) -> String>(line: &str, capture: F) -> String {
        let (id, req) = parse_serve_request(line);
        match req {
            Some(req) => capture(req),
            None => format!("{{\"id\":{id},\"error\":\"bad_request\"}}"),
        }
    }

    /// Parse one `--serve` request line: `{"id":N,"mode":"...","hwnd":<u64?>}`.
    /// Returns `(id, Some(Request))` on success, or `(id_or_0, None)` when the
    /// line isn't a usable request (the id is still recovered when present so the
    /// error response can be correlated).
    fn parse_serve_request(line: &str) -> (u64, Option<Request>) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return (0, None);
        };
        let Some(obj) = value.as_object() else {
            return (0, None);
        };
        let id = obj
            .get("id")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let mode = obj
            .get("mode")
            .and_then(serde_json::Value::as_str)
            .map_or(Mode::Focused, Mode::parse_mode);
        // hwnd is an optional u64; 0 / missing means "foreground".
        let hwnd = obj
            .get("hwnd")
            .and_then(serde_json::Value::as_u64)
            .filter(|h| *h > 0)
            .map(|h| h as isize);
        // ocr is an optional bool; missing / non-bool → false (opt-in default).
        let ocr = obj
            .get("ocr")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        (
            id,
            Some(Request {
                id,
                mode,
                hwnd,
                ocr,
            }),
        )
    }

    /// Tier-2 OCR trigger predicate (report R3). Returns true only when BOTH
    /// conditions hold, so OCR stays a fallback that can't leak on password
    /// fields or override a good UIA read:
    ///   (a) the request opted into OCR (`req.ocr` — the user's `contextScreenOcr`
    ///       setting, off by default), AND
    ///   (b) UIA captured NO usable text: every UIA-derived text slice is blank
    ///       after trimming (focused field, both caret halves, and the tree HTML).
    /// A password-focused field short-circuits to false — its text is withheld
    /// end-to-end, and a screenshot could still expose typed-but-masked content,
    /// so the same guard that blocks UIA reads blocks OCR. Split out as a pure
    /// function so the trigger logic is unit-tested without COM/UIA/GDI.
    fn should_run_ocr(
        ocr_opt_in: bool,
        is_password: bool,
        focused_text: &str,
        context_before: &str,
        context_after: &str,
        ax_html: &str,
    ) -> bool {
        if !ocr_opt_in || is_password {
            return false;
        }
        // "No usable text": nothing meaningful in any UIA channel. Whitespace-only
        // reads (e.g. a blank editor) count as empty and still trigger the fallback.
        focused_text.trim().is_empty()
            && context_before.trim().is_empty()
            && context_after.trim().is_empty()
            && ax_html.trim().is_empty()
    }

    /// Run one capture request against the (warm) UIA instance and return the
    /// single-line JSON body. With `include_id` the `"id"` field is prepended
    /// (serve mode); without it the historical 8-field one-shot shape is emitted.
    /// `uia == None` (COM/UIA unavailable) still yields metadata-only output.
    fn capture_json(uia: Option<&IUIAutomation>, req: Request, include_id: bool) -> String {
        let scope = req.hwnd.map(|h| HWND(h as *mut _));

        // Snapshot title + exe up front — useful even when UIA fails.
        let fg: HWND = match scope {
            Some(h) => h,
            // SAFETY: Reads the current foreground window handle; no ownership is transferred.
            None => unsafe { GetForegroundWindow() },
        };
        let window_title = get_window_title(fg);
        let app_exe = get_process_exe(fg);

        let mut focused_text = String::new();
        let mut element_name = String::new();
        let mut context_before = String::new();
        let mut context_after = String::new();
        let mut url = String::new();
        let mut ax_html = String::new();
        let mut ocr_text = String::new();
        // Set when the focused element is a password field: text is withheld and
        // this flag is surfaced so downstream never sees (or biases on) secrets.
        let mut is_password = false;

        if let Some(uia) = uia {
            match req.mode {
                Mode::Tree => {
                    is_password = read_focused_split(
                        uia,
                        scope,
                        &mut context_before,
                        &mut context_after,
                        &mut focused_text,
                        &mut element_name,
                    );
                    // The tree walk itself skips password subtrees (walk_tree),
                    // so axHtml/url stay populated even when the focused field is
                    // a password — only the focused text is withheld above.
                    ax_html = walk_foreground_tree(uia, fg, is_browser_exe(&app_exe));
                    url = find_browser_url(uia, fg, &app_exe);
                }
                Mode::Split => {
                    is_password = read_focused_split(
                        uia,
                        scope,
                        &mut context_before,
                        &mut context_after,
                        &mut focused_text,
                        &mut element_name,
                    );
                    // App identity for web apps WITHOUT the expensive/leaky tree
                    // walk: a single targeted omnibox lookup. The dictation path
                    // uses --split, and the URL is what (a) lets the LLM tell
                    // Gmail from Docs and (b) drives the host-based privacy
                    // deny-list (e.g. *.bankofamerica.com). axHtml stays empty.
                    url = find_browser_url(uia, fg, &app_exe);
                }
                Mode::Meta => {
                    // Identity-only capture: targeted omnibox lookup plus the
                    // Win32 title/exe collected above. Do not read the focused
                    // element's Value/Text patterns or walk its subtree.
                    url = find_browser_url(uia, fg, &app_exe);
                }
                Mode::Focused | Mode::Selection => {
                    is_password = read_focused_context(
                        uia,
                        scope,
                        req.mode == Mode::Selection,
                        &mut focused_text,
                        &mut element_name,
                    );
                }
            }
        }

        // Tier-2 OCR fallback (report R3). Fires ONLY when the opt-in flag is set
        // AND UIA yielded nothing usable (canvas apps, remote desktops, games —
        // the surfaces UIA is blind to) AND the focused field is not a password.
        // The recognized text feeds the SAME local LLM cleanup + biasing channels
        // as the UIA text; it never reaches the STT prompt and never leaves the
        // machine (Windows.Media.Ocr is on-device).
        if should_run_ocr(
            req.ocr,
            is_password,
            &focused_text,
            &context_before,
            &context_after,
            &ax_html,
        ) {
            ocr_text = capture_window_ocr(fg);
        }

        // Defensive truncation (chars), mirroring the C byte-cap intent.
        truncate_chars(&mut focused_text, MAX_CONTEXT_CHARS);
        truncate_chars(&mut context_before, MAX_CONTEXT_CHARS);
        truncate_chars(&mut context_after, MAX_CONTEXT_CHARS);
        truncate_chars(&mut ocr_text, MAX_OCR_CHARS);

        // Single-line JSON, key order identical to the C printf (one-shot). Serve
        // mode prepends `id`; `ocrText` (Tier-2 fallback) and `isPassword` are
        // appended only when set. The parser ignores unknown keys and reads by
        // name, so the extra fields never disturb existing consumers.
        let id_prefix = if include_id {
            format!("\"id\":{},", req.id)
        } else {
            String::new()
        };
        let ocr_suffix = if ocr_text.is_empty() {
            String::new()
        } else {
            format!(",\"ocrText\":\"{}\"", json_escape(&ocr_text))
        };
        let pw_suffix = if is_password {
            ",\"isPassword\":true"
        } else {
            ""
        };
        format!(
            "{{{id_prefix}\"windowTitle\":\"{}\",\"elementName\":\"{}\",\"focusedText\":\"{}\",\
             \"textBefore\":\"{}\",\"textAfter\":\"{}\",\"appExe\":\"{}\",\
             \"url\":\"{}\",\"axHtml\":\"{}\"{ocr_suffix}{pw_suffix}}}",
            json_escape(&window_title),
            json_escape(&element_name),
            json_escape(&focused_text),
            json_escape(&context_before),
            json_escape(&context_after),
            json_escape(&app_exe),
            json_escape(&url),
            json_escape(&ax_html),
        )
    }

    fn truncate_chars(s: &mut String, max: usize) {
        if s.chars().count() > max {
            let truncated: String = s.chars().take(max).collect();
            *s = truncated;
        }
    }

    // ─────────────────────────── JSON escape ──────────────────────────────

    /// Escape a UTF-8 string into a JSON string body. Multi-byte UTF-8 passes
    /// through (valid UTF-8 stays valid in a JSON string); only structural and
    /// sub-0x20 control bytes are escaped. Mirrors `json_escape_into`.
    fn json_escape(value: &str) -> String {
        let mut out = String::with_capacity(value.len() + 8);
        for ch in value.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\u{0008}' => out.push_str("\\b"),
                '\u{000C}' => out.push_str("\\f"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => {
                    out.push_str(&format!("\\u{:04x}", c as u32));
                }
                c => out.push(c),
            }
        }
        out
    }

    // ───────────────────────── window/process meta ────────────────────────

    fn get_window_title(hwnd: HWND) -> String {
        if hwnd.is_invalid() {
            return String::new();
        }
        let mut buf = [0u16; 512];
        // SAFETY: `hwnd` is a borrowed window handle and `buf` is valid writable UTF-16 storage.
        let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
        if n <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }

    /// Foreground window's process exe basename, lowercased (e.g. "chrome.exe").
    /// Mirrors get_process_exe (OpenProcess + QueryFullProcessImageNameW). The
    /// C Toolhelp fallback is dropped — the harness targets non-elevated Chrome,
    /// and the parser tolerates an empty appExe.
    fn get_process_exe(hwnd: HWND) -> String {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

        if hwnd.is_invalid() {
            return String::new();
        }
        let mut pid: u32 = 0;
        // SAFETY: `pid` is valid writable storage and `hwnd` is a borrowed window handle.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 {
            return String::new();
        }
        // SAFETY: Opens a query-only process handle for the PID reported by Win32.
        let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
        else {
            return String::new();
        };
        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        // SAFETY: `handle` is live and `buf`/`len` are valid writable outputs for the call.
        let ok = unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
        };
        // SAFETY: `handle` was returned by OpenProcess and is not used again after closing.
        let _ = unsafe { CloseHandle(handle) };
        if ok.is_err() || len == 0 {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let base = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
        base.to_lowercase()
    }

    // ───────────────────── UIA pattern text readers ───────────────────────

    /// TextPattern.DocumentRange.GetText(-1). Returns the whole document text.
    fn read_text_pattern(elem: &IUIAutomationElement) -> Option<String> {
        // SAFETY: `elem` is a live UIA element and the requested pattern/interface type matches.
        let pat: IUIAutomationTextPattern =
            unsafe { elem.GetCurrentPatternAs(UIA_TextPatternId) }.ok()?;
        // SAFETY: `pat` is a live TextPattern interface returned by UIA.
        let range: IUIAutomationTextRange = unsafe { pat.DocumentRange() }.ok()?;
        // SAFETY: `range` is a live UIA text range; -1 asks UIA for the whole range.
        let text: BSTR = unsafe { range.GetText(-1) }.ok()?;
        let s = text.to_string();
        if s.is_empty() { None } else { Some(s) }
    }

    /// TextPattern selection ranges, concatenated. Mirrors
    /// read_text_pattern_selection (multi-caret editors).
    fn read_text_pattern_selection(elem: &IUIAutomationElement) -> Option<String> {
        // SAFETY: `elem` is a live UIA element and the requested pattern/interface type matches.
        let pat: IUIAutomationTextPattern =
            unsafe { elem.GetCurrentPatternAs(UIA_TextPatternId) }.ok()?;
        // SAFETY: `pat` is a live TextPattern interface returned by UIA.
        let ranges = unsafe { pat.GetSelection() }.ok()?;
        // SAFETY: `ranges` is a live UIA selection collection.
        let length = unsafe { ranges.Length() }.ok()?;
        if length <= 0 {
            return None;
        }
        let mut out = String::new();
        for i in 0..length {
            // SAFETY: `i` is within the collection length returned by UIA.
            if let Ok(range) = unsafe { ranges.GetElement(i) } {
                // SAFETY: `range` is a live UIA text range; -1 asks UIA for the whole range.
                if let Ok(text) = unsafe { range.GetText(-1) } {
                    out.push_str(&text.to_string());
                }
            }
        }
        if out.is_empty() { None } else { Some(out) }
    }

    /// ValuePattern.CurrentValue (plain edit controls / address bars).
    fn read_value_pattern(elem: &IUIAutomationElement) -> Option<String> {
        // SAFETY: `elem` is a live UIA element and the requested pattern/interface type matches.
        let pat: IUIAutomationValuePattern =
            unsafe { elem.GetCurrentPatternAs(UIA_ValuePatternId) }.ok()?;
        // SAFETY: `pat` is a live ValuePattern interface returned by UIA.
        let text: BSTR = unsafe { pat.CurrentValue() }.ok()?;
        let s = text.to_string();
        if s.is_empty() { None } else { Some(s) }
    }

    fn read_element_name(elem: &IUIAutomationElement) -> String {
        // SAFETY: `elem` is a live UIA element; UIA reports failure for inaccessible elements.
        unsafe { elem.CurrentName() }
            .map(|b| b.to_string())
            .unwrap_or_default()
    }

    // ───────────────────── focused-element acquisition ────────────────────

    /// Depth-unbounded FindFirst(HasKeyboardFocus==TRUE) inside the scope window
    /// (Gmail's reply box sits very deep). Mirrors find_focused_in_window.
    fn find_focused_in_window(uia: &IUIAutomation, hwnd: HWND) -> Option<IUIAutomationElement> {
        // SAFETY: `hwnd` is a borrowed native window handle; UIA validates accessibility access.
        let root = unsafe { uia.ElementFromHandle(hwnd) }.ok()?;
        let v = windows::Win32::System::Variant::VARIANT::from(true);
        // SAFETY: `uia` is a live UIA root object and `v` is a valid VARIANT value.
        let cond =
            unsafe { uia.CreatePropertyCondition(UIA_HasKeyboardFocusPropertyId, &v) }.ok()?;
        // SAFETY: `root` and `cond` are live UIA interfaces; no ownership crosses this call.
        unsafe { root.FindFirst(TreeScope_Subtree, &cond) }.ok()
    }

    /// With --hwnd: STRICTLY scoped focus inside that window (never the OS-global
    /// focus, which belongs to the launching terminal). Else GetFocusedElement.
    fn acquire_focused_element(
        uia: &IUIAutomation,
        scope: Option<HWND>,
    ) -> Option<IUIAutomationElement> {
        if let Some(hwnd) = scope {
            find_focused_in_window(uia, hwnd)
        } else {
            // SAFETY: `uia` is a live UIA root object for this initialized COM thread.
            unsafe { uia.GetFocusedElement() }.ok()
        }
    }

    /// True when the focused element is a password field. UIA exposes password
    /// edits as `EditControlType` with the `IsPassword` property set, so the
    /// property is the authoritative, control-type-agnostic signal (it also
    /// covers non-Edit password surfaces some frameworks expose). Text of such
    /// elements is NEVER read: masked characters are worthless and reading them
    /// risks leaking a secret into the prompt/vocabulary channels. A query
    /// failure is treated as NOT a password (fail-open on capture) — the tree
    /// walk keeps its own subtree guard (`walk_tree`).
    fn is_password_element(elem: &IUIAutomationElement) -> bool {
        // SAFETY: `elem` is a live UIA element; UIA returns an error for
        // inaccessible elements, which unwraps to `false` (not a password).
        unsafe { elem.CurrentIsPassword() }
            .unwrap_or_default()
            .as_bool()
    }

    /// Default/selection mode: name + focused text (TextPattern → ValuePattern,
    /// or selection-only). Mirrors read_focused_context. Returns `true` when the
    /// focused element is a password field — in that case NO text is read and the
    /// caller surfaces the `isPassword` flag with metadata only.
    fn read_focused_context(
        uia: &IUIAutomation,
        scope: Option<HWND>,
        selection_only: bool,
        out_text: &mut String,
        out_name: &mut String,
    ) -> bool {
        let Some(focused) = acquire_focused_element(uia, scope) else {
            return false;
        };
        *out_name = read_element_name(&focused);
        // Password guard: never read Value/Text of a password element.
        if is_password_element(&focused) {
            return true;
        }
        let text = if selection_only {
            read_text_pattern_selection(&focused)
        } else {
            read_text_pattern(&focused).or_else(|| read_value_pattern(&focused))
        };
        if let Some(text) = text {
            *out_text = text;
        }
        false
    }

    /// --split / --tree caret read: name + caret-split before/after, falling back
    /// to whole-text into out_text when no caret. Mirrors read_focused_split.
    /// Returns `true` when the focused element is a password field — NO caret
    /// text is read in that case.
    fn read_focused_split(
        uia: &IUIAutomation,
        scope: Option<HWND>,
        out_before: &mut String,
        out_after: &mut String,
        out_text: &mut String,
        out_name: &mut String,
    ) -> bool {
        let Some(focused) = acquire_focused_element(uia, scope) else {
            return false;
        };
        *out_name = read_element_name(&focused);
        // Password guard: never read caret-split text of a password element.
        if is_password_element(&focused) {
            return true;
        }
        if !read_caret_split(&focused, out_before, out_after) {
            // No caret — degrade to the whole-text read.
            if let Some(text) = read_text_pattern(&focused).or_else(|| read_value_pattern(&focused))
            {
                *out_text = text;
            }
        }
        false
    }

    /// Pull `range`'s Start endpoint forward to the first ON-SCREEN character
    /// when it currently precedes the viewport. This bounds beforeCaret to the
    /// visible neighborhood of the caret instead of the whole document, which is
    /// what defeats the Gmail/Chromium "entire page is one text document" leak
    /// (inbox scrollback, OTP emails) that a char cap alone can't stop.
    ///
    /// Best-effort: a silent no-op if the provider doesn't implement
    /// `GetVisibleRanges`, returns no ranges, or the comparison fails. It never
    /// EXPANDS the range — only moves Start toward the caret (more restrictive).
    fn clamp_range_start_to_visible(
        pat: &IUIAutomationTextPattern,
        range: &IUIAutomationTextRange,
    ) {
        // SAFETY: `pat` is a live TextPattern; GetVisibleRanges returns an owned array.
        let Ok(vis) = (unsafe { pat.GetVisibleRanges() }) else {
            return;
        };
        // SAFETY: `vis` is a live UIA text-range array.
        if unsafe { vis.Length() }.unwrap_or(0) <= 0 {
            return;
        }
        // First element is the topmost visible range (document order); its Start
        // is the first on-screen character. SAFETY: index 0 valid (len > 0).
        let Ok(first) = (unsafe { vis.GetElement(0) }) else {
            return;
        };
        // Only move Start forward: if it is already at/after the visible start,
        // the char cap was the tighter bound — leave it. SAFETY: both are live
        // ranges from the same TextPattern document.
        let before_visible = unsafe {
            range.CompareEndpoints(
                TextPatternRangeEndpoint_Start,
                &first,
                TextPatternRangeEndpoint_Start,
            )
        }
        .is_ok_and(|cmp| cmp < 0);
        if before_visible {
            // SAFETY: same-document live ranges; moving Start to a later point
            // (or collapsing if it would cross End) is UIA-safe.
            unsafe {
                let _ = range.MoveEndpointByRange(
                    TextPatternRangeEndpoint_Start,
                    &first,
                    TextPatternRangeEndpoint_Start,
                );
            }
        }
    }

    /// Caret-aware split: tail before caret start + head after selection end.
    /// Returns true when a TextPattern caret/selection was obtained (either side
    /// may legitimately be empty). Mirrors read_caret_split.
    fn read_caret_split(
        elem: &IUIAutomationElement,
        out_before: &mut String,
        out_after: &mut String,
    ) -> bool {
        // SAFETY: `elem` is a live UIA element and the requested pattern/interface type matches.
        let Ok(pat) =
            (unsafe { elem.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) })
        else {
            return false;
        };
        // SAFETY: `pat` is a live TextPattern interface returned by UIA.
        let Ok(doc) = (unsafe { pat.DocumentRange() }) else {
            return false;
        };
        // SAFETY: `pat` is a live TextPattern interface returned by UIA.
        let Ok(sels) = (unsafe { pat.GetSelection() }) else {
            return false;
        };
        // SAFETY: `sels` is a live UIA selection collection.
        let sel_len = unsafe { sels.Length() }.unwrap_or(0);
        if sel_len <= 0 {
            return false;
        }
        // SAFETY: `sel_len > 0`, so index 0 is valid for the UIA selection collection.
        let Ok(sel) = (unsafe { sels.GetElement(0) }) else {
            return false;
        };

        let mut got = false;

        // BEFORE: [docStart, caretStart], keep only the trailing CARET_BEFORE_CHARS.
        // SAFETY: `doc` is a live text range; Clone returns an independent range object.
        if let Ok(before) = unsafe { doc.Clone() } {
            // SAFETY: `before` and `sel` are live ranges from the same TextPattern document.
            unsafe {
                let _ = before.MoveEndpointByRange(
                    TextPatternRangeEndpoint_End,
                    &sel,
                    TextPatternRangeEndpoint_Start,
                );
            }
            // SAFETY: `before` is a live text range; Clone returns an independent range object.
            if let Ok(tail) = unsafe { before.Clone() } {
                // SAFETY: `tail` is a live text range; endpoint moves stay within UIA-managed
                // document bounds and GetText uses UIA's range cap.
                unsafe {
                    // Collapse to the end, then move the start back CARET_BEFORE_CHARS.
                    let _ = tail.MoveEndpointByRange(
                        TextPatternRangeEndpoint_Start,
                        &tail,
                        TextPatternRangeEndpoint_End,
                    );
                    let _ = tail.MoveEndpointByUnit(
                        TextPatternRangeEndpoint_Start,
                        TextUnit_Character,
                        -CARET_BEFORE_CHARS,
                    );
                }
                // The char cap alone is not enough on page-hosted fields:
                // Chromium's DocumentRange spans the WHOLE page, so the trailing
                // CARET_BEFORE_CHARS can still be off-screen scrollback (an inbox
                // list, prior chat turns, OTP emails). Clamp the range start to
                // the first ON-SCREEN character — "screenshot semantics without
                // pixels" — so beforeCaret never precedes what the user sees.
                clamp_range_start_to_visible(&pat, &tail);
                // SAFETY: `tail` is a live text range; GetText uses UIA's cap.
                if let Ok(text) = unsafe { tail.GetText(-1) } {
                    *out_before = text.to_string();
                }
            }
            got = true;
        }

        // AFTER: [caretEnd, docEnd], capped at CARET_AFTER_CHARS.
        // SAFETY: `doc` is a live text range; Clone returns an independent range object.
        if let Ok(after) = unsafe { doc.Clone() } {
            // SAFETY: `after` and `sel` are live ranges from the same TextPattern document.
            unsafe {
                let _ = after.MoveEndpointByRange(
                    TextPatternRangeEndpoint_Start,
                    &sel,
                    TextPatternRangeEndpoint_End,
                );
                if let Ok(text) = after.GetText(CARET_AFTER_CHARS) {
                    *out_after = text.to_string();
                }
            }
            got = true;
        }

        got
    }

    // ─────────────────────────── tree mode ────────────────────────────────

    /// UIA ControlType → short XML tag. Mirrors role_name; unknown → "el".
    fn role_name(id: i32) -> &'static str {
        if id == UIA_WindowControlTypeId.0 {
            "window"
        } else if id == UIA_DocumentControlTypeId.0 {
            "doc"
        } else if id == UIA_EditControlTypeId.0 {
            "edit"
        } else if id == UIA_TextControlTypeId.0 {
            "text"
        } else if id == UIA_ButtonControlTypeId.0 {
            "button"
        } else if id == UIA_HyperlinkControlTypeId.0 {
            "link"
        } else if id == UIA_ListControlTypeId.0 {
            "list"
        } else if id == UIA_ListItemControlTypeId.0 {
            "item"
        } else if id == UIA_MenuControlTypeId.0 {
            "menu"
        } else if id == UIA_MenuItemControlTypeId.0 {
            "menuitem"
        } else if id == UIA_TabControlTypeId.0 {
            "tabs"
        } else if id == UIA_TabItemControlTypeId.0 {
            "tab"
        } else if id == UIA_TreeControlTypeId.0 {
            "tree"
        } else if id == UIA_TreeItemControlTypeId.0 {
            "node"
        } else if id == UIA_DataItemControlTypeId.0 {
            "row"
        } else if id == UIA_GroupControlTypeId.0 {
            "group"
        } else if id == UIA_PaneControlTypeId.0 {
            "pane"
        } else if id == UIA_ToolBarControlTypeId.0 {
            "toolbar"
        } else if id == UIA_StatusBarControlTypeId.0 {
            "status"
        } else if id == UIA_ComboBoxControlTypeId.0 {
            "combo"
        } else if id == UIA_CheckBoxControlTypeId.0 {
            "check"
        } else if id == UIA_RadioButtonControlTypeId.0 {
            "radio"
        } else if id == UIA_HeaderItemControlTypeId.0 {
            "header"
        } else if id == UIA_ImageControlTypeId.0 {
            "image"
        } else if id == UIA_TableControlTypeId.0 {
            "table"
        } else if id == UIA_HeaderControlTypeId.0 {
            "thead"
        } else {
            "el"
        }
    }

    /// Group/Pane/Toolbar with no name+value pass through transparently.
    fn is_structural_role(id: i32) -> bool {
        id == UIA_GroupControlTypeId.0
            || id == UIA_PaneControlTypeId.0
            || id == UIA_ToolBarControlTypeId.0
    }

    struct TreeBuilder {
        buf: String,
        element_count: usize,
        start: Instant,
        content_chars: usize,
    }

    impl TreeBuilder {
        fn has_budget(&self) -> bool {
            if self.element_count >= MAX_TREE_ELEMENTS {
                return false;
            }
            // Leave headroom under the char cap (close tags + newline).
            if self.buf.len() >= MAX_AXHTML_CHARS.saturating_sub(64) {
                return false;
            }
            if self.start.elapsed().as_millis() as u64 >= TREE_WALK_BUDGET_MS {
                return false;
            }
            true
        }

        fn emit(&mut self, s: &str) {
            if self.buf.len() + s.len() <= MAX_AXHTML_CHARS {
                self.buf.push_str(s);
            } else if self.buf.len() < MAX_AXHTML_CHARS {
                let room = MAX_AXHTML_CHARS - self.buf.len();
                // Push only whole chars that fit.
                for ch in s.chars() {
                    if self.buf.len() + ch.len_utf8() > self.buf.len() + room {
                        break;
                    }
                    if self.buf.len() + ch.len_utf8() > MAX_AXHTML_CHARS {
                        break;
                    }
                    self.buf.push(ch);
                }
            }
        }

        fn indent(&mut self, depth: i32) {
            for _ in 0..(depth * 2) {
                if self.buf.len() >= MAX_AXHTML_CHARS {
                    break;
                }
                self.buf.push(' ');
            }
        }

        /// Escape into XML attr/text form, capping at `cap` CHARS. Drops noise
        /// codepoints (U+FFFC/U+FFFD/U+FEFF), collapses whitespace runs to a
        /// single space, drops other control chars. Mirrors tb_emit_xml_escaped.
        fn emit_xml_escaped(&mut self, s: &str, cap: usize) {
            let mut emitted = 0usize;
            let mut last_space = false;
            for ch in s.chars() {
                if emitted >= cap || self.buf.len() >= MAX_AXHTML_CHARS.saturating_sub(8) {
                    break;
                }
                match ch {
                    '\u{FFFC}' | '\u{FFFD}' | '\u{FEFF}' => continue,
                    '<' => {
                        self.buf.push_str("&lt;");
                        emitted += 1;
                        last_space = false;
                    }
                    '>' => {
                        self.buf.push_str("&gt;");
                        emitted += 1;
                        last_space = false;
                    }
                    '"' => {
                        self.buf.push_str("&quot;");
                        emitted += 1;
                        last_space = false;
                    }
                    '&' => {
                        self.buf.push_str("&amp;");
                        emitted += 1;
                        last_space = false;
                    }
                    '\n' | '\r' | '\t' | ' ' => {
                        if !last_space {
                            self.buf.push(' ');
                            emitted += 1;
                            last_space = true;
                        }
                    }
                    c if (c as u32) < 0x20 => continue,
                    c => {
                        self.buf.push(c);
                        emitted += 1;
                        last_space = false;
                    }
                }
            }
        }
    }

    /// Tree-mode value read: TextPattern → ValuePattern, no subtree walk.
    fn tree_read_value(elem: &IUIAutomationElement) -> Option<String> {
        if let Some(t) = read_text_pattern(elem) {
            return Some(t);
        }
        read_value_pattern(elem)
    }

    /// Recursive control-view walker. Mirrors walk_tree. Returns true to keep
    /// walking siblings, false to stop (budget exhausted).
    fn walk_tree(
        tb: &mut TreeBuilder,
        walker: &IUIAutomationTreeWalker,
        elem: &IUIAutomationElement,
        depth: i32,
    ) -> bool {
        if !tb.has_budget() {
            return false;
        }
        if depth >= MAX_TREE_DEPTH {
            tb.indent(depth);
            tb.emit("<...truncated/>\n");
            return true;
        }

        // Never expose password-bearing elements (or their children).
        // SAFETY: `elem` is a live UIA element; UIA returns an error for inaccessible elements.
        if unsafe { elem.CurrentIsPassword() }
            .unwrap_or_default()
            .as_bool()
        {
            return true;
        }

        // SAFETY: `elem` is a live UIA element; UIA returns an error for inaccessible elements.
        let ctype = unsafe { elem.CurrentControlType() }.map_or(0, |c| c.0);
        let name = read_element_name(elem);
        // SAFETY: `elem` is a live UIA element; UIA returns an error for inaccessible elements.
        let has_focus = unsafe { elem.CurrentHasKeyboardFocus() }
            .unwrap_or_default()
            .as_bool();

        // Read text for Document/Edit/Text controls. Focused/Edit/Document get
        // the large content cap; incidental Text labels stay at 200.
        let mut value = String::new();
        let mut value_cap = MAX_ELEMENT_VALUE_CHARS;
        if ctype == UIA_EditControlTypeId.0
            || ctype == UIA_DocumentControlTypeId.0
            || ctype == UIA_TextControlTypeId.0
        {
            let is_content = has_focus
                || ctype == UIA_EditControlTypeId.0
                || ctype == UIA_DocumentControlTypeId.0;
            if let Some(v) = tree_read_value(elem) {
                value = v;
            }
            if is_content {
                value_cap = MAX_CONTENT_VALUE_CHARS;
                let cl = value.chars().count();
                if cl > tb.content_chars {
                    tb.content_chars = cl;
                }
            }
        }

        let has_name = !name.is_empty();
        let has_value = !value.is_empty();
        let structural_pass_through = is_structural_role(ctype) && !has_name && !has_value;
        let role = role_name(ctype);

        if !structural_pass_through {
            tb.indent(depth);
            tb.emit("<");
            tb.emit(role);
            if has_name {
                tb.emit(" name=\"");
                tb.emit_xml_escaped(&name, MAX_ELEMENT_VALUE_CHARS);
                tb.emit("\"");
            }
            if has_focus {
                tb.emit(" focus=\"1\"");
            }
            tb.element_count += 1;

            if has_value {
                tb.emit(">");
                tb.emit_xml_escaped(&value, value_cap);
                tb.emit("</");
                tb.emit(role);
                tb.emit(">\n");
                return true;
            }
            tb.emit(">\n");
        }

        let child_depth = if structural_pass_through {
            depth
        } else {
            depth + 1
        };
        // SAFETY: `walker` and `elem` are live UIA interfaces for the same tree.
        if let Ok(mut child) = unsafe { walker.GetFirstChildElement(elem) } {
            loop {
                if !tb.has_budget() {
                    break;
                }
                walk_tree(tb, walker, &child, child_depth);
                // SAFETY: `child` is the current live UIA element returned by this walker.
                match unsafe { walker.GetNextSiblingElement(&child) } {
                    Ok(next) => child = next,
                    Err(_) => break,
                }
            }
        }

        if !structural_pass_through {
            tb.indent(depth);
            tb.emit("</");
            tb.emit(role);
            tb.emit(">\n");
        }
        true
    }

    /// Walk the window's UIA subtree (control view) into axHtml. Retries once for
    /// browsers whose a11y tree is lazy. Mirrors walk_foreground_tree.
    fn walk_foreground_tree(uia: &IUIAutomation, hwnd: HWND, allow_retry: bool) -> String {
        if hwnd.is_invalid() {
            return String::new();
        }
        // SAFETY: `uia` is live and returns a control-view walker for this COM thread.
        let Ok(walker) = (unsafe { uia.ControlViewWalker() }) else {
            return String::new();
        };

        let mut out = String::new();
        for attempt in 0..2 {
            // SAFETY: `hwnd` is a borrowed native window handle; UIA validates access.
            let Ok(root) = (unsafe { uia.ElementFromHandle(hwnd) }) else {
                break;
            };
            let mut tb = TreeBuilder {
                buf: String::new(),
                element_count: 0,
                start: Instant::now(),
                content_chars: 0,
            };
            walk_tree(&mut tb, &walker, &root, 0);
            out = tb.buf;

            if !allow_retry || tb.content_chars >= COLD_TREE_CONTENT_THRESHOLD {
                break;
            }
            let _ = attempt;
            std::thread::sleep(Duration::from_millis(150));
        }
        out
    }

    /// Browsers whose a11y tree may be lazy (drives the cold-tree retry).
    fn is_browser_exe(app_exe: &str) -> bool {
        const BROWSERS: &[&str] = &[
            "chrome.exe",
            "msedge.exe",
            "brave.exe",
            "vivaldi.exe",
            "opera.exe",
            "arc.exe",
            "thorium.exe",
            "firefox.exe",
            "librewolf.exe",
            "zen.exe",
            "waterfox.exe",
        ];
        BROWSERS.iter().any(|b| app_exe.contains(b))
    }

    /// Best-effort browser URL via the omnibox/urlbar AutomationId. Mirrors
    /// find_browser_url. Empty for non-browsers / unreachable address bars.
    fn find_browser_url(uia: &IUIAutomation, hwnd: HWND, app_exe: &str) -> String {
        if hwnd.is_invalid() {
            return String::new();
        }
        let is_chromium = [
            "chrome.exe",
            "msedge.exe",
            "brave.exe",
            "vivaldi.exe",
            "opera.exe",
            "arc.exe",
            "thorium.exe",
        ]
        .iter()
        .any(|b| app_exe.contains(b));
        let is_firefox = ["firefox.exe", "librewolf.exe", "zen.exe", "waterfox.exe"]
            .iter()
            .any(|b| app_exe.contains(b));
        if !is_chromium && !is_firefox {
            return String::new();
        }
        // SAFETY: `hwnd` is a borrowed native window handle; UIA validates access.
        let Ok(root) = (unsafe { uia.ElementFromHandle(hwnd) }) else {
            return String::new();
        };
        // Fast path: the historical stable AutomationId (Firefox "urlbar" and older
        // Chromium "omnibox").
        let target_id: PCWSTR = if is_chromium {
            w!("omnibox")
        } else {
            w!("urlbar")
        };
        // SAFETY: `target_id` is a compile-time null-terminated PCWSTR from `w!`.
        let v = windows::Win32::System::Variant::VARIANT::from(BSTR::from_wide(unsafe {
            target_id.as_wide()
        }));
        // SAFETY: `uia` is live and `v` contains a valid AutomationId string.
        if let Ok(cond) = unsafe { uia.CreatePropertyCondition(UIA_AutomationIdPropertyId, &v) } {
            // SAFETY: `root` and `cond` are live UIA interfaces; no ownership crosses this call.
            if let Ok(el) = unsafe { root.FindFirst(TreeScope_Descendants, &cond) }
                && let Some(url) = read_value_pattern(&el)
                && looks_like_url_or_host(&url)
            {
                return url;
            }
        }

        // Fallback: modern Chrome assigns the omnibox a GENERATED AutomationId (e.g.
        // "view_1012"), so the id match misses. Identify the address bar by value
        // SHAPE instead: among the window's Edit controls (in tree order — the
        // toolbar precedes the web content), the address bar holds a single-line
        // URL/host while page fields hold prose. Return the first URL/host value.
        // Locale-independent (no control-name match) and version-independent.
        let ctype = windows::Win32::System::Variant::VARIANT::from(UIA_EditControlTypeId.0);
        // SAFETY: `uia` is live and `ctype` contains a valid UIA control type id.
        if let Ok(cond) = unsafe { uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &ctype) }
        {
            // SAFETY: `root` and `cond` are live UIA interfaces; no ownership crosses this call.
            if let Ok(edits) = unsafe { root.FindAll(TreeScope_Descendants, &cond) } {
                // SAFETY: `edits` is a live UIA element collection.
                let len = unsafe { edits.Length() }.unwrap_or(0);
                for i in 0..len {
                    // SAFETY: `i` is within the collection length returned by UIA.
                    if let Ok(el) = unsafe { edits.GetElement(i) }
                        && let Some(val) =
                            read_value_pattern(&el).or_else(|| read_text_pattern(&el))
                        && looks_like_url_or_host(&val)
                    {
                        return val;
                    }
                }
            }
        }
        String::new()
    }

    /// True when `value` looks like a browser address-bar URL or bare host (single
    /// line, no whitespace, http(s) scheme or a dotted label-shaped host) — used to
    /// pick the omnibox Edit out of the window's Edit controls without relying on
    /// Chrome's (now generated, unstable) omnibox AutomationId or a localized name.
    fn looks_like_url_or_host(value: &str) -> bool {
        let v = value.trim();
        if v.is_empty() || v.len() > 2048 || v.chars().any(char::is_whitespace) {
            return false;
        }
        if v.starts_with("http://") || v.starts_with("https://") {
            return true;
        }
        // Bare host such as "example.com" / "mail.google.com" (optionally followed
        // by a path): the part before the first '/' is a dotted, label-shaped host.
        let host = v.split('/').next().unwrap_or(v);
        host.contains('.')
            && host.split('.').all(|seg| {
                !seg.is_empty() && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
    }

    // ─────────────────────────── OCR fallback ─────────────────────────────

    /// Tier-2 OCR (report R3): screenshot the target window and recognize its
    /// text with on-device `Windows.Media.Ocr`. Only the pinned window is
    /// captured (never the whole screen). Every failure path — no window, a
    /// zero-size/oversize client area, a GDI or OCR error — yields an empty
    /// string so the caller simply omits the `ocrText` field. Nothing leaves the
    /// machine; the recognized text feeds only the local LLM cleanup + biasing.
    fn capture_window_ocr(hwnd: HWND) -> String {
        if hwnd.is_invalid() {
            return String::new();
        }
        match ocr::capture_window_bgra(hwnd) {
            Some(bitmap) => ocr::recognize(&bitmap).unwrap_or_default(),
            None => String::new(),
        }
    }

    /// Strip empty/whitespace-only lines and join with a single newline, then cap
    /// at `MAX_OCR_CHARS` (task rule: strip empty lines, hard-cap 8k). Pure so the
    /// post-processing is unit-tested without an OCR engine.
    fn tidy_ocr_text(raw: &str) -> String {
        let mut out = String::new();
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(trimmed);
        }
        if out.chars().count() > MAX_OCR_CHARS {
            out = out.chars().take(MAX_OCR_CHARS).collect();
        }
        out
    }

    mod ocr {
        use super::tidy_ocr_text;

        use windows::Globalization::Language;
        use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
        use windows::Media::Ocr::OcrEngine;
        use windows::Storage::Streams::DataWriter;
        use windows::Win32::Foundation::{HWND, RECT};
        use windows::Win32::Graphics::Gdi::{
            BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleBitmap,
            CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, HGDIOBJ,
            ReleaseDC, SRCCOPY, SelectObject,
        };
        use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
        use windows::Win32::UI::WindowsAndMessaging::GetClientRect;
        use windows::core::HSTRING;

        /// `PW_RENDERFULLCONTENT` (2): capture DirectComposition / hardware-
        /// accelerated content (Chromium, games, canvas apps — the exact surfaces
        /// UIA is blind to). Not exported as a named constant by the windows crate
        /// at this version, so it's spelled out here.
        const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

        /// Windows.Media.Ocr's hard input limit. A window larger than this can't be
        /// recognized, so skip rather than error mid-pipeline. (Baseline engine
        /// max is 10 000×10 000; we bail well before to keep the capture cheap.)
        const MAX_CAPTURE_DIMENSION: i32 = 8_192;

        /// A 32-bit top-down BGRA pixel buffer captured from a window, ready to
        /// wrap in a `SoftwareBitmap`. Owned so it outlives the transient GDI DCs.
        pub struct WindowBitmap {
            pixels: Vec<u8>,
            width: i32,
            height: i32,
        }

        /// Screenshot the window's CLIENT area into a top-down BGRA buffer.
        /// `PrintWindow(PW_RENDERFULLCONTENT)` is the primary path (works for
        /// occluded / composited windows without stealing focus); a `BitBlt` from
        /// the window DC is the fallback for windows PrintWindow refuses. Returns
        /// `None` on any failure or a degenerate (empty / oversize) client area.
        pub fn capture_window_bgra(hwnd: HWND) -> Option<WindowBitmap> {
            let (width, height) = client_size(hwnd)?;

            // SAFETY: `hwnd` is a borrowed live window handle; GDI validates it and
            // every created object is released on all exit paths below.
            unsafe {
                let window_dc = GetDC(Some(hwnd));
                if window_dc.is_invalid() {
                    return None;
                }
                let mem_dc = CreateCompatibleDC(Some(window_dc));
                if mem_dc.is_invalid() {
                    ReleaseDC(Some(hwnd), window_dc);
                    return None;
                }
                let bitmap = CreateCompatibleBitmap(window_dc, width, height);
                if bitmap.is_invalid() {
                    let _ = DeleteDC(mem_dc);
                    ReleaseDC(Some(hwnd), window_dc);
                    return None;
                }
                let old = SelectObject(mem_dc, HGDIOBJ(bitmap.0));

                // Primary: PrintWindow with full-content rendering. Fallback: BitBlt
                // the window DC (loses composited/GPU layers but still captures GDI).
                // Both render into the bitmap while it's selected into `mem_dc`.
                let printed = PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT).as_bool();
                let ok = if printed {
                    true
                } else {
                    BitBlt(mem_dc, 0, 0, width, height, Some(window_dc), 0, 0, SRCCOPY).is_ok()
                };

                // GetDIBits requires the bitmap to be DESELECTED from its DC, so
                // restore the DC's original object before reading the pixels out.
                SelectObject(mem_dc, old);

                let pixels = if ok {
                    read_dib_bgra(mem_dc, HGDIOBJ(bitmap.0), width, height)
                } else {
                    None
                };

                // Release GDI objects in reverse order of acquisition.
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
                let _ = DeleteDC(mem_dc);
                ReleaseDC(Some(hwnd), window_dc);

                pixels.map(|pixels| WindowBitmap {
                    pixels,
                    width,
                    height,
                })
            }
        }

        /// The window's client-area size, rejecting degenerate or oversize areas.
        fn client_size(hwnd: HWND) -> Option<(i32, i32)> {
            let mut rect = RECT::default();
            // SAFETY: `hwnd` is a borrowed live window handle and `rect` is valid
            // writable storage for the call.
            unsafe { GetClientRect(hwnd, &mut rect) }.ok()?;
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            if width <= 0
                || height <= 0
                || width > MAX_CAPTURE_DIMENSION
                || height > MAX_CAPTURE_DIMENSION
            {
                return None;
            }
            Some((width, height))
        }

        /// Copy the memory bitmap out as a top-down 32-bit BGRA buffer via
        /// `GetDIBits` (negative `biHeight` requests top-down rows, which is what
        /// `SoftwareBitmap` expects). The bitmap must already be DESELECTED from
        /// `mem_dc` (GetDIBits requires it), which the caller guarantees.
        ///
        /// SAFETY: `mem_dc` is a live DC compatible with `bitmap`, `bitmap` is a
        /// live HBITMAP not currently selected into any DC, and `width`/`height`
        /// match the bitmap's dimensions.
        unsafe fn read_dib_bgra(
            mem_dc: windows::Win32::Graphics::Gdi::HDC,
            bitmap: HGDIOBJ,
            width: i32,
            height: i32,
        ) -> Option<Vec<u8>> {
            let stride = (width as usize).checked_mul(4)?;
            let byte_len = stride.checked_mul(height as usize)?;
            let mut pixels = vec![0u8; byte_len];

            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    // Negative → top-down rows (matches SoftwareBitmap's origin).
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };

            let scanned = unsafe {
                GetDIBits(
                    mem_dc,
                    windows::Win32::Graphics::Gdi::HBITMAP(bitmap.0),
                    0,
                    height as u32,
                    Some(pixels.as_mut_ptr().cast()),
                    &mut info,
                    DIB_RGB_COLORS,
                )
            };
            if scanned == 0 {
                return None;
            }
            Some(pixels)
        }

        /// Recognize text in the captured window via on-device Windows.Media.Ocr.
        /// The engine is created from the user's profile languages (fallback:
        /// English); a machine with no OCR language pack installed returns `None`
        /// and the caller simply omits `ocrText`. Blocks on the async recognize
        /// (`.get()` pumps the STA), which is fine on the per-request sidecar thread
        /// under its own watchdog. The result is empty-line-stripped and 8k-capped.
        pub fn recognize(bitmap: &WindowBitmap) -> Option<String> {
            let engine = create_engine()?;
            let software_bitmap = to_software_bitmap(bitmap)?;
            let result = engine.RecognizeAsync(&software_bitmap).ok()?.get().ok()?;
            let text: HSTRING = result.Text().ok()?;
            let tidied = tidy_ocr_text(&text.to_string_lossy());
            if tidied.is_empty() {
                None
            } else {
                Some(tidied)
            }
        }

        /// Prefer the user's profile languages; fall back to English so a
        /// non-English profile without its OCR pack still recognizes Latin text
        /// (the on-screen names/identifiers the biasing channel cares about).
        fn create_engine() -> Option<OcrEngine> {
            if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
                return Some(engine);
            }
            let english = Language::CreateLanguage(&HSTRING::from("en")).ok()?;
            if OcrEngine::IsLanguageSupported(&english).ok()? {
                OcrEngine::TryCreateFromLanguage(&english).ok()
            } else {
                None
            }
        }

        /// Wrap the BGRA buffer in a WinRT `SoftwareBitmap` (Bgra8, alpha ignored —
        /// OCR is luminance-based, so the GDI-captured alpha channel is irrelevant).
        fn to_software_bitmap(bitmap: &WindowBitmap) -> Option<SoftwareBitmap> {
            let writer = DataWriter::new().ok()?;
            writer.WriteBytes(&bitmap.pixels).ok()?;
            let buffer = writer.DetachBuffer().ok()?;
            SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
                &buffer,
                BitmapPixelFormat::Bgra8,
                bitmap.width,
                bitmap.height,
                BitmapAlphaMode::Ignore,
            )
            .ok()
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn mode_from_str_maps_flags_and_defaults() {
            assert!(Mode::parse_mode("selection") == Mode::Selection);
            assert!(Mode::parse_mode("split") == Mode::Split);
            assert!(Mode::parse_mode("tree") == Mode::Tree);
            assert!(Mode::parse_mode("meta") == Mode::Meta);
            assert!(Mode::parse_mode("focused") == Mode::Focused);
            // Unknown / empty → focused (the safe default).
            assert!(Mode::parse_mode("") == Mode::Focused);
            assert!(Mode::parse_mode("garbage") == Mode::Focused);
        }

        #[test]
        fn parse_serve_request_reads_id_mode_hwnd() {
            let (id, req) = parse_serve_request(r#"{"id":7,"mode":"tree","hwnd":264342}"#);
            let req = req.expect("valid request");
            assert_eq!(id, 7);
            assert_eq!(req.id, 7);
            assert!(req.mode == Mode::Tree);
            assert_eq!(req.hwnd, Some(264342));
        }

        #[test]
        fn parse_serve_request_defaults_mode_and_omits_hwnd() {
            let (id, req) = parse_serve_request(r#"{"id":3}"#);
            let req = req.expect("valid request");
            assert_eq!(id, 3);
            assert!(req.mode == Mode::Focused);
            assert_eq!(req.hwnd, None);
        }

        #[test]
        fn parse_serve_request_treats_zero_hwnd_as_foreground() {
            let (_, req) = parse_serve_request(r#"{"id":1,"mode":"split","hwnd":0}"#);
            let req = req.expect("valid request");
            assert!(req.mode == Mode::Split);
            // hwnd 0 means "use foreground", i.e. no --hwnd scope.
            assert_eq!(req.hwnd, None);
        }

        #[test]
        fn parse_serve_request_rejects_bad_json() {
            assert!(parse_serve_request("not json at all").1.is_none());
            assert!(parse_serve_request("{").1.is_none());
            // A JSON array is not a request object.
            assert!(parse_serve_request("[1,2,3]").1.is_none());
        }

        #[test]
        fn parse_serve_request_recovers_id_from_partial_object() {
            // Even a request object missing "mode" is usable (defaults to focused);
            // this asserts the id round-trips for correlation.
            let (id, req) = parse_serve_request(r#"{"id":42,"extra":"ignored"}"#);
            assert_eq!(id, 42);
            assert!(req.is_some());
        }

        #[test]
        fn parse_serve_request_reads_ocr_flag() {
            // Present + true → carried through.
            let (_, req) = parse_serve_request(r#"{"id":1,"mode":"split","ocr":true}"#);
            assert!(req.expect("valid").ocr);
            // Explicit false → false.
            let (_, req) = parse_serve_request(r#"{"id":1,"mode":"split","ocr":false}"#);
            assert!(!req.expect("valid").ocr);
            // Missing → false (opt-in default), and a non-bool value doesn't panic.
            let (_, req) = parse_serve_request(r#"{"id":1,"mode":"split"}"#);
            assert!(!req.expect("valid").ocr);
            let (_, req) = parse_serve_request(r#"{"id":1,"mode":"split","ocr":"yes"}"#);
            assert!(!req.expect("valid").ocr);
        }

        #[test]
        fn should_run_ocr_requires_optin_and_empty_uia() {
            // Opt-in + nothing from UIA → run OCR.
            assert!(should_run_ocr(true, false, "", "", "", ""));
            // Whitespace-only UIA reads still count as empty → run OCR.
            assert!(should_run_ocr(true, false, "  ", "\n", "\t", "   "));
        }

        #[test]
        fn should_run_ocr_never_without_optin() {
            // No opt-in → never OCR, even with empty UIA.
            assert!(!should_run_ocr(false, false, "", "", "", ""));
        }

        #[test]
        fn should_run_ocr_never_on_password() {
            // Password-focused field → never OCR, even opted-in with empty UIA
            // (a screenshot could still expose typed-but-masked content).
            assert!(!should_run_ocr(true, true, "", "", "", ""));
        }

        #[test]
        fn should_run_ocr_skips_when_uia_has_text() {
            // Any single non-empty UIA channel suppresses the fallback.
            assert!(!should_run_ocr(true, false, "focused", "", "", ""));
            assert!(!should_run_ocr(true, false, "", "before", "", ""));
            assert!(!should_run_ocr(true, false, "", "", "after", ""));
            assert!(!should_run_ocr(true, false, "", "", "", "<doc/>"));
        }

        #[test]
        fn tidy_ocr_text_strips_empty_lines_and_trims() {
            let raw = "  first line \n\n\t\n  second  \n   \nthird\n";
            assert_eq!(tidy_ocr_text(raw), "first line\nsecond\nthird");
            // Entirely blank input → empty string.
            assert_eq!(tidy_ocr_text("\n  \n\t\n"), "");
        }

        #[test]
        fn tidy_ocr_text_caps_at_max_ocr_chars() {
            // A single very long line is capped at MAX_OCR_CHARS (chars, not bytes).
            let long = "x".repeat(MAX_OCR_CHARS + 500);
            let out = tidy_ocr_text(&long);
            assert_eq!(out.chars().count(), MAX_OCR_CHARS);
        }

        /// MANUAL live-OCR harness (report R3). Ignored by default: it needs a
        /// real foreground window AND a Windows OCR language pack, neither of which
        /// the CI/build host guarantees, and it depends on whatever is on screen.
        /// Run interactively with a text-heavy window focused:
        ///
        ///   cargo test --bin winstt_context -- --ignored ocr_pipeline_live_smoke
        ///
        /// It exercises the whole GDI-capture → SoftwareBitmap → Windows.Media.Ocr
        /// path against the foreground window and asserts the result is well-formed
        /// (no panic, no line exceeds the char cap). An OCR-less machine yields an
        /// empty string, which is the correct "no fallback text" outcome — so this
        /// can't hard-fail on capability; it fails only on a malformed result.
        #[test]
        #[ignore = "manual: needs a focused window + installed OCR language pack"]
        fn ocr_pipeline_live_smoke() {
            // SAFETY: WinRT OCR needs an initialized COM apartment on this thread.
            let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            // SAFETY: reads the current foreground window handle; no ownership moves.
            let fg = unsafe { GetForegroundWindow() };
            let text = capture_window_ocr(fg);
            // Empty is legitimate (no OCR pack / blank window); when non-empty it
            // must respect the 8k cap and carry no blank lines.
            assert!(text.chars().count() <= MAX_OCR_CHARS);
            assert!(!text.lines().any(|l| l.trim().is_empty()));
        }

        /// The `--serve` framing contract, exercised in-process without COM/UIA
        /// or a spawned binary (so it is deterministic and always runs): three
        /// lines — a valid request, malformed JSON, another valid request — and
        /// each yields a correlated response, with the malformed line NOT
        /// derailing the id sequence. `capture` is faked to echo the id so the
        /// test isolates framing + bad-JSON survival from the UIA capture.
        #[test]
        fn format_serve_response_correlates_and_survives_bad_json() {
            let fake_capture = |req: Request| format!(r#"{{"id":{},"ok":true}}"#, req.id);

            // 1) Valid request → the capture runs and its (id-bearing) body is
            //    returned verbatim.
            let r1 = format_serve_response(r#"{"id":1,"mode":"focused"}"#, fake_capture);
            let v1: serde_json::Value = serde_json::from_str(&r1).unwrap();
            assert_eq!(v1.get("id").and_then(serde_json::Value::as_u64), Some(1));

            // 2) Malformed line → correlated error, id 0, and (crucially) it does
            //    NOT invoke `capture` — the framing recovered on its own.
            let r2 = format_serve_response("this is not json", |_| {
                panic!("capture must not run for a malformed line")
            });
            let v2: serde_json::Value = serde_json::from_str(&r2).unwrap();
            assert_eq!(v2.get("id").and_then(serde_json::Value::as_u64), Some(0));
            assert_eq!(
                v2.get("error").and_then(serde_json::Value::as_str),
                Some("bad_request")
            );

            // 3) The next valid line still frames correctly after the bad one.
            let r3 = format_serve_response(r#"{"id":2,"mode":"tree"}"#, fake_capture);
            let v3: serde_json::Value = serde_json::from_str(&r3).unwrap();
            assert_eq!(v3.get("id").and_then(serde_json::Value::as_u64), Some(2));
        }

        /// A partial object (missing "mode") is still a valid request that runs
        /// the capture (defaulting to focused) — it is NOT a `bad_request`.
        #[test]
        fn format_serve_response_runs_capture_for_partial_object() {
            let r = format_serve_response(r#"{"id":5}"#, |req| {
                assert!(req.mode == Mode::Focused);
                format!(r#"{{"id":{}}}"#, req.id)
            });
            let v: serde_json::Value = serde_json::from_str(&r).unwrap();
            assert_eq!(v.get("id").and_then(serde_json::Value::as_u64), Some(5));
            assert!(v.get("error").is_none());
        }

        /// End-to-end `--serve` smoke against the REAL binary when a `--serve`-
        /// capable build is on disk. Self-skips (does not fail) when the located
        /// exe is stale/absent — the in-process test above is the always-run
        /// contract; this adds a live spawn+survival check when the fresh binary
        /// is available (e.g. after `cargo build --bin winstt_context`).
        #[test]
        fn serve_mode_spawns_and_survives_when_binary_supports_it() {
            use std::io::{BufRead, BufReader, Write};
            use std::process::{Command, Stdio};
            use std::sync::mpsc;
            use std::time::Duration;

            let exe = option_env!("CARGO_BIN_EXE_winstt_context")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("target/debug/winstt_context.exe")
                });
            if !exe.exists() {
                return;
            }

            let mut child = match Command::new(&exe)
                .arg("--serve")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(_) => return,
            };
            let mut stdin = child.stdin.take().expect("stdin");
            let stdout = child.stdout.take().expect("stdout");

            let (tx, rx) = mpsc::channel::<String>();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if tx.send(line.clone()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            let recv = |rx: &mpsc::Receiver<String>| -> Option<serde_json::Value> {
                let line = rx.recv_timeout(Duration::from_secs(5)).ok()?;
                serde_json::from_str::<serde_json::Value>(line.trim()).ok()
            };

            // Probe: a stale (pre-`--serve`) binary prints an id-less one-shot
            // snapshot then exits. Detect that and self-skip rather than fail.
            writeln!(stdin, r#"{{"id":1,"mode":"focused"}}"#).unwrap();
            stdin.flush().unwrap();
            let Some(r1) = recv(&rx) else {
                let _ = child.kill();
                return;
            };
            if r1.get("id").and_then(serde_json::Value::as_u64) != Some(1) {
                // Stale binary without --serve support — skip.
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            assert!(r1.get("windowTitle").is_some(), "snapshot fields present");

            // Malformed line → correlated error, server SURVIVES.
            writeln!(stdin, "this is not json").unwrap();
            stdin.flush().unwrap();
            let r2 = recv(&rx).expect("error response");
            assert_eq!(r2.get("id").and_then(serde_json::Value::as_u64), Some(0));
            assert_eq!(
                r2.get("error").and_then(serde_json::Value::as_str),
                Some("bad_request")
            );

            // A third valid request after the bad line proves the loop survived.
            writeln!(stdin, r#"{{"id":2,"mode":"tree"}}"#).unwrap();
            stdin.flush().unwrap();
            let r3 = recv(&rx).expect("third response");
            assert_eq!(r3.get("id").and_then(serde_json::Value::as_u64), Some(2));

            drop(stdin);
            let _ = child.wait();
        }
    }
}

// ─────────────────────────── macOS (AX-API) ───────────────────────────
//
// Focused-field reader via the Accessibility API (HIServices / AXUIElement). We
// bind the minimal CoreFoundation + ApplicationServices C ABI directly rather than
// the typed `objc2-application-services` wrappers: those methods take `&CFString` /
// `NonNull<*const CFType>` from `objc2-core-foundation`, which is only a transitive
// dependency here (not directly nameable), and the free-function forms are
// `#[deprecated]` (they would trip `warnings = "deny"`). The direct FFI is
// feature-flag-independent and self-contained; the framework linkage is guaranteed
// by the `#[link]` attributes below. Reading needs the Accessibility permission
// (granted out-of-band via `tauri_plugin_macos_permissions`); when it is absent —
// or any AX call fails — an empty, well-formed snapshot is printed.
#[cfg(target_os = "macos")]
mod macos_impl {
    use std::ffi::c_void;
    use std::ptr;
    use std::time::Duration;

    use super::{CARET_AFTER_CHARS, CARET_BEFORE_CHARS, NwMode, NwSnapshot, nw_parse_mode};

    // ── Minimal CoreFoundation / ApplicationServices C ABI ──
    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type CFIndex = isize;
    type CFTypeID = usize;
    type Boolean = u8;
    type AXError = i32;
    type CFStringEncoding = u32;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CFRange {
        location: CFIndex,
        length: CFIndex,
    }

    // kCFStringEncodingUTF8.
    const CF_STRING_ENCODING_UTF8: CFStringEncoding = 0x0800_0100;
    // kAXValueTypeCFRange (AXValue.rs: `pub const CFRange: Self = Self(4)`).
    const AX_VALUE_TYPE_CFRANGE: u32 = 4;
    // kAXErrorSuccess (AXError.rs: `pub const Success: Self = Self(0)`).
    const AX_ERROR_SUCCESS: AXError = 0;
    const CF_ALLOCATOR_DEFAULT: CFAllocatorRef = ptr::null();

    // PROC_PIDPATHINFO_MAXSIZE (4 * MAXPATHLEN).
    const PROC_PIDPATH_MAX: usize = 4096;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: CFTypeRef);
        fn CFGetTypeID(cf: CFTypeRef) -> CFTypeID;
        fn CFStringGetTypeID() -> CFTypeID;
        fn CFStringCreateWithBytes(
            alloc: CFAllocatorRef,
            bytes: *const u8,
            num_bytes: CFIndex,
            encoding: CFStringEncoding,
            is_external_representation: Boolean,
        ) -> CFStringRef;
        fn CFStringGetLength(the_string: CFStringRef) -> CFIndex;
        fn CFStringGetBytes(
            the_string: CFStringRef,
            range: CFRange,
            encoding: CFStringEncoding,
            loss_byte: u8,
            is_external_representation: Boolean,
            buffer: *mut u8,
            max_buf_len: CFIndex,
            used_buf_len: *mut CFIndex,
        ) -> CFIndex;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> Boolean;
        fn AXUIElementCreateSystemWide() -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(
            element: CFTypeRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
        fn AXUIElementGetPid(element: CFTypeRef, pid: *mut i32) -> AXError;
        fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut c_void) -> Boolean;
    }

    // libproc lives in libSystem (always linked); maps the focused app's pid to
    // its executable path, whose basename is the closest analog to the Windows
    // `appExe` the deny-list matches on.
    unsafe extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut c_void, buffersize: u32) -> i32;
    }

    /// RAII wrapper that `CFRelease`s an owned (+1) CoreFoundation object on drop,
    /// so every `Copy`/`Create` result is balanced on all paths.
    struct CfOwned(CFTypeRef);

    impl Drop for CfOwned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: `self.0` is a non-null CF object this owns a +1 ref to.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    impl CfOwned {
        fn get(&self) -> CFTypeRef {
            self.0
        }
    }

    pub fn run() {
        // Hard watchdog: a wedged AX call can hang the process; exit so the manager
        // sees a dead child and falls back (mirrors the Windows one-shot watchdog).
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(2_000));
            std::process::exit(3);
        });

        let mode = nw_parse_mode();
        let snapshot = read(mode).unwrap_or_else(NwSnapshot::empty);
        snapshot.print();
    }

    /// Read the focused-field context. Returns `None` (→ empty snapshot) when the
    /// Accessibility permission is missing or no focused element is reachable.
    fn read(mode: NwMode) -> Option<NwSnapshot> {
        // SAFETY: plain C predicate, no arguments.
        if unsafe { AXIsProcessTrusted() } == 0 {
            return None;
        }
        // SAFETY: constructs the system-wide AX element; may return null.
        let system = unsafe { AXUIElementCreateSystemWide() };
        if system.is_null() {
            return None;
        }
        let system = CfOwned(system);

        let focused = copy_attr(system.get(), "AXFocusedUIElement")?;
        let felem = focused.get();

        let mut snap = NwSnapshot::empty();

        // App identity: the focused element's owning pid → executable basename.
        let mut pid: i32 = 0;
        // SAFETY: `felem` is a live AX element and `pid` is valid writable storage.
        if unsafe { AXUIElementGetPid(felem, &mut pid) } == AX_ERROR_SUCCESS {
            snap.app_exe = app_exe_for_pid(pid);
        }

        // Element name: prefer the title, fall back to the description.
        snap.element_name = copy_attr_string(felem, "AXTitle")
            .filter(|s| !s.is_empty())
            .or_else(|| copy_attr_string(felem, "AXDescription"))
            .unwrap_or_default();

        // Window title: the focused element's window, else the focused app's title.
        if let Some(window) = copy_attr(felem, "AXWindow") {
            snap.window_title = copy_attr_string(window.get(), "AXTitle").unwrap_or_default();
        }
        if snap.window_title.is_empty()
            && let Some(app) = copy_attr(system.get(), "AXFocusedApplication")
        {
            snap.window_title = copy_attr_string(app.get(), "AXTitle").unwrap_or_default();
        }

        if mode == NwMode::Meta {
            return Some(snap);
        }

        // Password guard: secure text fields carry the AXSecureTextField subrole.
        // Their (masked) contents are never read — mirror the Windows guard.
        if copy_attr_string(felem, "AXSubrole").as_deref() == Some("AXSecureTextField") {
            snap.is_password = true;
            return Some(snap);
        }

        match mode {
            NwMode::Selection => {
                snap.focused_text = copy_attr_string(felem, "AXSelectedText").unwrap_or_default();
            }
            NwMode::Split | NwMode::Tree => {
                let value = copy_attr_string(felem, "AXValue").unwrap_or_default();
                if let Some(range) = copy_selected_range(felem) {
                    // AX text ranges index the UTF-16 representation; split there.
                    let units: Vec<u16> = value.encode_utf16().collect();
                    let total = units.len();
                    let caret = clamp_usize(range.location, total);
                    let sel_end =
                        clamp_usize(range.location.saturating_add(range.length.max(0)), total);
                    let before_start = caret.saturating_sub(CARET_BEFORE_CHARS as usize);
                    let after_end = sel_end
                        .saturating_add(CARET_AFTER_CHARS as usize)
                        .min(total);
                    snap.text_before = String::from_utf16_lossy(&units[before_start..caret]);
                    snap.text_after = String::from_utf16_lossy(&units[sel_end..after_end]);
                } else {
                    // No caret/selection — degrade to the whole-field value.
                    snap.focused_text = value;
                }
            }
            NwMode::Focused => {
                snap.focused_text = copy_attr_string(felem, "AXValue").unwrap_or_default();
            }
            NwMode::Meta => {}
        }

        Some(snap)
    }

    /// Clamp a CFIndex (may be negative on a stale range) into `0..=max` as usize.
    fn clamp_usize(value: CFIndex, max: usize) -> usize {
        if value <= 0 {
            0
        } else {
            (value as usize).min(max)
        }
    }

    /// Create a CoreFoundation string from a UTF-8 `&str` (owned; `CFRelease`d on
    /// drop). `None` if allocation fails.
    fn cfstr(s: &str) -> Option<CfOwned> {
        let bytes = s.as_bytes();
        // SAFETY: `bytes`/`len` describe a valid UTF-8 buffer; the default allocator
        // is null and the result is an owned (+1) CFString or null.
        let cf = unsafe {
            CFStringCreateWithBytes(
                CF_ALLOCATOR_DEFAULT,
                bytes.as_ptr(),
                bytes.len() as CFIndex,
                CF_STRING_ENCODING_UTF8,
                0,
            )
        };
        if cf.is_null() {
            None
        } else {
            Some(CfOwned(cf))
        }
    }

    /// Copy a UI element's attribute value as an owned CF object, or `None` when
    /// the attribute is unsupported / has no value.
    fn copy_attr(element: CFTypeRef, name: &str) -> Option<CfOwned> {
        let attr = cfstr(name)?;
        let mut value: CFTypeRef = ptr::null();
        // SAFETY: `element` is a live AX element, `attr` a live CFString, and
        // `value` valid writable storage; success yields an owned (+1) object.
        let err = unsafe { AXUIElementCopyAttributeValue(element, attr.get(), &mut value) };
        if err != AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        Some(CfOwned(value))
    }

    /// Copy an attribute value and decode it as a UTF-8 string (when it is a
    /// CFString).
    fn copy_attr_string(element: CFTypeRef, name: &str) -> Option<String> {
        let value = copy_attr(element, name)?;
        cfstring_to_string(value.get())
    }

    /// Copy the AXSelectedTextRange (an AXValue wrapping a CFRange) and unwrap it.
    fn copy_selected_range(element: CFTypeRef) -> Option<CFRange> {
        let value = copy_attr(element, "AXSelectedTextRange")?;
        let mut range = CFRange {
            location: 0,
            length: 0,
        };
        // SAFETY: `value` is an AXValue; requesting the CFRange type writes into the
        // provided `CFRange` slot and returns non-zero on success.
        let ok = unsafe {
            AXValueGetValue(
                value.get(),
                AX_VALUE_TYPE_CFRANGE,
                (&mut range as *mut CFRange).cast(),
            )
        };
        if ok == 0 { None } else { Some(range) }
    }

    /// Decode a `CFStringRef` into an owned `String` (UTF-8). Returns `None` when
    /// the object is null or not a CFString; an empty string decodes to `Some("")`.
    fn cfstring_to_string(cf: CFStringRef) -> Option<String> {
        if cf.is_null() {
            return None;
        }
        // SAFETY: `cf` is a live CF object; the type-id gate ensures it is a
        // CFString before any CFString-specific call below.
        unsafe {
            if CFGetTypeID(cf) != CFStringGetTypeID() {
                return None;
            }
            let len_utf16 = CFStringGetLength(cf);
            if len_utf16 <= 0 {
                return Some(String::new());
            }
            let range = CFRange {
                location: 0,
                length: len_utf16,
            };
            // First pass: measure the UTF-8 byte length.
            let mut used: CFIndex = 0;
            CFStringGetBytes(
                cf,
                range,
                CF_STRING_ENCODING_UTF8,
                0,
                0,
                ptr::null_mut(),
                0,
                &mut used,
            );
            if used <= 0 {
                return Some(String::new());
            }
            // Second pass: fill the buffer.
            let mut buf = vec![0u8; used as usize];
            let mut written: CFIndex = 0;
            let converted = CFStringGetBytes(
                cf,
                range,
                CF_STRING_ENCODING_UTF8,
                0,
                0,
                buf.as_mut_ptr(),
                used,
                &mut written,
            );
            if converted <= 0 {
                return None;
            }
            buf.truncate(written.max(0) as usize);
            Some(String::from_utf8_lossy(&buf).into_owned())
        }
    }

    /// The process executable basename (lowercased) for `pid`, matching the
    /// Windows `appExe` convention. Empty on failure.
    fn app_exe_for_pid(pid: i32) -> String {
        if pid <= 0 {
            return String::new();
        }
        let mut buf = vec![0u8; PROC_PIDPATH_MAX];
        // SAFETY: `buf` is valid writable storage of the declared size.
        let n = unsafe { proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
        if n <= 0 {
            return String::new();
        }
        buf.truncate(n as usize);
        let path = String::from_utf8_lossy(&buf).into_owned();
        let base = path.rsplit(['/', '\\']).next().unwrap_or(&path);
        base.to_lowercase()
    }
}

// ─────────────────────────── Linux (AT-SPI) ───────────────────────────
//
// Focused-field reader over AT-SPI (atspi + zbus). AT-SPI has no direct "focused
// element" query, so we walk the registry desktop tree (bounded by node + depth
// caps) for the accessible carrying `State::Focused` that also implements the
// `Text` interface, then read its caret offset / character count / selection /
// surrounding text. atspi is async; the sidecar is a short-lived process, so we
// drive the futures to completion on a local Tokio current-thread runtime (zbus
// is built on its async-io backend here and self-drives its D-Bus I/O on an
// internal thread, so any runtime can poll the top-level future). When the
// accessibility bus isn't running, or no focused text element exists, an empty
// snapshot is printed.
#[cfg(target_os = "linux")]
mod linux_impl {
    use std::time::Duration;

    use atspi::connection::AccessibilityConnection;
    use atspi::proxy::accessible::{AccessibleProxy, ObjectRefExt};
    use atspi::proxy::text::TextProxy;
    use atspi::{Interface, InterfaceSet, ObjectRefOwned, Role, State};
    use zbus::proxy::CacheProperties;

    use super::{
        CARET_AFTER_CHARS, CARET_BEFORE_CHARS, MAX_CONTEXT_CHARS, NwMode, NwSnapshot, nw_parse_mode,
    };

    /// Cap on accessibles visited while searching for the focused element (a live
    /// desktop tree can be large; the search is best-effort and bounded).
    const MAX_NODES: usize = 2_500;
    /// Cap on descent depth from each application root.
    const MAX_DEPTH: usize = 30;

    pub fn run() {
        // Hard watchdog: a wedged D-Bus round-trip can hang; exit so the manager
        // sees a dead child and falls back (mirrors the Windows one-shot watchdog).
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(2_500));
            std::process::exit(3);
        });

        let mode = nw_parse_mode();
        // atspi is async; drive it to completion on a local Tokio runtime. This is
        // the sidecar's main thread with no ambient runtime, so building one here is
        // safe. zbus's connection self-drives its I/O regardless of this runtime.
        let snapshot = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime
                .block_on(read(mode))
                .unwrap_or_else(NwSnapshot::empty),
            Err(_) => NwSnapshot::empty(),
        };
        snapshot.print();
    }

    async fn read(mode: NwMode) -> Option<NwSnapshot> {
        let connection = AccessibilityConnection::new().await.ok()?;
        let bus = connection.connection();

        // The AT-SPI registry's accessible desktop root; its children are the apps.
        let root = AccessibleProxy::builder(bus)
            .destination("org.a11y.atspi.Registry")
            .ok()?
            .path("/org/a11y/atspi/accessible/root")
            .ok()?
            .cache_properties(CacheProperties::No)
            .build()
            .await
            .ok()?;

        let focused_ref = find_focused_text(bus, &root).await?;
        let focused = focused_ref.as_accessible_proxy(bus).await.ok()?;

        let mut snap = NwSnapshot::empty();

        // App identity: the application ancestor's name, lowercased to mirror the
        // Windows `appExe` basename convention used by the deny-list matcher.
        if let Ok(app_ref) = focused.get_application().await
            && let Ok(app) = app_ref.as_accessible_proxy(bus).await
            && let Ok(name) = app.name().await
        {
            snap.app_exe = name.trim().to_lowercase();
        }

        snap.element_name = focused.name().await.unwrap_or_default();
        snap.window_title = window_title(bus, &focused).await;

        if mode == NwMode::Meta {
            return Some(snap);
        }

        // Password guard: AT-SPI exposes secure entries as Role::PasswordText.
        if focused.get_role().await.unwrap_or(Role::Invalid) == Role::PasswordText {
            snap.is_password = true;
            return Some(snap);
        }

        // Text interface on the focused object (offsets are in characters).
        let text = TextProxy::builder(bus)
            .destination(focused_ref.name()?.clone())
            .ok()?
            .path(focused_ref.path().clone())
            .ok()?
            .cache_properties(CacheProperties::No)
            .build()
            .await
            .ok()?;

        let count = text.character_count().await.unwrap_or(0).max(0);

        match mode {
            NwMode::Selection => {
                if text.get_n_selections().await.unwrap_or(0) > 0
                    && let Ok((start, end)) = text.get_selection(0).await
                    && end > start
                {
                    snap.focused_text = text.get_text(start, end).await.unwrap_or_default();
                }
            }
            NwMode::Split | NwMode::Tree => {
                let caret = text.caret_offset().await.unwrap_or(0).clamp(0, count);
                let before_start = (caret - CARET_BEFORE_CHARS).max(0);
                let after_end = (caret + CARET_AFTER_CHARS).min(count);
                if caret > before_start {
                    snap.text_before = text.get_text(before_start, caret).await.unwrap_or_default();
                }
                if after_end > caret {
                    snap.text_after = text.get_text(caret, after_end).await.unwrap_or_default();
                }
            }
            NwMode::Focused => {
                let end = count.min(MAX_CONTEXT_CHARS as i32);
                if end > 0 {
                    snap.focused_text = text.get_text(0, end).await.unwrap_or_default();
                }
            }
            NwMode::Meta => {}
        }

        Some(snap)
    }

    /// Bounded depth-first search from the desktop root for the first accessible
    /// that is `State::Focused` and implements the `Text` interface.
    async fn find_focused_text(
        bus: &zbus::Connection,
        root: &AccessibleProxy<'_>,
    ) -> Option<ObjectRefOwned> {
        let mut stack: Vec<(ObjectRefOwned, usize)> = root
            .get_children()
            .await
            .ok()?
            .into_iter()
            .map(|child| (child, 0usize))
            .collect();

        let mut visited = 0usize;
        while let Some((obj, depth)) = stack.pop() {
            if visited >= MAX_NODES {
                break;
            }
            visited += 1;

            let Ok(proxy) = obj.as_accessible_proxy(bus).await else {
                continue;
            };
            if proxy
                .get_state()
                .await
                .unwrap_or_default()
                .contains(State::Focused)
            {
                let interfaces = proxy
                    .get_interfaces()
                    .await
                    .unwrap_or_else(|_| InterfaceSet::empty());
                if interfaces.contains(Interface::Text) {
                    return Some(obj);
                }
            }
            if depth < MAX_DEPTH
                && let Ok(children) = proxy.get_children().await
            {
                for child in children {
                    stack.push((child, depth + 1));
                }
            }
        }
        None
    }

    /// Walk ancestors from the focused element to the enclosing frame / window /
    /// dialog and return its name as the window title. Empty when none is found.
    async fn window_title(bus: &zbus::Connection, focused: &AccessibleProxy<'_>) -> String {
        let mut current = match focused.parent().await {
            Ok(parent) => parent,
            Err(_) => return String::new(),
        };
        for _ in 0..MAX_DEPTH {
            let Ok(proxy) = current.as_accessible_proxy(bus).await else {
                break;
            };
            let role = proxy.get_role().await.unwrap_or(Role::Invalid);
            if matches!(role, Role::Frame | Role::Window | Role::Dialog) {
                return proxy.name().await.unwrap_or_default().trim().to_string();
            }
            match proxy.parent().await {
                // A root/self-parent terminates the walk (avoids a cycle).
                Ok(parent) if parent == current => break,
                Ok(parent) => current = parent,
                Err(_) => break,
            }
        }
        String::new()
    }
}
