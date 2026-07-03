//! Commands for the encoder dictionary model download (the non-LLM fallback). Mirror the managed
//! STT download UX: start / pause / resume / cancel + a status query that seeds a freshly-opened
//! Vocabulary tab. Progress + completion are broadcast via `encoder-dict:download-*` events.

use std::sync::Arc;

use tauri::State;

use crate::command_auth;
use crate::winstt::encoder_dict::download::{EncoderDownloadStatus, EncoderModelDownloader};

const ENCODER_DICT_MUTATION_ALLOWED_WINDOWS: &[&str] = &["settings"];

#[cfg(test)]
fn is_encoder_dict_mutation_allowed(caller: &str) -> bool {
    command_auth::label_in(caller, ENCODER_DICT_MUTATION_ALLOWED_WINDOWS)
}

fn authorize_encoder_dict_mutation(
    caller: &tauri::WebviewWindow,
    action: &str,
) -> Result<(), String> {
    command_auth::authorize_webview(
        caller,
        "encoder_dict",
        action,
        ENCODER_DICT_MUTATION_ALLOWED_WINDOWS,
        "",
    )
}

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
    webview: tauri::WebviewWindow,
) -> Result<(), String> {
    authorize_encoder_dict_mutation(&webview, "start encoder dictionary download")?;
    downloader.inner().start();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn encoder_dict_download_pause(
    downloader: State<'_, Arc<EncoderModelDownloader>>,
    webview: tauri::WebviewWindow,
) -> Result<(), String> {
    authorize_encoder_dict_mutation(&webview, "pause encoder dictionary download")?;
    downloader.pause();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn encoder_dict_download_resume(
    downloader: State<'_, Arc<EncoderModelDownloader>>,
    webview: tauri::WebviewWindow,
) -> Result<(), String> {
    authorize_encoder_dict_mutation(&webview, "resume encoder dictionary download")?;
    // Resume == start: the streamer picks up the partial file via an HTTP Range request.
    downloader.inner().start();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn encoder_dict_download_cancel(
    downloader: State<'_, Arc<EncoderModelDownloader>>,
    webview: tauri::WebviewWindow,
) -> Result<(), String> {
    authorize_encoder_dict_mutation(&webview, "cancel encoder dictionary download")?;
    downloader.cancel();
    Ok(())
}

/// Delete the downloaded model from disk (and drop it from memory) — used when the user turns the
/// on-device dictionary feature off.
#[tauri::command]
#[specta::specta]
pub fn encoder_dict_remove(
    downloader: State<'_, Arc<EncoderModelDownloader>>,
    webview: tauri::WebviewWindow,
) -> Result<(), String> {
    authorize_encoder_dict_mutation(&webview, "remove encoder dictionary model")?;
    downloader.remove();
    Ok(())
}

/// Preload + warm the model in the background (no-op if not downloaded yet). Called when the user
/// turns the feature on, so the first dictation is fast instead of cold-loading.
#[tauri::command]
#[specta::specta]
pub fn encoder_dict_preload(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
) -> Result<(), String> {
    authorize_encoder_dict_mutation(&webview, "preload encoder dictionary model")?;
    crate::winstt::encoder_dict::preload_async(&app);
    Ok(())
}

/// Drop the loaded model from memory (keeps the files on disk) — called when the user turns the
/// feature off, to free the ~310 MB session it was holding.
#[tauri::command]
#[specta::specta]
pub fn encoder_dict_unload(webview: tauri::WebviewWindow) -> Result<(), String> {
    authorize_encoder_dict_mutation(&webview, "unload encoder dictionary model")?;
    crate::winstt::encoder_dict::clear_loaded();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoder_dict_mutation_authorization_matches_settings_surface() {
        command_auth::assert_label_rules(
            &["settings"],
            &[
                "main",
                "overlay",
                "tray-menu",
                "model-picker",
                "device-picker",
                "history",
                "context-playground",
            ],
            is_encoder_dict_mutation_allowed,
        );
    }
}
