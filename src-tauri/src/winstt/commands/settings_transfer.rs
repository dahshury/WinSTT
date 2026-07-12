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
    /// settings tree. `None` for older backups that predate the field.
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
    // The backend-only `core` blob (and any secret material it carries, e.g. the
    // legacy `post_process_api_keys` SecretMap) is stripped wholesale in
    // `export_file_json` — it is never re-imported (`patch_from_present` ignores
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

/// Result of leniently parsing an export file. `settings` is the persisted tree
/// with the sections that were PRESENT (and valid) in the file overlaid on top —
/// absent sections keep the machine's current value instead of resetting to a
/// default. `present` is the set of section keys that were successfully applied
/// (this drives both the patch and the "restored" report). `adjustments`
/// collects envelope/version warnings, sections that were present but could not
/// be parsed on this version, and unknown/removed section keys.
struct ParsedImport {
    settings: WinsttSettings,
    present: BTreeSet<&'static str>,
    adjustments: Vec<SettingsRestoreItem>,
    /// Raw saved-LLM-configurations blob recovered from the backup's
    /// `llmConfigurations` field (re-serialized to a compact string ready for
    /// `localStorage.setItem`), or `None` when the backup predates the field.
    llm_configurations: Option<String>,
}

/// Port of the renderer's `migrateOpenaiSttModel`: a persisted
/// `model.model = "openai:<id>"` selection (from before OpenAI was removed as a
/// direct cloud STT provider) is rewritten to the equivalent OpenRouter route
/// so it keeps working via the OpenRouter key instead of being treated as an
/// unavailable local model. Operates on the raw settings object before the
/// section is deserialized.
fn migrate_openai_stt_model(settings_obj: &mut serde_json::Map<String, serde_json::Value>) {
    let Some(model) = settings_obj
        .get_mut("model")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    let Some(id) = model.get("model").and_then(serde_json::Value::as_str) else {
        return;
    };
    if let Some(bare) = id.strip_prefix("openai:") {
        let rewritten = format!("openrouter:openai/{bare}");
        model.insert("model".to_string(), serde_json::Value::String(rewritten));
    }
}

/// Deserialize a single top-level section value into the working settings tree.
/// Kept per-section so one corrupt/newer section (e.g. an unknown enum value
/// from a newer export) fails only that section rather than the whole import.
fn apply_section(
    settings: &mut WinsttSettings,
    key: &str,
    value: serde_json::Value,
) -> Result<(), serde_json::Error> {
    match key {
        "global" => settings.global = serde_json::from_value(value)?,
        "model" => settings.model = serde_json::from_value(value)?,
        "quality" => settings.quality = serde_json::from_value(value)?,
        "audio" => settings.audio = serde_json::from_value(value)?,
        "general" => settings.general = serde_json::from_value(value)?,
        "hotkey" => settings.hotkey = serde_json::from_value(value)?,
        "dictionary" => settings.dictionary = serde_json::from_value(value)?,
        "snippets" => settings.snippets = serde_json::from_value(value)?,
        "llm" => settings.llm = serde_json::from_value(value)?,
        "tts" => settings.tts = serde_json::from_value(value)?,
        "integrations" => settings.integrations = serde_json::from_value(value)?,
        _ => {}
    }
    Ok(())
}

/// Serialize the just-applied typed section back to JSON so its modeled key set
/// can be diffed against the raw input (finding #13). The array sections
/// (`dictionary`/`snippets`) have no named fields, so they return `None` and are
/// skipped.
fn serialized_known_section(settings: &WinsttSettings, key: &str) -> Option<serde_json::Value> {
    match key {
        "global" => serde_json::to_value(settings.global).ok(),
        "model" => serde_json::to_value(&settings.model).ok(),
        "quality" => serde_json::to_value(&settings.quality).ok(),
        "audio" => serde_json::to_value(&settings.audio).ok(),
        "general" => serde_json::to_value(&settings.general).ok(),
        "hotkey" => serde_json::to_value(&settings.hotkey).ok(),
        "llm" => serde_json::to_value(&settings.llm).ok(),
        "tts" => serde_json::to_value(&settings.tts).ok(),
        "integrations" => serde_json::to_value(&settings.integrations).ok(),
        _ => None,
    }
}

/// Report top-level keys present in the raw `input` section but not modeled by
/// this version's typed section (finding #13): a field removed/renamed in a newer
/// export is otherwise dropped SILENTLY on import, since serde ignores unknown
/// keys. Shallow by design (section top level only) — going deeper would risk
/// false positives from `skip_serializing_if` inner fields (e.g. a dictionary
/// entry's absent `replacement`), so nested-field drops within a section are not
/// individually reported.
fn report_unknown_section_keys(
    area: &str,
    key: &str,
    input: &serde_json::Value,
    settings: &WinsttSettings,
    adjustments: &mut Vec<SettingsRestoreItem>,
) {
    let (Some(input_obj), Some(known)) =
        (input.as_object(), serialized_known_section(settings, key))
    else {
        return;
    };
    let Some(known_obj) = known.as_object() else {
        return;
    };
    let mut unknown: Vec<&str> = input_obj
        .keys()
        .filter(|name| !known_obj.contains_key(name.as_str()))
        .map(String::as_str)
        .collect();
    if unknown.is_empty() {
        return;
    }
    unknown.sort_unstable();
    adjustments.push(report(
        area,
        "adjusted",
        format!(
            "This backup's '{area}' section had setting(s) not recognized on this version, which were ignored: {}.",
            unknown.join(", ")
        ),
    ));
}

/// Check the export envelope's `format`/`version` and record a warning (not a
/// hard failure) on mismatch — an older backup imports fine, and a newer backup
/// imports on a best-effort basis with per-section recovery skipping anything
/// this version can't read.
fn check_envelope(root: &serde_json::Value, adjustments: &mut Vec<SettingsRestoreItem>) {
    if let Some(format) = root.get("format").and_then(serde_json::Value::as_str)
        && format != SETTINGS_EXPORT_FORMAT
    {
        adjustments.push(report(
            "Backup format",
            "adjusted",
            format!(
                "This backup declares format '{format}', not '{SETTINGS_EXPORT_FORMAT}'; it was imported on a best-effort basis."
            ),
        ));
    }
    if let Some(version) = root.get("version").and_then(serde_json::Value::as_u64)
        && version > u64::from(SETTINGS_EXPORT_VERSION)
    {
        adjustments.push(report(
            "Backup version",
            "adjusted",
            format!(
                "This backup was created by a newer version (format v{version} > v{SETTINGS_EXPORT_VERSION}); any settings this version does not recognize were skipped."
            ),
        ));
    }
}

fn parse_import(bytes: &[u8], current: &WinsttSettings) -> Result<ParsedImport, String> {
    let root: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|err| format!("Invalid settings JSON: {err}"))?;

    let mut adjustments = Vec::new();

    // Saved LLM configurations travel alongside `settings` as the top-level
    // `llmConfigurations` field (embedded parsed JSON). Read it before `root` may
    // be moved into `settings_value` below. Re-serialize to a compact string ready
    // for `localStorage.setItem`; absent on backups predating the field.
    let llm_configurations = root
        .get("llmConfigurations")
        .filter(|value| !value.is_null())
        .and_then(|value| serde_json::to_string(value).ok());

    // Backups carry an envelope (`{ format, version, settings }`); a bare
    // settings object is also accepted for hand-edited files.
    let settings_value = if let Some(inner) = root.get("settings") {
        check_envelope(&root, &mut adjustments);
        inner.clone()
    } else {
        root
    };
    let Some(mut obj) = settings_value.as_object().cloned() else {
        return Err("Invalid settings payload: expected a JSON object.".to_string());
    };

    migrate_openai_stt_model(&mut obj);

    // Start from the persisted tree so sections ABSENT from the file are left
    // untouched (a partial/older backup must not wipe unspecified sections).
    let mut settings = current.clone();
    let mut present = BTreeSet::new();
    for (key, area) in IMPORT_SECTIONS {
        let Some(section_value) = obj.get(*key) else {
            continue;
        };
        match apply_section(&mut settings, key, section_value.clone()) {
            Ok(()) => {
                present.insert(*key);
                report_unknown_section_keys(area, key, section_value, &settings, &mut adjustments);
            }
            Err(err) => adjustments.push(report(
                area,
                "adjusted",
                format!(
                    "The '{area}' section from this backup could not be read on this version and was left unchanged ({err})."
                ),
            )),
        }
    }

    // Report unknown/removed top-level groups (dropped by the typed sections
    // above) so a silent data loss is at least surfaced. `core` is the
    // backend-only blob and is intentionally ignored, never imported.
    for key in obj.keys() {
        if key == "core" || IMPORT_SECTIONS.iter().any(|(known, _)| known == key) {
            continue;
        }
        adjustments.push(report(
            "Unknown",
            "adjusted",
            format!(
                "Setting group '{key}' from this backup is not recognized on this version and was ignored."
            ),
        ));
    }

    Ok(ParsedImport {
        settings,
        present,
        adjustments,
        llm_configurations,
    })
}

fn patch_from_present(
    settings: &WinsttSettings,
    present: &BTreeSet<&'static str>,
) -> PartialWinsttSettings {
    PartialWinsttSettings {
        global: present.contains("global").then_some(settings.global),
        model: present.contains("model").then(|| settings.model.clone()),
        quality: present
            .contains("quality")
            .then(|| settings.quality.clone()),
        audio: present.contains("audio").then(|| settings.audio.clone()),
        general: present
            .contains("general")
            .then(|| settings.general.clone()),
        hotkey: present.contains("hotkey").then(|| settings.hotkey.clone()),
        dictionary: present
            .contains("dictionary")
            .then(|| settings.dictionary.clone()),
        snippets: present
            .contains("snippets")
            .then(|| settings.snippets.clone()),
        llm: present.contains("llm").then(|| settings.llm.clone()),
        tts: present.contains("tts").then(|| settings.tts.clone()),
        integrations: present
            .contains("integrations")
            .then(|| settings.integrations.clone()),
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

fn restored_report(present: &BTreeSet<&'static str>) -> Vec<SettingsRestoreItem> {
    IMPORT_SECTIONS
        .iter()
        .filter(|(key, _)| present.contains(*key))
        .map(|(_, area)| report(area, "restored", format!("{area} settings were restored.")))
        .collect()
}

fn reconcile_imported_settings(
    parsed: ParsedImport,
    current: &WinsttSettings,
    availability: &SettingsAvailability,
) -> (
    WinsttSettings,
    BTreeSet<&'static str>,
    Vec<SettingsRestoreItem>,
) {
    let ParsedImport {
        mut settings,
        present,
        adjustments: mut adjusted,
        llm_configurations: _,
    } = parsed;
    preserve_target_secrets(&mut settings, current);

    // Only reconcile sections the file actually carried, so an absent section's
    // already-valid persisted value can't produce a spurious adjustment entry.
    if present.contains("general") {
        reconcile_general_paths(&mut settings, &mut adjusted);
    }
    if present.contains("audio") {
        reconcile_audio_devices(&mut settings, &mut adjusted);
    }
    if present.contains("model") {
        reconcile_stt_model(&mut settings, current, availability, &mut adjusted);
        reconcile_realtime_model(&mut settings, availability, &mut adjusted);
    }
    if present.contains("llm") {
        reconcile_llm(&mut settings, availability, &mut adjusted);
    }
    if present.contains("tts") {
        reconcile_tts(&mut settings, current, availability, &mut adjusted);
    }

    (settings, present, adjusted)
}

/// `settings_export_full` — save a JSON backup of the complete settings tree.
/// API keys and legacy post-process secrets are represented only by the standard
/// secret-present sentinel, never by plaintext values.
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
    let parsed = match parse_import(&bytes, &current) {
        Ok(parsed) => parsed,
        Err(err) => return Ok(SettingsImportResult::failed(err)),
    };
    if parsed.present.is_empty() {
        // Nothing recognizable to restore — surface the section problems (if any)
        // instead of silently "succeeding" with an empty patch.
        return Ok(SettingsImportResult::failed(
            "No recognizable settings were found in this backup.".to_string(),
        ));
    }

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
    let (next, present, mut adjusted) =
        reconcile_imported_settings(parsed, &current, &availability);

    if let Err(err) = apply_settings_patch(&app, patch_from_present(&next, &present)) {
        return Ok(SettingsImportResult::failed(format!(
            "Failed to apply imported settings: {err}"
        )));
    }

    let mut restored = restored_report(&present);
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

    /// Wrap a full `WinsttSettings` as a `ParsedImport` where every section is
    /// present, matching a whole-tree import for the reconcile-focused tests.
    fn all_present(settings: WinsttSettings) -> ParsedImport {
        ParsedImport {
            settings,
            present: IMPORT_SECTIONS.iter().map(|(key, _)| *key).collect(),
            adjustments: Vec::new(),
            llm_configurations: None,
        }
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
        // The backend-only `core` blob (which carries any secret material such as
        // the legacy post_process_api_keys) must not be present in the export.
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
        let current = WinsttSettings::default();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "format": SETTINGS_EXPORT_FORMAT,
            "version": SETTINGS_EXPORT_VERSION,
            "settings": { "global": {} },
            "llmConfigurations": {
                "version": 1,
                "configurations": [{ "id": "a", "name": "Mine" }],
                "seededBuiltinIds": [],
            },
        }))
        .unwrap();

        let parsed = parse_import(&bytes, &current).expect("parse");
        let blob = parsed.llm_configurations.expect("configs recovered");
        let reparsed: serde_json::Value = serde_json::from_str(&blob).expect("valid JSON");
        assert_eq!(reparsed["configurations"][0]["id"], serde_json::json!("a"));
    }

    #[test]
    fn import_without_llm_configurations_field_is_absent_not_fatal() {
        let current = WinsttSettings::default();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "format": SETTINGS_EXPORT_FORMAT,
            "version": SETTINGS_EXPORT_VERSION,
            "settings": { "global": {} },
        }))
        .unwrap();

        let parsed = parse_import(&bytes, &current).expect("parse");
        assert!(parsed.llm_configurations.is_none());
    }

    #[test]
    fn absent_sections_are_not_overwritten_and_not_reported() {
        let mut current = WinsttSettings::default();
        current.general.minimize_to_tray = !current.general.minimize_to_tray;
        let expect_minimize = current.general.minimize_to_tray;
        current.model.model = "distinct-current-model".into();

        // A minimal backup that only carries the `global` section.
        let bytes = serde_json::to_vec(&serde_json::json!({
            "format": SETTINGS_EXPORT_FORMAT,
            "version": SETTINGS_EXPORT_VERSION,
            "settings": { "global": {} },
        }))
        .unwrap();

        let parsed = parse_import(&bytes, &current).expect("parse partial backup");
        assert!(parsed.present.contains("global"));
        assert!(!parsed.present.contains("model"));
        // Sections absent from the file keep the machine's current value.
        assert_eq!(parsed.settings.model.model, "distinct-current-model");
        assert_eq!(parsed.settings.general.minimize_to_tray, expect_minimize);

        let restored = restored_report(&parsed.present);
        assert!(restored.iter().any(|item| item.area == "General"));
        assert!(!restored.iter().any(|item| item.area == "Transcription"));

        // The patch only carries the present section.
        let patch = patch_from_present(&parsed.settings, &parsed.present);
        assert!(patch.global.is_some());
        assert!(patch.model.is_none());
    }

    #[test]
    fn newer_section_enum_is_skipped_not_fatal() {
        let current = WinsttSettings::default();
        // `model` carries an unknown enum value for a strict field (as a newer
        // export might); the rest of the import must still succeed.
        let bytes = serde_json::to_vec(&serde_json::json!({
            "format": SETTINGS_EXPORT_FORMAT,
            "version": SETTINGS_EXPORT_VERSION + 5,
            "settings": {
                "global": {},
                "model": { "device": "from-the-future" },
            },
        }))
        .unwrap();

        let parsed = parse_import(&bytes, &current).expect("parse should not hard-fail");
        assert!(parsed.present.contains("global"));
        assert!(!parsed.present.contains("model"));
        // Both the version bump and the unreadable section are surfaced.
        assert!(
            parsed
                .adjustments
                .iter()
                .any(|item| item.area == "Backup version")
        );
        assert!(
            parsed
                .adjustments
                .iter()
                .any(|item| item.area == "Transcription")
        );
    }

    #[test]
    fn unknown_key_within_known_section_is_reported() {
        // finding #13: a field removed/renamed in a newer export lives INSIDE a
        // known section. serde drops it silently; the import must surface it.
        let current = WinsttSettings::default();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "settings": {
                "model": { "language": "fr", "someRemovedField": 123 },
            },
        }))
        .unwrap();

        let parsed = parse_import(&bytes, &current).expect("parse");
        assert!(parsed.present.contains("model"));
        assert_eq!(parsed.settings.model.language, "fr"); // known field still applied
        let item = parsed
            .adjustments
            .iter()
            .find(|item| item.area == "Transcription")
            .expect("unknown in-section key reported");
        assert!(item.message.contains("someRemovedField"));
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
    fn unknown_section_key_is_reported() {
        let current = WinsttSettings::default();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "settings": { "global": {}, "someRemovedGroup": { "x": 1 } },
        }))
        .unwrap();

        let parsed = parse_import(&bytes, &current).expect("parse");
        assert!(parsed.adjustments.iter().any(|item| item.area == "Unknown"));
    }

    #[test]
    fn openai_stt_model_migrates_to_openrouter() {
        let current = WinsttSettings::default();
        let bytes = serde_json::to_vec(&serde_json::json!({
            "settings": { "model": { "model": "openai:whisper-1" } },
        }))
        .unwrap();

        let parsed = parse_import(&bytes, &current).expect("parse");
        assert_eq!(parsed.settings.model.model, "openrouter:openai/whisper-1");
    }

    #[test]
    fn cloud_stt_without_target_key_falls_back_to_available_local_model() {
        let current = WinsttSettings::default();
        let mut imported = WinsttSettings::default();
        imported.model.model = "openrouter:openai/whisper-1".into();
        imported.model.realtime_model = "tiny".into();

        let (next, _present, adjusted) = reconcile_imported_settings(
            all_present(imported),
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

        let (next, _present, adjusted) = reconcile_imported_settings(
            all_present(imported),
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

        let (next, _present, adjusted) = reconcile_imported_settings(
            all_present(imported),
            &current,
            &availability(&["tiny"], &[], &[]),
        );

        assert_eq!(next.tts.source, TtsSource::Local);
        assert!(!next.tts.enabled);
        assert!(adjusted.iter().any(|item| item.area == "Read Aloud"));
    }
}
