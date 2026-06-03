// About panel backend. No manager — reads bundled text + app metadata.
//
// The About panel (widgets/about-settings) calls three commands on mount:
//   about_get_license   -> String   (the EULA / LICENSE text)
//   about_get_notices   -> String   (THIRD_PARTY_NOTICES.md)
//   about_get_app_info  -> AboutAppInfo { version, frameworkVersion, webview2Version, copyright }
//
// The renderer's `AboutAppInfo` shape (shared/api/ipc-client.ts) matches the
// `#[serde(rename_all = "camelCase")]` struct below, so `invoke` passes the value through
// unchanged (no reshape).
//
// LICENSE / THIRD_PARTY_NOTICES.md ship as compile-time `include_str!` blobs (relative to this
// source file → repo root) rather than runtime resources. They are tiny (a ~1 KB MIT body + a
// ~19 KB notices file) so embedding them in the binary is negligible.
//
// The two version rows surface the Tauri framework version and the embedded WebView
// (WebView2 / WKWebView / WebKitGTK) version. Both fall back to "—" in the UI when empty, so an
// unavailable WebView probe degrades cleanly.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

/// © string shown under the WinSTT product name.
const COPYRIGHT: &str = "© 2024-2026 dahshury";

/// The bundled End-User License text (repo-root `LICENSE`). Embedded at compile
/// time so no runtime file / resource registration is required.
const LICENSE_TEXT: &str = include_str!("../../../../LICENSE");

/// The bundled third-party notices (repo-root `THIRD_PARTY_NOTICES.md`).
const NOTICES_TEXT: &str = include_str!("../../../../THIRD_PARTY_NOTICES.md");

/// App metadata surfaced in the About panel. Field names mirror the renderer's
/// `AboutAppInfo` interface exactly (camelCase) so the value round-trips through
/// `invoke` with no reshape.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AboutAppInfo {
    pub version: String,
    /// Desktop-framework version — the Tauri framework version.
    pub framework_version: String,
    /// Embedded-WebView version (WebView2 on Windows).
    pub webview2_version: String,
    pub copyright: String,
}

/// Best-effort embedded-WebView version (WebView2 on Windows, WKWebView on
/// macOS, WebKitGTK on Linux). Returns an empty string if the probe fails so the
/// UI shows "—" rather than erroring.
fn webview_version() -> String {
    tauri::webview_version().unwrap_or_default()
}

/// `about_get_license` — the bundled EULA / LICENSE text.
#[tauri::command]
#[specta::specta]
pub fn about_get_license() -> String {
    LICENSE_TEXT.to_string()
}

/// `about_get_notices` — the bundled third-party notices.
#[tauri::command]
#[specta::specta]
pub fn about_get_notices() -> String {
    NOTICES_TEXT.to_string()
}

/// `about_get_app_info` — version + framework/webview versions + copyright.
#[tauri::command]
#[specta::specta]
pub fn about_get_app_info(app: AppHandle) -> AboutAppInfo {
    AboutAppInfo {
        version: app.package_info().version.to_string(),
        framework_version: tauri::VERSION.to_string(),
        webview2_version: webview_version(),
        copyright: COPYRIGHT.to_string(),
    }
}
