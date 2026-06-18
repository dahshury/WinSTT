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
//
// Output (stdout, single line, UTF-8 JSON):
//   {"windowTitle":"...","elementName":"...","focusedText":"...",
//    "textBefore":"...","textAfter":"...","appExe":"...","url":"...","axHtml":"..."}
//
// Caps + the 750ms watchdog mirror the C source (MAX_CONTEXT_CHARS = 24000;
// MAX_AXHTML_CHARS = 150000; TREE_WALK_BUDGET_MS = 600; WATCHDOG_TIMEOUT_MS = 750).
// On non-Windows this is a stub that prints an empty snapshot.

#![cfg_attr(
    not(windows),
    expect(
        unused,
        reason = "non-Windows sidecar build is a stub that leaves Windows UIA code unused"
    )
)]

// ─────────────────────────── shared caps ──────────────────────────────

/// Whole-field + caret context budget (chars). Matches MAX_CONTEXT_CHARS.
const MAX_CONTEXT_CHARS: usize = 24_000;
/// Tail before the caret (the continuation-deciding slice). CARET_BEFORE_CHARS.
const CARET_BEFORE_CHARS: i32 = 21_000;
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

fn main() {
    #[cfg(windows)]
    windows_impl::run();
    #[cfg(not(windows))]
    {
        // No UIA off Windows — emit the cheap empty 3-field shape.
        print!(
            "{{\"windowTitle\":\"\",\"elementName\":\"\",\"focusedText\":\"\",\
             \"textBefore\":\"\",\"textAfter\":\"\",\"appExe\":\"\",\
             \"url\":\"\",\"axHtml\":\"\"}}"
        );
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;

    use std::time::{Duration, Instant};

    use windows::core::{w, BSTR, PCWSTR};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
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

    // ─────────────────────── CLI parse + dispatch ─────────────────────────

    struct Cli {
        selection_only: bool,
        split: bool,
        tree: bool,
        hwnd: Option<isize>,
    }

    fn parse_cli() -> Cli {
        let mut cli = Cli {
            selection_only: false,
            split: false,
            tree: false,
            hwnd: None,
        };
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--selection" => cli.selection_only = true,
                "--split" => cli.split = true,
                "--tree" => cli.tree = true,
                "--hwnd" => {
                    if let Some(v) = args.next() {
                        // Decimal HWND, matching the C `_strtoui64(.., 10)`.
                        if let Ok(value) = v.trim().parse::<u64>() {
                            if value > 0 {
                                cli.hwnd = Some(value as isize);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        cli
    }

    pub fn run() {
        let cli = parse_cli();

        // Hard watchdog: a wedged UIA walk can hang COM. Kill the process after
        // the timeout, mirroring the C ExitProcess(3). main() races it.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(WATCHDOG_TIMEOUT_MS));
            std::process::exit(3);
        });

        let scope = cli.hwnd.map(|h| HWND(h as *mut _));

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

        // COM apartment (single-threaded, like the C COINIT_APARTMENTTHREADED).
        // SAFETY: Initializes COM for this helper process thread before any UIA COM calls.
        let co = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        // RPC_E_CHANGED_MODE is harmless. Any other hard failure → emit metadata only.
        let com_ok = co.is_ok() || co == windows::Win32::Foundation::RPC_E_CHANGED_MODE;

        if com_ok {
            // SAFETY: COM was initialized or already in a compatible mode; the UIA instance is
            // used only on this thread and released before CoUninitialize.
            if let Ok(uia) = unsafe {
                CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
            } {
                if cli.tree {
                    read_focused_split(
                        &uia,
                        scope,
                        &mut context_before,
                        &mut context_after,
                        &mut focused_text,
                        &mut element_name,
                    );
                    ax_html = walk_foreground_tree(&uia, fg, is_browser_exe(&app_exe));
                    url = find_browser_url(&uia, fg, &app_exe);
                } else if cli.split {
                    read_focused_split(
                        &uia,
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
                    url = find_browser_url(&uia, fg, &app_exe);
                } else {
                    read_focused_context(
                        &uia,
                        scope,
                        cli.selection_only,
                        &mut focused_text,
                        &mut element_name,
                    );
                }
            }
            // Drop `uia` (Release) before CoUninitialize.
            // SAFETY: Balances this thread's successful CoInitializeEx call.
            unsafe { CoUninitialize() };
        }

        // Defensive truncation (chars), mirroring the C byte-cap intent.
        truncate_chars(&mut focused_text, MAX_CONTEXT_CHARS);
        truncate_chars(&mut context_before, MAX_CONTEXT_CHARS);
        truncate_chars(&mut context_after, MAX_CONTEXT_CHARS);

        // Single-line JSON, key order identical to the C printf.
        let out = format!(
            "{{\"windowTitle\":\"{}\",\"elementName\":\"{}\",\"focusedText\":\"{}\",\
             \"textBefore\":\"{}\",\"textAfter\":\"{}\",\"appExe\":\"{}\",\
             \"url\":\"{}\",\"axHtml\":\"{}\"}}",
            json_escape(&window_title),
            json_escape(&element_name),
            json_escape(&focused_text),
            json_escape(&context_before),
            json_escape(&context_after),
            json_escape(&app_exe),
            json_escape(&url),
            json_escape(&ax_html),
        );
        print!("{out}");
        use std::io::Write;
        let _ = std::io::stdout().flush();
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
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
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
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }

    /// ValuePattern.CurrentValue (plain edit controls / address bars).
    fn read_value_pattern(elem: &IUIAutomationElement) -> Option<String> {
        // SAFETY: `elem` is a live UIA element and the requested pattern/interface type matches.
        let pat: IUIAutomationValuePattern =
            unsafe { elem.GetCurrentPatternAs(UIA_ValuePatternId) }.ok()?;
        // SAFETY: `pat` is a live ValuePattern interface returned by UIA.
        let text: BSTR = unsafe { pat.CurrentValue() }.ok()?;
        let s = text.to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
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

    /// Default/selection mode: name + focused text (TextPattern → ValuePattern,
    /// or selection-only). Mirrors read_focused_context.
    fn read_focused_context(
        uia: &IUIAutomation,
        scope: Option<HWND>,
        selection_only: bool,
        out_text: &mut String,
        out_name: &mut String,
    ) {
        let Some(focused) = acquire_focused_element(uia, scope) else {
            return;
        };
        *out_name = read_element_name(&focused);
        let text = if selection_only {
            read_text_pattern_selection(&focused)
        } else {
            read_text_pattern(&focused).or_else(|| read_value_pattern(&focused))
        };
        if let Some(text) = text {
            *out_text = text;
        }
    }

    /// --split / --tree caret read: name + caret-split before/after, falling back
    /// to whole-text into out_text when no caret. Mirrors read_focused_split.
    fn read_focused_split(
        uia: &IUIAutomation,
        scope: Option<HWND>,
        out_before: &mut String,
        out_after: &mut String,
        out_text: &mut String,
        out_name: &mut String,
    ) {
        let Some(focused) = acquire_focused_element(uia, scope) else {
            return;
        };
        *out_name = read_element_name(&focused);
        if !read_caret_split(&focused, out_before, out_after) {
            // No caret — degrade to the whole-text read.
            if let Some(text) = read_text_pattern(&focused).or_else(|| read_value_pattern(&focused))
            {
                *out_text = text;
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
                    if let Ok(text) = tail.GetText(-1) {
                        *out_before = text.to_string();
                    }
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
            if let Ok(el) = unsafe { root.FindFirst(TreeScope_Descendants, &cond) } {
                if let Some(url) = read_value_pattern(&el) {
                    if looks_like_url_or_host(&url) {
                        return url;
                    }
                }
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
                    if let Ok(el) = unsafe { edits.GetElement(i) } {
                        if let Some(val) =
                            read_value_pattern(&el).or_else(|| read_text_pattern(&el))
                        {
                            if looks_like_url_or_host(&val) {
                                return val;
                            }
                        }
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
}
