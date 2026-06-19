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

use crate::helpers::regex::static_regex;
use crate::winstt::settings_schema::ContextAppMode;

mod policy;
mod prompt_sections;
mod snapshot;
mod surface;

#[cfg(test)]
use policy::extract_host;
pub use policy::{is_allowed_by_list, is_denied_by_list, redact_sensitive_fields};
use prompt_sections::{json_serialize_context, json_trim_or_empty, JsonPromptSection};
pub use snapshot::{
    empty_context, parse_snapshot, ContextMode, ContextReader, WindowContextSnapshot,
    MAX_BUFFER_BYTES, READ_TIMEOUT_MS,
};
use surface::contains_word;
pub use surface::{
    ide_kind_from_exe, ide_profile, is_ai_coding_cli, is_canvas_surface, is_ide_context,
    is_ide_terminal, looks_like_terminal, IdeKind, IdeProfile,
};

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

#[expect(
    dead_code,
    reason = "legacy prompt formatter is retained for parity comparisons"
)]
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
    static_regex(
        r"[\p{C}\p{So}\x{2022}\x{2023}\x{2043}\x{034F}\x{200C}-\x{200F}\x{1F000}-\x{1FAFF}]",
    )
});
static JSON_INBOX_DATE_ROW_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"^(?:\d{1,2}:\d{2}\s?[AP]M|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2})$",
    )
});
static JSON_TAG_RE: Lazy<Regex> = Lazy::new(|| static_regex(r"<[^>]+>"));
static JSON_ROLE_RE: Lazy<Regex> = Lazy::new(|| static_regex(r"^</?\s*([a-z][a-z0-9]*)"));
static JSON_NAME_ATTR_RE: Lazy<Regex> = Lazy::new(|| static_regex(r#"\bname="([^"]*)""#));
static JSON_FOCUS_ATTR_RE: Lazy<Regex> = Lazy::new(|| static_regex(r#"\bfocus="1""#));
static JSON_NAV_NAME_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"(?i)\b(?:chats?|conversations?|inbox|channels?|direct messages|members?|participants?|navigation|navigation pane|recents?|recent threads?|threads?|projects?|workspaces?|files?|explorer|folders?|sidebar|side panel|mailbox|page list|pages|primary|timeline tabs|who to follow|what's happening|for you|following|premium|live on x|trending|grok|junk email|sent items|deleted items|archive|favorites|conversation history|message list|new mail)\b",
    )
});
static JSON_CONTAINER_NAV_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"(?i)\b(?:sidebar|side panel|side bar|navigation|nav rail|primary column|sidebar column|servers?|roster|app bar|browser chrome|left rail|chat list|chats)\b",
    )
});
static JSON_CONTENT_LIST_NAME_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"(?i)\b(?:messages?|conversation with|message thread|comment thread|comments?|timeline)\b",
    )
});
static JSON_SPEAKER_PREFIX_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r"^\s*(?:@?[\p{L}\p{N} _.'-]{2,40}|You|Me):\s+\S"));
static JSON_TIME_OR_META_LINE_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
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
});
static JSON_AUTHOR_TRAILING_TIME_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r"(?i)\s+\d{1,2}:\d{2}\s?[ap]m$"));
static JSON_LOW_SIGNAL_UI_LINE_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
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
        )\b
        |
        # Discord per-user clan badge + user-profile card chrome (the trailing
        # profile flyout: 'View Full Profile', 'Member Since Mar 12, 2017',
        # 'Mutual Servers — 3', 'Originally known as …', 'Add Note (only visible
        # to you)'). These leak as standalone lines in the textBefore stream.
        ^\s*(?:
            server\ tag\b
            | view\ (?:full\ )?profile
            | member\ since\b
            | mutual\ (?:servers?|friends?)\b
            | originally\ known\ as\b
            | add\ note(?:\ \(only\ visible\ to\ you\))?
        )",
    )
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
    static_regex(
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
});

/// A chat timestamp / datetime row that separates message groups and must never
/// become a body line or an author. Covers the real shapes seen in captures:
/// `6/11/26, 2:07 PM`, `Thursday, June 11, 2026 at 2:07 PM`, `June 11, 2026`,
/// `Yesterday at 9:45 AM`, bare `9:37 AM`, Messenger `5:14am`.
static JSON_CHAT_TIMESTAMP_LINE_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
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
});

/// Discord per-message UI affordances that interleave the flat stream and are
/// not part of any message body.
static JSON_DISCORD_AFFORDANCE_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"(?ix)
        ^\s*(?:
            add\ reaction | more\ message\ options | play\ voice\ message
            | control\ volume | remove\ all\ embeds | \d+x | \d{1,2}:\d{2}
            | started\ a\ call.* | .*started\ a\ call\ that\ lasted.*
        )\s*$
    ",
    )
});

/// An X (Twitter) author header line: a `@handle` standing alone, or a display
/// name immediately followed by ` @handle`. Used to attribute the flat tweet
/// blob positionally (X has no `Author:` prefix).
static JSON_X_HANDLE_RE: Lazy<Regex> = Lazy::new(|| static_regex(r"@[A-Za-z0-9_]{2,15}\b"));

/// Messenger embeds authorship as `... by <Author>:` inside its flat doc blob
/// (`Enter, Message sent Saturday 8:15am by موه: <body>`). This captures the
/// author + the start of the body so we can rebuild `Author: body`.
static JSON_MESSENGER_BY_AUTHOR_RE: Lazy<Regex> = Lazy::new(|| {
    // The author runs from "by " to the colon-and-body OR end-of-line. The colon
    // group is OPTIONAL because attachment/video messages render as a marker with
    // NO inline body ("Enter, Message sent 2:32 PM by موه\n"); requiring a colon
    // made the capture greedily swallow the next line's clock (the `5:43` colon).
    // Anchoring the author at `[^:\n]` (no colon, no newline) keeps it tight.
    static_regex(
        r"(?:Enter,\s*)?Message sent[^\n]*?\bby\s+(?P<author>[^:\n]{1,40}?)\s*(?::\s*|\n|$)",
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

/// Per-message Outlook reading-pane chrome (the action toolbar each open message
/// renders: `View with a light background / Reply / Reply all / Forward / Apps /
/// More items / Show original size`, the recipient `To:` row, and the
/// header-expand / pop-out footer). Dropped from the scrubbed mail blob so only
/// the sender + subject + body survive.
static JSON_OUTLOOK_MSG_CHROME_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"(?ix)
        ^\s*(?:
            view\ with\ a\ light\ background
            | reply\ all | reply | forward | apps | more\ items
            | show\ original\ size | show\ original
            | expand\ header(?:\ and\ show\ message\ history)?
            | expand\ conversation | collapse\ conversation
            | header\ action\ menu
            | pop\ out | send | more\ send\ options | discard
            | to:?\u{200b}? | to: | open\ font(?:\ size)?
            | hide\ navigation\ pane | navigation\ pane
            | go\ to\ groups | select | jump\ to | filter
            | focused | other | switch\ layouts | more\ options
        )\s*$
    ",
    )
});

/// An inbox-list preview row — a mail-list entry whose subject/snippet is rendered
/// TWICE (full text + a `…`-truncated copy). These rows are the message LIST, not
/// the open thread, so they are cut off as scrollback. Keyed on the trailing
/// horizontal-ellipsis truncation that only the list previews carry.
fn json_is_mail_list_preview_row(line: &str) -> bool {
    line.contains('\u{2026}')
}

/// Scrub a flat, page-spanning mail blob (Outlook / Gmail web) whose UIA tree is a
/// single structureless `<doc>` (no per-message nodes to prune). Operates on the
/// newline-preserved, denoised text so it can filter ROW-BY-ROW: (1) cut the
/// inbox-list scrollback prefix at the last `…`-truncated preview row (the message
/// list ends there; the open thread follows), (2) drop the per-message Outlook
/// action chrome, blank rows, and any OTP / single-use / verification / sign-in
/// security-code rows, and (3) collapse the yearly/threaded repeats (consecutive
/// duplicate lines).
///
/// Returns `None` when the blob does not look like a mail reading pane (no list
/// preview row found) so a non-mail page is never mangled.
fn json_scrub_mail_blob(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < 4 {
        return None;
    }
    // Cut at the LAST list-preview row in the first 85% — everything after it is
    // the open thread (the list is always above the reading pane).
    let limit = lines.len() * 85 / 100;
    let mut cut: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if i > limit {
            break;
        }
        if json_is_mail_list_preview_row(line) {
            cut = Some(i);
        }
    }
    let cut = cut?;
    let kept: Vec<String> = lines
        .iter()
        .skip(cut + 1)
        .map(|line| line.trim())
        .filter(|line| {
            !line.is_empty()
                && !JSON_OUTLOOK_MSG_CHROME_RE.is_match(line)
                && !json_is_gmail_chrome_line(line)
                && !json_is_otp_or_signin_row(line)
                && !json_is_mail_list_preview_row(line)
        })
        .map(|line| line.to_string())
        .collect();
    let scrubbed = json_dedupe_consecutive(kept).join("\n");
    let scrubbed = scrubbed.trim();
    if scrubbed.chars().count() < JSON_LANDMARK_MIN_CHARS {
        return None;
    }
    Some(scrubbed.to_string())
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
            "address and search bar" | "search" | "search mail" | "search messenger" | "urlbar"
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

/// A row that carries a one-time / single-use / verification / sign-in security
/// code (or merely announces one). These ride in OTHER inbox rows of a mail app
/// (Gmail / Outlook), NEVER in the open email/thread the user is replying to, so
/// they must never survive into the pruned context. Defense-in-depth on top of
/// the structural nav-list drop: even if a single OTP-bearing row leaks out of a
/// landmark, this line filter removes it.
static JSON_OTP_ROW_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"(?ix)
        \b(?:
            one[-\ ]time\ (?:code|password|passcode|pin)
            | single[-\ ]use\ (?:code|password|passcode|pin)
            | verification\ code
            | security\ code
            | login\ code
            | sign[-\ ]?in\ code
            | your\ .*\ (?:verification|security|login)\ code
            | otp
        )\b
        |
        # bare 'amazon.eg: Sign-in' style sign-in-notice row subjects.
        :\s*sign[-\ ]?in\b
    ",
    )
});

/// True when a row is a one-time / verification / sign-in security-code line that
/// must be scrubbed from any mail context (see `JSON_OTP_ROW_RE`). Bounded to a
/// single row's worth of text (<=200 chars): a page-spanning flat mail blob will
/// also contain such a phrase, but dropping the WHOLE blob on a single buried
/// match would discard the open thread too — the blob path scrubs those phrases
/// separately (see `json_scrub_mail_blob`).
fn json_is_otp_or_signin_row(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.chars().count() <= 200 && JSON_OTP_ROW_RE.is_match(trimmed)
}

// ───────────────── unconditional final OTP / secret-code scrub ─────────────────
//
// PRIVACY-CRITICAL. The per-row `json_is_otp_or_signin_row` filter above only
// fires on the paths that iterate ROW-BY-ROW (the mail-blob scrubber, the
// nav-list pruner). The window-dump fallback (`format_context_for_prompt_json`'s
// final `JsonPromptSection::text("screen", raw_axHtml)` branch) emits the whole
// `<doc>` as a SINGLE line — so a buried `... verification OTP is: 17042 ...`
// never gets seen by the per-row filter and leaks. This pass is the LAST gate:
// it runs on the assembled output strings (screen / beforeCaret / afterCaret /
// fieldText / selection / clipboard / screenOcr) inside `json_serialize_context`
// — i.e. no matter which branch produced them — and is intentionally
// keyword-anchored so it cannot over-redact ordinary numbers (prices, years,
// counts, phone numbers) that sit in normal conversation.
//
// Two complementary rules, applied per SEGMENT (a segment is a line, further
// split on sentence terminators so one giant single-line blob is still broken
// into sentence-sized units):
//   1. Drop any whole segment that announces / carries a verification, OTP,
//      one-time / single-use / security / passcode / 2FA / login / sign-in code
//      (the `JSON_SECRET_CODE_PHRASE_RE` phrase set).
//   2. Within a surviving segment, redact a bare 4-8 digit run (or a
//      `G-123456` / `G123456` provider-prefixed code) ONLY when an OTP /
//      verification / code keyword sits next to it — so a year ("2026"), a price
//      ("$4,200"), a count ("10926 unread") or a phone number never gets touched.

/// Phrase set that marks a segment as carrying / announcing a single-use secret
/// code. A match drops the WHOLE segment. Broader than `JSON_OTP_ROW_RE` (which
/// is tuned for short inbox-list rows): this also catches the open-email body
/// shapes ("Your account verification OTP is: …", "your verification code:",
/// "passcode", "2FA code", "G-123456 is your Google verification code").
static JSON_SECRET_CODE_PHRASE_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"(?ix)
        \b(?:
            one[-\ ]?time\ (?:code|password|passcode|pin|passphrase)
            | single[-\ ]?use\ (?:code|password|passcode|pin|link)
            | verification\ (?:code|otp|pin|number)
            | verification\ otp
            | confirmation\ code
            | security\ code
            | login\ code
            | log[-\ ]?in\ code
            | sign[-\ ]?in\ code
            | access\ code
            | passcode
            | pass\ code
            | auth(?:entication)?\ code
            | 2fa\ code | 2[-\ ]?factor\ code
            | two[-\ ]?factor\ (?:code|authentication)
            | otp
            | one[-\ ]?time\ pin
            # 'your ... verification/security/login/access code' (open-email body)
            | your\ .{0,40}?\ (?:verification|security|login|access|confirmation)\ code
            # explicit 'verification ... is: NNNN' / 'code is NNNN' announcements
            | (?:verification|security|access|confirmation|login)\ \w{0,12}?\ is:?\s*\d
        )\b
        |
        # 'amazon.eg: Sign-in' notice-row subject shape.
        :\s*sign[-\ ]?in\b
    ",
    )
});

/// A keyword that, when adjacent to a digit run, marks that digit run as a
/// secret code (used by rule 2 for in-segment digit redaction). This set is
/// STRICT — only terms that actually PRESENT a code value. The bare word
/// "verification" is deliberately excluded: it rides in inbox subject lines
/// ("Account Verification") next to unrelated counts ("10926 unread"), and must
/// not make those counts look like codes. The full announcing phrases (e.g.
/// "verification code") are still covered here and by the phrase set.
static JSON_SECRET_CODE_KEYWORD_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"(?ix)
        (?:
            \botp\b
            | \bone[-\ ]?time\ (?:code|password|passcode|pin)\b
            | \bsingle[-\ ]?use\ (?:code|password|passcode|pin)\b
            | \bpasscode\b | \bpass\ code\b
            | \bverification\ (?:code|pin|number)\b
            | \bsecurity\ code\b | \blogin\ code\b | \blog[-\ ]?in\ code\b
            | \bsign[-\ ]?in\ code\b | \baccess\ code\b | \bconfirmation\ code\b
            | \bauth(?:entication)?\ code\b
            | \b2fa\b | \btwo[-\ ]?factor\ (?:code|authentication)\b
            # generic 'code is' / 'code:' / 'pin is' value-presentation cues
            | \bcode\ is\b | \bcode:\s | \bpin\ is\b | \bpin:\s
        )
    ",
    )
});

/// A bare secret-code-shaped digit run: 4-8 digits, OR a provider-prefixed
/// `G-123456` / `G123456` style code (a single letter + optional dash + 4-8
/// digits). Used by rule 2; only redacted when keyword-adjacent.
static JSON_BARE_CODE_RE: Lazy<Regex> = Lazy::new(|| static_regex(r"(?i)\b[A-Z]?-?\d{4,8}\b"));

const SECRET_CODE_REDACTION: &str = "[redacted code]";

/// True when the given byte offset window of `segment` puts a digit run close
/// enough to a secret-code keyword to call it a code. "Close enough" = the
/// keyword and the digit run share a small character window (<=48 chars between
/// the nearest keyword edge and the digit run) — tight enough that an unrelated
/// number elsewhere in a long sentence is not pulled in.
fn json_digit_run_is_code_adjacent(segment: &str, run_start: usize, run_end: usize) -> bool {
    const WINDOW: usize = 48;
    for kw in JSON_SECRET_CODE_KEYWORD_RE.find_iter(segment) {
        // distance from the keyword to the digit run (whichever side it is on)
        let gap = if kw.end() <= run_start {
            run_start - kw.end()
        } else if run_end <= kw.start() {
            kw.start() - run_end
        } else {
            0
        };
        if gap <= WINDOW {
            return true;
        }
    }
    false
}

/// Redact keyword-adjacent bare digit codes inside a single segment, leaving all
/// other numbers untouched. Returns the segment with each adjacent code replaced
/// by `[redacted code]`.
fn json_redact_adjacent_codes(segment: &str) -> String {
    if !JSON_SECRET_CODE_KEYWORD_RE.is_match(segment) {
        return segment.to_string();
    }
    let mut out = String::with_capacity(segment.len());
    let mut last = 0usize;
    for m in JSON_BARE_CODE_RE.find_iter(segment) {
        if json_digit_run_is_code_adjacent(segment, m.start(), m.end()) {
            out.push_str(&segment[last..m.start()]);
            out.push_str(SECRET_CODE_REDACTION);
            last = m.end();
        }
    }
    out.push_str(&segment[last..]);
    out
}

/// Snap a clause boundary backwards from `pos` to the start of the secret-code
/// PHRASE/announcement — i.e. swallow a short leading run (<= back chars) so the
/// dropped span covers `Your account verification` rather than just `verification`
/// — but stop at a sentence terminator so unrelated earlier text is preserved.
fn json_clause_start(line: &str, pos: usize, back: usize) -> usize {
    let floor = pos.saturating_sub(back);
    let mut start = pos;
    // Walk back to the nearest sentence terminator (`.`/`!`/`?` + space) or the
    // back-window floor, whichever comes first, then trim leading whitespace.
    let prefix = &line[..pos];
    for (i, ch) in prefix.char_indices().rev() {
        if i < floor {
            break;
        }
        if matches!(ch, '.' | '!' | '?' | '\n') {
            start = i + ch.len_utf8();
            break;
        }
        start = i;
    }
    // Trim leading whitespace inside the chosen window.
    while start < pos && line.as_bytes()[start].is_ascii_whitespace() {
        start += 1;
    }
    start
}

/// Snap a clause boundary forwards from `pos` to the end of the secret-code
/// clause: extend past any adjacent bare code and stop at the next sentence
/// terminator (or the forward-window cap), so a single run-on blob loses only the
/// code clause, not everything up to the next period.
fn json_clause_end(line: &str, pos: usize, forward: usize) -> usize {
    let cap = (pos + forward).min(line.len());
    let mut end = pos;
    let tail = &line[pos..cap];
    for (rel, ch) in tail.char_indices() {
        let abs = pos + rel;
        end = abs + ch.len_utf8();
        if matches!(ch, '.' | '!' | '?' | '\n') {
            break;
        }
    }
    // Snap to a char boundary at/under cap.
    while end < line.len() && !line.is_char_boundary(end) {
        end += 1;
    }
    end.min(line.len())
}

/// The unconditional, path-independent final secret-code scrub. Applied to every
/// assembled context string before it leaves the formatter.
///
/// Two-stage, span-based (so a single giant one-line window-dump blob loses only
/// the code CLAUSE, never the whole blob):
///   1. For every secret-code PHRASE match, excise a tight clause around it
///      (back to the sentence start / a short window, forward to the sentence end
///      / a short window). This removes `Your account verification OTP is: 17042`
///      while keeping the inbox counts and the signature that surround it.
///   2. In what remains, redact any bare 4-8 digit (or `G-123456`) code that is
///      keyword-adjacent — defense-in-depth for a code split from its phrase.
///
/// A blob with no secret-code keyword or phrase at all is returned byte-for-byte
/// unchanged, so a normal conversation (prices, years, counts, phone numbers) is
/// never touched.
fn json_scrub_secret_codes(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    // Fast path: nothing remotely code-like → leave the text exactly as-is.
    if !JSON_SECRET_CODE_KEYWORD_RE.is_match(text) && !JSON_SECRET_CODE_PHRASE_RE.is_match(text) {
        return text.to_string();
    }

    // How far a dropped clause may extend on each side of a phrase match. Bounded
    // so an unpunctuated run-on (the Outlook <doc>) loses a sentence-sized window
    // around the code, not the entire blob.
    const CLAUSE_BACK: usize = 64;
    const CLAUSE_FWD: usize = 96;

    let mut lines_out: Vec<String> = Vec::new();
    for line in text.split('\n') {
        // Stage 1: collect drop spans for every phrase match, then excise.
        let mut spans: Vec<(usize, usize)> = Vec::new();
        for m in JSON_SECRET_CODE_PHRASE_RE.find_iter(line) {
            let start = json_clause_start(line, m.start(), CLAUSE_BACK);
            let end = json_clause_end(line, m.end(), CLAUSE_FWD);
            spans.push((start, end));
        }
        let kept = if spans.is_empty() {
            line.to_string()
        } else {
            // Merge overlapping spans, then keep the gaps between them.
            spans.sort_by_key(|s| s.0);
            let mut merged: Vec<(usize, usize)> = Vec::new();
            for (s, e) in spans {
                match merged.last_mut() {
                    Some(last) if s <= last.1 => last.1 = last.1.max(e),
                    _ => merged.push((s, e)),
                }
            }
            let mut out = String::with_capacity(line.len());
            let mut cursor = 0usize;
            for (s, e) in merged {
                if s > cursor {
                    out.push_str(&line[cursor..s]);
                }
                cursor = e;
            }
            if cursor < line.len() {
                out.push_str(&line[cursor..]);
            }
            json_collapse_inline_ws(&out)
        };

        // Stage 2: redact any keyword-adjacent code that survived stage 1.
        let kept = json_redact_adjacent_codes(&kept);
        let kept = kept.trim_end().to_string();

        if !line.trim().is_empty() && kept.trim().is_empty() {
            // The whole line was a secret-code row → drop the line entirely.
            continue;
        }
        lines_out.push(kept);
    }
    lines_out.join("\n")
}

fn json_is_low_signal_ui_line(line: &str) -> bool {
    let trimmed = line.trim();
    // An OTP / verification / sign-in security-code row is always low-signal — it
    // overrides even the speaker-turn shape (a row like "amazon.eg: Sign-in" or
    // "Google: Your verification code is 622297" otherwise reads as a speaker
    // turn and would survive).
    if json_is_otp_or_signin_row(trimmed) {
        return true;
    }
    !json_is_speaker_turn_line(trimmed)
        && (JSON_LOW_SIGNAL_UI_LINE_RE.is_match(trimmed)
            || JSON_FALSE_SPEAKER_PREFIX_RE.is_match(trimmed))
}

fn json_is_time_or_meta_line(line: &str) -> bool {
    JSON_TIME_OR_META_LINE_RE.is_match(line.trim())
}

/// True when a candidate author still carries Messenger/feed marker boilerplate
/// ("Enter", "Message sent", "Original message") — a sign the marker regex
/// over-captured past the real name. Never a legitimate display name.
fn json_author_is_marker_contaminated(author: &str) -> bool {
    let lower = author.to_lowercase();
    lower.contains("message sent")
        || lower.contains("original message")
        || contains_word(&lower, "enter")
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
        || json_author_is_marker_contaminated(&author)
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
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
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
                .is_some_and(|l| JSON_CHAT_TIMESTAMP_LINE_RE.is_match(l));
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

/// One Messenger message: the resolved author plus its raw inline body span.
struct JsonMessengerTurn {
    author: String,
    body: String,
}

/// Reconstruct `Author: message` turns from Facebook Messenger's flat `<doc>`
/// blob, which embeds authorship as `… Message sent <when> by <Author>: <body>`.
/// Splits on each "Message sent … by <Author>:" marker and attributes the text
/// up to the next marker. Returns `None` when no such marker is present.
///
/// Messenger renders each message as `<body>\n￼\n Enter, Message sent … by X:
/// <body>` — the body is duplicated as a preview ABOVE the marker, then echoed
/// after the colon. The naive "after the colon up to the next marker" span
/// therefore bleeds the NEXT message's preview into this turn (so
/// `سول: السلام عليكم` swallowed the next `صباح الخير`). Two passes fix it:
///   1. cut the inline body at the first object-replacement char (`￼`, U+FFFC),
///      which Messenger inserts between a body and the next preview, and
///   2. strip any trailing suffix of turn N that is the leading text of turn N+1
///      (the carried-over preview between two consecutive single-line messages
///      that share no `￼` separator).
fn json_reconstruct_messenger_blob(text: &str) -> Option<String> {
    let markers: Vec<regex::Match<'_>> = JSON_MESSENGER_BY_AUTHOR_RE.find_iter(text).collect();
    if markers.len() < 2 {
        return None;
    }

    // Pass 1: per-marker author + raw inline body (cut at the U+FFFC preview
    // boundary, deduped if the half-repeat shape is present, chrome-trimmed).
    let mut raw: Vec<JsonMessengerTurn> = Vec::new();
    for (idx, m) in markers.iter().enumerate() {
        let Some(caps) = JSON_MESSENGER_BY_AUTHOR_RE.captures(m.as_str()) else {
            continue;
        };
        let Some(author) = caps.name("author").map(|a| a.as_str().trim().to_string()) else {
            continue;
        };
        let Some(author) = json_normalize_author(&author) else {
            continue;
        };
        let body_start = m.end();
        let body_end = markers.get(idx + 1).map_or(text.len(), |next| next.start());
        let mut body = &text[body_start..body_end];
        // Cut at the object-replacement char Messenger drops between this body
        // and the next message's preview (multi-line bodies all end there).
        if let Some(obj) = body.find('\u{fffc}') {
            body = &body[..obj];
        }
        // Denoise (strip `￼` placeholders + invisible runs), collapse ALL
        // whitespace to single spaces, THEN trim chrome. Order matters: the
        // chrome-cut tokens are space-delimited (" Compose "), so they must run
        // after newlines are folded to spaces or a trailing "Compose\nOpen …"
        // toolbar dump would survive. Collapsing first also makes the body match
        // the next marker's preview text for the cross-marker bleed strip.
        let body = json_collapse_inline_ws(&denoise_for_llm(Some(body)));
        let body = json_dedupe_repeated_half(&body);
        let body = json_messenger_clean_body(&body);
        if body.is_empty() {
            continue;
        }
        raw.push(JsonMessengerTurn { author, body });
    }
    if raw.len() < 2 {
        return None;
    }

    // Pass 2: strip the cross-marker preview bleed — when turn N ends with the
    // start of turn N+1's body (the carried preview), drop that shared tail.
    let mut turns: Vec<String> = Vec::with_capacity(raw.len());
    for idx in 0..raw.len() {
        let next_body = raw.get(idx + 1).map_or("", |t| t.body.as_str());
        let body = json_strip_shared_suffix_prefix(&raw[idx].body, next_body);
        if body.is_empty() {
            continue;
        }
        turns.push(format!("{}: {body}", raw[idx].author));
    }
    if turns.len() < 2 {
        return None;
    }
    Some(json_dedupe_consecutive(turns).join("\n"))
}

/// When `body` ends with the leading run of `next_body` (Messenger carries the
/// next message's preview onto the tail of the current one), drop that shared
/// span. The comparison IGNORES whitespace — the carried preview and the next
/// marker's own body differ only in incidental spacing (`لهم :(` vs `لهم : (`),
/// so an exact char match would miss the bleed. The cut is made on the ORIGINAL
/// (spaced) body at the first character of the matched preview. Conservative:
/// requires a >=8 non-space-char overlap so short repeated words are kept.
fn json_strip_shared_suffix_prefix(body: &str, next_body: &str) -> String {
    let body = body.trim();
    let next_body = next_body.trim();
    if next_body.is_empty() {
        return body.to_string();
    }
    // Map each non-whitespace char of `body` to its byte offset, building the
    // compacted (space-free) string in parallel.
    let mut compact = String::with_capacity(body.len());
    let mut offsets: Vec<usize> = Vec::with_capacity(body.len());
    for (idx, ch) in body.char_indices() {
        if !ch.is_whitespace() {
            compact.push(ch);
            offsets.push(idx);
        }
    }
    let next_compact: String = next_body.chars().filter(|c| !c.is_whitespace()).collect();
    if next_compact.chars().count() < 8 {
        return body.to_string();
    }
    let compact_chars: Vec<char> = compact.chars().collect();
    let next_chars: Vec<char> = next_compact.chars().collect();
    let max = compact_chars.len().min(next_chars.len());
    let mut overlap = 0usize;
    for len in (8..=max).rev() {
        if compact_chars[compact_chars.len() - len..] == next_chars[..len] {
            overlap = len;
            break;
        }
    }
    if overlap == 0 {
        return body.to_string();
    }
    // Cut at the original byte offset of the first overlapping char.
    let cut_byte = offsets[compact_chars.len() - overlap];
    body[..cut_byte].trim().to_string()
}

/// Trim Messenger composer/footer chrome that trails the LAST message in the
/// flat doc blob (the message log has no closing delimiter, so the final turn's
/// body otherwise swallows the composer toolbar, the "Continue without
/// restoring?" modal, etc.). Also drop the "Original message:" reply-quote
/// preamble Messenger injects before an edited message.
fn json_messenger_clean_body(body: &str) -> String {
    // Search against a space-padded copy so a chrome token at the VERY START of
    // the body (an attachment-only marker whose span runs straight into the
    // composer toolbar: "Compose Open more actions …") is cut too, not just
    // mid-body occurrences. Offsets map back 1:1 minus the leading pad.
    let padded = format!(" {body}");
    let mut cut_at = padded.len();
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
        if let Some(i) = padded.find(cut) {
            cut_at = cut_at.min(i);
        }
    }
    // Map back to the unpadded body (drop the 1-byte leading space).
    let end = cut_at.saturating_sub(1).min(body.len());
    body[..end].trim().to_string()
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
    let mut scoped = match blob.find("Conversation") {
        Some(i) => &blob[i + "Conversation".len()..],
        None => blob,
    };
    // Truncate the post-thread footer (X appends "Relevant people", "Live on X",
    // and the trending/"What's happening" rail after the last reply) so its
    // account names + Arabic news headlines never become fabricated tweet turns.
    for footer in [
        " Relevant people",
        " Live on X ",
        " What's happening",
        " Trending now",
    ] {
        if let Some(i) = scoped.find(footer) {
            scoped = &scoped[..i];
        }
    }
    let handles: Vec<regex::Match<'_>> = JSON_X_HANDLE_RE.find_iter(scoped).collect();
    if handles.is_empty() {
        return None;
    }
    let mut pairs: Vec<(String, String)> = Vec::new();
    for (idx, h) in handles.iter().enumerate() {
        // Display name = the tail of the text since the previous handle's body
        // start, taking the last 1–3 capitalized-ish words right before @handle.
        let name_region_start = if idx == 0 { 0 } else { handles[idx - 1].end() };
        let name_region = &scoped[name_region_start..h.start()];
        let display_name = json_x_trailing_display_name(name_region);
        // Body = text after the handle up to the next handle.
        let body_start = h.end();
        let body_end = handles.get(idx + 1).map_or(scoped.len(), |n| {
            // back up to the start of that tweet's display name so the next
            // author's name isn't appended to this body.
            let region = &scoped[h.end()..n.start()];
            h.end() + json_x_body_cutoff(region)
        });
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
        if matches!(
            name_lower.as_str(),
            "replying to" | "replying" | "post" | "quote" | "reply"
        ) {
            continue;
        }
        if body.chars().count() < 8 {
            continue;
        }
        // Drop the user's own reply-compose prompt and known chrome bodies.
        if body.eq_ignore_ascii_case("Post your reply") || body.starts_with("Replying to") {
            continue;
        }
        pairs.push((name, body));
    }
    if pairs.is_empty() {
        return None;
    }
    // Post-pass: a tweet body that runs up to the next tweet's `@handle` still
    // carries that next tweet's display-name words (and an intervening lone
    // like-count token) on its tail — `… what's fusion using? 146 Andrew Trask`.
    // Strip the trailing copy of turn N+1's display name, plus any count token
    // left between, so the next author's name never bleeds into this turn.
    let mut turns: Vec<String> = Vec::with_capacity(pairs.len());
    for idx in 0..pairs.len() {
        let next_name = pairs.get(idx + 1).map_or("", |(n, _)| n.as_str());
        let body = json_x_strip_trailing_next_name(&pairs[idx].1, next_name);
        if body.chars().count() < 8 {
            continue;
        }
        // Format as `DisplayName: body` so it matches the speaker-prefix contract.
        turns.push(format!("{}: {body}", pairs[idx].0));
    }
    if turns.is_empty() {
        return None;
    }
    Some(json_dedupe_consecutive(turns).join("\n"))
}

/// Strip the next tweet's leaked display name (and an intervening lone count
/// token) off the tail of a body. `…what's fusion using? 146 Andrew Trask` with
/// `next_name = "Andrew Trask"` → `…what's fusion using?`.
fn json_x_strip_trailing_next_name(body: &str, next_name: &str) -> String {
    let body = body.trim();
    if next_name.is_empty() {
        return body.to_string();
    }
    let mut tokens: Vec<&str> = body.split_whitespace().collect();
    let name_tokens: Vec<&str> = next_name.split_whitespace().collect();
    // Drop the trailing run that equals the next name's tokens (case-sensitive,
    // these are proper nouns), tolerating a comma the display-name split left.
    if tokens.len() > name_tokens.len()
        && tokens[tokens.len() - name_tokens.len()..]
            .iter()
            .zip(&name_tokens)
            .all(|(a, b)| a.trim_end_matches(',') == *b)
    {
        tokens.truncate(tokens.len() - name_tokens.len());
    }
    // Then strip a single trailing like-count token (`146`, `30`, `15`).
    while tokens
        .last()
        .is_some_and(|t| json_is_engagement_count_token(t))
    {
        tokens.pop();
    }
    tokens.join(" ")
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
            "post"
                | "quote"
                | "reply"
                | "views"
                | "view"
                | "quotes"
                | "relevant"
                | "·"
                | "show"
                | "replies"
                | "translation"
                | "·jun"
                | "grok"
                | "chat"
        ) || JSON_CHAT_TIMESTAMP_LINE_RE.is_match(w)
            || lw.ends_with('h') && lw.trim_end_matches('h').chars().all(|c| c.is_ascii_digit())
            || lw.ends_with('m') && lw.trim_end_matches('m').chars().all(|c| c.is_ascii_digit());
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
        " Show more",
        " Show this thread",
        " Show translation",
        " View quotes",
        " Replying to ",
        " Relevant people",
        " Live on X ",
        " · ",
    ] {
        if let Some(i) = s.find(cut) {
            s = &s[..i];
        }
    }
    json_cut_at_engagement_counts(&json_collapse_inline_ws(s))
}

/// Truncate an X tweet body at its engagement-count footer. After every tweet
/// X renders `<reply> <repost> <like> [<views>]` as a run of bare-number tokens,
/// immediately followed by the NEXT tweet's display-name words (the region
/// between two `@handle`s spans into the next author's name). Cutting at the
/// FIRST run of >=2 consecutive count tokens drops both the counts AND the
/// leaked next-author name in one move, so `…complex networks 2 5 85 8.3K Andrew
/// Trask` becomes `…complex networks`. Tweet prose effectively never contains
/// two bare numbers back-to-back, so this is safe. A trailing single count token
/// (`… what's fusion using? 146`) is also stripped.
fn json_cut_at_engagement_counts(body: &str) -> String {
    let tokens: Vec<&str> = body.split_whitespace().collect();
    // Find the first index where a run of >=2 consecutive count tokens begins.
    let mut cut = tokens.len();
    let mut idx = 0;
    while idx < tokens.len() {
        if json_is_engagement_count_token(tokens[idx]) {
            let run_end = tokens[idx..]
                .iter()
                .take_while(|t| json_is_engagement_count_token(t))
                .count();
            if run_end >= 2 {
                cut = idx;
                break;
            }
            idx += run_end;
        } else {
            idx += 1;
        }
    }
    let mut kept: Vec<&str> = tokens[..cut].to_vec();
    // Also strip a lone trailing count token (single like/quote tally).
    while kept
        .last()
        .is_some_and(|t| json_is_engagement_count_token(t))
    {
        kept.pop();
    }
    kept.join(" ")
}

fn json_is_engagement_count_token(token: &str) -> bool {
    let trimmed = token.trim_end_matches(['K', 'M', 'B']);
    !trimmed.is_empty()
        && trimmed.len() != token.len() // had a K/M/B suffix
        && trimmed.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | ','))
        || (!token.is_empty() && token.chars().all(|c| c.is_ascii_digit()))
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
            .map_or(trimmed.len(), |(i, _)| i);
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
    !focus.is_some_and(|focus_idx| json_contains_node(tree, node_idx, focus_idx))
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
        if best.is_none_or(|(_, best_len)| len > best_len) {
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
/// each known surface shape in turn (AI-chat role turns, then Messenger "by
/// Author:" markers, then X display-name/@handle positional attribution);
/// returns the original blob unchanged when none match, so a non-conversation
/// page is never corrupted.
fn json_attribute_flat_blob(blob: &str) -> String {
    if let Some(turns) = json_reconstruct_ai_chat_blob(blob) {
        return turns;
    }
    if let Some(turns) = json_reconstruct_messenger_blob(blob) {
        return turns;
    }
    if let Some(turns) = json_reconstruct_x_blob(blob) {
        return turns;
    }
    blob.to_string()
}

/// Role-label markers an AI chat (ChatGPT / Claude / Gemini / Copilot) renders
/// before each turn. ChatGPT exposes `You said:` / `ChatGPT said:`; Claude's real
/// app shape uses `You said:` / `Claude responded:` (and `<App> responded:`);
/// Gemini and Copilot may use a bare `You` / `<assistant>` label. The capture
/// group is the speaker label; the alternation flips between the user and the
/// assistant. The `said|responded` verb is part of the label so it is consumed
/// (never leaks into the body) and so a bare brand mention without the verb still
/// only matches when followed by a colon.
static JSON_AI_CHAT_ROLE_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"(?i)\b(You said|You|(?:ChatGPT|Claude|Gemini|Copilot|Assistant)(?:\s+(?:said|responded|replied))?)\s*:\s*",
    )
});

/// Classify an AI-chat role label into its canonical speaker name. `You` →
/// `User`; any assistant brand (with or without a `said`/`responded`/`replied`
/// verb) → `Assistant`. Returns `None` for a label that is not a recognized chat
/// role (so it never fabricates a turn).
fn json_ai_chat_role_speaker(label: &str) -> Option<&'static str> {
    let normalized = label
        .to_lowercase()
        .replace(" responded", "")
        .replace(" replied", "")
        .replace(" said", "")
        .trim()
        .to_string();
    match normalized.as_str() {
        "you" => Some("User"),
        "chatgpt" | "assistant" | "claude" | "gemini" | "copilot" => Some("Assistant"),
        _ => None,
    }
}

/// Per-turn UI chrome an AI chat (Claude / ChatGPT / Gemini) interleaves around
/// each message: the message-action toolbar (`Retry Edit Copy Read aloud …`), the
/// artifact/tool-use affordances (`View <artifact>`, `Download`, `Code · HTML`),
/// the per-response feedback row, the composer chrome, the model picker, and the
/// "is AI / can make mistakes" footer. A real AI-chat body never starts with one
/// of these phrases, so cutting each turn body at the FIRST occurrence of any of
/// them drops the trailing chrome that runs between this turn and the next role
/// marker. Lower-case search against a space-padded copy (so a phrase at the very
/// start of a chrome-only span is cut too).
const JSON_AI_CHAT_CHROME_CUTS: &[&str] = &[
    " retry edit copy",
    " read aloud",
    " give positive feedback",
    " give negative feedback",
    " copy code",
    " download copy",
    // Claude artifact card toolbar: `View <Artifact> <Artifact> Code · <lang>
    // Download Copy …`. The `Code · ` language tag is the stable anchor; cutting
    // there drops the whole artifact chrome run. The bare `View <name>` opener
    // (one line up) is handled by the standalone-line filter below.
    " code · ",
    " code \u{00b7} ",
    " download copy",
    " add files, connectors, and more",
    " add files and more",
    " ask anything",
    " ask chatgpt",
    " enter a prompt for gemini",
    " press and hold to record",
    " is ai and can make mistakes",
    " is ai. by using it",
    " can make mistakes",
    " your previous message wasn't sent",
    " your previous message was not sent",
    " learn more (opens in new tab)",
    " is currently unavailable",
    " show thinking",
    " good response",
    " bad response",
];

/// Whole low-signal AI-chat chrome lines/tokens that survive between role markers
/// (sidebar nav, the per-turn action buttons rendered as standalone words, the
/// thinking/tool-use status lines). Matched on a single collapsed body line.
static JSON_AI_CHAT_CHROME_LINE_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"(?ix)
        ^\s*(?:
            new\ chat | chats | projects | artifacts | customize
            | retry | edit | copy | share | files
            | read\ aloud
            | give\ (?:positive|negative)\ feedback
            | download | code(?:\ ·\ html)? | view\ \w+
            | press\ and\ hold\ to\ record
            | add\ files(?:,\ connectors,\ and\ more|\ and\ more)?
            | search\ chats | images | settings | help | close\ sidebar
            | skip\ to\ content | chat\ history | home | open\ sidebar
            | temporary\ chat | recents | library | notebooks
            | see\ plans\ and\ pricing | log\ in | sign\ up\ for\ free
            | what'?s\ on\ the\ agenda\ today\? | ask\ anything
            | enter\ a\ prompt\ for\ gemini
            | (?:claude|chatgpt|gemini)\ is\ ai.* | .*can\ make\ mistakes.*
            | learn\ more(?:\ \(opens\ in\ new\ tab\))? | .*is\ currently\ unavailable.*
            | your\ previous\ message\ (?:was\ ?n'?t|was\ not)\ sent.*
            | opus\ \d.* | gpt-?\d.* | press\ and\ hold.*
        )\s*$
    ",
    )
});

/// A trailing `… 1:33 AM` / `… 1:36 AM` per-turn timestamp Claude renders at the
/// end of a user message, and the trailing `View <Artifact>` artifact-card opener
/// (the line above the `Code · <lang>` toolbar). Both are stripped off the tail
/// of an AI-chat turn body after the chrome cut.
static JSON_AI_CHAT_TURN_TAIL_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r"(?i)(?:\s+\d{1,2}:\d{2}\s?[ap]m|\s+view(?:\s+\S+){0,3})\s*$"));

/// Cut an AI-chat turn body at the first interleaved chrome phrase, then drop any
/// remaining standalone chrome lines and the trailing per-turn timestamp /
/// artifact-card opener. `body` is the already-collapsed (single space, denoised)
/// turn text.
fn json_ai_chat_clean_body(body: &str) -> String {
    let lower = format!(" {}", body.to_lowercase());
    let mut cut_at = body.len() + 1; // +1 for the leading pad
    for cut in JSON_AI_CHAT_CHROME_CUTS {
        if let Some(i) = lower.find(cut) {
            cut_at = cut_at.min(i);
        }
    }
    // Map the padded offset back to the unpadded body (drop the 1-byte pad).
    let end = cut_at.saturating_sub(1).min(body.len());
    let head = &body[..end];
    // Drop any standalone chrome lines that survived the cut (chrome rendered as
    // its own line rather than a trailing run).
    let joined = head
        .split('\n')
        .filter(|line| !JSON_AI_CHAT_CHROME_LINE_RE.is_match(line))
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    // Strip a trailing per-turn timestamp / `View <artifact>` opener (applied
    // repeatedly: `… 1:33 AM` then a `View Uplinq` left behind by the `Code · `
    // cut both come off).
    let mut out = joined;
    loop {
        let trimmed = JSON_AI_CHAT_TURN_TAIL_RE.replace(&out, "").into_owned();
        if trimmed.len() == out.len() {
            break;
        }
        out = trimmed;
    }
    out.trim().to_string()
}

/// Collapse a `TitleTitle…` self-duplication Gemini renders for each recents /
/// sidebar entry (the full title immediately followed by a truncated copy ending
/// in `…`). Returns the de-duplicated head, or the input unchanged.
fn json_strip_truncation_echo(text: &str) -> String {
    // Split on the horizontal-ellipsis: a `<full> <prefix-of-full>…` echo has the
    // truncated copy as the tail; keep only the full leading copy.
    if let Some(idx) = text.find('\u{2026}') {
        let head = &text[..idx];
        // The truncated tail (after dropping the …) is a prefix of `head`; when so,
        // it is an echo — drop it. Compare on a compacted (space-free) basis.
        let tail = head.trim_end();
        if !tail.is_empty() {
            return tail.to_string();
        }
    }
    text.to_string()
}

/// True when a flat doc blob is a Gemini-style sidebar dump: the leading nav run
/// (`Gemini Temporary chat Close sidebar New chat …`) followed by a `Recents`
/// roster of past-conversation titles. Keyed on the co-occurring sidebar nav
/// markers so a real conversation blob (which has none of them) is never scrubbed.
fn json_blob_is_gemini_sidebar(blob: &str) -> bool {
    let lower = blob.to_lowercase();
    let markers = [
        "temporary chat",
        "close sidebar",
        "new chat",
        "search chats",
        "recents",
        "new notebook",
    ];
    markers.iter().filter(|m| lower.contains(**m)).count() >= 3
}

/// Scrub the Gemini sidebar/recents chrome out of a flat AI-chat doc blob that
/// carries NO role markers (the real `gemini.google.com` capture exposes the whole
/// app as one structureless `<doc>`). Cuts the leading nav prefix up to and
/// including the `Recents` roster header, drops the short `…`-truncated roster
/// titles, strips the trailing `Ask Gemini` / `Enter a prompt for Gemini`
/// placeholder + `Gemini can make mistakes` footer, and collapses each
/// `TitleTitle…` echo. Returns `None` when the blob is not a Gemini sidebar shape.
fn json_scrub_gemini_sidebar_blob(blob: &str) -> Option<String> {
    if !json_blob_is_gemini_sidebar(blob) {
        return None;
    }
    // Drop everything up to and including the `Recents` roster label — the prefix
    // is pure sidebar nav (Gemini Temporary chat Close sidebar New chat …) and the
    // pre-Recents titles are roster entries too.
    let after_recents = match blob.rfind("Recents ") {
        Some(i) => &blob[i + "Recents ".len()..],
        None => blob,
    };
    // Strip the trailing composer/footer chrome.
    let mut body = after_recents;
    for cut in [
        " Conversation with Gemini",
        " Ask Gemini",
        " Enter a prompt for Gemini",
        " Gemini can make mistakes",
        " Let's jump in",
    ] {
        if let Some(i) = body.find(cut) {
            body = &body[..i];
        }
    }
    // Collapse the `…`-truncation echoes the roster + prompt previews carry, drop
    // standalone chrome lines, and re-join. The blob is space-joined, so split on
    // the ellipsis-echo boundary first, then filter token runs that are chrome.
    let cleaned = json_collapse_inline_ws(
        &body
            .split('\u{2026}')
            .map(str::trim)
            .filter(|seg| !seg.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
    );
    let cleaned = json_strip_truncation_echo(&cleaned);
    // Drop the leading Recents-roster titles. Gemini renders the recents rail as a
    // run of short Title-Case past-conversation titles immediately after `Recents`
    // with NO structural boundary before the first real turn (its turns collapse
    // into one undelimited <doc> — see json_strip_gemini_recents_roster).
    let cleaned = json_strip_gemini_recents_roster(&cleaned);
    if cleaned.chars().count() < JSON_LANDMARK_MIN_CHARS {
        return None;
    }
    Some(cleaned)
}

/// Lowercase connector/function words that may appear *inside* a Title-Case
/// recents-roster title ("Ants `on` Food", "Models `on` Hugging Face", "Turning
/// `Off` AC `Before` Car", "Papaya Tree Health `and` Pests"). A lowercase word NOT
/// in this set signals the roster has ended and the free-text conversation (the
/// first real prompt) has begun.
const JSON_GEMINI_TITLE_CONNECTORS: &[&str] = &[
    "a", "an", "and", "the", "of", "on", "in", "to", "for", "is", "it", "as", "at", "or", "off",
    "before", "after", "with", "by", "vs", "via",
];

/// True when `word` reads like a token of a Title-Case recents-roster title: it
/// starts with an uppercase letter, a digit, or a non-Latin (CJK/etc.) script —
/// OR it is a lowercase connector word that legitimately appears inside a title.
/// Internal-capital CamelCase glue like "RumorsWhatsApp" (left by an un-split
/// truncation echo) starts uppercase and so still qualifies.
fn json_is_gemini_title_word(word: &str) -> bool {
    let cleaned = word.trim_matches(|c: char| !c.is_alphanumeric());
    let Some(first) = cleaned.chars().next() else {
        return false;
    };
    if first.is_uppercase() || first.is_ascii_digit() {
        return true;
    }
    // Non-Latin scripts have no case; treat them as title-ish (never a sentence
    // boundary signal). Only a *lowercase Latin* word can end the roster.
    if first.is_alphabetic() && !first.is_lowercase() {
        return true;
    }
    JSON_GEMINI_TITLE_CONNECTORS.contains(&cleaned.to_lowercase().as_str())
}

/// Drop the leading run of Recents-roster conversation titles from a Gemini doc
/// blob whose sidebar prefix has already been cut at `Recents`. The roster is a
/// space-joined run of short Title-Case titles with no delimiter before the first
/// real turn; we consume leading title-shaped words and stop at the first
/// lowercase non-connector word (the free-text prompt boundary). Conservative: if
/// no such boundary is found within the leading region the blob is returned
/// unchanged (never over-cut). Documented structural reality: Gemini collapses its
/// turns into ONE undelimited UIA <doc> node, so true per-turn `User:`/`Gemini:`
/// attribution is NOT recoverable — the only job here is to drop the recents-rail
/// noise, never to fabricate turns.
fn json_strip_gemini_recents_roster(blob: &str) -> String {
    let words: Vec<&str> = blob.split_whitespace().collect();
    if words.is_empty() {
        return blob.to_string();
    }
    // Walk the leading title run. The boundary is the first lowercase non-connector
    // word (e.g. "picture" in "a picture of a VR headset …").
    let mut boundary: Option<usize> = None;
    for (idx, word) in words.iter().enumerate() {
        if !json_is_gemini_title_word(word) {
            boundary = Some(idx);
            break;
        }
    }
    let Some(mut boundary) = boundary else {
        // The whole leading region is Title-Case: this is not a recognizable
        // roster/prompt split — leave it untouched rather than risk eating a real
        // (Title-Case) opening turn.
        return blob.to_string();
    };
    // Back up over any trailing lowercase connector words right before the boundary
    // (e.g. the leading article in "a picture of a VR headset …"): a roster title
    // never ends on a bare lowercase connector, so those belong to the first real
    // prompt, not the preceding title.
    while boundary > 0 {
        let prev = words[boundary - 1];
        let cleaned = prev.trim_matches(|c: char| !c.is_alphanumeric());
        if JSON_GEMINI_TITLE_CONNECTORS.contains(&cleaned.to_lowercase().as_str()) {
            boundary -= 1;
        } else {
            break;
        }
    }
    // Safety: only treat the leading run as a roster when it is plausibly a roster
    // (at least one title word) and the boundary lands inside a reasonable rail
    // span — a runaway boundary deep into the blob means the heuristic is unsure.
    if boundary == 0 {
        return blob.to_string();
    }
    let rest = words[boundary..].join(" ");
    if rest.chars().count() < JSON_LANDMARK_MIN_CHARS {
        // Dropping the roster would leave too little real content — keep the blob.
        return blob.to_string();
    }
    rest
}

/// The Discord per-user clan "Server Tag" badge (`Server Tag: CCO`, `Server Tag:
/// W00T`) that renders right under each author header AND in the DM member roster.
/// `JSON_FALSE_SPEAKER_PREFIX_RE` already stops it from becoming a speaker *line*,
/// but the real capture arrives as one space-joined `<doc>` blob (no newlines), so
/// each badge sits INLINE inside the turn stream and must be removed by an inline
/// replace. The clan tag value is a short alphanumeric token.
static JSON_DISCORD_SERVER_TAG_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r"(?i)\bServer Tag:\s*[A-Za-z0-9][A-Za-z0-9._-]{0,15}"));

/// Markers that open Discord's trailing user-profile card / popout chrome (the
/// block Discord renders after the last message when a user-profile flyout is
/// open): `View Full Profile` / `View Profile`, the `Add Note` field, the
/// `Originally known as` alias, and the profile-card stats `Member Since` /
/// `Mutual Servers` / `Mutual Friends`. The card is a contiguous trailing run, so
/// the blob is cut at the EARLIEST of these markers found in its tail.
const JSON_DISCORD_PROFILE_CARD_MARKERS: &[&str] = &[
    // composer / message affordance row that always trails the last message and
    // opens the chrome run leading into the profile card.
    "More message options Send GIF",
    "'s profile Friend",
    "View Full Profile",
    "View Profile",
    "Add Note (only visible to you)",
    "Originally known as",
    "Member Since",
    "Mutual Servers",
    "Mutual Friends",
];

/// True when a flat doc blob is a Discord page dump — keyed on the co-occurring
/// Discord-shell nav markers so a non-Discord blob (which carries none of them) is
/// never scrubbed by `json_scrub_discord_blob`.
fn json_blob_is_discord(blob: &str) -> bool {
    let lower = blob.to_lowercase();
    let markers = [
        "direct messages",
        "add a server",
        "find or start a conversation",
        "message requests",
        "server tag",
        "pinned messages",
    ];
    markers.iter().filter(|m| lower.contains(**m)).count() >= 2
}

/// Scrub Discord profile/badge chrome out of a flat (space-joined) `<doc>` blob:
/// (1) remove every inline `Server Tag: <CLAN>` clan-tag badge, and (2) cut the
/// trailing user-profile card (`… View Full Profile … Member Since … Mutual
/// Servers — 3 Mutual Friends — 3 View Full Profile`) at its earliest marker. The
/// profile card always sits after the last message, so cutting the tail at the
/// first profile-card marker found in the back half of the blob drops the whole
/// card without touching the conversation. Returns the blob unchanged when it is
/// not a Discord shape (so no other surface is affected).
fn json_scrub_discord_blob(blob: &str) -> String {
    if !json_blob_is_discord(blob) {
        return blob.to_string();
    }
    // (1) Strip inline `Server Tag: <CLAN>` badges wherever they appear.
    let badge_free = JSON_DISCORD_SERVER_TAG_RE.replace_all(blob, " ");
    let badge_free = json_collapse_inline_ws(&badge_free);
    // (2) Cut the trailing profile-card block. Only consider markers in the back
    // half of the blob so a message that merely mentions one of these phrases mid
    // conversation is never used as the cut point.
    let half = badge_free.len() / 2;
    let mut card_cut = badge_free.len();
    for marker in JSON_DISCORD_PROFILE_CARD_MARKERS {
        if let Some(i) = badge_free.find(marker) {
            if i >= half {
                card_cut = card_cut.min(i);
            }
        }
    }
    badge_free[..card_cut].trim().to_string()
}

/// Per-turn ChatGPT affordance chrome that interleaves the flat transcript blob
/// (the user-turn `Copy message`/`Edit message` and the assistant-turn `Copy
/// response`/`Good response`/`Bad response`/`Share`/`Switch model`/`More
/// actions`/`Sources` toolbar, plus the `Thought for 26s` reasoning header). These
/// run mid-blob (not just at the edges), so they are removed by a global replace.
static JSON_AI_CHAT_INLINE_CHROME_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(
        r"(?i)\s*\b(?:Copy message|Edit message|Copy response|Copy code|Copy link|Open conversation options|Good response|Bad response|Switch model|More actions|Read aloud|Thought for \d+\s*(?:s|sec|secs|seconds|m|min|mins|minutes)?)\b",
    )
});

/// True when a flat doc blob carries the unmistakable framing chrome of an AI-chat
/// page (the skip-link / composer / placeholder / footer that ONLY ChatGPT /
/// Claude / Gemini render). Gates the chrome trimmer so a normal pruned chat
/// thread (Discord / Slack / Gmail) — whose newline structure must be preserved —
/// is never collapsed.
fn json_blob_is_ai_chat_doc(blob: &str) -> bool {
    let lower = blob.to_lowercase();
    [
        "skip to content",
        "open sidebar",
        "ask anything",
        "add files and more",
        "enter a prompt for gemini",
        "can make mistakes",
        "press and hold to record",
        "copy response",
        "copy message",
    ]
    .iter()
    .any(|m| lower.contains(m))
}

/// Leading / trailing chrome runs an AI-chat doc (ChatGPT / Claude / Gemini)
/// wraps around the transcript when it is exposed as one flat `<doc>` with no role
/// markers: the page opens with `Skip to content Open sidebar …` and closes with
/// the composer (`Add files and more`), the placeholder (`Ask anything` / `Enter a
/// prompt for Gemini`), the model picker, and the `… can make mistakes` footer; it
/// also interleaves per-turn affordance chrome (`Copy message` / `Copy response` /
/// `Good response` …). These are stripped off the head/tail and the inline runs
/// removed. Returns the blob UNCHANGED (newlines intact) when it is not an AI-chat
/// doc, so the role-pruned chat threads (Discord / Slack / Gmail) keep their
/// per-turn line structure.
fn json_trim_ai_chat_doc_chrome(blob: &str) -> String {
    if !json_blob_is_ai_chat_doc(blob) {
        return blob.to_string();
    }
    let blob = JSON_AI_CHAT_INLINE_CHROME_RE.replace_all(blob, " ");
    let blob = json_collapse_inline_ws(&blob);
    let mut body = blob.trim();
    // Trailing chrome — cut at the EARLIEST trailing-chrome marker found.
    let mut tail_cut = body.len();
    for cut in [
        " Add files and more",
        " Add files, connectors, and more",
        " Ask anything",
        " Ask ChatGPT",
        " Enter a prompt for Gemini",
        " Message ChatGPT",
        " can make mistakes",
        " is AI and can make mistakes",
        " is AI. By using it",
        " Press and hold to record",
        " Share Sources",
    ] {
        if let Some(i) = body.find(cut) {
            tail_cut = tail_cut.min(i);
        }
    }
    body = body[..tail_cut].trim();
    // Leading chrome — drop a known nav/skip-link prefix.
    for cut in [
        "Skip to content Open sidebar Copy link Open conversation options ",
        "Skip to content Open sidebar ",
        "Skip to content Close sidebar ",
        "Skip to content ",
        "Open sidebar Copy link Open conversation options ",
    ] {
        if let Some(rest) = body.strip_prefix(cut) {
            body = rest.trim();
            break;
        }
    }
    body.to_string()
}

/// Reconstruct `User:` / `Assistant:` turns from an AI chat's flat conversation
/// blob (ChatGPT / Claude / Gemini / Copilot). These surfaces render alternating
/// role-labeled blocks — `You said: …` then `ChatGPT said: …` / `Claude
/// responded: …` — which the tree flattens into one TextPattern blob. We split on
/// each role-label marker and attribute the text up to the next marker, dropping
/// the interleaved UI chrome (action buttons, model picker, footer) and
/// collapsing the two-role alternation to the canonical `User` / `Assistant`
/// speakers. Requires at least one of each role so a page that merely contains
/// the brand name (e.g. a "ChatGPT:" footer) is never mistaken for a
/// conversation. Returns `None` otherwise.
fn json_reconstruct_ai_chat_blob(blob: &str) -> Option<String> {
    let markers: Vec<regex::Match<'_>> = JSON_AI_CHAT_ROLE_RE.find_iter(blob).collect();
    if markers.len() < 2 {
        return None;
    }
    // Resolve each marker to (speaker, body-span). Skip labels that are not a
    // recognized chat role.
    let mut entries: Vec<(&'static str, usize, usize)> = Vec::new();
    for (idx, m) in markers.iter().enumerate() {
        let caps = match JSON_AI_CHAT_ROLE_RE.captures(m.as_str()) {
            Some(c) => c,
            None => continue,
        };
        let Some(label) = caps.get(1) else { continue };
        let Some(speaker) = json_ai_chat_role_speaker(label.as_str()) else {
            continue;
        };
        let body_start = m.end();
        let body_end = markers.get(idx + 1).map_or(blob.len(), |next| next.start());
        if body_end > body_start {
            entries.push((speaker, body_start, body_end));
        }
    }
    // Require a genuine 2-role conversation: at least one User and one Assistant.
    let has_user = entries.iter().any(|(s, _, _)| *s == "User");
    let has_assistant = entries.iter().any(|(s, _, _)| *s == "Assistant");
    if !has_user || !has_assistant {
        return None;
    }
    let mut turns: Vec<String> = Vec::new();
    for (speaker, start, end) in entries {
        let collapsed = json_collapse_inline_ws(&denoise_for_llm(Some(&blob[start..end])));
        let body = json_ai_chat_clean_body(&collapsed);
        if body.chars().count() < 2 {
            continue;
        }
        turns.push(format!("{speaker}: {body}"));
    }
    if turns.len() < 2 {
        return None;
    }
    Some(json_dedupe_consecutive(turns).join("\n"))
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
        // A flat AI-chat doc (ChatGPT / Claude / Gemini) is emitted whole by the
        // pruner with the sidebar/composer chrome inline. Gemini additionally has
        // a Recents roster; strip that first, then trim the leading skip-link /
        // trailing composer + footer chrome common to all three. A non-AI-chat
        // blob (Gmail thread, GitHub issue) carries none of these phrases, so both
        // passes are no-ops and the pruned blob is returned unchanged.
        let screen = json_scrub_gemini_sidebar_blob(&pruned).unwrap_or(pruned);
        let screen = json_trim_ai_chat_doc_chrome(&screen);
        // Discord's flat page <doc> carries inline `Server Tag: <CLAN>` clan badges
        // and a trailing user-profile card (`Member Since` / `Mutual Servers` /
        // `View Full Profile`); strip both. A non-Discord blob is returned unchanged.
        let screen = json_scrub_discord_blob(&screen);
        return JsonPromptSection::text("screen", clip_head(&screen, JSON_MAX_LLM_CONTEXT_CHARS));
    }
    // AI chats (ChatGPT/Claude/Gemini) render the focused composer as a bare
    // `<doc>`/`<edit>` with the whole transcript as its TextPattern blob and no
    // separate content landmark — the pruner's compose-vs-thread guard then
    // (correctly, for X-compose) bails to empty. Before dumping raw axHtml, try
    // recovering `User:`/`Assistant:` role turns from the flattened tree text.
    let flattened = json_flatten_ax_text(snapshot.ax_html.as_deref());
    if let Some(turns) = json_reconstruct_ai_chat_blob(&flattened) {
        return JsonPromptSection::text("screen", clip_head(&turns, JSON_MAX_LLM_CONTEXT_CHARS));
    }
    // Outlook web exposes the ENTIRE mail app (left rail + inbox list + open
    // thread) as a single structureless `<doc>` TextPattern blob with no
    // per-message nodes and no focus marker — so the role pruner can't isolate the
    // thread, and dumping the raw axHtml would leak the inbox list (+ any OTP /
    // sign-in rows). The composer's `textBefore` carries the SAME content but with
    // real per-row newlines, so scrub THAT row-by-row instead (cut the inbox-list
    // scrollback, drop the message-action chrome + OTP rows) and emit the open
    // thread as `screen`.
    if let Some(scrubbed) = json_scrub_mail_blob(&denoise_for_llm(snapshot.text_before.as_deref()))
    {
        return JsonPromptSection::text("screen", clip_head(&scrubbed, JSON_MAX_LLM_CONTEXT_CHARS));
    }
    JsonPromptSection::text("screen", json_trim_or_empty(snapshot.ax_html.as_deref()))
}

/// Flatten an axHtml tree to its visible text (every node's name + text, in
/// document order, denoised). Used as the AI-chat reconstruction input when the
/// role-based pruner declines to emit a landmark.
fn json_flatten_ax_text(ax_html: Option<&str>) -> String {
    let ax_html = ax_html.unwrap_or("").trim();
    if ax_html.is_empty() {
        return String::new();
    }
    let tree = json_parse_ax_html(ax_html);
    let mut out = Vec::new();
    json_collect_descendant_text_values(&tree, 0, &mut out);
    denoise_for_llm(Some(&out.join(" ")))
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
/// reading pane / X article / Outlook mail) but never in a real typed draft. Kept
/// lowercase. The Outlook block mirrors the Gmail one: its left-rail folder names
/// plus the message-list sort markers prove the caret range spans the whole mail
/// app (not a draft), so the formatter reroutes to the pruned tree path.
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
    // Outlook web (outlook.live.com / outlook.office.com) folder + list chrome.
    "junk email",
    "sent items",
    "deleted items",
    "archive",
    "favorites",
    "conversation history",
    "navigation pane",
    "sorted: by date",
    "focused",
    "other emails",
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
    // Facebook Messenger embeds authorship as `Enter, Message sent <when> by
    // <Author>: <body>` markers in the composer's RAW (newline-preserved)
    // `textBefore`. Reconstruct from that raw text — NOT the denoised blob —
    // because denoising strips the `￼` (U+FFFC) preview separators and the
    // per-message newlines the body-bleed dedup relies on, and it lets
    // attachment-only markers (no colon) collapse onto the next clock. When it
    // yields clean `Author: body` turns, emit them as the thread `screen`.
    if let Some(turns) =
        json_reconstruct_messenger_blob(snapshot.text_before.as_deref().unwrap_or(""))
    {
        sections.push(JsonPromptSection::text(
            "screen",
            clip_head(&turns, JSON_MAX_LLM_CONTEXT_CHARS),
        ));
        sections.push(json_build_clipboard_section(snapshot));
        return json_serialize_context(sections);
    }

    // The Discord stream reconstructor keys on `<author>/<timestamp>/<body>`
    // grouping — but a mail app's message-list (Outlook / Gmail) has the SAME
    // shape (a repeated sender name + a `Mon 6/12 12:00 PM` timestamp per row), so
    // it would fabricate `Sender: row` turns from the inbox list. When the caret
    // is page-spanning scrollback AND a tree is present, the role-based tree
    // pruner is the clean signal, so the flat Discord reconstruction must NOT run
    // (the reroute below sends it to `screen`). A real Discord composer has no
    // page-nav markers and no scrollback tree, so it still reaches this path.
    let reconstructed_chat = denoise_for_llm(snapshot.text_before.as_deref());
    if !(has_tree && caret_is_scrollback) {
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
        match serde_json::from_str(out) {
            Ok(value) => value,
            Err(err) => panic!("context output should parse as JSON: {err}; output: {out}"),
        }
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
        assert!(
            screen.contains("Saker: Everyone thought Brazil"),
            "{screen}"
        );
        assert!(screen.contains("Thamer: What hurts"), "{screen}");
        // beforeCaret with nav/counts must be gone
        assert!(ctx.get("beforeCaret").is_none(), "{out}");
        assert!(!out.contains("232.9K"), "engagement count leaked: {out}");
        assert!(!out.contains("Show translation"), "chrome leaked: {out}");
        assert!(!out.contains("@Dahshury"), "self identity leaked: {out}");
        assert!(
            !screen.contains("Who to follow"),
            "right column leaked: {screen}"
        );
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
            ax_html: Some(
                "<window name=\"Discord\"><edit name=\"Message @Fancy\" focus=\"1\"/></window>"
                    .into(),
            ),
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
            !screen
                .lines()
                .any(|l| l.trim_start().starts_with("قوله تعالى:")),
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
            !screen
                .lines()
                .any(|l| l.trim_start().starts_with("The short reason:")),
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
        assert!(
            !out.contains("Cousin Omar:"),
            "fabricated chat-list speaker: {out}"
        );
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
        assert!(!json_is_speaker_turn_line(
            "The short reason: combinations win"
        ));
        assert!(!json_is_speaker_turn_line("Replying to: @someone"));
        assert!(!json_is_speaker_turn_line("قوله تعالى: ماتعبدون"));
    }

    // ─────────── real-capture chrome scrubbing (discord / gemini) ───────────
    //
    // The slices below are lifted verbatim from the actual captured `<doc>` blobs
    // in artifacts/context-cdp/{discord,gemini}/rawSnapshot.json — the exact flat
    // (space-joined, no-newline) shapes the extractor must strip.

    /// On the real Discord capture the page arrives as ONE space-joined `<doc>`
    /// blob, so the per-user `Server Tag: <CLAN>` clan badge and the trailing
    /// user-profile card (`Member Since` / `Mutual Servers` / `View Full Profile`)
    /// sit inline and survive the line filters. `json_scrub_discord_blob` removes
    /// both. Slice lifted verbatim from artifacts/context-cdp/discord/rawSnapshot.
    #[test]
    fn discord_blob_scrub_drops_server_tag_and_profile_card() {
        let blob = "Direct Messages Create Message !Evirios! Fancy FLX MO PriNce OoS \
            anaskame1 Pacok Jake Edvin Server Tag: CCO Home Dachi Speranski Pinned Messages \
            Master Server Tag: W00T 6/13/26, 1:13 AM but I didn't make the websites \
            !Evirios! Yesterday at 10:18 PM yeah on 15k$ tourney grandfinals ek \
            More message options Send GIF !Evirios!'s profile Friend More View Full Profile \
            !Evirios! Add Note (only visible to you) evirios Originally known as !Evirios!#1950 \
            Bio . Member Since Mar 12, 2017 Mutual Servers — 3 Mutual Friends — 3 View Full Profile";
        let out = json_scrub_discord_blob(blob);
        // Every Server Tag clan badge is gone (it appears twice in the real blob).
        assert!(
            !out.contains("Server Tag"),
            "Server Tag badge leaked: {out}"
        );
        // The whole trailing profile card is cut.
        assert!(!out.contains("Member Since"), "profile card leaked: {out}");
        assert!(
            !out.contains("Mutual Servers"),
            "profile card leaked: {out}"
        );
        assert!(
            !out.contains("Mutual Friends"),
            "profile card leaked: {out}"
        );
        assert!(
            !out.contains("View Full Profile"),
            "profile card leaked: {out}"
        );
        assert!(
            !out.contains("Originally known as"),
            "profile card leaked: {out}"
        );
        // The real conversation survives untouched.
        assert!(out.contains("but I didn't make the websites"));
        assert!(out.contains("yeah on 15k$ tourney grandfinals ek"));
        // A non-Discord blob is returned unchanged.
        let other = "Subject: Q3 plan To me Sat 2:07 PM Hi team, here is the plan.";
        assert_eq!(json_scrub_discord_blob(other), other);
    }

    /// End-to-end through `format_context_for_prompt`: the real Discord `axHtml`
    /// doc must yield a `screen` with no `Server Tag` badge and no profile card.
    #[test]
    fn discord_screen_has_no_server_tag_or_profile_card() {
        let ax = "<window name=\"Discord\" focus=\"1\"><pane name=\"Discord\">\
            <doc name=\"Discord\"> Direct Messages Find or start a conversation \
            Friends Message Requests Add a Server Pinned Messages \
            Master Server Tag: W00T 6/13/26, 1:13 AM Saturday, June 13, 2026 at 1:13 AM \
            but I didn't make the websites 1:13 AM I just used them \
            !Evirios! 6/13/26, 1:19 AM Saturday, June 13, 2026 at 1:19 AM Yeah after nod that's cool \
            Master Server Tag: W00T Yesterday at 10:17 PM hw show off? \
            More message options Send GIF !Evirios!'s profile Friend More View Full Profile \
            evirios Originally known as !Evirios!#1950 Member Since Mar 12, 2017 \
            Mutual Servers — 3 Mutual Friends — 3 View Full Profile </doc></pane></window>";
        let s = WindowContextSnapshot {
            window_title: "(1155) Discord | @!Evirios! - Google Chrome".into(),
            element_name: "(1155) Discord | @!Evirios! - Google Chrome".into(),
            app_exe: Some("chrome.exe".into()),
            ax_html: Some(ax.into()),
            ..snap()
        };
        let screen = screen_text(s);
        assert!(!screen.is_empty(), "screen unexpectedly empty");
        assert!(
            !screen.contains("Server Tag"),
            "Server Tag leaked: {screen}"
        );
        assert!(
            !screen.contains("Member Since"),
            "profile card leaked: {screen}"
        );
        assert!(
            !screen.contains("Mutual Friends"),
            "profile card leaked: {screen}"
        );
        assert!(
            !screen.contains("View Full Profile"),
            "profile card leaked: {screen}"
        );
        assert!(screen.contains("but I didn't make the websites"));
    }

    /// The real Gemini capture exposes the whole app as ONE undelimited `<doc>`
    /// (per-turn `User:`/`Gemini:` attribution is structurally NOT recoverable from
    /// UIA — see the function docs); the only job is to drop the leading Recents
    /// rail. `json_scrub_gemini_sidebar_blob` must remove the roster titles and keep
    /// the first real prompt. Slice lifted verbatim from
    /// artifacts/context-cdp/gemini/rawSnapshot.json.
    #[test]
    fn gemini_sidebar_scrub_drops_recents_roster_keeps_first_prompt() {
        // Sidebar nav head + Recents roster + first real prompt, verbatim shapes
        // (incl. the `TitleTitle…` truncation echo Gemini renders per entry).
        let blob = "Gemini Temporary chat Close sidebar New chat Search chats Images New \
            Videos Library Notebooks New notebook \
            Recents Coffee Vending Machines Explained Queue Management System Explained \
            Ants on Food: Is It Safe? Text Formatting Models on Hugging Face \
            RTX 50 Series Laptop Pricing Turning Off AC Before Car Papaya Tree Health and Pests \
            WhatsApp Premium Subscription Rumors\u{2026} AI Coding Language Performance \
            a picture of a VR headset as an app icon with a speech visualizer inside it, \
            dynamic lighting, mascot Enter a prompt for Gemini Gemini can make mistakes";
        let out = json_scrub_gemini_sidebar_blob(blob).expect("gemini sidebar shape");
        // Every recents-roster title is gone.
        for title in [
            "Recents",
            "Coffee Vending Machines Explained",
            "Queue Management System Explained",
            "Papaya Tree Health and Pests",
            "RTX 50 Series Laptop Pricing",
            "WhatsApp Premium Subscription Rumors",
            "AI Coding Language Performance",
        ] {
            assert!(
                !out.contains(title),
                "recents roster leaked {title:?}: {out}"
            );
        }
        // The first real prompt survives, leading article intact (not over-trimmed).
        assert!(
            out.starts_with("a picture of a VR headset as an app icon"),
            "first prompt lost / over-trimmed: {out}"
        );
        // Trailing composer/footer chrome is dropped.
        assert!(
            !out.contains("Enter a prompt for Gemini"),
            "footer leaked: {out}"
        );
        assert!(!out.contains("can make mistakes"), "footer leaked: {out}");
    }

    /// The roster-strip is conservative: a blob with no lowercase-prompt boundary
    /// (all Title-Case) is returned unchanged so a real Title-Case opening turn is
    /// never eaten, and a connector-only/empty input is a no-op.
    #[test]
    fn gemini_recents_roster_strip_is_conservative() {
        // No lowercase non-connector boundary → unchanged.
        let all_titles = "Coffee Vending Machines Explained Queue Management System Explained";
        assert_eq!(json_strip_gemini_recents_roster(all_titles), all_titles);
        // Empty / whitespace → unchanged.
        assert_eq!(json_strip_gemini_recents_roster(""), "");
        // Boundary at index 0 (starts lowercase) → unchanged (nothing to strip).
        let starts_lower = "a picture of a VR headset as an app icon with a visualizer";
        assert_eq!(json_strip_gemini_recents_roster(starts_lower), starts_lower);
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

    // ───── focused-field (--split) dictation capture — competitor parity ─────
    //
    // The dictation pipeline captures with `ContextMode::Split`: the focused
    // field's caret-aware text + app identity, and NO `axHtml` (no whole-window
    // tree walk). The fragment must stay a clean focused-field shape — never the
    // old `screen` tree dump that leaked sidebars / inbox rows.

    #[test]
    fn split_dictation_capture_is_clean_focused_field() {
        // A Gmail reply: the draft sits in beforeCaret, the quoted thread in
        // afterCaret (so "reply to this" context survives within the field),
        // app identity comes from app/url/window — and there is NO tree `screen`.
        let reader = FakeReader(WindowContextSnapshot {
            window_title: "Inbox (3) - me@example.com - Gmail".into(),
            element_name: "Message Body".into(),
            text_before: Some("Hi Dana, thanks for the update. ".into()),
            text_after: Some("On Mon, Jun 15, Dana Lee wrote: see the attached draft.".into()),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://mail.google.com/mail/u/0/".into()),
            ..snap()
        });
        let out = capture_prompt_fragment(
            &reader,
            ContextMode::Split,
            ContextAppMode::AllExceptDenied,
            &[],
            &[],
        );
        let ctx = context_json(&out);
        assert_eq!(ctx["app"], "chrome.exe");
        assert_eq!(ctx["url"], "https://mail.google.com/mail/u/0/");
        assert!(ctx["window"].as_str().unwrap_or("").contains("Gmail"));
        assert!(ctx["beforeCaret"]
            .as_str()
            .unwrap_or("")
            .contains("thanks for the update"));
        assert!(ctx["afterCaret"]
            .as_str()
            .unwrap_or("")
            .contains("Dana Lee wrote"));
        // The focused-field path must NOT emit a whole-window tree dump.
        assert!(
            ctx.get("screen").is_none(),
            "focused-field capture must not emit a tree `screen`: {out}"
        );
    }

    #[test]
    fn split_dictation_capture_url_deny_list_still_redacts() {
        // The host-based privacy deny-list must keep working on the focused-field
        // (--split) path now that --split carries the url. A banking host →
        // redacted to bare metadata, field text dropped.
        let reader = FakeReader(WindowContextSnapshot {
            window_title: "Transfer funds".into(),
            element_name: "Amount".into(),
            text_before: Some("move 5000 to savings".into()),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://secure.bankofamerica.com/transfer".into()),
            ..snap()
        });
        let out = capture_prompt_fragment(
            &reader,
            ContextMode::Split,
            ContextAppMode::AllExceptDenied,
            &["bankofamerica.com".into()],
            &[],
        );
        assert!(
            !out.contains("move 5000 to savings"),
            "denied-host field text leaked: {out}"
        );
        let ctx = context_json(&out);
        assert_eq!(ctx["window"], "Transfer funds");
    }

    // ───────── real-capture speaker attribution (who-said-what) ─────────
    //
    // Each fixture below is a representative slice of the ACTUAL captured tree in
    // artifacts/context-cdp/<app>/rawSnapshot.json — the exact UI shapes the
    // extractor must attribute correctly (or filter as false speakers).

    fn before_caret_text(snapshot: WindowContextSnapshot) -> String {
        let out = format_context_for_prompt(&snapshot);
        context_json(&out)["beforeCaret"]
            .as_str()
            .unwrap_or("")
            .to_string()
    }

    /// The Discord "Server Tag: CCO" clan-tag badge (renders right under a user
    /// header) must NEVER become an `Author:` speaker line — it is a per-user
    /// badge, not a sender. Shape lifted from the real Discord friends-page doc.
    #[test]
    fn discord_server_tag_badge_is_not_a_speaker() {
        assert!(JSON_FALSE_SPEAKER_PREFIX_RE.is_match("Server Tag: CCO"));
        assert!(!json_is_speaker_turn_line("Server Tag: CCO"));
        // And in a real flat blob the badge is plain roster text, never a turn.
        let blob = "anaskame1 Pacok Jake Edvin Server Tag: CCO Home Dachi Speranski";
        assert_eq!(json_attribute_flat_blob(blob), blob);
        assert!(!blob
            .lines()
            .any(|l| json_is_speaker_turn_line(l) && l.starts_with("Server Tag")));
    }

    /// Discord renders a real message group as `<Author>` / [`Server Tag: X`] /
    /// `<H:MM AM>` / `<full datetime>` / `<body…>`. The username heads the group;
    /// the Server-Tag badge under it must be dropped, not treated as the author.
    #[test]
    fn discord_thread_attributes_username_not_server_tag() {
        let stream = [
            "Maya",
            "Server Tag: CCO",
            "9:41 AM",
            "Today at 9:41 AM",
            "The Windows build still needs signing.",
            "Chris",
            "Server Tag: CCO",
            "9:43 AM",
            "Today at 9:43 AM",
            "I uploaded the cert bundle.",
        ]
        .join("\n");
        let s = WindowContextSnapshot {
            window_title: "Discord | #release".into(),
            element_name: "Message #release".into(),
            app_exe: Some("chrome.exe".into()),
            text_before: Some(stream),
            ..snap()
        };
        let before = before_caret_text(s);
        assert!(before.contains("Maya: The Windows build still needs signing."));
        assert!(before.contains("Chris: I uploaded the cert bundle."));
        // The clan-tag badge is gone and never attributed.
        assert!(!before.contains("Server Tag"));
        assert!(!before.contains("Server Tag: CCO"));
    }

    /// Facebook Messenger embeds authorship as `Enter, Message sent <when> by
    /// <Author>: <body>` with the body ALSO previewed before the marker. The
    /// reconstructor must (1) attribute each turn to its real author, (2) not let
    /// one turn's body bleed into the next preview, and (3) keep a Quran-verse
    /// "قوله تعالى:" line as a BODY of its sender — never as a fabricated speaker.
    /// Shape lifted verbatim from the real facebook/rawSnapshot.json textBefore.
    #[test]
    fn messenger_by_author_marker_attributes_turns_without_bleed() {
        let text = concat!(
            "السلام عليكم\n\u{fffc}\n",
            "Enter, Message sent Saturday 5:14am by سول: السلام عليكم\n",
            "صباح الخير\n\u{fffc}\n",
            "Enter, Message sent Saturday 5:14am by سول: صباح الخير\n",
            "وعليكم السلام ورحمة الله وبركاته شكرا ياعمورة على الدعوة الصباحية الجميلة\n\u{fffc}\n",
            "Enter, Message sent Saturday 8:15am by موه: وعليكم السلام ورحمة الله وبركاته شكرا ياعمورة على الدعوة الصباحية الجميلة\n",
            "قوله تعالى: ﴿أَمْ كُنتُمْ شُهَدَاءَ﴾\n\u{fffc}\n",
            "Enter, Message sent Saturday 9:23am by موه: قوله تعالى: ﴿أَمْ كُنتُمْ شُهَدَاءَ﴾\n",
            "Compose\nOpen more actions\nWrite to ماما\n"
        );
        let s = WindowContextSnapshot {
            window_title: "Messenger | Facebook - Google Chrome".into(),
            element_name: "Write to ماما".into(),
            app_exe: Some("chrome.exe".into()),
            text_before: Some(text.into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
        // Each message attributed to its real author.
        assert!(screen.contains("سول: السلام عليكم"));
        assert!(screen.contains("سول: صباح الخير"));
        assert!(screen.contains("موه: وعليكم السلام"));
        // The first سول turn must NOT have swallowed the next preview line.
        assert!(!screen.contains("سول: السلام عليكم صباح الخير"));
        // The Quran verse is a BODY of موه, not a standalone "قوله تعالى:" speaker.
        assert!(screen.contains("موه: قوله تعالى:"));
        assert!(!screen.contains("\nقوله تعالى:"));
        // The trailing composer toolbar chrome never leaks into a turn.
        assert!(!screen.contains("Compose"));
        assert!(!screen.contains("Open more actions"));
        assert!(!screen.contains("Write to ماما"));
    }

    /// X (Twitter) reply page: no `Author:` prefix — each tweet is positionally
    /// `<DisplayName> @handle [time] <body> <engagement-counts>`. The
    /// reconstructor attributes by handle, strips the trailing count run, and must
    /// not fuse the NEXT author's display name onto a body. Shape from the real
    /// x-reply/rawSnapshot.json doc blob; "The short reason:" is body text, not a
    /// speaker. The whole-blob flows through the doc-landmark + flat-attribution
    /// path, so this drives format_context_for_prompt end-to-end.
    #[test]
    fn x_reply_attributes_by_handle_and_strips_counts() {
        let doc = concat!(
            "Conversation ",
            "Andrew Trask @iamtrask ",
            "This is a way bigger deal than it seems. The short reason: combinations of models will always outperform individual models ",
            "Quote OpenRouter @OpenRouter 20h Introducing the Fusion API ",
            "7:59 AM Jun 14, 2026 563.4K Views 148 237 2.8K 2.3K Relevant View quotes Replying to @iamtrask Post your reply ",
            "Trevor I. Lasn @trevorlasn 4h yeah different models miss different things so ensembling cancels the errors. what is fusion using? 146 ",
            "Christian Niven @christian_niven 6h No it is not. I do not understand how you were fooled by this marketing. 2 1 305 ",
            "Relevant people Andrew Trask @iamtrask Follow Live on X العربية is hosting trending"
        );
        // Real X-reply shape: the conversation is a flat `<doc>` content landmark
        // (page-spanning TextPattern blob, no per-tweet nodes) and the focused
        // composer is a sibling `<edit>` — so the landmark resolver picks the doc
        // and routes it through the flat positional @handle attribution path.
        let s = WindowContextSnapshot {
            window_title: "Andrew Trask on X - Google Chrome".into(),
            element_name: "Post text".into(),
            app_exe: Some("chrome.exe".into()),
            ax_html: Some(format!(
                r#"<pane name="X"><doc name="Conversation">{doc}</doc><edit name="Post text" focus="1"></edit></pane>"#
            )),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
        assert!(
            screen.contains("Andrew Trask: This is a way bigger deal"),
            "{screen}"
        );
        assert!(
            screen.contains("Trevor I. Lasn: yeah different models miss"),
            "{screen}"
        );
        assert!(
            screen.contains("Christian Niven: No it is not."),
            "{screen}"
        );
        // "The short reason:" stays inside Andrew Trask's body, not a speaker line.
        assert!(!screen.contains("\nThe short reason:"));
        // Trailing engagement counts and the next author's name are stripped.
        assert!(!screen.contains("146 Christian"));
        assert!(!screen.contains("305 Relevant"));
        assert!(!screen.contains("2 1 305"));
        // The post-thread footer (Relevant people / Live on X / trending) is cut.
        assert!(!screen.contains("Live on X"));
        assert!(!screen.contains("Relevant people"));
    }

    /// An AI chat (ChatGPT/Claude/Gemini) renders alternating role-labeled blocks
    /// (`You said:` / `ChatGPT said:`). They must collapse to a clean two-role
    /// `User:` / `Assistant:` alternation so the LLM sees who said what.
    #[test]
    fn ai_chat_collapses_to_user_assistant_turns() {
        let doc = "ChatGPT You said: How do I reverse a string in Rust? \
            ChatGPT said: Call chars rev collect on the input. \
            You said: Does that handle Unicode correctly? \
            ChatGPT said: It reverses by Unicode scalar values so most text is fine.";
        let s = WindowContextSnapshot {
            window_title: "ChatGPT - Google Chrome".into(),
            element_name: "Ask anything".into(),
            app_exe: Some("chrome.exe".into()),
            url: Some("https://chatgpt.com/c/abc".into()),
            ax_html: Some(format!(
                r#"<window name="ChatGPT"><doc name="ChatGPT" focus="1">{doc}</doc></window>"#
            )),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
        assert!(screen.contains("User: How do I reverse a string in Rust?"));
        assert!(screen.contains("Assistant: Call chars rev collect"));
        assert!(screen.contains("User: Does that handle Unicode correctly?"));
        assert!(screen.contains("Assistant: It reverses by Unicode scalar values"));
        // The brand label never survives as a speaker; only User/Assistant do.
        assert!(!screen.contains("ChatGPT:"));
        assert!(!screen.contains("You said:"));
    }

    /// A page that merely MENTIONS an assistant brand (a "ChatGPT:" footer link)
    /// without a real two-role exchange must NOT be mistaken for a conversation.
    #[test]
    fn ai_chat_requires_both_roles() {
        // Only an assistant label, no "You" — not a conversation.
        assert!(json_reconstruct_ai_chat_blob(
            "ChatGPT: the smartest model. Gemini: also great. Footer links here."
        )
        .is_none());
        // Only a user label — not a conversation either.
        assert!(json_reconstruct_ai_chat_blob("You: typed this. Some other text here.").is_none());
    }

    /// Generic false-speaker guard: a `prefix:` whose prefix is a sentence
    /// fragment, a known UI string, or a scripture/quote opener must be filtered,
    /// while genuine display names (incl. non-Latin and `You`) are kept.
    #[test]
    fn false_speaker_prefixes_are_filtered() {
        // False speakers (UI badges, sentence fragments, scripture openers).
        for line in [
            "Server Tag: CCO",
            "The short reason: combinations of models win",
            "Replying to: @someone",
            "Original message: text",
            "قوله تعالى: ﴿آية﴾",
        ] {
            assert!(
                !json_is_speaker_turn_line(line),
                "{line:?} must NOT be a speaker turn"
            );
        }
        // Genuine speakers.
        for line in [
            "Maya: the build needs signing",
            "You: I will ship it",
            "علي: تمام يا باشا",
            "Trevor I. Lasn: ensembling cancels the errors",
        ] {
            assert!(
                json_is_speaker_turn_line(line),
                "{line:?} SHOULD be a speaker turn"
            );
        }
    }

    /// A sentence fragment ending the body that ALSO ends in a colon (e.g. an
    /// over-long prefix) is rejected by the >40-char / sentence-shape guard so it
    /// never fabricates a speaker out of mid-sentence text.
    #[test]
    fn over_long_or_sentence_prefix_is_not_a_speaker() {
        let long = "This is a very long sentence fragment that clearly is not a chat author name at all: body";
        assert!(!json_is_speaker_turn_line(long));
        // A prefix carrying terminal sentence punctuation is not a name.
        assert!(!json_looks_like_author_header(
            "but anyway, that is the whole point."
        ));
    }

    // ─────────── REAL CAPTURE shapes: AI chat + Outlook attribution ───────────
    //
    // The fixtures below are lifted VERBATIM from the on-disk captures in
    // artifacts/context-cdp/{claude,gemini,chatgpt,outlook}/rawSnapshot.json (the
    // axHtml `<doc>` blob / the composer `textBefore`). They pin the four problem
    // shapes the finalize-attribution pass had to fix.

    /// Claude (artifacts/context-cdp/claude): the real app renders the transcript
    /// as `You said: …` / `Claude responded: …` app literals inside one flat
    /// `<doc>` TextPattern blob, surrounded by heavy UI chrome (the sidebar nav,
    /// the per-turn `Retry Edit Copy / Read aloud / Give positive feedback`
    /// toolbar, the artifact card `View <name> … Code · HTML Download Copy`, the
    /// composer + model picker, the `Claude is AI and can make mistakes` footer,
    /// and a `Your previous message wasn't sent` notice). The reconstruction must
    /// collapse to `User:` / `Assistant:` and filter ALL of that chrome.
    #[test]
    fn claude_real_doc_collapses_to_user_assistant_and_drops_chrome() {
        // Verbatim slice of the real claude/rawSnapshot.json axHtml `<doc>` text.
        let doc = "New chat Chats Projects Artifacts Customize M Mostafa Max plan \
            HTML CSS pixel perfect clone More options for HTML CSS pixel perfect clone \
            You said: clone this in html css pixel perfect clone this in html css pixel perfect \
            1:33 AM Retry Edit Copy \
            Claude responded: This is a faithful clone task—the brief pins down everything. \
            Architected pixel-perfect HTML/CSS layout with dark theme and chart \
            Done. Single-file uplinq.html — two-column dark panel, mint headline. \
            View Uplinq Uplinq Code · HTML Download Copy Read aloud Give positive feedback \
            Give negative feedback Retry \
            You said: not exact. not exact. edge highlights of the main card missing \
            1:36 AM Retry Edit Copy \
            Claude responded: Found the gaps. The original has a bright top-edge highlight. \
            View Uplinq Uplinq Code · HTML Download Copy Read aloud Give positive feedback \
            Give negative feedback Retry Claude Fable 5 is currently unavailable. \
            Learn more (opens in new tab) \
            Add files, connectors, and more Opus 4.8 High Press and hold to record \
            Claude is AI and can make mistakes. Please double-check responses. Files Share \
            Your previous message wasn't sent. You can try again. Close";
        let s = WindowContextSnapshot {
            window_title: "HTML CSS pixel perfect clone - Claude - Google Chrome".into(),
            element_name: "Write your prompt to Claude".into(),
            app_exe: Some("chrome.exe".into()),
            ax_html: Some(format!(
                r#"<window name="HTML CSS pixel perfect clone - Claude - Google Chrome"><doc name="HTML CSS pixel perfect clone - Claude" focus="1">{doc}</doc></window>"#
            )),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
        // Collapsed to the canonical two roles.
        assert!(
            screen.contains("User: clone this in html css pixel perfect"),
            "{screen}"
        );
        assert!(
            screen.contains("Assistant: This is a faithful clone task"),
            "{screen}"
        );
        assert!(screen.contains("User: not exact."), "{screen}");
        assert!(screen.contains("Assistant: Found the gaps."), "{screen}");
        // App literals never survive as speaker labels.
        assert!(!screen.contains("You said:"), "{screen}");
        assert!(!screen.contains("Claude responded:"), "{screen}");
        // Every named chrome run is filtered.
        for chrome in [
            "New chat Chats Projects",
            "Retry Edit Copy",
            "Read aloud",
            "Give positive feedback",
            "Give negative feedback",
            "Add files, connectors, and more",
            "Opus 4.8",
            "Press and hold to record",
            "Claude is AI and can make mistakes",
            "double-check responses",
            "Your previous message wasn't sent",
            "Code · HTML",
            "Download Copy",
            "View Uplinq",
            "is currently unavailable",
        ] {
            assert!(
                !screen.contains(chrome),
                "chrome leaked ({chrome}): {screen}"
            );
        }
        // Per-turn timestamps are stripped off the user-message tails.
        assert!(!screen.contains("1:33 AM"), "{screen}");
        assert!(!screen.contains("1:36 AM"), "{screen}");
    }

    /// The role regex matches the real Claude / ChatGPT verbs and the speaker
    /// classifier collapses them, but a bare brand mention WITHOUT a colon (the
    /// `Claude is AI and can make mistakes` footer) is never a role marker.
    #[test]
    fn ai_chat_role_markers_match_real_verbs_only_with_colon() {
        assert_eq!(json_ai_chat_role_speaker("You said"), Some("User"));
        assert_eq!(
            json_ai_chat_role_speaker("Claude responded"),
            Some("Assistant")
        );
        assert_eq!(json_ai_chat_role_speaker("ChatGPT said"), Some("Assistant"));
        assert_eq!(
            json_ai_chat_role_speaker("Gemini replied"),
            Some("Assistant")
        );
        assert_eq!(json_ai_chat_role_speaker("Random label"), None);
        // A bare brand WITHOUT a colon is not a marker (footer text is not a turn).
        assert!(json_reconstruct_ai_chat_blob(
            "Claude is AI and can make mistakes. Please double-check responses."
        )
        .is_none());
    }

    /// Claude/ChatGPT collapse also covers the `ChatGPT said:` shape the recipe is
    /// being fixed to capture (artifacts/context-cdp/chatgpt, label `claude`).
    #[test]
    fn chatgpt_said_shape_collapses_and_filters_chrome() {
        let doc = "Skip to content Chat history Home Close sidebar New chat Search chats \
            You said: please find this website \
            ChatGPT said: Found it: Specc. Website: speccapp.com. It matches the product. \
            You said: does it have a free tier? \
            ChatGPT said: Yes, the launch post mentions a free plan. \
            Ask anything ChatGPT can make mistakes. Check important info.";
        let s = WindowContextSnapshot {
            window_title: "ChatGPT - Google Chrome".into(),
            element_name: "Message ChatGPT".into(),
            app_exe: Some("chrome.exe".into()),
            ax_html: Some(format!(
                r#"<window name="ChatGPT - Google Chrome"><doc name="ChatGPT" focus="1">{doc}</doc></window>"#
            )),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
        assert!(
            screen.contains("User: please find this website"),
            "{screen}"
        );
        assert!(screen.contains("Assistant: Found it: Specc"), "{screen}");
        assert!(
            screen.contains("User: does it have a free tier?"),
            "{screen}"
        );
        assert!(
            screen.contains("Assistant: Yes, the launch post"),
            "{screen}"
        );
        assert!(!screen.contains("ChatGPT said:"), "{screen}");
        assert!(!screen.contains("You said:"), "{screen}");
        assert!(!screen.contains("Skip to content"), "{screen}");
        assert!(!screen.contains("ChatGPT can make mistakes"), "{screen}");
        assert!(!screen.contains("Ask anything"), "{screen}");
    }

    /// ChatGPT's CURRENT real capture (artifacts/context-cdp/chatgpt) uses
    /// affordance-based turns (no role labels): the doc opens with `Skip to content
    /// Open sidebar …`, interleaves `Copy message`/`Copy response`/`Good response`
    /// affordances + a `Thought for 26s` reasoning header, and closes with `Add
    /// files and more Ask anything … ChatGPT can make mistakes`. Even without role
    /// markers the framing + inline chrome must be stripped so the user query and
    /// the answer survive cleanly.
    #[test]
    fn chatgpt_affordance_doc_strips_framing_and_inline_chrome() {
        // Verbatim slice of the real chatgpt/rawSnapshot.json `<doc>` blob.
        let doc = "Skip to content Open sidebar Copy link Open conversation options \
            please find this website Copy message Edit message Thought for 26s \
            Found it: Specc Website: speccapp.com Specc \
            It matches the screenshot's product: AI that turns calls/transcripts into \
            developer-ready tickets and specs, with Jira/Linear/Notion integrations. \
            indiehackers.com Copy response Good response Bad response Share Switch model \
            More actions Sources Add files and more Ask anything Medium Start Voice \
            ChatGPT can make mistakes. Check important info.";
        let s = WindowContextSnapshot {
            window_title: "Website Search Result - Google Chrome".into(),
            element_name: "Message ChatGPT".into(),
            app_exe: Some("chrome.exe".into()),
            ax_html: Some(format!(
                r#"<window name="Website Search Result - Google Chrome"><doc name="Website Search Result">{doc}</doc></window>"#
            )),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
        // Real content survives.
        assert!(screen.contains("please find this website"), "{screen}");
        assert!(screen.contains("speccapp.com"), "{screen}");
        // Framing + inline affordance chrome is stripped.
        for chrome in [
            "Skip to content",
            "Open sidebar",
            "Copy link",
            "Copy message",
            "Edit message",
            "Copy response",
            "Good response",
            "Bad response",
            "Switch model",
            "More actions",
            "Thought for 26s",
            "Add files and more",
            "Ask anything",
            "ChatGPT can make mistakes",
        ] {
            assert!(
                !screen.contains(chrome),
                "chrome leaked ({chrome}): {screen}"
            );
        }
    }

    /// Gemini (artifacts/context-cdp/gemini): the real app exposes the whole UI as
    /// one structureless `<doc>` — a sidebar nav prefix, a `Recents` roster of past
    /// chat titles (each echoed `TitleTitle…`), then the user's prompts, closing
    /// with `Ask Gemini`. The scrub must drop the sidebar nav, the `Recents` label,
    /// the placeholder, and the footer, keeping the real prompt content.
    #[test]
    fn gemini_real_sidebar_doc_drops_nav_recents_and_placeholder() {
        // Verbatim slice of the real gemini/rawSnapshot.json `<doc>` blob.
        let doc = "Gemini Temporary chat Close sidebar New chat Search chats Images New \
            Videos Library Notebooks New notebook \
            Health in Hajj: Training and Guidance ManualHealth in Hajj: Training and Guida… \
            Recents Coffee Vending Machines Explained Queue Management System Explained \
            WhatsApp Premium Subscription RumorsWhatsApp Premium Subscription Rum… \
            Create a neon, cyberpunk-inspired logo of a stylized soundwave piercing through \
            a glowing text caret, with bright glowing lines and vibrant colors for a sleek \
            modern look using electric blue, neon pink, and bright purple gradients. \
            Conversation with Gemini Let's jump in, Mostafa Ask Gemini";
        let s = WindowContextSnapshot {
            window_title: "Google Gemini - Google Chrome".into(),
            element_name: "Enter a prompt for Gemini".into(),
            app_exe: Some("chrome.exe".into()),
            ax_html: Some(format!(
                r#"<window name="Google Gemini - Google Chrome"><doc name="Google Gemini">{doc}</doc></window>"#
            )),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let screen = context_json(&out)["screen"].as_str().unwrap().to_string();
        // The real prompt content survives.
        assert!(screen.contains("neon, cyberpunk-inspired logo"), "{screen}");
        // Sidebar nav / Recents label / placeholder / footer are gone.
        for chrome in [
            "Gemini Temporary chat",
            "Close sidebar",
            "New notebook",
            "Recents",
            "Ask Gemini",
            "Enter a prompt for Gemini",
            "Let's jump in",
            "Conversation with Gemini",
        ] {
            assert!(
                !screen.contains(chrome),
                "chrome leaked ({chrome}): {screen}"
            );
        }
        // The `TitleTitle…` truncation echo is collapsed (no stray `…`).
        assert!(
            !screen.contains('\u{2026}'),
            "truncation echo leaked: {screen}"
        );
    }

    /// Outlook (artifacts/context-cdp/outlook, label `gmail`): the composer focuses
    /// (`Message body`) but its caret TextPattern range spans the WHOLE mail app —
    /// the left-rail folders, the inbox message LIST (rows like `Reminder: …
    /// birthday`, `amazon.eg: Sign-in`, `… Account Verification`), then the open
    /// thread. The Outlook folder/sort markers must reroute it to the pruned path,
    /// and the message-list + any sign-in / verification / OTP rows must be dropped
    /// — only the open thread (sender + subject + body) survives. Shape lifted
    /// verbatim from the real outlook/rawSnapshot.json textBefore.
    #[test]
    fn outlook_inbox_list_reroutes_and_drops_message_list_and_otp() {
        let text_before = "\
Hide navigation pane
File
Home
Navigation pane
Favorites
Inbox
10927
unread
Sent Items
Drafts
Archive
Junk Email
Deleted Items
Conversation HistoryConversation Histo…
Focused
Other
Sorted: By Date
Other Emails (90)
info@codebasics.io
CodeBasics | Account Verification
Yesterday
Header action menu
support@storyblocks.com
Verify Your Storyblocks API AccountVerify Your Storyblocks API…
Sun 1:32 PM
amazon.eg
amazon.eg: Sign-in
Mon 6/1
Mostafa Eldahsory, Someone signed-in to your account.
SaSa Darsh
Reminder: kevin.e.13's birthdayReminder: kevin.e.13's birth…
Fri 12:00 PM
Your reminder for kevin.e.13's birthday 6/13/2026 All DayYour reminder for kevin.e.13's birthday 6…
Reminder: kevin.e.13's birthday
SaSa Darsh
View with a light background
Reply
Reply all
Forward
Apps
More items
To:
SaSa Darsh <MASTER_X_3@live.com>
Fri 6/12/2026 12:00 PM
Show original size
Your reminder for kevin.e.13's birthday
6/13/2026
All Day
Expand header and show message history
Pop Out";
        let s = WindowContextSnapshot {
            window_title: "Mail - SaSa Darsh - Outlook - Google Chrome".into(),
            element_name: "Message body".into(),
            app_exe: Some("chrome.exe".into()),
            text_before: Some(text_before.into()),
            // The real Outlook tree is one structureless <doc> whose entire content
            // is a single page-spanning TextPattern blob the role pruner classifies
            // as one low-signal line (it ends in an ` Ad` chrome token) and drops —
            // so the pruner yields nothing and the formatter scrubs the newline
            // `textBefore` instead. A bare toolbar-only tree reproduces that
            // "tree prunes to empty" condition.
            ax_html: Some(
                "<window name=\"Mail - SaSa Darsh - Outlook - Google Chrome\">\
                 <pane name=\"Mail - SaSa Darsh - Outlook - Google Chrome\">\
                 <toolbar name=\"Bookmarks\"><button name=\"Work\"></button></toolbar>\
                 </pane></window>"
                    .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        let ctx = context_json(&out);
        // Rerouted to the pruned `screen`; the polluted beforeCaret is NOT emitted.
        let screen = ctx["screen"].as_str().unwrap_or("");
        assert!(
            ctx.get("beforeCaret").is_none(),
            "beforeCaret leaked: {out}"
        );
        // The open email thread survives.
        assert!(
            screen.contains("Your reminder for kevin.e.13's birthday"),
            "{screen}"
        );
        // The message LIST + the sign-in / verification / OTP rows are gone.
        for leaked in [
            "amazon.eg: Sign-in",
            "Sign-in",
            "Account Verification",
            "Verify Your Storyblocks",
            "Someone signed-in",
            "Inbox",
            "Junk Email",
            "Deleted Items",
            "Sent Items",
            "Conversation History",
            "Sorted: By Date",
            "Header action menu",
            "Other Emails",
            // per-message reading-pane action chrome
            "View with a light background",
            "Reply all",
            "Expand header and show message history",
            "Pop Out",
        ] {
            assert!(
                !out.contains(leaked),
                "outlook chrome leaked ({leaked}): {out}"
            );
        }
        // No verification / single-use / sign-in OTP phrase survives anywhere.
        assert!(json_is_otp_or_signin_row("amazon.eg: Sign-in"));
        assert!(json_is_otp_or_signin_row(
            "Google: Your verification code is 622297"
        ));
        assert!(json_is_otp_or_signin_row("Qiwa: One time password 7596"));
        assert!(!out.to_lowercase().contains("verification code"), "{out}");
        assert!(!out.to_lowercase().contains("single-use"), "{out}");
    }

    /// The Outlook folder / sort markers are present in JSON_PAGE_NAV_MARKERS so a
    /// mail caret blob is detected as page-spanning scrollback (and rerouted off
    /// the flat beforeCaret path).
    #[test]
    fn outlook_folder_markers_detected_as_page_scrollback() {
        let blob = "Favorites Inbox Sent Items Drafts Archive Junk Email Deleted Items \
            Conversation History Focused Other Sorted: By Date";
        assert!(json_caret_is_page_scrollback(blob));
    }

    /// The mail-blob scrubber cuts the inbox-list scrollback at the last
    /// `…`-truncated preview row and drops the per-message Outlook chrome, keeping
    /// only the open thread.
    #[test]
    fn mail_blob_scrubber_cuts_list_and_keeps_thread() {
        let text = "\
Inbox
amazon.eg: Sign-inamazon.eg: Sign-…
Mon 6/1
Reminder: kevin.e.13's birthdayReminder: kevin.e.13's birth…
SaSa Darsh
View with a light background
Reply
Reply all
Forward
To:
SaSa Darsh <MASTER_X_3@live.com>
Your reminder for kevin.e.13's birthday
All Day
Pop Out";
        let scrubbed = json_scrub_mail_blob(text).expect("mail shape recognized");
        assert!(
            scrubbed.contains("Your reminder for kevin.e.13's birthday"),
            "{scrubbed}"
        );
        assert!(!scrubbed.contains("amazon.eg"), "{scrubbed}");
        assert!(!scrubbed.contains("Sign-in"), "{scrubbed}");
        assert!(
            !scrubbed.contains("View with a light background"),
            "{scrubbed}"
        );
        assert!(!scrubbed.contains("Reply all"), "{scrubbed}");
        assert!(!scrubbed.contains("Pop Out"), "{scrubbed}");
    }

    // ── unconditional final OTP / secret-code scrub (privacy-critical) ──

    /// The exact Outlook leak shape from artifacts/context-cdp/outlook: the whole
    /// mail app is a single structureless `<doc>` whose TextPattern blob carries
    /// the open email body `... Your account verification OTP is: 17042 ...`. With
    /// empty caret fields the formatter falls all the way through to the raw
    /// window-dump (`screen = ax_html`), which the per-ROW OTP filter never sees
    /// because the whole `<doc>` is ONE line. The unconditional final scrub must
    /// still strip the code on THIS path.
    #[test]
    fn outlook_window_dump_scrubs_verification_otp_code() {
        let ax_html = "<window name=\"Mail - SaSa Darsh - Outlook - Google Chrome\">\
            <doc name=\"Mail - SaSa Darsh - Outlook\"> Inbox 10926 unread \
            CodeBasics | Account Verification info@codebasics.io View with a light background \
            Reply Reply all More items Mon 2/26/2024 10:28 PM Show original size \
            Dear master el master, Your account verification OTP is: 17042 \
            If you have any questions, please do not hesitate to reach out to us. \
            Best regards, Team Codebasics Questions or FAQ? Contact us at info@codebasics.io. \
            Copyright 2024 codebasics.io. Pop Out </doc></window>";
        let s = WindowContextSnapshot {
            window_title: "Mail - SaSa Darsh - Outlook - Google Chrome".into(),
            element_name: "Mail - SaSa Darsh - Outlook - Google Chrome".into(),
            app_exe: Some("chrome.exe".into()),
            // No caret / focused text: forces the raw window-dump branch.
            ax_html: Some(ax_html.into()),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        assert!(!out.is_empty());
        assert!(serde_json::from_str::<serde_json::Value>(&out).is_ok());
        // THE leak: the real OTP code and its announcing phrase are gone.
        assert!(
            !out.contains("17042"),
            "OTP code leaked via window-dump: {out}"
        );
        assert!(
            !out.to_lowercase().contains("verification otp"),
            "OTP phrase leaked: {out}"
        );
        assert!(
            !out.to_lowercase().contains("otp is"),
            "OTP phrase leaked: {out}"
        );
        // Benign surrounding context (the sender, the signature) still survives,
        // and incidental numbers in the dump (the year 2024, the 10926 unread
        // count) are NOT collateral-damaged.
        assert!(out.contains("Team Codebasics"), "body context lost: {out}");
        assert!(out.contains("2024"), "year over-redacted: {out}");
        assert!(out.contains("10926"), "unread count over-redacted: {out}");
    }

    /// Same Outlook OTP body, but delivered through the page-spanning caret
    /// REROUTE path (rich `textBefore` + a tree present). The mail-blob scrubber
    /// handles most of it, but the final scrub is the guarantee the code never
    /// survives regardless of which branch wins.
    #[test]
    fn outlook_reroute_path_scrubs_verification_otp_code() {
        let text_before = "\
Inbox
amazon.eg: Sign-inamazon.eg: Sign-…
Sorted: By Date
CodeBasics | Account VerificationCodeBasics | Account Verif…
info@codebasics.io
View with a light background
Reply
Reply all
Show original size
Dear master el master,
Your account verification OTP is: 17042
If you have any questions, please do not hesitate to reach out to us.
Best regards, Team Codebasics";
        let s = WindowContextSnapshot {
            window_title: "Mail - SaSa Darsh - Outlook - Google Chrome".into(),
            element_name: "Message body".into(),
            app_exe: Some("chrome.exe".into()),
            text_before: Some(text_before.into()),
            ax_html: Some(
                "<window name=\"Mail - SaSa Darsh - Outlook - Google Chrome\">\
                 <pane name=\"Mail - SaSa Darsh - Outlook - Google Chrome\">\
                 <toolbar name=\"Bookmarks\"><button name=\"Work\"></button></toolbar>\
                 </pane></window>"
                    .into(),
            ),
            ..snap()
        };
        let out = format_context_for_prompt(&s);
        assert!(serde_json::from_str::<serde_json::Value>(&out).is_ok());
        assert!(!out.contains("17042"), "OTP code leaked via reroute: {out}");
        assert!(
            !out.to_lowercase().contains("verification otp"),
            "OTP phrase leaked via reroute: {out}"
        );
    }

    /// A normal conversation full of INCIDENTAL numbers (prices, years, counts,
    /// phone-ish ids, order numbers) that are NOT next to any OTP/verification
    /// keyword must pass through completely untouched.
    #[test]
    fn normal_conversation_numbers_are_not_over_redacted() {
        let thread = [
            "Alice: The Q3 budget came in at $42,500, up from 38900 last year.",
            "Bob: We shipped 1284 units in 2025 and expect 2026 to double that.",
            "Alice: Call me at 5551234 when the 405 invoice clears.",
            "Bob: Order 4051234567 was delivered; the room is 1408 on floor 12.",
        ]
        .join("\n");
        let scrubbed = json_scrub_secret_codes(&thread);
        // Identical: no OTP keyword anywhere → byte-for-byte unchanged.
        assert_eq!(scrubbed, thread);
        for n in [
            "42,500",
            "38900",
            "1284",
            "2025",
            "2026",
            "5551234",
            "405",
            "4051234567",
            "1408",
            "12",
        ] {
            assert!(
                scrubbed.contains(n),
                "number {n} was over-redacted: {scrubbed}"
            );
        }
    }

    /// The scrub drops whole secret-code sentences AND redacts keyword-adjacent
    /// bare codes in the canonical leak shapes, while leaving a non-code number in
    /// the SAME blob (a year) intact.
    #[test]
    fn scrub_drops_code_phrases_and_redacts_adjacent_codes() {
        // Each of these whole sentences carries a secret-code phrase → dropped.
        for leak in [
            "Your account verification OTP is: 17042",
            "your code is 482913",
            "Google: Your verification code is 622297",
            "Qiwa: One time password 7596",
            "Use single-use passcode 99213 to continue.",
            "Your 2FA code is 1029 — do not share it.",
            "G-123456 is your Google verification code.",
            "amazon.eg: Sign-in",
        ] {
            let scrubbed = json_scrub_secret_codes(leak);
            assert!(
                scrubbed.trim().is_empty()
                    || !scrubbed.chars().any(|c| c.is_ascii_digit())
                    || !JSON_SECRET_CODE_PHRASE_RE.is_match(&scrubbed),
                "secret-code phrase survived: {leak:?} -> {scrubbed:?}"
            );
        }
        // The specific codes must be gone.
        assert!(
            !json_scrub_secret_codes("Your account verification OTP is: 17042").contains("17042")
        );
        assert!(!json_scrub_secret_codes("your verification code is 622297").contains("622297"));
        assert!(
            !json_scrub_secret_codes("G-123456 is your Google verification code.")
                .contains("123456")
        );

        // The code-bearing sentence is dropped, but an incidental number in a
        // SEPARATE sentence of the same blob is preserved.
        let mixed = "The OTP is 884412. The budget for 2026 is due Friday.";
        let scrubbed = json_scrub_secret_codes(mixed);
        assert!(!scrubbed.contains("884412"), "code survived: {scrubbed}");
        assert!(
            scrubbed.contains("2026"),
            "year in a separate sentence lost: {scrubbed}"
        );
        assert!(
            scrubbed.contains("budget"),
            "separate sentence lost: {scrubbed}"
        );

        // Stage-2 catch: a bare code keyword-adjacent to a digit run inside a
        // sentence whose full phrase does NOT match (so the sentence is kept) is
        // still redacted in place.
        let residue = json_scrub_secret_codes("Reference pin: 4821 for the meeting room.");
        assert!(!residue.contains("4821"), "pin code survived: {residue}");
        assert!(residue.contains("meeting room"), "context lost: {residue}");
    }

    /// Multi-line blob: only the secret-code line is dropped; the surrounding
    /// conversation lines (and their incidental numbers) are preserved verbatim.
    #[test]
    fn scrub_is_line_local_and_preserves_surrounding_context() {
        let blob = "Maya: standup at 9:30 tomorrow, room 1408.\n\
            Bank: Your one-time code is 553201.\n\
            Maya: also the 2026 budget is due Friday.";
        let scrubbed = json_scrub_secret_codes(blob);
        assert!(scrubbed.contains("standup at 9:30 tomorrow, room 1408"));
        assert!(scrubbed.contains("2026 budget is due Friday"));
        assert!(!scrubbed.contains("553201"), "OTP code leaked: {scrubbed}");
        assert!(
            !scrubbed.to_lowercase().contains("one-time code"),
            "OTP phrase leaked: {scrubbed}"
        );
    }
}
