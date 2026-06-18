// Settings export/import for the settings window footer.
//
// The export file is deliberately plain JSON so users can keep a readable backup. Secrets are
// never exported; imports preserve the target machine's existing API keys and then reconcile model
// preferences against what is available locally or authenticated in the current install.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::command_auth;
use crate::winstt::catalog;
use crate::winstt::cloud_stt::{provider_of, CloudSttProvider};
use crate::winstt::commands::catalog_data::ModelCacheInfo;
use crate::winstt::commands::runtime::probe_cache_states;
use crate::winstt::commands::settings::{
    apply_settings_patch, read_settings, PartialWinsttSettings, SECRET_PRESENT_SENTINEL,
};
use crate::winstt::managers::llm_manager::LlmManager;
use crate::winstt::managers::tts_download_manager::{TtsCacheState, TtsDownloadManager};
use crate::winstt::managers::DownloadManager;
use crate::winstt::settings_schema::{
    LlmFeatureBase, LlmProvider, TtsCloudProvider, TtsSource, WinsttSettings,
};
use crate::winstt::tts::catalog as tts_catalog;

const SETTINGS_TRANSFER_ALLOWED_WINDOWS: &[&str] = &["settings"];
const SETTINGS_EXPORT_FORMAT: &str = "winstt-settings";
const SETTINGS_EXPORT_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsExportResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsRestoreItem {
    pub area: String,
    pub status: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsImportResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub restored: Vec<SettingsRestoreItem>,
    pub adjusted: Vec<SettingsRestoreItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsExportFile {
    format: String,
    version: u32,
    app_version: String,
    exported_at: u64,
    settings: WinsttSettings,
}

#[derive(Clone, Debug, Default)]
struct SettingsAvailability {
    cached_stt_models: BTreeSet<String>,
    cached_stt_quantizations: BTreeMap<String, BTreeSet<String>>,
    installed_ollama_models: BTreeSet<String>,
    cached_tts_models: BTreeSet<String>,
}

impl SettingsExportResult {
    fn ok_with(path: PathBuf) -> Self {
        Self {
            ok: true,
            cancelled: None,
            error: None,
            path: Some(path.to_string_lossy().into_owned()),
        }
    }

    fn cancelled() -> Self {
        Self {
            ok: false,
            cancelled: Some(true),
            error: None,
            path: None,
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            cancelled: None,
            error: Some(message.into()),
            path: None,
        }
    }
}

impl SettingsImportResult {
    fn cancelled() -> Self {
        Self {
            ok: false,
            cancelled: Some(true),
            error: None,
            path: None,
            restored: Vec::new(),
            adjusted: Vec::new(),
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            cancelled: None,
            error: Some(message.into()),
            path: None,
            restored: Vec::new(),
            adjusted: Vec::new(),
        }
    }

    fn ok_with(
        path: PathBuf,
        restored: Vec<SettingsRestoreItem>,
        adjusted: Vec<SettingsRestoreItem>,
    ) -> Self {
        Self {
            ok: true,
            cancelled: None,
            error: None,
            path: Some(path.to_string_lossy().into_owned()),
            restored,
            adjusted,
        }
    }
}

fn report(area: &str, status: &str, message: impl Into<String>) -> SettingsRestoreItem {
    SettingsRestoreItem {
        area: area.to_string(),
        status: status.to_string(),
        message: message.into(),
    }
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn default_export_filename() -> String {
    format!("winstt-settings-{}.json", now_epoch_seconds())
}

fn redact_secret(value: &mut String) {
    if !value.trim().is_empty() {
        *value = SECRET_PRESENT_SENTINEL.to_string();
    }
}

fn redact_export_secrets(settings: &mut WinsttSettings) {
    redact_secret(&mut settings.llm.openrouter_api_key);
    redact_secret(&mut settings.integrations.elevenlabs.api_key);
    for value in settings.core.post_process_api_keys.values_mut() {
        redact_secret(value);
    }
}

fn preserve_target_secrets(imported: &mut WinsttSettings, current: &WinsttSettings) {
    imported.llm.openrouter_api_key = current.llm.openrouter_api_key.clone();
    imported.integrations.elevenlabs.api_key = current.integrations.elevenlabs.api_key.clone();
    imported.integrations.elevenlabs.verified = current.integrations.elevenlabs.verified;
    imported.integrations.elevenlabs.last_verified_at =
        current.integrations.elevenlabs.last_verified_at;
    imported.core.post_process_api_keys = current.core.post_process_api_keys.clone();
}

fn parse_exported_settings(bytes: &[u8]) -> Result<WinsttSettings, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|err| format!("Invalid settings JSON: {err}"))?;
    if let Some(settings) = value.get("settings") {
        serde_json::from_value(settings.clone())
            .map_err(|err| format!("Invalid exported settings payload: {err}"))
    } else {
        serde_json::from_value(value).map_err(|err| format!("Invalid settings payload: {err}"))
    }
}

fn patch_from_settings(settings: &WinsttSettings) -> PartialWinsttSettings {
    PartialWinsttSettings {
        global: Some(settings.global),
        model: Some(settings.model.clone()),
        quality: Some(settings.quality.clone()),
        audio: Some(settings.audio.clone()),
        general: Some(settings.general.clone()),
        hotkey: Some(settings.hotkey.clone()),
        dictionary: Some(settings.dictionary.clone()),
        snippets: Some(settings.snippets.clone()),
        llm: Some(settings.llm.clone()),
        tts: Some(settings.tts.clone()),
        integrations: Some(settings.integrations.clone()),
    }
}

fn stt_cache_to_available(
    cache_by_model: BTreeMap<String, BTreeMap<String, ModelCacheInfo>>,
) -> (BTreeSet<String>, BTreeMap<String, BTreeSet<String>>) {
    let mut models = BTreeSet::new();
    let mut quantizations = BTreeMap::new();
    for (model_id, by_quant) in cache_by_model {
        let cached_quants = by_quant
            .into_iter()
            .filter_map(|(quant, info)| (info.state == "cached").then_some(quant))
            .collect::<BTreeSet<_>>();
        if !cached_quants.is_empty() {
            models.insert(model_id.clone());
            quantizations.insert(model_id, cached_quants);
        }
    }
    (models, quantizations)
}

fn tts_cached_models(downloads: &TtsDownloadManager) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for entry in tts_catalog::TTS_CATALOG {
        let quant = entry.default_quant();
        if downloads.cache_info(entry.id, quant).state == TtsCacheState::Cached {
            out.insert(entry.id.to_string());
        }
    }
    out
}

async fn collect_availability(
    downloads: &DownloadManager,
    tts_downloads: &TtsDownloadManager,
    llm_manager: &LlmManager,
    settings: &WinsttSettings,
) -> SettingsAvailability {
    let cache_by_model = probe_cache_states(downloads).await;
    let (cached_stt_models, cached_stt_quantizations) = stt_cache_to_available(cache_by_model);
    let cached_tts_models = tts_cached_models(tts_downloads);
    let installed_ollama_models = if llm_manager.ollama_detect(&settings.llm.endpoint).await {
        llm_manager
            .ollama_list_models_detailed(&settings.llm.endpoint)
            .await
            .map(|models| models.into_iter().map(|model| model.name).collect())
            .unwrap_or_default()
    } else {
        BTreeSet::new()
    };

    SettingsAvailability {
        cached_stt_models,
        cached_stt_quantizations,
        installed_ollama_models,
        cached_tts_models,
    }
}

fn has_cloud_stt_key(settings: &WinsttSettings, provider: CloudSttProvider) -> bool {
    match provider {
        CloudSttProvider::ElevenLabs => !settings.integrations.elevenlabs.api_key.trim().is_empty(),
        CloudSttProvider::OpenRouter => !settings.llm.openrouter_api_key.trim().is_empty(),
    }
}

fn stt_model_available(model_id: &str, availability: &SettingsAvailability) -> bool {
    let canonical = catalog::canonical_model_id(model_id).to_string();
    catalog::find(&canonical).is_some() && availability.cached_stt_models.contains(&canonical)
}

fn fallback_stt_model(availability: &SettingsAvailability, defaults: &WinsttSettings) -> String {
    catalog::STT_CATALOG
        .iter()
        .find(|entry| availability.cached_stt_models.contains(entry.id))
        .map_or_else(
            || defaults.model.model.clone(),
            |entry| entry.id.to_string(),
        )
}

fn reconcile_stt_model(
    imported: &mut WinsttSettings,
    current: &WinsttSettings,
    availability: &SettingsAvailability,
    adjusted: &mut Vec<SettingsRestoreItem>,
) {
    let defaults = WinsttSettings::default();
    let selected = imported.model.model.clone();
    if let Some(provider) = provider_of(&selected) {
        if has_cloud_stt_key(current, provider) {
            return;
        }
        let fallback = fallback_stt_model(availability, &defaults);
        imported.model.model = fallback.clone();
        imported.model.backend = defaults.model.backend;
        imported.model.onnx_quantization = defaults.model.onnx_quantization;
        adjusted.push(report(
            "Transcription model",
            "adjusted",
            format!(
                "Cloud speech model '{selected}' was not restored because the {} API key is missing; using '{fallback}'.",
                provider.id()
            ),
        ));
        return;
    }

    if stt_model_available(&selected, availability) {
        if !["", "auto"].contains(&imported.model.onnx_quantization.as_str()) {
            let canonical = catalog::canonical_model_id(&selected);
            let saved_quant = imported.model.onnx_quantization.clone();
            let has_saved_quant = availability
                .cached_stt_quantizations
                .get(canonical)
                .is_some_and(|quants| quants.contains(&saved_quant));
            if !has_saved_quant {
                imported.model.onnx_quantization = defaults.model.onnx_quantization;
                adjusted.push(report(
                    "Transcription precision",
                    "adjusted",
                    format!(
                        "Model '{selected}' was restored, but saved precision '{saved_quant}' was not cached; using Auto."
                    ),
                ));
            }
        }
        return;
    }

    let fallback = fallback_stt_model(availability, &defaults);
    imported.model.model = fallback.clone();
    imported.model.backend = defaults.model.backend;
    imported.model.onnx_quantization = defaults.model.onnx_quantization;
    adjusted.push(report(
        "Transcription model",
        "adjusted",
        format!("Local speech model '{selected}' was not available; using '{fallback}'."),
    ));
}

fn reconcile_realtime_model(
    imported: &mut WinsttSettings,
    availability: &SettingsAvailability,
    adjusted: &mut Vec<SettingsRestoreItem>,
) {
    let defaults = WinsttSettings::default();
    let selected = imported.model.realtime_model.clone();
    if stt_model_available(&selected, availability) {
        return;
    }
    let fallback = if stt_model_available(&imported.model.model, availability) {
        imported.model.model.clone()
    } else {
        fallback_stt_model(availability, &defaults)
    };
    imported.model.realtime_model = fallback.clone();
    adjusted.push(report(
        "Realtime model",
        "adjusted",
        format!("Realtime model '{selected}' was not available locally; using '{fallback}'."),
    ));
}

fn first_ollama_model(availability: &SettingsAvailability) -> String {
    availability
        .installed_ollama_models
        .iter()
        .next()
        .cloned()
        .unwrap_or_default()
}

fn reconcile_llm_base(
    area: &str,
    enabled: &mut bool,
    base: &mut LlmFeatureBase,
    default_base: &LlmFeatureBase,
    has_openrouter_key: bool,
    availability: &SettingsAvailability,
    adjusted: &mut Vec<SettingsRestoreItem>,
) {
    match base.provider {
        LlmProvider::Openrouter => {
            if has_openrouter_key {
                return;
            }
            let fallback = first_ollama_model(availability);
            base.provider = LlmProvider::Ollama;
            base.model = fallback.clone();
            base.openrouter_model = default_base.openrouter_model.clone();
            base.openrouter_fallback_model = default_base.openrouter_fallback_model.clone();
            if fallback.is_empty() {
                *enabled = false;
                adjusted.push(report(
                    area,
                    "adjusted",
                    "OpenRouter was selected but no API key is saved here; no local Ollama model was available, so this feature was disabled.",
                ));
            } else {
                adjusted.push(report(
                    area,
                    "adjusted",
                    format!(
                        "OpenRouter was selected but no API key is saved here; switched to local Ollama model '{fallback}'."
                    ),
                ));
            }
        }
        LlmProvider::Ollama => {
            if base.model.is_empty() {
                if *enabled {
                    let fallback = first_ollama_model(availability);
                    base.model = fallback.clone();
                    if fallback.is_empty() {
                        *enabled = false;
                        adjusted.push(report(
                            area,
                            "adjusted",
                            "No saved or installed Ollama model was available, so this feature was disabled.",
                        ));
                    } else {
                        adjusted.push(report(
                            area,
                            "adjusted",
                            format!("No saved Ollama model was set; using '{fallback}'."),
                        ));
                    }
                }
                return;
            }
            if availability.installed_ollama_models.contains(&base.model) {
                return;
            }
            let missing = base.model.clone();
            let fallback = first_ollama_model(availability);
            base.model = fallback.clone();
            if fallback.is_empty() {
                *enabled = false;
                adjusted.push(report(
                    area,
                    "adjusted",
                    format!(
                        "Ollama model '{missing}' is not installed here and no local replacement was found, so this feature was disabled."
                    ),
                ));
            } else {
                adjusted.push(report(
                    area,
                    "adjusted",
                    format!("Ollama model '{missing}' is not installed here; using '{fallback}'."),
                ));
            }
        }
        LlmProvider::AppleIntelligence => {}
    }
}

fn reconcile_llm(
    imported: &mut WinsttSettings,
    availability: &SettingsAvailability,
    adjusted: &mut Vec<SettingsRestoreItem>,
) {
    let defaults = WinsttSettings::default();
    let has_openrouter_key = !imported.llm.openrouter_api_key.trim().is_empty();
    reconcile_llm_base(
        "Dictation cleanup",
        &mut imported.llm.dictation.enabled,
        &mut imported.llm.dictation.base,
        &defaults.llm.dictation.base,
        has_openrouter_key,
        availability,
        adjusted,
    );
    reconcile_llm_base(
        "Text transforms",
        &mut imported.llm.transforms.enabled,
        &mut imported.llm.transforms.base,
        &defaults.llm.transforms.base,
        has_openrouter_key,
        availability,
        adjusted,
    );
}

fn has_cloud_tts_key(settings: &WinsttSettings, provider: TtsCloudProvider) -> bool {
    match provider {
        TtsCloudProvider::Elevenlabs => !settings.integrations.elevenlabs.api_key.trim().is_empty(),
        TtsCloudProvider::Openrouter => !settings.llm.openrouter_api_key.trim().is_empty(),
    }
}

fn fallback_tts_model(availability: &SettingsAvailability, defaults: &WinsttSettings) -> String {
    tts_catalog::TTS_CATALOG
        .iter()
        .find(|entry| availability.cached_tts_models.contains(entry.id))
        .map_or_else(|| defaults.tts.model.clone(), |entry| entry.id.to_string())
}

fn local_tts_available(model_id: &str, availability: &SettingsAvailability) -> bool {
    tts_catalog::find(model_id).is_some() && availability.cached_tts_models.contains(model_id)
}

fn switch_tts_to_local_fallback(
    imported: &mut WinsttSettings,
    availability: &SettingsAvailability,
    defaults: &WinsttSettings,
) -> String {
    let fallback = fallback_tts_model(availability, defaults);
    imported.tts.source = TtsSource::Local;
    imported.tts.model = fallback.clone();
    if !local_tts_available(&fallback, availability) {
        imported.tts.enabled = false;
    }
    fallback
}

fn reconcile_tts(
    imported: &mut WinsttSettings,
    current: &WinsttSettings,
    availability: &SettingsAvailability,
    adjusted: &mut Vec<SettingsRestoreItem>,
) {
    let defaults = WinsttSettings::default();
    match imported.tts.source {
        TtsSource::Cloud => {
            if has_cloud_tts_key(current, imported.tts.cloud.provider) {
                return;
            }
            let provider = imported.tts.cloud.provider;
            let fallback = switch_tts_to_local_fallback(imported, availability, &defaults);
            adjusted.push(report(
                "Read Aloud",
                "adjusted",
                format!(
                    "Cloud TTS provider '{provider:?}' was not restored because its API key is missing; using local model '{fallback}'."
                ),
            ));
        }
        TtsSource::Local => {
            let selected = imported.tts.model.clone();
            if local_tts_available(&selected, availability) {
                return;
            }
            let fallback = switch_tts_to_local_fallback(imported, availability, &defaults);
            adjusted.push(report(
                "Read Aloud",
                "adjusted",
                format!("Local TTS model '{selected}' was not available; using '{fallback}'."),
            ));
        }
    }
}

fn restored_report() -> Vec<SettingsRestoreItem> {
    [
        "General",
        "Recording",
        "Transcription",
        "Processing",
        "Vocabulary",
        "Output",
        "Read Aloud",
        "Shortcuts",
        "Appearance",
        "History",
        "Integrations",
    ]
    .into_iter()
    .map(|area| report(area, "restored", format!("{area} settings were restored.")))
    .collect()
}

fn reconcile_imported_settings(
    mut imported: WinsttSettings,
    current: &WinsttSettings,
    availability: &SettingsAvailability,
) -> (WinsttSettings, Vec<SettingsRestoreItem>) {
    preserve_target_secrets(&mut imported, current);

    let mut adjusted = Vec::new();
    reconcile_stt_model(&mut imported, current, availability, &mut adjusted);
    reconcile_realtime_model(&mut imported, availability, &mut adjusted);
    reconcile_llm(&mut imported, availability, &mut adjusted);
    reconcile_tts(&mut imported, current, availability, &mut adjusted);

    (imported, adjusted)
}

/// `settings_export_full` — save a JSON backup of the complete settings tree.
/// API keys and legacy post-process secrets are represented only by the standard
/// secret-present sentinel, never by plaintext values.
#[tauri::command]
#[specta::specta]
pub async fn settings_export_full(
    app: AppHandle,
    webview: WebviewWindow,
) -> Result<SettingsExportResult, String> {
    command_auth::authorize_webview(
        &webview,
        "settings-transfer",
        "export settings",
        SETTINGS_TRANSFER_ALLOWED_WINDOWS,
        "",
    )?;

    let mut builder = app
        .dialog()
        .file()
        .set_title("Export WinSTT Settings")
        .add_filter("WinSTT settings", &["json"])
        .set_file_name(default_export_filename());
    if let Ok(desktop) = app.path().desktop_dir() {
        builder = builder.set_directory(desktop);
    }

    let Some(chosen) = builder.blocking_save_file() else {
        return Ok(SettingsExportResult::cancelled());
    };
    let out_path = match chosen.into_path() {
        Ok(path) => path,
        Err(err) => return Ok(SettingsExportResult::failed(err.to_string())),
    };

    let mut settings = read_settings(&app);
    redact_export_secrets(&mut settings);
    let file = SettingsExportFile {
        format: SETTINGS_EXPORT_FORMAT.to_string(),
        version: SETTINGS_EXPORT_VERSION,
        app_version: app.package_info().version.to_string(),
        exported_at: now_epoch_seconds(),
        settings,
    };
    let bytes = serde_json::to_vec_pretty(&file).map_err(|err| err.to_string())?;
    if let Err(err) = std::fs::write(&out_path, bytes) {
        return Ok(SettingsExportResult::failed(format!(
            "Failed to write settings export: {err}"
        )));
    }

    Ok(SettingsExportResult::ok_with(out_path))
}

/// `settings_import_full` — pick a JSON settings backup, reconcile unavailable
/// model/provider preferences for this machine, then persist through the normal
/// settings path so runtime side effects and settings:changed broadcasts match
/// an ordinary Settings save.
#[tauri::command]
#[specta::specta]
pub async fn settings_import_full(
    app: AppHandle,
    webview: WebviewWindow,
    downloads: State<'_, Arc<DownloadManager>>,
    tts_downloads: State<'_, Arc<TtsDownloadManager>>,
    llm_manager: State<'_, Arc<LlmManager>>,
) -> Result<SettingsImportResult, String> {
    command_auth::authorize_webview(
        &webview,
        "settings-transfer",
        "import settings",
        SETTINGS_TRANSFER_ALLOWED_WINDOWS,
        "",
    )?;

    let Some(chosen) = app
        .dialog()
        .file()
        .set_title("Import WinSTT Settings")
        .add_filter("WinSTT settings", &["json"])
        .blocking_pick_file()
    else {
        return Ok(SettingsImportResult::cancelled());
    };
    let import_path = match chosen.into_path() {
        Ok(path) => path,
        Err(err) => return Ok(SettingsImportResult::failed(err.to_string())),
    };

    let bytes = match std::fs::read(&import_path) {
        Ok(bytes) => bytes,
        Err(err) => {
            return Ok(SettingsImportResult::failed(format!(
                "Failed to read settings export: {err}"
            )));
        }
    };
    let imported = match parse_exported_settings(&bytes) {
        Ok(settings) => settings,
        Err(err) => return Ok(SettingsImportResult::failed(err)),
    };

    let current = read_settings(&app);
    let availability = collect_availability(
        downloads.inner().as_ref(),
        tts_downloads.inner().as_ref(),
        llm_manager.inner().as_ref(),
        &current,
    )
    .await;
    let (next, adjusted) = reconcile_imported_settings(imported, &current, &availability);

    if let Err(err) = apply_settings_patch(&app, patch_from_settings(&next)) {
        return Ok(SettingsImportResult::failed(format!(
            "Failed to apply imported settings: {err}"
        )));
    }

    Ok(SettingsImportResult::ok_with(
        import_path,
        restored_report(),
        adjusted,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn availability(stt: &[&str], ollama: &[&str], tts: &[&str]) -> SettingsAvailability {
        SettingsAvailability {
            cached_stt_models: stt.iter().map(|id| (*id).to_string()).collect(),
            cached_stt_quantizations: stt
                .iter()
                .map(|id| {
                    (
                        (*id).to_string(),
                        ["".to_string()].into_iter().collect::<BTreeSet<_>>(),
                    )
                })
                .collect(),
            installed_ollama_models: ollama.iter().map(|id| (*id).to_string()).collect(),
            cached_tts_models: tts.iter().map(|id| (*id).to_string()).collect(),
        }
    }

    #[test]
    fn export_redacts_renderer_and_core_secrets() {
        let mut settings = WinsttSettings::default();
        settings.llm.openrouter_api_key = "or-secret".into();
        settings.integrations.elevenlabs.api_key = "el-secret".into();
        settings
            .core
            .post_process_api_keys
            .insert("openrouter".into(), "legacy-secret".into());

        redact_export_secrets(&mut settings);

        assert_eq!(settings.llm.openrouter_api_key, SECRET_PRESENT_SENTINEL);
        assert_eq!(
            settings.integrations.elevenlabs.api_key,
            SECRET_PRESENT_SENTINEL
        );
        assert_eq!(
            settings
                .core
                .post_process_api_keys
                .get("openrouter")
                .unwrap(),
            SECRET_PRESENT_SENTINEL
        );
    }

    #[test]
    fn cloud_stt_without_target_key_falls_back_to_available_local_model() {
        let current = WinsttSettings::default();
        let mut imported = WinsttSettings::default();
        imported.model.model = "openrouter:openai/whisper-1".into();
        imported.model.realtime_model = "tiny".into();

        let (next, adjusted) =
            reconcile_imported_settings(imported, &current, &availability(&["base"], &[], &[]));

        assert_eq!(next.model.model, "base");
        assert!(adjusted
            .iter()
            .any(|item| item.area == "Transcription model"));
    }

    #[test]
    fn missing_ollama_model_uses_installed_replacement() {
        let current = WinsttSettings::default();
        let mut imported = WinsttSettings::default();
        imported.llm.dictation.enabled = true;
        imported.llm.dictation.base.provider = LlmProvider::Ollama;
        imported.llm.dictation.base.model = "missing:latest".into();

        let (next, adjusted) = reconcile_imported_settings(
            imported,
            &current,
            &availability(&["tiny"], &["llama3.2:latest"], &[]),
        );

        assert!(next.llm.dictation.enabled);
        assert_eq!(next.llm.dictation.base.model, "llama3.2:latest");
        assert!(adjusted.iter().any(|item| item.area == "Dictation cleanup"));
    }

    #[test]
    fn cloud_tts_without_key_switches_to_local_or_disables() {
        let current = WinsttSettings::default();
        let mut imported = WinsttSettings::default();
        imported.tts.enabled = true;
        imported.tts.source = TtsSource::Cloud;
        imported.tts.cloud.provider = TtsCloudProvider::Elevenlabs;

        let (next, adjusted) =
            reconcile_imported_settings(imported, &current, &availability(&["tiny"], &[], &[]));

        assert_eq!(next.tts.source, TtsSource::Local);
        assert!(!next.tts.enabled);
        assert!(adjusted.iter().any(|item| item.area == "Read Aloud"));
    }
}
