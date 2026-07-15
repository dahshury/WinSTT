use crate::audio_toolkit::{CapturedAudio, is_microphone_access_denied, is_no_input_device_error};
use crate::managers::audio::AudioRecordingManager;
use crate::managers::history::HistoryManager;
use crate::managers::transcription::{TranscriptionManager, is_silent_recording_with_mask};
use crate::shortcut;
use crate::tray::{TrayIconState, change_tray_icon};
use crate::utils::{self, show_recording_overlay};
use log::{debug, error, warn};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::Manager;
use tauri::{AppHandle, Emitter};

use super::post_process::{
    PostProcessingSkipGuard, process_transcription_output, should_run_winstt_dictation_llm_from_app,
};
use super::{
    FinishGuard, RecordingErrorEvent, ShortcutAction, cancelled_session_cleanup,
    set_last_transcription,
};

const AUDIO_SAMPLE_RATE: usize = 16_000;
const SLOW_RECORDING_STOP_MS: u128 = 500;
const SLOW_HISTORY_AUDIO_PERSIST_MS: u128 = 2_000;

fn samples_to_ms(samples: usize) -> u64 {
    ((samples as u128 * 1000) / AUDIO_SAMPLE_RATE as u128) as u64
}

/// How long the transient "offline, no local model" overlay pill stays up before the window is
/// torn back down. Matches the renderer-side auto-dismiss so the two stay roughly aligned.
const OFFLINE_NOTICE_HIDE_MS: u64 = 4_000;

/// Hide the recording overlay a few seconds after showing an offline-notice pill from the
/// record-start pre-gate (no recording ran, so nothing else will tear it down). A no-op when the
/// overlay was never shown (disabled), since `hide_recording_overlay` on a hidden window is inert.
fn schedule_offline_notice_hide(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(OFFLINE_NOTICE_HIDE_MS));
        utils::hide_recording_overlay(&app);
    });
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
    llm_meta: Option<String>,
    dictionary_fixes: Option<i64>,
    history_tag: Option<String>,
    privacy_markers_json: Option<String>,
    stt_model: Option<String>,
    stt_processing_ms: Option<i64>,
    stt_cost: Option<crate::winstt::managers::CloudSttRunCost>,
) {
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        debug!(
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
            .record_without_log(Some(&app));
        }

        if !wav_saved {
            return;
        }

        if let Err(err) = hm.save_entry(
            file_name,
            transcription_text,
            post_process_requested,
            post_processed_text,
            // post_process_prompt: legacy history column — the prompt-template
            // path was removed; the row stays NULL for new entries.
            None,
            llm_meta,
            dictionary_fixes,
            history_tag,
            privacy_markers_json,
            stt_model,
            stt_processing_ms,
            stt_cost.as_ref().map(|c| c.cost_usd),
            stt_cost.as_ref().is_some_and(|c| c.cost_is_estimate),
        ) {
            error!("Failed to save history entry: {}", err);
        }
    });
}

// Transcribe Action
pub(super) struct TranscribeAction;

impl ShortcutAction for TranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let start_time = Instant::now();
        debug!("TranscribeAction::start called for binding: {}", binding_id);
        if crate::winstt::commands::onboarding::is_onboarding_active() {
            debug!("TranscribeAction::start ignored while onboarding is active");
            return;
        }

        // Pin the foreground window NOW — before any overlay/tray work below can
        // steal focus — so the LLM context capture (which runs only after the
        // decode finishes) reads the window the user is dictating INTO, not
        // wherever they alt-tabbed to during transcription (report R5b). All
        // recording modes (PTT / toggle / wake-word) reach this start endpoint, so
        // pinning here covers every mode. The pin is re-validated at capture time
        // and superseded by the next start.
        let pinned_hwnd = super::pinned_foreground::pin();
        super::app_profile::resolve_at_start(app, pinned_hwnd);

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

        // Get the microphone mode to determine audio feedback timing.
        let settings = crate::winstt::commands::settings::read_settings_raw(app);
        let is_always_on = matches!(
            crate::managers::audio::microphone_mode_from_settings(&settings),
            crate::managers::audio::MicrophoneMode::AlwaysOn
        );
        debug!("Microphone mode - always_on: {}", is_always_on);

        // ── Offline pre-gate ──────────────────────────────────────────────
        // If the selected STT model is a CLOUD model, its provider is currently believed offline
        // (a prior network failure armed the connectivity watch), AND no local model is cached to
        // fall back to, then nothing this recording could produce a transcript — the user "insists
        // on cloud" with no internet and no local model. Skip the doomed capture: no recording, no
        // misleading start chime. Surface an offline error in the overlay when it is enabled;
        // `show_recording_overlay` self-gates to a no-op when the overlay is disabled, so in that
        // case the suppressed chime IS the (only) signal — exactly the requested behavior.
        let selected_model = crate::winstt::catalog::canonical_model_id(&settings.model.model);
        if let Some(provider) = crate::winstt::cloud_stt::provider_of(selected_model)
            && crate::winstt::cloud_stt::provider_appears_offline(provider)
            && crate::winstt::stt::fallback::resolve_local_stt_fallback(app).is_none()
        {
            warn!(
                "STT cloud provider '{}' offline and no local model cached; skipping capture",
                provider.id()
            );
            crate::transcription_coordinator::finish_dictation_session(session_id);
            super::pinned_foreground::clear();
            super::app_profile::clear();
            utils::unregister_cancel_shortcut_if_idle(app);
            show_recording_overlay(app);
            crate::winstt::stt::fallback::emit_stt_pipeline_unavailable(
                app,
                "offline_no_local",
                Some(provider.id()),
            );
            // Tear the (possibly shown) overlay back down after the transient error pill has
            // had time to display, so a subsequent successful recording starts clean.
            schedule_offline_notice_hide(app);
            return;
        }

        // Open the microphone CONCURRENTLY with the UI work below. In on-demand mode the
        // cpal/WASAPI stream open is the slowest step of `start` (tens of ms, device
        // dependent) and every millisecond it runs serialized is dictated speech lost
        // before capture begins. The UI work (cancel shortcut, TTS pause, tray icon,
        // overlay show) is independent of the recorder, so it runs while the device opens;
        // the join below restores the original sequencing guarantee (`start` returns with
        // the recorder either running or errored, which the coordinator's Stage machine
        // relies on).
        let mic_thread = {
            let rm = Arc::clone(&rm);
            std::thread::spawn(move || -> Result<(), String> {
                if is_always_on {
                    // Always-on mode: the mic stream is already open, so mute can apply
                    // immediately. The start chime is the winstt recording sound played
                    // below (duck_then_play_recording_chime) — it routes to the OUTPUT
                    // device and is independent of the INPUT mute applied here.
                    debug!("Always-on mode: applying mute");
                    rm.apply_mute();
                } else {
                    // On-demand mode: start recording first (stream open below), then the
                    // caller applies mute once the mic stream is active. The start chime
                    // (winstt recording sound) plays on the output device, so muting the
                    // input does not silence it.
                    debug!("On-demand mode: starting recording first, then muting input");
                }
                let recording_start_time = Instant::now();
                let result = rm.try_start_recording(&binding_id);
                if result.is_ok() {
                    debug!("Recording started in {:?}", recording_start_time.elapsed());
                }
                result
            })
        };

        shortcut::register_cancel_shortcut(app);
        crate::winstt::commands::tts::request_tts_playback_pause_for_dictation(app);
        change_tray_icon(app, TrayIconState::Recording);
        show_recording_overlay(app);

        let recording_error: Option<String> = match mic_thread.join() {
            Ok(Ok(())) => {
                if !is_always_on {
                    // Small delay to ensure microphone stream is active before mute.
                    let rm_clone = Arc::clone(&rm);
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        debug!("Applying delayed input mute");
                        rm_clone.apply_mute();
                    });
                }
                None
            }
            Ok(Err(e)) => {
                debug!("Recording failed: {}", e);
                Some(e)
            }
            Err(panic) => {
                // A panicking device open must not take down the coordinator thread —
                // contain it here and surface it like any other recording failure.
                error!("Microphone open thread panicked: {panic:?}");
                Some("microphone open panicked".to_string())
            }
        };

        if recording_error.is_none() {
            if crate::transcription_coordinator::is_dictation_session_cancelled(session_id) {
                rm.cancel_recording();
                super::pinned_foreground::clear();
                super::app_profile::clear();
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
            // The start chime is NOT played here. It fires from the recorder's
            // capture-live callback (managers::audio::create_audio_recorder) on the FIRST
            // captured frame: a cold on-demand stream delivers nothing for up to ~1 s
            // after the press, and a chime at press invites speech into a mic that is not
            // capturing yet — those words are physically unrecoverable. The callback is
            // the mic-is-live ground truth, so the chime doubles as the honest "speak
            // now" signal in every mode (warm streams reach it within one device period).
        } else {
            crate::transcription_coordinator::finish_dictation_session(session_id);
            // The recorder never opened, so no context will be captured for this
            // attempt — drop the pin taken above rather than leaving it to be
            // re-validated (and superseded) later.
            super::pinned_foreground::clear();
            super::app_profile::clear();
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

        let binding_id = binding_id.to_string(); // Clone binding_id for the async task
        let session_id = crate::transcription_coordinator::current_dictation_session();
        // Snapshot the recording generation BEFORE `stop_recording` so the realtime-reuse check
        // matches the generation the realtime worker tagged its live decodes with. (Generation is
        // bumped only on the NEXT recording's start, so reading it here — recording still active —
        // yields the take being finalized; a racing re-press makes the cache generation mismatch,
        // which `try_reuse_realtime` safely rejects.)
        let generation = rm.recording_generation();

        let stop_recording_time = Instant::now();
        debug!("[stt-ui] recorder_stop_start binding_id='{binding_id}' generation={generation}");
        let stopped_capture = rm.stop_recording(&binding_id);
        let stop_recording_elapsed = stop_recording_time.elapsed();
        let stopped_sample_count = stopped_capture.as_ref().map_or(0, |c| c.samples.len());
        debug!(
            "[stt-ui] recorder_stop_complete binding_id='{binding_id}' duration_ms={} result={} samples={} audio_ms={}",
            stop_recording_elapsed.as_millis(),
            if stopped_capture.is_some() {
                "samples"
            } else {
                "none"
            },
            stopped_sample_count,
            samples_to_ms(stopped_sample_count)
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
            .context("samples", stopped_sample_count.to_string())
            .context("audioMs", samples_to_ms(stopped_sample_count).to_string())
            .record(Some(app));
        }

        change_tray_icon(app, TrayIconState::Transcribing);

        // WinSTT lifecycle: the recorder has stopped (PTT release / toggle-off). The
        // renderer snaps the visualizer to zero and holds the pill until a terminal event.
        crate::winstt::commands::dictation::SttEvents::recording_stop(app);

        // Restore the input mute applied at recording start. There is no stop chime to gate.
        rm.remove_mute();

        tauri::async_runtime::spawn(async move {
            let _guard = FinishGuard {
                app: ah.clone(),
                session_id,
            };
            debug!(
                "Starting async transcription task for binding: {}",
                binding_id
            );

            if let Some(CapturedAudio {
                samples,
                speech_mask,
            }) = stopped_capture
            {
                debug!(
                    "Recording samples handed to async transcription task, sample count: {} mask_frames: {}",
                    samples.len(),
                    speech_mask.len()
                );

                if cancelled_session_cleanup(&ah, session_id, "recording stop") {
                    return;
                }

                if is_silent_recording_with_mask(&samples, Some(&speech_mask)) {
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
                    // Save WAV concurrently with transcription. The captured buffer is
                    // SHARED (Arc) between the WAV task and the decode task — a minute of
                    // 16 kHz f32 audio is ~3.8 MB, and the previous deep clone here was
                    // pure memcpy on the hot path for zero benefit (both consumers only
                    // read).
                    let samples = Arc::new(samples);
                    let speech_mask = Arc::new(speech_mask);
                    let sample_count = samples.len();
                    // History master switch, read ONCE per dictation so the WAV
                    // write and the DB row always agree (no orphan recordings if
                    // the user flips the toggle mid-transcription).
                    let history_enabled = crate::winstt::settings_store::read_settings_raw(&ah)
                        .general
                        .history_enabled;
                    let file_name = format!("winstt-{}.wav", chrono::Utc::now().timestamp());
                    let wav_path = hm.recordings_dir().join(&file_name);
                    let wav_path_for_verify = wav_path.clone();
                    let samples_for_wav = Arc::clone(&samples);
                    let wav_handle = tauri::async_runtime::spawn_blocking(move || {
                        if !history_enabled {
                            return Ok(());
                        }
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
                    let samples_for_decode = Arc::clone(&samples);
                    let mask_for_decode = Arc::clone(&speech_mask);
                    let transcription_result =
                        match tauri::async_runtime::spawn_blocking(move || {
                            let mask = Some(mask_for_decode.as_slice());
                            if preview_requested {
                                debug!(
                                    "Preview-before-pasting active; skipping realtime reuse for batch final transcript"
                                );
                                tm_for_decode.clear_realtime_reuse();
                                return (
                                    false,
                                    tm_for_decode.transcribe_with_mask(&samples_for_decode, mask),
                                );
                            }

                            if let Some(reused) = tm_for_decode.try_reuse_realtime(
                                generation,
                                &samples_for_decode,
                                mask,
                            ) {
                                (true, Ok(reused))
                            } else {
                                (
                                    false,
                                    tm_for_decode.transcribe_with_mask(&samples_for_decode, mask),
                                )
                            }
                        })
                        .await
                        {
                            Ok((reused_realtime, result)) => {
                                if reused_realtime && let Ok(text) = &result {
                                    debug!(
                                        "Reused finalized realtime stream for final transcription ({} chars)",
                                        text.len()
                                    );
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
                            let stt_processing_ms = transcription_time
                                .elapsed()
                                .as_millis()
                                .max(1)
                                .min(i64::MAX as u128)
                                as i64;
                            // Do NOT log the dictated text — it lands in the persistent
                            // file log. Log only timing + length (privacy).
                            debug!(
                                "Transcription completed in {}ms: {} chars",
                                stt_processing_ms,
                                transcription.len()
                            );

                            let will_run_post_stt_llm =
                                should_run_winstt_dictation_llm_from_app(&ah);
                            if will_run_post_stt_llm {
                                show_recording_overlay(&ah);
                            }
                            if cancelled_session_cleanup(&ah, session_id, "post-processing start") {
                                return;
                            }
                            let skip_guard = will_run_post_stt_llm
                                .then(|| PostProcessingSkipGuard::new(&ah, session_id));
                            let post_process_started = Instant::now();
                            debug!(
                                "[stt-ui] post_process_start session_id={session_id} raw_chars={}",
                                transcription.chars().count()
                            );
                            let processed =
                                process_transcription_output(&ah, &transcription, session_id).await;
                            drop(skip_guard);
                            debug!(
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
                            // Cloud decodes record their billed cost on the CloudSttManager
                            // as they complete; local decodes leave it empty. Take it
                            // unconditionally so a stale value can never leak into a
                            // later local run's row.
                            let stt_cost = ah
                                .try_state::<Arc<crate::winstt::managers::CloudSttManager>>()
                                .and_then(|cloud| cloud.take_last_run_cost());
                            if history_enabled {
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
                                    processed.llm_meta.clone(),
                                    processed.dictionary_fixes,
                                    processed.history_tag.clone(),
                                    privacy_markers_json,
                                    // Stamp the row with whichever STT ("main") model is loaded.
                                    tm.get_current_model(),
                                    Some(stt_processing_ms),
                                    stt_cost,
                                );
                            } else {
                                debug!("History disabled; skipping WAV + history persistence");
                            }

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
                                        debug!(
                                            "[stt-ui] paste_start target=main_thread chars={paste_chars}"
                                        );
                                        match utils::paste(final_text, ah_clone.clone()) {
                                            Ok(()) => debug!(
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
                                                // Settle only when a modifier key-up was
                                                // actually injected; the common toggle-mode
                                                // paste (nothing held) skips the 15ms wait.
                                                if crate::input::release_held_modifiers() {
                                                    std::thread::sleep(
                                                        std::time::Duration::from_millis(15),
                                                    );
                                                }
                                            }

                                            let paste_time = Instant::now();
                                            debug!(
                                                "[stt-ui] paste_start target=worker chars={paste_chars}"
                                            );
                                            match utils::paste(final_text, ah_clone.clone()) {
                                                Ok(()) => debug!(
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
                            let stt_processing_ms = transcription_time
                                .elapsed()
                                .as_millis()
                                .max(1)
                                .min(i64::MAX as u128)
                                as i64;
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
                            if history_enabled {
                                persist_history_after_wav(
                                    ah.clone(),
                                    Arc::clone(&hm),
                                    wav_handle,
                                    wav_path_for_verify,
                                    sample_count,
                                    file_name,
                                    String::new(),
                                    false,
                                    None,
                                    None,
                                    None,
                                    None,
                                    None,
                                    // Record the model that was active when the decode failed
                                    // (may be None if it unloaded).
                                    tm.get_current_model(),
                                    Some(stt_processing_ms),
                                    // A failed decode billed nothing; clear any prior
                                    // cloud cost so it can't leak into a later row.
                                    {
                                        if let Some(cloud) = ah.try_state::<Arc<
                                            crate::winstt::managers::CloudSttManager,
                                        >>() {
                                            let _ = cloud.take_last_run_cost();
                                        }
                                        None
                                    },
                                );
                            }
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
