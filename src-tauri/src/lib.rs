mod actions;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod apple_intelligence;
mod audio_feedback;
pub mod audio_toolkit;
mod autostart;
mod bootstrap;
pub mod cli;
mod clipboard;
mod cloud_llm;
mod command_auth;
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
#[cfg(any(debug_assertions, test))]
use specta_typescript::{BigIntExportBehavior, Typescript};

#[cfg(unix)]
use signal_hook::consts::{SIGUSR1, SIGUSR2};
#[cfg(unix)]
use signal_hook::iterator::Signals;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tauri::image::Image;
pub use transcription_coordinator::TranscriptionCoordinator;

use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Listener, Manager};

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
    build_console_filter, ensure_hf_cache_env, request_app_exit, wait_for_renderer_dev_server,
    StartupProfiler,
};
use window_state::{
    restore_main_window_position, save_main_window_position, should_force_show_permissions_window,
};

#[cfg(any(debug_assertions, test))]
fn export_typescript_bindings(
    builder: &tauri_specta::Builder<tauri::Wry>,
    path: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    builder.export(
        Typescript::default().bigint(BigIntExportBehavior::Number),
        path,
    )?;
    trim_trailing_whitespace(path)?;
    Ok(())
}

#[cfg(any(debug_assertions, test))]
fn trim_trailing_whitespace(path: &str) -> std::io::Result<()> {
    let text = std::fs::read_to_string(path)?;
    let mut trimmed = String::with_capacity(text.len());

    for segment in text.split_inclusive('\n') {
        let (line, newline) = if let Some(line) = segment.strip_suffix("\r\n") {
            (line, "\r\n")
        } else if let Some(line) = segment.strip_suffix('\n') {
            (line, "\n")
        } else {
            (segment, "")
        };
        trimmed.push_str(line.trim_end_matches([' ', '\t']));
        trimmed.push_str(newline);
    }

    if trimmed != text {
        std::fs::write(path, trimmed)?;
    }

    Ok(())
}

fn advance_startup_phase(startup: &mut StartupProfiler, app: &AppHandle, label: &str) {
    startup.mark(label);
    splash::emit_startup_progress(app, label);
}

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
    advance_startup_phase(startup, app_handle, "settings defaults seeded");

    let core_managers = bootstrap::state::construct_core_managers(app_handle);
    advance_startup_phase(startup, app_handle, "core managers constructed");

    // Apply accelerator preferences before any model loads
    managers::transcription::apply_accelerator_settings(app_handle);

    bootstrap::state::register_core_managers(app_handle, &core_managers);
    advance_startup_phase(startup, app_handle, "core managers registered");

    helpers::clamshell::install_lid_state_monitor(app_handle);
    advance_startup_phase(startup, app_handle, "lid monitor initialized");

    // Pre-warm the Silero VAD + audio recorder OFF the PTT press path. Neither
    // WinSTT does not preload this, so the COLD first push-to-talk
    // otherwise pays the Silero ONNX load + recorder construction synchronously
    // inside `start_microphone_stream` (~50-200ms) before the recording chime
    // fires — the "warmup feels slow" the user reported. This only loads the
    // model + builds the recorder; it does NOT open the mic stream, so on-demand
    // privacy (mic stays closed until a real press) is preserved. Off-thread so
    // setup isn't blocked; `preload_vad` is idempotent (the press-path call then
    // no-ops).
    {
        let rm = core_managers.recording.clone();
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
    advance_startup_phase(startup, app_handle, "VAD preload scheduled");

    bootstrap::state::register_winstt_managers(app_handle, &core_managers);

    advance_startup_phase(
        startup,
        app_handle,
        "WinSTT managers registered and warmups scheduled",
    );
    // If the persisted WinSTT mode is wakeword, arm the detector and open the
    // microphone stream during startup. The renderer treats wakeword as
    // server-driven, so this backend sync is the only place that can make a cold
    // launch start listening.
    winstt::commands::settings::sync_wakeword_runtime_from_settings_in_background(app_handle);
    advance_startup_phase(startup, app_handle, "wakeword runtime sync scheduled");

    // Tray-menu placement state + the custom-HTML-tray + history live-event bridge.
    app_handle.manage(crate::winstt::commands::tray_menu::TrayMenuAnchor::default());
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
        app_handle.listen(
            crate::winstt::commands::events::names::WAKEWORD_DETECTED,
            move |_event| {
                crate::actions::start_dictation_from_wakeword(&app_for_ww);
            },
        );
    }
    advance_startup_phase(startup, app_handle, "event bridges installed");

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
    advance_startup_phase(startup, app_handle, "signal handlers installed");

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
        // WinSTT uses its OWN transparent HTML tray menu (views/tray-menu), not the
        // native OS context menu from the reference implementation. No native menu is
        // attached (see tray.rs::update_tray_menu).
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
    advance_startup_phase(startup, app_handle, "tray icon created");

    // Initialize tray menu with idle state
    utils::update_tray_menu(app_handle, &utils::TrayIconState::Idle, None);

    // Apply show_tray_icon setting
    let settings = settings::get_settings(app_handle);
    if !settings.show_tray_icon {
        tray::set_tray_visibility(app_handle, false);
    }

    // Refresh tray menu when model state changes
    let app_handle_for_listener = app_handle.clone();
    app_handle.listen(
        crate::winstt::commands::events::names::MODEL_STATE_CHANGED,
        move |_| {
            tray::update_tray_menu(&app_handle_for_listener, &tray::TrayIconState::Idle, None);
        },
    );

    let settings = winstt::commands::settings::read_settings_raw(app_handle);
    autostart::sync_launch_at_login(app_handle, settings.general.auto_start, "[autostart]");
    advance_startup_phase(startup, app_handle, "tray settings and autostart applied");

    // AUDIT #9: the separate `recording_overlay` window is no longer created — the
    // WinSTT recording pill is the React `overlay` WebviewWindow, and every show path
    // already redirected to it (see overlay.rs). The old window could never appear yet
    // still received per-frame mic levels no renderer listened to.

    // Eagerly load + WARM the STT engine at boot so the user's FIRST PTT decode is warm — no
    // model-load + cold DirectML-kernel JIT serialized after release (the ~10x first-dictation
    // gap vs the reference app, whose server warms at boot). Off-thread so setup isn't blocked;
    // `initiate_model_load` is idempotent (a later PTT-press load is a no-op) and `warmup` skips
    // cleanly for cloud ids / failed loads. Mirrors the reference server's boot `recorder.warmup()`.
    {
        let tm = core_managers.transcription.clone();
        let app_handle_for_stt = app_handle.clone();
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
            splash::mark_stt_boot_done(&app_handle_for_stt);
        });
    }
    advance_startup_phase(startup, app_handle, "STT boot/warmup scheduled");
}

fn continue_startup_after_splash_paint(app_handle: AppHandle, cli_args: CliArgs) {
    let mut startup = StartupProfiler::new();
    advance_startup_phase(&mut startup, &app_handle, "splash painted");
    wait_for_renderer_dev_server(&mut startup, &app_handle);

    // Create main window programmatically so we can set data_directory
    // for portable mode (redirects WebView2 cache to portable Data dir).
    let mut win_builder =
        tauri::WebviewWindowBuilder::new(&app_handle, "main", tauri::WebviewUrl::App("/".into()))
            .title("WinSTT")
            .inner_size(420.0, 150.0)
            .min_inner_size(420.0, 150.0)
            .resizable(false)
            .decorations(false)
            .maximizable(false)
            .center()
            .on_page_load({
                let app_handle_for_paint = app_handle.clone();
                move |_w, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        splash::mark_renderer_painted(&app_handle_for_paint);
                    }
                }
            })
            .visible(false);

    if let Some(data_dir) = portable::data_dir() {
        win_builder = win_builder.data_directory(data_dir.join("webview"));
    }

    let main_window = match win_builder.build() {
        Ok(window) => window,
        Err(e) => {
            log::error!("[startup] failed to build main window: {e}");
            splash::close_splash_window(&app_handle);
            return;
        }
    };
    restore_main_window_position(&app_handle, &main_window);
    advance_startup_phase(&mut startup, &app_handle, "main webview built");

    let mut settings = get_settings(&app_handle);
    if cli_args.debug {
        settings.debug_mode = true;
        settings.log_level = settings::LogLevel::Trace;
    }

    let tauri_log_level: tauri_plugin_log::LogLevel = settings.log_level.into();
    let file_log_level: log::Level = tauri_log_level.into();
    FILE_LOG_LEVEL.store(file_log_level.to_level_filter() as u8, Ordering::Relaxed);
    app_handle.manage(TranscriptionCoordinator::new(app_handle.clone()));
    advance_startup_phase(
        &mut startup,
        &app_handle,
        "settings loaded and coordinator registered",
    );

    crate::winstt::audio_device_watcher::install_audio_device_watcher(&app_handle);
    advance_startup_phase(&mut startup, &app_handle, "audio device watcher scheduled");

    initialize_core_logic(&app_handle, &mut startup);
    advance_startup_phase(&mut startup, &app_handle, "core logic initialized");

    crate::shortcut::init_shortcuts(&app_handle);
    advance_startup_phase(&mut startup, &app_handle, "base shortcuts initialized");

    #[cfg(not(target_os = "macos"))]
    match crate::input::EnigoState::new() {
        Ok(enigo_state) => {
            app_handle.manage(enigo_state);
            log::info!("Enigo initialized at startup (paste pipeline ready)");
        }
        Err(e) => log::warn!("Enigo init at startup failed: {e}"),
    }
    advance_startup_phase(&mut startup, &app_handle, "paste automation initialized");

    crate::shortcut::reconcile_winstt_hotkeys(&app_handle);
    advance_startup_phase(&mut startup, &app_handle, "WinSTT hotkeys reconciled");

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
    advance_startup_phase(
        &mut startup,
        &app_handle,
        "accelerator enumeration scheduled",
    );

    if cli_args.no_tray {
        tray::set_tray_visibility(&app_handle, false);
    }
    advance_startup_phase(&mut startup, &app_handle, "tray CLI visibility applied");

    let visibility_settings = winstt::commands::settings::read_settings_raw(&app_handle);
    let should_hide = visibility_settings.general.start_minimized || cli_args.start_hidden;
    let should_force_show = should_force_show_permissions_window(&app_handle);
    let tray_available = settings.show_tray_icon && !cli_args.no_tray;
    let will_show = should_force_show || !should_hide || !tray_available;
    advance_startup_phase(&mut startup, &app_handle, "startup visibility decided");

    if splash::is_active(&app_handle) {
        splash::spawn_ready_watcher(&app_handle, will_show);
    } else if will_show {
        show_main_window(&app_handle);
    }
    advance_startup_phase(&mut startup, &app_handle, "startup handoff scheduled");
    advance_startup_phase(&mut startup, &app_handle, "setup complete");
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
    export_typescript_bindings(&specta_builder, "../src/bindings.ts")
        .expect("Failed to export typescript bindings");

    let invoke_handler = specta_builder.invoke_handler();

    let builder = bootstrap::plugins::install_runtime_plugins(
        tauri::Builder::default(),
        console_filter,
        cli_args.clone(),
    );

    builder
        .setup(move |app| {
            let app_handle = app.handle().clone();
            specta_builder.mount_events(app);

            // Global panic hook -> the file log. Install it before the deferred
            // startup thread begins so worker panics are captured from phase one.
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

            let startup_winstt_settings =
                winstt::commands::settings::read_settings_raw(&app_handle);
            let should_show_splash =
                !cli_args.start_hidden && !startup_winstt_settings.general.start_minimized;
            if should_show_splash {
                splash::create_splash_window(&app_handle);
            }

            let app_handle_for_startup = app_handle.clone();
            let cli_args_for_startup = cli_args.clone();
            std::thread::spawn(move || {
                if should_show_splash {
                    let _ = splash::wait_until_painted();
                }
                continue_startup_after_splash_paint(app_handle_for_startup, cli_args_for_startup);
            });
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
                // Secondary windows generally hide so the app keeps running for the hotkey.
                // Debug-only Context Playground is destroyed below to match the Electron
                // reference and reset its live-capture renderer state on the next open.
                api.prevent_close();

                // Native close of Settings (Alt+F4 etc.) bypasses close_self_window,
                // so route it through the same animated close helper.
                if window.label() == "settings" {
                    let _ = winstt::commands::windows::close_window_internal(
                        window.app_handle(),
                        "settings",
                    );
                    return;
                }
                #[cfg(any(debug_assertions, feature = "context-playground"))]
                if window.label() == "context-playground" {
                    let _ = winstt::commands::windows::close_window_internal(
                        window.app_handle(),
                        "context-playground",
                    );
                    return;
                }
                let _res = window.hide();

                #[cfg(target_os = "macos")]
                {
                    let settings = get_settings(window.app_handle());
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
    use super::{export_typescript_bindings, make_specta_builder};

    /// Regenerates `src/bindings.ts` from the live command/event registry.
    /// Run `cargo test` to refresh it; CI re-runs this then `git diff --exit-code
    /// src/bindings.ts` asserts the checked-in file is up to date.
    #[test]
    fn export_bindings() {
        export_typescript_bindings(&make_specta_builder(), "../src/bindings.ts")
            .expect("Failed to export typescript bindings");
    }
}
