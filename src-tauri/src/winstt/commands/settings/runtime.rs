// On-save runtime side-effects (model reload/warm, tts/llm warm, history retention,
// audio device/release, autostart) + warm/reload async helpers + enabled_ollama_models
// + timeout mapping.

use std::sync::Arc;
use tauri::{AppHandle, Manager};

use crate::winstt::settings_schema::{
    LlmProvider, ModelUnloadTimeout as WinsttModelUnloadTimeout, RecordingMode, TtsSource,
    WinsttSettings,
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

fn should_keep_stt_model_warm_for_settings(settings: &WinsttSettings) -> bool {
    settings.general.recording_mode == RecordingMode::Listen
        || should_keep_stt_model_warm(settings.global.model_unload_timeout)
}

pub(super) fn apply_model_runtime_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    // Moving the STT model to a cloud provider (openrouter:/elevenlabs:) frees any
    // resident LOCAL engine right away — the user shouldn't keep a local model in
    // memory after switching to the cloud (the first requirement of onboarding's
    // "configure cloud → unload local"). Idempotent and cheap: a no-op when the
    // swap controller already unloaded it (cloud ids report `is_model_loaded()==false`).
    if stt_switched_to_cloud(previous, next) {
        unload_loaded_stt_model_async(app);
    }
    sync_core_model_unload_timeout(app, next.global.model_unload_timeout);
    sync_stt_runtime_policy(app, next);
    let keep_stt_warm = should_keep_stt_model_warm_for_settings(next);

    if same_model_load_inputs_changed(previous, next) {
        reload_stt_model_async(app, &next.model.model, keep_stt_warm);
    } else if model_warm_inputs_changed(previous, next) {
        if keep_stt_warm {
            warm_stt_model_async(app);
        } else {
            unload_loaded_stt_model_async(app);
        }
    }

    // Prompt-based realtime models (Nemotron-3.5) bind the encoder `prompt_index` at LOAD, so a
    // change to the realtime language must reload the realtime engine to re-bind it. Only fires when
    // the realtime model itself is unchanged (a model change already reloads via the swap controller).
    if realtime_language_changed(previous, next) {
        let rt = next.model.realtime_model.trim();
        if !rt.is_empty() {
            crate::winstt::commands::swap_events::perform_model_reload(app, "realtime", rt);
        }
    }
}

/// True when only the realtime LANGUAGE changed (same realtime model). Drives a targeted realtime
/// reload so the new `prompt_index` takes effect without touching the main engine.
fn realtime_language_changed(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    !next.model.realtime_model.trim().is_empty()
        && previous.model.realtime_model == next.model.realtime_model
        && previous.model.realtime_language != next.model.realtime_language
}

/// True when the STT model id CHANGED to a cloud provider id (`openrouter:` /
/// `elevenlabs:`) — the exact moment a resident LOCAL engine must be freed,
/// since a cloud model holds no local VRAM. Mirrors `local_tts_engine_wanted`'s
/// role for TTS and the `ollama_models_for_enabled_features` provider filter for
/// LLM: switching to cloud is an UNLOAD trigger, not only disabling.
fn stt_switched_to_cloud(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    previous.model.model != next.model.model
        && crate::winstt::cloud_stt::provider_of(&next.model.model).is_some()
}

fn sync_stt_runtime_policy(app: &AppHandle, settings: &WinsttSettings) {
    let Some(transcription) =
        app.try_state::<Arc<crate::managers::transcription::TranscriptionManager>>()
    else {
        return;
    };
    transcription.inner().update_runtime_policy(
        core_timeout_from_winstt(settings.global.model_unload_timeout),
        settings.general.recording_mode == RecordingMode::Listen,
    );
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
        || should_keep_stt_model_warm_for_settings(previous)
            != should_keep_stt_model_warm_for_settings(next)
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

/// True when the CURRENT settings still want a warm LOCAL STT engine. The queued
/// unload thread re-checks this so a rapid settings flip-back (e.g. cloud→local,
/// or immediate→finite timeout) can't let a stale eviction land after the warm
/// that re-loaded the model.
fn local_stt_engine_wanted(settings: &WinsttSettings) -> bool {
    should_keep_stt_model_warm_for_settings(settings)
        && crate::winstt::cloud_stt::provider_of(&settings.model.model).is_none()
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
    let app = app.clone();
    std::thread::spawn(move || {
        // The settings snapshot that scheduled this unload is stale by now —
        // only the CURRENT settings decide whether the local engine may drop.
        let current = crate::winstt::settings_store::read_settings_raw(&app);
        if local_stt_engine_wanted(&current) {
            log::info!(
                "[settings] STT unload skipped — current settings want the local model warm"
            );
            return;
        }
        if let Err(err) = tm.unload_model() {
            log::warn!("[settings] failed to unload STT model after load-input change: {err}");
        }
        // Self-heal: the user may have flipped back to "keep warm" between the
        // re-check above and the drop. The CURRENT settings win — reload + warm
        // now instead of leaving a cold engine behind an enabled-looking state.
        let after = crate::winstt::settings_store::read_settings_raw(&app);
        if local_stt_engine_wanted(&after) {
            log::info!("[settings] STT re-warm after unload — settings flipped back mid-drop");
            warm_stt_model_async(&app);
        }
    });
}

pub(crate) fn warm_stt_model_async(app: &AppHandle) {
    // Onboarding stays model-free until the user finishes — see
    // onboarding::is_onboarding_active. The deferred warm runs on finish.
    if crate::winstt::commands::onboarding::is_onboarding_active() {
        return;
    }
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
    sync_tts_idle_unload_timeout(app, next.global.model_unload_timeout);
    // Disabling TTS (or moving it to a cloud voice) should free the local ONNX
    // voice from VRAM right away — not leave it pinned until the idle timer fires
    // (up to 15 min, or never under "never unload").
    if local_tts_engine_wanted(previous) && !local_tts_engine_wanted(next) {
        unload_local_tts_async(app);
        return;
    }
    if tts_warm_inputs_changed(previous, next) {
        warm_tts_async(app);
    }
}

/// True iff a LOCAL (in-process ONNX) TTS voice is wanted — enabled AND sourced
/// locally. A cloud voice holds no VRAM, so it is not "wanted" for this purpose.
fn local_tts_engine_wanted(settings: &WinsttSettings) -> bool {
    settings.tts.enabled && matches!(settings.tts.source, TtsSource::Local)
}

/// Drop the active local TTS session off-thread (cancels any in-flight read-aloud,
/// which is the right call when the user just turned TTS off).
///
/// Emits `tts:unload-status` (inProgress true → false) around the drop so the
/// toggle row can show a truthful "freeing memory" state, and re-validates the
/// CURRENT settings first: a rapid disable→enable must not let the queued drop
/// land after the re-enable's warm-up and evict the session again.
fn unload_local_tts_async(app: &AppHandle) {
    let Some(tts) = app.try_state::<Arc<crate::winstt::managers::TtsManager>>() else {
        return;
    };
    let mgr = Arc::clone(tts.inner());
    let app = app.clone();
    std::thread::spawn(move || {
        use tauri::Emitter;
        let current = crate::winstt::settings_store::read_settings_raw(&app);
        if local_tts_engine_wanted(&current) {
            log::info!("[tts] unload skipped — current settings want the local voice loaded");
            return;
        }
        let _ = app.emit(
            "tts:unload-status",
            serde_json::json!({ "inProgress": true }),
        );
        mgr.unload_active_local_model_for_cleanup("tts disabled");
        let _ = app.emit(
            "tts:unload-status",
            serde_json::json!({ "inProgress": false }),
        );
        // Self-heal: a re-enable that landed between the re-check above and the
        // drop must not leave an enabled toggle with a cold engine — re-warm now
        // (the warm-up is claim-guarded and idempotent).
        let after = crate::winstt::settings_store::read_settings_raw(&app);
        if local_tts_engine_wanted(&after) {
            log::info!("[tts] re-warm after unload — settings flipped back mid-drop");
            warm_tts_async(&app);
        }
    });
}

/// Free the on-device dictionary fallback's mmBERT session (~310 MB) when the
/// feature is toggled OFF. Unlike STT/TTS it has no idle watcher, so without this
/// the session would sit in the global engine cell until the app exits.
pub(super) fn apply_encoder_dict_runtime_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    // Keep the encoder's idle-unload policy in lock-step with the shared
    // `model_unload_timeout` (so the dictionary model unloads on the same
    // schedule as STT/TTS/LLM instead of lingering in RAM forever).
    crate::winstt::encoder_dict::update_idle_unload_timeout(core_timeout_from_winstt(
        next.global.model_unload_timeout,
    ));
    if previous.general.encoder_dictionary_enabled && !next.general.encoder_dictionary_enabled {
        std::thread::spawn(|| {
            crate::winstt::encoder_dict::clear_loaded();
            log::info!("[encoder-dict] session dropped (feature disabled)");
        });
    }
    // Enable edge: preload + warm the mmBERT session now so the FIRST dictation
    // with the dictionary on doesn't pay the cold load. The widget's preload
    // command covers the settings UI path; this settings-diff hook makes the
    // guarantee hold for every writer (onboarding, profiles, direct patches).
    // `preload_async` is idempotent and a no-op when the model isn't downloaded.
    if !previous.general.encoder_dictionary_enabled && next.general.encoder_dictionary_enabled {
        crate::winstt::encoder_dict::preload_async(app);
    }
}

fn sync_tts_idle_unload_timeout(app: &AppHandle, timeout: WinsttModelUnloadTimeout) {
    let Some(tts) = app.try_state::<Arc<crate::winstt::managers::TtsManager>>() else {
        return;
    };
    tts.inner()
        .update_idle_unload_timeout(core_timeout_from_winstt(timeout));
}

fn tts_warm_inputs_changed(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    if !should_warm_tts(next) {
        return false;
    }
    !should_warm_tts(previous)
        || previous.tts.source != next.tts.source
        || previous.tts.model != next.tts.model
        // A precision change (e.g. Qwen3-TTS int4→fp16) moves the engine
        // fingerprint, so proactively rebuild+warm the resident voice at the new
        // quant instead of waiting for the next read-aloud (mirrors STT's
        // `same_model_load_inputs_changed` observing `onnx_quantization`).
        || previous.tts.quantization != next.tts.quantization
        || previous.model.device != next.model.device
}

pub(crate) fn warm_tts_async(app: &AppHandle) {
    // Held back while onboarding owns the launch (see onboarding::is_onboarding_active).
    if crate::winstt::commands::onboarding::is_onboarding_active() {
        return;
    }
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
    // Any Ollama model that was backing an enabled feature but is NO LONGER in use
    // (feature toggled off, model swapped, or provider changed) must be freed from
    // VRAM immediately — by name, via `keep_alive: 0`. This is INDEPENDENT of the
    // unload-timeout: that policy only governs how long an *enabled* model lingers
    // idle; the moment a feature stops using a model it should release VRAM even
    // under "never unload". Computing the diff (was-using − still-using) also frees
    // the old model on a swap and leaves a model that a still-enabled feature uses
    // untouched. Unloading by name (not the warm-tracking set) means a model loaded
    // before this build's warm-tracking — e.g. resident from a prior run under
    // keep_alive=-1 — still gets evicted.
    let was_in_use = ollama_models_for_enabled_features(previous);
    let still_in_use = ollama_models_for_enabled_features(next);
    let to_unload: Vec<String> = was_in_use
        .iter()
        .filter(|model| !still_in_use.iter().any(|kept| &kept == model))
        .cloned()
        .collect();
    let timeout_changed = previous.global.model_unload_timeout != next.global.model_unload_timeout;
    let should_warm = llm_warm_inputs_changed(previous, next);
    if to_unload.is_empty() && !timeout_changed && !should_warm {
        return;
    }

    sync_llm_model_unload_timeout(app, next.global.model_unload_timeout);
    log::info!(
        "[llm] apply_llm_runtime: was_in_use={was_in_use:?} still_in_use={still_in_use:?} to_unload={to_unload:?} timeout={:?}",
        next.global.model_unload_timeout
    );
    if !to_unload.is_empty() {
        unload_ollama_models_async(app, to_unload);
    }
    if should_warm {
        warm_llm_models_async(app);
    }
}

/// Evict the given Ollama models from VRAM off-thread (`keep_alive: 0` at the
/// configured loopback endpoint). Used when a feature stops using a model so it
/// frees memory right away instead of waiting out the keep-alive timer (or forever
/// under "never unload").
pub(crate) fn unload_ollama_models_async(app: &AppHandle, models: Vec<String>) {
    if models.is_empty() {
        return;
    }
    let Some(llm) = app.try_state::<Arc<crate::winstt::managers::LlmManager>>() else {
        return;
    };
    let mgr = Arc::clone(llm.inner());
    log::info!("[llm] unload_ollama_models_async: spawning unload for {models:?}");
    tauri::async_runtime::spawn(async move {
        mgr.unload_ollama_models(&models, std::time::Duration::from_secs(5))
            .await;
    });
}

fn sync_llm_model_unload_timeout(app: &AppHandle, timeout: WinsttModelUnloadTimeout) {
    let Some(llm) = app.try_state::<Arc<crate::winstt::managers::LlmManager>>() else {
        return;
    };
    llm.inner()
        .update_model_unload_timeout(core_timeout_from_winstt(timeout));
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
    if crate::winstt::commands::onboarding::is_onboarding_active() {
        return;
    }

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

    if input_device_changed && let Err(err) = audio_manager.update_selected_device() {
        log::warn!("[settings] failed to apply microphone device change: {err}");
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
    crate::autostart::sync_launch_at_login(app, next.general.auto_start, "[settings]");
}

/// Ollama models backing an ENABLED post-processing feature (dictation/transforms,
/// Ollama provider, non-empty model), deduped. Unlike [`enabled_ollama_models`]
/// this IGNORES the unload-timeout: it answers "which models is a live feature
/// using right now", which the VRAM-eviction diff in [`apply_llm_runtime_settings`]
/// needs even under the "never unload" policy (the timeout governs an enabled
/// model's idle lifetime, not whether a disabled feature frees its model).
pub(crate) fn ollama_models_for_enabled_features(settings: &WinsttSettings) -> Vec<String> {
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

pub(crate) fn enabled_ollama_models(settings: &WinsttSettings) -> Vec<String> {
    if !should_keep_stt_model_warm(settings.global.model_unload_timeout) {
        return Vec::new();
    }
    ollama_models_for_enabled_features(settings)
}

fn llm_warm_inputs_changed(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    let previous_models = enabled_ollama_models(previous);
    let next_models = enabled_ollama_models(next);
    if previous_models.is_empty() && next_models.is_empty() {
        return false;
    }
    previous.llm.endpoint != next.llm.endpoint
        || previous.global.model_unload_timeout != next.global.model_unload_timeout
        || previous_models != next_models
}

pub(crate) fn warm_llm_models_async(app: &AppHandle) {
    // Held back while onboarding owns the launch: enabling LLM cleanup in the wizard
    // persists the setting but must not pull a model into VRAM until finish (see
    // onboarding::is_onboarding_active). The warmup loop warms it after finish.
    if crate::winstt::commands::onboarding::is_onboarding_active() {
        return;
    }
    let Some(llm) = app.try_state::<Arc<crate::winstt::managers::LlmManager>>() else {
        return;
    };
    let mgr = Arc::clone(llm.inner());
    tauri::async_runtime::spawn(async move {
        // Retry on the short trigger cadence: when the user toggles
        // post-processing on or switches the model, the very first warm pass
        // can lose the pass-claim to an in-flight periodic pass, or hit an
        // Ollama that is momentarily busy unloading the previous model. A
        // single fire-and-forget pass would then leave the new model cold until
        // the 60s periodic tick — the user's "first post-process is slow" gap.
        mgr.warm_enabled_models_with_retry("trigger").await;
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
    fn ollama_models_for_enabled_features_ignores_unload_timeout() {
        use crate::winstt::settings_schema::{LlmProvider, ModelUnloadTimeout};

        let mut on = WinsttSettings::default();
        on.llm.dictation.enabled = true;
        on.llm.dictation.base.provider = LlmProvider::Ollama;
        on.llm.dictation.base.model = "gemma3:4b".into();
        assert_eq!(ollama_models_for_enabled_features(&on), vec!["gemma3:4b"]);

        // Unlike `enabled_ollama_models`, the "never unload" / immediate policy must
        // NOT zero this — a disabled feature has to free its model under any policy.
        on.global.model_unload_timeout = ModelUnloadTimeout::Never;
        assert_eq!(ollama_models_for_enabled_features(&on), vec!["gemma3:4b"]);
        on.global.model_unload_timeout = ModelUnloadTimeout::Immediately;
        assert_eq!(ollama_models_for_enabled_features(&on), vec!["gemma3:4b"]);
        assert!(enabled_ollama_models(&on).is_empty());

        // Disabling the feature drops it from the in-use set (the unload diff then
        // sees it in `previous` but not `next`).
        let mut off = on.clone();
        off.llm.dictation.enabled = false;
        assert!(ollama_models_for_enabled_features(&off).is_empty());

        // A cloud provider holds no local VRAM, and a blank model is not "in use".
        let mut cloud = on.clone();
        cloud.llm.dictation.base.provider = LlmProvider::Openrouter;
        assert!(ollama_models_for_enabled_features(&cloud).is_empty());
        let mut blank = on;
        blank.llm.dictation.base.model = "  ".into();
        assert!(ollama_models_for_enabled_features(&blank).is_empty());
    }

    #[test]
    fn unload_diff_frees_disabled_and_swapped_models_keeps_in_use() {
        use crate::winstt::settings_schema::LlmProvider;

        let mut prev = WinsttSettings::default();
        prev.global.model_unload_timeout =
            crate::winstt::settings_schema::ModelUnloadTimeout::Never;
        prev.llm.dictation.enabled = true;
        prev.llm.dictation.base.provider = LlmProvider::Ollama;
        prev.llm.dictation.base.model = "gemma3:4b".into();

        let unload_diff = |a: &WinsttSettings, b: &WinsttSettings| -> Vec<String> {
            let still = ollama_models_for_enabled_features(b);
            ollama_models_for_enabled_features(a)
                .into_iter()
                .filter(|m| !still.iter().any(|k| k == m))
                .collect()
        };

        // Toggle off → the model is freed even though timeout is "never".
        let mut off = prev.clone();
        off.llm.dictation.enabled = false;
        assert_eq!(unload_diff(&prev, &off), vec!["gemma3:4b"]);

        // Swap model → old freed, new is left for the warm path to load.
        let mut swap = prev.clone();
        swap.llm.dictation.base.model = "qwen3:8b".into();
        assert_eq!(unload_diff(&prev, &swap), vec!["gemma3:4b"]);

        // Still enabled, unchanged → nothing freed.
        assert!(unload_diff(&prev, &prev).is_empty());
    }

    #[test]
    fn local_tts_unload_triggers_only_when_local_voice_is_dropped() {
        use crate::winstt::settings_schema::TtsSource;

        let mut on = WinsttSettings::default();
        on.tts.enabled = true;
        on.tts.source = TtsSource::Local;
        assert!(local_tts_engine_wanted(&on));

        // Disable TTS → local voice no longer wanted → unload.
        let mut off = on.clone();
        off.tts.enabled = false;
        assert!(!local_tts_engine_wanted(&off));

        // Move to a cloud voice → local session no longer wanted → unload.
        let mut cloud = on;
        cloud.tts.source = TtsSource::Cloud;
        assert!(!local_tts_engine_wanted(&cloud));
    }

    #[test]
    fn stt_switch_to_cloud_provider_triggers_local_unload() {
        // Switching the STT model from a local engine to a cloud id must free the
        // resident local model — NOT only disabling does. Both cloud providers
        // (openrouter / elevenlabs) count; a plain local→local swap does not.
        let mut local = WinsttSettings::default();
        local.model.model = "dolphin-base-ctc".into();

        let mut to_eleven = local.clone();
        to_eleven.model.model = "elevenlabs:scribe_v1".into();
        assert!(stt_switched_to_cloud(&local, &to_eleven));

        let mut to_openrouter = local.clone();
        to_openrouter.model.model = "openrouter:whisper-large-v3".into();
        assert!(stt_switched_to_cloud(&local, &to_openrouter));

        // local → another local model is a swap, not a cloud switch.
        let mut local_swap = local.clone();
        local_swap.model.model = "nemo-parakeet-tdt-0.6b-v3".into();
        assert!(!stt_switched_to_cloud(&local, &local_swap));

        // Unchanged id, or already-cloud staying cloud, is not a fresh switch.
        assert!(!stt_switched_to_cloud(&local, &local));
        assert!(!stt_switched_to_cloud(&to_eleven, &to_eleven));
    }

    #[test]
    fn queued_stt_unload_is_vetoed_when_current_settings_want_a_warm_local_model() {
        use crate::winstt::settings_schema::ModelUnloadTimeout;

        // Local model + keep-warm policy → the queued unload must be skipped
        // (the user flipped back while the unload thread was queued).
        let mut warm_local = WinsttSettings::default();
        warm_local.model.model = "dolphin-base-ctc".into();
        assert!(local_stt_engine_wanted(&warm_local));

        // Cloud model → no local engine wanted → unload proceeds.
        let mut cloud = warm_local.clone();
        cloud.model.model = "elevenlabs:scribe_v1".into();
        assert!(!local_stt_engine_wanted(&cloud));

        // "Immediately" policy → nothing should stay warm → unload proceeds.
        let mut immediate = warm_local;
        immediate.global.model_unload_timeout = ModelUnloadTimeout::Immediately;
        assert!(!local_stt_engine_wanted(&immediate));
    }

    #[test]
    fn listen_mode_keeps_stt_warm_even_when_saved_timeout_is_immediate() {
        use crate::winstt::settings_schema::{ModelUnloadTimeout, RecordingMode};

        let mut settings = WinsttSettings::default();
        settings.global.model_unload_timeout = ModelUnloadTimeout::Immediately;
        settings.general.recording_mode = RecordingMode::Listen;

        assert!(should_keep_stt_model_warm_for_settings(&settings));

        settings.general.recording_mode = RecordingMode::Ptt;
        assert!(!should_keep_stt_model_warm_for_settings(&settings));
    }

    #[test]
    fn listen_mode_transition_changes_warm_policy_when_saved_timeout_is_immediate() {
        use crate::winstt::settings_schema::{ModelUnloadTimeout, RecordingMode};

        let mut listen = WinsttSettings::default();
        listen.global.model_unload_timeout = ModelUnloadTimeout::Immediately;
        listen.general.recording_mode = RecordingMode::Listen;

        let mut ptt = listen.clone();
        ptt.general.recording_mode = RecordingMode::Ptt;

        assert!(model_warm_inputs_changed(&ptt, &listen));
        assert!(model_warm_inputs_changed(&listen, &ptt));
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

        let mut local = disabled;
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
    fn llm_warmup_only_targets_enabled_ollama_provider_models() {
        use crate::winstt::settings_schema::{LlmProvider, ModelUnloadTimeout};

        let mut settings = WinsttSettings::default();
        assert!(enabled_ollama_models(&settings).is_empty());

        settings.llm.dictation.enabled = true;
        settings.llm.dictation.base.provider = LlmProvider::Openrouter;
        settings.llm.dictation.base.model = "openai/gpt-4.1-mini".into();
        assert!(enabled_ollama_models(&settings).is_empty());

        settings.llm.dictation.base.provider = LlmProvider::Ollama;
        settings.llm.dictation.base.model = "gemma3:4b".into();
        assert!(!enabled_ollama_models(&settings).is_empty());

        settings.global.model_unload_timeout = ModelUnloadTimeout::Immediately;
        assert!(enabled_ollama_models(&settings).is_empty());
    }

    #[test]
    fn llm_warmup_reacts_only_to_ollama_warm_inputs() {
        use crate::winstt::settings_schema::{LlmProvider, ModelUnloadTimeout};

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

        let mut unload_timeout_change = prev.clone();
        unload_timeout_change.global.model_unload_timeout = ModelUnloadTimeout::Hour1;
        assert!(llm_warm_inputs_changed(&prev, &unload_timeout_change));
    }
}
