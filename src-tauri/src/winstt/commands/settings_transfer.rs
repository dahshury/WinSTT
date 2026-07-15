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
use crate::winstt::cloud_stt::{CloudSttProvider, provider_of};
use crate::winstt::commands::catalog_data::ModelCacheInfo;
use crate::winstt::commands::runtime::probe_cache_states;
use crate::winstt::commands::settings::{
    PartialWinsttSettings, SECRET_PRESENT_SENTINEL, apply_settings_patch, read_settings,
};
use crate::winstt::managers::DownloadManager;
use crate::winstt::managers::llm_manager::LlmManager;
use crate::winstt::managers::tts_download_manager::{TtsCacheState, TtsDownloadManager};
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
    /// Raw saved-LLM-configurations blob (the `winstt:llm-configurations`
    /// localStorage value) recovered from the backup, if present. The renderer
    /// writes this back to localStorage — these configs live outside the backend
    /// settings tree. `None` when the export did not include saved configurations.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llm_configurations: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsExportFile {
    format: String,
    version: u32,
    app_version: String,
    exported_at: u64,
    settings: WinsttSettings,
    /// Saved LLM configurations (the renderer's `winstt:llm-configurations`
    /// localStorage blob), embedded as parsed JSON so the backup stays readable.
    /// These live outside the backend settings tree; they carry no secrets.
    #[serde(skip_serializing_if = "Option::is_none")]
    llm_configurations: Option<serde_json::Value>,
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
            llm_configurations: None,
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
            llm_configurations: None,
        }
    }

    fn ok_with(
        path: PathBuf,
        restored: Vec<SettingsRestoreItem>,
        adjusted: Vec<SettingsRestoreItem>,
        llm_configurations: Option<String>,
    ) -> Self {
        Self {
            ok: true,
            cancelled: None,
            error: None,
            path: Some(path.to_string_lossy().into_owned()),
            restored,
            adjusted,
            llm_configurations,
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
    // The backend-only `core` blob and any secret material it carries are stripped in
    // `export_file_json` — it is never re-imported (`full_settings_patch` ignores
    // it), so exporting it would only leak secrets/machine state.
}

/// Serialize an export file to bytes with the backend-only `core` section
/// removed. `core` is never re-imported and can carry secret material, so it is
/// dropped here to honour the "secrets are sentinel-only" export contract.
fn export_file_json(file: &SettingsExportFile) -> Result<Vec<u8>, serde_json::Error> {
    let mut value = serde_json::to_value(file)?;
    if let Some(settings) = value
        .get_mut("settings")
        .and_then(serde_json::Value::as_object_mut)
    {
        settings.remove("core");
    }
    serde_json::to_vec_pretty(&value)
}

fn preserve_target_secrets(imported: &mut WinsttSettings, current: &WinsttSettings) {
    imported.llm.openrouter_api_key = current.llm.openrouter_api_key.clone();
    imported.integrations.elevenlabs.api_key = current.integrations.elevenlabs.api_key.clone();
    imported.integrations.elevenlabs.verified = current.integrations.elevenlabs.verified;
    imported.integrations.elevenlabs.last_verified_at =
        current.integrations.elevenlabs.last_verified_at;
}

/// Top-level import sections, paired with the human-readable area name shown in
/// the import report. The order here is the report order.
const IMPORT_SECTIONS: &[(&str, &str)] = &[
    ("global", "General"),
    ("model", "Transcription"),
    ("quality", "Transcription quality"),
    ("audio", "Recording"),
    ("general", "Output & behavior"),
    ("hotkey", "Shortcuts"),
    ("dictionary", "Vocabulary"),
    ("snippets", "Snippets"),
    ("llm", "Processing"),
    ("tts", "Read Aloud"),
    ("integrations", "Integrations"),
];

/// A current-format settings export after exact schema validation.
#[derive(Debug)]
struct ParsedImport {
    settings: WinsttSettings,
    /// Raw saved-LLM-configurations blob recovered from the backup's
    /// `llmConfigurations` field (re-serialized to a compact string ready for
    /// `localStorage.setItem`), or `None` when none were exported.
    llm_configurations: Option<String>,
}

fn settings_from_envelope(root: &serde_json::Value) -> Result<serde_json::Value, String> {
    let root_object = root
        .as_object()
        .ok_or_else(|| "Invalid settings backup: expected a JSON object.".to_string())?;
    const REQUIRED: &[&str] = &["format", "version", "appVersion", "exportedAt", "settings"];
    const ALLOWED: &[&str] = &[
        "format",
        "version",
        "appVersion",
        "exportedAt",
        "settings",
        "llmConfigurations",
    ];
    let missing = REQUIRED
        .iter()
        .filter(|key| !root_object.contains_key(**key))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "Invalid settings backup: missing field(s): {}.",
            missing.join(", ")
        ));
    }
    let unknown = root_object
        .keys()
        .filter(|key| !ALLOWED.contains(&key.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(format!(
            "Invalid settings backup: unknown field(s): {}.",
            unknown.join(", ")
        ));
    }
    if root
        .get("appVersion")
        .and_then(serde_json::Value::as_str)
        .is_none()
    {
        return Err("Invalid settings backup: appVersion must be a string.".to_string());
    }
    if root
        .get("exportedAt")
        .and_then(serde_json::Value::as_u64)
        .is_none()
    {
        return Err("Invalid settings backup: exportedAt must be an unsigned integer.".to_string());
    }
    let format = root
        .get("format")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Invalid settings backup: missing format.".to_string())?;
    if format != SETTINGS_EXPORT_FORMAT {
        return Err(format!(
            "Unsupported settings backup format '{format}'; expected '{SETTINGS_EXPORT_FORMAT}'."
        ));
    }
    let version = root
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "Invalid settings backup: missing version.".to_string())?;
    if version != u64::from(SETTINGS_EXPORT_VERSION) {
        return Err(format!(
            "Unsupported settings backup version {version}; expected {SETTINGS_EXPORT_VERSION}."
        ));
    }
    root.get("settings")
        .cloned()
        .ok_or_else(|| "Invalid settings backup: missing settings payload.".to_string())
}

fn validate_exact_shape(
    input: &serde_json::Value,
    canonical: &serde_json::Value,
    path: &str,
) -> Result<(), String> {
    match (input, canonical) {
        (serde_json::Value::Object(input), serde_json::Value::Object(canonical)) => {
            let missing = canonical
                .keys()
                .filter(|key| !input.contains_key(*key))
                .cloned()
                .collect::<Vec<_>>();
            let unknown = input
                .keys()
                .filter(|key| !canonical.contains_key(*key))
                .cloned()
                .collect::<Vec<_>>();
            if !missing.is_empty() || !unknown.is_empty() {
                return Err(format!(
                    "Invalid settings backup at '{path}': missing [{}], unknown [{}].",
                    missing.join(", "),
                    unknown.join(", ")
                ));
            }
            for (key, value) in input {
                validate_exact_shape(value, &canonical[key], &format!("{path}.{key}"))?;
            }
        }
        (serde_json::Value::Array(input), serde_json::Value::Array(canonical)) => {
            for (index, (value, canonical_value)) in input.iter().zip(canonical).enumerate() {
                validate_exact_shape(value, canonical_value, &format!("{path}[{index}]"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn parse_import(bytes: &[u8]) -> Result<ParsedImport, String> {
    let root: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|err| format!("Invalid settings JSON: {err}"))?;

    // Saved LLM configurations travel alongside `settings` as the top-level
    // `llmConfigurations` field (embedded parsed JSON). Read it before `root` may
    // be moved into `settings_value` below. Re-serialize to a compact string ready
    // for `localStorage.setItem`.
    let llm_configurations = root
        .get("llmConfigurations")
        .filter(|value| !value.is_null())
        .and_then(|value| serde_json::to_string(value).ok());

    let settings_value = settings_from_envelope(&root)?;
    let Some(_) = settings_value.as_object() else {
        return Err("Invalid settings payload: expected a JSON object.".to_string());
    };

    let settings: WinsttSettings = serde_json::from_value(settings_value.clone())
        .map_err(|err| format!("Invalid settings payload: {err}"))?;
    let mut canonical = serde_json::to_value(&settings)
        .map_err(|err| format!("Could not validate settings payload: {err}"))?;
    canonical
        .as_object_mut()
        .expect("WinsttSettings serializes as an object")
        .remove("core");
    validate_exact_shape(&settings_value, &canonical, "settings")?;

    Ok(ParsedImport {
        settings,
        llm_configurations,
    })
}

fn full_settings_patch(settings: &WinsttSettings) -> PartialWinsttSettings {
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

/// Machine-specific reconciliation for the General section: a recording-sound
/// path from another machine (an absolute library path) will not exist here, so
/// fall back to the built-in chime. `""` (built-in) and `builtin:<file>`
/// (bundled) are machine-independent and left as-is. The mic index and wakeword
/// live in the backend-only `core` blob / are free-form KWS phrases, so those
/// machine-specific values are not checkable here (see notes).
fn reconcile_general_paths(imported: &mut WinsttSettings, adjusted: &mut Vec<SettingsRestoreItem>) {
    let path = imported.general.recording_sound_path.clone();
    if path.is_empty() || path.starts_with("builtin:") {
        return;
    }
    if !std::path::Path::new(&path).exists() {
        imported.general.recording_sound_path = String::new();
        adjusted.push(report(
            "Recording",
            "adjusted",
            format!(
                "Recording sound '{path}' was not found on this machine; using the built-in chime."
            ),
        ));
    }
}

/// Machine-specific reconciliation for input-device indices (finding #14). An
/// `audio.inputDeviceIndex` / `audio.clamshellMicrophone` saved on another machine
/// may point past THIS host's input-device list; reset any out-of-range index to
/// the system default (`null`) and report it. Best-effort: if the device list
/// can't be enumerated, indices are left untouched. Still unreconcilable here: the
/// backend-only core-blob mic index and the free-form wakeword phrase.
fn reconcile_audio_devices(imported: &mut WinsttSettings, adjusted: &mut Vec<SettingsRestoreItem>) {
    // Skip enumerating the audio host entirely when there's nothing to check.
    if imported.audio.input_device_index.is_none() && imported.audio.clamshell_microphone.is_none()
    {
        return;
    }
    let Ok(devices) = crate::audio_toolkit::list_input_devices() else {
        return;
    };
    reconcile_audio_device_indices(imported, devices.len() as i64, adjusted);
}

/// Pure core of [`reconcile_audio_devices`], split out so the range logic is unit
/// testable without touching the audio host. Indices are 0-based, so any index
/// `>= device_count` (including everything when `device_count == 0`) is invalid.
fn reconcile_audio_device_indices(
    imported: &mut WinsttSettings,
    device_count: i64,
    adjusted: &mut Vec<SettingsRestoreItem>,
) {
    if let Some(index) = imported.audio.input_device_index
        && index >= device_count
    {
        imported.audio.input_device_index = None;
        adjusted.push(report(
            "Recording",
            "adjusted",
            format!(
                "Saved microphone #{index} is not present on this machine ({device_count} input device(s)); using the system default."
            ),
        ));
    }
    if let Some(index) = imported.audio.clamshell_microphone
        && index >= device_count
    {
        imported.audio.clamshell_microphone = None;
        adjusted.push(report(
            "Recording",
            "adjusted",
            format!(
                "Saved clamshell microphone #{index} is not present on this machine; the clamshell override was disabled."
            ),
        ));
    }
}

fn restored_report() -> Vec<SettingsRestoreItem> {
    IMPORT_SECTIONS
        .iter()
        .map(|(_, area)| report(area, "restored", format!("{area} settings were restored.")))
        .collect()
}

fn reconcile_imported_settings(
    parsed: ParsedImport,
    current: &WinsttSettings,
    availability: &SettingsAvailability,
) -> (WinsttSettings, Vec<SettingsRestoreItem>) {
    let ParsedImport {
        mut settings,
        llm_configurations: _,
    } = parsed;
    let mut adjusted = Vec::new();
    preserve_target_secrets(&mut settings, current);

    reconcile_general_paths(&mut settings, &mut adjusted);
    reconcile_audio_devices(&mut settings, &mut adjusted);
    reconcile_stt_model(&mut settings, current, availability, &mut adjusted);
    reconcile_realtime_model(&mut settings, availability, &mut adjusted);
    reconcile_llm(&mut settings, availability, &mut adjusted);
    reconcile_tts(&mut settings, current, availability, &mut adjusted);

    (settings, adjusted)
}

/// `settings_export_full` — save a JSON backup of the complete settings tree.
/// API keys are represented only by the standard secret-present sentinel.
#[tauri::command]
#[specta::specta]
pub async fn settings_export_full(
    app: AppHandle,
    webview: WebviewWindow,
    llm_configurations: Option<String>,
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
    // Embed the renderer's saved-LLM-configurations blob as parsed JSON so the
    // backup stays human-readable. These configs live outside the backend settings
    // tree and carry no secrets. A malformed/absent blob is simply omitted.
    let llm_configurations = llm_configurations
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    let file = SettingsExportFile {
        format: SETTINGS_EXPORT_FORMAT.to_string(),
        version: SETTINGS_EXPORT_VERSION,
        app_version: app.package_info().version.to_string(),
        exported_at: now_epoch_seconds(),
        settings,
        llm_configurations,
    };
    let bytes = export_file_json(&file).map_err(|err| err.to_string())?;
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
    let current = read_settings(&app);
    let parsed = match parse_import(&bytes) {
        Ok(parsed) => parsed,
        Err(err) => return Ok(SettingsImportResult::failed(err)),
    };

    // Saved LLM configurations live outside the backend settings tree and are
    // handed back to the renderer for a localStorage write; capture the blob
    // before `reconcile_imported_settings` consumes the parsed import.
    let llm_configurations = parsed.llm_configurations.clone();

    let availability = collect_availability(
        downloads.inner().as_ref(),
        tts_downloads.inner().as_ref(),
        llm_manager.inner().as_ref(),
        &current,
    )
    .await;
    let (next, mut adjusted) = reconcile_imported_settings(parsed, &current, &availability);

    if let Err(err) = apply_settings_patch(&app, full_settings_patch(&next)) {
        return Ok(SettingsImportResult::failed(format!(
            "Failed to apply imported settings: {err}"
        )));
    }

    let mut restored = restored_report();
    if llm_configurations.is_some() {
        restored.push(report(
            "AI configurations",
            "restored",
            "Saved AI configurations were restored.",
        ));
    } else {
        adjusted.push(report(
            "AI configurations",
            "adjusted",
            "This backup had no saved AI configurations; existing ones were kept.",
        ));
    }

    Ok(SettingsImportResult::ok_with(
        import_path,
        restored,
        adjusted,
        llm_configurations,
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

    fn parsed_import(settings: WinsttSettings) -> ParsedImport {
        ParsedImport {
            settings,
            llm_configurations: None,
        }
    }

    fn import_bytes(
        settings: WinsttSettings,
        llm_configurations: Option<serde_json::Value>,
    ) -> Vec<u8> {
        export_file_json(&SettingsExportFile {
            format: SETTINGS_EXPORT_FORMAT.to_string(),
            version: SETTINGS_EXPORT_VERSION,
            app_version: "0.0.0-test".to_string(),
            exported_at: 0,
            settings,
            llm_configurations,
        })
        .expect("serialize import fixture")
    }

    #[test]
    fn export_strips_core_and_redacts_renderer_secrets() {
        let mut settings = WinsttSettings::default();
        settings.llm.openrouter_api_key = "or-secret".into();
        settings.integrations.elevenlabs.api_key = "el-secret".into();

        redact_export_secrets(&mut settings);
        assert_eq!(settings.llm.openrouter_api_key, SECRET_PRESENT_SENTINEL);
        assert_eq!(
            settings.integrations.elevenlabs.api_key,
            SECRET_PRESENT_SENTINEL
        );

        let file = SettingsExportFile {
            format: SETTINGS_EXPORT_FORMAT.to_string(),
            version: SETTINGS_EXPORT_VERSION,
            app_version: "0.0.0-test".to_string(),
            exported_at: 0,
            settings,
            llm_configurations: None,
        };
        let bytes = export_file_json(&file).expect("serialize export");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("parse export");
        // The backend-only `core` blob must not be present in the export.
        assert!(value["settings"].get("core").is_none());
        // Renderer secrets are represented only by the sentinel.
        assert_eq!(
            value["settings"]["llm"]["openrouterApiKey"],
            serde_json::json!(SECRET_PRESENT_SENTINEL)
        );
    }

    #[test]
    fn export_embeds_llm_configurations_blob_as_parsed_json() {
        let settings = WinsttSettings::default();
        // The renderer hands the raw localStorage string; the export embeds it as
        // parsed JSON so the backup stays readable.
        let blob = r#"{"version":1,"configurations":[{"id":"a","name":"Mine"}],"seededBuiltinIds":["builtin:ai-prompt"]}"#;
        let file = SettingsExportFile {
            format: SETTINGS_EXPORT_FORMAT.to_string(),
            version: SETTINGS_EXPORT_VERSION,
            app_version: "0.0.0-test".to_string(),
            exported_at: 0,
            settings,
            llm_configurations: serde_json::from_str(blob).ok(),
        };
        let bytes = export_file_json(&file).expect("serialize export");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("parse export");
        assert_eq!(value["llmConfigurations"]["version"], serde_json::json!(1));
        assert_eq!(
            value["llmConfigurations"]["configurations"][0]["name"],
            serde_json::json!("Mine")
        );
    }

    #[test]
    fn import_recovers_llm_configurations_blob() {
        let bytes = import_bytes(
            WinsttSettings::default(),
            Some(serde_json::json!({
                "version": 1,
                "configurations": [{ "id": "a", "name": "Mine" }],
                "seededBuiltinIds": [],
            })),
        );

        let parsed = parse_import(&bytes).expect("parse");
        let blob = parsed.llm_configurations.expect("configs recovered");
        let reparsed: serde_json::Value = serde_json::from_str(&blob).expect("valid JSON");
        assert_eq!(reparsed["configurations"][0]["id"], serde_json::json!("a"));
    }

    #[test]
    fn import_without_llm_configurations_field_is_absent_not_fatal() {
        let bytes = import_bytes(WinsttSettings::default(), None);

        let parsed = parse_import(&bytes).expect("parse");
        assert!(parsed.llm_configurations.is_none());
    }

    #[test]
    fn incomplete_settings_payload_is_rejected() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "format": SETTINGS_EXPORT_FORMAT,
            "version": SETTINGS_EXPORT_VERSION,
            "appVersion": "0.0.0-test",
            "exportedAt": 0,
            "settings": { "global": {} },
        }))
        .unwrap();

        let error = parse_import(&bytes).expect_err("incomplete payload must be rejected");
        assert!(error.contains("Invalid settings backup at 'settings'"));
    }

    #[test]
    fn mismatched_backup_version_is_rejected() {
        let mut value: serde_json::Value =
            serde_json::from_slice(&import_bytes(WinsttSettings::default(), None)).unwrap();
        value["version"] = serde_json::json!(SETTINGS_EXPORT_VERSION + 5);
        let bytes = serde_json::to_vec(&value).unwrap();

        let error = match parse_import(&bytes) {
            Ok(_) => panic!("mismatched version must be rejected"),
            Err(error) => error,
        };
        assert!(error.contains("Unsupported settings backup version"));
    }

    #[test]
    fn unknown_key_within_known_section_is_rejected() {
        let mut value: serde_json::Value =
            serde_json::from_slice(&import_bytes(WinsttSettings::default(), None)).unwrap();
        value["settings"]["model"]["someRemovedField"] = serde_json::json!(123);
        let bytes = serde_json::to_vec(&value).unwrap();

        let error = parse_import(&bytes).expect_err("unknown field must be rejected");
        assert!(error.contains("someRemovedField"));
    }

    #[test]
    fn reconcile_audio_device_indices_resets_out_of_range() {
        // finding #14: an index saved on a machine with more mics points past this
        // host's list → reset to the system default; a still-valid index is kept.
        let mut imported = WinsttSettings::default();
        imported.audio.input_device_index = Some(5);
        imported.audio.clamshell_microphone = Some(0);
        let mut adjusted = Vec::new();

        reconcile_audio_device_indices(&mut imported, 2, &mut adjusted);

        assert_eq!(imported.audio.input_device_index, None); // 5 >= 2 → reset
        assert_eq!(imported.audio.clamshell_microphone, Some(0)); // 0 < 2 → kept
        assert_eq!(adjusted.len(), 1);
        assert_eq!(adjusted[0].area, "Recording");
    }

    #[test]
    fn reconcile_audio_device_indices_keeps_valid_index() {
        let mut imported = WinsttSettings::default();
        imported.audio.input_device_index = Some(1);
        let mut adjusted = Vec::new();

        reconcile_audio_device_indices(&mut imported, 3, &mut adjusted);

        assert_eq!(imported.audio.input_device_index, Some(1));
        assert!(adjusted.is_empty());
    }

    #[test]
    fn unknown_section_key_is_rejected() {
        let mut value: serde_json::Value =
            serde_json::from_slice(&import_bytes(WinsttSettings::default(), None)).unwrap();
        value["settings"]["someRemovedGroup"] = serde_json::json!({ "x": 1 });
        let bytes = serde_json::to_vec(&value).unwrap();

        let error = parse_import(&bytes).expect_err("unknown section must be rejected");
        assert!(error.contains("someRemovedGroup"));
    }

    #[test]
    fn cloud_stt_without_target_key_falls_back_to_available_local_model() {
        let current = WinsttSettings::default();
        let mut imported = WinsttSettings::default();
        imported.model.model = "openrouter:openai/whisper-1".into();
        imported.model.realtime_model = "tiny".into();

        let (next, adjusted) = reconcile_imported_settings(
            parsed_import(imported),
            &current,
            &availability(&["base"], &[], &[]),
        );

        assert_eq!(next.model.model, "base");
        assert!(
            adjusted
                .iter()
                .any(|item| item.area == "Transcription model")
        );
    }

    #[test]
    fn missing_ollama_model_uses_installed_replacement() {
        let current = WinsttSettings::default();
        let mut imported = WinsttSettings::default();
        imported.llm.dictation.enabled = true;
        imported.llm.dictation.base.provider = LlmProvider::Ollama;
        imported.llm.dictation.base.model = "missing:latest".into();

        let (next, adjusted) = reconcile_imported_settings(
            parsed_import(imported),
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

        let (next, adjusted) = reconcile_imported_settings(
            parsed_import(imported),
            &current,
            &availability(&["tiny"], &[], &[]),
        );

        assert_eq!(next.tts.source, TtsSource::Local);
        assert!(!next.tts.enabled);
        assert!(adjusted.iter().any(|item| item.area == "Read Aloud"));
    }
}
