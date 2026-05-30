// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/06_tts.md + lib_wiring.md §3,
// frontend/electron/ipc/{tts,tts-cloud,tts-reader}.ts. Wraps managers::TtsManager.
//
// TTS commands. Local synthesis runs blocking on a worker (spawn_blocking) so the
// async pump never stalls on the first-run download / session create / inference.
// Voices come from the static 54-voice catalog (local) or a live `/v2/voices`
// fetch (cloud). Cancel + install lifecycle route through the manager.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use crate::winstt::managers::TtsManager;

/// One voice surfaced to the renderer picker (specta-typed wire shape).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VoicePayload {
    pub id: String,
    pub label: String,
    pub language: String,
    pub gender: String,
}

/// Cloud (ElevenLabs) subscription summary for the picker quota hints.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudSubscription {
    pub tier: String,
    pub character_count: u64,
    pub character_limit: u64,
}

/// Download size estimate for the on-demand Kokoro pack.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEstimate {
    pub total_bytes: u64,
    pub already_have_bytes: u64,
}

/// `tts_speak` — read `text` aloud (dictation/manual). Returns the request id so
/// the renderer can correlate the `tts://chunk` stream + cancel it.
#[tauri::command]
#[specta::specta]
pub async fn tts_speak(
    app: AppHandle,
    tts: State<'_, Arc<TtsManager>>,
    text: String,
    voice: String,
    lang: String,
    speed: f32,
) -> Result<String, String> {
    let mgr = tts.inner().clone();
    let request_id = mgr.next_request_id();
    let rid = request_id.clone();
    // Run the blocking synthesis off the async pump.
    tauri::async_runtime::spawn_blocking(move || {
        let _ = mgr.read_aloud(&rid, &text, &voice, &lang, || speed);
    });
    let _ = app;
    Ok(request_id)
}

/// `tts_speak_selection` — read the current selection aloud (the read hotkey).
/// The selected text is captured by the caller (context sidecar / clipboard) and
/// passed in; this wraps the same synthesis path.
#[tauri::command]
#[specta::specta]
pub async fn tts_speak_selection(
    tts: State<'_, Arc<TtsManager>>,
    text: String,
    voice: String,
    lang: String,
    speed: f32,
) -> Result<String, String> {
    let mgr = tts.inner().clone();
    let request_id = mgr.next_request_id();
    let rid = request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = mgr.read_aloud(&rid, &text, &voice, &lang, || speed);
    });
    Ok(request_id)
}

/// `tts_cancel` — stop one in-flight read.
#[tauri::command]
#[specta::specta]
pub fn tts_cancel(tts: State<'_, Arc<TtsManager>>, request_id: String) {
    tts.cancel(&request_id);
}

/// `tts_cancel_all` — stop every read (STT force-stop / app exit).
#[tauri::command]
#[specta::specta]
pub fn tts_cancel_all(tts: State<'_, Arc<TtsManager>>) {
    tts.cancel_all();
}

/// `tts_init` — force the engine warm-up off the UI thread (download + session
/// create / key check). Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn tts_init(tts: State<'_, Arc<TtsManager>>) -> Result<(), String> {
    let mgr = tts.inner().clone();
    tauri::async_runtime::spawn_blocking(move || mgr.warm_up().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// `tts_list_voices` — the static 54-voice local Kokoro catalog.
#[tauri::command]
#[specta::specta]
pub fn tts_list_voices(tts: State<'_, Arc<TtsManager>>) -> Vec<VoicePayload> {
    tts.list_voices()
        .into_iter()
        .map(|v| VoicePayload {
            id: v.id.to_string(),
            label: v.label.to_string(),
            language: v.language.to_string(),
            gender: v.gender.as_str().to_string(),
        })
        .collect()
}

/// `tts_list_cloud_voices` — live `GET /v2/voices` (cloned voices appear here).
/// SPIKE: reqwest the ElevenLabs voices endpoint with the stored key. Empty until
/// the key + transport are wired; the picker falls back to the local catalog.
#[tauri::command]
#[specta::specta]
pub async fn tts_list_cloud_voices(_app: AppHandle) -> Result<Vec<VoicePayload>, String> {
    // SPIKE: GET ELEVENLABS_VOICES_URL with xi-api-key; map name/voice_id/labels.
    Ok(Vec::new())
}

/// `tts_cloud_subscription` — the ElevenLabs quota summary.
#[tauri::command]
#[specta::specta]
pub async fn tts_cloud_subscription(_app: AppHandle) -> Result<CloudSubscription, String> {
    // SPIKE: GET /v1/user/subscription with xi-api-key.
    Ok(CloudSubscription::default())
}

/// `tts_download_estimate` — bytes to fetch for the on-demand Kokoro pack.
#[tauri::command]
#[specta::specta]
pub fn tts_download_estimate(_app: AppHandle) -> DownloadEstimate {
    // SPIKE: stat the cache dir vs the known model+voicepack sizes.
    DownloadEstimate::default()
}

/// `tts_install_pause` — cooperatively pause the engine-pack download.
#[tauri::command]
#[specta::specta]
pub fn tts_install_pause(_app: AppHandle) {
    // SPIKE: signal the asset downloader (Range-resumable) to pause.
}

/// `tts_install_resume` — resume a paused install.
#[tauri::command]
#[specta::specta]
pub async fn tts_install_resume(tts: State<'_, Arc<TtsManager>>) -> Result<(), String> {
    let mgr = tts.inner().clone();
    tauri::async_runtime::spawn_blocking(move || mgr.warm_up().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// `tts_install_cancel` — cancel the install + clean up the partial download.
#[tauri::command]
#[specta::specta]
pub fn tts_install_cancel(_app: AppHandle) {
    // SPIKE: signal the asset downloader to cancel + remove `.partial`.
}

/// `tts_preview_cloud` — synthesize a short preview via the cloud engine.
#[tauri::command]
#[specta::specta]
pub async fn tts_preview_cloud(
    tts: State<'_, Arc<TtsManager>>,
    text: String,
    voice: String,
    lang: String,
    speed: f32,
) -> Result<String, String> {
    let mgr = tts.inner().clone();
    let request_id = mgr.next_request_id();
    let rid = request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = mgr.read_aloud(&rid, &text, &voice, &lang, || speed);
    });
    Ok(request_id)
}
