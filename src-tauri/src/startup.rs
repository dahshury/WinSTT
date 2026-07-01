//! Boot-time utilities: log-level filter setup, startup profiling, dev-server
//! wait, and process-exit/watchdog helpers.

use env_filter::Builder as EnvFilterBuilder;
#[cfg(debug_assertions)]
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::AtomicU8;
#[cfg(debug_assertions)]
use std::time::Duration;
use std::time::Instant;
use tauri::AppHandle;

#[cfg(windows)]
use crate::signal_handle;

#[cfg(windows)]
const WEBVIEW2_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-logging --log-level=3";

// Global atomic to store the file log level filter
// We use u8 to store the log::LevelFilter as a number
pub static FILE_LOG_LEVEL: AtomicU8 = AtomicU8::new(log::LevelFilter::Debug as u8);

pub(crate) fn level_filter_from_u8(value: u8) -> log::LevelFilter {
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

pub(crate) fn build_console_filter() -> env_filter::Filter {
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

pub(crate) fn startup_profile_enabled() -> bool {
    env_flag_enabled("WINSTT_PROFILE_STARTUP")
}

pub(crate) fn model_profile_enabled() -> bool {
    env_flag_enabled("WINSTT_PROFILE_MODELS") || startup_profile_enabled()
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

pub(crate) fn log_startup_duration(label: &str, started: Instant) {
    if startup_profile_enabled() {
        log::info!("[startup] {label}: {} ms", started.elapsed().as_millis());
    }
}

pub(crate) fn log_model_duration(label: &str, started: Instant) {
    if model_profile_enabled() {
        log::info!(
            "[model-profile] {label}: {} ms",
            started.elapsed().as_millis()
        );
    }
}

#[cfg(windows)]
pub(crate) fn configure_webview_window_builder<'a, R, M>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    // Tauri's `additional_browser_args` replaces Wry's defaults, so keep those
    // defaults and add Chromium quiet-logging flags. This suppresses WebView2's
    // benign shutdown stderr line:
    // `Failed to unregister class Chrome_WidgetWin_0. Error = 1412`.
    builder.additional_browser_args(WEBVIEW2_BROWSER_ARGS)
}

#[cfg(not(windows))]
pub(crate) fn configure_webview_window_builder<'a, R, M>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M>
where
    R: tauri::Runtime,
    M: tauri::Manager<R>,
{
    builder
}

pub(crate) struct StartupProfiler {
    enabled: bool,
    start: Instant,
    last: Instant,
}

impl StartupProfiler {
    pub(crate) fn new() -> Self {
        let now = Instant::now();
        Self {
            enabled: startup_profile_enabled(),
            start: now,
            last: now,
        }
    }

    pub(crate) fn mark(&mut self, label: &str) {
        if !self.enabled {
            return;
        }
        let now = Instant::now();
        log::info!(
            "[startup] {label}: +{} ms ({} ms total)",
            now.duration_since(self.last).as_millis(),
            now.duration_since(self.start).as_millis()
        );
        self.last = now;
    }
}

#[cfg(debug_assertions)]
const RENDERER_DEV_SERVER_ADDR: &str = "127.0.0.1:1420";
#[cfg(debug_assertions)]
const RENDERER_DEV_SERVER_WAIT_TIMEOUT: Duration = Duration::from_millis(15_000);
#[cfg(debug_assertions)]
const RENDERER_DEV_SERVER_CONNECT_TIMEOUT: Duration = Duration::from_millis(200);

#[cfg(debug_assertions)]
pub(crate) fn wait_for_renderer_dev_server(startup: &mut StartupProfiler, app: &AppHandle) {
    let Ok(addr) = RENDERER_DEV_SERVER_ADDR.parse::<SocketAddr>() else {
        log::error!("[dev-server] invalid renderer dev server address: {RENDERER_DEV_SERVER_ADDR}");
        return;
    };
    let started = Instant::now();
    let mut attempts = 0u32;

    loop {
        attempts = attempts.saturating_add(1);
        match TcpStream::connect_timeout(&addr, RENDERER_DEV_SERVER_CONNECT_TIMEOUT) {
            Ok(_) => {
                if attempts > 1 {
                    log::info!(
                        "[dev-server] renderer reachable at http://{RENDERER_DEV_SERVER_ADDR} after {}ms",
                        started.elapsed().as_millis()
                    );
                }
                startup.mark("renderer dev server reachable");
                crate::splash::emit_startup_progress(app, "renderer dev server reachable");
                return;
            }
            Err(error) => {
                if started.elapsed() >= RENDERER_DEV_SERVER_WAIT_TIMEOUT {
                    log::warn!(
                        "[dev-server] renderer did not accept connections at http://{RENDERER_DEV_SERVER_ADDR} within {}ms ({error}); continuing",
                        RENDERER_DEV_SERVER_WAIT_TIMEOUT.as_millis()
                    );
                    startup.mark("renderer dev server wait timed out");
                    crate::splash::emit_startup_progress(app, "renderer dev server wait timed out");
                    return;
                }
            }
        }
        if attempts == 1 {
            log::info!(
                "[dev-server] waiting for http://{RENDERER_DEV_SERVER_ADDR} before creating WebViews"
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(not(debug_assertions))]
pub(crate) fn wait_for_renderer_dev_server(_startup: &mut StartupProfiler, _app: &AppHandle) {}

fn force_process_exit_success() -> ! {
    #[cfg(windows)]
    {
        signal_handle::terminate_process_success();
    }

    #[cfg(not(windows))]
    {
        std::process::exit(0);
    }
}

fn spawn_exit_watchdog() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(8000));
        log::warn!("Graceful exit stalled past 8s - forcing process exit.");
        force_process_exit_success();
    });
}

pub(crate) fn request_app_exit(app: &AppHandle, reason: &str) {
    log::info!("{reason} - exiting.");
    spawn_exit_watchdog();
    app.exit(0);
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
pub(crate) fn ensure_hf_cache_env() {
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
        std::env::set_var("HF_HOME", hf_home);
    }
}

/// No-op on non-Windows: `$HOME` is always set there, so hf-hub resolves the
/// cache correctly without help.
#[cfg(not(windows))]
pub(crate) fn ensure_hf_cache_env() {}
