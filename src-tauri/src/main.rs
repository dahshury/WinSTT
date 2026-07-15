// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::Parser;
use winstt_app_lib::CliArgs;

fn main() {
    let cli_args = CliArgs::parse();

    if let Some(exit_code) = winstt_app_lib::cli::run_headless(&cli_args) {
        std::process::exit(exit_code);
    }

    #[cfg(target_os = "linux")]
    {
        // DMABUF renderer causes crashes on various GPU/display server configurations
        // See: https://github.com/tauri-apps/tauri/issues/9394
        // SAFETY: this runs at process startup before Tauri creates webview or worker threads.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }

    winstt_app_lib::run(cli_args)
}
