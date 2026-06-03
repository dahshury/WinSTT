mod actions;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod apple_intelligence;
mod audio_feedback;
pub mod audio_toolkit;
pub mod cli;
mod clipboard;
mod commands;
mod helpers;
mod input;
mod llm_client;
mod managers;
mod overlay;
pub mod portable;
mod settings;
mod shortcut;
mod signal_handle;
mod splash;
mod transcription_coordinator;
mod tray;
mod utils;
pub mod winstt;

pub use cli::CliArgs;
#[cfg(debug_assertions)]
use specta_typescript::{BigIntExportBehavior, Typescript};
use tauri_specta::{collect_commands, collect_events, Builder};

use env_filter::Builder as EnvFilterBuilder;
use managers::audio::AudioRecordingManager;
use managers::history::HistoryManager;
use managers::model::ModelManager;
use managers::transcription::TranscriptionManager;
#[cfg(unix)]
use signal_hook::consts::{SIGUSR1, SIGUSR2};
#[cfg(unix)]
use signal_hook::iterator::Signals;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use tauri::image::Image;
pub use transcription_coordinator::TranscriptionCoordinator;

use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_log::{Builder as LogBuilder, RotationStrategy, Target, TargetKind};

use crate::settings::get_settings;

// Global atomic to store the file log level filter
// We use u8 to store the log::LevelFilter as a number
pub static FILE_LOG_LEVEL: AtomicU8 = AtomicU8::new(log::LevelFilter::Debug as u8);

fn level_filter_from_u8(value: u8) -> log::LevelFilter {
    match value {
        0 => log::LevelFilter::Off,
        1 => log::LevelFilter::Error,
        2 => log::LevelFilter::Warn,
        3 => log::LevelFilter::Info,
        4 => log::LevelFilter::Debug,
        5 => log::LevelFilter::Trace,
        _ => log::LevelFilter::Trace,
    }
}

fn build_console_filter() -> env_filter::Filter {
    let mut builder = EnvFilterBuilder::new();

    match std::env::var("RUST_LOG") {
        Ok(spec) if !spec.trim().is_empty() => {
            if let Err(err) = builder.try_parse(&spec) {
                log::warn!(
                    "Ignoring invalid RUST_LOG value '{}': {}. Falling back to info-level console logging",
                    spec,
                    err
                );
                builder.filter_level(log::LevelFilter::Info);
            }
        }
        _ => {
            builder.filter_level(log::LevelFilter::Info);
        }
    }

    builder.build()
}

fn show_main_window(app: &AppHandle) {
    // Hand off from the splash: the real window is about to be visible. Idempotent
    // and a no-op if the page-load handler already closed it (mirrors the reference's
    // showOnce → closeSplashWindow).
    splash::close_splash_window(app);
    if let Some(main_window) = app.get_webview_window("main") {
        if let Err(e) = main_window.unminimize() {
            log::error!("Failed to unminimize webview window: {}", e);
        }
        if let Err(e) = main_window.show() {
            log::error!("Failed to show webview window: {}", e);
        }
        // Force the pill ABOVE every other app's window. On Windows `set_focus()`
        // alone is unreliable when another process owns the foreground
        // (SetForegroundWindow is restricted to the foreground-owning process), so
        // the window comes up *behind* whatever the user was typing into — the
        // reported "doesn't get above the others" bug. Briefly toggling
        // always-on-top reliably raises it; the pill isn't an always-on-top window,
        // so we drop the flag again immediately after.
        #[cfg(target_os = "windows")]
        {
            let _ = main_window.set_always_on_top(true);
            let _ = main_window.set_always_on_top(false);
        }
        if let Err(e) = main_window.set_focus() {
            log::error!("Failed to focus webview window: {}", e);
        }
        #[cfg(target_os = "macos")]
        {
            if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
                log::error!("Failed to set activation policy to Regular: {}", e);
            }
        }
        return;
    }

    let webview_labels = app.webview_windows().keys().cloned().collect::<Vec<_>>();
    log::error!(
        "Main window not found. Webview labels: {:?}",
        webview_labels
    );
}

#[allow(unused_variables)]
fn should_force_show_permissions_window(app: &AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        let model_manager = app.state::<Arc<ModelManager>>();
        let has_downloaded_models = model_manager
            .get_available_models()
            .iter()
            .any(|model| model.is_downloaded);

        if !has_downloaded_models {
            return false;
        }

        let status = commands::audio::get_windows_microphone_permission_status();
        if status.supported && status.overall_access == commands::audio::PermissionAccess::Denied {
            log::info!(
                "Windows microphone permissions are denied; forcing main window visible for onboarding"
            );
            return true;
        }
    }

    false
}

fn initialize_core_logic(app_handle: &AppHandle) {
    // Note: Enigo (keyboard/mouse simulation) is NOT initialized here.
    // The frontend is responsible for calling the `initialize_enigo` command
    // after onboarding completes. This avoids triggering permission dialogs
    // on macOS before the user is ready.

    // Initialize the managers
    let recording_manager = Arc::new(
        AudioRecordingManager::new(app_handle).expect("Failed to initialize recording manager"),
    );
    let model_manager =
        Arc::new(ModelManager::new(app_handle).expect("Failed to initialize model manager"));
    let transcription_manager = Arc::new(
        TranscriptionManager::new(app_handle, model_manager.clone())
            .expect("Failed to initialize transcription manager"),
    );
    let history_manager =
        Arc::new(HistoryManager::new(app_handle).expect("Failed to initialize history manager"));

    // Apply accelerator preferences before any model loads
    managers::transcription::apply_accelerator_settings(app_handle);

    // Add managers to Tauri's managed state
    app_handle.manage(recording_manager.clone());
    app_handle.manage(model_manager.clone());
    app_handle.manage(transcription_manager.clone());
    app_handle.manage(history_manager.clone());

    // Pre-warm the Silero VAD + audio recorder OFF the PTT press path. Neither
    // WinSTT nor upstream Handy preloads this, so the COLD first push-to-talk
    // otherwise pays the Silero ONNX load + recorder construction synchronously
    // inside `start_microphone_stream` (~50-200ms) before the recording chime
    // fires — the "warmup feels slow" the user reported. This only loads the
    // model + builds the recorder; it does NOT open the mic stream, so on-demand
    // privacy (mic stays closed until a real press) is preserved. Off-thread so
    // setup isn't blocked; `preload_vad` is idempotent (the press-path call then
    // no-ops).
    {
        let rm = recording_manager.clone();
        std::thread::spawn(move || {
            if let Err(e) = rm.preload_vad() {
                log::debug!("Startup VAD pre-load failed: {e}");
            }
        });
    }

    // Seed WinSTT settings defaults BEFORE managers read them (first-run materialization).
    winstt::commands::settings::seed_defaults(app_handle);

    // Point the TTS phonemizer at the BUNDLED espeak-ng (src-tauri/resources/espeakng_loader/,
    // shipped via tauri.conf `resources/**/*`) for PACKAGED builds — the in-process FFI resolver
    // (phonemize.rs::resolve_espeak_lib) reads ESPEAK_NG_LIBRARY first and finds espeak-ng-data as
    // the lib's sibling. Dev already resolves the %LOCALAPPDATA% extraction, so this only fills the
    // shipping gap; best-effort — if the resource isn't present we leave it to the resolver's tiers.
    if std::env::var_os("ESPEAK_NG_LIBRARY").is_none() {
        if let Ok(res_dir) = app_handle.path().resource_dir() {
            let lib = res_dir.join("resources/espeakng_loader/espeak-ng.dll");
            if lib.exists() {
                std::env::set_var("ESPEAK_NG_LIBRARY", &lib);
                log::info!("[tts] using bundled espeak-ng at {}", lib.display());
            }
        }
    }

    // ── WinSTT managers (lib_wiring.md §2) ──
    {
        use crate::winstt::managers::{
            CloudSttManager, ContextManager, DiarizationManager, DownloadManager,
            FileTranscribeManager, LlmManager, LoopbackManager, RealtimeManager, TtsManager,
            WakeWordManager, WordAligner,
        };
        let llm_manager = Arc::new(LlmManager::new(app_handle));
        app_handle.manage(llm_manager.clone());
        app_handle.manage(Arc::new(CloudSttManager::new(app_handle)));
        app_handle.manage(Arc::new(ContextManager::new(app_handle)));
        let tts_manager = Arc::new(TtsManager::new(app_handle));
        tts_manager.start_idle_watcher();
        app_handle.manage(tts_manager);
        app_handle.manage(Arc::new(WakeWordManager::new(app_handle)));
        app_handle.manage(Arc::new(DiarizationManager::new(app_handle)));
        app_handle.manage(Arc::new(LoopbackManager::new(app_handle)));
        app_handle.manage(Arc::new(WordAligner::new(
            app_handle,
            model_manager.clone(),
        )));
        app_handle.manage(Arc::new(FileTranscribeManager::new(
            app_handle,
            transcription_manager.clone(),
        )));
        // C4 fix: DownloadManager MUST be managed or the 6 download commands panic on State injection.
        app_handle.manage(Arc::new(DownloadManager::new(app_handle)));
        // Multi-provider TTS catalog download manager (Kitten/Piper/Supertonic/Kokoro
        // from HF) — backs the tts_predownload_model / pause / resume / cancel / delete
        // commands + the picker's per-model cache state.
        app_handle.manage(Arc::new(
            crate::winstt::managers::tts_download_manager::TtsDownloadManager::new(app_handle),
        ));
        {
            let settings = winstt::commands::settings::read_settings(app_handle);
            if winstt::commands::settings::should_warm_tts(&settings) {
                winstt::commands::settings::warm_tts_async(app_handle);
            }
        }
        llm_manager.start_warmup_loop();

        // ── Realtime streaming transcription worker ──
        // Reuses the MAIN transcription engine (single-engine port — no separate realtime
        // engine) + the recording manager's live-audio mirror. Spawn the daemon thread ONCE
        // here (like the idle-unload watcher); it idles cheaply unless a recording is active
        // AND effective-realtime is enabled.
        let realtime_manager = Arc::new(RealtimeManager::new(
            app_handle.clone(),
            transcription_manager.clone(),
            recording_manager.clone(),
        ));
        realtime_manager.start();
        app_handle.manage(realtime_manager);
    }
    // If the persisted WinSTT mode is wakeword, arm the detector and open the
    // microphone stream during startup. The renderer treats wakeword as
    // server-driven, so this backend sync is the only place that can make a cold
    // launch start listening.
    winstt::commands::settings::sync_wakeword_runtime_from_settings(app_handle);

    // Tray-menu placement state + the custom-HTML-tray + history live-event bridge.
    app_handle.manage(crate::winstt::commands::tray_menu::TrayMenuAnchor::default());
    // Hotkey combo-recorder state. hotkey_start_recording/stop + the per-key
    // translation all do `app.try_state::<CaptureBridge>()` — without managing it here
    // that returns None, so the capture listener is never installed and pressing keys
    // during a hotkey rebind records NOTHING. (This is why "changing a hotkey doesn't
    // record the keys".) Must be managed before hotkey_start_recording runs.
    app_handle.manage(crate::winstt::commands::hotkey::CaptureBridge::default());
    // Preview-before-pasting: holds the foreground (paste-target) HWND captured
    // when the editable preview pill opens, so `confirm_paste` can restore it
    // before pasting. Managed here so `capture_foreground` / `confirm_paste` /
    // `cancel_preview` find it via `app.try_state::<PreviewState>()`.
    app_handle.manage(crate::winstt::commands::preview::PreviewState::default());
    winstt::commands::history::install_history_event_bridge(app_handle);
    winstt::commands::tray_menu::install_tray_menu_lifecycle(app_handle);
    // Snippet expansion cache: warm at startup + rebuild on every settings:changed.
    winstt::commands::snippets::install_snippet_reload_bridge(app_handle);
    // Wakeword → dictation: a wake_word_detected hit (emitted by WakeWordManager.feed_chunk
    // off the live mic tap) starts one dictation cycle, exactly like a toggle-press.
    {
        use tauri::Listener;
        let app_for_ww = app_handle.clone();
        app_handle.listen("wake_word_detected", move |_event| {
            crate::actions::start_dictation_from_wakeword(&app_for_ww);
        });
    }

    // Note: Shortcuts are NOT initialized here.
    // The frontend is responsible for calling the `initialize_shortcuts` command
    // after permissions are confirmed (on macOS) or after onboarding completes.
    // This matches the pattern used for Enigo initialization.

    #[cfg(unix)]
    let signals = Signals::new(&[SIGUSR1, SIGUSR2]).unwrap();
    // Set up signal handlers for toggling transcription
    #[cfg(unix)]
    signal_handle::setup_signal_handler(app_handle.clone(), signals);

    // Windows: shut down cleanly on Ctrl+C / console-close so `tauri dev` exits with code 0
    // and no WebView2 teardown noise (no STATUS_CONTROL_C_EXIT, no `window_impl.cc` warning,
    // no `^C^C` race). See the handler doc for why this is a hard exit, not app.exit(0).
    #[cfg(windows)]
    signal_handle::setup_windows_ctrl_handler();

    // Apply macOS Accessory policy if starting hidden and tray is available.
    // If the tray icon is disabled, keep the dock icon so the user can reopen.
    #[cfg(target_os = "macos")]
    {
        let settings = settings::get_settings(app_handle);
        if settings.start_hidden && settings.show_tray_icon {
            let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    }
    // Get the current theme to set the appropriate initial icon
    let initial_theme = tray::get_current_theme(app_handle);

    // Choose the appropriate initial icon based on theme
    let initial_icon_path = tray::get_icon_path(initial_theme, tray::TrayIconState::Idle);

    let tray = TrayIconBuilder::new()
        .icon(
            Image::from_path(
                app_handle
                    .path()
                    .resolve(initial_icon_path, tauri::path::BaseDirectory::Resource)
                    .unwrap(),
            )
            .unwrap(),
        )
        .tooltip(tray::tray_tooltip())
        .icon_as_template(true)
        // WinSTT uses its OWN transparent HTML tray menu (views/tray-menu), NOT Handy's
        // native OS context menu (the user's complaint: "tray menu matches Handy not my
        // the reference menu"). No native menu is attached (see tray.rs::update_tray_menu).
        //
        // Click routing mirrors the reference tray (electron/ipc/tray.ts):
        //   - LEFT click / DOUBLE click → show + raise the main window
        //     (`tray.on("click", () => win.show())`).
        //   - RIGHT click → toggle the custom HTML tray menu at the cursor
        //     (`tray.on("right-click", … showTrayMenuAt)`).
        // Previously ANY click toggled the menu, so a left/double-click popped the menu
        // instead of showing the app — the reported bug.
        .on_tray_icon_event(|tray_handle, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    show_main_window(tray_handle.app_handle());
                }
                TrayIconEvent::Click {
                    button: MouseButton::Right,
                    button_state: MouseButtonState::Up,
                    position,
                    ..
                } => {
                    crate::winstt::commands::tray_menu::toggle_tray_menu_at_physical(
                        tray_handle.app_handle(),
                        position.x,
                        position.y,
                    );
                }
                _ => {}
            }
        })
        .build(app_handle)
        .unwrap();
    app_handle.manage(tray);

    // Initialize tray menu with idle state
    utils::update_tray_menu(app_handle, &utils::TrayIconState::Idle, None);

    // Apply show_tray_icon setting
    let settings = settings::get_settings(app_handle);
    if !settings.show_tray_icon {
        tray::set_tray_visibility(app_handle, false);
    }

    // Refresh tray menu when model state changes
    let app_handle_for_listener = app_handle.clone();
    app_handle.listen("model-state-changed", move |_| {
        tray::update_tray_menu(&app_handle_for_listener, &tray::TrayIconState::Idle, None);
    });

    // Get the autostart manager and configure based on user setting
    let autostart_manager = app_handle.autolaunch();
    let settings = settings::get_settings(app_handle);

    if settings.autostart_enabled {
        // Enable autostart if user has opted in
        let _ = autostart_manager.enable();
    } else {
        // Disable autostart if user has opted out
        let _ = autostart_manager.disable();
    }

    // AUDIT #9: Handy's separate `recording_overlay` window is no longer created — the
    // WinSTT recording pill is the React `overlay` WebviewWindow, and every show path
    // already redirected to it (see overlay.rs). The old window could never appear yet
    // still received per-frame mic levels no renderer listened to.

    // Eagerly load + WARM the STT engine at boot so the user's FIRST PTT decode is warm — no
    // model-load + cold DirectML-kernel JIT serialized after release (the ~10x first-dictation
    // gap vs the reference app, whose server warms at boot). Off-thread so setup isn't blocked;
    // `initiate_model_load` is idempotent (a later PTT-press load is a no-op) and `warmup` skips
    // cleanly for cloud ids / failed loads. Mirrors the reference server's boot `recorder.warmup()`.
    {
        let tm = transcription_manager.clone();
        std::thread::spawn(move || {
            tm.initiate_model_load(); // spawns its own background load thread
            tm.warmup(); // waits out that load, then dummy-decodes to compile kernels
                         // Signal the splash ready-watcher that the backend is up + warm (or had
                         // nothing to load). The single-process analog of the reference's
                         // `server-ready`; one of the two gates before the pill is shown.
            splash::mark_stt_boot_done();
        });
    }
}

#[tauri::command]
#[specta::specta]
fn trigger_update_check(app: AppHandle) -> Result<(), String> {
    let settings = settings::get_settings(&app);
    if !settings.update_checks_enabled {
        return Ok(());
    }
    app.emit("check-for-updates", ())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn show_main_window_command(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

/// Build the tauri-specta `Builder` with the full command + event registry.
/// Single source of truth for both `run()` (which mounts it on the live app) and
/// the `export_bindings` test (which calls `.export(...)` without starting the app).
pub fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            shortcut::change_binding,
            shortcut::reset_binding,
            shortcut::change_ptt_setting,
            shortcut::change_audio_feedback_setting,
            shortcut::change_audio_feedback_volume_setting,
            shortcut::change_sound_theme_setting,
            shortcut::change_start_hidden_setting,
            shortcut::change_autostart_setting,
            shortcut::change_translate_to_english_setting,
            shortcut::change_selected_language_setting,
            shortcut::change_overlay_position_setting,
            shortcut::change_debug_mode_setting,
            shortcut::change_word_correction_threshold_setting,
            shortcut::change_extra_recording_buffer_setting,
            shortcut::change_paste_delay_ms_setting,
            shortcut::change_paste_method_setting,
            shortcut::get_available_typing_tools,
            shortcut::change_typing_tool_setting,
            shortcut::change_external_script_path_setting,
            shortcut::change_clipboard_handling_setting,
            shortcut::change_auto_submit_setting,
            shortcut::change_auto_submit_key_setting,
            shortcut::change_post_process_enabled_setting,
            shortcut::change_experimental_enabled_setting,
            shortcut::change_post_process_base_url_setting,
            shortcut::change_post_process_api_key_setting,
            shortcut::change_post_process_model_setting,
            shortcut::set_post_process_provider,
            shortcut::fetch_post_process_models,
            shortcut::add_post_process_prompt,
            shortcut::update_post_process_prompt,
            shortcut::delete_post_process_prompt,
            shortcut::set_post_process_selected_prompt,
            shortcut::update_custom_words,
            shortcut::suspend_binding,
            shortcut::resume_binding,
            shortcut::change_mute_while_recording_setting,
            shortcut::change_append_trailing_space_setting,
            shortcut::change_lazy_stream_close_setting,
            shortcut::change_app_language_setting,
            shortcut::change_update_checks_setting,
            shortcut::change_keyboard_implementation_setting,
            shortcut::get_keyboard_implementation,
            shortcut::change_show_tray_icon_setting,
            shortcut::change_whisper_accelerator_setting,
            shortcut::change_ort_accelerator_setting,
            shortcut::change_whisper_gpu_device,
            shortcut::get_available_accelerators,
            shortcut::handy_keys::start_handy_keys_recording,
            shortcut::handy_keys::stop_handy_keys_recording,
            trigger_update_check,
            show_main_window_command,
            tray::copy_last_transcript,
            commands::cancel_operation,
            commands::is_portable,
            commands::get_app_dir_path,
            commands::get_app_settings,
            commands::get_default_settings,
            commands::get_log_dir_path,
            commands::set_log_level,
            commands::open_recordings_folder,
            commands::open_log_dir,
            commands::open_app_data_dir,
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
            commands::audio::update_microphone_mode,
            commands::audio::get_microphone_mode,
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
            commands::history::update_history_limit,
            commands::history::update_recording_retention_period,
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
            winstt::commands::listen::start_listen,
            winstt::commands::listen::stop_listen,
            winstt::commands::wordts::align_words,
            winstt::commands::file_transcribe::file_transcribe_enqueue,
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
            winstt::commands::loopback::loopback_list_devices,
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
            winstt::commands::about::about_get_app_info,
            winstt::commands::about::about_get_license,
            winstt::commands::about::about_get_notices,
            winstt::commands::diag::diag_open_logs_folder,
            winstt::commands::diag::diag_save_bundle,
            winstt::commands::sound::sound_library_add,
            winstt::commands::sound::sound_library_read_file,
            winstt::commands::sound::sound_library_remove,
            winstt::commands::transforms::apply_transform,
            winstt::commands::transforms::apply_transform_preview,
            winstt::commands::preview::confirm_paste,
            winstt::commands::preview::cancel_preview,
            winstt::commands::windows::winstt_diag,
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
            winstt::commands::context_playground::context_playground_set_live,
            winstt::commands::context_playground::context_playground_arm_deep,
            winstt::commands::context_playground::context_playground_capture,
        ])
        .events(collect_events![
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

/// Point hf-hub at the standard Hugging Face cache when the user hasn't set one.
///
/// hf-hub 1.0.0-rc.1 resolves its cache dir from `$HOME` only (see
/// `hf_hub::constants::dirs_or_home`): it ignores Windows' `%USERPROFILE%` and
/// falls back to `/tmp` when `HOME` is unset. A packaged `WinSTT.exe` launched
/// from Explorer inherits no `HOME`, so every `HFClient::new()` resolves the
/// model cache to `<cwd-drive>:\tmp\.cache\huggingface\hub` — an empty dir — and
/// the app "can't see" models already downloaded under
/// `%USERPROFILE%\.cache\huggingface\hub`. `tauri dev`, launched from a shell
/// that exports `HOME`, never hits this, which is why dev finds the models and a
/// double-clicked build doesn't.
///
/// Set `HF_HOME` to the same location Python's `huggingface_hub` uses on Windows
/// (`%USERPROFILE%/.cache/huggingface`) whenever the user hasn't configured the
/// cache themselves — leaving any explicit `HF_HOME` / `HF_HUB_CACHE` /
/// `HUGGINGFACE_HUB_CACHE`, or a shell-provided `HOME`, untouched.
#[cfg(windows)]
fn ensure_hf_cache_env() {
    let configured = std::env::var_os("HF_HOME").is_some()
        || std::env::var_os("HF_HUB_CACHE").is_some()
        || std::env::var_os("HUGGINGFACE_HUB_CACHE").is_some()
        // A shell-provided HOME already yields the correct cache (this is how
        // `tauri dev` finds the models), so don't override it.
        || std::env::var_os("HOME").is_some();
    if configured {
        return;
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let hf_home = std::path::Path::new(&profile)
            .join(".cache")
            .join("huggingface");
        eprintln!(
            "[hf-cache] HOME unset; pointing HF_HOME at {}",
            hf_home.display()
        );
        std::env::set_var("HF_HOME", hf_home);
    }
}

/// No-op on non-Windows: `$HOME` is always set there, so hf-hub resolves the
/// cache correctly without help.
#[cfg(not(windows))]
fn ensure_hf_cache_env() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(cli_args: CliArgs) {
    // Detect portable mode before anything else
    portable::init();

    // Make a double-clicked build resolve the same HF model cache as `tauri dev`
    // (hf-hub reads $HOME only and falls back to /tmp on Windows without it).
    ensure_hf_cache_env();

    // Parse console logging directives from RUST_LOG, falling back to info-level logging
    // when the variable is unset
    let console_filter = build_console_filter();

    let specta_builder = make_specta_builder();

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    specta_builder
        .export(
            Typescript::default().bigint(BigIntExportBehavior::Number),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    let invoke_handler = specta_builder.invoke_handler();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .device_event_filter(tauri::DeviceEventFilter::Always)
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            LogBuilder::new()
                .level(log::LevelFilter::Trace) // Set to most verbose level globally
                .max_file_size(500_000)
                .rotation_strategy(RotationStrategy::KeepOne)
                .clear_targets()
                .targets([
                    // Console output respects RUST_LOG environment variable
                    Target::new(TargetKind::Stdout).filter({
                        let console_filter = console_filter.clone();
                        move |metadata| console_filter.enabled(metadata)
                    }),
                    // File logs respect the user's settings (stored in FILE_LOG_LEVEL atomic)
                    Target::new(if let Some(data_dir) = portable::data_dir() {
                        TargetKind::Folder {
                            path: data_dir.join("logs"),
                            file_name: Some("handy".into()),
                        }
                    } else {
                        TargetKind::LogDir {
                            file_name: Some("handy".into()),
                        }
                    })
                    .filter(|metadata| {
                        let file_level = FILE_LOG_LEVEL.load(Ordering::Relaxed);
                        metadata.level() <= level_filter_from_u8(file_level)
                    }),
                ])
                .build(),
        );

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--toggle-transcription") {
                signal_handle::send_transcription_input(app, "transcribe", "CLI");
            } else if args.iter().any(|a| a == "--toggle-post-process") {
                signal_handle::send_transcription_input(app, "transcribe_with_post_process", "CLI");
            } else if args.iter().any(|a| a == "--cancel") {
                crate::utils::cancel_current_operation(app);
            } else {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .manage(cli_args.clone())
        .setup(move |app| {
            specta_builder.mount_events(app);

            // Global panic hook → the file log. The log plugin's logger is installed by now, so
            // this captures EVERY panic (thread name + location + payload) even when a
            // `catch_unwind` later swallows it (the hook runs first, before unwinding). Without
            // it, a panic on a worker thread — the audio recorder pump, the hotkey dispatch, a
            // model-load thread — left no trace and was the kind of silent fault that wedged the
            // PTT pipeline. Chains the previous hook so the default stderr message is preserved.
            {
                let prev_hook = std::panic::take_hook();
                std::panic::set_hook(Box::new(move |info| {
                    let thread = std::thread::current();
                    let name = thread.name().unwrap_or("<unnamed>");
                    let location = info
                        .location()
                        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                        .unwrap_or_else(|| "<unknown location>".to_string());
                    let payload = info
                        .payload()
                        .downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| info.payload().downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "<non-string panic payload>".to_string());
                    log::error!("[panic] thread '{name}' at {location}: {payload}");
                    prev_hook(info);
                }));
            }

            // Show the startup splash the instant setup begins — BEFORE the slow
            // path (initialize_core_logic + prewarm_windows building all 8
            // secondary WebView2 windows + Enigo init) and before the main pill
            // paints. Ported from the reference in-app splash (splash-window.ts);
            // closed by the main window's on_page_load(Finished) below (with a
            // 30 s backstop inside create_splash_window).
            let app_handle_for_splash = app.handle().clone();
            if !cli_args.start_hidden {
                splash::create_splash_window(&app_handle_for_splash);
            }

            // Create main window programmatically so we can set data_directory
            // for portable mode (redirects WebView2 cache to portable Data dir)
            // WinSTT main window: 420x150 frameless floating pill (windows.rs WINDOW_SPECS[main]).
            let mut win_builder =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("/".into()))
                    .title("WinSTT")
                    .inner_size(420.0, 150.0)
                    .min_inner_size(420.0, 150.0)
                    .resizable(false)
                    .decorations(false)
                    .maximizable(false)
                    // Record that the renderer has PAINTED — one of the two signals
                    // the splash ready-watcher waits on before handing off to the
                    // real window (the reference `did-finish-load` half of its
                    // `showOnce` gate). Do NOT close the splash here: the watcher
                    // also waits for the STT boot to finish, then shows the pill +
                    // closes the splash in one handoff.
                    .on_page_load(move |_w, payload| {
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            splash::mark_renderer_painted();
                        }
                    })
                    .visible(false);

            if let Some(data_dir) = portable::data_dir() {
                win_builder = win_builder.data_directory(data_dir.join("webview"));
            }

            win_builder.build()?;

            let mut settings = get_settings(app.handle());

            // CLI --debug flag overrides debug_mode and log level (runtime-only, not persisted)
            if cli_args.debug {
                settings.debug_mode = true;
                settings.log_level = settings::LogLevel::Trace;
            }

            let tauri_log_level: tauri_plugin_log::LogLevel = settings.log_level.into();
            let file_log_level: log::Level = tauri_log_level.into();
            // Store the file log level in the atomic for the filter to use
            FILE_LOG_LEVEL.store(file_log_level.to_level_filter() as u8, Ordering::Relaxed);
            let app_handle = app.handle().clone();
            app.manage(TranscriptionCoordinator::new(app_handle.clone()));

            initialize_core_logic(&app_handle);

            // Register the global hotkeys at startup. The WinSTT renderer (ported from the reference,
            // where shortcuts lived in main.ts) never calls `initialize_shortcuts`, so without this
            // the dictation/cancel hotkeys are NEVER registered and pressing them does nothing.
            // Must run BEFORE the transforms hook below so HandyKeysState is initialized first.
            crate::shortcut::init_shortcuts(&app_handle);

            // Initialize Enigo (keyboard simulation used to PASTE the transcription) at
            // startup. On macOS this needs accessibility permission so Handy left it to a
            // frontend `initialize_enigo` call — but the WinSTT renderer never makes that
            // call, so on Windows the paste pipeline failed with "Enigo state not
            // initialized" (dictation transcribed but never typed). No permission gate
            // exists off macOS, so initialize it directly here.
            #[cfg(not(target_os = "macos"))]
            match crate::input::EnigoState::new() {
                Ok(enigo_state) => {
                    app_handle.manage(enigo_state);
                    log::info!("Enigo initialized at startup (paste pipeline ready)");
                }
                Err(e) => log::warn!("Enigo init at startup failed: {e}"),
            }

            // WinSTT-tree global hotkeys: arm the transforms (`llm.transforms.hotkey`),
            // TTS read-aloud (`tts.hotkey`) and re-paste (`general.repasteHotkey`) combos
            // from the WinSTT settings tree. `init_shortcuts` above deliberately skips
            // these (their raw key names aren't parseable without translation), so this
            // single call is what makes them live — gated on each feature's enable flag,
            // and re-run on settings change (apply_settings_patch) so they hot-swap with
            // no relaunch. Mirrors the reference's setupTransformHotkeys / setupTtsHotkey /
            // setupRepasteHotkey, which all ran in main.ts at boot.
            crate::shortcut::reconcile_winstt_hotkeys(&app_handle);

            // Pre-warm GPU/accelerator enumeration on a background thread.
            // The first call into transcribe_rs::whisper_cpp::gpu::list_gpu_devices
            // loads the Metal/Vulkan backend and probes devices, which can take
            // several seconds. Without this, that cost is paid synchronously the
            // first time the user opens the Advanced settings page (which calls
            // the get_available_accelerators command), causing a UI freeze.
            // Result is cached in a OnceLock inside the transcription manager.
            std::thread::spawn(|| {
                let _ = crate::managers::transcription::get_available_accelerators();
            });

            // Hide tray icon if --no-tray was passed
            if cli_args.no_tray {
                tray::set_tray_visibility(&app_handle, false);
            }

            // Show main window only if not starting hidden.
            // CLI --start-hidden flag overrides the setting.
            // But if permission onboarding is required, always show the window.
            let should_hide = settings.start_hidden || cli_args.start_hidden;
            let should_force_show = should_force_show_permissions_window(&app_handle);

            // If start_hidden but tray is disabled, we must show the window
            // anyway. Without a tray icon, the dock is the only way back in.
            let tray_available = settings.show_tray_icon && !cli_args.no_tray;
            let will_show = should_force_show || !should_hide || !tray_available;

            // Hand off from the splash to the real window only once the app is READY.
            //
            // The previous code called `show_main_window` HERE, synchronously, inside
            // `setup`. Because `show_main_window` closes the splash first (the handoff),
            // and this runs before the event loop pumps, it tore the splash down at the
            // very start of boot — before the renderer painted and long before the STT
            // engine warmed — flashing a blank pill (the reported "splash killed early"
            // bug). The intended `on_page_load(Finished)` close could never win that race.
            //
            // Instead the ready-watcher (off the main thread) waits for BOTH the renderer
            // paint AND the STT boot (or a 15 s fallback), then shows the pill + closes the
            // splash in one handoff — mirroring the reference's gated `showOnce`
            // (did-finish-load + server-ready). When no splash exists (the `--start-hidden`
            // CLI flag skips its creation), fall back to the old immediate show.
            if splash::is_active(&app_handle) {
                splash::spawn_ready_watcher(&app_handle, will_show);
            } else if will_show {
                show_main_window(&app_handle);
            }

            // AUDIT #6: prewarm the secondary windows AFTER showing the pill so first
            // paint isn't blocked by building 8 WebView2 instances. `prewarm_windows`
            // builds `overlay` + `tray-menu` eagerly and defers the rest onto an idle
            // `run_on_main_thread` callback (still eager, just off the critical path —
            // NOT lazy-build-inside-open_window, which hangs on Windows). The webviews
            // must still be pre-built so `open_window` is a pure show().
            winstt::commands::windows::prewarm_windows(&app_handle);

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Closing the MAIN pill quits the whole app (the user expects X to close it,
                // not silently hide-to-tray — KEEP quit-on-X, do NOT hide-to-tray).
                //
                // AUDIT #18: route through `app.exit(0)` rather than `std::process::exit(0)`.
                // `app.exit(0)` runs Tauri's graceful shutdown (RunEvent::ExitRequested →
                // Exit) so the store plugin / history DB get a chance to flush — a raw
                // `process::exit` skipped all of that. A background thread (wakeword tap /
                // idle watcher / ORT) could in theory stall the graceful path, so a bounded
                // watchdog thread escalates to a hard `process::exit(0)` if the graceful exit
                // hasn't terminated the process within the deadline. Mirrors the reference
                // app.exit(0)+watchdog pattern. (No blocking joins are added to any Drop.)
                if window.label() == "main" {
                    log::info!("Main window closed — exiting.");
                    // Watchdog: if graceful shutdown stalls, force-terminate. 3 s is far
                    // longer than a healthy store/DB flush but short enough not to feel hung.
                    std::thread::spawn(|| {
                        std::thread::sleep(std::time::Duration::from_millis(3000));
                        log::warn!("Graceful exit stalled past 3s — forcing process exit.");
                        std::process::exit(0);
                    });
                    window.app_handle().exit(0);
                    return;
                }
                // Secondary windows (settings / pickers / overlay) just hide so the app keeps
                // running for the hotkey.
                api.prevent_close();

                // Native close of Settings (Alt+F4 etc.) bypasses close_self_window,
                // so route it through the same animated close helper.
                if window.label() == "settings" {
                    let _ = winstt::commands::windows::close_window(
                        window.app_handle().clone(),
                        "settings".into(),
                    );
                    return;
                }
                let _res = window.hide();

                #[cfg(target_os = "macos")]
                {
                    let settings = get_settings(&window.app_handle());
                    let tray_visible =
                        settings.show_tray_icon && !window.app_handle().state::<CliArgs>().no_tray;
                    if tray_visible {
                        // Tray is available: hide the dock icon, app lives in the tray
                        let res = window
                            .app_handle()
                            .set_activation_policy(tauri::ActivationPolicy::Accessory);
                        if let Err(e) = res {
                            log::error!("Failed to set activation policy: {}", e);
                        }
                    }
                    // No tray: keep the dock icon visible so the user can reopen
                }
            }
            tauri::WindowEvent::ThemeChanged(theme) => {
                log::info!("Theme changed to: {:?}", theme);
                // Update tray icon to match new theme, maintaining idle state
                utils::change_tray_icon(window.app_handle(), utils::TrayIconState::Idle);
            }
            _ => {}
        })
        .invoke_handler(invoke_handler)
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                show_main_window(app);
            }
            let _ = (app, event); // suppress unused warnings on non-macOS
        });
}

#[cfg(test)]
mod bindings_export_tests {
    use super::make_specta_builder;
    use specta_typescript::{BigIntExportBehavior, Typescript};

    /// Regenerates `src/bindings.ts` from the live command/event registry.
    /// Run `cargo test` to refresh it; CI re-runs this then `git diff --exit-code
    /// src/bindings.ts` asserts the checked-in file is up to date.
    #[test]
    fn export_bindings() {
        make_specta_builder()
            .export(
                Typescript::default().bigint(BigIntExportBehavior::Number),
                "../src/bindings.ts",
            )
            .expect("Failed to export typescript bindings");
    }
}
