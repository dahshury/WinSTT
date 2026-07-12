//! Phonetic retrieval index for the encoder dictionary fallback.
//!
//! This replaces the old "compare every 1–2 word window against every term" prefilter
//! (`phonetics.rs`, deleted). That design was O(words × terms) *and*, worse, every survivor became an
//! INDEPENDENT accept/reject test in the masked-LM — so with a large dictionary the false-positive
//! probability compounded roughly linearly with the number of terms.
//!
//! The retrieve-then-verify pattern (NVIDIA SpellMapper / Microsoft CSC / BR-ASR) fixes this: a
//! high-recall phonetic index returns a FIXED top-K (~10) candidate `(span → term)` pairs regardless
//! of how many terms the dictionary holds, and the masked-LM judge ([`super::engine`]) then makes a
//! single margin-based decision over that bounded set. Correction quality stops degrading with
//! dictionary size, and scorer cost is capped.
//!
//! Recall comes from two orthogonal signals, so no hand-tuned confusion table is needed:
//!   * **character n-grams** (n = 2..=3) — catch corruption-style errors (added/dropped/swapped
//!     letters: "kubernetties" ~ "kubernetes"). Script-agnostic, so Arabic/CJK terms are indexed too.
//!   * **Double Metaphone** (reusing the ONE faithful port in [`crate::winstt::snippets::phonetic`],
//!     not a second copy) — catches homophones an n-gram overlap misses ("veet"/"video" ~ "Vite" all
//!     share metaphone code "FT"). Latin-script only; non-Latin terms simply lean on n-grams + edit.
//!
//! The index only PROPOSES; the masked-LM margin rule accepts/rejects. So retrieval is deliberately
//! permissive — a proposed "video → Vite" is correct behaviour: the judge then keeps "video" in
//! "watch the video" (margin negative) and snaps "veet → Vite" in "install veet" (margin positive).

use std::collections::{HashMap, HashSet};

use strsim::levenshtein;

use crate::winstt::snippets::phonetic::double_metaphone;

/// How many candidate `(span, term)` pairs survive retrieval and reach the masked-LM judge, at most —
/// the load-bearing constant that decouples scorer cost / false-positive exposure from dictionary
/// size. ~10 is the SpellMapper operating point (≈90% recall@10).
pub const RETRIEVAL_TOP_K: usize = 10;

/// Widest spoken span (in words) a single dictionary term may be misheard across. 3 lets a two- or
/// three-word mis-hearing collapse to a one-word term ("oh llama" → "ollama", "supa base" →
/// "supabase"); the old prefilter capped at 2.
const MAX_WINDOW_WORDS: usize = 3;

/// Character n-gram sizes indexed per term. 2–3 balances recall (short terms like "Vite" still yield
/// grams) against index size.
const NGRAM_MIN: usize = 2;
const NGRAM_MAX: usize = 3;

/// Tight edit-ratio gate for the NON-homophone path (normalized Levenshtein). A candidate whose
/// metaphone does NOT match the term must be within this edit ratio to be proposed — the same 0.34
/// bar the validated spike used, kept so genuine corruptions pass while unrelated words that merely
/// share an n-gram do not. Homophones (metaphone-equal) bypass this (their edit distance is often
/// large, e.g. "veet"/"vite").
pub(super) const EDIT_RATIO_MAX: f64 = 0.34;

/// A proposed replacement: byte span `[start, end)` in the source text, the dictionary term it sounds
/// like, the retrieval `score` (higher = stronger phonetic match; ranks + caps at top-K), and the
/// normalized `edit` distance to the term (a deterministic, closeness-aware tiebreak when scores tie).
#[derive(Debug, Clone)]
pub struct Retrieved {
    pub start: usize,
    pub end: usize,
    pub term: String,
    pub score: f64,
    pub edit: f64,
}

/// Lowercased, alphanumeric-only normalization (any script) used for every phonetic comparison.
pub(super) fn normalize(s: &str) -> String {
    s.chars()
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Normalized edit distance in `0.0..=1.0` (0 = identical). Both args must already be [`normalize`]d.
pub(super) fn edit_ratio(a: &str, b: &str) -> f64 {
    let max_len = a.chars().count().max(b.chars().count()).max(1) as f64;
    levenshtein(a, b) as f64 / max_len
}

/// Character n-grams (n = [`NGRAM_MIN`]..=[`NGRAM_MAX`]) of a normalized string. For a string shorter
/// than `NGRAM_MIN`, the whole string is its own single gram so short terms still index.
fn char_ngrams(norm: &str) -> HashSet<String> {
    let chars: Vec<char> = norm.chars().collect();
    let mut out = HashSet::new();
    if chars.len() < NGRAM_MIN {
        if !chars.is_empty() {
            out.insert(norm.to_string());
        }
        return out;
    }
    for n in NGRAM_MIN..=NGRAM_MAX {
        if chars.len() < n {
            break;
        }
        for w in chars.windows(n) {
            out.insert(w.iter().collect());
        }
    }
    out
}

/// Word = a run of alphanumerics (any script). Returns `(byte_start, byte_end)` spans.
pub(super) fn word_spans(text: &str) -> Vec<(usize, usize)> {
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

/// Per-term metadata retained for scoring after the inverted index narrows the candidate set.
struct TermMeta {
    display: String,
    norm: String,
    ngrams: HashSet<String>,
    /// Double Metaphone `(primary, secondary)` codes; either empty for non-Latin / unmappable input.
    metaphone: (String, String),
}

/// Whether two Double Metaphone `(primary, secondary)` code pairs share any populated code — the
/// homophone test. Mirrors `snippets::phonetic::phonetic_overlap` / the engine's defensive gate
/// (primary OR secondary), so retrieval and verification agree; empty codes never match.
fn metaphone_overlap(a: &(String, String), b: &(String, String)) -> bool {
    let hit = |k: &str| !k.is_empty() && (k == b.0 || k == b.1);
    hit(&a.0) || hit(&a.1)
}

/// A phonetic inverted index over the dictionary terms. Built once per correction call (cheap — a few
/// µs/term) from the union of user vocabulary + on-screen context terms, then queried per utterance.
pub struct DictIndex {
    terms: Vec<TermMeta>,
    /// n-gram or `MP:<code>` key → term ids that contain it.
    postings: HashMap<String, Vec<usize>>,
}

impl DictIndex {
    /// Build the index from `terms` (display spellings). Empty / whitespace-only terms are dropped.
    pub fn build(terms: &[String]) -> Self {
        let mut metas: Vec<TermMeta> = Vec::new();
        let mut postings: HashMap<String, Vec<usize>> = HashMap::new();
        for display in terms {
            let norm = normalize(display);
            if norm.is_empty() {
                continue;
            }
            let id = metas.len();
            let ngrams = char_ngrams(&norm);
            let metaphone = double_metaphone(&norm);
            for g in &ngrams {
                postings.entry(g.clone()).or_default().push(id);
            }
            // Index BOTH metaphone codes (deduped) so a homophone agreeing on only the secondary code
            // is still retrievable — matching the primary-OR-secondary gate used at scoring time.
            for code in [&metaphone.0, &metaphone.1] {
                if !code.is_empty() {
                    let key = format!("MP:{code}");
                    let bucket = postings.entry(key).or_default();
                    if bucket.last() != Some(&id) {
                        bucket.push(id);
                    }
                }
            }
            metas.push(TermMeta {
                display: display.clone(),
                norm,
                ngrams,
                metaphone,
            });
        }
        Self {
            terms: metas,
            postings,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }

    /// Retrieve up to [`RETRIEVAL_TOP_K`] `(span → term)` proposals for `text`, ranked by phonetic
    /// score. O(utterance length), independent of dictionary size: each window looks up only the
    /// terms that share one of its n-grams or its metaphone code, never the whole dictionary.
    pub fn retrieve(&self, text: &str) -> Vec<Retrieved> {
        if self.terms.is_empty() {
            return Vec::new();
        }
        let words = word_spans(text);
        // Best score per (term id, span) — a term can be proposed for at most one span here; the
        // engine resolves cross-term span overlaps by margin afterwards.
        let mut best: Vec<Retrieved> = Vec::new();
        for n in 1..=MAX_WINDOW_WORDS {
            if words.len() < n {
                break;
            }
            for i in 0..=words.len() - n {
                let start = words[i].0;
                let end = words[i + n - 1].1;
                let win_norm = normalize(&text[start..end]);
                if win_norm.is_empty() {
                    continue;
                }
                let win_ngrams = char_ngrams(&win_norm);
                let win_mp = double_metaphone(&win_norm);

                // Candidate term ids = union of postings for this window's grams + BOTH metaphone
                // codes. Collect into a sorted Vec so scoring order is deterministic across runs
                // (HashSet iteration order is per-process-random, which made tied-score top-K
                // truncation nondeterministic — a term could correct on one launch, not the next).
                let mut cand_set: HashSet<usize> = HashSet::new();
                for g in &win_ngrams {
                    if let Some(ids) = self.postings.get(g) {
                        cand_set.extend(ids);
                    }
                }
                for code in [&win_mp.0, &win_mp.1] {
                    if !code.is_empty()
                        && let Some(ids) = self.postings.get(&format!("MP:{code}"))
                    {
                        cand_set.extend(ids);
                    }
                }
                let mut cand_ids: Vec<usize> = cand_set.into_iter().collect();
                cand_ids.sort_unstable();

                for id in cand_ids {
                    let term = &self.terms[id];
                    let mp_equal = metaphone_overlap(&win_mp, &term.metaphone);
                    let edit = edit_ratio(&win_norm, &term.norm);
                    // Tight phonetic gate: homophone (metaphone-equal) OR a close edit. Anything else
                    // that merely shares an n-gram is dropped BEFORE the model ever sees it.
                    if !(mp_equal || edit < EDIT_RATIO_MAX) {
                        continue;
                    }
                    // Score = n-gram overlap coefficient (|∩| / min set size) + a homophone bonus, so
                    // exact-sound matches rank above merely-similar spellings.
                    let common = win_ngrams.intersection(&term.ngrams).count();
                    let denom = win_ngrams.len().min(term.ngrams.len()).max(1);
                    let mut score = common as f64 / denom as f64;
                    if mp_equal {
                        score += 1.0;
                    }
                    // Keep the best span for this term across all window widths (higher score, then
                    // closer edit).
                    if let Some(slot) = best.iter_mut().find(|r| r.term == term.display) {
                        if score > slot.score || (score == slot.score && edit < slot.edit) {
                            slot.start = start;
                            slot.end = end;
                            slot.score = score;
                            slot.edit = edit;
                        }
                    } else {
                        best.push(Retrieved {
                            start,
                            end,
                            term: term.display.clone(),
                            score,
                            edit,
                        });
                    }
                }
            }
        }
        // Rank by score desc, then closest edit, then term name — fully deterministic, so the top-K
        // survivors are the same on every run (and closeness breaks the homophone-bonus tier).
        best.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then(a.edit.total_cmp(&b.edit))
                .then_with(|| a.term.cmp(&b.term))
        });
        best.truncate(RETRIEVAL_TOP_K);
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retrieve_terms(text: &str, terms: &[&str]) -> Vec<Retrieved> {
        let terms: Vec<String> = terms.iter().map(|s| (*s).to_string()).collect();
        DictIndex::build(&terms).retrieve(text)
    }

    #[test]
    fn homophones_are_retrieved_via_metaphone() {
        // "veet" shares no 2/3-gram with "vite" — only the metaphone (FT==FT) can retrieve it.
        let r = retrieve_terms("install veet today", &["Vite"]);
        assert!(
            r.iter().any(|c| c.term == "Vite"),
            "veet should retrieve Vite: {r:?}"
        );
    }

    #[test]
    fn correct_word_is_still_retrieved_for_the_judge_to_reject() {
        // "video" also collides on metaphone; retrieval PROPOSES it (the model then keeps "video").
        let r = retrieve_terms("watch the video", &["Vite"]);
        assert!(r.iter().any(|c| c.term == "Vite"));
    }

    #[test]
    fn corruptions_are_retrieved_via_ngrams() {
        let r = retrieve_terms("run kubernetties now", &["Kubernetes"]);
        assert!(r.iter().any(|c| c.term == "Kubernetes"), "{r:?}");
    }

    #[test]
    fn two_word_span_collapses_to_term() {
        let r = retrieve_terms("run it with oh llama tonight", &["ollama"]);
        let top = r.first().expect("a candidate");
        assert_eq!(
            &"run it with oh llama tonight"[top.start..top.end],
            "oh llama"
        );
    }

    #[test]
    fn unrelated_words_retrieve_nothing() {
        let r = retrieve_terms("will it transcribe the text cleanly", &["Vite"]);
        assert!(r.is_empty(), "unexpected: {r:?}");
    }

    #[test]
    fn top_k_is_capped_regardless_of_dictionary_size() {
        // 200 distractor terms that all collide on the same span must not blow past the cap.
        let mut terms: Vec<String> = (0..200).map(|i| format!("veet{i}")).collect();
        terms.push("Vite".into());
        let idx = DictIndex::build(&terms);
        let r = idx.retrieve("install veet");
        assert!(
            r.len() <= RETRIEVAL_TOP_K,
            "retrieval exceeded top-K: {}",
            r.len()
        );
    }

    #[test]
    fn utf8_spans_do_not_panic() {
        let text = "la vidéo était très longue";
        let r = retrieve_terms(text, &["Vite"]);
        for c in &r {
            let _ = &text[c.start..c.end]; // must slice on a char boundary
        }
    }

    #[test]
    fn arabic_corruption_retrieves_via_ngrams() {
        // Non-Latin: no metaphone, but n-gram overlap on a dropped letter still retrieves.
        let r = retrieve_terms("عايز اكتب كوبرنيتيس هنا", &["كوبرنيتس"]);
        assert!(r.iter().any(|c| c.term == "كوبرنيتس"), "{r:?}");
    }

    #[test]
    fn metaphone_overlap_matches_on_either_code() {
        // Shared secondary code counts (homophone), disjoint does not, empty never does.
        assert!(metaphone_overlap(
            &("A".into(), "B".into()),
            &("C".into(), "B".into())
        ));
        assert!(!metaphone_overlap(
            &("A".into(), "B".into()),
            &("C".into(), "D".into())
        ));
        assert!(!metaphone_overlap(
            &(String::new(), String::new()),
            &("A".into(), "B".into())
        ));
    }

    #[test]
    fn top_k_truncation_is_deterministic_across_calls() {
        // Many tied homophones on one span: the surviving set + order must be identical every call
        // (the old HashSet-iteration-ordered truncation returned a random 10-of-N subset per run).
        let mut terms: Vec<String> = (0..80).map(|i| format!("veet{i:02}")).collect();
        terms.push("Vite".into());
        let idx = DictIndex::build(&terms);
        let a: Vec<String> = idx
            .retrieve("install veet")
            .into_iter()
            .map(|c| c.term)
            .collect();
        let b: Vec<String> = idx
            .retrieve("install veet")
            .into_iter()
            .map(|c| c.term)
            .collect();
        assert_eq!(a, b, "retrieval order must be deterministic");
        assert!(a.len() <= RETRIEVAL_TOP_K);
    }
}
