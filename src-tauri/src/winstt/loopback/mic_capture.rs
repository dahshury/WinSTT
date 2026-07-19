// Microphone capture for Listen mode's "also listen to my microphone" toggle.
//
// A deliberately small, self-contained cpal input session that mirrors the
// loopback capture's output contract exactly: 16 kHz mono f32 frames in 30 ms
// chunks, AGC'd in the int16 domain with the SAME `SlowTrackingAgc` the
// loopback path uses — so the two streams arrive at the listen mixer with
// comparable levels and the downstream VAD/model behave identically on both.
//
// This is NOT the dictation recorder (`audio_toolkit::audio::AudioRecorder`):
// that one is hotkey-driven, VAD-endpointed, and owns paste/finalize
// machinery. Listen mode needs a continuous producer with no endpointing —
// endpointing happens in the loopback consumer on the MIXED stream.
//
// THREADING: `start()` spawns a worker that owns the cpal stream (cpal streams
// are !Send, so the stream must be built and dropped on the same thread). The
// cpal callback only folds to mono and forwards raw device-rate chunks over an
// internal channel; AGC + resampling run on the worker loop. Device-open
// errors are reported back synchronously through a ready-channel so the
// manager can log a clear warning and keep the loopback-only session alive.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use crate::audio_toolkit::audio::{FrameResampler, device_display_name};
use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;

use super::SlowTrackingAgc;

/// 30 ms output frames — the shared timing unit of the listen pipeline.
const FRAME_MS: u64 = 30;
/// How long `start()` waits for the worker to report the stream opened.
const OPEN_TIMEOUT: Duration = Duration::from_secs(5);
/// Worker recv timeout so the stop flag is honoured during silence.
const RECV_TIMEOUT: Duration = Duration::from_millis(200);

pub struct MicrophoneCapture {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Default for MicrophoneCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl MicrophoneCapture {
    pub fn new() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            worker: None,
        }
    }

    pub fn is_active(&self) -> bool {
        self.worker.is_some()
    }

    /// Open the preferred (or default) input device and stream 16 kHz mono f32
    /// frames onto `sink`. `preferred_names` is the user's microphone priority
    /// list (first match wins); empty / no match falls back to the default
    /// input device. Returns the resolved device name.
    pub fn start(
        &mut self,
        preferred_names: Vec<String>,
        sink: Sender<Vec<f32>>,
    ) -> Result<String, String> {
        if self.is_active() {
            return Err("microphone capture already active".to_string());
        }
        self.stop.store(false, Ordering::SeqCst);
        let stop = self.stop.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<String, String>>(1);

        let worker = std::thread::Builder::new()
            .name("listen-mic-capture".into())
            .spawn(move || worker_body(preferred_names, sink, stop, ready_tx))
            .map_err(|e| format!("spawn mic capture thread: {e}"))?;

        match ready_rx.recv_timeout(OPEN_TIMEOUT) {
            Ok(Ok(name)) => {
                self.worker = Some(worker);
                Ok(name)
            }
            Ok(Err(err)) => {
                let _ = worker.join();
                Err(err)
            }
            Err(_) => {
                // Worker wedged on open — signal stop and detach; it exits on
                // its own once (if ever) the open returns.
                self.stop.store(true, Ordering::SeqCst);
                Err("timed out opening the microphone".to_string())
            }
        }
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for MicrophoneCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

fn pick_device(host: &cpal::Host, preferred_names: &[String]) -> Option<cpal::Device> {
    if !preferred_names.is_empty()
        && let Ok(devices) = host.input_devices()
    {
        let devices: Vec<cpal::Device> = devices.collect();
        for wanted in preferred_names {
            let wanted = wanted.trim();
            if wanted.is_empty() {
                continue;
            }
            for device in &devices {
                if device_display_name(device).is_ok_and(|name| name.eq_ignore_ascii_case(wanted)) {
                    return Some(device.clone());
                }
            }
        }
    }
    host.default_input_device()
}

fn worker_body(
    preferred_names: Vec<String>,
    sink: Sender<Vec<f32>>,
    stop: Arc<AtomicBool>,
    ready_tx: mpsc::SyncSender<Result<String, String>>,
) {
    let host = crate::audio_toolkit::get_cpal_host();
    let Some(device) = pick_device(&host, &preferred_names) else {
        let _ = ready_tx.send(Err("no input device found".to_string()));
        return;
    };
    let device_name = device_display_name(&device).unwrap_or_else(|_| "Microphone".to_string());
    let config = match device.default_input_config() {
        Ok(config) => config,
        Err(err) => {
            let _ = ready_tx.send(Err(format!("query input config: {err}")));
            return;
        }
    };
    let channels = config.channels() as usize;
    let device_rate = config.sample_rate() as usize;

    // The callback only folds to mono; AGC + resampling run on this thread.
    let (raw_tx, raw_rx) = mpsc::channel::<Vec<f32>>();
    let stream_result = match config.sample_format() {
        cpal::SampleFormat::F32 => build_stream::<f32>(&device, &config, channels, raw_tx),
        cpal::SampleFormat::I16 => build_stream::<i16>(&device, &config, channels, raw_tx),
        cpal::SampleFormat::U16 => build_stream::<u16>(&device, &config, channels, raw_tx),
        cpal::SampleFormat::I32 => build_stream::<i32>(&device, &config, channels, raw_tx),
        cpal::SampleFormat::U8 => build_stream::<u8>(&device, &config, channels, raw_tx),
        cpal::SampleFormat::I8 => build_stream::<i8>(&device, &config, channels, raw_tx),
        other => Err(format!("unsupported mic sample format: {other:?}")),
    };
    let stream = match stream_result {
        Ok(stream) => stream,
        Err(err) => {
            let _ = ready_tx.send(Err(err));
            return;
        }
    };
    if let Err(err) = stream.play() {
        let _ = ready_tx.send(Err(format!("start microphone stream: {err}")));
        return;
    }
    let _ = ready_tx.send(Ok(device_name));

    let mut agc = SlowTrackingAgc::new();
    let mut resampler = match FrameResampler::try_new(
        device_rate,
        WHISPER_SAMPLE_RATE as usize,
        Duration::from_millis(FRAME_MS),
    ) {
        Ok(resampler) => resampler,
        Err(err) => {
            log::error!("[listen-mic] resampler init failed: {err}");
            return;
        }
    };

    while !stop.load(Ordering::SeqCst) {
        let mono = match raw_rx.recv_timeout(RECV_TIMEOUT) {
            Ok(chunk) => chunk,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        // AGC in the int16 domain — identical treatment to the loopback path so
        // the mixer sums two comparably-levelled streams.
        let mut mono_i16: Vec<i16> = mono
            .iter()
            .map(|&s| (s * 32768.0).clamp(-32768.0, 32767.0) as i16)
            .collect();
        agc.process(&mut mono_i16);
        let device_f32 = super::i16_to_f32(&mono_i16);
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
            break;
        }
    }
    drop(stream);
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    channels: usize,
    raw_tx: mpsc::Sender<Vec<f32>>,
) -> Result<cpal::Stream, String>
where
    T: cpal::Sample + cpal::SizedSample + Send + 'static,
    f32: cpal::FromSample<T>,
{
    let stream_cb = move |data: &[T], _info: &cpal::InputCallbackInfo| {
        let mono: Vec<f32> = if channels <= 1 {
            data.iter().map(|&s| s.to_sample::<f32>()).collect()
        } else {
            data.chunks_exact(channels)
                .map(|frame| {
                    frame.iter().map(|&s| s.to_sample::<f32>()).sum::<f32>() / channels as f32
                })
                .collect()
        };
        let _ = raw_tx.send(mono);
    };
    device
        .build_input_stream(
            &config.clone().into(),
            stream_cb,
            |err| log::error!("[listen-mic] stream error: {err}"),
            None,
        )
        .map_err(|e| format!("build mic input stream: {e}"))
}
