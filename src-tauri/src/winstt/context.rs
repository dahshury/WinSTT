// Context-awareness for the dictation cleanup path. ZERO reimplementation of
// the UIA reader — `winstt-context.exe` (the existing C binary) ships as a
// Tauri SIDECAR (externalBin) and is invoked
// per dictation via std::process::Command. This module:
//
//   1. Resolves + spawns the sidecar with the right mode flag
//      (--selection / --split / --tree), with the same hard timeout as the
//      sidecar wrapper (READ_TIMEOUT_MS = 1200ms; the binary's own 750ms
//      watchdog is the inner fence).
//   2. Parses its single-line JSON stdout into a `WindowContextSnapshot`,
//      attaching optional fields only when non-empty (so an empty capture is
//      the cheap 3-field shape the deny-list / "nothing captured" checks rely
//      on).
//   3. Applies the user's DENY-LIST (exe-name or URL-host patterns) →
//      redaction, and the prompt FORMATTER (compact fragment for the LLM).
//
// The deny-list, IDE/terminal/canvas detection, host extraction, and prompt
// formatter are PURE STRING LOGIC. The only non-pure part is the Command spawn.
//
// The formatter is the GENERIC path (report R2): role-pruned, size-capped,
// deduplicated, honestly-labeled flatten of the accessibility tree with ZERO
// app-specific logic (no per-app conversation reconstructors, no chrome regex
// tables, no mail-blob scrubbers). The A/B evaluation cleared generic >= legacy,
// so the legacy per-app understanding layer was deleted. The actual formatting
// lives in the `generic` submodule; this file keeps only the shared plumbing it
// reuses (denoise, metadata sections, caps, policy) and the capture flow.
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

use crate::helpers::regex::static_regex;
use crate::winstt::settings_schema::ContextAppMode;

mod ax_tree;
mod caret_join;
pub mod file_reference_resolver;
pub mod fixtures;
mod generic;
mod policy;
mod prompt_sections;
mod secret_scrub;
mod snapshot;
mod surface;
pub mod workspace_index;

pub use caret_join::{
    apply_ide_file_tags, extract_taggable_filenames, join_for_insertion, upgrade_tags_to_paths,
};
pub use generic::format_context_generic;
#[cfg(test)]
use policy::extract_host;
pub use policy::{is_allowed_by_list, is_denied_by_list, redact_sensitive_fields};
use prompt_sections::{JsonPromptSection, json_serialize_context, json_trim_or_empty};
#[cfg(test)]
use secret_scrub::JSON_SECRET_CODE_PHRASE_RE;
// Referenced by the shared final scrub gate in `prompt_sections` (via super::)
// and the OTP-scrub tests; the generic formatter routes every text section
// through `json_serialize_context`, which calls this.
use secret_scrub::json_scrub_secret_codes;
pub use snapshot::{
    ContextMode, ContextReader, MAX_BUFFER_BYTES, READ_TIMEOUT_MS, WindowContextSnapshot,
    empty_context, parse_snapshot,
};
pub use surface::{
    IdeKind, ide_kind_from_exe, is_canvas_surface, is_ide_context, looks_like_terminal,
};

// ───────────────────────── shared plumbing ────────────────────────────
//
// Caps, denoise, and metadata-section assembly reused by the generic formatter
// (`generic` submodule). The caret label keys (`beforeCaret`/`afterCaret`) are
// EXACT — the system-prompt continuation clause matches against them literally
// (see with_context_prefix in llm/mod.rs).

const RICH_FIELD_MIN_CHARS: usize = 40;
const SELECTED_TEXT_LLM_MAX: usize = 4000;
const CLIPBOARD_LLM_MAX: usize = 2000;
const CARET_AFTER_LLM_MAX: usize = 2000;
// Formatter backstop for beforeCaret (`clip_tail` keeps the caret-nearest end).
// Set to match the sidecar's CARET_BEFORE_CHARS proximity bound so a stale or
// whole-field capture can't reintroduce page scrollback (inbox lists, prior
// messages, OTP emails) even if the sidecar's own bound is bypassed.
const JSON_CARET_BEFORE_LLM_MAX: usize = 2_000;
const JSON_MAX_LLM_CONTEXT_CHARS: usize = 12_000;

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

/// True when the focused field already carries enough real text (caret split or
/// whole field) to be the primary context — used only by the debug-verdicts
/// panel now that the generic path always emits both field text and screen.
fn focused_field_is_rich(snapshot: &WindowContextSnapshot) -> bool {
    let caret = denoise_for_llm(snapshot.text_before.as_deref())
        .chars()
        .count()
        + denoise_for_llm(snapshot.text_after.as_deref())
            .chars()
            .count();
    if caret >= RICH_FIELD_MIN_CHARS {
        return true;
    }
    denoise_for_llm(Some(&snapshot.focused_text))
        .chars()
        .count()
        >= RICH_FIELD_MIN_CHARS
}

static JSON_LLM_NOISE_RE: Lazy<Regex> = Lazy::new(|| {
    // \p{C} already covers most control/format codepoints (incl. U+200B-U+200F
    // and U+034F), but list the invisible-separator runs UIs inject into
    // preview snippets explicitly so intent is clear: U+034F (CGJ), U+200C/D
    // (ZWNJ/ZWJ), U+200E/F (LRM/RLM).
    static_regex(
        r"[\p{C}\p{So}\x{2022}\x{2023}\x{2043}\x{034F}\x{200C}-\x{200F}\x{1F000}-\x{1FAFF}]",
    )
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

/// Strip control/format/emoji noise and collapse inline whitespace per line,
/// dropping the blank lines that leaves behind. App-agnostic — the ONLY text
/// transform on the generic path.
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

fn json_build_metadata_sections(snapshot: &WindowContextSnapshot) -> Vec<JsonPromptSection> {
    vec![
        JsonPromptSection::text("app", json_trim_or_empty(snapshot.app_exe.as_deref())),
        JsonPromptSection::bool("ide", is_ide_context(snapshot)),
        JsonPromptSection::text("url", json_trim_or_empty(snapshot.url.as_deref())),
        JsonPromptSection::text("window", snapshot.window_title.trim()),
        JsonPromptSection::text("field", snapshot.element_name.trim()),
    ]
}

/// Format the snapshot into a compact JSON LLM-cleanup prompt fragment. Returns
/// "" when no context is available, so callers can blindly concatenate.
///
/// This IS the generic path (report R2). There is no longer a per-app formatter;
/// every capture shape is flattened by role-pruning, size caps, dedup, and OTP
/// scrubbing with zero app-specific branches.
pub fn format_context_for_prompt(snapshot: &WindowContextSnapshot) -> String {
    format_context_generic(snapshot)
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
        ContextAppMode::SelectedOnly if allow_list.is_empty() => {
            // "Allow list" mode with no apps selected captures nothing — context
            // awareness is effectively off (the settings UI persists the toggle
            // off in this state too). Return a blank snapshot so not even the
            // window-title metadata that `redact_sensitive_fields` keeps reaches
            // the prompt.
            WindowContextSnapshot::default()
        }
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
mod tests;
