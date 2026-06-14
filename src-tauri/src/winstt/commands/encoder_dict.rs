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
