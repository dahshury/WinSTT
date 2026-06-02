// PORT IMPL. Source: examples/winstt-electron/server/src/recorder/application/
// recorder_service.py `_realtime_worker` (L2621-2638) + its helpers
// `_realtime_step` / `_realtime_idle_reset` / `_realtime_mark_recording_start` /
// `_realtime_ready` / `_realtime_run_if_fresh` / `_realtime_process_once` /
// `_realtime_commit_if_needed` / `_realtime_publish_fresh` / `_publish_realtime_update`.
//
// The realtime daemon worker: one background thread that periodically decodes a growing
// window of the in-flight recording for the live-preview overlay, driving the
// already-ported `RealtimeAccumulator` (committed-watermark + RealtimeSTT stabilizer).
//
// FRAMING CONTRACT (differs from the Python audio_buffer, intentionally):
//   The Python worker counts FRAMES = audio CHUNKS, with
//   `frames_per_second = sample_rate / buffer_size`. This Rust port counts
//   FRAMES = SAMPLES at 16 kHz, so `fps = 16000.0` and `total_frames = snapshot.len()`.
//   That keeps the unit system internally consistent: `commit_chunk_frames(16000.0)
//   = REALTIME_COMMIT_AFTER_SECONDS * 16000 = 32000 samples = 2.0 s`, and every
//   frame-range the accumulator hands the closure maps DIRECTLY onto a snapshot slice
//   (frame index == sample index). `RealtimeAccumulator::commit_if_needed` /
//   `publish_fresh` are agnostic to the unit — they only require fps and frame counts to
//   agree, which they do here.
//
// SINGLE ENGINE: there is deliberately NO separate realtime engine in this port. The
// worker reuses the MAIN TranscriptionManager engine via `transcribe_realtime` (a
// non-blocking try_lock peek that bails the instant a batch decode wants the engine).
// Do not wire a second engine.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::managers::audio::AudioRecordingManager;
use crate::managers::transcription::TranscriptionManager;
use crate::winstt::commands::dictation::SttEvents;
use crate::winstt::commands::settings::{effective_realtime, read_settings_raw};
use crate::winstt::realtime_stabilizer::RealtimeAccumulator;

/// 16 kHz mono — the rate every WinSTT engine + the recorder's FrameResampler target. The
/// realtime snapshot is in this domain, so frames == samples and fps == 16000.
const REALTIME_FPS: f32 = 16_000.0;

/// The realtime live-preview daemon. Holds Arc handles to the managers + app; `start()`
/// spawns ONE background thread that runs the decode loop for the app's lifetime.
pub struct RealtimeManager {
    app: AppHandle,
    transcription: Arc<TranscriptionManager>,
    audio: Arc<AudioRecordingManager>,
    started: AtomicBool,
}

impl RealtimeManager {
    pub fn new(
        app: AppHandle,
        transcription: Arc<TranscriptionManager>,
        audio: Arc<AudioRecordingManager>,
    ) -> Self {
        Self {
            app,
            transcription,
            audio,
            started: AtomicBool::new(false),
        }
    }

    /// Launch the daemon thread ONCE (idempotent — repeated calls are no-ops). Called from
    /// lib.rs `initialize_core_logic` after the managers exist, like the idle-unload watcher.
    pub fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return; // already running
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || me.run_loop());
    }

    /// The realtime worker loop (port of `_realtime_worker` → `_realtime_step`). One owned
    /// `RealtimeAccumulator` per worker lifetime; reset on each recording's rising edge.
    fn run_loop(&self) {
        log::info!("[realtime] worker started");
        let mut acc = RealtimeAccumulator::new();

        // Per-loop state (mirrors _RealtimeLoopState).
        let mut recording_seen_at: Option<Instant> = None; // set on rising edge
        let mut last_transcription = Instant::now(); // gates realtime_processing_pause
        // -1 sentinel → "no tick processed yet this recording" (Python last_processed_frame_count).
        let mut last_processed_len: i64 = -1;

        loop {
            // ── not recording: reset accumulator (keep last text), idle-sleep ──
            // Mirrors _realtime_idle_reset: reset(clear_last=False), clear per-loop markers.
            if !self.audio.is_recording() {
                acc.reset(false);
                recording_seen_at = None;
                last_processed_len = -1;
                // Stop the recorder's live-audio mirror from growing while idle (no second copy
                // when nothing is being previewed).
                self.audio.set_realtime_enabled(false);
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }

            // Gate the WHOLE decode path on effective-realtime (live preview actually shown).
            // When disabled, idle exactly like the not-recording branch but WITHOUT resetting
            // (a recording is in progress and may re-enable mid-session). Mirrors the Python
            // worker only running when realtime is configured. Use the secret-agnostic
            // `read_settings_raw` here (NOT `read_settings`): this is the hot recording loop and
            // none of the fields it reads are secrets, so we must not trigger per-tick secret
            // decryption (reg.exe spawns) on the live path.
            let settings = read_settings_raw(&self.app);
            if !effective_realtime(&settings) {
                // Realtime is off this tick → keep the recorder mirror disabled (free) and idle.
                self.audio.set_realtime_enabled(false);
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }

            // Realtime IS shown for this recording → ensure the recorder is mirroring audio into
            // `live_audio` so our snapshots see the growing window. Cheap, idempotent.
            self.audio.set_realtime_enabled(true);

            // ── rising edge: first tick after recording started ──
            // Mirrors _realtime_mark_recording_start: stamp start time + reset(clear_last=True)
            // so the stabilizer + committed text start clean for the new utterance.
            if recording_seen_at.is_none() {
                recording_seen_at = Some(Instant::now());
                acc.reset(true);
            }
            let seen_at = recording_seen_at.expect("set on the line above");

            // ── readiness gate (port of _realtime_ready) ──
            let init_after =
                Duration::from_secs_f64(settings.quality.init_realtime_after_seconds.max(0.0));
            if seen_at.elapsed() < init_after {
                std::thread::sleep(Duration::from_millis(1));
                continue;
            }
            let processing_pause =
                Duration::from_secs_f64(settings.quality.realtime_processing_pause.max(0.0));
            if last_transcription.elapsed() < processing_pause {
                std::thread::sleep(Duration::from_millis(1));
                continue;
            }

            // ── stale-audio guard (port of _realtime_run_if_fresh) ──
            // Snapshot ONLY the tail past the committed-frame watermark — the worker never reads
            // audio before it (the commit slice starts AT the watermark and the fresh window runs
            // from it to the end). `snapshot_audio_from(base)` returns (absolute_total_len, tail)
            // where `tail == mirror[base..]`, so the per-tick clone is O(new samples), not O(N) —
            // this is the fix for the O(N²)-per-utterance full-buffer clone. Absolute frame
            // indices `f` map onto `tail` as `f - base`. We take ONE snapshot here and feed the
            // SAME `tail` to both commit + fresh decode.
            //
            // If the buffer hasn't grown since the last processed tick, the recording has
            // effectively stopped feeding frames — re-decoding identical audio is pure waste.
            // Back off and retry.
            let base = acc.committed_frames() as usize;
            let (total_len, tail) = self.audio.snapshot_audio_from(base);
            let total_frames = total_len as u64;
            if total_len as i64 == last_processed_len {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            last_processed_len = total_len as i64;
            last_transcription = Instant::now();

            // Nothing past the watermark yet → skip (port of _realtime_process_once guard).
            if total_frames <= acc.committed_frames() {
                continue;
            }

            // ── commit the older portion once the fresh window exceeds the threshold ──
            // commit_if_needed calls the closure with absolute (start_frame, end_frame); we re-base
            // them onto `tail` (subtract `base`) and clamp to its bounds defensively (the watermark
            // can briefly exceed a torn/shrunk snapshot during the next-recording transition).
            // The configured language is threaded through so each realtime tick reuses it instead
            // of re-running Whisper's language-detect (we already have `settings` in hand).
            let lang_owned = {
                let l = settings.model.language.trim();
                if l.is_empty() || l == "auto" { None } else { Some(l.to_string()) }
            };
            let lang = lang_owned.as_deref();
            let tm = &self.transcription;
            let snap = &tail;
            acc.commit_if_needed(total_frames, REALTIME_FPS, |start_frame, end_frame| {
                // Re-base absolute frame indices onto the tail (start_frame >= base always, since
                // the commit slice begins at the current watermark which is >= base).
                let start = (start_frame as usize).saturating_sub(base).min(snap.len());
                let end = (end_frame as usize).saturating_sub(base).min(snap.len());
                if start >= end {
                    return Some(String::new()); // empty slice → no text, watermark still advances
                }
                Some(tm.transcribe_realtime(&snap[start..end], lang).unwrap_or_default())
            });

            // ── decode the FRESH window past the (possibly advanced) watermark ──
            // Frames committed_frames..total_frames → tail indices (re-based by `base`), clamped.
            let committed = acc.committed_frames();
            let fresh_start = (committed as usize).saturating_sub(base).min(tail.len());
            let fresh_text = if fresh_start >= tail.len() {
                String::new()
            } else {
                tm.transcribe_realtime(&tail[fresh_start..], lang)
                    .unwrap_or_default()
            };

            let publish = acc.publish_fresh(&fresh_text);

            // ── late bail (port of _publish_realtime_update's is_recording re-check) ──
            // The user may have released PTT during the (potentially long) decode; the recorder
            // has already flipped out of Recording and main is about to run its own final pass.
            // Skip the emit so the preview doesn't flash a stale realtime tick over the final
            // text.
            if !self.audio.is_recording() {
                continue;
            }

            // ── emit STABILIZED first, then UPDATE (RealtimeSTT ordering) ──
            // Both carry `publish.stabilized` (matches the Python publish payload: the
            // stabilized monotonic text is what the renderer's live preview consumes; the raw
            // assembled text is carried separately for noise-break/logging consumers, but this
            // port surfaces the stabilized text on both events per the spec).
            SttEvents::realtime_stabilized(&self.app, &publish.stabilized);
            SttEvents::realtime_text(&self.app, &publish.stabilized);
        }
    }
}
