//! Deterministic "caret join" post-pass for dictation insertion.
//!
//! Small local models (e.g. `gemma4:e4b`) reliably GROUND the transcript but
//! ignore two cosmetic boundary rules the production prompt asks for:
//!   1. mid-sentence continuation casing — after a `beforeCaret` that ends
//!      "...smooth and ", a title-case transcript "The Migration Finished..."
//!      comes back title-case instead of lowercase-continuation;
//!   2. IDE `@file` tagging — a KNOWN filename mentioned naturally (or after the
//!      spoken trigger words "at"/"tag"/"tagged") is promoted to an "@file"
//!      reference, matching Wispr Flow's file-tagging model.
//!
//! Both are enforced HERE, deterministically, AFTER the LLM (and on the no-LLM
//! raw dictation path too). Everything in this module is a PURE function with no
//! I/O, generic and app-agnostic (no per-app logic): the caret-join reads only
//! the surrounding text and the session's biasing terms; the `@file` tagging is
//! gated on a single `is_ide` bool and driven by the filename shape of the
//! terms, never by which app produced them.
//!
//! `@file` tagging LIMITATION: insertion writes the finished string to the
//! clipboard and sends Ctrl+V once, so the produced "@file.ts" lands as literal
//! pasted TEXT — it does NOT drive Cursor's keystroke-triggered @-mention picker
//! (no synthetic "@" keydown, no dropdown accept). Emitting the correct
//! "@<name>" reference text is the realistic ceiling for a paste-based tool; a
//! driven-picker path is out of scope. We also only have the BARE filename from
//! the term list (no workspace path), so we emit "@name.ext" and NOT a
//! workspace-relative "@src/…/name.ext" — path-qualified tagging is a future
//! upgrade that would need a workspace file index the Split-mode capture does
//! not currently provide.

/// Characters that, when they are the last non-whitespace char of `beforeCaret`,
/// mean the sentence is already TERMINATED — the dictation starts a fresh
/// sentence and its first letter is capitalized. `:` and `;` are treated as
/// terminal (a new clause/list item usually starts capitalized after a colon in
/// dictated prose, and the prompt lists `:` among the terminals).
const SENTENCE_TERMINALS: &[char] = &['.', '!', '?', '…', ':', ';'];

/// Closing quote/bracket glyphs that can trail a sentence terminal
/// (`... done." ` / `... (yes!) `). When `beforeCaret` ends with one of these we
/// look PAST it for a terminal, so `he said "Done." ` still counts as terminal.
const CLOSERS: &[char] = &['"', '\'', ')', ']', '}', '»', '”', '’'];

/// Opening quote/bracket glyphs. When `beforeCaret` ends with one of these the
/// dictation is being inserted right after an opener (`("`) — no space is added
/// and the first letter is left as the model produced it (an opener does not by
/// itself force a case change; the continuation/terminal check below still runs
/// on the text BEFORE the opener is stripped, so `("` after a period stays a
/// sentence start).
const OPENERS: &[char] = &['"', '\'', '(', '[', '{', '«', '“', '‘'];

/// Common list-bullet leaders: when the trimmed `beforeCaret` ENDS with one of
/// these (i.e. the caret sits right after a bullet marker), the dictation is the
/// first word of a list item and is capitalized like a sentence start.
const LIST_BULLETS: &[&str] = &["-", "*", "•", "‣", "◦", "·", ">"];

/// Extension allow-list for `@file` tagging — a term is only treated as a
/// filename when its extension is in here. Covers common code + doc + config
/// extensions. Kept lowercase; comparison is case-insensitive.
///
/// `pub(super)` so the sibling `file_reference_resolver` module can reuse the
/// exact same allow-list when stripping a basename's trailing extension segment
/// (design: "the SAME `looks_like_taggable_filename` gate").
pub(super) const FILE_EXTENSIONS: &[&str] = &[
    // languages
    "rs",
    "py",
    "js",
    "ts",
    "jsx",
    "tsx",
    "mjs",
    "cjs",
    "go",
    "java",
    "kt",
    "kts",
    "c",
    "h",
    "cc",
    "cpp",
    "cxx",
    "hpp",
    "cs",
    "rb",
    "php",
    "swift",
    "m",
    "mm",
    "scala",
    "clj",
    "ex",
    "exs",
    "erl",
    "hs",
    "ml",
    "fs",
    "dart",
    "lua",
    "pl",
    "r",
    "jl",
    "zig",
    "nim",
    "vala",
    "sql",
    // web / markup
    "html",
    "htm",
    "css",
    "scss",
    "sass",
    "less",
    "vue",
    "svelte",
    "astro",
    // data / config
    "json",
    "jsonc",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "xml",
    "csv",
    "tsv",
    "properties",
    "lock",
    // docs / text
    "md",
    "mdx",
    "rst",
    "txt",
    "adoc",
    "org",
    "tex",
    // shell / build
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "bat",
    "cmd",
    "make",
    "mk",
    "cmake",
    "gradle",
    "dockerfile",
];

/// Pronoun tokens that stay CAPITALIZED even mid-sentence ("I", "I'll", ...).
/// Compared case-insensitively against the first word's alphabetic+apostrophe
/// run; the canonical spelling is what we would emit if we re-cased, but since
/// these are exceptions we simply leave the first word untouched.
const KEEP_CAPITALIZED_PRONOUNS: &[&str] = &["i", "i'll", "i'm", "i've", "i'd"];

/// True when `word` is an acronym: at least 2 chars TOTAL, contains at least one
/// letter, and every alphabetic char is uppercase (digits allowed, e.g. `H264`,
/// `API`, `RFC2119`). A single uppercase letter (`I`, `A`) is NOT an acronym.
fn is_acronym(word: &str) -> bool {
    if word.chars().count() < 2 {
        return false;
    }
    let mut has_letter = false;
    for c in word.chars() {
        if c.is_alphabetic() {
            has_letter = true;
            if c.is_lowercase() {
                return false;
            }
        }
    }
    has_letter
}

/// Extract the FIRST word of `output` for the exception checks: the leading run
/// of alphanumeric chars plus interior apostrophes/hyphens, starting at the
/// first alphabetic char. Returns `(prefix_len_bytes, word)` where `prefix_len`
/// is the byte offset of the first alphabetic char (so callers can re-case in
/// place). `None` when there is no alphabetic char.
fn first_word(output: &str) -> Option<(usize, String)> {
    let first_alpha = output.char_indices().find(|(_, c)| c.is_alphabetic())?;
    let start = first_alpha.0;
    // Consume from `start` while chars are alphanumeric or an interior '\'' / '-'.
    let mut end = start;
    let mut chars = output[start..].char_indices().peekable();
    while let Some((rel, c)) = chars.next() {
        let is_wordy = c.is_alphanumeric() || c == '\'' || c == '-';
        if !is_wordy {
            break;
        }
        // A trailing apostrophe/hyphen (not between word chars) ends the word.
        if (c == '\'' || c == '-') && chars.peek().is_none_or(|(_, nc)| !nc.is_alphanumeric()) {
            break;
        }
        end = start + rel + c.len_utf8();
    }
    Some((start, output[start..end].to_string()))
}

/// Should the first word be left as-is (NOT lowercased) during a continuation?
/// True when it is a preserved pronoun, an acronym, or appears case-sensitively
/// in `context_terms` (a proper noun / identifier the user is looking at).
fn first_word_is_protected(word: &str, context_terms: &[String]) -> bool {
    if word.is_empty() {
        return true;
    }
    if KEEP_CAPITALIZED_PRONOUNS
        .iter()
        .any(|p| word.eq_ignore_ascii_case(p))
    {
        return true;
    }
    if is_acronym(word) {
        return true;
    }
    // Case-SENSITIVE membership: "Kubernetes" in terms protects "Kubernetes",
    // but a lowercase "kubernetes" term would not (and we would not be
    // lowercasing an already-lowercase word anyway).
    context_terms.iter().any(|t| t == word)
}

/// Lowercase ONLY the first alphabetic char of `output`, leaving the rest — and
/// every other word's casing — untouched. This is the whole point: a title-case
/// transcript "The Migration Finished" becomes "the Migration Finished" here,
/// but the CONTINUATION path only touches the first word (interior casing is the
/// LLM's job and it does that well), so we intentionally do not de-title the
/// tail.
fn lowercase_first_alpha(output: &str) -> String {
    let Some((idx, _)) = output.char_indices().find(|(_, c)| c.is_alphabetic()) else {
        return output.to_string();
    };
    let mut out = String::with_capacity(output.len());
    out.push_str(&output[..idx]);
    let mut rest = output[idx..].chars();
    if let Some(first) = rest.next() {
        out.extend(first.to_lowercase());
    }
    out.push_str(rest.as_str());
    out
}

/// Uppercase ONLY the first alphabetic char of `output`.
fn uppercase_first_alpha(output: &str) -> String {
    let Some((idx, _)) = output.char_indices().find(|(_, c)| c.is_alphabetic()) else {
        return output.to_string();
    };
    let mut out = String::with_capacity(output.len());
    out.push_str(&output[..idx]);
    let mut rest = output[idx..].chars();
    if let Some(first) = rest.next() {
        out.extend(first.to_uppercase());
    }
    out.push_str(rest.as_str());
    out
}

/// Does `before` (already right-trimmed) end a sentence — so the dictation is a
/// fresh sentence start? True when it ends with a sentence-terminal char (after
/// skipping any trailing closers), ends with a list bullet, or is empty.
fn before_ends_sentence(before_trimmed: &str) -> bool {
    if before_trimmed.is_empty() {
        return true;
    }
    // A trailing list-bullet token means "start of a new item" → capitalize.
    if LIST_BULLETS.iter().any(|b| before_trimmed.ends_with(b))
        && before_trimmed
            .chars()
            .rev()
            .find(|c| !c.is_whitespace())
            .is_some_and(|c| LIST_BULLETS.iter().any(|b| b.starts_with(c)))
    {
        // Only when the bullet is the LAST non-space glyph (e.g. "- " or ">").
        let last = before_trimmed.chars().next_back();
        if last.is_some_and(|c| LIST_BULLETS.iter().any(|b| b.ends_with(c))) {
            return true;
        }
    }
    // Skip trailing closing quotes/brackets, then look at the char before them.
    let mut chars: Vec<char> = before_trimmed.chars().collect();
    while chars
        .last()
        .is_some_and(|c| CLOSERS.contains(c) || c.is_whitespace())
    {
        chars.pop();
    }
    chars.last().is_some_and(|c| SENTENCE_TERMINALS.contains(c))
}

/// Deterministically stitch `output` into the caret position described by
/// `before_caret` / `after_caret`. Pure and idempotent. See the module doc.
///
/// `context_terms` protects proper nouns / identifiers from continuation
/// lowercasing (case-sensitive membership).
pub fn join_for_insertion(
    output: &str,
    before_caret: Option<&str>,
    after_caret: Option<&str>,
    context_terms: &[String],
) -> String {
    if output.is_empty() {
        return String::new();
    }

    let before_raw = before_caret.unwrap_or("");
    let before_trimmed = before_raw.trim_end();

    // ── 1. Casing at the boundary ──
    let mut result = if before_ends_sentence(before_trimmed) {
        // Sentence start (empty/None before, or terminal end): capitalize.
        uppercase_first_alpha(output)
    } else {
        // Mid-sentence continuation: lowercase the first word UNLESS protected.
        match first_word(output) {
            Some((_, word)) if !first_word_is_protected(&word, context_terms) => {
                lowercase_first_alpha(output)
            }
            _ => output.to_string(),
        }
    };

    // ── 2. After-caret punctuation dedup ──
    // If afterCaret begins (after optional leading space) with one of . , ! ? ; :
    // and `result` already ends with that same punctuation, strip the duplicate
    // trailing occurrence (and any trailing whitespace before it) from `result`.
    if let Some(after) = after_caret {
        let after_lead = after.trim_start();
        if let Some(punct) = after_lead.chars().next()
            && matches!(punct, '.' | ',' | '!' | '?' | ';' | ':')
        {
            let trimmed = result.trim_end();
            if trimmed.ends_with(punct) {
                // Drop the trailing punct (one occurrence) + any whitespace after it.
                result = trimmed[..trimmed.len() - punct.len_utf8()]
                    .trim_end()
                    .to_string();
            }
        }
    }

    // ── 3. Spacing before `result` ──
    // Only prefix a space when beforeCaret is non-empty AND does not already end
    // with whitespace / an opener. When it ends with whitespace, ensure `result`
    // does not ALSO begin with whitespace (no doubles).
    if !before_raw.is_empty() {
        let last = before_raw.chars().next_back();
        let ends_ws = last.is_some_and(char::is_whitespace);
        let ends_opener = last.is_some_and(|c| OPENERS.contains(&c));
        if ends_ws {
            // Collapse any leading whitespace on result so we don't double up.
            let start_trimmed = result.trim_start_matches(char::is_whitespace);
            result = start_trimmed.to_string();
        } else if !ends_opener {
            // Insert exactly one space, and make sure result isn't already
            // leading with whitespace (idempotency across double runs).
            let start_trimmed = result.trim_start_matches(char::is_whitespace);
            result = format!(" {start_trimmed}");
        }
    }

    result
}

/// True when `term` looks like a filename-with-extension worth `@`-tagging: no
/// whitespace, contains a dot, and its final dot-segment is a known code/doc
/// extension.
fn looks_like_taggable_filename(term: &str) -> bool {
    if term.is_empty() || term.chars().any(char::is_whitespace) {
        return false;
    }
    let Some(dot) = term.rfind('.') else {
        return false;
    };
    if dot == 0 || dot + 1 >= term.len() {
        return false; // ".rs" or "foo." — not a real name.ext
    }
    let ext = &term[dot + 1..];
    FILE_EXTENSIONS.iter().any(|e| ext.eq_ignore_ascii_case(e))
}

/// True when byte offset `pos` in `text` is a word boundary on the LEFT of a
/// match — i.e. the char immediately before is not alphanumeric/`_`/`.`/`@`
/// (so we don't retag inside `foo@context_manager.rs` or `x.context.rs`).
///
/// `pub(super)` so the sibling `file_reference_resolver` splices its descriptive
/// span using the identical boundary guards (idempotent, never inside a tag).
pub(super) fn left_boundary_ok(text: &str, pos: usize) -> bool {
    text[..pos]
        .chars()
        .next_back()
        .is_none_or(|c| !c.is_alphanumeric() && c != '_' && c != '.' && c != '@')
}

/// True when byte offset `pos` (just past a match) is a word boundary on the
/// RIGHT — the char there is not alphanumeric/`_` (so a filename match isn't a
/// prefix of a longer token).
///
/// `pub(super)` so the sibling `file_reference_resolver` shares the identical
/// right-boundary guard when splicing a descriptive span.
pub(super) fn right_boundary_ok(text: &str, pos: usize) -> bool {
    text[pos..]
        .chars()
        .next()
        .is_none_or(|c| !c.is_alphanumeric() && c != '_')
}

/// Replace every occurrence of `needle` in `haystack` with `replacement`, only
/// at word boundaries, case-preserving on the surrounding text. `needle` is
/// matched literally (case-sensitive on the filename, which matches how the
/// context spells it). Returns the rewritten string.
fn replace_at_boundaries(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let mut out = String::with_capacity(haystack.len());
    let mut search_from = 0;
    while let Some(rel) = haystack[search_from..].find(needle) {
        let start = search_from + rel;
        let end = start + needle.len();
        if left_boundary_ok(haystack, start) && right_boundary_ok(haystack, end) {
            out.push_str(&haystack[search_from..start]);
            out.push_str(replacement);
            search_from = end;
        } else {
            // Not a boundary match: keep one char and continue scanning.
            let next = start + haystack[start..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&haystack[search_from..next]);
            search_from = next;
        }
    }
    out.push_str(&haystack[search_from..]);
    out
}

/// Case-insensitive spoken trigger words that precede a filename and mean "tag
/// this file". "at" covers both a literal spoken "at file.ts" AND the ~9/10 case
/// where the user's "@" is transcribed as the word "at"; "tag"/"tagged" mirror
/// Wispr Flow's spoken trigger vocabulary. All collapse `"<trigger> name"` →
/// `"@name"`.
const FILE_TAG_TRIGGERS: &[&str] = &["at", "tag", "tagged"];

/// Deterministically promote a KNOWN filename to an "@&lt;filename&gt;" reference for
/// IDE surfaces, matching Wispr Flow's file-tagging model. Pure and idempotent.
/// Gated on `is_ide`.
///
/// A term is "known" iff it is in `context_terms` (i.e. it appeared verbatim in
/// the focused-field/caret context) AND passes [`looks_like_taggable_filename`]
/// (no whitespace, has a dot, extension in the allow-list). For each such term,
/// applied longest-first so a longer name/path is tagged before any shorter
/// suffix could eat into it:
///   1. `"@ " + filename`      → `"@" + filename` (collapse a stray sigil+space);
///   2. `"<trigger> " + name`  → `"@" + name` for the case-insensitive spoken
///      triggers in [`FILE_TAG_TRIGGERS`] ("at"/"tag"/"tagged");
///   3. a BARE, boundary-delimited `filename` mentioned naturally anywhere in the
///      utterance → `"@" + filename`.
///
/// This is the parity change: a natural mention of a known file
/// (`"the bug in authCheck.ts"` → `"the bug in @authCheck.ts"`) now tags, not
/// only an explicit "at file". It stays high-precision because a filename is only
/// promoted when it is BOTH present in the captured context AND an exact,
/// extension-bearing, boundary-delimited token — never ordinary prose. No fuzzy /
/// camelCase-to-spoken normalization is attempted (a separate, riskier feature).
///
/// Never `@@`: [`left_boundary_ok`] rejects a preceding `@`/`.`/alnum/`_`, so an
/// already-tagged `"@name"` and an in-path `"x.name"` are both skipped. That same
/// guard makes the whole pass idempotent — after step 3 there is no bare `name`
/// at a valid left boundary, so a re-run is a no-op. The filename's own casing is
/// preserved (the needle is matched case-sensitively as spelled in `terms`).
///
/// LIMITATION: the produced `"@name.ext"` is literal pasted TEXT and does NOT
/// drive Cursor's @-mention picker; see the module doc. We emit the BARE filename
/// (no workspace path) because the term list carries no path — a workspace-
/// relative `"@src/…/name.ext"` upgrade would need a file index not captured here.
pub fn apply_ide_file_tags(output: &str, is_ide: bool, context_terms: &[String]) -> String {
    if !is_ide || output.is_empty() {
        return output.to_string();
    }

    // Only taggable filenames, iterated LONGEST-first so a longer term (e.g.
    // `main.test.tsx`) is tagged before a shorter one (`test.tsx`) could match a
    // substring and produce malformed sigil placement.
    let mut terms: Vec<&String> = context_terms
        .iter()
        .filter(|t| looks_like_taggable_filename(t))
        .collect();
    terms.sort_by(|a, b| {
        b.len()
            .cmp(&a.len())
            .then_with(|| a.as_str().cmp(b.as_str()))
    });

    let mut result = output.to_string();
    for term in terms {
        let tagged = format!("@{term}");
        // 1. Collapse a stray "@ filename" (sigil then a single space) FIRST, so
        //    the trigger-word pass below doesn't see a leftover word.
        result = replace_at_boundaries(&result, &format!("@ {term}"), &tagged);
        // 2. "<trigger> filename" → "@filename" for the spoken trigger words.
        //    Each trigger is matched at both lowercase- and Capitalized-initial
        //    (sentence-start) spelling; the produced "@<name>" is left alone on a
        //    re-run because "<trigger> @<name>" never appears (the sigil replaces
        //    the trigger + name).
        for trigger in FILE_TAG_TRIGGERS {
            result = replace_at_boundaries(&result, &format!("{trigger} {term}"), &tagged);
            let cap = capitalize_ascii_initial(trigger);
            result = replace_at_boundaries(&result, &format!("{cap} {term}"), &tagged);
        }
        // 3. Natural-mention pass: a BARE, boundary-delimited "filename" anywhere
        //    → "@filename". left_boundary_ok already skips "@<name>" (idempotent,
        //    no "@@") and "x.<name>" (in-path), so this only sigil-izes an exact,
        //    context-present, extension-bearing filename token.
        result = replace_at_boundaries(&result, term, &tagged);
    }
    result
}

/// Extract every DISTINCT, boundary-delimited, extension-bearing filename token
/// present in `text` (the same shape [`apply_ide_file_tags`] would tag). Used by
/// the workspace-tagging union to widen the KNOWN set with ONLY the workspace
/// basenames the user actually spoke — never the whole (up-to-50k) index — so the
/// tagger's per-term full-text scan stays bounded by what's in the utterance.
///
/// Boundary rules match the tagger: a token is skipped if its left neighbour is
/// alnum/`_`/`.`/`@` (so `x.name`, `@name`, `foo@name` don't yield a spurious
/// `name`) or its right neighbour is alnum/`_` (a prefix of a longer token).
/// Casing is preserved as spoken.
pub fn extract_taggable_filenames(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut i = 0;
    let bytes = text.as_bytes();
    while i < bytes.len() {
        // Advance to the start of a candidate token (a filename can't start with
        // a separator we treat as interior, so start at any non-boundary run).
        let c = text[i..].chars().next().unwrap();
        let is_wordy = c.is_alphanumeric() || c == '.' || c == '_' || c == '-';
        if !is_wordy {
            i += c.len_utf8();
            continue;
        }
        // Consume the maximal wordy run.
        let start = i;
        let mut end = start;
        for (rel, ch) in text[start..].char_indices() {
            if ch.is_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
                end = start + rel + ch.len_utf8();
            } else {
                break;
            }
        }
        let token = &text[start..end];
        if looks_like_taggable_filename(token)
            && left_boundary_ok(text, start)
            && right_boundary_ok(text, end)
            && seen.insert(token.to_string())
        {
            out.push(token.to_string());
        }
        i = end.max(i + 1);
    }
    out
}

/// Additive, IDE-gated pass that UPGRADES a bare `@basename.ext` tag (as produced
/// by [`apply_ide_file_tags`]) to a workspace-relative `@<root/rel/path>.ext` when
/// — and only when — `resolve_unique` reports the basename is UNIQUE in the
/// workspace index (case 1 of the disambiguation design). It scans the text for
/// every `@`-prefixed, extension-bearing, boundary-delimited filename token, asks
/// `resolve_unique(basename)` for a unique root-relative path, and replaces the
/// bare `@name.ext` with `@rel/path/name.ext` (forward slashes, root-relative).
///
/// A basename that is ambiguous or comes from a truncated index yields `None` from
/// `resolve_unique` and is left as the bare `@name` (never a guessed path). Pure,
/// boundary-safe, and idempotent: once a tag is a path, its trailing basename
/// still resolves to the SAME unique path, and [`replace_at_boundaries`] rewrites
/// the already-correct `@rel/path` in place (a no-op). Casing of the emitted name
/// follows the index's on-disk spelling embedded in the returned relpath.
///
/// The returned path text is still literal pasted TEXT (does NOT drive Cursor's
/// @-mention picker) — the same paste-based ceiling as the bare-name tagger — but
/// now path-qualified, matching Wispr's "the right file in your workspace".
pub fn upgrade_tags_to_paths(
    output: &str,
    is_ide: bool,
    resolve_unique: impl Fn(&str) -> Option<String>,
) -> String {
    if !is_ide || output.is_empty() || !output.contains('@') {
        return output.to_string();
    }

    // Collect the distinct `@basename.ext` tags present so we can rewrite each
    // once, longest-first (so `@a.test.tsx` is handled before `@test.tsx` could
    // touch its suffix). We only look at tokens that (a) start with `@`, (b) pass
    // the same filename shape gate, and (c) have a unique workspace path.
    let mut upgrades: Vec<(String, String)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let bytes = output.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'@' {
            i += 1;
            continue;
        }
        // A tag must sit at a valid left boundary (never inside `foo@name` or an
        // email) — reuse the same guard the tagger uses, checked at the `@`.
        if !left_boundary_ok(output, i) {
            i += 1;
            continue;
        }
        // Consume the filename token after the sigil (word chars + `.`/`_`/`-`).
        let start = i + 1;
        let mut end = start;
        for (rel, c) in output[start..].char_indices() {
            if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' {
                end = start + rel + c.len_utf8();
            } else {
                break;
            }
        }
        let name = &output[start..end];
        if looks_like_taggable_filename(name)
            && seen.insert(name.to_string())
            && let Some(rel) = resolve_unique(name)
            && rel != name
        {
            upgrades.push((name.to_string(), rel));
        }
        i = end.max(i + 1);
    }
    // Longest basename first, then lexicographic for determinism.
    upgrades.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));

    let mut result = output.to_string();
    for (name, rel) in upgrades {
        // Rewrite `@name` → `@rel`. The needle carries its own `@`, so a bare
        // `name` inside prose is untouched and only the already-sigilled tag moves.
        result = replace_at_boundaries(&result, &format!("@{name}"), &format!("@{rel}"));
    }
    result
}

/// Uppercase only the first ASCII char of a lowercase trigger word ("at" → "At").
/// The triggers are ASCII, so a simple first-byte upcase is exact and allocation-
/// light.
fn capitalize_ascii_initial(word: &str) -> String {
    let mut c = word.chars();
    match c.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + c.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests;
