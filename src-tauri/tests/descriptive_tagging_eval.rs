// Black-box reliability measurement for the descriptive-phrase → workspace-file
// tagger. Treats the resolver purely as its public API:
//   winstt_app_lib::winstt::context::file_reference_resolver::{
//       FileRefIndex, resolve_descriptive_tags }
// and drives it with a labeled corpus grounded in the REAL WinSTT enumeration
// (the same `git ls-files --cached --others --exclude-standard` set the runtime
// index is built from). Emits a full results.json with per-case verdicts and the
// aggregate precision / recall / FPR against the ship bar (precision >= 0.90 AND
// FPR <= 0.10).
//
// Run with:  cargo test --test descriptive_tagging_eval -- --nocapture --ignored
// (ignored by default so it never runs on the normal test path — it shells out to
// git and writes an artifact.)

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use winstt_app_lib::winstt::context::file_reference_resolver::{
    FileRefIndex, resolve_descriptive_tags,
};

/// Optional external corpus override via the `WINSTT_DESC_CORPUS` env var (a path
/// to a JSON file). When set the harness reads it as-is for fast iteration without
/// a recompile; otherwise it falls back to [`EMBEDDED_CORPUS`], the
/// version-controlled copy that ships with the repo so this measurement is
/// reproducible on any checkout.

/// The labeled corpus, embedded so the reliability measurement is reproducible on
/// a fresh checkout (no dependency on an ephemeral scratchpad file). 58 cases:
/// 23 positives (each names a UNIQUE real basename in the tree), 21 negatives
/// (ordinary prose that names no file), and 14 ambiguities (a phrase owned by 2+
/// set-equal files, or a bare single-token / cue-noun that must abstain). All
/// utterances are grounded in the real `git ls-files` enumeration.
const EMBEDDED_CORPUS: &str = include_str!("descriptive_tagging_corpus.json");

#[derive(Debug, Deserialize)]
struct Case {
    id: u32,
    class: String, // "positive" | "negative" | "ambiguous"
    utterance: String,
    #[serde(default)]
    expected_basename: Option<String>,
    #[serde(default)]
    hard: bool,
}

#[derive(Debug, Serialize)]
struct CaseResult {
    id: u32,
    class: String,
    hard: bool,
    utterance: String,
    expected_basename: Option<String>,
    expected_relpath: Option<String>,
    /// Full resolver output (byte-for-byte).
    output: String,
    /// True if the resolver spliced an @-tag over the descriptive span.
    tagged: bool,
    /// The relpath the resolver tagged, if any (extracted from `@<relpath>`).
    got_relpath: Option<String>,
    /// Judgement bucket for aggregate metrics.
    verdict: String, // TP | FN | TN | FP | WRONG_TAG
    correct: bool,
}

#[derive(Debug, Serialize)]
struct Metrics {
    corpus_size: usize,
    positives: usize,
    negatives: usize,
    ambiguous: usize,
    emitted_tags: usize,
    correct_tags: usize,
    precision: f64,
    recall: f64,
    false_positive_rate: f64,
    threshold_used: String,
    reliable: bool,
}

#[derive(Debug, Serialize)]
struct Report {
    root: String,
    enumeration_count: usize,
    truncated: bool,
    metrics: Metrics,
    cases: Vec<CaseResult>,
}

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is <root>/src-tauri; the git root is its parent.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .to_path_buf()
}

/// Reproduce the runtime enumeration exactly: tracked + untracked-not-ignored,
/// NUL-separated, forward-slash repo-relative paths.
fn enumerate(root: &Path) -> Vec<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .output()
        .expect("git ls-files runs");
    assert!(out.status.success(), "git ls-files failed");
    String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// Map basename -> unique relpath (only when unique). Used to resolve a case's
/// expected basename to the concrete path the resolver ought to emit.
fn unique_relpath_for(relpaths: &[String], basename: &str) -> Option<String> {
    let mut hit: Option<&str> = None;
    for p in relpaths {
        let b = p.rsplit('/').next().unwrap_or(p);
        if b.eq_ignore_ascii_case(basename) {
            if hit.is_some() {
                return None; // not unique
            }
            hit = Some(p);
        }
    }
    hit.map(|s| s.to_string())
}

/// Extract the first `@<relpath>` token the resolver spliced in, if the output
/// differs from the input. The resolver emits `@` + a forward-slash relpath.
fn extract_tag(input: &str, output: &str) -> Option<String> {
    if input == output {
        return None;
    }
    // Find an @-token that is NOT present in the input at the same style. We just
    // scan for '@' followed by a path-ish run (letters/digits/_/-/./ and '/').
    let bytes = output.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() {
                let c = bytes[j];
                let ok = c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b'/');
                if !ok {
                    break;
                }
                j += 1;
            }
            if j > start {
                let tok = &output[start..j];
                // A real file tag contains a '/' or a dotted extension.
                if tok.contains('/') || tok.contains('.') {
                    return Some(tok.to_string());
                }
            }
        }
        i += 1;
    }
    // Output changed but no parseable @token: still count as tagged-unknown.
    Some(String::from("<changed>"))
}

#[test]
#[ignore = "adversarial reliability measurement; writes an artifact and shells out to git"]
fn measure_descriptive_tagger_reliability() {
    let root = repo_root();
    let relpaths = enumerate(&root);
    let refs: Vec<&str> = relpaths.iter().map(|s| s.as_str()).collect();
    let index = FileRefIndex::from_relpaths(refs.iter().copied(), false);

    // Prefer an external corpus via WINSTT_DESC_CORPUS (fast iteration without a
    // recompile), else fall back to the embedded, version-controlled copy.
    let corpus_raw = std::env::var("WINSTT_DESC_CORPUS")
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| EMBEDDED_CORPUS.to_string());
    let cases: Vec<Case> = serde_json::from_str(&corpus_raw).expect("corpus parses");

    let mut results: Vec<CaseResult> = Vec::new();
    let (mut emitted, mut correct_tags) = (0usize, 0usize);
    let (mut tp, mut fp_neg) = (0usize, 0usize);
    let (mut n_pos, mut n_neg, mut n_amb) = (0usize, 0usize, 0usize);
    let mut neg_amb_total = 0usize;

    for c in &cases {
        let expected_relpath = c
            .expected_basename
            .as_deref()
            .and_then(|b| unique_relpath_for(&relpaths, b));

        let output = resolve_descriptive_tags(&c.utterance, true, &index);
        let got = extract_tag(&c.utterance, &output);
        let tagged = got.is_some();

        let (verdict, correct);
        match c.class.as_str() {
            "positive" => {
                n_pos += 1;
                match (&expected_relpath, &got) {
                    (Some(exp), Some(g)) if g.eq_ignore_ascii_case(exp) => {
                        verdict = "TP";
                        correct = true;
                        tp += 1;
                    }
                    (_, Some(_)) => {
                        // tagged, but the WRONG file
                        verdict = "WRONG_TAG";
                        correct = false;
                    }
                    (_, None) => {
                        // abstained on a positive => recall miss (not a precision hit)
                        verdict = "FN";
                        correct = false;
                    }
                }
            }
            "negative" | "ambiguous" => {
                if c.class == "negative" {
                    n_neg += 1;
                } else {
                    n_amb += 1;
                }
                neg_amb_total += 1;
                if tagged {
                    verdict = "FP";
                    correct = false;
                    fp_neg += 1;
                } else {
                    verdict = "TN";
                    correct = true;
                }
            }
            other => panic!("unknown class {other}"),
        }

        if tagged {
            emitted += 1;
            if verdict == "TP" {
                correct_tags += 1;
            }
        }

        results.push(CaseResult {
            id: c.id,
            class: c.class.clone(),
            hard: c.hard,
            utterance: c.utterance.clone(),
            expected_basename: c.expected_basename.clone(),
            expected_relpath,
            output,
            tagged,
            got_relpath: got,
            verdict: verdict.to_string(),
            correct,
        });
    }

    // precision = correct emitted tags / all emitted tags
    let precision = if emitted == 0 {
        1.0
    } else {
        correct_tags as f64 / emitted as f64
    };
    // recall = TP / positives
    let recall = if n_pos == 0 {
        0.0
    } else {
        tp as f64 / n_pos as f64
    };
    // FPR = wrong emissions among cases that should abstain / all such cases
    let fpr = if neg_amb_total == 0 {
        0.0
    } else {
        fp_neg as f64 / neg_amb_total as f64
    };
    let reliable = precision >= 0.90 && fpr <= 0.10;

    let report = Report {
        root: root.display().to_string(),
        enumeration_count: relpaths.len(),
        truncated: false,
        metrics: Metrics {
            corpus_size: cases.len(),
            positives: n_pos,
            negatives: n_neg,
            ambiguous: n_amb,
            emitted_tags: emitted,
            correct_tags,
            precision,
            recall,
            false_positive_rate: fpr,
            threshold_used: "precision>=0.90 AND FPR<=0.10".to_string(),
            reliable,
        },
        cases: results,
    };

    let out_dir = root.join(".tmp_e2e").join("descriptive_tagging");
    std::fs::create_dir_all(&out_dir).expect("create results dir");
    let out_path = out_dir.join("results.json");
    std::fs::write(&out_path, serde_json::to_string_pretty(&report).unwrap())
        .expect("write results.json");

    eprintln!("=== descriptive tagger reliability ===");
    eprintln!("enumeration files : {}", report.enumeration_count);
    eprintln!(
        "corpus            : {} ({} pos / {} neg / {} amb)",
        cases.len(),
        n_pos,
        n_neg,
        n_amb
    );
    eprintln!("emitted tags      : {emitted}  (correct {correct_tags})");
    eprintln!("precision         : {precision:.4}");
    eprintln!("recall            : {recall:.4}");
    eprintln!("false-pos rate    : {fpr:.4}");
    eprintln!("reliable (ship)   : {reliable}");
    eprintln!("results.json      : {}", out_path.display());
    for r in &report.cases {
        eprintln!(
            "  [{:<9}] {:<9} tagged={} got={:?} :: {}",
            r.verdict, r.class, r.tagged, r.got_relpath, r.utterance
        );
    }
}
