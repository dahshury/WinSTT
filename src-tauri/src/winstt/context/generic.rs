//! The GENERIC context formatter path (report R2).
//!
//! Emits the SAME JSON section schema as the legacy path
//! (`{app, ide, url, window, field, selection, beforeCaret/afterCaret |
//! fieldText | screen, screenOcr, clipboard, note}`) but with ZERO app-specific
//! logic: no per-app conversation reconstruction, no chrome regexes, no
//! app-name / URL-conditioned branches. Every shared privacy/plumbing concern
//! (metadata, selection/clipboard caps, caret split, OTP/secret scrubbing,
//! allow/deny policy) is reused unchanged; the ONLY app-agnostic transform is
//! the `screen` build, which flattens the accessibility tree by pruning
//! subtrees BY ROLE ONLY, collapsing whitespace, and deduplicating repeated
//! lines.
//!
//! The honest `note` tells the LLM prompt template what `screen` really is so a
//! small model treats it as background rather than clean conversation turns.

use super::ax_tree::{JsonAxNode, JsonAxTree, json_parse_ax_html};
use super::{
    CARET_AFTER_LLM_MAX, CLIPBOARD_LLM_MAX, JSON_CARET_BEFORE_LLM_MAX, JSON_MAX_LLM_CONTEXT_CHARS,
    JsonPromptSection, SELECTED_TEXT_LLM_MAX, WindowContextSnapshot, clip_head, clip_tail,
    denoise_for_llm, json_build_metadata_sections, json_serialize_context,
};

/// The honest description of `screen` that the LLM prompt template consumes. It
/// is deliberately blunt about what raw accessibility text near a focused field
/// contains so a small local model treats it as background, not clean turns.
pub(super) const GENERIC_SCREEN_NOTE: &str = "screen is raw accessibility text captured near the focused field; it may contain UI labels, timestamps and repeated fragments; prioritize selection and beforeCaret.";

/// Below this many chars of pruned screen text, the `screen` section is dropped
/// (too little survived pruning to be worth the note). Mirrors the legacy
/// landmark floor so both paths agree on "there is no usable screen".
const GENERIC_SCREEN_MIN_CHARS: usize = 20;

/// Roles whose ENTIRE subtree is dropped from the generic flatten. This is the
/// only pruning signal — chosen purely by role, never by app name, URL, or text
/// content (report R2). Chrome-ish structural roles (navigation, controls,
/// media, decorations) go; content stays.
fn generic_drop_subtree_role(role: &str) -> bool {
    matches!(
        role,
        "toolbar"
            | "tabs"
            | "tab"
            | "menu"
            | "menubar"
            | "menuitem"
            | "button"
            | "link"
            | "status"
            | "image"
            | "scrollbar"
            | "progressbar"
    )
}

/// Landmark container roles that are KEPT (their descendants are walked). Listed
/// for documentation/parity with the legacy path; the generic walker keeps every
/// non-dropped role, so this set is informational — landmarks are simply not in
/// the drop list.
#[cfg(test)]
pub(super) fn generic_landmark_role(role: &str) -> bool {
    matches!(role, "doc" | "pane" | "group" | "article")
}

/// Collapse every run of whitespace (incl. newlines) inside a single line to one
/// space and trim. Generic — no token/word knowledge.
fn generic_collapse_ws(raw: &str) -> String {
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

/// Normalize a line for near-duplicate comparison: lowercase, drop every
/// non-alphanumeric char, collapse the remainder. Two lines that differ only by
/// punctuation / casing / spacing map to the same key. Generic — no app or
/// language knowledge.
fn generic_dedup_key(line: &str) -> String {
    line.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Walk the tree in document order, dropping subtrees by role and collecting
/// each surviving node's `name` and `text` as separate candidate lines.
fn generic_collect_lines(tree: &JsonAxTree, node_idx: usize, out: &mut Vec<String>) {
    let node: &JsonAxNode = &tree.nodes[node_idx];
    if generic_drop_subtree_role(&node.role) {
        return;
    }
    let name = node.name.trim();
    if name.chars().count() >= 2 {
        out.push(name.to_string());
    }
    let text = node.text.trim();
    if text.chars().count() >= 2 {
        out.push(text.to_string());
    }
    for child in &node.children {
        generic_collect_lines(tree, *child, out);
    }
}

/// Deduplicate lines: drop exact repeats anywhere, AND near-duplicates (same
/// normalized key). First occurrence wins; order is preserved. This kills the
/// UI's repeated labels/preview echoes without any per-app rule.
fn generic_dedup_lines(lines: Vec<String>) -> Vec<String> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for line in lines {
        let collapsed = generic_collapse_ws(&line);
        if collapsed.is_empty() {
            continue;
        }
        let key = generic_dedup_key(&collapsed);
        // A line that is pure punctuation/whitespace has an empty key; keep it
        // only if not already emitted verbatim (rare, but avoids a blank-key
        // collision collapsing every symbol-only line into one).
        let novel = if key.is_empty() {
            seen.insert(collapsed.clone())
        } else {
            seen.insert(key)
        };
        if novel {
            out.push(collapsed);
        }
    }
    out
}

/// Build the generic `screen`: parse the ax tree, role-prune it, flatten to
/// lines, collapse whitespace, deduplicate (exact + near-dup), join, and cap at
/// the existing 12k ceiling. Returns "" when there is no tree or too little
/// survives. No app-name / URL / chrome-regex branches anywhere.
fn generic_screen(ax_html: Option<&str>) -> String {
    let ax_html = ax_html.unwrap_or("").trim();
    if ax_html.is_empty() {
        return String::new();
    }
    let tree = json_parse_ax_html(ax_html);
    let mut lines = Vec::new();
    generic_collect_lines(&tree, 0, &mut lines);
    let deduped = generic_dedup_lines(lines);
    let joined = deduped.join("\n");
    // Denoise (strip control/format/emoji noise + trim blank lines) generically,
    // then cap. denoise_for_llm is app-agnostic whitespace/noise handling.
    let cleaned = denoise_for_llm(Some(&joined));
    if cleaned.chars().count() < GENERIC_SCREEN_MIN_CHARS {
        return String::new();
    }
    clip_head(&cleaned, JSON_MAX_LLM_CONTEXT_CHARS)
}

/// Generic selection section: denoise-only (no `strip_list_scrollback`, which is
/// an inbox-list heuristic), capped at the existing selection ceiling.
fn generic_selected_section(snapshot: &WindowContextSnapshot) -> JsonPromptSection {
    JsonPromptSection::text(
        "selection",
        clip_head(
            &denoise_for_llm(snapshot.selected_text.as_deref()),
            SELECTED_TEXT_LLM_MAX,
        ),
    )
}

/// Generic clipboard section: denoise-only, capped at the existing clipboard
/// ceiling.
fn generic_clipboard_section(snapshot: &WindowContextSnapshot) -> JsonPromptSection {
    JsonPromptSection::text(
        "clipboard",
        clip_head(
            &denoise_for_llm(snapshot.clipboard_text.as_deref()),
            CLIPBOARD_LLM_MAX,
        ),
    )
}

/// Generic content sections: the caret split (beforeCaret/afterCaret) when the
/// sidecar captured a caret, else the whole focused field as `fieldText`. Both
/// are denoise-only with the existing caps — no reconstruction, no reroute.
fn generic_content_sections(snapshot: &WindowContextSnapshot) -> Vec<JsonPromptSection> {
    let before = denoise_for_llm(snapshot.text_before.as_deref());
    let after = denoise_for_llm(snapshot.text_after.as_deref());
    if !before.is_empty() || !after.is_empty() {
        return vec![
            JsonPromptSection::text("beforeCaret", clip_tail(&before, JSON_CARET_BEFORE_LLM_MAX)),
            JsonPromptSection::text("afterCaret", clip_head(&after, CARET_AFTER_LLM_MAX)),
        ];
    }
    vec![JsonPromptSection::text(
        "fieldText",
        denoise_for_llm(Some(&snapshot.focused_text)),
    )]
}

/// Generic OCR section: denoise-only passthrough of the (currently stubbed)
/// `ocr_text` field.
fn generic_ocr_section(snapshot: &WindowContextSnapshot) -> JsonPromptSection {
    JsonPromptSection::text("screenOcr", denoise_for_llm(snapshot.ocr_text.as_deref()))
}

/// The GENERIC formatter (report R2). Same section schema as the legacy path,
/// zero app-specific logic. Section order mirrors the legacy assembly so the two
/// paths line up field-for-field in the A/B harness:
/// metadata → selection → [screen + note] → caret/field → screenOcr → clipboard.
///
/// The final OTP/secret scrub + empty-section drop happen inside
/// `json_serialize_context`, shared with the legacy path.
pub fn format_context_generic(snapshot: &WindowContextSnapshot) -> String {
    let mut sections = json_build_metadata_sections(snapshot);
    sections.push(generic_selected_section(snapshot));

    let screen = generic_screen(snapshot.ax_html.as_deref());
    let has_screen = !screen.is_empty();
    if has_screen {
        sections.push(JsonPromptSection::text("screen", screen));
        // The note only makes sense when there IS raw screen text to caveat.
        sections.push(JsonPromptSection::text("note", GENERIC_SCREEN_NOTE));
    }

    sections.extend(generic_content_sections(snapshot));
    sections.push(generic_ocr_section(snapshot));
    sections.push(generic_clipboard_section(snapshot));

    json_serialize_context(sections)
}

#[cfg(test)]
mod tests;
