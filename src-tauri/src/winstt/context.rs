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

mod ax_tree;
mod policy;
mod prompt_sections;
mod secret_scrub;
mod snapshot;
mod surface;

use ax_tree::{json_parse_ax_html, JsonAxNode, JsonAxTree};
#[cfg(test)]
use policy::extract_host;
pub use policy::{is_allowed_by_list, is_denied_by_list, redact_sensitive_fields};
use prompt_sections::{json_serialize_context, json_trim_or_empty, JsonPromptSection};
#[cfg(test)]
use secret_scrub::JSON_SECRET_CODE_PHRASE_RE;
use secret_scrub::{json_is_otp_or_signin_row, json_scrub_secret_codes};
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
mod tests;
