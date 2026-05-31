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
use tauri::{AppHandle, Emitter, State};

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

/// Result of a speak/preview start — the request id the renderer correlates the
/// `tts://chunk` stream + cancel against. Mirrors `TtsSpeakResult` in
/// `ipc-client.ts` (`{ requestId }`).
#[derive(Clone, Debug, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpeakResult {
    pub request_id: String,
}

/// `tts_speak` — read `text` aloud (dictation/manual). Returns the request id so
/// the renderer can correlate the `tts://chunk` stream + cancel it.
#[tauri::command]
#[specta::specta]
pub async fn tts_speak(
    app: AppHandle,
    tts: State<'_, Arc<TtsManager>>,
    text: String,
    // `voice`/`lang`/`speed` are optional in the renderer's `ttsSpeak` wrapper
    // (`{ text, voice?, lang?, speed? }`) — the host resolves them from settings
    // when omitted. Empty voice/lang let the engine pick its configured defaults.
    voice: Option<String>,
    lang: Option<String>,
    speed: Option<f32>,
) -> Result<SpeakResult, String> {
    let mgr = tts.inner().clone();
    let request_id = mgr.next_request_id();
    let rid = request_id.clone();
    let voice = voice.unwrap_or_default();
    let lang = lang.unwrap_or_default();
    // Seed the live speed from this request, then sample it per sentence so the
    // pill's mid-read speed change (`tts_set_speed`) applies to the NEXT sentence.
    mgr.set_speed(speed.unwrap_or(1.0));
    let speed_mgr = mgr.clone();
    // Run the blocking synthesis off the async pump.
    tauri::async_runtime::spawn_blocking(move || {
        let _ = mgr.read_aloud(&rid, &text, &voice, &lang, move || speed_mgr.current_speed());
    });
    let _ = app;
    Ok(SpeakResult { request_id })
}

/// `tts_speak_selection` — read the current selection aloud (the read hotkey).
/// The selected text is captured by the caller (context sidecar / clipboard) and
/// passed in; this wraps the same synthesis path.
#[tauri::command]
#[specta::specta]
pub async fn tts_speak_selection(
    tts: State<'_, Arc<TtsManager>>,
    text: String,
    voice: Option<String>,
    lang: Option<String>,
    speed: Option<f32>,
) -> Result<SpeakResult, String> {
    let mgr = tts.inner().clone();
    let request_id = mgr.next_request_id();
    let rid = request_id.clone();
    let voice = voice.unwrap_or_default();
    let lang = lang.unwrap_or_default();
    mgr.set_speed(speed.unwrap_or(1.0));
    let speed_mgr = mgr.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = mgr.read_aloud(&rid, &text, &voice, &lang, move || speed_mgr.current_speed());
    });
    Ok(SpeakResult { request_id })
}

/// `tts_cancel` — stop one (or, with no id, every) in-flight read. The renderer's
/// `ttsCancel(requestId?)` sends `{ requestId: undefined }` for the cancel-all
/// gesture, so `request_id` is optional (mirrors `tts.ts` `cancel(requestId?)`).
#[tauri::command]
#[specta::specta]
pub fn tts_cancel(tts: State<'_, Arc<TtsManager>>, request_id: Option<String>) {
    match request_id.as_deref() {
        Some(id) if !id.is_empty() => tts.cancel(id),
        _ => tts.cancel_all(),
    }
}

/// `tts_set_speed` — set the live read-aloud speed from the pill's speed control.
/// Applies to the active read's upcoming sentences (next-sentence, natural pitch)
/// and to every subsequent read. The persisted `tts.speed` / `tts.cloud.speed`
/// store write is the settings command's job. Mirrors `tts.ts` `handleSetSpeed`.
#[tauri::command]
#[specta::specta]
pub fn tts_set_speed(tts: State<'_, Arc<TtsManager>>, speed: f32) {
    tts.set_speed(speed);
}

/// `tts_report_playback_started` — the window that owns the Web Audio queue
/// (the overlay) reports that audio for `request_id` ACTUALLY started playing
/// (the ~1s synthesis gap is over). Re-broadcast as `tts:playback-started` so a
/// play/stop control in a window WITHOUT a queue (settings) can flip its loading
/// spinner to a stop control. Mirrors `tts.ts` `handleReportPlaybackStarted`.
#[tauri::command]
#[specta::specta]
pub fn tts_report_playback_started(app: AppHandle, request_id: String) {
    let _ = app.emit("tts:playback-started", serde_json::json!({ "requestId": request_id }));
}

/// `tts_report_playback_ended` — the overlay reports that audio for `request_id`
/// has finished draining (also fires on cancel / failure). Re-broadcast as
/// `tts:playback-ended` so a queue-less window tracks REAL playback (not the much
/// earlier synthesis-complete). Mirrors `tts.ts` `handleReportPlaybackEnded`.
#[tauri::command]
#[specta::specta]
pub fn tts_report_playback_ended(app: AppHandle, request_id: String) {
    let _ = app.emit("tts:playback-ended", serde_json::json!({ "requestId": request_id }));
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

/// `tts_preview_cloud` — play a cloud voice's FREE pre-generated sample clip
/// (`previewUrl`) instead of synthesizing (browsing voices costs no credits). The
/// renderer can't fetch the clip itself (CSP blocks external hosts), so the backend
/// downloads it and streams it back as a `tts://chunk`. Mirrors `tts.ts`
/// `handleCloudPreview` (payload `{ previewUrl }`). Returns the request id.
#[tauri::command]
#[specta::specta]
pub async fn tts_preview_cloud(
    tts: State<'_, Arc<TtsManager>>,
    preview_url: String,
) -> Result<SpeakResult, String> {
    if preview_url.is_empty() {
        return Ok(SpeakResult::default());
    }
    let mgr = tts.inner().clone();
    let request_id = mgr.next_request_id();
    let rid = request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        mgr.read_preview_url(&rid, &preview_url);
    });
    Ok(SpeakResult { request_id })
}
