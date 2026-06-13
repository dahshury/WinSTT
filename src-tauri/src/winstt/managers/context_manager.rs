// Reference: frontend/electron/lib/context-reader.ts.
// Wraps winstt::context (pure deny-list + formatter + parser).
//
// ContextManager resolves the `winstt-context.exe` sidecar path and implements
// `ContextReader` by spawning it with the mode flag, bounded by a hard timeout
// (READ_TIMEOUT_MS) and an output cap (MAX_BUFFER_BYTES). Transport (B):
// std::process::Command (no extra plugin), with a watchdog thread that kills a
// wedged UIA walk. ALWAYS resolves to a snapshot — failure → empty_context().

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::winstt::context::{
    capture_prompt_fragment, empty_context, parse_snapshot, ContextMode, ContextReader,
    WindowContextSnapshot,
};
#[cfg(windows)]
use crate::winstt::context::{MAX_BUFFER_BYTES, READ_TIMEOUT_MS};
use crate::winstt::settings_schema::ContextAppMode;

pub struct ContextManager {
    app: AppHandle,
    /// Resolved sidecar path (packaged resource dir, then dev fallback). `None`
    /// when the binary couldn't be located — `read()` then returns empty.
    sidecar_path: Option<PathBuf>,
}

impl ContextManager {
    pub fn new(app: &AppHandle) -> Self {
        let sidecar_path = resolve_sidecar_path(app);
        if sidecar_path.is_none() && cfg!(windows) {
            log::warn!("winstt-context sidecar not found; context capture disabled");
        }
        Self {
            app: app.clone(),
            sidecar_path,
        }
    }

    pub fn is_available(&self) -> bool {
        self.sidecar_path.is_some()
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    /// Read → deny-list → format, the full capture-to-prompt path the dictation
    /// pipeline calls. Returns "" when nothing usable was captured.
    pub fn capture_fragment(
        &self,
        mode: ContextMode,
        app_mode: ContextAppMode,
        deny_list: &[String],
        allow_list: &[String],
    ) -> String {
        capture_prompt_fragment(self, mode, app_mode, deny_list, allow_list)
    }

    /// Read a specific top-level window by HWND. This is for debug/harness flows
    /// that need to capture an occluded browser window without stealing OS focus.
    /// Normal dictation still uses `ContextReader::read` against the foreground.
    pub fn read_hwnd(&self, mode: ContextMode, hwnd: u64) -> WindowContextSnapshot {
        let Some(bin) = self.sidecar_path.as_ref() else {
            return empty_context();
        };
        match run_sidecar(bin, mode, Some(hwnd)) {
            Some(raw) => parse_snapshot(&raw),
            None => empty_context(),
        }
    }
}

impl ContextReader for ContextManager {
    fn read(&self, mode: ContextMode) -> WindowContextSnapshot {
        let Some(bin) = self.sidecar_path.as_ref() else {
            return empty_context();
        };
        match run_sidecar(bin, mode, None) {
            Some(raw) => parse_snapshot(&raw),
            None => empty_context(),
        }
    }
}

/// Resolve the sidecar exe. Packaged: `<resource>/binaries/winstt-context.exe`.
/// Dev fallback: the binary staged under `src-tauri/binaries/`.
fn resolve_sidecar_path(app: &AppHandle) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "winstt-context.exe"
    } else {
        "winstt-context"
    };
    // 1. Tauri resource dir (where externalBin lands at build time).
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join("binaries").join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    // 2. Next to the executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("binaries").join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    // 3. Dev fallbacks. Prefer `src-tauri/binaries/` when present, otherwise
    //    reuse the reference Electron sidecar from this monorepo.
    #[cfg(windows)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let candidates = [
            PathBuf::from("binaries").join(name),
            manifest_dir.join("binaries").join(name),
            manifest_dir
                .join("..")
                .join("examples")
                .join("winstt-electron")
                .join("frontend")
                .join("electron")
                .join("native")
                .join("bin")
                .join(name),
        ];

        for candidate in candidates {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Spawn the sidecar with the mode flag, bounded by READ_TIMEOUT_MS + the byte
/// cap. Returns the stdout text, or None on any failure (the inner watchdog
/// kills a wedged UIA walk). Non-Windows always yields None (no UIA).
// The UIA sidecar is Windows-only; on other platforms this helper has no caller
// (context capture yields None there), so suppress the dead-code lint rather
// than cfg-gating it away.
#[cfg_attr(not(windows), allow(dead_code))]
fn sidecar_args(mode: ContextMode, hwnd: Option<u64>) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(flag) = mode.flag() {
        args.push(flag.to_string());
    }
    if let Some(hwnd) = hwnd.filter(|hwnd| *hwnd > 0) {
        args.push("--hwnd".to_string());
        args.push(hwnd.to_string());
    }
    args
}

#[cfg(windows)]
fn run_sidecar(bin: &std::path::Path, mode: ContextMode, hwnd: Option<u64>) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    // CREATE_NO_WINDOW — don't flash a console on the dictation hot-path.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    use std::os::windows::process::CommandExt;

    let mut cmd = Command::new(bin);
    for arg in sidecar_args(mode, hwnd) {
        cmd.arg(arg);
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;

    // Drain stdout (bounded) on a worker; the parent enforces the timeout.
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut buf = Vec::with_capacity(8192);
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() >= MAX_BUFFER_BYTES {
                        buf.truncate(MAX_BUFFER_BYTES);
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });

    let out = match rx.recv_timeout(Duration::from_millis(READ_TIMEOUT_MS)) {
        Ok(s) => Some(s),
        Err(_) => {
            // Wedged — kill the child so it doesn't leak a hung UIA walk.
            let _ = child.kill();
            None
        }
    };
    let status = child.wait().ok();
    if status.map(|s| s.success()).unwrap_or(false) {
        out
    } else {
        None
    }
}

#[cfg(not(windows))]
fn run_sidecar(_bin: &std::path::Path, _mode: ContextMode, _hwnd: Option<u64>) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_args_keep_foreground_default() {
        assert_eq!(
            sidecar_args(ContextMode::Focused, None),
            Vec::<String>::new()
        );
        assert_eq!(sidecar_args(ContextMode::Tree, None), vec!["--tree"]);
    }

    #[test]
    fn sidecar_args_append_hwnd_scope_after_mode() {
        assert_eq!(
            sidecar_args(ContextMode::Tree, Some(264342)),
            vec!["--tree", "--hwnd", "264342"]
        );
        assert_eq!(
            sidecar_args(ContextMode::Focused, Some(264342)),
            vec!["--hwnd", "264342"]
        );
    }

    #[test]
    fn sidecar_args_ignore_zero_hwnd() {
        assert_eq!(sidecar_args(ContextMode::Split, Some(0)), vec!["--split"]);
    }
}
