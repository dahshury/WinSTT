// Pure serde/specta wire-shape DTOs returned across the Tauri IPC boundary
// (cloud voices, subscription, download estimate, local voice catalog) + the
// `is_false` skip predicate. No behavior, no `TtsManager` reference.

/// One cloud voice surfaced to the renderer cloud-voice picker — the EXACT
/// `CloudTtsVoice` wire shape (`{ id, name, language, category, previewUrl }`).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudVoicePayload {
    pub id: String,
    pub name: String,
    pub language: Option<String>,
    pub category: String,
    pub preview_url: Option<String>,
}

/// `{ voices, error }` — the `CloudTtsVoiceCatalog` wire shape (`ttsCloudListVoices`).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudVoiceCatalogPayload {
    pub voices: Vec<CloudVoicePayload>,
    pub error: Option<String>,
}

/// `{ tier, creditsExhausted }` — the `ttsCloudSubscription` wire shape.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudSubscriptionPayload {
    pub tier: Option<String>,
    pub credits_exhausted: bool,
}

/// One install component — `{ id, label, bytes, installed }` (the estimate dialog).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadComponent {
    pub id: String,
    pub label: String,
    pub bytes: u64,
    pub installed: bool,
}

/// `{ alreadyInstalled, components, totalBytes, unavailable? }` —
/// the `TtsDownloadEstimatePayload` wire shape (`ttsDownloadEstimate`).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEstimatePayload {
    pub already_installed: bool,
    pub components: Vec<DownloadComponent>,
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "is_false")]
    pub unavailable: bool,
}

/// `skip_serializing_if` predicate so `unavailable: false` is omitted (the
/// renderer's `TtsDownloadEstimatePayload.unavailable` is optional).
fn is_false(b: &bool) -> bool {
    !*b
}

/// `{ voices, languages }` — the `TtsVoiceCatalog` wire shape (`listTtsVoices`).
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCatalogPayload {
    pub voices: Vec<LocalVoicePayload>,
    pub languages: Vec<LanguagePayload>,
}

/// One local Kokoro voice — `{ id, label, language, gender }`.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalVoicePayload {
    pub id: String,
    pub label: String,
    pub language: String,
    pub gender: String,
}

/// One language `{ code, label }`.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePayload {
    pub code: String,
    pub label: String,
}
