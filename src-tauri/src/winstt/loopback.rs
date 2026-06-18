// WASAPI system-audio loopback capture for Listen mode.
//
// Source of truth: server/src/stt_server/loopback.py (LoopbackCapture + slow-tracking AGC).
// Listen mode transcribes SYSTEM audio (a call, a YouTube lecture), not the mic. cpal (the
// capture lib) cannot capture the render endpoint on Windows, so we open the default RENDER device
// in WASAPI shared-mode loopback (render device + `Direction::Capture` in `initialize_client` — a
// combination the `wasapi` crate explicitly supports), pull blocks on the WASAPI event handle,
// fold to mono, run the slow-tracking AGC (in the int16 domain, bit-faithful to the Python so the
// downstream VAD endpoint behaves identically), resample to 16 kHz, and push f32 frames onto a
// channel that the `LoopbackManager` VAD-gates + transcribes.
//
// THREADING: the capture loop owns a daemon thread; `start()` is non-blocking (it spawns the
// thread and returns) so it never stalls the Tauri async command loop — the exact antipattern
// the project memory warns about for `start_loopback`. `stop()` flips an atomic + joins (bounded
// by the 200 ms WASAPI event-wait timeout).
//
// PORTABILITY: the WASAPI capture thread + COM init are gated `#[cfg(windows)]`.
// The SlowTrackingAgc, the multichannel→mono fold, and the channel plumbing are platform-agnostic
// and unit-tested everywhere.

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
#[cfg(windows)]
use std::sync::Arc;
#[cfg(windows)]
use std::thread::JoinHandle;

// ═════════════════════════════════════════════════════════════════════════════
// 1. Slow-tracking AGC — verbatim port of loopback.py constants (int16 domain).
//    Peak is measured as |sample| in int16, exactly like the Python, so the
//    VAD-endpoint behaviour is bit-faithful.
// ═════════════════════════════════════════════════════════════════════════════

/// Target peak amplitude (out of 32768).
pub const TARGET_PEAK: f32 = 8000.0;
/// Maximum amplification factor.
pub const MAX_GAIN: f32 = 30.0;
/// Below this int16 peak a block is treated as silence (gain decays, no amplify).
pub const NOISE_FLOOR: f32 = 50.0;
/// EMA smoothing factor (slow-tracking).
pub const GAIN_SMOOTH: f32 = 0.05;

/// Slow-tracking automatic gain control. Holds one running `gain` across blocks.
///
/// Per block (int16-domain peak):
/// * `peak > NOISE_FLOOR` → `desired = min(TARGET_PEAK/peak, MAX_GAIN)`,
///   `gain += GAIN_SMOOTH*(desired-gain)`; if `gain > 1.0`, scale + clip to i16.
/// * else (silence) → `gain += GAIN_SMOOTH*(1.0-gain)`; PASS THROUGH unamplified.
///
/// The silence branch is LOAD-BEARING: holding speech-time gain over trailing
/// silence multiplies room noise by up to `MAX_GAIN`, pinning the VAD at "speech"
/// forever so Listen mode never reaches its silence endpoint. Decaying toward
/// unity (and never amplifying sub-floor audio) is what lets the VAD gate.
#[derive(Debug, Clone)]
pub struct SlowTrackingAgc {
    gain: f32,
}

impl Default for SlowTrackingAgc {
    fn default() -> Self {
        SlowTrackingAgc { gain: 1.0 }
    }
}

impl SlowTrackingAgc {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.gain = 1.0;
    }

    pub fn gain(&self) -> f32 {
        self.gain
    }

    /// Apply AGC in place on a 16-bit-domain block (peak measured as |sample|).
    pub fn process(&mut self, samples: &mut [i16]) {
        let peak = samples
            .iter()
            .map(|&s| (s as f32).abs())
            .fold(0.0f32, f32::max);
        if peak > NOISE_FLOOR {
            let desired = (TARGET_PEAK / peak).min(MAX_GAIN);
            self.gain += GAIN_SMOOTH * (desired - self.gain);
            if self.gain > 1.0 {
                for s in samples.iter_mut() {
                    let scaled = (*s as f32) * self.gain;
                    *s = scaled.clamp(-32768.0, 32767.0) as i16;
                }
            }
        } else {
            // Silence: decay gain toward unity, pass through un-amplified.
            self.gain += GAIN_SMOOTH * (1.0 - self.gain);
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Channel folding — interleaved multichannel → mono.
//    Matches Python's reshape(-1, channels) + feed_audio's mono fold.
// ═════════════════════════════════════════════════════════════════════════════

/// Average `channels`-interleaved i16 frames into mono i16. A trailing partial
/// frame (len not a multiple of `channels`) is dropped (matches numpy reshape).
pub fn interleaved_to_mono_i16(interleaved: &[i16], channels: usize) -> Vec<i16> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let frames = interleaved.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * channels;
        let sum: i32 = interleaved[base..base + channels]
            .iter()
            .map(|&s| s as i32)
            .sum();
        out.push((sum / channels as i32) as i16);
    }
    out
}

/// Average `channels`-interleaved f32 PCM frames into mono i16 (scale + clip).
/// WASAPI shared-mode render is normally 32-bit float in [-1, 1].
pub fn interleaved_f32_to_mono_i16(interleaved: &[f32], channels: usize) -> Vec<i16> {
    let channels = channels.max(1);
    let frames = interleaved.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * channels;
        let sum: f32 = interleaved[base..base + channels].iter().copied().sum();
        let mono = sum / channels as f32;
        let scaled = (mono * 32768.0).clamp(-32768.0, 32767.0);
        out.push(scaled as i16);
    }
    out
}

/// Convert an int16 PCM block to f32 in [-1, 1] (the domain the recorder/VAD/
/// transcriber pipeline consumes). Inverse of the `* 32768` scale above.
pub fn i16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples.iter().map(|&s| s as f32 / 32768.0).collect()
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Device + capture types.
// ═════════════════════════════════════════════════════════════════════════════

/// A loopback-capable output (render) device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackDeviceInfo {
    /// Stable id (the WASAPI endpoint id string).
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Resolved info for the device a capture session started on.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
}

/// Errors from the loopback subsystem.
#[derive(Debug, thiserror::Error)]
pub enum LoopbackError {
    #[error("loopback is only supported on Windows")]
    Unsupported,
    #[error("loopback backend error: {0}")]
    Backend(String),
    #[error("capture already active")]
    AlreadyActive,
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. LoopbackCapture — owns the WASAPI capture thread.
//
//    The captured 16 kHz mono f32 frames are pushed onto `sink` (the manager's
//    `mpsc::Sender<Vec<f32>>`); the manager side VAD-gates + transcribes them.
//    A standalone source (mirrors WinSTT's FileAudioSource) rather than editing
//    recorder path.
// ═════════════════════════════════════════════════════════════════════════════

#[derive(Default)]
pub struct LoopbackCapture {
    #[cfg(windows)]
    stop: Arc<AtomicBool>,
    #[cfg(windows)]
    worker: Option<JoinHandle<()>>,
}

impl LoopbackCapture {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_active(&self) -> bool {
        #[cfg(windows)]
        {
            self.worker.is_some()
        }
        #[cfg(not(windows))]
        {
            false
        }
    }

    /// Open the selected render endpoint in WASAPI loopback, AGC each
    /// block, resample to 16 kHz mono, and push f32 frames onto `sink`. Returns
    /// the resolved [`DeviceInfo`] synchronously so the caller surfaces
    /// device-open errors before capture is marked active.
    ///
    /// `device_id == None` uses the default render device. Serialize start/stop
    /// in the manager (concurrent WASAPI start/stop crash the audio backend).
    #[cfg(windows)]
    pub fn start(
        &mut self,
        device_id: Option<String>,
        sink: Sender<Vec<f32>>,
    ) -> Result<DeviceInfo, LoopbackError> {
        if self.is_active() {
            return Err(LoopbackError::AlreadyActive);
        }

        let info = windows_impl::resolve_render_device(device_id.as_deref())
            .map_err(|e| LoopbackError::Backend(format!("resolve render device: {e}")))?;
        self.stop.store(false, Ordering::SeqCst);
        let stop = self.stop.clone();
        let capture_device_id = device_id;
        let capture_info = info.clone();
        let thread_stop = stop;
        let worker = std::thread::Builder::new()
            .name("loopback-capture".into())
            .spawn(move || {
                if let Err(err) = windows_impl::capture_loop(
                    capture_device_id.as_deref(),
                    capture_info,
                    sink,
                    thread_stop.clone(),
                ) {
                    if !thread_stop.load(Ordering::SeqCst) {
                        log::error!("[loopback] WASAPI capture failed: {err}");
                    }
                }
            })
            .map_err(|e| LoopbackError::Backend(format!("spawn capture thread: {e}")))?;
        log::info!(
            "[loopback] WASAPI loopback stream started device='{}' rate={} channels={}",
            info.name,
            info.sample_rate,
            info.channels,
        );
        self.worker = Some(worker);
        Ok(info)
    }

    #[cfg(not(windows))]
    pub fn start(
        &mut self,
        _device_id: Option<String>,
        _sink: Sender<Vec<f32>>,
    ) -> Result<DeviceInfo, LoopbackError> {
        Err(LoopbackError::Unsupported)
    }

    /// Stop capture by signaling the WASAPI thread and joining it.
    pub fn stop(&mut self) {
        #[cfg(windows)]
        {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    /// Enumerate loopback-capable (render) devices.
    #[cfg(windows)]
    pub fn list_devices() -> Result<Vec<LoopbackDeviceInfo>, LoopbackError> {
        windows_impl::list_render_devices()
            .map_err(|e| LoopbackError::Backend(format!("list render devices: {e}")))
    }

    #[cfg(not(windows))]
    pub fn list_devices() -> Result<Vec<LoopbackDeviceInfo>, LoopbackError> {
        Ok(Vec::new())
    }
}

impl Drop for LoopbackCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Windows WASAPI implementation.
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(any())]
mod cpal_loopback {
    use super::*;
    use std::time::Duration;

    use cpal::traits::{DeviceTrait, HostTrait};
    use cpal::{FromSample, Sample, SizedSample};

    use crate::audio_toolkit::audio::FrameResampler;
    use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;

    /// Resampler frame size (matches the recorder's 30 ms emit cadence so the
    /// downstream Silero VAD receives whole 30 ms / 480-sample frames).
    const RESAMPLER_FRAME_MS: u64 = 30;

    pub struct SelectedOutputDevice {
        pub id: String,
        pub name: String,
        pub device: cpal::Device,
    }

    struct EnumeratedOutputDevice {
        id: String,
        name: String,
        is_default: bool,
        device: cpal::Device,
    }

    fn backend_error(label: &str, err: impl std::fmt::Display) -> LoopbackError {
        LoopbackError::Backend(format!("{label}: {err}"))
    }

    fn enumerate_output_devices() -> Result<Vec<EnumeratedOutputDevice>, LoopbackError> {
        let host = crate::audio_toolkit::get_cpal_host();
        let default_name = host
            .default_output_device()
            .and_then(|d| crate::audio_toolkit::audio::device_display_name(&d).ok());
        let devices = host
            .output_devices()
            .map_err(|e| backend_error("enumerate output devices", e))?;

        Ok(devices
            .enumerate()
            .map(|(index, device)| {
                let name = crate::audio_toolkit::audio::device_display_name(&device)
                    .unwrap_or_else(|_| "System Audio".to_string());
                let is_default = Some(name.clone()) == default_name;
                EnumeratedOutputDevice {
                    id: index.to_string(),
                    name,
                    is_default,
                    device,
                }
            })
            .collect())
    }

    pub fn list_output_devices() -> Result<Vec<LoopbackDeviceInfo>, LoopbackError> {
        Ok(enumerate_output_devices()?
            .into_iter()
            .map(|device| LoopbackDeviceInfo {
                id: device.id,
                name: device.name,
                is_default: device.is_default,
            })
            .collect())
    }

    pub fn resolve_output_device(
        device_id: Option<&str>,
    ) -> Result<SelectedOutputDevice, LoopbackError> {
        let mut devices = enumerate_output_devices()?;
        if let Some(target) = device_id {
            if let Some(index) = devices
                .iter()
                .position(|device| device.id == target || device.name == target)
            {
                let selected = devices.remove(index);
                return Ok(SelectedOutputDevice {
                    id: selected.id,
                    name: selected.name,
                    device: selected.device,
                });
            }
            log::warn!("[loopback] output device id/name '{target}' not found; using default");
        }

        let selected = devices
            .iter()
            .position(|device| device.is_default)
            .or(if devices.is_empty() { None } else { Some(0) })
            .map(|index| devices.remove(index))
            .ok_or_else(|| LoopbackError::Backend("no output devices available".to_string()))?;
        Ok(SelectedOutputDevice {
            id: selected.id,
            name: selected.name,
            device: selected.device,
        })
    }

    pub fn build_loopback_stream(
        device: &cpal::Device,
        config: &cpal::SupportedStreamConfig,
        sink: Sender<Vec<f32>>,
    ) -> Result<cpal::Stream, LoopbackError> {
        match config.sample_format() {
            cpal::SampleFormat::U8 => build_loopback_stream_for_format::<u8>(device, config, sink),
            cpal::SampleFormat::I8 => build_loopback_stream_for_format::<i8>(device, config, sink),
            cpal::SampleFormat::I16 => {
                build_loopback_stream_for_format::<i16>(device, config, sink)
            }
            cpal::SampleFormat::I32 => {
                build_loopback_stream_for_format::<i32>(device, config, sink)
            }
            cpal::SampleFormat::F32 => {
                build_loopback_stream_for_format::<f32>(device, config, sink)
            }
            other => Err(LoopbackError::Backend(format!(
                "unsupported loopback sample format {other:?}"
            ))),
        }
    }

    fn build_loopback_stream_for_format<T>(
        device: &cpal::Device,
        config: &cpal::SupportedStreamConfig,
        sink: Sender<Vec<f32>>,
    ) -> Result<cpal::Stream, LoopbackError>
    where
        T: Sample + SizedSample + Send + 'static,
        f32: FromSample<T>,
    {
        let channels = config.channels() as usize;
        let device_rate = config.sample_rate() as usize;
        let mut agc = SlowTrackingAgc::new();
        let mut resampler = FrameResampler::try_new(
            device_rate,
            WHISPER_SAMPLE_RATE as usize,
            Duration::from_millis(RESAMPLER_FRAME_MS),
        )
        .map_err(LoopbackError::Backend)?;
        let mut send_closed = false;

        let stream_cb = move |data: &[T], _: &cpal::InputCallbackInfo| {
            if send_closed {
                return;
            }

            let mut mono = samples_to_mono_i16(data, channels);
            agc.process(&mut mono);
            let device_f32 = i16_to_f32(&mono);
            resampler.push(&device_f32, |frame: &[f32]| {
                if send_closed {
                    return;
                }
                if sink.send(frame.to_vec()).is_err() {
                    send_closed = true;
                }
            });
        };

        device
            .build_input_stream(
                &config.clone().into(),
                stream_cb,
                |err| log::error!("[loopback] CPAL stream error: {err}"),
                None,
            )
            .map_err(|e| backend_error("build CPAL loopback stream", e))
    }

    fn samples_to_mono_i16<T>(data: &[T], channels: usize) -> Vec<i16>
    where
        T: Sample,
        f32: FromSample<T>,
    {
        let channels = channels.max(1);
        if channels == 1 {
            return data.iter().map(|&sample| sample_to_i16(sample)).collect();
        }

        data.chunks_exact(channels)
            .map(|frame| {
                let mono = frame
                    .iter()
                    .map(|&sample| sample.to_sample::<f32>())
                    .sum::<f32>()
                    / channels as f32;
                f32_to_i16(mono)
            })
            .collect()
    }

    fn sample_to_i16<T>(sample: T) -> i16
    where
        T: Sample,
        f32: FromSample<T>,
    {
        f32_to_i16(sample.to_sample::<f32>())
    }

    fn f32_to_i16(sample: f32) -> i16 {
        (sample * 32768.0).clamp(-32768.0, 32767.0) as i16
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::collections::VecDeque;
    use std::time::Duration;

    use crate::audio_toolkit::audio::FrameResampler;
    use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;
    use wasapi::{deinitialize, initialize_mta, Direction, SampleType, StreamMode};

    /// Buffer duration requested from WASAPI (hundred-nanosecond units). 200 ms
    /// shared-mode buffer keeps the event wait responsive to `stop`.
    const BUFFER_DURATION_HNS: i64 = 2_000_000; // 200 ms in 100-ns ticks.
    /// Event-wait timeout per loop iteration (ms) — bounds stop latency.
    const EVENT_TIMEOUT_MS: u32 = 200;
    /// Resampler frame size (matches the recorder's 30 ms emit cadence so the
    /// downstream Silero VAD receives whole 30 ms / 480-sample frames).
    const RESAMPLER_FRAME_MS: u64 = 30;

    /// RAII COM-apartment guard. `initialize_mta()` returns an `HRESULT`; we only
    /// pair a `deinitialize()` with an init that actually entered the apartment
    /// (`S_OK`/`S_FALSE`). `RPC_E_CHANGED_MODE` means another lib already put this
    /// thread in an STA — WASAPI still works there, but we must NOT `deinitialize`
    /// an apartment we didn't enter.
    struct ComGuard {
        owned: bool,
    }

    impl ComGuard {
        fn enter() -> Self {
            // HRESULT::ok() → Ok(()) on S_OK/S_FALSE, Err otherwise (incl.
            // RPC_E_CHANGED_MODE when the thread is already STA).
            let owned = initialize_mta().ok().is_ok();
            ComGuard { owned }
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.owned {
                deinitialize();
            }
        }
    }

    /// Resolve the default (or named) render device into [`DeviceInfo`] without
    /// starting capture. Used by `start` to surface device errors synchronously.
    pub fn resolve_render_device(device_id: Option<&str>) -> anyhow::Result<DeviceInfo> {
        let _com = ComGuard::enter();
        let enumerator = wasapi::DeviceEnumerator::new()
            .map_err(|e| anyhow::anyhow!("DeviceEnumerator::new: {e:?}"))?;
        let device = open_device(&enumerator, device_id)?;
        let id = device
            .get_id()
            .map_err(|e| anyhow::anyhow!("device id: {e:?}"))?;
        let name = device
            .get_friendlyname()
            .unwrap_or_else(|_| "System Audio".to_string());
        let client = device
            .get_iaudioclient()
            .map_err(|e| anyhow::anyhow!("get_iaudioclient: {e:?}"))?;
        let format = client
            .get_mixformat()
            .map_err(|e| anyhow::anyhow!("get_mixformat: {e:?}"))?;
        Ok(DeviceInfo {
            id,
            name,
            sample_rate: format.get_samplespersec(),
            channels: format.get_nchannels(),
        })
    }

    /// Open the default render device, or the one matching `device_id`.
    fn open_device(
        enumerator: &wasapi::DeviceEnumerator,
        device_id: Option<&str>,
    ) -> anyhow::Result<wasapi::Device> {
        if let Some(target) = device_id {
            // get_device resolves an endpoint by its WASAPI id string directly.
            match enumerator.get_device(target) {
                Ok(dev) => return Ok(dev),
                Err(e) => log::warn!(
                    "[loopback] device id {target} not found ({e:?}); using default render"
                ),
            }
        }
        enumerator
            .get_default_device(&Direction::Render)
            .map_err(|e| anyhow::anyhow!("get_default_device(Render): {e:?}"))
    }

    /// List render endpoints (the loopback-capable outputs).
    pub fn list_render_devices() -> anyhow::Result<Vec<LoopbackDeviceInfo>> {
        let _com = ComGuard::enter();
        let enumerator = wasapi::DeviceEnumerator::new()
            .map_err(|e| anyhow::anyhow!("DeviceEnumerator::new: {e:?}"))?;
        let default_id = enumerator
            .get_default_device(&Direction::Render)
            .ok()
            .and_then(|d| d.get_id().ok());
        let collection = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(|e| anyhow::anyhow!("get_device_collection(Render): {e:?}"))?;
        let mut out = Vec::new();
        for idx in 0..collection.get_nbr_devices().unwrap_or(0) {
            if let Ok(dev) = collection.get_device_at_index(idx) {
                let id = dev.get_id().unwrap_or_default();
                let name = dev.get_friendlyname().unwrap_or_else(|_| "Output".into());
                let is_default = default_id.as_deref() == Some(id.as_str());
                out.push(LoopbackDeviceInfo {
                    id,
                    name,
                    is_default,
                });
            }
        }
        Ok(out)
    }

    /// The capture thread body. Opens the render device in LOOPBACK mode (render
    /// device + `Direction::Capture` in `initialize_client`), drains blocks on the
    /// WASAPI event, folds to mono i16, AGCs (int16 domain — Python parity), then
    /// resamples to 16 kHz and pushes f32 frames to `sink`.
    pub fn capture_loop(
        device_id: Option<&str>,
        _info: DeviceInfo,
        sink: Sender<Vec<f32>>,
        stop: Arc<AtomicBool>,
    ) -> anyhow::Result<()> {
        let _com = ComGuard::enter();

        let enumerator = wasapi::DeviceEnumerator::new()
            .map_err(|e| anyhow::anyhow!("DeviceEnumerator::new: {e:?}"))?;
        let device = open_device(&enumerator, device_id)?;
        let mut client = device
            .get_iaudioclient()
            .map_err(|e| anyhow::anyhow!("get_iaudioclient: {e:?}"))?;
        let format = client
            .get_mixformat()
            .map_err(|e| anyhow::anyhow!("get_mixformat: {e:?}"))?;

        let channels = format.get_nchannels() as usize;
        let device_rate = format.get_samplespersec();
        // WASAPI shared render is normally float32; honour whatever the mix
        // format actually reports.
        let sample_type = format.get_subformat().unwrap_or(SampleType::Float);
        let bytes_per_sample = (format.get_bitspersample() / 8) as usize;
        let block_align = bytes_per_sample * channels;

        // LOOPBACK: render device opened with Direction::Capture (a combo the
        // wasapi crate maps to AUDCLNT_STREAMFLAGS_LOOPBACK). autoconvert lets
        // WASAPI hand us the mix format directly.
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: BUFFER_DURATION_HNS,
        };
        client
            .initialize_client(&format, &Direction::Capture, &mode)
            .map_err(|e| anyhow::anyhow!("initialize_client(loopback): {e:?}"))?;

        let h_event = client
            .set_get_eventhandle()
            .map_err(|e| anyhow::anyhow!("set_get_eventhandle: {e:?}"))?;
        let capture = client
            .get_audiocaptureclient()
            .map_err(|e| anyhow::anyhow!("get_audiocaptureclient: {e:?}"))?;

        client
            .start_stream()
            .map_err(|e| anyhow::anyhow!("start_stream: {e:?}"))?;

        // AGC runs at the device rate in int16 (Python parity), BEFORE resampling.
        let mut agc = SlowTrackingAgc::new();
        // Resample device-rate mono → 16 kHz mono, emitting 30 ms frames.
        let mut resampler = FrameResampler::try_new(
            device_rate as usize,
            WHISPER_SAMPLE_RATE as usize,
            Duration::from_millis(RESAMPLER_FRAME_MS),
        )
        .map_err(|err| anyhow::anyhow!(err))?;

        let mut raw: VecDeque<u8> = VecDeque::new();
        let mut consecutive_errors = 0u32;
        const MAX_ERRORS: u32 = 5;

        let result = (|| -> anyhow::Result<()> {
            while !stop.load(Ordering::SeqCst) {
                // Drain all currently-available bytes into `raw`.
                match capture.read_from_device_to_deque(&mut raw) {
                    Ok(_) => consecutive_errors = 0,
                    Err(e) => {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        consecutive_errors += 1;
                        log::warn!(
                            "[loopback] read error ({consecutive_errors}/{MAX_ERRORS}): {e:?}"
                        );
                        if consecutive_errors >= MAX_ERRORS {
                            anyhow::bail!("too many consecutive capture errors");
                        }
                    }
                }

                // Convert whole frames out of the byte deque.
                if let Some(frames) = raw.len().checked_div(block_align) {
                    let usable = frames * block_align;
                    if usable > 0 {
                        let bytes: Vec<u8> = raw.drain(0..usable).collect();
                        let mut mono =
                            bytes_to_mono_i16(&bytes, channels, sample_type, bytes_per_sample);
                        // AGC at device rate, int16 domain (Python parity).
                        agc.process(&mut mono);
                        // int16 → f32 [-1, 1], then resample to 16 kHz mono in
                        // 30 ms frames and forward to the consumer.
                        let device_f32 = i16_to_f32(&mono);
                        let mut send_err = false;
                        resampler.push(&device_f32, &mut |frame: &[f32]| {
                            if send_err {
                                return;
                            }
                            if sink.send(frame.to_vec()).is_err() {
                                send_err = true;
                            }
                        });
                        if send_err {
                            // Consumer gone → end the session.
                            break;
                        }
                    }
                }

                // Wait for the next buffer-ready event (bounded → stop-responsive).
                if h_event.wait_for_event(EVENT_TIMEOUT_MS).is_err() {
                    // Timeout is normal during silence; loop re-checks `stop`.
                    continue;
                }
            }
            Ok(())
        })();

        // Flush any partially-buffered resampler tail before tearing down.
        resampler.finish(&mut |frame: &[f32]| {
            let _ = sink.send(frame.to_vec());
        });
        let _ = client.stop_stream();
        result
    }

    /// Decode a byte buffer of interleaved PCM into mono i16, honouring the
    /// WASAPI sample type (float32 or int16/int32).
    fn bytes_to_mono_i16(
        bytes: &[u8],
        channels: usize,
        sample_type: SampleType,
        bytes_per_sample: usize,
    ) -> Vec<i16> {
        match sample_type {
            SampleType::Float => {
                // 32-bit float interleaved.
                let mut interleaved = Vec::with_capacity(bytes.len() / 4);
                for chunk in bytes.chunks_exact(4) {
                    interleaved.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
                }
                interleaved_f32_to_mono_i16(&interleaved, channels)
            }
            SampleType::Int => {
                if bytes_per_sample == 2 {
                    let mut interleaved = Vec::with_capacity(bytes.len() / 2);
                    for chunk in bytes.chunks_exact(2) {
                        interleaved.push(i16::from_le_bytes([chunk[0], chunk[1]]));
                    }
                    interleaved_to_mono_i16(&interleaved, channels)
                } else if bytes_per_sample == 4 {
                    // 32-bit int → top 16 bits.
                    let mut interleaved = Vec::with_capacity(bytes.len() / 4);
                    for chunk in bytes.chunks_exact(4) {
                        let v = i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                        interleaved.push((v >> 16) as i16);
                    }
                    interleaved_to_mono_i16(&interleaved, channels)
                } else {
                    Vec::new()
                }
            }
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Tests — AGC + channel folding (the platform-agnostic arithmetic).
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn peak(samples: &[i16]) -> f32 {
        samples
            .iter()
            .map(|&s| (s as f32).abs())
            .fold(0.0, f32::max)
    }

    #[test]
    fn agc_attenuates_loud_block_over_time() {
        let mut agc = SlowTrackingAgc::new();
        // A loud block (peak ~20000) should drive the gain DOWN gradually.
        let make = || vec![20000i16; 256];
        let mut last_gain = agc.gain();
        for _ in 0..10 {
            let mut block = make();
            agc.process(&mut block);
            // Gain tracks toward desired = 8000/20000 = 0.4 (EMA, not instant).
            assert!(
                agc.gain() <= last_gain + 1e-6,
                "gain must not rise on loud audio"
            );
            last_gain = agc.gain();
        }
        assert!(agc.gain() < 1.0, "gain settles below 1.0 for a loud source");
    }

    #[test]
    fn agc_amplifies_quiet_speech_within_max_gain() {
        let mut agc = SlowTrackingAgc::new();
        // Quiet speech (peak ~1000) → desired gain 8000/1000 = 8, under MAX_GAIN.
        for _ in 0..50 {
            let mut block = vec![1000i16; 256];
            agc.process(&mut block);
        }
        assert!(agc.gain() > 1.0, "quiet speech is amplified");
        assert!(agc.gain() <= MAX_GAIN + 1e-3, "gain never exceeds MAX_GAIN");
    }

    #[test]
    fn agc_gain_capped_at_max_for_near_silent_voice() {
        let mut agc = SlowTrackingAgc::new();
        // Peak just above the noise floor → desired gain hits the MAX_GAIN cap.
        for _ in 0..200 {
            let mut block = vec![60i16; 256]; // > NOISE_FLOOR (50)
            agc.process(&mut block);
        }
        assert!(agc.gain() <= MAX_GAIN + 1e-3);
    }

    #[test]
    fn agc_silence_decays_gain_toward_unity_and_passes_through() {
        let mut agc = SlowTrackingAgc::new();
        // Push gain up first with quiet speech…
        for _ in 0..40 {
            let mut block = vec![1000i16; 64];
            agc.process(&mut block);
        }
        let raised = agc.gain();
        assert!(raised > 1.0);
        // …then sub-floor "silence" must DECAY gain toward 1.0 and NOT amplify.
        let mut silence = vec![10i16; 64]; // < NOISE_FLOOR
        let before = silence.clone();
        agc.process(&mut silence);
        assert_eq!(
            silence, before,
            "sub-floor audio passes through un-amplified"
        );
        assert!(agc.gain() < raised, "gain decays during silence");
        assert!(
            agc.gain() > 1.0,
            "single decay step doesn't overshoot unity"
        );
    }

    #[test]
    fn agc_clips_near_full_scale_block() {
        let mut agc = SlowTrackingAgc::new();
        // Pre-seed a high gain by hand, then feed a full-scale-ish block; the
        // scaled output must clip into i16 range rather than wrap.
        for _ in 0..30 {
            let mut warm = vec![2000i16; 64];
            agc.process(&mut warm);
        }
        let mut block = vec![30000i16; 64];
        agc.process(&mut block);
        assert!(peak(&block) <= 32767.0, "output clipped to i16 range");
    }

    // ── channel folding ─────────────────────────────────────────────────────

    #[test]
    fn mono_passthrough_for_single_channel() {
        let data = [1i16, -2, 3, -4];
        assert_eq!(interleaved_to_mono_i16(&data, 1), data.to_vec());
    }

    #[test]
    fn stereo_folds_to_average() {
        // L/R interleaved: (10,20)->15, (-4,4)->0.
        let data = [10i16, 20, -4, 4];
        assert_eq!(interleaved_to_mono_i16(&data, 2), vec![15, 0]);
    }

    #[test]
    fn partial_trailing_frame_is_dropped() {
        // 2 channels, 5 samples → 2 whole frames, last sample dropped.
        let data = [10i16, 20, 30, 40, 50];
        assert_eq!(interleaved_to_mono_i16(&data, 2), vec![15, 35]);
    }

    #[test]
    fn f32_stereo_to_mono_i16_scales_and_clips() {
        // (0.5,0.5)->0.5 → 16384; (1.0,1.0)->1.0 → 32767 (clipped).
        let data = [0.5f32, 0.5, 1.0, 1.0, -1.0, -1.0];
        let out = interleaved_f32_to_mono_i16(&data, 2);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], 16384);
        assert_eq!(out[1], 32767);
        assert_eq!(out[2], -32768);
    }

    #[test]
    fn i16_to_f32_roundtrips_scale() {
        // 16384 / 32768 = 0.5; -32768 / 32768 = -1.0; 0 -> 0.
        let out = i16_to_f32(&[16384, -32768, 0]);
        assert!((out[0] - 0.5).abs() < 1e-6);
        assert!((out[1] + 1.0).abs() < 1e-6);
        assert_eq!(out[2], 0.0);
    }
}
