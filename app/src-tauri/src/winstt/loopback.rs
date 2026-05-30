// PORT IMPL — drafted against real APIs, pending compile.
// Source: server/src/stt_server/loopback.py (LoopbackCapture + slow-tracking AGC)
//         app/PORT/05_wakeword_diarization_loopback_wordts.md §C
// External API (wasapi 0.23.0, verified docs.rs 2026-05):
//   wasapi::initialize_mta() -> Result<()> ; deinitialize()
//   DeviceEnumerator::new() -> Result<DeviceEnumerator>
//     .get_default_device(&Direction) -> Result<Device>
//     .enumerate_audio_endpoints(&Direction, DeviceState) (device list)
//   Device::get_iaudioclient() -> Result<AudioClient> ; .get_friendlyname() -> Result<String>
//   AudioClient::get_mixformat() -> Result<WaveFormat>
//     .initialize_client(&WaveFormat, &Direction, &StreamMode) -> Result<()>
//        // LOOPBACK = default RENDER device + Direction::Capture in initialize_client
//     .set_get_eventhandle() -> Result<Handle>
//     .get_audiocaptureclient() -> Result<AudioCaptureClient>
//     .start_stream() / .stop_stream() -> Result<()>
//   AudioCaptureClient::read_from_device_to_deque(&mut VecDeque<u8>) -> Result<BufferInfo>
//     .get_next_packet_size() -> Result<Option<u32>>
//   Handle::wait_for_event(timeout_ms: u32) -> Result<()>
//   WaveFormat::get_nchannels()->u16 ; get_samplespersec()->u32 ;
//     get_bitspersample()->u16 ; get_subformat()->Result<SampleType>
//     ; new(storebits, validbits, &SampleType, samplerate, channels, mask)
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS DOES
// ─────────────────────────────────────────────────────────────────────────────
// Listen mode transcribes SYSTEM audio (a call, a YouTube lecture), not the mic.
// cpal (Handy's capture lib) cannot capture the render endpoint on Windows, so we
// open the default RENDER device in WASAPI LOOPBACK mode (render device + capture
// direction), pull blocks on the WASAPI event, convert to mono, run the
// slow-tracking AGC, and push 16 kHz-bound i16 frames onto a channel that the
// existing Handy consumer (`run_consumer`) resamples + VAD-gates.
//
// PORTABILITY: WASAPI is Windows-only. The CAPTURE thread + COM init are gated
// `#[cfg(windows)]`. The SlowTrackingAgc, the stereo→mono fold, and the channel
// plumbing are platform-agnostic and unit-tested everywhere.

#![allow(dead_code)] // DRAFT: surface defined ahead of the LoopbackManager call sites.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread::JoinHandle;

// ═════════════════════════════════════════════════════════════════════════════
// 1. Slow-tracking AGC — ARITHMETIC, verbatim port of loopback.py constants.
//    Operates in the int16 domain (peak measured as |sample| in int16), exactly
//    like the Python so the VAD-endpoint behavior is bit-faithful.
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
/// silence multiplies room noise by up to `MAX_GAIN`, pinning the composite VAD
/// at "speech" forever so Listen mode never reaches its silence endpoint. Decaying
/// toward unity (and never amplifying sub-floor audio) is what lets the VAD gate.
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
        let peak = samples.iter().map(|&s| (s as f32).abs()).fold(0.0f32, f32::max);
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
// 2. Channel folding — interleaved multichannel → mono (average channels).
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
        let sum: i32 = interleaved[base..base + channels].iter().map(|&s| s as i32).sum();
        out.push((sum / channels as i32) as i16);
    }
    out
}

/// Average `channels`-interleaved f32 frames into mono f32, then convert to i16
/// (clip to range). WASAPI shared-mode render is usually 32-bit float.
pub fn interleaved_f32_to_mono_i16(interleaved: &[f32], channels: usize) -> Vec<i16> {
    let channels = channels.max(1);
    let frames = interleaved.len() / channels;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let base = f * channels;
        let sum: f32 = interleaved[base..base + channels].iter().copied().sum();
        let mono = sum / channels as f32;
        // f32 PCM is in [-1, 1]; scale to int16 with clipping.
        let scaled = (mono * 32768.0).clamp(-32768.0, 32767.0);
        out.push(scaled as i16);
    }
    out
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
    #[error("WASAPI error: {0}")]
    Wasapi(String),
    #[error("capture already active")]
    AlreadyActive,
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. LoopbackCapture — owns the WASAPI capture thread.
//
//    The captured i16 mono frames are pushed onto `sink` (the consumer's
//    `mpsc::Sender<Vec<i16>>`); the consumer side resamples to 16 kHz + VADs.
//    Mirrors WinSTT's FileAudioSource (external-feed source) rather than editing
//    Handy's recorder.rs.
// ═════════════════════════════════════════════════════════════════════════════

pub struct LoopbackCapture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    /// AGC state is reset on each `start` (and lives in the capture thread); this
    /// copy is the seed so tests / callers can pre-seed if needed.
    agc_seed: SlowTrackingAgc,
}

impl Default for LoopbackCapture {
    fn default() -> Self {
        LoopbackCapture {
            stop: Arc::new(AtomicBool::new(false)),
            thread: None,
            agc_seed: SlowTrackingAgc::new(),
        }
    }
}

impl LoopbackCapture {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_active(&self) -> bool {
        self.thread.as_ref().map(|t| !t.is_finished()).unwrap_or(false)
    }

    /// Open the default render endpoint in WASAPI loopback, spawn the capture
    /// thread that AGCs each block and pushes mono i16 frames onto `sink`.
    ///
    /// `device_id == None` uses the default render device. Serialize start/stop
    /// in the manager (concurrent WASAPI start/stop crash the audio backend).
    #[cfg(windows)]
    pub fn start(
        &mut self,
        device_id: Option<String>,
        sink: Sender<Vec<i16>>,
    ) -> Result<DeviceInfo, LoopbackError> {
        if self.is_active() {
            return Err(LoopbackError::AlreadyActive);
        }
        self.stop.store(false, Ordering::SeqCst);
        let stop = self.stop.clone();
        let agc = self.agc_seed.clone();

        // Resolve device info synchronously so the caller gets it (and errors)
        // before the thread spins; the thread re-opens its own client.
        let info = windows_impl::resolve_render_device(device_id.as_deref())
            .map_err(|e| LoopbackError::Wasapi(e.to_string()))?;
        let thread_info = info.clone();
        let device_id_for_thread = device_id.clone();

        let handle = std::thread::Builder::new()
            .name("loopback-capture".into())
            .spawn(move || {
                if let Err(e) = windows_impl::capture_loop(
                    device_id_for_thread.as_deref(),
                    thread_info,
                    sink,
                    stop,
                    agc,
                ) {
                    log::error!("[loopback] capture loop ended with error: {e}");
                }
            })
            .map_err(|e| LoopbackError::Wasapi(format!("spawn capture thread: {e}")))?;

        self.thread = Some(handle);
        Ok(info)
    }

    #[cfg(not(windows))]
    pub fn start(
        &mut self,
        _device_id: Option<String>,
        _sink: Sender<Vec<i16>>,
    ) -> Result<DeviceInfo, LoopbackError> {
        Err(LoopbackError::Unsupported)
    }

    /// Signal the capture thread to stop and join it (best-effort, bounded).
    /// The thread polls `stop` between WASAPI event waits and exits promptly.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            // The WASAPI event wait has a 200ms timeout, so the thread checks
            // `stop` at least 5×/s — join is bounded without a hard kill.
            let _ = handle.join();
        }
    }

    /// Enumerate loopback-capable (render) devices.
    #[cfg(windows)]
    pub fn list_devices() -> Result<Vec<LoopbackDeviceInfo>, LoopbackError> {
        windows_impl::list_render_devices().map_err(|e| LoopbackError::Wasapi(e.to_string()))
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
// 5. Windows WASAPI implementation (the FFI half). `// SPIKE:` markers flag the
//    exact-shape details to confirm against a live device in the compile loop.
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use std::collections::VecDeque;
    use wasapi::{
        deinitialize, initialize_mta, Direction, SampleType, StreamMode,
    };

    /// Buffer duration requested from WASAPI (hundred-nanosecond units). 200ms
    /// shared-mode buffer keeps the event wait responsive to `stop`.
    const BUFFER_DURATION_HNS: i64 = 2_000_000; // 200 ms in 100-ns ticks.
    /// Event-wait timeout per loop iteration (ms) — bounds stop latency.
    const EVENT_TIMEOUT_MS: u32 = 200;

    /// Resolve the default (or named) render device into [`DeviceInfo`] without
    /// starting capture. Used by `start` to surface device errors synchronously.
    pub fn resolve_render_device(device_id: Option<&str>) -> anyhow::Result<DeviceInfo> {
        initialize_mta().ok();
        let result = (|| -> anyhow::Result<DeviceInfo> {
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
        })();
        deinitialize();
        result
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
        initialize_mta().ok();
        let result = (|| -> anyhow::Result<Vec<LoopbackDeviceInfo>> {
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
                    out.push(LoopbackDeviceInfo { id, name, is_default });
                }
            }
            Ok(out)
        })();
        deinitialize();
        result
    }

    /// The capture thread body. Opens the render device in LOOPBACK mode
    /// (render device + `Direction::Capture` in `initialize_client`), drains
    /// blocks on the WASAPI event, folds to mono i16, AGCs, and pushes to `sink`.
    pub fn capture_loop(
        device_id: Option<&str>,
        info: DeviceInfo,
        sink: Sender<Vec<i16>>,
        stop: Arc<AtomicBool>,
        mut agc: SlowTrackingAgc,
    ) -> anyhow::Result<()> {
        initialize_mta().ok();
        let run = (|| -> anyhow::Result<()> {
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
            // f32 vs int16 subformat — WASAPI shared render is normally float32.
            // SPIKE: confirm get_subformat() returns SampleType::Float for the
            // default shared mix format on the target machine.
            let sample_type = format.get_subformat().unwrap_or(SampleType::Float);
            let bytes_per_sample = (format.get_bitspersample() / 8) as usize;
            let block_align = bytes_per_sample * channels;

            // LOOPBACK: render device opened with Direction::Capture. autoconvert
            // lets WASAPI hand us the mix format directly.
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

            let mut raw: VecDeque<u8> = VecDeque::new();
            let mut consecutive_errors = 0u32;
            const MAX_ERRORS: u32 = 5;

            while !stop.load(Ordering::SeqCst) {
                // Drain all currently-available packets into `raw`.
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
                if block_align > 0 {
                    let usable = (raw.len() / block_align) * block_align;
                    if usable > 0 {
                        let bytes: Vec<u8> = raw.drain(0..usable).collect();
                        let mut mono = bytes_to_mono_i16(&bytes, channels, sample_type, bytes_per_sample);
                        agc.process(&mut mono);
                        if !mono.is_empty() && sink.send(mono).is_err() {
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

            let _ = client.stop_stream();
            Ok(())
        })();
        let _ = info; // info already returned to caller; kept for symmetry.
        deinitialize();
        run
    }

    /// Decode a byte buffer of interleaved PCM into mono i16, honoring the
    /// WASAPI sample type (float32 or int16).
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
                // SPIKE: int paths can be 16/24/32-bit; handle the common 16-bit
                // mix and treat anything else as the top 16 bits.
                if bytes_per_sample == 2 {
                    let mut interleaved = Vec::with_capacity(bytes.len() / 2);
                    for chunk in bytes.chunks_exact(2) {
                        interleaved.push(i16::from_le_bytes([chunk[0], chunk[1]]));
                    }
                    interleaved_to_mono_i16(&interleaved, channels)
                } else if bytes_per_sample == 4 {
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
        samples.iter().map(|&s| (s as f32).abs()).fold(0.0, f32::max)
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
            assert!(agc.gain() <= last_gain + 1e-6, "gain must not rise on loud audio");
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
        assert_eq!(silence, before, "sub-floor audio passes through un-amplified");
        assert!(agc.gain() < raised, "gain decays during silence");
        assert!(agc.gain() > 1.0, "single decay step doesn't overshoot unity");
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
}
