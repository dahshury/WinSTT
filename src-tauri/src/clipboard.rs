use crate::input::{self, EnigoState};
#[cfg(target_os = "linux")]
use crate::settings::TypingTool;
use crate::settings::{get_settings, AutoSubmitKey, ClipboardHandling, PasteMethod};
use enigo::{Direction, Enigo, Key, Keyboard};
use log::{info, warn};
#[cfg(target_os = "linux")]
use std::process::Command;
use std::sync::{MutexGuard, TryLockError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[cfg(target_os = "linux")]
use crate::utils::{is_kde_wayland, is_wayland};

const SLOW_PASTE_PHASE_MS: u128 = 2_000;
const ENIGO_LOCK_TIMEOUT_MS: u64 = 2_000;

fn warn_if_slow_paste_phase(phase: &str, elapsed_ms: u128) {
    if elapsed_ms >= SLOW_PASTE_PHASE_MS {
        warn!("[clipboard] {phase}_slow duration_ms={elapsed_ms}");
    }
}

fn lock_enigo<'a>(
    enigo_state: &'a EnigoState,
    context: &str,
) -> Result<MutexGuard<'a, Enigo>, ClipboardError> {
    let started = Instant::now();
    info!("[clipboard] enigo_lock_start context={context}");
    loop {
        match enigo_state.0.try_lock() {
            Ok(guard) => {
                let elapsed_ms = started.elapsed().as_millis();
                info!("[clipboard] enigo_lock_complete context={context} duration_ms={elapsed_ms}");
                warn_if_slow_paste_phase("enigo_lock", elapsed_ms);
                return Ok(guard);
            }
            Err(TryLockError::Poisoned(err)) => {
                return Err(ClipboardError::Input(format!(
                    "Failed to lock Enigo: {err}"
                )));
            }
            Err(TryLockError::WouldBlock) => {
                if started.elapsed() >= Duration::from_millis(ENIGO_LOCK_TIMEOUT_MS) {
                    warn!(
                        "[clipboard] enigo_lock_timeout context={context} duration_ms={}",
                        started.elapsed().as_millis()
                    );
                    return Err(ClipboardError::Input(format!(
                        "Timed out locking Enigo after {ENIGO_LOCK_TIMEOUT_MS}ms"
                    )));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

/// Typed error for the paste/clipboard pipeline. Used for internal error construction
/// so each failure carries its category (clipboard I/O vs. external typing tool vs.
/// enigo key synthesis vs. misconfiguration) instead of a bare `String`. The public
/// `paste*` boundary flattens this to `String` (via `Display`) so every existing caller
/// — including those outside this module — keeps compiling unchanged.
#[derive(Debug, thiserror::Error)]
pub enum ClipboardError {
    /// Reading or writing the system clipboard failed.
    #[error("clipboard I/O failed: {0}")]
    Clipboard(String),

    /// A Linux-native typing/paste tool (wtype, xdotool, dotool, ydotool, kwtype,
    /// wl-copy) failed to run or exited non-zero.
    #[cfg(target_os = "linux")]
    #[error("paste tool failed: {0}")]
    Tool(String),

    /// Synthesizing keystrokes via enigo failed (paste combo / auto-submit Return).
    #[error("input synthesis failed: {0}")]
    Input(String),

    /// The paste pipeline was misconfigured (missing enigo state or an unsupported
    /// paste method for the chosen path).
    #[error("paste configuration error: {0}")]
    Config(String),
}

/// Pastes text using the clipboard: saves current content, writes text, sends paste keystroke, restores clipboard.
fn paste_via_clipboard(
    enigo: &mut Enigo,
    text: &str,
    app_handle: &AppHandle,
    paste_method: &PasteMethod,
    paste_delay_ms: u64,
) -> Result<(), ClipboardError> {
    let total_started = Instant::now();
    info!(
        "[clipboard] paste_via_clipboard_start method={paste_method:?} chars={} delay_ms={paste_delay_ms}",
        text.chars().count()
    );
    let clipboard = app_handle.clipboard();
    let phase_started = Instant::now();
    info!("[clipboard] read_original_start");
    let clipboard_content = clipboard.read_text().unwrap_or_default();
    let elapsed_ms = phase_started.elapsed().as_millis();
    info!(
        "[clipboard] read_original_complete duration_ms={elapsed_ms} chars={}",
        clipboard_content.chars().count()
    );
    warn_if_slow_paste_phase("read_original", elapsed_ms);

    // Write text to clipboard first
    // On Wayland, prefer wl-copy for better compatibility (especially with umlauts)
    let phase_started = Instant::now();
    info!(
        "[clipboard] write_text_start chars={}",
        text.chars().count()
    );
    #[cfg(target_os = "linux")]
    let write_result = if is_wayland() && command_available("wl-copy") {
        info!("Using wl-copy for clipboard write on Wayland");
        write_clipboard_via_wl_copy(text)
    } else {
        clipboard
            .write_text(text)
            .map_err(|e| ClipboardError::Clipboard(format!("Failed to write to clipboard: {}", e)))
    };

    #[cfg(not(target_os = "linux"))]
    let write_result = clipboard
        .write_text(text)
        .map_err(|e| ClipboardError::Clipboard(format!("Failed to write to clipboard: {}", e)));

    write_result?;
    let elapsed_ms = phase_started.elapsed().as_millis();
    info!("[clipboard] write_text_complete duration_ms={elapsed_ms}");
    warn_if_slow_paste_phase("write_text", elapsed_ms);

    std::thread::sleep(Duration::from_millis(paste_delay_ms));

    // Send paste key combo
    let phase_started = Instant::now();
    info!("[clipboard] key_combo_start method={paste_method:?}");
    #[cfg(target_os = "linux")]
    let key_combo_sent = try_send_key_combo_linux(paste_method)?;

    #[cfg(not(target_os = "linux"))]
    let key_combo_sent = false;

    // Fall back to enigo if no native tool handled it
    if !key_combo_sent {
        match paste_method {
            PasteMethod::CtrlV => input::send_paste_ctrl_v(enigo).map_err(ClipboardError::Input)?,
            PasteMethod::CtrlShiftV => {
                input::send_paste_ctrl_shift_v(enigo).map_err(ClipboardError::Input)?
            }
            PasteMethod::ShiftInsert => {
                input::send_paste_shift_insert(enigo).map_err(ClipboardError::Input)?
            }
            _ => {
                return Err(ClipboardError::Config(
                    "Invalid paste method for clipboard paste".into(),
                ))
            }
        }
    }
    let elapsed_ms = phase_started.elapsed().as_millis();
    info!("[clipboard] key_combo_complete duration_ms={elapsed_ms}");
    warn_if_slow_paste_phase("key_combo", elapsed_ms);

    std::thread::sleep(std::time::Duration::from_millis(50));

    // Restore original clipboard content
    // On Wayland, prefer wl-copy for better compatibility
    let phase_started = Instant::now();
    info!(
        "[clipboard] restore_original_start chars={}",
        clipboard_content.chars().count()
    );
    #[cfg(target_os = "linux")]
    if is_wayland() && command_available("wl-copy") {
        let _ = write_clipboard_via_wl_copy(&clipboard_content);
    } else {
        let _ = clipboard.write_text(&clipboard_content);
    }

    #[cfg(not(target_os = "linux"))]
    let _ = clipboard.write_text(&clipboard_content);
    let elapsed_ms = phase_started.elapsed().as_millis();
    info!("[clipboard] restore_original_complete duration_ms={elapsed_ms}");
    warn_if_slow_paste_phase("restore_original", elapsed_ms);

    let total_elapsed_ms = total_started.elapsed().as_millis();
    info!("[clipboard] paste_via_clipboard_complete duration_ms={total_elapsed_ms}");
    warn_if_slow_paste_phase("paste_via_clipboard", total_elapsed_ms);

    Ok(())
}

/// Attempts to send a key combination using Linux-native tools.
/// Returns `Ok(true)` if a native tool handled it, `Ok(false)` to fall back to enigo.
#[cfg(target_os = "linux")]
fn try_send_key_combo_linux(paste_method: &PasteMethod) -> Result<bool, ClipboardError> {
    if is_wayland() {
        // Wayland: prefer wtype (but not on KDE), then dotool, then ydotool
        // Note: wtype doesn't work on KDE (no zwp_virtual_keyboard_manager_v1 support)
        if !is_kde_wayland() && command_available("wtype") {
            info!("Using wtype for key combo");
            send_key_combo_via_wtype(paste_method)?;
            return Ok(true);
        }
        if command_available("dotool") {
            info!("Using dotool for key combo");
            send_key_combo_via_dotool(paste_method)?;
            return Ok(true);
        }
        if command_available("ydotool") {
            info!("Using ydotool for key combo");
            send_key_combo_via_ydotool(paste_method)?;
            return Ok(true);
        }
    } else {
        // X11: prefer xdotool, then ydotool
        if command_available("xdotool") {
            info!("Using xdotool for key combo");
            send_key_combo_via_xdotool(paste_method)?;
            return Ok(true);
        }
        if command_available("ydotool") {
            info!("Using ydotool for key combo");
            send_key_combo_via_ydotool(paste_method)?;
            return Ok(true);
        }
    }

    Ok(false)
}

/// Attempts to type text directly using Linux-native tools.
/// Returns `Ok(true)` if a native tool handled it, `Ok(false)` to fall back to enigo.
#[cfg(target_os = "linux")]
fn try_direct_typing_linux(text: &str, preferred_tool: TypingTool) -> Result<bool, ClipboardError> {
    // If user specified a tool, try only that one
    if preferred_tool != TypingTool::Auto {
        return match preferred_tool {
            TypingTool::Wtype if command_available("wtype") => {
                info!("Using user-specified wtype");
                type_text_via_wtype(text)?;
                Ok(true)
            }
            TypingTool::Kwtype if command_available("kwtype") => {
                info!("Using user-specified kwtype");
                type_text_via_kwtype(text)?;
                Ok(true)
            }
            TypingTool::Dotool if command_available("dotool") => {
                info!("Using user-specified dotool");
                type_text_via_dotool(text)?;
                Ok(true)
            }
            TypingTool::Ydotool if command_available("ydotool") => {
                info!("Using user-specified ydotool");
                type_text_via_ydotool(text)?;
                Ok(true)
            }
            TypingTool::Xdotool if command_available("xdotool") => {
                info!("Using user-specified xdotool");
                type_text_via_xdotool(text)?;
                Ok(true)
            }
            _ => Err(ClipboardError::Tool(format!(
                "Typing tool {:?} is not available on this system",
                preferred_tool
            ))),
        };
    }

    // Auto mode - existing fallback chain
    if is_wayland() {
        // KDE Wayland: prefer kwtype (uses KDE Fake Input protocol, supports umlauts)
        if is_kde_wayland() && command_available("kwtype") {
            info!("Using kwtype for direct text input on KDE Wayland");
            type_text_via_kwtype(text)?;
            return Ok(true);
        }
        // Wayland: prefer wtype, then dotool, then ydotool
        // Note: wtype doesn't work on KDE (no zwp_virtual_keyboard_manager_v1 support)
        if !is_kde_wayland() && command_available("wtype") {
            info!("Using wtype for direct text input");
            type_text_via_wtype(text)?;
            return Ok(true);
        }
        if command_available("dotool") {
            info!("Using dotool for direct text input");
            type_text_via_dotool(text)?;
            return Ok(true);
        }
        if command_available("ydotool") {
            info!("Using ydotool for direct text input");
            type_text_via_ydotool(text)?;
            return Ok(true);
        }
    } else {
        // X11: prefer xdotool, then ydotool
        if command_available("xdotool") {
            info!("Using xdotool for direct text input");
            type_text_via_xdotool(text)?;
            return Ok(true);
        }
        if command_available("ydotool") {
            info!("Using ydotool for direct text input");
            type_text_via_ydotool(text)?;
            return Ok(true);
        }
    }

    Ok(false)
}

/// Returns the list of available typing tools on this system.
/// Always includes "auto" as the first entry.
#[cfg(target_os = "linux")]
pub fn get_available_typing_tools() -> Vec<String> {
    let mut tools = vec!["auto".to_string()];
    if command_available("wtype") {
        tools.push("wtype".to_string());
    }
    if command_available("kwtype") {
        tools.push("kwtype".to_string());
    }
    if command_available("dotool") {
        tools.push("dotool".to_string());
    }
    if command_available("ydotool") {
        tools.push("ydotool".to_string());
    }
    if command_available("xdotool") {
        tools.push("xdotool".to_string());
    }
    tools
}

#[cfg(target_os = "linux")]
fn command_available(name: &str) -> bool {
    Command::new("which")
        .arg(name)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Type text directly via wtype on Wayland.
#[cfg(target_os = "linux")]
fn type_text_via_wtype(text: &str) -> Result<(), ClipboardError> {
    let output = Command::new("wtype")
        .arg("--") // Protect against text starting with -
        .arg(text)
        .output()
        .map_err(|e| ClipboardError::Tool(format!("Failed to execute wtype: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ClipboardError::Tool(format!("wtype failed: {}", stderr)));
    }

    Ok(())
}

/// Type text directly via xdotool on X11.
#[cfg(target_os = "linux")]
fn type_text_via_xdotool(text: &str) -> Result<(), ClipboardError> {
    let output = Command::new("xdotool")
        .arg("type")
        .arg("--clearmodifiers")
        .arg("--")
        .arg(text)
        .output()
        .map_err(|e| ClipboardError::Tool(format!("Failed to execute xdotool: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ClipboardError::Tool(format!("xdotool failed: {}", stderr)));
    }

    Ok(())
}

/// Type text directly via dotool (works on both Wayland and X11 via uinput).
#[cfg(target_os = "linux")]
fn type_text_via_dotool(text: &str) -> Result<(), ClipboardError> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = Command::new("dotool")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| ClipboardError::Tool(format!("Failed to spawn dotool: {}", e)))?;

    if let Some(mut stdin) = child.stdin.take() {
        // dotool uses "type <text>" command
        writeln!(stdin, "type {}", text)
            .map_err(|e| ClipboardError::Tool(format!("Failed to write to dotool stdin: {}", e)))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| ClipboardError::Tool(format!("Failed to wait for dotool: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ClipboardError::Tool(format!("dotool failed: {}", stderr)));
    }

    Ok(())
}

/// Type text directly via ydotool (uinput-based, requires ydotoold daemon).
#[cfg(target_os = "linux")]
fn type_text_via_ydotool(text: &str) -> Result<(), ClipboardError> {
    let output = Command::new("ydotool")
        .arg("type")
        .arg("--")
        .arg(text)
        .output()
        .map_err(|e| ClipboardError::Tool(format!("Failed to execute ydotool: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ClipboardError::Tool(format!("ydotool failed: {}", stderr)));
    }

    Ok(())
}

/// Type text directly via kwtype (KDE Wayland virtual keyboard, uses KDE Fake Input protocol).
#[cfg(target_os = "linux")]
fn type_text_via_kwtype(text: &str) -> Result<(), ClipboardError> {
    let output = Command::new("kwtype")
        .arg("--")
        .arg(text)
        .output()
        .map_err(|e| ClipboardError::Tool(format!("Failed to execute kwtype: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ClipboardError::Tool(format!("kwtype failed: {}", stderr)));
    }

    Ok(())
}

/// Write text to clipboard via wl-copy (Wayland clipboard tool).
/// Uses Stdio::null() to avoid blocking on repeated calls — wl-copy forks a
/// daemon that inherits piped fds, causing read_to_end to hang indefinitely.
#[cfg(target_os = "linux")]
fn write_clipboard_via_wl_copy(text: &str) -> Result<(), ClipboardError> {
    use std::process::Stdio;
    let status = Command::new("wl-copy")
        .arg("--")
        .arg(text)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| ClipboardError::Clipboard(format!("Failed to execute wl-copy: {}", e)))?;

    if !status.success() {
        return Err(ClipboardError::Clipboard("wl-copy failed".into()));
    }

    Ok(())
}

/// Send a key combination (e.g., Ctrl+V) via wtype on Wayland.
#[cfg(target_os = "linux")]
fn send_key_combo_via_wtype(paste_method: &PasteMethod) -> Result<(), ClipboardError> {
    let args: Vec<&str> = match paste_method {
        PasteMethod::CtrlV => vec!["-M", "ctrl", "-k", "v"],
        PasteMethod::ShiftInsert => vec!["-M", "shift", "-k", "Insert"],
        PasteMethod::CtrlShiftV => vec!["-M", "ctrl", "-M", "shift", "-k", "v"],
        _ => return Err(ClipboardError::Config("Unsupported paste method".into())),
    };

    let output = Command::new("wtype")
        .args(&args)
        .output()
        .map_err(|e| ClipboardError::Tool(format!("Failed to execute wtype: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ClipboardError::Tool(format!("wtype failed: {}", stderr)));
    }

    Ok(())
}

/// Send a key combination (e.g., Ctrl+V) via dotool.
#[cfg(target_os = "linux")]
fn send_key_combo_via_dotool(paste_method: &PasteMethod) -> Result<(), ClipboardError> {
    let command = match paste_method {
        PasteMethod::CtrlV => "echo key ctrl+v | dotool",
        PasteMethod::ShiftInsert => "echo key shift+insert | dotool",
        PasteMethod::CtrlShiftV => "echo key ctrl+shift+v | dotool",
        _ => return Err(ClipboardError::Config("Unsupported paste method".into())),
    };
    use std::process::Stdio;
    let status = Command::new("sh")
        .arg("-c")
        .arg(command)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| ClipboardError::Tool(format!("Failed to execute dotool: {}", e)))?;
    if !status.success() {
        return Err(ClipboardError::Tool("dotool failed".into()));
    }

    Ok(())
}

/// Send a key combination (e.g., Ctrl+V) via ydotool (requires ydotoold daemon).
#[cfg(target_os = "linux")]
fn send_key_combo_via_ydotool(paste_method: &PasteMethod) -> Result<(), ClipboardError> {
    // ydotool uses Linux input event keycodes with format <keycode>:<pressed>
    // where pressed is 1 for down, 0 for up. Keycodes: ctrl=29, shift=42, v=47, insert=110
    let args: Vec<&str> = match paste_method {
        PasteMethod::CtrlV => vec!["key", "29:1", "47:1", "47:0", "29:0"],
        PasteMethod::ShiftInsert => vec!["key", "42:1", "110:1", "110:0", "42:0"],
        PasteMethod::CtrlShiftV => vec!["key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"],
        _ => return Err(ClipboardError::Config("Unsupported paste method".into())),
    };

    let output = Command::new("ydotool")
        .args(&args)
        .output()
        .map_err(|e| ClipboardError::Tool(format!("Failed to execute ydotool: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ClipboardError::Tool(format!("ydotool failed: {}", stderr)));
    }

    Ok(())
}

/// Send a key combination (e.g., Ctrl+V) via xdotool on X11.
#[cfg(target_os = "linux")]
fn send_key_combo_via_xdotool(paste_method: &PasteMethod) -> Result<(), ClipboardError> {
    let key_combo = match paste_method {
        PasteMethod::CtrlV => "ctrl+v",
        PasteMethod::CtrlShiftV => "ctrl+shift+v",
        PasteMethod::ShiftInsert => "shift+Insert",
        _ => return Err(ClipboardError::Config("Unsupported paste method".into())),
    };

    let output = Command::new("xdotool")
        .arg("key")
        .arg("--clearmodifiers")
        .arg(key_combo)
        .output()
        .map_err(|e| ClipboardError::Tool(format!("Failed to execute xdotool: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ClipboardError::Tool(format!("xdotool failed: {}", stderr)));
    }

    Ok(())
}

/// Types text directly by simulating individual key presses.
fn paste_direct(
    enigo: &mut Enigo,
    text: &str,
    #[cfg(target_os = "linux")] typing_tool: TypingTool,
) -> Result<(), ClipboardError> {
    #[cfg(target_os = "linux")]
    {
        if try_direct_typing_linux(text, typing_tool)? {
            return Ok(());
        }
        info!("Falling back to enigo for direct text input");
    }

    input::paste_text_direct(enigo, text).map_err(ClipboardError::Input)
}

/// Types realtime chunks without letting physically held PTT modifiers alter the text.
fn paste_streaming_direct(
    enigo: &mut Enigo,
    backspace_chars: usize,
    text: &str,
    #[cfg(target_os = "linux")] typing_tool: TypingTool,
) -> Result<(), ClipboardError> {
    #[cfg(target_os = "linux")]
    {
        if backspace_chars == 0 && try_direct_typing_linux(text, typing_tool)? {
            return Ok(());
        }
        info!("Falling back to enigo for streaming text input");
    }

    input::edit_text_streaming(enigo, backspace_chars, text).map_err(ClipboardError::Input)
}

fn send_return_key(enigo: &mut Enigo, key_type: AutoSubmitKey) -> Result<(), ClipboardError> {
    match key_type {
        AutoSubmitKey::Enter => {
            enigo
                .key(Key::Return, Direction::Press)
                .map_err(|e| ClipboardError::Input(format!("Failed to press Return key: {}", e)))?;
            enigo.key(Key::Return, Direction::Release).map_err(|e| {
                ClipboardError::Input(format!("Failed to release Return key: {}", e))
            })?;
        }
        AutoSubmitKey::CtrlEnter => {
            enigo.key(Key::Control, Direction::Press).map_err(|e| {
                ClipboardError::Input(format!("Failed to press Control key: {}", e))
            })?;
            enigo
                .key(Key::Return, Direction::Press)
                .map_err(|e| ClipboardError::Input(format!("Failed to press Return key: {}", e)))?;
            enigo.key(Key::Return, Direction::Release).map_err(|e| {
                ClipboardError::Input(format!("Failed to release Return key: {}", e))
            })?;
            enigo.key(Key::Control, Direction::Release).map_err(|e| {
                ClipboardError::Input(format!("Failed to release Control key: {}", e))
            })?;
        }
        AutoSubmitKey::CmdEnter => {
            enigo.key(Key::Meta, Direction::Press).map_err(|e| {
                ClipboardError::Input(format!("Failed to press Meta/Cmd key: {}", e))
            })?;
            enigo
                .key(Key::Return, Direction::Press)
                .map_err(|e| ClipboardError::Input(format!("Failed to press Return key: {}", e)))?;
            enigo.key(Key::Return, Direction::Release).map_err(|e| {
                ClipboardError::Input(format!("Failed to release Return key: {}", e))
            })?;
            enigo.key(Key::Meta, Direction::Release).map_err(|e| {
                ClipboardError::Input(format!("Failed to release Meta/Cmd key: {}", e))
            })?;
        }
    }

    Ok(())
}

fn should_send_auto_submit(auto_submit: bool, paste_method: PasteMethod) -> bool {
    auto_submit && paste_method != PasteMethod::None
}

/// Dictation paste: append the trailing space (if enabled) and honor the auto-submit Enter.
/// This is the normal "insert at caret" path. Runs on the calling thread — callers off the
/// main thread MUST schedule it via [`paste_on_main_thread`] (input synthesis is a main-thread
/// concern, the discipline `actions.rs` keeps).
pub fn paste(text: String, app_handle: AppHandle) -> Result<(), String> {
    paste_inner(text, app_handle, false, false).map_err(|e| e.to_string())
}

/// In-place REPLACE paste (the Transforms pipeline): paste over the still-highlighted selection
/// WITHOUT the dictation niceties — NO trailing space and NO auto-submit Enter, which would
/// corrupt a rewrite-in-place (the user didn't dictate a new line, they rewrote existing text).
/// Otherwise identical to [`paste`] (clipboard sandwich + configured paste method).
pub fn paste_replace(text: String, app_handle: AppHandle) -> Result<(), String> {
    paste_inner(text, app_handle, true, false).map_err(|e| e.to_string())
}

/// Full focused-field replacement for transform recovery: select all text in
/// the active field, then paste without dictation affordances.
pub fn paste_replace_field(text: String, app_handle: AppHandle) -> Result<(), String> {
    paste_inner(text, app_handle, true, true).map_err(|e| e.to_string())
}

fn paste_streaming_edit_inner(
    backspace_chars: usize,
    text: String,
    app_handle: AppHandle,
) -> Result<(), ClipboardError> {
    if backspace_chars == 0 && text.is_empty() {
        return Ok(());
    }

    let settings = get_settings(&app_handle);
    if settings.paste_method == PasteMethod::None {
        info!("PasteMethod::None selected - skipping streaming paste action");
        return Ok(());
    }

    let enigo_state = app_handle
        .try_state::<EnigoState>()
        .ok_or_else(|| ClipboardError::Config("Enigo state not initialized".into()))?;
    let mut enigo = lock_enigo(&enigo_state, "streaming_edit")?;

    // Streaming runs while the PTT hotkey can still be physically held. Avoid clipboard
    // accelerators here; Ctrl+V during Ctrl+Win can become Ctrl+Win+V, and a synthetic
    // Ctrl release can terminate the recording hotkey.
    let result = paste_streaming_direct(
        &mut enigo,
        backspace_chars,
        &text,
        #[cfg(target_os = "linux")]
        settings.typing_tool,
    );
    drop(enigo);

    result
}

/// Apply realtime text edits without paste accelerators. Backspaces repair prior provisional
/// realtime words when the model revises them on a later tick.
pub fn paste_streaming_edit(
    backspace_chars: usize,
    text: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    paste_streaming_edit_inner(backspace_chars, text, app_handle).map_err(|e| e.to_string())
}

fn submit_after_dictation_paste_inner(app_handle: AppHandle) -> Result<(), ClipboardError> {
    let settings = get_settings(&app_handle);
    if !should_send_auto_submit(settings.auto_submit, settings.paste_method) {
        return Ok(());
    }

    let enigo_state = app_handle
        .try_state::<EnigoState>()
        .ok_or_else(|| ClipboardError::Config("Enigo state not initialized".into()))?;
    let mut enigo = lock_enigo(&enigo_state, "auto_submit")?;

    std::thread::sleep(Duration::from_millis(50));
    send_return_key(&mut enigo, settings.auto_submit_key)
}

/// Send the configured auto-submit key without inserting text. Used by streaming
/// word-by-word paste after the final suffix has landed, so Enter fires once per
/// dictation instead of once per streamed word.
pub fn submit_after_dictation_paste(app_handle: AppHandle) -> Result<(), String> {
    submit_after_dictation_paste_inner(app_handle).map_err(|e| e.to_string())
}

pub fn submit_after_dictation_paste_on_main_thread(app_handle: &AppHandle) -> Result<(), String> {
    let app_for_submit = app_handle.clone();
    app_handle
        .run_on_main_thread(move || {
            if let Err(e) = submit_after_dictation_paste(app_for_submit.clone()) {
                log::error!("auto-submit after streaming paste failed: {e}");
                crate::winstt::commands::events::emit_paste_error(&app_for_submit);
            }
        })
        .map_err(|e| format!("failed to schedule auto-submit on main thread: {e}"))
}

/// Schedule a modifier-safe realtime edit on the main thread.
pub fn paste_streaming_edit_on_main_thread(
    app_handle: &AppHandle,
    backspace_chars: usize,
    text: String,
) -> Result<(), String> {
    let app_for_paste = app_handle.clone();
    app_handle
        .run_on_main_thread(move || {
            if let Err(e) = paste_streaming_edit(backspace_chars, text, app_for_paste.clone()) {
                log::error!("streaming paste on main thread failed: {e}");
                crate::winstt::commands::events::emit_paste_error(&app_for_paste);
            }
        })
        .map_err(|e| format!("failed to schedule streaming paste on main thread: {e}"))
}

/// Schedule a paste on the MAIN thread (input synthesis must not run on an async-runtime worker —
/// the discipline `actions.rs` keeps but `transforms.rs` previously broke by pasting straight off
/// `spawn`/`spawn_blocking`). `replace` picks the replace-mode variant (no trailing space / no
/// auto-submit). Returns `Err` only if the closure couldn't be scheduled; the paste's own result
/// is logged inside the closure (the caller is off-thread and can't await it).
pub fn paste_on_main_thread(
    app_handle: &AppHandle,
    text: String,
    replace: bool,
) -> Result<(), String> {
    let app_for_paste = app_handle.clone();
    app_handle
        .run_on_main_thread(move || {
            let result = if replace {
                paste_replace(text, app_for_paste.clone())
            } else {
                paste(text, app_for_paste.clone())
            };
            if let Err(e) = result {
                log::error!("paste on main thread failed: {e}");
                crate::winstt::commands::events::emit_paste_error(&app_for_paste);
            }
        })
        .map_err(|e| format!("failed to schedule paste on main thread: {e}"))
}

pub fn paste_replace_field_on_main_thread(
    app_handle: &AppHandle,
    text: String,
) -> Result<(), String> {
    let app_for_paste = app_handle.clone();
    app_handle
        .run_on_main_thread(move || {
            if let Err(e) = paste_replace_field(text, app_for_paste.clone()) {
                log::error!("full-field replace paste on main thread failed: {e}");
                crate::winstt::commands::events::emit_paste_error(&app_for_paste);
            }
        })
        .map_err(|e| format!("failed to schedule full-field replace paste on main thread: {e}"))
}

fn paste_inner(
    text: String,
    app_handle: AppHandle,
    replace_mode: bool,
    select_all_first: bool,
) -> Result<(), ClipboardError> {
    let paste_started = Instant::now();
    let settings = get_settings(&app_handle);
    let paste_method = settings.paste_method;
    let paste_delay_ms = settings.paste_delay_ms;

    // Append trailing space if enabled — SKIPPED in replace mode (an in-place rewrite must not
    // gain a stray trailing space the original selection didn't have).
    let text = if settings.append_trailing_space && !replace_mode {
        format!("{} ", text)
    } else {
        text
    };

    info!(
        "Using paste method: {:?}, delay: {}ms",
        paste_method, paste_delay_ms
    );
    info!(
        "[clipboard] paste_start method={paste_method:?} chars={} replace_mode={replace_mode} select_all_first={select_all_first}",
        text.chars().count()
    );

    if paste_method == PasteMethod::None {
        info!("PasteMethod::None selected - skipping paste action");
        return Ok(());
    }

    // Get the managed Enigo instance
    let enigo_state = app_handle
        .try_state::<EnigoState>()
        .ok_or_else(|| ClipboardError::Config("Enigo state not initialized".into()))?;
    let mut enigo = lock_enigo(&enigo_state, "paste")?;

    if select_all_first {
        let phase_started = Instant::now();
        info!("[clipboard] select_all_start");
        input::send_select_all(&mut enigo).map_err(ClipboardError::Input)?;
        let elapsed_ms = phase_started.elapsed().as_millis();
        info!("[clipboard] select_all_complete duration_ms={elapsed_ms}");
        warn_if_slow_paste_phase("select_all", elapsed_ms);
        std::thread::sleep(Duration::from_millis(50));
    }

    // Perform the paste operation
    match paste_method {
        PasteMethod::None => unreachable!("PasteMethod::None returned before input synthesis"),
        PasteMethod::Direct => {
            let phase_started = Instant::now();
            info!(
                "[clipboard] direct_paste_start chars={}",
                text.chars().count()
            );
            paste_direct(
                &mut enigo,
                &text,
                #[cfg(target_os = "linux")]
                settings.typing_tool,
            )?;
            let elapsed_ms = phase_started.elapsed().as_millis();
            info!("[clipboard] direct_paste_complete duration_ms={elapsed_ms}");
            warn_if_slow_paste_phase("direct_paste", elapsed_ms);
        }
        PasteMethod::CtrlV | PasteMethod::CtrlShiftV | PasteMethod::ShiftInsert => {
            paste_via_clipboard(
                &mut enigo,
                &text,
                &app_handle,
                &paste_method,
                paste_delay_ms,
            )?
        }
        PasteMethod::ExternalScript => {
            return Err(ClipboardError::Config(
                "External script paste is disabled".into(),
            ));
        }
    }

    // Auto-submit (Enter) is a DICTATION affordance — SKIPPED in replace mode so a Transforms
    // rewrite-in-place doesn't fire a spurious Enter (submitting the form / inserting a newline
    // the user never asked for).
    if !replace_mode && should_send_auto_submit(settings.auto_submit, paste_method) {
        std::thread::sleep(Duration::from_millis(50));
        let phase_started = Instant::now();
        info!(
            "[clipboard] auto_submit_start key={:?}",
            settings.auto_submit_key
        );
        send_return_key(&mut enigo, settings.auto_submit_key)?;
        let elapsed_ms = phase_started.elapsed().as_millis();
        info!("[clipboard] auto_submit_complete duration_ms={elapsed_ms}");
        warn_if_slow_paste_phase("auto_submit", elapsed_ms);
    }

    // After pasting, optionally copy to clipboard based on settings
    if settings.clipboard_handling == ClipboardHandling::CopyToClipboard {
        let clipboard = app_handle.clipboard();
        let phase_started = Instant::now();
        info!(
            "[clipboard] copy_to_clipboard_start chars={}",
            text.chars().count()
        );
        clipboard.write_text(&text).map_err(|e| {
            ClipboardError::Clipboard(format!("Failed to copy to clipboard: {}", e))
        })?;
        let elapsed_ms = phase_started.elapsed().as_millis();
        info!("[clipboard] copy_to_clipboard_complete duration_ms={elapsed_ms}");
        warn_if_slow_paste_phase("copy_to_clipboard", elapsed_ms);
    }

    let elapsed_ms = paste_started.elapsed().as_millis();
    info!("[clipboard] paste_complete duration_ms={elapsed_ms}");
    warn_if_slow_paste_phase("paste", elapsed_ms);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_submit_requires_setting_enabled() {
        assert!(!should_send_auto_submit(false, PasteMethod::CtrlV));
        assert!(!should_send_auto_submit(false, PasteMethod::Direct));
    }

    #[test]
    fn auto_submit_skips_none_paste_method() {
        assert!(!should_send_auto_submit(true, PasteMethod::None));
    }

    #[test]
    fn auto_submit_runs_for_active_paste_methods() {
        assert!(should_send_auto_submit(true, PasteMethod::CtrlV));
        assert!(should_send_auto_submit(true, PasteMethod::Direct));
        assert!(should_send_auto_submit(true, PasteMethod::CtrlShiftV));
        assert!(should_send_auto_submit(true, PasteMethod::ShiftInsert));
    }
}
