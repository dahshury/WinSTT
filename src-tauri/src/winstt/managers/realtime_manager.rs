// Realtime worker.
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
//   = REALTIME_COMMIT_AFTER_SECONDS * 16000 = 320000 samples = 20.0 s`, and every
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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::managers::audio::AudioRecordingManager;
use crate::managers::transcription::{RealtimeStreamOutcome, TranscriptionManager};
use crate::winstt::commands::dictation::SttEvents;
use crate::winstt::commands::settings::effective_realtime_with_focus;
use crate::winstt::realtime_stabilizer::RealtimeAccumulator;
use crate::winstt::settings_store::read_settings_raw;
use crate::winstt::stt::backend::fixed_realtime_language_from_model;

/// 16 kHz mono — the rate every WinSTT engine + the recorder's FrameResampler target. The
/// realtime snapshot is in this domain, so frames == samples and fps == 16000.
const REALTIME_FPS: f32 = 16_000.0;
const NATIVE_STREAM_BACKLOG_WARN_AFTER: Duration = Duration::from_millis(750);
const NATIVE_STREAM_WAKE_TIMEOUT: Duration = Duration::from_millis(250);
const ENGINE_READY_PROBE_INTERVAL: Duration = Duration::from_millis(10);

fn realtime_redecode_pause(configured: f64) -> Duration {
    Duration::from_secs_f64(configured.max(0.0))
}

/// True when one of OUR webview windows currently holds OS focus. The in-app live-
/// transcription panel only renders inside a focused WinSTT window, so this drives the
/// focus-aware realtime gate (see `effective_realtime_with_focus`). Cheap (a foreground-
/// window compare per window) and only evaluated while a recording is in progress.
fn any_window_focused(app: &AppHandle) -> bool {
    use tauri::Manager;
    app.webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false))
}

#[derive(Debug, Default)]
struct WordByWordPasteState {
    generation: Option<u64>,
    active: bool,
    committed_text: String,
    previous_interim_text: String,
}

#[derive(Debug, PartialEq, Eq)]
struct WordByWordPasteEdit {
    backspace_chars: usize,
    text: String,
}

impl WordByWordPasteEdit {
    fn is_empty(&self) -> bool {
        self.backspace_chars == 0 && self.text.is_empty()
    }
}

impl WordByWordPasteState {
    fn reset_for_generation(&mut self, generation: u64) {
        self.generation = Some(generation);
        self.active = false;
        self.committed_text.clear();
        self.previous_interim_text.clear();
    }

    fn next_final_edit(&mut self, generation: u64, text: &str) -> Option<WordByWordPasteEdit> {
        if self.generation != Some(generation) {
            self.reset_for_generation(generation);
        }
        self.previous_interim_text.clear();
        let final_text = normalize_realtime_paste_text(text);
        let edit = append_only_edit_from_committed_to_latest(&self.committed_text, final_text)?;
        if edit.is_empty() {
            return None;
        }
        self.committed_text = final_text.to_string();
        self.active = true;
        Some(edit)
    }

    fn next_interim_edit(&mut self, generation: u64, text: &str) -> Option<WordByWordPasteEdit> {
        if self.generation != Some(generation) {
            self.reset_for_generation(generation);
        }

        let latest = normalize_realtime_paste_text(text);
        let stable_prefix =
            stable_word_boundary_prefix(&self.previous_interim_text, latest).to_string();
        self.previous_interim_text = latest.to_string();

        let edit = append_only_edit_from_committed_to_latest(&self.committed_text, &stable_prefix)?;
        if edit.is_empty() {
            return None;
        }
        self.committed_text = stable_prefix;
        self.active = true;
        Some(edit)
    }

    fn finish(&mut self, generation: u64, final_text: &str) -> Option<WordByWordPasteEdit> {
        if self.generation != Some(generation) || !self.active {
            return None;
        }

        let final_text = normalize_realtime_paste_text(final_text);
        let edit = append_only_edit_from_committed_to_latest(&self.committed_text, final_text)
            .unwrap_or_else(|| WordByWordPasteEdit {
                backspace_chars: 0,
                text: String::new(),
            });

        self.generation = None;
        self.active = false;
        self.committed_text.clear();
        self.previous_interim_text.clear();
        Some(edit)
    }
}

fn normalize_realtime_paste_text(text: &str) -> &str {
    text.trim_start()
}

fn append_only_edit_from_committed_to_latest(
    committed: &str,
    latest: &str,
) -> Option<WordByWordPasteEdit> {
    latest.starts_with(committed).then(|| WordByWordPasteEdit {
        backspace_chars: 0,
        text: latest[committed.len()..].to_string(),
    })
}

fn common_prefix_len_on_char_boundary(a: &str, b: &str) -> usize {
    let mut last = 0;
    for ((ai, ac), (_, bc)) in a.char_indices().zip(b.char_indices()) {
        if ac != bc {
            break;
        }
        last = ai + ac.len_utf8();
    }
    last
}

fn stable_word_boundary_prefix<'a>(previous: &str, latest: &'a str) -> &'a str {
    let common_len = common_prefix_len_on_char_boundary(previous, latest);
    let common = &latest[..common_len];
    match common.rfind(char::is_whitespace) {
        Some(idx) => &common[..idx + common[idx..].chars().next().map_or(0, char::len_utf8)],
        None => "",
    }
}

/// Loop-carried worker state (mirrors the Python `_RealtimeLoopState`). One owned
/// `RealtimeAccumulator` per worker lifetime + the per-loop markers reset on each recording's
/// rising edge. Threaded `&mut` through `process_tick` so the hot loop allocates nothing per tick.
struct RealtimeLoopState {
    acc: RealtimeAccumulator,
    /// Set on the recording rising edge; `None` while idle.
    recording_seen_at: Option<Instant>,
    /// Gates the non-native window re-decodes (the configured processing-pause back-off).
    last_transcription: Instant,
    /// `-1` sentinel → "no tick processed yet this recording" (Python last_processed_frame_count).
    last_processed_len: i64,
    /// The recorder's recording-generation as of the last reset. Used to detect a NEW recording
    /// even when the idle gap was never observed (quick re-press).
    last_generation: Option<u64>,
    /// Native-streaming preview state, decided ONCE per recording (the loaded engine's kind doesn't
    /// change mid-recording). `None` until the engine resolves; `Some(true)` → feed only new
    /// samples to the engine's cache via `stream_accept`; `Some(false)` → window-redecode.
    native_decided: Option<bool>,
    /// Absolute count of samples already handed to the streaming engine.
    fed_len: usize,
    last_native_emit_text: String,
}

impl RealtimeLoopState {
    fn new() -> Self {
        Self {
            acc: RealtimeAccumulator::new(),
            recording_seen_at: None,
            last_transcription: Instant::now(),
            last_processed_len: -1,
            last_generation: None,
            native_decided: None,
            fed_len: 0,
            last_native_emit_text: String::new(),
        }
    }
}

/// How `run_loop` should advance after a `process_tick` (the original `continue` /
/// `sleep; continue` control flow, made explicit).
enum TickAction {
    /// Proceed to the next loop iteration immediately.
    Continue,
    /// Sleep for the given duration, then proceed to the next iteration.
    Sleep(Duration),
}

/// The realtime live-preview daemon. Holds Arc handles to the managers + app; `start()`
/// spawns ONE background thread that runs the decode loop for the app's lifetime.
pub struct RealtimeManager {
    app: AppHandle,
    transcription: Arc<TranscriptionManager>,
    audio: Arc<AudioRecordingManager>,
    started: AtomicBool,
    word_by_word_paste: Mutex<WordByWordPasteState>,
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
            word_by_word_paste: Mutex::new(WordByWordPasteState::default()),
        }
    }

    fn maybe_word_by_word_paste(
        &self,
        generation: u64,
        settings: &crate::winstt::settings_schema::WinsttSettings,
        text: &str,
        is_final: bool,
    ) {
        if !settings.general.word_by_word_pasting {
            return;
        }

        let edit = {
            let mut state = self
                .word_by_word_paste
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if is_final {
                state.next_final_edit(generation, text)
            } else {
                state.next_interim_edit(generation, text)
            }
        };

        if let Some(edit) = edit {
            if let Err(err) = crate::clipboard::paste_streaming_edit_on_main_thread(
                &self.app,
                edit.backspace_chars,
                edit.text,
            ) {
                log::error!("word-by-word paste failed to schedule: {err}");
            }
        }
    }

    /// Complete a recording that already streamed text into the target app.
    /// Returns `true` when the normal final paste should be suppressed.
    pub fn finish_word_by_word_session(&self, generation: u64, final_text: &str) -> bool {
        let edit = {
            let mut state = self
                .word_by_word_paste
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.finish(generation, final_text)
        };
        let Some(mut edit) = edit else {
            return false;
        };

        if read_settings_raw(&self.app).core.append_trailing_space {
            edit.text.push(' ');
        }

        if !edit.is_empty() {
            if let Err(err) = crate::clipboard::paste_streaming_edit_on_main_thread(
                &self.app,
                edit.backspace_chars,
                edit.text,
            ) {
                log::error!("word-by-word final suffix paste failed to schedule: {err}");
            }
        }
        SttEvents::realtime_stabilized_with_final(&self.app, final_text, true);
        SttEvents::realtime_text_with_final(&self.app, final_text, true);
        if let Err(err) = crate::clipboard::submit_after_dictation_paste_on_main_thread(&self.app) {
            log::error!("word-by-word auto-submit failed to schedule: {err}");
        }
        true
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
    ///
    /// Orchestrates: `RealtimeLoopState` (the loop-carried `_RealtimeLoopState` mirror) + a
    /// per-tick `process_tick` that returns a `TickAction` (continue immediately or sleep then
    /// continue). All decode/emit logic lives in `process_tick` and its named sub-steps.
    fn run_loop(&self) {
        log::info!("[realtime] worker started");
        let mut state = RealtimeLoopState::new();
        loop {
            match self.process_tick(&mut state) {
                TickAction::Continue => {}
                TickAction::Sleep(dur) => std::thread::sleep(dur),
            }
        }
    }

    /// One iteration of the realtime worker (port of `_realtime_step`). Runs the idle/gate/edge
    /// guards, then dispatches to the native-streaming fast path or the window-redecode path.
    /// Returns a `TickAction` describing how the loop should advance (the original `continue` /
    /// `sleep; continue` control flow, made explicit so the body reads as a sequence of guards).
    fn process_tick(&self, state: &mut RealtimeLoopState) -> TickAction {
        // ── not recording: reset accumulator (keep last text), idle-sleep ──
        // Mirrors _realtime_idle_reset: reset(clear_last=False), clear per-loop markers.
        if !self.audio.is_recording() {
            state.acc.reset(false);
            state.recording_seen_at = None;
            state.last_processed_len = -1;
            // Stop the recorder's live-audio mirror from growing while idle (no second copy
            // when nothing is being previewed).
            self.audio.set_realtime_enabled(false);
            return TickAction::Sleep(Duration::from_millis(10));
        }

        // Gate the WHOLE decode path on effective-realtime (live preview actually shown).
        // When disabled, idle exactly like the not-recording branch but WITHOUT resetting
        // (a recording is in progress and may re-enable mid-session). Mirrors the Python
        // worker only running when realtime is configured. Use the secret-agnostic
        // `read_settings_raw` here (NOT `read_settings`): this is the hot recording loop and
        // none of the fields it reads are secrets, so we must not trigger per-tick secret
        // decryption (reg.exe spawns) on the live path.
        let settings = read_settings_raw(&self.app);
        // The in-app preview panel lives inside the main WinSTT window, so it's only visible
        // when one of our windows holds focus. During normal dictation the user is typing into
        // ANOTHER app (WinSTT unfocused), so feeding the realtime model purely for that hidden
        // panel is wasted work — gate it on focus. The pill overlay (in-pill/both with the
        // overlay shown) and word-by-word pasting stay live regardless; see
        // `effective_realtime_with_focus`.
        if !effective_realtime_with_focus(&settings, any_window_focused(&self.app)) {
            // Realtime is off this tick → keep the recorder mirror disabled (free) and idle.
            self.audio.set_realtime_enabled(false);
            return TickAction::Sleep(Duration::from_millis(10));
        }

        // Realtime IS shown for this recording → ensure the recorder is mirroring audio into
        // `live_audio` so our snapshots see the growing window. Cheap, idempotent.
        self.audio.set_realtime_enabled(true);

        let generation = self.audio.recording_generation();
        self.handle_recording_edge(state, generation);
        let Some(seen_at) = state.recording_seen_at else {
            return TickAction::Sleep(Duration::from_millis(10));
        };

        // ── readiness gate (port of _realtime_ready) ──
        let init_after =
            Duration::from_secs_f64(settings.quality.init_realtime_after_seconds.max(0.0));
        if seen_at.elapsed() < init_after {
            return TickAction::Sleep(Duration::from_millis(1));
        }

        // ── NATIVE-STREAMING fast path (T-One / sherpa Zipformer+NeMo) ──
        // Resolve once per recording. The engine carries cache state across chunks, so native
        // streaming feeds only new samples and blocks on recorder progress below. While the
        // engine is still loading/contended, idle briefly instead of starting speculative
        // window re-decodes.
        if state.native_decided.is_none() {
            state.native_decided = self.transcription.realtime_native_streaming();
            if state.native_decided == Some(true) {
                self.transcription.stream_reset_realtime();
                state.fed_len = 0;
                state.last_processed_len = -1;
                state.last_native_emit_text.clear();
            }
        }
        if state.native_decided.is_none() {
            return TickAction::Sleep(ENGINE_READY_PROBE_INTERVAL);
        }

        if state.native_decided == Some(true) {
            return self.process_native_stream_tick(state, &settings, generation);
        }

        self.process_window_redecode_tick(state, &settings, generation)
    }

    /// New-recording edge (port of `_realtime_mark_recording_start`). Stamps the start time +
    /// `reset(clear_last=True)` so the stabilizer + committed text start clean for the new
    /// utterance.
    ///
    /// Detect a fresh recording by the recorder's monotonic GENERATION, not only by having
    /// observed `!is_recording()` since the last tick. On a quick press→release→press the worker
    /// can be mid-decode across the boundary and never see the idle gap, so a
    /// `recording_seen_at`-only edge would (1) leave the previous utterance's committed-frame
    /// watermark in place — freezing the preview until the new take grows past it — and (2) let
    /// the previous take's in-flight text be emitted into the new session (the pill "carries on
    /// the previous transcription"). Resetting on a generation change closes both holes.
    /// `last_processed_len` is reset here too so the stale-audio guard doesn't compare against the
    /// previous recording's length.
    fn handle_recording_edge(&self, state: &mut RealtimeLoopState, generation: u64) {
        if state.recording_seen_at.is_none() || state.last_generation != Some(generation) {
            state.recording_seen_at = Some(Instant::now());
            state.last_generation = Some(generation);
            state.last_processed_len = -1;
            state.acc.reset(true);
            // Re-decide native vs window for the new utterance; the streaming engine's stream is
            // reset the moment `process_tick` (re-)detects native so it starts from the buffer head.
            state.native_decided = None;
            state.fed_len = 0;
            state.last_native_emit_text.clear();
        }
    }

    /// Native-streaming fast path (T-One / sherpa Zipformer+NeMo). Feeds only the new samples past
    /// `fed_len` to the engine's cache and emits the incremental update. Returns the `TickAction`
    /// for the loop (continue, or a short back-off sleep while a batch decode holds the engine).
    fn process_native_stream_tick(
        &self,
        state: &mut RealtimeLoopState,
        settings: &crate::winstt::settings_schema::WinsttSettings,
        generation: u64,
    ) -> TickAction {
        if !self
            .audio
            .wait_for_realtime_audio_after(state.fed_len, NATIVE_STREAM_WAKE_TIMEOUT)
        {
            return TickAction::Continue;
        }
        let (total_len, new_tail) = self.audio.snapshot_audio_from(state.fed_len);
        if total_len as i64 == state.last_processed_len {
            return TickAction::Continue;
        }
        if new_tail.is_empty() {
            return TickAction::Continue;
        }
        let pending_audio = Duration::from_secs_f32(new_tail.len() as f32 / REALTIME_FPS);
        let decode_started = Instant::now();
        match self
            .transcription
            .stream_accept_realtime(generation, total_len, &new_tail)
        {
            RealtimeStreamOutcome::Text(update) => {
                let decode_elapsed = decode_started.elapsed();
                if pending_audio >= NATIVE_STREAM_BACKLOG_WARN_AFTER
                    || decode_elapsed >= NATIVE_STREAM_BACKLOG_WARN_AFTER
                {
                    log::warn!(
                        "[realtime] native stream backlog: pending_audio_ms={} decode_ms={}",
                        pending_audio.as_millis(),
                        decode_elapsed.as_millis()
                    );
                }
                state.fed_len = total_len;
                state.last_processed_len = total_len as i64;
                let text = update.text;
                let is_final = update.is_final;
                // Late bail: PTT released / generation changed mid-decode (don't flash a stale
                // tick over the final paste or into the next session).
                if !self.audio.is_recording() || self.audio.recording_generation() != generation {
                    return TickAction::Continue;
                }
                self.maybe_word_by_word_paste(generation, settings, &text, is_final);
                if is_final || text != state.last_native_emit_text {
                    state.last_native_emit_text = text.clone();
                    SttEvents::realtime_stabilized_with_final(&self.app, &text, is_final);
                    SttEvents::realtime_text_with_final(&self.app, &text, is_final);
                }
                TickAction::Continue
            }
            // Batch decode holds the engine — retry the SAME samples next tick (don't advance
            // `fed_len`/`last_processed_len`).
            RealtimeStreamOutcome::Skipped => TickAction::Sleep(Duration::from_millis(5)),
            // Engine swapped to a non-streaming kind under us → window path from now on.
            RealtimeStreamOutcome::NotStreaming => {
                state.native_decided = Some(false);
                TickAction::Continue
            }
        }
    }

    /// Window-redecode path (attention enc-dec families). Re-decodes the growing window past the
    /// committed-frame watermark, commits the older portion, publishes the stabilized preview, and
    /// caches the assembled text for the final-paste reuse fast path.
    fn process_window_redecode_tick(
        &self,
        state: &mut RealtimeLoopState,
        settings: &crate::winstt::settings_schema::WinsttSettings,
        generation: u64,
    ) -> TickAction {
        let processing_pause = realtime_redecode_pause(settings.quality.realtime_processing_pause);
        if state.last_transcription.elapsed() < processing_pause {
            return TickAction::Sleep(Duration::from_millis(1));
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
        let base = state.acc.committed_frames() as usize;
        let (total_len, tail) = self.audio.snapshot_audio_from(base);
        let total_frames = total_len as u64;
        if total_len as i64 == state.last_processed_len {
            return TickAction::Sleep(Duration::from_millis(50));
        }
        state.last_processed_len = total_len as i64;
        state.last_transcription = Instant::now();

        // Nothing past the watermark yet → skip (port of _realtime_process_once guard).
        if total_frames <= state.acc.committed_frames() {
            return TickAction::Continue;
        }

        // ── commit the older portion once the fresh window exceeds the threshold ──
        // commit_if_needed calls the closure with absolute (start_frame, end_frame); we re-base
        // them onto `tail` (subtract `base`) and clamp to its bounds defensively (the watermark
        // can briefly exceed a torn/shrunk snapshot during the next-recording transition).
        // The configured language is threaded through so each realtime tick reuses it instead
        // of re-running Whisper's language-detect (we already have `settings` in hand).
        let lang_owned = fixed_realtime_language_from_model(&settings.model);
        let lang = lang_owned.as_deref();
        let tm = &self.transcription;
        let snap = &tail;
        state
            .acc
            .commit_if_needed(total_frames, REALTIME_FPS, |start_frame, end_frame| {
                // Re-base absolute frame indices onto the tail (start_frame >= base always, since
                // the commit slice begins at the current watermark which is >= base).
                let start = (start_frame as usize).saturating_sub(base).min(snap.len());
                let end = (end_frame as usize).saturating_sub(base).min(snap.len());
                if start >= end {
                    return Some(String::new()); // empty slice → no text, watermark still advances
                }
                Some(
                    tm.transcribe_realtime(&snap[start..end], lang)
                        .unwrap_or_default(),
                )
            });

        // ── decode the FRESH window past the (possibly advanced) watermark ──
        // Frames committed_frames..total_frames → tail indices (re-based by `base`), clamped.
        let committed = state.acc.committed_frames();
        let fresh_start = (committed as usize).saturating_sub(base).min(tail.len());
        let fresh_text = if fresh_start >= tail.len() {
            String::new()
        } else {
            tm.transcribe_realtime(&tail[fresh_start..], lang)
                .unwrap_or_default()
        };

        let publish = state.acc.publish_fresh(&fresh_text);

        // Cache the assembled realtime text for the final-paste reuse fast path. Cache even on
        // the tick where the recording just ended (still our generation) — the most complete
        // preview. `try_reuse_realtime` consumes it only for NON-context (CTC/transducer/
        // streaming) families; the attention enc-dec families re-decode via VAD-segment instead.
        if self.audio.recording_generation() == generation {
            self.transcription
                .cache_realtime_reuse(generation, total_len, &publish.raw);
        }

        // ── late bail (port of _publish_realtime_update's is_recording re-check) ──
        // The user may have released PTT during the (potentially long) decode; the recorder
        // has already flipped out of Recording and main is about to run its own final pass.
        // Skip the emit so the preview doesn't flash a stale realtime tick over the final
        // text. Also bail when the recording GENERATION changed mid-decode (release + quick
        // re-press): this decode belongs to the PREVIOUS utterance, so emitting it would
        // repaint the next session's freshly-cleared pill with the old transcription.
        if !self.audio.is_recording() || self.audio.recording_generation() != generation {
            return TickAction::Continue;
        }

        // ── emit STABILIZED first, then UPDATE (RealtimeSTT ordering) ──
        // Both carry `publish.stabilized` (matches the Python publish payload: the
        // stabilized monotonic text is what the renderer's live preview consumes; the raw
        // assembled text is carried separately for noise-break/logging consumers, but this
        // port surfaces the stabilized text on both events per the spec).
        SttEvents::realtime_stabilized_with_final(&self.app, &publish.stabilized, false);
        SttEvents::realtime_text_with_final(&self.app, &publish.stabilized, false);
        TickAction::Continue
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_streaming_uses_configured_redecode_interval() {
        assert_eq!(realtime_redecode_pause(0.25), Duration::from_millis(250));
    }

    #[test]
    fn append_only_edit_appends_generated_suffix() {
        assert_eq!(
            append_only_edit_from_committed_to_latest("hello", "hello world"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: " world".to_string(),
            })
        );
    }

    #[test]
    fn normalize_realtime_paste_text_drops_leading_space_only() {
        assert_eq!(
            normalize_realtime_paste_text("  hello world  "),
            "hello world  "
        );
    }

    #[test]
    fn append_only_edit_rejects_rewrites() {
        assert_eq!(
            append_only_edit_from_committed_to_latest("helo ", "hello there"),
            None
        );
    }

    #[test]
    fn stable_prefix_keeps_only_words_seen_across_interim_updates() {
        assert_eq!(stable_word_boundary_prefix("", "hello wor"), "");
        assert_eq!(
            stable_word_boundary_prefix("hello wor", "hello world"),
            "hello "
        );
        assert_eq!(
            stable_word_boundary_prefix("hello world", "hello world again"),
            "hello "
        );
        assert_eq!(
            stable_word_boundary_prefix("hello world again", "hello world again soon"),
            "hello world "
        );
    }

    #[test]
    fn word_by_word_state_appends_stable_interim_prefixes() {
        let mut state = WordByWordPasteState::default();

        assert_eq!(state.next_interim_edit(7, "hello wor"), None);
        assert_eq!(
            state.next_interim_edit(7, "hello world"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: "hello ".to_string(),
            })
        );
        assert_eq!(state.next_interim_edit(7, "hello worlds"), None);
        assert_eq!(state.next_interim_edit(7, "hello world again"), None);
        assert_eq!(
            state.next_interim_edit(7, "hello world again soon"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: "world ".to_string(),
            })
        );
    }

    #[test]
    fn word_by_word_state_does_not_paste_unstable_interim_rewrites() {
        let mut state = WordByWordPasteState::default();

        assert_eq!(state.next_interim_edit(7, "helo "), None);
        assert_eq!(state.next_interim_edit(7, "hello there"), None);
        assert!(!state.active);
        assert!(state.committed_text.is_empty());
    }

    #[test]
    fn word_by_word_state_appends_only_final_stream_chunks() {
        let mut state = WordByWordPasteState::default();

        assert_eq!(
            state.next_final_edit(7, "hello"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: "hello".to_string(),
            })
        );
        assert_eq!(
            state.next_final_edit(7, "hello world"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: " world".to_string(),
            })
        );
        assert!(state.active);

        assert_eq!(
            state.finish(7, "hello world again"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: " again".to_string(),
            })
        );
        assert!(!state.active);
        assert_eq!(state.generation, None);
    }

    #[test]
    fn word_by_word_finish_returns_none_when_no_final_chunk_landed() {
        let mut state = WordByWordPasteState::default();

        assert_eq!(state.finish(7, "hello world"), None);
        assert!(!state.active);
    }

    #[test]
    fn word_by_word_state_does_not_repair_realtime_rewrites() {
        let mut state = WordByWordPasteState::default();

        assert_eq!(
            state.next_final_edit(7, "helo"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: "helo".to_string(),
            })
        );
        assert_eq!(state.next_final_edit(7, "hello there"), None);
    }

    #[test]
    fn word_by_word_state_resets_on_new_generation() {
        let mut state = WordByWordPasteState::default();

        assert_eq!(
            state.next_final_edit(1, "old words"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: "old words".to_string(),
            })
        );
        assert_eq!(
            state.next_final_edit(2, "new words"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: "new words".to_string(),
            })
        );
        assert_eq!(state.finish(1, "old words again"), None);
        assert_eq!(
            state.finish(2, "new words again"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: " again".to_string(),
            })
        );
    }

    #[test]
    fn word_by_word_finish_does_not_repair_final_text_rewrites_prefix() {
        let mut state = WordByWordPasteState::default();

        assert_eq!(
            state.next_final_edit(3, "hello world"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: "hello world".to_string(),
            })
        );

        assert_eq!(
            state.finish(3, "HELLO WORLD THERE"),
            Some(WordByWordPasteEdit {
                backspace_chars: 0,
                text: String::new(),
            })
        );
    }
}
