use std::{
    io::Error,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    time::Duration,
};

use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, Sample, SizedSample,
};

use crate::audio_toolkit::{
    audio::{AudioVisualiser, FrameResampler},
    constants,
    vad::{self, VadFrame},
    VoiceActivityDetector,
};

enum Cmd {
    Start,
    Stop(mpsc::Sender<Vec<f32>>),
    Shutdown,
}

/// Per-frame DC-immune RMS (AC energy of one resampled frame). Used ONLY to gate the
/// surfaced speech signal (`speech_cb`), never the recording buffer itself.
fn frame_ac_energy(frame: &[f32]) -> f32 {
    let n = frame.len() as f32;
    if n == 0.0 {
        return 0.0;
    }
    let mean = frame.iter().copied().sum::<f32>() / n;
    (frame.iter().map(|&x| (x - mean) * (x - mean)).sum::<f32>() / n).sqrt()
}

/// Frame AC-energy floor below which a Silero "speech" verdict is treated as a false
/// positive for the UI signal. The Silero VAD (threshold 0.3) reports speech on
/// near-silent frames on some mics, which would flash the overlay pill on silence; this
/// floor sits above the silence/room-tone band and below voiced-speech frame energy.
/// Mirrors the batch silence gate's intent (managers::transcription::SILENCE_AC_FLOOR).
const SPEECH_SIGNAL_AC_FLOOR: f32 = 0.005;

enum AudioChunk {
    Samples(Vec<f32>),
    EndOfStream,
}

fn send_input_callback_chunk(
    sample_tx: &mpsc::Sender<AudioChunk>,
    samples: &[f32],
    stop_requested: bool,
    eos_sent: &mut bool,
) {
    if stop_requested && *eos_sent {
        return;
    }

    if !samples.is_empty()
        && sample_tx
            .send(AudioChunk::Samples(samples.to_vec()))
            .is_err()
    {
        log::error!("Failed to send samples");
    }

    if stop_requested {
        let _ = sample_tx.send(AudioChunk::EndOfStream);
        *eos_sent = true;
    } else {
        *eos_sent = false;
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RealtimeAudioProgress {
    pub len: usize,
    pub version: u64,
}

pub struct AudioRecorder {
    device: Option<Device>,
    cmd_tx: Option<mpsc::Sender<Cmd>>,
    worker_handle: Option<std::thread::JoinHandle<()>>,
    vad: Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
    level_cb: Option<Arc<dyn Fn(Vec<f32>) + Send + Sync + 'static>>,
    /// Raw-16k mono tap fired on EVERY resampled frame (independent of `recording`), so the
    /// wakeword detector can listen while idle. None = no-op (free when no wakeword armed).
    #[expect(
        clippy::type_complexity,
        reason = "boxed audio-frame callback; factoring into a type alias would not aid clarity"
    )]
    chunk_cb: Option<Arc<dyn Fn(&[f32]) + Send + Sync + 'static>>,
    /// Fired on SMOOTHED-VAD speech-state TRANSITIONS while recording: `true` at speech
    /// onset, `false` at offset (after the hangover). Lets the app surface the real
    /// Silero/SmoothedVad boundaries (e.g. as `stt:vad-start` / `stt:vad-stop`) instead
    /// of faking them from the recording window. None = no-op.
    speech_cb: Option<Arc<dyn Fn(bool) + Send + Sync + 'static>>,
    /// Live snapshot MIRROR of `processed_samples` (the in-flight 16 kHz recording buffer),
    /// kept in sync TAIL-ONLY by run_consumer so the realtime worker can read a growing window
    /// of the current recording WITHOUT touching the wakeword `chunk_cb` slot (single, taken) or
    /// the batch Cmd::Stop drain. Cleared on Cmd::Start, mem::take'd-equivalent on Stop (the
    /// mirror keeps the last recording until the next Start clears it). Always allocated so
    /// `snapshot_recorded` can clone it; `None` is never used at runtime but keeps run_consumer
    /// agnostic. See project memory: realtime streaming port.
    live_audio: Arc<Mutex<Vec<f32>>>,
    /// Gate for the `live_audio` mirror: run_consumer only grows the mirror while this is true.
    /// The recording manager flips it per recording based on `effective_realtime` so we never
    /// pay the second-copy memory + per-chunk extend when the live preview is off. Defaults to
    /// `false`; the manager sets it before the first frame of a realtime recording.
    realtime_enabled: Arc<AtomicBool>,
    /// Signals realtime workers that the live mirror length changed. This lets native streaming
    /// block on recorder progress instead of polling the mirror on a fixed timer.
    realtime_audio_signal: Arc<(Mutex<RealtimeAudioProgress>, Condvar)>,
}

impl AudioRecorder {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        Ok(AudioRecorder {
            device: None,
            cmd_tx: None,
            worker_handle: None,
            vad: None,
            level_cb: None,
            chunk_cb: None,
            speech_cb: None,
            live_audio: Arc::new(Mutex::new(Vec::new())),
            realtime_enabled: Arc::new(AtomicBool::new(false)),
            realtime_audio_signal: Arc::new((
                Mutex::new(RealtimeAudioProgress::default()),
                Condvar::new(),
            )),
        })
    }

    /// Enable/disable the realtime `live_audio` mirror at runtime. When `false`, run_consumer
    /// skips the per-chunk extend entirely (no second copy of the recording). Cheap, lock-free;
    /// safe to flip from any thread. The recording manager calls this per recording based on
    /// whether the live preview is actually shown (`effective_realtime`).
    pub fn set_realtime_enabled(&self, enabled: bool) {
        self.realtime_enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn with_vad(mut self, vad: Box<dyn VoiceActivityDetector>) -> Self {
        self.vad = Some(Arc::new(Mutex::new(vad)));
        self
    }

    pub fn with_level_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(Vec<f32>) + Send + Sync + 'static,
    {
        self.level_cb = Some(Arc::new(cb));
        self
    }

    pub fn with_chunk_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(&[f32]) + Send + Sync + 'static,
    {
        self.chunk_cb = Some(Arc::new(cb));
        self
    }

    /// Register a callback fired on SMOOTHED-VAD speech-state transitions (`true` =
    /// onset, `false` = offset) while recording. Used to surface real VAD boundaries
    /// to the UI instead of faking them from the recording window.
    pub fn with_speech_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn(bool) + Send + Sync + 'static,
    {
        self.speech_cb = Some(Arc::new(cb));
        self
    }

    pub fn with_realtime_audio_signal(
        mut self,
        signal: Arc<(Mutex<RealtimeAudioProgress>, Condvar)>,
    ) -> Self {
        self.realtime_audio_signal = signal;
        self
    }

    pub fn open(&mut self, device: Option<Device>) -> Result<(), Box<dyn std::error::Error>> {
        if self.worker_handle.is_some() {
            return Ok(()); // already open
        }

        let (sample_tx, sample_rx) = mpsc::channel::<AudioChunk>();
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();
        let (init_tx, init_rx) = mpsc::sync_channel::<Result<(), String>>(1);

        let host = crate::audio_toolkit::get_cpal_host();
        let device = match device {
            Some(dev) => dev,
            None => host
                .default_input_device()
                .ok_or_else(|| Error::new(std::io::ErrorKind::NotFound, "No input device found"))?,
        };

        let thread_device = device.clone();
        let vad = self.vad.clone();
        // Move the optional level callback into the worker thread
        let level_cb = self.level_cb.clone();
        let chunk_cb = self.chunk_cb.clone();
        let speech_cb = self.speech_cb.clone();
        // Clone the live-audio mirror handle so the realtime worker (via snapshot_recorded)
        // and run_consumer share the SAME buffer.
        let live_audio = Some(self.live_audio.clone());
        // Clone the realtime gate so run_consumer can skip the mirror extend when off.
        let realtime_enabled = self.realtime_enabled.clone();
        let realtime_audio_signal = self.realtime_audio_signal.clone();

        let worker = std::thread::spawn(move || {
            let stop_flag = Arc::new(AtomicBool::new(false));
            let stop_flag_for_stream = stop_flag.clone();
            let init_result = (|| -> Result<(cpal::Stream, u32), String> {
                let config = AudioRecorder::get_preferred_config(&thread_device)
                    .map_err(|e| format!("Failed to fetch preferred config: {e}"))?;

                let sample_rate = config.sample_rate().0;
                let channels = config.channels() as usize;

                log::info!(
                    "Using device: {:?}\nSample rate: {}\nChannels: {}\nFormat: {:?}",
                    thread_device.name(),
                    sample_rate,
                    channels,
                    config.sample_format()
                );

                let stream = match config.sample_format() {
                    cpal::SampleFormat::U8 => AudioRecorder::build_stream::<u8>(
                        &thread_device,
                        &config,
                        sample_tx,
                        channels,
                        stop_flag_for_stream,
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::I8 => AudioRecorder::build_stream::<i8>(
                        &thread_device,
                        &config,
                        sample_tx,
                        channels,
                        stop_flag_for_stream,
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::I16 => AudioRecorder::build_stream::<i16>(
                        &thread_device,
                        &config,
                        sample_tx,
                        channels,
                        stop_flag_for_stream,
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::I32 => AudioRecorder::build_stream::<i32>(
                        &thread_device,
                        &config,
                        sample_tx,
                        channels,
                        stop_flag_for_stream,
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::F32 => AudioRecorder::build_stream::<f32>(
                        &thread_device,
                        &config,
                        sample_tx,
                        channels,
                        stop_flag_for_stream,
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    sample_format => {
                        return Err(format!("Unsupported sample format: {sample_format:?}"));
                    }
                };

                stream
                    .play()
                    .map_err(|e| format!("Failed to start microphone stream: {e}"))?;

                Ok((stream, sample_rate))
            })();

            match init_result {
                Ok((stream, sample_rate)) => {
                    let _ = init_tx.send(Ok(()));
                    // Keep the stream alive while we process samples.
                    run_consumer(
                        sample_rate,
                        vad,
                        sample_rx,
                        cmd_rx,
                        level_cb,
                        chunk_cb,
                        speech_cb,
                        live_audio,
                        realtime_enabled,
                        realtime_audio_signal,
                        stop_flag,
                    );
                    drop(stream);
                }
                Err(error_message) => {
                    log::error!("{error_message}");
                    let _ = init_tx.send(Err(error_message));
                }
            }
        });

        match init_rx.recv() {
            Ok(Ok(())) => {
                self.device = Some(device);
                self.cmd_tx = Some(cmd_tx);
                self.worker_handle = Some(worker);
                Ok(())
            }
            Ok(Err(error_message)) => {
                let _ = worker.join();
                let kind = if is_microphone_access_denied(&error_message) {
                    std::io::ErrorKind::PermissionDenied
                } else {
                    std::io::ErrorKind::Other
                };
                Err(Box::new(Error::new(kind, error_message)))
            }
            Err(recv_error) => {
                let _ = worker.join();
                Err(Box::new(Error::other(format!(
                    "Failed to initialize microphone worker: {recv_error}"
                ))))
            }
        }
    }

    pub fn start(&self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(tx) = &self.cmd_tx {
            tx.send(Cmd::Start)?;
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        let (resp_tx, resp_rx) = mpsc::channel();
        if let Some(tx) = &self.cmd_tx {
            tx.send(Cmd::Stop(resp_tx))?;
        }
        Ok(resp_rx.recv()?) // wait for the samples
    }

    pub fn close(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(Cmd::Shutdown);
        }
        if let Some(h) = self.worker_handle.take() {
            let _ = h.join();
        }
        self.device = None;
        Ok(())
    }

    /// Clone the current in-flight 16 kHz mono recording buffer (the live mirror that
    /// run_consumer keeps tail-synced with `processed_samples`). Returns an empty Vec if nothing
    /// has been captured since the last Cmd::Start. O(N) clone — kept for back-compat; the
    /// realtime worker uses `snapshot_from` (O(new samples)) instead.
    pub fn snapshot_recorded(&self) -> Vec<f32> {
        self.live_audio.lock().unwrap().clone()
    }

    /// Snapshot only the TAIL of the live recording mirror past `offset` samples, plus the
    /// current total length. Returns `(total_len, tail)` where `tail == live_audio[offset..]`
    /// (an empty Vec when `offset >= total_len`). The realtime worker passes its committed-frame
    /// watermark as `offset` and never reads audio before it, so the clone is O(new samples)
    /// instead of O(N) — eliminating the O(N²)-per-utterance full-buffer clone on every tick.
    /// Indices the caller derives from absolute frame numbers must be re-based by `offset`.
    pub fn snapshot_from(&self, offset: usize) -> (usize, Vec<f32>) {
        let mirror = self.live_audio.lock().unwrap();
        let total = mirror.len();
        let tail = if offset < total {
            mirror[offset..].to_vec()
        } else {
            Vec::new()
        };
        (total, tail)
    }

    fn build_stream<T>(
        device: &cpal::Device,
        config: &cpal::SupportedStreamConfig,
        sample_tx: mpsc::Sender<AudioChunk>,
        channels: usize,
        stop_flag: Arc<AtomicBool>,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: Sample + SizedSample + Send + 'static,
        f32: cpal::FromSample<T>,
    {
        let mut output_buffer = Vec::new();
        let mut eos_sent = false;

        let stream_cb = move |data: &[T], _: &cpal::InputCallbackInfo| {
            let stop_requested = stop_flag.load(Ordering::Relaxed);
            if stop_requested && eos_sent {
                return;
            }

            output_buffer.clear();

            if channels == 1 {
                output_buffer.extend(data.iter().map(|&sample| sample.to_sample::<f32>()));
            } else {
                let frame_count = data.len() / channels;
                output_buffer.reserve(frame_count);

                for frame in data.chunks_exact(channels) {
                    let mono_sample = frame
                        .iter()
                        .map(|&sample| sample.to_sample::<f32>())
                        .sum::<f32>()
                        / channels as f32;
                    output_buffer.push(mono_sample);
                }
            }

            send_input_callback_chunk(&sample_tx, &output_buffer, stop_requested, &mut eos_sent);
        };

        device.build_input_stream(
            &config.clone().into(),
            stream_cb,
            |err| log::error!("Stream error: {}", err),
            None,
        )
    }

    fn get_preferred_config(
        device: &cpal::Device,
    ) -> Result<cpal::SupportedStreamConfig, Box<dyn std::error::Error>> {
        // Use the device's native/default sample rate and let the FrameResampler
        // in run_consumer() downsample to 16kHz. This avoids forcing hardware into
        // a non-native rate which can cause issues on some devices (Bluetooth
        // codecs, certain ALSA drivers, etc.).
        let default_config = device.default_input_config()?;
        let target_rate = default_config.sample_rate();

        // Try to find the best sample format at the device's default rate
        let supported_configs = match device.supported_input_configs() {
            Ok(configs) => configs,
            Err(e) => {
                log::warn!("Could not enumerate input configs ({e}), using device default");
                return Ok(default_config);
            }
        };
        let mut best_config: Option<cpal::SupportedStreamConfigRange> = None;

        for config_range in supported_configs {
            if config_range.min_sample_rate() <= target_rate
                && config_range.max_sample_rate() >= target_rate
            {
                match best_config {
                    None => best_config = Some(config_range),
                    Some(ref current) => {
                        // Prioritize F32 > I16 > I32 > others
                        let score = |fmt: cpal::SampleFormat| match fmt {
                            cpal::SampleFormat::F32 => 4,
                            cpal::SampleFormat::I16 => 3,
                            cpal::SampleFormat::I32 => 2,
                            _ => 1,
                        };

                        if score(config_range.sample_format()) > score(current.sample_format()) {
                            best_config = Some(config_range);
                        }
                    }
                }
            }
        }

        if let Some(config) = best_config {
            return Ok(config.with_sample_rate(target_rate));
        }

        // Fall back to device default if no config matched (exotic/virtual devices)
        log::warn!(
            "No supported config matched device default rate {:?}, using default config",
            target_rate
        );
        Ok(default_config)
    }
}

/// Typed taxonomy for the failure modes the recorder can surface while opening a
/// cpal input stream. Previously these distinctions only existed as Display
/// substrings parsed back out at the call sites; this enum makes the taxonomy a
/// real type so callers can `matches!` on a variant instead of string-sniffing.
///
/// Note: cpal's backend errors are stringly-typed and platform-specific (WASAPI
/// HRESULTs, CoreAudio opaque errors, ALSA messages), so the *boundary* where a
/// raw backend message becomes a typed variant is `classify`. Everything above
/// that boundary works in terms of variants, not substrings.
#[derive(Debug, thiserror::Error)]
pub enum AudioDeviceError {
    /// The OS refused microphone access (Windows mic-privacy off, WASAPI
    /// `0x80070005`, or a generic "permission denied" from the backend).
    #[error("microphone access denied: {0}")]
    MicrophoneAccessDenied(String),

    /// No usable input device exists (cpal returned none, or the CoreAudio
    /// preferred-config probe failed because there is nothing to open).
    #[error("no input device: {0}")]
    NoInputDevice(String),

    /// Building / starting the cpal input stream failed for some other reason.
    #[error("failed to build input stream: {0}")]
    BuildStream(String),
}

impl AudioDeviceError {
    /// Classify a raw backend error message into a typed variant. This is the
    /// single point where stringly-typed cpal/backend errors are interpreted;
    /// the recorder's worker thread can only hand back a `String`, so the parse
    /// has to live somewhere — keep it here, not scattered across call sites.
    pub fn classify(error_message: &str) -> Self {
        let normalized = error_message.to_lowercase();
        if normalized.contains("access is denied")
            || normalized.contains("permission denied")
            || normalized.contains("0x80070005")
        {
            Self::MicrophoneAccessDenied(error_message.to_string())
        } else if normalized.contains("no input device found")
            || (normalized.contains("failed to fetch preferred config")
                && normalized.contains("coreaudio"))
        {
            Self::NoInputDevice(error_message.to_string())
        } else {
            Self::BuildStream(error_message.to_string())
        }
    }
}

pub fn is_microphone_access_denied(error_message: &str) -> bool {
    matches!(
        AudioDeviceError::classify(error_message),
        AudioDeviceError::MicrophoneAccessDenied(_)
    )
}

pub fn is_no_input_device_error(error_message: &str) -> bool {
    matches!(
        AudioDeviceError::classify(error_message),
        AudioDeviceError::NoInputDevice(_)
    )
}

#[cfg(test)]
#[allow(
    clippy::items_after_test_module,
    reason = "run_consumer is defined below the tests; keeping it in place avoids a risky reorder"
)]
mod tests {
    use std::sync::mpsc;

    use super::{
        is_microphone_access_denied, is_no_input_device_error, send_input_callback_chunk,
        AudioChunk, AudioDeviceError,
    };

    #[test]
    fn classify_routes_access_denied_to_typed_variant() {
        assert!(matches!(
            AudioDeviceError::classify("Access is denied"),
            AudioDeviceError::MicrophoneAccessDenied(_)
        ));
    }

    #[test]
    fn classify_routes_no_input_device_to_typed_variant() {
        assert!(matches!(
            AudioDeviceError::classify("No input device found"),
            AudioDeviceError::NoInputDevice(_)
        ));
    }

    #[test]
    fn classify_routes_unrecognized_to_build_stream() {
        assert!(matches!(
            AudioDeviceError::classify("Failed to build input stream: device disconnected"),
            AudioDeviceError::BuildStream(_)
        ));
    }

    #[test]
    fn detects_access_is_denied() {
        assert!(is_microphone_access_denied("Access is denied"));
    }

    #[test]
    fn detects_permission_denied() {
        assert!(is_microphone_access_denied("permission denied"));
    }

    #[test]
    fn detects_windows_error_code() {
        assert!(is_microphone_access_denied("WASAPI error: 0x80070005"));
    }

    #[test]
    fn does_not_match_unrelated_errors() {
        assert!(!is_microphone_access_denied("device not found"));
    }

    #[test]
    fn detects_no_input_device() {
        assert!(is_no_input_device_error("No input device found"));
    }

    #[test]
    fn detects_coreaudio_config_error() {
        assert!(is_no_input_device_error(
            "Failed to fetch preferred config: A backend-specific error has occurred: An unknown error unknown to the coreaudio-rs API occurred"
        ));
    }

    #[test]
    fn does_not_match_other_errors_for_no_device() {
        assert!(!is_no_input_device_error("permission denied"));
        assert!(!is_no_input_device_error("device not found"));
    }

    #[test]
    fn stop_callback_sends_current_samples_before_end_of_stream() {
        let (tx, rx) = mpsc::channel();
        let mut eos_sent = false;

        send_input_callback_chunk(&tx, &[0.25, -0.5, 0.75], true, &mut eos_sent);

        match rx.recv().unwrap() {
            AudioChunk::Samples(samples) => assert_eq!(samples, vec![0.25, -0.5, 0.75]),
            AudioChunk::EndOfStream => panic!("expected samples before end-of-stream"),
        }
        assert!(matches!(rx.recv().unwrap(), AudioChunk::EndOfStream));
        assert!(eos_sent);
    }

    #[test]
    fn stop_callback_drops_callbacks_after_end_of_stream_was_sent() {
        let (tx, rx) = mpsc::channel();
        let mut eos_sent = true;

        send_input_callback_chunk(&tx, &[1.0], true, &mut eos_sent);

        assert!(rx.try_recv().is_err());
        assert!(eos_sent);
    }
}

fn publish_realtime_audio_progress(
    signal: &Arc<(Mutex<RealtimeAudioProgress>, Condvar)>,
    len: usize,
) {
    let (lock, cvar) = &**signal;
    let mut progress = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    progress.len = len;
    progress.version = progress.version.wrapping_add(1);
    drop(progress);
    cvar.notify_all();
}

#[expect(
    clippy::too_many_arguments,
    reason = "audio consumer wires together the cpal stream, VAD, callbacks, and shared buffers; grouping into a struct would not aid clarity"
)]
#[expect(
    clippy::type_complexity,
    reason = "boxed audio callbacks; factoring into type aliases would not aid clarity"
)]
fn run_consumer(
    in_sample_rate: u32,
    vad: Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
    sample_rx: mpsc::Receiver<AudioChunk>,
    cmd_rx: mpsc::Receiver<Cmd>,
    level_cb: Option<Arc<dyn Fn(Vec<f32>) + Send + Sync + 'static>>,
    chunk_cb: Option<Arc<dyn Fn(&[f32]) + Send + Sync + 'static>>,
    // Smoothed-VAD speech-transition callback (true=onset, false=offset). `None` = no-op.
    speech_cb: Option<Arc<dyn Fn(bool) + Send + Sync + 'static>>,
    // Live snapshot mirror of `processed_samples` for the realtime worker (tail-synced below).
    // `None` makes the sync a no-op (free); the recorder always passes `Some(...)`.
    live_audio: Option<Arc<Mutex<Vec<f32>>>>,
    // Runtime gate: only grow `live_audio` while this is true (set per recording from
    // `effective_realtime`). When off, the mirror extend is skipped entirely → no second copy.
    realtime_enabled: Arc<AtomicBool>,
    realtime_audio_signal: Arc<(Mutex<RealtimeAudioProgress>, Condvar)>,
    stop_flag: Arc<AtomicBool>,
) {
    let mut frame_resampler = FrameResampler::new(
        in_sample_rate as usize,
        constants::WHISPER_SAMPLE_RATE as usize,
        Duration::from_millis(30),
    );

    let mut processed_samples = Vec::<f32>::new();
    let mut recording = false;
    // Last surfaced SMOOTHED-VAD speech state, so we fire `speech_cb` only on
    // transitions (not every frame). Reset to `false` on each Cmd::Start.
    let mut vad_speaking = false;

    // ---------- spectrum visualisation setup ---------------------------- //
    const BUCKETS: usize = 16;
    const WINDOW_SIZE: usize = 512;
    let mut visualizer = AudioVisualiser::new(
        in_sample_rate,
        WINDOW_SIZE,
        BUCKETS,
        400.0,  // vocal_min_hz
        4000.0, // vocal_max_hz
    );

    // Recover a poisoned VAD lock instead of propagating the panic: a panic inside
    // the Silero ONNX `push_frame` would otherwise poison this mutex and silently
    // kill the recorder worker forever. Mirrors the transcription manager's
    // `lock_engine` poison discipline (warn + carry on with the inner guard).
    fn lock_vad<'a>(
        vad_arc: &'a Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>,
    ) -> std::sync::MutexGuard<'a, Box<dyn vad::VoiceActivityDetector>> {
        vad_arc.lock().unwrap_or_else(|p| {
            log::warn!("VAD lock poisoned; recovering inner guard");
            p.into_inner()
        })
    }

    /// Returns whether this frame was classified as SPEECH by the (smoothed) VAD —
    /// `true` when the frame's samples were kept (speech / hangover), `false` for
    /// dropped noise or while not recording. The caller uses the return value to
    /// surface speech-state transitions (see `vad_speaking` / `speech_cb`). With no
    /// VAD configured every recorded frame counts as speech.
    fn handle_frame(
        samples: &[f32],
        recording: bool,
        vad: &Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
        out_buf: &mut Vec<f32>,
    ) -> bool {
        if !recording {
            return false;
        }

        if let Some(vad_arc) = vad {
            let mut det = lock_vad(vad_arc);
            // The Silero ONNX inference can panic on malformed state; a panic here
            // would poison the lock and kill the worker. Contain it and do the
            // keep/drop extend INSIDE the guarded closure — `push_frame` returns a
            // `VadFrame<'a>` borrowing `det`, so it cannot cross the `catch_unwind`
            // boundary. On a panic, fall back to treating the frame as speech so
            // audio is never silently dropped (and no per-frame allocation on the
            // happy path). The closure yields whether the frame was speech.
            let contained = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                match det.push_frame(samples).unwrap_or(VadFrame::Speech(samples)) {
                    VadFrame::Speech(buf) => {
                        out_buf.extend_from_slice(buf);
                        true
                    }
                    VadFrame::Noise => false,
                }
            }));
            contained.unwrap_or_else(|_| {
                log::warn!("VAD push_frame panicked; treating frame as speech");
                out_buf.extend_from_slice(samples);
                true
            })
        } else {
            out_buf.extend_from_slice(samples);
            true
        }
    }

    while let Ok(chunk) = sample_rx.recv() {
        let raw = match chunk {
            AudioChunk::Samples(s) => s,
            AudioChunk::EndOfStream => continue,
        };

        // ---------- spectrum processing ---------------------------------- //
        if let Some(buckets) = visualizer.feed(&raw) {
            if let Some(cb) = &level_cb {
                cb(buckets);
            }
        }

        // ---------- existing pipeline ------------------------------------ //
        frame_resampler.push(&raw, &mut |frame: &[f32]| {
            // Wakeword tap: fire on EVERY 16k frame regardless of `recording` so the detector
            // listens while idle. No-op (free) unless a wakeword is armed.
            if let Some(cb) = &chunk_cb {
                cb(frame);
            }
            let is_speech = handle_frame(frame, recording, &vad, &mut processed_samples);
            // Surface SMOOTHED-VAD speech boundaries (real Silero state, ~one onset
            // window after the user starts/stops talking) so the renderer's
            // `isSpeaking` reflects ACTUAL speech — driving the overlay-pill reveal
            // and the breathing glow. Fire only on transitions, only while recording.
            //
            // ENERGY BACKSTOP for the SIGNAL (not the recording): Silero at threshold 0.3
            // reports "speech" even on near-silent frames on some mics, which flashed the
            // pill on silence. Require real frame energy to BEGIN signaling speech; once
            // signaling, follow the VAD's hangover so a brief quiet dip mid-word doesn't
            // toggle it off and re-fire on the next loud frame.
            let new_speaking = if vad_speaking {
                is_speech
            } else {
                is_speech && frame_ac_energy(frame) >= SPEECH_SIGNAL_AC_FLOOR
            };
            if recording && new_speaking != vad_speaking {
                vad_speaking = new_speaking;
                if let Some(cb) = &speech_cb {
                    cb(vad_speaking);
                }
            }
        });

        // ---------- realtime live-audio mirror (tail-sync) --------------- //
        // Mirror only the NEW tail of `processed_samples` into the shared buffer so the realtime
        // worker can read a growing window of the active recording. O(new samples), NOT a full
        // clone per chunk. Gated on `recording` so the idle wakeword path never grows it, AND on
        // `realtime_enabled` so we skip the second copy entirely when the live preview is off
        // (the common dictation case). The batch path (Cmd::Stop drain + mem::take below) is
        // byte-identical — this only reads `processed_samples`.
        if recording && realtime_enabled.load(Ordering::Relaxed) {
            if let Some(mirror) = &live_audio {
                let new_len = {
                    let mut m = mirror.lock().unwrap();
                    let mirrored = m.len();
                    if processed_samples.len() > mirrored {
                        m.extend_from_slice(&processed_samples[mirrored..]);
                        Some(m.len())
                    } else {
                        None
                    }
                };
                if let Some(new_len) = new_len {
                    publish_realtime_audio_progress(&realtime_audio_signal, new_len);
                }
            }
        }

        // non-blocking check for a command
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                Cmd::Start => {
                    stop_flag.store(false, Ordering::Relaxed);
                    processed_samples.clear();
                    // Clear the realtime mirror in lock-step so the worker's first snapshot of
                    // the new recording starts empty (no stale tail from the previous take).
                    if let Some(mirror) = &live_audio {
                        mirror.lock().unwrap().clear();
                    }
                    publish_realtime_audio_progress(&realtime_audio_signal, 0);
                    recording = true;
                    // Fresh utterance: the next real speech onset re-fires speech_cb(true).
                    vad_speaking = false;
                    visualizer.reset();
                    if let Some(v) = &vad {
                        lock_vad(v).reset();
                    }
                }
                Cmd::Stop(reply_tx) => {
                    recording = false;
                    // Surface a final speech-off if we ended mid-utterance so any consumer's
                    // `isSpeaking` clears even when the user released PTT while still talking.
                    if vad_speaking {
                        vad_speaking = false;
                        if let Some(cb) = &speech_cb {
                            cb(false);
                        }
                    }
                    stop_flag.store(true, Ordering::Relaxed);

                    // Drain all remaining audio until the producer confirms end-of-stream.
                    // The cpal callback sees the stop flag, sends EndOfStream, and goes
                    // silent — guaranteeing every captured sample is in the channel
                    // ahead of the sentinel.
                    loop {
                        match sample_rx.recv_timeout(Duration::from_secs(2)) {
                            Ok(AudioChunk::Samples(remaining)) => {
                                frame_resampler.push(&remaining, &mut |frame: &[f32]| {
                                    // Drain to the batch buffer; speech transitions aren't
                                    // surfaced past release (we already emitted the final off).
                                    let _ = handle_frame(frame, true, &vad, &mut processed_samples);
                                });
                            }
                            Ok(AudioChunk::EndOfStream) => break,
                            Err(_) => {
                                log::warn!("Timed out waiting for EndOfStream from audio callback");
                                break;
                            }
                        }
                    }

                    frame_resampler.finish(&mut |frame: &[f32]| {
                        let _ = handle_frame(frame, true, &vad, &mut processed_samples);
                    });

                    let _ = reply_tx.send(std::mem::take(&mut processed_samples));

                    // Drop the realtime mirror now that the take is finalized — it must not
                    // retain a finished recording's audio (a realtime-worker snapshot landing
                    // in the gap before the next Cmd::Start would otherwise re-decode and emit
                    // the previous utterance). Cmd::Start also clears it; doing it here too frees
                    // the second copy immediately and closes the cross-recording snapshot window.
                    if let Some(mirror) = &live_audio {
                        mirror.lock().unwrap().clear();
                    }
                    publish_realtime_audio_progress(&realtime_audio_signal, 0);

                    // Resume the audio callback so the consumer loop can continue
                    // receiving chunks (important for always-on microphone mode).
                    stop_flag.store(false, Ordering::Relaxed);
                }
                Cmd::Shutdown => {
                    stop_flag.store(true, Ordering::Relaxed);
                    publish_realtime_audio_progress(&realtime_audio_signal, 0);
                    return;
                }
            }
        }
    }
}
