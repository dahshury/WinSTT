//! The tauri-specta `Builder` construction: full command list +
//! `#[cfg(any(debug_assertions, feature = "context-playground"))]` extension +
//! event registry. Pure declarative, no shared state.

use tauri_specta::{collect_commands, collect_events, Builder};

use tauri::{AppHandle, Emitter};

use crate::{commands, helpers, managers, shortcut, tray, winstt};

// These window/update/quit commands live alongside `collect_commands!` (they were
// inline in `lib.rs` before the split). tauri-specta resolves a command's generated
// `__cmd__`/`__specta__fn__` macros by bare name only when the command shares this
// module, so they must be defined here rather than at the crate root.
#[tauri::command]
#[specta::specta]
pub(crate) fn trigger_update_check(app: AppHandle) -> Result<(), String> {
    let settings = crate::settings::get_settings(&app);
    if !settings.update_checks_enabled {
        return Ok(());
    }
    app.emit("check-for-updates", ())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn show_main_window_command(app: AppHandle) -> Result<(), String> {
    crate::window_state::show_main_window(&app);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn quit_app(app: AppHandle) {
    crate::startup::request_app_exit(&app, "Quit requested");
}

/// Build the tauri-specta `Builder` with the full command + event registry.
/// Single source of truth for both `run()` (which mounts it on the live app) and
/// the `export_bindings` test (which calls `.export(...)` without starting the app).
pub fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        shortcut::change_binding,
        shortcut::reset_binding,
        shortcut::change_word_correction_threshold_setting,
        shortcut::get_available_typing_tools,
        shortcut::set_post_process_provider,
        shortcut::fetch_post_process_models,
        shortcut::add_post_process_prompt,
        shortcut::update_post_process_prompt,
        shortcut::delete_post_process_prompt,
        shortcut::set_post_process_selected_prompt,
        shortcut::update_custom_words,
        shortcut::suspend_binding,
        shortcut::resume_binding,
        shortcut::get_keyboard_implementation,
        shortcut::change_whisper_gpu_device,
        shortcut::get_available_accelerators,
        shortcut::handy_keys::start_handy_keys_recording,
        shortcut::handy_keys::stop_handy_keys_recording,
        trigger_update_check,
        show_main_window_command,
        quit_app,
        tray::copy_last_transcript,
        commands::cancel_operation,
        commands::is_portable,
        commands::get_app_dir_path,
        commands::get_log_dir_path,
        commands::set_log_level,
        commands::open_recordings_folder,
        commands::open_log_dir,
        commands::open_app_data_dir,
        commands::cleanup::remove_application_data,
        commands::cleanup::remove_downloaded_models,
        commands::check_apple_intelligence_available,
        commands::initialize_enigo,
        commands::initialize_shortcuts,
        commands::models::get_available_models,
        commands::models::get_model_info,
        commands::models::download_model,
        commands::models::delete_model,
        commands::models::cancel_download,
        commands::models::set_active_model,
        commands::models::get_current_model,
        commands::models::get_transcription_model_status,
        commands::models::is_model_loading,
        commands::models::has_any_models_available,
        commands::models::has_any_models_or_downloads,
        commands::audio::get_windows_microphone_permission_status,
        commands::audio::open_microphone_privacy_settings,
        commands::audio::get_available_microphones,
        commands::audio::set_selected_microphone,
        commands::audio::get_selected_microphone,
        commands::audio::get_available_output_devices,
        commands::audio::set_selected_output_device,
        commands::audio::get_selected_output_device,
        commands::audio::play_test_sound,
        commands::audio::check_custom_sounds,
        commands::audio::set_clamshell_microphone,
        commands::audio::get_clamshell_microphone,
        commands::audio::is_recording,
        commands::transcription::set_model_unload_timeout,
        commands::transcription::get_model_load_status,
        commands::transcription::unload_model_manually,
        commands::history::get_history_entries,
        commands::history::toggle_history_entry_saved,
        commands::history::get_audio_file_path,
        commands::history::delete_history_entry,
        commands::history::retry_history_entry_transcription,
        helpers::clamshell::is_laptop,
        // ── WinSTT commands (lib_wiring.md §3) ──
        winstt::commands::settings::winstt_get_settings,
        winstt::commands::settings::winstt_set_settings,
        winstt::commands::stt::list_models,
        winstt::commands::stt::picker_quantizations_for,
        winstt::commands::stt::get_live_resources,
        winstt::commands::stt::set_custom_model,
        winstt::commands::tts::tts_speak,
        winstt::commands::tts::tts_speak_selection,
        winstt::commands::tts::tts_cancel,
        winstt::commands::tts::tts_cancel_all,
        winstt::commands::tts::tts_init,
        winstt::commands::tts::tts_list_voices,
        winstt::commands::tts::tts_list_cloud_voices,
        winstt::commands::tts::tts_cloud_subscription,
        winstt::commands::tts::tts_download_estimate,
        winstt::commands::tts::tts_install_pause,
        winstt::commands::tts::tts_install_resume,
        winstt::commands::tts::tts_install_cancel,
        winstt::commands::tts::tts_preview_cloud,
        winstt::commands::tts::tts_list_models,
        winstt::commands::tts::tts_list_models_with_state,
        winstt::commands::tts::tts_predownload_model,
        winstt::commands::tts::tts_download_pause,
        winstt::commands::tts::tts_download_resume,
        winstt::commands::tts::tts_download_cancel,
        winstt::commands::tts::tts_delete_model,
        winstt::commands::llm::process_text,
        winstt::commands::llm::process_transform,
        winstt::commands::llm::scan_ollama_models,
        winstt::commands::llm::scan_openrouter_models,
        winstt::commands::llm::ollama_detect,
        winstt::commands::llm::ollama_start,
        winstt::commands::llm::ollama_pull,
        winstt::commands::llm::ollama_delete,
        winstt::commands::llm::verify_credential,
        winstt::commands::cloud_stt::verify_cloud_stt_credential,
        winstt::commands::cloud_stt::cloud_stt_cancel,
        winstt::commands::wakeword::set_wake_word,
        winstt::commands::wakeword::list_wake_word_presets,
        winstt::commands::wakeword::wakeword_model_status,
        winstt::commands::wakeword::wakeword_start_model_download,
        winstt::commands::wakeword::wakeword_pause_model_download,
        winstt::commands::wakeword::wakeword_resume_model_download,
        winstt::commands::wakeword::wakeword_cancel_model_download,
        winstt::commands::listen::start_listen,
        winstt::commands::listen::stop_listen,
        winstt::commands::wordts::align_words,
        winstt::commands::file_transcribe::file_transcribe_enqueue,
        winstt::commands::file_transcribe::file_transcribe_pick_and_enqueue,
        winstt::commands::file_transcribe::file_transcribe_pause,
        winstt::commands::file_transcribe::file_transcribe_resume,
        winstt::commands::file_transcribe::file_transcribe_cancel,
        // ── frontend-port slice commands (10_frontend_port_plan.md WU-3..13) ──
        winstt::commands::snippets::winstt_expand_snippets,
        winstt::commands::dictation::set_winstt_model,
        winstt::commands::dictation::winstt_call_method,
        winstt::commands::dictation::winstt_emit_ready,
        winstt::commands::dictation::winstt_get_parameter,
        winstt::commands::dictation::winstt_set_parameter,
        winstt::commands::download::predownload_quant,
        winstt::commands::download::download_pause_quant,
        winstt::commands::download::download_resume_quant,
        winstt::commands::download::download_cancel_quant,
        winstt::commands::download::delete_model_quantization,
        winstt::commands::download::delete_model_cache,
        winstt::commands::runtime::get_runtime_info,
        winstt::commands::runtime::list_models_with_state,
        winstt::commands::runtime::assess_dictation_fit,
        winstt::commands::runtime::assess_ollama_fit,
        winstt::commands::runtime::gpu_get_info,
        winstt::commands::hotkey::hotkey_register,
        winstt::commands::hotkey::hotkey_unregister,
        winstt::commands::hotkey::hotkey_start_recording,
        winstt::commands::hotkey::hotkey_stop_recording,
        winstt::commands::audio_devices::get_audio_devices,
        winstt::commands::audio_devices::refresh_audio_devices,
        winstt::commands::audio_devices::get_audio_output_devices,
        winstt::commands::audio_devices::refresh_audio_output_devices,
        winstt::commands::audio_devices::start_microphone_level_monitor,
        winstt::commands::audio_devices::stop_microphone_level_monitor,
        winstt::commands::loopback::loopback_list_devices,
        winstt::commands::context::list_context_apps,
        winstt::commands::tts::tts_set_speed,
        winstt::commands::tts::tts_report_playback_started,
        winstt::commands::tts::tts_report_playback_ended,
        winstt::commands::ollama_library::ollama_fetch_library,
        winstt::commands::ollama_library::ollama_fetch_tags,
        winstt::commands::ollama_library::ollama_search_library,
        winstt::commands::ollama_pull::ollama_cancel_pull,
        winstt::commands::ollama_pull::llm_get_warmup_status,
        winstt::commands::verify::verify_integration_credential,
        winstt::commands::file_transcribe::file_transcribe_clear,
        winstt::commands::file_transcribe::file_transcribe_copy,
        winstt::commands::file_transcribe::file_transcribe_discard_all,
        winstt::commands::file_transcribe::file_transcribe_get_active,
        winstt::commands::file_transcribe::file_transcribe_retry,
        winstt::commands::history::history_list,
        winstt::commands::history::history_recent,
        winstt::commands::history::history_add,
        winstt::commands::history::history_toggle,
        winstt::commands::history::history_delete_row,
        winstt::commands::history::history_load_audio_by_row,
        winstt::commands::history::history_get_all,
        winstt::commands::history::history_clear,
        winstt::commands::history::history_delete,
        winstt::commands::history::history_load_audio,
        winstt::commands::history::transform_history_get_all,
        winstt::commands::history::transform_history_clear,
        winstt::commands::history::transform_history_delete,
        winstt::commands::about::about_get_app_info,
        winstt::commands::about::about_get_license,
        winstt::commands::about::about_get_notices,
        winstt::commands::diag::diag_open_logs_folder,
        winstt::commands::diag::diag_save_bundle,
        winstt::commands::sound::sound_library_add,
        winstt::commands::sound::sound_library_pick_and_add,
        winstt::commands::sound::sound_library_read_file,
        winstt::commands::sound::sound_library_remove,
        winstt::commands::transforms::apply_transform,
        winstt::commands::transforms::apply_transform_preview,
        winstt::commands::preview::confirm_paste,
        winstt::commands::preview::cancel_preview,
        winstt::commands::overlay::set_overlay_hit_regions,
        winstt::commands::windows::winstt_diag,
        winstt::commands::windows::settings_window_ready,
        winstt::commands::windows::open_window,
        winstt::commands::windows::close_window,
        winstt::commands::windows::close_self_window,
        winstt::commands::windows::resize_window,
        winstt::commands::windows::anchor_window,
        winstt::commands::onboarding::onboarding_finish,
        winstt::commands::tray_menu::show_tray_menu,
        winstt::commands::tray_menu::reanchor_tray_menu,
        winstt::commands::tray_menu::hide_tray_menu,
        // ── de-brand/completion slice ──
        winstt::commands::sound::sound_get_data,
        winstt::commands::cancel::cancel_current_operation,
        winstt::commands::custom_models::open_custom_models_folder,
        winstt::commands::download::winstt_cancel_download,
        winstt::commands::updater::winstt_updater_check_and_download,
        winstt::commands::updater::winstt_updater_clear_status_history,
        winstt::commands::updater::winstt_updater_get_status_history,
        winstt::commands::updater::winstt_updater_install,
    ]);

    // Context-playground: a `#[cfg(feature = "context-playground")]` dev tool.
    //
    // FOOTGUN: tauri-specta rc.21 `Builder::commands()` REPLACES the command
    // list — it is NOT additive (see builder.rs: `commands, ..self`). So a
    // second `.commands()` call is only safe when it is skipped for normal
    // builds: gating it on the feature means dev/release builds keep the full
    // ~240-command set above. Do NOT widen this to
    // `any(debug_assertions, ...)` — that fires the replace on EVERY debug
    // build and clobbers the whole command surface (and the generated
    // `bindings.ts`) down to just these four. To expose these in dev without
    // the feature, the full list must be duplicated under a cfg branch, not
    // appended via a second `.commands()`.
    #[cfg(feature = "context-playground")]
    let builder = builder.commands(collect_commands![
        winstt::commands::context::debug_read_context,
        winstt::commands::context_playground::context_playground_set_live,
        winstt::commands::context_playground::context_playground_arm_deep,
        winstt::commands::context_playground::context_playground_capture,
    ]);

    builder.events(collect_events![
        managers::history::HistoryUpdatePayload,
        winstt::commands::events::RealtimeStabilizedPayload,
        winstt::commands::events::RealtimeUpdatePayload,
        winstt::commands::events::WakeWordDetectedPayload,
        winstt::commands::events::SpeakerSegmentsPayload,
        winstt::commands::events::WordAlignmentPayload,
        winstt::commands::events::VadSensitivityAdaptedPayload,
        winstt::commands::events::TtsLifecyclePayload,
        winstt::commands::events::FileTranscribeProgressPayload,
    ])
}
