// Model-download command surface. Reference:
//   frontend/src/shared/api/ipc-client.ts (predownloadModelQuant / pauseModelDownload /
//     resumeModelDownload / cancelModelDownloadQuant / deleteModelQuantization /
//     deleteModelCache / cancelDownload — the exact arg shapes)
//   + frontend/electron/ipc/stt-models.ts (the channel handlers these mapped to).
//
// The per-quant download command surface. Each command pulls the `DownloadManager` from Tauri
// state and forwards the call. The manager owns the keyed in-flight registry + the four
// `stt:model-download-*` / `stt:model-cache-changed` broadcasts (download_manager.rs).
//
// IPC mapping (app/src/shared/api/native-bridge-adapter.ts ROUTE):
//   IPC.STT_PREDOWNLOAD_QUANT       (`stt:predownload-quant`,        { modelId, quantization }) → predownload_quant
//   IPC.STT_DOWNLOAD_PAUSE          (`stt:download-pause`,           { modelId, quantization }) → download_pause_quant
//   IPC.STT_DOWNLOAD_RESUME         (`stt:download-resume`,          { modelId, quantization }) → download_resume_quant
//   IPC.STT_DOWNLOAD_CANCEL_QUANT   (`stt:download-cancel-quant`,    { modelId, quantization }) → download_cancel_quant
//   IPC.STT_DELETE_MODEL_QUANTIZATION (`stt:delete-model-quantization`, { modelId, quantization }) → delete_model_quantization
//   IPC.STT_DELETE_MODEL_CACHE      (`stt:delete-model-cache`,       { modelId })               → delete_model_cache
//   IPC.STT_CANCEL_DOWNLOAD         (`stt:cancel-download`)                                      → cancel_download
//
// NOTE on arg shape: every `{ modelId, quantization }` or `{ modelId }` channel deserializes into
// the camelCase Tauri params (`model_id`, `quantization`).

use std::sync::Arc;

use tauri::State;

use crate::command_auth;
use crate::winstt::catalog::{self, ModelEntry};
use crate::winstt::managers::DownloadManager;
use crate::winstt::stt::{resolver, Quantization};

fn catalog_model(model_id: &str, action: &str) -> Result<&'static ModelEntry, String> {
    catalog::find(model_id)
        .ok_or_else(|| format!("Refusing to {action} for unknown STT catalog model '{model_id}'"))
}

fn validate_quantization_token(quantization: &str, action: &str) -> Result<(), String> {
    if quantization.trim() != quantization {
        return Err(format!(
            "Refusing to {action} for STT quantization with leading/trailing whitespace"
        ));
    }
    if Quantization::parse(quantization).is_none() {
        return Err(format!(
            "Refusing to {action} for unsupported STT quantization '{quantization}'"
        ));
    }
    Ok(())
}

fn download_model_target(
    model_id: &str,
    action: &str,
) -> Result<Option<&'static ModelEntry>, String> {
    if model_id.trim().is_empty() {
        return Err(format!("Refusing to {action} for empty STT model id"));
    }
    if model_id.trim() != model_id {
        return Err(format!(
            "Refusing to {action} for STT model id with leading/trailing whitespace"
        ));
    }

    if let Some(entry) = catalog::find(model_id) {
        return Ok(Some(entry));
    }

    // Explicit off-catalog HF repos and known onnx-asr aliases are intentional compatibility paths.
    // `resolve_repo` also rejects malformed owner/name strings before any HF URL is built.
    if resolver::resolve_repo(model_id).is_some() {
        return Ok(None);
    }

    Err(format!(
        "Refusing to {action} for unknown STT catalog model or HF repo '{model_id}'"
    ))
}

fn validate_entry_quantization(
    entry: &ModelEntry,
    model_id: &str,
    quantization: &str,
    action: &str,
) -> Result<(), String> {
    if entry.available_quantizations.contains(&quantization) {
        Ok(())
    } else {
        Err(format!(
            "Refusing to {action} for unpublished quantization '{quantization}' on STT model '{model_id}'"
        ))
    }
}

fn validate_download_quantization_target(
    model_id: &str,
    quantization: &str,
    action: &str,
) -> Result<(), String> {
    validate_quantization_token(quantization, action)?;
    if let Some(entry) = download_model_target(model_id, action)? {
        validate_entry_quantization(entry, model_id, quantization, action)?;
    }
    Ok(())
}

fn validate_catalog_quantization(
    model_id: &str,
    quantization: &str,
    action: &str,
) -> Result<(), String> {
    validate_quantization_token(quantization, action)?;
    let entry = catalog_model(model_id, action)?;
    validate_entry_quantization(entry, model_id, quantization, action)
}

const STT_CACHE_MUTATION_ALLOWED_WINDOWS: &[&str] = &["settings", "model-picker", "onboarding"];

#[cfg(test)]
fn is_stt_cache_mutation_allowed(caller: &str) -> bool {
    command_auth::label_in(caller, STT_CACHE_MUTATION_ALLOWED_WINDOWS)
}

/// `predownload_quant` — start a byte-level pause/resume capable download for one
/// `(model_id, quantization)` tuple, INTO the HF cache without changing the loaded model.
/// Emits `stt:model-download-start` immediately so the badge flips to "downloading".
#[tauri::command]
#[specta::specta]
pub fn predownload_quant(
    downloads: State<'_, Arc<DownloadManager>>,
    model_id: String,
    quantization: String,
) -> Result<(), String> {
    validate_download_quantization_target(&model_id, &quantization, "start STT download")?;
    // DIAGNOSTIC: trace the download trigger (the reported "clicking download does nothing /
    // resets the selector" — confirms the command is actually reached + with what args).
    log::info!("[download] predownload_quant requested: model='{model_id}' quant='{quantization}'");
    downloads.predownload_quant(model_id, quantization);
    Ok(())
}

/// `download_pause_quant` — pause the in-flight per-quant download (.partial preserved on disk for
/// the next Range-resume). The renderer flips the badge optimistically; this confirms it.
#[tauri::command]
#[specta::specta]
pub fn download_pause_quant(
    downloads: State<'_, Arc<DownloadManager>>,
    model_id: String,
    quantization: String,
) -> Result<(), String> {
    validate_download_quantization_target(&model_id, &quantization, "pause STT download")?;
    downloads.pause_quant(&model_id, &quantization);
    Ok(())
}

/// `download_resume_quant` — resume a paused per-quant download (skips already-cached files).
#[tauri::command]
#[specta::specta]
pub fn download_resume_quant(
    downloads: State<'_, Arc<DownloadManager>>,
    model_id: String,
    quantization: String,
) -> Result<(), String> {
    validate_download_quantization_target(&model_id, &quantization, "resume STT download")?;
    downloads.resume_quant(model_id, quantization);
    Ok(())
}

/// `download_cancel_quant` — cancel an in-flight per-quant download; the current file's `.partial`
/// is unlinked, previously-completed files are kept (delete_model_quantization wipes those too).
#[tauri::command]
#[specta::specta]
pub fn download_cancel_quant(
    downloads: State<'_, Arc<DownloadManager>>,
    model_id: String,
    quantization: String,
) -> Result<(), String> {
    validate_download_quantization_target(&model_id, &quantization, "cancel STT download")?;
    downloads.cancel_quant(&model_id, &quantization);
    Ok(())
}

/// `delete_model_quantization` — drop just the weight files matching `quantization` from the HF
/// cache of `model_id` (other quants intact). Re-broadcasts `stt:model-cache-changed`.
///
/// `async` so the blocking HF-cache scan + unlink runs on the blocking pool instead of stalling
/// the main thread (async commands register identically to sync ones).
#[tauri::command]
#[specta::specta]
pub async fn delete_model_quantization(
    downloads: State<'_, Arc<DownloadManager>>,
    webview: tauri::WebviewWindow,
    model_id: String,
    quantization: String,
) -> Result<(), String> {
    command_auth::authorize_webview(
        &webview,
        "download",
        "delete STT quantization",
        STT_CACHE_MUTATION_ALLOWED_WINDOWS,
        " through STT model cache",
    )?;
    validate_catalog_quantization(&model_id, &quantization, "delete STT quantization")?;
    let downloads = downloads.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        downloads.delete_quantization(&model_id, &quantization);
    })
    .await
    .map_err(|e| format!("delete_model_quantization task panicked: {e}"))
}

/// `delete_model_cache` — wipe the entire HF snapshot directory for `model_id`.
/// Re-broadcasts cache-changed.
///
/// `async` so the blocking snapshot-dir scan + remove runs on the blocking pool instead of
/// stalling the main thread (async commands register identically to sync ones).
#[tauri::command]
#[specta::specta]
pub async fn delete_model_cache(
    downloads: State<'_, Arc<DownloadManager>>,
    webview: tauri::WebviewWindow,
    model_id: String,
) -> Result<(), String> {
    command_auth::authorize_webview(
        &webview,
        "download",
        "delete STT cache",
        STT_CACHE_MUTATION_ALLOWED_WINDOWS,
        " through STT model cache",
    )?;
    catalog_model(&model_id, "delete STT cache")?;
    let downloads = downloads.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        downloads.delete_model_cache(&model_id);
    })
    .await
    .map_err(|e| format!("delete_model_cache task panicked: {e}"))
}

/// `cancel_download` — cancel the legacy single-slot whole-model swap-download (no quantization).
/// The renderer's `cancelDownload()` sends no args, so this stays a distinct arg-less command
/// rather than sharing the per-model/per-quantization cancel routes.
#[tauri::command]
#[specta::specta]
pub fn winstt_cancel_download(downloads: State<'_, Arc<DownloadManager>>) {
    downloads.cancel_download();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_target_accepts_catalog_published_quantization() {
        assert!(
            validate_download_quantization_target("tiny", "fp16", "start STT download").is_ok()
        );
    }

    #[test]
    fn download_target_rejects_catalog_unpublished_quantization() {
        let err = validate_download_quantization_target("tiny", "fp16w", "start STT download")
            .unwrap_err();

        assert!(err.contains("unpublished quantization 'fp16w'"));
    }

    #[test]
    fn download_target_rejects_unknown_bare_model_id() {
        let err = validate_download_quantization_target(
            "not-a-catalog-or-alias-model",
            "int8",
            "start STT download",
        )
        .unwrap_err();

        assert!(err.contains("unknown STT catalog model or HF repo"));
    }

    #[test]
    fn download_target_accepts_explicit_off_catalog_hf_repo_id() {
        assert!(validate_download_quantization_target(
            "some-owner/some-model",
            "int8",
            "start STT download",
        )
        .is_ok());
    }

    #[test]
    fn download_target_rejects_off_catalog_unknown_quantization() {
        let err = validate_download_quantization_target(
            "some-owner/some-model",
            "q5",
            "start STT download",
        )
        .unwrap_err();

        assert!(err.contains("unsupported STT quantization 'q5'"));
    }

    #[test]
    fn download_target_rejects_malformed_off_catalog_repo_id() {
        let err = validate_download_quantization_target(
            "some-owner/../some-model",
            "int8",
            "start STT download",
        )
        .unwrap_err();

        assert!(err.contains("unknown STT catalog model or HF repo"));
    }

    #[test]
    fn catalog_delete_keeps_catalog_only_policy() {
        let err = validate_catalog_quantization(
            "some-owner/some-model",
            "int8",
            "delete STT quantization",
        )
        .unwrap_err();

        assert!(err.contains("unknown STT catalog model"));
    }

    #[test]
    fn stt_cache_mutation_authorization_matches_renderer_flows() {
        command_auth::assert_label_rules(
            &["settings", "model-picker", "onboarding"],
            &[
                "main",
                "overlay",
                "tray-menu",
                "device-picker",
                "history",
                "context-playground",
            ],
            is_stt_cache_mutation_allowed,
        );
    }
}
