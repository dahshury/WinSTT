// Context-awareness for the dictation cleanup path. ZERO reimplementation of
// the UIA reader — `winstt-context.exe` (the existing C binary, byte-identical
// to the reference build) ships as a Tauri SIDECAR (externalBin) and is invoked
// per dictation via std::process::Command. This module:
//
//   1. Resolves + spawns the sidecar with the right mode flag
//      (--selection / --split / --tree), with the same hard timeout as the
//      the reference wrapper (READ_TIMEOUT_MS = 1200ms; the binary's own 750ms
//      watchdog is the inner fence).
//   2. Parses its single-line JSON stdout into a `WindowContextSnapshot`,
//      attaching optional fields only when non-empty (so an empty capture is
//      the cheap 3-field shape the deny-list / "nothing captured" checks rely
//      on).
//   3. Applies the user's DENY-LIST (exe-name or URL-host patterns) →
//      redaction, and the prompt FORMATTER (compact fragment for the LLM).
//
// The deny-list, IDE/terminal/canvas detection, host extraction, and prompt
// formatter are PURE STRING LOGIC ported 1:1 from context-snapshot.ts and
// fully unit-tested. The only non-pure part is the Command spawn (a thin
// sketch — wire during the compile loop).
//
// Sidecar registration (tauri.conf.json):
//   "bundle": { "externalBin": ["binaries/winstt-context"] }
// Tauri appends the target triple (winstt-context-x86_64-pc-windows-msvc.exe).
// At runtime resolve via the resource dir; in dev fall back to the repo path.
//
// Invariant: context is an LLM-CLEANUP concern only — never fed to the
// transcriber as an initial prompt (Canary/Cohere context slot untrained;
// Whisper is the only beneficiary and that path lives in the STT slice).

use std::collections::BTreeMap;

use once_cell::sync::Lazy;
use regex::Regex;

use crate::winstt::settings_schema::ContextAppMode;

/// The parsed UIA snapshot. Mirrors `WindowContextSnapshot`. Required triple
/// (window_title / element_name / focused_text) is always present; the
/// Wispr-tier enrichments are attached only when the sidecar emitted them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WindowContextSnapshot {
    pub window_title: String,
    pub element_name: String,
    pub focused_text: String,
    pub text_before: Option<String>,
    pub text_after: Option<String>,
    pub selected_text: Option<String>,
    pub clipboard_text: Option<String>,
    pub app_exe: Option<String>,
    pub url: Option<String>,
    pub ax_html: Option<String>,
    pub ocr_text: Option<String>,
}

/// The empty/sentinel snapshot — returned on any sidecar failure (binary
/// missing, timeout, malformed JSON, non-Windows). Mirrors EMPTY_CONTEXT.
pub fn empty_context() -> WindowContextSnapshot {
    WindowContextSnapshot::default()
}

/// Sidecar invocation mode. Mirrors the C binary's flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextMode {
    /// Default: focused element text only.
    Focused,
    /// `--selection`: only the user's selected text.
    Selection,
    /// `--split`: caret-aware textBefore / textAfter.
    Split,
    /// `--tree`: full UIA subtree axHtml + URL + appExe (strongest).
    Tree,
}

impl ContextMode {
    pub fn flag(self) -> Option<&'static str> {
        match self {
            ContextMode::Focused => None,
            ContextMode::Selection => Some("--selection"),
            ContextMode::Split => Some("--split"),
            ContextMode::Tree => Some("--tree"),
        }
    }
}

/// Hard outer timeout for the sidecar (the binary's own watchdog is 750ms).
/// Mirrors READ_TIMEOUT_MS.
pub const READ_TIMEOUT_MS: u64 = 1200;

/// Cap on raw stdout bytes from the sidecar. The 24k native context caps can
/// produce ~2.7MB after JSON escaping, so the consumer must allow 4MB or the
/// snapshot silently drops to empty on long Gmail/chat captures.
pub const MAX_BUFFER_BYTES: usize = 4 * 1024 * 1024;

/// Parse the sidecar's single-line JSON into a snapshot, attaching optional
/// fields only when non-empty. Mirrors buildSnapshotFromParsed +
/// attachCaretFields + attachIfNonEmpty. Returns EMPTY_CONTEXT on bad JSON.
pub fn parse_snapshot(raw: &str) -> WindowContextSnapshot {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw.trim()) else {
        return empty_context();
    };
    let Some(obj) = value.as_object() else {
        return empty_context();
    };
    let get = |k: &str| {
        obj.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let non_empty = |k: &str| {
        let v = get(k);
        if v.is_empty() {
            None
        } else {
            Some(v)
        }
    };
    WindowContextSnapshot {
        window_title: get("windowTitle"),
        element_name: get("elementName"),
        focused_text: get("focusedText"),
        text_before: non_empty("textBefore"),
        text_after: non_empty("textAfter"),
        selected_text: non_empty("selectedText"),
        clipboard_text: non_empty("clipboardText"),
        app_exe: non_empty("appExe"),
        url: non_empty("url"),
        ax_html: non_empty("axHtml"),
        ocr_text: non_empty("ocrText"),
    }
}

/// Public reader trait so the manager can inject a fake sidecar in tests.
pub trait ContextReader {
    /// Run the sidecar in `mode`. ALWAYS resolves (returns empty on failure).
    fn read(&self, mode: ContextMode) -> WindowContextSnapshot;
}

// ─────────────────────── app policy lists ─────────────────────────────
//
// Ported 1:1 from context-snapshot.ts. A pattern is either an exe name
// ("chrome.exe", "1password.exe") matched case-insensitively against
// app_exe, OR a URL host suffix ("bankofamerica.com") matched against the
// snapshot URL's host (every pattern covers any subdomain). A leading
// "*." is stripped so users can author either form.

struct AppPolicyProbe {
    app_exe: String,
    host: String,
}

fn build_app_policy_probe(snapshot: &WindowContextSnapshot) -> AppPolicyProbe {
    let app_exe = snapshot.app_exe.clone().unwrap_or_default().to_lowercase();
    let url = snapshot.url.clone().unwrap_or_default().to_lowercase();
    AppPolicyProbe {
        app_exe,
        host: extract_host(&url),
    }
}

fn normalise_app_pattern(raw: &str) -> String {
    let lower = raw.trim().to_lowercase();
    lower.strip_prefix("*.").unwrap_or(&lower).to_string()
}

fn matches_app_exe_pattern(pattern: &str, app_exe: &str) -> bool {
    pattern.ends_with(".exe") && app_exe == pattern
}

fn matches_host_pattern(pattern: &str, host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    host == pattern || host.ends_with(&format!(".{pattern}"))
}

fn app_pattern_matches_probe(raw: &str, probe: &AppPolicyProbe) -> bool {
    let pattern = normalise_app_pattern(raw);
    if pattern.is_empty() {
        return false;
    }
    matches_app_exe_pattern(&pattern, &probe.app_exe) || matches_host_pattern(&pattern, &probe.host)
}

/// True when the snapshot's app/url matches any deny-list pattern. Mirrors
/// isDeniedByList. Tolerant: a mistyped pattern is a silent no-op.
pub fn is_denied_by_list(snapshot: &WindowContextSnapshot, deny_list: &[String]) -> bool {
    if deny_list.is_empty() {
        return false;
    }
    let probe = build_app_policy_probe(snapshot);
    deny_list
        .iter()
        .any(|raw| app_pattern_matches_probe(raw, &probe))
}

/// True when the snapshot's app/url matches any selected-only allow-list entry.
/// Uses the same executable/host pattern semantics as the deny-list.
pub fn is_allowed_by_list(snapshot: &WindowContextSnapshot, allow_list: &[String]) -> bool {
    if allow_list.is_empty() {
        return false;
    }
    let probe = build_app_policy_probe(snapshot);
    allow_list
        .iter()
        .any(|raw| app_pattern_matches_probe(raw, &probe))
}

/// Strip the Wispr-tier fields from a denied snapshot, keeping only the
/// harmless metadata triple (window title + element name; focused text
/// blanked). Mirrors redactSensitiveFields.
pub fn redact_sensitive_fields(snapshot: &WindowContextSnapshot) -> WindowContextSnapshot {
    WindowContextSnapshot {
        window_title: snapshot.window_title.clone(),
        element_name: snapshot.element_name.clone(),
        focused_text: String::new(),
        ..Default::default()
    }
}

/// Pull the host out of a URL string WITHOUT a full URL parser (UIA's
/// omnibox value sometimes lacks a scheme). Mirrors extractHost.
fn extract_host(url: &str) -> String {
    if url.is_empty() {
        return String::new();
    }
    // strip scheme "xxx://"
    let no_scheme = match url.find("://") {
        Some(i) => &url[i + 3..],
        None => url,
    };
    // host = up to first '/'
    let host_part = match no_scheme.find('/') {
        Some(i) => &no_scheme[..i],
        None => no_scheme,
    };
    // strip query/fragment
    host_part
        .split('?')
        .next()
        .unwrap_or("")
        .split('#')
        .next()
        .unwrap_or("")
        .to_string()
}

// ──────────────── IDE / terminal / canvas detection ───────────────────

/// Which editor/IDE the foreground app is. Drives per-IDE feature gating
/// (variable recognition + file tagging), mirroring Wispr Flow's IDE matrix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdeKind {
    Cursor,
    Windsurf,
    VsCode,
    VsCodeInsiders,
    Vscodium,
    SublimeText,
    VisualStudio,
    JetBrains,
}

/// Per-IDE capability profile.
///
/// - `variable_recognition` = backtick-wrap spoken code symbols. WinSTT does this
///   in the LLM prompt with no screen-reader-mode dependency, so we keep it ON for
///   every recognized editor (incl. VS Code Insiders — unlike Flow, which gates it
///   on a screen-reader integration it lacks there).
/// - `file_tagging` = the "@file" chat affordance, intentionally limited to Cursor
///   + Windsurf (the editors with a tag-aware chat input), matching Flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdeProfile {
    pub kind: IdeKind,
    pub variable_recognition: bool,
    pub file_tagging: bool,
}

/// Classify the foreground app's executable into an `IdeKind`, or `None` when it
/// is not a recognized editor. Exact basenames first, then JetBrains launchers by
/// prefix (idea64.exe / pycharm64.exe / …).
pub fn ide_kind_from_exe(app_exe: Option<&str>) -> Option<IdeKind> {
    let exe = app_exe.unwrap_or("").to_lowercase();
    if exe.is_empty() {
        return None;
    }
    let exact = match exe.as_str() {
        "cursor.exe" => Some(IdeKind::Cursor),
        "windsurf.exe" => Some(IdeKind::Windsurf),
        "code.exe" => Some(IdeKind::VsCode),
        "code - insiders.exe" => Some(IdeKind::VsCodeInsiders),
        "vscodium.exe" => Some(IdeKind::Vscodium),
        "sublime_text.exe" => Some(IdeKind::SublimeText),
        "devenv.exe" => Some(IdeKind::VisualStudio),
        _ => None,
    };
    if exact.is_some() {
        return exact;
    }
    const JETBRAINS: &[&str] = &[
        "idea",
        "pycharm",
        "webstorm",
        "rubymine",
        "clion",
        "goland",
        "rustrover",
        "rider",
        "phpstorm",
    ];
    if exe.ends_with(".exe") && JETBRAINS.iter().any(|p| exe.starts_with(p)) {
        return Some(IdeKind::JetBrains);
    }
    None
}

/// Resolve the per-IDE capability profile for the foreground app, or `None` when
/// it is not a recognized editor.
pub fn ide_profile(snapshot: &WindowContextSnapshot) -> Option<IdeProfile> {
    let kind = ide_kind_from_exe(snapshot.app_exe.as_deref())?;
    let file_tagging = matches!(kind, IdeKind::Cursor | IdeKind::Windsurf);
    Some(IdeProfile {
        kind,
        variable_recognition: true,
        file_tagging,
    })
}

/// True when the foreground app is a recognized IDE / code editor. Drives the
/// "treat visible content as code" prompt hint. Mirrors isIdeContext.
pub fn is_ide_context(snapshot: &WindowContextSnapshot) -> bool {
    ide_kind_from_exe(snapshot.app_exe.as_deref()).is_some()
}

/// True when the focused control is an IDE's integrated terminal (a recognized
/// editor AND a terminal-shaped focused element). On Windows these terminals take
/// Shift+Insert rather than Ctrl+V for paste, so the paste path keys off this.
pub fn is_ide_terminal(snapshot: &WindowContextSnapshot) -> bool {
    is_ide_context(snapshot) && looks_like_terminal(snapshot)
}

/// True when the focused surface looks like an AI coding CLI (Claude Code / Codex)
/// running in a terminal. These collapse long single pastes, so the paste path
/// chunks into smaller writes. Conservative: requires a terminal-shaped focus and
/// a CLI name in the window title or element name.
pub fn is_ai_coding_cli(snapshot: &WindowContextSnapshot) -> bool {
    if !looks_like_terminal(snapshot) {
        return false;
    }
    let haystack = format!(
        "{} {}",
        snapshot.window_title.to_lowercase(),
        snapshot.element_name.to_lowercase()
    );
    contains_word(&haystack, "claude") || contains_word(&haystack, "codex")
}

/// True when the focused control looks like a terminal/console (its caret
/// context is scrollback soup). Mirrors looksLikeTerminal.
pub fn looks_like_terminal(snapshot: &WindowContextSnapshot) -> bool {
    let name = snapshot.element_name.to_lowercase();
    contains_word(&name, "terminal") || contains_word(&name, "console")
}

fn contains_word(haystack: &str, word: &str) -> bool {
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(word) {
        let start = from + rel;
        let end = start + word.len();
        let left_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let right_ok = end >= bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if left_ok && right_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

/// True for canvas/grid surfaces (Figma, Canva, Sheets) whose real content is
/// painted to <canvas> and not exposed via UIA. Mirrors isCanvasSurface (a
/// minimal port — the full ax-prune heuristics live in the STT/context slice).
pub fn is_canvas_surface(app_exe: Option<&str>, url: Option<&str>) -> bool {
    let exe = app_exe.unwrap_or("").to_lowercase();
    let url = url.unwrap_or("").to_lowercase();
    const CANVAS_EXES: &[&str] = &["figma.exe"];
    const CANVAS_HOSTS: &[&str] = &[
        "figma.com",
        "canva.com",
        "docs.google.com/spreadsheets",
        "sheets.google.com",
        "miro.com",
        "excalidraw.com",
    ];
    if CANVAS_EXES.contains(&exe.as_str()) {
        return true;
    }
    CANVAS_HOSTS.iter().any(|h| url.contains(h))
}

// ───────────────────────── prompt formatter ───────────────────────────
//
// Ported from formatContextForPrompt + buildPromptSections. The caret label
// phrases are EXACT — the system-prompt continuation clause matches against
// them literally (see with_context_prefix in llm/mod.rs). `clean_caret` here
// is a minimal denoise (trim + collapse blank lines); the full ax-prune
// pipeline (denoiseForLlm / stripListScrollback / pruneAxHtmlForLlm) is a
// separate slice — wire it in where marked.

const RICH_FIELD_MIN_CHARS: usize = 40;
const SELECTED_TEXT_LLM_MAX: usize = 4000;
const CLIPBOARD_LLM_MAX: usize = 2000;
const CARET_BEFORE_LLM_MAX: usize = 24_000;
const CARET_AFTER_LLM_MAX: usize = 2000;

fn clip_head(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn clip_tail(value: &str, max: usize) -> String {
    let count = value.chars().count();
    if count <= max {
        value.to_string()
    } else {
        value.chars().skip(count - max).collect()
    }
}

/// Minimal caret/field cleaner: trim + collapse runs of blank lines. The full
/// LLM denoise (object-replacement chars, list scrollback) is the ax-prune
/// slice — wire `denoise_for_llm` / `strip_list_scrollback` here when present.
fn clean_caret(raw: Option<&str>) -> String {
    let s = raw.unwrap_or("").trim();
    // collapse 2+ consecutive newlines into one
    let mut out = String::with_capacity(s.len());
    let mut newline_run = 0;
    for ch in s.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run == 1 {
                out.push('\n');
            }
        } else {
            newline_run = 0;
            out.push(ch);
        }
    }
    out.trim().to_string()
}

fn focused_field_is_rich(snapshot: &WindowContextSnapshot) -> bool {
    let caret = clean_caret(snapshot.text_before.as_deref()).chars().count()
        + clean_caret(snapshot.text_after.as_deref()).chars().count();
    if caret >= RICH_FIELD_MIN_CHARS {
        return true;
    }
    clean_caret(Some(&snapshot.focused_text)).chars().count() >= RICH_FIELD_MIN_CHARS
}

fn push_section(out: &mut Vec<String>, value: &str, render: impl FnOnce(&str) -> String) {
    if !value.is_empty() {
        out.push(render(value));
    }
}

/// The lightweight metadata sections (app / IDE / URL / window / focused field).
fn push_metadata(out: &mut Vec<String>, snapshot: &WindowContextSnapshot) {
    push_section(out, snapshot.app_exe.as_deref().unwrap_or("").trim(), |v| {
        format!("App: {v}")
    });
    if is_ide_context(snapshot) {
        out.push("IDE context: yes (treat visible content as code)".to_string());
    }
    push_section(out, snapshot.url.as_deref().unwrap_or("").trim(), |v| {
        format!("URL: {v}")
    });
    push_section(out, snapshot.window_title.trim(), |v| {
        format!("Window: {v}")
    });
    push_section(out, snapshot.element_name.trim(), |v| {
        format!("Focused field: {v}")
    });
}

fn push_selected(out: &mut Vec<String>, snapshot: &WindowContextSnapshot) {
    let v = clip_head(
        &clean_caret(snapshot.selected_text.as_deref()),
        SELECTED_TEXT_LLM_MAX,
    );
    push_section(out, &v, |s| {
        format!(
            "Selected text (the user highlighted this — likely the thing they're acting on):\n{s}"
        )
    });
}

fn push_clipboard(out: &mut Vec<String>, snapshot: &WindowContextSnapshot) {
    let v = clip_head(
        &clean_caret(snapshot.clipboard_text.as_deref()),
        CLIPBOARD_LLM_MAX,
    );
    push_section(out, &v, |s| {
        format!("Clipboard contents (the user recently copied this — use only if relevant):\n{s}")
    });
}

fn push_content(out: &mut Vec<String>, snapshot: &WindowContextSnapshot) {
    let before = clean_caret(snapshot.text_before.as_deref());
    let after = clean_caret(snapshot.text_after.as_deref());
    if !before.is_empty() || !after.is_empty() {
        let b = clip_tail(&before, CARET_BEFORE_LLM_MAX);
        push_section(out, &b, |s| {
            format!("Text immediately before the caret (your cleaned output will be inserted directly after this — continue it, do not repeat it):\n{s}")
        });
        let a = clip_head(&after, CARET_AFTER_LLM_MAX);
        push_section(out, &a, |s| {
            format!("Text immediately after the caret (your output will sit directly before this — do not repeat it):\n{s}")
        });
        return;
    }
    let focused = clean_caret(Some(&snapshot.focused_text));
    push_section(out, &focused, |s| format!("Visible content:\n{s}"));
}

fn push_fallback_tree(out: &mut Vec<String>, snapshot: &WindowContextSnapshot) {
    if is_canvas_surface(snapshot.app_exe.as_deref(), snapshot.url.as_deref()) {
        return;
    }
    // The full pruner (pruneAxHtmlForLlm) is the ax-prune slice — until it's
    // wired, emit the raw (trimmed) axHtml fenced as reference. Replace with
    // the pruned variant when available.
    let ax = snapshot.ax_html.as_deref().unwrap_or("").trim();
    push_section(out, ax, |s| {
        format!("Visible UI (XML — DO NOT echo, only use for reference):\n{s}")
    });
}

fn push_ocr(out: &mut Vec<String>, snapshot: &WindowContextSnapshot) {
    let v = clean_caret(snapshot.ocr_text.as_deref());
    push_section(out, &v, |s| {
        format!("Screen text (OCR — approximate, no reliable reading order; the structured fields above were empty so this is the only context):\n{s}")
    });
}

/// Format the snapshot into a compact LLM-cleanup prompt fragment. Returns ""
/// when no context is available, so callers can blindly concatenate. Mirrors
/// formatContextForPrompt + buildPromptSections (focused-field-first; terminal
/// scrollback omitted; tree/OCR only when the focused field is thin).
pub fn format_context_for_prompt(snapshot: &WindowContextSnapshot) -> String {
    format_context_for_prompt_json(snapshot)
}

#[allow(dead_code)]
fn format_context_for_prompt_legacy(snapshot: &WindowContextSnapshot) -> String {
    let mut sections: Vec<String> = Vec::new();
    push_metadata(&mut sections, snapshot);
    push_selected(&mut sections, snapshot);

    if looks_like_terminal(snapshot) {
        sections.push(
            "Terminal/console focused — scrollback omitted (no clean prior text available)."
                .to_string(),
        );
        push_clipboard(&mut sections, snapshot);
        return sections.join("\n");
    }

    if focused_field_is_rich(snapshot) {
        push_content(&mut sections, snapshot);
        push_clipboard(&mut sections, snapshot);
        return sections.join("\n");
    }

    push_fallback_tree(&mut sections, snapshot);
    push_content(&mut sections, snapshot);
    push_ocr(&mut sections, snapshot);
    push_clipboard(&mut sections, snapshot);
    sections.join("\n")
}

static JSON_LLM_NOISE_RE: Lazy<Regex> = Lazy::new(|| {
    // \p{C} already covers most control/format codepoints (incl. U+200B-U+200F
    // and U+034F), but list the invisible-separator runs Gmail injects into
    // preview snippets explicitly so intent is clear: U+034F (CGJ), U+200C/D
    // (ZWNJ/ZWJ), U+200E/F (LRM/RLM).
    Regex::new(
        r"[\p{C}\p{So}\x{2022}\x{2023}\x{2043}\x{034F}\x{200C}-\x{200F}\x{1F000}-\x{1FAFF}]",
    )
    .unwrap()
});
static JSON_INBOX_DATE_ROW_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(?:\d{1,2}:\d{2}\s?[AP]M|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2})$",
    )
    .unwrap()
});
static JSON_TAG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());
static JSON_ROLE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^</?\s*([a-z][a-z0-9]*)").unwrap());
static JSON_NAME_ATTR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\bname="([^"]*)""#).unwrap());
static JSON_FOCUS_ATTR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\bfocus="1""#).unwrap());
static JSON_NAV_NAME_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:chats?|conversations?|inbox|channels?|direct messages|members?|participants?|navigation|recents?|recent threads?|threads?|projects?|workspaces?|files?|explorer|folders?|sidebar|side panel|mailbox|page list|pages|primary|timeline tabs|who to follow|what's happening|for you|following|premium|live on x|trending|grok)\b").unwrap()
});
static JSON_CONTAINER_NAV_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:sidebar|side panel|side bar|navigation|nav rail|primary column|sidebar column|servers?|roster|app bar|browser chrome|left rail|chat list|chats)\b").unwrap()
});
static JSON_CONTENT_LIST_NAME_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(?:messages?|conversation with|message thread|comment thread|comments?|timeline)\b",
    )
    .unwrap()
});
static JSON_SPEAKER_PREFIX_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(?:@?[\p{L}\p{N} _.'-]{2,40}|You|Me):\s+\S").unwrap());
static JSON_TIME_OR_META_LINE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?ix)
        ^(?:today|yesterday)\s+at\s+\d{1,2}:\d{2}\s?[ap]m$
        |
        ^\d{1,2}:\d{2}\s?[ap]m$
        |
        # 'H:MM AM · Jun 14, 2026' datetime / 'H:MM AM · <anything>' meta row (X)
        ^\d{1,2}:\d{2}\s?[ap]m\s+·\s+.+$
        |
        ^\d+[smhdw]$
        |
        # bare month-day, e.g. 'Jun 14' / 'May 3' (X relative date row)
        ^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}$
        |
        ^(?:online|offline|typing\.\.\.)$
        |
        # presence / receipt meta (chat apps)
        ^(?:active|last\ seen)\b.*$
        |
        ^(?:seen|delivered|sent)$
        |
        # WhatsApp end-to-end-encryption banner
        ^.*messages\ and\ calls\ are\ end-to-end\ encrypted.*$
    ",
    )
    .unwrap()
});
static JSON_AUTHOR_TRAILING_TIME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\s+\d{1,2}:\d{2}\s?[ap]m$").unwrap());
static JSON_LOW_SIGNAL_UI_LINE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?ix)
        ^
        (?:
            sponsored|reply|like|comment|share|send|follow|following|
            write\ a\ comment|see\ more|show\ more|
            # standalone engagement / chrome words (X, social feeds)
            views|view\ quotes|show\ translation|embedded\ video|relevant|
            subscribe|unsubscribe|verified\ sender|ad
        )
        $
        |
        # promoted-block marker: a line that ENDS with ' Ad' (X interleaves
        # '<account> Ad' promoted posts). Speaker-prefixed lines are exempted
        # by json_is_low_signal_ui_line before this regex runs.
        \ ad$
        |
        # bare engagement count on its own line: '232.9K', '41', '1.1K'
        ^\d+(?:[.,]\d+)?[kmb]?$
        |
        ^\d+(?:[.,]\d+)?[kmb]?\s+(?:likes?|comments?|shares?|reposts?|views?|reactions?)$
        |
        \b(?:
            joined\ the\ channel|
            left\ the\ channel|
            started\ a\ call|
            missed\ (?:a\ )?(?:voice\ )?call|
            pinned\ a\ message|
            reacted\ with|
            changed\ the\ channel\ name|
            added\ .+\ to\ the\ (?:channel|conversation)|
            removed\ .+\ from\ the\ (?:channel|conversation)
        )\b",
    )
    .unwrap()
});

const JSON_CARET_BEFORE_LLM_MAX: usize = 24_000;
const JSON_LANDMARK_MIN_CHARS: usize = 20;
const JSON_MAX_LLM_CONTEXT_CHARS: usize = 12_000;

// ──────────────── flat-stream speaker attribution ─────────────────────
//
// The synthetic test fixtures use idealized nested <item>/<group> trees, but
// REAL Chrome UIA captures of Discord / X / Messenger arrive as FLAT text:
// either the focused composer's `textBefore` (Discord — a newline stream of
// `author / timestamp / datetime / body` rows) or a single page-spanning
// `<doc>` TextPattern blob (X, Messenger). The tree reconstructor never sees a
// per-message node in those shapes, so attribution has to be recovered from the
// flat text. These helpers do that conservatively (only when a conversation
// shape is confidently detected) and are applied as a post-process on both the
// cleaned beforeCaret blob and the prune_ax_html_for_llm output.

/// Lines/badges that masquerade as "Author:" speakers but are UI chrome. The
/// canonical offender is Discord's "Server Tag: <CLAN>" badge that renders right
/// under each author header; also drop standalone scripture/citation colons.
static JSON_FALSE_SPEAKER_PREFIX_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?ix)
        ^\s*(?:
            server\ tag            # Discord clan-tag badge under the author
            | the\ short\ reason   # sentence fragments seen in real X/Messenger blobs
            | the\ long\ reason
            | reason
            | note
            | edit
            | edited
            | replying\ to
            | quote
            | reply
            | forwarded
            | original\ message
        )\s*:
        |
        # Arabic scripture/citation openers ('Allah says:', 'he said:') — a colon
        # after these is a quotation marker, never a chat speaker.
        ^\s*(?:قوله\ تعالى|قال\ تعالى|قال|وقال|يقول|قوله)\s*:
    ",
    )
    .unwrap()
});

/// A chat timestamp / datetime row that separates message groups and must never
/// become a body line or an author. Covers the real shapes seen in captures:
/// `6/11/26, 2:07 PM`, `Thursday, June 11, 2026 at 2:07 PM`, `June 11, 2026`,
/// `Yesterday at 9:45 AM`, bare `9:37 AM`, Messenger `5:14am`.
static JSON_CHAT_TIMESTAMP_LINE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?ix)
        ^\s*
        (?:
            # M/D/YY or M/D/YYYY optionally with a clock: '6/11/26, 2:07 PM'
            \d{1,2}/\d{1,2}/\d{2,4}(?:\s*,?\s*\d{1,2}:\d{2}\s?[ap]m?)?
            |
            # full weekday datetime: 'Thursday, June 11, 2026 at 2:07 PM'
            (?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\s*,?.*\b\d{4}\b.*
            |
            # day separator: 'June 11, 2026'
            (?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},\s*\d{4}
            |
            # relative: 'Yesterday at 9:45 AM' / 'Today at 2:14 PM'
            (?:today|yesterday)\s+at\s+\d{1,2}:\d{2}\s?[ap]m
            |
            # bare clock (continuation marker): '9:37 AM' / '5:14am'
            \d{1,2}:\d{2}\s?[ap]m
        )
        \s*$
    ",
    )
    .unwrap()
});

/// Discord per-message UI affordances that interleave the flat stream and are
/// not part of any message body.
static JSON_DISCORD_AFFORDANCE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?ix)
        ^\s*(?:
            add\ reaction | more\ message\ options | play\ voice\ message
            | control\ volume | remove\ all\ embeds | \d+x | \d{1,2}:\d{2}
            | started\ a\ call.* | .*started\ a\ call\ that\ lasted.*
        )\s*$
    ",
    )
    .unwrap()
});

/// An X (Twitter) author header line: a `@handle` standing alone, or a display
/// name immediately followed by ` @handle`. Used to attribute the flat tweet
/// blob positionally (X has no `Author:` prefix).
static JSON_X_HANDLE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"@[A-Za-z0-9_]{2,15}\b").unwrap());

/// Messenger embeds authorship as `... by <Author>:` inside its flat doc blob
/// (`Enter, Message sent Saturday 8:15am by موه: <body>`). This captures the
/// author + the start of the body so we can rebuild `Author: body`.
static JSON_MESSENGER_BY_AUTHOR_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:Enter,\s*)?Message sent[^\n]*?\bby\s+(?P<author>[^:\n]{1,40}?):\s*").unwrap()
});

fn json_collapse_inline_ws(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_ws = false;
    for ch in raw.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out.trim().to_string()
}

pub fn denoise_for_llm(raw: Option<&str>) -> String {
    raw.unwrap_or("")
        .split('\n')
        .map(|line| JSON_LLM_NOISE_RE.replace_all(line, "").to_string())
        .map(|line| json_collapse_inline_ws(&line))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn json_is_gmail_chrome_line(line: &str) -> bool {
    let trimmed = line.trim();
    let lower = trimmed.to_lowercase();
    matches!(
        lower.as_str(),
        "inbox"
            | "x"
            | "to me"
            | "show details"
            | "hide details"
            | "pop out reply"
            | "everything else"
            | "describe your message"
            | "send"
            | "compose"
    ) || trimmed == "\u{00d7}"
}

pub fn strip_list_scrollback(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let lines = text.lines().collect::<Vec<_>>();
    let limit = lines.len() * 85 / 100;
    let mut cut: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if i > limit {
            break;
        }
        if JSON_INBOX_DATE_ROW_RE.is_match(line.trim()) {
            cut = Some(i);
        }
    }
    let Some(cut) = cut else {
        return text.to_string();
    };
    lines
        .iter()
        .skip(cut + 1)
        .filter(|line| !json_is_gmail_chrome_line(line))
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn json_clean_caret(raw: Option<&str>) -> String {
    strip_list_scrollback(&denoise_for_llm(raw))
}

fn json_focused_field_is_rich(snapshot: &WindowContextSnapshot) -> bool {
    let caret = json_clean_caret(snapshot.text_before.as_deref())
        .chars()
        .count()
        + json_clean_caret(snapshot.text_after.as_deref())
            .chars()
            .count();
    if caret >= RICH_FIELD_MIN_CHARS {
        return true;
    }
    json_clean_caret(Some(&snapshot.focused_text))
        .chars()
        .count()
        >= RICH_FIELD_MIN_CHARS
}

#[derive(Debug, Clone)]
struct JsonAxNode {
    children: Vec<usize>,
    focused: bool,
    name: String,
    role: String,
    text: String,
}

#[derive(Debug, Clone)]
struct JsonAxTree {
    nodes: Vec<JsonAxNode>,
}

impl JsonAxTree {
    fn new() -> Self {
        Self {
            nodes: vec![JsonAxNode {
                children: Vec::new(),
                focused: false,
                name: String::new(),
                role: "root".to_string(),
                text: String::new(),
            }],
        }
    }

    fn push_node(&mut self, parent: usize, node: JsonAxNode) -> usize {
        let idx = self.nodes.len();
        self.nodes.push(node);
        self.nodes[parent].children.push(idx);
        idx
    }
}

struct JsonParsedTag {
    focused: bool,
    is_close: bool,
    name: String,
    role: String,
    self_close: bool,
}

fn json_unescape_entities(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn json_append_text(tree: &mut JsonAxTree, node: usize, between: &str) {
    let trimmed = between.trim();
    if trimmed.is_empty() {
        return;
    }
    let piece = json_unescape_entities(trimmed);
    let target = &mut tree.nodes[node];
    if target.text.is_empty() {
        target.text = piece;
    } else {
        target.text.push(' ');
        target.text.push_str(&piece);
    }
}

fn json_classify_tag(tag: &str) -> Option<JsonParsedTag> {
    let role = JSON_ROLE_RE.captures(tag)?.get(1)?.as_str().to_lowercase();
    let name = JSON_NAME_ATTR_RE
        .captures(tag)
        .and_then(|caps| caps.get(1))
        .map(|m| json_unescape_entities(m.as_str()))
        .unwrap_or_default();
    Some(JsonParsedTag {
        focused: JSON_FOCUS_ATTR_RE.is_match(tag),
        is_close: tag.starts_with("</"),
        name,
        role,
        self_close: tag.trim_end().ends_with("/>"),
    })
}

fn json_apply_tag(tree: &mut JsonAxTree, stack: &mut Vec<usize>, tag: &str) {
    let Some(parsed) = json_classify_tag(tag) else {
        return;
    };
    if parsed.is_close {
        if stack.len() > 1 {
            stack.pop();
        }
        return;
    }
    let parent = *stack.last().unwrap_or(&0);
    let idx = tree.push_node(
        parent,
        JsonAxNode {
            children: Vec::new(),
            focused: parsed.focused,
            name: parsed.name,
            role: parsed.role,
            text: String::new(),
        },
    );
    if !parsed.self_close {
        stack.push(idx);
    }
}

fn json_parse_ax_html(ax: &str) -> JsonAxTree {
    let mut tree = JsonAxTree::new();
    let mut stack = vec![0usize];
    let mut last_index = 0usize;
    for mat in JSON_TAG_RE.find_iter(ax) {
        let current = *stack.last().unwrap_or(&0);
        json_append_text(&mut tree, current, &ax[last_index..mat.start()]);
        last_index = mat.end();
        json_apply_tag(&mut tree, &mut stack, mat.as_str());
    }
    let current = *stack.last().unwrap_or(&0);
    json_append_text(&mut tree, current, &ax[last_index..]);
    tree
}

fn json_role_is(role: &str, roles: &[&str]) -> bool {
    roles.contains(&role)
}

fn json_drop_subtree_role(role: &str) -> bool {
    json_role_is(
        role,
        &[
            "toolbar", "tabs", "tab", "menu", "menuitem", "status", "button", "link", "combo",
            "check", "radio", "image", "tree", "table", "thead", "banner",
        ],
    )
}

fn json_name_emit_role(role: &str) -> bool {
    json_role_is(role, &["item", "text", "node", "row", "header"])
}

fn json_landmark_role(role: &str) -> bool {
    json_role_is(role, &["doc", "pane", "group", "article"])
}

fn json_is_omnibox(node: &JsonAxNode) -> bool {
    node.role == "edit"
        && matches!(
            node.name.trim().to_lowercase().as_str(),
            "address and search bar"
                | "search"
                | "search mail"
                | "search messenger"
                | "urlbar"
        )
}

/// True when a line is a genuine `Author: message` speaker turn — it matches the
/// speaker-prefix shape AND its prefix is not a known false positive (Discord's
/// "Server Tag:" badge, sentence fragments like "The short reason:", or scripture
/// citations like "قوله تعالى:"). This is the single gate every speaker-prefix
/// decision flows through, so the false-positive filter applies uniformly.
fn json_is_speaker_turn_line(line: &str) -> bool {
    let trimmed = line.trim();
    JSON_SPEAKER_PREFIX_RE.is_match(trimmed) && !JSON_FALSE_SPEAKER_PREFIX_RE.is_match(trimmed)
}

fn json_is_low_signal_ui_line(line: &str) -> bool {
    let trimmed = line.trim();
    !json_is_speaker_turn_line(trimmed)
        && (JSON_LOW_SIGNAL_UI_LINE_RE.is_match(trimmed)
            || JSON_FALSE_SPEAKER_PREFIX_RE.is_match(trimmed))
}

fn json_is_time_or_meta_line(line: &str) -> bool {
    JSON_TIME_OR_META_LINE_RE.is_match(line.trim())
}

fn json_normalize_author(raw: &str) -> Option<String> {
    let mut author = raw
        .trim()
        .trim_matches(['-', '—', '•', '|'])
        .trim()
        .to_string();
    if author.is_empty()
        || author.chars().count() > 48
        || JSON_SPEAKER_PREFIX_RE.is_match(&author)
        || JSON_NAV_NAME_RE.is_match(&author)
        || JSON_CONTAINER_NAV_RE.is_match(&author)
        || JSON_CONTENT_LIST_NAME_RE.is_match(&author)
        || json_is_low_signal_ui_line(&author)
    {
        return None;
    }

    if let Some((before, _)) = author.split_once(" commented") {
        author = before.trim().to_string();
    }
    if let Some((before, _)) = author.split_once(',') {
        author = before.trim().to_string();
    }
    author = JSON_AUTHOR_TRAILING_TIME_RE
        .replace(&author, "")
        .trim()
        .to_string();
    let words = author.split_whitespace().collect::<Vec<_>>();
    if words.len() >= 2 {
        let last = *words.last().unwrap_or(&"");
        if json_is_time_or_meta_line(last) {
            author = author.trim_end_matches(last).trim().to_string();
        }
    }
    if author.chars().any(|ch| ch.is_alphabetic()) {
        Some(author)
    } else {
        None
    }
}

/// True when a bare line looks like a chat author *header* (a display name on its
/// own line), as opposed to a message body or chrome. Conservative: a name is
/// short, has at most ~4 words, no sentence punctuation, and is not a timestamp /
/// nav / low-signal line. Used by the flat-stream reconstructor where the author
/// is a standalone line (Discord) rather than an `Author:` prefix.
fn json_looks_like_author_header(line: &str) -> bool {
    let t = line.trim();
    if t.chars().count() < 2 || t.chars().count() > 40 {
        return false;
    }
    if JSON_CHAT_TIMESTAMP_LINE_RE.is_match(t)
        || JSON_DISCORD_AFFORDANCE_RE.is_match(t)
        || json_is_low_signal_ui_line(t)
        || JSON_NAV_NAME_RE.is_match(t)
        || JSON_CONTAINER_NAV_RE.is_match(t)
        || JSON_CONTENT_LIST_NAME_RE.is_match(t)
        || JSON_FALSE_SPEAKER_PREFIX_RE.is_match(t)
    {
        return false;
    }
    // A header is a name, not a sentence: reject lines that end with sentence
    // punctuation or carry a colon (those are bodies / already-attributed turns).
    if t.ends_with(['.', '!', '?', ',']) || t.contains(':') {
        return false;
    }
    if !t.chars().any(char::is_alphabetic) {
        return false;
    }
    // A display name is a short token group (≤3 words) AND each word reads like a
    // name token, not a sentence word: it starts with an uppercase letter / digit
    // / non-Latin script (Arabic, CJK), OR carries a handle marker. This rejects
    // all-lowercase body fragments like "btw limits are reset" that happen to sit
    // right before a continuation timestamp.
    let words: Vec<&str> = t.split_whitespace().collect();
    if words.is_empty() || words.len() > 3 {
        return false;
    }
    words.iter().all(|w| {
        let first = w.chars().next().unwrap_or(' ');
        // Latin lowercase first letter ⇒ a sentence word, not a name token.
        !(first.is_ascii_lowercase())
    })
}

/// True when a flat caret blob is actually a chat-app LEFT-RAIL chat list (the
/// roster of conversations), not a message log. WhatsApp Web's composer exposes
/// the chat-list pane through its caret TextPattern range, so its `beforeCaret`
/// is the list of contacts + previews (which would otherwise be mis-attributed
/// as message authors). Keyed on the WhatsApp chat-list nav header that never
/// appears inside an actual conversation transcript.
fn json_text_is_chat_list_pane(text: &str) -> bool {
    let lower = text.to_lowercase();
    // Require several co-occurring chat-list nav markers (any one alone could
    // appear in a real message), so a genuine transcript is never suppressed.
    const LIST_MARKERS: &[&str] = &[
        "search or start a new chat",
        "archived",
        "status updates in status",
        "new chat",
        "unread message",
        "muted chat",
    ];
    LIST_MARKERS
        .iter()
        .filter(|marker| lower.contains(**marker))
        .count()
        >= 2
}

/// Reconstruct `Author: message` turns from a Discord-style FLAT line stream
/// (the focused composer's `textBefore`). The stream groups each message as:
///   `<Author>` / [`Server Tag: X`] / `<timestamp>` / `<full datetime>` / `<body…>`
/// with same-author continuations marked by a bare clock line and no header.
/// Returns `None` when the text does not look like such a stream (so callers
/// fall back to the unmodified blob).
fn json_reconstruct_discord_stream(text: &str) -> Option<String> {
    // Guard: a chat-LIST pane (WhatsApp Web's left column, whose composer
    // TextPattern range spans the chat list, NOT the open conversation) mimics
    // the author/timestamp/preview grouping and would fabricate fake "Contact:"
    // turns from chat-list rows. Bail when the unmistakable chat-list nav header
    // is present so this stream-reconstruction only runs on a real message log.
    if json_text_is_chat_list_pane(text) {
        return None;
    }
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.len() < 4 {
        return None;
    }
    let mut current_author: Option<String> = None;
    let mut turns: Vec<String> = Vec::new();
    let mut header_count = 0usize;
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];
        // Drop timestamps, affordances, false-speaker badges and low-signal chrome.
        if JSON_CHAT_TIMESTAMP_LINE_RE.is_match(line)
            || JSON_DISCORD_AFFORDANCE_RE.is_match(line)
            || JSON_FALSE_SPEAKER_PREFIX_RE.is_match(line)
            || json_is_low_signal_ui_line(line)
        {
            i += 1;
            continue;
        }
        // An author header switches the active speaker IF the next non-chrome line
        // is a timestamp (the canonical Discord author/time/body grouping). This
        // disambiguates a real header ("Master") from a one-word message body.
        if json_looks_like_author_header(line) {
            let next_is_time = lines[i + 1..]
                .iter()
                .find(|l| {
                    !JSON_FALSE_SPEAKER_PREFIX_RE.is_match(l) && !json_is_low_signal_ui_line(l)
                })
                .map(|l| JSON_CHAT_TIMESTAMP_LINE_RE.is_match(l))
                .unwrap_or(false);
            if next_is_time {
                current_author = json_normalize_author(line);
                header_count += 1;
                i += 1;
                continue;
            }
        }
        // Otherwise this is a body line — attribute it to the active author.
        if let Some(author) = &current_author {
            if json_is_speaker_turn_line(line) {
                turns.push(line.to_string());
            } else {
                turns.push(format!("{author}: {line}"));
            }
        }
        i += 1;
    }
    // Only trust the reconstruction when it found a real conversation: at least
    // two distinct author headers (or one author with several attributed turns).
    let distinct = {
        let mut authors: Vec<&str> = turns
            .iter()
            .filter_map(|t| t.split_once(": ").map(|(a, _)| a))
            .collect();
        authors.sort_unstable();
        authors.dedup();
        authors.len()
    };
    if turns.is_empty() || (header_count < 2 && distinct < 2 && turns.len() < 3) {
        return None;
    }
    Some(json_dedupe_consecutive(turns).join("\n"))
}

/// Reconstruct `Author: message` turns from Facebook Messenger's flat `<doc>`
/// blob, which embeds authorship as `… Message sent <when> by <Author>: <body>`.
/// Splits on each "Message sent … by <Author>:" marker and attributes the text
/// up to the next marker. Returns `None` when no such marker is present.
fn json_reconstruct_messenger_blob(text: &str) -> Option<String> {
    let markers: Vec<regex::Match> = JSON_MESSENGER_BY_AUTHOR_RE.find_iter(text).collect();
    if markers.len() < 2 {
        return None;
    }
    let mut turns: Vec<String> = Vec::new();
    for (idx, m) in markers.iter().enumerate() {
        let caps = match JSON_MESSENGER_BY_AUTHOR_RE.captures(m.as_str()) {
            Some(c) => c,
            None => continue,
        };
        let Some(author) = caps.name("author").map(|a| a.as_str().trim().to_string()) else {
            continue;
        };
        let body_start = m.end();
        let body_end = markers
            .get(idx + 1)
            .map(|next| next.start())
            .unwrap_or(text.len());
        let body = text[body_start..body_end].trim();
        if author.is_empty() || body.is_empty() {
            continue;
        }
        let Some(author) = json_normalize_author(&author) else {
            continue;
        };
        // Messenger duplicates the body once verbatim after the colon
        // ("...by موه: <body> <body>") — keep just the first half if it repeats.
        let body = json_dedupe_repeated_half(body);
        let body = json_messenger_clean_body(&body);
        if body.is_empty() {
            continue;
        }
        turns.push(format!("{author}: {}", json_collapse_inline_ws(&body)));
    }
    if turns.len() < 2 {
        return None;
    }
    Some(json_dedupe_consecutive(turns).join("\n"))
}

/// Trim Messenger composer/footer chrome that trails the LAST message in the
/// flat doc blob (the message log has no closing delimiter, so the final turn's
/// body otherwise swallows the composer toolbar, the "Continue without
/// restoring?" modal, etc.). Also drop the "Original message:" reply-quote
/// preamble Messenger injects before an edited message.
fn json_messenger_clean_body(body: &str) -> String {
    let mut s = body;
    for cut in [
        " Compose ",
        " Open more actions",
        " Play video",
        " Play voice",
        " Attach a file",
        " Choose a sticker",
        " Choose a GIF",
        " Write to ",
        " Chat notifications",
        " Continue without restoring",
        " Opened group chat",
        " Original message:",
    ] {
        if let Some(i) = s.find(cut) {
            s = &s[..i];
        }
    }
    s.trim().to_string()
}

/// Reconstruct `DisplayName: tweet` turns from X's flat conversation blob. X has
/// no `Author:` prefix — each tweet is positionally `<DisplayName> @handle
/// [relative-time] <body> <engagement-counts>`. We split the blob on `@handle`
/// boundaries: the words immediately BEFORE a handle are that tweet's display
/// name, and the text AFTER the handle (minus a leading relative-time token) up
/// to the next handle is the body. Self-identity (the author pair that appears
/// before the "Conversation"/"Replying to" boundary) and the quoted/embedded
/// tweet chrome are dropped. Returns `None` when fewer than one real tweet author
/// is recoverable (so a non-X blob is never mangled).
fn json_reconstruct_x_blob(blob: &str) -> Option<String> {
    // Only engage on an X conversation blob (the "Conversation" landmark word is
    // present in every captured reply page and absent elsewhere).
    if !blob.contains("Conversation") {
        return None;
    }
    // Scope to AFTER the "Conversation" boundary so the top-bar self-identity
    // (Mostafa @Dahshury) and left-nav are excluded.
    let scoped = match blob.find("Conversation") {
        Some(i) => &blob[i + "Conversation".len()..],
        None => blob,
    };
    let handles: Vec<regex::Match> = JSON_X_HANDLE_RE.find_iter(scoped).collect();
    if handles.is_empty() {
        return None;
    }
    let mut turns: Vec<String> = Vec::new();
    let mut seen_handles: Vec<String> = Vec::new();
    for (idx, h) in handles.iter().enumerate() {
        let handle = h.as_str();
        // Display name = the tail of the text since the previous handle's body
        // start, taking the last 1–3 capitalized-ish words right before @handle.
        let name_region_start = if idx == 0 {
            0
        } else {
            handles[idx - 1].end()
        };
        let name_region = &scoped[name_region_start..h.start()];
        let display_name = json_x_trailing_display_name(name_region);
        // Body = text after the handle up to the next handle.
        let body_start = h.end();
        let body_end = handles
            .get(idx + 1)
            .map(|n| {
                // back up to the start of that tweet's display name so the next
                // author's name isn't appended to this body.
                let region = &scoped[h.end()..n.start()];
                h.end() + json_x_body_cutoff(region)
            })
            .unwrap_or(scoped.len());
        if body_end <= body_start {
            continue;
        }
        let body = json_x_clean_body(&scoped[body_start..body_end]);
        // Skip the quoted/embedded tweet (it follows a "Quote" marker) and empty
        // bodies; dedupe consecutive same-handle continuations.
        let Some(name) = display_name.filter(|n| !n.is_empty()) else {
            continue;
        };
        // Drop chrome "names" (the 'Replying to @x' marker, bare 'Post'/'Quote').
        let name_lower = name.to_lowercase();
        if matches!(name_lower.as_str(), "replying to" | "replying" | "post" | "quote" | "reply") {
            continue;
        }
        if body.chars().count() < 8 {
            continue;
        }
        // Drop the user's own reply-compose prompt and known chrome bodies.
        if body.eq_ignore_ascii_case("Post your reply") || body.starts_with("Replying to") {
            continue;
        }
        // Format as `DisplayName: body` so it matches the speaker-prefix contract
        // (the parenthetical-handle form breaks JSON_SPEAKER_PREFIX_RE). The
        // @handle is preserved inline at the end of the name when it is the only
        // identity signal (display name == handle).
        if seen_handles.last().map(String::as_str) != Some(handle) {
            seen_handles.push(handle.to_string());
        }
        turns.push(format!("{name}: {body}"));
    }
    if turns.is_empty() {
        return None;
    }
    Some(json_dedupe_consecutive(turns).join("\n"))
}

/// The display name preceding an `@handle`: the last short run of name words in
/// `region` (after stripping leading chrome words like Post/Quote/Reply/counts).
fn json_x_trailing_display_name(region: &str) -> Option<String> {
    let words: Vec<&str> = region.split_whitespace().collect();
    // Take up to the last 4 tokens, dropping chrome/count tokens.
    let mut name_words: Vec<&str> = Vec::new();
    for w in words.iter().rev() {
        if name_words.len() >= 4 {
            break;
        }
        let lw = w.to_lowercase();
        let is_count = w
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | 'K' | 'M' | 'B'));
        let is_chrome = matches!(
            lw.as_str(),
            "post" | "quote" | "reply" | "views" | "view" | "quotes" | "relevant" | "·"
                | "show" | "replies" | "translation" | "·jun" | "grok" | "chat"
        ) || JSON_CHAT_TIMESTAMP_LINE_RE.is_match(w)
            || lw.ends_with('h')
                && lw.trim_end_matches('h').chars().all(|c| c.is_ascii_digit())
            || lw.ends_with('m')
                && lw.trim_end_matches('m').chars().all(|c| c.is_ascii_digit());
        if is_count || is_chrome {
            if name_words.is_empty() {
                continue;
            }
            break;
        }
        name_words.push(w);
    }
    name_words.reverse();
    let name = name_words.join(" ");
    let name = json_normalize_author(&name)?;
    Some(name)
}

/// Where this tweet's body ends inside `region` (the span between two handles).
/// The next author's display name (~1–4 words) sits at the very end of `region`;
/// since the name detector for the next turn re-scans from this handle's end, a
/// small overlap is harmless, so we keep the whole span up to its trailing
/// whitespace.
fn json_x_body_cutoff(region: &str) -> usize {
    region.trim_end().len()
}

/// Clean an X tweet body: strip leading relative-time/counts, trailing engagement
/// counts and known chrome words, and collapse whitespace.
fn json_x_clean_body(raw: &str) -> String {
    let collapsed = json_collapse_inline_ws(raw);
    let mut s = collapsed.as_str();
    // strip a leading relative-time token ('9h', '20h', '30m', '·', 'Jun 14').
    loop {
        let trimmed = s.trim_start();
        let first = trimmed.split_whitespace().next().unwrap_or("");
        let flw = first.to_lowercase();
        let is_rel = (flw.ends_with('h') || flw.ends_with('m') || flw.ends_with('d'))
            && flw[..flw.len().saturating_sub(1)]
                .chars()
                .all(|c| c.is_ascii_digit())
            && !flw.is_empty()
            && flw.len() <= 4;
        if first == "·" || is_rel {
            s = &trimmed[first.len()..];
        } else {
            break;
        }
    }
    // Cut the body at the engagement/footer markers that follow every tweet.
    for cut in [
        " Quote ",
        " Show replies",
        " Show this thread",
        " Show translation",
        " View quotes",
        " Replying to ",
        " · ",
    ] {
        if let Some(i) = s.find(cut) {
            s = &s[..i];
        }
    }
    json_collapse_inline_ws(s).trim().to_string()
}

/// Some UIA TextPattern reads emit a value followed by an exact duplicate of
/// itself ("X X"). When the back half exactly repeats the front, drop it.
fn json_dedupe_repeated_half(body: &str) -> String {
    let trimmed = body.trim();
    let count = trimmed.chars().count();
    if count >= 4 && count.is_multiple_of(2) {
        // Split at the char (not byte) midpoint so multibyte text is safe.
        let mid_byte = trimmed
            .char_indices()
            .nth(count / 2)
            .map(|(i, _)| i)
            .unwrap_or(trimmed.len());
        let (a, b) = trimmed.split_at(mid_byte);
        if a.trim() == b.trim() {
            return a.trim().to_string();
        }
    }
    trimmed.to_string()
}

fn json_collect_descendant_text_values(tree: &JsonAxTree, node_idx: usize, out: &mut Vec<String>) {
    let node = &tree.nodes[node_idx];
    if json_drop_subtree_role(&node.role) || json_is_omnibox(node) {
        return;
    }
    if node.name.chars().count() >= 2
        && !json_is_low_signal_ui_line(&node.name)
        && node.role == "text"
    {
        out.push(node.name.trim().to_string());
    }
    if node.text.chars().count() >= 2 && !json_is_low_signal_ui_line(&node.text) {
        out.push(node.text.trim().to_string());
    }
    for child in &node.children {
        json_collect_descendant_text_values(tree, *child, out);
    }
}

fn json_reconstruct_speaker_turns(tree: &JsonAxTree, node_idx: usize) -> Option<Vec<String>> {
    let node = &tree.nodes[node_idx];
    if !matches!(node.role.as_str(), "item" | "group" | "row") {
        return None;
    }
    let mut values = Vec::new();
    if node.text.chars().count() >= 2 && !json_is_low_signal_ui_line(&node.text) {
        values.push(node.text.trim().to_string());
    }
    for child in &node.children {
        json_collect_descendant_text_values(tree, *child, &mut values);
    }
    values = json_dedupe_consecutive(values)
        .into_iter()
        .filter(|line| !json_is_time_or_meta_line(line))
        .collect();

    let author = json_normalize_author(&node.name).or_else(|| {
        if !matches!(node.role.as_str(), "item" | "row") {
            return None;
        }
        let first = values.first()?;
        json_normalize_author(first)
    })?;
    let messages = values
        .into_iter()
        .filter(|line| {
            line.trim() != author
                && !json_is_time_or_meta_line(line)
                && !json_is_low_signal_ui_line(line)
        })
        .collect::<Vec<_>>();
    if messages.is_empty() {
        return None;
    }
    Some(
        messages
            .into_iter()
            .map(|message| {
                if json_is_speaker_turn_line(&message) {
                    message
                } else {
                    format!("{author}: {message}")
                }
            })
            .collect(),
    )
}

fn json_contains_node(tree: &JsonAxTree, node: usize, target: usize) -> bool {
    node == target
        || tree.nodes[node]
            .children
            .iter()
            .any(|child| json_contains_node(tree, *child, target))
}

fn json_is_nav_chrome(tree: &JsonAxTree, node_idx: usize, focus: Option<usize>) -> bool {
    let node = &tree.nodes[node_idx];
    if JSON_CONTENT_LIST_NAME_RE.is_match(&node.name) {
        return false;
    }
    let matches_nav = if node.role == "list" {
        JSON_NAV_NAME_RE.is_match(&node.name)
    } else {
        json_landmark_role(&node.role) && JSON_CONTAINER_NAV_RE.is_match(&node.name)
    };
    if !matches_nav {
        return false;
    }
    !focus
        .map(|focus_idx| json_contains_node(tree, node_idx, focus_idx))
        .unwrap_or(false)
}

fn json_collect_lines(
    tree: &JsonAxTree,
    node_idx: usize,
    focus: Option<usize>,
    exclude: Option<usize>,
) -> Vec<String> {
    let node = &tree.nodes[node_idx];
    if json_drop_subtree_role(&node.role)
        || json_is_omnibox(node)
        || json_is_nav_chrome(tree, node_idx, focus)
    {
        return Vec::new();
    }
    let mut lines = Vec::new();
    if exclude != Some(node_idx) {
        if let Some(turns) = json_reconstruct_speaker_turns(tree, node_idx) {
            return turns;
        }
        let name = node.name.trim();
        if json_name_emit_role(&node.role)
            && name.chars().count() >= 2
            && !json_is_low_signal_ui_line(name)
        {
            lines.push(name.to_string());
        }
        let text = node.text.trim();
        if text.chars().count() >= 2 && !json_is_low_signal_ui_line(text) {
            lines.push(text.to_string());
        }
    }
    for child in &node.children {
        lines.extend(json_collect_lines(tree, *child, focus, exclude));
    }
    lines
}

fn json_dedupe_consecutive(lines: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in lines {
        if out.last() != Some(&line) {
            out.push(line);
        }
    }
    out
}

fn json_find_focus_path_rec(tree: &JsonAxTree, node: usize, path: &mut Vec<usize>) -> bool {
    path.push(node);
    if tree.nodes[node].focused {
        return true;
    }
    for child in &tree.nodes[node].children {
        if json_find_focus_path_rec(tree, *child, path) {
            return true;
        }
    }
    path.pop();
    false
}

fn json_find_focus_path(tree: &JsonAxTree) -> Option<Vec<usize>> {
    let mut path = Vec::new();
    json_find_focus_path_rec(tree, 0, &mut path).then_some(path)
}

fn json_scoped_content_len(tree: &JsonAxTree, node: usize, focus: Option<usize>) -> usize {
    let joined = json_collect_lines(tree, node, focus, None).join("\n");
    denoise_for_llm(Some(&joined)).chars().count()
}

fn json_find_landmark_on_path(tree: &JsonAxTree, path: &[usize], focus: usize) -> Option<usize> {
    let mut best = None;
    let mut best_len = 0usize;
    for node_idx in path {
        let node = &tree.nodes[*node_idx];
        if *node_idx == focus || !json_landmark_role(&node.role) {
            continue;
        }
        let len = json_scoped_content_len(tree, *node_idx, Some(focus));
        if len >= JSON_LANDMARK_MIN_CHARS && len >= best_len {
            best = Some(*node_idx);
            best_len = len;
        }
    }
    best
}

fn json_find_largest_landmark_rec(
    tree: &JsonAxTree,
    node_idx: usize,
    best: &mut Option<(usize, usize)>,
) {
    let node = &tree.nodes[node_idx];
    if json_landmark_role(&node.role) {
        let len = json_scoped_content_len(tree, node_idx, None);
        if best.map(|(_, best_len)| len > best_len).unwrap_or(true) {
            *best = Some((node_idx, len));
        }
    }
    for child in &node.children {
        json_find_largest_landmark_rec(tree, *child, best);
    }
}

fn json_find_largest_landmark(tree: &JsonAxTree) -> Option<usize> {
    let mut best = None;
    json_find_largest_landmark_rec(tree, 0, &mut best);
    best.map(|(idx, _)| idx)
}

fn json_should_clip_thread_tail(lines: &[String], focus: Option<usize>) -> bool {
    focus.is_some()
        && lines
            .iter()
            .filter(|line| json_is_speaker_turn_line(line.trim()))
            .take(3)
            .count()
            >= 3
}

fn json_resolve_landmark(tree: &JsonAxTree) -> Option<usize> {
    let path = json_find_focus_path(tree);
    let focus = path.as_ref().and_then(|p| p.last()).copied();
    if let (Some(path), Some(focus)) = (path.as_deref(), focus) {
        if !json_is_omnibox(&tree.nodes[focus]) {
            if let Some(on_path) = json_find_landmark_on_path(tree, path, focus) {
                return Some(on_path);
            }
        }
    }
    json_find_largest_landmark(tree)
}

/// True when the focused control is a compose box (an `edit`/`doc` with a focus
/// flag) that has NO real CONTENT landmark on its ancestor path — i.e. the only
/// thing the landmark resolver could pick is the whole-page largest landmark
/// (the timeline feed on X home). In that case there is no thread to attribute,
/// so the tree path must emit nothing for `screen` and rely on the draft
/// (`fieldText`). This is the X-compose vs X-reply discriminator (plan B1):
/// X-reply has a `doc`/`Conversation` content landmark ON the focus path, so
/// `json_find_landmark_on_path` returns it and this guard does NOT fire.
fn json_compose_only_no_thread_landmark(tree: &JsonAxTree) -> bool {
    let Some(path) = json_find_focus_path(tree) else {
        return false;
    };
    let Some(&focus) = path.last() else {
        return false;
    };
    let focus_node = &tree.nodes[focus];
    // Only relevant when the focus is an editable composer.
    if !matches!(focus_node.role.as_str(), "edit" | "doc") || json_is_omnibox(focus_node) {
        return false;
    }
    // A content landmark anywhere on the focus path means a thread is present
    // (X-reply Conversation doc, Gmail reading-pane group) — keep it.
    if json_find_landmark_on_path(tree, &path, focus).is_some() {
        return false;
    }
    // A content-list (messages/conversation/thread/timeline) that WRAPS the
    // focus is also a thread context — keep it.
    let in_content_list = path
        .iter()
        .any(|&idx| JSON_CONTENT_LIST_NAME_RE.is_match(&tree.nodes[idx].name));
    !in_content_list
}

pub fn prune_ax_html_for_llm(ax_html: Option<&str>) -> String {
    let ax_html = ax_html.unwrap_or("").trim();
    if ax_html.is_empty() {
        return String::new();
    }
    let tree = json_parse_ax_html(ax_html);
    // B1 — compose-vs-thread guard: a bare composer with no thread landmark on
    // its focus path (X home compose) must NOT dump the timeline feed.
    if json_compose_only_no_thread_landmark(&tree) {
        return String::new();
    }
    let Some(landmark) = json_resolve_landmark(&tree) else {
        return String::new();
    };
    let focus = json_find_focus_path(&tree).and_then(|p| p.last().copied());
    let lines = json_dedupe_consecutive(json_collect_lines(&tree, landmark, focus, None));
    let out = denoise_for_llm(Some(&lines.join("\n")));
    if out.chars().count() < JSON_LANDMARK_MIN_CHARS {
        return String::new();
    }
    // The landmark pruner often resolves to ONE big `<doc>` node whose text is a
    // flat page-spanning TextPattern blob (X conversation, Messenger thread) with
    // no per-message nodes. Try to recover `Author: message` turns from that flat
    // text; only succeeds when a known conversation shape is confidently detected.
    let out = json_attribute_flat_blob(&out);
    if json_should_clip_thread_tail(&lines, focus) {
        clip_tail(&out, JSON_MAX_LLM_CONTEXT_CHARS)
    } else {
        clip_head(&out, JSON_MAX_LLM_CONTEXT_CHARS)
    }
}

/// Best-effort speaker attribution for a flat (page-spanning) text blob. Tries
/// each known surface shape in turn (Messenger "by Author:" markers, then X
/// display-name/@handle positional attribution); returns the original blob
/// unchanged when none match, so a non-conversation page is never corrupted.
fn json_attribute_flat_blob(blob: &str) -> String {
    if let Some(turns) = json_reconstruct_messenger_blob(blob) {
        return turns;
    }
    if let Some(turns) = json_reconstruct_x_blob(blob) {
        return turns;
    }
    blob.to_string()
}

enum JsonPromptValue {
    Bool(bool),
    Text(String),
}

struct JsonPromptSection {
    key: &'static str,
    value: JsonPromptValue,
}

impl JsonPromptSection {
    fn text(key: &'static str, value: impl Into<String>) -> Self {
        Self {
            key,
            value: JsonPromptValue::Text(value.into()),
        }
    }

    fn bool(key: &'static str, value: bool) -> Self {
        Self {
            key,
            value: JsonPromptValue::Bool(value),
        }
    }

    fn has_value(&self) -> bool {
        match &self.value {
            JsonPromptValue::Bool(value) => *value,
            JsonPromptValue::Text(value) => !value.is_empty(),
        }
    }
}

fn json_serialize_context(sections: Vec<JsonPromptSection>) -> String {
    let sections = sections
        .into_iter()
        .filter(JsonPromptSection::has_value)
        .collect::<Vec<_>>();
    if sections.is_empty() {
        return String::new();
    }

    let mut out = String::from("{\n");
    for (index, section) in sections.iter().enumerate() {
        let key = serde_json::to_string(section.key).unwrap_or_else(|_| "\"\"".to_string());
        let value = match &section.value {
            JsonPromptValue::Bool(value) => value.to_string(),
            JsonPromptValue::Text(value) => {
                serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
            }
        };
        out.push_str("  ");
        out.push_str(&key);
        out.push_str(": ");
        out.push_str(&value);
        if index + 1 < sections.len() {
            out.push(',');
        }
        out.push('\n');
    }
    out.push('}');
    out
}

fn json_trim_or_empty(raw: Option<&str>) -> String {
    raw.unwrap_or("").trim().to_string()
}

fn json_build_metadata_sections(snapshot: &WindowContextSnapshot) -> Vec<JsonPromptSection> {
    vec![
        JsonPromptSection::text("app", json_trim_or_empty(snapshot.app_exe.as_deref())),
        JsonPromptSection::bool("ide", is_ide_context(snapshot)),
        JsonPromptSection::text("url", json_trim_or_empty(snapshot.url.as_deref())),
        JsonPromptSection::text("window", snapshot.window_title.trim()),
        JsonPromptSection::text("field", snapshot.element_name.trim()),
    ]
}

fn json_build_selected_section(snapshot: &WindowContextSnapshot) -> JsonPromptSection {
    JsonPromptSection::text(
        "selection",
        clip_head(
            &json_clean_caret(snapshot.selected_text.as_deref()),
            SELECTED_TEXT_LLM_MAX,
        ),
    )
}

fn json_build_clipboard_section(snapshot: &WindowContextSnapshot) -> JsonPromptSection {
    JsonPromptSection::text(
        "clipboard",
        clip_head(
            &json_clean_caret(snapshot.clipboard_text.as_deref()),
            CLIPBOARD_LLM_MAX,
        ),
    )
}

fn json_build_fallback_tree_section(snapshot: &WindowContextSnapshot) -> JsonPromptSection {
    if is_canvas_surface(snapshot.app_exe.as_deref(), snapshot.url.as_deref()) {
        return JsonPromptSection::text("screen", "");
    }
    let pruned = prune_ax_html_for_llm(snapshot.ax_html.as_deref());
    if !pruned.is_empty() {
        return JsonPromptSection::text("screen", pruned);
    }
    JsonPromptSection::text("screen", json_trim_or_empty(snapshot.ax_html.as_deref()))
}

fn json_build_ocr_section(snapshot: &WindowContextSnapshot) -> JsonPromptSection {
    JsonPromptSection::text("screenOcr", denoise_for_llm(snapshot.ocr_text.as_deref()))
}

fn json_build_content_sections(snapshot: &WindowContextSnapshot) -> Vec<JsonPromptSection> {
    let before = json_clean_caret(snapshot.text_before.as_deref());
    let after = json_clean_caret(snapshot.text_after.as_deref());
    if !before.is_empty() || !after.is_empty() {
        // A "rich" beforeCaret on a chat composer (Discord) is the rendered
        // backlog as a FLAT author/timestamp/body line stream — reconstruct it
        // into `Author: message` turns before clipping. Falls back to the raw
        // blob when it is not conversation-shaped (e.g. a real typed draft).
        let before = json_reconstruct_discord_stream(&before).unwrap_or(before);
        return vec![
            JsonPromptSection::text("beforeCaret", clip_tail(&before, JSON_CARET_BEFORE_LLM_MAX)),
            JsonPromptSection::text("afterCaret", clip_head(&after, CARET_AFTER_LLM_MAX)),
        ];
    }
    vec![JsonPromptSection::text(
        "fieldText",
        json_clean_caret(Some(&snapshot.focused_text)),
    )]
}

/// Nav markers that co-occur in a page-spanning UIA TextPattern range (Gmail
/// reading pane / X article) but never in a real typed draft. Kept lowercase.
const JSON_PAGE_NAV_MARKERS: &[&str] = &[
    "inbox",
    "compose",
    "snoozed",
    "drafts",
    "promotions",
    "home",
    "explore",
    "notifications",
    "bookmarks",
    "what's happening",
    "trending",
    "who to follow",
    "address and search bar",
];

/// True when caret text is "rich" only because the focused control's UIA
/// TextPattern range spans the WHOLE page (Gmail reading-pane / X article),
/// not because the user typed a long draft. In that case the flat `beforeCaret`
/// blob leaks left-nav + inbox + counts; the formatter must instead route to
/// the role-based tree pruner. A real typed draft has no nav markers and is
/// short, so it stays on the fast `beforeCaret` path.
///
/// Heuristic (mirrors the plan A1):
/// - >=2 co-occurring browser/app nav markers, OR
/// - a speaker-prefix line is present AND the blob is long (>12 lines) — i.e.
///   it already looks like a rendered conversation, not a draft.
fn json_caret_is_page_scrollback(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    let lower = text.to_lowercase();
    let nav_hits = JSON_PAGE_NAV_MARKERS
        .iter()
        .filter(|marker| lower.contains(**marker))
        .count();
    let has_speaker_line = text.lines().any(json_is_speaker_turn_line);
    // A chat-list rail (WhatsApp left column) is page-scrollback too — reroute it
    // to the tree path so its contact-list previews (and any delivery/OTP codes)
    // do not leak through the flat beforeCaret.
    json_text_is_chat_list_pane(text)
        || nav_hits >= 2
        || (has_speaker_line && text.lines().count() > 12)
}

fn format_context_for_prompt_json(snapshot: &WindowContextSnapshot) -> String {
    let mut sections = json_build_metadata_sections(snapshot);
    sections.push(json_build_selected_section(snapshot));

    if looks_like_terminal(snapshot) {
        sections.push(JsonPromptSection::text(
            "note",
            "Terminal/console focused - scrollback omitted (no clean prior text available).",
        ));
        sections.push(json_build_clipboard_section(snapshot));
        return json_serialize_context(sections);
    }

    // A1/A2 — the highest-impact fix. A "rich" focused field whose caret text is
    // actually a page-spanning scrollback (Gmail reading pane / X article) leaks
    // nav/inbox/counts through the flat beforeCaret path. When we ALSO have an
    // ax_html tree, prefer the role-based pruner (the `screen` key) which
    // structurally drops the nav/inbox/toolbar subtrees. Real typed drafts (no
    // nav markers, short) keep the fast beforeCaret path.
    //
    // NB: detect on the RAW (denoise-only) caret, NOT the fully-cleaned one —
    // json_clean_caret runs strip_list_scrollback which would already have
    // removed the nav/inbox markers we key on, hiding the leak from the detector.
    let has_tree = snapshot
        .ax_html
        .as_deref()
        .is_some_and(|ax| !ax.trim().is_empty());
    let caret_is_scrollback =
        json_caret_is_page_scrollback(&denoise_for_llm(snapshot.text_before.as_deref()));

    // Chat composers (Discord) expose the rendered backlog ONLY in the focused
    // field's beforeCaret as a flat author/timestamp/body stream — it is not in
    // the ax_html tree. When that stream confidently reconstructs into multi-
    // author `Author: message` turns, keep it on the beforeCaret path with the
    // reconstructed turns (the scrollback reroute would send it to the tree,
    // which has no thread). This must win over the page-scrollback heuristic.
    //
    // NB: reconstruct from the DENOISED caret, NOT json_clean_caret — the latter
    // runs strip_list_scrollback, whose inbox-date-row cut treats Discord's bare
    // `H:MM PM` timestamp lines as list rows and would amputate the whole thread.
    let reconstructed_chat = denoise_for_llm(snapshot.text_before.as_deref());
    if let Some(turns) = json_reconstruct_discord_stream(&reconstructed_chat) {
        sections.push(JsonPromptSection::text(
            "beforeCaret",
            clip_tail(&turns, JSON_CARET_BEFORE_LLM_MAX),
        ));
        let after = json_clean_caret(snapshot.text_after.as_deref());
        sections.push(JsonPromptSection::text(
            "afterCaret",
            clip_head(&after, CARET_AFTER_LLM_MAX),
        ));
        sections.push(json_build_clipboard_section(snapshot));
        return json_serialize_context(sections);
    }

    if json_focused_field_is_rich(snapshot) && !(has_tree && caret_is_scrollback) {
        sections.extend(json_build_content_sections(snapshot));
        sections.push(json_build_clipboard_section(snapshot));
        return json_serialize_context(sections);
    }

    sections.push(json_build_fallback_tree_section(snapshot));
    // When we rerouted here BECAUSE the caret blob is page-spanning scrollback,
    // the flat content sections would re-leak that same polluted blob as
    // `beforeCaret` — so suppress them. The pruned tree (`screen` above) is the
    // clean signal. The empty-tree thin-field case still emits `fieldText`.
    if !(has_tree && caret_is_scrollback) {
        sections.extend(json_build_content_sections(snapshot));
    }
    sections.push(json_build_ocr_section(snapshot));
    sections.push(json_build_clipboard_section(snapshot));
    json_serialize_context(sections)
}

/// Resolve a snapshot through the deny-list, returning the (possibly redacted)
/// snapshot ready for formatting. A denied app keeps only metadata. Mirrors
/// the relay-context-capture flow's deny-list gate.
pub fn apply_deny_list(
    snapshot: &WindowContextSnapshot,
    deny_list: &[String],
) -> WindowContextSnapshot {
    if is_denied_by_list(snapshot, deny_list) {
        redact_sensitive_fields(snapshot)
    } else {
        snapshot.clone()
    }
}

/// Resolve a snapshot through the configured app-scope policy. The existing
/// default remains `all-except-denied`; selected-only mode captures rich text
/// only when the foreground app/url matches the user's allow-list.
pub fn apply_context_app_policy(
    snapshot: &WindowContextSnapshot,
    app_mode: ContextAppMode,
    deny_list: &[String],
    allow_list: &[String],
) -> WindowContextSnapshot {
    match app_mode {
        ContextAppMode::AllExceptDenied => apply_deny_list(snapshot, deny_list),
        ContextAppMode::SelectedOnly => {
            if is_allowed_by_list(snapshot, allow_list) {
                snapshot.clone()
            } else {
                redact_sensitive_fields(snapshot)
            }
        }
    }
}

/// Convenience: read → deny-list → format, the full capture-to-prompt path
/// the dictation pipeline calls. Mirrors relay-context-capture's
/// recording_start capture → fullSentence serve.
pub fn capture_prompt_fragment(
    reader: &dyn ContextReader,
    mode: ContextMode,
    app_mode: ContextAppMode,
    deny_list: &[String],
    allow_list: &[String],
) -> String {
    let raw = reader.read(mode);
    let resolved = apply_context_app_policy(&raw, app_mode, deny_list, allow_list);
    format_context_for_prompt(&resolved)
}

/// Diagnostic snapshot of the detection verdicts (for the context-playground
/// debug tooling). Mirrors the playground's "what does capture see" panel.
pub fn debug_verdicts(snapshot: &WindowContextSnapshot) -> BTreeMap<&'static str, bool> {
    let mut m = BTreeMap::new();
    m.insert("ide", is_ide_context(snapshot));
    m.insert("terminal", looks_like_terminal(snapshot));
    m.insert(
        "canvas",
        is_canvas_surface(snapshot.app_exe.as_deref(), snapshot.url.as_deref()),
    );
    m.insert("rich_field", focused_field_is_rich(snapshot));
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap() -> WindowContextSnapshot {
        WindowContextSnapshot::default()
    }

    fn context_json(out: &str) -> serde_json::Value {
        serde_json::from_str(out).expect("context fragment must be valid JSON")
    }

    fn screen_text(snapshot: WindowContextSnapshot) -> String {
        let out = format_context_for_prompt(&snapshot);
        let ctx = context_json(&out);
        ctx["screen"].as_str().unwrap_or("").to_string()
    }

    // ── JSON parsing ──

    #[test]
    fn parse_attaches_only_nonempty_optionals() {
        let raw = r#"{"windowTitle":"Gmail","elementName":"Body","focusedText":"hi","textBefore":"","appExe":"chrome.exe","url":"https://mail.google.com"}"#;
        let s = parse_snapshot(raw);
        assert_eq!(s.window_title, "Gmail");
        assert_eq!(s.focused_text, "hi");
        // empty textBefore is NOT attached
        assert!(s.text_before.is_none());
        assert_eq!(s.app_exe.as_deref(), Some("chrome.exe"));
        assert_eq!(s.url.as_deref(), Some("https://mail.google.com"));
    }

    #[test]
    fn parse_bad_json_yields_empty() {
        assert_eq!(parse_snapshot("not json"), empty_context());
        assert_eq!(parse_snapshot(""), empty_context());
    }

    #[test]
    fn parse_partial_sidecar_json_yields_empty_prompt() {
        let raw =
            r#"{"windowTitle":"Huge Chrome page","elementName":"Document","focusedText":"partial"#;
        let s = parse_snapshot(raw);
        assert_eq!(s, empty_context());
        assert_eq!(format_context_for_prompt(&s), "");
    }

    // ── deny-list ──

    #[test]
    fn deny_exe_exact_match() {
        let s = WindowContextSnapshot {
            app_exe: Some("1Password.exe".into()),
            ..snap()
        };
        assert!(is_denied_by_list(&s, &["1password.exe".into()]));
        assert!(!is_denied_by_list(&s, &["chrome.exe".into()]));
    }

    #[test]
    fn deny_host_covers_subdomains() {
        let s = WindowContextSnapshot {
            url: Some("https://secure.bankofamerica.com/login".into()),
            ..snap()
        };
        assert!(is_denied_by_list(&s, &["bankofamerica.com".into()]));
        // wildcard form normalized
        assert!(is_denied_by_list(&s, &["*.bankofamerica.com".into()]));
        assert!(!is_denied_by_list(&s, &["chase.com".into()]));
    }

    #[test]
    fn deny_empty_list_and_blank_patterns_no_op() {
        let s = WindowContextSnapshot {
            app_exe: Some("chrome.exe".into()),
            ..snap()
        };
        assert!(!is_denied_by_list(&s, &[]));
        assert!(!is_denied_by_list(&s, &["   ".into()]));
    }

    #[test]
    fn allow_list_reuses_exe_and_host_patterns() {
        let browser = WindowContextSnapshot {
            app_exe: Some("Chrome.exe".into()),
            url: Some("https://docs.google.com/document/d/123".into()),
            ..snap()
        };
        assert!(is_allowed_by_list(&browser, &["chrome.exe".into()]));
        assert!(is_allowed_by_list(&browser, &["google.com".into()]));
        assert!(is_allowed_by_list(&browser, &["*.docs.google.com".into()]));
        assert!(!is_allowed_by_list(&browser, &["notepad.exe".into()]));
        assert!(!is_allowed_by_list(&browser, &[]));
    }

    #[test]
    fn redact_keeps_only_metadata_triple() {
        let s = WindowContextSnapshot {
            window_title: "Bank".into(),
            element_name: "Password".into(),
            focused_text: "hunter2".into(),
            url: Some("https://bank.com".into()),
            ax_html: Some("<tree/>".into()),
            ..snap()
        };
        let r = redact_sensitive_fields(&s);
        assert_eq!(r.window_title, "Bank");
        assert_eq!(r.element_name, "Password");
        assert_eq!(r.focused_text, "");
        assert!(r.url.is_none());
        assert!(r.ax_html.is_none());
    }

    #[test]
    fn apply_deny_list_redacts_denied() {
        let s = WindowContextSnapshot {
            window_title: "x".into(),
            focused_text: "secret".into(),
            app_exe: Some("1password.exe".into()),
            ..snap()
        };
        let out = apply_deny_list(&s, &["1password.exe".into()]);
        assert_eq!(out.focused_text, "");
        // not denied → unchanged
        let out2 = apply_deny_list(&s, &["chrome.exe".into()]);
        assert_eq!(out2.focused_text, "secret");
    }

    #[test]
    fn selected_only_policy_redacts_unlisted_app() {
        let s = WindowContextSnapshot {
            window_title: "Notes".into(),
            focused_text: "private draft".into(),
            app_exe: Some("notepad.exe".into()),
            ..snap()
        };
        let out = apply_context_app_policy(
            &s,
            ContextAppMode::SelectedOnly,
            &["notepad.exe".into()],
            &["chrome.exe".into()],
        );
        assert_eq!(out.window_title, "Notes");
        assert_eq!(out.focused_text, "");

        let allowed = apply_context_app_policy(
            &s,
            ContextAppMode::SelectedOnly,
            &[],
            &["notepad.exe".into()],
        );
        assert_eq!(allowed.focused_text, "private draft");
    }

    // ── host extraction ──

    #[test]
    fn host_extraction_handles_missing_scheme() {
        assert_eq!(extract_host("github.com/foo"), "github.com");
        assert_eq!(extract_host("https://github.com/foo?x=1#y"), "github.com");
        assert_eq!(extract_host(""), "");
    }

    // ── IDE / terminal / canvas ──

    #[test]
    fn ide_detection() {
        let code = WindowContextSnapshot {
            app_exe: Some("Code.exe".into()),
            ..snap()
        };
        assert!(is_ide_context(&code));
        let idea = WindowContextSnapshot {
            app_exe: Some("idea64.exe".into()),
            ..snap()
        };
        assert!(is_ide_context(&idea));
        let chrome = WindowContextSnapshot {
            app_exe: Some("chrome.exe".into()),
            ..snap()
        };
        assert!(!is_ide_context(&chrome));
    }

    #[test]
    fn terminal_detection_word_boundary() {
        let term = WindowContextSnapshot {
            element_name: "Terminal 45, bash".into(),
            ..snap()
        };
        assert!(looks_like_terminal(&term));
        // "terminate" must NOT match (word boundary)
        let not_term = WindowContextSnapshot {
            element_name: "terminate process".into(),
            ..snap()
        };
        assert!(!looks_like_terminal(&not_term));
    }

    #[test]
    fn canvas_detection() {
        assert!(is_canvas_surface(Some("figma.exe"), None));
        assert!(is_canvas_surface(
            None,
            Some("https://www.figma.com/file/x")
        ));
        assert!(!is_canvas_surface(
            Some("notepad.exe"),
            Some("https://example.com")
        ));
    }

    // ── IDE profile (per-IDE feature matrix) ──

    #[test]
    fn ide_kind_classification() {
        assert_eq!(ide_kind_from_exe(Some("Cursor.exe")), Some(IdeKind::Cursor));
        assert_eq!(
            ide_kind_from_exe(Some("windsurf.exe")),
            Some(IdeKind::Windsurf)
        );
        assert_eq!(ide_kind_from_exe(Some("Code.exe")), Some(IdeKind::VsCode));
        assert_eq!(
            ide_kind_from_exe(Some("Code - Insiders.exe")),
            Some(IdeKind::VsCodeInsiders)
        );
        assert_eq!(
            ide_kind_from_exe(Some("idea64.exe")),
            Some(IdeKind::JetBrains)
        );
        assert_eq!(ide_kind_from_exe(Some("chrome.exe")), None);
        assert_eq!(ide_kind_from_exe(None), None);
    }

    #[test]
    fn ide_profile_file_tagging_is_cursor_windsurf_only() {
        let cursor = WindowContextSnapshot {
            app_exe: Some("cursor.exe".into()),
            ..snap()
        };
        let p = ide_profile(&cursor).expect("cursor is an ide");
        assert!(p.variable_recognition);
        assert!(p.file_tagging);

        let vscode = WindowContextSnapshot {
            app_exe: Some("code.exe".into()),
            ..snap()
        };
        let p = ide_profile(&vscode).expect("vscode is an ide");
        assert!(p.variable_recognition);
        assert!(!p.file_tagging, "file tagging is Cursor/Windsurf only");

        let chrome = WindowContextSnapshot {
            app_exe: Some("chrome.exe".into()),
            ..snap()
        };
        assert!(ide_profile(&chrome).is_none());
    }

    #[test]
    fn ide_terminal_requires_ide_and_terminal_element() {
        let cursor_term = WindowContextSnapshot {
            app_exe: Some("cursor.exe".into()),
            element_name: "Terminal 1, pwsh".into(),
            ..snap()
        };
        assert!(is_ide_terminal(&cursor_term));
        // IDE editor (not terminal) → not an IDE terminal.
        let cursor_editor = WindowContextSnapshot {
            app_exe: Some("cursor.exe".into()),
            element_name: "Editor, main.rs".into(),
            ..snap()
        };
        assert!(!is_ide_terminal(&cursor_editor));
        // Terminal in a non-IDE app → not an IDE terminal.
        let wt = WindowContextSnapshot {
            app_exe: Some("windowsterminal.exe".into()),
            element_name: "Terminal".into(),
            ..snap()
        };
        assert!(!is_ide_terminal(&wt));
    }

    #[test]
    fn ai_cli_detection_needs_terminal_and_cli_name() {
        let claude = WindowContextSnapshot {
            window_title: "Claude Code — myproject".into(),
            element_name: "Terminal 2, bash".into(),
            ..snap()
        };
        assert!(is_ai_coding_cli(&claude));
        let codex = WindowContextSnapshot {
            window_title: "codex".into(),
            element_name: "console".into(),
            ..snap()
        };
        assert!(is_ai_coding_cli(&codex));
        // A terminal with no CLI name → not an AI CLI.
        let plain = WindowContextSnapshot {
            window_title: "pwsh".into(),
            element_name: "Terminal 1".into(),
            ..snap()
        };
        assert!(!is_ai_coding_cli(&plain));
        // The CLI name outside a terminal (e.g. a browser tab) → not an AI CLI.
        let browser = WindowContextSnapshot {
            window_title: "Claude — Anthropic".into(),
            element_name: "Document".into(),
            ..snap()
        };
        assert!(!is_ai_coding_cli(&browser));
    }

    // ── prompt formatter ──

    #[test]
    fn format_empty_snapshot_is_empty_string() {
        assert_eq!(format_context_for_prompt(&empty_context()), "");
    }

    #[test]
    fn format_terminal_omits_scrollback() {
        let s = WindowContextSnapshot {
            element_name: "Terminal 1, pwsh".into(),
            text_before: Some("a".repeat(500)),
            ax_html: Some("<tree>lots of soup</tree>".into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        assert!(ctx["note"]
            .as_str()
            .unwrap()
            .contains("Terminal/console focused"));
        assert!(ctx.get("beforeCaret").is_none());
        assert!(ctx.get("screen").is_none());
        assert!(!out.contains("soup"));
    }

    #[test]
    fn format_rich_field_drops_tree() {
        let s = WindowContextSnapshot {
            element_name: "Message body".into(),
            text_before: Some("Dear team, ".repeat(10)), // > 40 chars
            ax_html: Some("<tree>chrome</tree>".into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        assert!(ctx["beforeCaret"].as_str().unwrap().contains("Dear team"));
        // tree dropped when focused field is rich
        assert!(ctx.get("screen").is_none());
        assert!(!out.contains("chrome"));
    }

    #[test]
    fn format_thin_field_includes_tree() {
        let s = WindowContextSnapshot {
            element_name: "Reply".into(),
            focused_text: "".into(),
            ax_html: Some("<doc>original email body that is long enough</doc>".into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        assert!(ctx["screen"]
            .as_str()
            .unwrap()
            .contains("original email body"));
    }

    #[test]
    fn format_includes_metadata_and_selection() {
        let s = WindowContextSnapshot {
            window_title: "Gmail".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://mail.google.com".into()),
            selected_text: Some("reply to this".into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        assert_eq!(ctx["app"], "chrome.exe");
        assert_eq!(ctx["url"], "https://mail.google.com");
        assert_eq!(ctx["window"], "Gmail");
        assert_eq!(ctx["selection"], "reply to this");
    }

    #[test]
    fn format_ide_marker() {
        let s = WindowContextSnapshot {
            app_exe: Some("code.exe".into()),
            ax_html: Some("<edit>useState</edit>".into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        assert_eq!(ctx["ide"], true);
    }

    #[test]
    fn caret_before_keeps_tail_after_keeps_head() {
        let before = format!("{}TAIL", "x".repeat(CARET_BEFORE_LLM_MAX));
        let after = format!("HEAD{}", "y".repeat(CARET_AFTER_LLM_MAX));
        let s = WindowContextSnapshot {
            element_name: "Body".into(),
            text_before: Some(before),
            text_after: Some(after),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        assert!(ctx["beforeCaret"].as_str().unwrap().contains("TAIL")); // before kept its tail
        assert!(ctx["afterCaret"].as_str().unwrap().contains("HEAD")); // after kept its head
    }

    #[test]
    fn long_gmail_reply_keeps_large_tail_as_valid_json() {
        let older = format!("{}older body that should be clipped\n", "x".repeat(12_000));
        let recent = "Alice: Can you confirm the Supernova v2 rollout timing?\nYou: ".repeat(520);
        let s = WindowContextSnapshot {
            window_title: "Supernova rollout - Gmail".into(),
            element_name: "Message Body".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://mail.google.com/mail/u/0/#inbox/thread-a".into()),
            text_before: Some(format!("{older}{recent}RECENT_TAIL")),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let before = ctx["beforeCaret"].as_str().unwrap();
        assert!(before.contains("RECENT_TAIL"));
        assert!(before.contains("Supernova v2"));
        assert!(before.chars().count() <= JSON_CARET_BEFORE_LLM_MAX);
        assert!(!before.starts_with('x'));
    }

    #[test]
    fn gmail_list_scrollback_is_removed_from_reply_context() {
        let s = WindowContextSnapshot {
            window_title: "Project Orion - Gmail".into(),
            element_name: "Message Body".into(),
            text_before: Some(
                [
                    "Inbox",
                    "Jane Sender",
                    "Your login code is 123456",
                    "Jun 2",
                    "Dev Team",
                    "Project Orion launch",
                    "Jun 5",
                    "Alice: We can ship if QA signs off.",
                    "Bob: QA is green on Windows.",
                    "You: ",
                ]
                .join("\n"),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let before = ctx["beforeCaret"].as_str().unwrap();
        assert!(before.contains("Alice: We can ship"));
        assert!(before.contains("Bob: QA is green"));
        assert!(!before.contains("123456"));
        assert!(!before.contains("Your login code"));
    }

    #[test]
    fn gmail_long_rendered_thread_keeps_big_context_chunk() {
        let mut messages = String::new();
        for i in 1..=12 {
            messages.push_str(&format!(
                r#"<item name="Sender {i}: Page-spanning Gmail message {i} about rollout blockers and next steps."/>"#
            ));
        }
        let s = WindowContextSnapshot {
            window_title: "Rollout thread - Gmail".into(),
            element_name: "Message Body".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://mail.google.com/mail/u/0/#inbox/thread-long".into()),
            ax_html: Some(format!(
                r#"
                <pane name="Gmail">
                  <list name="Inbox"><item name="Unrelated login code 654321"/></list>
                  <doc name="Rollout thread">
                    <list name="Messages">{messages}</list>
                    <edit name="Message Body" focus="1"></edit>
                  </doc>
                </pane>
                "#
            )),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        let kept_messages = screen.matches("Page-spanning Gmail message").count();
        assert!(kept_messages >= 10);
        assert!(screen.contains("Sender 12"));
        assert!(!screen.contains("654321"));
        assert!(!screen.contains("Unrelated login code"));
    }

    #[test]
    fn gmail_very_long_rendered_thread_keeps_recent_tail_near_reply() {
        let mut messages = String::new();
        let detail = " deployment-note".repeat(8);
        for i in 1..=100 {
            messages.push_str(&format!(
                r#"<item name="Sender {i}: Multi-page Gmail message {i} includes decisions, owners, blockers, dates, and the current ask for the reply.{detail}"/>"#
            ));
        }
        let s = WindowContextSnapshot {
            window_title: "Long rollout thread - Gmail".into(),
            element_name: "Message Body".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://mail.google.com/mail/u/0/#inbox/thread-very-long".into()),
            ax_html: Some(format!(
                r#"
                <pane name="Gmail">
                  <doc name="Long rollout thread">
                    <list name="Messages">{messages}</list>
                    <edit name="Message Body" focus="1"></edit>
                  </doc>
                </pane>
                "#
            )),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        let kept_messages = screen.matches("Multi-page Gmail message").count();
        assert!(kept_messages >= 40, "{kept_messages}: {screen}");
        assert!(screen.contains("Sender 100"), "{screen}");
        assert!(screen.contains("Sender 90"), "{screen}");
        assert!(!screen.contains("Sender 1: Multi-page"), "{screen}");
        assert!(screen.chars().count() <= JSON_MAX_LLM_CONTEXT_CHARS);
    }

    #[test]
    fn omnibox_focus_falls_back_to_page_content() {
        let s = WindowContextSnapshot {
            window_title: "Gmail - Google Chrome".into(),
            element_name: "Address and search bar".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://mail.google.com/mail/u/0/#inbox".into()),
            ax_html: Some(
                r#"
                <pane name="Chrome">
                  <edit name="Address and search bar" focus="1">mail.google.com</edit>
                  <doc name="Inbox">The newsletter content the user is reading and acting upon here.</doc>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("newsletter content"));
        assert!(!screen.contains("mail.google.com"));
    }

    #[test]
    fn discord_thread_keeps_multi_sender_message_context() {
        let s = WindowContextSnapshot {
            window_title: "Discord | #release".into(),
            element_name: "Message #release".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://discord.com/channels/1/2".into()),
            ax_html: Some(
                r#"
                <pane name="Discord">
                  <list name="Servers"><item name="General"/></list>
                  <list name="Messages">
                    <item name="علي: The Arabic sender should stay attributed."/>
                    <item name="Maya: The Windows build still needs signing."/>
                    <item name="Chris: I uploaded the cert bundle."/>
                    <item name="You: I will kick off the release after tests."/>
                    <edit name="Message #release" focus="1"></edit>
                  </list>
                  <list name="Members"><item name="Online 42"/></list>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("علي: The Arabic sender"));
        assert!(screen.contains("Maya: The Windows build"));
        assert!(screen.contains("Chris: I uploaded"));
        assert!(screen.contains("You: I will kick off"));
        assert!(!screen.contains("Online 42"));
    }

    #[test]
    fn discord_split_author_nodes_reconstruct_speaker_turns() {
        let s = WindowContextSnapshot {
            window_title: "#general | My Server - Discord".into(),
            element_name: "Message #general".into(),
            app_exe: Some("discord.exe".into()),
            ax_html: Some(
                r##"
                <window name="#general | My Server - Discord">
                  <group name="Channels"><tree name="Channels"><node name="general"># general</node></tree></group>
                  <group name="Messages">
                    <list name="Messages in general">
                      <item name="alice">
                        <text>alice</text>
                        <text>Today at 2:14 PM</text>
                        <text>can someone review the deploy script before we ship?</text>
                      </item>
                      <item name="bob">
                        <text>bob</text>
                        <text>Today at 2:16 PM</text>
                        <text>I looked at it earlier, the rollback step is missing a guard</text>
                      </item>
                    </list>
                    <group name="Message composer"><edit name="Message #general" focus="1"></edit></group>
                  </group>
                </window>
                "##
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("alice: can someone review"));
        assert!(screen.contains("bob: I looked at it earlier"), "{screen}");
        assert!(!screen.contains("Today at 2:14 PM"));
    }

    #[test]
    fn slack_split_author_nodes_reconstruct_speaker_turns() {
        let s = WindowContextSnapshot {
            window_title: "Slack | general (Channel) | Acme Workspace".into(),
            element_name: "Message to #general".into(),
            app_exe: Some("slack.exe".into()),
            ax_html: Some(
                r##"
                <window name="Slack | general (Channel) | Acme Workspace">
                  <tree name="Channels"><node name="# random"/><node name="# eng-standup"/></tree>
                  <pane name="general">
                    <list name="Messages">
                      <item>
                        <text name="Dana Lee">Dana Lee</text>
                        <text>11:02 AM</text>
                        <text>Can someone send the Q3 numbers before the 2pm sync?</text>
                      </item>
                      <item>
                        <text name="Sam Ortiz">Sam Ortiz</text>
                        <text>11:05 AM</text>
                        <text>I have them, finalizing the deck now.</text>
                      </item>
                    </list>
                    <group name="Message input"><edit name="Message to #general" focus="1"></edit></group>
                  </pane>
                </window>
                "##
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("Dana Lee: Can someone send"));
        assert!(screen.contains("Sam Ortiz: I have them"));
        assert!(!screen.contains("# random"));
        assert!(!screen.contains("11:02 AM"));
    }

    #[test]
    fn reference_fixture_matrix_keeps_more_app_context_shapes() {
        let teams = screen_text(WindowContextSnapshot {
            window_title: "Chat | Microsoft Teams".into(),
            element_name: "Type a message".into(),
            app_exe: Some("ms-teams.exe".into()),
            ax_html: Some(
                r#"
                <window name="Chat | Microsoft Teams">
                  <toolbar name="App bar"><tab name="Activity"/><tab name="Chat"/></toolbar>
                  <pane name="Chat list"><list name="Recent"><item name="Unrelated DM"/></list></pane>
                  <pane name="Conversation">
                    <list name="Messages">
                      <group name="Teammate, 9:14 AM"><text>Can you review the PR before standup? It touches the auth refactor.</text></group>
                      <group name="Teammate, 9:15 AM"><text>No rush if you're heads-down, just want it merged by EOD.</text></group>
                    </list>
                    <edit name="Type a message" focus="1"></edit>
                  </pane>
                </window>
                "#
                .into(),
            ),
            ..snap()
        });
        assert!(teams.contains("Teammate: Can you review the PR"), "{teams}");
        assert!(teams.contains("Teammate: No rush"), "{teams}");
        assert!(!teams.contains("Unrelated DM"));

        let telegram = screen_text(WindowContextSnapshot {
            window_title: "Telegram".into(),
            element_name: "Write a message".into(),
            app_exe: Some("telegram.exe".into()),
            ax_html: Some(
                r#"
                <window name="Telegram">
                  <pane name="Navigation"><list name="Chats"><item name="Saved Messages">You: meeting notes</item></list></pane>
                  <pane name="Alex Rivera">
                    <list name="Message list">
                      <item name="Alex Rivera"><text>Can you send over the Q3 deck before the 3pm sync?</text></item>
                      <item name="You"><text>yeah one sec</text></item>
                      <item name="Alex Rivera"><text>also did legal sign off on the pricing slide?</text></item>
                    </list>
                    <group name="Composer"><edit name="Write a message" focus="1"></edit></group>
                  </pane>
                </window>
                "#
                .into(),
            ),
            ..snap()
        });
        assert!(telegram.contains("Alex Rivera: Can you send"), "{telegram}");
        assert!(telegram.contains("You: yeah one sec"), "{telegram}");
        assert!(!telegram.contains("Saved Messages"));

        let whatsapp = screen_text(WindowContextSnapshot {
            window_title: "WhatsApp".into(),
            element_name: "Type a message".into(),
            app_exe: Some("whatsapp.exe".into()),
            ax_html: Some(
                r#"
                <window name="WhatsApp">
                  <pane name="Chat list"><list name="Chats"><item name="Mom. Did you eat? 8:15 AM"/></list></pane>
                  <pane name="Conversation">
                    <list name="Messages">
                      <group name="Sarah Chen">
                        <text>Hey, are we still on for the demo on Thursday?</text>
                        <text>I can move it to 2pm if that's easier for you.</text>
                      </group>
                      <group name="You"><text>Thursday works, let me confirm the room.</text></group>
                    </list>
                    <doc name="Type a message" focus="1"></doc>
                  </pane>
                </window>
                "#
                .into(),
            ),
            ..snap()
        });
        assert!(whatsapp.contains("Sarah Chen: Hey"), "{whatsapp}");
        assert!(whatsapp.contains("Sarah Chen: I can move"), "{whatsapp}");
        assert!(whatsapp.contains("You: Thursday works"), "{whatsapp}");
        assert!(!whatsapp.contains("Mom. Did you eat"));

        let github = screen_text(WindowContextSnapshot {
            window_title: "Issue: Crash on startup - GitHub".into(),
            element_name: "Comment body".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://github.com/acme/widget/issues/482".into()),
            ax_html: Some(
                r##"
                <window name="Issue: Crash on startup - GitHub">
                  <header name="Global"><link name="GitHub Home"/><edit name="Search or jump to"/></header>
                  <pane name="content">
                    <group name="issue header"><text>Crash on startup #482</text><text>Open</text></group>
                    <list name="Timeline">
                      <item name="comment"><group name="alice commented"><doc name="comment body">The app crashes on launch with "missing model.onnx".</doc></group></item>
                      <item name="comment"><group name="bob commented"><doc name="comment body">Can you attach the log from APPDATA?</doc></group></item>
                    </list>
                    <group name="add a comment"><edit name="Comment body" focus="1"></edit></group>
                  </pane>
                  <list name="metadata"><item><text>Labels</text><link name="bug"/></item></list>
                </window>
                "##
                .into(),
            ),
            ..snap()
        });
        assert!(github.contains("alice: The app crashes"), "{github}");
        assert!(github.contains("bob: Can you attach"), "{github}");
        assert!(!github.contains("GitHub Home"));
        assert!(!github.contains("comment body"));

        let instagram = screen_text(WindowContextSnapshot {
            window_title: "Instagram - Google Chrome".into(),
            element_name: "Message".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://instagram.com/direct/inbox".into()),
            ax_html: Some(
                r#"
                <window name="Instagram - Google Chrome">
                  <doc name="Instagram">
                    <pane name="Navigation"><link name="Home"/><link name="Messages"/></pane>
                    <list name="Conversations"><item name="mom - 3d">call me</item></list>
                    <list name="Messages">
                      <item><text name="alex_m">hey are we still on for saturday?</text></item>
                      <item><text name="alex_m">lmk what time works</text></item>
                      <item><text name="You">yeah! thinking around 2</text></item>
                    </list>
                    <group name="Composer"><edit name="Message" focus="1"></edit></group>
                  </doc>
                </window>
                "#
                .into(),
            ),
            ..snap()
        });
        assert!(
            instagram.contains("alex_m: hey are we still"),
            "{instagram}"
        );
        assert!(instagram.contains("You: yeah"), "{instagram}");
        assert!(!instagram.contains("mom - 3d"));

        let notion = screen_text(WindowContextSnapshot {
            window_title: "Q3 Planning - Notion".into(),
            element_name: "Empty paragraph".into(),
            app_exe: Some("notion.exe".into()),
            ax_html: Some(
                r#"
                <window name="Q3 Planning - Notion">
                  <pane name="sidebar"><tree name="Workspace"><node name="Meeting Notes"/></tree></pane>
                  <pane name="content">
                    <doc name="page">
                      <header name="title"><text>Q3 Planning</text></header>
                      <group name="block"><text>We need to ship the new onboarding flow before the quarter ends.</text></group>
                      <group name="block"><text>Open questions about staffing remain.</text></group>
                      <edit name="Empty paragraph" focus="1"></edit>
                    </doc>
                  </pane>
                </window>
                "#
                .into(),
            ),
            ..snap()
        });
        assert!(notion.contains("Q3 Planning"), "{notion}");
        assert!(notion.contains("new onboarding flow"), "{notion}");
        assert!(notion.contains("Open questions"), "{notion}");
        assert!(!notion.contains("Meeting Notes"));
    }

    #[test]
    fn same_display_name_chat_turns_keep_order_and_valid_json() {
        let s = WindowContextSnapshot {
            window_title: "Discord | #support".into(),
            element_name: "Message #support".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://discord.com/channels/1/3".into()),
            ax_html: Some(
                r#"
                <pane name="Discord">
                  <list name="Messages">
                    <item name="Alex: I can reproduce the crash on beta 4."/>
                    <item name="Alex: Different Alex here - I only see it after login."/>
                    <item name="You: Thanks, I will split the report by account."/>
                    <edit name="Message #support" focus="1"></edit>
                  </list>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        let first = screen.find("I can reproduce").unwrap();
        let second = screen.find("Different Alex").unwrap();
        assert!(first < second);
        assert!(screen.contains("You: Thanks"));
    }

    #[test]
    fn mixed_unicode_and_ascii_chat_items_keep_all_turns() {
        let s = WindowContextSnapshot {
            window_title: "Discord | #general".into(),
            element_name: "Message #general".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://discord.com/channels/1/2".into()),
            ax_html: Some(
                r#"
                <pane name="Discord">
                  <list name="Messages">
                    <item name="Maya: I can reproduce the reply-context issue."/>
                    <item name="علي: خلينا نثبت مشكلة السياق قبل الرد النهائي."/>
                    <item name="You: I will keep the reply scoped to the rendered thread."/>
                    <edit name="Message #general" focus="1"></edit>
                  </list>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("Maya: I can reproduce"));
        assert!(screen.contains("علي: خلينا"));
        assert!(screen.contains("You: I will keep"), "{screen}");
    }

    #[test]
    fn chat_system_noise_is_dropped_without_dropping_thread_words() {
        let s = WindowContextSnapshot {
            window_title: "Discord | #release".into(),
            element_name: "Message #release".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://discord.com/channels/1/2".into()),
            ax_html: Some(
                r#"
                <pane name="Discord">
                  <list name="Messages">
                    <item name="Alex joined the channel"/>
                    <item name="Maya reacted with thumbs up to Chris"/>
                    <item name="Maya: The thread wording must stay in the real message."/>
                    <item name="You: Inbox cleanup is the actual topic for the reply."/>
                    <edit name="Message #release" focus="1"></edit>
                  </list>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("Maya: The thread wording"));
        assert!(screen.contains("You: Inbox cleanup"));
        assert!(!screen.contains("joined the channel"));
        assert!(!screen.contains("reacted with"));
    }

    #[test]
    fn facebook_engagement_counts_are_dropped_from_feed_context() {
        let s = WindowContextSnapshot {
            window_title: "Facebook".into(),
            element_name: "Write a comment".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://www.facebook.com/".into()),
            ax_html: Some(
                r#"
                <pane name="Facebook">
                  <article name="Post by Nina">
                    <item name="Nina: The prototype demo is tomorrow."/>
                    <item name="12 comments"/>
                    <item name="34 likes"/>
                    <item name="Share"/>
                    <item name="Omar: I can review the deck tonight."/>
                    <edit name="Write a comment" focus="1"></edit>
                  </article>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("Nina: The prototype"));
        assert!(screen.contains("Omar: I can review"));
        assert!(!screen.contains("12 comments"));
        assert!(!screen.contains("34 likes"));
        assert!(!screen.contains("Share"));
    }

    #[test]
    fn rtl_and_cjk_context_survives_denoise() {
        let s = WindowContextSnapshot {
            window_title: "Messenger".into(),
            element_name: "Message".into(),
            focused_text: "مرحبا يا علي\n你好，明天见\n\u{fffc}\u{2726}".into(),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let field = ctx["fieldText"].as_str().unwrap();
        assert!(field.contains("مرحبا يا علي"));
        assert!(field.contains("你好，明天见"));
        assert!(!field.contains('\u{fffc}'));
    }

    #[test]
    fn facebook_messenger_keeps_chat_and_drops_nav() {
        let s = WindowContextSnapshot {
            window_title: "Messenger".into(),
            element_name: "Message".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://www.facebook.com/messages/t/123".into()),
            ax_html: Some(
                r#"
                <pane name="Messenger">
                  <list name="Chats"><item name="Dad"/></list>
                  <group name="Conversation with Dana">
                    <item name="Dana: Are we still meeting at 4 PM?"/>
                    <item name="You: Yes, I can bring the notes."/>
                    <item name="Dana: Please send the room number too."/>
                    <edit name="Message" focus="1"></edit>
                  </group>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("Dana: Are we still meeting"));
        assert!(screen.contains("You: Yes"));
        assert!(screen.contains("Dana: Please send"));
        assert!(!screen.contains("Dad"));
    }

    #[test]
    fn messenger_item_name_with_inline_body_reconstructs_speaker_turns() {
        let s = WindowContextSnapshot {
            window_title: "Messenger".into(),
            element_name: "Message".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://www.messenger.com/t/100087".into()),
            ax_html: Some(
                r#"
                <doc name="Messenger">
                  <group name="Message thread">
                    <list name="Messages in conversation with Maya Chen">
                      <item name="Maya Chen">Hey, are we still on for Friday's standup?</item>
                      <item name="Maya Chen">I can move it to 10 if that works better for you.</item>
                      <item name="You">let me check my calendar</item>
                      <item name="Maya Chen">No rush! Just let me know by tonight.</item>
                    </list>
                    <edit name="Message" focus="1"></edit>
                  </group>
                </doc>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(
            screen.contains("Maya Chen: Hey, are we still on"),
            "{screen}"
        );
        assert!(screen.contains("You: let me check my calendar"), "{screen}");
        assert!(screen.contains("Maya Chen: No rush"), "{screen}");
    }

    #[test]
    fn zoom_timestamped_groups_reconstruct_speaker_turns() {
        let s = WindowContextSnapshot {
            window_title: "Zoom Meeting".into(),
            element_name: "Type message here...".into(),
            app_exe: Some("zoom.exe".into()),
            ax_html: Some(
                r#"
                <pane name="Chat">
                  <list name="Chat Messages">
                    <group name="Alex Rivera 10:02 AM">
                      <text>Can you send me the Q3 numbers before we wrap up?</text>
                    </group>
                    <group name="Priya Shah 10:03 AM">
                      <text>I have the deck open, sharing now.</text>
                    </group>
                    <group name="Alex Rivera 10:04 AM">
                      <text>Thanks. Also who owns the migration timeline?</text>
                    </group>
                  </list>
                  <edit name="Type message here..." focus="1"></edit>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("Alex Rivera: Can you send"), "{screen}");
        assert!(screen.contains("Priya Shah: I have the deck"), "{screen}");
        assert!(screen.contains("Alex Rivera: Thanks"), "{screen}");
        assert!(!screen.contains("10:02 AM:"));
    }

    #[test]
    fn facebook_main_bubble_keeps_feed_comment_thread() {
        let s = WindowContextSnapshot {
            window_title: "Facebook".into(),
            element_name: "Write a comment".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://www.facebook.com/".into()),
            ax_html: Some(
                r#"
                <pane name="Facebook">
                  <group name="Navigation"><item name="Home"/><item name="Friends"/></group>
                  <article name="Post by Nina">
                    <item name="Nina: The prototype demo is tomorrow."/>
                    <item name="Omar: I can review the deck tonight."/>
                    <item name="You: I added the metrics slide."/>
                    <edit name="Write a comment" focus="1"></edit>
                  </article>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("Nina: The prototype"));
        assert!(screen.contains("Omar: I can review"));
        assert!(screen.contains("You: I added"));
        assert!(!screen.contains("Friends"));
    }

    #[test]
    fn slack_channel_keeps_messages_and_drops_workspace_chrome() {
        let s = WindowContextSnapshot {
            window_title: "Slack | #launch".into(),
            element_name: "Message #launch".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://app.slack.com/client/T123/C456".into()),
            ax_html: Some(
                r##"
                <pane name="Slack">
                  <list name="Workspaces"><item name="Acme Internal"/></list>
                  <list name="Channels"><item name="#random"/><item name="#sales"/></list>
                  <group name="Conversation in #launch">
                    <list name="Messages">
                      <item name="Priya: The release note needs the Linux caveat."/>
                      <item name="Marco: I can add it after QA signs off."/>
                      <item name="You: Please keep the customer-impact line."/>
                      <edit name="Message #launch" focus="1"></edit>
                    </list>
                  </group>
                </pane>
                "##
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("Priya: The release note"));
        assert!(screen.contains("Marco: I can add"));
        assert!(screen.contains("You: Please keep"));
        assert!(!screen.contains("#random"));
        assert!(!screen.contains("Acme Internal"));
    }

    #[test]
    fn codex_chat_keeps_active_thread_and_drops_recent_threads() {
        let s = WindowContextSnapshot {
            window_title: "Codex".into(),
            element_name: "Ask Codex".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://chatgpt.com/codex".into()),
            ax_html: Some(
                r#"
                <pane name="Codex">
                  <list name="Recent threads">
                    <item name="Old billing investigation"/>
                    <item name="Unrelated private task"/>
                  </list>
                  <group name="Conversation">
                    <item name="User: Please update the context parser."/>
                    <item name="Codex: I found the malformed JSON edge case."/>
                    <item name="User: Add a regression before continuing."/>
                    <edit name="Ask Codex" focus="1"></edit>
                  </group>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("User: Please update"));
        assert!(screen.contains("Codex: I found"));
        assert!(screen.contains("User: Add a regression"));
        assert!(!screen.contains("Old billing"));
        assert!(!screen.contains("Unrelated private"));
    }

    #[test]
    fn claude_chat_keeps_dialog_and_drops_project_sidebar() {
        let s = WindowContextSnapshot {
            window_title: "Claude".into(),
            element_name: "Message Claude".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://claude.ai/chat/123".into()),
            ax_html: Some(
                r#"
                <pane name="Claude">
                  <list name="Projects"><item name="Hiring docs"/><item name="Personal notes"/></list>
                  <group name="Conversation">
                    <item name="User: Can you summarize the error report?"/>
                    <item name="Claude: The failing component is the context sidecar."/>
                    <item name="User: Draft the follow-up with the workaround."/>
                    <edit name="Message Claude" focus="1"></edit>
                  </group>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("User: Can you summarize"));
        assert!(screen.contains("Claude: The failing"));
        assert!(screen.contains("User: Draft the follow-up"));
        assert!(!screen.contains("Hiring docs"));
        assert!(!screen.contains("Personal notes"));
    }

    #[test]
    fn canvas_surface_uses_ocr_not_raw_ax_tree() {
        let s = WindowContextSnapshot {
            window_title: "Design".into(),
            element_name: "Canvas".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://www.figma.com/file/abc".into()),
            ax_html: Some("<doc>unhelpful canvas internals</doc>".into()),
            ocr_text: Some("Frame title\nPrimary action copy".into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        assert!(ctx.get("screen").is_none());
        assert_eq!(ctx["screenOcr"], "Frame title\nPrimary action copy");
    }

    // ── fake reader integration ──

    #[test]
    fn browser_tab_strip_titles_do_not_leak_into_page_context() {
        let s = WindowContextSnapshot {
            window_title: "Video - YouTube - Google Chrome".into(),
            element_name: "Search".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://www.youtube.com/watch?v=123".into()),
            ax_html: Some(
                r#"
                <window name="Video - YouTube - Google Chrome">
                  <toolbar name="Toolbar">
                    <button name="Back"/>
                    <edit name="Address and search bar">youtube.com/watch?v=123</edit>
                  </toolbar>
                  <tabs name="Tab strip">
                    <tab name="ChatGPT - Part of group pins"/>
                    <tab name="New chat - Claude - Part of group pins"/>
                    <tab name="Inbox (2,677) - private.sender@gmail.com - Gmail - Part of group social"/>
                    <tab name="Facebook - Part of group social"/>
                  </tabs>
                  <doc name="YouTube">
                    <group name="Main content">
                      <item name="Chess analysis: queen sacrifice at move 17"/>
                      <item name="Comment by Alex: The bishop pin was missed."/>
                      <edit name="Search" focus="1"></edit>
                    </group>
                  </doc>
                </window>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap();
        assert!(screen.contains("Chess analysis"));
        assert!(screen.contains("Comment by Alex"));
        assert!(!screen.contains("private.sender"));
        assert!(!screen.contains("Gmail"));
        assert!(!screen.contains("Facebook"));
        assert!(!screen.contains("Claude"));
        assert!(!screen.contains("ChatGPT"));
    }

    // ── A1/A2: page-spanning caret reroutes to the pruned tree ──

    // Gmail inline reply: the composer's UIA TextPattern range spans the whole
    // page, so text_before is "rich" but full of left-nav + inbox rows + an OTP
    // email that lives in OTHER inbox rows (not the open email). With an ax_html
    // tree present, the formatter must route to the pruned `screen` and NOT leak
    // the inbox/OTP via beforeCaret. (Real Gmail leak shape from the artifact.)
    #[test]
    fn gmail_page_spanning_caret_reroutes_to_clean_screen_no_inbox_or_otp() {
        let before = [
            "Compose",
            "Inbox 2,677",
            "Snoozed",
            "Sent",
            "Drafts",
            "Promotions 25,370",
            "Amazon.sa",
            "Delivered: 1 item Order # 405-1234567",
            "May 13",
            "Google",
            "Your Google verification code is 622297",
            "May 13",
            "Qiwa",
            "One time password 7596",
            "Jun 9",
            "Kiwi.com",
            "Thinking of adding travel insurance to your trip?",
            "to me",
            "Show details",
            "Hi Mostafa, your upcoming trip to Rome is in two weeks.",
            "We noticed you have not added travel insurance yet.",
        ]
        .join("\n");
        let s = WindowContextSnapshot {
            window_title: "Thinking of adding travel insurance - Gmail".into(),
            element_name: "Message Body".into(),
            app_exe: Some("chrome.exe".into()),
            // url is EMPTY for Chrome captures — detection must not rely on it.
            text_before: Some(before),
            ax_html: Some(
                r#"
                <pane name="Gmail">
                  <list name="Mailbox"><item name="Compose"/><item name="Inbox 2,677"/><item name="Snoozed"/></list>
                  <list name="Inbox">
                    <item name="Amazon.sa: Delivered: 1 item Order # 405-1234567"/>
                    <item name="Google: Your Google verification code is 622297"/>
                    <item name="Qiwa: One time password 7596"/>
                  </list>
                  <doc name="Thinking of adding travel insurance">
                    <group name="Kiwi.com email">
                      <text>Hi Mostafa, your upcoming trip to Rome is in two weeks.</text>
                      <text>We noticed you have not added travel insurance yet.</text>
                    </group>
                    <edit name="Message Body" focus="1"></edit>
                  </doc>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap_or("");
        // the open email body survives
        assert!(screen.contains("upcoming trip to Rome"), "{screen}");
        // inbox rows + OTP codes are structurally gone, and beforeCaret (the
        // polluted blob) must not be emitted at all
        assert!(ctx.get("beforeCaret").is_none(), "{out}");
        assert!(!out.contains("622297"), "OTP leaked: {out}");
        assert!(!out.contains("7596"), "OTP leaked: {out}");
        assert!(!out.contains("Amazon.sa"), "inbox row leaked: {out}");
        assert!(!out.contains("25,370"), "nav counter leaked: {out}");
    }

    // X reply: the composer TextPattern range spans the whole article, so
    // text_before is "rich" but leaks the nav rail, the user's own identity, and
    // engagement counts (232.9K / Views / 41 / Show translation). With a tree
    // present, the formatter reroutes to the pruned conversation `screen`.
    #[test]
    fn x_reply_page_spanning_caret_reroutes_clean_screen_drops_nav_and_counts() {
        let before = [
            "Home",
            "Explore",
            "Notifications",
            "Bookmarks",
            "Mostafa",
            "@Dahshury",
            "Post",
            "Conversation",
            "Saker",
            "@SakerSport",
            "Everyone thought Brazil was the team playing in red yesterday.",
            "232.9K",
            "Views",
            "Show translation",
            "Replying to @SakerSport",
            "Thamer",
            "@Dexcris17",
            "What hurts is after all those touches there is no finish.",
            "41",
            "82",
            "Post your reply",
        ]
        .join("\n");
        let s = WindowContextSnapshot {
            window_title: "Saker on X: \"Everyone thought...\" / X".into(),
            element_name: "Post text".into(),
            app_exe: Some("chrome.exe".into()),
            text_before: Some(before),
            // Realistic X shape: nav rail + self-identity live in chrome regions
            // (banner / nav list) that json_drop_subtree_role + json_is_nav_chrome
            // strip; the conversation is a content-list inside the article doc.
            ax_html: Some(
                r#"
                <pane name="X">
                  <banner name="Top bar"><text>Mostafa</text><text>@Dahshury</text></banner>
                  <list name="Primary"><link name="Home"/><link name="Explore"/><link name="Notifications"/></list>
                  <doc name="Conversation">
                    <list name="Timeline: Conversation">
                      <item name="Saker: Everyone thought Brazil was the team playing in red yesterday."/>
                      <item name="Thamer: What hurts is after all those touches there is no finish."/>
                    </list>
                    <edit name="Post text" focus="1"></edit>
                  </doc>
                  <list name="Who to follow"><item name="Suggested account"/></list>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap_or("");
        assert!(screen.contains("Saker: Everyone thought Brazil"), "{screen}");
        assert!(screen.contains("Thamer: What hurts"), "{screen}");
        // beforeCaret with nav/counts must be gone
        assert!(ctx.get("beforeCaret").is_none(), "{out}");
        assert!(!out.contains("232.9K"), "engagement count leaked: {out}");
        assert!(!out.contains("Show translation"), "chrome leaked: {out}");
        assert!(!out.contains("@Dahshury"), "self identity leaked: {out}");
        assert!(!screen.contains("Who to follow"), "right column leaked: {screen}");
    }

    // A short, real typed draft with NO nav markers keeps the fast beforeCaret
    // path (does NOT get rerouted to the tree even though a tree exists).
    #[test]
    fn short_typed_draft_keeps_before_caret_path() {
        let s = WindowContextSnapshot {
            window_title: "Compose - Gmail".into(),
            element_name: "Message Body".into(),
            app_exe: Some("chrome.exe".into()),
            text_before: Some(
                "Hi team, just confirming the rollout window is still Friday at noon.".into(),
            ),
            ax_html: Some("<doc>some page chrome here for reference</doc>".into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        assert!(
            ctx["beforeCaret"]
                .as_str()
                .unwrap_or("")
                .contains("rollout window is still Friday"),
            "{out}"
        );
        assert!(ctx.get("screen").is_none(), "{out}");
    }

    // ── B1: X compose (no thread) emits the thin draft shape, not the feed ──

    #[test]
    fn x_compose_emits_thin_field_text_not_timeline_feed() {
        let s = WindowContextSnapshot {
            window_title: "Home / X - Google Chrome".into(),
            element_name: "Post text".into(),
            app_exe: Some("chrome.exe".into()),
            focused_text: "so excited to finally ship the new dictation context feature".into(),
            ax_html: Some(
                r#"
                <pane name="X">
                  <list name="Primary"><link name="Home"/><link name="Explore"/></list>
                  <doc name="Home timeline">
                    <list name="Timeline: Your Home Timeline">
                      <item name="Someone: a random post on the home feed about lunch"/>
                      <item name="Bitget TradFi Ad"/>
                      <item name="Another: yet another unrelated home feed post"/>
                    </list>
                  </doc>
                  <group name="Composer"><edit name="Post text" focus="1"></edit></group>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        // thin shape: the draft is present, the feed is NOT dumped as screen
        assert!(
            ctx["fieldText"]
                .as_str()
                .unwrap_or("")
                .contains("ship the new dictation context feature"),
            "{out}"
        );
        assert!(ctx.get("screen").is_none(), "feed dumped on compose: {out}");
        assert!(!out.contains("random post on the home feed"), "{out}");
        assert!(!out.contains("Bitget TradFi Ad"), "{out}");
    }

    // ── A5: standalone 'Ad' / '<account> Ad' promoted blocks are dropped ──

    #[test]
    fn x_promoted_ad_block_is_dropped_from_thread_context() {
        let s = WindowContextSnapshot {
            window_title: "Saker on X / X".into(),
            element_name: "Post text".into(),
            app_exe: Some("chrome.exe".into()),
            ax_html: Some(
                r#"
                <pane name="X">
                  <doc name="Conversation">
                    <list name="Timeline: Conversation">
                      <item name="Saker: The original tweet text that should be kept."/>
                      <item name="Bitget TradFi Ad"/>
                      <item name="Ad"/>
                      <item name="Thamer: A genuine reply that must survive."/>
                      <edit name="Post text" focus="1"></edit>
                    </list>
                  </doc>
                </pane>
                "#
                .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap_or("");
        assert!(screen.contains("Saker: The original tweet"), "{screen}");
        assert!(screen.contains("Thamer: A genuine reply"), "{screen}");
        assert!(!screen.contains("Bitget TradFi Ad"), "{screen}");
        assert!(
            !screen.lines().any(|l| l.trim() == "Ad"),
            "bare Ad line leaked: {screen}"
        );
    }

    // ── D4: Messenger left-rail search box is treated as an omnibox ──

    #[test]
    fn messenger_search_box_is_not_picked_as_field_content() {
        let node = JsonAxNode {
            children: Vec::new(),
            focused: false,
            name: "Search Messenger".to_string(),
            role: "edit".to_string(),
            text: String::new(),
        };
        assert!(json_is_omnibox(&node));
    }

    // ── REAL-CAPTURE shapes: flat-stream speaker attribution ──────────────
    //
    // The following fixtures are lightly-truncated excerpts of ACTUAL Chrome UIA
    // captures (artifacts/context-cdp/*/rawSnapshot.json). They exercise the flat
    // beforeCaret / page-spanning-doc shapes that the synthetic <item> fixtures
    // above do NOT cover, and which were producing wrong attribution.

    // Discord DM: the focused composer's `textBefore` is a flat newline stream of
    // `author / [Server Tag: CLAN] / timestamp / full-datetime / body` rows, with
    // same-author continuations marked by a bare clock line. The reconstruction
    // must (a) attribute each body to its real author header (Fancy / Master),
    // (b) DROP the "Server Tag: W00T"/"Server Tag: CCO" badge lines (the prior bug
    // attributed those as speakers), and (c) carry the author across continuations.
    #[test]
    fn discord_real_flat_stream_attributes_authors_and_drops_server_tag() {
        let text_before = "\
Fancy chat
June 11, 2026
Fancy
6/11/26, 2:07 PM
Thursday, June 11, 2026 at 2:07 PM
Feeh 7agat htt3ml fel nos ofcourse
Master
Server Tag: W00T
6/11/26, 2:07 PM
Thursday, June 11, 2026 at 2:07 PM
can we talk a little
Fancy
6/11/26, 2:07 PM
Thursday, June 11, 2026 at 2:07 PM
Yeah sure
Master
Server Tag: W00T
6/11/26, 11:56 PM
Thursday, June 11, 2026 at 11:56 PM
Did you do whatever you wanted to do before pushing
11:57 PM
Thursday, June 11, 2026 at 11:57 PM
Can I test";
        let s = WindowContextSnapshot {
            window_title: "(1153) Discord | @Fancy - Google Chrome".into(),
            element_name: "Message @Fancy".into(),
            app_exe: Some("chrome.exe".into()),
            text_before: Some(text_before.into()),
            ax_html: Some("<window name=\"Discord\"><edit name=\"Message @Fancy\" focus=\"1\"/></window>".into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let before = ctx["beforeCaret"].as_str().unwrap_or("");
        assert!(
            before.contains("Fancy: Feeh 7agat htt3ml fel nos ofcourse"),
            "{before}"
        );
        assert!(before.contains("Master: can we talk a little"), "{before}");
        assert!(before.contains("Fancy: Yeah sure"), "{before}");
        // continuation line keeps the Master author across the bare clock line
        assert!(before.contains("Master: Can I test"), "{before}");
        // the Server Tag badge is NOT a speaker and must be gone entirely
        assert!(!out.contains("Server Tag"), "server tag leaked: {out}");
        // and the datetime rows must not appear as bodies
        assert!(!before.contains("Thursday, June 11"), "{before}");
        // two distinct real authors are attributed (multi-speaker correct)
        let speakers = before
            .lines()
            .filter_map(|l| l.split_once(": ").map(|(a, _)| a))
            .filter(|a| *a == "Fancy" || *a == "Master")
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(speakers.len(), 2, "{before}");
    }

    // A real typed Discord draft (short, no timestamp grouping) must NOT be
    // mangled by the stream reconstructor — it stays on the plain beforeCaret path.
    #[test]
    fn discord_short_typed_draft_is_not_reconstructed() {
        let s = WindowContextSnapshot {
            window_title: "Discord | @Fancy".into(),
            element_name: "Message @Fancy".into(),
            app_exe: Some("chrome.exe".into()),
            text_before: Some(
                "hey can you take a look at the deploy script before we ship it tonight".into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        assert!(
            ctx["beforeCaret"]
                .as_str()
                .unwrap_or("")
                .contains("deploy script before we ship"),
            "{out}"
        );
    }

    // Messenger (facebook.com/messages): the conversation is a single flat `<doc>`
    // TextPattern blob that embeds authorship as `… Message sent <when> by
    // <Author>: <body>`. Reconstruction must attribute each segment to the author
    // after "by", and must NOT false-match the scripture "قوله تعالى:" as a speaker.
    #[test]
    fn messenger_real_by_author_blob_attributes_authors() {
        let s = WindowContextSnapshot {
            window_title: "Messenger | Facebook - Google Chrome".into(),
            element_name: "Write to موه".into(),
            app_exe: Some("chrome.exe".into()),
            ax_html: Some(
                "<window name=\"Messenger | Facebook - Google Chrome\">\
                 <doc name=\"Messenger | Facebook\">Conversation titled موه \
                 Enter, Message sent Saturday 5:14am by سول: السلام عليكم \
                 Enter, Message sent Saturday 8:15am by موه: وعليكم السلام ورحمة الله \
                 Enter, Message sent Saturday 8:18am by موه: قوله تعالى: ماتعبدون من بعدي</doc>\
                 <edit name=\"Write to موه\" focus=\"1\"></edit></window>"
                    .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap_or("");
        assert!(screen.contains("سول: السلام عليكم"), "{screen}");
        assert!(screen.contains("موه: وعليكم السلام"), "{screen}");
        // the scripture colon must NOT be picked as a separate speaker
        assert!(
            !screen.lines().any(|l| l.trim_start().starts_with("قوله تعالى:")),
            "scripture matched as speaker: {screen}"
        );
    }

    // X reply: the conversation lives in a single flat `<doc>` blob with no
    // `Author:` prefixes — each tweet is `<DisplayName> @handle [time] <body>`.
    // Reconstruction must attribute the original tweet to its author handle and
    // drop the logged-in user's own top-bar identity + the "The short reason:"
    // sentence-colon false positive.
    #[test]
    fn x_real_flat_conversation_attributes_tweet_author() {
        let doc = "To view keyboard shortcuts Home Explore Notifications Post \
            Mostafa @Dahshury Post Conversation Andrew Trask @iamtrask This is a bigger deal \
            than it seems. The short reason: combinations of models will always outperform \
            individual models. More in article below Quote OpenRouter @OpenRouter 20h \
            Introducing the Fusion API 7:59 AM Replying to @iamtrask Post your reply \
            Delta, Dirac @DeltaClimbs 8h A neat thing about AI is that it gradually teaches people";
        // Real shape: the X reply page exposes ONE <doc> whose flat TextPattern
        // text is the whole conversation; the composer carries no focus marker in
        // the captured tree (verified against artifacts/context-cdp/x-reply).
        let s = WindowContextSnapshot {
            window_title: "Andrew Trask on X / X - Google Chrome".into(),
            element_name: "Post text".into(),
            app_exe: Some("chrome.exe".into()),
            ax_html: Some(format!(
                "<window name=\"Andrew Trask on X / X\">\
                 <doc name=\"Andrew Trask on X\">{doc}</doc></window>"
            )),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        let screen = ctx["screen"].as_str().unwrap_or("");
        // the original tweet is attributed to its real author (display name) — the
        // `DisplayName: body` form matches the speaker-prefix contract.
        assert!(
            screen.contains("Andrew Trask: This is a bigger deal"),
            "{screen}"
        );
        // a second distinct author is attributed (the comma-suffix is normalized
        // off, so 'Delta, Dirac' becomes 'Delta')
        assert!(screen.contains("Delta: "), "{screen}");
        // the logged-in user's own identity is NOT emitted as a turn
        assert!(
            !screen.lines().any(|l| l.starts_with("Mostafa:")),
            "self identity leaked as a turn: {screen}"
        );
        // 'The short reason:' must NOT be treated as a speaker turn (it can appear
        // INSIDE the tweet body, but never as a line prefix)
        assert!(
            !screen.lines().any(|l| l.trim_start().starts_with("The short reason:")),
            "sentence-colon matched as speaker: {screen}"
        );
        // the 'Replying to @x' marker is not attributed as an author
        assert!(
            !screen.lines().any(|l| l.starts_with("Replying to:")),
            "replying-to marker leaked as a speaker: {screen}"
        );
    }

    // WhatsApp Web's composer caret TextPattern range spans the chat-LIST rail,
    // not the open conversation — so its beforeCaret is the roster of contacts +
    // previews (incl. a delivery/OTP 6-digit code). The Discord stream
    // reconstructor must NOT fabricate "Contact: preview" turns from it, and the
    // formatter must NOT leak the list (or its codes) through beforeCaret. (Real
    // shape from artifacts/context-cdp/whatsapp.)
    #[test]
    fn whatsapp_chat_list_pane_is_not_attributed_and_does_not_leak() {
        let chat_list = "\
Chats 2 Status Updates in Status Channels Communities
Search or start a new chat
All Unread Favorites Groups
Cousin Omar
5:08 PM
Turing intelligence test passed
Muted chat
Bosta
برجاء إظهار الكود 3005137 مندوب بوسطة وصل عندك
1 unread message
Momen
2 unread messages
Archived";
        // chat-list guard fires on the flat stream
        assert!(json_text_is_chat_list_pane(chat_list));
        assert!(json_reconstruct_discord_stream(chat_list).is_none());
        let s = WindowContextSnapshot {
            window_title: "(2) WhatsApp - Google Chrome".into(),
            element_name: "Type a message to Cousin Omar".into(),
            app_exe: Some("chrome.exe".into()),
            text_before: Some(chat_list.into()),
            ax_html: Some("<window name=\"WhatsApp\"><doc name=\"WhatsApp\">chat list pane only</doc></window>".into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        // no fabricated 'Cousin Omar:' speaker turn, and the delivery code is gone
        assert!(!out.contains("Cousin Omar:"), "fabricated chat-list speaker: {out}");
        assert!(!out.contains("3005137"), "delivery/OTP code leaked: {out}");
    }

    // The false-speaker filter is uniform: 'Server Tag: X', sentence fragments and
    // scripture colons are never counted as speaker turns by the central gate.
    #[test]
    fn false_speaker_prefixes_are_rejected() {
        assert!(json_is_speaker_turn_line("Fancy: hey there"));
        assert!(json_is_speaker_turn_line("You: sure"));
        assert!(json_is_speaker_turn_line("Alex Rivera: can you review"));
        assert!(!json_is_speaker_turn_line("Server Tag: W00T"));
        assert!(!json_is_speaker_turn_line("The short reason: combinations win"));
        assert!(!json_is_speaker_turn_line("Replying to: @someone"));
        assert!(!json_is_speaker_turn_line("قوله تعالى: ماتعبدون"));
    }

    struct FakeReader(WindowContextSnapshot);
    impl ContextReader for FakeReader {
        fn read(&self, _mode: ContextMode) -> WindowContextSnapshot {
            self.0.clone()
        }
    }

    #[test]
    fn capture_redacts_denied_app() {
        let reader = FakeReader(WindowContextSnapshot {
            window_title: "Vault".into(),
            focused_text: "master password".into(),
            app_exe: Some("1password.exe".into()),
            ..snap()
        });
        let out = capture_prompt_fragment(
            &reader,
            ContextMode::Tree,
            ContextAppMode::AllExceptDenied,
            &["1password.exe".into()],
            &[],
        );
        assert!(!out.contains("master password"));
        let ctx = context_json(&out);
        assert_eq!(ctx["window"], "Vault");
    }

    #[test]
    fn mode_flags() {
        assert_eq!(ContextMode::Focused.flag(), None);
        assert_eq!(ContextMode::Selection.flag(), Some("--selection"));
        assert_eq!(ContextMode::Split.flag(), Some("--split"));
        assert_eq!(ContextMode::Tree.flag(), Some("--tree"));
    }
}
