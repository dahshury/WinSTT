// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/10_frontend_port_plan.md
// §1b/§6 (WU-11), frontend/electron/ipc/about.ts. No manager — reads bundled text + app metadata.
//
// The About panel (widgets/about-settings) calls three commands on mount:
//   about_get_license   -> String   (the EULA / LICENSE text)
//   about_get_notices   -> String   (THIRD_PARTY_NOTICES.md)
//   about_get_app_info  -> AboutAppInfo { version, electronVersion, nodeVersion, copyright }
//
// The renderer's `AboutAppInfo` shape (shared/api/ipc-client.ts) is byte-identical to the
// `#[serde(rename_all = "camelCase")]` struct below, so the polyfill passes the value through
// `invoke` unchanged (no reshape).
//
// LICENSE / THIRD_PARTY_NOTICES.md ship as compile-time `include_str!` blobs (relative to this
// source file → repo root) rather than runtime resources, so the port needs no `tauri.conf.json`
// edit (HARD RULE: only new files under winstt/commands/). They are tiny (a ~1 KB MIT body + a
// ~19 KB notices file) so embedding them in the binary is negligible.
//
// The Electron build reported `process.versions.electron` / `process.versions.node`. Tauri has
// neither; the two rows are kept (the renderer ports verbatim and still renders the "Electron" /
// "Node" labels) by reporting the closest faithful equivalents: the Tauri framework version and the
// embedded WebView (WebView2 / WKWebView / WebKitGTK) version. Both fall back to "—" in the UI when
// empty, so an unavailable WebView probe degrades cleanly.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

/// © string shown under the WinSTT product name. Matches the Electron handler's
/// `COPYRIGHT` constant (frontend/electron/ipc/about.ts) verbatim.
const COPYRIGHT: &str = "© 2024-2026 dahshury";

/// The bundled End-User License text (repo-root `LICENSE`). Embedded at compile
/// time so no runtime file / resource registration is required.
const LICENSE_TEXT: &str = include_str!("../../../../../LICENSE");

/// The bundled third-party notices (repo-root `THIRD_PARTY_NOTICES.md`).
const NOTICES_TEXT: &str = include_str!("../../../../../THIRD_PARTY_NOTICES.md");

/// App metadata surfaced in the About panel. Field names mirror the renderer's
/// `AboutAppInfo` interface exactly (camelCase) so the value round-trips through
/// the electronAPI polyfill with no reshape.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AboutAppInfo {
    pub version: String,
    /// Desktop-framework version. In the Electron build this was the Electron
    /// runtime version; in Tauri it is the Tauri framework version.
    pub electron_version: String,
    /// JS-runtime version. In Electron this was Node's version; in Tauri the
    /// closest analogue surfaced to the user is the embedded WebView version.
    pub node_version: String,
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
        electron_version: tauri::VERSION.to_string(),
        node_version: webview_version(),
        copyright: COPYRIGHT.to_string(),
    }
}
