use std::{
    collections::VecDeque,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use cpal::{
    Device, Sample, SizedSample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};

use crate::audio_toolkit::{
    VoiceActivityDetector,
    audio::{AudioVisualiser, FrameResampler},
    constants, vad,
};
use crate::winstt::sync_ext::MutexExt;

/// The full captured recording: every 16 kHz mono sample (NO capture-time VAD cropping)
/// plus a per-frame speech mask. The mask granularity is `vad::VAD_FRAME_SAMPLES` (one
/// bool per that many samples, in capture order); `speech_mask.len() * VAD_FRAME_SAMPLES`
/// may be slightly UNDER `samples.len()` when a trailing partial frame was resampled but
/// not labeled. Downstream compaction cuts silence by consulting the mask instead of the
/// recorder dropping frames at capture.
#[derive(Clone, Debug, Default)]
pub struct CapturedAudio {
    pub samples: Vec<f32>,
    pub speech_mask: Vec<bool>,
}

/// Number of resampled 480-frames (~0.96 s at 16 kHz) kept in the warm pre-roll ring while
/// the stream is open but idle, so a `Cmd::Start` can recover speech the user began before
/// the hotkey press registered (and, on a warm stream, hide mic-open latency). Costs nothing
/// when the ring holds silence — downstream mask compaction removes it.
const PREROLL_RING_FRAMES: usize = 32;

enum Cmd {
    Start,
    Stop(mpsc::Sender<CapturedAudio>),
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

/// The recorder worker has two producers: CPAL's input callback and the public
/// start/stop API. Keeping both on one queue lets the worker block until real
/// work arrives instead of waking every few milliseconds to sample a second
/// receiver.
enum WorkerMsg {
    Audio(AudioChunk),
    Command(Cmd),
}

/// Upper bound on how long `Cmd::Stop` blocks draining the input channel for the callback's
/// final `EndOfStream` after signaling the stream to flush. Comfortably covers one WASAPI
/// shared-mode buffer period (~10-30 ms) plus scheduling slack, while capping the wait so a
/// stalled/dead stream that never fires another callback cannot hang the stop reply. On
/// timeout the drain returns with whatever arrived.
/// Upper bound on how long `Cmd::Stop` waits for the callback's `EndOfStream` sentinel. The
/// normal exit is the sentinel itself, which arrives once delivered audio catches up to the
/// stop deadline — i.e. after roughly the device's capture→callback lag (~10-30 ms wired,
/// hundreds of ms on Bluetooth/USB headsets, whose tail audio is exactly what the wait
/// recovers). The budget only bites on a dead/stalled stream, where the reply proceeds with
/// whatever arrived; it must exceed the worst realistic device lag or the tail is lost again.
const STOP_DRAIN_BUDGET: Duration = Duration::from_millis(1500);

/// Drain audio messages from `worker_rx` until the input callback's `EndOfStream` sentinel arrives
/// or `budget`
/// elapses, invoking `on_samples` for each captured chunk. Returns `true` when the sentinel
/// was observed (clean flush), `false` on timeout/disconnect (caller proceeds with what
/// arrived). This is how `Cmd::Stop` recovers audio physically captured DURING the press that
/// is still in transit — sitting in the OS/WASAPI ring buffer, the cpal callback, or this mpsc
/// channel — WITHOUT holding the mic open any longer: the callback keeps forwarding chunks
/// only until the delivered audio's CAPTURE time reaches the stop deadline, trims the boundary
/// chunk exactly there, and emits the sentinel (`plan_stop_chunk`). On devices without usable
/// capture timestamps it degrades to one final buffer + sentinel. Split out of the handler so
/// the drain-to-EOS contract is unit-testable with a scripted channel (no cpal).
fn drain_to_end_of_stream(
    worker_rx: &mpsc::Receiver<WorkerMsg>,
    budget: Duration,
    pending_commands: &mut VecDeque<Cmd>,
    coalesced_stop_replies: &mut Vec<mpsc::Sender<CapturedAudio>>,
    mut on_samples: impl FnMut(Vec<f32>),
) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match worker_rx.recv_timeout(remaining) {
            Ok(WorkerMsg::Audio(AudioChunk::Samples(chunk))) => on_samples(chunk),
            Ok(WorkerMsg::Audio(AudioChunk::EndOfStream)) => return true,
            // Consecutive Stop requests belong to the same in-flight stop. Coalesce
            // only the leading run: once another command is observed, every later
            // command stays deferred in FIFO order (for example Start then Stop is a
            // genuine new recording lifecycle). Replaying a duplicate Stop would ask
            // the callback for a second EOS while its `eos_sent` latch is still set,
            // needlessly consuming the full drain budget.
            Ok(WorkerMsg::Command(Cmd::Stop(reply_tx))) if pending_commands.is_empty() => {
                coalesced_stop_replies.push(reply_tx);
            }
            // Commands used to accumulate on their separate receiver while the
            // bounded EOS drain ran. Preserve that ordering by deferring them
            // until the current stop has finalized.
            Ok(WorkerMsg::Command(command)) => pending_commands.push_back(command),
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {
                return false;
            }
        }
    }
}

fn reply_to_stop_requests(
    primary_reply: mpsc::Sender<CapturedAudio>,
    coalesced_replies: Vec<mpsc::Sender<CapturedAudio>>,
    captured: CapturedAudio,
) {
    for reply_tx in coalesced_replies {
        let _ = reply_tx.send(captured.clone());
    }
    let _ = primary_reply.send(captured);
}

/// How one input callback that fires while a stop is pending disposes of its chunk:
/// how many leading mono frames belong to the recording (captured at or before the stop
/// deadline) and whether the capture boundary has been reached (emit `EndOfStream`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StopChunkPlan {
    keep_frames: usize,
    end_of_stream: bool,
}

/// Decide the fate of an input chunk delivered AFTER a stop was requested.
///
/// Devices deliver audio with a capture→callback latency (`capture_lag_nanos` =
/// callback-timestamp − capture-timestamp of the chunk's FIRST frame). On Bluetooth/USB
/// headsets that lag reaches hundreds of ms, so at the stop instant the last ~lag of the
/// recording is still inside the OS stack — flushing "one more buffer" and closing (the old
/// behavior) permanently dropped it. Instead, keep accepting chunks until the delivered
/// audio's CAPTURE time reaches the stop deadline, then cut exactly there:
/// sample `i` of this chunk was captured at `now − lag + i/rate`; keep while ≤ deadline.
/// This recovers only audio physically captured DURING the press — anything captured after
/// the deadline is trimmed, so capture is never extended.
///
/// Fallbacks (both take the legacy keep-all + immediate-EOS path):
/// - `capture_lag_nanos == None`: the backend provides no usable timestamps.
/// - lag smaller than the chunk's own duration: physically impossible for a real capture
///   (the buffer must fill before it can be delivered), so the timestamps are synthetic —
///   trusting them would cut MORE than the legacy path.
fn plan_stop_chunk(
    now_nanos: u64,
    capture_lag_nanos: Option<u64>,
    deadline_nanos: u64,
    chunk_frames: usize,
    sample_rate: u32,
) -> StopChunkPlan {
    let legacy = StopChunkPlan {
        keep_frames: chunk_frames,
        end_of_stream: true,
    };
    if chunk_frames == 0 || sample_rate == 0 {
        return legacy;
    }
    let chunk_dur_nanos =
        (chunk_frames as u64).saturating_mul(1_000_000_000) / u64::from(sample_rate);
    let Some(lag) = capture_lag_nanos else {
        return legacy;
    };
    if lag < chunk_dur_nanos {
        return legacy;
    }

    // Capture time of the chunk's first frame, epoch-relative.
    let first_capture = now_nanos.saturating_sub(lag);
    if first_capture > deadline_nanos {
        // Entire chunk was captured after the stop — none of it belongs to the recording.
        return StopChunkPlan {
            keep_frames: 0,
            end_of_stream: true,
        };
    }
    // Frames captured in (deadline-first_capture] — the +1 includes the frame captured
    // exactly at the deadline; saturate to the chunk length.
    let pre_deadline =
        (deadline_nanos - first_capture).saturating_mul(u64::from(sample_rate)) / 1_000_000_000;
    let keep = usize::try_from(pre_deadline.saturating_add(1))
        .unwrap_or(usize::MAX)
        .min(chunk_frames);
    StopChunkPlan {
        keep_frames: keep,
        // The boundary landed inside this chunk → the recording is complete. A full keep
        // means audio captured before the deadline may still be in flight — keep draining.
        end_of_stream: keep < chunk_frames,
    }
}

fn send_input_callback_chunk(
    worker_tx: &mpsc::Sender<WorkerMsg>,
    samples: &mut Vec<f32>,
    recycle_rx: &mpsc::Receiver<Vec<f32>>,
    stop_requested: bool,
    send_eos: bool,
    eos_sent: &mut bool,
) {
    if stop_requested && *eos_sent {
        return;
    }

    if !samples.is_empty() {
        let next_capacity = samples.capacity().max(samples.len());
        let chunk = std::mem::take(samples);
        match worker_tx.send(WorkerMsg::Audio(AudioChunk::Samples(chunk))) {
            Ok(()) => {
                *samples = match recycle_rx.try_recv() {
                    Ok(mut recycled) => {
                        recycled.clear();
                        if recycled.capacity() < next_capacity {
                            recycled.reserve(next_capacity - recycled.capacity());
                        }
                        recycled
                    }
                    Err(_) => Vec::with_capacity(next_capacity),
                };
            }
            Err(err) => {
                log::error!("Failed to send samples");
                match err.0 {
                    WorkerMsg::Audio(AudioChunk::Samples(mut returned)) => {
                        returned.clear();
                        *samples = returned;
                    }
                    WorkerMsg::Audio(AudioChunk::EndOfStream) | WorkerMsg::Command(_) => {}
                }
            }
        }
    }

    if send_eos {
        let _ = worker_tx.send(WorkerMsg::Audio(AudioChunk::EndOfStream));
        *eos_sent = true;
    } else if !stop_requested {
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
    worker_tx: Option<mpsc::Sender<WorkerMsg>>,
    worker_handle: Option<std::thread::JoinHandle<()>>,
    vad: Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
    level_cb: Option<Arc<dyn Fn(f32) + Send + Sync + 'static>>,
    /// Fired EXACTLY ONCE per recording, the instant the FIRST raw audio chunk is captured
    /// after a `Cmd::Start` — i.e. the proof the OS actually opened the mic and it is
    /// delivering frames (not merely that `stream.play()` returned). Lets the app surface a
    /// real "recording is live" signal (`stt:capture-active`) instead of lighting the UI on
    /// the keypress, before WASAPI has finished opening an asleep device. None = no-op.
    capture_live_cb: Option<Arc<dyn Fn() + Send + Sync + 'static>>,
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
    /// of the current recording WITHOUT touching the wakeword `chunk_cb` slot (single, taken).
    /// Cleared on Cmd::Start, mem::take'd-equivalent on Stop (the
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
    pub fn new() -> Self {
        AudioRecorder {
            device: None,
            worker_tx: None,
            worker_handle: None,
            vad: None,
            level_cb: None,
            capture_live_cb: None,
            chunk_cb: None,
            speech_cb: None,
            live_audio: Arc::new(Mutex::new(Vec::new())),
            realtime_enabled: Arc::new(AtomicBool::new(false)),
            realtime_audio_signal: Arc::new((
                Mutex::new(RealtimeAudioProgress::default()),
                Condvar::new(),
            )),
        }
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
        F: Fn(f32) + Send + Sync + 'static,
    {
        self.level_cb = Some(Arc::new(cb));
        self
    }

    /// Register a callback fired ONCE per recording on the first captured frame after start
    /// (see `capture_live_cb`). Used to emit `stt:capture-active` so the UI reflects the mic
    /// actually being live rather than the moment the hotkey was pressed.
    pub fn with_capture_live_callback<F>(mut self, cb: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.capture_live_cb = Some(Arc::new(cb));
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

    pub fn open(&mut self, device: Option<Device>) -> Result<(), AudioRecorderError> {
        if self.worker_handle.is_some() {
            return Ok(()); // already open
        }

        let (worker_tx, worker_rx) = mpsc::channel::<WorkerMsg>();
        let public_worker_tx = worker_tx.clone();
        let (recycle_tx, recycle_rx) = mpsc::channel::<Vec<f32>>();
        let (init_tx, init_rx) = mpsc::sync_channel::<Result<(), String>>(1);

        let host = crate::audio_toolkit::get_cpal_host();
        let device = match device {
            Some(dev) => dev,
            None => host
                .default_input_device()
                .ok_or_else(|| AudioDeviceError::NoInputDevice("No input device found".into()))?,
        };

        let thread_device = device.clone();
        let vad = self.vad.clone();
        // Move the optional level callback into the worker thread
        let level_cb = self.level_cb.clone();
        let capture_live_cb = self.capture_live_cb.clone();
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
            // Shared clock for the timestamp-bounded stop: run_consumer stamps the stop
            // instant (nanos since this epoch) into `stop_deadline`, the input callback
            // trims delivered chunks against it (see `plan_stop_chunk`).
            let epoch = Instant::now();
            let stop_deadline = Arc::new(AtomicU64::new(0));
            let stop_deadline_for_stream = stop_deadline.clone();
            let init_result = (|| -> Result<(cpal::Stream, u32), String> {
                let config = AudioRecorder::get_preferred_config(&thread_device)
                    .map_err(|e| format!("Failed to fetch preferred config: {e}"))?;

                let sample_rate = config.sample_rate();
                let channels = config.channels() as usize;

                log::debug!(
                    "[audio] capture_device name={:?} sample_rate_hz={} channels={} format={:?}",
                    super::device_display_name(&thread_device).unwrap_or_else(|_| "Unknown".into()),
                    sample_rate,
                    channels,
                    config.sample_format()
                );

                let stream = match config.sample_format() {
                    cpal::SampleFormat::U8 => AudioRecorder::build_stream::<u8>(
                        &thread_device,
                        &config,
                        worker_tx,
                        recycle_rx,
                        channels,
                        sample_rate,
                        stop_flag_for_stream,
                        epoch,
                        stop_deadline_for_stream.clone(),
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::I8 => AudioRecorder::build_stream::<i8>(
                        &thread_device,
                        &config,
                        worker_tx,
                        recycle_rx,
                        channels,
                        sample_rate,
                        stop_flag_for_stream,
                        epoch,
                        stop_deadline_for_stream.clone(),
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::I16 => AudioRecorder::build_stream::<i16>(
                        &thread_device,
                        &config,
                        worker_tx,
                        recycle_rx,
                        channels,
                        sample_rate,
                        stop_flag_for_stream,
                        epoch,
                        stop_deadline_for_stream.clone(),
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::I32 => AudioRecorder::build_stream::<i32>(
                        &thread_device,
                        &config,
                        worker_tx,
                        recycle_rx,
                        channels,
                        sample_rate,
                        stop_flag_for_stream,
                        epoch,
                        stop_deadline_for_stream.clone(),
                    )
                    .map_err(|e| format!("Failed to build input stream: {e}"))?,
                    cpal::SampleFormat::F32 => AudioRecorder::build_stream::<f32>(
                        &thread_device,
                        &config,
                        worker_tx,
                        recycle_rx,
                        channels,
                        sample_rate,
                        stop_flag_for_stream,
                        epoch,
                        stop_deadline_for_stream.clone(),
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
                        worker_rx,
                        recycle_tx,
                        level_cb,
                        capture_live_cb,
                        chunk_cb,
                        speech_cb,
                        live_audio,
                        realtime_enabled,
                        realtime_audio_signal,
                        stop_flag,
                        epoch,
                        stop_deadline,
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
                self.worker_tx = Some(public_worker_tx);
                self.worker_handle = Some(worker);
                Ok(())
            }
            Ok(Err(error_message)) => {
                let _ = worker.join();
                Err(AudioDeviceError::classify(&error_message).into())
            }
            Err(recv_error) => {
                let _ = worker.join();
                Err(AudioRecorderError::ResponseChannel(format!(
                    "Failed to initialize microphone worker: {recv_error}"
                )))
            }
        }
    }

    pub fn start(&self) -> Result<(), AudioRecorderError> {
        if let Some(tx) = &self.worker_tx {
            tx.send(WorkerMsg::Command(Cmd::Start))
                .map_err(|err| AudioRecorderError::CommandChannel(err.to_string()))?;
        }
        Ok(())
    }

    /// Stop the recording and return the FULL capture — every sample plus the per-frame
    /// speech mask (see `CapturedAudio`). No VAD cropping happens at capture; silence is cut
    /// downstream via the mask. Returns an empty capture if the worker was never opened.
    pub fn stop_captured(&self) -> Result<CapturedAudio, AudioRecorderError> {
        let (resp_tx, resp_rx) = mpsc::channel();
        if let Some(tx) = &self.worker_tx {
            tx.send(WorkerMsg::Command(Cmd::Stop(resp_tx)))
                .map_err(|err| AudioRecorderError::CommandChannel(err.to_string()))?;
        } else {
            return Ok(CapturedAudio::default());
        }
        resp_rx
            .recv()
            .map_err(|err| AudioRecorderError::ResponseChannel(err.to_string()))
    }

    /// Back-compat wrapper returning ONLY the samples of the capture. Thin shim over
    /// `stop_captured` so existing call sites keep compiling until integration migrates them
    /// to the mask-aware path; the speech mask it carries is discarded here.
    pub fn stop(&self) -> Result<Vec<f32>, AudioRecorderError> {
        Ok(self.stop_captured()?.samples)
    }

    pub fn close(&mut self) -> Result<(), AudioRecorderError> {
        if let Some(tx) = self.worker_tx.take() {
            let _ = tx.send(WorkerMsg::Command(Cmd::Shutdown));
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
        self.live_audio.lock_recover().clone()
    }

    /// Snapshot only the TAIL of the live recording mirror past `offset` samples, plus the
    /// current total length. Returns `(total_len, tail)` where `tail == live_audio[offset..]`
    /// (an empty Vec when `offset >= total_len`). The realtime worker passes its committed-frame
    /// watermark as `offset` and never reads audio before it, so the clone is O(new samples)
    /// instead of O(N) — eliminating the O(N²)-per-utterance full-buffer clone on every tick.
    /// Indices the caller derives from absolute frame numbers must be re-based by `offset`.
    pub fn snapshot_from(&self, offset: usize) -> (usize, Vec<f32>) {
        let mirror = self.live_audio.lock_recover();
        let total = mirror.len();
        let tail = if offset < total {
            mirror[offset..].to_vec()
        } else {
            Vec::new()
        };
        (total, tail)
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "the input-callback wiring (channels, timing epoch, stop signals) has no meaningful grouping that would aid clarity"
    )]
    fn build_stream<T>(
        device: &cpal::Device,
        config: &cpal::SupportedStreamConfig,
        worker_tx: mpsc::Sender<WorkerMsg>,
        recycle_rx: mpsc::Receiver<Vec<f32>>,
        channels: usize,
        sample_rate: u32,
        stop_flag: Arc<AtomicBool>,
        // Epoch that `stop_deadline` nanos are relative to (shared with run_consumer, which
        // stamps the deadline at Cmd::Stop). Instants are monotonic and cross-thread ordered.
        epoch: Instant,
        // Stop instant in nanos since `epoch`; 0 = no stop pending. Written by run_consumer
        // BEFORE it raises `stop_flag` (Release/Acquire pairing on the flag).
        stop_deadline: Arc<AtomicU64>,
    ) -> Result<cpal::Stream, cpal::BuildStreamError>
    where
        T: Sample + SizedSample + Send + 'static,
        f32: cpal::FromSample<T>,
    {
        let mut output_buffer = Vec::new();
        let mut eos_sent = false;

        // Channel-aware downmix calibration: accumulate per-channel sum-of-squares over the
        // first ~500 ms, then decide ONCE whether a channel is dead/broken (>20 dB below the
        // loudest) and latch loudest-channel selection for the rest of the stream. Until the
        // window completes we mean-downmix; the level step at the switch is absorbed by the
        // downstream peak-normalize. Only multi-channel devices calibrate.
        let calib_budget: u64 = (u64::from(sample_rate) * 500 / 1000).max(1);
        let mut calib_sumsq = vec![0.0f64; channels];
        // Σx alongside Σx² so `decide_downmix_mode` can subtract each channel's mean: a
        // constant-DC dead channel must NOT read as loud on its raw Σx².
        let mut calib_sum = vec![0.0f64; channels];
        let mut calib_frames: u64 = 0;
        let mut downmix_mode = DownmixMode::Mean;

        let stream_cb = move |data: &[T], info: &cpal::InputCallbackInfo| {
            let stop_requested = stop_flag.load(Ordering::Acquire);
            if stop_requested && eos_sent {
                return;
            }

            output_buffer.clear();

            if channels == 1 {
                output_buffer.reserve(data.len());
                output_buffer.extend(data.iter().map(|&sample| sample.to_sample::<f32>()));
            } else {
                let frame_count = data.len() / channels;
                output_buffer.reserve(frame_count);

                for frame in data.chunks_exact(channels) {
                    if calib_frames < calib_budget {
                        for (c, &sample) in frame.iter().enumerate() {
                            let v = f64::from(sample.to_sample::<f32>());
                            calib_sumsq[c] += v * v;
                            calib_sum[c] += v;
                        }
                        calib_frames += 1;
                        if calib_frames >= calib_budget {
                            downmix_mode =
                                decide_downmix_mode(&calib_sumsq, &calib_sum, calib_frames);
                            match downmix_mode {
                                DownmixMode::SelectChannel(idx) => log::debug!(
                                    "Downmix: dead channel detected (>20 dB imbalance); selecting channel {idx} of {channels}"
                                ),
                                DownmixMode::Mean => log::debug!(
                                    "Downmix: {channels} channels balanced; using mean downmix"
                                ),
                            }
                        }
                    }

                    let mono_sample = match downmix_mode {
                        DownmixMode::Mean => {
                            frame
                                .iter()
                                .map(|&sample| sample.to_sample::<f32>())
                                .sum::<f32>()
                                / channels as f32
                        }
                        DownmixMode::SelectChannel(idx) => frame[idx].to_sample::<f32>(),
                    };
                    output_buffer.push(mono_sample);
                }
            }

            let mut send_eos = false;
            if stop_requested {
                // Timestamp-bounded stop: keep only the frames captured at or before the
                // stop deadline, and close the stream's take exactly when delivered audio
                // catches up to it (see `plan_stop_chunk`). A 0 deadline means the stop was
                // signalled without a stamp (defensive) — treat as "cut here, now".
                let deadline = stop_deadline.load(Ordering::Acquire);
                let now_nanos = u64::try_from(epoch.elapsed().as_nanos()).unwrap_or(u64::MAX);
                let deadline = if deadline == 0 { now_nanos } else { deadline };
                let lag = {
                    let ts = info.timestamp();
                    ts.callback
                        .duration_since(&ts.capture)
                        .map(|d| u64::try_from(d.as_nanos()).unwrap_or(u64::MAX))
                };
                let plan =
                    plan_stop_chunk(now_nanos, lag, deadline, output_buffer.len(), sample_rate);
                output_buffer.truncate(plan.keep_frames);
                send_eos = plan.end_of_stream;
            }

            send_input_callback_chunk(
                &worker_tx,
                &mut output_buffer,
                &recycle_rx,
                stop_requested,
                send_eos,
                &mut eos_sent,
            );
        };

        device.build_input_stream(
            &config.clone().into(),
            stream_cb,
            |err| log::error!("Stream error: {}", err),
            None,
        )
    }

    fn get_preferred_config(device: &cpal::Device) -> Result<cpal::SupportedStreamConfig, String> {
        // Use the device's native/default sample rate and let the FrameResampler
        // in run_consumer() downsample to 16kHz. This avoids forcing hardware into
        // a non-native rate which can cause issues on some devices (Bluetooth
        // codecs, certain ALSA drivers, etc.).
        let default_config = device
            .default_input_config()
            .map_err(|err| format!("failed to read default input config: {err}"))?;
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

impl Default for AudioRecorder {
    fn default() -> Self {
        Self::new()
    }
}

/// How the multi-channel input callback collapses to mono once calibration latches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DownmixMode {
    /// Unweighted mean of all channels (the default, and what runs during calibration).
    Mean,
    /// Take a single channel by index — the LOUDEST — because a channel was found dead
    /// (>20 dB below the loudest), so averaging it in would halve the level and/or inject
    /// its noise/silence.
    SelectChannel(usize),
}

/// Decide the downmix mode from per-channel Σx² and Σx accumulated over the calibration window.
/// `sumsq[c]` is Σx² and `sum[c]` is Σx for channel `c`; `frames` is the per-channel sample count
/// (equal across channels). Ranking is by AC VARIANCE — `Σx²/N − (Σx/N)²`, the mean-subtracted
/// (DC-immune) power — NOT raw Σx²: a dead channel carrying a constant DC offset has a large Σx²
/// but ~zero variance, so ranking on Σx² would wrongly latch it as the "loudest" and discard the
/// live voice channel. Returns `SelectChannel(loudest)` when the quietest channel's RMS is below
/// the loudest channel's RMS / 10 (a >20 dB imbalance in AC power, i.e. a dead/broken channel),
/// else `Mean`. Pure so it is unit-testable without cpal.
fn decide_downmix_mode(sumsq: &[f64], sum: &[f64], frames: u64) -> DownmixMode {
    if sumsq.len() < 2 || sum.len() != sumsq.len() || frames == 0 {
        return DownmixMode::Mean;
    }
    let n = frames as f64;
    // AC variance = E[x²] − E[x]², clamped against fp rounding: DC-immune, so a constant-offset
    // channel reads ~0 despite a large Σx².
    let variance = |c: usize| (sumsq[c] / n - (sum[c] / n).powi(2)).max(0.0);
    let mut max_v = f64::MIN;
    let mut min_v = f64::MAX;
    let mut loudest = 0usize;
    for c in 0..sumsq.len() {
        let v = variance(c);
        if v > max_v {
            max_v = v;
            loudest = c;
        }
        if v < min_v {
            min_v = v;
        }
    }
    if max_v <= 0.0 {
        // No AC energy on any channel during calibration — no basis to call a channel dead.
        return DownmixMode::Mean;
    }
    // RMS_q < RMS_max / 10  ⇔  Var_q < Var_max / 100.
    if min_v < max_v / 100.0 {
        DownmixMode::SelectChannel(loudest)
    } else {
        DownmixMode::Mean
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

#[derive(Debug, thiserror::Error)]
pub enum AudioRecorderError {
    #[error(transparent)]
    Device(#[from] AudioDeviceError),

    #[error("recorder command channel closed: {0}")]
    CommandChannel(String),

    #[error("recorder response channel closed: {0}")]
    ResponseChannel(String),
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
#[expect(
    clippy::items_after_test_module,
    reason = "run_consumer is defined below the tests; keeping it in place avoids a risky reorder"
)]
mod tests {
    use std::{sync::mpsc, time::Duration};

    use super::{
        AudioChunk, AudioDeviceError, Cmd, WorkerMsg, drain_to_end_of_stream,
        is_microphone_access_denied, is_no_input_device_error, plan_stop_chunk,
        send_input_callback_chunk,
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
        let (_recycle_tx, recycle_rx) = mpsc::channel();
        let mut samples = vec![0.25, -0.5, 0.75];
        let mut eos_sent = false;

        send_input_callback_chunk(&tx, &mut samples, &recycle_rx, true, true, &mut eos_sent);

        match rx.recv().unwrap() {
            WorkerMsg::Audio(AudioChunk::Samples(samples)) => {
                assert_eq!(samples, vec![0.25, -0.5, 0.75]);
            }
            WorkerMsg::Audio(AudioChunk::EndOfStream) | WorkerMsg::Command(_) => {
                panic!("expected samples before end-of-stream");
            }
        }
        assert!(matches!(
            rx.recv().unwrap(),
            WorkerMsg::Audio(AudioChunk::EndOfStream)
        ));
        assert!(eos_sent);
    }

    #[test]
    fn stop_callback_drops_callbacks_after_end_of_stream_was_sent() {
        let (tx, rx) = mpsc::channel();
        let (_recycle_tx, recycle_rx) = mpsc::channel();
        let mut samples = vec![1.0];
        let mut eos_sent = true;

        send_input_callback_chunk(&tx, &mut samples, &recycle_rx, true, true, &mut eos_sent);

        assert!(rx.try_recv().is_err());
        assert!(eos_sent);
    }

    // ---- plan_stop_chunk: the timestamp-bounded stop boundary ---------------------- //
    // Scenario constants: 48 kHz input, 10 ms chunks (480 frames), nanos everywhere.
    const RATE: u32 = 48_000;
    const CHUNK: usize = 480;
    const MS: u64 = 1_000_000;

    #[test]
    fn plan_without_timestamps_takes_legacy_path() {
        let plan = plan_stop_chunk(1_000 * MS, None, 990 * MS, CHUNK, RATE);
        assert_eq!(plan.keep_frames, CHUNK, "keep-all fallback");
        assert!(plan.end_of_stream, "immediate EOS fallback");
    }

    #[test]
    fn plan_with_synthetic_lag_smaller_than_chunk_takes_legacy_path() {
        // A real capture cannot be delivered before its own buffer filled; lag below the
        // chunk duration (10 ms) means the timestamps are synthetic — do not trust them.
        let plan = plan_stop_chunk(1_000 * MS, Some(3 * MS), 990 * MS, CHUNK, RATE);
        assert_eq!(plan.keep_frames, CHUNK);
        assert!(plan.end_of_stream);
    }

    #[test]
    fn plan_keeps_whole_pre_deadline_chunk_and_stays_open() {
        // BT-style 400 ms lag: a callback 50 ms after the deadline carries audio captured
        // 350 ms BEFORE it — all pre-deadline, and more is still in flight → no EOS yet.
        let deadline = 1_000 * MS;
        let now = deadline + 50 * MS;
        let plan = plan_stop_chunk(now, Some(400 * MS), deadline, CHUNK, RATE);
        assert_eq!(
            plan.keep_frames, CHUNK,
            "entire chunk was captured before the stop"
        );
        assert!(!plan.end_of_stream, "boundary not reached; keep draining");
    }

    #[test]
    fn plan_trims_boundary_chunk_at_deadline_and_closes() {
        // The callback whose chunk STRADDLES the deadline: captured [deadline-5ms,
        // deadline+5ms] → keep the first ~5 ms (240 frames ±1) and emit EOS.
        let deadline = 1_000 * MS;
        let lag = 400 * MS;
        let now = deadline + lag - 5 * MS; // first frame captured at deadline − 5 ms
        let plan = plan_stop_chunk(now, Some(lag), deadline, CHUNK, RATE);
        assert!(
            (239..=241).contains(&plan.keep_frames),
            "~5 ms of 48 kHz kept, got {}",
            plan.keep_frames
        );
        assert!(
            plan.end_of_stream,
            "boundary inside this chunk closes the take"
        );
    }

    #[test]
    fn plan_drops_fully_post_deadline_chunk_and_closes() {
        let deadline = 1_000 * MS;
        let lag = 400 * MS;
        let now = deadline + lag + 30 * MS; // first frame captured 30 ms after the stop
        let plan = plan_stop_chunk(now, Some(lag), deadline, CHUNK, RATE);
        assert_eq!(
            plan.keep_frames, 0,
            "no sample of this chunk belongs to the press"
        );
        assert!(plan.end_of_stream);
    }

    #[test]
    fn plan_recovers_full_bt_lag_across_successive_callbacks() {
        // End-to-end shape of the 400 ms-lag stop: callbacks every 10 ms after the stop
        // keep passing whole chunks (audio captured before release still draining) until
        // delivered capture-time reaches the deadline ~lag later — the exact audio the old
        // one-more-buffer stop dropped.
        let deadline = 1_000 * MS;
        let lag = 400 * MS;
        let mut kept: usize = 0;
        let mut closed = false;
        for k in 1..=60 {
            let now = deadline + k * 10 * MS;
            let plan = plan_stop_chunk(now, Some(lag), deadline, CHUNK, RATE);
            kept += plan.keep_frames;
            if plan.end_of_stream {
                closed = true;
                break;
            }
        }
        assert!(closed, "the drain must terminate");
        // ~400 ms of 48 kHz audio recovered after the stop instant (±1 chunk of rounding).
        let expected = (400 * 48) as usize;
        assert!(
            kept >= expected - CHUNK && kept <= expected + CHUNK,
            "recovered {kept} frames, expected ~{expected}"
        );
    }

    #[test]
    fn drain_to_end_of_stream_collects_until_sentinel() {
        // Scripted channel: two captured chunks, then EndOfStream, then a stray chunk that
        // arrived AFTER the sentinel. The bounded drain must recover both pre-sentinel chunks,
        // stop at the sentinel, and never pull the post-sentinel sample (which would be audio
        // captured after the flush boundary).
        let (tx, rx) = mpsc::channel();
        tx.send(WorkerMsg::Audio(AudioChunk::Samples(vec![1.0, 2.0])))
            .unwrap();
        tx.send(WorkerMsg::Command(Cmd::Start)).unwrap();
        tx.send(WorkerMsg::Audio(AudioChunk::Samples(vec![3.0])))
            .unwrap();
        tx.send(WorkerMsg::Audio(AudioChunk::EndOfStream)).unwrap();
        tx.send(WorkerMsg::Audio(AudioChunk::Samples(vec![9.0])))
            .unwrap();

        let mut got: Vec<f32> = Vec::new();
        let mut pending_commands = VecDeque::new();
        let mut coalesced_stop_replies = Vec::new();
        let saw_eos = drain_to_end_of_stream(
            &rx,
            Duration::from_millis(250),
            &mut pending_commands,
            &mut coalesced_stop_replies,
            |c| got.extend(c),
        );

        assert!(saw_eos, "sentinel observed -> clean flush");
        assert_eq!(
            got,
            vec![1.0, 2.0, 3.0],
            "all pre-sentinel samples recovered, nothing after"
        );
        assert!(matches!(pending_commands.pop_front(), Some(Cmd::Start)));
        assert!(coalesced_stop_replies.is_empty());
    }

    #[test]
    fn drain_to_end_of_stream_times_out_without_sentinel() {
        // A stalled/dead stream never emits EndOfStream: the drain must return `false` after the
        // budget rather than block forever, keeping whatever arrived. tx stays alive so the
        // channel is Timeout (not Disconnected).
        let (tx, rx) = mpsc::channel();
        tx.send(WorkerMsg::Audio(AudioChunk::Samples(vec![1.0])))
            .unwrap();

        let mut got: Vec<f32> = Vec::new();
        let mut pending_commands = VecDeque::new();
        let mut coalesced_stop_replies = Vec::new();
        let saw_eos = drain_to_end_of_stream(
            &rx,
            Duration::from_millis(30),
            &mut pending_commands,
            &mut coalesced_stop_replies,
            |c| got.extend(c),
        );

        assert!(!saw_eos, "no sentinel -> timeout path");
        assert_eq!(got, vec![1.0], "the in-flight chunk is still recovered");
        drop(tx);
    }

    #[test]
    fn drain_coalesces_only_consecutive_stop_requests() {
        let (worker_tx, worker_rx) = mpsc::channel();
        let (primary_tx, primary_rx) = mpsc::channel();
        let (duplicate_tx, duplicate_rx) = mpsc::channel();
        let (later_tx, later_rx) = mpsc::channel();

        worker_tx
            .send(WorkerMsg::Command(Cmd::Stop(duplicate_tx)))
            .unwrap();
        worker_tx.send(WorkerMsg::Command(Cmd::Start)).unwrap();
        worker_tx
            .send(WorkerMsg::Command(Cmd::Stop(later_tx)))
            .unwrap();
        worker_tx
            .send(WorkerMsg::Audio(AudioChunk::EndOfStream))
            .unwrap();

        let mut pending_commands = VecDeque::new();
        let mut coalesced_stop_replies = Vec::new();
        assert!(drain_to_end_of_stream(
            &worker_rx,
            Duration::from_secs(1),
            &mut pending_commands,
            &mut coalesced_stop_replies,
            |_| {},
        ));

        let captured = CapturedAudio {
            samples: vec![0.25, -0.5],
            speech_mask: vec![true],
        };
        reply_to_stop_requests(primary_tx, coalesced_stop_replies, captured.clone());

        assert_eq!(primary_rx.try_recv().unwrap().samples, captured.samples);
        assert_eq!(duplicate_rx.try_recv().unwrap().samples, captured.samples);
        assert!(later_rx.try_recv().is_err());
        assert!(matches!(pending_commands.pop_front(), Some(Cmd::Start)));
        assert!(matches!(pending_commands.pop_front(), Some(Cmd::Stop(_))));
        assert!(pending_commands.is_empty());
    }

    #[test]
    fn stop_callback_reuses_recycled_buffer_after_send() {
        let (tx, rx) = mpsc::channel();
        let (recycle_tx, recycle_rx) = mpsc::channel();
        let recycled = Vec::<f32>::with_capacity(64);
        recycle_tx.send(recycled).unwrap();
        let mut samples = vec![1.0, 2.0];
        let mut eos_sent = false;

        send_input_callback_chunk(&tx, &mut samples, &recycle_rx, false, false, &mut eos_sent);

        assert!(matches!(
            rx.recv().unwrap(),
            WorkerMsg::Audio(AudioChunk::Samples(_))
        ));
        assert!(samples.is_empty());
        assert!(samples.capacity() >= 64);
        assert!(!eos_sent);
    }

    // ---------- capture-core reworks ------------------------------------- //

    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex},
    };

    use anyhow::Result;

    use super::{
        CapturedAudio, DownmixMode, PREROLL_RING_FRAMES, decide_downmix_mode, handle_frame,
        push_preroll_frame, push_speech_mask, reply_to_stop_requests, seed_preroll,
        seeded_onset_should_signal,
    };
    use crate::audio_toolkit::vad::{self, SpeechLabel, VadFrame, VoiceActivityDetector};

    /// Test detector driven by a scripted list of `SpeechLabel`s through the LABELED API,
    /// so `handle_frame`'s mask/retro logic can be exercised deterministically.
    struct LabelVad {
        seq: VecDeque<SpeechLabel>,
    }
    impl VoiceActivityDetector for LabelVad {
        fn push_frame<'a>(&'a mut self, _frame: &'a [f32]) -> Result<VadFrame<'a>> {
            Ok(VadFrame::Noise)
        }
        fn push_frame_labeled(&mut self, _frame: &[f32]) -> Result<SpeechLabel> {
            Ok(self.seq.pop_front().unwrap_or_default())
        }
    }

    fn boxed_vad(
        seq: impl IntoIterator<Item = SpeechLabel>,
    ) -> Option<Arc<Mutex<Box<dyn VoiceActivityDetector>>>> {
        let vad: Box<dyn VoiceActivityDetector> = Box::new(LabelVad {
            seq: seq.into_iter().collect(),
        });
        Some(Arc::new(Mutex::new(vad)))
    }

    fn label(is_speech: bool, retro_frames: usize) -> SpeechLabel {
        SpeechLabel {
            is_speech,
            retro_frames,
        }
    }

    const FR: usize = vad::VAD_FRAME_SAMPLES;

    #[test]
    fn captured_audio_defaults_empty() {
        let cap = CapturedAudio::default();
        assert!(cap.samples.is_empty());
        assert!(cap.speech_mask.is_empty());
    }

    #[test]
    fn handle_frame_none_vad_appends_and_labels_every_frame_speech() {
        // No VAD: every recorded frame is kept AND marked speech; mask stays 1:1 with frames.
        let vad = None;
        let mut out = Vec::new();
        let mut mask = Vec::new();
        let frame = vec![0.3f32; FR];
        for _ in 0..3 {
            assert!(handle_frame(&frame, true, &vad, &mut out, &mut mask));
        }
        assert_eq!(out.len(), 3 * FR, "every frame appended (ungated)");
        assert_eq!(mask.len(), 3, "one mask entry per appended frame");
        assert!(mask.iter().all(|&m| m));
    }

    #[test]
    fn handle_frame_not_recording_is_noop() {
        let vad = None;
        let mut out = Vec::new();
        let mut mask = Vec::new();
        assert!(!handle_frame(&[0.0; FR], false, &vad, &mut out, &mut mask));
        assert!(out.is_empty());
        assert!(mask.is_empty());
    }

    #[test]
    fn handle_frame_keeps_noise_frames_but_labels_them_false() {
        // Silence/noise frames are NO LONGER dropped — they are appended and labeled false.
        let vad = boxed_vad([label(false, 0), label(false, 0)]);
        let mut out = Vec::new();
        let mut mask = Vec::new();
        let frame = vec![0.1f32; FR];
        assert!(!handle_frame(&frame, true, &vad, &mut out, &mut mask));
        assert!(!handle_frame(&frame, true, &vad, &mut out, &mut mask));
        assert_eq!(out.len(), 2 * FR, "noise frames kept in the buffer");
        assert_eq!(mask, vec![false, false]);
    }

    #[test]
    fn handle_frame_onset_retro_marks_preceding_mask_entries() {
        // Two idle-labeled frames, then an onset carrying retro_frames=2: the two preceding
        // entries flip to speech, reproducing the pre-roll the old gating path prepended.
        let vad = boxed_vad([
            label(false, 0),
            label(false, 0),
            label(true, 2),
            label(true, 0),
        ]);
        let mut out = Vec::new();
        let mut mask = Vec::new();
        let frame = vec![0.4f32; FR];
        for _ in 0..4 {
            handle_frame(&frame, true, &vad, &mut out, &mut mask);
        }
        assert_eq!(out.len(), 4 * FR);
        assert_eq!(
            mask,
            vec![true, true, true, true],
            "retro flips the two pre-onset entries to speech"
        );
    }

    #[test]
    fn push_speech_mask_flips_only_the_retro_window() {
        // Pre-existing history: two false, then several earlier entries that must stay put.
        let mut mask = vec![false, true, false, false]; // indices 0..4 pre-onset
        push_speech_mask(&mut mask, &label(true, 2));
        // pushed current (index 4)=true; retro flips indices 2,3 (not 0,1).
        assert_eq!(mask, vec![false, true, true, true, true]);
    }

    #[test]
    fn push_speech_mask_retro_saturates_at_buffer_start() {
        let mut mask = vec![false]; // only one prior entry
        push_speech_mask(&mut mask, &label(true, 5));
        // retro of 5 but only index 0 precedes the current -> flip it, no panic.
        assert_eq!(mask, vec![true, true]);
    }

    #[test]
    fn push_preroll_frame_bounds_the_ring_and_keeps_newest() {
        let mut ring: VecDeque<Vec<f32>> = VecDeque::new();
        for i in 0..(PREROLL_RING_FRAMES + 5) {
            push_preroll_frame(&mut ring, &[i as f32; FR]);
        }
        assert_eq!(ring.len(), PREROLL_RING_FRAMES, "ring is bounded");
        // Oldest 5 evicted -> front holds frame index 5, back holds the newest.
        assert_eq!(ring.front().unwrap()[0], 5.0);
        assert_eq!(
            ring.back().unwrap()[0],
            (PREROLL_RING_FRAMES + 4) as f32,
            "newest frame retained"
        );
    }

    #[test]
    fn seed_preroll_replays_ring_oldest_to_newest_and_drains() {
        // No VAD: seeding appends every ring frame in order and marks them speech; the ring
        // is drained. speech_cb is structurally impossible here (seed_preroll takes none).
        let vad = None;
        let mut ring: VecDeque<Vec<f32>> = VecDeque::new();
        ring.push_back(vec![1.0; FR]);
        ring.push_back(vec![2.0; FR]);
        ring.push_back(vec![3.0; FR]);
        let mut out = Vec::new();
        let mut mask = Vec::new();
        let speaking = seed_preroll(&mut ring, &vad, &mut out, &mut mask);
        assert!(ring.is_empty(), "ring drained after seeding");
        assert_eq!(out.len(), 3 * FR);
        assert_eq!(out[0], 1.0, "oldest replayed first");
        assert_eq!(out[FR], 2.0);
        assert_eq!(out[2 * FR], 3.0, "newest replayed last");
        assert_eq!(mask.len(), 3);
        assert!(speaking, "no-VAD seed ends speaking");
    }

    #[test]
    fn seed_preroll_labels_ring_frames_through_vad() {
        // The ring frames are labeled honestly by the VAD: a mid-ring onset with retro=1
        // flips the entry before it, and the final verdict propagates to `vad_speaking`.
        let vad = boxed_vad([label(false, 0), label(true, 1), label(false, 0)]);
        let mut ring: VecDeque<Vec<f32>> = VecDeque::new();
        ring.push_back(vec![0.1; FR]);
        ring.push_back(vec![0.2; FR]);
        ring.push_back(vec![0.3; FR]);
        let mut out = Vec::new();
        let mut mask = Vec::new();
        let speaking = seed_preroll(&mut ring, &vad, &mut out, &mut mask);
        assert_eq!(
            mask,
            vec![true, true, false],
            "onset retro flips prior entry"
        );
        assert!(!speaking, "last ring frame labeled non-speech");
    }

    #[test]
    fn seed_preroll_trims_leading_noise_frames() {
        // Pre-hotkey room noise before the onset must not enter the take: the realtime
        // preview decodes the raw buffer (no mask compaction), so seeded noise made the
        // live pill hallucinate phantom text at the start of every recording. Frames:
        // noise, noise, onset(retro=1 flips frame 2), speech → frame 1 is trimmed,
        // frames 2..4 (the retro pre-roll + the utterance) are kept.
        let vad = boxed_vad([
            label(false, 0),
            label(false, 0),
            label(true, 1),
            label(true, 0),
        ]);
        let mut ring: VecDeque<Vec<f32>> = VecDeque::new();
        ring.push_back(vec![1.0; FR]);
        ring.push_back(vec![2.0; FR]);
        ring.push_back(vec![3.0; FR]);
        ring.push_back(vec![4.0; FR]);
        let mut out = Vec::new();
        let mut mask = Vec::new();
        let speaking = seed_preroll(&mut ring, &vad, &mut out, &mut mask);
        assert_eq!(mask, vec![true, true, true], "leading noise entry trimmed");
        assert_eq!(out.len(), 3 * FR);
        assert_eq!(out[0], 2.0, "buffer now starts at the retro-flipped frame");
        assert!(speaking);
    }

    #[test]
    fn seed_preroll_all_noise_seeds_nothing() {
        // A ring holding only silence/noise (the common idle case) seeds an empty take —
        // nothing for the realtime preview to hallucinate on.
        let vad = boxed_vad([label(false, 0), label(false, 0)]);
        let mut ring: VecDeque<Vec<f32>> = VecDeque::new();
        ring.push_back(vec![0.1; FR]);
        ring.push_back(vec![0.2; FR]);
        let mut out = Vec::new();
        let mut mask = Vec::new();
        let speaking = seed_preroll(&mut ring, &vad, &mut out, &mut mask);
        assert!(out.is_empty());
        assert!(mask.is_empty());
        assert!(!speaking);
    }

    #[test]
    fn seeded_onset_signals_only_with_vad_and_seeded_speech() {
        // A recording that begins mid-speech must surface one speech_cb(true) so the manager's
        // no-speech watchdog does not discard a valid gap-free utterance.
        assert!(seeded_onset_should_signal(true, true));
        // Seeded into silence: nothing to surface.
        assert!(!seeded_onset_should_signal(true, false));
        // No VAD: vad_speaking is not tracked, so signaling would desync — never fire.
        assert!(!seeded_onset_should_signal(false, true));
        assert!(!seeded_onset_should_signal(false, false));
    }

    #[test]
    fn downmix_stays_mean_when_channels_balanced() {
        // Zero-mean channels: variance == Σx²/N, so these mirror the original balanced cases.
        // Two channels at equal energy: no dead channel, keep the mean downmix.
        assert_eq!(
            decide_downmix_mode(&[4.0, 4.0], &[0.0, 0.0], 100),
            DownmixMode::Mean
        );
        // Within 20 dB (factor 100 in variance) also stays mean: 4.0 vs 0.05 -> ratio 80 < 100.
        assert_eq!(
            decide_downmix_mode(&[4.0, 0.05], &[0.0, 0.0], 100),
            DownmixMode::Mean
        );
    }

    #[test]
    fn downmix_selects_loudest_when_a_channel_is_dead() {
        // Channel 1 is >20 dB below channel 0 (variance ratio > 100) -> select the loudest (0).
        assert_eq!(
            decide_downmix_mode(&[4.0, 0.01], &[0.0, 0.0], 100),
            DownmixMode::SelectChannel(0)
        );
        // Loudest can be any index; here channel 2 dominates a dead channel 0.
        assert_eq!(
            decide_downmix_mode(&[0.001, 2.0, 8.0], &[0.0, 0.0, 0.0], 100),
            DownmixMode::SelectChannel(2)
        );
    }

    #[test]
    fn downmix_ignores_dc_biased_dead_channel() {
        // Channel 0 carries a constant DC offset (large Σx² but ZERO AC variance); channel 1 is
        // the genuinely-live-but-quiet voice channel. Ranking on raw Σx² would latch the DC
        // channel as "loudest" and discard the voice; the DC-immune variance ranks channel 1
        // loudest and selects it.
        let frames = 100u64;
        let n = frames as f64;
        let dc = 0.03f64;
        let sum = vec![n * dc, 0.0];
        let sumsq = vec![n * dc * dc, 0.02];
        assert!(
            sumsq[0] > sumsq[1],
            "raw Σx² would (wrongly) rank the DC channel loudest"
        );
        assert_eq!(
            decide_downmix_mode(&sumsq, &sum, frames),
            DownmixMode::SelectChannel(1),
            "DC-only channel is not loud in AC power; the live voice channel is selected"
        );
    }

    #[test]
    fn downmix_guards_degenerate_inputs() {
        // Mono / empty / zero-frame / total-silence never trigger channel selection.
        assert_eq!(decide_downmix_mode(&[9.0], &[0.0], 100), DownmixMode::Mean);
        assert_eq!(decide_downmix_mode(&[], &[], 100), DownmixMode::Mean);
        assert_eq!(
            decide_downmix_mode(&[4.0, 0.0], &[0.0, 0.0], 0),
            DownmixMode::Mean
        );
        assert_eq!(
            decide_downmix_mode(&[0.0, 0.0], &[0.0, 0.0], 100),
            DownmixMode::Mean
        );
        // Mismatched sum/sumsq lengths are treated as degenerate (defensive).
        assert_eq!(
            decide_downmix_mode(&[4.0, 0.01], &[0.0], 100),
            DownmixMode::Mean
        );
    }
}

fn publish_realtime_audio_progress(
    signal: &Arc<(Mutex<RealtimeAudioProgress>, Condvar)>,
    len: usize,
) {
    let (lock, cvar) = &**signal;
    let mut progress = lock.lock_recover();
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
    worker_rx: mpsc::Receiver<WorkerMsg>,
    recycle_tx: mpsc::Sender<Vec<f32>>,
    level_cb: Option<Arc<dyn Fn(f32) + Send + Sync + 'static>>,
    // Fired once per recording on the first captured frame after Cmd::Start (mic confirmed live).
    capture_live_cb: Option<Arc<dyn Fn() + Send + Sync + 'static>>,
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
    // Clock shared with the input callback for the timestamp-bounded stop (see build_stream).
    epoch: Instant,
    stop_deadline: Arc<AtomicU64>,
) {
    let mut frame_resampler = match FrameResampler::try_new(
        in_sample_rate as usize,
        constants::WHISPER_SAMPLE_RATE as usize,
        Duration::from_millis(30),
    ) {
        Ok(resampler) => resampler,
        Err(err) => {
            log::error!("Failed to initialize frame resampler: {err}");
            return;
        }
    };

    let mut processed_samples = Vec::<f32>::new();
    // Per-frame speech mask, one bool per 480-sample frame appended to `processed_samples`
    // (see `CapturedAudio`). NEVER used to drop audio at capture — only to label it so
    // downstream compaction can cut silence. Kept exactly in step with `processed_samples`.
    let mut speech_mask = Vec::<bool>::new();
    // Warm pre-roll ring: most-recent resampled 480-frames captured while idle (not
    // recording). Seeded into a fresh recording on Cmd::Start so speech begun before the
    // hotkey press is not lost, then cleared. Bounded to `PREROLL_RING_FRAMES`.
    let mut preroll_ring: VecDeque<Vec<f32>> = VecDeque::with_capacity(PREROLL_RING_FRAMES);
    let mut recording = false;
    // Armed on Cmd::Start, disarmed by the first captured frame of that recording so
    // `capture_live_cb` fires exactly once per recording (the mic-is-live signal).
    let mut awaiting_first_capture = false;
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

    let mut pending_commands = VecDeque::new();
    loop {
        let message = match pending_commands.pop_front() {
            Some(command) => WorkerMsg::Command(command),
            None => match worker_rx.recv() {
                Ok(message) => message,
                Err(_) => break,
            },
        };

        match message {
            WorkerMsg::Audio(AudioChunk::Samples(raw)) => {
                // ---------- mic-is-live signal ----------------------------------- //
                // A raw chunk arriving while `recording` is set means the OS finished opening
                // the device and it is actually delivering audio (vs. `stream.play()` merely
                // having returned). Fire once per recording so the UI can switch from
                // "opening mic…" to a real recording state. See managers::audio.
                if recording && awaiting_first_capture {
                    awaiting_first_capture = false;
                    if let Some(cb) = &capture_live_cb {
                        cb();
                    }
                }

                // ---------- spectrum processing ---------------------------------- //
                if let Some(level) = visualizer.feed(&raw)
                    && let Some(cb) = &level_cb
                {
                    cb(level);
                }

                // ---------- existing pipeline ------------------------------------ //
                frame_resampler.push(&raw, &mut |frame: &[f32]| {
                    // Wakeword tap: fire on EVERY 16k frame regardless of `recording` so the detector
                    // listens while idle. No-op (free) unless a wakeword is armed.
                    if let Some(cb) = &chunk_cb {
                        cb(frame);
                    }

                    if !recording {
                        // Idle: keep the frame in the warm pre-roll ring (bounded) so a
                        // subsequent Cmd::Start can recover speech begun before the hotkey.
                        // The VAD is NOT consulted while idle (its state is reset at Start).
                        push_preroll_frame(&mut preroll_ring, frame);
                        return;
                    }

                    // Recording: keep EVERY frame (ungated) and label it in the mask; VAD noise
                    // is no longer dropped from the buffer.
                    let is_speech =
                        handle_frame(frame, true, &vad, &mut processed_samples, &mut speech_mask);
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
                    if new_speaking != vad_speaking {
                        vad_speaking = new_speaking;
                        if let Some(cb) = &speech_cb {
                            cb(vad_speaking);
                        }
                    }
                });

                let _ = recycle_tx.send(raw);

                // ---------- realtime live-audio mirror (tail-sync) --------------- //
                // Mirror only the NEW tail of `processed_samples` into the shared buffer so the realtime
                // worker can read a growing window of the active recording. O(new samples), NOT a full
                // clone per chunk. Gated on `recording` so the idle wakeword path never grows it, AND on
                // `realtime_enabled` so we skip the second copy entirely when the live preview is off
                // (the common dictation case). The batch path still mem::take's `processed_samples`;
                // this only reads it.
                if recording
                    && realtime_enabled.load(Ordering::Relaxed)
                    && let Some(mirror) = &live_audio
                {
                    let new_len = {
                        let mut m = mirror.lock_recover();
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
            WorkerMsg::Audio(AudioChunk::EndOfStream) => {}
            WorkerMsg::Command(cmd) => match cmd {
                Cmd::Start => {
                    stop_deadline.store(0, Ordering::Release);
                    stop_flag.store(false, Ordering::Release);
                    processed_samples.clear();
                    speech_mask.clear();
                    // Clear the realtime mirror in lock-step so the worker's first snapshot of
                    // the new recording starts empty (no stale tail from the previous take).
                    if let Some(mirror) = &live_audio {
                        mirror.lock_recover().clear();
                    }
                    publish_realtime_audio_progress(&realtime_audio_signal, 0);
                    recording = true;
                    // Arm the once-per-recording "mic is live" signal for this take.
                    awaiting_first_capture = true;
                    // Fresh utterance: the next real speech onset re-fires speech_cb(true).
                    vad_speaking = false;
                    visualizer.reset();
                    if let Some(v) = &vad {
                        lock_vad(v).reset();
                    }
                    // Warm pre-roll seeding: replay the idle ring (oldest→newest) into the
                    // fresh recording so speech begun before the hotkey press is captured.
                    // Frames are labeled through the (just-reset) VAD so the mask is honest,
                    // but speech_cb stays SUPPRESSED — pre-hotkey audio must not fire UI
                    // transitions. Afterwards `vad_speaking` is set to the smoothed state so
                    // the next real transition fires correctly.
                    let seeded_speaking = seed_preroll(
                        &mut preroll_ring,
                        &vad,
                        &mut processed_samples,
                        &mut speech_mask,
                    );
                    if vad.is_some() {
                        vad_speaking = seeded_speaking;
                        // A recording that BEGINS mid-speech (the pre-roll seeded the smoothed
                        // VAD into in-speech) produces no false→true transition on the first real
                        // frame, so the per-frame loop below would never fire `speech_cb(true)`.
                        // Surface that onset EXACTLY ONCE here so the manager records that speech
                        // was seen (else its no-speech watchdog silently discards a valid
                        // gap-free utterance) and the overlay pill reveals. seed_preroll stays
                        // silent per-frame to avoid replay flicker; only this settled state fires.
                        if seeded_onset_should_signal(true, seeded_speaking)
                            && let Some(cb) = &speech_cb
                        {
                            cb(true);
                        }
                    }
                }
                Cmd::Stop(reply_tx) => {
                    // Timestamp-bounded drain-to-EndOfStream. Devices deliver audio with a
                    // capture→callback lag (hundreds of ms on Bluetooth/USB headsets), so at
                    // the stop instant the last ~lag of the recording is still inside the OS
                    // stack. Stamp the stop deadline, raise the flag, then block (bounded by
                    // STOP_DRAIN_BUDGET) while the callback keeps forwarding chunks UNTIL the
                    // delivered audio's capture time reaches the deadline — it trims the
                    // boundary chunk exactly there and emits `EndOfStream` (plan_stop_chunk).
                    // Capture is never extended: samples captured after the deadline are cut,
                    // and the stream lifecycle (release policy) is untouched. Deadline is
                    // stored BEFORE the flag (Release/Acquire on the flag) so the callback
                    // never sees the flag without the stamp.
                    stop_deadline.store(
                        u64::try_from(epoch.elapsed().as_nanos())
                            .unwrap_or(u64::MAX)
                            .max(1),
                        Ordering::Release,
                    );
                    stop_flag.store(true, Ordering::Release);
                    let mut coalesced_stop_replies = Vec::new();
                    drain_to_end_of_stream(
                        &worker_rx,
                        STOP_DRAIN_BUDGET,
                        &mut pending_commands,
                        &mut coalesced_stop_replies,
                        |chunk| {
                            frame_resampler.push(&chunk, &mut |frame: &[f32]| {
                                let _ = handle_frame(
                                    frame,
                                    true,
                                    &vad,
                                    &mut processed_samples,
                                    &mut speech_mask,
                                );
                            });
                            let _ = recycle_tx.send(chunk);
                        },
                    );
                    recording = false;
                    // Surface a final speech-off if we ended mid-utterance so any consumer's
                    // `isSpeaking` clears even when the user released PTT while still talking.
                    if vad_speaking {
                        vad_speaking = false;
                        if let Some(cb) = &speech_cb {
                            cb(false);
                        }
                    }
                    let synthetic = frame_resampler.finish(&mut |frame: &[f32]| {
                        let _ = handle_frame(
                            frame,
                            true,
                            &vad,
                            &mut processed_samples,
                            &mut speech_mask,
                        );
                    });
                    // Resampler tail truncation: strip the synthetic zero-pad the resampler
                    // appended (last-chunk + final-frame padding) so the utterance is never
                    // lengthened with silence. The mask then covers only whole frames of the
                    // truncated length (a trailing partial frame carries no label).
                    let keep = processed_samples.len().saturating_sub(synthetic);
                    processed_samples.truncate(keep);
                    speech_mask.truncate(processed_samples.len() / vad::VAD_FRAME_SAMPLES);

                    reply_to_stop_requests(
                        reply_tx,
                        coalesced_stop_replies,
                        CapturedAudio {
                            samples: std::mem::take(&mut processed_samples),
                            speech_mask: std::mem::take(&mut speech_mask),
                        },
                    );

                    // Drop the realtime mirror now that the take is finalized — it must not
                    // retain a finished recording's audio (a realtime-worker snapshot landing
                    // in the gap before the next Cmd::Start would otherwise re-decode and emit
                    // the previous utterance). Cmd::Start also clears it; doing it here too frees
                    // the second copy immediately and closes the cross-recording snapshot window.
                    if let Some(mirror) = &live_audio {
                        mirror.lock_recover().clear();
                    }
                    publish_realtime_audio_progress(&realtime_audio_signal, 0);

                    // Re-arm idle capture: the drain above set `stop_flag` so the callback would
                    // trim to the deadline, emit EndOfStream and go silent. In AlwaysOn mode the
                    // stream stays open between recordings and must keep feeding the warm pre-roll
                    // ring, so clear both now that the take is finalized. The next Cmd::Start
                    // also clears them; doing it here restores idle capture immediately.
                    stop_deadline.store(0, Ordering::Release);
                    stop_flag.store(false, Ordering::Release);
                }
                Cmd::Shutdown => {
                    // Stamp a deadline so the callback's stop path cuts immediately (a 0
                    // deadline is only a defensive fallback there).
                    stop_deadline.store(
                        u64::try_from(epoch.elapsed().as_nanos())
                            .unwrap_or(u64::MAX)
                            .max(1),
                        Ordering::Release,
                    );
                    stop_flag.store(true, Ordering::Release);
                    publish_realtime_audio_progress(&realtime_audio_signal, 0);
                    return;
                }
            },
        }
    }
}

/// Recover a poisoned VAD lock instead of propagating the panic: a panic inside the Silero
/// ONNX inference would otherwise poison this mutex and silently kill the recorder worker
/// forever. Mirrors the transcription manager's `lock_engine` poison discipline (warn +
/// carry on with the inner guard).
fn lock_vad(
    vad_arc: &Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>,
) -> std::sync::MutexGuard<'_, Box<dyn vad::VoiceActivityDetector>> {
    vad_arc.lock().unwrap_or_else(|p| {
        log::warn!("VAD lock poisoned; recovering inner guard");
        p.into_inner()
    })
}

/// Push one mask entry for a frame that was JUST appended to the recording buffer, then, on a
/// labeled speech onset, retroactively flip the preceding `retro_frames` entries to `true`.
/// Those preceding entries are the pre-roll frames the smoother buffered before the onset
/// fired — each already appended (labeled `false`) on an earlier call, so flipping them here
/// reproduces exactly the samples the old gating path prepended. Keeps `mask.len()` equal to
/// the number of frames appended (one entry per frame).
fn push_speech_mask(mask: &mut Vec<bool>, label: &vad::SpeechLabel) {
    mask.push(label.is_speech);
    if label.retro_frames > 0 {
        let end = mask.len() - 1; // exclude the current frame (already pushed above)
        let start = end.saturating_sub(label.retro_frames);
        for m in &mut mask[start..end] {
            *m = true;
        }
    }
}

/// Append `samples` to the recording buffer (ALWAYS — capture is ungated; VAD noise is no
/// longer dropped) and push exactly ONE mask entry for it via the labeled VAD, retro-marking
/// pre-roll on onset. Returns the smoothed-VAD speech verdict so the caller can drive
/// `speech_cb`. `recording == false` is a no-op returning `false`. With no VAD configured
/// every frame is speech. Panics inside the ONNX inference are contained (the frame is then
/// treated as speech so audio is never silently lost); `SpeechLabel` is `Copy`, so nothing
/// borrowing the detector crosses the `catch_unwind` boundary.
fn handle_frame(
    samples: &[f32],
    recording: bool,
    vad: &Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
    out_buf: &mut Vec<f32>,
    mask: &mut Vec<bool>,
) -> bool {
    if !recording {
        return false;
    }

    out_buf.extend_from_slice(samples);

    let Some(vad_arc) = vad else {
        mask.push(true);
        return true;
    };

    let mut det = lock_vad(vad_arc);
    let label = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        det.push_frame_labeled(samples).unwrap_or(vad::SpeechLabel {
            is_speech: true,
            retro_frames: 0,
        })
    }))
    .unwrap_or_else(|_| {
        log::warn!("VAD push_frame_labeled panicked; treating frame as speech");
        vad::SpeechLabel {
            is_speech: true,
            retro_frames: 0,
        }
    });
    drop(det);

    push_speech_mask(mask, &label);
    label.is_speech
}

/// Keep the most-recent resampled 480-frame in the warm pre-roll ring, evicting the oldest
/// once it is full. Reuses the evicted buffer's allocation to avoid a per-idle-frame alloc.
fn push_preroll_frame(ring: &mut VecDeque<Vec<f32>>, frame: &[f32]) {
    if ring.len() == PREROLL_RING_FRAMES
        && let Some(mut recycled) = ring.pop_front()
    {
        recycled.clear();
        recycled.extend_from_slice(frame);
        ring.push_back(recycled);
        return;
    }
    ring.push_back(frame.to_vec());
}

/// Seed a fresh recording from the idle pre-roll ring: replay every buffered frame
/// oldest→newest through `handle_frame` (labeling each via the just-reset VAD so the mask is
/// honest) and drain the ring. Returns the final smoothed speech verdict so the caller can
/// keep `vad_speaking` continuous. Deliberately takes NO `speech_cb` — pre-hotkey audio must
/// not fire UI transitions.
///
/// LEADING NON-SPEECH IS TRIMMED (when a VAD is configured): after all frames are labeled
/// (retro onset flips applied), seeded frames BEFORE the first speech-labeled frame are
/// dropped from both the buffer and the mask. The batch path would cut them anyway via
/// mask compaction, but the realtime live preview decodes the raw buffer — up to ~1 s of
/// pre-hotkey room noise/breath made Whisper hallucinate phantom text into the pill at the
/// start of every take (and the stabilizer's monotonic prefix then pinned it there). Only
/// the ring's actual purpose survives: speech begun before the press. Ring frames are
/// uniform-length (the FrameResampler emits fixed 480-sample frames), so samples-per-frame
/// is derived from the seeded totals.
fn seed_preroll(
    ring: &mut VecDeque<Vec<f32>>,
    vad: &Option<Arc<Mutex<Box<dyn vad::VoiceActivityDetector>>>>,
    out_buf: &mut Vec<f32>,
    mask: &mut Vec<bool>,
) -> bool {
    let seed_start_frame = mask.len();
    let seed_start_sample = out_buf.len();
    let mut speaking = false;
    for frame in ring.drain(..) {
        speaking = handle_frame(&frame, true, vad, out_buf, mask);
    }
    if vad.is_some() {
        let seeded_frames = mask.len() - seed_start_frame;
        let lead = mask[seed_start_frame..]
            .iter()
            .take_while(|labeled_speech| !**labeled_speech)
            .count();
        if lead > 0 {
            let samples_per_frame = (out_buf.len() - seed_start_sample) / seeded_frames;
            out_buf.drain(seed_start_sample..seed_start_sample + lead * samples_per_frame);
            mask.drain(seed_start_frame..seed_start_frame + lead);
        }
    }
    speaking
}

/// Whether a freshly-started recording should surface a one-shot `speech_cb(true)` for a seeded
/// onset. Only when a VAD is configured (so `vad_speaking` actually tracks the seeded state) AND
/// the pre-roll seeded it into speech. Without a VAD, `seed_preroll` returns `true` unconditionally
/// but `vad_speaking` is left untouched, so signaling there would desync the speech state. Pure so
/// the gate is unit-testable.
const fn seeded_onset_should_signal(has_vad: bool, seeded_speaking: bool) -> bool {
    has_vad && seeded_speaking
}
