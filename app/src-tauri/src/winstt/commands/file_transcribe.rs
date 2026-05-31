// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/07_*.md +
// 10_frontend_port_plan.md §6 WU-8 + lib_wiring.md §3, and the authoritative
// frontend/electron/ipc/file-transcribe-queue.ts. Wraps managers::FileTranscribeManager.
//
// The multi-file transcription queue command surface. The renderer
// (`features/file-transcription` + `widgets/audio-display`) drives these via the
// `window.electronAPI` polyfill (electron-tauri-adapter.ts), which routes the
// WinSTT `file:queue-*` channels to these commands with BYTE-IDENTICAL arg shapes:
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

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::winstt::managers::FileTranscribeManager;

/// One dropped file: its native path + display name (resolved renderer-side via
/// the `getPathForFile` drag-drop bridge). Mirrors the Electron enqueue payload.
#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
pub struct DroppedFile {
    #[serde(rename = "filePath")]
    pub file_path: String,
    #[serde(rename = "fileName", default)]
    pub file_name: String,
}

/// `file_transcribe_enqueue` — append files to the sequential queue (drop order
/// preserved; repeated calls accumulate). Returns the assigned row ids (the
/// renderer correlates these with the `file:queue-*` events). The shared STT
/// model is single-threaded, so files transcribe one at a time.
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_enqueue(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    files: Vec<DroppedFile>,
) -> Vec<String> {
    let mgr = file_tx.inner().clone();
    let prepared: Vec<(PathBuf, String)> = files
        .into_iter()
        .map(|f| (PathBuf::from(f.file_path), f.file_name))
        .collect();
    mgr.enqueue(prepared)
}

/// `file_transcribe_cancel` `{id}` — drop a queued/paused row, or cancel the
/// in-flight file (removed once its one-shot transcribe returns).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_cancel(file_tx: State<'_, Arc<FileTranscribeManager>>, id: String) {
    file_tx.inner().clone().cancel(&id);
}

/// `file_transcribe_retry` `{id}` — re-queue a terminal/paused row from scratch.
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_retry(file_tx: State<'_, Arc<FileTranscribeManager>>, id: String) {
    file_tx.inner().clone().retry(&id);
}

/// `file_transcribe_copy` `{id}` — copy a completed row's transcript to the
/// clipboard (via the clipboard-manager plugin).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_copy(file_tx: State<'_, Arc<FileTranscribeManager>>, id: String) {
    file_tx.copy(&id);
}

/// `file_transcribe_clear` — remove every terminal row (the auto-clear path).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_clear(file_tx: State<'_, Arc<FileTranscribeManager>>) {
    file_tx.inner().clone().clear_finished();
}

/// `file_transcribe_pause` — optional `{id}`.
///   • with `id` → per-row manual pause.
///   • no `id`   → PTT whole-queue auto-pause (the model is busy dictating).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_pause(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    id: Option<String>,
) {
    file_tx.inner().clone().pause(id.as_deref());
}

/// `file_transcribe_resume` — optional `{id}` (symmetric with pause).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_resume(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    id: Option<String>,
) {
    file_tx.inner().clone().resume(id.as_deref());
}

/// `file_transcribe_discard_all` — cancel the in-flight file and drop all rows.
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_discard_all(file_tx: State<'_, Arc<FileTranscribeManager>>) {
    file_tx.inner().clone().discard_all();
}

/// `file_transcribe_get_active` — one-shot busy-flag read for windows mounted
/// AFTER the edge-triggered `file:queue-active` broadcast.
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_get_active(file_tx: State<'_, Arc<FileTranscribeManager>>) -> bool {
    file_tx.is_active()
}
