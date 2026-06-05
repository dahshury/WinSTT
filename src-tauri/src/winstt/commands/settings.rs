// PORT IMPL — WU-0 settings persistence + apply. Source: frontend/electron/ipc/settings.ts
// (the behavioral truth), frontend/electron/lib/store.ts + secret-storage.ts. Wraps
// winstt::settings_schema (the ~150-field nested WinsttSettings tree).
//
// winstt_get_settings / winstt_set_settings expose the full nested WinsttSettings tree
// to the reused React renderer over tauri-specta. They are NOT thin getters/setters:
//
//   * winstt_get_settings → reads the persisted store, opens the three secret fields
//     for backend use, then masks those fields before returning the full nested tree
//     to the renderer (defaulting cleanly on a missing / partial blob).
//
//   * winstt_set_settings → merges the PARTIAL section patch the renderer posts over
//     the persisted snapshot (so a `{ audio: ... }` calibration save can't wipe
//     `model`/`general`), preserves the main-owned `onboarded*` fields, SEALS the
//     secret fields at rest (`enc:v1:` envelope), persists, applies owned runtime
//     side-effects in-process, and broadcasts the post-save renderer-safe snapshot
//     via `settings:changed`.
//
// Hot-swap side-effects that are owned by this Rust port (model unload timeout,
// same-model load-input changes, TTS warmups, LLM unload policy, wakeword runtime,
// and WinSTT-tree hotkeys) are applied here. Renderer-owned side-effects still fan
// out through the reused sync layer.
//
// Persistence rides Handy's existing tauri-plugin-store. WinSTT settings live under a
// dedicated `winstt_settings` key in `winstt-settings.json` (separate from Handy's
// `settings`) so the two schemas don't collide.
//
// Runtime invariant: settings saves in this port must not emit manual restart events.
// Former restart-only settings are live-read or applied through targeted in-process
// reload/arm/disarm paths.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_store::StoreExt;

use crate::winstt::commands::secret_storage::{try_decrypt_secret, try_encrypt_secret};
use crate::winstt::settings_schema::{
    is_secret, AudioSettings, DictionaryEntry, GeneralSettings, GlobalSettings, HotkeySettings,
    IntegrationsSettings, LiveTranscriptionDisplay, LlmProvider, LlmSettings, ModelSettings,
    ModelUnloadTimeout as WinsttModelUnloadTimeout, PresetEntry, PresetKey, QualitySettings,
    RecordingMode, SnippetEntry, TtsSettings, TtsSource, WinsttSettings, SECRET_KEYS,
};

pub const WINSTT_SETTINGS_KEY: &str = "winstt_settings";
pub(crate) const WINSTT_SETTINGS_FILE: &str = "winstt-settings.json";
pub(crate) const SECRET_PRESENT_SENTINEL: &str = "__WINSTT_SECRET_PRESENT__";

/// The `settings:changed` plain event — the post-save full masked snapshot every other
/// window re-hydrates its Zustand store from. Byte-identical to WinSTT's the reference
/// IPC shape (`{ settings }`) so the reused renderer's `onSettingsChanged`
/// listener (ipc-client.ts) needs no changes.
pub(crate) const SETTINGS_CHANGED_EVENT: &str = "settings:changed";

/// The `settings:save-error` plain event — emitted on validation/persist failure
/// (the renderer's save path is fire-and-forget, so it can't see the `Result`).
/// Shape `{ error }` matches `onSettingsSaveError` in ipc-client.ts.
const SETTINGS_SAVE_ERROR_EVENT: &str = "settings:save-error";

/// Result of `winstt_set_settings`: whether the change requires an engine
/// restart, and which dot-paths drove that decision. Kept for renderer wire
/// compatibility; the Rust port applies these changes in-process.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetSettingsResult {
    pub needs_restart: bool,
    pub changed_startup_keys: Vec<String>,
}

/// The partial section patch the renderer posts to `winstt_set_settings`.
///
/// The renderer (`collectChangedSections` in `features/update-settings`) diffs
/// against its last-saved baseline and sends only the changed top-level sections
/// (e.g. VAD calibration and device-switch-feedback post just `{ audio }` after
/// every utterance). Every field is `Option` so an absent section deserializes
/// to `None` (= "leave the persisted value untouched") rather than resetting to a
/// default — the clobber the old full-`WinsttSettings` parameter caused.
///
/// Sections are always posted whole (the renderer copies the entire section
/// value), so an `Option<Section>` round-trips losslessly.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PartialWinsttSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global: Option<GlobalSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<QualitySettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub general: Option<GeneralSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotkey: Option<HotkeySettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dictionary: Option<Vec<DictionaryEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippets: Option<Vec<SnippetEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm: Option<LlmSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts: Option<TtsSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrations: Option<IntegrationsSettings>,
}

fn store_path() -> std::path::PathBuf {
    crate::portable::store_path(WINSTT_SETTINGS_FILE)
}

/// Read the persisted WinSTT settings with secrets OPENED to plaintext.
///
/// This is the single read path every consumer uses (managers for LLM / cloud-STT /
/// verify read API keys straight off the returned struct). Renderer-facing commands
/// must call `sanitize_settings_for_renderer` before returning or emitting this tree.
/// The on-disk store holds the sealed `enc:v1:` envelopes; legacy plaintext (no
/// prefix) passes through unchanged.
///
/// Defaults cleanly on a missing / partial blob — every field is `#[serde(default)]`,
/// mirroring Zod `.catch`.
pub fn read_settings(app: &AppHandle) -> WinsttSettings {
    match try_read_settings_raw(app) {
        Ok(mut settings) => {
            if let Err(err) = try_open_secrets(&mut settings) {
                log::warn!("[settings] failed to open WinSTT settings secrets: {err}");
            }
            settings
        }
        Err(err) => {
            log::warn!("[settings] failed to read WinSTT settings: {err}");
            WinsttSettings::default()
        }
    }
}

fn try_read_settings(app: &AppHandle) -> Result<WinsttSettings, String> {
    let mut settings = try_read_settings_raw(app)?;
    try_open_secrets(&mut settings)?;
    Ok(settings)
}

/// Read the persisted settings WITHOUT opening secrets (the on-disk form, where the
/// three secret fields are still sealed envelopes). Originally the save path's
/// old→new diff helper (so sealed secret fields compare like-for-like rather than
/// triggering a spurious "changed" on every save, mirroring `snapshotSettings`), it
/// is now ALSO the secret-agnostic reader for the hot recording/realtime loops
/// (`realtime_manager`, `recording_mode`) — those must NOT trigger per-tick secret
/// decryption (reg.exe spawns), so they read raw. Hence `pub(crate)`.
pub(crate) fn read_settings_raw(app: &AppHandle) -> WinsttSettings {
    match try_read_settings_raw(app) {
        Ok(settings) => settings,
        Err(err) => {
            log::warn!("[settings] failed to read raw WinSTT settings: {err}");
            WinsttSettings::default()
        }
    }
}

fn try_read_settings_raw(app: &AppHandle) -> Result<WinsttSettings, String> {
    let store = app
        .store(store_path())
        .map_err(|err| format!("winstt settings store: {err}"))?;
    match store.get(WINSTT_SETTINGS_KEY) {
        Some(value) => parse_settings_value(value),
        None => Ok(WinsttSettings::default()),
    }
}

fn parse_settings_value(value: serde_json::Value) -> Result<WinsttSettings, String> {
    let mut settings: WinsttSettings = serde_json::from_value(value)
        .map_err(|err| format!("invalid persisted WinSTT settings: {err}"))?;
    normalize_cross_field_settings(&mut settings);
    Ok(settings)
}

fn word_by_word_pasting_effective(settings: &WinsttSettings) -> bool {
    settings.general.word_by_word_pasting
}

fn normalize_cross_field_settings(settings: &mut WinsttSettings) {
    if settings.general.word_by_word_pasting {
        settings.general.preview_before_pasting = false;
        settings.llm.dictation.enabled = false;
    }
}

/// The current recording mode, read cheaply from the in-memory settings store (NO secret
/// decryption). Used on the hotkey thread to decide whether to dispatch the recorder in-process
/// (PTT) vs leaving it renderer/server-driven — so the press path stays fast.
pub fn recording_mode(app: &AppHandle) -> RecordingMode {
    read_settings_raw(app).general.recording_mode
}

/// Open (decrypt) the three secret fields on a settings tree in place. Idempotent
/// on already-plaintext values (legacy passthrough).
fn try_open_secrets(settings: &mut WinsttSettings) -> Result<(), String> {
    settings.llm.openrouter_api_key = try_decrypt_secret(&settings.llm.openrouter_api_key)?;
    settings.integrations.openai.api_key =
        try_decrypt_secret(&settings.integrations.openai.api_key)?;
    settings.integrations.elevenlabs.api_key =
        try_decrypt_secret(&settings.integrations.elevenlabs.api_key)?;
    Ok(())
}

/// Seal (encrypt) the three secret fields on a settings tree in place, ready for
/// the store. A value that is already a sealed envelope (the renderer echoed it
/// back without touching it — it can't, the IPC path always sends plaintext, but
/// the guard keeps this total) is left as-is via `encrypt_secret`'s idempotence.
fn try_seal_secrets(settings: &mut WinsttSettings) -> Result<(), String> {
    settings.llm.openrouter_api_key = try_encrypt_secret(&settings.llm.openrouter_api_key)?;
    settings.integrations.openai.api_key =
        try_encrypt_secret(&settings.integrations.openai.api_key)?;
    settings.integrations.elevenlabs.api_key =
        try_encrypt_secret(&settings.integrations.elevenlabs.api_key)?;
    Ok(())
}

fn mask_secret_for_renderer(value: &mut String) {
    if !value.is_empty() {
        *value = SECRET_PRESENT_SENTINEL.to_string();
    }
}

fn sanitize_settings_for_renderer(settings: &mut WinsttSettings) {
    mask_secret_for_renderer(&mut settings.llm.openrouter_api_key);
    mask_secret_for_renderer(&mut settings.integrations.openai.api_key);
    mask_secret_for_renderer(&mut settings.integrations.elevenlabs.api_key);
}

fn preserve_masked_secret(previous: &str, next: &mut String) {
    if next == SECRET_PRESENT_SENTINEL {
        *next = previous.to_string();
    }
}

fn preserve_masked_secrets(previous: &WinsttSettings, next: &mut WinsttSettings) {
    preserve_masked_secret(
        &previous.llm.openrouter_api_key,
        &mut next.llm.openrouter_api_key,
    );
    preserve_masked_secret(
        &previous.integrations.openai.api_key,
        &mut next.integrations.openai.api_key,
    );
    preserve_masked_secret(
        &previous.integrations.elevenlabs.api_key,
        &mut next.integrations.elevenlabs.api_key,
    );
}

/// Persist a full settings tree (with secrets ALREADY sealed) to the store and flush.
fn write_settings_value(app: &AppHandle, settings: &WinsttSettings) -> Result<(), String> {
    let store = app
        .store(store_path())
        .map_err(|e| format!("winstt settings store: {e}"))?;
    let value = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    store.set(WINSTT_SETTINGS_KEY, value);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// Seed the default settings tree on first run so the store file exists and a cold
/// renderer boots against a complete tree (matching the reference's persisted store, which
/// writes the schema defaults on creation). Idempotent: if the `winstt_settings` key
/// is already present we leave it untouched. Called once from lib.rs setup.
pub fn seed_defaults(app: &AppHandle) {
    let Ok(store) = app.store(store_path()) else {
        return;
    };
    if store.get(WINSTT_SETTINGS_KEY).is_some() {
        return; // already seeded — never clobber a real store.
    }
    // Defaults have empty secret fields, so sealing is a no-op (empty → empty);
    // write the canonical default tree so the file materializes.
    let defaults = WinsttSettings::default();
    if let Ok(value) = serde_json::to_value(&defaults) {
        store.set(WINSTT_SETTINGS_KEY, value);
        let _ = store.save();
    }
}

/// `winstt_get_settings` — the full tree the renderer boots against, with
/// secret fields masked so renderer code can know a key exists without reading
/// the key material.
#[tauri::command]
#[specta::specta]
pub fn winstt_get_settings(app: AppHandle) -> WinsttSettings {
    let mut settings = read_settings(&app);
    sanitize_settings_for_renderer(&mut settings);
    settings
}

/// `winstt_set_settings` merges a PARTIAL section patch, validates, seals
/// secrets, persists, applies runtime side-effects, and broadcasts.
///
/// The renderer sends **partial** top-level sections, not the whole tree
/// (`collectChangedSections`), so we accept a `PartialWinsttSettings` (every section
/// `Option`) and merge each present section over the persisted snapshot — exactly
/// the reference's per-section `applySettings`.
///
/// On any failure the renderer's fire-and-forget save can't observe the `Err`, so we
/// ALSO emit `settings:save-error { error }` (and still return `Err`).
#[tauri::command]
#[specta::specta]
pub fn winstt_set_settings(
    app: AppHandle,
    settings: PartialWinsttSettings,
) -> Result<SetSettingsResult, String> {
    match apply_settings_patch(&app, settings) {
        Ok(result) => Ok(result),
        Err(error) => {
            // Mirror the reference's `event.sender.send("settings:save-error", { error })`.
            let _ = app.emit(
                SETTINGS_SAVE_ERROR_EVENT,
                serde_json::json!({ "error": error }),
            );
            Err(error)
        }
    }
}

/// The set-settings body, factored out so the error branch in `winstt_set_settings`
/// can emit `settings:save-error` once for any failure (validation, merge, persist).
pub fn apply_settings_patch(
    app: &AppHandle,
    patch: PartialWinsttSettings,
) -> Result<SetSettingsResult, String> {
    // `previous` here is the PLAINTEXT view (secrets opened). The renderer's patch is
    // plaintext too, so the merge + diff operate entirely in plaintext — like
    // the reference's `snapshotSettings`, which decrypts before diffing.
    let previous = try_read_settings(app)?;

    // Merge the partial patch over the persisted full snapshot, section by section
    // (matching `applySettings` / `mergeMainOwnedFields`). Each present section
    // overwrites its counterpart wholesale; absent sections keep the persisted value;
    // `general` preserves the main-owned `onboarded*` fields.
    let mut next = merge_patch_over(&previous, patch);
    preserve_masked_secrets(&previous, &mut next);

    // (a) cross-field validation (the Zod `.refine` equivalents).
    validate_settings(&next)?;

    // (b) restart-need result for wire compatibility. The Rust port hot-applies
    //     model, wakeword, and realtime changes in-process.
    let changed_startup = compute_restart_keys(&previous, &next);
    let needs_restart = !changed_startup.is_empty();

    // (c) seal the secret fields at rest, then persist. Clone so runtime
    //     side-effects keep the plaintext `next`; only the on-disk copy is
    //     sealed and the renderer broadcast is masked below.
    let mut to_persist = next.clone();
    try_seal_secrets(&mut to_persist)?;
    debug_assert!(SECRET_KEYS.iter().all(|k| is_secret(k)));
    write_settings_value(app, &to_persist)?;
    if previous.general.recording_mode != next.general.recording_mode
        || previous.general.wake_word != next.general.wake_word
    {
        log::info!(
            "[settings] saved recordingMode={:?} wakeWord='{}'",
            next.general.recording_mode,
            next.general.wake_word
        );
    }

    // (c.1) HOT-SWAP the WinSTT-tree global hotkeys (transforms / TTS read-aloud /
    //       re-paste) when their accelerator OR enable flag changed. These are armed
    //       from the WinSTT settings tree (not AppSettings.bindings), so a plain save
    //       must re-reconcile them — otherwise enabling/rebinding them in Settings did
    //       nothing until relaunch (the reported "hotkey doesn't work" bug). The PTT
    //       hotkey is NOT touched here (the renderer rebinds it via hotkey_register).
    if winstt_hotkeys_changed(&previous, &next) {
        crate::shortcut::reconcile_winstt_hotkeys(app);
    }
    apply_model_runtime_settings(app, &previous, &next);
    apply_tts_runtime_settings(app, &previous, &next);
    apply_llm_runtime_settings(app, &previous, &next);
    apply_wakeword_runtime_settings(app, &previous, &next);
    apply_history_retention_settings(app, &previous, &next);
    apply_audio_runtime_settings(app, &previous, &next);
    apply_autostart_setting(app, &previous, &next);
    crate::tray::set_tray_visualizer_style_from_general(&next.general);

    // (d) broadcast the post-save full snapshot (not the raw partial) so every
    //     other window re-hydrates the same canonical view. Secret fields are
    //     masked before crossing IPC; a later save that echoes the sentinel
    //     preserves the stored secret, while an empty string still clears it.
    let mut renderer_next = next.clone();
    sanitize_settings_for_renderer(&mut renderer_next);
    let snapshot = serde_json::to_value(&renderer_next).map_err(|e| e.to_string())?;
    let _ = app.emit(
        SETTINGS_CHANGED_EVENT,
        serde_json::json!({ "settings": snapshot }),
    );

    Ok(SetSettingsResult {
        needs_restart,
        changed_startup_keys: changed_startup,
    })
}

pub(crate) fn core_timeout_from_winstt(
    timeout: WinsttModelUnloadTimeout,
) -> crate::settings::ModelUnloadTimeout {
    match timeout {
        WinsttModelUnloadTimeout::Immediately => crate::settings::ModelUnloadTimeout::Immediately,
        WinsttModelUnloadTimeout::Never => crate::settings::ModelUnloadTimeout::Never,
        WinsttModelUnloadTimeout::Min2 => crate::settings::ModelUnloadTimeout::Min2,
        WinsttModelUnloadTimeout::Min5 => crate::settings::ModelUnloadTimeout::Min5,
        WinsttModelUnloadTimeout::Min10 => crate::settings::ModelUnloadTimeout::Min10,
        WinsttModelUnloadTimeout::Min15 => crate::settings::ModelUnloadTimeout::Min15,
        WinsttModelUnloadTimeout::Hour1 => crate::settings::ModelUnloadTimeout::Hour1,
    }
}

pub(crate) fn should_keep_stt_model_warm(timeout: WinsttModelUnloadTimeout) -> bool {
    timeout != WinsttModelUnloadTimeout::Immediately
}

fn apply_model_runtime_settings(app: &AppHandle, previous: &WinsttSettings, next: &WinsttSettings) {
    sync_core_model_unload_timeout(app, next.global.model_unload_timeout);

    if same_model_load_inputs_changed(previous, next) {
        reload_stt_model_async(
            app,
            &next.model.model,
            should_keep_stt_model_warm(next.global.model_unload_timeout),
        );
    } else if model_warm_inputs_changed(previous, next)
        && should_keep_stt_model_warm(next.global.model_unload_timeout)
    {
        warm_stt_model_async(app);
    }
}

fn sync_core_model_unload_timeout(app: &AppHandle, timeout: WinsttModelUnloadTimeout) {
    let mapped = core_timeout_from_winstt(timeout);
    let mut settings = crate::settings::get_settings(app);
    if settings.model_unload_timeout == mapped {
        return;
    }
    settings.model_unload_timeout = mapped;
    crate::settings::write_settings(app, settings);
}

fn model_warm_inputs_changed(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    previous.global.model_unload_timeout != next.global.model_unload_timeout
}

fn same_model_load_inputs_changed(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    let model = next.model.model.trim();
    !model.is_empty()
        && previous.model.model == next.model.model
        && (previous.model.backend != next.model.backend
            || previous.model.device != next.model.device
            || previous.model.onnx_quantization != next.model.onnx_quantization)
}

fn reload_stt_model_async(app: &AppHandle, model: &str, keep_warm: bool) {
    let model = model.trim();
    if model.is_empty() {
        return;
    }
    if !keep_warm {
        unload_loaded_stt_model_async(app);
        return;
    }
    crate::winstt::commands::swap_events::perform_model_reload(app, "main", model);
}

fn unload_loaded_stt_model_async(app: &AppHandle) {
    let Some(transcription) =
        app.try_state::<Arc<crate::managers::transcription::TranscriptionManager>>()
    else {
        return;
    };
    if !transcription.inner().is_model_loaded() {
        return;
    }
    let tm = Arc::clone(transcription.inner());
    std::thread::spawn(move || {
        if let Err(err) = tm.unload_model() {
            log::warn!("[settings] failed to unload STT model after load-input change: {err}");
        }
    });
}

pub(crate) fn warm_stt_model_async(app: &AppHandle) {
    let Some(transcription) =
        app.try_state::<Arc<crate::managers::transcription::TranscriptionManager>>()
    else {
        return;
    };
    let tm = Arc::clone(transcription.inner());
    std::thread::spawn(move || {
        tm.initiate_model_load();
        tm.warmup();
    });
}

pub(crate) fn should_warm_tts(settings: &WinsttSettings) -> bool {
    settings.tts.enabled
        && matches!(settings.tts.source, TtsSource::Local)
        && should_keep_stt_model_warm(settings.global.model_unload_timeout)
}

fn apply_tts_runtime_settings(app: &AppHandle, previous: &WinsttSettings, next: &WinsttSettings) {
    if tts_warm_inputs_changed(previous, next) {
        warm_tts_async(app);
    }
}

fn tts_warm_inputs_changed(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    if !should_warm_tts(next) {
        return false;
    }
    !should_warm_tts(previous)
        || previous.tts.source != next.tts.source
        || previous.tts.model != next.tts.model
        || previous.model.device != next.model.device
}

pub(crate) fn warm_tts_async(app: &AppHandle) {
    let Some(tts) = app.try_state::<Arc<crate::winstt::managers::TtsManager>>() else {
        return;
    };
    let mgr = Arc::clone(tts.inner());
    std::thread::spawn(move || {
        if let Err(err) = mgr.warm_up() {
            log::debug!("[tts] warm-up skipped/failed: {err}");
        }
    });
}

fn apply_llm_runtime_settings(app: &AppHandle, previous: &WinsttSettings, next: &WinsttSettings) {
    if llm_warm_inputs_changed(previous, next) {
        warm_llm_models_async(app);
    }
}

fn apply_history_retention_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    if previous.general.history_max_entries == next.general.history_max_entries
        && previous.general.recording_retention == next.general.recording_retention
    {
        return;
    }
    let Some(history_manager) = app.try_state::<Arc<crate::managers::history::HistoryManager>>()
    else {
        return;
    };
    if let Err(err) = history_manager.cleanup_old_entries() {
        log::warn!("[settings] failed to apply history retention change: {err}");
    }
}

fn apply_audio_runtime_settings(app: &AppHandle, previous: &WinsttSettings, next: &WinsttSettings) {
    let microphone_release_changed =
        previous.audio.microphone_release != next.audio.microphone_release;
    let input_device_changed = previous.audio.input_device_index != next.audio.input_device_index
        || previous.audio.clamshell_microphone != next.audio.clamshell_microphone;
    if !microphone_release_changed && !input_device_changed {
        return;
    }

    let Some(audio_manager) = app.try_state::<Arc<crate::managers::audio::AudioRecordingManager>>()
    else {
        return;
    };

    if microphone_release_changed {
        let mode = crate::managers::audio::microphone_mode_from_settings(next);
        if let Err(err) = audio_manager.update_mode(mode) {
            log::warn!("[settings] failed to apply microphone release policy: {err}");
        }
    }

    if input_device_changed {
        if let Err(err) = audio_manager.update_selected_device() {
            log::warn!("[settings] failed to apply microphone device change: {err}");
        }
    }
}

fn apply_autostart_setting(app: &AppHandle, previous: &WinsttSettings, next: &WinsttSettings) {
    if previous.general.auto_start == next.general.auto_start {
        return;
    }
    let autostart = app.autolaunch();
    let result = if next.general.auto_start {
        autostart.enable()
    } else {
        autostart.disable()
    };
    if let Err(err) = result {
        log::warn!("[settings] failed to apply autostart setting: {err}");
    }
}

pub(crate) fn enabled_ollama_models(settings: &WinsttSettings) -> Vec<String> {
    if !should_keep_stt_model_warm(settings.global.model_unload_timeout) {
        return Vec::new();
    }

    fn push_feature(out: &mut Vec<String>, enabled: bool, provider: LlmProvider, model: &str) {
        let model = model.trim();
        if !enabled || provider != LlmProvider::Ollama || model.is_empty() {
            return;
        }
        if !out.iter().any(|existing| existing == model) {
            out.push(model.to_string());
        }
    }

    let mut out = Vec::new();
    push_feature(
        &mut out,
        settings.llm.dictation.enabled,
        settings.llm.dictation.base.provider,
        &settings.llm.dictation.base.model,
    );
    push_feature(
        &mut out,
        settings.llm.transforms.enabled,
        settings.llm.transforms.base.provider,
        &settings.llm.transforms.base.model,
    );
    out
}

fn llm_warm_inputs_changed(previous: &WinsttSettings, next: &WinsttSettings) -> bool {
    let previous_models = enabled_ollama_models(previous);
    let next_models = enabled_ollama_models(next);
    if previous_models.is_empty() && next_models.is_empty() {
        return false;
    }
    previous.llm.endpoint != next.llm.endpoint || previous_models != next_models
}

pub(crate) fn warm_llm_models_async(app: &AppHandle) {
    let Some(llm) = app.try_state::<Arc<crate::winstt::managers::LlmManager>>() else {
        return;
    };
    let mgr = Arc::clone(llm.inner());
    tauri::async_runtime::spawn(async move {
        mgr.warm_enabled_models().await;
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WakewordRuntimeTransition {
    Noop,
    Arm,
    Disarm,
    Refresh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WakewordArmReadiness {
    Ready,
    MissingModelBundle,
    DetectorUnavailable,
}

fn wakeword_arm_readiness(has_detector: bool, has_model_bundle: bool) -> WakewordArmReadiness {
    if has_detector {
        WakewordArmReadiness::Ready
    } else if !has_model_bundle {
        WakewordArmReadiness::MissingModelBundle
    } else {
        WakewordArmReadiness::DetectorUnavailable
    }
}

fn wakeword_runtime_transition(
    previous: Option<&WinsttSettings>,
    next: &WinsttSettings,
) -> WakewordRuntimeTransition {
    let next_is_wakeword = next.general.recording_mode == RecordingMode::Wakeword;
    let Some(previous) = previous else {
        return if next_is_wakeword {
            WakewordRuntimeTransition::Arm
        } else {
            WakewordRuntimeTransition::Noop
        };
    };

    let previous_is_wakeword = previous.general.recording_mode == RecordingMode::Wakeword;
    match (previous_is_wakeword, next_is_wakeword) {
        (false, true) => WakewordRuntimeTransition::Arm,
        (true, false) => WakewordRuntimeTransition::Disarm,
        (true, true)
            if wake_config_changed_while_in_wakeword(
                previous.general.recording_mode,
                next.general.recording_mode,
                previous,
                next,
            ) =>
        {
            WakewordRuntimeTransition::Refresh
        }
        _ => WakewordRuntimeTransition::Noop,
    }
}

fn apply_wakeword_runtime_settings(
    app: &AppHandle,
    previous: &WinsttSettings,
    next: &WinsttSettings,
) {
    apply_wakeword_runtime_transition(app, wakeword_runtime_transition(Some(previous), next), next);
}

pub(crate) fn sync_wakeword_runtime_from_settings(app: &AppHandle) {
    let settings = read_settings_raw(app);
    apply_wakeword_runtime_transition(app, wakeword_runtime_transition(None, &settings), &settings);
}

pub(crate) fn sync_wakeword_runtime_from_settings_in_background(app: &AppHandle) {
    let app = app.clone();
    if let Err(err) = std::thread::Builder::new()
        .name("winstt-wakeword-startup-arm".to_string())
        .spawn(move || sync_wakeword_runtime_from_settings(&app))
    {
        log::warn!("[wakeword] failed to start startup arm thread: {err}");
    }
}

pub(crate) fn rearm_wakeword_runtime_if_active(app: &AppHandle) {
    let settings = read_settings_raw(app);
    if settings.general.recording_mode == RecordingMode::Wakeword {
        apply_wakeword_runtime_transition(app, WakewordRuntimeTransition::Arm, &settings);
    }
}

fn apply_wakeword_runtime_transition(
    app: &AppHandle,
    transition: WakewordRuntimeTransition,
    settings: &WinsttSettings,
) {
    match transition {
        WakewordRuntimeTransition::Noop => {}
        WakewordRuntimeTransition::Arm | WakewordRuntimeTransition::Refresh => {
            arm_wakeword_runtime(app, settings);
        }
        WakewordRuntimeTransition::Disarm => {
            disarm_wakeword_runtime(app);
        }
    }
}

fn arm_wakeword_runtime(app: &AppHandle, settings: &WinsttSettings) {
    let Some(wakeword) = app.try_state::<Arc<crate::winstt::managers::WakeWordManager>>() else {
        log::warn!("[wakeword] cannot arm: WakeWordManager is not managed");
        return;
    };
    let Some(audio) = app.try_state::<Arc<crate::managers::audio::AudioRecordingManager>>() else {
        log::warn!("[wakeword] cannot arm: AudioRecordingManager is not managed");
        wakeword.set_armed(false);
        return;
    };
    if audio.is_recording() {
        wakeword.set_armed(false);
        log::debug!("[wakeword] delaying arm until the active recording finishes");
        return;
    }

    if let Err(err) = wakeword.set_wake_word(
        &settings.general.wake_word,
        settings.general.wake_word_sensitivity as f32,
        settings.general.wake_word_timeout as f32,
    ) {
        log::warn!("[wakeword] failed to configure detector: {err}");
        wakeword.set_armed(false);
        return;
    }

    match wakeword_arm_readiness(wakeword.has_detector(), wakeword.has_model_bundle()) {
        WakewordArmReadiness::Ready => {}
        WakewordArmReadiness::MissingModelBundle => {
            wakeword.set_armed(false);
            if wakeword.start_model_bundle_download_if_missing() {
                log::info!(
                    "[wakeword] KWS model bundle missing; download started before microphone arm"
                );
            } else if wakeword.model_bundle_download_inflight() {
                log::debug!(
                    "[wakeword] KWS model bundle download already in progress; delaying arm"
                );
            } else {
                log::debug!(
                    "[wakeword] KWS model bundle is still unavailable; delaying microphone arm"
                );
            }
            return;
        }
        WakewordArmReadiness::DetectorUnavailable => {
            wakeword.set_armed(false);
            log::warn!(
                "[wakeword] detector unavailable for '{}' even though the KWS model bundle exists",
                settings.general.wake_word
            );
            return;
        }
    }

    if let Err(err) = audio.inner().ensure_wakeword_listening_stream() {
        let detail = err.to_string();
        log::warn!("[wakeword] failed to open microphone stream: {detail}");
        wakeword.set_armed(false);
        emit_recording_error(app, &detail);
        return;
    }

    wakeword.set_armed(true);
    let _ = app.emit("stt:wakeword-detection-start", ());
    log::info!(
        "[wakeword] listening for '{}' via live microphone stream",
        wakeword.current_phrase()
    );
}

fn disarm_wakeword_runtime(app: &AppHandle) {
    let mut stopped = false;
    if let Some(wakeword) = app.try_state::<Arc<crate::winstt::managers::WakeWordManager>>() {
        stopped |= wakeword.set_armed(false);
    }
    if let Some(audio) = app.try_state::<Arc<crate::managers::audio::AudioRecordingManager>>() {
        audio.inner().stop_wakeword_listening_stream_if_idle();
    }
    if stopped {
        let _ = app.emit("stt:wakeword-detection-end", ());
        log::info!("[wakeword] detection stopped");
    }
}

fn emit_recording_error(app: &AppHandle, detail: &str) {
    let error_type = if crate::audio_toolkit::is_microphone_access_denied(detail) {
        "microphone_permission_denied"
    } else if crate::audio_toolkit::is_no_input_device_error(detail) {
        "no_input_device"
    } else {
        "unknown"
    };
    let _ = app.emit(
        "recording-error",
        serde_json::json!({
            "error_type": error_type,
            "detail": detail,
        }),
    );
}

/// Compute the ordered set of restart-forcing dot-paths between two plaintext trees.
///
/// The Rust port hot-applies model, wakeword, and realtime changes in-process, so
/// no current user-editable WinSTT setting should request a relaunch.
/// Current Tauri behavior: always return no restart keys; runtime side-effects are
/// applied by the targeted handlers above.
fn compute_restart_keys(_prev: &WinsttSettings, _next: &WinsttSettings) -> Vec<String> {
    Vec::new()
}

/// Did any WinSTT-tree global hotkey's accelerator OR enable flag change between two
/// snapshots? Used to trigger `reconcile_winstt_hotkeys` on save. Covers the
/// transforms hotkey + enable, the TTS read-aloud hotkey + enable, and the re-paste
/// hotkey (no enable flag). The PTT hotkey is intentionally excluded — the renderer
/// owns its registration via `hotkey_register`.
fn winstt_hotkeys_changed(prev: &WinsttSettings, next: &WinsttSettings) -> bool {
    prev.llm.transforms.hotkey != next.llm.transforms.hotkey
        || prev.llm.transforms.enabled != next.llm.transforms.enabled
        || prev.tts.hotkey != next.tts.hotkey
        || prev.tts.enabled != next.tts.enabled
        || prev.general.repaste_hotkey != next.general.repaste_hotkey
}

/// Any of the wakeword CLI params (`wakeWord` / `wakeWordSensitivity` /
/// `wakeWordTimeout`) changed while staying in wakeword mode — the detector is built
/// once from these at bootstrap, so a change needs a rebuild.
fn wake_config_changed_while_in_wakeword(
    old_mode: RecordingMode,
    new_mode: RecordingMode,
    prev: &WinsttSettings,
    next: &WinsttSettings,
) -> bool {
    if old_mode != RecordingMode::Wakeword || new_mode != RecordingMode::Wakeword {
        return false;
    }
    prev.general.wake_word != next.general.wake_word
        || prev.general.wake_word_sensitivity != next.general.wake_word_sensitivity
        || prev.general.wake_word_timeout != next.general.wake_word_timeout
}

/// `isRealtimeEnabled({ showRecordingOverlay, liveTranscriptionDisplay, wordByWordPasting })`
/// ported from shared/lib/realtime-enabled.ts. The pill path ("in-pill"/"both") gates on
/// the overlay being shown; in-app/both always render. Word-by-word paste also needs the
/// realtime worker even when the visual preview is off.
///
/// Public so the realtime worker (winstt::managers::realtime_manager) gates its decode
/// loop on the SAME source of truth instead of duplicating the branch logic.
pub fn effective_realtime(settings: &WinsttSettings) -> bool {
    if word_by_word_pasting_effective(settings) {
        return true;
    }

    let overlay = settings.general.show_recording_overlay;
    match settings.general.live_transcription_display {
        LiveTranscriptionDisplay::None => false,
        LiveTranscriptionDisplay::InApp | LiveTranscriptionDisplay::Both => true,
        LiveTranscriptionDisplay::InPill => overlay,
    }
}

/// Merge a partial section patch over the current full tree. Each `Some(section)`
/// OVERWRITES wholesale; a `None` section keeps the persisted value. For `general`,
/// the main-owned `onboarded*` fields are restored from the persisted copy so a
/// renderer round-trip can't revert them. Mirrors the reference's `applySettings`.
fn merge_patch_over(current: &WinsttSettings, patch: PartialWinsttSettings) -> WinsttSettings {
    let mut next = current.clone();
    if let Some(global) = patch.global {
        next.global = global;
    }
    if let Some(model) = patch.model {
        next.model = model;
    }
    if let Some(quality) = patch.quality {
        next.quality = quality;
    }
    if let Some(audio) = patch.audio {
        next.audio = audio;
    }
    if let Some(general) = patch.general {
        next.general = preserve_main_owned_general(&current.general, general);
    }
    if let Some(hotkey) = patch.hotkey {
        next.hotkey = hotkey;
    }
    if let Some(dictionary) = patch.dictionary {
        next.dictionary = dictionary;
    }
    if let Some(snippets) = patch.snippets {
        next.snippets = snippets;
    }
    if let Some(llm) = patch.llm {
        next.llm = llm;
    }
    if let Some(tts) = patch.tts {
        next.tts = tts;
    }
    if let Some(integrations) = patch.integrations {
        next.integrations = integrations;
    }
    normalize_cross_field_settings(&mut next);
    next
}

/// Re-merge the main-owned `onboarded*` fields from the on-disk `general` section
/// into the incoming `general` patch so a renderer save can't clobber them. Mirrors
/// `mergeMainOwnedFields`.
fn preserve_main_owned_general(
    existing: &GeneralSettings,
    mut incoming: GeneralSettings,
) -> GeneralSettings {
    incoming.onboarded = existing.onboarded;
    incoming.onboarded_at = existing.onboarded_at;
    incoming.onboarded_track = existing.onboarded_track;
    if incoming.word_by_word_pasting {
        incoming.preview_before_pasting = false;
    }
    incoming
}

/// Re-run the Zod cross-field rules: no duplicate preset keys, at most one tone key,
/// `level` only for summarize/concise, `targetLang` only for translate.
fn validate_settings(settings: &WinsttSettings) -> Result<(), String> {
    validate_presets(&settings.llm.dictation.presets)?;
    crate::winstt::llm::validate_loopback_ollama_endpoint(&settings.llm.endpoint)?;
    Ok(())
}

fn validate_presets(presets: &[PresetEntry]) -> Result<(), String> {
    use std::collections::HashSet;

    let mut seen: HashSet<&'static str> = HashSet::new();
    let mut tone_count = 0;
    for p in presets {
        let key = p.key;
        let slug = preset_slug(key);
        if !seen.insert(slug) {
            return Err(format!("duplicate preset: {slug}"));
        }
        if is_tone_preset(key) {
            tone_count += 1;
            if tone_count > 1 {
                return Err("at most one tone preset is allowed".into());
            }
        }
        if p.level.is_some() && !is_leveled_preset(key) {
            return Err(format!("preset {slug} does not accept a level"));
        }
        if p.target_lang.is_some() && key != PresetKey::Translate {
            return Err(format!("preset {slug} does not accept a target language"));
        }
    }
    Ok(())
}

fn preset_slug(key: PresetKey) -> &'static str {
    match key {
        PresetKey::Neutral => "neutral",
        PresetKey::Formal => "formal",
        PresetKey::Friendly => "friendly",
        PresetKey::Technical => "technical",
        PresetKey::Concise => "concise",
        PresetKey::Summarize => "summarize",
        PresetKey::Reorder => "reorder",
        PresetKey::Restructure => "restructure",
        PresetKey::RewordForClarity => "rewordForClarity",
        PresetKey::Translate => "translate",
    }
}

fn is_tone_preset(key: PresetKey) -> bool {
    matches!(
        key,
        PresetKey::Neutral | PresetKey::Formal | PresetKey::Friendly | PresetKey::Technical
    )
}

fn is_leveled_preset(key: PresetKey) -> bool {
    matches!(key, PresetKey::Concise | PresetKey::Summarize)
}

#[cfg(test)]
mod tests {
    // `super::*` already brings in PresetKey / PresetEntry / RecordingMode /
    // LiveTranscriptionDisplay / WinsttSettings (imported at module top).
    use super::*;
    #[cfg(target_os = "windows")]
    use crate::winstt::commands::secret_storage::is_encrypted;

    fn p(key: PresetKey) -> PresetEntry {
        PresetEntry {
            key,
            level: None,
            target_lang: None,
        }
    }

    #[test]
    fn rejects_duplicate_presets() {
        let presets = vec![p(PresetKey::Formal), p(PresetKey::Formal)];
        assert!(validate_presets(&presets).is_err());
    }

    #[test]
    fn rejects_two_tones() {
        let presets = vec![p(PresetKey::Formal), p(PresetKey::Friendly)];
        assert!(validate_presets(&presets).is_err());
    }

    #[test]
    fn rejects_level_on_non_leveled() {
        let presets = vec![PresetEntry {
            key: PresetKey::Formal,
            level: Some(crate::winstt::settings_schema::PresetLevel::High),
            target_lang: None,
        }];
        assert!(validate_presets(&presets).is_err());
    }

    #[test]
    fn rejects_target_lang_on_non_translate() {
        let presets = vec![PresetEntry {
            key: PresetKey::Formal,
            level: None,
            target_lang: Some("French".into()),
        }];
        assert!(validate_presets(&presets).is_err());
    }

    #[test]
    fn accepts_valid_combo() {
        let presets = vec![
            p(PresetKey::Neutral),
            PresetEntry {
                key: PresetKey::Concise,
                level: Some(crate::winstt::settings_schema::PresetLevel::Medium),
                target_lang: None,
            },
            PresetEntry {
                key: PresetKey::Translate,
                level: None,
                target_lang: Some("Spanish".into()),
            },
        ];
        assert!(validate_presets(&presets).is_ok());
    }

    // ── restart-need: the reference parity ──────────────────────────────────────────

    #[test]
    fn former_startup_only_key_change_does_not_force_restart() {
        let mut a = WinsttSettings::default();
        let mut b = WinsttSettings::default();
        b.model.device = crate::winstt::settings_schema::DeviceType::Cpu;
        assert!(compute_restart_keys(&a, &b).is_empty());
        b.quality.use_main_model_for_realtime = true;
        b.quality.realtime_processing_pause = 0.05;
        b.quality.init_realtime_after_seconds = 0.5;
        b.quality.early_transcription_on_silence = 0.4;
        b.general.send_crash_reports = false;
        assert!(compute_restart_keys(&a, &b).is_empty());
        // and the reverse direction (cpu→auto) also restarts.
        std::mem::swap(&mut a, &mut b);
        assert!(compute_restart_keys(&a, &b).is_empty());
    }

    #[test]
    fn ptt_toggle_swap_does_not_restart() {
        // The load-bearing CONDITIONAL: a plain ptt↔toggle change must NOT restart
        // (it touches no CLI flag) — the reference's `modeCrossesWakeword` is false.
        let mut a = WinsttSettings::default();
        a.general.recording_mode = RecordingMode::Ptt;
        let mut b = a.clone();
        b.general.recording_mode = RecordingMode::Toggle;
        assert!(compute_restart_keys(&a, &b).is_empty());
    }

    #[test]
    fn entering_wakeword_does_not_force_restart() {
        let mut a = WinsttSettings::default();
        a.general.recording_mode = RecordingMode::Ptt;
        let mut b = a.clone();
        b.general.recording_mode = RecordingMode::Wakeword;
        assert!(compute_restart_keys(&a, &b).is_empty());
    }

    #[test]
    fn leaving_wakeword_does_not_force_restart() {
        let mut a = WinsttSettings::default();
        a.general.recording_mode = RecordingMode::Wakeword;
        let mut b = a.clone();
        b.general.recording_mode = RecordingMode::Listen;
        assert!(compute_restart_keys(&a, &b).is_empty());
    }

    #[test]
    fn wake_word_change_while_in_wakeword_does_not_force_restart() {
        let mut a = WinsttSettings::default();
        a.general.recording_mode = RecordingMode::Wakeword;
        a.general.wake_word = "alexa".into();
        let mut b = a.clone();
        b.general.wake_word = "computer".into();
        assert!(compute_restart_keys(&a, &b).is_empty());
    }

    #[test]
    fn wake_word_change_outside_wakeword_does_not_restart() {
        // Changing the configured wake word while in PTT (not armed) touches no
        // live detector → no restart. the reference `staysInWakeword` is false.
        let mut a = WinsttSettings::default();
        a.general.recording_mode = RecordingMode::Ptt;
        a.general.wake_word = "alexa".into();
        let mut b = a.clone();
        b.general.wake_word = "computer".into();
        assert!(compute_restart_keys(&a, &b).is_empty());
    }

    #[test]
    fn wakeword_runtime_arms_on_startup_when_persisted_mode_is_wakeword() {
        let mut next = WinsttSettings::default();
        next.general.recording_mode = RecordingMode::Wakeword;

        assert_eq!(
            wakeword_runtime_transition(None, &next),
            WakewordRuntimeTransition::Arm
        );
    }

    #[test]
    fn wakeword_runtime_arms_when_entering_wakeword() {
        let mut prev = WinsttSettings::default();
        prev.general.recording_mode = RecordingMode::Ptt;
        let mut next = prev.clone();
        next.general.recording_mode = RecordingMode::Wakeword;

        assert_eq!(
            wakeword_runtime_transition(Some(&prev), &next),
            WakewordRuntimeTransition::Arm
        );
    }

    #[test]
    fn wakeword_runtime_disarms_when_leaving_wakeword() {
        let mut prev = WinsttSettings::default();
        prev.general.recording_mode = RecordingMode::Wakeword;
        let mut next = prev.clone();
        next.general.recording_mode = RecordingMode::Ptt;

        assert_eq!(
            wakeword_runtime_transition(Some(&prev), &next),
            WakewordRuntimeTransition::Disarm
        );
    }

    #[test]
    fn wakeword_runtime_refreshes_config_while_staying_in_wakeword() {
        let mut prev = WinsttSettings::default();
        prev.general.recording_mode = RecordingMode::Wakeword;
        prev.general.wake_word = "alexa".into();
        let mut next = prev.clone();
        next.general.wake_word = "computer".into();

        assert_eq!(
            wakeword_runtime_transition(Some(&prev), &next),
            WakewordRuntimeTransition::Refresh
        );
    }

    #[test]
    fn wakeword_runtime_noops_for_non_wakeword_mode_changes() {
        let mut prev = WinsttSettings::default();
        prev.general.recording_mode = RecordingMode::Ptt;
        let mut next = prev.clone();
        next.general.recording_mode = RecordingMode::Toggle;

        assert_eq!(
            wakeword_runtime_transition(Some(&prev), &next),
            WakewordRuntimeTransition::Noop
        );
    }

    #[test]
    fn wakeword_arm_readiness_requires_detector_before_microphone() {
        assert_eq!(
            wakeword_arm_readiness(true, true),
            WakewordArmReadiness::Ready
        );
        assert_eq!(
            wakeword_arm_readiness(true, false),
            WakewordArmReadiness::Ready
        );
        assert_eq!(
            wakeword_arm_readiness(false, false),
            WakewordArmReadiness::MissingModelBundle
        );
        assert_eq!(
            wakeword_arm_readiness(false, true),
            WakewordArmReadiness::DetectorUnavailable
        );
    }

    #[test]
    fn disabling_live_transcription_does_not_restart() {
        // both → none disables the realtime preview. The realtime worker self-gates on
        // the live setting (re-read every loop tick), so this is a HOT toggle — no
        // relaunch. Regression guard for the "restart the server to disable realtime"
        // bug (the reference restarted here; this port does not).
        let mut a = WinsttSettings::default();
        a.general.live_transcription_display = LiveTranscriptionDisplay::Both;
        let mut b = a.clone();
        b.general.live_transcription_display = LiveTranscriptionDisplay::None;
        assert!(compute_restart_keys(&a, &b).is_empty());
    }

    #[test]
    fn word_by_word_paste_enables_realtime_without_live_preview() {
        let mut settings = WinsttSettings::default();
        settings.general.live_transcription_display = LiveTranscriptionDisplay::None;
        settings.general.word_by_word_pasting = true;
        assert!(effective_realtime(&settings));
    }

    #[test]
    fn word_by_word_realtime_override_wins_over_llm_dictation() {
        let mut settings = WinsttSettings::default();
        settings.general.live_transcription_display = LiveTranscriptionDisplay::None;
        settings.general.word_by_word_pasting = true;
        settings.llm.dictation.enabled = true;
        assert!(effective_realtime(&settings));
    }

    #[test]
    fn changing_live_transcription_display_does_not_restart() {
        // ANY live-transcription display change is hot (in-app → both shown here; none →
        // both, both → in-pill, … all behave the same): the worker self-gates.
        let mut a = WinsttSettings::default();
        a.general.live_transcription_display = LiveTranscriptionDisplay::InApp;
        let mut b = a.clone();
        b.general.live_transcription_display = LiveTranscriptionDisplay::Both;
        assert!(compute_restart_keys(&a, &b).is_empty());
    }

    #[test]
    fn pill_overlay_toggle_does_not_restart() {
        // display=in-pill, overlay on→off changes whether the preview renders, but the
        // worker re-reads effective-realtime live → hot toggle, no relaunch.
        let mut a = WinsttSettings::default();
        a.general.live_transcription_display = LiveTranscriptionDisplay::InPill;
        a.general.show_recording_overlay = true;
        let mut b = a.clone();
        b.general.show_recording_overlay = false;
        assert!(compute_restart_keys(&a, &b).is_empty());
    }

    #[test]
    fn no_change_no_restart() {
        let a = WinsttSettings::default();
        assert!(compute_restart_keys(&a, &a).is_empty());
    }

    #[test]
    fn same_model_load_input_change_requests_reload() {
        let a = WinsttSettings::default();
        let mut b = a.clone();
        b.model.device = crate::winstt::settings_schema::DeviceType::Cpu;
        assert!(same_model_load_inputs_changed(&a, &b));

        let mut quant = a.clone();
        quant.model.onnx_quantization = "int8".into();
        assert!(same_model_load_inputs_changed(&a, &quant));
    }

    #[test]
    fn model_id_change_is_owned_by_swap_controller() {
        let a = WinsttSettings::default();
        let mut b = a.clone();
        b.model.model = "nemo-canary-180m-flash".into();
        assert!(!same_model_load_inputs_changed(&a, &b));
        assert!(!model_warm_inputs_changed(&a, &b));
    }

    #[test]
    fn keep_warm_policy_change_can_request_stt_warmup() {
        use crate::winstt::settings_schema::ModelUnloadTimeout;

        let a = WinsttSettings::default();
        let mut b = a.clone();
        b.global.model_unload_timeout = ModelUnloadTimeout::Immediately;
        assert!(model_warm_inputs_changed(&a, &b));
    }

    #[test]
    fn winstt_unload_timeout_maps_to_core_policy() {
        use crate::settings::ModelUnloadTimeout as CoreTimeout;
        use crate::winstt::settings_schema::ModelUnloadTimeout as WinsttTimeout;

        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Immediately),
            CoreTimeout::Immediately
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Never),
            CoreTimeout::Never
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Min2),
            CoreTimeout::Min2
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Min5),
            CoreTimeout::Min5
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Min10),
            CoreTimeout::Min10
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Min15),
            CoreTimeout::Min15
        );
        assert_eq!(
            core_timeout_from_winstt(WinsttTimeout::Hour1),
            CoreTimeout::Hour1
        );
    }

    #[test]
    fn keep_warm_policy_runs_for_every_timeout_except_immediately() {
        use crate::winstt::settings_schema::ModelUnloadTimeout as WinsttTimeout;

        assert!(!should_keep_stt_model_warm(WinsttTimeout::Immediately));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Never));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Min2));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Min5));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Min10));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Min15));
        assert!(should_keep_stt_model_warm(WinsttTimeout::Hour1));
    }

    #[test]
    fn tts_warmup_only_runs_for_enabled_local_tts() {
        use crate::winstt::settings_schema::{ModelUnloadTimeout, TtsSource};

        let mut disabled = WinsttSettings::default();
        disabled.tts.enabled = false;
        disabled.tts.source = TtsSource::Local;
        assert!(!should_warm_tts(&disabled));

        let mut cloud = disabled.clone();
        cloud.tts.enabled = true;
        cloud.tts.source = TtsSource::Cloud;
        assert!(!should_warm_tts(&cloud));

        let mut local = disabled.clone();
        local.tts.enabled = true;
        local.tts.source = TtsSource::Local;
        assert!(should_warm_tts(&local));

        local.global.model_unload_timeout = ModelUnloadTimeout::Immediately;
        assert!(!should_warm_tts(&local));
    }

    #[test]
    fn tts_warmup_reacts_to_local_enable_model_and_device_edges() {
        use crate::winstt::settings_schema::{DeviceType, TtsSource};

        let mut prev = WinsttSettings::default();
        prev.tts.enabled = false;
        prev.tts.source = TtsSource::Local;
        let mut next = prev.clone();
        next.tts.enabled = true;
        assert!(tts_warm_inputs_changed(&prev, &next));

        let mut model_swap = next.clone();
        model_swap.tts.model = "kitten-nano-0.2".into();
        assert!(tts_warm_inputs_changed(&next, &model_swap));

        let mut device_swap = model_swap.clone();
        device_swap.model.device = DeviceType::Cpu;
        assert!(tts_warm_inputs_changed(&model_swap, &device_swap));

        let mut speed_only = device_swap.clone();
        speed_only.tts.speed = 1.25;
        assert!(!tts_warm_inputs_changed(&device_swap, &speed_only));
    }

    #[test]
    fn enabled_ollama_models_are_deduped_across_dictation_and_transforms() {
        use crate::winstt::settings_schema::LlmProvider;

        let mut settings = WinsttSettings::default();
        settings.llm.dictation.enabled = true;
        settings.llm.dictation.base.provider = LlmProvider::Ollama;
        settings.llm.dictation.base.model = "gemma3:4b".into();
        settings.llm.transforms.enabled = true;
        settings.llm.transforms.base.provider = LlmProvider::Ollama;
        settings.llm.transforms.base.model = "gemma3:4b".into();

        assert_eq!(enabled_ollama_models(&settings), vec!["gemma3:4b"]);

        settings.llm.transforms.base.model = "qwen3:8b".into();
        assert_eq!(
            enabled_ollama_models(&settings),
            vec!["gemma3:4b", "qwen3:8b"]
        );

        settings.llm.transforms.base.provider = LlmProvider::Openrouter;
        assert_eq!(enabled_ollama_models(&settings), vec!["gemma3:4b"]);

        settings.global.model_unload_timeout =
            crate::winstt::settings_schema::ModelUnloadTimeout::Immediately;
        assert!(enabled_ollama_models(&settings).is_empty());
    }

    #[test]
    fn parse_settings_value_defaults_missing_fields() {
        let settings = parse_settings_value(serde_json::json!({
            "model": {
                "model": "nemo-canary-180m-flash"
            }
        }))
        .unwrap();

        assert_eq!(settings.model.model, "nemo-canary-180m-flash");
        assert_eq!(
            settings.general.recording_mode,
            WinsttSettings::default().general.recording_mode
        );
    }

    #[test]
    fn parse_settings_value_disables_llm_dictation_when_word_by_word_enabled() {
        let mut value = serde_json::to_value(WinsttSettings::default()).unwrap();
        value["general"]["wordByWordPasting"] = serde_json::json!(true);
        value["llm"]["dictation"]["enabled"] = serde_json::json!(true);

        let settings = parse_settings_value(value).unwrap();

        assert!(settings.general.word_by_word_pasting);
        assert!(!settings.llm.dictation.enabled);
    }

    #[test]
    fn parse_settings_value_rejects_malformed_field_type() {
        let mut value = serde_json::to_value(WinsttSettings::default()).unwrap();
        value["general"]["recordingMode"] = serde_json::json!(42);

        let err = parse_settings_value(value).unwrap_err();
        assert!(err.contains("invalid persisted WinSTT settings"));
    }

    #[test]
    fn llm_warmup_reacts_only_to_ollama_warm_inputs() {
        use crate::winstt::settings_schema::LlmProvider;

        let mut prev = WinsttSettings::default();
        prev.llm.endpoint = "http://localhost:11434".into();
        prev.llm.dictation.enabled = true;
        prev.llm.dictation.base.provider = LlmProvider::Ollama;
        prev.llm.dictation.base.model = "gemma3:4b".into();

        let mut unchanged_for_warmup = prev.clone();
        unchanged_for_warmup.llm.openrouter_api_key = "sk-not-ollama".into();
        assert!(!llm_warm_inputs_changed(&prev, &unchanged_for_warmup));

        let mut endpoint_swap = prev.clone();
        endpoint_swap.llm.endpoint = "http://127.0.0.1:11434".into();
        assert!(llm_warm_inputs_changed(&prev, &endpoint_swap));

        let mut model_swap = prev.clone();
        model_swap.llm.dictation.base.model = "qwen3:8b".into();
        assert!(llm_warm_inputs_changed(&prev, &model_swap));

        let mut provider_swap = prev.clone();
        provider_swap.llm.dictation.base.provider = LlmProvider::Openrouter;
        assert!(llm_warm_inputs_changed(&prev, &provider_swap));
    }

    // ── secret sealing on the persisted form ───────────────────────────────────

    #[cfg(target_os = "windows")]
    #[test]
    fn seal_then_open_round_trips_secret_fields() {
        let mut s = WinsttSettings::default();
        s.llm.openrouter_api_key = "sk-or-v1-secret".into();
        s.integrations.openai.api_key = "sk-openai-secret".into();
        s.integrations.elevenlabs.api_key = "xi-el-secret".into();

        let mut sealed = s.clone();
        try_seal_secrets(&mut sealed).unwrap();
        // On disk the secret fields are NOT plaintext.
        assert!(is_encrypted(&sealed.llm.openrouter_api_key));
        assert_ne!(sealed.llm.openrouter_api_key, s.llm.openrouter_api_key);
        // Non-secret fields untouched.
        assert_eq!(sealed.llm.endpoint, s.llm.endpoint);

        // Opening returns plaintext.
        let mut opened = sealed.clone();
        try_open_secrets(&mut opened).unwrap();
        assert_eq!(opened.llm.openrouter_api_key, "sk-or-v1-secret");
        assert_eq!(opened.integrations.openai.api_key, "sk-openai-secret");
        assert_eq!(opened.integrations.elevenlabs.api_key, "xi-el-secret");
    }

    #[test]
    fn empty_secret_seals_to_empty() {
        // The default tree has empty secrets — sealing must keep them empty (no
        // spurious envelope on disk), matching the reference's empty-string short-circuit.
        let mut s = WinsttSettings::default();
        try_seal_secrets(&mut s).unwrap();
        assert_eq!(s.llm.openrouter_api_key, "");
        assert_eq!(s.integrations.openai.api_key, "");
        assert_eq!(s.integrations.elevenlabs.api_key, "");
    }

    #[test]
    fn malformed_secret_envelope_returns_error() {
        let mut s = WinsttSettings::default();
        s.llm.openrouter_api_key = "enc:v1:not-hex-!!!".into();

        let err = try_open_secrets(&mut s).unwrap_err();
        assert!(err.contains("malformed encrypted secret envelope"));
        assert_eq!(s.llm.openrouter_api_key, "enc:v1:not-hex-!!!");
    }

    #[test]
    fn renderer_sanitization_masks_non_empty_secrets() {
        let mut s = WinsttSettings::default();
        s.llm.openrouter_api_key = "sk-or-v1-secret".into();
        s.integrations.openai.api_key = "sk-openai-secret".into();
        s.integrations.elevenlabs.api_key = "xi-el-secret".into();

        sanitize_settings_for_renderer(&mut s);

        assert_eq!(s.llm.openrouter_api_key, SECRET_PRESENT_SENTINEL);
        assert_eq!(s.integrations.openai.api_key, SECRET_PRESENT_SENTINEL);
        assert_eq!(s.integrations.elevenlabs.api_key, SECRET_PRESENT_SENTINEL);
    }

    #[test]
    fn renderer_sanitization_keeps_empty_secrets_empty() {
        let mut s = WinsttSettings::default();

        sanitize_settings_for_renderer(&mut s);

        assert_eq!(s.llm.openrouter_api_key, "");
        assert_eq!(s.integrations.openai.api_key, "");
        assert_eq!(s.integrations.elevenlabs.api_key, "");
    }

    #[test]
    fn masked_secret_patch_preserves_previous_plaintext_secret() {
        let mut previous = WinsttSettings::default();
        previous.llm.openrouter_api_key = "sk-or-v1-secret".into();
        previous.integrations.openai.api_key = "sk-openai-secret".into();
        previous.integrations.elevenlabs.api_key = "xi-el-secret".into();

        let mut next = previous.clone();
        next.llm.openrouter_api_key = SECRET_PRESENT_SENTINEL.into();
        next.integrations.openai.api_key = SECRET_PRESENT_SENTINEL.into();
        next.integrations.elevenlabs.api_key = SECRET_PRESENT_SENTINEL.into();

        preserve_masked_secrets(&previous, &mut next);

        assert_eq!(next.llm.openrouter_api_key, "sk-or-v1-secret");
        assert_eq!(next.integrations.openai.api_key, "sk-openai-secret");
        assert_eq!(next.integrations.elevenlabs.api_key, "xi-el-secret");
    }

    #[test]
    fn empty_secret_patch_still_clears_previous_secret() {
        let mut previous = WinsttSettings::default();
        previous.llm.openrouter_api_key = "sk-or-v1-secret".into();
        previous.integrations.openai.api_key = "sk-openai-secret".into();
        previous.integrations.elevenlabs.api_key = "xi-el-secret".into();

        let mut next = previous.clone();
        next.llm.openrouter_api_key.clear();
        next.integrations.openai.api_key.clear();
        next.integrations.elevenlabs.api_key.clear();

        preserve_masked_secrets(&previous, &mut next);

        assert_eq!(next.llm.openrouter_api_key, "");
        assert_eq!(next.integrations.openai.api_key, "");
        assert_eq!(next.integrations.elevenlabs.api_key, "");
    }

    // ── partial-patch merge (the load-bearing partial-save fix) ────────────────

    fn patch_from_json(value: serde_json::Value) -> PartialWinsttSettings {
        serde_json::from_value(value).expect("partial patch deserialize")
    }

    #[test]
    fn partial_patch_preserves_untouched_sections() {
        let mut current = WinsttSettings::default();
        let mut cv = serde_json::to_value(&current).unwrap();
        cv["model"]["model"] = serde_json::json!("nemo-canary-180m-flash");
        current = serde_json::from_value(cv).unwrap();
        let customized_model = current.model.clone();

        let mut audio = serde_json::to_value(&current.audio).unwrap();
        audio["sileroSensitivity"] = serde_json::json!(0.42);
        let patch = patch_from_json(serde_json::json!({ "audio": audio }));
        let next = merge_patch_over(&current, patch);

        assert_eq!(next.model, customized_model);
        let audio_val = serde_json::to_value(&next.audio).unwrap();
        assert_eq!(audio_val["sileroSensitivity"], serde_json::json!(0.42));
    }

    #[test]
    fn general_patch_cannot_revert_onboarded() {
        let mut current = WinsttSettings::default();
        let mut cv = serde_json::to_value(&current).unwrap();
        cv["general"]["onboarded"] = serde_json::json!(true);
        cv["general"]["onboardedTrack"] = serde_json::json!("local");
        current = serde_json::from_value(cv).unwrap();

        let mut general = serde_json::to_value(&current.general).unwrap();
        general["onboarded"] = serde_json::json!(false);
        general["onboardedTrack"] = serde_json::json!("");
        general["recordingMode"] = serde_json::json!("toggle");
        let patch = patch_from_json(serde_json::json!({ "general": general }));
        let next = merge_patch_over(&current, patch);

        assert!(next.general.onboarded);
        assert_eq!(
            next.general.onboarded_track,
            crate::winstt::settings_schema::OnboardedTrack::Local
        );
        let general_val = serde_json::to_value(&next.general).unwrap();
        assert_eq!(general_val["recordingMode"], serde_json::json!("toggle"));
    }

    #[test]
    fn general_patch_makes_word_by_word_and_preview_mutually_exclusive() {
        let current = WinsttSettings::default();
        let mut general = serde_json::to_value(&current.general).unwrap();
        general["previewBeforePasting"] = serde_json::json!(true);
        general["wordByWordPasting"] = serde_json::json!(true);
        let patch = patch_from_json(serde_json::json!({ "general": general }));
        let next = merge_patch_over(&current, patch);

        assert!(next.general.word_by_word_pasting);
        assert!(!next.general.preview_before_pasting);
    }

    #[test]
    fn general_patch_disables_llm_dictation_when_word_by_word_enabled() {
        let mut current = WinsttSettings::default();
        current.llm.dictation.enabled = true;
        let mut general = serde_json::to_value(&current.general).unwrap();
        general["wordByWordPasting"] = serde_json::json!(true);
        let patch = patch_from_json(serde_json::json!({ "general": general }));

        let next = merge_patch_over(&current, patch);

        assert!(next.general.word_by_word_pasting);
        assert!(!next.llm.dictation.enabled);
    }

    #[test]
    fn llm_patch_keeps_word_by_word_and_disables_dictation() {
        let mut current = WinsttSettings::default();
        current.general.word_by_word_pasting = true;
        let mut llm = serde_json::to_value(&current.llm).unwrap();
        llm["dictation"]["enabled"] = serde_json::json!(true);
        let patch = patch_from_json(serde_json::json!({ "llm": llm }));

        let next = merge_patch_over(&current, patch);

        assert!(next.general.word_by_word_pasting);
        assert!(!next.llm.dictation.enabled);
    }

    #[test]
    fn empty_patch_is_noop() {
        let current = WinsttSettings::default();
        let next = merge_patch_over(&current, PartialWinsttSettings::default());
        assert_eq!(next, current);
    }

    #[test]
    fn partial_deserializes_with_absent_sections_as_none() {
        let patch: PartialWinsttSettings =
            serde_json::from_value(serde_json::json!({ "audio": {} })).unwrap();
        assert!(patch.audio.is_some());
        assert!(patch.model.is_none());
        assert!(patch.general.is_none());
        assert!(patch.integrations.is_none());
    }
}
