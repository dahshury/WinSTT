// Wraps winstt::context (pure deny-list + formatter + parser).
//
// ContextManager resolves the `winstt-context.exe` sidecar and implements
// `ContextReader`. Transport (report R5a): a SINGLE PERSISTENT sidecar in
// `--serve` mode is kept warm across captures — COM/UIA are initialized once in
// the child, and each capture writes one JSON request line and reads back the
// matching response line, bounded by a hard timeout (SERVE_TIMEOUT_MS) and the
// output cap (MAX_BUFFER_BYTES). Killing cold-spawn latency lets the outer
// timeout drop well below the old 1200 ms spawn budget. On timeout or a dead
// child the child is killed, respawned, and the capture retried ONCE; a second
// failure gives up for that capture. The child is killed on drop (clean app
// exit). ALWAYS resolves to a snapshot — failure → empty_context().

use std::path::PathBuf;
#[cfg(windows)]
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::winstt::context::MAX_BUFFER_BYTES;
// Outer timeout for the one-shot non-Windows capture (macOS AX / Linux AT-SPI).
#[cfg(not(windows))]
use crate::winstt::context::READ_TIMEOUT_MS;
use crate::winstt::context::parse_snapshot;
use crate::winstt::context::{
    ContextMode, ContextReader, WindowContextSnapshot, apply_context_app_policy,
    capture_prompt_fragment, empty_context, format_context_for_prompt,
};
use crate::winstt::settings_schema::ContextAppMode;

/// Outer timeout for one persistent-sidecar request. With no cold spawn on the
/// hot path this can sit well under the old 1200 ms `READ_TIMEOUT_MS`; the
/// child's own 750 ms per-request watchdog is the inner fence. Kept as a named
/// const so it stays easy to tune.
#[cfg(windows)]
const SERVE_TIMEOUT_MS: u64 = 900;

pub struct ContextManager {
    app: AppHandle,
    /// Resolved sidecar path (packaged resource dir, then dev fallback). `None`
    /// when the binary couldn't be located — `read()` then returns empty.
    sidecar_path: Option<PathBuf>,
    /// The warm `--serve` child, lazily spawned on first capture and reused
    /// across captures. Behind a `Mutex` because `ContextReader::read` takes
    /// `&self` while the request/response exchange mutates the child's pipes.
    #[cfg(windows)]
    serve: Mutex<Option<serve::ServeChild>>,
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
            #[cfg(windows)]
            serve: Mutex::new(None),
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

    /// Same read → deny-list → format path as [`Self::capture_fragment`], but
    /// scoped to a specific top-level window (`hwnd`) via the sidecar's `--hwnd`
    /// flag instead of the current foreground. The dictation pipeline pins the
    /// foreground HWND at recording start and passes it here so the post-decode
    /// context capture reads the window the user dictated INTO, not whatever they
    /// alt-tabbed to during transcription (report R5b). `hwnd == 0` falls back to
    /// the foreground, so callers that mean "no window is valid, skip capture"
    /// must not call this — they return "" themselves.
    pub fn capture_fragment_for_hwnd(
        &self,
        mode: ContextMode,
        app_mode: ContextAppMode,
        deny_list: &[String],
        allow_list: &[String],
        hwnd: u64,
        ocr: bool,
    ) -> String {
        let raw = self.read_hwnd_with_ocr(mode, hwnd, ocr);
        let resolved = apply_context_app_policy(&raw, app_mode, deny_list, allow_list);
        format_context_for_prompt(&resolved)
    }

    /// Read a specific top-level window by HWND. This is for debug/harness flows
    /// that need to capture an occluded browser window without stealing OS focus.
    /// Normal dictation still uses `ContextReader::read` against the foreground.
    /// OCR is off here — the debug/biasing callers that want the Tier-2 fallback
    /// use [`Self::read_hwnd_with_ocr`].
    pub fn read_hwnd(&self, mode: ContextMode, hwnd: u64) -> WindowContextSnapshot {
        self.capture(mode, Some(hwnd), false)
    }

    /// Same as [`Self::read_hwnd`] but threads the Tier-2 OCR opt-in (report R3)
    /// into the sidecar request. The sidecar only OCRs when this is `true` AND
    /// UIA yielded no usable text AND the field isn't a password.
    pub fn read_hwnd_with_ocr(
        &self,
        mode: ContextMode,
        hwnd: u64,
        ocr: bool,
    ) -> WindowContextSnapshot {
        self.capture(mode, Some(hwnd), ocr)
    }

    /// The single capture entry point: run one request through the warm serve
    /// sidecar. Always resolves — a missing binary or a persistent failure
    /// (after one respawn+retry) yields `empty_context`.
    fn capture(&self, mode: ContextMode, hwnd: Option<u64>, ocr: bool) -> WindowContextSnapshot {
        let Some(bin) = self.sidecar_path.as_ref() else {
            return empty_context();
        };
        #[cfg(windows)]
        {
            match self.serve_request(bin, mode, hwnd, ocr) {
                Some(raw) => parse_snapshot(&raw),
                None => empty_context(),
            }
        }
        #[cfg(not(windows))]
        {
            // AX-API (macOS) / AT-SPI (Linux) capture. The sidecar is invoked
            // one-shot per request (no warm serve loop off Windows); the reader
            // emits the SAME JSON snapshot shape the parser consumes. `hwnd` has no
            // cross-platform analog and `ocr` (Windows.Media.Ocr) is Windows-only.
            let _ = (hwnd, ocr);
            match oneshot::request(bin, mode, READ_TIMEOUT_MS, MAX_BUFFER_BYTES) {
                Some(raw) => parse_snapshot(&raw),
                None => empty_context(),
            }
        }
    }

    /// Run one request against the persistent serve child, spawning it if needed
    /// and respawning+retrying ONCE on timeout or a dead child. Returns the raw
    /// response body (id-stripped) or `None` after a second failure.
    #[cfg(windows)]
    fn serve_request(
        &self,
        bin: &std::path::Path,
        mode: ContextMode,
        hwnd: Option<u64>,
        ocr: bool,
    ) -> Option<String> {
        let mut guard = self.serve.lock().unwrap_or_else(|e| e.into_inner());
        for attempt in 0..2 {
            // Ensure a live child; a respawn on the retry pass gets a fresh warm
            // COM/UIA state (the previous one may have exited on its watchdog).
            if guard.is_none() {
                *guard = serve::ServeChild::spawn(bin);
            }
            let Some(child) = guard.as_mut() else {
                // Spawn failed outright — nothing to retry against.
                return None;
            };
            match child.request(mode, hwnd, ocr, SERVE_TIMEOUT_MS, MAX_BUFFER_BYTES) {
                Ok(body) => return Some(body),
                Err(_) => {
                    // Timeout / dead child / protocol error: drop (kills) this
                    // child so the next loop pass respawns a clean one.
                    *guard = None;
                    let _ = attempt;
                }
            }
        }
        None
    }
}

impl ContextReader for ContextManager {
    fn read(&self, mode: ContextMode) -> WindowContextSnapshot {
        // Foreground reads (playground/debug) never use the OCR fallback; the
        // dictation + biasing paths that want it call `read_hwnd_with_ocr`.
        self.capture(mode, None, false)
    }
}

/// Resolve the sidecar exe. Packaged: `<resource>/winstt_context.exe` (the Cargo
/// bin Tauri bundles next to the main executable).
/// Dev fallback: the binary staged under `src-tauri/binaries/`.
fn resolve_sidecar_path(app: &AppHandle) -> Option<PathBuf> {
    let staged_name = if cfg!(windows) {
        "winstt-context.exe"
    } else {
        "winstt-context"
    };
    let bundled_name = if cfg!(windows) {
        "winstt_context.exe"
    } else {
        "winstt_context"
    };
    // 1. Tauri resource dir. Prefer the Cargo bin bundled beside the app, then
    //    accept the legacy resources/binaries layout for existing dev artifacts.
    if let Ok(res) = app.path().resource_dir() {
        for candidate in [
            res.join(bundled_name),
            res.join("binaries").join(staged_name),
        ] {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    // 2. Next to the executable.
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        for candidate in [
            dir.join(bundled_name),
            dir.join("binaries").join(staged_name),
        ] {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    // 3. Dev fallback: prefer `src-tauri/binaries/` when present (all platforms —
    //    the non-`.exe` binary name is already resolved above, so `cargo run` dev
    //    builds locate the staged sidecar on macOS/Linux too).
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let candidates = [
            PathBuf::from("binaries").join(staged_name),
            manifest_dir.join("binaries").join(staged_name),
        ];

        for candidate in candidates {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The `"mode"` string for a serve request line (mirrors the child's
/// `Mode::parse_mode`). `Focused` is the default and serializes to `"focused"`.
// Only the Windows context sidecar consumes serve request lines; unused on other targets.
#[cfg_attr(not(windows), allow(dead_code))]
fn mode_str(mode: ContextMode) -> &'static str {
    match mode {
        ContextMode::Focused => "focused",
        ContextMode::Selection => "selection",
        ContextMode::Split => "split",
        ContextMode::Tree => "tree",
        ContextMode::Meta => "meta",
    }
}

/// Build one `--serve` request line: `{"id":N,"mode":"...","hwnd":H,"ocr":B}`
/// (hwnd omitted when `None` / `0`; `ocr` omitted when false, its default). No
/// JSON escaping is needed — every field is a number, a bool, or a fixed
/// lowercase ASCII token.
#[cfg_attr(not(windows), allow(dead_code))]
fn serve_request_line(id: u64, mode: ContextMode, hwnd: Option<u64>, ocr: bool) -> String {
    let ocr_field = if ocr { r#","ocr":true"# } else { "" };
    match hwnd.filter(|h| *h > 0) {
        Some(h) => format!(
            r#"{{"id":{id},"mode":"{}","hwnd":{h}{ocr_field}}}"#,
            mode_str(mode)
        ),
        None => format!(r#"{{"id":{id},"mode":"{}"{ocr_field}}}"#, mode_str(mode)),
    }
}

#[cfg(windows)]
mod serve {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
    use std::time::Duration;

    use crate::winstt::context::ContextMode;

    use super::serve_request_line;

    // CREATE_NO_WINDOW — don't flash a console on the dictation hot-path.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// A warm `--serve` child plus its request/response plumbing. A dedicated
    /// reader thread pushes each stdout line onto a channel so the request path
    /// can time out without blocking on a wedged read; the child is killed on
    /// drop for a clean shutdown.
    pub struct ServeChild {
        child: Child,
        stdin: ChildStdin,
        /// Lines from the child's stdout (one JSON response per line).
        rx: Receiver<String>,
        /// Monotonic request id; responses are correlated by echoed `id`.
        next_id: u64,
    }

    impl ServeChild {
        /// Spawn the sidecar in `--serve` mode and wire up the reader thread.
        /// Returns `None` if the process or its pipes couldn't be created.
        pub fn spawn(bin: &std::path::Path) -> Option<Self> {
            use std::os::windows::process::CommandExt;

            let mut child = Command::new(bin)
                .arg("--serve")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .ok()?;

            let stdin = child.stdin.take()?;
            let stdout = child.stdout.take()?;

            let (tx, rx) = mpsc::channel::<String>();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        // EOF: the child exited — the sender drops and the
                        // request path sees a disconnect.
                        Ok(0) => break,
                        Ok(_) => {
                            if tx.send(std::mem::take(&mut line)).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            });

            Some(Self {
                child,
                stdin,
                rx,
                next_id: 1,
            })
        }

        /// Send one request and await its matching response, bounded by
        /// `timeout_ms`. Returns the id-stripped JSON body (the parser's input),
        /// or `Err(())` on write failure, timeout, disconnect, or oversize
        /// response — in every error case the caller drops (kills) this child.
        pub fn request(
            &mut self,
            mode: ContextMode,
            hwnd: Option<u64>,
            ocr: bool,
            timeout_ms: u64,
            max_bytes: usize,
        ) -> Result<String, ()> {
            let id = self.next_id;
            self.next_id = self.next_id.wrapping_add(1).max(1);

            // Drain any stale lines left from a previous (timed-out) request so a
            // late arrival can't be mistaken for this request's response.
            while self.rx.try_recv().is_ok() {}

            let line = serve_request_line(id, mode, hwnd, ocr);
            if writeln!(self.stdin, "{line}").is_err() || self.stdin.flush().is_err() {
                return Err(());
            }

            // Await the response with the matching id within a single overall
            // deadline (not per-line), so a chatty child can't extend the budget.
            let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                let now = std::time::Instant::now();
                if now >= deadline {
                    return Err(());
                }
                match self.rx.recv_timeout(deadline - now) {
                    Ok(resp) => {
                        if resp.len() > max_bytes {
                            // Oversize — treat as a protocol failure; respawn.
                            return Err(());
                        }
                        match strip_matching_id(&resp, id) {
                            Some(body) => return Ok(body),
                            // A response for a different id (a stale line that
                            // slipped past the drain): keep waiting for ours.
                            None => continue,
                        }
                    }
                    Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                        return Err(());
                    }
                }
            }
        }
    }

    impl Drop for ServeChild {
        fn drop(&mut self) {
            // Best-effort clean shutdown: kill the child and reap it so no warm
            // sidecar lingers past the manager (or app exit).
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// If `resp` is a JSON object whose `"id"` equals `want`, return a copy with
    /// the leading `"id":N,` removed so the remaining body matches the one-shot
    /// snapshot shape that `parse_snapshot` consumes. `None` when the id differs
    /// or the line isn't a usable object.
    fn strip_matching_id(resp: &str, want: u64) -> Option<String> {
        let value: serde_json::Value = serde_json::from_str(resp.trim()).ok()?;
        let obj = value.as_object()?;
        let id = obj.get("id").and_then(serde_json::Value::as_u64)?;
        if id != want {
            return None;
        }
        // Rebuild the object without `id`. `parse_snapshot` ignores unknown keys
        // and reads by name, so key order is irrelevant to it; serde_json emits a
        // valid object either way. An `error` line round-trips here too, parsing
        // to an empty snapshot downstream (no known fields).
        let mut map = obj.clone();
        map.remove("id");
        Some(serde_json::Value::Object(map).to_string())
    }
}

/// One-shot sidecar transport for the non-Windows readers (macOS AX / Linux
/// AT-SPI). Unlike the Windows warm `--serve` child, each capture spawns the
/// sidecar with the mode flag, reads its single-line JSON stdout under a hard
/// timeout, and lets the child exit. The mac/linux readers are process-cheap and
/// dictation off Windows isn't the latency-critical hot path, so the simpler
/// spawn-per-capture avoids the Windows-specific `--serve` pipe plumbing.
#[cfg(not(windows))]
mod oneshot {
    use std::io::Read;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    use crate::winstt::context::ContextMode;

    /// Run the sidecar once in `mode` and return its raw single-line JSON stdout,
    /// bounded by `timeout_ms` (the child is killed on timeout) and `max_bytes`.
    /// Returns `None` on spawn failure, timeout, disconnect, or an empty/oversize
    /// response — the caller then yields `empty_context`.
    pub fn request(
        bin: &Path,
        mode: ContextMode,
        timeout_ms: u64,
        max_bytes: usize,
    ) -> Option<String> {
        let mut cmd = Command::new(bin);
        if let Some(flag) = mode.flag() {
            cmd.arg(flag);
        }
        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;

        // Read stdout on a helper thread so the timeout can fire even if the child
        // (a wedged AX / AT-SPI call) never closes the pipe.
        let mut stdout = child.stdout.take()?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });

        let out = match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
            Ok(buf) => buf,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        };
        let _ = child.wait();

        if out.is_empty() || out.len() > max_bytes {
            return None;
        }
        let text = String::from_utf8_lossy(&out).trim().to_string();
        if text.is_empty() { None } else { Some(text) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serve_request_line_defaults_to_foreground_without_hwnd() {
        assert_eq!(
            serve_request_line(1, ContextMode::Focused, None, false),
            r#"{"id":1,"mode":"focused"}"#
        );
        assert_eq!(
            serve_request_line(5, ContextMode::Tree, None, false),
            r#"{"id":5,"mode":"tree"}"#
        );
    }

    #[test]
    fn serve_request_line_includes_positive_hwnd() {
        assert_eq!(
            serve_request_line(2, ContextMode::Split, Some(264342), false),
            r#"{"id":2,"mode":"split","hwnd":264342}"#
        );
    }

    #[test]
    fn serve_request_line_ignores_zero_hwnd() {
        assert_eq!(
            serve_request_line(3, ContextMode::Selection, Some(0), false),
            r#"{"id":3,"mode":"selection"}"#
        );
    }

    #[test]
    fn serve_request_line_appends_ocr_flag_only_when_set() {
        // ocr=false ⇒ field omitted (the default, keeps the line minimal).
        assert_eq!(
            serve_request_line(4, ContextMode::Split, Some(99), false),
            r#"{"id":4,"mode":"split","hwnd":99}"#
        );
        // ocr=true with an hwnd ⇒ trailing "ocr":true after the hwnd.
        assert_eq!(
            serve_request_line(4, ContextMode::Split, Some(99), true),
            r#"{"id":4,"mode":"split","hwnd":99,"ocr":true}"#
        );
        // ocr=true without an hwnd ⇒ "ocr":true after the mode.
        assert_eq!(
            serve_request_line(7, ContextMode::Focused, None, true),
            r#"{"id":7,"mode":"focused","ocr":true}"#
        );
    }

    #[test]
    fn mode_str_covers_every_mode() {
        assert_eq!(mode_str(ContextMode::Focused), "focused");
        assert_eq!(mode_str(ContextMode::Selection), "selection");
        assert_eq!(mode_str(ContextMode::Split), "split");
        assert_eq!(mode_str(ContextMode::Tree), "tree");
        assert_eq!(mode_str(ContextMode::Meta), "meta");
    }
}
