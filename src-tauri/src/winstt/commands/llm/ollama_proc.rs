// Ollama executable detection + spawn (mirrors detectOllama / startOllama) plus
// the pull-name validation + progress emit helpers. Split out of the `llm`
// command root; `detect_ollama_executable` / `spawn_ollama_serve` are re-exported
// there to keep the `winstt::commands::llm::*` paths the manager calls.

use tauri::{AppHandle, Emitter};

use super::payloads::OllamaDetectResultPayload;

// ── Ollama executable detection + spawn (mirrors detectOllama / startOllama) ──

pub(crate) async fn detect_ollama_executable() -> OllamaDetectResultPayload {
    // Detection shells out + touches the filesystem; do it on the blocking pool
    // so the async runtime isn't stalled (and we avoid relying on tokio's
    // optional `process`/`fs` features — `std` is always available).
    tokio::task::spawn_blocking(detect_ollama_executable_blocking)
        .await
        .unwrap_or(OllamaDetectResultPayload {
            installed: false,
            path: None,
        })
}

fn detect_ollama_executable_blocking() -> OllamaDetectResultPayload {
    // 1. PATH lookup (`where` on Windows, `which` elsewhere).
    let lookup = if cfg!(windows) { "where" } else { "which" };
    let mut cmd = std::process::Command::new(lookup);
    cmd.arg("ollama");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = stdout.lines().map(str::trim).find(|l| !l.is_empty()) {
                return OllamaDetectResultPayload {
                    installed: true,
                    path: Some(line.to_string()),
                };
            }
        }
    }
    // 2. Default install locations (Windows).
    for candidate in ollama_default_paths() {
        if std::fs::metadata(&candidate).is_ok() {
            return OllamaDetectResultPayload {
                installed: true,
                path: Some(candidate),
            };
        }
    }
    OllamaDetectResultPayload {
        installed: false,
        path: None,
    }
}

fn ollama_default_paths() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out.push(format!("{local}\\Programs\\Ollama\\ollama.exe"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        out.push(format!("{pf}\\Ollama\\ollama.exe"));
    }
    out
}

pub(crate) fn spawn_ollama_serve(exec_path: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new(exec_path);
    cmd.arg("serve");
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | DETACHED_PROCESS so the serve survives + stays hidden.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.spawn()
        .map(|_child| ())
        .map_err(|e| format!("Failed to start Ollama: {e}"))
}

/// Mirror of `VALID_PULL_NAME_RE` in llm.ts.
pub(super) fn validate_model_name(model: &str) -> Result<(), String> {
    if model.is_empty() {
        return Err("Model name is required".to_string());
    }
    let valid = model
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-'));
    if valid {
        Ok(())
    } else {
        Err("Model name contains invalid characters".to_string())
    }
}

/// Broadcast an `llm:pull-progress` event to all renderers (the plain channel the
/// reused `onOllamaPullProgress` listener parses).
pub(super) fn emit_pull_progress(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit("llm:pull-progress", payload);
}
