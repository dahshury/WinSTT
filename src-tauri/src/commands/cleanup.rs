use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State, WebviewWindow};

use crate::command_auth;
use crate::managers::transcription::TranscriptionManager;
use crate::winstt::cleanup;
use crate::winstt::commands::settings::{
    apply_settings_patch, read_settings, PartialWinsttSettings,
};
use crate::winstt::managers::{
    tts_download_manager::TtsDownloadManager, DownloadManager, LlmManager, TtsManager,
};
use crate::winstt::observability::IssueBuilder;
use crate::winstt::settings_schema::RecordingMode;

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoveApplicationDataResult {
    pub scheduled: bool,
    pub portable: bool,
    pub delete_portable_app_dir: bool,
    pub deleted_ollama_models: Vec<String>,
    pub ollama_errors: Vec<String>,
}

/// One row of the "remove application data" disk-usage preview: a category key
/// (`stt` / `tts` / `dictionary` / `wakeword` / `history` / `logs` / `other`) and
/// its on-disk size in bytes.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppDataUsageEntry {
    pub key: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDownloadedModelsResult {
    pub deleted_model_caches: usize,
    pub disabled_features: Vec<String>,
    pub deleted_ollama_models: Vec<String>,
    pub ollama_errors: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
enum CleanupOperation {
    RemoveApplicationData,
    RemoveDownloadedModels,
}

impl CleanupOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::RemoveApplicationData => "remove application data",
            Self::RemoveDownloadedModels => "remove downloaded models",
        }
    }

    fn issue_operation(self) -> &'static str {
        match self {
            Self::RemoveApplicationData => "remove_application_data",
            Self::RemoveDownloadedModels => "remove_downloaded_models",
        }
    }
}

const CLEANUP_ALLOWED_WINDOWS: &[&str] = &["settings"];

fn cleanup_issue(
    operation: CleanupOperation,
    summary: impl Into<String>,
    detail: impl Into<String>,
) -> IssueBuilder {
    IssueBuilder::new("cleanup", operation.issue_operation(), summary)
        .detail(detail)
        .user_visible(true)
}

fn record_cleanup_failure(
    app: &AppHandle,
    operation: CleanupOperation,
    summary: &'static str,
    detail: impl Into<String>,
) {
    cleanup_issue(operation, summary, detail).record(Some(app));
}

fn record_cleanup_errors(
    app: &AppHandle,
    operation: CleanupOperation,
    summary: &'static str,
    errors: &[String],
) {
    if errors.is_empty() {
        return;
    }
    cleanup_issue(operation, summary, errors.join("; "))
        .kind("partial_failure")
        .severity("warn")
        .context("errorCount", errors.len().to_string())
        .record(Some(app));
}

#[cfg(test)]
fn is_cleanup_operation_allowed(caller: &str, _operation: CleanupOperation) -> bool {
    command_auth::label_in(caller, CLEANUP_ALLOWED_WINDOWS)
}

/// Best-effort delete a file or directory tree, pushing any failure onto
/// `errors` rather than aborting (a locked file leaves the rest intact).
fn delete_path_best_effort(path: &std::path::Path, errors: &mut Vec<String>) {
    if !path.exists() {
        return;
    }
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    if let Err(err) = result {
        errors.push(format!("{}: {err}", path.display()));
    }
}

/// Remove ONE app-data category in-process (no app restart), unwiring any
/// settings that referenced it so the next launch stays consistent. The
/// `history` category is handled by the existing `history_clear` command (it
/// deletes rows + their WAVs), so it is intentionally not accepted here.
/// Returns the list of per-path failures (empty on full success).
#[tauri::command]
#[specta::specta]
pub async fn remove_app_data_category(
    app: AppHandle,
    webview: WebviewWindow,
    transcription: State<'_, Arc<TranscriptionManager>>,
    downloads: State<'_, Arc<DownloadManager>>,
    tts_manager: State<'_, Arc<TtsManager>>,
    tts_downloads: State<'_, Arc<TtsDownloadManager>>,
    key: String,
) -> Result<Vec<String>, String> {
    command_auth::authorize_webview(
        &webview,
        "cleanup",
        "remove app data category",
        CLEANUP_ALLOWED_WINDOWS,
        "",
    )?;
    let mut errors = Vec::new();
    match key.as_str() {
        "stt" => {
            crate::utils::cancel_current_operation(&app);
            if let Err(err) = transcription.unload_model() {
                errors.push(format!("failed to unload STT model: {err}"));
            }
            cleanup::delete_stt_model_caches(downloads.inner(), &mut errors).await;
            // Clear the selected STT models so the app doesn't try to reload a
            // now-deleted cache on the next launch.
            let mut settings = read_settings(&app);
            settings.model.model.clear();
            settings.model.realtime_model.clear();
            if let Err(err) = apply_settings_patch(
                &app,
                PartialWinsttSettings {
                    model: Some(settings.model),
                    ..PartialWinsttSettings::default()
                },
            ) {
                errors.push(err);
            }
            cleanup::clear_legacy_selected_model(&app);
        }
        "tts" => {
            tts_manager.unload_active_local_model_for_cleanup("category cleanup");
            cleanup::delete_tts_model_caches(&app, tts_downloads.inner(), &mut errors);
            let mut settings = read_settings(&app);
            settings.tts.enabled = false;
            if let Err(err) = apply_settings_patch(
                &app,
                PartialWinsttSettings {
                    tts: Some(settings.tts),
                    ..PartialWinsttSettings::default()
                },
            ) {
                errors.push(err);
            }
        }
        "wakeword" => {
            cleanup::delete_wakeword_model_caches(&app, &mut errors);
            let mut settings = read_settings(&app);
            if matches!(settings.general.recording_mode, RecordingMode::Wakeword) {
                settings.general.recording_mode = RecordingMode::Ptt;
                if let Err(err) = apply_settings_patch(
                    &app,
                    PartialWinsttSettings {
                        general: Some(settings.general),
                        ..PartialWinsttSettings::default()
                    },
                ) {
                    errors.push(err);
                }
            }
        }
        "dictionary" => {
            if let Ok(dir) = crate::portable::app_data_dir(&app) {
                delete_path_best_effort(&dir.join("encoder-dict"), &mut errors);
            }
            let mut settings = read_settings(&app);
            settings.general.encoder_dictionary_enabled = false;
            if let Err(err) = apply_settings_patch(
                &app,
                PartialWinsttSettings {
                    general: Some(settings.general),
                    ..PartialWinsttSettings::default()
                },
            ) {
                errors.push(err);
            }
        }
        "logs" => {
            // Delete each log file best-effort; the active log file is held open
            // by the logger and simply stays (reported as an error), which is fine.
            if let Ok(dir) = crate::portable::app_log_dir(&app) {
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        delete_path_best_effort(&entry.path(), &mut errors);
                    }
                }
            }
        }
        other => {
            return Err(format!("category '{other}' cannot be removed individually"));
        }
    }
    record_cleanup_errors(
        &app,
        CleanupOperation::RemoveDownloadedModels,
        "Per-category removal completed with errors",
        &errors,
    );
    Ok(errors)
}

/// Per-category on-disk footprint of WinSTT's application data, so the About tab
/// can preview what "remove application data" / "remove downloaded models" frees
/// before the user commits. Read-only; allowed from the settings window only.
#[tauri::command]
#[specta::specta]
pub async fn app_data_usage(
    app: AppHandle,
    webview: WebviewWindow,
) -> Result<Vec<AppDataUsageEntry>, String> {
    command_auth::authorize_webview(
        &webview,
        "cleanup",
        "app data usage",
        CLEANUP_ALLOWED_WINDOWS,
        "",
    )?;
    Ok(cleanup::app_data_usage(&app)
        .await
        .into_iter()
        .map(|(key, bytes)| AppDataUsageEntry {
            key: key.to_string(),
            bytes,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn remove_application_data(
    app: AppHandle,
    webview: WebviewWindow,
    llm_manager: State<'_, Arc<LlmManager>>,
    delete_ollama_models: bool,
) -> Result<RemoveApplicationDataResult, String> {
    command_auth::authorize_webview(
        &webview,
        "cleanup",
        CleanupOperation::RemoveApplicationData.as_str(),
        CLEANUP_ALLOWED_WINDOWS,
        "",
    )?;

    let settings = read_settings(&app);
    let (deleted_ollama_models, ollama_errors) = if delete_ollama_models {
        cleanup::delete_configured_ollama_models(&settings, llm_manager.inner().clone()).await
    } else {
        (Vec::new(), Vec::new())
    };
    record_cleanup_errors(
        &app,
        CleanupOperation::RemoveApplicationData,
        "Configured Ollama model cleanup failed",
        &ollama_errors,
    );

    let plan = match cleanup::CleanupPlan::from_app(&app).await {
        Ok(plan) => plan,
        Err(err) => {
            record_cleanup_failure(
                &app,
                CleanupOperation::RemoveApplicationData,
                "Application cleanup plan could not be built",
                err.clone(),
            );
            return Err(err);
        }
    };
    if let Err(err) = cleanup::schedule_cleanup_after_exit(&plan) {
        record_cleanup_failure(
            &app,
            CleanupOperation::RemoveApplicationData,
            "Application cleanup could not be scheduled",
            err.clone(),
        );
        return Err(err);
    }

    let result = RemoveApplicationDataResult {
        scheduled: true,
        portable: crate::portable::is_portable(),
        delete_portable_app_dir: plan.delete_portable_app_dir,
        deleted_ollama_models,
        ollama_errors,
    };

    let app_for_exit = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        app_for_exit.exit(0);
    });

    Ok(result)
}

#[tauri::command]
#[specta::specta]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri command signature mirrors IPC state injection and generated binding shape"
)]
pub async fn remove_downloaded_models(
    app: AppHandle,
    webview: WebviewWindow,
    transcription: State<'_, Arc<TranscriptionManager>>,
    downloads: State<'_, Arc<DownloadManager>>,
    tts_manager: State<'_, Arc<TtsManager>>,
    tts_downloads: State<'_, Arc<TtsDownloadManager>>,
    llm_manager: State<'_, Arc<LlmManager>>,
    delete_ollama_models: bool,
) -> Result<RemoveDownloadedModelsResult, String> {
    command_auth::authorize_webview(
        &webview,
        "cleanup",
        CleanupOperation::RemoveDownloadedModels.as_str(),
        CLEANUP_ALLOWED_WINDOWS,
        "",
    )?;

    let original_settings = read_settings(&app);
    let (deleted_ollama_models, ollama_errors) = if delete_ollama_models {
        cleanup::delete_configured_ollama_models(&original_settings, llm_manager.inner().clone())
            .await
    } else {
        (Vec::new(), Vec::new())
    };
    record_cleanup_errors(
        &app,
        CleanupOperation::RemoveDownloadedModels,
        "Configured Ollama model cleanup failed",
        &ollama_errors,
    );

    crate::utils::cancel_current_operation(&app);

    let mut errors = Vec::new();
    if let Err(err) = transcription.unload_model() {
        let message = format!("failed to unload STT model: {err}");
        record_cleanup_failure(
            &app,
            CleanupOperation::RemoveDownloadedModels,
            "STT model could not be unloaded before cleanup",
            message.clone(),
        );
        errors.push(message);
    }
    tts_manager.unload_active_local_model_for_cleanup("model uninstall");

    let (patch, disabled_features) =
        cleanup::model_uninstall_settings_patch(&original_settings, delete_ollama_models);
    if let Err(err) = apply_settings_patch(&app, patch) {
        record_cleanup_failure(
            &app,
            CleanupOperation::RemoveDownloadedModels,
            "Settings could not be updated for model cleanup",
            err.clone(),
        );
        return Err(err);
    }
    cleanup::clear_legacy_selected_model(&app);

    let mut deleted_model_caches = 0;
    deleted_model_caches += cleanup::delete_stt_model_caches(downloads.inner(), &mut errors).await;
    deleted_model_caches +=
        cleanup::delete_tts_model_caches(&app, tts_downloads.inner(), &mut errors);
    deleted_model_caches += cleanup::delete_wakeword_model_caches(&app, &mut errors);
    record_cleanup_errors(
        &app,
        CleanupOperation::RemoveDownloadedModels,
        "Downloaded model cleanup completed with errors",
        &errors,
    );

    Ok(RemoveDownloadedModelsResult {
        deleted_model_caches,
        disabled_features,
        deleted_ollama_models,
        ollama_errors,
        errors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_authorization_matches_settings_only_policy() {
        for operation in [
            CleanupOperation::RemoveApplicationData,
            CleanupOperation::RemoveDownloadedModels,
        ] {
            command_auth::assert_label_rules(
                &["settings"],
                &[
                    "main",
                    "overlay",
                    "tray-menu",
                    "model-picker",
                    "device-picker",
                    "history",
                    "onboarding",
                    "context-playground",
                ],
                |caller| is_cleanup_operation_allowed(caller, operation),
            );
        }
    }

    #[test]
    fn cleanup_issue_uses_command_operation_and_classifies_detail() {
        let issue = cleanup_issue(
            CleanupOperation::RemoveDownloadedModels,
            "Downloaded model cleanup completed with errors",
            "C:\\cache\\model: access is denied",
        )
        .build_for_test();

        assert_eq!(issue.area, "cleanup");
        assert_eq!(issue.operation, "remove_downloaded_models");
        assert_eq!(issue.kind, "permission_denied");
        assert!(issue.user_visible);
    }
}
