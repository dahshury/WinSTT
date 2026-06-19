use once_cell::sync::Lazy;
use regex::Regex;

use super::json_collapse_inline_ws;
use crate::helpers::regex::static_regex;

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
pub(super) fn json_is_otp_or_signin_row(line: &str) -> bool {
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
pub(super) static JSON_SECRET_CODE_PHRASE_RE: Lazy<Regex> = Lazy::new(|| {
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
pub(super) fn json_scrub_secret_codes(text: &str) -> String {
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
