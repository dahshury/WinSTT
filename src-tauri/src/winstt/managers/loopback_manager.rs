// LoopbackManager — Listen-mode lifecycle for system-audio transcription.
//
// Source of truth: server/src/stt_server/loopback.py (LoopbackCapture._capture_loop +
// recorder.feed_audio's VAD-gated continuous transcription) and
// server/src/stt_server/control_handler.py (_handle_start_loopback / _handle_stop_loopback).
//
// Listen mode transcribes SYSTEM audio (a call, a YouTube lecture), not the mic. The native
// WASAPI capture lives in `winstt::loopback::LoopbackCapture` (render endpoint, shared-mode
// loopback) and delivers 16 kHz mono f32 frames over an mpsc channel, already AGC'd. This
// manager owns:
//
//   * the capture lifecycle (start/stop, idempotent, serialized — concurrent WASAPI start/stop
//     crash the backend),
//   * a consumer thread that feeds continuous loopback audio to the selected native-streaming
//     `TranscriptionManager` model while using VAD only for UI activity state.
//
// Why the manager owns the consumer (not the recorder): cpal's `AudioRecorder` is mic-only and
// hotkey-driven; loopback is a second, continuous producer with its own VAD endpoint loop. Per
// the Python (`recorder.feed_audio`), the loopback audio feeds the SAME transcriber but never the
// mic stream. Mirroring that, this manager is a self-contained second pipeline that reuses the
// shared `TranscriptionManager` from Tauri state.
//
// start() is NON-BLOCKING (spawns the capture thread + consumer thread and returns) so it never
// stalls the Tauri async command loop — the antipattern the project memory flags for
// `start_loopback`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::managers::transcription::{RealtimeStreamOutcome, TranscriptionManager};

use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;
use crate::audio_toolkit::vad::{
    SileroVad, SmoothedVad, VadFrame, VoiceActivityDetector, VAD_FRAME_SAMPLES,
};
use crate::winstt::commands::dictation::SttEvents;
use crate::winstt::loopback::{DeviceInfo, LoopbackCapture};
use crate::winstt::settings_store::read_settings_raw;
use crate::winstt::sync_ext::MutexExt;

/// Silence (seconds) after speech that clears the current loopback live caption.
const POST_SPEECH_SILENCE_DURATION: f64 = 2.0;

/// Hard cap for the in-memory consumer buffer when transcription falls behind. This buffer holds
/// only samples not yet discarded from the continuous stream; keeping several minutes here prevents
/// short CPU/GPU stalls from turning into dropped captions during long media playback.
const LISTEN_MAX_BUFFER_SECONDS: f64 = 300.0;

/// Timeout used to notice render devices that stop delivering zero-filled frames during silence.
const LOOPBACK_RECV_TIMEOUT: Duration = Duration::from_millis(200);

/// Loopback needs much more permissive VAD than close-talk mic dictation: system audio is often
/// normalized, compressed, mixed with music/effects, or quieter than microphone speech. This
/// mirrors the RealtimeSTT stereo-mix example's `silero_sensitivity=0.05`.
const LOOPBACK_VAD_SPEECH_THRESHOLD: f32 = 0.05;

// The 30 ms frame size (`VAD_FRAME_SAMPLES`) stays shared with the mic path from
// `audio_toolkit::vad` so the two pipelines keep the same timing unit.

/// SmoothedVad onset/hangover/prefill frame counts — same tuning the mic recorder
/// applies (`create_audio_recorder` in managers/audio.rs wraps SileroVad in
/// `SmoothedVad::new(.., 15, 15, 2)`), so loopback gets the SAME onset debounce +
/// hangover tail instead of the bare per-frame Silero decision it used before.
const VAD_PREFILL_FRAMES: usize = 15;
const VAD_HANGOVER_FRAMES: usize = 15;
const VAD_ONSET_FRAMES: usize = 2;

/// Minimum speech (samples) before a flush is worth transcribing — drops sub-VAD
/// blips (a single click / notification chime) that would otherwise spawn an
/// empty-text transcription. ~150 ms at 16 kHz.
const MIN_SPEECH_SAMPLES: usize = (WHISPER_SAMPLE_RATE as usize) * 150 / 1000;

/// Lowest feed cadence for native streaming models without an explicit latency token.
const LISTEN_NATIVE_STREAM_DEFAULT_FEED_MS: usize = 160;
const LISTEN_NATIVE_STREAM_MIN_FEED_MS: usize = 80;
const LISTEN_NATIVE_STREAM_MAX_FEED_MS: usize = 1120;

/// Soft roll target for listen-mode UI commits. The model stream stays continuous; these thresholds
/// only decide when accumulated text is emitted as a caption row.
const LISTEN_STREAM_ROLL_SECONDS: f64 = 12.0;
const LISTEN_STREAM_ROLL_HARD_SECONDS: f64 = 20.0;
const LISTEN_STREAM_ROLL_CHARS: usize = 360;
const LISTEN_STREAM_ROLL_HARD_CHARS: usize = 720;

struct LoopbackRealtimeState {
    generation: u64,
    fed_len: usize,
    committed_fed_len: usize,
    committed_text: String,
    last_raw_text: String,
    last_emit_text: String,
    last_preview: Instant,
}

impl LoopbackRealtimeState {
    fn new() -> Self {
        Self {
            generation: 1,
            fed_len: 0,
            committed_fed_len: 0,
            committed_text: String::new(),
            last_raw_text: String::new(),
            last_emit_text: String::new(),
            last_preview: Instant::now(),
        }
    }

    fn reset_stream(&mut self, transcription: &TranscriptionManager) {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.fed_len = 0;
        self.committed_fed_len = 0;
        self.committed_text.clear();
        self.last_raw_text.clear();
        self.last_emit_text.clear();
        self.last_preview = Instant::now();
        transcription.stream_reset_realtime();
    }

    fn forget_buffered_prefix(&mut self, samples: usize) {
        self.fed_len = self.fed_len.saturating_sub(samples);
        self.committed_fed_len = self.committed_fed_len.saturating_sub(samples);
        self.last_emit_text.clear();
        self.last_preview = Instant::now();
    }

    fn uncommitted_text(&self, raw_text: &str) -> String {
        uncommitted_realtime_text(&self.committed_text, raw_text)
    }

    fn mark_committed(&mut self, raw_text: &str, total_len: usize) {
        self.committed_text = raw_text.trim().to_string();
        self.committed_fed_len = total_len;
        self.last_emit_text.clear();
    }
}

pub struct LoopbackManager {
    app: AppHandle,
    /// Shared transcription engine — injected at construction (the same
    /// `Arc<TranscriptionManager>` Tauri manages). Listen mode feeds final chunks
    /// here, mirroring how mic dictation reuses the one engine. Previously resolved
    /// per-call via `app.try_state`; injection makes the dependency explicit and
    /// drops the fallible state lookups on the hot path.
    transcription: Arc<TranscriptionManager>,
    /// True while loopback capture is running (listen mode active).
    capturing: AtomicBool,
    /// The native WASAPI capture (render endpoint, shared-mode loopback). Owned
    /// behind a mutex so start/stop are serialized.
    capture: Mutex<LoopbackCapture>,
    /// Resolved device for the current loopback session.
    active_device: Mutex<Option<DeviceInfo>>,
    /// Handle to the consumer/transcription thread; joined on stop.
    consumer: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Signals the consumer thread to stop (it also exits when the capture
    /// channel closes, but this lets stop() interrupt a silent stretch promptly).
    stop_flag: Arc<AtomicBool>,
}

impl LoopbackManager {
    pub fn new(app: &AppHandle, transcription: Arc<TranscriptionManager>) -> Self {
        Self {
            app: app.clone(),
            transcription,
            capturing: AtomicBool::new(false),
            capture: Mutex::new(LoopbackCapture::new()),
            active_device: Mutex::new(None),
            consumer: Mutex::new(None),
            stop_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_capturing(&self) -> bool {
        self.capturing.load(Ordering::Acquire)
    }

    /// Resolve the bundled Silero VAD model path (same resource the mic recorder
    /// loads in `AudioRecordingManager::preload_vad`).
    fn vad_path(&self) -> Result<String, String> {
        self.app
            .path()
            .resolve(
                "resources/models/silero_vad_v4.onnx",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("failed to resolve VAD path: {e}"))?
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "VAD path is not valid UTF-8".to_string())
    }

    /// Begin loopback capture: open the WASAPI render endpoint, then spawn the
    /// consumer thread that VAD-gates + transcribes the system-audio stream.
    /// Idempotent (a second call while active is a no-op). Non-blocking.
    pub fn start(&self, device_id: Option<String>, model_id: String) -> Result<DeviceInfo, String> {
        if self.is_capturing() {
            if let Some(info) = self.active_device.lock_recover().clone() {
                return Ok(info);
            }
            return Err("loopback capture is already active".to_string());
        }

        // Build the VAD up front so a missing model fails the start cleanly
        // (before we open the audio backend). Wrap Silero in SmoothedVad with the
        // SAME prefill/hangover/onset tuning the mic recorder uses so listen-mode
        // endpointing matches dictation (onset debounce + hangover tail), not a raw
        // per-frame decision.
        let vad_path = self.vad_path()?;
        let silero = SileroVad::new(&vad_path, LOOPBACK_VAD_SPEECH_THRESHOLD)
            .map_err(|e| format!("failed to create Silero VAD: {e}"))?;
        let vad: Box<dyn VoiceActivityDetector> = Box::new(SmoothedVad::new(
            Box::new(silero),
            VAD_PREFILL_FRAMES,
            VAD_HANGOVER_FRAMES,
            VAD_ONSET_FRAMES,
        ));

        self.stop_flag.store(false, Ordering::Release);

        // Listen mode must run on an explicit native-streaming model. Load it
        // before opening capture so a missing/corrupt cache fails cleanly.
        self.transcription.load_model_blocking(&model_id)?;

        // 16 kHz mono f32 frames flow from the capture thread into the consumer.
        let (tx, rx) = mpsc::channel::<Vec<f32>>();

        // Open WASAPI loopback (resolves device + surfaces open errors here).
        let started_device = {
            let mut capture = self.capture.lock_recover();
            capture
                .start(device_id, tx)
                .map_err(|e| format!("failed to start loopback capture: {e}"))?
        };
        *self.active_device.lock_recover() = Some(started_device.clone());

        // Spawn the consumer/transcription loop.
        let app = self.app.clone();
        let transcription = self.transcription.clone();
        let stop_flag = self.stop_flag.clone();
        let handle = std::thread::Builder::new()
            .name("loopback-consumer".into())
            .spawn(move || {
                consumer_loop(app, transcription, rx, stop_flag, vad);
            })
            .map_err(|e| {
                // Roll back the capture if the consumer thread couldn't spawn.
                self.capture.lock_recover().stop();
                *self.active_device.lock_recover() = None;
                format!("failed to spawn loopback consumer: {e}")
            })?;

        *self.consumer.lock_recover() = Some(handle);
        self.capturing.store(true, Ordering::Release);
        Ok(started_device)
    }

    /// Stop loopback capture + the consumer thread. Idempotent.
    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::Release);
        self.capturing.store(false, Ordering::Release);

        // Stop the WASAPI capture first; this closes the channel so the consumer
        // loop's recv() returns and the thread winds down.
        self.capture.lock_recover().stop();
        *self.active_device.lock_recover() = None;

        if let Some(handle) = self.consumer.lock_recover().take() {
            let _ = handle.join();
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }
}

impl Drop for LoopbackManager {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The Listen-mode consumer: feed the 16 kHz mono f32 stream continuously into the native
/// streaming model, keep capture responsive, and use VAD only to drive the visual active/idle
/// state. Listen mode never runs the mic dictation finalizer: no paste, no final post-processing
/// pass.
fn consumer_loop(
    app: AppHandle,
    transcription: Arc<TranscriptionManager>,
    rx: Receiver<Vec<f32>>,
    stop_flag: Arc<AtomicBool>,
    mut vad: Box<dyn VoiceActivityDetector>,
) {
    // How many consecutive silence frames close an utterance.
    let silence_frames_to_end = ((POST_SPEECH_SILENCE_DURATION * 1000.0) / 30.0).round() as usize;
    let max_buffer_samples = samples_for_seconds(LISTEN_MAX_BUFFER_SECONDS);

    let mut speech: Vec<f32> = Vec::new();
    // Re-frame buffer: the capture emits 30 ms frames, but guard against a
    // partial frame arriving (resampler flush) by carrying a remainder.
    let mut frame_acc: Vec<f32> = Vec::new();
    let mut in_speech = false;
    let mut silence_frames = 0usize;
    let mut realtime = LoopbackRealtimeState::new();
    transcription.stream_reset_realtime();

    loop {
        if stop_flag.load(Ordering::Acquire) {
            break;
        }

        // Block for the next capture chunk; a short timeout lets us re-check the
        // stop flag during silent stretches without busy-spinning.
        let chunk = match rx.recv_timeout(LOOPBACK_RECV_TIMEOUT) {
            Ok(c) => c,
            Err(RecvTimeoutError::Timeout) => {
                SttEvents::audio_level(&app, 0.0);
                if in_speech {
                    silence_frames = silence_frames
                        .saturating_add(silence_frames_for_duration(LOOPBACK_RECV_TIMEOUT));
                    if silence_frames >= silence_frames_to_end {
                        finish_realtime_segment(
                            &app,
                            &transcription,
                            &mut speech,
                            &mut realtime,
                            &mut in_speech,
                            &mut silence_frames,
                        );
                    }
                } else if speech.len() >= MIN_SPEECH_SAMPLES
                    && !realtime.last_raw_text.trim().is_empty()
                {
                    finish_realtime_segment(
                        &app,
                        &transcription,
                        &mut speech,
                        &mut realtime,
                        &mut in_speech,
                        &mut silence_frames,
                    );
                } else if !realtime.last_emit_text.is_empty() {
                    commit_last_realtime_text(&app, &mut realtime, speech.len());
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };

        // Scalar level for the reused renderer's audio visualizer (onAudioLevel).
        let level = chunk
            .iter()
            .copied()
            .fold(0.0f32, |m, s| m.max(s.abs()))
            .clamp(0.0, 1.0);
        SttEvents::audio_level(&app, level);

        frame_acc.extend_from_slice(&chunk);

        // Process whole 30 ms frames.
        while frame_acc.len() >= VAD_FRAME_SAMPLES {
            let frame: Vec<f32> = frame_acc.drain(0..VAD_FRAME_SAMPLES).collect();
            speech.extend_from_slice(&frame);
            let vad_frame = vad.push_frame(&frame).unwrap_or(VadFrame::Noise);

            if let VadFrame::Speech(_) = vad_frame {
                if !in_speech {
                    in_speech = true;
                    SttEvents::vad_start(&app);
                }
                silence_frames = 0;
            } else if in_speech {
                silence_frames += 1;
                if silence_frames >= silence_frames_to_end {
                    finish_realtime_segment(
                        &app,
                        &transcription,
                        &mut speech,
                        &mut realtime,
                        &mut in_speech,
                        &mut silence_frames,
                    );
                }
            }
            let dropped = enforce_buffer_cap(&mut speech, max_buffer_samples);
            if dropped > 0 {
                realtime.forget_buffered_prefix(dropped);
            }
            // VAD no longer gates model input; it only controls active/idle UI state.
        }

        publish_native_realtime_preview_if_due(&app, &transcription, &mut speech, &mut realtime);
    }

    if in_speech || speech.len() >= MIN_SPEECH_SAMPLES {
        finish_realtime_segment(
            &app,
            &transcription,
            &mut speech,
            &mut realtime,
            &mut in_speech,
            &mut silence_frames,
        );
    } else {
        clear_realtime_preview(&app);
    }
}

fn samples_for_seconds(seconds: f64) -> usize {
    ((seconds * WHISPER_SAMPLE_RATE as f64).round() as usize).max(1)
}

fn samples_for_millis(ms: usize) -> usize {
    ((ms * WHISPER_SAMPLE_RATE as usize) / 1000).max(1)
}

fn silence_frames_for_duration(duration: Duration) -> usize {
    ((duration.as_secs_f64() * 1000.0) / 30.0).ceil() as usize
}

fn streaming_latency_ms_from_id(model_id: &str) -> Option<usize> {
    model_id
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter_map(|token| token.strip_suffix("ms"))
        .filter_map(|value| value.parse::<usize>().ok())
        .next()
}

fn listen_native_stream_feed_samples(model_id: Option<&str>) -> usize {
    let latency_ms = model_id
        .map(crate::winstt::catalog::canonical_model_id)
        .and_then(streaming_latency_ms_from_id)
        .unwrap_or(LISTEN_NATIVE_STREAM_DEFAULT_FEED_MS)
        .clamp(
            LISTEN_NATIVE_STREAM_MIN_FEED_MS,
            LISTEN_NATIVE_STREAM_MAX_FEED_MS,
        );
    samples_for_millis(latency_ms)
}

fn native_realtime_ready_to_publish(
    speech_len: usize,
    fed_len: usize,
    last_preview_elapsed: Duration,
    interval: Duration,
    feed_samples: usize,
    force: bool,
) -> bool {
    if speech_len < MIN_SPEECH_SAMPLES || speech_len <= fed_len {
        return false;
    }
    if force {
        return true;
    }
    speech_len - fed_len >= feed_samples && last_preview_elapsed >= interval
}

fn finish_realtime_segment(
    app: &AppHandle,
    transcription: &TranscriptionManager,
    speech: &mut Vec<f32>,
    realtime: &mut LoopbackRealtimeState,
    in_speech: &mut bool,
    silence_frames: &mut usize,
) {
    let committed = finalize_realtime_segment(app, transcription, speech, realtime);
    if !committed {
        clear_realtime_preview(app);
    }
    realtime.reset_stream(transcription);
    if *in_speech {
        SttEvents::vad_stop(app);
    }
    *in_speech = false;
    *silence_frames = 0;
}

fn enforce_buffer_cap(speech: &mut Vec<f32>, max_samples: usize) -> usize {
    if speech.len() <= max_samples {
        return 0;
    }
    let drop = speech.len() - max_samples;
    speech.drain(..drop);
    log::warn!(
        "[loopback] transcription is falling behind; dropped {:.1}s of buffered audio",
        drop as f64 / WHISPER_SAMPLE_RATE as f64
    );
    drop
}

fn clear_realtime_preview(app: &AppHandle) {
    SttEvents::realtime_stabilized(app, "");
    SttEvents::realtime_text(app, "");
}

fn collapse_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn uncommitted_realtime_text(committed: &str, raw_text: &str) -> String {
    let raw = raw_text.trim();
    let committed = committed.trim();
    if raw.is_empty() || raw == committed {
        return String::new();
    }
    if committed.is_empty() {
        return raw.to_string();
    }
    if let Some(rest) = raw.strip_prefix(committed) {
        return rest.trim_start().to_string();
    }

    let raw_normalized = collapse_whitespace(raw);
    let committed_normalized = collapse_whitespace(committed);
    if raw_normalized == committed_normalized {
        return String::new();
    }
    if let Some(rest) = raw_normalized.strip_prefix(&committed_normalized) {
        return rest.trim_start().to_string();
    }

    let raw_words: Vec<&str> = raw_normalized.split_whitespace().collect();
    let committed_words: Vec<&str> = committed_normalized.split_whitespace().collect();
    let max_overlap = raw_words.len().min(committed_words.len());
    for overlap in (1..=max_overlap).rev() {
        if committed_words[committed_words.len() - overlap..] == raw_words[..overlap] {
            return raw_words[overlap..].join(" ");
        }
    }

    raw_normalized
}

fn listen_realtime_interval(app: &AppHandle) -> Duration {
    let settings = read_settings_raw(app);
    Duration::from_secs_f64(listen_realtime_interval_seconds(
        settings.quality.realtime_processing_pause,
    ))
}

fn listen_realtime_interval_seconds(configured: f64) -> f64 {
    configured.max(0.01)
}

fn ends_on_realtime_boundary(text: &str) -> bool {
    text.trim_end()
        .chars()
        .last()
        .is_some_and(|c| matches!(c, '.' | '!' | '?' | ',' | ';' | ':' | ')' | ']' | '}'))
}

fn should_roll_realtime_segment(text: &str, samples: usize) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    let chars = trimmed.chars().count();
    if chars >= LISTEN_STREAM_ROLL_HARD_CHARS
        || samples >= samples_for_seconds(LISTEN_STREAM_ROLL_HARD_SECONDS)
    {
        return true;
    }

    (chars >= LISTEN_STREAM_ROLL_CHARS
        || samples >= samples_for_seconds(LISTEN_STREAM_ROLL_SECONDS))
        && ends_on_realtime_boundary(trimmed)
}

fn commit_realtime_segment(
    app: &AppHandle,
    realtime: &mut LoopbackRealtimeState,
    text: &str,
    total_len: usize,
) {
    let delta = realtime.uncommitted_text(text);
    let trimmed = delta.trim();
    if !trimmed.is_empty() {
        SttEvents::listen_sentence(app, trimmed);
    }
    realtime.mark_committed(text, total_len);
    clear_realtime_preview(app);
}

fn commit_last_realtime_text(
    app: &AppHandle,
    realtime: &mut LoopbackRealtimeState,
    total_len: usize,
) {
    if realtime.last_raw_text.trim().is_empty() && realtime.last_emit_text.trim().is_empty() {
        return;
    }
    let raw = if realtime.last_raw_text.trim().is_empty() {
        realtime.last_emit_text.clone()
    } else {
        realtime.last_raw_text.clone()
    };
    commit_realtime_segment(app, realtime, &raw, total_len);
}

fn finalize_realtime_segment(
    app: &AppHandle,
    transcription: &TranscriptionManager,
    speech: &mut Vec<f32>,
    realtime: &mut LoopbackRealtimeState,
) -> bool {
    if speech.len() < MIN_SPEECH_SAMPLES {
        speech.clear();
        return false;
    }

    let total_len = speech.len();
    let tail_start = realtime.fed_len.min(total_len);
    let tail = &speech[tail_start..];
    let final_text = transcription
        .stream_finalize_realtime_blocking(tail)
        .or_else(|| {
            let last = realtime.last_raw_text.trim();
            (!last.is_empty()).then(|| last.to_string())
        });
    speech.clear();

    let Some(text) = final_text else {
        return false;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    let delta = realtime.uncommitted_text(trimmed);
    let committed = !delta.trim().is_empty();
    if committed {
        SttEvents::realtime_stabilized_with_final(app, delta.trim(), true);
        SttEvents::realtime_text_with_final(app, delta.trim(), true);
        SttEvents::listen_sentence(app, delta.trim());
    }
    realtime.mark_committed(trimmed, 0);
    committed
}

fn publish_native_realtime_preview_if_due(
    app: &AppHandle,
    transcription: &TranscriptionManager,
    speech: &mut Vec<f32>,
    realtime: &mut LoopbackRealtimeState,
) {
    let feed_samples =
        listen_native_stream_feed_samples(transcription.get_current_model().as_deref());
    if !native_realtime_ready_to_publish(
        speech.len(),
        realtime.fed_len,
        realtime.last_preview.elapsed(),
        listen_realtime_interval(app),
        feed_samples,
        false,
    ) {
        return;
    }
    let total_len = speech.len();
    let new_tail = &speech[realtime.fed_len..];
    realtime.last_preview = Instant::now();

    match transcription.stream_accept_realtime_blocking(realtime.generation, total_len, new_tail) {
        RealtimeStreamOutcome::Text(update) => {
            realtime.fed_len = total_len;
            let text = update.text.trim().to_string();
            realtime.last_raw_text = text.clone();
            let visible_text = realtime.uncommitted_text(&text);
            if update.is_final || visible_text != realtime.last_emit_text {
                realtime.last_emit_text = visible_text.clone();
                SttEvents::realtime_stabilized_with_final(app, &visible_text, update.is_final);
                SttEvents::realtime_text_with_final(app, &visible_text, update.is_final);
            }
            let samples_since_commit = total_len.saturating_sub(realtime.committed_fed_len);
            let should_roll = should_roll_realtime_segment(&visible_text, samples_since_commit);
            let reset_after_roll = should_roll && ends_on_realtime_boundary(&visible_text);
            if update.is_final || should_roll {
                commit_realtime_segment(app, realtime, &text, total_len);
                if reset_after_roll {
                    speech.clear();
                    realtime.reset_stream(transcription);
                }
            }
        }
        RealtimeStreamOutcome::Skipped => {}
        RealtimeStreamOutcome::NotStreaming => {
            log::warn!("[loopback] selected realtime model does not expose native streaming");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_frames_threshold_matches_two_seconds() {
        // 2.0 s / 30 ms = ~67 frames.
        let frames = ((POST_SPEECH_SILENCE_DURATION * 1000.0) / 30.0).round() as usize;
        assert_eq!(frames, 67);
    }

    #[test]
    fn vad_frame_is_thirty_ms_at_16k() {
        assert_eq!(VAD_FRAME_SAMPLES, 480);
    }

    #[test]
    fn min_speech_is_150ms() {
        assert_eq!(MIN_SPEECH_SAMPLES, 2400);
    }

    #[test]
    fn listen_timeout_counts_as_silence_frames() {
        assert_eq!(silence_frames_for_duration(LOOPBACK_RECV_TIMEOUT), 7);
    }

    #[test]
    fn listen_buffer_cap_keeps_five_minutes() {
        assert_eq!(samples_for_seconds(LISTEN_MAX_BUFFER_SECONDS), 4_800_000);
    }

    #[test]
    fn uncommitted_realtime_text_returns_suffix_for_cumulative_stream() {
        assert_eq!(
            uncommitted_realtime_text("hello there", "hello there general kenobi"),
            "general kenobi"
        );
    }

    #[test]
    fn uncommitted_realtime_text_handles_whitespace_and_word_overlap() {
        assert_eq!(
            uncommitted_realtime_text("the quick brown fox", "brown fox jumps over the lazy dog"),
            "jumps over the lazy dog"
        );
        assert_eq!(
            uncommitted_realtime_text("the quick brown fox", "the   quick brown fox"),
            ""
        );
    }

    #[test]
    fn listen_stream_soft_roll_waits_for_text_boundary() {
        assert!(!should_roll_realtime_segment(
            "this segment is still mid phrase",
            samples_for_seconds(LISTEN_STREAM_ROLL_SECONDS)
        ));
        assert!(should_roll_realtime_segment(
            "this segment reached a sentence boundary.",
            samples_for_seconds(LISTEN_STREAM_ROLL_SECONDS)
        ));
    }

    #[test]
    fn listen_stream_hard_roll_does_not_wait_forever() {
        assert!(should_roll_realtime_segment(
            "still no punctuation but this has gone on long enough",
            samples_for_seconds(LISTEN_STREAM_ROLL_HARD_SECONDS)
        ));
    }

    #[test]
    fn loopback_vad_uses_stereo_mix_sensitivity() {
        assert_eq!(LOOPBACK_VAD_SPEECH_THRESHOLD, 0.05);
    }

    #[test]
    fn listen_realtime_interval_honors_configured_pause() {
        assert_eq!(listen_realtime_interval_seconds(0.02), 0.02);
        assert_eq!(listen_realtime_interval_seconds(0.5), 0.5);
        assert_eq!(listen_realtime_interval_seconds(0.0), 0.01);
    }

    #[test]
    fn streaming_latency_parses_from_catalog_and_repo_ids() {
        assert_eq!(
            streaming_latency_ms_from_id("streaming-nemotron-en-560ms-int8"),
            Some(560)
        );
        assert_eq!(
            streaming_latency_ms_from_id(
                "csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-1120ms-int8-2026-04-25"
            ),
            Some(1120)
        );
        assert_eq!(streaming_latency_ms_from_id("zipformer-en"), None);
    }

    #[test]
    fn listen_feed_samples_follow_canonical_model_latency() {
        // Each concrete latency row feeds at ITS OWN chunk latency (clamped to
        // the [MIN, MAX] feed window). Latency is the speed-vs-accuracy control
        // and must NOT collapse to a single canonical window — see the design
        // note on `catalog::canonical_model_id`. An already-int8 id is canonical
        // (idempotent), so the parsed `<n>ms` token is the feed window.
        assert_eq!(
            listen_native_stream_feed_samples(Some("streaming-nemotron-en-80ms-int8")),
            samples_for_millis(80)
        );
        assert_eq!(
            listen_native_stream_feed_samples(Some("streaming-parakeet-unified-en-560ms-int8")),
            samples_for_millis(560)
        );
        assert_eq!(
            listen_native_stream_feed_samples(Some("zipformer-en")),
            samples_for_millis(LISTEN_NATIVE_STREAM_DEFAULT_FEED_MS)
        );
    }

    #[test]
    fn native_realtime_waits_for_model_sized_feed() {
        let interval = Duration::from_millis(10);
        let elapsed = Duration::from_millis(50);
        let feed = samples_for_millis(1120);
        assert!(!native_realtime_ready_to_publish(
            MIN_SPEECH_SAMPLES + samples_for_millis(30),
            MIN_SPEECH_SAMPLES,
            elapsed,
            interval,
            feed,
            false
        ));
        assert!(native_realtime_ready_to_publish(
            MIN_SPEECH_SAMPLES + feed,
            MIN_SPEECH_SAMPLES,
            elapsed,
            interval,
            feed,
            false
        ));
        assert!(native_realtime_ready_to_publish(
            MIN_SPEECH_SAMPLES + samples_for_millis(30),
            MIN_SPEECH_SAMPLES,
            elapsed,
            interval,
            feed,
            true
        ));
    }
}
