//! context_ab_request — byte-faithful `/api/chat` request emitter for the R2
//! A/B evaluation. NOT a shipped bin; a dev tool used only by the evaluation.
//!
//! Reads a JSONL file where each line is
//!   {"fixture": <name>, "kind": <surface>, "transcript": <dictation>,
//!    "context_legacy": <ctx json string>, "context_generic": <ctx json string>}
//! and, for each line, builds the EXACT Ollama `/api/chat` body the app would
//! send for BOTH context arms, using the real production request builders
//! (`build_dictation_system_prompt_for_model`, `dictation_user_prompt_for_presets`,
//! `build_ollama_chat_body_with_keep_alive`, `add_ollama_side_effect_schema_instruction`).
//! It flips `stream` to false so the evaluator can call /api/chat once per arm.
//!
//! The ONLY thing that differs between the two emitted bodies for a fixture is
//! the injected context JSON — every other byte (system frame, user prompt,
//! grounding, schema, options, think flag) is identical, which is precisely the
//! variable the A/B gate isolates.
//!
//! Usage: cargo run --example context_ab_request -- <requests.jsonl> <model>

use std::path::Path;
use std::process::ExitCode;

use winstt_app_lib::winstt::llm::{
    self, PresetEntry, PresetKey, ThinkingEffort, Vocab, build_dictation_system_prompt_for_model,
    build_ollama_chat_body_with_keep_alive, dictation_user_prompt_for_presets,
};

/// The default dictation presets: a single Neutral (Polish base) preset — the
/// app's out-of-the-box configuration when the user has selected no modifier.
fn neutral_presets() -> Vec<PresetEntry> {
    vec![PresetEntry::Builtin {
        key: PresetKey::Neutral,
        level: None,
        target_lang: None,
    }]
}

/// Build the exact chat body for one arm. `supports_thinking`/`effort` mirror
/// gemma-family full-tier defaults (thinking-capable, effort=Medium → boolean
/// think=true); `dictionary_auto_add_enabled=true` is the default, appending the
/// side-effect schema instruction to the system prompt exactly as the app does.
fn build_arm(model: &str, transcript: &str, context: &str) -> serde_json::Value {
    let presets = neutral_presets();
    let vocab = Vocab::default();
    let system_prompt =
        build_dictation_system_prompt_for_model(&presets, context, &vocab, Some(model));
    let user_prompt = dictation_user_prompt_for_presets(&presets, transcript);
    let mut body = build_ollama_chat_body_with_keep_alive(
        model,
        &system_prompt,
        &user_prompt,
        transcript.len(),
        true, // gemma-family supports thinking
        ThinkingEffort::Medium,
        serde_json::json!("5m"),
    );
    // The app appends the six-field side-effect schema instruction to the system
    // message (default dictionary_auto_add_enabled = true).
    llm::add_ollama_side_effect_schema_instruction(&mut body, true);
    // Evaluate with a single non-streaming call.
    if let Some(obj) = body.as_object_mut() {
        obj.insert("stream".to_string(), serde_json::Value::Bool(false));
    }
    body
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(path), Some(model)) = (args.first(), args.get(1)) else {
        eprintln!("usage: cargo run --example context_ab_request -- <requests.jsonl> <model>");
        return ExitCode::FAILURE;
    };
    let raw = match std::fs::read_to_string(Path::new(path)) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("error reading {path}: {e}");
            return ExitCode::FAILURE;
        }
    };
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let rec: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("skip bad line: {e}");
                continue;
            }
        };
        let fixture = rec["fixture"].as_str().unwrap_or("?");
        let kind = rec["kind"].as_str().unwrap_or("?");
        let transcript = rec["transcript"].as_str().unwrap_or("");
        let ctx_legacy = rec["context_legacy"].as_str().unwrap_or("");
        let ctx_generic = rec["context_generic"].as_str().unwrap_or("");
        let out = serde_json::json!({
            "fixture": fixture,
            "kind": kind,
            "transcript": transcript,
            "body_legacy": build_arm(model, transcript, ctx_legacy),
            "body_generic": build_arm(model, transcript, ctx_generic),
        });
        println!("{out}");
    }
    ExitCode::SUCCESS
}
