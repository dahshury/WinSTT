use std::sync::atomic::Ordering;

use env_filter::Filter;
use tauri::{Builder, Wry};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_log::{Builder as LogBuilder, RotationStrategy, Target, TargetKind};

use crate::cli::CliArgs;
use crate::startup::{level_filter_from_u8, FILE_LOG_LEVEL};

pub(crate) fn install_runtime_plugins(
    builder: Builder<Wry>,
    console_filter: Filter,
    cli_args: CliArgs,
) -> Builder<Wry> {
    #[allow(unused_mut)]
    let mut builder = builder
        .device_event_filter(tauri::DeviceEventFilter::Always)
        .plugin(tauri_plugin_dialog::init())
        .plugin(build_log_plugin(console_filter));

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--toggle-transcription") {
                crate::signal_handle::send_transcription_input(app, "transcribe", "CLI");
            } else if args.iter().any(|a| a == "--toggle-post-process") {
                crate::signal_handle::send_transcription_input(
                    app,
                    "transcribe_with_post_process",
                    "CLI",
                );
            } else if args.iter().any(|a| a == "--cancel") {
                crate::utils::cancel_current_operation(app);
            } else {
                crate::show_main_window(app);
            }
        }))
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
        .manage(crate::winstt::commands::updater::UpdaterRuntimeState::default())
        .manage(cli_args)
}

fn build_log_plugin(console_filter: Filter) -> tauri::plugin::TauriPlugin<Wry> {
    LogBuilder::new()
        .level(log::LevelFilter::Trace)
        .max_file_size(500_000)
        .rotation_strategy(RotationStrategy::KeepOne)
        .clear_targets()
        .targets([
            Target::new(TargetKind::Stdout).filter({
                let console_filter = console_filter.clone();
                move |metadata| console_filter.enabled(metadata)
            }),
            Target::new(if let Some(data_dir) = crate::portable::data_dir() {
                TargetKind::Folder {
                    path: data_dir.join("logs"),
                    file_name: Some("winstt".into()),
                }
            } else {
                TargetKind::LogDir {
                    file_name: Some("winstt".into()),
                }
            })
            .filter(|metadata| {
                let file_level = FILE_LOG_LEVEL.load(Ordering::Relaxed);
                metadata.level() <= level_filter_from_u8(file_level)
            }),
        ])
        .build()
}
