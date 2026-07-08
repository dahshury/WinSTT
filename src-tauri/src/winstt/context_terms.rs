//! Context term extraction — the "screen as dictionary" / variable-recognition
//! mechanism (report R4). Pulls a deduplicated, ranked list of proper nouns and
//! code identifiers out of the Tier-1 context snapshot text (focused field,
//! before/after caret, selection, screen) so the EXISTING per-session
//! vocabulary-biasing machinery can bias the dictation toward names the user is
//! looking at (a variable in the editor, a channel in chat, a filename).
//!
//! This is deliberately GENERIC-BY-ROLE: no app-specific regexes, no per-app
//! branches (report R1). A term is kept because of its *shape* (camelCase,
//! `snake_case`, a filename, a `@handle`, a capitalized proper noun), never
//! because of which app produced it.
//!
//! CRITICAL: the terms produced here feed ONLY the vocabulary/dictionary biasing
//! path — the same channel the user dictionary uses — and are session-scoped
//! (never persisted, never added to the Whisper/STT initial prompt, which context
//! text has been proven to poison).
//!
//! By construction the extractor keeps only word-shaped tokens (identifiers,
//! filenames, capitalized nouns, handles); it never keeps bare numeric runs, so
//! numeric OTP/verification codes cannot become terms even if they reach it.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use regex::Regex;

use crate::helpers::regex::static_regex;

/// Default cap on the extracted term list. The encoder/dictionary biasing path
/// scores each term, so an unbounded list would balloon per-utterance cost; 50
/// proper nouns comfortably covers a focused-field neighbourhood.
pub const DEFAULT_TERM_CAP: usize = 50;

/// Shortest token we treat as a code identifier. Below this, camel/snake/kebab
/// detection produces noise (`id`, `fn`, `x1`).
const MIN_IDENTIFIER_LEN: usize = 4;

/// Filenames like `context_manager.rs`, `utils.py`, `README.md`, `main.test.tsx`.
/// A dot-separated name with a 1–5 char lowercase-ish extension. Anchored on a
/// word boundary so `foo.bar.baz` in prose still reads its trailing extension.
static FILENAME_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r"(?i)\b[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9]{0,4}\b"));

/// `@handle` / `#channel` — allow letters, digits, `_`, `-`, `.` after the sigil
/// (covers `@user`, `#general`, `@user.name`, `#dev-ops`).
static HANDLE_RE: Lazy<Regex> = Lazy::new(|| static_regex(r"[@#][A-Za-z0-9][A-Za-z0-9._-]*"));

/// A bare word candidate: a run of letters/digits/underscore/hyphen. We inspect
/// its internal shape afterwards to decide whether it's a code identifier.
static WORD_RE: Lazy<Regex> = Lazy::new(|| static_regex(r"[A-Za-z0-9][A-Za-z0-9_-]*"));

/// One capitalized token (`Vite`, `Anthropic`) — the atom of a proper-noun run.
/// Requires an uppercase initial followed by at least one lowercase letter, so
/// `A`, `I`, and SCREAMING_CASE are excluded here (SCREAMING is caught as a code
/// identifier instead).
static CAP_WORD_RE: Lazy<Regex> = Lazy::new(|| static_regex(r"[A-Z][a-z]+(?:[A-Za-z]*)"));

/// Generic English UI-chrome words to drop. GENERIC ONLY — button/menu labels
/// every desktop app shares, nothing app-specific. These slip past the
/// capitalized-noun filter because they're legitimately capitalized in toolbars.
static UI_CHROME: &[&str] = &[
    "Reply",
    "Forward",
    "Copy",
    "Cut",
    "Paste",
    "Edit",
    "Delete",
    "Settings",
    "Search",
    "Home",
    "Back",
    "Next",
    "Previous",
    "Cancel",
    "Close",
    "Save",
    "Open",
    "File",
    "View",
    "Help",
    "Send",
    "New",
    "Add",
    "Remove",
    "Menu",
    "More",
    "Done",
    "Ok",
    "Okay",
    "Yes",
    "No",
    "Submit",
    "Share",
    "Download",
    "Upload",
    "Print",
    "Refresh",
    "Reload",
    "Undo",
    "Redo",
    "Select",
    "All",
    "None",
    "Sign",
    "Login",
    "Logout",
    "Account",
    "Profile",
    "Notifications",
    "Inbox",
    "Sent",
    "Drafts",
    "Trash",
    "Archive",
    "Spam",
    "Compose",
    "Attach",
    "Insert",
    "Format",
    "Tools",
    "Window",
    "Options",
    "Preferences",
    "Toolbar",
    "Sidebar",
    "Details",
    "Preview",
    "Filter",
    "Sort",
    "Enable",
    "Disable",
    "Continue",
    "Confirm",
    "Apply",
    "Reset",
    "Clear",
    "Show",
    "Hide",
];

/// Sentence-initial common words to skip when they lead a capitalized run — the
/// leading `The` in "The report" is not a proper noun. Small and generic.
static SENTENCE_LEADERS: &[&str] = &[
    "The", "This", "That", "These", "Those", "There", "Then", "They", "Their", "Them", "It", "Its",
    "He", "She", "We", "You", "Your", "Our", "My", "Me", "Us", "His", "Her", "A", "An", "And",
    "But", "Or", "Nor", "So", "Yet", "For", "If", "When", "While", "Because", "Since", "As", "At",
    "In", "On", "Of", "To", "By", "With", "From", "Into", "Onto", "Is", "Are", "Was", "Were", "Be",
    "Been", "Being", "Do", "Does", "Did", "Have", "Has", "Had", "Will", "Would", "Can", "Could",
    "Should", "May", "Might", "Must", "Not", "No", "Yes", "Please", "Thanks", "Thank", "Hi",
    "Hello", "Hey", "Dear", "Regards", "Best", "Here", "Now", "How", "What", "Why", "Who", "Where",
    "Which", "Whose", "Whom", "Let", "Get", "Got", "Just", "Also", "Only",
];

/// Case-preserving membership test against a small static word list.
fn word_in(list: &[&str], word: &str) -> bool {
    list.iter().any(|w| w.eq_ignore_ascii_case(word))
}

/// True when `token` looks like a code identifier worth biasing toward:
/// camelCase, PascalCase, `snake_case`, `SCREAMING_SNAKE`, or `kebab-case`,
/// at least [`MIN_IDENTIFIER_LEN`] chars. Plain lowercase words and plain
/// Capitalized words are NOT identifiers (they go through the proper-noun path).
fn is_code_identifier(token: &str) -> bool {
    if token.chars().count() < MIN_IDENTIFIER_LEN {
        return false;
    }
    // Must contain at least one letter and not be all digits/punctuation.
    if !token.chars().any(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let has_underscore = token.contains('_');
    let has_hyphen = token.contains('-');
    let has_lower = token.chars().any(|c| c.is_ascii_lowercase());
    let has_upper = token.chars().any(|c| c.is_ascii_uppercase());
    let has_digit = token.chars().any(|c| c.is_ascii_digit());

    // snake_case / SCREAMING_SNAKE / kebab-case: a separator alone qualifies,
    // but require the separator to sit between word chars (not lead/trail).
    if (has_underscore || has_hyphen)
        && token.chars().next().is_some_and(|c| c != '_' && c != '-')
        && token.chars().last().is_some_and(|c| c != '_' && c != '-')
    {
        return true;
    }
    // camelCase / PascalCase: an internal case transition. A word that is only
    // Capitalized (`Report`) has an initial upper + all-lower tail and is NOT
    // camelCase — detect a lowercase-followed-by-uppercase boundary, or a
    // digit adjacent to letters (`utf8Decode`, `h264`).
    if has_lower && has_upper {
        let bytes = token.as_bytes();
        for w in bytes.windows(2) {
            if w[0].is_ascii_lowercase() && w[1].is_ascii_uppercase() {
                return true;
            }
        }
    }
    // Mixed alphanumerics that aren't plain words (`v2ray`, `h264encoder`) — but
    // only when there's real letter content and it's not a pure version/number.
    if has_digit && (has_lower || has_upper) && token.chars().any(|c| c.is_ascii_alphabetic()) {
        // Require at least two consecutive letters so `3d`/`x1` don't slip in.
        let has_letter_run = token
            .as_bytes()
            .windows(2)
            .any(|w| w[0].is_ascii_alphabetic() && w[1].is_ascii_alphabetic());
        if has_letter_run && token.chars().count() >= MIN_IDENTIFIER_LEN {
            return true;
        }
    }
    false
}

/// Accumulates candidate terms with the metadata needed to rank them.
struct Ranker {
    /// term -> (best/earliest source index seen, occurrence count, insertion order)
    seen: HashMap<String, (usize, usize, usize)>,
    /// Case-preserving canonical spelling, keyed by a case-folded form so the
    /// first-seen casing wins on later differently-cased occurrences.
    canonical: HashMap<String, String>,
    order: usize,
}

impl Ranker {
    fn new() -> Self {
        Self {
            seen: HashMap::new(),
            canonical: HashMap::new(),
            order: 0,
        }
    }

    /// Record one occurrence of `term` found at source index `src` (0 = closest
    /// to the caret). First-seen casing is preserved; later casings fold onto it.
    fn add(&mut self, term: &str, src: usize) {
        let term = term.trim_matches(|c: char| c == '.' || c == ',' || c == ';' || c == ':');
        if term.is_empty() {
            return;
        }
        let key = term.to_lowercase();
        let canonical = self
            .canonical
            .entry(key)
            .or_insert_with(|| term.to_string())
            .clone();
        let entry = self
            .seen
            .entry(canonical)
            .or_insert_with(|| (src, 0, usize::MAX));
        entry.0 = entry.0.min(src);
        entry.1 += 1;
        if entry.2 == usize::MAX {
            entry.2 = self.order;
            self.order += 1;
        }
    }

    /// Rank + cap: closest-to-caret first (lowest source index), then most
    /// frequent, then first-seen (stable). Returns case-preserved spellings.
    fn finish(self, cap: usize) -> Vec<String> {
        let mut items: Vec<(String, usize, usize, usize)> = self
            .seen
            .into_iter()
            .map(|(term, (src, count, order))| (term, src, count, order))
            .collect();
        items.sort_by(|a, b| {
            a.1.cmp(&b.1) // proximity: lower source index first
                .then(b.2.cmp(&a.2)) // frequency: higher count first
                .then(a.3.cmp(&b.3)) // first-seen: stable
        });
        items.truncate(cap);
        items.into_iter().map(|(term, ..)| term).collect()
    }
}

/// Extract a ranked, deduplicated list of biasing terms from Tier-1 snapshot
/// text. `texts` is ordered by proximity to the caret — earlier slices (field
/// text, beforeCaret, selection) rank above later ones (screen). `cap` bounds
/// the list (pass [`DEFAULT_TERM_CAP`] for the standard 50).
///
/// Kept, generic-by-role: code identifiers (camel/Pascal/snake/SCREAMING/kebab,
/// at least 4 chars), filenames with extensions, capitalized proper nouns and
/// multi-word proper sequences, `@handles` and `#channels`. Dropped: single
/// letters, sentence-initial common words, generic UI-chrome labels, bare
/// numbers.
pub fn extract_context_terms(texts: &[&str], cap: usize) -> Vec<String> {
    let mut ranker = Ranker::new();

    for (src, text) in texts.iter().enumerate() {
        if text.trim().is_empty() {
            continue;
        }
        extract_from_text(text, src, &mut ranker);
    }

    ranker.finish(cap)
}

/// Pull all term shapes out of a single text slice at proximity rank `src`.
fn extract_from_text(text: &str, src: usize, ranker: &mut Ranker) {
    // 1. @handles / #channels (before word/filename passes so the sigil survives).
    for m in HANDLE_RE.find_iter(text) {
        let h = m.as_str();
        // Need at least one letter after the sigil (drop `#1`, `@42`).
        if h[1..].chars().any(|c| c.is_ascii_alphabetic()) {
            ranker.add(h, src);
        }
    }

    // 2. filenames with extensions.
    for m in FILENAME_RE.find_iter(text) {
        ranker.add(m.as_str(), src);
    }

    // 3. code identifiers (camel/Pascal/snake/SCREAMING/kebab).
    for m in WORD_RE.find_iter(text) {
        let w = m.as_str();
        if is_code_identifier(w) && !word_in(UI_CHROME, w) {
            ranker.add(w, src);
        }
    }

    // 4. capitalized proper nouns and multi-word proper sequences.
    extract_proper_nouns(text, src, ranker);
}

/// Capitalized proper nouns. A run of adjacent `Capitalized` words (`New York`,
/// `Visual Studio Code`) is emitted BOTH as the joined multi-word sequence and
/// as its individual tokens, so either can bias recognition. A capitalized word
/// that leads a sentence and is a common word (`The`, `Please`) is skipped; UI
/// chrome (`Reply`, `Settings`) is skipped everywhere.
fn extract_proper_nouns(text: &str, src: usize, ranker: &mut Ranker) {
    // Iterate line by line so a capitalized word after a newline is treated as
    // sentence-initial (drop leaders) but mid-line runs stay intact.
    for line in text.split(['\n', '\r']) {
        let caps: Vec<(usize, &str)> = CAP_WORD_RE
            .find_iter(line)
            .map(|m| (m.start(), m.as_str()))
            .collect();
        if caps.is_empty() {
            continue;
        }

        // Group adjacent capitalized words (separated only by a single space) into
        // proper-noun sequences.
        let mut i = 0;
        while i < caps.len() {
            let mut j = i;
            while j + 1 < caps.len() {
                let (cur_start, cur_word) = caps[j];
                let (next_start, _) = caps[j + 1];
                let gap = &line[cur_start + cur_word.len()..next_start];
                // Adjacent only when the gap is a single space (not punctuation,
                // which usually means a new clause / sentence).
                if gap == " " {
                    j += 1;
                } else {
                    break;
                }
            }

            let run = &caps[i..=j];
            let is_line_start = run[0].0 == first_nonspace_offset(line);
            emit_proper_run(run, is_line_start, src, ranker);
            i = j + 1;
        }
    }
}

/// Byte offset of the first non-space char on the line (so a leader check only
/// fires for the genuinely sentence-initial word).
fn first_nonspace_offset(line: &str) -> usize {
    line.char_indices()
        .find(|(_, c)| !c.is_whitespace())
        .map_or(0, |(i, _)| i)
}

/// Emit a run of capitalized words as individual terms + the joined sequence.
/// The first word is dropped when it's a sentence leader AND sits at line start.
fn emit_proper_run(run: &[(usize, &str)], is_line_start: bool, src: usize, ranker: &mut Ranker) {
    // Filter UI chrome and (only at line start) sentence leaders from the head.
    let mut words: Vec<&str> = Vec::with_capacity(run.len());
    for (idx, (_, word)) in run.iter().enumerate() {
        if word.chars().count() < 2 {
            continue; // never single letters
        }
        if word_in(UI_CHROME, word) {
            continue;
        }
        // Sentence-initial leader: only skip when it's the first word of the run
        // AND the run leads the line (mid-line "The" inside a title is rare and
        // dropping it there loses "The Verge" → acceptable, but only line-start).
        if idx == 0 && is_line_start && word_in(SENTENCE_LEADERS, word) {
            continue;
        }
        words.push(word);
    }

    if words.is_empty() {
        return;
    }

    // Individual proper nouns.
    for w in &words {
        ranker.add(w, src);
    }
    // Multi-word sequence (e.g. "Visual Studio Code").
    if words.len() > 1 {
        ranker.add(&words.join(" "), src);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(texts: &[&str]) -> Vec<String> {
        extract_context_terms(texts, DEFAULT_TERM_CAP)
    }

    #[test]
    fn code_identifiers_of_every_shape() {
        let text = "The function extractContextTerms calls context_manager and \
                    reads DEFAULT_RANK_K plus a kebab-case flag.";
        let terms = extract(&[text]);
        assert!(terms.contains(&"extractContextTerms".to_string()));
        assert!(terms.contains(&"context_manager".to_string()));
        assert!(terms.contains(&"DEFAULT_RANK_K".to_string()));
        assert!(terms.contains(&"kebab-case".to_string()));
    }

    #[test]
    fn plain_words_are_not_identifiers() {
        // Lowercase prose words and a plain Capitalized common word must not be
        // classified as code identifiers.
        assert!(!is_code_identifier("function"));
        assert!(!is_code_identifier("report"));
        assert!(!is_code_identifier("Report"));
        assert!(!is_code_identifier("id")); // too short
        assert!(!is_code_identifier("fn")); // too short
        assert!(is_code_identifier("camelCase"));
        assert!(is_code_identifier("PascalCase"));
        assert!(is_code_identifier("snake_case"));
        assert!(is_code_identifier("SCREAMING_SNAKE"));
        assert!(is_code_identifier("kebab-case"));
    }

    #[test]
    fn filenames_with_extensions() {
        let text = "Open context_manager.rs and utils.py, then check README.md and main.test.tsx";
        let terms = extract(&[text]);
        assert!(terms.contains(&"context_manager.rs".to_string()));
        assert!(terms.contains(&"utils.py".to_string()));
        assert!(terms.contains(&"README.md".to_string()));
        assert!(terms.contains(&"main.test.tsx".to_string()));
    }

    #[test]
    fn handles_and_channels() {
        let text = "Ping @alice and @bob.dev in #general and #dev-ops about the release.";
        let terms = extract(&[text]);
        assert!(terms.contains(&"@alice".to_string()));
        assert!(terms.contains(&"@bob.dev".to_string()));
        assert!(terms.contains(&"#general".to_string()));
        assert!(terms.contains(&"#dev-ops".to_string()));
    }

    #[test]
    fn numeric_only_handles_are_dropped() {
        let terms = extract(&["Order #42 shipped to @1234 today"]);
        assert!(!terms.iter().any(|t| t == "#42"));
        assert!(!terms.iter().any(|t| t == "@1234"));
    }

    #[test]
    fn proper_nouns_and_multiword_sequences() {
        let text = "We migrated to Anthropic and use Visual Studio Code with Vite.";
        let terms = extract(&[text]);
        assert!(terms.contains(&"Anthropic".to_string()));
        assert!(terms.contains(&"Vite".to_string()));
        assert!(terms.contains(&"Visual".to_string()));
        assert!(terms.contains(&"Studio".to_string()));
        assert!(terms.contains(&"Code".to_string()));
        assert!(terms.contains(&"Visual Studio Code".to_string()));
    }

    #[test]
    fn sentence_initial_common_words_are_skipped() {
        // "The" leads the line and is a common word → dropped; "Anthropic" kept.
        let terms = extract(&["The Anthropic team shipped it."]);
        assert!(!terms.iter().any(|t| t == "The"));
        assert!(terms.contains(&"Anthropic".to_string()));
    }

    #[test]
    fn never_single_letters() {
        let terms = extract(&["I saw A big X on the map with B."]);
        assert!(!terms.iter().any(|t| t.chars().count() == 1));
    }

    #[test]
    fn ui_chrome_words_excluded() {
        // A real email-client chrome dump: these are all generic UI labels.
        let chrome = "Reply Forward Copy Edit Settings Search Home Archive Delete \
                      Compose Inbox Sent Drafts Trash Send Save Cancel";
        let terms = extract(&[chrome]);
        for w in [
            "Reply", "Forward", "Copy", "Edit", "Settings", "Search", "Home", "Archive", "Delete",
            "Compose", "Inbox", "Sent", "Drafts", "Trash", "Send", "Save", "Cancel",
        ] {
            assert!(
                !terms.iter().any(|t| t == w),
                "UI chrome word {w:?} leaked into terms: {terms:?}"
            );
        }
    }

    #[test]
    fn casing_is_preserved_first_seen_wins() {
        // First occurrence "Vite" (proper), a later "vite" must not overwrite it.
        let terms = extract(&["Install Vite now", "we like vite a lot vite vite"]);
        assert!(terms.contains(&"Vite".to_string()));
        assert!(!terms.iter().any(|t| t == "vite"));
    }

    #[test]
    fn dedupe_is_case_insensitive() {
        let terms = extract(&["Anthropic Anthropic anthropic ANTHROPIC"]);
        let count = terms
            .iter()
            .filter(|t| t.eq_ignore_ascii_case("anthropic"))
            .count();
        assert_eq!(count, 1, "term should appear once: {terms:?}");
    }

    #[test]
    fn proximity_ranks_caret_text_above_screen() {
        // src 0 = beforeCaret (near), src 1 = screen (far). A term seen only in
        // the near text must rank ahead of a term seen only in the far text.
        let near = "reviewing the useAuthToken hook";
        let far = "unrelated MarketingBanner on screen";
        let terms = extract_context_terms(&[near, far], DEFAULT_TERM_CAP);
        let near_pos = terms.iter().position(|t| t == "useAuthToken");
        let far_pos = terms.iter().position(|t| t == "MarketingBanner");
        assert!(near_pos.is_some() && far_pos.is_some());
        assert!(
            near_pos < far_pos,
            "caret-near term should outrank screen-only term: {terms:?}"
        );
    }

    #[test]
    fn frequency_breaks_proximity_ties() {
        // Both terms only in the same (screen) source; the more frequent wins.
        let text = "Kubernetes Kubernetes Kubernetes and one Terraform mention";
        let terms = extract_context_terms(&[text], DEFAULT_TERM_CAP);
        let k = terms.iter().position(|t| t == "Kubernetes");
        let tf = terms.iter().position(|t| t == "Terraform");
        assert!(k.is_some() && tf.is_some());
        assert!(k < tf, "more frequent term should rank first: {terms:?}");
    }

    #[test]
    fn cap_is_respected() {
        // Generate many distinct identifiers, cap to 5.
        let big: String = (0..100).map(|i| format!("ident_{i:03} ")).collect();
        let terms = extract_context_terms(&[big.as_str()], 5);
        assert_eq!(terms.len(), 5);
    }

    #[test]
    fn empty_and_blank_inputs() {
        assert!(extract_context_terms(&[], DEFAULT_TERM_CAP).is_empty());
        assert!(extract_context_terms(&["", "   ", "\n\t"], DEFAULT_TERM_CAP).is_empty());
    }

    #[test]
    fn email_thread_text_extracts_names_not_chrome() {
        // Simulated Gmail-style capture: chrome labels mixed with real content.
        let email = "Reply Forward Archive Delete\n\
                     From: Sarah Chen at Anthropic\n\
                     Please review the pull request for winstt_context.rs before Friday.\n\
                     Thanks, Sarah";
        let terms = extract(&[email]);
        // Real proper nouns / identifiers survive.
        assert!(terms.contains(&"Sarah".to_string()));
        assert!(terms.contains(&"Chen".to_string()));
        assert!(terms.contains(&"Anthropic".to_string()));
        assert!(terms.contains(&"winstt_context.rs".to_string()));
        // Generic chrome + sentence leaders dropped.
        for w in [
            "Reply", "Forward", "Archive", "Delete", "Please", "Thanks", "From",
        ] {
            assert!(!terms.iter().any(|t| t == w), "{w:?} leaked: {terms:?}");
        }
    }

    #[test]
    fn chat_text_extracts_handles_and_identifiers() {
        let chat = "@dana pushed a fix to authMiddleware in #backend, see api_gateway.ts";
        let terms = extract(&[chat]);
        assert!(terms.contains(&"@dana".to_string()));
        assert!(terms.contains(&"#backend".to_string()));
        assert!(terms.contains(&"authMiddleware".to_string()));
        assert!(terms.contains(&"api_gateway.ts".to_string()));
    }

    #[test]
    fn code_editor_text_extracts_symbols() {
        // A Cursor/VS Code focused-buffer capture (the demo that motivated R4).
        let code = "fn extract_context_terms(texts: &[&str], cap: usize) -> Vec<String> {\n\
                    let ranker = Ranker::new();\n\
                    for chunk in CHUNK_SIZES { process(chunk) }\n\
                    }";
        let terms = extract(&[code]);
        assert!(terms.contains(&"extract_context_terms".to_string()));
        assert!(terms.contains(&"CHUNK_SIZES".to_string()));
        // "Ranker" is a PascalCase-initial type name → proper-noun path keeps it.
        assert!(terms.contains(&"Ranker".to_string()));
    }

    #[test]
    fn bare_numbers_never_become_terms() {
        let terms = extract(&["The code is 622297 and the year is 2026, ref 12345"]);
        assert!(!terms.iter().any(|t| t.chars().all(|c| c.is_ascii_digit())));
        assert!(!terms.iter().any(|t| t == "622297"));
        assert!(!terms.iter().any(|t| t == "2026"));
    }
}
