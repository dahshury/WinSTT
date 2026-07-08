//! caret_join_cli — tiny wrapper around the production `join_for_insertion`
//! deterministic caret-join post-pass, for the context-pipeline E2E harness.
//!
//! Reads a single-line JSON object from stdin:
//!   {"output": "<llm text>", "before": "<beforeCaret|null>",
//!    "after": "<afterCaret|null>", "terms": ["Proper","Nouns"],
//!    "is_ide": <bool, optional, default false>}
//! Prints the joined insertion string (the exact bytes production would paste)
//! to stdout, no trailing newline. When `is_ide` is true the production
//! `apply_ide_file_tags` @-mention pass runs AFTER the caret join, mirroring the
//! insertion pipeline order for an IDE surface.

use std::io::Read;

use winstt_app_lib::winstt::context::{apply_ide_file_tags, join_for_insertion};

fn main() {
    let mut raw = String::new();
    std::io::stdin()
        .read_to_string(&mut raw)
        .expect("read stdin");
    let v: serde_json::Value = serde_json::from_str(raw.trim()).expect("parse json");

    let output = v.get("output").and_then(|x| x.as_str()).unwrap_or("");
    let before = v.get("before").and_then(|x| x.as_str());
    let after = v.get("after").and_then(|x| x.as_str());
    let terms: Vec<String> = v
        .get("terms")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| t.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let is_ide = v.get("is_ide").and_then(|x| x.as_bool()).unwrap_or(false);

    let joined = join_for_insertion(output, before, after, &terms);
    let final_text = apply_ide_file_tags(&joined, is_ide, &terms);
    print!("{final_text}");
    use std::io::Write;
    let _ = std::io::stdout().flush();
}
