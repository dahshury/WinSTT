// Source: frontend/electron/native/src/winstt-context.c
// + frontend/electron/lib/context-reader.ts + frontend/electron/lib/context-snapshot.ts
//
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

/// Cap on raw stdout bytes from the sidecar (axHtml can reach ~600KB after
/// JSON escaping). Mirrors MAX_BUFFER_BYTES.
pub const MAX_BUFFER_BYTES: usize = 1024 * 1024;

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

// ── sidecar spawn sketch (DRAFT — wire during compile loop) ────────────
//
// Two viable transports — pick during the compile loop:
//
// (A) tauri-plugin-shell sidecar (preferred — Tauri resolves the bundled
//     target-triple path for you):
//   use tauri_plugin_shell::ShellExt;
//   let mut cmd = app.shell().sidecar("winstt-context")
//       .map_err(|e| e.to_string())?;
//   if let Some(flag) = mode.flag() { cmd = cmd.arg(flag); }
//   let output = tokio::time::timeout(
//       Duration::from_millis(READ_TIMEOUT_MS),
//       cmd.output(),
//   ).await.map_err(|_| "context sidecar timed out")?
//    .map_err(|e| e.to_string())?;
//   Ok(parse_snapshot(&String::from_utf8_lossy(&output.stdout)))
//
// (B) std::process::Command (matches how Handy already shells out for
//     clamshell/audio — no extra plugin):
//   #[cfg(windows)] {
//     let bin = resolve_sidecar_path(app)?;        // resource dir, then dev path
//     let mut c = std::process::Command::new(bin);
//     if let Some(flag) = mode.flag() { c.arg(flag); }
//     c.creation_flags(CREATE_NO_WINDOW);          // windowsHide
//     // spawn + wait with a watchdog thread that kills on READ_TIMEOUT_MS,
//     // bounded read of stdout to MAX_BUFFER_BYTES.
//   }
//   #[cfg(not(windows))] { Ok(empty_context()) }    // non-Windows ⇒ empty
//
// resolve_sidecar_path(app):
//   packaged: app.path().resource_dir()?.join("binaries/winstt-context.exe")
//   dev:      <repo>/frontend/electron/native/bin/winstt-context.exe (reuse
//             the already-built binary; or copy into src-tauri/binaries/ with
//             the target-triple suffix Tauri's externalBin expects).
//
// ALWAYS resolves to a snapshot — never propagate an error past this layer.
// An empty snapshot just means "no extra hint"; the LLM cleanup degrades
// cleanly (same contract as readWindowContext in context-reader.ts).

/// Public reader trait so the manager can inject a fake sidecar in tests.
/// The production impl is one of the sketches above.
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
        "idea", "pycharm", "webstorm", "rubymine", "clion", "goland", "rustrover", "rider",
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
const CARET_BEFORE_LLM_MAX: usize = 6000;
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
        assert!(out.contains("Terminal/console focused"));
        assert!(!out.contains("before the caret"));
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
        assert!(out.contains("before the caret"));
        // tree dropped when focused field is rich
        assert!(!out.contains("Visible UI (XML"));
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
        assert!(out.contains("Visible UI (XML"));
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
        assert!(out.contains("App: chrome.exe"));
        assert!(out.contains("URL: https://mail.google.com"));
        assert!(out.contains("Window: Gmail"));
        assert!(out.contains("Selected text"));
        assert!(out.contains("reply to this"));
    }

    #[test]
    fn format_ide_marker() {
        let s = WindowContextSnapshot {
            app_exe: Some("code.exe".into()),
            ax_html: Some("<edit>useState</edit>".into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        assert!(out.contains("IDE context: yes (treat visible content as code)"));
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
        assert!(out.contains("TAIL")); // before kept its tail
        assert!(out.contains("HEAD")); // after kept its head
    }

    // ── fake reader integration ──

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
        assert!(out.contains("Window: Vault"));
    }

    #[test]
    fn mode_flags() {
        assert_eq!(ContextMode::Focused.flag(), None);
        assert_eq!(ContextMode::Selection.flag(), Some("--selection"));
        assert_eq!(ContextMode::Split.flag(), Some("--split"));
        assert_eq!(ContextMode::Tree.flag(), Some("--tree"));
    }
}
