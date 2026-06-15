//! Commands for the encoder dictionary model download (the non-LLM fallback). Mirror the managed
//! STT download UX: start / pause / resume / cancel + a status query that seeds a freshly-opened
//! Vocabulary tab. Progress + completion are broadcast via `encoder-dict:download-*` events.

use std::sync::Arc;

use tauri::State;

use crate::winstt::encoder_dict::download::{EncoderDownloadStatus, EncoderModelDownloader};

#[tauri::command]
#[specta::specta]
pub fn encoder_dict_status(
    downloader: State<'_, Arc<EncoderModelDownloader>>,
) -> EncoderDownloadStatus {
    downloader.status()
}

#[tauri::command]
#[specta::specta]
pub fn encoder_dict_download_start(
    downloader: State<'_, Arc<EncoderModelDownloader>>,
) -> Result<(), String> {
    downloader.inner().start();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn encoder_dict_download_pause(
    downloader: State<'_, Arc<EncoderModelDownloader>>,
) -> Result<(), String> {
    downloader.pause();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn encoder_dict_download_resume(
    downloader: State<'_, Arc<EncoderModelDownloader>>,
) -> Result<(), String> {
    // Resume == start: the streamer picks up the partial file via an HTTP Range request.
    downloader.inner().start();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn encoder_dict_download_cancel(
    downloader: State<'_, Arc<EncoderModelDownloader>>,
) -> Result<(), String> {
    downloader.cancel();
    Ok(())
}

/// Delete the downloaded model from disk (and drop it from memory) — used when the user turns the
/// on-device dictionary feature off.
#[tauri::command]
#[specta::specta]
pub fn encoder_dict_remove(
    downloader: State<'_, Arc<EncoderModelDownloader>>,
) -> Result<(), String> {
    downloader.remove();
    Ok(())
}

/// Preload + warm the model in the background (no-op if not downloaded yet). Called when the user
/// turns the feature on, so the first dictation is fast instead of cold-loading.
#[tauri::command]
#[specta::specta]
pub fn encoder_dict_preload(app: tauri::AppHandle) -> Result<(), String> {
    crate::winstt::encoder_dict::preload_async(&app);
    Ok(())
}

/// Drop the loaded model from memory (keeps the files on disk) — called when the user turns the
/// feature off, to free the ~310 MB session it was holding.
#[tauri::command]
#[specta::specta]
pub fn encoder_dict_unload() -> Result<(), String> {
    crate::winstt::encoder_dict::clear_loaded();
    Ok(())
}
