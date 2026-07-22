use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

// Serde `#[serde(default = "default_*")]` attribute paths on `AppSettings` resolve
// against this module, so the private default fns must be in scope here.
use super::defaults::*;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl From<LogLevel> for tauri_plugin_log::LogLevel {
    fn from(level: LogLevel) -> Self {
        match level {
            LogLevel::Trace => tauri_plugin_log::LogLevel::Trace,
            LogLevel::Debug => tauri_plugin_log::LogLevel::Debug,
            LogLevel::Info => tauri_plugin_log::LogLevel::Info,
            LogLevel::Warn => tauri_plugin_log::LogLevel::Warn,
            LogLevel::Error => tauri_plugin_log::LogLevel::Error,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct ShortcutBinding {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_binding: String,
    pub current_binding: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelUnloadTimeout {
    Never,
    Immediately,
    Min2,
    Min5,
    Min10,
    Min15,
    Hour1,
    Sec15, // Debug mode only
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PasteMethod {
    CtrlV,
    Direct,
    None,
    ShiftInsert,
    CtrlShiftV,
    ExternalScript,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardHandling {
    DontModify,
    CopyToClipboard,
}

impl Default for ModelUnloadTimeout {
    fn default() -> Self {
        // Match the renderer default: unload resident local models after 15 minutes idle.
        ModelUnloadTimeout::Min15
    }
}

impl Default for PasteMethod {
    fn default() -> Self {
        // Default to CtrlV for macOS and Windows, Direct for Linux
        #[cfg(target_os = "linux")]
        return PasteMethod::Direct;
        #[cfg(not(target_os = "linux"))]
        return PasteMethod::CtrlV;
    }
}

impl Default for ClipboardHandling {
    fn default() -> Self {
        ClipboardHandling::DontModify
    }
}

impl ModelUnloadTimeout {
    /// Stable, lossless u8 tag for atomic storage. Kept in sync with `from_tag`.
    fn to_tag(self) -> u8 {
        match self {
            ModelUnloadTimeout::Never => 0,
            ModelUnloadTimeout::Immediately => 1,
            ModelUnloadTimeout::Min2 => 2,
            ModelUnloadTimeout::Min5 => 3,
            ModelUnloadTimeout::Min10 => 4,
            ModelUnloadTimeout::Min15 => 5,
            ModelUnloadTimeout::Hour1 => 6,
            ModelUnloadTimeout::Sec15 => 7,
        }
    }

    /// Inverse of `to_tag`; an unknown tag falls back to the default policy.
    fn from_tag(tag: u8) -> Self {
        match tag {
            0 => ModelUnloadTimeout::Never,
            1 => ModelUnloadTimeout::Immediately,
            2 => ModelUnloadTimeout::Min2,
            3 => ModelUnloadTimeout::Min5,
            4 => ModelUnloadTimeout::Min10,
            5 => ModelUnloadTimeout::Min15,
            6 => ModelUnloadTimeout::Hour1,
            7 => ModelUnloadTimeout::Sec15,
            _ => ModelUnloadTimeout::default(),
        }
    }

    pub fn to_minutes(self) -> Option<u64> {
        match self {
            ModelUnloadTimeout::Never => None,
            ModelUnloadTimeout::Immediately => Some(0), // Special case for immediate unloading
            ModelUnloadTimeout::Min2 => Some(2),
            ModelUnloadTimeout::Min5 => Some(5),
            ModelUnloadTimeout::Min10 => Some(10),
            ModelUnloadTimeout::Min15 => Some(15),
            ModelUnloadTimeout::Hour1 => Some(60),
            ModelUnloadTimeout::Sec15 => Some(0), // Special case for debug - handled separately
        }
    }

    pub fn to_seconds(self) -> Option<u64> {
        match self {
            ModelUnloadTimeout::Never => None,
            ModelUnloadTimeout::Immediately => Some(0), // Special case for immediate unloading
            ModelUnloadTimeout::Sec15 => Some(15),
            _ => self.to_minutes().map(|m| m * 60),
        }
    }
}

/// Lock-free atomic cell holding a [`ModelUnloadTimeout`], for managers that cache
/// the shared unload policy and update it from settings runtime hooks without a
/// `Mutex`. Storage is a lossless u8 tag (see `ModelUnloadTimeout::to_tag`), so the
/// exact variant round-trips — unlike a raw seconds encoding, which would collapse
/// distinct finite variants. Replaces the bespoke per-manager atomic codecs.
#[derive(Debug)]
pub struct AtomicModelUnloadTimeout(std::sync::atomic::AtomicU8);

impl AtomicModelUnloadTimeout {
    pub fn new(timeout: ModelUnloadTimeout) -> Self {
        Self(std::sync::atomic::AtomicU8::new(timeout.to_tag()))
    }

    pub fn load(&self) -> ModelUnloadTimeout {
        ModelUnloadTimeout::from_tag(self.0.load(std::sync::atomic::Ordering::Acquire))
    }

    pub fn store(&self, timeout: ModelUnloadTimeout) {
        self.0
            .store(timeout.to_tag(), std::sync::atomic::Ordering::Release);
    }
}

impl From<ModelUnloadTimeout> for AtomicModelUnloadTimeout {
    fn from(timeout: ModelUnloadTimeout) -> Self {
        Self::new(timeout)
    }
}

impl From<&AtomicModelUnloadTimeout> for ModelUnloadTimeout {
    fn from(atomic: &AtomicModelUnloadTimeout) -> Self {
        atomic.load()
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TypingTool {
    Auto,
    Wtype,
    Kwtype,
    Dotool,
    Ydotool,
    Xdotool,
}

impl Default for TypingTool {
    fn default() -> Self {
        TypingTool::Auto
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WhisperAcceleratorSetting {
    Auto,
    Cpu,
}

impl Default for WhisperAcceleratorSetting {
    fn default() -> Self {
        WhisperAcceleratorSetting::Auto
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrtAcceleratorSetting {
    Auto,
    Cpu,
    Cuda,
    #[serde(rename = "directml")]
    DirectMl,
    Rocm,
}

impl Default for OrtAcceleratorSetting {
    fn default() -> Self {
        OrtAcceleratorSetting::Auto
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct AppSettings {
    pub bindings: HashMap<String, ShortcutBinding>,
    #[serde(default = "default_update_checks_enabled")]
    pub update_checks_enabled: bool,
    #[serde(default)]
    pub selected_output_device: Option<String>,
    #[serde(default = "default_debug_mode")]
    pub debug_mode: bool,
    #[serde(default = "default_log_level")]
    pub log_level: LogLevel,
    #[serde(default)]
    pub paste_method: PasteMethod,
    #[serde(default)]
    pub clipboard_handling: ClipboardHandling,
    #[serde(default)]
    pub mute_while_recording: bool,
    #[serde(default)]
    pub append_trailing_space: bool,
    #[serde(default = "default_show_tray_icon")]
    pub show_tray_icon: bool,
    #[serde(default = "default_paste_delay_ms")]
    pub paste_delay_ms: u64,
    #[serde(default = "default_typing_tool")]
    pub typing_tool: TypingTool,
    #[serde(default)]
    pub whisper_accelerator: WhisperAcceleratorSetting,
    #[serde(default)]
    pub ort_accelerator: OrtAcceleratorSetting,
    #[serde(default = "default_whisper_gpu_device")]
    pub whisper_gpu_device: i32,
}
