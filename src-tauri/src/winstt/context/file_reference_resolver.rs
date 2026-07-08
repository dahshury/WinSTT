//! Deterministic descriptive-phrase → workspace-file `@`-tagging (behind a flag,
//! NOT yet wired to production).
//!
//! The shipped exact-filename tagger ([`super::caret_join::apply_ide_file_tags`] +
//! [`super::caret_join::upgrade_tags_to_paths`]) promotes a SPOKEN `name.ext`
//! token to `@src/…/name.ext`. This module extends that to the case where the
//! user SPEAKS a DESCRIPTION instead of the exact filename:
//!   - "fix the auth middleware file"  → `@…/authMiddleware.ts`
//!   - "open the context manager"      → `@…/context_manager.rs`
//!
//! ## NON-NEGOTIABLE PRINCIPLE — precision over recall, ABSTAIN when unsure
//! This MUTATES the user's dictated text via FUZZY word→file matching. A WRONG
//! tag (wrong file, or a tag where no file was meant) is worse than NO tag, so
//! every path here biases to ABSTAIN: emit a tag ONLY when a fully-deterministic,
//! exact token-set gate proves a unique winner; otherwise leave the text
//! byte-for-byte unchanged. There is NO probabilistic scoring and NO edit-
//! distance fuzz — membership is exact token-set logic, so the gate is
//! explainable and reproducible.
//!
//! ## Mechanism (all off the dictation hot path except the O(1) capture read)
//!  1. NORMALIZE each workspace BASENAME (never the directory path — path-
//!     tokenizing `…/managers/` would falsely give all files under it the
//!     `manager` token and destroy the discriminator) to a lowercase word-token
//!     set, computed ONCE at index-build time.
//!  2. Build a token → file-indices INVERTED INDEX once per root, cached in the
//!     same 60 s-TTL / 4-root-LRU structure as the workspace index. Resolution is
//!     a sorted postings INTERSECTION, not an O(files) scan.
//!  3. At capture, extract a cue-anchored descriptive SPAN from the utterance,
//!     map spoken words to tokens (light stemming only), and resolve by postings
//!     intersection: candidates = files whose basename token-set ⊇ phrase set.
//!  4. GATE: emit only when the index is not truncated, the phrase has ≥2 SALIENT
//!     tokens, coverage is full, and exactly ONE candidate is the strictly-unique
//!     full-phrase carrier (set-equality tiebreak). Else ABSTAIN.
//!  5. SPLICE `@<root-relative/on-disk-cased/path>` over exactly the salient span,
//!     boundary-safe (shared `left_boundary_ok`/`right_boundary_ok` guards) and
//!     idempotent, longest-span-first.
//!
//! Generic / app-agnostic, `is_ide`-gated identically to the exact tagger, and
//! fail-soft: any error / `None` / ambiguity leaves the text unchanged.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use super::caret_join::{FILE_EXTENSIONS, left_boundary_ok, right_boundary_ok};
use super::workspace_index::WorkspaceIndex;

// ───────────────────────────── caps / knobs ─────────────────────────────

/// Per-root cache TTL — mirrors the workspace index's own TTL so a dictation
/// burst reuses one build and a stale entry costs at most a missed tag.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// LRU bound on the per-root cache (matches the workspace index's 4-root cap so
/// project-switching cannot accumulate roots).
const MAX_CACHED_ROOTS: usize = 4;

/// Hard cap on the total number of files folded into a single inverted index.
/// Mirrors the workspace index's 50k cap: a truncated source index already
/// forces ABSTAIN, and this bounds the pathological case independently.
const MAX_INDEXED_FILES: usize = 50_000;

/// Minimum salient token count for the gate — a one-token description is
/// inherently ambiguous in a real tree (verified single-token owners: `index`
/// ×127, `manager` alone → 13 files) so it ALWAYS abstains.
const MIN_SALIENT_TOKENS: usize = 2;

/// Stopwords dropped from the SALIENT span before scoring. Ordinary prose glue
/// plus the cue verbs/preps — none of these discriminate a file.
const STOPWORDS: &[&str] = &[
    "the", "a", "an", "my", "this", "that", "to", "in", "of", "and", "please", "go", "at", "on",
    "for", "with", "into",
];

/// Cue verbs/preps that FRAME a following description as a file reference. Their
/// presence (or a trailing/interior cue NOUN) is what lets a bare superset match
/// tag at all (abstain-rule 9); they are themselves dropped from the salient set.
const CUE_VERBS: &[&str] = &[
    "open", "edit", "update", "fix", "check", "look", "show", "find", "goto",
];

/// Cue NOUNS naming a file's KIND. A trailing one that is NOT itself a token of
/// the resolved basename is absorbed into the replacement span (drop "file" in
/// "middleware file"); one that IS a basename token stays salient (keep
/// "manager" in "context manager"). Their presence also anchors a reference.
const CUE_NOUNS: &[&str] = &[
    "file",
    "module",
    "script",
    "component",
    "class",
    "hook",
    "util",
    "config",
    "schema",
    "manager",
    "dialog",
    "store",
    "provider",
];

// ─────────────────────────── basename tokenization ───────────────────────

/// The normalized token view of one workspace file's BASENAME.
#[derive(Debug, Clone)]
pub struct FileEntry {
    /// Root-relative, forward-slash, on-disk-cased path (the emitted `@rel`).
    pub relpath: String,
    /// Full lowercase token set of the basename (salient + non-salient).
    pub token_set: HashSet<String>,
    /// Count of SALIENT tokens (excludes single-letter tokens; acronyms count).
    pub salient_token_count: usize,
}

/// Strip a basename's trailing RECOGNIZED extension segment, returning the stem.
///
/// Uses the SAME `looks_like_taggable_filename` gate + `FILE_EXTENSIONS` allow-
/// list as the exact tagger. Only a recognized trailing code/doc/config ext is
/// removed; a compound tail like `settings-store.test.ts` strips only `.ts`
/// (leaving `settings-store.test`, whose `test` is a meaningful token, not an
/// ext), and `use-tts-playback.ts` → `use-tts-playback`. A basename with no
/// recognized extension (a bare `Makefile`) keeps its whole self as the stem.
fn strip_extension(basename: &str) -> &str {
    match basename.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < basename.len() => {
            let ext = &basename[dot + 1..];
            if FILE_EXTENSIONS.iter().any(|e| ext.eq_ignore_ascii_case(e)) {
                &basename[..dot]
            } else {
                basename
            }
        }
        _ => basename,
    }
}

/// True for an all-caps (or caps+digits) run of length ≥2 — an acronym / domain
/// term (`TTS`, `LLM`, `STT`, `HTTP`). These collapse to ONE salient lowercase
/// token, unlike a single stray uppercase letter.
fn is_acronym_run(s: &str) -> bool {
    let mut has_upper = false;
    for c in s.chars() {
        if c.is_ascii_uppercase() {
            has_upper = true;
        } else if !c.is_ascii_digit() {
            return false;
        }
    }
    has_upper && s.chars().count() >= 2
}

/// Split a basename STEM into lowercase tokens on the separator classes:
/// camelCase / PascalCase boundary (`aA`), the ABBRev boundary
/// (`HTTPServer`→{http,server}), snake `_`, kebab `-`, dot `.`, and the
/// digit↔letter boundary. Acronym runs collapse to one lowercase token.
///
/// Verified against the real tree: `context_manager`→{context,manager};
/// `authMiddleware`→{auth,middleware};
/// `OllamaModelManagerDialog`→{ollama,model,manager,dialog};
/// `settings-store.test`→{settings,store,test}; `use-tts-playback`→{use,tts,
/// playback}.
fn split_stem(stem: &str) -> Vec<String> {
    // 1. Split on explicit separators.
    let mut raw: Vec<String> = Vec::new();
    for seg in stem.split(['_', '-', '.', ' ']) {
        if !seg.is_empty() {
            raw.push(seg.to_string());
        }
    }
    // 2. Within each separator-run, split on case + digit↔letter boundaries.
    let mut out: Vec<String> = Vec::new();
    for seg in raw {
        split_camel_and_digits(&seg, &mut out);
    }
    out
}

/// Push the case/digit-boundary sub-tokens of one separator-run `seg` (already
/// free of `_`/`-`/`.`) into `out`, lowercased. Handles:
///   - lower→UPPER (`authMiddleware` → auth | Middleware)
///   - UPPER-run then Upper+lower (`HTTPServer` → HTTP | Server)
///   - letter↔digit (`utf8` → utf | 8; `h264` → h | 264)
fn split_camel_and_digits(seg: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = seg.chars().collect();
    if chars.is_empty() {
        return;
    }
    let mut start = 0usize;
    for i in 1..chars.len() {
        let prev = chars[i - 1];
        let cur = chars[i];
        let boundary =
            // lower/digit → Upper: end of a word (authM|iddleware, x2A → but
            // digit→Upper also splits, see below).
            (prev.is_lowercase() && cur.is_uppercase())
            // Upper → Upper followed by lower: HTTP|Server (break BEFORE the
            // last upper that starts the next word).
            || (prev.is_uppercase()
                && cur.is_uppercase()
                && chars.get(i + 1).is_some_and(|n| n.is_lowercase()))
            // letter ↔ digit either direction.
            || (prev.is_alphabetic() && cur.is_ascii_digit())
            || (prev.is_ascii_digit() && cur.is_alphabetic());
        if boundary {
            push_token(&chars[start..i], out);
            start = i;
        }
    }
    push_token(&chars[start..], out);
}

/// Lowercase + push one sub-token slice (dropping empties).
fn push_token(slice: &[char], out: &mut Vec<String>) {
    if slice.is_empty() {
        return;
    }
    let s: String = slice.iter().collect();
    let lowered = s.to_lowercase();
    if !lowered.is_empty() {
        out.push(lowered);
    }
}

/// True when a lowercase token is SALIENT for the gate: length ≥2 (single-letter
/// tokens are dropped) — acronyms already collapsed to a ≥2-char lowercase term
/// upstream, so they are naturally salient here. (Stopword filtering applies to
/// the SPOKEN phrase, not to file tokens.)
fn is_salient_token(tok: &str) -> bool {
    tok.chars().count() >= 2
}

/// Normalize one BASENAME (not path) to its `(token_set, salient_count)`.
/// `is_acronym_run` is applied to each ORIGINAL separator-run so an all-caps
/// term is kept whole (`TTS`→tts) rather than exploded by the case splitter.
fn tokenize_basename(basename: &str) -> (HashSet<String>, usize) {
    let stem = strip_extension(basename);
    let mut token_set: HashSet<String> = HashSet::new();
    // First, protect acronym runs: iterate separator-runs and, for an all-caps
    // run, emit it as a single lowercase token; otherwise case/digit-split it.
    for seg in stem.split(['_', '-', '.', ' ']) {
        if seg.is_empty() {
            continue;
        }
        if is_acronym_run(seg) {
            token_set.insert(seg.to_lowercase());
        } else {
            let mut sub = Vec::new();
            split_camel_and_digits(seg, &mut sub);
            for t in sub {
                token_set.insert(t);
            }
        }
    }
    // Fallback: if the acronym-aware pass produced nothing (e.g. all separators),
    // use the plain splitter so we never lose a real token.
    if token_set.is_empty() {
        for t in split_stem(stem) {
            token_set.insert(t);
        }
    }
    let salient = token_set.iter().filter(|t| is_salient_token(t)).count();
    (token_set, salient)
}

// ─────────────────────────── inverted index ──────────────────────────────

/// A token → file-indices inverted index over a workspace's basenames. Built
/// ONCE per root (off the hot path). Resolution intersects postings lists.
#[derive(Debug, Clone, Default)]
pub struct FileRefIndex {
    files: Vec<FileEntry>,
    /// Lowercase basename-token → sorted file indices whose basename token-set
    /// contains it.
    token_postings: HashMap<String, Vec<u32>>,
    /// Mirrors the workspace index's `truncated`: a truncated source index (or a
    /// 50k overflow here) cannot prove uniqueness → the resolver abstains wholesale.
    truncated: bool,
}

impl FileRefIndex {
    /// Build the inverted index from a [`WorkspaceIndex`]. Iterates its relpaths
    /// once, tokenizes each BASENAME, and inserts the file index under each of
    /// its basename tokens. Inherits `truncated` from the source index. Pure; the
    /// caller caches the result.
    pub fn build(source: &WorkspaceIndex) -> Self {
        Self::from_relpaths(source.relpaths(), source.is_truncated())
    }

    /// Build the inverted index directly from an iterator of ROOT-RELATIVE,
    /// forward-slash, on-disk-cased paths. Tokenizes each BASENAME once and
    /// inserts its file index under each basename token; sets `truncated` when the
    /// 50k cap is hit here (or when the caller passes `truncated == true`, e.g.
    /// from a truncated [`WorkspaceIndex`]). This is the seam [`Self::build`] uses
    /// and the one tests drive with a synthetic file list.
    pub fn from_relpaths<'a>(relpaths: impl IntoIterator<Item = &'a str>, truncated: bool) -> Self {
        let mut files: Vec<FileEntry> = Vec::new();
        let mut token_postings: HashMap<String, Vec<u32>> = HashMap::new();
        let mut truncated = truncated;

        for relpath in relpaths {
            if files.len() >= MAX_INDEXED_FILES {
                truncated = true;
                break;
            }
            let basename = relpath.rsplit('/').next().unwrap_or(relpath);
            if basename.is_empty() {
                continue;
            }
            let (token_set, salient_token_count) = tokenize_basename(basename);
            if token_set.is_empty() {
                continue;
            }
            let idx = files.len() as u32;
            for tok in &token_set {
                token_postings.entry(tok.clone()).or_default().push(idx);
            }
            files.push(FileEntry {
                relpath: relpath.to_string(),
                token_set,
                salient_token_count,
            });
        }
        // Postings are appended in ascending file-index order already, so each
        // list is sorted — the intersection relies on that.
        FileRefIndex {
            files,
            token_postings,
            truncated,
        }
    }

    pub fn is_truncated(&self) -> bool {
        self.truncated
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    /// Intersect the postings of `tokens`, returning the file indices whose
    /// basename token-set ⊇ `tokens`. `None` (empty) when any token has no
    /// postings. Sorted-merge over the smallest list first for cheapness.
    fn intersect(&self, tokens: &[String]) -> Vec<u32> {
        if tokens.is_empty() {
            return Vec::new();
        }
        // Gather each token's postings; bail on the first absent token.
        let mut lists: Vec<&[u32]> = Vec::with_capacity(tokens.len());
        for t in tokens {
            match self.token_postings.get(t) {
                Some(list) if !list.is_empty() => lists.push(list.as_slice()),
                _ => return Vec::new(), // absent token ⇒ empty intersection ⇒ abstain
            }
        }
        // Start from the shortest list to keep the merge small.
        lists.sort_by_key(|l| l.len());
        let mut acc: Vec<u32> = lists[0].to_vec();
        for list in &lists[1..] {
            acc = sorted_intersect(&acc, list);
            if acc.is_empty() {
                break;
            }
        }
        acc
    }
}

/// Intersect two ascending-sorted `u32` slices. Linear sorted-merge.
fn sorted_intersect(a: &[u32], b: &[u32]) -> Vec<u32> {
    let mut out = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                i += 1;
                j += 1;
            }
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
        }
    }
    out
}

// ───────────────────────────── per-root cache ────────────────────────────

struct CacheSlot {
    built_at: Instant,
    index: Arc<FileRefIndex>,
}

static REF_INDEX_CACHE: Lazy<Mutex<HashMap<String, CacheSlot>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn cache_key(root: &Path) -> String {
    root.to_string_lossy().to_lowercase()
}

/// Return the cached [`FileRefIndex`] for `root`, (re)building from `source` when
/// cold or stale. LRU-bounds the cache to [`MAX_CACHED_ROOTS`]. The build runs
/// OFF the dictation hot path; a warm capture-time read is O(1).
pub fn ref_index_for_root(root: &Path, source: &WorkspaceIndex) -> Arc<FileRefIndex> {
    let key = cache_key(root);
    {
        let cache = REF_INDEX_CACHE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(slot) = cache.get(&key)
            && slot.built_at.elapsed() < CACHE_TTL
        {
            return slot.index.clone();
        }
    }
    let index = Arc::new(FileRefIndex::build(source));
    let mut cache = REF_INDEX_CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    cache.insert(
        key.clone(),
        CacheSlot {
            built_at: Instant::now(),
            index: index.clone(),
        },
    );
    if cache.len() > MAX_CACHED_ROOTS {
        let mut by_age: Vec<(String, Instant)> =
            cache.iter().map(|(k, s)| (k.clone(), s.built_at)).collect();
        by_age.sort_by_key(|(_, t)| *t);
        let excess = cache.len() - MAX_CACHED_ROOTS;
        for (old_key, _) in by_age.into_iter().take(excess) {
            if old_key != key {
                cache.remove(&old_key);
            }
        }
    }
    index
}

// ─────────────────────── candidate span extraction ───────────────────────

/// One lowercase word token of the utterance with its byte range in the ORIGINAL
/// `output` (so replacement splices precisely).
#[derive(Debug, Clone)]
struct WordTok {
    lower: String,
    start: usize,
    end: usize,
}

/// Tokenize `output` into lowercase word tokens (maximal runs of alphanumerics
/// plus interior `'`), preserving byte offsets. Mirrors the word-run shape of the
/// exact tagger's scanner but yields WORDS, not filenames. Tokens whose run
/// touches an `@`, `.`, `_`, `-`, or `/` on either side are still produced, but
/// the resolver's boundary guards reject splicing across a tag/path later.
fn word_tokens(output: &str) -> Vec<WordTok> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < output.len() {
        let c = output[i..].chars().next().unwrap();
        if !(c.is_alphanumeric()) {
            i += c.len_utf8();
            continue;
        }
        let start = i;
        let mut end = start;
        for (rel, ch) in output[start..].char_indices() {
            let wordy = ch.is_alphanumeric() || ch == '\'';
            // A trailing apostrophe ends the word (don't swallow "manager'").
            if wordy && !(ch == '\'' && is_word_end_apostrophe(&output[start..], rel)) {
                end = start + rel + ch.len_utf8();
            } else {
                break;
            }
        }
        if end > start {
            out.push(WordTok {
                lower: output[start..end].to_lowercase(),
                start,
                end,
            });
        }
        i = end.max(i + 1);
    }
    out
}

/// True when the apostrophe at relative offset `rel` in `seg` is NOT between two
/// alphanumerics (so it terminates the word rather than being interior).
fn is_word_end_apostrophe(seg: &str, rel: usize) -> bool {
    let next = seg[rel + 1..].chars().next();
    !next.is_some_and(|c| c.is_alphanumeric())
}

/// One salient spoken word with its byte range in the ORIGINAL `output`, kept as
/// an ordered list so the gate can score a PREFIX of the run (the longest leading
/// sub-phrase that resolves to a unique file) and splice exactly that prefix's
/// span — the trailing prose words after the real filename phrase are left
/// untouched.
#[derive(Debug, Clone)]
struct SalientTok {
    lower: String,
    start: usize,
    end: usize,
}

/// A descriptive candidate span: the ORDERED salient tokens (lowercased, each with
/// its byte offsets) and whether a cue word anchored the run. The resolver scores
/// the LONGEST leading prefix of `salient` that resolves to a unique file, so
/// `start`/`end` are derived per-prefix at gate time rather than stored here.
#[derive(Debug, Clone)]
struct Candidate {
    salient: Vec<SalientTok>,
    /// Whether a cue word anchored this span (used by abstain-rule 9).
    cue_anchored: bool,
}

/// True when `tok` is a stopword (dropped from the salient set).
fn is_stopword(tok: &str) -> bool {
    STOPWORDS.contains(&tok)
}

/// True when `tok` is a cue verb/prep (frames a reference; dropped from salient).
fn is_cue_verb(tok: &str) -> bool {
    CUE_VERBS.contains(&tok)
}

/// True when `tok` is a cue noun naming a file kind.
fn is_cue_noun(tok: &str) -> bool {
    CUE_NOUNS.contains(&tok)
}

/// Light stemming: map a spoken token to the token actually present in the index
/// when a trivial plural is the only difference. Returns the candidate spellings
/// to try, most-specific first. NEVER over-stems (`settings`→`setting` is NOT
/// applied because both are real distinct tree tokens); only a trailing `s` is
/// stripped, and only the caller decides which spelling the index bears.
fn stem_variants(tok: &str) -> Vec<String> {
    let mut v = vec![tok.to_string()];
    if let Some(singular) = tok.strip_suffix('s')
        && singular.len() >= 2
        && singular != tok
    {
        v.push(singular.to_string());
    }
    v
}

/// Resolve a spoken token to the single index token it should match, given the
/// index's postings. Tries the token as-spoken first, then its singular. Returns
/// `None` when neither spelling has postings (an absent token ⇒ abstain).
fn resolve_token(tok: &str, index: &FileRefIndex) -> Option<String> {
    stem_variants(tok)
        .into_iter()
        .find(|cand| index.token_postings.contains_key(cand))
}

/// Extract every descriptive candidate span from the utterance. A span is a
/// maximal run of CONTENT tokens (non-stopword, non-cue-verb) that is EITHER
/// preceded by a cue verb/prep OR contains / trails a cue noun — the two signals
/// that frame the run as a file reference. Stopwords/cue-verbs bound and split
/// runs. Each span's salient set drops stopwords and cue-verbs but keeps cue
/// NOUNS that are content-bearing (e.g. "manager").
///
/// Overlapping / nested spans are naturally avoided: we walk left-to-right and a
/// new content run starts only after a boundary token.
fn extract_candidates(output: &str) -> Vec<Candidate> {
    let toks = word_tokens(output);
    let mut candidates = Vec::new();
    let mut i = 0usize;
    while i < toks.len() {
        // Skip boundary tokens (stopwords / cue verbs). Track whether ANY cue verb
        // (open/fix/…) or framing stopword (the/in/at/…) immediately precedes the
        // upcoming content run — either anchors a bare superset match (rule 9).
        let mut cue_before = false;
        while i < toks.len() && (is_stopword(&toks[i].lower) || is_cue_verb(&toks[i].lower)) {
            if is_cue_verb(&toks[i].lower) || is_framing_stopword(&toks[i].lower) {
                cue_before = true;
            }
            i += 1;
        }
        // Collect the maximal content run.
        let run_start_tok = i;
        while i < toks.len() && !is_stopword(&toks[i].lower) && !is_cue_verb(&toks[i].lower) {
            i += 1;
        }
        let run_end_tok = i; // exclusive
        if run_end_tok == run_start_tok {
            continue;
        }
        let run = &toks[run_start_tok..run_end_tok];
        // A cue NOUN anywhere in the run also anchors the reference.
        let has_cue_noun = run.iter().any(|t| is_cue_noun(&t.lower));
        let cue_anchored = cue_before || has_cue_noun;

        if let Some(c) = build_candidate(run, cue_anchored) {
            candidates.push(c);
        }
    }
    candidates
}

/// The framing stopwords that (per abstain-rule 9) count as a cue anchor for an
/// otherwise-superset match ("the"/"in"/"at"/"on"/"into").
fn is_framing_stopword(tok: &str) -> bool {
    matches!(tok, "the" | "in" | "at" | "on" | "into" | "of" | "to")
}

/// Build a [`Candidate`] from a content run, preserving the ordered salient tokens
/// with their byte offsets. A single TRAILING absorbable kind-word ("file"/
/// "module"/"script") is DROPPED here (its span is re-absorbed at splice time if
/// it is not a basename token); the more general role-noun suffixes ("walker"/
/// "builder"/…) are handled per-prefix by the gate, since whether a trailing noun
/// is droppable depends on which prefix wins. Runs already exclude stopwords/
/// cue-verbs. Returns `None` for an empty salient run.
fn build_candidate(run: &[WordTok], cue_anchored: bool) -> Option<Candidate> {
    // Drop a single trailing absorbable kind-word from the SALIENT span.
    let mut salient_end = run.len();
    if salient_end >= 2 && ABSORBABLE_TRAILING_NOUNS.contains(&run[salient_end - 1].lower.as_str())
    {
        salient_end -= 1;
    }
    let salient_run = &run[..salient_end];
    if salient_run.is_empty() {
        return None;
    }
    let salient: Vec<SalientTok> = salient_run
        .iter()
        .map(|t| SalientTok {
            lower: t.lower.clone(),
            start: t.start,
            end: t.end,
        })
        .collect();
    Some(Candidate {
        salient,
        cue_anchored,
    })
}

// ──────────────────────────── resolve + gate ─────────────────────────────

/// The trailing "kind" cue nouns that may be absorbed (dropped) from the emitted
/// span when they abut the last salient token and are NOT a token of the winning
/// basename. Conservative subset of [`CUE_NOUNS`].
const ABSORBABLE_TRAILING_NOUNS: &[&str] = &["file", "module", "script"];

/// Generic DESCRIPTIVE role-nouns a speaker appends to name what a file DOES
/// ("the ax tree walker", "the prompt sections builder", "the secret scrub
/// code") that are almost never part of the filename itself. When one trails the
/// scored prefix AND is not itself a token of the resolved basename, the gate
/// drops it so the real discriminating tokens survive. Kept deliberately SMALL
/// and generic to preserve precision: dropping is gated behind the same ≥2
/// salient-token floor + unique set-equal winner, so a role-noun can never
/// manufacture a match on its own.
const ROLE_SUFFIX_NOUNS: &[&str] = &[
    "walker", "builder", "handler", "logic", "code", "thing", "stuff", "function", "helper",
];

/// True when `tok` is a droppable generic descriptive role-noun suffix.
fn is_role_suffix_noun(tok: &str) -> bool {
    ROLE_SUFFIX_NOUNS.contains(&tok)
}

/// One resolved replacement: byte range in `output` to overwrite with `@relpath`.
#[derive(Debug, Clone)]
struct Resolution {
    start: usize,
    end: usize,
    relpath: String,
    span_len: usize,
}

/// Resolve a single candidate to a unique file via the confidence gate, or
/// `None` (ABSTAIN).
///
/// A dictated content run is `<filename-phrase> <trailing prose…>` far more often
/// than a bare filename phrase ("the download manager KEEPS STALLING", "open the
/// workspace index SO I CAN CHECK…"). Forcing the WHOLE run's token-set through
/// the gate makes the intersection go empty on that trailing prose and abstains.
/// So we score the LONGEST leading PREFIX of the salient run that resolves to a
/// unique file, walking prefixes longest→shortest and taking the first that
/// clears the gate. Because a shorter prefix is strictly LESS specific (more
/// ambiguous), longest-first keeps precision: the first prefix that yields a
/// unique set-equal winner is the most-specific safe match.
fn resolve_candidate(cand: &Candidate, index: &FileRefIndex) -> Option<Resolution> {
    // G1. INDEX COMPLETE.
    if index.truncated {
        return None;
    }

    // The salient run's tokens keep their byte offsets so a winning prefix splices
    // exactly its own span. Single-letter tokens and stray stop/cue words are
    // never salient; they are pruned but must NOT extend the span, so we prune
    // here into an ordered scored list.
    let scored: Vec<&SalientTok> = cand
        .salient
        .iter()
        .filter(|t| {
            !is_stopword(&t.lower) && !is_cue_verb(&t.lower) && t.lower.chars().count() >= 2
        })
        .collect();
    if scored.len() < MIN_SALIENT_TOKENS {
        return None;
    }

    // Walk prefixes longest → shortest; first unique winner wins.
    for prefix_len in (MIN_SALIENT_TOKENS..=scored.len()).rev() {
        let prefix = &scored[..prefix_len];
        if let Some(res) = resolve_prefix(prefix, cand.cue_anchored, index) {
            return Some(res);
        }
    }
    None
}

/// Try to resolve ONE leading prefix of the salient run to a unique file. Applies
/// the confidence gate to the prefix (optionally after dropping a trailing generic
/// role-noun) and returns a [`Resolution`] over exactly the prefix's byte span, or
/// `None` (this prefix does not resolve uniquely).
fn resolve_prefix(
    prefix: &[&SalientTok],
    cue_anchored: bool,
    index: &FileRefIndex,
) -> Option<Resolution> {
    // A trailing generic role-noun ("walker"/"builder"/"code"/…) the speaker
    // appended to describe the file is dropped from the SCORED set when doing so
    // still leaves ≥2 tokens — but its SPAN is kept only if it turns out to be a
    // basename token of the winner (checked below via `scored_end`). We try the
    // drop first (more specific: the real discriminators without the descriptive
    // suffix); the byte span still ends at the last KEPT-for-splice token.
    let last = prefix.last()?;
    let drop_role = prefix.len() > MIN_SALIENT_TOKENS && is_role_suffix_noun(&last.lower);

    // First attempt: with the role-noun dropped (if applicable).
    if drop_role
        && let Some(res) = resolve_token_set(&prefix[..prefix.len() - 1], cue_anchored, index)
    {
        return Some(res);
    }
    // Fallback / normal path: score the full prefix (role-noun kept — it may BE a
    // basename token, e.g. a real "…handler.rs").
    resolve_token_set(prefix, cue_anchored, index)
}

/// The confidence gate over a concrete ordered token slice. Maps spoken tokens →
/// index tokens (full coverage required), then requires a UNIQUE winner under the
/// set-equal-beats-superset rule. Returns a [`Resolution`] spanning exactly the
/// slice, or `None` (ABSTAIN).
fn resolve_token_set(
    tokens: &[&SalientTok],
    cue_anchored: bool,
    index: &FileRefIndex,
) -> Option<Resolution> {
    if tokens.len() < MIN_SALIENT_TOKENS {
        return None;
    }
    // Map every token → its index spelling (light plural stemming). An absent
    // token means the slice is not fully covered by any basename → abstain.
    let mut phrase_tokens: Vec<String> = Vec::with_capacity(tokens.len());
    for t in tokens {
        phrase_tokens.push(resolve_token(&t.lower, index)?);
    }
    // Dedup while preserving order (a repeated word shouldn't inflate the count).
    let mut seen = HashSet::new();
    phrase_tokens.retain(|t| seen.insert(t.clone()));

    // G2. SALIENCE FLOOR: ≥2 distinct salient tokens.
    if phrase_tokens.len() < MIN_SALIENT_TOKENS {
        return None;
    }

    // C = files whose basename token-set ⊇ phrase set (postings intersection).
    // Every file in C is a FULL-PHRASE CARRIER by construction.
    let candidate_indices = index.intersect(&phrase_tokens);
    if candidate_indices.is_empty() {
        return None; // |C| == 0 → abstain
    }
    let phrase_set: HashSet<&String> = phrase_tokens.iter().collect();

    // Partition C into SET-EQUAL owners (basename salient-set == phrase set — the
    // user named the file EXACTLY, no extra tokens) and strict SUPERSETS (the file
    // carries the phrase plus more). A set-equal owner is a strictly stronger
    // signal than any superset.
    let mut set_equal: Vec<u32> = Vec::new();
    let mut supersets: Vec<u32> = Vec::new();
    for &idx in &candidate_indices {
        let f = &index.files[idx as usize];
        // FULL COVERAGE (redundant with the intersection, asserted for safety).
        if !phrase_set.iter().all(|t| f.token_set.contains(*t)) {
            return None;
        }
        if f.salient_token_count == phrase_set.len() {
            set_equal.push(idx);
        } else {
            supersets.push(idx);
        }
    }

    // WINNER SELECTION (precision-first):
    //  - EXACTLY ONE set-equal owner → it wins, even if supersets co-exist. A
    //    set-equal owner means the user spoke the filename exactly (no extra
    //    tokens) — a strictly stronger lock than any longer-named superset. Tags
    //    without a cue anchor (an exact basename lock is self-anchoring).
    //  - TWO+ set-equal owners → genuine ambiguity → ABSTAIN.
    //  - ZERO set-equal, exactly ONE superset, AND cue-anchored → tag it (the
    //    prior superset behaviour: a longer-named file the user under-specified,
    //    permitted only under an explicit cue).
    //  - ZERO set-equal + 2+ supersets, or a lone superset with no cue → ABSTAIN.
    let (winner_idx, is_set_equal) = match (set_equal.as_slice(), supersets.as_slice()) {
        ([only], _) => (*only, true),
        ([], [only]) if cue_anchored => (*only, false),
        _ => return None,
    };
    let winner = &index.files[winner_idx as usize];

    // Guard (redundant with the arm gating but explicit): a superset winner needs
    // a cue anchor; a set-equal winner does not.
    if !is_set_equal && !cue_anchored {
        return None;
    }

    let start = tokens.first().unwrap().start;
    let end = tokens.last().unwrap().end;
    Some(Resolution {
        start,
        end,
        relpath: winner.relpath.clone(),
        span_len: end - start,
    })
}

// ─────────────────────────── span replacement ────────────────────────────

/// Descriptive-phrase → workspace-file resolver. Scans `output` for cue-anchored
/// descriptive spans that name a file by WORDS (not by `name.ext`, already
/// handled by the exact tagger), resolves each via the confidence gate, and
/// splices `@<relpath>` over exactly the salient span. Returns `output` unchanged
/// (byte-for-byte) whenever `is_ide` is false, the index is empty/truncated, or
/// no span resolves uniquely (ABSTAIN is the default).
///
/// `is_ide`-gated identically to [`super::caret_join::apply_ide_file_tags`].
/// Pure, boundary-safe, and idempotent (a re-run's candidate scan skips already-
/// `@`-tagged spans via `left_boundary_ok`).
pub fn resolve_descriptive_tags(output: &str, is_ide: bool, index: &FileRefIndex) -> String {
    if !is_ide || output.is_empty() || index.truncated || index.is_empty() {
        return output.to_string();
    }

    // Extract every candidate span, resolve each, and collect the valid ones.
    let mut resolutions: Vec<Resolution> = Vec::new();
    for cand in extract_candidates(output) {
        if let Some(res) = resolve_candidate(&cand, index) {
            resolutions.push(res);
        }
    }
    if resolutions.is_empty() {
        return output.to_string();
    }

    // Longest-span-first so a shorter span can't eat a longer one; drop any span
    // that overlaps an already-chosen (longer) one.
    resolutions.sort_by(|a, b| {
        b.span_len
            .cmp(&a.span_len)
            .then_with(|| a.start.cmp(&b.start))
    });
    let mut chosen: Vec<Resolution> = Vec::new();
    for res in resolutions {
        if chosen
            .iter()
            .any(|c| ranges_overlap(c.start, c.end, res.start, res.end))
        {
            continue;
        }
        chosen.push(res);
    }

    // Apply the chosen spans, splicing right-to-left so earlier byte offsets stay
    // valid as we mutate. Each splice is boundary-checked with the SAME guards as
    // the exact tagger.
    chosen.sort_by_key(|r| std::cmp::Reverse(r.start));
    let mut result = output.to_string();
    for res in chosen {
        // Boundary safety: left char before span and right char after (absorbing
        // an optional trailing cue noun) must be non-word boundaries; never splice
        // inside a tag/path/email.
        let mut end = res.end;
        // Absorb an immediately-trailing absorbable cue noun ("… middleware file")
        // when it is NOT a token of the resolved basename.
        end = absorb_trailing_cue_noun(&result, end, &res.relpath).unwrap_or(end);

        if !left_boundary_ok(&result, res.start) || !right_boundary_ok(&result, end) {
            continue; // fail-soft: skip a span that isn't cleanly delimited
        }
        // Idempotency: if the span is already exactly `@relpath`, skip.
        let replacement = format!("@{}", res.relpath);
        if result[res.start..end] == replacement[..] {
            continue;
        }
        result.replace_range(res.start..end, &replacement);
    }
    result
}

/// True when byte ranges [a0,a1) and [b0,b1) overlap.
fn ranges_overlap(a0: usize, a1: usize, b0: usize, b1: usize) -> bool {
    a0 < b1 && b0 < a1
}

/// Given the byte offset `end` just past a resolved salient span, return the new
/// end that ABSORBS an immediately-trailing generic kind/role noun ("file"/
/// "module"/"script" or a role-noun like "walker"/"builder"/"code") — but ONLY
/// when that noun is NOT a token of the resolved basename (so "context manager"
/// keeps "manager"; "middleware file" drops "file"; "secret scrub code" absorbs
/// the descriptive "code"). Returns `None` when there is nothing to absorb.
fn absorb_trailing_cue_noun(text: &str, end: usize, relpath: &str) -> Option<usize> {
    // Skip a single run of spaces after the span.
    let after = &text[end..];
    let trimmed = after.trim_start_matches(' ');
    let ws_len = after.len() - trimmed.len();
    if ws_len == 0 {
        return None; // must directly abut (one or more spaces)
    }
    // Read the next word token.
    let mut word_end = 0usize;
    for (rel, ch) in trimmed.char_indices() {
        if ch.is_alphanumeric() {
            word_end = rel + ch.len_utf8();
        } else {
            break;
        }
    }
    if word_end == 0 {
        return None;
    }
    let word = trimmed[..word_end].to_lowercase();
    // A trailing generic kind-noun ("file"/"module"/"script") or descriptive
    // role-noun ("walker"/"builder"/"code"/…) is absorbable — both are speaker-
    // added labels the filename doesn't carry.
    if !ABSORBABLE_TRAILING_NOUNS.contains(&word.as_str()) && !is_role_suffix_noun(&word) {
        return None;
    }
    // Is the noun a token of the resolved basename? If so, DO NOT absorb (it is
    // part of the real filename, e.g. a genuine "…_handler.rs").
    let basename = relpath.rsplit('/').next().unwrap_or(relpath);
    let (tokens, _) = tokenize_basename(basename);
    if tokens.contains(&word) {
        return None;
    }
    Some(end + ws_len + word_end)
}

#[cfg(test)]
mod tests;
