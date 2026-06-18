// Deterministic snippet / text-expansion engine.
//
// Source of truth (behavioral): frontend/src/shared/lib/fuzzy-match.ts
// (`replaceWithSnippets` / `findSnippetMatches` + `doubleMetaphone`).
//
// WinSTT's snippet expansion is a FUZZY trigger → expansion substitution that
// runs as the LAST step of the post-processing pass on the finalized
// transcription, immediately before paste. It tolerates Whisper near-misses
// (dropped letters, homophones) by gating each candidate window on BOTH a
// Jaro-Winkler string-similarity threshold AND a double-metaphone phonetic
// overlap — either gate alone is too noisy (JW alone matches "cool"→"cold";
// metaphone alone matches "see"→"sea"). This file ports that engine 1:1:
//
//   * `double_metaphone`  — faithful port of the `double-metaphone` npm package
//                           (Lawrence Philips' algorithm) used by the TS path.
//   * `jaro_winkler`      — reuses the `strsim` crate (identical formula: Jaro +
//                           0.1 prefix scale, 4-char prefix cap, boost above 0.7).
//   * `find_snippet_matches` / `replace_with_snippets` — the sliding-window
//                           fuzzy matcher + reverse splice (preserves surrounding
//                           punctuation; non-overlapping left-to-right).
//   * `SnippetStore`      — thread-safe cache loaded from `WinsttSettings.snippets`
//                           (mirrors `cachedSnippets` + `rebuildSnippets`): drops
//                           entries with an empty trigger OR expansion.
//   * `expand_snippets`   — read settings → apply expansion (the relay seam).
//
// CRUD has NO dedicated IPC command in the reference: the snippets array is part
// of the settings tree, edited wholesale via `winstt_set_settings({ snippets })`
// (the renderer's SnippetsTable is fully controlled). We expose one read-only
// command (`winstt_expand_snippets`) so the context playground / a future preview
// can render exactly what the recorder would expand, matching `getPostProcessingVocab`.
//
// The self-contained fuzzy-similarity primitives (the Double Metaphone port and
// the Jaro-Winkler wrapper) live in the sibling `phonetic` submodule; this file
// is the snippet engine proper plus the `SnippetStore` cache and public seams.

mod phonetic;

use std::sync::RwLock;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::AppHandle;

use crate::helpers::regex::static_regex;
use crate::winstt::commands::settings::read_settings;
use crate::winstt::settings_schema::SnippetEntry;
use phonetic::{double_metaphone, jaro_winkler, phonetic_overlap, SNIPPET_JW_THRESHOLD};

// Words are letters/digits/apostrophes. Punctuation is intentionally excluded so
// it stays in the surrounding text when a fuzzy match replaces a span — e.g.
// "address." stays as match("address") + literal ".". Mirrors the TS
// `WORD_RE = /[\p{L}\p{N}']+/gu`. The `regex` crate has Unicode classes on by
// default, so `\p{L}` / `\p{N}` resolve the same way.
static WORD_RE: Lazy<Regex> = Lazy::new(|| static_regex(r"[\p{L}\p{N}']+"));

// ===========================================================================
// Sliding-window fuzzy snippet matcher (ports findSnippetMatches / replaceWith…)
// ===========================================================================

/// A matched trigger span in the source text. `start..end` are BYTE offsets into
/// the original text covering exactly the matched words (surrounding punctuation
/// stays outside). Mirrors the TS `SnippetMatch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnippetMatch {
    pub start: usize,
    pub end: usize,
    pub expansion: String,
}

/// One regex word hit: its lowercased text + byte span in the source.
struct WordHit {
    lower: String,
    start: usize,
    end: usize,
}

/// Pre-computed trigger context shared across every window (built once).
struct TriggerContext {
    joined: String,
    mp: (String, String),
    word_count: usize,
}

/// Tokenize a trigger into lowercase words. Mirrors `triggerWords`.
fn trigger_words(trigger: &str) -> Vec<String> {
    let lower = trigger.to_lowercase();
    WORD_RE
        .find_iter(&lower)
        .map(|m| m.as_str().to_string())
        .collect()
}

fn build_trigger_context(t_words: &[String]) -> TriggerContext {
    let joined = t_words.join(" ");
    let concat = t_words.concat();
    TriggerContext {
        joined,
        mp: double_metaphone(&concat),
        word_count: t_words.len(),
    }
}

/// Collect all word hits (lowercased + byte span) in source order.
fn word_hits(text: &str) -> Vec<WordHit> {
    WORD_RE
        .find_iter(text)
        .map(|m| WordHit {
            lower: m.as_str().to_lowercase(),
            start: m.start(),
            end: m.end(),
        })
        .collect()
}

/// True iff the window passes BOTH gates against the trigger: the JW threshold
/// AND a phonetic overlap. Mirrors `windowMatchesTrigger`.
fn window_matches(window: &[&WordHit], trigger: &TriggerContext) -> bool {
    let joined: String = window
        .iter()
        .map(|w| w.lower.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    if jaro_winkler(&joined, &trigger.joined) < SNIPPET_JW_THRESHOLD {
        return false;
    }
    let concat: String = window.iter().map(|w| w.lower.as_str()).collect();
    let mp = double_metaphone(&concat);
    phonetic_overlap(&mp, &trigger.mp)
}

/// Find non-overlapping fuzzy occurrences of one snippet trigger, in order.
/// Mirrors `findSnippetMatches` + `collectSnippetMatches`.
pub fn find_snippet_matches(text: &str, trigger: &str, expansion: &str) -> Vec<SnippetMatch> {
    let t_words = trigger_words(trigger);
    let hits = word_hits(text);
    if t_words.is_empty() || hits.len() < t_words.len() {
        return Vec::new();
    }
    let ctx = build_trigger_context(&t_words);
    let mut results: Vec<SnippetMatch> = Vec::new();
    let span = hits.len() - ctx.word_count;
    let mut cursor = 0usize; // byte offset of the previous accepted match's end
    for i in 0..=span {
        // Skip windows that overlap the previous accepted match (left-to-right
        // non-overlap, mirrors the `windowStartIndex < cursor` guard).
        if hits[i].start < cursor {
            continue;
        }
        let window: Vec<&WordHit> = hits[i..i + ctx.word_count].iter().collect();
        if !window_matches(&window, &ctx) {
            continue;
        }
        let start = window[0].start;
        let end = window[window.len() - 1].end;
        results.push(SnippetMatch {
            start,
            end,
            expansion: expansion.to_string(),
        });
        cursor = end;
    }
    results
}

/// Splice the matches into `text` right-to-left so earlier byte offsets stay
/// valid as later spans are replaced. Mirrors `applySnippetMatchesReverse`.
fn apply_matches_reverse(text: &str, matches: &[SnippetMatch]) -> String {
    let mut result = text.to_string();
    for m in matches.iter().rev() {
        result.replace_range(m.start..m.end, &m.expansion);
    }
    result
}

/// Apply one snippet's matches to `text`. No-op when the trigger has zero matches.
fn apply_one_snippet(text: &str, trigger: &str, expansion: &str) -> String {
    let matches = find_snippet_matches(text, trigger, expansion);
    if matches.is_empty() {
        text.to_string()
    } else {
        apply_matches_reverse(text, &matches)
    }
}

/// Apply every snippet's fuzzy trigger in order, splicing each matched word-span
/// with its expansion. Surrounding punctuation stays put (matches end at word
/// boundaries). Mirrors `replaceWithSnippets`.
pub fn replace_with_snippets(text: &str, snippets: &[SnippetEntry]) -> String {
    let mut result = text.to_string();
    for snip in snippets {
        // `rebuildSnippets` already drops empty-trigger/empty-expansion entries,
        // but guard here too so a direct caller can't splice an empty expansion.
        if snip.trigger.is_empty() || snip.expansion.is_empty() {
            continue;
        }
        result = apply_one_snippet(&result, &snip.trigger, &snip.expansion);
    }
    result
}

// ===========================================================================
// SnippetsManager — thread-safe cache mirroring cachedSnippets / rebuildSnippets.
// ===========================================================================

/// Keep only entries with BOTH a non-empty trigger AND a non-empty expansion
/// (mirrors `rebuildSnippets`'s `Boolean(e.trigger && e.expansion)` filter).
fn sanitize(entries: &[SnippetEntry]) -> Vec<SnippetEntry> {
    entries
        .iter()
        .filter(|e| !e.trigger.is_empty() && !e.expansion.is_empty())
        .cloned()
        .collect()
}

/// Owns the warm snippet cache. Registered as Tauri managed state
/// (`Arc<SnippetsManager>`) in lib.rs setup, mirroring the other WinSTT managers.
/// Loaded from `WinsttSettings.snippets` and rebuilt whenever settings change (the
/// relay seam calls `reload_from_settings` after a save, just like the TS
/// `onDidChange("snippets", rebuildSnippets)` watcher). Replaces the former
/// process-wide `SNIPPET_STORE` static so the cache lifecycle is owned + testable.
pub struct SnippetsManager {
    app: AppHandle,
    /// The active snippet set the expansion pass uses (sanitized).
    store: RwLock<Vec<SnippetEntry>>,
}

impl SnippetsManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            store: RwLock::new(Vec::new()),
        }
    }

    /// Replace the cached snippet set (called on init + after every settings save).
    pub fn set_snippets(&self, entries: &[SnippetEntry]) {
        let sanitized = sanitize(entries);
        if let Ok(mut guard) = self.store.write() {
            *guard = sanitized;
        }
    }

    /// Reload the cache from the persisted settings tree. Call once at startup and
    /// from the settings-changed seam so a live snippet edit takes effect on the very
    /// next utterance — the in-proc analogue of `rebuildSnippets`.
    pub fn reload_from_settings(&self) {
        let settings = read_settings(&self.app);
        self.set_snippets(&settings.snippets);
    }

    /// Snapshot the cached snippets (the active set the expansion pass uses).
    fn cached_snippets(&self) -> Vec<SnippetEntry> {
        self.store.read().map(|g| g.clone()).unwrap_or_default()
    }

    /// Apply snippet expansion using the in-memory cache. Pure given the cache;
    /// returns `text` unchanged when the cache is empty. This is the hot-path entry
    /// the paste pipeline calls (no settings read — the cache is kept warm by
    /// `reload_from_settings`).
    pub fn expand_cached(&self, text: &str) -> String {
        if text.is_empty() {
            return text.to_string();
        }
        let snippets = self.cached_snippets();
        if snippets.is_empty() {
            return text.to_string();
        }
        replace_with_snippets(text, &snippets)
    }

    /// Apply snippet expansion, reading the live settings first. Used by callers that
    /// don't run on the cache-kept-warm hot path (e.g. the read-only preview command).
    /// The paste pipeline should prefer `expand_cached` (warmed by the relay).
    pub fn expand_snippets(&self, text: &str) -> String {
        self.reload_from_settings();
        self.expand_cached(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(trigger: &str, expansion: &str) -> SnippetEntry {
        SnippetEntry {
            id: "x".into(),
            trigger: trigger.into(),
            expansion: expansion.into(),
        }
    }

    // ── double metaphone parity (spot checks vs the npm package output) ──

    #[test]
    fn metaphone_basic_codes() {
        assert_eq!(double_metaphone("email"), ("AML".into(), "AML".into()));
        assert_eq!(double_metaphone("address"), ("ATRS".into(), "ATRS".into()));
        // 'X' initial → 'S'.
        assert_eq!(double_metaphone("Xavier").0.chars().next(), Some('S'));
        // 'PH' → 'F'.
        assert_eq!(double_metaphone("phone"), ("FN".into(), "FN".into()));
    }

    #[test]
    fn metaphone_homophones_overlap() {
        let see = double_metaphone("see");
        let sea = double_metaphone("sea");
        assert!(phonetic_overlap(&see, &sea));
    }

    // ── jaro-winkler matches the snippet threshold expectations ──

    #[test]
    fn jw_close_strings_clear_threshold() {
        // "my email adress" vs "my email address" (dropped 'd') clears 0.92.
        assert!(jaro_winkler("my email adress", "my email address") >= SNIPPET_JW_THRESHOLD);
    }

    // ── full expansion behavior (mirrors text-processing.test.ts) ──

    #[test]
    fn expands_multiword_trigger_on_exact_match() {
        let s = vec![entry("my email address", "user@example.test")];
        assert_eq!(
            replace_with_snippets("forward to my email address", &s),
            "forward to user@example.test"
        );
    }

    #[test]
    fn expands_fuzzy_trigger_when_letter_dropped() {
        let s = vec![entry("my email address", "user@example.test")];
        assert_eq!(
            replace_with_snippets("forward to my email adress", &s),
            "forward to user@example.test"
        );
    }

    #[test]
    fn empty_trigger_is_filtered_out() {
        let s = vec![entry("", "X"), entry("my email", "user@example.test")];
        assert_eq!(
            replace_with_snippets("send my email", &s),
            "send user@example.test"
        );
    }

    #[test]
    fn preserves_trailing_punctuation() {
        let s = vec![entry("my email", "user@example.test")];
        assert_eq!(
            replace_with_snippets("send my email.", &s),
            "send user@example.test."
        );
    }

    #[test]
    fn does_not_over_match_unrelated_text() {
        let s = vec![entry("my email address", "user@example.test")];
        let input = "a totally different sentence";
        assert_eq!(replace_with_snippets(input, &s), input);
    }

    #[test]
    fn non_overlapping_left_to_right() {
        let s = vec![entry("my email", "E")];
        // Two occurrences, each replaced independently.
        assert_eq!(
            replace_with_snippets("my email and my email", &s),
            "E and E"
        );
    }

    #[test]
    fn empty_text_is_noop() {
        let s = vec![entry("my email", "X")];
        assert_eq!(replace_with_snippets("", &s), "");
    }

    #[test]
    fn store_sanitizes_empty_entries() {
        let raw = vec![
            entry("trigger", "exp"),
            entry("", "exp"),
            entry("trigger2", ""),
        ];
        assert_eq!(sanitize(&raw).len(), 1);
    }

    #[test]
    fn unicode_words_do_not_panic_on_byte_slicing() {
        // Cyrillic words tokenize via \p{L}, but double-metaphone returns empty
        // codes for non-Latin scripts (verified against the `double-metaphone` npm
        // package: `доubleMetaphone("привет мир") === ["",""]`). The phonetic gate
        // (empty keys never overlap) therefore fails, so the snippet does NOT
        // expand — byte-IDENTICAL to the reference TS path. The load-bearing
        // assertion here is that multi-byte word spans never panic the splice.
        let s = vec![entry("привет мир", "HELLO")];
        assert_eq!(replace_with_snippets("привет мир!", &s), "привет мир!");
    }
}
