use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;
use std::collections::HashMap;

// Serde `#[serde(default = "default_*")]` attribute paths on `AppSettings` resolve
// against this module, so the private default fns must be in scope here.
use super::defaults::*;

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

// Custom deserializer to handle both old numeric format (1-5) and new string format ("trace", "debug", etc.)
impl<'de> Deserialize<'de> for LogLevel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct LogLevelVisitor;

        impl<'de> Visitor<'de> for LogLevelVisitor {
            type Value = LogLevel;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a string or integer representing log level")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<LogLevel, E> {
                match value.to_lowercase().as_str() {
                    "trace" => Ok(LogLevel::Trace),
                    "debug" => Ok(LogLevel::Debug),
                    "info" => Ok(LogLevel::Info),
                    "warn" => Ok(LogLevel::Warn),
                    "error" => Ok(LogLevel::Error),
                    _ => Err(E::unknown_variant(
                        value,
                        &["trace", "debug", "info", "warn", "error"],
                    )),
                }
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<LogLevel, E> {
                match value {
                    1 => Ok(LogLevel::Trace),
                    2 => Ok(LogLevel::Debug),
                    3 => Ok(LogLevel::Info),
                    4 => Ok(LogLevel::Warn),
                    5 => Ok(LogLevel::Error),
                    _ => Err(E::invalid_value(de::Unexpected::Unsigned(value), &"1-5")),
                }
            }
        }

        deserializer.deserialize_any(LogLevelVisitor)
    }
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

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
// Renderer-canonical timeout type is WinSTT `settings_schema::ModelUnloadTimeout`;
// suffix this inherited one's TS export to break the bindings.ts collision.
#[specta(rename = "ModelUnloadTimeoutLegacy")]
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

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum PasteMethod {
    CtrlV,
    Direct,
    None,
    ShiftInsert,
    CtrlShiftV,
    ExternalScript,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ClipboardHandling {
    DontModify,
    CopyToClipboard,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
// Renderer-canonical is WinSTT `settings_schema::AutoSubmitKey`; suffix this
// inherited one's TS export to break the bindings.ts collision.
#[specta(rename = "AutoSubmitKeyLegacy")]
pub enum AutoSubmitKey {
    Enter,
    CtrlEnter,
    CmdEnter,
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

impl Default for AutoSubmitKey {
    fn default() -> Self {
        AutoSubmitKey::Enter
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

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
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

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum WhisperAcceleratorSetting {
    Auto,
    Cpu,
}

// Tolerant deserialization: legacy on-disk configs may still carry the removed
// "gpu" value (or any other unknown string). Map anything that is not an exact
// known variant to `Auto` instead of erroring, so old settings keep loading.
impl<'de> Deserialize<'de> for WhisperAcceleratorSetting {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Ok(match raw.as_str() {
            "cpu" => WhisperAcceleratorSetting::Cpu,
            _ => WhisperAcceleratorSetting::Auto,
        })
    }
}

impl Default for WhisperAcceleratorSetting {
    fn default() -> Self {
        WhisperAcceleratorSetting::Auto
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
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

/* still useful for composing the initial JSON in the store ------------ */
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
pub struct AppSettings {
    pub bindings: HashMap<String, ShortcutBinding>,
    // NOTE: the legacy `push_to_talk` bool was removed — the recording mode
    // (ptt / toggle / listen / wakeword) is owned by `WinsttSettings.general.recording_mode`,
    // which the BACKEND reads in shortcut/handler.rs to decide dispatch. The field had no
    // live reader. `#[serde(default)]` on the remaining fields means an older
    // settings_store.json that still carries `"push_to_talk"` deserializes fine (the unknown
    // key is ignored).
    #[serde(default = "default_update_checks_enabled")]
    pub update_checks_enabled: bool,
    // NOTE: the legacy `selected_model` / `translate_to_english` / `selected_language` /
    // `overlay_position` / `model_unload_timeout` fields were removed — each is fully owned by a
    // canonical `WinsttSettings` field the backend actually reads (`model.model` /
    // `model.translate_target_language` / `model.language` / `general.overlay_position` /
    // `global.model_unload_timeout`); the `core` copies had NO reader (only a write-only sync for
    // the timeout). `#[serde(default)]` on the remaining fields means an older store still carrying
    // those keys deserializes fine (the unknown keys are ignored).
    #[serde(default)]
    pub selected_microphone: Option<String>,
    #[serde(default)]
    pub clamshell_microphone: Option<String>,
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
    #[serde(default = "default_auto_submit")]
    pub auto_submit: bool,
    #[serde(default)]
    pub auto_submit_key: AutoSubmitKey,
    // NOTE: the legacy `post_process_*` fields (enabled/provider catalog/API
    // keys/models/prompts) were removed with the legacy post-processing path —
    // LLM post-processing is configured solely via `WinsttSettings.llm`. Older
    // stores that still carry those keys deserialize fine (unknown keys are
    // ignored).
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
