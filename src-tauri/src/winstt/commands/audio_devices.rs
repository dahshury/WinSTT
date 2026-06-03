// Source: docs/port/10_frontend_port_plan.md
// (WU-9 §6 — `entities/audio-device`), lib_wiring.md §3, spec/openapi.yaml `AudioDevice`,
// server/src/stt_server/control_handler.py `list_input_devices`. Wraps Handy's
// `audio_toolkit::audio::device::list_input_devices` (cpal).
//
// `get_audio_devices` is the input-device enumeration the WinSTT renderer's
// `entities/audio-device` (`useInputDevices`) calls via `IPC.AUDIO_GET_DEVICES`
// (adapter → `get_audio_devices`). It is consumed by WU-3 (footer mic picker),
// WU-9 (`useVadCalibration` device-name correlation, `useDeviceSwitchFeedback`
// stale-index reset, the detached `DevicePickerWindow`), and WU-11 (audio
// settings). The renderer validates the spec `AudioDevice` shape:
//
//     { index: integer, name: string, isDefault: boolean,
//       maxInputChannels?, defaultSampleRate?, hostApi?, hostApiName? }
//
// The renderer only READS `index` / `name` / `isDefault` (`buildInputDeviceOptions`
// dedupes by name, resolves the selected row by numeric `index`); the optional
// fields are spec-present for parity with PyAudio's enumeration but unused here.
//
// Handy already ships `get_available_microphones` (audio.rs), but it returns
// Handy's `AudioDevice { index: String, name, is_default }` (string index, no
// "System default" semantics matching WinSTT) — wrong shape for the reused
// renderer. This command emits the WinSTT spec shape directly. The numeric
// `index` is cpal's positional enumeration ordinal (string `"0"`,`"1"`,… →
// integer), the same integer the renderer persists as
// `audio.inputDeviceIndex` and hands to `set_parameter input_device_index`.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::audio_toolkit::audio::list_input_devices;

/// Last device list we logged, so repeated identical enumerations (every window's
/// `useInputDevices` calls this on mount + on each device-change poll) don't spam the
/// log. We log ONLY when the set changes — which preserves the diagnostic value
/// (a hot-plugged BT mic appearing/disappearing) while killing the dozen-per-startup
/// duplicate lines.
static LAST_LOGGED_DEVICES: Mutex<Option<String>> = Mutex::new(None);

/// One audio input device in the WinSTT spec `AudioDevice` shape (camelCase).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevicePayload {
    /// cpal positional enumeration ordinal (the renderer persists this as
    /// `audio.inputDeviceIndex`).
    pub index: i32,
    pub name: String,
    pub is_default: bool,
    /// Spec-present for parity with PyAudio's enumeration; the renderer doesn't
    /// read these, so a faithful constant keeps the shape stable without a
    /// second probe per device.
    pub max_input_channels: i32,
    pub default_sample_rate: i32,
}

/// Mono-capture sample rate WinSTT feeds the VAD/engine; the renderer never
/// gates on `defaultSampleRate` so the canonical 16 kHz is faithful.
const WINSTT_CAPTURE_RATE_HZ: i32 = 16_000;
/// Input devices are captured mono.
const WINSTT_INPUT_CHANNELS: i32 = 1;

/// Map cpal's input-device enumeration into the renderer's `AudioDevice` rows.
/// Pure — extracted for unit testing the index/name/default mapping.
fn map_input_devices() -> Vec<AudioDevicePayload> {
    let devices = match list_input_devices() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[devices] list_input_devices failed: {e}");
            return Vec::new();
        }
    };
    // DIAGNOSTIC: log every cpal INPUT device so we can see whether a hot-plugged mic (e.g.
    // a Bluetooth headset) is enumerated. NB: a BT headset's mic exists as an input device
    // ONLY in HFP/Hands-Free mode — in A2DP (music) mode Windows exposes NO mic input, so
    // cpal (correctly) won't list it until it switches to HFP. Logged ONLY when the set
    // CHANGES (see `LAST_LOGGED_DEVICES`) so the many windows that enumerate on mount don't
    // each emit an identical line.
    let signature = devices
        .iter()
        .map(|d| {
            format!(
                "{}:{}{}",
                d.index,
                d.name,
                if d.is_default { "*" } else { "" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    {
        let mut last = LAST_LOGGED_DEVICES
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if last.as_deref() != Some(signature.as_str()) {
            log::info!("[devices] cpal input devices: [{signature}]");
            *last = Some(signature);
        }
    }
    devices
        .into_iter()
        .filter_map(|d| {
            // cpal hands us a string ordinal ("0","1",…); parse to the integer
            // index the renderer expects. A non-numeric id (never happens for
            // cpal enumerate) is dropped rather than mis-indexed.
            d.index.parse::<i32>().ok().map(|index| AudioDevicePayload {
                index,
                name: d.name,
                is_default: d.is_default,
                max_input_channels: WINSTT_INPUT_CHANNELS,
                default_sample_rate: WINSTT_CAPTURE_RATE_HZ,
            })
        })
        .collect()
}

/// `get_audio_devices` — enumerate audio INPUT devices for the renderer's mic
/// pickers + listen-mode device correlation. Returns `[]` on any enumeration
/// failure (the renderer's `useInputDevices` `.catch(() => undefined)` tolerates
/// it and falls back to system-default routing server-side).
#[tauri::command]
#[specta::specta]
pub fn get_audio_devices() -> Vec<AudioDevicePayload> {
    map_input_devices()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_device_serializes_with_spec_keys() {
        let p = AudioDevicePayload {
            index: 2,
            name: "Microphone".into(),
            is_default: false,
            max_input_channels: 1,
            default_sample_rate: 16_000,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("index").and_then(|x| x.as_i64()), Some(2));
        assert!(v.get("isDefault").is_some());
        assert!(v.get("maxInputChannels").is_some());
        assert!(v.get("defaultSampleRate").is_some());
    }
}
