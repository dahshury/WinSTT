//! caret_join_reverify — live acceptance gate for the deterministic caret-join
//! post-pass (`winstt::context::join_for_insertion` /
//! `winstt::context::apply_ide_file_tags`), the SAME functions wired into
//! `actions::post_process::process_transcription_output`.
//!
//! It proves the two behaviours the small local model (`gemma4:e4b`) ignored are
//! now enforced deterministically after the LLM:
//!
//!   A. Notepad mid-sentence continuation casing. Replays the EXACT production
//!      request body captured for the notepad-continuation fixture (built by the
//!      real prompt builder, carrying the beforeCaret continuation clause + the
//!      "...smooth and" context) against Ollama 3x, parses `.text` the same way
//!      production does (`value["text"]`), pipes it through the real
//!      `join_for_insertion`, and asserts the final text starts
//!      "the migration finished..." with no double space. 3/3 must pass.
//!
//!   B. Cursor @file tagging. Feeds the 10 saved REAL Cursor model outputs
//!      (`.tmp_e2e/cursor_ide/resp_b_*.ndjson`, where the model wrote
//!      "at context_manager.rs" / "@context_manager.rs") through the real
//!      `apply_ide_file_tags` with `is_ide=true` and the extracted term
//!      "context_manager.rs". Asserts "@context_manager.rs" in 10/10, no `@@`,
//!      no invented tags.
//!
//! Run: `cargo run --example caret_join_reverify`
//! Ollama: http://127.0.0.1:11434, model gemma4:e4b. Artifacts are written under
//! `.tmp_e2e/caret_join_reverify/`.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use winstt_app_lib::winstt::context::{apply_ide_file_tags, join_for_insertion};

const OLLAMA_URL: &str = "http://127.0.0.1:11434/api/chat";
const REPO_TMP: &str = "../.tmp_e2e";

/// The beforeCaret the notepad fixture captured (mid-sentence, no terminal). The
/// caret join reads THIS to decide continuation lowercasing — exactly as the
/// wired code reads `snapshot.text_before`.
const NOTEPAD_BEFORE_CARET: &str =
    "We deployed the Kubernetes cluster yesterday. The rollout was smooth and";

/// The session biasing terms for the notepad fixture (Kubernetes is a visible
/// proper noun, protected from lowercasing; it is not the first word so it does
/// not affect this case, but we pass a realistic set).
fn notepad_terms() -> Vec<String> {
    vec!["Kubernetes".to_string()]
}

fn repo_tmp() -> PathBuf {
    PathBuf::from(REPO_TMP)
}

fn out_dir() -> PathBuf {
    repo_tmp().join("caret_join_reverify")
}

/// Parse `.text` from a model content string the SAME way production does
/// (`value.get("text")`). The model returns a JSON object; on non-JSON we fall
/// back to the raw string (mirrors the fail-soft behaviour).
fn extract_text_field(content: &str) -> String {
    serde_json::from_str::<serde_json::Value>(content.trim())
        .ok()
        .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_else(|| content.trim().to_string())
}

/// One Ollama /api/chat call replaying an already-built production body. Returns
/// the assistant message content (the model's JSON string).
async fn ollama_chat(client: &reqwest::Client, body: &serde_json::Value) -> Result<String, String> {
    let resp = client
        .post(OLLAMA_URL)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("read body failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("ollama {status}: {}", &text[..text.len().min(400)]));
    }
    // Non-streaming: one JSON object with message.content.
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse response: {e}; body: {text}"))?;
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(String::from)
        .ok_or_else(|| format!("no message.content in response: {text}"))
}

/// Read the saved production request body for the notepad continuation, force
/// non-streaming so we get one object back.
fn load_notepad_body() -> Result<serde_json::Value, String> {
    let path = repo_tmp().join("notepad_caret/a_continuation/chat_body_generic.json");
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse body: {e}"))?;
    value["stream"] = serde_json::Value::Bool(false);
    Ok(value)
}

/// Part A: 3 live runs through the real prompt + Ollama + `join_for_insertion`.
async fn reverify_notepad_continuation(client: &reqwest::Client) -> Result<usize, String> {
    let body = load_notepad_body()?;
    let terms = notepad_terms();
    let mut passes = 0usize;
    let mut records = Vec::new();

    for run in 1..=3 {
        let content = ollama_chat(client, &body).await?;
        let model_text = extract_text_field(&content);
        // The REAL wired call: same signature as in post_process::apply_caret_join.
        let joined = join_for_insertion(&model_text, Some(NOTEPAD_BEFORE_CARET), None, &terms);
        // The captured beforeCaret ends "...and" with NO trailing space, so the
        // real caret sits directly after it: the join correctly inserts ONE
        // leading space. The acceptance is on the CONTINUATION CASING — the
        // model's title-case "The" is lowercased to "the" (first word only; the
        // spec deliberately leaves the interior title-case tail to the LLM so
        // proper nouns are never corrupted). Assert on the trimmed text.
        let trimmed = joined.trim_start();
        // First word lowercased: starts with lowercase "the " (not "The ").
        let starts_lower_the = trimmed.starts_with("the ") && !trimmed.starts_with("The ");
        // Case-insensitively it is the expected continuation phrase.
        let is_migration_phrase = trimmed.to_lowercase().starts_with("the migration finished");
        let no_double_space = !joined.contains("  ");
        let pass = starts_lower_the && is_migration_phrase && no_double_space;
        if pass {
            passes += 1;
        }
        println!(
            "[A run {run}] model_text={model_text:?}\n          joined={joined:?}\n          first_word_lowercased={starts_lower_the} continuation_phrase={is_migration_phrase} no_double_space={no_double_space} => {}",
            if pass { "PASS" } else { "FAIL" }
        );
        records.push(serde_json::json!({
            "run": run,
            "model_text": model_text,
            "joined": joined,
            "first_word_lowercased": starts_lower_the,
            "continuation_phrase": is_migration_phrase,
            "no_double_space": no_double_space,
            "pass": pass,
        }));
    }

    let summary = serde_json::json!({
        "fixture": "notepad_continuation",
        "before_caret": NOTEPAD_BEFORE_CARET,
        "passes": passes,
        "runs": records,
    });
    write_artifact("notepad_continuation.json", &summary)?;
    Ok(passes)
}

/// Collect the 10 saved Cursor model outputs (each an NDJSON stream of chat
/// chunks; concatenate `message.content`) and extract each `.text` field.
fn load_cursor_outputs() -> Result<Vec<(String, String)>, String> {
    let dir = repo_tmp().join("cursor_ide");
    // The 10 runs that motivated the gate: r3..r10 (8), plus the two filetag runs.
    let names = [
        "resp_b_r3.ndjson",
        "resp_b_r4.ndjson",
        "resp_b_r5.ndjson",
        "resp_b_r6.ndjson",
        "resp_b_r7.ndjson",
        "resp_b_r8.ndjson",
        "resp_b_r9.ndjson",
        "resp_b_r10.ndjson",
        "resp_b_filetag.ndjson",
        "resp_b_filetag_r2.ndjson",
    ];
    let mut out = Vec::new();
    for name in names {
        let path = dir.join(name);
        let raw =
            std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let mut content = String::new();
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line)
                && let Some(c) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
            {
                content.push_str(c);
            }
        }
        let text = extract_text_field(&content);
        out.push((name.to_string(), text));
    }
    Ok(out)
}

/// Part B: the 10 saved Cursor outputs through the real `apply_ide_file_tags`.
fn reverify_cursor_filetags() -> Result<usize, String> {
    let outputs = load_cursor_outputs()?;
    let terms = vec!["context_manager.rs".to_string()];
    let mut passes = 0usize;
    let mut records = Vec::new();

    for (name, model_text) in &outputs {
        // The REAL wired call (is_ide=true for Cursor).
        let tagged = apply_ide_file_tags(model_text, true, &terms);
        let has_tag = tagged.contains("@context_manager.rs");
        let no_double = !tagged.contains("@@");
        // No invented tags: the only '@' present is the one before the real file.
        let at_count = tagged.matches('@').count();
        let no_invented = at_count <= 1;
        let pass = has_tag && no_double && no_invented;
        if pass {
            passes += 1;
        }
        println!(
            "[B {name}] model_text={model_text:?}\n          tagged={tagged:?}\n          has_tag={has_tag} no_double={no_double} no_invented={no_invented} => {}",
            if pass { "PASS" } else { "FAIL" }
        );
        records.push(serde_json::json!({
            "source": name,
            "model_text": model_text,
            "tagged": tagged,
            "has_tag": has_tag,
            "no_double_sigil": no_double,
            "no_invented_tags": no_invented,
            "pass": pass,
        }));
    }

    let summary = serde_json::json!({
        "fixture": "cursor_filetag",
        "terms": ["context_manager.rs"],
        "passes": passes,
        "total": outputs.len(),
        "runs": records,
    });
    write_artifact("cursor_filetag.json", &summary)?;
    Ok(passes)
}

fn write_artifact(name: &str, value: &serde_json::Value) -> Result<(), String> {
    let dir = out_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join(name);
    std::fs::write(
        &path,
        serde_json::to_string_pretty(value).unwrap_or_default(),
    )
    .map_err(|e| format!("write {}: {e}", path.display()))?;
    println!("  wrote {}", path.display());
    Ok(())
}

fn assert_dir() -> Result<(), String> {
    let p = Path::new(REPO_TMP);
    if !p.exists() {
        return Err(format!(
            "{REPO_TMP} not found (run from src-tauri/ so the saved E2E captures resolve)"
        ));
    }
    Ok(())
}

fn main() -> ExitCode {
    if let Err(e) = assert_dir() {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }

    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("error: tokio runtime: {e}");
            return ExitCode::FAILURE;
        }
    };

    // Part B is offline (replays saved outputs) — always run it.
    println!("=== B. Cursor @file tagging (10 saved real outputs) ===");
    let b_passes = match reverify_cursor_filetags() {
        Ok(n) => n,
        Err(e) => {
            eprintln!("error (B): {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("B result: {b_passes}/10\n");

    // Part A needs Ollama live.
    println!("=== A. Notepad continuation (3 live Ollama runs) ===");
    let client = reqwest::Client::new();
    let a_passes = match rt.block_on(reverify_notepad_continuation(&client)) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("error (A): {e}");
            eprintln!("(is Ollama running at 127.0.0.1:11434 with gemma4:e4b?)");
            // Still surface B's outcome as a partial pass.
            return ExitCode::FAILURE;
        }
    };
    println!("A result: {a_passes}/3\n");

    println!("=== SUMMARY ===");
    println!("A notepad continuation: {a_passes}/3");
    println!("B cursor @file tagging:  {b_passes}/10");
    if a_passes == 3 && b_passes == 10 {
        println!("ACCEPTANCE GATE: PASS");
        ExitCode::SUCCESS
    } else {
        println!("ACCEPTANCE GATE: FAIL");
        ExitCode::FAILURE
    }
}
