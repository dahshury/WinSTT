mod actions;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod apple_intelligence;
mod audio_feedback;
pub mod audio_toolkit;
pub mod cli;
mod clipboard;
mod cloud_llm;
mod commands;
mod commands_registry;
mod helpers;
mod input;
mod llm_client;
mod managers;
pub mod portable;
mod settings;
mod shortcut;
mod signal_handle;
mod splash;
mod startup;
mod transcription_coordinator;
mod tray;
mod tray_indicator;
mod utils;
mod window_state;
#[cfg(windows)]
mod windows_com;
pub mod winstt;

pub use cli::CliArgs;
#[cfg(debug_assertions)]
use specta_typescript::{BigIntExportBehavior, Typescript};

use managers::audio::AudioRecordingManager;
use managers::history::HistoryManager;
use managers::model::ModelManager;
use managers::transcription::TranscriptionManager;
#[cfg(unix)]
use signal_hook::consts::{SIGUSR1, SIGUSR2};
#[cfg(unix)]
use signal_hook::iterator::Signals;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;
use tauri::image::Image;
pub use transcription_coordinator::TranscriptionCoordinator;

use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Listener, Manager};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_log::{Builder as LogBuilder, RotationStrategy, Target, TargetKind};

use crate::settings::get_settings;

// Re-export the boot-time + window-geometry + registry symbols at the crate root
// so external call sites keep their existing `crate::X` paths after the split.
pub use commands_registry::make_specta_builder;
pub use startup::FILE_LOG_LEVEL;
pub(crate) use startup::{log_startup_duration, startup_profile_enabled};
pub(crate) use window_state::show_main_window;

// Boot-time helpers used only inside this crate root (run / initialize_core_logic
// / the window-event handlers).
use startup::{
    build_console_filter, ensure_hf_cache_env, level_filter_from_u8, request_app_exit,
    wait_for_renderer_dev_server, StartupProfiler,
};
use window_state::{
    restore_main_window_position, save_main_window_position, should_force_show_permissions_window,
};

fn initialize_core_logic(app_handle: &AppHandle, startup: &mut StartupProfiler) {
    // Note: Enigo (keyboard/mouse simulation) is NOT initialized here.
    // The frontend is responsible for calling the `initialize_enigo` command
    // after onboarding completes. This avoids triggering permission dialogs
    // on macOS before the user is ready.

    // SINGLE-STORE: seed WinSTT settings defaults + run the one-time migration of
    // the legacy `settings_store.json` into the embedded `WinsttSettings.core`
    // BEFORE any manager reads settings. `crate::settings::get_settings` now derives
    // its `AppSettings` view from `core`, so this must run first or early readers
    // (e.g. `apply_accelerator_settings`) would see defaults instead of the
    // migrated user values.
    winstt::commands::settings::seed_defaults(app_handle);
    startup.mark("settings defaults seeded");

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
    startup.mark("core managers constructed");

    // Apply accelerator preferences before any model loads
    managers::transcription::apply_accelerator_settings(app_handle);

    // Add managers to Tauri's managed state
    app_handle.manage(recording_manager.clone());
    app_handle.manage(model_manager.clone());
    app_handle.manage(transcription_manager.clone());
    app_handle.manage(history_manager.clone());
    startup.mark("core managers registered");

    helpers::clamshell::install_lid_state_monitor(app_handle);
    startup.mark("lid monitor initialized");

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
        let profile_vad = startup_profile_enabled();
        std::thread::spawn(move || {
            let started = Instant::now();
            if let Err(e) = rm.preload_vad() {
                log::debug!("Startup VAD pre-load failed: {e}");
            }
            if profile_vad {
                log::info!(
                    "[startup] VAD preload thread completed: {} ms",
                    started.elapsed().as_millis()
                );
            }
        });
    }
    startup.mark("VAD preload scheduled");

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
        app_handle.manage(Arc::new(LoopbackManager::new(
            app_handle,
            transcription_manager.clone(),
        )));
        // Snippet expansion cache owner (warmed at startup + on settings:changed by
        // install_snippet_reload_bridge below). Must be managed before that bridge runs.
        app_handle.manage(Arc::new(crate::winstt::snippets::SnippetsManager::new(
            app_handle,
        )));
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
    startup.mark("WinSTT managers registered and warmups scheduled");
    // If the persisted WinSTT mode is wakeword, arm the detector and open the
    // microphone stream during startup. The renderer treats wakeword as
    // server-driven, so this backend sync is the only place that can make a cold
    // launch start listening.
    winstt::commands::settings::sync_wakeword_runtime_from_settings_in_background(app_handle);
    startup.mark("wakeword runtime sync scheduled");

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
    startup.mark("event bridges installed");

    // Note: Shortcuts are NOT initialized here.
    // The frontend is responsible for calling the `initialize_shortcuts` command
    // after permissions are confirmed (on macOS) or after onboarding completes.
    // This matches the pattern used for Enigo initialization.

    #[cfg(unix)]
    let signals = Signals::new([SIGUSR1, SIGUSR2]).unwrap();
    // Set up signal handlers for toggling transcription
    #[cfg(unix)]
    signal_handle::setup_signal_handler(app_handle.clone(), signals);

    // Windows: shut down cleanly on Ctrl+C / console-close so `tauri dev` exits with code 0
    // and no WebView2 teardown noise (no STATUS_CONTROL_C_EXIT, no `window_impl.cc` warning,
    // no `^C^C` race). See the handler doc for why this is a hard exit, not app.exit(0).
    #[cfg(windows)]
    signal_handle::setup_windows_ctrl_handler();
    startup.mark("signal handlers installed");

    // Apply macOS Accessory policy if starting hidden and tray is available.
    // If the tray icon is disabled, keep the dock icon so the user can reopen.
    #[cfg(target_os = "macos")]
    {
        let core_settings = settings::get_settings(app_handle);
        let settings = winstt::commands::settings::read_settings_raw(app_handle);
        if settings.general.start_minimized && core_settings.show_tray_icon {
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
    tray::sync_tray_visualizer_style_from_settings(app_handle);
    startup.mark("tray icon created");

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
    let settings = winstt::commands::settings::read_settings_raw(app_handle);

    if settings.general.auto_start {
        // Enable autostart if user has opted in
        let _ = autostart_manager.enable();
    } else {
        // Disable autostart if user has opted out
        let _ = autostart_manager.disable();
    }
    startup.mark("tray settings and autostart applied");

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
        let profile_stt = startup_profile_enabled();
        std::thread::spawn(move || {
            let started = Instant::now();
            tm.initiate_model_load(); // spawns its own background load thread
            tm.warmup(); // waits out that load, then dummy-decodes to compile kernels
                         // Signal the splash ready-watcher that the backend is up + warm (or had
                         // nothing to load). The single-process analog of the reference's
                         // `server-ready`; one of the two gates before the pill is shown.
            if profile_stt {
                log::info!(
                    "[startup] STT boot/warmup thread completed: {} ms",
                    started.elapsed().as_millis()
                );
            }
            splash::mark_stt_boot_done();
        });
    }
    startup.mark("STT boot/warmup scheduled");
}

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
        .manage(winstt::commands::updater::UpdaterRuntimeState::default())
        .manage(cli_args.clone())
        .setup(move |app| {
            let mut startup = StartupProfiler::new();
            startup.mark("setup entered");
            specta_builder.mount_events(app);
            startup.mark("events mounted");

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
            startup.mark("panic hook installed");
            wait_for_renderer_dev_server(&mut startup);

            // Show the startup splash the instant setup begins — BEFORE the slow
            // path (initialize_core_logic + prewarm_windows building all 8
            // secondary WebView2 windows + Enigo init) and before the main pill
            // paints. Ported from the reference in-app splash (splash-window.ts);
            // closed by the main window's on_page_load(Finished) below (with a
            // 30 s backstop inside create_splash_window).
            let app_handle_for_splash = app.handle().clone();
            let startup_winstt_settings =
                winstt::commands::settings::read_settings_raw(&app_handle_for_splash);
            if !cli_args.start_hidden && !startup_winstt_settings.general.start_minimized {
                splash::create_splash_window(&app_handle_for_splash);
            }
            startup.mark("splash initialized");

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
                    // Center on the primary display as the first-run / no-saved-state
                    // default. Without an explicit position the OS places a frameless
                    // window at the top-left corner (the reported "always opens
                    // top-left" bug). On later runs `restore_main_window_position`
                    // (below) overrides this with the remembered spot. Mirrors the
                    // splash's `.center()`.
                    .center()
                    // Record that the renderer has PAINTED — one of the two signals
                    // the splash ready-watcher treats as the shallow WebView-load
                    // signal. Do NOT close the splash here: the watcher also waits
                    // for React bootstrap readiness and STT boot, then shows the
                    // pill + closes the splash in one handoff.
                    .on_page_load(move |_w, payload| {
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            splash::mark_renderer_painted();
                        }
                    })
                    .visible(false);

            if let Some(data_dir) = portable::data_dir() {
                win_builder = win_builder.data_directory(data_dir.join("webview"));
            }

            let main_window = win_builder.build()?;
            // Restore the remembered position (overrides the `.center()` above) when one
            // was saved and is still on-screen. Done before the window is shown, so there
            // is no visible jump from center to the saved spot.
            restore_main_window_position(app.handle(), &main_window);
            startup.mark("main webview built");

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
            startup.mark("settings loaded and coordinator registered");

            crate::winstt::audio_device_watcher::install_audio_device_watcher(&app_handle);
            startup.mark("audio device watcher scheduled");

            initialize_core_logic(&app_handle, &mut startup);
            startup.mark("core logic initialized");

            // Register the global hotkeys at startup. The WinSTT renderer (ported from the reference,
            // where shortcuts lived in main.ts) never calls `initialize_shortcuts`, so without this
            // the dictation/cancel hotkeys are NEVER registered and pressing them does nothing.
            // Must run BEFORE the transforms hook below so HandyKeysState is initialized first.
            crate::shortcut::init_shortcuts(&app_handle);
            startup.mark("base shortcuts initialized");

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
            startup.mark("paste automation initialized");

            // WinSTT-tree global hotkeys: arm the transforms (`llm.transforms.hotkey`),
            // TTS read-aloud (`tts.hotkey`) and re-paste (`general.repasteHotkey`) combos
            // from the WinSTT settings tree. `init_shortcuts` above deliberately skips
            // these (their raw key names aren't parseable without translation), so this
            // single call is what makes them live — gated on each feature's enable flag,
            // and re-run on settings change (apply_settings_patch) so they hot-swap with
            // no relaunch. Mirrors the reference's setupTransformHotkeys / setupTtsHotkey /
            // setupRepasteHotkey, which all ran in main.ts at boot.
            crate::shortcut::reconcile_winstt_hotkeys(&app_handle);
            startup.mark("WinSTT hotkeys reconciled");

            // Pre-warm GPU/accelerator enumeration on a background thread.
            // The first call into transcribe_rs::whisper_cpp::gpu::list_gpu_devices
            // loads the Metal/Vulkan backend and probes devices, which can take
            // several seconds. Without this, that cost is paid synchronously the
            // first time the user opens the Advanced settings page (which calls
            // the get_available_accelerators command), causing a UI freeze.
            // Result is cached in a OnceLock inside the transcription manager.
            let profile_accelerators = startup_profile_enabled();
            std::thread::spawn(move || {
                let started = Instant::now();
                let _ = crate::managers::transcription::get_available_accelerators();
                if profile_accelerators {
                    log::info!(
                        "[startup] accelerator enumeration thread completed: {} ms",
                        started.elapsed().as_millis()
                    );
                }
            });
            startup.mark("accelerator enumeration scheduled");

            // Hide tray icon if --no-tray was passed
            if cli_args.no_tray {
                tray::set_tray_visibility(&app_handle, false);
            }
            startup.mark("tray CLI visibility applied");

            // Show main window only if not starting hidden.
            // CLI --start-hidden flag overrides the setting.
            // But if permission onboarding is required, always show the window.
            let visibility_settings = winstt::commands::settings::read_settings_raw(&app_handle);
            let should_hide = visibility_settings.general.start_minimized || cli_args.start_hidden;
            let should_force_show = should_force_show_permissions_window(&app_handle);

            // If start_hidden but tray is disabled, we must show the window
            // anyway. Without a tray icon, the dock is the only way back in.
            let tray_available = settings.show_tray_icon && !cli_args.no_tray;
            let will_show = should_force_show || !should_hide || !tray_available;
            startup.mark("startup visibility decided");

            // Hand off from the splash to the real window only once the app is READY.
            //
            // The previous code called `show_main_window` HERE, synchronously, inside
            // `setup`. Because `show_main_window` closes the splash first (the handoff),
            // and this runs before the event loop pumps, it tore the splash down at the
            // very start of boot — before the renderer painted and long before the STT
            // engine warmed — flashing a blank pill (the reported "splash killed early"
            // bug). The intended `on_page_load(Finished)` close could never win that race.
            //
            // Instead the ready-watcher (off the main thread) waits for renderer paint,
            // React bootstrap readiness, and STT boot (or a 45 s fallback), then shows
            // the pill + closes the
            // splash in one handoff — mirroring the reference's gated `showOnce`
            // (did-finish-load + server-ready). When no splash exists (the `--start-hidden`
            // CLI flag skips its creation), fall back to the old immediate show.
            if splash::is_active(&app_handle) {
                splash::spawn_ready_watcher(&app_handle, will_show);
            } else if will_show {
                show_main_window(&app_handle);
            }
            startup.mark("startup handoff scheduled");

            // Secondary WebView2 prewarm is scheduled by `show_main_window` after the
            // pill is visible. Keeping it out of setup prevents hidden utility windows
            // from competing with renderer paint and required model warmup.
            startup.mark("setup complete");

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
                    let settings =
                        winstt::commands::settings::read_settings_raw(window.app_handle());
                    let core_settings = get_settings(window.app_handle());
                    let tray_available = core_settings.show_tray_icon
                        && !window.app_handle().state::<CliArgs>().no_tray;
                    if settings.general.minimize_to_tray && tray_available {
                        api.prevent_close();
                        log::info!("Main window close requested - hiding to tray.");
                        let _ = window.hide();
                        return;
                    }
                    request_app_exit(window.app_handle(), "Main window closed");
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
            tauri::WindowEvent::Moved(position) => {
                // Remember where the user drags the main pill so it reopens there next
                // run. Only the main window is tracked; secondary windows are positioned
                // dynamically. Skip the (-32000, -32000) sentinel Windows reports for a
                // minimized window, which would otherwise persist a bogus off-screen spot.
                if window.label() == "main" && position.x > -30000 && position.y > -30000 {
                    save_main_window_position(window.app_handle(), position.x, position.y);
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
