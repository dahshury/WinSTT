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
//   * a consumer thread that VAD-gates the f32 stream (Silero), accumulates speech, and on a
//     sustained-silence endpoint (`POST_SPEECH_SILENCE_DURATION` = 2.0 s, the longer threshold
//     the Python uses for continuous loopback audio) flushes the buffered utterance to the
//     shared `TranscriptionManager`, emits the `stt:full-sentence` event, runs diarization, and
//     pastes the text — exactly the path mic dictation takes, but driven by VAD endpoints instead
//     of a hotkey.
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
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;
use crate::audio_toolkit::vad::{
    SileroVad, SmoothedVad, VoiceActivityDetector, VAD_FRAME_SAMPLES, VAD_SPEECH_THRESHOLD,
};
use crate::managers::transcription::TranscriptionManager;
use crate::winstt::commands::dictation::SttEvents;
use crate::winstt::commands::listen_events::{emit_speaker_segments, EmitSpeakerSegment};
use crate::winstt::loopback::LoopbackCapture;
use crate::winstt::managers::DiarizationManager;

/// Silence (seconds) after speech that closes a loopback utterance. The Python
/// (`loopback.py` / `_start_locked`) raises `post_speech_silence_duration` to 2.0
/// for loopback because system audio is continuous — a shorter window would chop
/// a sentence mid-stream. Bit-faithful to the server.
const POST_SPEECH_SILENCE_DURATION: f64 = 2.0;

// VAD sensitivity (`VAD_SPEECH_THRESHOLD`) and the 30 ms frame size
// (`VAD_FRAME_SAMPLES`) are shared with the mic path from `audio_toolkit::vad` so
// the two pipelines can't drift apart.

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

pub struct LoopbackManager {
    app: AppHandle,
    /// True while loopback capture is running (listen mode active).
    capturing: AtomicBool,
    /// The native WASAPI capture (render endpoint, shared-mode loopback). Owned
    /// behind a mutex so start/stop are serialized.
    capture: Mutex<LoopbackCapture>,
    /// Handle to the consumer/transcription thread; joined on stop.
    consumer: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Signals the consumer thread to stop (it also exits when the capture
    /// channel closes, but this lets stop() interrupt a silent stretch promptly).
    stop_flag: Arc<AtomicBool>,
}

impl LoopbackManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            capturing: AtomicBool::new(false),
            capture: Mutex::new(LoopbackCapture::new()),
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
    pub fn start(&self) -> Result<(), String> {
        if self.is_capturing() {
            return Ok(());
        }

        // Build the VAD up front so a missing model fails the start cleanly
        // (before we open the audio backend). Wrap Silero in SmoothedVad with the
        // SAME prefill/hangover/onset tuning the mic recorder uses so listen-mode
        // endpointing matches dictation (onset debounce + hangover tail), not a raw
        // per-frame decision.
        let vad_path = self.vad_path()?;
        let silero = SileroVad::new(&vad_path, VAD_SPEECH_THRESHOLD)
            .map_err(|e| format!("failed to create Silero VAD: {e}"))?;
        let vad: Box<dyn VoiceActivityDetector> = Box::new(SmoothedVad::new(
            Box::new(silero),
            VAD_PREFILL_FRAMES,
            VAD_HANGOVER_FRAMES,
            VAD_ONSET_FRAMES,
        ));

        self.stop_flag.store(false, Ordering::Release);

        // Kick off the ASR model load in the background (same as mic dictation's
        // TranscribeAction::start). By the time the first ~2 s-silence endpoint
        // fires the model is ready; if it's still loading, `transcribe()` blocks
        // on the loading condvar rather than erroring.
        if let Some(tm) = self.app.try_state::<Arc<TranscriptionManager>>() {
            tm.initiate_model_load();
        }

        // 16 kHz mono f32 frames flow from the capture thread into the consumer.
        let (tx, rx) = mpsc::channel::<Vec<f32>>();

        // Open WASAPI loopback (resolves device + surfaces open errors here).
        {
            let mut capture = self.capture.lock().unwrap();
            capture
                .start(None, tx)
                .map_err(|e| format!("failed to start loopback capture: {e}"))?;
        }

        // Spawn the consumer/transcription loop.
        let app = self.app.clone();
        let stop_flag = self.stop_flag.clone();
        let handle = std::thread::Builder::new()
            .name("loopback-consumer".into())
            .spawn(move || {
                consumer_loop(app, rx, stop_flag, vad);
            })
            .map_err(|e| {
                // Roll back the capture if the consumer thread couldn't spawn.
                self.capture.lock().unwrap().stop();
                format!("failed to spawn loopback consumer: {e}")
            })?;

        *self.consumer.lock().unwrap() = Some(handle);
        self.capturing.store(true, Ordering::Release);
        Ok(())
    }

    /// Stop loopback capture + the consumer thread. Idempotent.
    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::Release);
        self.capturing.store(false, Ordering::Release);

        // Stop the WASAPI capture first; this closes the channel so the consumer
        // loop's recv() returns and the thread winds down.
        self.capture.lock().unwrap().stop();

        if let Some(handle) = self.consumer.lock().unwrap().take() {
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

/// The Listen-mode consumer: VAD-gate the 16 kHz mono f32 stream, accumulate
/// speech, and on a sustained-silence endpoint flush the utterance to the shared
/// transcriber, emit the sentence + diarization, and paste. Mirrors the Python
/// `_capture_loop` + `feed_audio`'s VAD endpointing, but with the longer
/// `POST_SPEECH_SILENCE_DURATION` the server uses for continuous loopback audio.
fn consumer_loop(
    app: AppHandle,
    rx: Receiver<Vec<f32>>,
    stop_flag: Arc<AtomicBool>,
    mut vad: Box<dyn VoiceActivityDetector>,
) {
    // How many consecutive silence frames close an utterance.
    let silence_frames_to_end =
        ((POST_SPEECH_SILENCE_DURATION * 1000.0) / 30.0).round() as usize;

    let mut speech: Vec<f32> = Vec::new();
    // Re-frame buffer: the capture emits 30 ms frames, but guard against a
    // partial frame arriving (resampler flush) by carrying a remainder.
    let mut frame_acc: Vec<f32> = Vec::new();
    let mut in_speech = false;
    let mut silence_frames = 0usize;

    loop {
        if stop_flag.load(Ordering::Acquire) {
            break;
        }

        // Block for the next capture chunk; a short timeout lets us re-check the
        // stop flag during silent stretches without busy-spinning.
        let chunk = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(c) => c,
            Err(RecvTimeoutError::Timeout) => continue,
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
            let is_voice = vad.is_voice(&frame).unwrap_or(false);

            if is_voice {
                if !in_speech {
                    in_speech = true;
                }
                silence_frames = 0;
                speech.extend_from_slice(&frame);
            } else if in_speech {
                // Trailing silence is kept in the buffer (it gives the model a
                // clean tail) until the endpoint fires.
                speech.extend_from_slice(&frame);
                silence_frames += 1;
                if silence_frames >= silence_frames_to_end {
                    flush_utterance(&app, &mut speech);
                    in_speech = false;
                    silence_frames = 0;
                }
            }
            // else: not in speech and no voice → drop (idle system audio).
        }
    }

    // Session ending: flush whatever speech remains so the last sentence isn't
    // lost when the user stops Listen mode mid-utterance.
    flush_utterance(&app, &mut speech);
}

/// Transcribe a completed speech buffer and route the result the same way mic
/// dictation does: emit `stt:full-sentence`, run diarization, paste. Clears
/// `speech` afterward. No-op for sub-threshold buffers (a stray chime).
fn flush_utterance(app: &AppHandle, speech: &mut Vec<f32>) {
    if speech.len() < MIN_SPEECH_SAMPLES {
        speech.clear();
        return;
    }
    let audio = std::mem::take(speech);

    let Some(tm) = app.try_state::<Arc<TranscriptionManager>>() else {
        log::warn!("[loopback] TranscriptionManager not available; dropping utterance");
        return;
    };

    SttEvents::transcription_start(app, None);
    let start = std::time::Instant::now();
    let text = match tm.transcribe(audio) {
        Ok(t) => t,
        Err(e) => {
            log::error!("[loopback] transcription failed: {e}");
            SttEvents::transcription_failed(app);
            return;
        }
    };
    let trimmed = text.trim().to_string();
    log::debug!(
        "[loopback] utterance transcribed in {:?}: '{}'",
        start.elapsed(),
        trimmed
    );

    if trimmed.is_empty() {
        SttEvents::no_audio_detected(app);
        return;
    }

    // Emit the sentence BEFORE diarization so the renderer's relay attaches
    // speaker colours to the right transcript item (listen_events.rs ordering
    // contract: fullSentence first, then speaker_segments).
    SttEvents::full_sentence(app, &trimmed);

    // Diarization (if the user enabled it). The DiarizationManager degrades to a
    // single speaker until the embedder is wired, so this is always safe.
    if let Some(diar) = app.try_state::<Arc<DiarizationManager>>() {
        if diar.is_enabled() {
            let segments = diar.assign_speakers(0.0, 0.0, &trimmed);
            let emit_segs: Vec<EmitSpeakerSegment> = segments
                .into_iter()
                .map(|s| EmitSpeakerSegment {
                    speaker: s.speaker,
                    start: s.start,
                    end: s.end,
                    text: s.text,
                })
                .collect();
            if !emit_segs.is_empty() {
                emit_speaker_segments(app, emit_segs);
            }
        }
    }

    // Paste into the focused field (same path as mic dictation). Must run on the
    // main thread (UI input synthesis).
    let app_for_paste = app.clone();
    let to_paste = trimmed;
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = crate::utils::paste(to_paste, app_for_paste.clone()) {
            log::error!("[loopback] failed to paste transcription: {e}");
            let _ = app_for_paste.emit("paste-error", ());
        }
    });
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
}
