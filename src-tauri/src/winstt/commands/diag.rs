// Reference: frontend/electron/ipc/diag-bundle.ts. No manager — reads logs + zips them.
//
// The About panel's "Open logs folder" / "Save diagnostic bundle" actions map to:
//   diag_open_logs_folder -> DiagOpenLogsFolderResult { ok, error?, path? }
//   diag_save_bundle      -> DiagSaveBundleResult { ok, cancelled?, error?, path? }
//
// `diag_open_logs_folder` opens from Rust instead of the JS opener plugin. The log path is
// portable-aware (`Data/logs` beside the exe in portable mode), which cannot be represented
// cleanly as a narrow static opener scope. The command still returns the resolved path so the
// renderer/test surface stays inspectable.
//
// `diag_save_bundle` mirrors the reference handler: prompt for a save location (Desktop +
// `winstt-diag-<ts>.zip` default), collect whatever log files exist, append a `system-info.txt`,
// and write a single deflate zip. The renderer's `DiagSaveBundleResult` shape (shared/api/
// ipc-client.ts) is byte-identical to the camelCase struct below, so the value round-trips through
// the polyfill with no reshape. The post-save "reveal in folder" message box is intentionally
// dropped — the renderer already surfaces the saved path, and a blocking confirm dialog mid-command
// is worse UX in the Tauri build.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::command_auth;

const LOGS_FOLDER_ALLOWED_WINDOWS: &[&str] = &["settings"];

/// Result of `diag_save_bundle`. Field names mirror the renderer's
/// `DiagSaveBundleResult` interface exactly; `ok` is always present, the rest are
/// optional and skipped when absent so the JSON matches the reference handler.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagSaveBundleResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Result of `diag_open_logs_folder`. This mirrors the renderer-facing
/// `DiagOpenLogsFolderResult`: `ok` is always present; details are omitted when
/// not applicable.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagOpenLogsFolderResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

impl DiagOpenLogsFolderResult {
    fn ok_with(path: PathBuf) -> Self {
        Self {
            ok: true,
            error: None,
            path: Some(path.to_string_lossy().into_owned()),
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(message.into()),
            path: None,
        }
    }
}

impl DiagSaveBundleResult {
    fn ok_with(path: PathBuf) -> Self {
        Self {
            ok: true,
            cancelled: None,
            error: None,
            path: Some(path.to_string_lossy().into_owned()),
        }
    }

    fn cancelled() -> Self {
        Self {
            ok: false,
            cancelled: Some(true),
            error: None,
            path: None,
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            cancelled: None,
            error: Some(message.into()),
            path: None,
        }
    }
}

/// The log directory the diagnostic bundle reads from and "open logs folder"
/// reveals. Portable-aware (Data/logs in portable mode, app_log_dir otherwise),
/// matching where `tauri-plugin-log` writes.
fn logs_dir(app: &AppHandle) -> PathBuf {
    crate::portable::app_log_dir(app).unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg(test)]
fn is_logs_folder_opener_allowed(caller: &str) -> bool {
    command_auth::label_in(caller, LOGS_FOLDER_ALLOWED_WINDOWS)
}

/// `diag_open_logs_folder` — create and open the log directory, returning the
/// path that was opened. Restricted to the settings window, where the About tab
/// lives.
#[tauri::command]
#[specta::specta]
pub fn diag_open_logs_folder(app: AppHandle, webview: WebviewWindow) -> DiagOpenLogsFolderResult {
    if let Err(err) = command_auth::authorize_webview(
        &webview,
        "diagnostics",
        "open the logs folder",
        LOGS_FOLDER_ALLOWED_WINDOWS,
        "",
    ) {
        return DiagOpenLogsFolderResult::failed(err);
    }

    let dir = match crate::portable::app_log_dir(&app) {
        Ok(dir) => dir,
        Err(err) => {
            return DiagOpenLogsFolderResult::failed(format!("Failed to get log directory: {err}"));
        }
    };

    if let Err(err) = std::fs::create_dir_all(&dir) {
        return DiagOpenLogsFolderResult::failed(format!("Failed to create log directory: {err}"));
    }

    let path = dir.to_string_lossy().into_owned();
    if let Err(err) = app.opener().open_path(path, None::<String>) {
        return DiagOpenLogsFolderResult::failed(format!("Failed to open log directory: {err}"));
    }

    DiagOpenLogsFolderResult::ok_with(dir)
}

fn pad2(n: u32) -> String {
    if n < 10 {
        format!("0{n}")
    } else {
        n.to_string()
    }
}

/// `winstt-diag-YYYYMMDD-HHMMSS.zip` — same scheme as the reference handler's
/// `formatTimestampForFilename`, derived from local time without pulling `chrono`.
fn default_bundle_filename() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Decompose the unix timestamp into a UTC civil date/time. The the reference build
    // used local time; UTC here keeps the filename deterministic without a
    // timezone dep — the value is cosmetic (uniqueness, not correctness).
    let (y, mo, d, h, mi, s) = unix_to_civil(now);
    format!(
        "winstt-diag-{y}{}{}-{}{}{}.zip",
        pad2(mo),
        pad2(d),
        pad2(h),
        pad2(mi),
        pad2(s)
    )
}

/// Minimal UTC civil-time decomposition (days-since-epoch → Y/M/D, seconds → H/M/S).
/// Avoids a `chrono`/`time` dependency for a filename timestamp.
fn unix_to_civil(secs: u64) -> (u64, u32, u32, u32, u32, u32) {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let hour = (rem / 3600) as u32;
    let minute = ((rem % 3600) / 60) as u32;
    let second = (rem % 60) as u32;

    // Howard Hinnant's civil_from_days algorithm.
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = if month <= 2 { year + 1 } else { year } as u64;
    (year, month, day, hour, minute, second)
}

struct LogEntry {
    name: &'static str,
    source: PathBuf,
}

/// Candidate log files, filtered to those that actually exist (the reference
/// handler's `collectExistingLogFiles`). `tauri-plugin-log` writes a single
/// rolling log; the WinSTT-named files are included opportunistically.
fn collect_existing_log_files(logs_dir: &Path) -> Vec<LogEntry> {
    let candidates: [(&'static str, PathBuf); 4] = [
        ("WinSTT.log", logs_dir.join("WinSTT.log")),
        ("debug.log", logs_dir.join("debug.log")),
        ("debug.old.log", logs_dir.join("debug.old.log")),
        ("stt-server.log", logs_dir.join("stt-server.log")),
    ];
    candidates
        .into_iter()
        .filter(|(_, source)| source.exists())
        .map(|(name, source)| LogEntry { name, source })
        .collect()
}

/// The `system-info.txt` content (the reference handler's `buildSystemInfo`),
/// trimmed to what's available without `sysinfo`/the reference's `getGPUInfo`.
fn build_system_info(app: &AppHandle) -> String {
    let lines = [
        format!("WinSTT version: {}", app.package_info().version),
        format!("Tauri version: {}", tauri::VERSION),
        format!(
            "WebView version: {}",
            tauri::webview_version().unwrap_or_else(|_| "unknown".into())
        ),
        format!("Platform: {}", std::env::consts::OS),
        format!("Arch: {}", std::env::consts::ARCH),
        format!("Portable: {}", crate::portable::is_portable()),
    ];
    format!("{}\n", lines.join("\n"))
}

fn write_zip_archive(
    out_path: &Path,
    log_files: &[LogEntry],
    system_info: &str,
) -> Result<(), String> {
    let file = File::create(out_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for entry in log_files {
        // Read each log fully (logs are small relative to the diagnostic flow)
        // and embed it at the archive root under its display name, matching the
        // the reference handler's `addLocalFile(source, "", name)`.
        let bytes = std::fs::read(&entry.source).map_err(|e| e.to_string())?;
        zip.start_file(entry.name, options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    zip.start_file("system-info.txt", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(system_info.as_bytes())
        .map_err(|e| e.to_string())?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// Prompt for a save location (Desktop default), then collect logs + system-info
/// into a single deflate zip. Returns `cancelled` when the user dismisses the
/// dialog (matching the reference `{ ok:false, cancelled:true }`).
fn build_bundle(app: &AppHandle) -> DiagSaveBundleResult {
    let default_name = default_bundle_filename();
    let mut builder = app
        .dialog()
        .file()
        .set_title("Save diagnostic bundle")
        .add_filter("Zip", &["zip"])
        .set_file_name(default_name);
    if let Ok(desktop) = app.path().desktop_dir() {
        builder = builder.set_directory(desktop);
    }

    let Some(chosen) = builder.blocking_save_file() else {
        return DiagSaveBundleResult::cancelled();
    };
    let out_path = match chosen.into_path() {
        Ok(p) => p,
        Err(e) => return DiagSaveBundleResult::failed(e.to_string()),
    };

    let logs = logs_dir(app);
    let log_files = collect_existing_log_files(&logs);
    let system_info = build_system_info(app);

    match write_zip_archive(&out_path, &log_files, &system_info) {
        Ok(()) => DiagSaveBundleResult::ok_with(out_path),
        Err(e) => DiagSaveBundleResult::failed(e),
    }
}

/// `diag_save_bundle` — the full save flow. `async` so the blocking save dialog
/// runs off the main webview message loop (Tauri commands that block must be
/// `async` or `spawn_blocking`; the dialog plugin's `blocking_save_file` already
/// hops to the main thread internally).
#[tauri::command]
#[specta::specta]
pub async fn diag_save_bundle(app: AppHandle) -> DiagSaveBundleResult {
    build_bundle(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pads_single_digits() {
        assert_eq!(pad2(0), "00");
        assert_eq!(pad2(9), "09");
        assert_eq!(pad2(10), "10");
        assert_eq!(pad2(31), "31");
    }

    #[test]
    fn civil_from_known_epochs() {
        // 1970-01-01 00:00:00 UTC
        assert_eq!(unix_to_civil(0), (1970, 1, 1, 0, 0, 0));
        // 2000-01-01 00:00:00 UTC = 946_684_800
        assert_eq!(unix_to_civil(946_684_800), (2000, 1, 1, 0, 0, 0));
        // 2021-12-31 23:59:59 UTC = 1_640_995_199
        assert_eq!(unix_to_civil(1_640_995_199), (2021, 12, 31, 23, 59, 59));
    }

    #[test]
    fn default_filename_has_expected_shape() {
        let name = default_bundle_filename();
        assert!(name.starts_with("winstt-diag-"));
        assert!(name.ends_with(".zip"));
        // winstt-diag-YYYYMMDD-HHMMSS.zip = 12 + 8 + 1 + 6 + 4 = 31 chars
        assert_eq!(name.len(), 31);
    }

    #[test]
    fn logs_folder_opener_authorization_matches_about_panel() {
        command_auth::assert_label_rules(
            &["settings"],
            &[
                "main",
                "overlay",
                "tray-menu",
                "model-picker",
                "device-picker",
                "history",
                "onboarding",
                "context-playground",
            ],
            is_logs_folder_opener_allowed,
        );
    }
}
