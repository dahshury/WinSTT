// PORT IMPL — WU-0 settings persistence + apply. Source: frontend/electron/ipc/settings.ts
// (the behavioral truth), frontend/electron/lib/store.ts + secret-storage.ts. Wraps
// winstt::settings_schema (the ~150-field nested WinsttSettings tree).
//
// winstt_get_settings / winstt_set_settings expose the full nested WinsttSettings tree
// to the reused React renderer over tauri-specta. They are NOT thin getters/setters —
// they reproduce the reference's settings:load / settings:save handlers 1:1:
//
//   * winstt_get_settings → reads the persisted store, OPENS the three secret fields
//     to plaintext (every internal consumer + the renderer expect plaintext, exactly
//     like the reference's `getStoreValue` / `decryptSecretsForRenderer`), returns the
//     full nested tree (defaulting cleanly on a missing / partial blob).
//
//   * winstt_set_settings → merges the PARTIAL section patch the renderer posts over
//     the persisted snapshot (so a `{ audio: ... }` calibration save can't wipe
//     `model`/`general`), preserves the main-owned `onboarded*` fields, SEALS the
//     secret fields at rest (`enc:v1:` envelope), persists, computes the
//     restart-need (startup-only ∪ CONDITIONAL wakeword — NOT effective-realtime, which
//     self-gates live; see `compute_restart_keys`), emits `stt:restart-required` for the
//     changed key (the in-proc engine is "unmanaged" — there is no server process to
//     auto-restart, so we surface the manual-restart notice exactly like the reference's
//     unmanaged-server branch), and broadcasts the post-save DECRYPTED snapshot via
//     `settings:changed`.
//
// Hot-swap side-effects (model swap, quant, VAD knobs, autostart, …) are driven by the
// renderer's own sync layer (`features/update-settings` → `sttSetParameter` /
// `autostartSet` / `sttReloadModel`), NOT by this handler — byte-identical to the reference,
// whose `settings:save` ALSO only persists + diffs restart + broadcasts. So "apply" here
// means: persist + seal + restart-notify + broadcast. The renderer fans the per-setting
// hot-swaps out separately (and those land in their owning slices' commands).
//
// Persistence rides Handy's existing tauri-plugin-store. WinSTT settings live under a
// dedicated `winstt_settings` key in `winstt-settings.json` (separate from Handy's
// `settings`) so the two schemas don't collide.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;

use crate::winstt::commands::secret_storage::{decrypt_secret, encrypt_secret, is_encrypted};
use crate::winstt::settings_schema::{
    is_secret, is_startup_only, AudioSettings, DictionaryEntry, GeneralSettings, GlobalSettings,
    HotkeySettings, IntegrationsSettings, LiveTranscriptionDisplay, LlmProvider, LlmSettings,
    ModelSettings, ModelUnloadTimeout as WinsttModelUnloadTimeout, PresetEntry, PresetKey,
    QualitySettings, RecordingMode, SnippetEntry, TtsSettings, TtsSource, WinsttSettings,
    SECRET_KEYS, WAKEWORD_CONFIG_KEYS,
};

pub const WINSTT_SETTINGS_KEY: &str = "winstt_settings";
const WINSTT_SETTINGS_FILE: &str = "winstt-settings.json";

/// The `settings:changed` plain event — the post-save full snapshot every other
/// window re-hydrates its Zustand store from. Byte-identical to WinSTT's the reference
/// IPC shape (`{ settings }`) so the reused renderer's `onSettingsChanged`
/// listener (ipc-client.ts) needs no changes.
const SETTINGS_CHANGED_EVENT: &str = "settings:changed";

/// The `settings:save-error` plain event — emitted on validation/persist failure
/// (the renderer's save path is fire-and-forget, so it can't see the `Result`).
/// Shape `{ error }` matches `onSettingsSaveError` in ipc-client.ts.
const SETTINGS_SAVE_ERROR_EVENT: &str = "settings:save-error";

/// The `stt:restart-required` plain event — emitted when a startup-only / wakeword /
/// effective-realtime setting changed but the (in-proc) engine cannot apply it
/// without a relaunch. Shape `{ setting, kind }` matches `ServerRestartRequiredPayload`
/// in ipc-client.ts. The in-proc engine is always "unmanaged" (no separate server
/// process the reference could kill+respawn), so `kind` is always `"unmanaged"`.
const RESTART_REQUIRED_EVENT: &str = "stt:restart-required";

/// Result of `winstt_set_settings`: whether the change requires an engine
/// restart, and which dot-paths drove that decision (for diagnostics / UI).
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
/// verify read API keys straight off the returned struct, and `winstt_get_settings`
/// returns it to the renderer) — so it MUST hand back plaintext secrets, exactly like
/// the reference's `getStoreValue` decrypting transparently on every read. The on-disk
/// store holds the sealed `enc:v1:` envelopes; legacy plaintext (no prefix) passes
/// through unchanged.
///
/// Defaults cleanly on a missing / partial blob — every field is `#[serde(default)]`,
/// mirroring Zod `.catch`.
pub fn read_settings(app: &AppHandle) -> WinsttSettings {
    let mut settings = read_settings_raw(app);
    open_secrets(&mut settings);
    settings
}

/// Read the persisted settings WITHOUT opening secrets (the on-disk form, where the
/// three secret fields are still sealed envelopes). Originally the save path's
/// old→new diff helper (so sealed secret fields compare like-for-like rather than
/// triggering a spurious "changed" on every save, mirroring `snapshotSettings`), it
/// is now ALSO the secret-agnostic reader for the hot recording/realtime loops
/// (`realtime_manager`, `recording_mode`) — those must NOT trigger per-tick secret
/// decryption (reg.exe spawns), so they read raw. Hence `pub(crate)`.
pub(crate) fn read_settings_raw(app: &AppHandle) -> WinsttSettings {
    let Ok(store) = app.store(store_path()) else {
        return WinsttSettings::default();
    };
    match store.get(WINSTT_SETTINGS_KEY) {
        Some(value) => serde_json::from_value(value).unwrap_or_default(),
        None => WinsttSettings::default(),
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
fn open_secrets(settings: &mut WinsttSettings) {
    settings.llm.openrouter_api_key = decrypt_secret(&settings.llm.openrouter_api_key);
    settings.integrations.openai.api_key = decrypt_secret(&settings.integrations.openai.api_key);
    settings.integrations.elevenlabs.api_key =
        decrypt_secret(&settings.integrations.elevenlabs.api_key);
}

/// Seal (encrypt) the three secret fields on a settings tree in place, ready for
/// the store. A value that is already a sealed envelope (the renderer echoed it
/// back without touching it — it can't, the IPC path always sends plaintext, but
/// the guard keeps this total) is left as-is via `encrypt_secret`'s idempotence.
fn seal_secrets(settings: &mut WinsttSettings) {
    settings.llm.openrouter_api_key = encrypt_secret(&settings.llm.openrouter_api_key);
    settings.integrations.openai.api_key = encrypt_secret(&settings.integrations.openai.api_key);
    settings.integrations.elevenlabs.api_key =
        encrypt_secret(&settings.integrations.elevenlabs.api_key);
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

/// `winstt_get_settings` — the full tree the renderer boots against (secrets opened).
#[tauri::command]
#[specta::specta]
pub fn winstt_get_settings(app: AppHandle) -> WinsttSettings {
    read_settings(&app)
}

/// `winstt_set_settings` — merge a PARTIAL section patch, validate, diff restart-need,
/// seal secrets, persist, restart-notify, broadcast.
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
    let previous = read_settings(app);

    // Merge the partial patch over the persisted full snapshot, section by section
    // (matching `applySettings` / `mergeMainOwnedFields`). Each present section
    // overwrites its counterpart wholesale; absent sections keep the persisted value;
    // `general` preserves the main-owned `onboarded*` fields.
    let next = merge_patch_over(&previous, patch);

    // (a) cross-field validation (the Zod `.refine` equivalents).
    validate_settings(&next)?;

    // (b) restart-need predicate set —
    //     1. an unconditional startup-only key changed; OR
    //     2. the wakeword config branch changed (CONDITIONAL on mode).
    //     (the reference also restarted on an effective-realtime flip; this port does NOT —
    //     the realtime worker self-gates on the live setting, so toggling live
    //     transcription needs no relaunch. See `compute_restart_keys`.)
    let changed_startup = compute_restart_keys(&previous, &next);
    let needs_restart = !changed_startup.is_empty();

    // (c) seal the secret fields at rest, then persist. Clone so the broadcast +
    //     return keep the PLAINTEXT `next` (the renderer + every consumer want
    //     plaintext); only the on-disk copy is sealed.
    let mut to_persist = next.clone();
    seal_secrets(&mut to_persist);
    debug_assert!(SECRET_KEYS.iter().all(|k| is_secret(k)));
    write_settings_value(app, &to_persist)?;

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

    // (d) surface the manual-restart notice for the in-proc (unmanaged) engine. The
    //     renderer's `onServerRestartRequired` shows the "restart to apply" UI.
    if needs_restart {
        notify_restart_required(app, resolve_changed_key(&changed_startup));
    }

    // (e) broadcast the post-save PLAINTEXT full snapshot (not the raw partial) so
    //     every other window re-hydrates the same canonical view. Sending the partial
    //     would make `decodeSettingsPayload` fill DEFAULTS for the missing sections
    //     and stomp customized fields — the exact reason the reference broadcasts the
    //     decrypted snapshot, not the raw payload.
    let snapshot = serde_json::to_value(&next).map_err(|e| e.to_string())?;
    let _ = app.emit(
        SETTINGS_CHANGED_EVENT,
        serde_json::json!({ "settings": snapshot }),
    );

    Ok(SetSettingsResult {
        needs_restart,
        changed_startup_keys: changed_startup,
    })
}

/// Emit `stt:restart-required { setting, kind: "unmanaged" }`. The in-proc engine has
/// no separate server process to kill+respawn (the reference's "managed" branch), so this
/// is always the unmanaged branch: the user must relaunch the app to apply the change.
fn notify_restart_required(app: &AppHandle, setting: &str) {
    let _ = app.emit(
        RESTART_REQUIRED_EVENT,
        serde_json::json!({ "setting": setting, "kind": "unmanaged" }),
    );
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

    if model_warm_inputs_changed(previous, next)
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
    previous.model.model != next.model.model
        || previous.model.backend != next.model.backend
        || previous.model.device != next.model.device
        || previous.model.onnx_quantization != next.model.onnx_quantization
        || previous.global.model_unload_timeout != next.global.model_unload_timeout
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

    if let Err(err) = audio.inner().ensure_wakeword_listening_stream() {
        let detail = err.to_string();
        log::warn!("[wakeword] failed to open microphone stream: {detail}");
        wakeword.set_armed(false);
        emit_recording_error(app, &detail);
        return;
    }

    wakeword.set_armed(true);
    let _ = app.emit("stt:wakeword-detection-start", ());
    if wakeword.has_detector() {
        log::info!(
            "[wakeword] listening for '{}' via live microphone stream",
            wakeword.current_phrase()
        );
    } else {
        log::warn!(
            "[wakeword] microphone stream is open, but no detector is loaded for '{}'",
            settings.general.wake_word
        );
    }
}

fn disarm_wakeword_runtime(app: &AppHandle) {
    if let Some(wakeword) = app.try_state::<Arc<crate::winstt::managers::WakeWordManager>>() {
        wakeword.set_armed(false);
    }
    let _ = app.emit("stt:wakeword-detection-end", ());
    if let Some(audio) = app.try_state::<Arc<crate::managers::audio::AudioRecordingManager>>() {
        audio.inner().stop_wakeword_listening_stream_if_idle();
    }
    log::info!("[wakeword] detection stopped");
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

/// Pick the single key name to name in the restart notice (the reference's
/// `resolveChangedKey`): the first changed startup-only key, else the wakeword group,
/// else the realtime group. `changed` is already the ordered restart-key list.
fn resolve_changed_key(changed: &[String]) -> &str {
    changed.first().map(String::as_str).unwrap_or("a setting")
}

/// Compute the ordered set of restart-forcing dot-paths between two PLAINTEXT trees.
/// Adapted from the reference's `checkForRestartNeeded` predicate, decomposed:
///   * every diffed dot-path that is `is_startup_only` (unconditional);
///   * the wakeword group, but ONLY when the wakeword restart condition holds
///     (mode crosses into/out of wakeword, or a wakeword param changed while staying
///     in wakeword) — a plain ptt↔toggle swap must NOT restart.
///
/// DIVERGENCE FROM THE REFERENCE: the reference also restarted when effective-realtime flipped
/// (its realtime engine was configured at process startup). This port deliberately does
/// NOT — the realtime worker (`winstt::managers::realtime_manager`) re-reads
/// `effective_realtime` every loop tick and self-gates its decode path, so enabling OR
/// disabling live transcription takes effect immediately with no relaunch. Surfacing a
/// "restart the server to apply" notice for a plain feature toggle was a user-facing bug.
fn compute_restart_keys(prev: &WinsttSettings, next: &WinsttSettings) -> Vec<String> {
    let changed = changed_dot_paths(prev, next);
    let mut out: Vec<String> = Vec::new();

    // 1. Unconditional startup-only keys (preserve diff order for the notice).
    for path in &changed {
        if is_startup_only(path) {
            out.push(path.clone());
        }
    }

    // 2. CONDITIONAL wakeword restart (the reference `wakeWordRestartNeeded`).
    if wakeword_restart_needed(prev, next) {
        // Name the specific changed wakeword key (mode, wakeWord, sensitivity, …)
        // if one is in the diff; else the recordingMode boundary itself.
        let wake_key = WAKEWORD_CONFIG_KEYS
            .iter()
            .find(|k| changed.iter().any(|c| c == *k))
            .map(|k| (*k).to_string())
            .unwrap_or_else(|| "general.recordingMode".to_string());
        if !out.contains(&wake_key) {
            out.push(wake_key);
        }
    }

    // NOTE: no effective-realtime restart branch (see the doc comment) — the realtime
    // worker self-gates on the live setting, so toggling live transcription is hot.

    out
}

// ── CONDITIONAL restart predicates (ported 1:1 from electron/ipc/settings.ts) ─────

/// Did the recordingMode cross the wakeword boundary, or did a wakeword CLI param
/// change while staying in wakeword? the reference `wakeWordRestartNeeded`.
fn wakeword_restart_needed(prev: &WinsttSettings, next: &WinsttSettings) -> bool {
    let old_mode = prev.general.recording_mode;
    let new_mode = next.general.recording_mode;
    mode_crosses_wakeword(old_mode, new_mode)
        || wake_config_changed_while_in_wakeword(old_mode, new_mode, prev, next)
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

/// `(old == wakeword) != (new == wakeword)` — entering OR leaving wakeword mode.
fn mode_crosses_wakeword(old_mode: RecordingMode, new_mode: RecordingMode) -> bool {
    (old_mode == RecordingMode::Wakeword) != (new_mode == RecordingMode::Wakeword)
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

/// `isRealtimeEnabled({ showRecordingOverlay, liveTranscriptionDisplay })` ported
/// from shared/lib/realtime-enabled.ts. The pill path ("in-pill"/"both") gates on
/// the overlay being shown; in-app/both always render.
///
/// Public so the realtime worker (winstt::managers::realtime_manager) gates its decode
/// loop on the SAME source of truth instead of duplicating the branch logic.
pub fn effective_realtime(settings: &WinsttSettings) -> bool {
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
    incoming
}

/// Re-run the Zod cross-field rules: no duplicate preset keys, at most one tone key,
/// `level` only for summarize/concise, `targetLang` only for translate.
fn validate_settings(settings: &WinsttSettings) -> Result<(), String> {
    validate_presets(&settings.llm.dictation.presets)
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

/// Compute the changed dot-paths between two settings trees via JSON diff (covers the
/// full nested tree without per-field plumbing). camelCase keys match the renderer's
/// dot-path convention (e.g. `general.recordingMode`).
fn changed_dot_paths(prev: &WinsttSettings, next: &WinsttSettings) -> Vec<String> {
    let pv = serde_json::to_value(prev).unwrap_or(serde_json::Value::Null);
    let nv = serde_json::to_value(next).unwrap_or(serde_json::Value::Null);
    let mut out = Vec::new();
    diff_json("", &pv, &nv, &mut out);
    out
}

fn diff_json(prefix: &str, a: &serde_json::Value, b: &serde_json::Value, out: &mut Vec<String>) {
    match (a, b) {
        (serde_json::Value::Object(ao), serde_json::Value::Object(bo)) => {
            let mut keys: std::collections::BTreeSet<&String> = ao.keys().collect();
            keys.extend(bo.keys());
            for k in keys {
                let child_prefix = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                let av = ao.get(k).unwrap_or(&serde_json::Value::Null);
                let bv = bo.get(k).unwrap_or(&serde_json::Value::Null);
                diff_json(&child_prefix, av, bv, out);
            }
        }
        _ => {
            if a != b && !prefix.is_empty() {
                out.push(prefix.to_string());
            }
        }
    }
}

/// Silence the "is_encrypted unused" lint when only the seal/open helpers are used —
/// kept as a re-export point so callers in other slices (e.g. a future secrets
/// migration) can detect an already-sealed value without importing the submodule.
#[allow(dead_code)]
pub fn value_is_sealed(value: &str) -> bool {
    is_encrypted(value)
}

#[cfg(test)]
mod tests {
    // `super::*` already brings in PresetKey / PresetEntry / RecordingMode /
    // LiveTranscriptionDisplay / WinsttSettings (imported at module top).
    use super::*;

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
    fn startup_only_key_change_forces_restart() {
        let mut a = WinsttSettings::default();
        let mut b = WinsttSettings::default();
        b.model.device = crate::winstt::settings_schema::DeviceType::Cpu;
        let keys = compute_restart_keys(&a, &b);
        assert!(keys.iter().any(|k| k == "model.device"));
        // and the reverse direction (cpu→auto) also restarts.
        std::mem::swap(&mut a, &mut b);
        let keys2 = compute_restart_keys(&a, &b);
        assert!(keys2.iter().any(|k| k == "model.device"));
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
    fn entering_wakeword_forces_restart() {
        let mut a = WinsttSettings::default();
        a.general.recording_mode = RecordingMode::Ptt;
        let mut b = a.clone();
        b.general.recording_mode = RecordingMode::Wakeword;
        let keys = compute_restart_keys(&a, &b);
        assert!(keys.iter().any(|k| k == "general.recordingMode"));
    }

    #[test]
    fn leaving_wakeword_forces_restart() {
        let mut a = WinsttSettings::default();
        a.general.recording_mode = RecordingMode::Wakeword;
        let mut b = a.clone();
        b.general.recording_mode = RecordingMode::Listen;
        let keys = compute_restart_keys(&a, &b);
        assert!(keys.iter().any(|k| k == "general.recordingMode"));
    }

    #[test]
    fn wake_word_change_while_in_wakeword_restarts() {
        let mut a = WinsttSettings::default();
        a.general.recording_mode = RecordingMode::Wakeword;
        a.general.wake_word = "alexa".into();
        let mut b = a.clone();
        b.general.wake_word = "computer".into();
        let keys = compute_restart_keys(&a, &b);
        assert!(keys.iter().any(|k| k == "general.wakeWord"));
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

    #[test]
    fn seal_then_open_round_trips_secret_fields() {
        let mut s = WinsttSettings::default();
        s.llm.openrouter_api_key = "sk-or-v1-secret".into();
        s.integrations.openai.api_key = "sk-openai-secret".into();
        s.integrations.elevenlabs.api_key = "xi-el-secret".into();

        let mut sealed = s.clone();
        seal_secrets(&mut sealed);
        // On disk the secret fields are NOT plaintext.
        assert!(value_is_sealed(&sealed.llm.openrouter_api_key));
        assert_ne!(sealed.llm.openrouter_api_key, s.llm.openrouter_api_key);
        // Non-secret fields untouched.
        assert_eq!(sealed.llm.endpoint, s.llm.endpoint);

        // Opening returns plaintext.
        let mut opened = sealed.clone();
        open_secrets(&mut opened);
        assert_eq!(opened.llm.openrouter_api_key, "sk-or-v1-secret");
        assert_eq!(opened.integrations.openai.api_key, "sk-openai-secret");
        assert_eq!(opened.integrations.elevenlabs.api_key, "xi-el-secret");
    }

    #[test]
    fn empty_secret_seals_to_empty() {
        // The default tree has empty secrets — sealing must keep them empty (no
        // spurious envelope on disk), matching the reference's empty-string short-circuit.
        let mut s = WinsttSettings::default();
        seal_secrets(&mut s);
        assert_eq!(s.llm.openrouter_api_key, "");
        assert_eq!(s.integrations.openai.api_key, "");
        assert_eq!(s.integrations.elevenlabs.api_key, "");
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
        audio["vadSensitivity"] = serde_json::json!(0.42);
        let patch = patch_from_json(serde_json::json!({ "audio": audio }));
        let next = merge_patch_over(&current, patch);

        assert_eq!(next.model, customized_model);
        let audio_val = serde_json::to_value(&next.audio).unwrap();
        assert_eq!(audio_val["vadSensitivity"], serde_json::json!(0.42));
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
