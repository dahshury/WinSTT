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

pub(crate) fn construct_core_managers(app_handle: &AppHandle) -> CoreManagers {
    let recording = Arc::new(
        AudioRecordingManager::new(app_handle).expect("Failed to initialize recording manager"),
    );
    let transcription = Arc::new(
        TranscriptionManager::new(app_handle).expect("Failed to initialize transcription manager"),
    );
    let history =
        Arc::new(HistoryManager::new(app_handle).expect("Failed to initialize history manager"));

    CoreManagers {
        recording,
        transcription,
        history,
    }
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

    let llm_manager = Arc::new(LlmManager::new(app_handle));
    app_handle.manage(llm_manager.clone());
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

    {
        let settings = crate::winstt::commands::settings::read_settings(app_handle);
        if crate::winstt::commands::settings::should_warm_tts(&settings) {
            crate::winstt::commands::settings::warm_tts_async(app_handle);
        }
    }
    llm_manager.start_warmup_loop();

    let realtime_manager = Arc::new(RealtimeManager::new(
        app_handle.clone(),
        managers.transcription.clone(),
        managers.recording.clone(),
    ));
    realtime_manager.start();
    app_handle.manage(realtime_manager);
}
