//! Accelerator settings reporting for the WinSTT-owned STT engine.

use crate::settings::{OrtAcceleratorSetting, WhisperAcceleratorSetting};
use crate::winstt::commands::settings::read_settings_raw;
use serde::Serialize;
use specta::Type;

/// Apply persisted accelerator preferences. The current local STT path resolves
/// providers directly from WinSTT settings when a model loads, so this function is
/// intentionally limited to logging the selected preferences for diagnostics.
pub fn apply_accelerator_settings(app: &tauri::AppHandle) {
    let settings = read_settings_raw(app).core;
    log::info!(
        "STT accelerator preferences: whisper={:?}, ort={:?}, gpu_device={}",
        settings.whisper_accelerator,
        settings.ort_accelerator,
        settings.whisper_gpu_device
    );
}

#[derive(Serialize, Clone, Debug, Type)]
pub struct GpuDeviceOption {
    pub id: i32,
    pub name: String,
    pub total_vram_mb: usize,
}

#[derive(Serialize, Clone, Debug, Type)]
pub struct AvailableAccelerators {
    pub whisper: Vec<String>,
    pub ort: Vec<String>,
    pub gpu_devices: Vec<GpuDeviceOption>,
}

/// Return which accelerators are compiled into this build.
pub fn get_available_accelerators() -> AvailableAccelerators {
    AvailableAccelerators {
        whisper: available_whisper_options(),
        ort: available_ort_options(),
        gpu_devices: Vec::new(),
    }
}

fn available_whisper_options() -> Vec<String> {
    [
        WhisperAcceleratorSetting::Auto,
        WhisperAcceleratorSetting::Cpu,
    ]
    .into_iter()
    .map(whisper_accelerator_label)
    .collect()
}

fn available_ort_options() -> Vec<String> {
    vec![
        ort_accelerator_label(OrtAcceleratorSetting::Auto),
        ort_accelerator_label(OrtAcceleratorSetting::Cpu),
        #[cfg(feature = "cuda")]
        ort_accelerator_label(OrtAcceleratorSetting::Cuda),
        #[cfg(windows)]
        ort_accelerator_label(OrtAcceleratorSetting::DirectMl),
        #[cfg(feature = "rocm")]
        ort_accelerator_label(OrtAcceleratorSetting::Rocm),
    ]
}

fn whisper_accelerator_label(value: WhisperAcceleratorSetting) -> String {
    match value {
        WhisperAcceleratorSetting::Auto => "auto",
        WhisperAcceleratorSetting::Cpu => "cpu",
        WhisperAcceleratorSetting::Gpu => "gpu",
    }
    .to_string()
}

fn ort_accelerator_label(value: OrtAcceleratorSetting) -> String {
    match value {
        OrtAcceleratorSetting::Auto => "auto",
        OrtAcceleratorSetting::Cpu => "cpu",
        OrtAcceleratorSetting::Cuda => "cuda",
        OrtAcceleratorSetting::DirectMl => "directml",
        OrtAcceleratorSetting::Rocm => "rocm",
    }
    .to_string()
}
