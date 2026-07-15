// Wraps managers::FileTranscribeManager.
//
// The multi-file transcription queue command surface. The renderer
// (`features/file-transcription` + `widgets/audio-display`) calls these generated
// commands directly with byte-identical argument shapes:
//
//   file:transcribe        → file_transcribe_enqueue   { files: [{ filePath, fileName }] }
//   file:queue-enqueue     → file_transcribe_enqueue   { files: [{ filePath, fileName }] }
//   file:queue-cancel      → file_transcribe_cancel    { id }
//   file:queue-retry       → file_transcribe_retry     { id }
//   file:queue-copy        → file_transcribe_copy      { id }
//   file:queue-clear       → file_transcribe_clear     {}
//   file:queue-pause       → file_transcribe_pause     { id? }   (no id = PTT whole-queue)
//   file:queue-resume      → file_transcribe_resume    { id? }   (no id = PTT whole-queue)
//   file:queue-discard-all → file_transcribe_discard_all {}
//   file:queue-get-active  → file_transcribe_get_active {}  -> bool
//
// Progress + structural updates are EMITTED by the manager as the three plain
// `file:queue-*` events the reused renderer listener subscribes to. Every payload
// type derives `specta::Type` so tauri-specta emits TS bindings.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::command_auth;
use crate::winstt::managers::FileTranscribeManager;

const MAX_PICKED_FILES: usize = 32;
const MAX_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const SUPPORTED_MEDIA_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "flac", "m4a", "aac", "ogg", "wma", "mp4", "mkv", "avi", "mov", "wmv", "flv",
    "webm",
];
const FILE_TRANSCRIBE_QUEUE_WINDOWS: &[&str] = &["main"];
const FILE_TRANSCRIBE_PICK_WINDOWS: &[&str] = &["main", "tray-menu"];
const FILE_TRANSCRIBE_ACTIVE_WINDOWS: &[&str] = &["main", "model-picker"];

#[derive(Clone, Copy, Debug)]
enum FileTranscribeOperation {
    Enqueue,
    PickAndEnqueue,
    ControlQueue,
    ReadActive,
}

impl FileTranscribeOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Enqueue => "enqueue file transcription",
            Self::PickAndEnqueue => "open file transcription picker",
            Self::ControlQueue => "control file transcription queue",
            Self::ReadActive => "read file transcription active state",
        }
    }

    fn allowed_windows(self) -> &'static [&'static str] {
        match self {
            Self::Enqueue | Self::ControlQueue => FILE_TRANSCRIBE_QUEUE_WINDOWS,
            Self::PickAndEnqueue => FILE_TRANSCRIBE_PICK_WINDOWS,
            Self::ReadActive => FILE_TRANSCRIBE_ACTIVE_WINDOWS,
        }
    }
}

fn authorize_file_transcribe_operation(
    caller: &tauri::WebviewWindow,
    operation: FileTranscribeOperation,
) -> Result<(), String> {
    command_auth::authorize_webview(
        caller,
        "file_transcribe",
        operation.as_str(),
        operation.allowed_windows(),
        "",
    )
}

#[cfg(test)]
fn is_file_transcribe_operation_allowed(caller: &str, operation: FileTranscribeOperation) -> bool {
    command_auth::label_in(caller, operation.allowed_windows())
}

/// One dropped file: its native path + display name (resolved renderer-side via
/// the `getPathForFile` drag-drop bridge). Mirrors the reference enqueue payload.
#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
pub struct DroppedFile {
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(rename = "fileName", default)]
    pub file_name: String,
}

fn is_supported_media_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            SUPPORTED_MEDIA_EXTENSIONS
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        })
}

fn prepare_backend_selected_files(paths: Vec<PathBuf>) -> Vec<(PathBuf, String)> {
    paths
        .into_iter()
        .take(MAX_PICKED_FILES)
        .filter(|path| is_supported_media_path(path))
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
                return None;
            }
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("audio")
                .to_string();
            Some((path, file_name))
        })
        .collect()
}

fn display_file_name(path: &std::path::Path, fallback: &str) -> String {
    let fallback = fallback.trim();
    if !fallback.is_empty()
        && let Some(name) = std::path::Path::new(fallback)
            .file_name()
            .and_then(|name| name.to_str())
    {
        return name.to_string();
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio")
        .to_string()
}

fn is_webview_allowed_file(webview: &tauri::WebviewWindow, path: &Path) -> bool {
    webview.asset_protocol_scope().is_allowed(path)
}

fn prepare_dropped_files(
    webview: &tauri::WebviewWindow,
    files: Vec<DroppedFile>,
) -> Vec<(PathBuf, String)> {
    files
        .into_iter()
        .take(MAX_PICKED_FILES)
        .filter_map(|file| {
            let raw = file.file_path.trim();
            if raw.is_empty() {
                return None;
            }
            let path = PathBuf::from(raw);
            if !is_supported_media_path(&path) {
                return None;
            }
            let meta = std::fs::metadata(&path).ok()?;
            if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
                return None;
            }
            let path = path.canonicalize().unwrap_or(path);
            if !is_webview_allowed_file(webview, &path) {
                log::warn!(
                    "[file_transcribe] blocked renderer path not present in caller file scope: {}",
                    path.display()
                );
                return None;
            }
            let file_name = display_file_name(&path, &file.file_name);
            Some((path, file_name))
        })
        .collect()
}

fn enqueue_prepared(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    prepared: Vec<(PathBuf, String)>,
) -> Vec<String> {
    if prepared.is_empty() {
        return Vec::new();
    }
    file_tx.inner().clone().enqueue(prepared)
}

/// `file_transcribe_enqueue` — append files to the sequential queue (drop order
/// preserved; repeated calls accumulate). Returns the assigned row ids (the
/// renderer correlates these with the `file:queue-*` events). The shared STT
/// model is single-threaded, so files transcribe one at a time.
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_enqueue(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    webview: tauri::WebviewWindow,
    files: Vec<DroppedFile>,
) -> Vec<String> {
    if authorize_file_transcribe_operation(&webview, FileTranscribeOperation::Enqueue).is_err() {
        return Vec::new();
    }
    let prepared = prepare_dropped_files(&webview, files);
    enqueue_prepared(file_tx, prepared)
}

/// Open a backend-owned native picker and enqueue only selected supported media
/// files. This keeps local/UNC paths out of renderer-controlled IPC.
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_pick_and_enqueue(
    app: AppHandle,
    webview: tauri::WebviewWindow,
    file_tx: State<'_, Arc<FileTranscribeManager>>,
) -> Vec<String> {
    if authorize_file_transcribe_operation(&webview, FileTranscribeOperation::PickAndEnqueue)
        .is_err()
    {
        return Vec::new();
    }
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("Select Audio or Video Files")
        .add_filter("Audio or Video", SUPPORTED_MEDIA_EXTENSIONS)
        .blocking_pick_files()
    else {
        return Vec::new();
    };
    let paths = selected
        .into_iter()
        .filter_map(|file_path| file_path.into_path().ok())
        .collect::<Vec<_>>();
    let prepared = prepare_backend_selected_files(paths);
    enqueue_prepared(file_tx, prepared)
}

/// `file_transcribe_cancel` `{id}` — drop a queued/paused row, or cancel the
/// in-flight file (removed once its one-shot transcribe returns).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_cancel(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    webview: tauri::WebviewWindow,
    id: String,
) {
    if authorize_file_transcribe_operation(&webview, FileTranscribeOperation::ControlQueue).is_err()
    {
        return;
    }
    file_tx.inner().clone().cancel(&id);
}

/// `file_transcribe_retry` `{id}` — re-queue a terminal/paused row from scratch.
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_retry(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    webview: tauri::WebviewWindow,
    id: String,
) {
    if authorize_file_transcribe_operation(&webview, FileTranscribeOperation::ControlQueue).is_err()
    {
        return;
    }
    file_tx.inner().clone().retry(&id);
}

/// `file_transcribe_copy` `{id}` — copy a completed row's transcript to the
/// clipboard (via the clipboard-manager plugin).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_copy(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    webview: tauri::WebviewWindow,
    id: String,
) {
    if authorize_file_transcribe_operation(&webview, FileTranscribeOperation::ControlQueue).is_err()
    {
        return;
    }
    file_tx.copy(&id);
}

/// `file_transcribe_clear` — remove every terminal row (the auto-clear path).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_clear(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    webview: tauri::WebviewWindow,
) {
    if authorize_file_transcribe_operation(&webview, FileTranscribeOperation::ControlQueue).is_err()
    {
        return;
    }
    file_tx.inner().clone().clear_finished();
}

/// `file_transcribe_pause` — optional `{id}`.
///   • with `id` → per-row manual pause.
///   • no `id`   → PTT whole-queue auto-pause (the model is busy dictating).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_pause(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    webview: tauri::WebviewWindow,
    id: Option<String>,
) {
    if authorize_file_transcribe_operation(&webview, FileTranscribeOperation::ControlQueue).is_err()
    {
        return;
    }
    file_tx.inner().clone().pause(id.as_deref());
}

/// `file_transcribe_resume` — optional `{id}` (symmetric with pause).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_resume(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    webview: tauri::WebviewWindow,
    id: Option<String>,
) {
    if authorize_file_transcribe_operation(&webview, FileTranscribeOperation::ControlQueue).is_err()
    {
        return;
    }
    file_tx.inner().clone().resume(id.as_deref());
}

/// `file_transcribe_discard_all` — cancel the in-flight file and drop all rows.
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_discard_all(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    webview: tauri::WebviewWindow,
) {
    if authorize_file_transcribe_operation(&webview, FileTranscribeOperation::ControlQueue).is_err()
    {
        return;
    }
    file_tx.inner().clone().discard_all();
}

/// `file_transcribe_get_active` — one-shot busy-flag read for windows mounted
/// AFTER the edge-triggered `file:queue-active` broadcast.
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_get_active(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    webview: tauri::WebviewWindow,
) -> bool {
    if authorize_file_transcribe_operation(&webview, FileTranscribeOperation::ReadActive).is_err() {
        return false;
    }
    file_tx.is_active()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_transcribe_authorization_matches_renderer_surfaces() {
        command_auth::assert_label_rules(
            &["main"],
            &[
                "settings",
                "overlay",
                "tray-menu",
                "history",
                "context-playground",
            ],
            |caller| is_file_transcribe_operation_allowed(caller, FileTranscribeOperation::Enqueue),
        );
        command_auth::assert_label_rules(
            &["main", "tray-menu"],
            &["settings", "overlay", "history", "context-playground"],
            |caller| {
                is_file_transcribe_operation_allowed(
                    caller,
                    FileTranscribeOperation::PickAndEnqueue,
                )
            },
        );
        command_auth::assert_label_rules(
            &["main", "model-picker"],
            &[
                "settings",
                "overlay",
                "tray-menu",
                "history",
                "context-playground",
            ],
            |caller| {
                is_file_transcribe_operation_allowed(caller, FileTranscribeOperation::ReadActive)
            },
        );
    }
}
