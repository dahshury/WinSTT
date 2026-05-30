// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/07_*.md (file-transcribe)
// + lib_wiring.md §3, frontend/electron/ipc/file-transcribe-queue.ts. Wraps managers::FileTranscribeManager.
//
// File-transcription queue commands: enqueue (drag-drop), pause/resume (PTT held),
// cancel. Per-file/per-chunk progress is emitted as `file-transcribe-progress`.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::State;

use crate::winstt::managers::FileTranscribeManager;

/// `file_transcribe_enqueue` — queue files for sequential transcription. Returns
/// the assigned ids (correlate with the progress events).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_enqueue(
    file_tx: State<'_, Arc<FileTranscribeManager>>,
    paths: Vec<String>,
) -> Vec<String> {
    let mgr = file_tx.inner().clone();
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    mgr.enqueue(paths)
}

/// `file_transcribe_pause` — pause the queue (PTT pressed).
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_pause(file_tx: State<'_, Arc<FileTranscribeManager>>) {
    file_tx.pause();
}

/// `file_transcribe_resume` — resume a paused queue.
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_resume(file_tx: State<'_, Arc<FileTranscribeManager>>) {
    file_tx.resume();
}

/// `file_transcribe_cancel` — cancel the whole queue.
#[tauri::command]
#[specta::specta]
pub fn file_transcribe_cancel(file_tx: State<'_, Arc<FileTranscribeManager>>) {
    file_tx.cancel();
}
