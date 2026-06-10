//! The tauri-specta `Builder` construction: full command list +
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
    app.emit(winstt::commands::events::names::UPDATER_CHECK, ())
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
        shortcut::get_available_typing_tools,
        shortcut::set_post_process_provider,
        shortcut::fetch_post_process_models,
        shortcut::add_post_process_prompt,
        shortcut::update_post_process_prompt,
        shortcut::delete_post_process_prompt,
        shortcut::set_post_process_selected_prompt,
        shortcut::suspend_binding,
        shortcut::resume_binding,
        shortcut::get_keyboard_implementation,
        shortcut::change_whisper_gpu_device,
        shortcut::get_available_accelerators,
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
        helpers::clamshell::is_laptop,
        // ── WinSTT commands (lib_wiring.md §3) ──
        winstt::commands::settings::winstt_get_settings,
        winstt::commands::settings::winstt_set_settings,
        winstt::commands::stt::stt_list_models,
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
        winstt::commands::tts::tts_preview_openrouter,
        winstt::commands::tts::tts_list_models,
        winstt::commands::tts::tts_list_models_with_state,
        winstt::commands::tts::tts_predownload_model,
        winstt::commands::tts::tts_download_pause,
        winstt::commands::tts::tts_download_resume,
        winstt::commands::tts::tts_download_cancel,
        winstt::commands::tts::tts_delete_model,
        winstt::commands::llm::process_text,
        winstt::commands::llm::process_transform,
        winstt::commands::llm::ollama_refresh_models,
        winstt::commands::llm::openrouter_refresh_models,
        winstt::commands::llm::openrouter_refresh_stt_models,
        winstt::commands::llm::openrouter_refresh_tts_models,
        winstt::commands::llm::ollama_detect,
        winstt::commands::llm::ollama_start,
        winstt::commands::llm::ollama_pull,
        winstt::commands::llm::ollama_delete,
        winstt::commands::llm::verify_credential,
        winstt::commands::cloud_stt::verify_cloud_stt_credential,
        winstt::commands::cloud_stt::cloud_stt_cancel,
        winstt::commands::wakeword::wakeword_set_model,
        winstt::commands::wakeword::wakeword_list_presets,
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
        winstt::commands::download::stt_predownload_quant,
        winstt::commands::download::download_pause_quant,
        winstt::commands::download::download_resume_quant,
        winstt::commands::download::download_cancel_quant,
        winstt::commands::download::delete_model_quantization,
        winstt::commands::download::delete_model_cache,
        winstt::commands::runtime::get_runtime_info,
        winstt::commands::runtime::stt_list_models_with_state,
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
        winstt::commands::context::context_list_apps,
        winstt::commands::tts::tts_set_speed,
        winstt::commands::tts::tts_pause_playback,
        winstt::commands::tts::tts_resume_playback,
        winstt::commands::tts::tts_report_playback_started,
        winstt::commands::tts::tts_report_playback_ended,
        winstt::commands::ollama_library::ollama_refresh_library,
        winstt::commands::ollama_library::ollama_refresh_tags,
        winstt::commands::ollama_library::ollama_search_library,
        winstt::commands::ollama_pull::ollama_cancel_pull,
        winstt::commands::ollama_pull::llm_warmup_status,
        winstt::commands::ollama_pull::llm_retry_warmup,
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
        // Debug-only raw context playground surface. These command ids stay in the
        // stable registry for binding compatibility, but the command bodies
        // return/no-op without reading UIA data in release builds unless the
        // explicit `context-playground` Cargo feature is enabled.
        winstt::commands::context_playground::context_playground_set_live,
        winstt::commands::context_playground::context_playground_arm_deep,
        winstt::commands::context_playground::context_playground_capture,
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

    builder.events(collect_events![
        managers::history::HistoryUpdatePayload,
        winstt::commands::events::RealtimeUpdatePayload,
    ])
}

#[cfg(test)]
mod command_registry_tests {
    use regex::Regex;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::{Path, PathBuf};

    const INTENTIONAL_COMMAND_EXCLUSIONS: &[(&str, &str)] = &[(
        "winstt::commands::context::debug_read_context",
        "debug-only context probe; keep it off the normal registry instead of exposing raw snapshots",
    )];

    #[test]
    fn tauri_command_definitions_are_registered_or_explicitly_excluded() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let source_dir = manifest_dir.join("src");
        let registry_source = fs::read_to_string(source_dir.join("commands_registry.rs"))
            .expect("commands_registry.rs should be readable");
        let registered = registered_command_paths(&registry_source);
        let exclusions = intentional_exclusions();

        let mut missing = Vec::new();
        let mut seen_exclusions = BTreeSet::new();

        for file in rust_files(&source_dir) {
            let source = fs::read_to_string(&file)
                .unwrap_or_else(|err| panic!("{} should be readable: {err}", file.display()));
            let relative = relative_source_path(&source_dir, &file);
            for (line, name) in command_names_in_source(&source) {
                let registry_path =
                    expected_registry_path(&relative, &name).unwrap_or_else(|err| panic!("{err}"));
                if exclusions.contains(registry_path.as_str()) {
                    seen_exclusions.insert(registry_path.clone());
                } else if !registered.contains(registry_path.as_str()) {
                    missing.push(format!("{relative}:{line} -> {registry_path}"));
                }
            }
        }

        let stale_exclusions: Vec<_> = exclusions
            .iter()
            .filter(|path| !seen_exclusions.contains(**path))
            .copied()
            .collect();

        assert!(
            missing.is_empty() && stale_exclusions.is_empty(),
            "{}{}",
            if missing.is_empty() {
                String::new()
            } else {
                format!(
                    "Tauri commands missing from collect_commands![]:\n{}\nAdd them to src/commands_registry.rs or add an intentional exclusion with a reason.\n",
                    missing.join("\n")
                )
            },
            if stale_exclusions.is_empty() {
                String::new()
            } else {
                format!(
                    "Stale command registry exclusions:\n{}\nRemove exclusions when commands are removed or registered.\n",
                    stale_exclusions.join("\n")
                )
            }
        );
    }

    fn intentional_exclusions() -> BTreeSet<&'static str> {
        INTENTIONAL_COMMAND_EXCLUSIONS
            .iter()
            .map(|(path, reason)| {
                assert!(
                    !reason.trim().is_empty(),
                    "command registry exclusions need a reason"
                );
                *path
            })
            .collect()
    }

    fn rust_files(source_dir: &Path) -> Vec<PathBuf> {
        fn visit(dir: &Path, files: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(dir)
                .unwrap_or_else(|err| panic!("{} should be readable: {err}", dir.display()))
            {
                let path = entry.expect("directory entry should be readable").path();
                if path.is_dir() {
                    visit(&path, files);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    files.push(path);
                }
            }
        }

        let mut files = Vec::new();
        visit(source_dir, &mut files);
        files.sort();
        files
    }

    fn command_names_in_source(source: &str) -> Vec<(usize, String)> {
        let command_re = Regex::new(
            r"(?ms)#\s*\[\s*tauri::command[^\]]*\]\s*(?:#\s*\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)",
        )
        .expect("command regex should compile");

        command_re
            .captures_iter(source)
            .map(|captures| {
                let full = captures.get(0).expect("full command match");
                let line = source[..full.start()].lines().count() + 1;
                let name = captures.get(1).expect("command name").as_str().to_owned();
                (line, name)
            })
            .collect()
    }

    fn registered_command_paths(registry_source: &str) -> BTreeSet<String> {
        let command_path_re =
            Regex::new(r"(?m)^\s*([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)\s*,")
                .expect("registered command regex should compile");
        command_path_re
            .captures_iter(collect_commands_macro_body(registry_source))
            .map(|captures| captures[1].to_owned())
            .collect()
    }

    fn collect_commands_macro_body(source: &str) -> &str {
        let start = source
            .find("collect_commands![")
            .expect("commands_registry.rs should contain collect_commands![]")
            + "collect_commands![".len();
        let mut depth = 1usize;
        for (offset, ch) in source[start..].char_indices() {
            match ch {
                '[' => depth += 1,
                ']' => {
                    depth -= 1;
                    if depth == 0 {
                        return &source[start..start + offset];
                    }
                }
                _ => {}
            }
        }
        panic!("collect_commands![] should have a closing bracket");
    }

    fn expected_registry_path(source: &str, name: &str) -> Result<String, String> {
        let maybe_module = |prefix: &str| {
            source
                .strip_prefix(prefix)
                .and_then(|path| path.strip_suffix(".rs"))
                .map(|path| path.replace('/', "::"))
        };

        match source {
            "src/commands_registry.rs" => Ok(name.to_string()),
            "src/tray.rs" => Ok(format!("tray::{name}")),
            "src/helpers/clamshell.rs" => Ok(format!("helpers::clamshell::{name}")),
            "src/shortcut/mod.rs" => Ok(format!("shortcut::{name}")),
            "src/commands/mod.rs" => Ok(format!("commands::{name}")),
            _ if source.starts_with("src/shortcut/") => {
                let module = maybe_module("src/shortcut/").ok_or_else(|| {
                    format!("{source} should be under src/shortcut/ and end with .rs")
                })?;
                match module.as_str() {
                    "accelerator_commands" | "post_process_commands" | "settings_commands" => {
                        Ok(format!("shortcut::{name}"))
                    }
                    _ => Ok(format!("shortcut::{module}::{name}")),
                }
            }
            _ if source.starts_with("src/commands/") => {
                let module = maybe_module("src/commands/").ok_or_else(|| {
                    format!("{source} should be under src/commands/ and end with .rs")
                })?;
                Ok(format!("commands::{module}::{name}"))
            }
            _ if source.starts_with("src/winstt/commands/") => {
                let module_path = maybe_module("src/winstt/commands/").ok_or_else(|| {
                    format!("{source} should be under src/winstt/commands/ and end with .rs")
                })?;
                if module_path == "mod" {
                    Ok(format!("winstt::commands::{name}"))
                } else {
                    Ok(format!("winstt::commands::{module_path}::{name}"))
                }
            }
            _ => Err(format!(
                "No command registry path mapping for {source}. Add a mapping before defining #[tauri::command] there."
            )),
        }
    }

    fn relative_source_path(source_dir: &Path, file: &Path) -> String {
        let relative = file
            .strip_prefix(
                source_dir
                    .parent()
                    .expect("source dir should have a parent"),
            )
            .expect("source file should be under manifest dir");
        relative.to_string_lossy().replace('\\', "/")
    }
}
