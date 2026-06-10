// Reference: frontend/electron/ipc/{tts,tts-cloud,tts-reader}.ts. Wraps managers::TtsManager.
//
// TTS commands. Local synthesis runs blocking on a worker (spawn_blocking) so the
// async pump never stalls on the first-run download / session create / inference.
// The voice catalog is the static 54-voice Kokoro list ({ voices, languages });
// cloud voices come from a live `/v2/voices` fetch ({ voices, error }). Cancel +
// speed + install lifecycle route through the manager.
//
// Every payload shape is byte-identical to what the reused WinSTT renderer's
// `ipc-client.ts` expects (TtsSpeakResult / TtsVoiceCatalog / CloudTtsVoiceCatalog
// / {tier,creditsExhausted} / TtsDownloadEstimatePayload).

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::command_auth;
use crate::winstt::managers::tts_manager::{
    CloudSubscriptionPayload, CloudVoiceCatalogPayload, DownloadEstimatePayload,
    VoiceCatalogPayload,
};
use crate::winstt::managers::TtsManager;

const TTS_OVERLAY_READY_TIMEOUT: Duration = Duration::from_millis(750);

/// Result of a speak/preview start — the request id the renderer correlates the
/// `tts:chunk` stream + cancel against. Mirrors `TtsSpeakResult` in
/// `ipc-client.ts` (`{ requestId }`).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpeakResult {
    pub request_id: String,
}

/// Reserve the overlay's read-aloud layer and keep Escape armed while a TTS
/// session exists. Playback may not have started yet, but the user should still
/// be able to cancel the pending synthesis with Escape.
pub fn reserve_tts_playback_layer(app: &AppHandle) {
    crate::winstt::commands::overlay::reserve_tts_overlay(app);
    if !crate::winstt::commands::overlay::wait_for_overlay_page_loaded(TTS_OVERLAY_READY_TIMEOUT) {
        log::warn!("[tts] overlay did not report ready before playback stream started");
    }
    crate::shortcut::register_cancel_shortcut(app);
}

/// `tts_speak` — read `text` aloud (the renderer "Speak" button / dictation).
/// Returns the request id so the renderer can correlate the `tts:chunk` stream
/// + cancel it. Enabled-gate, source selection (local/cloud), and settings
/// fallbacks for voice/lang/speed all live in `TtsManager::read_aloud` (mirrors
/// the reference `handleSpeak`). Empty `voice`/`lang` → the manager resolves them
/// from the active source's settings.
#[tauri::command]
#[specta::specta]
pub async fn tts_speak(
    app: AppHandle,
    tts: State<'_, Arc<TtsManager>>,
    text: String,
    // `voice`/`lang`/`speed` are optional in the renderer's `ttsSpeak` wrapper.
    voice: Option<String>,
    lang: Option<String>,
    speed: Option<f32>,
) -> Result<SpeakResult, String> {
    let mgr = tts.inner().clone();
    let request_id = mgr.next_request_id();
    reserve_tts_playback_layer(&app);
    let rid = request_id.clone();
    let voice = voice.unwrap_or_default();
    let lang = lang.unwrap_or_default();
    // Seed the live speed from this request (or the persisted setting), then sample
    // it per sentence so the pill's mid-read `tts_set_speed` applies NEXT sentence.
    if let Some(sp) = speed {
        mgr.set_speed(sp);
    }
    let speed_mgr = mgr.clone();
    let panic_rid = request_id.clone();
    // Run the blocking synthesis off the async pump.
    tauri::async_runtime::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            mgr.read_aloud(&rid, &text, &voice, &lang, move || {
                speed_mgr.current_speed()
            });
        }));
        if result.is_err() {
            mgr.fail_request(&panic_rid, "TTS synthesis panicked");
        }
    });
    Ok(SpeakResult { request_id })
}

/// `tts_speak_selection` — read the current selection aloud (the read hotkey).
/// The selected text is captured by the caller (context sidecar / clipboard) and
/// passed in; this wraps the same source-aware synthesis path. An empty selection
/// emits `tts:failed { reason: "No text selected" }` (mirrors the reference).
#[tauri::command]
#[specta::specta]
pub async fn tts_speak_selection(
    app: AppHandle,
    tts: State<'_, Arc<TtsManager>>,
    text: Option<String>,
    voice: Option<String>,
    lang: Option<String>,
    speed: Option<f32>,
) -> Result<SpeakResult, String> {
    let mgr = tts.inner().clone();
    let request_id = mgr.next_request_id();
    let text = text.unwrap_or_default();
    if text.trim().is_empty() {
        // No selection — surface the same failure the reference path broadcasts so
        // the overlay pill shows the error and resets.
        let _ = app.emit(
            "tts:failed",
            serde_json::json!({ "requestId": "", "reason": "No text selected" }),
        );
        return Ok(SpeakResult::default());
    }
    reserve_tts_playback_layer(&app);
    let rid = request_id.clone();
    let voice = voice.unwrap_or_default();
    let lang = lang.unwrap_or_default();
    if let Some(sp) = speed {
        mgr.set_speed(sp);
    }
    let speed_mgr = mgr.clone();
    let panic_rid = request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            mgr.read_aloud(&rid, &text, &voice, &lang, move || {
                speed_mgr.current_speed()
            });
        }));
        if result.is_err() {
            mgr.fail_request(&panic_rid, "TTS synthesis panicked");
        }
    });
    Ok(SpeakResult { request_id })
}

/// `tts_cancel` — stop one (or, with no id / empty id, every) in-flight read. The
/// renderer's `ttsCancel(requestId?)` sends `{ requestId: undefined }` for the
/// cancel-all gesture (mirrors `tts.ts` `cancel(requestId?)`).
#[tauri::command]
#[specta::specta]
pub fn tts_cancel(tts: State<'_, Arc<TtsManager>>, request_id: Option<String>) {
    match request_id.as_deref() {
        Some(id) if !id.is_empty() => tts.cancel(id),
        _ => tts.cancel_all(),
    }
}

/// `tts_set_speed` — set the read-aloud speed from the pill's speed control.
/// Applies to the active read's upcoming sentences (next-sentence, natural pitch)
/// AND persists `tts.speed` / `tts.cloud.speed` so it carries to every subsequent
/// read. Persisting is load-bearing for the island pill: it shows (and cycles
/// from) the speed read out of the settings store, so without the store write the
/// label never advances and the button looks dead. The pill window has no
/// settings write-back of its own, so the persist must happen here.
///
/// The tts section is replaced wholesale on save, so we copy the full persisted
/// section and change only the one speed field for the active source.
#[tauri::command]
#[specta::specta]
pub fn tts_set_speed(app: AppHandle, tts: State<'_, Arc<TtsManager>>, speed: f32) {
    use crate::winstt::commands::settings::{
        apply_settings_patch, read_settings, PartialWinsttSettings,
    };
    use crate::winstt::settings_schema::TtsSource;

    // Immediate live effect on the in-flight read (next sentence).
    tts.set_speed(speed);

    // Persist + broadcast so the pill's displayed speed advances and the choice
    // sticks. Patch only the active source's speed field; keep every other field.
    let mut tts_section = read_settings(&app).tts;
    if tts_section.source == TtsSource::Cloud {
        tts_section.cloud.speed = speed as f64;
    } else {
        tts_section.speed = speed as f64;
    }
    let patch = PartialWinsttSettings {
        tts: Some(tts_section),
        ..Default::default()
    };
    if let Err(err) = apply_settings_patch(&app, patch) {
        log::warn!("[tts] failed to persist read-aloud speed {speed}: {err}");
    }
}

/// Ask the overlay-owned Web Audio queue to pause read-aloud playback before
/// microphone capture starts. This is intentionally playback-only: synthesis and
/// the request id remain alive so the TTS session can be resumed from the island.
pub fn request_tts_playback_pause_for_dictation(app: &AppHandle) {
    emit_tts_playback_pause(app, "dictation");
}

fn emit_tts_playback_pause(app: &AppHandle, reason: &str) {
    let _ = app.emit(
        "tts:pause-playback",
        serde_json::json!({ "reason": reason }),
    );
}

fn emit_tts_playback_resume(app: &AppHandle, reason: &str) {
    let _ = app.emit(
        "tts:resume-playback",
        serde_json::json!({ "reason": reason }),
    );
}

/// `tts_pause_playback` - request a playback-only pause from the backend. This is
/// used by renderer Media Session handlers for OS media keys: the renderer reports
/// the intent to Rust, and Rust rebroadcasts the authoritative playback-control
/// event to the overlay-owned Web Audio queue.
#[tauri::command]
#[specta::specta]
pub fn tts_pause_playback(app: AppHandle, reason: Option<String>) {
    emit_tts_playback_pause(&app, reason.as_deref().unwrap_or("media-session"));
}

/// `tts_resume_playback` - request a playback-only resume from the backend. This
/// mirrors `tts_pause_playback`; synthesis stays alive and only the overlay-owned
/// Web Audio queue changes state.
#[tauri::command]
#[specta::specta]
pub fn tts_resume_playback(app: AppHandle, reason: Option<String>) {
    emit_tts_playback_resume(&app, reason.as_deref().unwrap_or("media-session"));
}

/// Cancel the active read-aloud layer in response to Escape. The Web Audio queue
/// lives in the overlay renderer, so Rust asks that window to discard playback
/// and also cancels backend synthesis as a fallback.
pub fn cancel_tts_playback_layer(app: &AppHandle) -> bool {
    if !crate::winstt::commands::overlay::tts_overlay_is_active() {
        return false;
    }

    let _ = app.emit(
        "tts:discard-playback",
        serde_json::json!({ "reason": "escape" }),
    );
    if let Some(tts) = app.try_state::<Arc<TtsManager>>() {
        tts.cancel_all();
    }
    crate::winstt::commands::overlay::hide_tts_overlay(app);
    crate::utils::unregister_cancel_shortcut_if_idle(app);
    true
}

/// `tts_report_playback_started` — the window that owns the Web Audio queue (the
/// overlay) reports that audio for `request_id` ACTUALLY started playing (the ~1s
/// synthesis gap is over). Re-broadcast as `tts:playback-started` so a play/stop
/// control in a queue-less window (settings) flips its spinner to a stop control.
/// Mirrors `tts.ts` `handleReportPlaybackStarted`.
#[tauri::command]
#[specta::specta]
pub fn tts_report_playback_started(app: AppHandle, request_id: String) {
    crate::winstt::ducking::duck_read_aloud_from_settings(&app);
    // Reveal the forced read-aloud island. The overlay window is otherwise only
    // shown for dictation; the renderer already paints the TTS island from its
    // `ttsStatus` store, so we just have to put the window on screen (top-anchored).
    crate::winstt::commands::overlay::show_tts_overlay(&app);
    let _ = app.emit(
        "tts:playback-started",
        serde_json::json!({ "requestId": request_id }),
    );
}

/// `tts_report_playback_ended` — the overlay reports that audio for `request_id`
/// has finished draining (also fires on cancel / failure). Re-broadcast as
/// `tts:playback-ended` so a queue-less window tracks REAL playback. Mirrors
/// `tts.ts` `handleReportPlaybackEnded`.
#[tauri::command]
#[specta::specta]
pub fn tts_report_playback_ended(app: AppHandle, request_id: String) {
    crate::winstt::ducking::request_read_aloud_restore();
    // Read finished / cancelled / failed → hide the island. The shared hide's
    // show-generation guard means a dictation session that just took over (which
    // re-shows + repositions the overlay) is NOT hidden by this call.
    crate::winstt::commands::overlay::hide_tts_overlay(&app);
    crate::utils::unregister_cancel_shortcut_if_idle(&app);
    let _ = app.emit(
        "tts:playback-ended",
        serde_json::json!({ "requestId": request_id }),
    );
}

/// `tts_cancel_all` — stop every read (STT force-stop / app exit).
#[tauri::command]
#[specta::specta]
pub fn tts_cancel_all(tts: State<'_, Arc<TtsManager>>) {
    tts.cancel_all();
}

/// `tts_init` — force the engine warm-up off the UI thread (download + session
/// create / key check). Idempotent. Cloud source has no Kokoro engine to warm, so
/// it's a no-op there (mirrors the reference `maybeWarmup` skipping cloud). Returns
/// `{ ready }` (the renderer's `initTts` expects `{ ready: boolean }`).
#[tauri::command]
#[specta::specta]
pub async fn tts_init(tts: State<'_, Arc<TtsManager>>) -> Result<TtsInitResult, String> {
    let mgr = tts.inner().clone();
    // Cloud needs no warm-up; report ready (key is checked at synth time).
    if mgr.is_cloud_source() {
        return Ok(TtsInitResult { ready: true });
    }
    let ready = tauri::async_runtime::spawn_blocking(move || mgr.warm_up().is_ok())
        .await
        .map_err(|e| e.to_string())?;
    Ok(TtsInitResult { ready })
}

/// `{ ready }` — the `initTts` result shape (`{ ready: boolean }`).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct TtsInitResult {
    pub ready: bool,
}

/// `tts_list_voices` — the static 54-voice Kokoro catalog as `{ voices, languages }`
/// (the `TtsVoiceCatalog` the renderer's `listTtsVoices` expects). NOT a bare array.
#[tauri::command]
#[specta::specta]
pub fn tts_list_voices(
    tts: State<'_, Arc<TtsManager>>,
    model_id: Option<String>,
) -> VoiceCatalogPayload {
    tts.list_voices_catalog(model_id)
}

/// `tts_list_cloud_voices` — live `GET /v2/voices` (cloned voices appear here).
/// Returns `{ voices, error }` (`CloudTtsVoiceCatalog`); never throws across the
/// boundary — a missing/invalid key surfaces as `{ voices: [], error }`.
#[tauri::command]
#[specta::specta]
pub async fn tts_list_cloud_voices(
    tts: State<'_, Arc<TtsManager>>,
) -> Result<CloudVoiceCatalogPayload, String> {
    Ok(tts.inner().list_cloud_voices().await)
}

/// `tts_cloud_subscription` — the ElevenLabs quota summary `{ tier, creditsExhausted }`.
/// Defaults to `{ tier: null, creditsExhausted: false }` on a missing-scope key /
/// request failure (never wrongly blocks cloud TTS).
#[tauri::command]
#[specta::specta]
pub async fn tts_cloud_subscription(
    tts: State<'_, Arc<TtsManager>>,
) -> Result<CloudSubscriptionPayload, String> {
    Ok(tts.inner().cloud_subscription().await)
}

/// `tts_download_estimate` — side-effect-free estimate of what enabling local
/// Kokoro TTS will download `{ alreadyInstalled, components, totalBytes,
/// unavailable? }` (`TtsDownloadEstimatePayload`). Calling this never starts a
/// download. Cloud source reports `alreadyInstalled: true` (nothing local to fetch).
#[tauri::command]
#[specta::specta]
pub async fn tts_download_estimate(
    tts: State<'_, Arc<TtsManager>>,
) -> Result<DownloadEstimatePayload, String> {
    Ok(tts.inner().download_estimate().await)
}

/// `tts_install_pause` — cooperatively pause the engine-pack download.
///
/// The local Kokoro install is just the two model FILES (no separate engine pack),
/// and the current downloader runs synchronously inside `warm_up`/first-synth, so
/// there is no long-lived resumable job to pause yet. We emit `tts:install-paused`
/// for UI parity with the reference; the partial files survive on disk and re-enabling
/// resumes via HTTP Range automatically.
// TODO(engine): when the shared resumable asset downloader lands (mod.rs
// `download_kokoro_assets` DownloadControl), wire pause/resume/cancel to its
// cooperative pause/cancel flags instead of this UI-only emit.
#[tauri::command]
#[specta::specta]
pub fn tts_install_pause(app: AppHandle) {
    let _ = app.emit("tts:install-paused", serde_json::json!({}));
}

/// `tts_install_resume` — resume a paused install by re-firing warm-up (which
/// re-downloads any missing model file via HTTP Range, then loads the session).
/// No-op for cloud.
#[tauri::command]
#[specta::specta]
pub async fn tts_install_resume(
    app: AppHandle,
    tts: State<'_, Arc<TtsManager>>,
) -> Result<(), String> {
    let _ = app.emit("tts:install-resumed", serde_json::json!({}));
    let mgr = tts.inner().clone();
    if mgr.is_cloud_source() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || mgr.warm_up().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// `tts_install_cancel` — cancel the install + clean up the partial download.
///
/// Emits `tts:model-download-complete { cancelled: true }` for UI parity. Partial-
/// file removal happens lazily on the next resume (HTTP Range re-validates).
// TODO(engine): wire to the shared downloader's cooperative cancel + `.partial`
// removal once it lands (see `tts_install_pause`).
#[tauri::command]
#[specta::specta]
pub fn tts_install_cancel(app: AppHandle) {
    let _ = app.emit(
        "tts:model-download-complete",
        serde_json::json!({ "cancelled": true }),
    );
}

/// `tts_preview_cloud` — play a cloud voice's FREE pre-generated sample clip
/// (`previewUrl`) instead of synthesizing (browsing voices costs no credits). The
/// renderer can't fetch the clip itself (CSP blocks external hosts), so the backend
/// downloads it and streams it back as a `tts:chunk`. Mirrors `tts.ts`
/// `handleCloudPreview` (payload `{ previewUrl }`). Returns the request id.
#[tauri::command]
#[specta::specta]
pub async fn tts_preview_cloud(
    app: AppHandle,
    tts: State<'_, Arc<TtsManager>>,
    preview_url: String,
) -> Result<SpeakResult, String> {
    if preview_url.is_empty() {
        return Ok(SpeakResult::default());
    }
    let mgr = tts.inner().clone();
    let request_id = mgr.next_request_id();
    reserve_tts_playback_layer(&app);
    let rid = request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        mgr.read_preview_url(&rid, &preview_url);
    });
    Ok(SpeakResult { request_id })
}

/// `tts_preview_openrouter` — play a model-scoped OpenRouter voice preview.
/// The manager performs a short live `/audio/speech` synthesis through
/// OpenRouter for the selected model/voice/speed.
#[tauri::command]
#[specta::specta]
pub async fn tts_preview_openrouter(
    app: AppHandle,
    tts: State<'_, Arc<TtsManager>>,
    model: String,
    voice: String,
    speed: Option<f32>,
) -> Result<SpeakResult, String> {
    if model.trim().is_empty() || voice.trim().is_empty() {
        return Ok(SpeakResult::default());
    }
    let mgr = tts.inner().clone();
    let request_id = mgr.next_request_id();
    reserve_tts_playback_layer(&app);
    let rid = request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        mgr.read_openrouter_preview(&rid, &model, &voice, speed.unwrap_or(1.0));
    });
    Ok(SpeakResult { request_id })
}

// ===========================================================================
// Multi-provider TTS catalog (the model-aware picker). Mirrors the STT
// list_models / list_models_with_state + per-quant download lifecycle, but for
// the TTS_CATALOG (Kokoro / Kitten / Piper / Supertonic) downloaded from HF.
// ===========================================================================

use std::collections::HashMap;

use crate::winstt::managers::tts_download_manager::TtsDownloadManager;
use crate::winstt::tts::catalog::{self, TtsModelEntry};

/// One TTS catalog row, snake_case (the renderer's rawTtsModelSchema maps it to
/// the camelCase `TtsModelInfo`).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type, Default)]
pub struct TtsModelInfoDto {
    pub id: String,
    pub engine: String,
    pub display_name: String,
    pub maker: String,
    pub languages: Vec<String>,
    pub num_voices: u32,
    pub cloning: String,
    pub sample_rate: u32,
    pub param_count_m: u32,
    pub size_label: String,
    pub available_quantizations: Vec<String>,
    pub size_bytes_by_quantization: HashMap<String, u64>,
    pub quality_score: f32,
    pub speed_score: f32,
    pub description: String,
    pub available: bool,
}

/// Per-quant cache state, camelCase (matches the renderer's `TtsModelCacheInfo`).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct TtsCacheInfoDto {
    pub state: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub progress: f64,
}

/// Per-model cache state, camelCase (matches the renderer's `TtsModelStateEntry`).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct TtsModelStateDto {
    pub id: String,
    pub cache_by_quantization: HashMap<String, TtsCacheInfoDto>,
    pub effective_quantization: String,
    pub estimated_bytes: u64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type, Default)]
pub struct TtsModelsWithStateDto {
    pub models: Vec<TtsModelInfoDto>,
    pub states: Vec<TtsModelStateDto>,
}

fn human_size(bytes: u64) -> String {
    const MB: f64 = 1_048_576.0;
    const GB: f64 = 1_073_741_824.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else {
        format!("{:.0} MB", (b / MB).max(1.0))
    }
}

fn to_model_info(m: &TtsModelEntry) -> TtsModelInfoDto {
    let mut size_by: HashMap<String, u64> = HashMap::new();
    for q in m.quants {
        size_by.insert(q.id.to_string(), q.size_bytes);
    }
    let default_size = m
        .quant(m.default_quant())
        .map(|q| q.size_bytes)
        .unwrap_or(0);
    TtsModelInfoDto {
        id: m.id.to_string(),
        engine: m.engine.as_str().to_string(),
        display_name: m.display_name.to_string(),
        maker: m.maker.to_string(),
        languages: m.languages.iter().map(|s| s.to_string()).collect(),
        num_voices: m.num_voices,
        cloning: m.cloning.as_str().to_string(),
        sample_rate: m.sample_rate,
        param_count_m: m.param_count_m,
        size_label: human_size(default_size),
        available_quantizations: m.quants.iter().map(|q| q.id.to_string()).collect(),
        size_bytes_by_quantization: size_by,
        quality_score: m.quality_score,
        speed_score: m.speed_score,
        description: m.description.to_string(),
        available: true,
    }
}

fn to_model_state(m: &TtsModelEntry, dl: &TtsDownloadManager) -> TtsModelStateDto {
    let mut by_quant: HashMap<String, TtsCacheInfoDto> = HashMap::new();
    for q in m.quants {
        let info = dl.cache_info(m.id, q.id);
        by_quant.insert(
            q.id.to_string(),
            TtsCacheInfoDto {
                state: info.state.as_str().to_string(),
                downloaded_bytes: info.downloaded_bytes,
                total_bytes: info.total_bytes,
                progress: info.progress,
            },
        );
    }
    let eff = m.default_quant().to_string();
    let estimated_bytes = m.quant(&eff).map(|q| q.size_bytes).unwrap_or(0);
    TtsModelStateDto {
        id: m.id.to_string(),
        cache_by_quantization: by_quant,
        effective_quantization: eff,
        estimated_bytes,
    }
}

/// `tts_list_models` — the full multi-provider TTS catalog (snake_case rows).
#[tauri::command]
#[specta::specta]
pub fn tts_list_models() -> Vec<TtsModelInfoDto> {
    catalog::TTS_CATALOG.iter().map(to_model_info).collect()
}

/// `tts_list_models_with_state` — catalog + per-model cache state in one call.
#[tauri::command]
#[specta::specta]
pub fn tts_list_models_with_state(dl: State<'_, Arc<TtsDownloadManager>>) -> TtsModelsWithStateDto {
    let models = catalog::TTS_CATALOG.iter().map(to_model_info).collect();
    let states = catalog::TTS_CATALOG
        .iter()
        .map(|m| to_model_state(m, dl.inner()))
        .collect();
    TtsModelsWithStateDto { models, states }
}

/// `tts_predownload_model` — start (or resume) a per-quant model download.
#[tauri::command]
#[specta::specta]
pub fn tts_predownload_model(
    dl: State<'_, Arc<TtsDownloadManager>>,
    model_id: String,
    quantization: String,
) {
    dl.inner().predownload(&model_id, &quantization);
}

/// `tts_download_pause` — cooperatively pause an in-flight model download.
#[tauri::command]
#[specta::specta]
pub fn tts_download_pause(
    dl: State<'_, Arc<TtsDownloadManager>>,
    model_id: String,
    quantization: String,
) {
    dl.pause(&model_id, &quantization);
}

/// `tts_download_resume` — resume a paused download (re-fires the worker; the
/// `.partial` file resumes via HTTP Range).
#[tauri::command]
#[specta::specta]
pub fn tts_download_resume(
    dl: State<'_, Arc<TtsDownloadManager>>,
    model_id: String,
    quantization: String,
) {
    dl.inner().predownload(&model_id, &quantization);
}

/// `tts_download_cancel` — cancel an in-flight download (drops the `.partial`).
#[tauri::command]
#[specta::specta]
pub fn tts_download_cancel(
    dl: State<'_, Arc<TtsDownloadManager>>,
    model_id: String,
    quantization: String,
) {
    dl.cancel(&model_id, &quantization);
}

const TTS_CACHE_MUTATION_ALLOWED_WINDOWS: &[&str] = &["settings"];

#[cfg(test)]
fn is_tts_cache_mutation_allowed(caller: &str) -> bool {
    command_auth::label_in(caller, TTS_CACHE_MUTATION_ALLOWED_WINDOWS)
}

/// `tts_delete_model` — delete a model's cached files from disk.
#[tauri::command]
#[specta::specta]
pub fn tts_delete_model(
    dl: State<'_, Arc<TtsDownloadManager>>,
    webview: tauri::WebviewWindow,
    model_id: String,
    _quantization: String,
) -> Result<(), String> {
    command_auth::authorize_webview(
        &webview,
        "tts",
        "delete TTS cache",
        TTS_CACHE_MUTATION_ALLOWED_WINDOWS,
        " through TTS model cache",
    )?;
    dl.delete(&model_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_tts_cache_mutation_allowed;

    #[test]
    fn tts_cache_mutation_authorization_matches_settings_only_policy() {
        crate::command_auth::assert_label_rules(
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
            is_tts_cache_mutation_allowed,
        );
    }
}
