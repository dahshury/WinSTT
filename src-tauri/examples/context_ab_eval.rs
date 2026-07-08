//! context_ab_eval — fixture-dump harness for the context formatter (report R2).
//!
//! The A/B evaluation (Legacy app-specific reconstruction vs. Generic role-pruned
//! path) has concluded: generic held within tolerance, so the legacy per-app
//! understanding layer was deleted and production runs the single generic path.
//! This tool now simply emits that path's fragment for each snapshot, kept as a
//! regression / inspection utility (feed a fixture or a live capture, eyeball the
//! prompt the LLM would see).
//!
//! This is a cargo EXAMPLE (dev tool), not a bundled bin — src-tauri/src/bin is
//! reserved for the shipped context sidecar (enforced by tests/bundle_hygiene).
//! Run it with `cargo run --example context_ab_eval`.
//!
//! Two modes:
//!
//!   cargo run --example context_ab_eval
//!       Emit one JSONL line per embedded fixture (the corpus in
//!       `winstt::context::fixtures`):
//!         {"fixture": <name>, "kind": <surface>, "generic": <json string>}
//!
//!   cargo run --example context_ab_eval -- --snapshot <path-to-raw-sidecar-json>
//!       Parse a LIVE capture file (the single-line JSON a
//!       `winstt-context.exe --tree/--split` run prints) and emit ONE JSONL line
//!       for it (fixture = the file stem, kind = "snapshot").
//!
//! The "generic" value is the formatter's own JSON fragment carried as a STRING
//! (so the outer line stays one flat JSONL record); an empty fragment ("no
//! context") is carried as an empty string.

use std::path::Path;
use std::process::ExitCode;

use winstt_app_lib::winstt::context::{
    WindowContextSnapshot, fixtures, format_context_for_prompt, parse_snapshot,
};

/// Emit one JSONL line. Uses serde_json to escape every field so the fragment
/// string (which contains quotes/newlines) is carried safely.
fn emit_line(fixture: &str, kind: &str, snapshot: &WindowContextSnapshot) {
    let generic = format_context_for_prompt(snapshot);
    let line = serde_json::json!({
        "fixture": fixture,
        "kind": kind,
        "generic": generic,
    });
    println!("{line}");
}

/// Run the formatter on a single live sidecar capture file and emit its line.
/// Returns an error string on read/parse failure so the caller can report it.
fn run_snapshot_file(path: &str) -> Result<(), String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    // parse_snapshot never panics — a malformed/partial capture yields the empty
    // snapshot, whose formatted fragment is "". Still surface an explicit note so
    // an all-empty line is not read as a silent success.
    let snapshot = parse_snapshot(&raw);
    if snapshot == WindowContextSnapshot::default() && !raw.trim().is_empty() {
        eprintln!(
            "warning: {path} parsed to the empty snapshot (not valid sidecar JSON, or nothing captured)"
        );
    }
    let name = Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("snapshot");
    emit_line(name, "snapshot", &snapshot);
    Ok(())
}

fn print_usage() {
    eprintln!(
        "usage: cargo run --example context_ab_eval [-- --snapshot <path-to-raw-sidecar-json>]\n\
         \n\
         With no args: emit one JSONL line per embedded fixture.\n\
         With --snapshot <path>: run the generic formatter on a live capture file."
    );
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    match args.split_first() {
        None => {
            // Default: the embedded fixture corpus.
            for fixture in fixtures::all_fixtures() {
                emit_line(fixture.name, fixture.kind, &fixture.snapshot);
            }
            ExitCode::SUCCESS
        }
        Some((flag, rest)) if flag == "--snapshot" => {
            let Some(path) = rest.first() else {
                eprintln!("error: --snapshot requires a path argument");
                print_usage();
                return ExitCode::FAILURE;
            };
            match run_snapshot_file(path) {
                Ok(()) => ExitCode::SUCCESS,
                Err(err) => {
                    eprintln!("error: {err}");
                    ExitCode::FAILURE
                }
            }
        }
        Some((flag, _)) if flag == "-h" || flag == "--help" => {
            print_usage();
            ExitCode::SUCCESS
        }
        Some((flag, _)) => {
            eprintln!("error: unknown argument {flag:?}");
            print_usage();
            ExitCode::FAILURE
        }
    }
}
