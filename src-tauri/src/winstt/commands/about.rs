// About metadata and bundled legal text readers. No manager.
//
// The settings About panel currently calls only:
//   about_get_app_info  -> AboutAppInfo { version, frameworkVersion, webview2Version, copyright }
//
// The legal text commands stay registered for native/legal surfaces that need
// the bundled files without shipping them in the renderer bundle:
//   about_get_license   -> String   (the EULA / LICENSE text)
//   about_get_notices   -> String   (THIRD_PARTY_NOTICES.md)
//
// The renderer consumes the public app version + copyright and ignores the
// implementation-version fields.
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
const COPYRIGHT: &str = "© 2024-2026 WinSTT contributors";

/// The bundled End-User License text (repo-root `LICENSE`). Embedded at compile
/// time so no runtime file / resource registration is required.
const LICENSE_TEXT: &str = include_str!("../../../../LICENSE");

/// The bundled third-party notices (repo-root `THIRD_PARTY_NOTICES.md`).
const NOTICES_TEXT: &str = include_str!("../../../../THIRD_PARTY_NOTICES.md");

/// App metadata returned to the renderer. The About panel only displays the
/// product version and copyright; framework/runtime versions remain available
/// to native callers and generated bindings.
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

/// `about_get_app_info` — app metadata for About/native surfaces.
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
