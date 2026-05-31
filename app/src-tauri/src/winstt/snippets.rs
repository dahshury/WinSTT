// PORT IMPL — deterministic snippet / text-expansion engine.
//
// Source of truth (behavioral): frontend/src/shared/lib/fuzzy-match.ts
// (`replaceWithSnippets` / `findSnippetMatches` + `doubleMetaphone`) and
// frontend/electron/lib/text-processing.ts (`rebuildSnippets` /
// `applyPostProcessing`), wired into the recorder via electron/ipc/relay.ts.
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

use std::sync::RwLock;

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::AppHandle;

use crate::winstt::commands::settings::read_settings;
use crate::winstt::settings_schema::SnippetEntry;

// Words are letters/digits/apostrophes. Punctuation is intentionally excluded so
// it stays in the surrounding text when a fuzzy match replaces a span — e.g.
// "address." stays as match("address") + literal ".". Mirrors the TS
// `WORD_RE = /[\p{L}\p{N}']+/gu`. The `regex` crate has Unicode classes on by
// default, so `\p{L}` / `\p{N}` resolve the same way.
static WORD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\p{L}\p{N}']+").expect("valid word regex"));

/// Jaro-Winkler acceptance bar for a candidate window vs. a trigger. Mirrors the
/// TS `SNIPPET_JW_THRESHOLD` (0.92). Higher than the dictionary bar because a
/// snippet expansion is a hard splice of multi-word phrases — a false positive is
/// far more disruptive than a single-word dictionary canonicalization.
pub const SNIPPET_JW_THRESHOLD: f64 = 0.92;

// ===========================================================================
// Jaro-Winkler (reuse strsim — identical formula to the TS implementation)
// ===========================================================================

/// Jaro-Winkler similarity in `0.0..=1.0`. Delegated to `strsim::jaro_winkler`,
/// which is byte-for-byte the same algorithm the TS path hand-rolls: standard
/// Jaro, then a 0.1 prefix scale on the up-to-4-char shared prefix, applied only
/// when the base Jaro clears the 0.7 floor.
fn jaro_winkler(a: &str, b: &str) -> f64 {
    strsim::jaro_winkler(a, b)
}

// ===========================================================================
// Double Metaphone — faithful port of the `double-metaphone` npm package.
// Returns `(primary, secondary)`; either may be empty for unmappable input.
// ===========================================================================

fn is_vowel(c: char) -> bool {
    matches!(c, 'A' | 'E' | 'I' | 'O' | 'U' | 'Y')
}

/// Char at `idx` into the padded character vector, or `'\0'` when out of range.
/// The TS version reads `characters[idx]` which is `undefined` out of range; we
/// model that as the NUL sentinel (which never equals a real letter test) so the
/// comparison branches behave identically.
fn at(chars: &[char], idx: i64) -> char {
    if idx < 0 {
        return '\0';
    }
    chars.get(idx as usize).copied().unwrap_or('\0')
}

/// Faithful port of JS `String.prototype.slice(start, end)` over the padded
/// uppercase character vector. This MUST match JS semantics for negative indices
/// exactly: a negative argument resolves to `len + arg` (clamped to ≥ 0), and a
/// resolved `start >= end` yields the empty string. The double-metaphone algorithm
/// relies on this — e.g. at `index = 0`, `slice(index - 2, index + 4)` is
/// `slice(-2, 4)` which JS resolves to `""` (because `len - 2 > 4`), NOT
/// `slice(0, 4)`. Getting this wrong silently changes Germanic-`C`/`CH` branch
/// decisions. (See the regression note in tests.)
fn slice(norm: &[char], start: i64, end: i64) -> String {
    let len = norm.len() as i64;
    let resolve = |i: i64| -> i64 {
        if i < 0 {
            (len + i).max(0)
        } else {
            i.min(len)
        }
    };
    let s = resolve(start);
    let e = resolve(end);
    if s >= e {
        return String::new();
    }
    norm[s as usize..e as usize].iter().collect()
}

#[allow(clippy::too_many_lines)]
fn double_metaphone(value: &str) -> (String, String) {
    let mut primary = String::new();
    let mut secondary = String::new();
    let mut index: i64 = 0;

    let upper = value.to_uppercase();
    let length = upper.chars().count() as i64;
    let last = length - 1;
    // Pad with 5 spaces so look-ahead slices never read past the end (mirrors the
    // TS `+ '     '`). The padding is whitespace, which no branch treats as a
    // letter, so it is inert for matching.
    let normalized: Vec<char> = format!("{upper}     ").chars().collect();

    let norm_string: String = normalized.iter().collect();
    let is_slavo_germanic = norm_string.contains('W')
        || norm_string.contains('K')
        || norm_string.contains("CZ")
        || norm_string.contains("WITZ");
    let is_germanic = norm_string.starts_with("VAN ")
        || norm_string.starts_with("VON ")
        || norm_string.starts_with("SCH");

    let chars = &normalized;

    // Skip first char of `GN`/`KN`/`PN`/`WR`/`PS`.
    let initial = slice(chars, 0, 2);
    if matches!(initial.as_str(), "GN" | "KN" | "PN" | "WR" | "PS") {
        index += 1;
    }

    // Initial X is pronounced Z → S (`Xavier`).
    if at(chars, 0) == 'X' {
        primary.push('S');
        secondary.push('S');
        index += 1;
    }

    while index < length {
        let previous = at(chars, index - 1);
        let next = at(chars, index + 1);
        let nextnext = at(chars, index + 2);
        let current = at(chars, index);

        match current {
            'A' | 'E' | 'I' | 'O' | 'U' | 'Y' | 'À' | 'Ê' | 'É' => {
                if index == 0 {
                    primary.push('A');
                    secondary.push('A');
                }
                index += 1;
            }
            'B' => {
                primary.push('P');
                secondary.push('P');
                if next == 'B' {
                    index += 1;
                }
                index += 1;
            }
            'Ç' => {
                primary.push('S');
                secondary.push('S');
                index += 1;
            }
            'C' => {
                // Various Germanic.
                let bacher_macher = {
                    let sv = slice(chars, index - 2, index + 4);
                    sv == "BACHER" || sv == "MACHER"
                };
                if previous == 'A'
                    && next == 'H'
                    && nextnext != 'I'
                    && !is_vowel(at(chars, index - 2))
                    && (nextnext != 'E' || bacher_macher)
                {
                    primary.push('K');
                    secondary.push('K');
                    index += 2;
                    continue;
                }
                // `Caesar`.
                if index == 0 && slice(chars, index + 1, index + 6) == "AESAR" {
                    primary.push('S');
                    secondary.push('S');
                    index += 2;
                    continue;
                }
                // Italian `Chianti`.
                if slice(chars, index + 1, index + 4) == "HIA" {
                    primary.push('K');
                    secondary.push('K');
                    index += 2;
                    continue;
                }
                if next == 'H' {
                    // `Michael`.
                    if index > 0 && nextnext == 'A' && at(chars, index + 3) == 'E' {
                        primary.push('K');
                        secondary.push('X');
                        index += 2;
                        continue;
                    }
                    // Greek roots `chemistry`, `chorus`.
                    if index == 0 && initial_greek_ch(&norm_string) {
                        primary.push('K');
                        secondary.push('K');
                        index += 2;
                        continue;
                    }
                    // Germanic / Greek / `CH` for `KH`.
                    let greek = {
                        let sv = slice(chars, index - 2, index + 4);
                        sv.contains("ORCHES") || sv.contains("ARCHIT") || sv.contains("ORCHID")
                    };
                    let ch_for_kh = matches!(nextnext, ' ' | 'B' | 'F' | 'H' | 'L' | 'M' | 'N' | 'R' | 'V' | 'W');
                    if is_germanic
                        || greek
                        || nextnext == 'T'
                        || nextnext == 'S'
                        || ((index == 0
                            || previous == 'A'
                            || previous == 'E'
                            || previous == 'O'
                            || previous == 'U')
                            && ch_for_kh)
                    {
                        primary.push('K');
                        secondary.push('K');
                    } else if index == 0 {
                        primary.push('X');
                        secondary.push('X');
                    } else if slice(chars, 0, 2) == "MC" {
                        primary.push('K');
                        secondary.push('K');
                    } else {
                        primary.push('X');
                        secondary.push('K');
                    }
                    index += 2;
                    continue;
                }
                // `Czerny`.
                if next == 'Z' && slice(chars, index - 2, index) != "WI" {
                    primary.push('S');
                    secondary.push('X');
                    index += 2;
                    continue;
                }
                // `Focaccia`.
                if slice(chars, index + 1, index + 4) == "CIA" {
                    primary.push('X');
                    secondary.push('X');
                    index += 3;
                    continue;
                }
                // Double `C`, but not `McClellan`.
                if next == 'C' && !(index == 1 && at(chars, 0) == 'M') {
                    if (nextnext == 'I' || nextnext == 'E' || nextnext == 'H')
                        && slice(chars, index + 2, index + 4) != "HU"
                    {
                        let sv = slice(chars, index - 1, index + 4);
                        if (index == 1 && previous == 'A') || sv == "UCCEE" || sv == "UCCES" {
                            primary.push_str("KS");
                            secondary.push_str("KS");
                        } else {
                            primary.push('X');
                            secondary.push('X');
                        }
                        index += 3;
                        continue;
                    }
                    // Pierce's rule.
                    primary.push('K');
                    secondary.push('K');
                    index += 2;
                    continue;
                }
                if next == 'G' || next == 'K' || next == 'Q' {
                    primary.push('K');
                    secondary.push('K');
                    index += 2;
                    continue;
                }
                // Italian.
                if next == 'I' && (nextnext == 'E' || nextnext == 'O') {
                    primary.push('S');
                    secondary.push('X');
                    index += 2;
                    continue;
                }
                if next == 'I' || next == 'E' || next == 'Y' {
                    primary.push('S');
                    secondary.push('S');
                    index += 2;
                    continue;
                }
                primary.push('K');
                secondary.push('K');
                // `Mac Caffrey`, `Mac Gregor`.
                if next == ' ' && (nextnext == 'C' || nextnext == 'G' || nextnext == 'Q') {
                    index += 3;
                    continue;
                }
                index += 1;
            }
            'D' => {
                if next == 'G' {
                    if nextnext == 'E' || nextnext == 'I' || nextnext == 'Y' {
                        primary.push('J');
                        secondary.push('J');
                        index += 3;
                    } else {
                        primary.push_str("TK");
                        secondary.push_str("TK");
                        index += 2;
                    }
                    continue;
                }
                if next == 'T' || next == 'D' {
                    primary.push('T');
                    secondary.push('T');
                    index += 2;
                    continue;
                }
                primary.push('T');
                secondary.push('T');
                index += 1;
            }
            'F' => {
                if next == 'F' {
                    index += 1;
                }
                index += 1;
                primary.push('F');
                secondary.push('F');
            }
            'G' => {
                if next == 'H' {
                    if index > 0 && !is_vowel(previous) {
                        primary.push('K');
                        secondary.push('K');
                        index += 2;
                        continue;
                    }
                    if index == 0 {
                        if nextnext == 'I' {
                            primary.push('J');
                            secondary.push('J');
                        } else {
                            primary.push('K');
                            secondary.push('K');
                        }
                        index += 2;
                        continue;
                    }
                    // Parker's rule.
                    let c2 = at(chars, index - 2);
                    let c3 = at(chars, index - 3);
                    let c4 = at(chars, index - 4);
                    if matches!(c2, 'B' | 'H' | 'D')
                        || matches!(c3, 'B' | 'H' | 'D')
                        || matches!(c4, 'B' | 'H')
                    {
                        index += 2;
                        continue;
                    }
                    if index > 2 && previous == 'U' && matches!(c3, 'C' | 'G' | 'L' | 'R' | 'T') {
                        primary.push('F');
                        secondary.push('F');
                    } else if index > 0 && previous != 'I' {
                        primary.push('K');
                        secondary.push('K');
                    }
                    index += 2;
                    continue;
                }
                if next == 'N' {
                    if index == 1 && is_vowel(at(chars, 0)) && !is_slavo_germanic {
                        primary.push_str("KN");
                        secondary.push('N');
                    } else if slice(chars, index + 2, index + 4) != "EY"
                        && slice(chars, index + 1, length) != "Y"
                        && !is_slavo_germanic
                    {
                        primary.push('N');
                        secondary.push_str("KN");
                    } else {
                        primary.push_str("KN");
                        secondary.push_str("KN");
                    }
                    index += 2;
                    continue;
                }
                // `Tagliaro`.
                if slice(chars, index + 1, index + 3) == "LI" && !is_slavo_germanic {
                    primary.push_str("KL");
                    secondary.push('L');
                    index += 2;
                    continue;
                }
                // -ges-, -gep-, -gel- at beginning.
                if index == 0 && initial_g_for_kj(&slice(chars, 1, 3)) {
                    primary.push('K');
                    secondary.push('J');
                    index += 2;
                    continue;
                }
                // -ger-, -gy-.
                let anger_exc = initial_anger_exception(&slice(chars, 0, 6));
                let g_for_kj_prev = matches!(previous, 'E' | 'G' | 'I' | 'R');
                if (slice(chars, index + 1, index + 3) == "ER"
                    && previous != 'I'
                    && previous != 'E'
                    && !anger_exc)
                    || (next == 'Y' && !g_for_kj_prev)
                {
                    primary.push('K');
                    secondary.push('J');
                    index += 2;
                    continue;
                }
                // Italian `biaggi`.
                if next == 'E'
                    || next == 'I'
                    || next == 'Y'
                    || ((previous == 'A' || previous == 'O') && next == 'G' && nextnext == 'I')
                {
                    if slice(chars, index + 1, index + 3) == "ET" || is_germanic {
                        primary.push('K');
                        secondary.push('K');
                    } else {
                        primary.push('J');
                        if slice(chars, index + 1, index + 5) == "IER " {
                            secondary.push('J');
                        } else {
                            secondary.push('K');
                        }
                    }
                    index += 2;
                    continue;
                }
                if next == 'G' {
                    index += 1;
                }
                index += 1;
                primary.push('K');
                secondary.push('K');
            }
            'H' => {
                if is_vowel(next) && (index == 0 || is_vowel(previous)) {
                    primary.push('H');
                    secondary.push('H');
                    index += 1;
                }
                index += 1;
            }
            'J' => {
                // Spanish `jose`, `San Jacinto`.
                if slice(chars, index, index + 4) == "JOSE" || slice(chars, 0, 4) == "SAN " {
                    if slice(chars, 0, 4) == "SAN " || (index == 0 && at(chars, index + 4) == ' ') {
                        primary.push('H');
                        secondary.push('H');
                    } else {
                        primary.push('J');
                        secondary.push('H');
                    }
                    index += 1;
                    continue;
                }
                if index == 0 {
                    primary.push('J');
                    secondary.push('A');
                } else if !is_slavo_germanic
                    && (next == 'A' || next == 'O')
                    && is_vowel(previous)
                {
                    primary.push('J');
                    secondary.push('H');
                } else if index == last {
                    primary.push('J');
                } else if previous != 'S'
                    && previous != 'K'
                    && previous != 'L'
                    && !matches!(next, 'L' | 'T' | 'K' | 'S' | 'N' | 'M' | 'B' | 'Z')
                {
                    primary.push('J');
                    secondary.push('J');
                } else if next == 'J' {
                    index += 1;
                }
                index += 1;
            }
            'K' => {
                if next == 'K' {
                    index += 1;
                }
                primary.push('K');
                secondary.push('K');
                index += 1;
            }
            'L' => {
                if next == 'L' {
                    // Spanish `cabrillo`, `gallegos`.
                    let alle = {
                        let sv = slice(chars, last - 1, length);
                        sv == "AS" || sv == "OS"
                    };
                    let cl = at(chars, last);
                    if (index == length - 3
                        && ((previous == 'A' && nextnext == 'E')
                            || (previous == 'I' && (nextnext == 'O' || nextnext == 'A'))))
                        || (previous == 'A'
                            && nextnext == 'E'
                            && (cl == 'A' || cl == 'O' || alle))
                    {
                        primary.push('L');
                        index += 2;
                        continue;
                    }
                    index += 1;
                }
                primary.push('L');
                secondary.push('L');
                index += 1;
            }
            'M' => {
                if next == 'M'
                    || (previous == 'U'
                        && next == 'B'
                        && (index + 1 == last || slice(chars, index + 2, index + 4) == "ER"))
                {
                    index += 1;
                }
                index += 1;
                primary.push('M');
                secondary.push('M');
            }
            'N' => {
                if next == 'N' {
                    index += 1;
                }
                index += 1;
                primary.push('N');
                secondary.push('N');
            }
            'Ñ' => {
                index += 1;
                primary.push('N');
                secondary.push('N');
            }
            'P' => {
                if next == 'H' {
                    primary.push('F');
                    secondary.push('F');
                    index += 2;
                    continue;
                }
                if next == 'P' || next == 'B' {
                    index += 1;
                }
                index += 1;
                primary.push('P');
                secondary.push('P');
            }
            'Q' => {
                if next == 'Q' {
                    index += 1;
                }
                index += 1;
                primary.push('K');
                secondary.push('K');
            }
            'R' => {
                if index == last
                    && !is_slavo_germanic
                    && previous == 'E'
                    && at(chars, index - 2) == 'I'
                    && at(chars, index - 4) != 'M'
                    && at(chars, index - 3) != 'E'
                    && at(chars, index - 3) != 'A'
                {
                    secondary.push('R');
                } else {
                    primary.push('R');
                    secondary.push('R');
                }
                if next == 'R' {
                    index += 1;
                }
                index += 1;
            }
            'S' => {
                // `island`, `isle`, `carlisle`, `carlysle`.
                if next == 'L' && (previous == 'I' || previous == 'Y') {
                    index += 1;
                    continue;
                }
                // `sugar-`.
                if index == 0 && slice(chars, 1, 5) == "UGAR" {
                    primary.push('X');
                    secondary.push('S');
                    index += 1;
                    continue;
                }
                if next == 'H' {
                    let h_for_s = {
                        let sv = slice(chars, index + 1, index + 5);
                        matches!(sv.as_str(), "EIM" | "OEK" | "OLM" | "OLZ")
                            || sv.starts_with("EIM")
                            || sv.starts_with("OEK")
                            || sv.starts_with("OLM")
                            || sv.starts_with("OLZ")
                    };
                    if h_for_s {
                        primary.push('S');
                        secondary.push('S');
                    } else {
                        primary.push('X');
                        secondary.push('X');
                    }
                    index += 2;
                    continue;
                }
                if next == 'I' && (nextnext == 'O' || nextnext == 'A') {
                    if is_slavo_germanic {
                        primary.push('S');
                        secondary.push('S');
                    } else {
                        primary.push('S');
                        secondary.push('X');
                    }
                    index += 3;
                    continue;
                }
                if next == 'Z'
                    || (index == 0 && (next == 'L' || next == 'M' || next == 'N' || next == 'W'))
                {
                    primary.push('S');
                    secondary.push('X');
                    if next == 'Z' {
                        index += 1;
                    }
                    index += 1;
                    continue;
                }
                if next == 'C' {
                    // Schlesinger's rule.
                    if nextnext == 'H' {
                        let sv = slice(chars, index + 3, index + 5);
                        let dutch = matches!(
                            sv.as_str(),
                            "ED" | "EM" | "EN" | "ER" | "UY" | "OO"
                        ) || sv.starts_with("ED")
                            || sv.starts_with("EM")
                            || sv.starts_with("EN")
                            || sv.starts_with("ER")
                            || sv.starts_with("UY")
                            || sv.starts_with("OO");
                        if dutch {
                            if sv == "ER" || sv == "EN" {
                                primary.push('X');
                                secondary.push_str("SK");
                            } else {
                                primary.push_str("SK");
                                secondary.push_str("SK");
                            }
                            index += 3;
                            continue;
                        }
                        if index == 0 && !is_vowel(at(chars, 3)) && at(chars, 3) != 'W' {
                            primary.push('X');
                            secondary.push('S');
                        } else {
                            primary.push('X');
                            secondary.push('X');
                        }
                        index += 3;
                        continue;
                    }
                    if nextnext == 'I' || nextnext == 'E' || nextnext == 'Y' {
                        primary.push('S');
                        secondary.push('S');
                        index += 3;
                        continue;
                    }
                    primary.push_str("SK");
                    secondary.push_str("SK");
                    index += 3;
                    continue;
                }
                let sv = slice(chars, index - 2, index);
                if index == last && (sv == "AI" || sv == "OI") {
                    secondary.push('S');
                } else {
                    primary.push('S');
                    secondary.push('S');
                }
                if next == 'S' {
                    index += 1;
                }
                index += 1;
            }
            'T' => {
                if next == 'I' && nextnext == 'O' && at(chars, index + 3) == 'N' {
                    primary.push('X');
                    secondary.push('X');
                    index += 3;
                    continue;
                }
                if (next == 'I' && nextnext == 'A') || (next == 'C' && nextnext == 'H') {
                    primary.push('X');
                    secondary.push('X');
                    index += 3;
                    continue;
                }
                if next == 'H' || (next == 'T' && nextnext == 'H') {
                    if is_germanic
                        || ((nextnext == 'O' || nextnext == 'A') && at(chars, index + 3) == 'M')
                    {
                        primary.push('T');
                        secondary.push('T');
                    } else {
                        primary.push('0');
                        secondary.push('T');
                    }
                    index += 2;
                    continue;
                }
                if next == 'T' || next == 'D' {
                    index += 1;
                }
                index += 1;
                primary.push('T');
                secondary.push('T');
            }
            'V' => {
                if next == 'V' {
                    index += 1;
                }
                primary.push('F');
                secondary.push('F');
                index += 1;
            }
            'W' => {
                if next == 'R' {
                    primary.push('R');
                    secondary.push('R');
                    index += 2;
                    continue;
                }
                if index == 0 {
                    if is_vowel(next) {
                        primary.push('A');
                        secondary.push('F');
                    } else if next == 'H' {
                        primary.push('A');
                        secondary.push('A');
                    }
                }
                if ((previous == 'E' || previous == 'O')
                    && next == 'S'
                    && nextnext == 'K'
                    && (at(chars, index + 3) == 'I' || at(chars, index + 3) == 'Y'))
                    || slice(chars, 0, 3) == "SCH"
                    || (index == last && is_vowel(previous))
                {
                    secondary.push('F');
                    index += 1;
                    continue;
                }
                // Polish `Filipowicz`.
                if next == 'I'
                    && (nextnext == 'C' || nextnext == 'T')
                    && at(chars, index + 3) == 'Z'
                {
                    primary.push_str("TS");
                    secondary.push_str("FX");
                    index += 4;
                    continue;
                }
                index += 1;
            }
            'X' => {
                // French `breaux`.
                if !(index == last
                    && previous == 'U'
                    && (at(chars, index - 2) == 'A' || at(chars, index - 2) == 'O'))
                {
                    primary.push_str("KS");
                    secondary.push_str("KS");
                }
                if next == 'C' || next == 'X' {
                    index += 1;
                }
                index += 1;
            }
            'Z' => {
                // Chinese pinyin `Zhao`.
                if next == 'H' {
                    primary.push('J');
                    secondary.push('J');
                    index += 2;
                    continue;
                }
                if (next == 'Z' && (nextnext == 'A' || nextnext == 'I' || nextnext == 'O'))
                    || (is_slavo_germanic && index > 0 && previous != 'T')
                {
                    primary.push('S');
                    secondary.push_str("TS");
                } else {
                    primary.push('S');
                    secondary.push('S');
                }
                if next == 'Z' {
                    index += 1;
                }
                index += 1;
            }
            _ => {
                index += 1;
            }
        }
    }

    (primary, secondary)
}

// initialGreekCh = /^CH(IA|EM|OR([^E])|YM|ARAC|ARIS)/
fn initial_greek_ch(norm: &str) -> bool {
    let Some(rest) = norm.strip_prefix("CH") else {
        return false;
    };
    rest.starts_with("IA")
        || rest.starts_with("EM")
        || (rest.starts_with("OR") && rest.chars().nth(2).is_some_and(|c| c != 'E'))
        || rest.starts_with("YM")
        || rest.starts_with("ARAC")
        || rest.starts_with("ARIS")
}

// initialGForKj = /Y[\s\S]|E[BILPRSY]|I[BELN]/ tested against `normalized.slice(1, 3)`.
fn initial_g_for_kj(s: &str) -> bool {
    let cs: Vec<char> = s.chars().collect();
    if cs.is_empty() {
        return false;
    }
    let a = cs[0];
    let b = cs.get(1).copied().unwrap_or('\0');
    (a == 'Y' && b != '\0')
        || (a == 'E' && matches!(b, 'B' | 'I' | 'L' | 'P' | 'R' | 'S' | 'Y'))
        || (a == 'I' && matches!(b, 'B' | 'E' | 'L' | 'N'))
}

// initialAngerException = /^[DMR]ANGER/ tested against `normalized.slice(0, 6)`.
fn initial_anger_exception(s: &str) -> bool {
    let mut chars = s.chars();
    let first = chars.next().unwrap_or('\0');
    matches!(first, 'D' | 'M' | 'R') && chars.as_str().starts_with("ANGER")
}

/// Whether a non-empty key equals either slot of `b`. Empty keys never overlap
/// (double-metaphone returns "" for unmappable input). Mirrors `keyMatchesPair`.
fn key_matches_pair(key: &str, b: &(String, String)) -> bool {
    if key.is_empty() {
        return false;
    }
    key == b.0 || key == b.1
}

/// True iff any populated metaphone slot of `a` overlaps a slot of `b`. Mirrors
/// `phoneticOverlap` — the phonetic-confirmation half of the snippet gate.
fn phonetic_overlap(a: &(String, String), b: &(String, String)) -> bool {
    key_matches_pair(&a.0, b) || key_matches_pair(&a.1, b)
}

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
// SnippetStore — thread-safe cache mirroring cachedSnippets / rebuildSnippets.
// ===========================================================================

/// Process-wide snippet cache. Loaded from `WinsttSettings.snippets` and rebuilt
/// whenever settings change (the relay seam calls `reload` after a settings save,
/// just like the TS `onDidChange("snippets", rebuildSnippets)` watcher).
static SNIPPET_STORE: Lazy<RwLock<Vec<SnippetEntry>>> = Lazy::new(|| RwLock::new(Vec::new()));

/// Keep only entries with BOTH a non-empty trigger AND a non-empty expansion
/// (mirrors `rebuildSnippets`'s `Boolean(e.trigger && e.expansion)` filter).
fn sanitize(entries: &[SnippetEntry]) -> Vec<SnippetEntry> {
    entries
        .iter()
        .filter(|e| !e.trigger.is_empty() && !e.expansion.is_empty())
        .cloned()
        .collect()
}

/// Replace the cached snippet set (called on init + after every settings save).
pub fn set_snippets(entries: &[SnippetEntry]) {
    let sanitized = sanitize(entries);
    if let Ok(mut guard) = SNIPPET_STORE.write() {
        *guard = sanitized;
    }
}

/// Reload the cache from the persisted settings tree. Call once at startup and
/// from the settings-changed seam so a live snippet edit takes effect on the very
/// next utterance — the in-proc analogue of `rebuildSnippets`.
pub fn reload_from_settings(app: &AppHandle) {
    let settings = read_settings(app);
    set_snippets(&settings.snippets);
}

/// Snapshot the cached snippets (the active set the expansion pass uses).
fn cached_snippets() -> Vec<SnippetEntry> {
    SNIPPET_STORE
        .read()
        .map(|g| g.clone())
        .unwrap_or_default()
}

/// Apply snippet expansion using the in-memory cache. Pure given the cache;
/// returns `text` unchanged when the cache is empty. This is the hot-path entry
/// the paste pipeline calls (no settings read — the cache is kept warm by
/// `reload_from_settings`).
pub fn expand_cached(text: &str) -> String {
    if text.is_empty() {
        return text.to_string();
    }
    let snippets = cached_snippets();
    if snippets.is_empty() {
        return text.to_string();
    }
    replace_with_snippets(text, &snippets)
}

/// Apply snippet expansion, reading the live settings first. Used by callers that
/// don't run on the cache-kept-warm hot path (e.g. a one-shot CLI / test seam).
/// The paste pipeline should prefer `expand_cached` (warmed by the relay).
pub fn expand_snippets(app: &AppHandle, text: &str) -> String {
    reload_from_settings(app);
    expand_cached(text)
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
        let s = vec![entry("my email address", "khaled@example.com")];
        assert_eq!(
            replace_with_snippets("forward to my email address", &s),
            "forward to khaled@example.com"
        );
    }

    #[test]
    fn expands_fuzzy_trigger_when_letter_dropped() {
        let s = vec![entry("my email address", "khaled@example.com")];
        assert_eq!(
            replace_with_snippets("forward to my email adress", &s),
            "forward to khaled@example.com"
        );
    }

    #[test]
    fn empty_trigger_is_filtered_out() {
        let s = vec![entry("", "X"), entry("my email", "khaled@example.com")];
        assert_eq!(
            replace_with_snippets("send my email", &s),
            "send khaled@example.com"
        );
    }

    #[test]
    fn preserves_trailing_punctuation() {
        let s = vec![entry("my email", "khaled@example.com")];
        assert_eq!(
            replace_with_snippets("send my email.", &s),
            "send khaled@example.com."
        );
    }

    #[test]
    fn does_not_over_match_unrelated_text() {
        let s = vec![entry("my email address", "khaled@example.com")];
        let input = "a totally different sentence";
        assert_eq!(replace_with_snippets(input, &s), input);
    }

    #[test]
    fn non_overlapping_left_to_right() {
        let s = vec![entry("my email", "E")];
        // Two occurrences, each replaced independently.
        assert_eq!(replace_with_snippets("my email and my email", &s), "E and E");
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
