use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::managers::audio::AudioRecordingManager;
use crate::managers::history::HistoryManager;
use crate::managers::transcription::TranscriptionManager;

pub(crate) struct CoreManagers {
    pub(crate) recording: Arc<AudioRecordingManager>,
    pub(crate) transcription: Arc<TranscriptionManager>,
    history: Arc<HistoryManager>,
}

pub(crate) fn construct_core_managers(app_handle: &AppHandle) -> Result<CoreManagers, String> {
    let recording = Arc::new(
        AudioRecordingManager::new(app_handle)
            .map_err(|err| format!("failed to initialize recording manager: {err}"))?,
    );
    let transcription = Arc::new(
        TranscriptionManager::new(app_handle)
            .map_err(|err| format!("failed to initialize transcription manager: {err}"))?,
    );
    let history = Arc::new(
        HistoryManager::new(app_handle)
            .map_err(|err| format!("failed to initialize history manager: {err}"))?,
    );

    Ok(CoreManagers {
        recording,
        transcription,
        history,
    })
}

pub(crate) fn register_core_managers(app_handle: &AppHandle, managers: &CoreManagers) {
    app_handle.manage(managers.recording.clone());
    app_handle.manage(managers.transcription.clone());
    app_handle.manage(managers.history.clone());
}

pub(crate) fn register_winstt_managers(app_handle: &AppHandle, managers: &CoreManagers) {
    use crate::winstt::managers::{
        ollama_manager, CloudSttManager, ContextManager, DiarizationManager, DownloadManager,
        FileTranscribeManager, LlmManager, LoopbackManager, RealtimeManager, TtsManager,
        WakeWordManager, WordAligner,
    };

    app_handle.manage(Arc::new(LlmManager::new(app_handle)));
    // Resolve the SAME `Arc<OllamaManager>` the context-free pull-cancel / warmup-status
    // free functions reach via the process-global handle, so managed state and the global
    // are one instance (must register before `start_warmup_loop`, which publishes status).
    app_handle.manage(ollama_manager::global());
    app_handle.manage(Arc::new(CloudSttManager::new(app_handle)));
    app_handle.manage(Arc::new(ContextManager::new(app_handle)));

    let tts_manager = Arc::new(TtsManager::new(app_handle));
    tts_manager.start_idle_watcher();
    app_handle.manage(tts_manager);

    app_handle.manage(Arc::new(WakeWordManager::new(app_handle)));
    app_handle.manage(Arc::new(DiarizationManager::new(app_handle)));
    app_handle.manage(Arc::new(LoopbackManager::new(
        app_handle,
        managers.transcription.clone(),
    )));
    app_handle.manage(Arc::new(crate::winstt::snippets::SnippetsManager::new(
        app_handle,
    )));
    app_handle.manage(Arc::new(WordAligner::new(app_handle)));
    app_handle.manage(Arc::new(FileTranscribeManager::new(
        app_handle,
        managers.transcription.clone(),
    )));
    app_handle.manage(Arc::new(DownloadManager::new(app_handle)));
    app_handle.manage(Arc::new(
        crate::winstt::managers::tts_download_manager::TtsDownloadManager::new(app_handle),
    ));
    app_handle.manage(Arc::new(
        crate::winstt::encoder_dict::download::EncoderModelDownloader::new(app_handle),
    ));

    let realtime_manager = Arc::new(RealtimeManager::new(
        app_handle.clone(),
        managers.transcription.clone(),
        managers.recording.clone(),
    ));
    realtime_manager.start();
    app_handle.manage(realtime_manager);
}

pub(crate) fn schedule_vad_preload(app_handle: &AppHandle, recording: Arc<AudioRecordingManager>) {
    let profile_vad = crate::startup_profile_enabled();
    let app_for_vad = app_handle.clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        if let Err(e) = recording.preload_vad() {
            log::debug!("Startup VAD pre-load failed: {e}");
            crate::winstt::observability::IssueBuilder::new(
                "startup",
                "vad_preload",
                "Startup VAD preload failed",
            )
            .detail(e.to_string())
            .user_visible(false)
            .record(Some(&app_for_vad));
        }
        if profile_vad {
            log::info!(
                "[startup] VAD preload thread completed: {} ms",
                started.elapsed().as_millis()
            );
        }
    });
}

pub(crate) fn activate_interactive_runtime(app_handle: &AppHandle) {
    crate::shortcut::init_shortcuts(app_handle);

    #[cfg(not(target_os = "macos"))]
    if app_handle.try_state::<crate::input::EnigoState>().is_none() {
        match crate::input::EnigoState::new() {
            Ok(enigo_state) => {
                app_handle.manage(enigo_state);
                log::info!("Enigo initialized (paste pipeline ready)");
            }
            Err(e) => log::warn!("Enigo init failed: {e}"),
        }
    }

    crate::shortcut::reconcile_winstt_hotkeys(app_handle);
}

pub(crate) fn activate_runtime_after_onboarding(app_handle: &AppHandle) {
    activate_interactive_runtime(app_handle);

    if let Some(audio) = app_handle.try_state::<Arc<AudioRecordingManager>>() {
        if let Err(err) = audio.inner().sync_microphone_mode_from_settings() {
            log::warn!("[onboarding] failed to sync microphone policy after finish: {err}");
        }
        schedule_vad_preload(app_handle, audio.inner().clone());
    }

    warm_models_after_onboarding(app_handle);
}

pub(crate) fn deactivate_runtime_for_onboarding(app_handle: &AppHandle) {
    crate::winstt::commands::onboarding::set_onboarding_active(true);
    crate::shortcut::disarm_all_shortcuts(app_handle);
    crate::winstt::commands::settings::disarm_wakeword_runtime_for_onboarding(app_handle);

    if let Some(audio) = app_handle.try_state::<Arc<AudioRecordingManager>>() {
        audio.inner().cancel_recording();
        audio.inner().stop_microphone_stream();
    }

    if let (Some(loopback), Some(diarization)) = (
        app_handle.try_state::<Arc<crate::winstt::managers::LoopbackManager>>(),
        app_handle.try_state::<Arc<crate::winstt::managers::DiarizationManager>>(),
    ) {
        crate::winstt::commands::listen::stop_listen_runtime(
            app_handle,
            loopback.inner().as_ref(),
            diarization.inner().as_ref(),
        );
    }

    if let Some(transcription) =
        app_handle.try_state::<Arc<crate::managers::transcription::TranscriptionManager>>()
    {
        if transcription.inner().is_model_loaded() {
            let tm = Arc::clone(transcription.inner());
            std::thread::spawn(move || {
                if let Err(err) = tm.unload_model() {
                    log::warn!("[onboarding] failed to unload STT model: {err}");
                }
            });
        }
    }
}

/// Run the model warmups that were deferred while the first-run wizard was open.
/// Called from `onboarding_finish` once the gate (`onboarding::is_onboarding_active`)
/// is lifted: load + warm the STT model the user just configured (a cloud id frees
/// any resident local engine and needs no local load; a local id loads + warms the
/// engine), kick off the TTS/encoder/LLM background warmups, and arm wakeword if
/// that is the saved recording mode. All off the command thread so the wizard →
/// main window transition isn't blocked on a cold model load.
pub(crate) fn warm_models_after_onboarding(app_handle: &AppHandle) {
    if let Some(transcription) =
        app_handle.try_state::<Arc<crate::managers::transcription::TranscriptionManager>>()
    {
        let tm = Arc::clone(transcription.inner());
        let app_for_warm = app_handle.clone();
        std::thread::spawn(move || {
            tm.initiate_model_load();
            tm.warmup();
            schedule_winstt_background_warmups(&app_for_warm);
        });
    } else {
        schedule_winstt_background_warmups(app_handle);
    }
    crate::winstt::commands::settings::sync_wakeword_runtime_from_settings_in_background(
        app_handle,
    );
}

pub(crate) fn schedule_winstt_background_warmups(app_handle: &AppHandle) {
    use crate::winstt::managers::LlmManager;

    let settings = crate::winstt::commands::settings::read_settings_raw(app_handle);
    if crate::winstt::commands::settings::should_warm_tts(&settings) {
        crate::winstt::commands::settings::warm_tts_async(app_handle);
    }
    // Preload + warm the on-device dictionary encoder when the feature is on and the model is
    // already downloaded, so the first non-LLM dictation doesn't pay the cold-load cost.
    if settings.general.encoder_dictionary_enabled
        && crate::winstt::encoder_dict::is_model_present(app_handle)
    {
        crate::winstt::encoder_dict::preload_async(app_handle);
    }

    let Some(llm_manager) = app_handle.try_state::<Arc<LlmManager>>() else {
        return;
    };
    llm_manager.inner().start_warmup_loop();
}
