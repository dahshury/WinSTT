#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::apple_intelligence;
use crate::audio_feedback::{play_feedback_sound, play_feedback_sound_blocking, SoundType};
use crate::audio_toolkit::{is_microphone_access_denied, is_no_input_device_error};
use crate::managers::audio::AudioRecordingManager;
use crate::managers::history::HistoryManager;
use crate::managers::transcription::TranscriptionManager;
use crate::settings::{get_settings, AppSettings, APPLE_INTELLIGENCE_PROVIDER_ID};
use crate::shortcut;
use crate::tray::{change_tray_icon, TrayIconState};
use crate::utils::{
    self, show_processing_overlay, show_recording_overlay, show_transcribing_overlay,
};
use crate::TranscriptionCoordinator;
use ferrous_opencc::{config::BuiltinConfig, OpenCC};
use log::{debug, error, warn};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
struct RecordingErrorEvent {
    error_type: String,
    detail: Option<String>,
}

/// Single-slot memory of the most recent dictation transcription, read back by the
/// re-paste hotkey (`RepasteAction`). Ported from the reference's
/// `electron/lib/last-transcription.ts`: deliberately ONE slot (the shortcut's
/// contract is "paste the thing you just dictated"), not the full history store.
/// Set at the same point dictation auto-pastes the final text (`TranscribeAction::stop`).
static LAST_TRANSCRIPTION: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));

/// Remember `text` as the most recent transcription. Whitespace-only / empty input
/// is ignored so a "no audio detected" pass can't blank the slot — the user still
/// wants the previous real transcript re-pastable (mirrors `setLastTranscription`).
fn set_last_transcription(text: &str) {
    if text.trim().is_empty() {
        return;
    }
    if let Ok(mut slot) = LAST_TRANSCRIPTION.lock() {
        *slot = text.to_string();
    }
}

/// The last recorded transcription, or `""` when nothing has been dictated yet.
fn last_transcription() -> String {
    LAST_TRANSCRIPTION
        .lock()
        .map(|slot| slot.clone())
        .unwrap_or_default()
}

/// Drop guard that notifies the [`TranscriptionCoordinator`] when the
/// transcription pipeline finishes — whether it completes normally or panics.
struct FinishGuard(AppHandle);
impl Drop for FinishGuard {
    fn drop(&mut self) {
        if let Some(c) = self.0.try_state::<TranscriptionCoordinator>() {
            c.notify_processing_finished();
        }
    }
}

// Shortcut Action Trait
pub trait ShortcutAction: Send + Sync {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
}

// Transcribe Action
struct TranscribeAction {
    post_process: bool,
}

/// Field name for structured output JSON schema
const TRANSCRIPTION_FIELD: &str = "transcription";

/// Strip invisible Unicode characters that some LLMs may insert
fn strip_invisible_chars(s: &str) -> String {
    s.replace(['\u{200B}', '\u{200C}', '\u{200D}', '\u{FEFF}'], "")
}

/// Build a system prompt from the user's prompt template.
/// Removes `${output}` placeholder since the transcription is sent as the user message.
fn build_system_prompt(prompt_template: &str) -> String {
    prompt_template.replace("${output}", "").trim().to_string()
}

/// Telemetry captured while the LLM post-processes a transcription, surfaced in
/// the history footer (model + how long it took + generation speed). `model` is
/// the configured model id (the renderer derives the maker logo from it);
/// `completion_tokens` is `None` when the provider didn't report `usage`.
pub(crate) struct PostProcessMeta {
    pub model: String,
    pub duration_ms: i64,
    pub completion_tokens: Option<i64>,
}

async fn post_process_transcription(
    settings: &AppSettings,
    transcription: &str,
) -> Option<(String, PostProcessMeta)> {
    let provider = match settings.active_post_process_provider().cloned() {
        Some(provider) => provider,
        None => {
            debug!("Post-processing enabled but no provider is selected");
            return None;
        }
    };

    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    if model.trim().is_empty() {
        debug!(
            "Post-processing skipped because provider '{}' has no model configured",
            provider.id
        );
        return None;
    }

    let selected_prompt_id = match &settings.post_process_selected_prompt_id {
        Some(id) => id.clone(),
        None => {
            debug!("Post-processing skipped because no prompt is selected");
            return None;
        }
    };

    let prompt = match settings
        .post_process_prompts
        .iter()
        .find(|prompt| prompt.id == selected_prompt_id)
    {
        Some(prompt) => prompt.prompt.clone(),
        None => {
            debug!(
                "Post-processing skipped because prompt '{}' was not found",
                selected_prompt_id
            );
            return None;
        }
    };

    if prompt.trim().is_empty() {
        debug!("Post-processing skipped because the selected prompt is empty");
        return None;
    }

    debug!(
        "Starting LLM post-processing with provider '{}' (model: {})",
        provider.id, model
    );

    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    // Disable reasoning for providers where post-processing rarely benefits from it.
    // - custom: top-level reasoning_effort (works for local OpenAI-compat servers)
    // - openrouter: nested reasoning object; exclude:true also keeps reasoning text
    //   out of the response so it can't pollute structured-output JSON parsing
    let (reasoning_effort, reasoning) = match provider.id.as_str() {
        "custom" => (Some("none".to_string()), None),
        "openrouter" => (
            None,
            Some(crate::llm_client::ReasoningConfig {
                effort: Some("none".to_string()),
                exclude: Some(true),
            }),
        ),
        _ => (None, None),
    };

    // Wall-clock for the LLM round-trip — the footer's "processing time", and
    // the denominator for tokens/s. Started right before the request so it
    // excludes the (negligible) prompt assembly above.
    let started = Instant::now();
    let build_meta = |completion_tokens: Option<i64>| PostProcessMeta {
        model: model.clone(),
        duration_ms: started.elapsed().as_millis() as i64,
        completion_tokens,
    };

    if provider.supports_structured_output {
        debug!("Using structured outputs for provider '{}'", provider.id);

        let system_prompt = build_system_prompt(&prompt);
        let user_content = transcription.to_string();

        // Handle Apple Intelligence separately since it uses native Swift APIs
        if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            {
                if !apple_intelligence::check_apple_intelligence_availability() {
                    debug!(
                        "Apple Intelligence selected but not currently available on this device"
                    );
                    return None;
                }

                let token_limit = model.trim().parse::<i32>().unwrap_or(0);
                return match apple_intelligence::process_text_with_system_prompt(
                    &system_prompt,
                    &user_content,
                    token_limit,
                ) {
                    Ok(result) => {
                        if result.trim().is_empty() {
                            debug!("Apple Intelligence returned an empty response");
                            None
                        } else {
                            let result = strip_invisible_chars(&result);
                            debug!(
                                "Apple Intelligence post-processing succeeded. Output length: {} chars",
                                result.len()
                            );
                            // Apple Intelligence runs on-device via Swift APIs and
                            // exposes no token usage — report model + duration only.
                            Some((result, build_meta(None)))
                        }
                    }
                    Err(err) => {
                        error!("Apple Intelligence post-processing failed: {}", err);
                        None
                    }
                };
            }

            #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
            {
                debug!("Apple Intelligence provider selected on unsupported platform");
                return None;
            }
        }

        // Define JSON schema for transcription output
        let json_schema = serde_json::json!({
            "type": "object",
            "properties": {
                (TRANSCRIPTION_FIELD): {
                    "type": "string",
                    "description": "The cleaned and processed transcription text"
                }
            },
            "required": [TRANSCRIPTION_FIELD],
            "additionalProperties": false
        });

        match crate::llm_client::send_chat_completion_with_schema(
            &provider,
            api_key.clone(),
            &model,
            user_content,
            Some(system_prompt),
            Some(json_schema),
            reasoning_effort.clone(),
            reasoning.clone(),
        )
        .await
        {
            Ok((Some(content), tokens)) => {
                // Parse the JSON response to extract the transcription field
                match serde_json::from_str::<serde_json::Value>(&content) {
                    Ok(json) => {
                        if let Some(transcription_value) =
                            json.get(TRANSCRIPTION_FIELD).and_then(|t| t.as_str())
                        {
                            let result = strip_invisible_chars(transcription_value);
                            debug!(
                                "Structured output post-processing succeeded for provider '{}'. Output length: {} chars",
                                provider.id,
                                result.len()
                            );
                            return Some((result, build_meta(tokens)));
                        } else {
                            error!("Structured output response missing 'transcription' field");
                            return Some((strip_invisible_chars(&content), build_meta(tokens)));
                        }
                    }
                    Err(e) => {
                        error!(
                            "Failed to parse structured output JSON: {}. Returning raw content.",
                            e
                        );
                        return Some((strip_invisible_chars(&content), build_meta(tokens)));
                    }
                }
            }
            Ok((None, _)) => {
                error!("LLM API response has no content");
                return None;
            }
            Err(e) => {
                warn!(
                    "Structured output failed for provider '{}': {}. Falling back to legacy mode.",
                    provider.id, e
                );
                // Fall through to legacy mode below
            }
        }
    }

    // Legacy mode: Replace ${output} variable in the prompt with the actual text
    let processed_prompt = prompt.replace("${output}", transcription);
    debug!("Processed prompt length: {} chars", processed_prompt.len());

    match crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        processed_prompt,
        reasoning_effort,
        reasoning,
    )
    .await
    {
        Ok((Some(content), tokens)) => {
            let content = strip_invisible_chars(&content);
            debug!(
                "LLM post-processing succeeded for provider '{}'. Output length: {} chars",
                provider.id,
                content.len()
            );
            Some((content, build_meta(tokens)))
        }
        Ok((None, _)) => {
            error!("LLM API response has no content");
            None
        }
        Err(e) => {
            error!(
                "LLM post-processing failed for provider '{}': {}. Falling back to original transcription.",
                provider.id,
                e
            );
            None
        }
    }
}

async fn maybe_convert_chinese_variant(
    selected_language: &str,
    transcription: &str,
) -> Option<String> {
    // Check if language is set to Simplified or Traditional Chinese. The language is sourced
    // from WinsttSettings.model.language (the single language store) by the caller — AppSettings
    // .selected_language is no longer written by the WinSTT renderer, so reading it here would
    // mean this zh-variant conversion never fired.
    let is_simplified = selected_language == "zh-Hans";
    let is_traditional = selected_language == "zh-Hant";

    if !is_simplified && !is_traditional {
        debug!("language is not Simplified or Traditional Chinese; skipping translation");
        return None;
    }

    debug!(
        "Starting Chinese translation using OpenCC for language: {}",
        selected_language
    );

    // Use OpenCC to convert based on selected language
    let config = if is_simplified {
        // Convert Traditional Chinese to Simplified Chinese
        BuiltinConfig::Tw2sp
    } else {
        // Convert Simplified Chinese to Traditional Chinese
        BuiltinConfig::S2tw
    };

    match OpenCC::from_config(config) {
        Ok(converter) => {
            let converted = converter.convert(transcription);
            debug!(
                "OpenCC translation completed. Input length: {}, Output length: {}",
                transcription.len(),
                converted.len()
            );
            Some(converted)
        }
        Err(e) => {
            error!("Failed to initialize OpenCC converter: {}. Falling back to original transcription.", e);
            None
        }
    }
}

pub(crate) struct ProcessedTranscription {
    pub final_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
    /// JSON telemetry of the LLM pass (`{model, processingMs, tokens}`), or
    /// `None` when no LLM ran (raw transcript, Chinese-variant convert, or
    /// snippet-only expansion). Persisted to `transcription_history.llm_meta`
    /// and reshaped into the history footer's model/duration/speed chips.
    pub llm_meta: Option<String>,
}

pub(crate) async fn process_transcription_output(
    app: &AppHandle,
    transcription: &str,
    post_process: bool,
) -> ProcessedTranscription {
    let settings = get_settings(app);
    let mut final_text = transcription.to_string();
    let mut post_processed_text: Option<String> = None;
    let mut post_process_prompt: Option<String> = None;
    let mut llm_meta: Option<String> = None;

    // Source the language from the single store (WinsttSettings.model.language). AppSettings
    // .selected_language is no longer written by the renderer, so the zh-variant convert reads
    // the canonical picker value.
    let selected_language = crate::winstt::commands::settings::read_settings(app)
        .model
        .language;
    if let Some(converted_text) =
        maybe_convert_chinese_variant(&selected_language, transcription).await
    {
        final_text = converted_text;
    }

    if post_process {
        if let Some((processed_text, meta)) =
            post_process_transcription(&settings, &final_text).await
        {
            post_processed_text = Some(processed_text.clone());
            final_text = processed_text;
            // Stash the model/timing/tokens for the history footer. `tokens`
            // serializes to null when the provider reported no usage.
            llm_meta = serde_json::to_string(&serde_json::json!({
                "model": meta.model,
                "processingMs": meta.duration_ms,
                "tokens": meta.completion_tokens,
            }))
            .ok();

            if let Some(prompt_id) = &settings.post_process_selected_prompt_id {
                if let Some(prompt) = settings
                    .post_process_prompts
                    .iter()
                    .find(|prompt| &prompt.id == prompt_id)
                {
                    post_process_prompt = Some(prompt.prompt.clone());
                }
            }
        }
    } else if final_text != transcription {
        post_processed_text = Some(final_text.clone());
    }

    // WinSTT snippet expansion: deterministic fuzzy trigger→expansion on the finalized
    // text — the LAST step before paste (mirrors applyPostProcessing's replaceWithSnippets,
    // after dictionary correction). Uses the warm in-memory cache; no-op when no snippets.
    let expanded = crate::winstt::snippets::expand_cached(&final_text);
    if expanded != final_text {
        final_text = expanded;
        post_processed_text = Some(final_text.clone());
    }

    ProcessedTranscription {
        final_text,
        post_processed_text,
        post_process_prompt,
        llm_meta,
    }
}

impl ShortcutAction for TranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let start_time = Instant::now();
        debug!("TranscribeAction::start called for binding: {}", binding_id);

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
        change_tray_icon(app, TrayIconState::Recording);
        show_recording_overlay(app);

        // Get the microphone mode to determine audio feedback timing
        let settings = get_settings(app);
        let is_always_on = settings.always_on_microphone;
        debug!("Microphone mode - always_on: {}", is_always_on);

        let mut recording_error: Option<String> = None;
        if is_always_on {
            // Always-on mode: Play audio feedback immediately, then apply mute after sound finishes
            debug!("Always-on mode: Playing audio feedback immediately");
            let rm_clone = Arc::clone(&rm);
            let app_clone = app.clone();
            // The blocking helper exits immediately if audio feedback is disabled,
            // so we can always reuse this thread to ensure mute happens right after playback.
            std::thread::spawn(move || {
                play_feedback_sound_blocking(&app_clone, SoundType::Start);
                rm_clone.apply_mute();
            });

            if let Err(e) = rm.try_start_recording(&binding_id) {
                debug!("Recording failed: {}", e);
                recording_error = Some(e);
            }
        } else {
            // On-demand mode: Start recording first, then play audio feedback, then apply mute
            // This allows the microphone to be activated before playing the sound
            debug!("On-demand mode: Starting recording first, then audio feedback");
            let recording_start_time = Instant::now();
            match rm.try_start_recording(&binding_id) {
                Ok(()) => {
                    debug!("Recording started in {:?}", recording_start_time.elapsed());
                    // Small delay to ensure microphone stream is active
                    let app_clone = app.clone();
                    let rm_clone = Arc::clone(&rm);
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        debug!("Handling delayed audio feedback/mute sequence");
                        // Helper handles disabled audio feedback by returning early, so we reuse it
                        // to keep mute sequencing consistent in every mode.
                        play_feedback_sound_blocking(&app_clone, SoundType::Start);
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
            // NATIVE rodio (like Handy) instead of the old `app.emit("sound:play")` →
            // renderer Web Audio path: the webview chime hung off the main window's
            // AudioContext, which starts suspended (a global hotkey gives the page no
            // user gesture) and is throttled by WebView2 while the window sits hidden in
            // the tray — so the first chime after idle could lag/drop. Playing from Rust
            // removes the IPC→webview hop and both hazards. Self-gates on
            // `general.recording_sound` and fires on a worker thread (non-blocking).
            // Listen mode goes through loopback_manager (not this path), matching the
            // reference's "suppressed in listen mode".
            crate::winstt::commands::sound::play_recording_chime(app);
            // Dynamically register the cancel shortcut in a separate task to avoid deadlock
            shortcut::register_cancel_shortcut(app);
        } else {
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
                    "recording-error",
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
        // Unregister the cancel shortcut when transcription stops
        shortcut::unregister_cancel_shortcut(app);

        let stop_time = Instant::now();
        debug!("TranscribeAction::stop called for binding: {}", binding_id);

        let ah = app.clone();
        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
        let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());

        change_tray_icon(app, TrayIconState::Transcribing);
        show_transcribing_overlay(app);

        // WinSTT lifecycle: the recorder stopped (PTT release / toggle-off). The
        // renderer's useVisualizerSync (onRecordingStop) snaps the visualizer to
        // zero AND clears `isSpeaking`; the overlay pill stays armed until a terminal
        // event lands. isRecordingActive is held true across recording-stop so the
        // pill survives the "transcribing/thinking" transition (see useTranscriptionFeed).
        // No fake `vad-stop` here — the recorder emits a real one (Cmd::Stop →
        // speech_cb(false)) if speech was still open at release, and recordingStopped()
        // zeroes `isSpeaking` regardless.
        crate::winstt::commands::dictation::SttEvents::recording_stop(app);

        // Unmute before playing audio feedback so the stop sound is audible
        rm.remove_mute();

        // Play audio feedback for recording stop
        play_feedback_sound(app, SoundType::Stop);

        let binding_id = binding_id.to_string(); // Clone binding_id for the async task
        let post_process = self.post_process;
        // Snapshot the recording generation BEFORE `stop_recording` so the realtime-reuse check
        // matches the generation the realtime worker tagged its live decodes with. (Generation is
        // bumped only on the NEXT recording's start, so reading it here — recording still active —
        // yields the take being finalized; a racing re-press makes the cache generation mismatch,
        // which `try_reuse_realtime` safely rejects.)
        let generation = rm.recording_generation();

        tauri::async_runtime::spawn(async move {
            let _guard = FinishGuard(ah.clone());
            debug!(
                "Starting async transcription task for binding: {}",
                binding_id
            );

            let stop_recording_time = Instant::now();
            if let Some(samples) = rm.stop_recording(&binding_id) {
                debug!(
                    "Recording stopped and samples retrieved in {:?}, sample count: {}",
                    stop_recording_time.elapsed(),
                    samples.len()
                );

                if samples.is_empty() {
                    debug!("Recording produced no audio samples; skipping persistence");
                    // WinSTT terminal: nothing usable was captured. The renderer's
                    // useTranscriptionFeed (onNoAudioDetected) shows the ephemeral
                    // "(no audio detected)" pill and resets isRecordingActive.
                    crate::winstt::commands::dictation::SttEvents::no_audio_detected(&ah);
                    utils::hide_recording_overlay(&ah);
                    change_tray_icon(&ah, TrayIconState::Idle);
                } else {
                    // Save WAV concurrently with transcription
                    let sample_count = samples.len();
                    let file_name = format!("handy-{}.wav", chrono::Utc::now().timestamp());
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

                    // Transcribe concurrently with WAV save. The decode is a multi-second
                    // SYNC call (ONNX/GGML) — run it on the blocking pool so it never stalls
                    // a tokio worker thread (mirrors commands/history.rs). Flatten a task
                    // panic into the same `Result` shape the match below expects.
                    let transcription_time = Instant::now();
                    // FAST PATH: reuse the realtime worker's last full-buffer decode when the user
                    // has stopped talking — the live decode used the same engine on the same audio,
                    // so final == that decode + post-processing, and we skip a redundant re-decode.
                    // Falls back to a fresh decode when live transcription was off, the cache belongs
                    // to a different recording, the recording is silent, or speech continued past the
                    // last live decode (see TranscriptionManager::try_reuse_realtime).
                    let transcription_result = if let Some(reused) =
                        tm.try_reuse_realtime(generation, &samples)
                    {
                        debug!(
                            "Reused realtime decode for final transcription ({} chars)",
                            reused.len()
                        );
                        Ok(reused)
                    } else {
                        match tauri::async_runtime::spawn_blocking(move || tm.transcribe(samples))
                            .await
                        {
                            Ok(res) => res,
                            Err(e) => Err(anyhow::anyhow!("Transcription task panicked: {e}")),
                        }
                    };

                    // Await WAV save and verify
                    let wav_saved = match wav_handle.await {
                        Ok(Ok(())) => {
                            match crate::audio_toolkit::verify_wav_file(
                                &wav_path_for_verify,
                                sample_count,
                            ) {
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

                    match transcription_result {
                        Ok(transcription) => {
                            // Do NOT log the dictated text — it lands in the persistent
                            // file log. Log only timing + length (privacy).
                            debug!(
                                "Transcription completed in {:?}: {} chars",
                                transcription_time.elapsed(),
                                transcription.len()
                            );

                            if post_process {
                                show_processing_overlay(&ah);
                            }
                            let processed =
                                process_transcription_output(&ah, &transcription, post_process)
                                    .await;

                            // Keep the raw transcript for the preview pill's
                            // "original" (re-process source) — `save_entry`
                            // consumes `transcription` when a WAV was saved.
                            let original_transcript = transcription.clone();

                            // Save to history if WAV was saved
                            if wav_saved {
                                if let Err(err) = hm.save_entry(
                                    file_name,
                                    transcription,
                                    post_process,
                                    processed.post_processed_text.clone(),
                                    processed.post_process_prompt.clone(),
                                    processed.llm_meta.clone(),
                                ) {
                                    error!("Failed to save history entry: {}", err);
                                }
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

                                // Preview-before-pasting: when enabled AND the pill is
                                // shown, hold the auto-paste back and show the editable
                                // preview pill. Capture the foreground (paste target)
                                // NOW — while the user's app still owns the foreground
                                // (the overlay hasn't taken focus yet) — then grow the
                                // overlay + make it interactive and emit the raw +
                                // processed text. The paste fires later on
                                // `confirm_paste`; dismiss → `cancel_preview`.
                                let preview_enabled =
                                    crate::winstt::commands::settings::read_settings(&ah)
                                        .general
                                        .preview_before_pasting
                                        && crate::winstt::commands::overlay::overlay_is_active(&ah);
                                if preview_enabled {
                                    crate::winstt::commands::preview::capture_foreground(&ah);
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
                                    let ah_clone = ah.clone();
                                    let paste_time = Instant::now();
                                    let final_text = processed.final_text;
                                    ah.run_on_main_thread(move || {
                                        match utils::paste(final_text, ah_clone.clone()) {
                                            Ok(()) => debug!(
                                                "Text pasted successfully in {:?}",
                                                paste_time.elapsed()
                                            ),
                                            Err(e) => {
                                                error!("Failed to paste transcription: {}", e);
                                                let _ = ah_clone.emit("paste-error", ());
                                            }
                                        }
                                        utils::hide_recording_overlay(&ah_clone);
                                        change_tray_icon(&ah_clone, TrayIconState::Idle);
                                    })
                                    .unwrap_or_else(|e| {
                                        error!("Failed to run paste on main thread: {:?}", e);
                                        utils::hide_recording_overlay(&ah);
                                        change_tray_icon(&ah, TrayIconState::Idle);
                                    });
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
                            crate::winstt::commands::dictation::SttEvents::transcription_failed(
                                &ah,
                            );
                            // Save entry with empty text so user can retry
                            if wav_saved {
                                if let Err(save_err) = hm.save_entry(
                                    file_name,
                                    String::new(),
                                    post_process,
                                    None,
                                    None,
                                    None,
                                ) {
                                    error!("Failed to save failed history entry: {}", save_err);
                                }
                            }
                            utils::hide_recording_overlay(&ah);
                            change_tray_icon(&ah, TrayIconState::Idle);
                        }
                    }
                }
            } else {
                debug!("No samples retrieved from recording stop");
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

// Cancel Action
struct CancelAction;

impl ShortcutAction for CancelAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        utils::cancel_current_operation(app);
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Nothing to do on stop for cancel
    }
}

// Transform Action (WinSTT transforms.hotkey, default LCtrl+LShift+T): capture selection ->
// transform over the configured provider -> paste-replace -> emit transforms:applied.
struct TransformAction;

impl ShortcutAction for TransformAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Single-shot on press. run_transform_pipeline does its own enabled-gate + failure
        // events and never errors past its boundary; spawn so the shortcut thread isn't
        // blocked by the LLM round-trip.
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = crate::winstt::commands::transforms::run_transform_pipeline(&app).await;
        });
    }
    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {}
}

// Re-paste Action (WinSTT general.repasteHotkey, default LCtrl+LShift+V): re-inject
// the most recent dictation transcription without re-dictating. handy-keys registers
// the combo with blocking, so the accelerator is consumed system-wide (the reference's
// "exclusive" globalShortcut semantics) — pressing it ONLY re-pastes, it does not also
// trigger the focused app's native binding for the same combo. Mirrors
// electron/ipc/repaste-hotkey.ts.
struct RepasteAction;

impl ShortcutAction for RepasteAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        let text = last_transcription();
        if text.trim().is_empty() {
            debug!("RepasteAction: no transcription recorded yet — ignoring");
            return;
        }
        // This hotkey fires on key-DOWN while the user is STILL holding the combo
        // (LCtrl+LShift+V), and must paste the WHOLE block immediately — exactly like a
        // manual Ctrl+V — without waiting for release. A naive synthetic Ctrl+V can't do
        // that here: handy-keys' blocking hook (which doesn't filter injected events) sees
        // the synthetic `V` re-match the still-held Ctrl+Shift+V and SWALLOWS it, and the
        // held Shift would turn Ctrl+V into Ctrl+Shift+V. Fix (the standard clipboard-paste
        // dance, à la Espanso): inject key-UPs to release the held modifiers first — now
        // the combo no longer matches (so handy lets the synthetic `V` through) and the
        // paste reaches the app as a clean Ctrl+V. Then run the normal clipboard paste, so
        // the text drops in as ONE block via the user's configured paste method.
        // Run on a worker (off the hotkey/manager thread): Windows input synthesis +
        // clipboard are thread-safe, and pasting here avoids the idle-event-loop latency a
        // `run_on_main_thread` hop adds when no overlay is animating to pump the loop.
        let app = app.clone();
        std::thread::spawn(move || {
            #[cfg(target_os = "windows")]
            {
                crate::input::release_held_modifiers();
                // Let the foreground app process the modifier key-ups before the paste.
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            debug!(
                "RepasteAction: re-pasting last transcription ({} chars)",
                text.len()
            );
            // `replace=false` = the dictation paste variant (clipboard sandwich +
            // configured paste method + append_trailing_space + auto-submit), so a
            // re-paste is indistinguishable from the original dictation paste.
            #[cfg(target_os = "macos")]
            let result = crate::clipboard::paste_on_main_thread(&app, text, false);
            #[cfg(not(target_os = "macos"))]
            let result = crate::clipboard::paste(text, app.clone());
            if let Err(e) = result {
                error!("RepasteAction: paste failed: {e}");
            }
        });
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {}
}

// Read-Aloud Action (WinSTT tts.hotkey, default LMeta+LShift+E): capture the active
// selection and read it aloud through the source-aware TTS pipeline (local Kokoro /
// cloud ElevenLabs). Single-shot on press. Mirrors electron/ipc/tts-hotkey.ts.
struct ReadAloudAction;

impl ShortcutAction for ReadAloudAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Gate on tts.enabled BEFORE capturing the selection — selection capture can
        // fall back to a synthetic Ctrl+C (clipboard sandwich), which we must not fire
        // when TTS is off (mirrors tts-hotkey.ts `maybeFire` checking `isTtsEnabled`).
        let enabled = crate::winstt::commands::settings::read_settings(app)
            .tts
            .enabled;
        if !enabled {
            debug!("ReadAloudAction: TTS disabled — ignoring");
            return;
        }
        let app = app.clone();
        // Selection capture + blocking synthesis run off the hotkey thread.
        std::thread::spawn(move || {
            let text = crate::winstt::commands::transforms::capture_selection_text(&app);
            if text.trim().is_empty() {
                debug!("ReadAloudAction: no selection captured");
                let _ = app.emit(
                    "tts:failed",
                    serde_json::json!({ "requestId": "", "reason": "No text selected" }),
                );
                return;
            }
            let Some(tts) = app.try_state::<Arc<crate::winstt::managers::TtsManager>>() else {
                return;
            };
            let mgr = tts.inner().clone();
            let rid = mgr.next_request_id();
            // Empty voice/lang → the manager fills them from the active source's
            // settings (same as the `tts_speak_selection` command path). Speed is
            // sampled per sentence so a mid-read change applies to the next one.
            let speed_mgr = mgr.clone();
            mgr.read_aloud(&rid, &text, "", "", move || speed_mgr.current_speed());
        });
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {}
}

// Test Action
struct TestAction;

impl ShortcutAction for TestAction {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Started - {} (App: {})", // Changed "Pressed" to "Started" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Stopped - {} (App: {})", // Changed "Released" to "Stopped" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }
}

// Static Action Map
pub static ACTION_MAP: Lazy<HashMap<String, Arc<dyn ShortcutAction>>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "transcribe".to_string(),
        Arc::new(TranscribeAction {
            post_process: false,
        }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "transcribe_with_post_process".to_string(),
        Arc::new(TranscribeAction { post_process: true }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "cancel".to_string(),
        Arc::new(CancelAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "test".to_string(),
        Arc::new(TestAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "transforms".to_string(),
        Arc::new(TransformAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "repaste".to_string(),
        Arc::new(RepasteAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "read_aloud".to_string(),
        Arc::new(ReadAloudAction) as Arc<dyn ShortcutAction>,
    );
    map
});

/// Start one dictation cycle from a wakeword hit. A wake-word detection acts exactly like a
/// toggle-press of the transcribe action: it begins a recording cycle that the recorder's
/// silence-endpoint stops. Bound to the `wake_word_detected` event in `initialize_core_logic`.
pub fn start_dictation_from_wakeword(app: &AppHandle) {
    if let Some(coord) = app.try_state::<crate::TranscriptionCoordinator>() {
        coord.send_input("transcribe", "", true, false);
        schedule_wakeword_followup_timeout(app);
    } else {
        crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(app);
    }
}

fn schedule_wakeword_followup_timeout(app: &AppHandle) {
    let settings = crate::winstt::commands::settings::read_settings_raw(app);
    let raw_seconds = settings.general.wake_word_timeout;
    let seconds = if raw_seconds.is_finite() {
        raw_seconds
    } else {
        5.0
    }
    .clamp(1.0, 30.0);
    let timeout = Duration::from_millis((seconds * 1000.0).round() as u64);
    let app = app.clone();

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        let Some(audio) = app.try_state::<Arc<AudioRecordingManager>>() else {
            return;
        };
        if !audio.is_recording() {
            crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(&app);
            return;
        }
        let recording_generation = audio.recording_generation();
        drop(audio);

        std::thread::sleep(timeout);
        let Some(audio) = app.try_state::<Arc<AudioRecordingManager>>() else {
            return;
        };
        if audio.is_recording()
            && audio.recording_generation() == recording_generation
            && !audio.speech_seen_since_recording_start()
        {
            if let Some(coord) = app.try_state::<crate::TranscriptionCoordinator>() {
                coord.request_silence_stop("transcribe", recording_generation);
            }
        }
    });
}
