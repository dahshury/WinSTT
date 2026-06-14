//! Phonetic candidate generation for the encoder dictionary fallback — a faithful Rust port of the
//! validated Python spike (`tools/bench/eval_encoder_dict.py`). PURE logic, no model: it proposes
//! `(span -> dictionary term)` replacements wherever a 1–2 word span *sounds like* a term, so the
//! masked-LM judge ([`super::engine`]) only ever has to score genuine phonetic collisions.
//!
//! Matching = Soundex equality OR a tight normalized-Levenshtein bar (< 0.34). The tight edit bar is
//! load-bearing: 0.5 let garbage through ("please"~"supabase", "mute"~"vite"); real collisions
//! (video/veet/vat ~ "Vite") come in via Soundex. Verified end-to-end: 0 false positives on the
//! held-out adversarial set.

use strsim::levenshtein;

/// Max normalized edit distance for an edit-only (non-Soundex) phonetic match.
const EDIT_RATIO_MAX: f64 = 0.34;

/// A proposed replacement: the byte span `[start, end)` in the source text and the dictionary term
/// it sounds like. `words` is the span's word count (longer spans win on overlap); `edit` is the
/// normalized-form edit distance to the term (closer wins on ties).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub start: usize,
    pub end: usize,
    pub words: usize,
    pub edit: usize,
    pub term: String,
}

/// English-style Soundex code (first letter + 3 digits). Crude but fine here — it only PROPOSES
/// candidates; the masked-LM makes the real decision. Non-ASCII letters collapse to no-code, so
/// non-Latin scripts simply fall back to the edit-distance / exact path.
fn soundex(word: &str) -> String {
    let letters: Vec<char> = word
        .chars()
        .flat_map(|c| c.to_lowercase())
        .filter(|c| c.is_ascii_alphabetic())
        .collect();
    let Some(&first) = letters.first() else {
        return String::new();
    };
    let digit = |c: char| -> Option<char> {
        match c {
            'b' | 'f' | 'p' | 'v' => Some('1'),
            'c' | 'g' | 'j' | 'k' | 'q' | 's' | 'x' | 'z' => Some('2'),
            'd' | 't' => Some('3'),
            'l' => Some('4'),
            'm' | 'n' => Some('5'),
            'r' => Some('6'),
            _ => None, // vowels + h/w
        }
    };
    let mut out = String::new();
    out.push(first.to_ascii_uppercase());
    let mut prev = digit(first);
    for &c in &letters[1..] {
        let d = digit(c);
        if let Some(dd) = d {
            if Some(dd) != prev {
                out.push(dd);
            }
        }
        // h/w are transparent (don't reset prev); vowels reset it so a digit can repeat across them.
        if c != 'h' && c != 'w' {
            prev = d;
        }
    }
    let mut s: String = out.chars().take(4).collect();
    while s.len() < 4 {
        s.push('0');
    }
    s
}

/// Lowercased, alphanumeric-only normalization used for both Soundex and edit comparisons.
fn normalize(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Whether normalized `a` (a spoken span) is phonetically close enough to normalized `b` (a term)
/// to be worth scoring. `a`/`b` must already be [`normalize`]d.
fn phonetic_close(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let sa = soundex(a);
    if !sa.is_empty() && sa == soundex(b) {
        return true;
    }
    let max_len = a.chars().count().max(b.chars().count()).max(1) as f64;
    (levenshtein(a, b) as f64) / max_len < EDIT_RATIO_MAX
}

/// Word = a run of alphanumerics (any script). Returns `(byte_start, byte_end)` spans.
fn word_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        if c.is_alphanumeric() {
            if start.is_none() {
                start = Some(i);
            }
        } else if let Some(s) = start.take() {
            spans.push((s, i));
        }
    }
    if let Some(s) = start {
        spans.push((s, text.len()));
    }
    spans
}

/// Propose replacement candidates for `terms` over 1–2 word windows of `text`. Permissive by design;
/// the masked-LM judge rejects the ones that don't fit context. Sorted longest-span-first, then
/// closest-edit, so e.g. "oh llama" beats the 1-word "llama" for "ollama".
pub fn candidates(text: &str, terms: &[String]) -> Vec<Candidate> {
    let words = word_spans(text);
    let term_norms: Vec<(String, &String)> =
        terms.iter().map(|t| (normalize(t), t)).filter(|(n, _)| !n.is_empty()).collect();
    let mut out: Vec<Candidate> = Vec::new();
    for (tnorm, term) in &term_norms {
        for n in (1..=2).rev() {
            if words.len() < n {
                continue;
            }
            for i in 0..=words.len() - n {
                let start = words[i].0;
                let end = words[i + n - 1].1;
                let span_norm = normalize(&text[start..end]);
                if phonetic_close(&span_norm, tnorm) {
                    out.push(Candidate {
                        start,
                        end,
                        words: n,
                        edit: levenshtein(&span_norm, tnorm),
                        term: (*term).clone(),
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| b.words.cmp(&a.words).then(a.edit.cmp(&b.edit)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm_close(a: &str, b: &str) -> bool {
        phonetic_close(&normalize(a), &normalize(b))
    }

    #[test]
    fn soundex_collisions_match_but_garbage_does_not() {
        // Real collisions the model must arbitrate (Soundex V300).
        assert!(norm_close("video", "vite"));
        assert!(norm_close("veet", "vite"));
        assert!(norm_close("vat", "vite"));
        // Garbage that the OLD 0.5 edit bar wrongly accepted — must now be rejected.
        assert!(!norm_close("please", "supabase"));
        assert!(!norm_close("mute", "vite"));
        assert!(!norm_close("wine", "vite"));
    }

    #[test]
    fn genuine_corruptions_match_via_edit() {
        assert!(norm_close("kubernetties", "kubernetes"));
        assert!(norm_close("supa base", "supabase"));
        assert!(norm_close("charge bee", "chargebee"));
    }

    #[test]
    fn prefers_two_word_span() {
        // "oh llama" should be proposed (2-word) and rank before the 1-word "llama".
        let c = candidates("run it with oh llama tonight", &["ollama".to_string()]);
        assert!(!c.is_empty());
        assert_eq!(c[0].words, 2);
        assert_eq!(&"run it with oh llama tonight"[c[0].start..c[0].end], "oh llama");
    }

    #[test]
    fn no_candidate_for_unrelated_words() {
        let c = candidates("will it transcribe the text cleanly", &["Vite".to_string()]);
        assert!(c.is_empty(), "unexpected candidates: {c:?}");
    }

    #[test]
    fn byte_spans_are_utf8_safe() {
        // Accented French must not panic and must slice on char boundaries.
        let c = candidates("la vidéo était très longue", &["Vite".to_string()]);
        for cand in &c {
            // slicing must be valid (would panic on a bad boundary)
            let _ = &"la vidéo était très longue"[cand.start..cand.end];
        }
    }
}
