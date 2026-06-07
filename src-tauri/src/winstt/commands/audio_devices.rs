// Reference: spec/openapi.yaml `AudioDevice`,
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

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use cpal::{
    traits::{DeviceTrait, StreamTrait},
    Sample, SizedSample,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

use crate::audio_toolkit::audio::{list_input_devices, list_output_devices};

/// Last device list we logged, so repeated identical enumerations (every window's
/// `useInputDevices` calls this on mount + on device-change events) don't spam the
/// log. We log ONLY when the set changes — which preserves the diagnostic value
/// (a hot-plugged BT mic appearing/disappearing) while killing the dozen-per-startup
/// duplicate lines.
static LAST_LOGGED_DEVICES: Mutex<Option<String>> = Mutex::new(None);
static INPUT_DEVICE_CACHE: Mutex<Option<Vec<AudioDevicePayload>>> = Mutex::new(None);
/// Mirror of `LAST_LOGGED_DEVICES`/`INPUT_DEVICE_CACHE` for the OUTPUT list. Output
/// devices are enumerated alongside inputs by the native endpoint watcher so the
/// renderer's output picker sees a hot-plugged speaker in real time — the same
/// mechanism inputs already use (browser `enumerateDevices()` lags on output
/// hot-plug inside the embedded WebView2, so the picker would otherwise be stale).
static LAST_LOGGED_OUTPUT_DEVICES: Mutex<Option<String>> = Mutex::new(None);
static OUTPUT_DEVICE_CACHE: Mutex<Option<Vec<AudioOutputDevicePayload>>> = Mutex::new(None);

/// One audio input device in the WinSTT spec `AudioDevice` shape (camelCase).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
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
const AUDIO_DEVICES_CHANGED_EVENT: &str = "audio:devices-changed";
const AUDIO_DEVICECHANGE_DETECTED_EVENT: &str = "audio:devicechange-detected";
const AUDIO_OUTPUT_DEVICES_CHANGED_EVENT: &str = "audio:output-devices-changed";
const MICROPHONE_LEVELS_EVENT: &str = "audio:microphone-levels";
const MICROPHONE_LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(80);
static MICROPHONE_LEVEL_MONITOR_STOP: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevicesChangedPayload {
    pub devices: Vec<AudioDevicePayload>,
}

/// One audio OUTPUT device (speakers/headphones) in the renderer's shape.
/// Mirrors `AudioDevicePayload` minus the capture-only fields. Output routing
/// happens in the renderer via `setSinkId(deviceId)`, where `deviceId` is the
/// browser's opaque `MediaDeviceInfo.deviceId` — which the backend can't supply.
/// So the backend provides the authoritative MEMBERSHIP (name + default,
/// reliably refreshed by the native endpoint watcher) and the renderer joins it
/// to the browser's `deviceId` by name. See `use-output-devices.ts`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevicePayload {
    /// cpal positional enumeration ordinal (diagnostic / stable ordering only;
    /// the renderer routes by name→browser-deviceId, not by this index).
    pub index: i32,
    pub name: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevicesChangedPayload {
    pub devices: Vec<AudioOutputDevicePayload>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioDeviceChangeDetectedPayload {}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneLevelMonitorTarget {
    pub id: String,
    pub device_index: Option<i32>,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneLevelEntry {
    pub id: String,
    pub level: f32,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneLevelsPayload {
    pub levels: Vec<MicrophoneLevelEntry>,
}

struct MicrophoneLevelSource {
    device: cpal::Device,
    ids: Vec<String>,
}

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

fn cached_input_devices() -> Option<Vec<AudioDevicePayload>> {
    INPUT_DEVICE_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

fn replace_input_device_cache(devices: Vec<AudioDevicePayload>) -> bool {
    let mut cache = INPUT_DEVICE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let changed = cache.as_ref() != Some(&devices);
    *cache = Some(devices);
    changed
}

/// Map cpal's output-device enumeration into the renderer's output rows. Pure
/// counterpart to `map_input_devices`; logs only when the device set changes.
fn map_output_devices() -> Vec<AudioOutputDevicePayload> {
    let devices = match list_output_devices() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("[devices] list_output_devices failed: {e}");
            return Vec::new();
        }
    };
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
        let mut last = LAST_LOGGED_OUTPUT_DEVICES
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if last.as_deref() != Some(signature.as_str()) {
            log::info!("[devices] cpal output devices: [{signature}]");
            *last = Some(signature);
        }
    }
    devices
        .into_iter()
        .filter_map(|d| {
            d.index
                .parse::<i32>()
                .ok()
                .map(|index| AudioOutputDevicePayload {
                    index,
                    name: d.name,
                    is_default: d.is_default,
                })
        })
        .collect()
}

fn cached_output_devices() -> Option<Vec<AudioOutputDevicePayload>> {
    OUTPUT_DEVICE_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

fn replace_output_device_cache(devices: Vec<AudioOutputDevicePayload>) -> bool {
    let mut cache = OUTPUT_DEVICE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    let changed = cache.as_ref() != Some(&devices);
    *cache = Some(devices);
    changed
}

/// `get_audio_devices` — enumerate audio INPUT devices for the renderer's mic
/// pickers + listen-mode device correlation. Returns `[]` on any enumeration
/// failure (the renderer's `useInputDevices` `.catch(() => undefined)` tolerates
/// it and falls back to system-default routing server-side).
#[tauri::command]
#[specta::specta]
pub fn get_audio_devices() -> Vec<AudioDevicePayload> {
    if let Some(devices) = cached_input_devices() {
        return devices;
    }
    let devices = map_input_devices();
    replace_input_device_cache(devices.clone());
    devices
}

/// `get_audio_output_devices` — enumerate audio OUTPUT devices for the
/// renderer's output picker. Cached like the input list and refreshed in real
/// time by the native endpoint watcher via `refresh_audio_devices_and_emit`.
#[tauri::command]
#[specta::specta]
pub fn get_audio_output_devices() -> Vec<AudioOutputDevicePayload> {
    if let Some(devices) = cached_output_devices() {
        return devices;
    }
    let devices = map_output_devices();
    replace_output_device_cache(devices.clone());
    devices
}

/// Force a fresh OS device enumeration (BOTH input and output), update the
/// backend caches, and notify all renderer windows. Each list's typed payload
/// is emitted only when that list actually changed; the generic devicechange
/// event fires every time so browser-owned selectors can refresh too.
///
/// Output devices are refreshed here — not just inputs — so the renderer's
/// output picker updates the instant a speaker is plugged in, exactly like the
/// input picker. The browser's own `enumerateDevices()` cache lags (or never
/// updates) on output hot-plug inside the embedded WebView2, so this push is
/// what makes the output list real-time.
pub fn refresh_audio_devices_and_emit(app: &AppHandle) -> Vec<AudioDevicePayload> {
    let devices = map_input_devices();
    let input_devices_changed = replace_input_device_cache(devices.clone());

    let output_devices = map_output_devices();
    let output_devices_changed = replace_output_device_cache(output_devices.clone());

    let _ = app.emit(
        AUDIO_DEVICECHANGE_DETECTED_EVENT,
        AudioDeviceChangeDetectedPayload {},
    );
    if input_devices_changed {
        let _ = app.emit(
            AUDIO_DEVICES_CHANGED_EVENT,
            AudioDevicesChangedPayload {
                devices: devices.clone(),
            },
        );
    }
    if output_devices_changed {
        let _ = app.emit(
            AUDIO_OUTPUT_DEVICES_CHANGED_EVENT,
            AudioOutputDevicesChangedPayload {
                devices: output_devices,
            },
        );
    }
    devices
}

/// Force a fresh OS input-device enumeration from the renderer IPC surface.
#[tauri::command]
#[specta::specta]
pub fn refresh_audio_devices(app: AppHandle) -> Vec<AudioDevicePayload> {
    refresh_audio_devices_and_emit(&app)
}

/// Force a fresh OS output-device enumeration from the renderer IPC surface,
/// emit the updated list, and return the refreshed output devices.
#[tauri::command]
#[specta::specta]
pub fn refresh_audio_output_devices(app: AppHandle) -> Vec<AudioOutputDevicePayload> {
    refresh_audio_devices_and_emit(&app);
    cached_output_devices().unwrap_or_default()
}

fn stop_existing_microphone_level_monitor() {
    let mut current = MICROPHONE_LEVEL_MONITOR_STOP
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    if let Some(stop) = current.take() {
        stop.store(true, Ordering::Relaxed);
    }
}

fn resolve_level_source(
    target: &MicrophoneLevelMonitorTarget,
    devices: &[crate::audio_toolkit::CpalDeviceInfo],
) -> Option<(String, cpal::Device)> {
    let selected = match target.device_index {
        Some(index) => devices
            .iter()
            .find(|d| d.index.parse::<i32>().ok() == Some(index)),
        None => devices
            .iter()
            .find(|d| d.is_default)
            .or_else(|| devices.first()),
    }?;
    Some((selected.index.clone(), selected.device.clone()))
}

fn build_level_sources(targets: Vec<MicrophoneLevelMonitorTarget>) -> Vec<MicrophoneLevelSource> {
    let devices = match list_input_devices() {
        Ok(devices) => devices,
        Err(e) => {
            log::warn!("[devices] microphone level monitor could not list inputs: {e}");
            return Vec::new();
        }
    };

    let mut source_positions = HashMap::<String, usize>::new();
    let mut sources = Vec::<MicrophoneLevelSource>::new();
    for target in targets {
        let Some((key, device)) = resolve_level_source(&target, &devices) else {
            log::debug!(
                "[devices] microphone level target '{}' is unavailable",
                target.id
            );
            continue;
        };
        if let Some(index) = source_positions.get(&key).copied() {
            sources[index].ids.push(target.id);
            continue;
        }
        source_positions.insert(key, sources.len());
        sources.push(MicrophoneLevelSource {
            device,
            ids: vec![target.id],
        });
    }
    sources
}

fn compute_microphone_level<T>(data: &[T], channels: usize) -> f32
where
    T: Sample,
    f32: cpal::FromSample<T>,
{
    if data.is_empty() {
        return 0.0;
    }
    let channels = channels.max(1);
    let mut frames = 0usize;
    let mut sum = 0.0f32;
    for frame in data.chunks_exact(channels) {
        let mono = frame
            .iter()
            .map(|&sample| sample.to_sample::<f32>())
            .sum::<f32>()
            / channels as f32;
        sum += mono * mono;
        frames += 1;
    }
    if frames == 0 {
        return 0.0;
    }
    (sum / frames as f32).sqrt().clamp(0.0, 1.0)
}

fn build_level_stream_for_format<T>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    channels: usize,
    ids: Vec<String>,
    levels: Arc<Mutex<HashMap<String, f32>>>,
) -> Result<cpal::Stream, String>
where
    T: Sample + SizedSample + Send + 'static,
    f32: cpal::FromSample<T>,
{
    device
        .build_input_stream(
            &config.clone().into(),
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let level = compute_microphone_level(data, channels);
                let mut guard = levels.lock().unwrap_or_else(|p| p.into_inner());
                for id in &ids {
                    guard.insert(id.clone(), level);
                }
            },
            |err| log::debug!("[devices] microphone level stream error: {err}"),
            None,
        )
        .map_err(|e| e.to_string())
}

fn build_level_stream(
    source: MicrophoneLevelSource,
    levels: Arc<Mutex<HashMap<String, f32>>>,
) -> Result<cpal::Stream, String> {
    let config = source
        .device
        .default_input_config()
        .map_err(|e| e.to_string())?;
    let channels = usize::from(config.channels());
    match config.sample_format() {
        cpal::SampleFormat::U8 => build_level_stream_for_format::<u8>(
            &source.device,
            &config,
            channels,
            source.ids,
            levels,
        ),
        cpal::SampleFormat::I8 => build_level_stream_for_format::<i8>(
            &source.device,
            &config,
            channels,
            source.ids,
            levels,
        ),
        cpal::SampleFormat::I16 => build_level_stream_for_format::<i16>(
            &source.device,
            &config,
            channels,
            source.ids,
            levels,
        ),
        cpal::SampleFormat::I32 => build_level_stream_for_format::<i32>(
            &source.device,
            &config,
            channels,
            source.ids,
            levels,
        ),
        cpal::SampleFormat::F32 => build_level_stream_for_format::<f32>(
            &source.device,
            &config,
            channels,
            source.ids,
            levels,
        ),
        sample_format => Err(format!("Unsupported sample format: {sample_format:?}")),
    }
}

fn emit_microphone_levels(
    app: &AppHandle,
    ids: &[String],
    levels: &Arc<Mutex<HashMap<String, f32>>>,
) {
    let snapshot = {
        let guard = levels.lock().unwrap_or_else(|p| p.into_inner());
        ids.iter()
            .map(|id| MicrophoneLevelEntry {
                id: id.clone(),
                level: guard.get(id).copied().unwrap_or(0.0),
            })
            .collect::<Vec<_>>()
    };
    let _ = app.emit(
        MICROPHONE_LEVELS_EVENT,
        MicrophoneLevelsPayload { levels: snapshot },
    );
}

fn run_microphone_level_monitor(
    app: AppHandle,
    targets: Vec<MicrophoneLevelMonitorTarget>,
    stop: Arc<AtomicBool>,
) {
    let ids = targets.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
    let levels = Arc::new(Mutex::new(HashMap::<String, f32>::new()));
    {
        let mut guard = levels.lock().unwrap_or_else(|p| p.into_inner());
        for id in &ids {
            guard.insert(id.clone(), 0.0);
        }
    }

    let mut streams = Vec::<cpal::Stream>::new();
    for source in build_level_sources(targets) {
        match build_level_stream(source, levels.clone()).and_then(|stream| {
            stream.play().map_err(|e| e.to_string())?;
            Ok(stream)
        }) {
            Ok(stream) => streams.push(stream),
            Err(e) => log::debug!("[devices] microphone level stream unavailable: {e}"),
        }
    }

    while !stop.load(Ordering::Relaxed) {
        thread::sleep(MICROPHONE_LEVEL_EMIT_INTERVAL);
        emit_microphone_levels(&app, &ids, &levels);
    }

    drop(streams);
}

/// Start short-lived per-row microphone level sampling for the detached picker.
/// The monitor is global and picker-scoped: starting a new one stops the old
/// stream set, and callers should stop it as soon as the popup unmounts.
#[tauri::command]
#[specta::specta]
pub fn start_microphone_level_monitor(app: AppHandle, targets: Vec<MicrophoneLevelMonitorTarget>) {
    stop_existing_microphone_level_monitor();
    if targets.is_empty() {
        return;
    }

    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut current = MICROPHONE_LEVEL_MONITOR_STOP
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        *current = Some(stop.clone());
    }
    thread::spawn(move || run_microphone_level_monitor(app, targets, stop));
}

/// Stop the picker-scoped microphone level monitor and release every CPAL input
/// stream it opened.
#[tauri::command]
#[specta::specta]
pub fn stop_microphone_level_monitor() {
    stop_existing_microphone_level_monitor();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_device(index: i32, name: &str) -> AudioDevicePayload {
        AudioDevicePayload {
            index,
            name: name.into(),
            is_default: index == 0,
            max_input_channels: WINSTT_INPUT_CHANNELS,
            default_sample_rate: WINSTT_CAPTURE_RATE_HZ,
        }
    }

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

    #[test]
    fn replace_input_device_cache_reports_only_real_list_changes() {
        {
            let mut cache = INPUT_DEVICE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
            *cache = None;
        }

        let original = vec![sample_device(0, "Built-in Mic")];
        assert!(replace_input_device_cache(original.clone()));
        assert!(!replace_input_device_cache(original));

        let changed = vec![
            sample_device(0, "Built-in Mic"),
            sample_device(1, "Bluetooth Headset Mic"),
        ];
        assert!(replace_input_device_cache(changed));
    }

    fn sample_output(index: i32, name: &str) -> AudioOutputDevicePayload {
        AudioOutputDevicePayload {
            index,
            name: name.into(),
            is_default: index == 0,
        }
    }

    #[test]
    fn audio_output_device_serializes_with_spec_keys() {
        let p = sample_output(1, "Speakers");
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v.get("index").and_then(|x| x.as_i64()), Some(1));
        assert_eq!(v.get("name").and_then(|x| x.as_str()), Some("Speakers"));
        assert!(v.get("isDefault").is_some());
    }

    #[test]
    fn replace_output_device_cache_reports_only_real_list_changes() {
        {
            let mut cache = OUTPUT_DEVICE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
            *cache = None;
        }

        let original = vec![sample_output(0, "Speakers (Realtek)")];
        assert!(replace_output_device_cache(original.clone()));
        assert!(!replace_output_device_cache(original));

        let changed = vec![
            sample_output(0, "Speakers (Realtek)"),
            sample_output(1, "USB Headphones"),
        ];
        assert!(replace_output_device_cache(changed));
    }
}
