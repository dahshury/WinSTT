use crate::audio_toolkit::{is_microphone_access_denied, is_no_input_device_error};
use crate::managers::audio::AudioRecordingManager;
use crate::managers::history::HistoryManager;
use crate::managers::transcription::{is_silent_recording, TranscriptionManager};
use crate::shortcut;
use crate::tray::{change_tray_icon, TrayIconState};
use crate::utils::{self, show_recording_overlay};
use log::{debug, error, info, warn};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::Manager;
use tauri::{AppHandle, Emitter};

use super::post_process::{process_transcription_output, should_run_winstt_dictation_llm_from_app};
use super::{
    cancelled_session_cleanup, set_last_transcription, FinishGuard, RecordingErrorEvent,
    ShortcutAction,
};

const AUDIO_SAMPLE_RATE: usize = 16_000;
const SLOW_RECORDING_STOP_MS: u128 = 2_000;
const SLOW_HISTORY_AUDIO_PERSIST_MS: u128 = 2_000;

fn samples_to_ms(samples: usize) -> u64 {
    ((samples as u128 * 1000) / AUDIO_SAMPLE_RATE as u128) as u64
}

#[expect(
    clippy::too_many_arguments,
    reason = "history persistence mirrors HistoryManager::save_entry row fields"
)]
fn persist_history_after_wav(
    app: AppHandle,
    hm: Arc<HistoryManager>,
    wav_handle: tauri::async_runtime::JoinHandle<anyhow::Result<()>>,
    wav_path_for_verify: PathBuf,
    sample_count: usize,
    file_name: String,
    transcription_text: String,
    post_process_requested: bool,
    post_processed_text: Option<String>,
    post_process_prompt: Option<String>,
    llm_meta: Option<String>,
    dictionary_fixes: Option<i64>,
    history_tag: Option<String>,
    privacy_markers_json: Option<String>,
    stt_model: Option<String>,
) {
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        info!(
            "[history] wav_persist_start file='{file_name}' samples={sample_count} audio_ms={}",
            samples_to_ms(sample_count)
        );

        let wav_saved = match wav_handle.await {
            Ok(Ok(())) => {
                match crate::audio_toolkit::verify_wav_file(&wav_path_for_verify, sample_count) {
                    Ok(()) => true,
                    Err(e) => {
                        error!("WAV verification failed: {}", e);
                        false
                    }
                }
            }
            Ok(Err(e)) => {
                error!("Failed to save WAV file: {}", e);
                false
            }
            Err(e) => {
                error!("WAV save task panicked: {}", e);
                false
            }
        };

        let elapsed_ms = started.elapsed().as_millis();
        if elapsed_ms >= SLOW_HISTORY_AUDIO_PERSIST_MS {
            warn!(
                "[history] wav_persist_slow file='{file_name}' duration_ms={elapsed_ms} samples={sample_count}"
            );
            crate::winstt::observability::IssueBuilder::new(
                "history",
                "wav_persistence",
                "Recording WAV persistence was slow",
            )
            .detail(format!("WAV persistence completed in {elapsed_ms}ms"))
            .kind("timeout")
            .severity("warn")
            .duration_ms(elapsed_ms as u64)
            .user_visible(false)
            .context("fileName", file_name.clone())
            .context("samples", sample_count.to_string())
            .context("audioMs", samples_to_ms(sample_count).to_string())
            .record(Some(&app));
        }

        if !wav_saved {
            return;
        }

        if let Err(err) = hm.save_entry(
            file_name,
            transcription_text,
            post_process_requested,
            post_processed_text,
            post_process_prompt,
            llm_meta,
            dictionary_fixes,
            history_tag,
            privacy_markers_json,
            stt_model,
        ) {
            error!("Failed to save history entry: {}", err);
        }
    });
}

// Transcribe Action
pub(super) struct TranscribeAction {
    pub(super) post_process: bool,
}

impl ShortcutAction for TranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let start_time = Instant::now();
        debug!("TranscribeAction::start called for binding: {}", binding_id);
        if crate::winstt::commands::onboarding::is_onboarding_active() {
            debug!("TranscribeAction::start ignored while onboarding is active");
            return;
        }

        // Load model in the background
        let tm = app.state::<Arc<TranscriptionManager>>();
        let rm = app.state::<Arc<AudioRecordingManager>>();

        // Load ASR model and VAD model in parallel
        tm.initiate_model_load();
        let rm_clone = Arc::clone(&rm);
        std::thread::spawn(move || {
            if let Err(e) = rm_clone.preload_vad() {
                debug!("VAD pre-load failed: {}", e);
            }
        });

        let binding_id = binding_id.to_string();
        let session_id = crate::transcription_coordinator::begin_dictation_session();
        debug!("Starting dictation session {session_id}");
        shortcut::register_cancel_shortcut(app);
        crate::winstt::commands::tts::request_tts_playback_pause_for_dictation(app);
        change_tray_icon(app, TrayIconState::Recording);
        show_recording_overlay(app);

        // Get the microphone mode to determine audio feedback timing.
        let settings = crate::winstt::commands::settings::read_settings_raw(app);
        let is_always_on = matches!(
            crate::managers::audio::microphone_mode_from_settings(&settings),
            crate::managers::audio::MicrophoneMode::AlwaysOn
        );
        debug!("Microphone mode - always_on: {}", is_always_on);

        let mut recording_error: Option<String> = None;
        if is_always_on {
            // Always-on mode: the mic stream is already open, so mute can apply
            // immediately. The start chime is the winstt recording sound played
            // below (duck_then_play_recording_chime) — it routes to the OUTPUT
            // device and is independent of the INPUT mute applied here.
            debug!("Always-on mode: applying mute");
            rm.apply_mute();

            if let Err(e) = rm.try_start_recording(&binding_id) {
                debug!("Recording failed: {}", e);
                recording_error = Some(e);
            }
        } else {
            // On-demand mode: start recording first, then apply mute once the mic
            // stream is active. The start chime (winstt recording sound) plays
            // below on the output device, so muting the input does not silence it.
            debug!("On-demand mode: starting recording first, then muting input");
            let recording_start_time = Instant::now();
            match rm.try_start_recording(&binding_id) {
                Ok(()) => {
                    debug!("Recording started in {:?}", recording_start_time.elapsed());
                    // Small delay to ensure microphone stream is active before mute.
                    let rm_clone = Arc::clone(&rm);
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        debug!("Applying delayed input mute");
                        rm_clone.apply_mute();
                    });
                }
                Err(e) => {
                    debug!("Failed to start recording: {}", e);
                    recording_error = Some(e);
                }
            }
        }

        if recording_error.is_none() {
            if crate::transcription_coordinator::is_dictation_session_cancelled(session_id) {
                rm.cancel_recording();
                let _ = cancelled_session_cleanup(app, session_id, "recording start");
                utils::unregister_cancel_shortcut_if_idle(app);
                return;
            }
            // WinSTT lifecycle: a new recording cycle began. The reused renderer's
            // useVisualizerSync (onRecordingStart) arms the rAF level loop + shows the
            // overlay pill, and useTranscriptionFeed wipes ephemeral state + sets
            // isRecordingActive(true). Emitted only once the recorder actually opened
            // (recording_error is None) so a failed-mic start doesn't flash the pill.
            // NOTE: we deliberately do NOT fake `vad-start` here. The recorder's real
            // smoothed-Silero VAD now surfaces `stt:vad-start` / `stt:vad-stop` on actual
            // speech onset/offset (managers::audio::create_audio_recorder
            // with_speech_callback), so `isSpeaking` reflects real speech instead of the
            // whole recording window — the overlay pill reveals on the first words, not
            // on the silent lead-in. See winstt/commands/dictation.rs::SttEvents.
            crate::winstt::commands::dictation::SttEvents::recording_start(app);
            // Play the recording chime (the reference `playRecordingSound()` on hotkey-start).
            // Native rodio instead of the old `app.emit("sound:play")` ->
            // renderer Web Audio path: the webview chime hung off the main window's
            // AudioContext, which starts suspended (a global hotkey gives the page no
            // user gesture) and is throttled by WebView2 while the window sits hidden in
            // the tray — so the first chime after idle could lag/drop. Playing from Rust
            // removes the IPC→webview hop and both hazards. Self-gates on
            // `general.recording_sound` and fires on a worker thread (non-blocking).
            // Listen mode goes through loopback_manager (not this path), matching the
            // reference's "suppressed in listen mode".
            //
            // System-audio ducking is sequenced INSIDE this call: background audio
            // is ducked first (per-session, protecting WinSTT's process tree), then
            // the chime plays at full volume — so the chime is never attenuated.
            crate::winstt::commands::sound::duck_then_play_recording_chime(
                app,
                rm.recording_generation(),
            );
        } else {
            crate::transcription_coordinator::finish_dictation_session(session_id);
            utils::unregister_cancel_shortcut_if_idle(app);
            // Starting failed (for example due to blocked microphone permissions).
            // Revert UI state so we don't stay stuck in the recording overlay.
            utils::hide_recording_overlay(app);
            change_tray_icon(app, TrayIconState::Idle);
            if let Some(err) = recording_error {
                let error_type = if is_microphone_access_denied(&err) {
                    "microphone_permission_denied"
                } else if is_no_input_device_error(&err) {
                    "no_input_device"
                } else {
                    "unknown"
                };
                let _ = app.emit(
                    crate::winstt::commands::events::names::RECORDING_ERROR,
                    RecordingErrorEvent {
                        error_type: error_type.to_string(),
                        detail: Some(err),
                    },
                );
            }
        }

        debug!(
            "TranscribeAction::start completed in {:?}",
            start_time.elapsed()
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let stop_time = Instant::now();
        debug!("TranscribeAction::stop called for binding: {}", binding_id);

        let ah = app.clone();
        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
        let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());

        change_tray_icon(app, TrayIconState::Transcribing);

        // WinSTT lifecycle: the recorder stopped (PTT release / toggle-off). The
        // renderer's useVisualizerSync (onRecordingStop) snaps the visualizer to
        // zero AND clears `isSpeaking`; the overlay pill stays armed until a terminal
        // event lands. isRecordingActive is held true across recording-stop so the
        // pill survives the "transcribing/thinking" transition (see useTranscriptionFeed).
        // Do not call `show_recording_overlay` here: start already showed the window,
        // and re-showing on key release can resurrect a stale floating-bottom frame
        // right before the terminal event starts the exit animation.
        // No fake `vad-stop` here — the recorder emits a real one (Cmd::Stop →
        // speech_cb(false)) if speech was still open at release, and recordingStopped()
        // zeroes `isSpeaking` regardless.
        crate::winstt::commands::dictation::SttEvents::recording_stop(app);

        // Restore the input mute applied at recording start. The winstt sound
        // system has a single recording chime (played on start by
        // duck_then_play_recording_chime) and no separate stop sound, so there is
        // no stop chime to gate this on.
        rm.remove_mute();

        let binding_id = binding_id.to_string(); // Clone binding_id for the async task
        let post_process = self.post_process;
        let session_id = crate::transcription_coordinator::current_dictation_session();
        // Snapshot the recording generation BEFORE `stop_recording` so the realtime-reuse check
        // matches the generation the realtime worker tagged its live decodes with. (Generation is
        // bumped only on the NEXT recording's start, so reading it here — recording still active —
        // yields the take being finalized; a racing re-press makes the cache generation mismatch,
        // which `try_reuse_realtime` safely rejects.)
        let generation = rm.recording_generation();

        tauri::async_runtime::spawn(async move {
            let _guard = FinishGuard {
                app: ah.clone(),
                session_id,
            };
            debug!(
                "Starting async transcription task for binding: {}",
                binding_id
            );

            let stop_recording_time = Instant::now();
            if let Some(samples) = rm.stop_recording(&binding_id) {
                let stop_recording_elapsed = stop_recording_time.elapsed();
                debug!(
                    "Recording stopped and samples retrieved in {:?}, sample count: {}",
                    stop_recording_elapsed,
                    samples.len()
                );
                if stop_recording_elapsed.as_millis() >= SLOW_RECORDING_STOP_MS {
                    crate::winstt::observability::IssueBuilder::new(
                        "stt",
                        "recording_stop",
                        "Recording stop took a long time before transcription",
                    )
                    .detail(format!(
                        "recording stop completed in {}ms",
                        stop_recording_elapsed.as_millis()
                    ))
                    .kind("timeout")
                    .severity("warn")
                    .duration_ms(stop_recording_elapsed.as_millis() as u64)
                    .user_visible(false)
                    .context("samples", samples.len().to_string())
                    .context("audioMs", samples_to_ms(samples.len()).to_string())
                    .record(Some(&ah));
                }

                if cancelled_session_cleanup(&ah, session_id, "recording stop") {
                    return;
                }

                if is_silent_recording(&samples) {
                    debug!(
                        "Recording produced no decodable audio ({} samples); skipping persistence",
                        samples.len()
                    );
                    // WinSTT terminal: nothing usable was captured. The renderer's
                    // useTranscriptionFeed (onNoAudioDetected) clears live overlay
                    // state and resets isRecordingActive without showing a status pill.
                    crate::winstt::commands::dictation::SttEvents::no_audio_detected(&ah);
                    utils::hide_recording_overlay(&ah);
                    change_tray_icon(&ah, TrayIconState::Idle);
                } else {
                    // Save WAV concurrently with transcription
                    let sample_count = samples.len();
                    let file_name = format!("winstt-{}.wav", chrono::Utc::now().timestamp());
                    let wav_path = hm.recordings_dir().join(&file_name);
                    let wav_path_for_verify = wav_path.clone();
                    let samples_for_wav = samples.clone();
                    let wav_handle = tauri::async_runtime::spawn_blocking(move || {
                        crate::audio_toolkit::save_wav_file(&wav_path, &samples_for_wav)
                    });

                    // WinSTT lifecycle: transcription kicked off. `audioBase64` is
                    // None here — the renderer's onTranscriptionStart wrapper exists
                    // for parity but has no active consumer (history playback reads
                    // the saved WAV via history_load_audio, not this payload), so we
                    // skip the base64 encode in the hot path.
                    crate::winstt::commands::dictation::SttEvents::transcription_start(&ah, None);

                    if cancelled_session_cleanup(&ah, session_id, "transcription start") {
                        return;
                    }

                    let preview_requested = {
                        let settings = crate::winstt::commands::settings::read_settings(&ah);
                        settings.general.preview_before_pasting
                            && !settings.general.word_by_word_pasting
                            && crate::winstt::commands::overlay::overlay_is_active(&ah)
                    };

                    // Transcribe concurrently with WAV save. The decode is a multi-second
                    // SYNC call (ONNX/GGML) — run it on the blocking pool so it never stalls
                    // a tokio worker thread (mirrors commands/history.rs). Flatten a task
                    // panic into the same `Result` shape the match below expects.
                    let transcription_time = Instant::now();
                    // FAST PATH: reuse the realtime stream when possible. Native streaming engines
                    // feed the captured tail and wait for `stream_finalize()` in this blocking task,
                    // so final paste follows the model's end-of-stream result instead of a fixed
                    // post-key-up delay. Falls back to a fresh decode when reuse is not safe.
                    let tm_for_decode = Arc::clone(&tm);
                    let transcription_result =
                        match tauri::async_runtime::spawn_blocking(move || {
                            if preview_requested {
                                debug!(
                                    "Preview-before-pasting active; skipping realtime reuse for batch final transcript"
                                );
                                tm_for_decode.clear_realtime_reuse();
                                return (false, tm_for_decode.transcribe(samples));
                            }

                            if let Some(reused) =
                                tm_for_decode.try_reuse_realtime(generation, &samples)
                            {
                                (true, Ok(reused))
                            } else {
                                (false, tm_for_decode.transcribe(samples))
                            }
                        })
                        .await
                        {
                            Ok((reused_realtime, result)) => {
                                if reused_realtime {
                                    if let Ok(text) = &result {
                                        debug!(
                                            "Reused finalized realtime stream for final transcription ({} chars)",
                                            text.len()
                                        );
                                    }
                                }
                                result
                            }
                            Err(e) => Err(anyhow::anyhow!("Transcription task panicked: {e}")),
                        };

                    if cancelled_session_cleanup(&ah, session_id, "transcription") {
                        return;
                    }

                    match transcription_result {
                        Ok(transcription) => {
                            // Do NOT log the dictated text — it lands in the persistent
                            // file log. Log only timing + length (privacy).
                            debug!(
                                "Transcription completed in {:?}: {} chars",
                                transcription_time.elapsed(),
                                transcription.len()
                            );

                            let will_run_post_stt_llm =
                                post_process || should_run_winstt_dictation_llm_from_app(&ah);
                            if will_run_post_stt_llm {
                                show_recording_overlay(&ah);
                            }
                            if cancelled_session_cleanup(&ah, session_id, "post-processing start") {
                                return;
                            }
                            let post_process_started = Instant::now();
                            info!(
                                "[stt-ui] post_process_start session_id={session_id} raw_chars={} hotkey_post_process={post_process}",
                                transcription.chars().count()
                            );
                            let processed =
                                process_transcription_output(&ah, &transcription, post_process)
                                    .await;
                            info!(
                                "[stt-ui] post_process_complete session_id={session_id} duration_ms={} final_chars={} post_processed={}",
                                post_process_started.elapsed().as_millis(),
                                processed.final_text.chars().count(),
                                processed.post_processed_text.is_some()
                            );

                            if cancelled_session_cleanup(&ah, session_id, "post-processing") {
                                return;
                            }

                            // Keep the raw transcript for the preview pill's
                            // "original" (re-process source) — `save_entry`
                            // consumes `transcription` when a WAV was saved.
                            let original_transcript = transcription.clone();

                            let privacy_markers_json =
                                serde_json::to_string(&processed.privacy_markers).ok();
                            persist_history_after_wav(
                                ah.clone(),
                                Arc::clone(&hm),
                                wav_handle,
                                wav_path_for_verify,
                                sample_count,
                                file_name,
                                transcription,
                                processed.post_process_requested,
                                processed.post_processed_text.clone(),
                                processed.post_process_prompt.clone(),
                                processed.llm_meta.clone(),
                                processed.dictionary_fixes,
                                processed.history_tag.clone(),
                                privacy_markers_json,
                                // Stamp the row with whichever STT ("main") model is loaded.
                                tm.get_current_model(),
                            );

                            if processed.final_text.is_empty() {
                                // WinSTT terminal: the engine ran but produced no
                                // text (silence / pure noise). Same pill slot as the
                                // empty-samples case (onNoAudioDetected).
                                crate::winstt::commands::dictation::SttEvents::no_audio_detected(
                                    &ah,
                                );
                                utils::hide_recording_overlay(&ah);
                                change_tray_icon(&ah, TrayIconState::Idle);
                            } else {
                                // WinSTT terminal: a finalized transcription (post
                                // Chinese-variant convert + optional LLM cleanup).
                                // The renderer's useTranscriptionFeed (onFullSentence)
                                // appends it to the live feed + history store and
                                // resets isRecordingActive; useVisualizerSync pulses
                                // the sentence ring. Emitted BEFORE the paste so the
                                // pill updates the instant the text is ready.
                                // Remember this as the re-pastable "last transcription"
                                // (the RepasteAction hotkey reads it). Recorded at the
                                // same point we auto-paste — mirrors relay.ts calling
                                // setLastTranscription alongside its paste.
                                set_last_transcription(&processed.final_text);

                                let streamed_paste_handled = ah
                                    .try_state::<Arc<crate::winstt::managers::RealtimeManager>>()
                                    .is_some_and(|rt| {
                                        rt.finish_word_by_word_session(
                                            generation,
                                            &processed.final_text,
                                        )
                                    });

                                // Preview-before-pasting: when enabled AND the pill is
                                // shown, hold the auto-paste back and show the editable
                                // preview pill. Capture the foreground (paste target)
                                // NOW — while the user's app still owns the foreground
                                // (the overlay hasn't taken focus yet) — then grow the
                                // overlay + make it interactive and emit the raw +
                                // processed text. The paste fires later on
                                // `confirm_paste`; dismiss → `cancel_preview`.
                                let preview_enabled = preview_requested;
                                if streamed_paste_handled {
                                    crate::winstt::commands::dictation::SttEvents::full_sentence(
                                        &ah,
                                        &processed.final_text,
                                    );
                                    utils::hide_recording_overlay(&ah);
                                    change_tray_icon(&ah, TrayIconState::Idle);
                                } else if preview_enabled {
                                    crate::winstt::commands::preview::capture_foreground(
                                        &ah,
                                        &processed.final_text,
                                    );
                                    crate::winstt::commands::overlay::enter_preview_overlay(&ah);
                                    // preview_ready BEFORE full_sentence so the renderer sets
                                    // `isPreviewActive` before full_sentence flips
                                    // `isRecordingActive` off — otherwise the pill briefly
                                    // collapses between the two events.
                                    crate::winstt::commands::dictation::SttEvents::preview_ready(
                                        &ah,
                                        &original_transcript,
                                        &processed.final_text,
                                    );
                                    crate::winstt::commands::dictation::SttEvents::full_sentence(
                                        &ah,
                                        &processed.final_text,
                                    );
                                    // Transcription is done; the pill stays up via the
                                    // renderer's `isPreviewActive` until confirm/cancel.
                                    change_tray_icon(&ah, TrayIconState::Idle);
                                } else {
                                    // pill updates the instant the text is ready.
                                    crate::winstt::commands::dictation::SttEvents::full_sentence(
                                        &ah,
                                        &processed.final_text,
                                    );

                                    // The transcription session is complete before paste delivery.
                                    // Clipboard/key synthesis can be blocked by the target app or
                                    // Windows clipboard ownership; keep that out of the island's
                                    // lifetime so a paste stall cannot look like infinite STT.
                                    utils::hide_recording_overlay(&ah);
                                    change_tray_icon(&ah, TrayIconState::Idle);

                                    #[cfg(target_os = "macos")]
                                    {
                                        let ah_clone = ah.clone();
                                        let paste_time = Instant::now();
                                        let final_text = processed.final_text;
                                        let paste_chars = final_text.chars().count();
                                        ah.run_on_main_thread(move || {
                                        info!(
                                            "[stt-ui] paste_start target=main_thread chars={paste_chars}"
                                        );
                                        match utils::paste(final_text, ah_clone.clone()) {
                                            Ok(()) => info!(
                                                "[stt-ui] paste_complete target=main_thread duration_ms={}",
                                                paste_time.elapsed().as_millis()
                                            ),
                                            Err(e) => {
                                                error!("Failed to paste transcription: {}", e);
                                                crate::winstt::commands::events::emit_paste_error(
                                                    &ah_clone,
                                                );
                                            }
                                        }
                                        })
                                        .unwrap_or_else(|e| {
                                            error!("Failed to run paste on main thread: {:?}", e);
                                        });
                                    }

                                    #[cfg(not(target_os = "macos"))]
                                    {
                                        let ah_clone = ah.clone();
                                        let final_text = processed.final_text;
                                        let paste_chars = final_text.chars().count();
                                        std::thread::spawn(move || {
                                            #[cfg(target_os = "windows")]
                                            {
                                                crate::input::release_held_modifiers();
                                                std::thread::sleep(
                                                    std::time::Duration::from_millis(15),
                                                );
                                            }

                                            let paste_time = Instant::now();
                                            info!(
                                                "[stt-ui] paste_start target=worker chars={paste_chars}"
                                            );
                                            match utils::paste(final_text, ah_clone.clone()) {
                                                Ok(()) => info!(
                                                    "[stt-ui] paste_complete target=worker duration_ms={}",
                                                    paste_time.elapsed().as_millis()
                                                ),
                                                Err(e) => {
                                                    error!("Failed to paste transcription: {}", e);
                                                    crate::winstt::commands::events::emit_paste_error(
                                                        &ah_clone,
                                                    );
                                                }
                                            }
                                        });
                                    }
                                }
                            }
                        }
                        Err(err) => {
                            debug!("Global Shortcut Transcription error: {}", err);
                            // WinSTT terminal: a genuine transcriber error (engine
                            // panic / model not loaded / decode failure) — report it
                            // honestly via onTranscriptionFailed ("(transcription
                            // failed)" pill) rather than the misleading "no audio
                            // detected" lie (memory:
                            // project_whisper_incomplete_vocab_and_transcription_failed).
                            let failure_reason = err.to_string();
                            crate::winstt::commands::dictation::SttEvents::transcription_failed(
                                &ah,
                                Some(&failure_reason),
                            );
                            // Save entry with empty text so user can retry, but do not block the
                            // failed-terminal UI on recorder-file persistence.
                            persist_history_after_wav(
                                ah.clone(),
                                Arc::clone(&hm),
                                wav_handle,
                                wav_path_for_verify,
                                sample_count,
                                file_name,
                                String::new(),
                                post_process,
                                None,
                                None,
                                None,
                                None,
                                None,
                                None,
                                // Record the model that was active when the decode failed
                                // (may be None if it unloaded).
                                tm.get_current_model(),
                            );
                            utils::hide_recording_overlay(&ah);
                            change_tray_icon(&ah, TrayIconState::Idle);
                        }
                    }
                }
            } else {
                debug!("No samples retrieved from recording stop");
                if cancelled_session_cleanup(&ah, session_id, "recording cancellation") {
                    return;
                }
                // WinSTT terminal: stop_recording returned None (binding mismatch /
                // already stopped). Reset the renderer's armed pill so it doesn't
                // hang on isRecordingActive=true with no terminal event to clear it.
                crate::winstt::commands::dictation::SttEvents::no_audio_detected(&ah);
                utils::hide_recording_overlay(&ah);
                change_tray_icon(&ah, TrayIconState::Idle);
            }
        });

        debug!(
            "TranscribeAction::stop completed in {:?}",
            stop_time.elapsed()
        );
    }
}
