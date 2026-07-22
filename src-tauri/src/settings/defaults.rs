use super::types::{LogLevel, TypingTool};

pub(super) fn default_update_checks_enabled() -> bool {
    true
}

pub(super) fn default_debug_mode() -> bool {
    false
}

pub(super) fn default_log_level() -> LogLevel {
    // Ship at Info so dictated text (logged at Debug) never reaches the persistent
    // file log by default. Users can opt into Debug when troubleshooting.
    LogLevel::Info
}

pub(super) fn default_paste_delay_ms() -> u64 {
    60
}

pub(super) fn default_show_tray_icon() -> bool {
    true
}

pub(super) fn default_whisper_gpu_device() -> i32 {
    -1 // auto
}

pub(super) fn default_typing_tool() -> TypingTool {
    TypingTool::Auto
}
