// Ollama executable detection + spawn (mirrors detectOllama / startOllama) plus
// the pull-name validation + progress emit helpers. Split out of the `llm`
// command root; `detect_ollama_executable` / `spawn_ollama_serve` are re-exported
// there to keep the `winstt::commands::llm::*` paths the manager calls.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Emitter};

use super::payloads::OllamaDetectResultPayload;
use crate::command_auth;

const OLLAMA_MODEL_MANAGEMENT_ALLOWED_WINDOWS: &[&str] =
    &["settings", "model-picker", "onboarding"];

/// PID of the `ollama serve` process WinSTT auto-started this session, or `0`
/// when WinSTT did NOT start Ollama (the user's own server / Ollama desktop app
/// is running). Recorded so a graceful exit can stop ONLY a server WinSTT
/// launched — we never kill a server the user owns. See `stop_winstt_spawned_ollama`.
static WINSTT_SPAWNED_OLLAMA_PID: AtomicU32 = AtomicU32::new(0);

// ── Ollama executable detection + spawn (mirrors detectOllama / startOllama) ──

pub(crate) async fn detect_ollama_executable() -> OllamaDetectResultPayload {
    // Detection touches the filesystem; do it on the blocking pool so the async
    // runtime is not stalled.
    tokio::task::spawn_blocking(detect_ollama_executable_blocking)
        .await
        .unwrap_or(OllamaDetectResultPayload {
            installed: false,
            path: None,
        })
}

fn detect_ollama_executable_blocking() -> OllamaDetectResultPayload {
    detect_ollama_from_candidates(ollama_default_paths(), ollama_path_candidates()).map_or(
        OllamaDetectResultPayload {
            installed: false,
            path: None,
        },
        |path| OllamaDetectResultPayload {
            installed: true,
            path: Some(path_to_payload_string(&path)),
        },
    )
}

fn detect_ollama_from_candidates(
    default_paths: impl IntoIterator<Item = PathBuf>,
    path_candidates: impl IntoIterator<Item = PathBuf>,
) -> Option<PathBuf> {
    default_paths
        .into_iter()
        .chain(path_candidates)
        .find(|candidate| validate_ollama_executable_path(candidate).is_ok())
}

fn ollama_default_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();

    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            out.push(
                PathBuf::from(local)
                    .join("Programs")
                    .join("Ollama")
                    .join("ollama.exe"),
            );
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            out.push(PathBuf::from(pf).join("Ollama").join("ollama.exe"));
        }
        if let Ok(pf) = std::env::var("ProgramW6432") {
            out.push(PathBuf::from(pf).join("Ollama").join("ollama.exe"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        out.push(
            PathBuf::from("/Applications")
                .join("Ollama.app")
                .join("Contents")
                .join("Resources")
                .join("ollama"),
        );
        out.push(PathBuf::from("/opt/homebrew/bin/ollama"));
        out.push(PathBuf::from("/usr/local/bin/ollama"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        out.push(PathBuf::from("/usr/local/bin/ollama"));
        out.push(PathBuf::from("/usr/bin/ollama"));
    }

    out
}

fn ollama_path_candidates() -> Vec<PathBuf> {
    let Some(path) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for dir in std::env::split_paths(&path).filter(|dir| dir.is_absolute()) {
        for file_name in ollama_path_executable_names() {
            out.push(dir.join(file_name));
        }
    }
    out
}

#[cfg(windows)]
fn ollama_path_executable_names() -> &'static [&'static str] {
    &["ollama.exe"]
}

#[cfg(not(windows))]
fn ollama_path_executable_names() -> &'static [&'static str] {
    &["ollama"]
}

fn validate_ollama_executable_path(candidate: &Path) -> Result<(), String> {
    if candidate.as_os_str().is_empty() {
        return Err("Ollama executable path is empty".to_string());
    }
    if !candidate.is_absolute() {
        return Err("Ollama executable path must be absolute".to_string());
    }
    if !has_expected_ollama_file_name(candidate) {
        return Err("Ollama executable path must point to the Ollama binary".to_string());
    }
    let metadata = std::fs::metadata(candidate)
        .map_err(|e| format!("Ollama executable path is not accessible: {e}"))?;
    if !metadata.is_file() {
        return Err("Ollama executable path is not a file".to_string());
    }
    if !has_execute_permission(&metadata) {
        return Err("Ollama executable path is not executable".to_string());
    }
    Ok(())
}

fn has_expected_ollama_file_name(candidate: &Path) -> bool {
    let Some(file_name) = candidate.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    #[cfg(windows)]
    {
        file_name.eq_ignore_ascii_case("ollama.exe")
    }
    #[cfg(not(windows))]
    {
        file_name == "ollama"
    }
}

#[cfg(windows)]
fn has_execute_permission(metadata: &std::fs::Metadata) -> bool {
    metadata.is_file()
}

#[cfg(unix)]
fn has_execute_permission(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

fn path_to_payload_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn resolve_ollama_spawn_path(exec_path: &str) -> Result<PathBuf, String> {
    if exec_path.trim() != exec_path || exec_path.is_empty() {
        return Err("Invalid Ollama executable path".to_string());
    }
    if exec_path.contains('\0') {
        return Err("Invalid Ollama executable path".to_string());
    }
    let path = PathBuf::from(exec_path);
    validate_ollama_executable_path(&path)?;
    Ok(path)
}

pub(crate) fn spawn_ollama_serve(exec_path: &str) -> Result<(), String> {
    let exec_path = resolve_ollama_spawn_path(exec_path)
        .map_err(|e| format!("Refusing to start Ollama: {e}"))?;
    let mut cmd = std::process::Command::new(exec_path);
    cmd.arg("serve");
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW ONLY — and deliberately NOT DETACHED_PROCESS. WinSTT is
        // a GUI-subsystem process with no console, so CREATE_NO_WINDOW gives the
        // spawned `ollama serve` a fresh HIDDEN console; the model-runner
        // subprocesses Ollama then spawns inherit that windowless console and stay
        // hidden too. DETACHED_PROCESS gives the serve NO console at all, so each
        // runner allocated its own NEW console WINDOW — the terminals that flashed
        // on every model load/unload (warmup, toggle, boot-with-toggle-on). Survival
        // across our exit isn't needed: `stop_winstt_spawned_ollama` kills this tree
        // on graceful exit, and a child outlives the parent on Windows regardless.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map(|child| {
            // Detached: we intentionally don't retain/await the child, but record
            // its PID so a graceful exit can stop the tree WE started (and only it).
            let pid = child.id();
            WINSTT_SPAWNED_OLLAMA_PID.store(pid, Ordering::Release);
            crate::winstt::model_watchdog::track_spawned_ollama_pid(pid);
        })
        .map_err(|e| format!("Failed to start Ollama: {e}"))
}

/// Stop the `ollama serve` process tree WinSTT auto-started this session. No-op
/// when WinSTT did not start Ollama (the user owns it) — WinSTT never kills a
/// server it did not launch. Best-effort and bounded; the model is unloaded
/// separately (keep_alive:0) so VRAM is already freed before this runs. Called
/// on graceful app exit.
pub(crate) fn stop_winstt_spawned_ollama() {
    let pid = WINSTT_SPAWNED_OLLAMA_PID.swap(0, Ordering::AcqRel);
    crate::winstt::model_watchdog::clear_spawned_ollama_pid();
    if pid == 0 {
        return;
    }
    log::info!("[llm] stopping WinSTT-spawned Ollama server (pid {pid}) on exit");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // /T kills the whole tree (`ollama serve` -> the `llama-server` child that
        // holds the model in VRAM); /F forces it. Ignore failure: the process may
        // already be gone, or the user may have closed Ollama out from under us.
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        // SIGTERM lets `ollama serve` shut its model runners down cleanly.
        let _ = std::process::Command::new("kill")
            .arg(pid.to_string())
            .status();
    }
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

#[cfg(test)]
pub(crate) fn is_ollama_model_management_allowed(caller: &str) -> bool {
    command_auth::label_in(caller, OLLAMA_MODEL_MANAGEMENT_ALLOWED_WINDOWS)
}

pub(crate) fn authorize_ollama_model_management_label(
    caller: &str,
    action: &str,
) -> Result<(), String> {
    command_auth::authorize_label(
        caller,
        "llm",
        action,
        OLLAMA_MODEL_MANAGEMENT_ALLOWED_WINDOWS,
        " through Ollama model management",
    )
}

/// Broadcast an `llm:pull-progress` event to all renderers (the plain channel the
/// reused `onOllamaPullProgress` listener parses).
pub(super) fn emit_pull_progress(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit("llm:pull-progress", payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ollama_file_name() -> &'static str {
        #[cfg(windows)]
        {
            "ollama.exe"
        }
        #[cfg(not(windows))]
        {
            "ollama"
        }
    }

    fn write_test_binary(path: &Path) {
        std::fs::create_dir_all(path.parent().expect("binary parent")).expect("parent dir");
        std::fs::write(path, b"test binary").expect("write binary");
        mark_executable(path);
    }

    #[cfg(windows)]
    fn mark_executable(_path: &Path) {}

    #[cfg(unix)]
    fn mark_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = std::fs::metadata(path).expect("metadata").permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).expect("set executable");
    }

    #[test]
    fn detect_prefers_default_install_path_over_path_candidate() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let default_candidate = tmp.path().join("known").join(ollama_file_name());
        let path_candidate = tmp.path().join("path").join(ollama_file_name());
        write_test_binary(&default_candidate);
        write_test_binary(&path_candidate);

        let detected = detect_ollama_from_candidates([default_candidate.clone()], [path_candidate])
            .expect("detected");

        assert_eq!(detected, default_candidate);
    }

    #[test]
    fn detect_uses_path_candidate_when_default_install_path_is_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing_default = tmp.path().join("missing").join(ollama_file_name());
        let path_candidate = tmp.path().join("path").join(ollama_file_name());
        write_test_binary(&path_candidate);

        let detected = detect_ollama_from_candidates([missing_default], [path_candidate.clone()])
            .expect("detected");

        assert_eq!(detected, path_candidate);
    }

    #[test]
    fn detect_rejects_directory_candidates() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let directory_candidate = tmp.path().join("path").join(ollama_file_name());
        std::fs::create_dir_all(&directory_candidate).expect("candidate dir");

        let detected = detect_ollama_from_candidates(Vec::<PathBuf>::new(), [directory_candidate]);

        assert!(detected.is_none());
    }

    #[test]
    fn spawn_validation_rejects_relative_path_lookup_input() {
        let result = resolve_ollama_spawn_path(ollama_file_name());

        assert!(result.is_err());
    }

    #[test]
    fn spawn_validation_rejects_wrong_binary_name() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let wrong_name = if cfg!(windows) {
            "ollama.cmd"
        } else {
            "ollama.exe"
        };
        let candidate = tmp.path().join(wrong_name);
        write_test_binary(&candidate);

        let result = resolve_ollama_spawn_path(&path_to_payload_string(&candidate));

        assert!(result.is_err());
    }

    #[test]
    fn spawn_validation_accepts_absolute_ollama_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let candidate = tmp.path().join("install").join(ollama_file_name());
        write_test_binary(&candidate);

        let resolved =
            resolve_ollama_spawn_path(&path_to_payload_string(&candidate)).expect("valid path");

        assert_eq!(resolved, candidate);
    }

    #[test]
    fn ollama_model_management_authorization_matches_renderer_flows() {
        command_auth::assert_label_rules(
            &["settings", "model-picker", "onboarding"],
            &[
                "main",
                "overlay",
                "tray-menu",
                "device-picker",
                "history",
                "context-playground",
            ],
            is_ollama_model_management_allowed,
        );
    }
}
