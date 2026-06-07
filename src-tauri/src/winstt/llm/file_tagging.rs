// IDE chat file tagging — the deterministic rewrite that turns spoken file
// references into "@filename" chat tags (Cursor / Windsurf chat panels), mirroring
// Wispr Flow's file-tagging behavior.
//
// PURE string logic, no I/O. The `catalog` (filenames WITH extensions, sourced
// from the IDE's open tabs + sidebar tree) is supplied by the caller; building
// that catalog from the UIA snapshot is a separate, JSON-tuned concern.
//
// Semantics (v1 — NON-DESTRUCTIVE; refine against real captures):
//   1. A recognized FULL filename (literal "cron.py", or spoken "cron dot py" /
//      "my script dot py") is replaced in place with "@<filename>". Surrounding
//      words — including any preceding trigger — are left untouched.
//        "look at cron.py and vad.py" → "look at @cron.py and @vad.py"
//   2. A trigger word ("at" / "tag" / "tagged") immediately followed by a BASE
//      name (no extension) that uniquely resolves in the catalog consumes the
//      trigger and expands: "tag myScript" → "@myScript.py". This is the only
//      case a dictated word is dropped, and only because a bare base name needs
//      the trigger to be intentional and needs expanding to a full filename.
//   3. Dot-prefixed files: "dot env" → ".env" (a full filename), handled by (1).
//   4. Longest span wins; matching is case- and separator-insensitive
//      ("my script" ≡ "myScript" ≡ "my_script"); already-"@"-tagged tokens are
//      left alone; an ambiguous base name (same stem, different extensions) is
//      skipped rather than guessed.
//
// NOTE: Flow's headline example drops "at" ("Check at main.py" → "Check
// @main.py"). We keep it ("Check at @main.py") because never deleting a dictated
// word is the safer default; this is the kind of nuance we tune later.

use std::collections::HashMap;

/// Spoken words that introduce a base-name file reference.
const TRIGGERS: &[&str] = &["at", "tag", "tagged"];
/// Max number of spoken tokens a single filename may span ("my script dot py").
const MAX_SPAN: usize = 8;

/// Result of a file-tagging pass: the rewritten text plus the full filenames that
/// were tagged (in first-seen order, deduped) — useful for the debug window.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileTagResult {
    pub text: String,
    pub tagged: Vec<String>,
}

struct Catalog {
    /// canon(full filename) → original filename.
    full: HashMap<String, String>,
    /// canon(stem) → original filenames sharing that stem (skips dot-leading files).
    stem: HashMap<String, Vec<String>>,
}

/// Canonical form for matching: lowercase, keep only `[a-z0-9.]`. Drops spaces,
/// underscores, hyphens, and camelCase boundaries so spoken and written forms
/// compare equal ("myScript" / "my script" / "my_script" → "myscript").
fn canon(s: &str) -> String {
    s.chars()
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.')
        .collect()
}

fn build_catalog(files: &[String]) -> Catalog {
    let mut full = HashMap::new();
    let mut stem: HashMap<String, Vec<String>> = HashMap::new();
    for raw in files {
        let name = raw.trim();
        // Must have an extension dot.
        let Some(dot) = name.rfind('.') else {
            continue;
        };
        let cfull = canon(name);
        if !cfull.contains('.') {
            continue;
        }
        full.entry(cfull).or_insert_with(|| name.to_string());
        // Stem index (skip dot-leading files like ".env" — those need "dot env").
        if dot > 0 {
            let cstem = canon(&name[..dot]);
            if !cstem.is_empty() && !cstem.contains('.') {
                stem.entry(cstem).or_default().push(name.to_string());
            }
        }
    }
    Catalog { full, stem }
}

struct Word {
    /// Index into the segment list (for reconstruction).
    seg: usize,
    /// Leading punctuation stripped from the token (e.g. "(").
    lead: String,
    /// The filename-ish core of the token.
    core: String,
    /// Trailing punctuation stripped from the token (e.g. "," ")").
    trail: String,
    /// Lowercased core (for trigger / "dot" checks).
    lower: String,
}

fn split_affixes(s: &str) -> (String, String, String) {
    const LEAD: &[char] = &['(', '[', '{', '"', '\''];
    const TRAIL: &[char] = &[')', ']', '}', '"', '\'', ',', ';', ':', '!', '?'];
    let chars: Vec<char> = s.chars().collect();
    let mut a = 0;
    while a < chars.len() && LEAD.contains(&chars[a]) {
        a += 1;
    }
    let mut b = chars.len();
    while b > a && TRAIL.contains(&chars[b - 1]) {
        b -= 1;
    }
    (
        chars[..a].iter().collect(),
        chars[a..b].iter().collect(),
        chars[b..].iter().collect(),
    )
}

/// Split text into runs of whitespace / non-whitespace, preserving everything for
/// exact reconstruction, and index the non-whitespace runs as `Word`s.
fn tokenize(text: &str) -> (Vec<(bool, String)>, Vec<Word>) {
    let mut segs: Vec<(bool, String)> = Vec::new();
    let mut run = String::new();
    let mut run_ws = false;
    let mut started = false;
    for ch in text.chars() {
        let is_ws = ch.is_whitespace();
        if started && is_ws == run_ws {
            run.push(ch);
        } else {
            if started {
                segs.push((!run_ws, std::mem::take(&mut run)));
            }
            run.push(ch);
            run_ws = is_ws;
            started = true;
        }
    }
    if started {
        segs.push((!run_ws, run));
    }

    let mut words = Vec::new();
    for (i, (is_word, s)) in segs.iter().enumerate() {
        if *is_word {
            let (lead, core, trail) = split_affixes(s);
            let lower = core.to_lowercase();
            words.push(Word {
                seg: i,
                lead,
                core,
                trail,
                lower,
            });
        }
    }
    (segs, words)
}

/// Canonical join of `len` spoken tokens starting at `start`, translating a spoken
/// "dot" / "punto" token into ".".
fn join_canon(words: &[Word], start: usize, len: usize) -> String {
    let mut out = String::new();
    for w in &words[start..start + len] {
        if w.lower == "dot" || w.lower == "punto" {
            out.push('.');
        } else {
            out.push_str(&canon(&w.core));
        }
    }
    out
}

/// Longest full-filename span starting at `start` → (span length, filename).
fn match_full(words: &[Word], start: usize, cat: &Catalog) -> Option<(usize, String)> {
    let max = MAX_SPAN.min(words.len() - start);
    for len in (1..=max).rev() {
        let cj = join_canon(words, start, len);
        if !cj.contains('.') {
            continue;
        }
        if let Some(name) = cat.full.get(&cj) {
            return Some((len, name.clone()));
        }
    }
    None
}

/// Longest base-name span (no extension) starting at `start` that resolves to a
/// UNIQUE catalog filename → (span length, filename). Used only after a trigger.
fn match_base(words: &[Word], start: usize, cat: &Catalog) -> Option<(usize, String)> {
    if start >= words.len() {
        return None;
    }
    let max = MAX_SPAN.min(words.len() - start);
    for len in (1..=max).rev() {
        let cj = join_canon(words, start, len);
        if cj.is_empty() || cj.contains('.') {
            continue;
        }
        if let Some(names) = cat.stem.get(&cj) {
            if names.len() == 1 {
                return Some((len, names[0].clone()));
            }
        }
    }
    None
}

fn push_unique(v: &mut Vec<String>, s: &str) {
    if !v.iter().any(|x| x == s) {
        v.push(s.to_string());
    }
}

struct Rep {
    start_seg: usize,
    end_seg: usize,
    text: String,
}

/// Rewrite spoken file references in `text` into "@filename" tags using `catalog`
/// (filenames with extensions). Returns the original text unchanged when nothing
/// matched.
pub fn apply_file_tagging(text: &str, catalog: &[String]) -> FileTagResult {
    if text.is_empty() || catalog.is_empty() {
        return FileTagResult {
            text: text.to_string(),
            tagged: Vec::new(),
        };
    }
    let cat = build_catalog(catalog);
    if cat.full.is_empty() {
        return FileTagResult {
            text: text.to_string(),
            tagged: Vec::new(),
        };
    }
    let (segs, words) = tokenize(text);

    let mut reps: Vec<Rep> = Vec::new();
    let mut tagged: Vec<String> = Vec::new();
    let mut wi = 0usize;
    while wi < words.len() {
        // Leave already-tagged tokens alone.
        if words[wi].core.starts_with('@') {
            wi += 1;
            continue;
        }
        // Case 2: trigger + base name (consumes the trigger).
        if TRIGGERS.contains(&words[wi].lower.as_str()) {
            if let Some((len, name)) = match_base(&words, wi + 1, &cat) {
                let first = &words[wi];
                let last = &words[wi + len];
                reps.push(Rep {
                    start_seg: first.seg,
                    end_seg: last.seg,
                    text: format!("{}@{}{}", first.lead, name, last.trail),
                });
                push_unique(&mut tagged, &name);
                wi += 1 + len;
                continue;
            }
        }
        // Case 1: full filename span (trigger, if any, left intact).
        if let Some((len, name)) = match_full(&words, wi, &cat) {
            let first = &words[wi];
            let last = &words[wi + len - 1];
            reps.push(Rep {
                start_seg: first.seg,
                end_seg: last.seg,
                text: format!("{}@{}{}", first.lead, name, last.trail),
            });
            push_unique(&mut tagged, &name);
            wi += len;
            continue;
        }
        wi += 1;
    }

    if reps.is_empty() {
        return FileTagResult {
            text: text.to_string(),
            tagged: Vec::new(),
        };
    }

    reps.sort_by_key(|r| r.start_seg);
    let mut out = String::with_capacity(text.len() + reps.len() * 2);
    let mut si = 0usize;
    let mut ri = 0usize;
    while si < segs.len() {
        if ri < reps.len() && reps[ri].start_seg == si {
            out.push_str(&reps[ri].text);
            si = reps[ri].end_seg + 1;
            ri += 1;
        } else {
            out.push_str(&segs[si].1);
            si += 1;
        }
    }
    FileTagResult { text: out, tagged }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat() -> Vec<String> {
        vec![
            "main.py".into(),
            "cron.py".into(),
            "vad.py".into(),
            "myScript.py".into(),
            ".env".into(),
            "App.tsx".into(),
        ]
    }

    #[test]
    fn literal_full_filename_auto_tags() {
        let r = apply_file_tagging("open cron.py now", &cat());
        assert_eq!(r.text, "open @cron.py now");
        assert_eq!(r.tagged, vec!["cron.py".to_string()]);
    }

    #[test]
    fn multiple_files_in_one_dictation() {
        let r = apply_file_tagging("look at cron.py and vad.py", &cat());
        assert_eq!(r.text, "look at @cron.py and @vad.py");
        assert_eq!(r.tagged, vec!["cron.py".to_string(), "vad.py".to_string()]);
    }

    #[test]
    fn trigger_plus_base_name_expands_and_consumes_trigger() {
        let r = apply_file_tagging("tag myScript please", &cat());
        assert_eq!(r.text, "@myScript.py please");
        assert_eq!(r.tagged, vec!["myScript.py".to_string()]);
    }

    #[test]
    fn trigger_plus_full_filename_keeps_trigger() {
        // Non-destructive: "at" stays; main.py is tagged in place.
        let r = apply_file_tagging("check at main.py for bugs", &cat());
        assert_eq!(r.text, "check at @main.py for bugs");
    }

    #[test]
    fn spoken_dot_prefixed_file() {
        let r = apply_file_tagging("edit dot env file", &cat());
        assert_eq!(r.text, "edit @.env file");
        assert_eq!(r.tagged, vec![".env".to_string()]);
    }

    #[test]
    fn spoken_multiword_camelcase_filename() {
        let r = apply_file_tagging("open my script dot py", &cat());
        assert_eq!(r.text, "open @myScript.py");
        assert_eq!(r.tagged, vec!["myScript.py".to_string()]);
    }

    #[test]
    fn longest_match_wins() {
        let files = vec!["app.tsx".to_string(), "app.test.tsx".to_string()];
        let r = apply_file_tagging("run app.test.tsx", &files);
        assert_eq!(r.text, "run @app.test.tsx");
    }

    #[test]
    fn preserves_punctuation_around_filename() {
        let r = apply_file_tagging("see (cron.py), thanks", &cat());
        assert_eq!(r.text, "see (@cron.py), thanks");
    }

    #[test]
    fn already_tagged_is_left_alone() {
        let r = apply_file_tagging("already @main.py here", &cat());
        assert_eq!(r.text, "already @main.py here");
        assert!(r.tagged.is_empty());
    }

    #[test]
    fn no_match_returns_unchanged() {
        let r = apply_file_tagging("just some prose here", &cat());
        assert_eq!(r.text, "just some prose here");
        assert!(r.tagged.is_empty());
        // Empty catalog is a clean no-op.
        let r2 = apply_file_tagging("open main.py", &[]);
        assert_eq!(r2.text, "open main.py");
    }

    #[test]
    fn ambiguous_base_name_is_skipped() {
        // Two files share the stem "main" → a bare "tag main" can't be resolved.
        let files = vec!["main.py".to_string(), "main.ts".to_string()];
        let r = apply_file_tagging("tag main now", &files);
        assert_eq!(r.text, "tag main now");
        assert!(r.tagged.is_empty());
    }

    #[test]
    fn newlines_preserved() {
        let r = apply_file_tagging("first line\nopen cron.py\nlast", &cat());
        assert_eq!(r.text, "first line\nopen @cron.py\nlast");
    }
}
