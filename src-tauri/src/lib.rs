mod actions;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod apple_intelligence;
mod audio_feedback;
pub mod audio_toolkit;
mod autostart;
mod bootstrap;
pub mod cli;
mod clipboard;
mod clipboard_snapshot;
mod cloud_llm;
mod command_auth;
mod commands;
mod commands_registry;
mod foreground_window;
mod helpers;
mod input;
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
#[cfg(test)]
use specta_typescript::{BigIntExportBehavior, Typescript};

#[cfg(unix)]
use signal_hook::consts::{SIGUSR1, SIGUSR2};
#[cfg(unix)]
use signal_hook::iterator::Signals;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Instant;
use tauri::image::Image;
pub use transcription_coordinator::TranscriptionCoordinator;

use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Listener, Manager};

// Re-export the boot-time + window-geometry + registry symbols at the crate root
// so external call sites keep their existing `crate::X` paths after the split.
pub use commands_registry::make_specta_builder;
pub use startup::FILE_LOG_LEVEL;
pub(crate) use startup::{log_model_duration, startup_profile_enabled};
pub(crate) use window_state::show_main_window;

static EXIT_CLEANUP_STARTED: AtomicBool = AtomicBool::new(false);
static STT_BOOT_WARMUP_STARTED: AtomicBool = AtomicBool::new(false);

// Boot-time helpers used only inside this crate root (run / initialize_core_logic
// / the window-event handlers).
use startup::{
    StartupProfiler, build_console_filter, configure_webview_window_builder, ensure_hf_cache_env,
    request_app_exit, wait_for_renderer_dev_server,
};
use window_state::{restore_main_window_position, save_main_window_position};

#[cfg(test)]
fn export_typescript_bindings(
    builder: &tauri_specta::Builder<tauri::Wry>,
    path: &str,
) -> Result<(), String> {
    builder
        .export(
            Typescript::default().bigint(BigIntExportBehavior::Number),
            path,
        )
        .map_err(|err| format!("failed to export TypeScript bindings: {err}"))?;
    post_process_typescript_bindings(path)
        .map_err(|err| format!("failed to post-process TypeScript bindings: {err}"))?;
    Ok(())
}

#[cfg(test)]
fn post_process_typescript_bindings(path: &str) -> std::io::Result<()> {
    let text = std::fs::read_to_string(path)?;
    let processed = strip_unused_tauri_channel_import(&text);
    let processed = normalize_generated_result_errors(&processed);
    let processed = replace_generated_event_helper(&processed);
    let processed = trim_trailing_whitespace(&processed);

    if processed != text {
        std::fs::write(path, processed)?;
    }

    Ok(())
}

#[cfg(test)]
fn strip_unused_tauri_channel_import(text: &str) -> String {
    let generated_import_lf = "import {\n\tinvoke as TAURI_INVOKE,\n\tChannel as TAURI_CHANNEL,\n} from \"@tauri-apps/api/core\";";
    let generated_import_crlf = generated_import_lf.replace('\n', "\r\n");
    let cleaned_import = "import { invoke as TAURI_INVOKE } from \"@tauri-apps/api/core\";";

    text.replace(generated_import_lf, cleaned_import)
        .replace(&generated_import_crlf, cleaned_import)
}

#[cfg(test)]
fn normalize_generated_result_errors(text: &str) -> String {
    let without_error_casts = text
        .replace(
            "return { status: \"error\", error: e  as any };",
            "return __commandError__(e);",
        )
        .replace(
            "return { status: \"error\", error: e as any };",
            "return __commandError__(e);",
        );

    if without_error_casts.contains("function __commandError__") {
        return without_error_casts;
    }

    let newline = preferred_typescript_newline(&without_error_casts);
    let result_type_lf = "export type Result<T, E> =\n\t| { status: \"ok\"; data: T }\n\t| { status: \"error\"; error: E };\n";
    let result_type = normalize_newlines(result_type_lf, newline);
    let helper = normalize_newlines(COMMAND_ERROR_HELPER_LF, newline);
    let replacement = format!("{result_type}{newline}{helper}");

    without_error_casts.replacen(&result_type, &replacement, 1)
}

#[cfg(test)]
fn replace_generated_event_helper(text: &str) -> String {
    let start_marker = "function __makeEvents__<T extends Record<string, any>>(";
    let Some(start) = text.find(start_marker) else {
        return text.to_string();
    };

    let newline = preferred_typescript_newline(text);
    let helper = normalize_newlines(EVENT_HELPER_LF, newline);
    let mut processed = String::with_capacity(start + helper.len() + 1);
    processed.push_str(&text[..start]);
    processed.push_str(&helper);
    if text.ends_with('\n') {
        processed.push_str(newline);
    }
    processed
}

#[cfg(test)]
fn preferred_typescript_newline(text: &str) -> &'static str {
    if text.contains("\r\n") { "\r\n" } else { "\n" }
}

#[cfg(test)]
fn normalize_newlines(text: &str, newline: &str) -> String {
    if newline == "\r\n" {
        text.replace('\n', "\r\n")
    } else {
        text.to_string()
    }
}

#[cfg(test)]
const COMMAND_ERROR_HELPER_LF: &str = "function __commandError__<E>(error: unknown): { status: \"error\"; error: E } {\n\treturn { status: \"error\", error: error as E };\n}\n";

#[cfg(test)]
const EVENT_HELPER_LF: &str = r#"type __EventAccessor__<T> = __EventObj__<T> & {
	(handle: __WebviewWindow__): __EventObj__<T>;
};

type __EventMap__<T extends object> = {
	[K in keyof T]: __EventAccessor__<T[K]>;
};

function __makeWindowEventObj__<T>(
	name: string,
	window: __WebviewWindow__,
): __EventObj__<T> {
	return {
		listen: (cb) => window.listen<T>(name, cb),
		once: (cb) => window.once<T>(name, cb),
		emit: ((payload?: T) =>
			window.emit(name, payload)) as __EventObj__<T>["emit"],
	};
}

function __makeGlobalEventObj__<T>(name: string): __EventObj__<T> {
	return {
		listen: (cb) => TAURI_API_EVENT.listen<T>(name, cb),
		once: (cb) => TAURI_API_EVENT.once<T>(name, cb),
		emit: ((payload?: T) =>
			TAURI_API_EVENT.emit(name, payload)) as __EventObj__<T>["emit"],
	};
}

function __makeEventAccessor__<T>(name: string): __EventAccessor__<T> {
	const eventObj = __makeGlobalEventObj__<T>(name);
	const accessor = ((window: __WebviewWindow__) =>
		__makeWindowEventObj__<T>(name, window)) as __EventAccessor__<T>;
	accessor.listen = eventObj.listen;
	accessor.once = eventObj.once;
	accessor.emit = eventObj.emit;
	return accessor;
}

function __makeEvents__<T extends object>(
	mappings: Record<keyof T, string>,
): __EventMap__<T> {
	return new Proxy({} as __EventMap__<T>, {
		get: (_, event: string | symbol) =>
			__makeEventAccessor__<T[keyof T]>(mappings[event as keyof T]),
	});
}"#;

#[cfg(test)]
fn trim_trailing_whitespace(text: &str) -> String {
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

    trimmed
}

fn advance_startup_phase(startup: &mut StartupProfiler, app: &AppHandle, label: &str) {
    startup.mark(label);
    splash::emit_startup_progress(app, label);
}

fn open_startup_onboarding_window(
    app: &AppHandle,
    _main_window: &tauri::WebviewWindow,
) -> Result<(), String> {
    winstt::commands::windows::show_onboarding_window_internal(app)
}

fn spawn_stt_boot_warmup(
    app_handle: &AppHandle,
    tm: Arc<managers::transcription::TranscriptionManager>,
) {
    if STT_BOOT_WARMUP_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let app_handle_for_stt = app_handle.clone();
    let profile_stt = startup_profile_enabled();
    startup::log_since_launch("STT boot/warmup thread spawned");
    std::thread::spawn(move || {
        let started = Instant::now();
        // Onboarding owns this launch: stay model-free until the user finishes and
        // `warm_models_after_onboarding` runs. Still release the splash gate so a
        // failed-to-open onboarding window's fallback ready-watcher can proceed.
        if winstt::commands::onboarding::is_onboarding_active() {
            if profile_stt {
                log::info!("[startup] STT boot/warmup skipped -- onboarding active");
            }
            splash::mark_stt_boot_done(&app_handle_for_stt);
            return;
        }
        // Booting straight into Listen mode: the listen session loads its OWN
        // native-streaming model, and dictation loads on demand once the user
        // leaves listen — preloading the dictation model here would stack a
        // second (often multi-GB, multi-second) engine next to the listen one
        // that nothing is about to use.
        if winstt::settings_store::read_settings_raw(&app_handle_for_stt)
            .general
            .recording_mode
            == winstt::settings_schema::RecordingMode::Listen
        {
            log::info!("[startup] STT dictation-model preload skipped -- recording mode is listen");
            splash::mark_stt_boot_done(&app_handle_for_stt);
            crate::bootstrap::state::schedule_winstt_background_warmups(&app_handle_for_stt);
            return;
        }
        tm.initiate_model_load(); // spawns its own background load thread
        tm.warmup(); // waits out that load, then dummy-decodes to compile kernels
        splash::mark_stt_boot_done(&app_handle_for_stt);
        // Push the settled readiness flags. The renderer may already be visible,
        // so it must not have to poll or wait for a later model swap to learn
        // that the background warmup finished.
        let runtime_info =
            winstt::commands::runtime::runtime_info_snapshot(&app_handle_for_stt, tm.as_ref());
        winstt::commands::swap_events::SwapEvents::runtime_info(&app_handle_for_stt, &runtime_info);
        // Publish model readiness for diagnostics and first-dictation status.
        // The visible-window handoff deliberately does not wait for this: large
        // DirectML models can take many seconds to load, while the renderer is
        // already usable and can continue warming the engine in the background.
        if profile_stt {
            log::info!(
                "[startup] STT boot/warmup thread completed: {} ms",
                started.elapsed().as_millis()
            );
        }
        crate::bootstrap::state::schedule_winstt_background_warmups(&app_handle_for_stt);
        if profile_stt {
            log::info!("[startup] WinSTT background warmups scheduled after STT boot");
        }
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SttBootWarmupPolicy {
    Eager,
    RendererReady,
}

fn stt_boot_warmup_policy() -> SttBootWarmupPolicy {
    parse_stt_boot_warmup_policy(&std::env::var("WINSTT_STT_WARMUP_POLICY").unwrap_or_default())
}

fn parse_stt_boot_warmup_policy(value: &str) -> SttBootWarmupPolicy {
    match value.trim().to_ascii_lowercase().as_str() {
        "renderer-ready" => SttBootWarmupPolicy::RendererReady,
        _ => SttBootWarmupPolicy::Eager,
    }
}

/// Start the one-time STT load/warm pass after the renderer has acknowledged
/// its first paint and startup IPC work. The measured default is eager; this
/// entry point retains the delayed policy for controlled launch experiments.
pub(crate) fn schedule_stt_boot_warmup_after_renderer_ready(app: &AppHandle) {
    let Some(transcription) = app.try_state::<Arc<managers::transcription::TranscriptionManager>>()
    else {
        log::warn!("[startup] renderer-ready STT warmup skipped: manager unavailable");
        return;
    };
    spawn_stt_boot_warmup(app, Arc::clone(transcription.inner()));
}

/// Headless model-runtime boot: manager construction + registration and the
/// VAD/wakeword setup. Runs before the main webview is created. STT load/warm
/// defaults to eager because the packaged native A/B found it faster at paint,
/// first usable, and STT-ready; renderer-ready remains an explicit benchmark policy.
/// Nothing in here touches a window or webview.
///
/// Note: Enigo (keyboard/mouse simulation) is NOT initialized here.
/// The frontend is responsible for calling the `initialize_enigo` command
/// after onboarding completes. This avoids triggering permission dialogs
/// on macOS before the user is ready.
fn initialize_model_runtime(
    app_handle: &AppHandle,
    startup: &mut StartupProfiler,
) -> Result<(), String> {
    // The watchdog spawns a detached PowerShell (~250 ms) — that cost sat on
    // the serial path in front of the STT warmup spawn, so run it off-thread.
    // It only has to be up before the first Ollama model is TRACKED, which
    // happens seconds later (LLM warmups start after the STT boot completes).
    std::thread::spawn(winstt::model_watchdog::install);
    advance_startup_phase(startup, app_handle, "model cleanup watchdog installed");

    // Establish both the first-run and returning-user permission gate before
    // device watchers, microphone streams, VAD, or model warmups are scheduled.
    // This is a non-requesting preflight: OS prompts remain owned by the focused
    // onboarding/recovery UI.
    let permission_status = winstt::commands::permission::initialize_startup_gate(app_handle);
    if permission_status.ready {
        winstt::audio_device_watcher::install_audio_device_watcher(app_handle);
    } else {
        log::info!("[permissions] audio device watcher deferred until access is restored");
    }

    let core_managers = bootstrap::state::construct_core_managers(app_handle)?;
    advance_startup_phase(startup, app_handle, "core managers constructed");

    // Apply accelerator preferences before any model loads
    managers::transcription::apply_accelerator_settings(app_handle);

    bootstrap::state::register_core_managers(app_handle, &core_managers);
    advance_startup_phase(startup, app_handle, "core managers registered");

    helpers::clamshell::install_lid_state_monitor(app_handle);
    advance_startup_phase(startup, app_handle, "lid monitor initialized");

    // Pre-warm the Silero VAD + audio recorder OFF the PTT press path. WinSTT
    // does not otherwise preload this, so the COLD first push-to-talk
    // otherwise pays the Silero ONNX load + recorder construction synchronously
    // inside `start_microphone_stream` (~50-200ms) before the recording chime
    // fires — the "warmup feels slow" the user reported. This only loads the
    // model + builds the recorder; it does NOT open the mic stream, so on-demand
    // privacy (mic stays closed until a real press) is preserved. Off-thread so
    // setup isn't blocked; `preload_vad` is idempotent (the press-path call then
    // no-ops).
    {
        if winstt::commands::onboarding::is_onboarding_active() {
            if startup_profile_enabled() {
                log::info!("[startup] VAD preload skipped - onboarding active");
            }
        } else {
            bootstrap::state::schedule_vad_preload(app_handle, core_managers.recording.clone());
        }
    }
    advance_startup_phase(startup, app_handle, "VAD preload scheduled");

    bootstrap::state::register_winstt_managers(app_handle, &core_managers);
    advance_startup_phase(startup, app_handle, "WinSTT managers registered");
    // Default to eager warmup: the packaged native A/B found lower median paint,
    // first-usable, and STT-ready times than deferring until renderer-ready.
    // Keep the delayed policy available for repeatable controlled measurements.
    if stt_boot_warmup_policy() == SttBootWarmupPolicy::Eager {
        spawn_stt_boot_warmup(app_handle, core_managers.transcription);
        advance_startup_phase(startup, app_handle, "eager STT boot/warmup scheduled");
    } else {
        advance_startup_phase(
            startup,
            app_handle,
            "STT boot/warmup deferred until renderer ready",
        );
    }
    // If the persisted WinSTT mode is wakeword, arm the detector and open the
    // microphone stream during startup. The renderer treats wakeword as
    // server-driven, so this backend sync is the only place that can make a cold
    // launch start listening. Held back while onboarding owns the launch (the mic
    // stays closed + the wakeword model unloaded); `warm_models_after_onboarding`
    // re-runs this once the wizard is done.
    if !winstt::commands::onboarding::is_onboarding_active() {
        winstt::commands::settings::sync_wakeword_runtime_from_settings_in_background(app_handle);
    }
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
    let signals = Signals::new([SIGUSR1, SIGUSR2])
        .map_err(|err| format!("failed to install signal handlers: {err}"))?;
    // Set up signal handlers for toggling transcription
    #[cfg(unix)]
    signal_handle::setup_signal_handler(app_handle.clone(), signals);

    // Windows: shut down cleanly on Ctrl+C / console-close so `tauri dev` exits with code 0
    // and no WebView2 teardown noise (no STATUS_CONTROL_C_EXIT, no `window_impl.cc` warning,
    // no `^C^C` race). See the handler doc for why this is a hard exit, not app.exit(0).
    #[cfg(windows)]
    signal_handle::setup_windows_ctrl_handler();
    advance_startup_phase(startup, app_handle, "signal handlers installed");

    Ok(())
}

/// Desktop-shell integration that needs (or follows) the main window: tray
/// icon + menu (the initial tray theme is read from the main window), macOS
/// activation policy, and launch-at-login sync. Split from the model runtime
/// so the STT warmup spawn no longer waits behind any of it.
fn initialize_desktop_integration(
    app_handle: &AppHandle,
    startup: &mut StartupProfiler,
) -> Result<(), String> {
    // Apply macOS Accessory policy if starting hidden and tray is available.
    // If the tray icon is disabled, keep the dock icon so the user can reopen.
    #[cfg(target_os = "macos")]
    {
        let settings = winstt::commands::settings::read_settings_raw(app_handle);
        if settings.general.start_minimized && settings.core.show_tray_icon {
            let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
    }
    let initial_theme = tray::get_current_theme(app_handle);

    let initial_icon_path = tray::get_icon_path(initial_theme, tray::TrayIconState::Idle);
    let initial_icon_path = app_handle
        .path()
        .resolve(initial_icon_path, tauri::path::BaseDirectory::Resource)
        .map_err(|err| format!("failed to resolve tray icon path: {err}"))?;
    let initial_icon = Image::from_path(initial_icon_path)
        .map_err(|err| format!("failed to load tray icon: {err}"))?;

    let tray = TrayIconBuilder::new()
        .icon(initial_icon)
        .tooltip(tray::tray_tooltip())
        .icon_as_template(true)
        // WinSTT uses its OWN transparent HTML tray menu (views/tray-menu), not the
        // native OS context menu from the reference implementation. No native menu is
        // attached (see tray.rs::update_tray_menu).
        //
        // Click routing mirrors the reference tray:
        //   - LEFT click / DOUBLE click → show + raise the main window
        //     (`tray.on("click", () => win.show())`).
        //   - RIGHT click → toggle the custom HTML tray menu at the cursor
        //     (`tray.on("right-click", … showTrayMenuAt)`).
        // Previously ANY click toggled the menu, so a left/double-click popped the menu
        // instead of showing the app — the reported bug.
        .on_tray_icon_event(|tray_handle, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            // DIAGNOSTIC: the tray click path is invisible in a packaged build
            // (no console), so a "right-click does nothing" report has no trace
            // to follow. Log the CLICKS only — the tray also emits Move/Enter/
            // Leave for every pixel the cursor crosses.
            if matches!(
                event,
                TrayIconEvent::Click { .. } | TrayIconEvent::DoubleClick { .. }
            ) {
                log::debug!("[tray] {event:?}");
            }
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
                    // Don't surface the main window from the tray while the first-run
                    // wizard is up — it must be completed, not bypassed.
                    if !winstt::commands::onboarding::is_onboarding_in_progress(
                        tray_handle.app_handle(),
                    ) {
                        window_state::show_main_window_from_tray(tray_handle.app_handle());
                    }
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
        .map_err(|err| format!("failed to build tray icon: {err}"))?;
    app_handle.manage(tray);
    tray::sync_tray_visualizer_style_from_settings(app_handle);
    advance_startup_phase(startup, app_handle, "tray icon created");

    utils::update_tray_menu(app_handle, &utils::TrayIconState::Idle, None);

    // Apply show_tray_icon setting
    let settings = winstt::commands::settings::read_settings_raw(app_handle).core;
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

    let auto_start = winstt::commands::settings::read_settings_raw(app_handle)
        .general
        .auto_start;
    let app_for_autostart = app_handle.clone();
    std::thread::spawn(move || {
        autostart::sync_launch_at_login(&app_for_autostart, auto_start, "[autostart]");
    });
    advance_startup_phase(
        startup,
        app_handle,
        "tray settings applied; autostart sync scheduled",
    );

    // The separate `recording_overlay` window is no longer created — the
    // WinSTT recording pill is the React `overlay` WebviewWindow, and every show path
    // already redirected to it (see overlay.rs). The old window could never appear yet
    // still received per-frame mic levels no renderer listened to.

    Ok(())
}

/// Settings-store seeding, the cheap headless singletons, then the model
/// runtime. Runs on the deferred startup thread only after the splash has
/// painted at 0%; expensive STT warmup follows the selected eager/renderer-ready
/// policy.
fn run_headless_boot(
    app_handle: &AppHandle,
    cli_args: &CliArgs,
    startup: &mut StartupProfiler,
) -> Result<(), String> {
    // Materialize the canonical settings tree, including backend-only `core`,
    // before any manager reads settings.
    winstt::commands::settings::seed_defaults(app_handle);
    advance_startup_phase(startup, app_handle, "settings defaults seeded");

    let mut settings = winstt::commands::settings::read_settings_raw(app_handle).core;
    if cli_args.debug {
        settings.debug_mode = true;
        settings.log_level = settings::LogLevel::Trace;
    }
    let tauri_log_level: tauri_plugin_log::LogLevel = settings.log_level.into();
    let file_log_level: log::Level = tauri_log_level.into();
    FILE_LOG_LEVEL.store(file_log_level.to_level_filter() as u8, Ordering::Relaxed);
    app_handle.manage(TranscriptionCoordinator::new(app_handle.clone()));
    advance_startup_phase(
        startup,
        app_handle,
        "settings loaded and coordinator registered",
    );

    initialize_model_runtime(app_handle, startup)
}

/// Shared abort path for a failed headless boot / desktop integration: record
/// the issue, drop the splash, and exit instead of leaving a window-less app.
fn abort_startup(app_handle: &AppHandle, err: String) {
    log::error!("[startup] core logic initialization failed: {err}");
    crate::winstt::observability::IssueBuilder::new(
        "startup",
        "core_initialization",
        "WinSTT core startup failed",
    )
    .detail(err)
    .severity("error")
    .record_without_log(Some(app_handle));
    splash::close_splash_window(app_handle);
    request_app_exit(app_handle, "Core logic initialization failed");
}

fn continue_startup_after_splash_paint(
    app_handle: AppHandle,
    cli_args: CliArgs,
    mut startup: StartupProfiler,
    headless_boot: Result<(), String>,
) {
    if let Err(err) = headless_boot {
        abort_startup(&app_handle, err);
        return;
    }
    wait_for_renderer_dev_server(&mut startup, &app_handle);

    // Create main window programmatically so we can set data_directory
    // for portable mode (redirects WebView2 cache to portable Data dir).
    let mut win_builder = configure_webview_window_builder(
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
            .visible(false),
    );

    if let Some(data_dir) = portable::data_dir() {
        win_builder = win_builder.data_directory(data_dir.join("webview"));
    }

    let main_window = match win_builder.build() {
        Ok(window) => window,
        Err(e) => {
            log::error!("[startup] failed to build main window: {e}");
            crate::winstt::observability::IssueBuilder::new(
                "startup",
                "main_window_build",
                "WinSTT could not create the main window",
            )
            .detail(e.to_string())
            .severity("error")
            .record_without_log(Some(&app_handle));
            splash::close_splash_window(&app_handle);
            return;
        }
    };
    restore_main_window_position(&app_handle, &main_window);
    advance_startup_phase(&mut startup, &app_handle, "main webview built");

    if let Err(err) = initialize_desktop_integration(&app_handle, &mut startup) {
        abort_startup(&app_handle, err);
        return;
    }
    advance_startup_phase(&mut startup, &app_handle, "core logic initialized");

    if winstt::commands::onboarding::is_onboarding_active() {
        log::info!("[startup] interactive runtime deferred until onboarding finishes");
        advance_startup_phase(&mut startup, &app_handle, "interactive runtime deferred");
    } else {
        bootstrap::state::activate_interactive_runtime(&app_handle);
        advance_startup_phase(&mut startup, &app_handle, "interactive runtime initialized");
    }

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
    let should_show_onboarding = !visibility_settings.general.onboarded
        || winstt::commands::permission::is_recovery_active();
    let should_hide = visibility_settings.general.start_minimized || cli_args.start_hidden;
    let tray_available = visibility_settings.core.show_tray_icon && !cli_args.no_tray;
    let will_show_main = !should_show_onboarding && (!should_hide || !tray_available);
    advance_startup_phase(&mut startup, &app_handle, "startup visibility decided");

    if should_show_onboarding {
        match open_startup_onboarding_window(&app_handle, &main_window) {
            Ok(()) => {
                splash::emit_startup_complete(&app_handle, "onboarding window shown");
                splash::close_splash_window(&app_handle);
            }
            Err(e) => {
                log::error!("Failed to open onboarding window at startup: {e}");
                crate::winstt::observability::IssueBuilder::new(
                    "startup",
                    "onboarding_window_open",
                    "Startup could not open the onboarding window",
                )
                .detail(e)
                .record_without_log(Some(&app_handle));
                if winstt::commands::permission::is_recovery_active() {
                    // Never bypass an explicit OS denial into a half-active app.
                    // If the focused recovery surface cannot be created, stop
                    // cleanly and let the recorded startup issue explain why.
                    request_app_exit(
                        &app_handle,
                        "Permission recovery window could not be opened",
                    );
                    return;
                }
                // The wizard never opened, so `onboarding_finish` will never run to
                // lift the model gate. Drop straight into normal-launch behaviour:
                // un-gate and warm the configured model so the user isn't stranded
                // on a model-free app.
                winstt::commands::onboarding::set_onboarding_active(false);
                bootstrap::state::activate_runtime_after_onboarding(&app_handle);
                let fallback_will_show = !should_hide || !tray_available;
                if splash::is_active(&app_handle) {
                    splash::spawn_ready_watcher(&app_handle, fallback_will_show);
                } else if fallback_will_show {
                    show_main_window(&app_handle);
                }
            }
        }
    } else if splash::is_active(&app_handle) {
        splash::spawn_ready_watcher(&app_handle, will_show_main);
    } else if will_show_main {
        show_main_window(&app_handle);
    }
    // Start-hidden launches never reach `show_main_window_with_restore` (which
    // warms on visible launches), yet the tray icon is right-clickable
    // immediately — warm the tray-menu webview so the first click can't land on
    // a still-loading transparent window.
    if tray_available && !will_show_main {
        winstt::commands::tray_menu::schedule_tray_menu_warmup(&app_handle);
    }
    // Same reasoning for the other always-warm surfaces (overlay /
    // model-footprint / tray-indicator): a hidden or onboarding launch never
    // reaches `show_main_window_with_restore`, yet global hotkeys work
    // immediately — warm them so the first PTT pill and the first hotkey
    // mode-switch pill don't depend on a webview that was never created.
    if !will_show_main {
        winstt::commands::windows::schedule_secondary_window_warmup(&app_handle);
    }
    advance_startup_phase(&mut startup, &app_handle, "startup handoff scheduled");
    advance_startup_phase(&mut startup, &app_handle, "setup complete");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(cli_args: CliArgs) {
    startup::mark_process_start();
    // Detect portable mode before anything else
    portable::init();
    shortcut::announce_packaged_hotkey_owner();

    // Make a double-clicked build resolve the same HF model cache as `tauri dev`
    // (hf-hub reads $HOME only and falls back to /tmp on Windows without it).
    ensure_hf_cache_env();

    // Parse console logging directives from RUST_LOG, falling back to info-level logging
    // when the variable is unset
    let console_filter = build_console_filter();

    let specta_builder = make_specta_builder();

    let invoke_handler = specta_builder.invoke_handler();

    let builder = bootstrap::plugins::install_runtime_plugins(
        tauri::Builder::default(),
        console_filter,
        cli_args.clone(),
    );

    let app = match builder
        .setup(move |app| {
            let app_handle = app.handle().clone();
            specta_builder.mount_events(app);

            // Global panic hook -> the file log. Install it before the deferred
            // startup thread begins so worker panics are captured from phase one.
            {
                let prev_hook = std::panic::take_hook();
                let app_for_panic = app_handle.clone();
                std::panic::set_hook(Box::new(move |info| {
                    let thread = std::thread::current();
                    let name = thread.name().unwrap_or("<unnamed>");
                    let location = info.location().map_or_else(
                        || "<unknown location>".to_string(),
                        |l| format!("{}:{}:{}", l.file(), l.line(), l.column()),
                    );
                    let payload = info
                        .payload()
                        .downcast_ref::<&str>()
                        .map(|s| s.to_string())
                        .or_else(|| info.payload().downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "<non-string panic payload>".to_string());
                    // Capture a backtrace UNCONDITIONALLY (independent of the RUST_BACKTRACE
                    // env var, which a GUI launch never sets) and route it through the FILE
                    // log + observability issue. Without this, an intermittent worker-thread
                    // panic — e.g. a dependency tripping a std `Rc`/`Arc` UB precondition
                    // (`inc_strong` on a strong==0 refcount, which aborts the process) — only
                    // surfaces its file:line, not the call stack that names the offending
                    // crate. `force_capture()` resolves frames because the dev profile keeps
                    // `debug = "line-tables-only"` and does not strip. This runs solely on the
                    // panic/abort path, so its cost never touches steady-state.
                    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
                    log::error!(
                        "[panic] thread '{name}' at {location}: {payload}\n[panic][backtrace]\n{backtrace}"
                    );
                    crate::winstt::observability::IssueBuilder::new(
                        "runtime",
                        "panic",
                        "A WinSTT thread panicked",
                    )
                    .detail(payload)
                    .kind("panic")
                    .severity("error")
                    .context("thread", name.to_string())
                    .context("location", location)
                    .context("backtrace", backtrace)
                    .record_without_log(Some(&app_for_panic));
                    prev_hook(info);
                }));
            }

            // Build the settings store handle HERE — on the main (event-loop) thread —
            // before the spawned startup thread / realtime worker / PTT watchdog ever
            // read settings. `app.store(..)` clones the `AppHandle` (and on Wry, tao's
            // non-`Send` `Rc<EventLoopRunner>`); doing that from those background loops
            // raced the main loop's refcount and aborted with an `Rc::inc_strong` UB
            // precondition violation. Caching the handle here keeps every later read on
            // the clone-free path. (Must precede the first `read_settings_raw` below.)
            winstt::commands::settings::init_settings_store(&app_handle);

            let startup_winstt_settings =
                winstt::commands::settings::read_settings_raw(&app_handle);
            let should_show_splash =
                !cli_args.start_hidden && !startup_winstt_settings.general.start_minimized;
            if should_show_splash {
                splash::create_splash_window(&app_handle);
            }

            let app_handle_for_startup = app_handle;
            let cli_args_for_startup = cli_args;
            std::thread::spawn(move || {
                let mut startup = StartupProfiler::new();
                startup::log_since_launch("deferred startup thread running");
                // Do not begin any progress-producing or model-runtime work until
                // the local splash page has loaded and WebView2 has had time to
                // present its initial 0% frame. Starting headless boot first could
                // starve the splash compositor, making its first visible frame land
                // at 50-70% on cold launches.
                if should_show_splash && splash::wait_until_painted() {
                    advance_startup_phase(&mut startup, &app_handle_for_startup, "splash painted");
                }
                // Wire the ducking crash journal and restore any session
                // volumes a previous run left ducked (crash / kill while
                // dictating). Must precede the first dictation.
                winstt::ducking::init(&app_handle_for_startup);
                // With the splash already visible, begin headless manager setup
                // and the selected STT load/warm policy before creating the main
                // renderer webview.
                let headless_boot = run_headless_boot(
                    &app_handle_for_startup,
                    &cli_args_for_startup,
                    &mut startup,
                );
                continue_startup_after_splash_paint(
                    app_handle_for_startup,
                    cli_args_for_startup,
                    startup,
                    headless_boot,
                );
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Focused(_)) {
                crate::winstt::commands::context_playground::notify_context_playground_focus_changed();
                if let Some(realtime) = window.app_handle().try_state::<
                    Arc<crate::winstt::managers::RealtimeManager>,
                >() {
                    realtime.notify_external_conditions_changed();
                }
            }
            match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Closing the MAIN pill quits the whole app (the user expects X to close it,
                // not silently hide-to-tray — KEEP quit-on-X, do NOT hide-to-tray).
                //
                // Route through `app.exit(0)` rather than `std::process::exit(0)`.
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
                    let tray_available = settings.core.show_tray_icon
                        && !window.app_handle().state::<CliArgs>().no_tray;
                    if settings.general.minimize_to_tray && tray_available {
                        api.prevent_close();
                        log::debug!("Main window close requested - hiding to tray.");
                        let _ = window.hide();
                        return;
                    }
                    request_app_exit(window.app_handle(), "Main window closed");
                    return;
                }
                // Secondary windows generally hide so the app keeps running for the hotkey.
                // Debug-only Context Playground is destroyed below to reset its
                // live-capture renderer state on the next open.
                api.prevent_close();

                // The first-run wizard must be COMPLETED, not dismissed. A native close
                // (Alt+F4 / OS gesture) while onboarding is still in progress quits the
                // whole app instead of hiding the window into the un-onboarded app — the
                // same behaviour as the titlebar control. Persisted wizard progress means
                // a relaunch resumes onboarding where it left off, so there is no
                // "close to skip" path. Once onboarding has finished (`onboarded`), the
                // window is reused like any other secondary window (falls through to hide).
                if window.label() == "onboarding" {
                    let onboarded =
                        winstt::commands::settings::read_settings_raw(window.app_handle())
                            .general
                            .onboarded;
                    if !onboarded
                        || winstt::commands::permission::is_recovery_active()
                    {
                        request_app_exit(
                            window.app_handle(),
                            "Permission/onboarding window closed before completion",
                        );
                        return;
                    }
                }

                // Native close of a main-window modal (Alt+F4 etc.) bypasses
                // close_self_window, so route it through the same teardown path.
                if matches!(window.label(), "settings" | "whats-new") {
                    let _ = winstt::commands::windows::close_window_internal(
                        window.app_handle(),
                        window.label(),
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
                    let settings =
                        winstt::commands::settings::read_settings_raw(window.app_handle()).core;
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
                log::debug!("Theme changed to: {:?}", theme);
                utils::change_tray_icon(window.app_handle(), utils::TrayIconState::Idle);
            }
            tauri::WindowEvent::Focused(true) if window.label() == "main" => {
                winstt::commands::permission::schedule_recurring_preflight(
                    window.app_handle(),
                );
            }
                _ => {}
            }
        })
        .invoke_handler(invoke_handler)
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(err) => {
            eprintln!("error while building tauri application: {err}");
            crate::winstt::observability::IssueBuilder::new(
                "startup",
                "tauri_application_build",
                "Tauri application build failed",
            )
            .detail(err.to_string())
            .severity("error")
            .record(None);
            return;
        }
    };

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = &event {
            cleanup_runtime_models_on_exit(app);
        }
        if let tauri::RunEvent::Resumed = &event {
            winstt::commands::permission::schedule_recurring_preflight(app);
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = &event {
            // Don't surface the main window from a dock reopen while the first-run
            // wizard is up — it must be completed, not bypassed.
            if !winstt::commands::onboarding::is_onboarding_in_progress(app) {
                show_main_window(app);
            }
        }
        let _ = (app, event); // suppress unused warnings on non-macOS
    });
}

/// On graceful exit, stop live capture paths and explicitly drop every model
/// runtime WinSTT owns before process teardown. In-process ONNX sessions would be
/// reclaimed by the OS eventually, but dropping them here gives DirectML/ORT and
/// sherpa/Kokoro deterministic shutdown and keeps repeated dev launches clean.
fn cleanup_runtime_models_on_exit(app: &AppHandle) {
    if EXIT_CLEANUP_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }

    let started = Instant::now();
    log::info!("[shutdown] unloading model runtimes");

    // Put every mixer session we ducked back FIRST (bounded wait). Windows
    // persists per-app session volumes, so quitting while ducked would leave
    // the user's apps quiet across reboots.
    winstt::ducking::restore_all_blocking_on_exit();

    if let Some(llm) = app.try_state::<Arc<winstt::managers::LlmManager>>() {
        llm.inner().begin_shutdown();
    }

    if let Some(tts) = app.try_state::<Arc<winstt::managers::TtsManager>>() {
        tts.inner().cancel_all();
    }

    if let Some(realtime) = app.try_state::<Arc<winstt::managers::RealtimeManager>>() {
        realtime.inner().shutdown();
    }

    if let Some(audio) = app.try_state::<Arc<managers::audio::AudioRecordingManager>>() {
        audio.inner().cancel_recording();
        audio.inner().stop_microphone_stream();
    }

    if let Some(loopback) = app.try_state::<Arc<winstt::managers::LoopbackManager>>() {
        loopback.inner().stop();
    }

    if let Some(wakeword) = app.try_state::<Arc<winstt::managers::WakeWordManager>>() {
        wakeword.inner().shutdown_runtime();
    }

    if let Some(transcription) =
        app.try_state::<Arc<managers::transcription::TranscriptionManager>>()
    {
        let manager = transcription.inner();
        if manager.is_model_loaded()
            && let Err(err) = manager.unload_model()
        {
            log::warn!("[shutdown] failed to unload STT model: {err}");
        }
    }

    if let Some(tts) = app.try_state::<Arc<winstt::managers::TtsManager>>() {
        tts.inner()
            .unload_active_local_model_for_cleanup("app shutdown");
    }

    winstt::encoder_dict::clear_loaded();
    free_ollama_vram_on_exit(app);

    log::info!(
        "[shutdown] model runtime cleanup finished in {}ms",
        started.elapsed().as_millis()
    );
}

/// On graceful exit, unload the Ollama model(s) WinSTT loaded into VRAM, then stop
/// the `ollama serve` WinSTT auto-started (a no-op when the user owns the server).
/// Ollama is a separate, detached process that survives WinSTT — without this the
/// model lingers in VRAM after quit until Ollama's keep-alive timer fires (or
/// forever under "never unload"). Bounded well under the 8s exit watchdog
/// (`startup::spawn_exit_watchdog`): the unload drives on a worker thread and the
/// main thread waits at most ~2.2s for it before letting exit proceed.
fn free_ollama_vram_on_exit(app: &AppHandle) {
    use std::sync::mpsc;
    use std::time::Duration;

    if let Some(llm) = app.try_state::<Arc<winstt::managers::LlmManager>>() {
        let mgr = Arc::clone(llm.inner());
        let (tx, rx) = mpsc::channel::<()>();
        std::thread::spawn(move || {
            // The Tauri async runtime is still alive at ExitRequested. The
            // per-model timeout is below the join budget so a hung localhost call
            // cannot push us past the exit watchdog.
            tauri::async_runtime::block_on(
                mgr.unload_warmed_ollama_models(Duration::from_millis(1500)),
            );
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(Duration::from_millis(2200));
    }
    winstt::commands::llm::stop_winstt_spawned_ollama();
}

#[cfg(test)]
mod startup_policy_tests {
    use super::{SttBootWarmupPolicy, parse_stt_boot_warmup_policy};

    #[test]
    fn eager_is_the_default_warmup_policy() {
        assert_eq!(parse_stt_boot_warmup_policy(""), SttBootWarmupPolicy::Eager);
        assert_eq!(
            parse_stt_boot_warmup_policy("unexpected"),
            SttBootWarmupPolicy::Eager
        );
    }

    #[test]
    fn renderer_ready_warmup_remains_available_for_ab_measurement() {
        assert_eq!(
            parse_stt_boot_warmup_policy(" RENDERER-READY "),
            SttBootWarmupPolicy::RendererReady
        );
    }
}

#[cfg(test)]
mod bindings_export_tests {
    use super::{
        export_typescript_bindings, make_specta_builder, normalize_generated_result_errors,
        replace_generated_event_helper, strip_unused_tauri_channel_import,
    };

    #[test]
    fn strips_unused_tauri_channel_import_from_generated_globals() {
        let generated = "import {\n\tinvoke as TAURI_INVOKE,\n\tChannel as TAURI_CHANNEL,\n} from \"@tauri-apps/api/core\";\nimport * as TAURI_API_EVENT from \"@tauri-apps/api/event\";";
        let cleaned = strip_unused_tauri_channel_import(generated);

        assert_eq!(
            cleaned,
            "import { invoke as TAURI_INVOKE } from \"@tauri-apps/api/core\";\nimport * as TAURI_API_EVENT from \"@tauri-apps/api/event\";"
        );
        assert!(!cleaned.contains("TAURI_CHANNEL"));
    }

    #[test]
    fn replaces_generated_result_error_any_casts_with_typed_helper() {
        let generated = "export type Result<T, E> =\n\t| { status: \"ok\"; data: T }\n\t| { status: \"error\"; error: E };\n\nasync example() {\n\ttry {\n\t\treturn { status: \"ok\", data: null };\n\t} catch (e) {\n\t\tif(e instanceof Error) throw e;\n\t\telse return { status: \"error\", error: e  as any };\n\t}\n}";
        let cleaned = normalize_generated_result_errors(generated);

        assert!(cleaned.contains("function __commandError__<E>"));
        assert!(cleaned.contains("return __commandError__(e);"));
        assert!(!cleaned.contains("as any"));
    }

    #[test]
    fn replaces_generated_event_helper_any_proxies() {
        let generated = "type __EventObj__<T> = {\n\tlisten: unknown;\n};\n\nfunction __makeEvents__<T extends Record<string, any>>(\n\tmappings: Record<keyof T, string>,\n) {\n\treturn new Proxy({} as unknown as {}, {});\n}\n";
        let cleaned = replace_generated_event_helper(generated);

        assert!(cleaned.contains("type __EventAccessor__<T>"));
        assert!(cleaned.contains("function __makeEvents__<T extends object>"));
        assert!(!cleaned.contains("Record<string, any>"));
        assert!(!cleaned.contains("as unknown as"));
    }

    /// Regenerates `src/bindings.ts` from the live command/event registry.
    /// Run `cargo test` to refresh it; CI re-runs this then `git diff --exit-code
    /// src/bindings.ts` asserts the checked-in file is up to date.
    #[test]
    fn export_bindings() {
        export_typescript_bindings(&make_specta_builder(), "../src/bindings.ts")
            .expect("Failed to export typescript bindings");
    }
}
