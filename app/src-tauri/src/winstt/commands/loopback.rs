// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/10_frontend_port_plan.md
// (WU-9 §6 — "add loopback device-list"), lib_wiring.md §3/§4b,
// server/src/stt_server/control_handler.py `_handle_list_loopback_devices` +
// server/src/stt_server/loopback.py `LoopbackCapture.list_devices`. Wraps
// `winstt::loopback::LoopbackCapture::list_devices`.
//
// `loopback_list_devices` is the MISSING command the WinSTT renderer's listen-mode
// slice calls (`IPC.LOOPBACK_LIST_DEVICES` → adapter → `loopback_list_devices`).
// The renderer (`features/listen-mode/api/use-loopback-devices.ts` +
// `use-listen-mode.ts`) validates each row against the Zod shape:
//
//     { index: int, name: string, defaultSampleRate: number,
//       maxOutputChannels: number, isDefault?: bool }
//
// so this command emits EXACTLY that shape (byte-identical to the Electron
// server's `list_loopback_devices` response `value`). The numeric `index` is the
// positional ordinal of the device in the enumeration — the same integer the
// renderer hands back to `loopback:start` (→ `start_listen { deviceIndex }`),
// which `listen::start_listen` maps back to a WASAPI endpoint id via the same
// enumeration order.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::winstt::loopback::LoopbackCapture;

/// One loopback-capable output device, in the renderer's expected shape.
///
/// `index` is the positional ordinal in the WASAPI render-device enumeration
/// (NOT a PyAudio host-API index — there's no PyAudio here). `start_listen`
/// resolves it back to the endpoint id by re-enumerating in the same order.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoopbackDevicePayload {
    pub index: i32,
    pub name: String,
    /// WASAPI render endpoints are mixed at 48 kHz on Windows; the renderer only
    /// displays this and never gates on it, so a fixed default is faithful to the
    /// shared-mode mix the loopback capture actually sees.
    pub default_sample_rate: f64,
    /// Loopback capture mirrors the render mix as 2-channel; the renderer only
    /// uses this for display.
    pub max_output_channels: i32,
    pub is_default: bool,
}

/// Default shared-mode mix rate (Hz) WASAPI exposes for render endpoints.
const WASAPI_SHARED_MIX_RATE_HZ: f64 = 48_000.0;
/// Render endpoints surface a stereo mix in shared mode.
const WASAPI_RENDER_CHANNELS: i32 = 2;

/// Map the loopback-capture enumeration into the renderer's device-row shape,
/// assigning each device its positional `index`. Pure — extracted so the
/// index↔endpoint mapping can be reused by `start_listen` and unit-tested.
pub fn enumerate_loopback_devices() -> Vec<LoopbackDevicePayload> {
    let raw = LoopbackCapture::list_devices().unwrap_or_default();
    raw.into_iter()
        .enumerate()
        .map(|(i, d)| LoopbackDevicePayload {
            index: i as i32,
            name: d.name,
            default_sample_rate: WASAPI_SHARED_MIX_RATE_HZ,
            max_output_channels: WASAPI_RENDER_CHANNELS,
            is_default: d.is_default,
        })
        .collect()
}

/// Resolve a numeric loopback `device_index` (positional, as handed out by
/// [`enumerate_loopback_devices`]) back to its display name. Returns `None` when
/// the index is out of range (stale list — the renderer re-fetches on the next
/// listen-mode entry). Used by `start_listen` to label the `loopback_started`
/// event's `deviceName`.
pub fn resolve_loopback_device_name(device_index: i32) -> Option<String> {
    enumerate_loopback_devices()
        .into_iter()
        .find(|d| d.index == device_index)
        .map(|d| d.name)
}

/// `loopback_list_devices` — enumerate WASAPI loopback-capable output devices for
/// the listen-mode device picker. Mirrors the Electron server's
/// `list_loopback_devices` command (returns `[]` on any failure so the renderer's
/// `.catch` / non-array guard never trips). Off the UI thread is unnecessary —
/// WASAPI enumeration is sub-millisecond — but errors are swallowed to `[]`.
#[tauri::command]
#[specta::specta]
pub fn loopback_list_devices() -> Vec<LoopbackDevicePayload> {
    enumerate_loopback_devices()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_payload_is_camel_case() {
        // The renderer's Zod schema keys are camelCase — confirm serde renames.
        let p = LoopbackDevicePayload {
            index: 0,
            name: "Speakers".into(),
            default_sample_rate: 48_000.0,
            max_output_channels: 2,
            is_default: true,
        };
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("defaultSampleRate").is_some());
        assert!(v.get("maxOutputChannels").is_some());
        assert!(v.get("isDefault").is_some());
        assert_eq!(v.get("index").and_then(|x| x.as_i64()), Some(0));
    }

    #[test]
    fn resolve_out_of_range_index_is_none() {
        // On a CI box with no audio devices the enumeration is empty; any index
        // is out of range → None (the documented stale-list degrade).
        assert_eq!(resolve_loopback_device_name(9999), None);
    }
}
