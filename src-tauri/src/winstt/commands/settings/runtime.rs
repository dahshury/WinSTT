// On-save runtime side-effects (model reload/warm, tts/llm warm, history retention,
// audio device/release, autostart) + warm/reload async helpers + enabled_ollama_models
// + timeout mapping.

use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::winstt::settings_schema::{
    LlmProvider, ModelUnloadTimeout as WinsttModelUnloadTimeout, TtsSource, WinsttSettings,
};

pub(crate) fn core_timeout_from_winstt(
    timeout: WinsttModelUnloadTimeout,
) -> crate::settings::ModelUnloadTimeout {
    match timeout {
        WinsttModelUnloadTimeout::Immediately => crate::settings::ModelUnloadTimeout::Immediately,
        WinsttModelUnloadTimeout::Never => crate::settings::ModelUnloadTimeout::Never,
        WinsttModelUnloadTimeout::Min2 => crate::settings::ModelUnloadTimeout::Min2,
        WinsttModelUnloadTimeout::Min5 => crate::settings::ModelUnloadTimeout::Min5,
        WinsttModelUnloadTimeout::Min10 => crate::settings::ModelUnloadTimeout::Min10,
        WinsttModelUnloadTimeout::Min15 => crate::settings::ModelUnloadTimeout::Min15,
        WinsttModelUnloadTimeout::Hour1 => crate::settings::ModelUnloadTimeout::Hour1,
    }
}

pub(crate) fn should_keep_stt_model_warm(timeout: WinsttModelUnloadTimeout) -> bool {
    timeout != WinsttModelUnloadTimeout::Immediately
}

pub(super) fn apply_model_runtime_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    sync_core_model_unload_timeout(app, next.global.model_unload_timeout);

    if same_model_load_inputs_changed(previous, next) {
        reload_stt_model_async(
            app,
            &next.model.model,
            should_keep_stt_model_warm(next.global.model_unload_timeout),
        );
    } else if model_warm_inputs_changed(previous, next)
        && should_keep_stt_model_warm(next.global.model_unload_timeout)
    {
        warm_stt_model_async(app);
    }
}

fn sync_core_model_unload_timeout(app: &AppHandle, timeout: WinsttModelUnloadTimeout) {
    let mapped = core_timeout_from_winstt(timeout);
    let mut settings = crate::settings::get_settings(app);
    if settings.model_unload_timeout == mapped {
        return;
    }
    settings.model_unload_timeout = mapped;
    crate::settings::write_settings(app, settings);
}

fn model_warm_inputs_changed(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    previous.global.model_unload_timeout != next.global.model_unload_timeout
}

fn same_model_load_inputs_changed(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    let model = next.model.model.trim();
    !model.is_empty()
        && previous.model.model == next.model.model
        && (previous.model.backend != next.model.backend
            || previous.model.device != next.model.device
            || previous.model.onnx_quantization != next.model.onnx_quantization)
}

fn reload_stt_model_async(app: &AppHandle, model: &str, keep_warm: bool) {
    let model = model.trim();
    if model.is_empty() {
        return;
    }
    if !keep_warm {
        unload_loaded_stt_model_async(app);
        return;
    }
    crate::winstt::commands::swap_events::perform_model_reload(app, "main", model);
}

fn unload_loaded_stt_model_async(app: &AppHandle) {
    let Some(transcription) =
        app.try_state::<Arc<crate::managers::transcription::TranscriptionManager>>()
    else {
        return;
    };
    if !transcription.inner().is_model_loaded() {
        return;
    }
    let tm = Arc::clone(transcription.inner());
    std::thread::spawn(move || {
        if let Err(err) = tm.unload_model() {
            log::warn!("[settings] failed to unload STT model after load-input change: {err}");
        }
    });
}

pub(crate) fn warm_stt_model_async(app: &AppHandle) {
    let Some(transcription) =
        app.try_state::<Arc<crate::managers::transcription::TranscriptionManager>>()
    else {
        return;
    };
    let tm = Arc::clone(transcription.inner());
    std::thread::spawn(move || {
        tm.initiate_model_load();
        tm.warmup();
    });
}

pub(crate) fn should_warm_tts(settings: &WinsttSettings) -> bool {
    settings.tts.enabled
        && matches!(settings.tts.source, TtsSource::Local)
        && should_keep_stt_model_warm(settings.global.model_unload_timeout)
}

pub(super) fn apply_tts_runtime_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    if tts_warm_inputs_changed(previous, next) {
        warm_tts_async(app);
    }
}

fn tts_warm_inputs_changed(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    if !should_warm_tts(next) {
        return false;
    }
    !should_warm_tts(previous)
        || previous.tts.source != next.tts.source
        || previous.tts.model != next.tts.model
        || previous.model.device != next.model.device
}

pub(crate) fn warm_tts_async(app: &AppHandle) {
    let Some(tts) = app.try_state::<Arc<crate::winstt::managers::TtsManager>>() else {
        return;
    };
    let mgr = Arc::clone(tts.inner());
    std::thread::spawn(move || {
        if let Err(err) = mgr.warm_up() {
            log::debug!("[tts] warm-up skipped/failed: {err}");
        }
    });
}

pub(super) fn apply_llm_runtime_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    if llm_warm_inputs_changed(previous, next) {
        warm_llm_models_async(app);
    }
}

pub(super) fn apply_history_retention_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    if previous.general.history_max_entries == next.general.history_max_entries
        && previous.general.recording_retention == next.general.recording_retention
    {
        return;
    }
    let Some(history_manager) = app.try_state::<Arc<crate::managers::history::HistoryManager>>()
    else {
        return;
    };
    if let Err(err) = history_manager.cleanup_old_entries() {
        log::warn!("[settings] failed to apply history retention change: {err}");
    }
}

pub(super) fn apply_audio_runtime_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    let microphone_release_changed =
        previous.audio.microphone_release != next.audio.microphone_release;
    let input_device_changed = previous.audio.input_device_index != next.audio.input_device_index
        || previous.audio.clamshell_microphone != next.audio.clamshell_microphone;
    if !microphone_release_changed && !input_device_changed {
        return;
    }

    let Some(audio_manager) = app.try_state::<Arc<crate::managers::audio::AudioRecordingManager>>()
    else {
        return;
    };

    if microphone_release_changed {
        let mode = crate::managers::audio::microphone_mode_from_settings(next);
        if let Err(err) = audio_manager.update_mode(mode) {
            log::warn!("[settings] failed to apply microphone release policy: {err}");
        }
    }

    if input_device_changed {
        if let Err(err) = audio_manager.update_selected_device() {
            log::warn!("[settings] failed to apply microphone device change: {err}");
        }
    }
}

pub(super) fn apply_autostart_setting(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    if previous.general.auto_start == next.general.auto_start {
        return;
    }
    let autostart = app.autolaunch();
    let result = if next.general.auto_start {
        autostart.enable()
    } else {
        autostart.disable()
    };
    if let Err(err) = result {
        log::warn!("[settings] failed to apply autostart setting: {err}");
    }
}

pub(crate) fn enabled_ollama_models(settings: &WinsttSettings) -> Vec<String> {
    if !should_keep_stt_model_warm(settings.global.model_unload_timeout) {
        return Vec::new();
    }

    fn push_feature(out: &mut Vec<String>, enabled: bool, provider: LlmProvider, model: &str) {
        let model = model.trim();
        if !enabled || provider != LlmProvider::Ollama || model.is_empty() {
            return;
        }
        if !out.iter().any(|existing| existing == model) {
            out.push(model.to_string());
        }
    }

    let mut out = Vec::new();
    push_feature(
        &mut out,
        settings.llm.dictation.enabled,
        settings.llm.dictation.base.provider,
        &settings.llm.dictation.base.model,
    );
    push_feature(
        &mut out,
        settings.llm.transforms.enabled,
        settings.llm.transforms.base.provider,
        &settings.llm.transforms.base.model,
    );
    out
}

fn llm_warm_inputs_changed(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    let previous_models = enabled_ollama_models(previous);
    let next_models = enabled_ollama_models(next);
    if previous_models.is_empty() && next_models.is_empty() {
        return false;
    }
    previous.llm.endpoint != next.llm.endpoint || previous_models != next_models
}

pub(crate) fn warm_llm_models_async(app: &AppHandle) {
    let Some(llm) = app.try_state::<Arc<crate::winstt::managers::LlmManager>>() else {
        return;
    };
    let mgr = Arc::clone(llm.inner());
    tauri::async_runtime::spawn(async move {
        mgr.warm_enabled_models().await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_model_load_input_change_requests_reload() {
        let a = WinsttSettings::default();
        let mut b = a.clone();
        b.model.device = crate::winstt::settings_schema::DeviceType::Cpu;
        assert!(same_model_load_inputs_changed(&a, &b));

        let mut quant = a.clone();
        quant.model.onnx_quantization = "int8".into();
        assert!(same_model_load_inputs_changed(&a, &quant));
    }

    #[test]
    fn model_id_change_is_owned_by_swap_controller() {
        let a = WinsttSettings::default();
        let mut b = a.clone();
        b.model.model = "nemo-canary-180m-flash".into();
        assert!(!same_model_load_inputs_changed(&a, &b));
        assert!(!model_warm_inputs_changed(&a, &b));
    }

    #[test]
    fn keep_warm_policy_change_can_request_stt_warmup() {
        use crate::winstt::settings_schema::ModelUnloadTimeout;

        let a = WinsttSettings::default();
        let mut b = a.clone();
        b.global.model_unload_timeout = ModelUnloadTimeout::Immediately;
        assert!(model_warm_inputs_changed(&a, &b));
    }

    #[test]
    fn winstt_unload_timeout_maps_to_core_policy() {
        use crate::settings::ModelUnloadTimeout as CoreTimeout;
        use crate::winstt::settings_schema::ModelUnloadTimeout as WinsttTimeout;

        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Immediately),
            CoreTimeout::Immediately
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Never),
            CoreTimeout::Never
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Min2),
            CoreTimeout::Min2
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Min5),
            CoreTimeout::Min5
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Min10),
            CoreTimeout::Min10
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Min15),
            CoreTimeout::Min15
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Hour1),
            CoreTimeout::Hour1
        );
    }

    #[test]
    fn keep_warm_policy_runs_for_every_timeout_except_immediately() {
        use crate::winstt::settings_schema::ModelUnloadTimeout as WinsttTimeout;

        assert!(!should_keep_stt_model_warm(WinsttTimeout::Immediately));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Never));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Min2));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Min5));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Min10));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Min15));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Hour1));
    }

    #[test]
    fn tts_warmup_only_runs_for_enabled_local_tts() {
        use crate::winstt::settings_schema::{ModelUnloadTimeout, TtsSource};

        let mut disabled = WinsttSettings::default();
        disabled.tts.enabled = false;
        disabled.tts.source = TtsSource::Local;
        assert!(!should_warm_tts(&disabled));

        let mut cloud = disabled.clone();
        cloud.tts.enabled = true;
        cloud.tts.source = TtsSource::Cloud;
        assert!(!should_warm_tts(&cloud));

        let mut local = disabled.clone();
        local.tts.enabled = true;
        local.tts.source = TtsSource::Local;
        assert!(should_warm_tts(&local));

        local.global.model_unload_timeout = ModelUnloadTimeout::Immediately;
        assert!(!should_warm_tts(&local));
    }

    #[test]
    fn tts_warmup_reacts_to_local_enable_model_and_device_edges() {
        use crate::winstt::settings_schema::{DeviceType, TtsSource};

        let mut prev = WinsttSettings::default();
        prev.tts.enabled = false;
        prev.tts.source = TtsSource::Local;
        let mut next = prev.clone();
        next.tts.enabled = true;
        assert!(tts_warm_inputs_changed(&prev, &next));

        let mut model_swap = next.clone();
        model_swap.tts.model = "kitten-nano-0.2".into();
        assert!(tts_warm_inputs_changed(&next, &model_swap));

        let mut device_swap = model_swap.clone();
        device_swap.model.device = DeviceType::Cpu;
        assert!(tts_warm_inputs_changed(&model_swap, &device_swap));

        let mut speed_only = device_swap.clone();
        speed_only.tts.speed = 1.25;
        assert!(!tts_warm_inputs_changed(&device_swap, &speed_only));
    }

    #[test]
    fn enabled_ollama_models_are_deduped_across_dictation_and_transforms() {
        use crate::winstt::settings_schema::LlmProvider;

        let mut settings = WinsttSettings::default();
        settings.llm.dictation.enabled = true;
        settings.llm.dictation.base.provider = LlmProvider::Ollama;
        settings.llm.dictation.base.model = "gemma3:4b".into();
        settings.llm.transforms.enabled = true;
        settings.llm.transforms.base.provider = LlmProvider::Ollama;
        settings.llm.transforms.base.model = "gemma3:4b".into();

        assert_eq!(enabled_ollama_models(&settings), vec!["gemma3:4b"]);

        settings.llm.transforms.base.model = "qwen3:8b".into();
        assert_eq!(
            enabled_ollama_models(&settings),
            vec!["gemma3:4b", "qwen3:8b"]
        );

        settings.llm.transforms.base.provider = LlmProvider::Openrouter;
        assert_eq!(enabled_ollama_models(&settings), vec!["gemma3:4b"]);

        settings.global.model_unload_timeout =
            crate::winstt::settings_schema::ModelUnloadTimeout::Immediately;
        assert!(enabled_ollama_models(&settings).is_empty());
    }

    #[test]
    fn llm_warmup_reacts_only_to_ollama_warm_inputs() {
        use crate::winstt::settings_schema::LlmProvider;

        let mut prev = WinsttSettings::default();
        prev.llm.endpoint = "http://localhost:11434".into();
        prev.llm.dictation.enabled = true;
        prev.llm.dictation.base.provider = LlmProvider::Ollama;
        prev.llm.dictation.base.model = "gemma3:4b".into();

        let mut unchanged_for_warmup = prev.clone();
        unchanged_for_warmup.llm.openrouter_api_key = "sk-not-ollama".into();
        assert!(!llm_warm_inputs_changed(&prev, &unchanged_for_warmup));

        let mut endpoint_swap = prev.clone();
        endpoint_swap.llm.endpoint = "http://127.0.0.1:11434".into();
        assert!(llm_warm_inputs_changed(&prev, &endpoint_swap));

        let mut model_swap = prev.clone();
        model_swap.llm.dictation.base.model = "qwen3:8b".into();
        assert!(llm_warm_inputs_changed(&prev, &model_swap));

        let mut provider_swap = prev.clone();
        provider_swap.llm.dictation.base.provider = LlmProvider::Openrouter;
        assert!(llm_warm_inputs_changed(&prev, &provider_swap));
    }
}
