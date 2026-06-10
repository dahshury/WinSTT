// Settings persistence + apply. Reference: frontend/electron/ipc/settings.ts
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
// Persistence rides the existing tauri-plugin-store. WinSTT settings live under a
// dedicated `winstt_settings` key in `winstt-settings.json` (separate from the legacy
// `settings`) so the two schemas don't collide.
//
// Runtime invariant: settings saves in this port must not emit manual restart events.
// Former restart-only settings are live-read or applied through targeted in-process
// reload/arm/disarm paths.
//
// This module root holds the public wire surface (commands + types + constants),
// the `apply_settings_patch` orchestrator, and the merge/validate/effective-realtime
// helpers. The cohesive concern clusters live in sibling submodules:
//   * `persistence` — store I/O + secret seal/open/mask + cross-field normalization.
//   * `learning`    — auto-apply dictation learning appenders.
//   * `runtime`     — on-save runtime side-effects (model/tts/llm/history/audio/autostart).
//   * `wakeword`    — wakeword runtime state machine.

mod learning;
mod persistence;
mod runtime;
mod wakeword;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

use crate::winstt::settings_schema::{
    is_secret, AudioSettings, CustomModifier, DictionaryEntry, GeneralSettings, GlobalSettings,
    HotkeySettings, IntegrationsSettings, LiveTranscriptionDisplay, LlmFeatureBase, LlmSettings,
    ModelSettings, PresetEntry, PresetKey, QualitySettings, SnippetEntry, SoundLibraryEntry,
    Transform, TtsCloud, TtsSettings, WinsttSettings, SECRET_KEYS,
};

use self::persistence::{
    normalize_cross_field_settings, preserve_masked_secrets, read_settings_for_renderer,
    sanitize_settings_for_renderer, try_read_settings, try_seal_secrets,
    word_by_word_pasting_effective, write_settings_value,
};
use self::runtime::{
    apply_audio_runtime_settings, apply_autostart_setting, apply_history_retention_settings,
    apply_llm_runtime_settings, apply_model_runtime_settings, apply_tts_runtime_settings,
};
use self::wakeword::apply_wakeword_runtime_settings;

// Re-export the cluster items that external (out-of-this-module) code reaches at
// the historical `crate::winstt::commands::settings::X` paths, so no import site
// changes. Visibilities mirror each item's original declaration (crate-internal
// helpers stay `pub(crate)`; the three `pub` reader entry points stay `pub`).
// Items that are only used WITHIN their own submodule (e.g. `should_keep_stt_model_warm`,
// `warm_llm_models_async`, `sync_wakeword_runtime_from_settings`) are intentionally
// NOT re-exported here — re-exporting an unused path would trip `-D warnings`.
pub(crate) use self::learning::auto_apply_dictation_learning;
pub(crate) use self::persistence::read_settings_raw;
pub use self::persistence::{read_settings, recording_mode, seed_defaults, write_core_settings};
pub(crate) use self::runtime::{
    core_timeout_from_winstt, enabled_ollama_models, should_warm_tts, warm_stt_model_async,
    warm_tts_async,
};
pub(crate) use self::wakeword::{
    rearm_wakeword_runtime_if_active, sync_wakeword_runtime_from_settings_in_background,
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

/// `winstt_get_settings` — the full tree the renderer boots against, with
/// secret fields masked so renderer code can know a key exists without reading
/// the key material.
#[tauri::command]
#[specta::specta]
pub fn winstt_get_settings(app: AppHandle) -> WinsttSettings {
    read_settings_for_renderer(&app)
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
    validate_model_settings(&settings.model)?;
    validate_quality_settings(&settings.quality)?;
    validate_audio_settings(&settings.audio)?;
    validate_general_settings(&settings.general)?;
    validate_hotkey(
        "hotkey.pushToTalkKey",
        &settings.hotkey.push_to_talk_key,
        true,
    )?;
    validate_dictionary(&settings.dictionary)?;
    validate_snippets(&settings.snippets)?;
    validate_llm_settings(&settings.llm)?;
    validate_tts_settings(&settings.tts)?;
    validate_integrations(&settings.integrations)?;
    validate_presets(&settings.llm.dictation.presets)?;
    validate_presets(&settings.llm.transforms.presets)?;
    crate::winstt::llm::validate_loopback_ollama_endpoint(&settings.llm.endpoint)?;
    Ok(())
}

const MAX_ID_LEN: usize = 128;
const MAX_MODEL_ID_LEN: usize = 256;
const MAX_ENDPOINT_LEN: usize = 256;
const MAX_SECRET_LEN: usize = 8 * 1024;
const MAX_HOTKEY_LEN: usize = 96;
const MAX_LANGUAGE_LEN: usize = 32;
const MAX_LANGUAGE_CANDIDATES: usize = 16;
const MAX_PROMPT_LEN: usize = 16 * 1024;
const MAX_SHORT_TEXT_LEN: usize = 256;
const MAX_REPLACEMENT_LEN: usize = 2 * 1024;
const MAX_SNIPPET_EXPANSION_LEN: usize = 16 * 1024;
const MAX_DICTIONARY_ENTRIES: usize = 2_000;
const MAX_SNIPPETS: usize = 1_000;
const MAX_CUSTOM_MODIFIERS: usize = 128;
const MAX_TRANSFORMS: usize = 128;
const MAX_PRESETS: usize = 10;
const MAX_SOUND_LIBRARY_ENTRIES: usize = 50;
const MAX_CONTEXT_LIST_ENTRIES: usize = 256;
const MAX_CONTEXT_ENTRY_LEN: usize = 253;
const MAX_CUSTOM_WAKE_WORDS: usize = 32;
const MAX_DEVICE_SENSITIVITY_ENTRIES: usize = 128;
const MAX_DEVICE_ID_LEN: usize = 512;
const MAX_PATH_LEN: usize = 4096;
const MAX_OUTPUT_TOKENS: i64 = 200_000;
const BUILTIN_RECORDING_SOUND_FILES: &[&str] = &[
    "marimba_start.wav",
    "recording_sound_ui_earcon_1.wav",
    "recording_sound_ui_earcon_4.wav",
];

fn validate_model_settings(model: &ModelSettings) -> Result<(), String> {
    validate_model_id("model.model", &model.model, true)?;
    validate_model_id("model.realtimeModel", &model.realtime_model, true)?;
    validate_short_text("model.language", &model.language, MAX_LANGUAGE_LEN, false)?;
    validate_collection_len(
        "model.languageCandidates",
        model.language_candidates.len(),
        MAX_LANGUAGE_CANDIDATES,
    )?;
    for (index, language) in model.language_candidates.iter().enumerate() {
        validate_short_text(
            &format!("model.languageCandidates[{index}]"),
            language,
            MAX_LANGUAGE_LEN,
            false,
        )?;
    }
    validate_quantization(&model.model, &model.onnx_quantization)?;
    validate_text("model.initialPrompt", &model.initial_prompt, MAX_PROMPT_LEN)?;
    validate_text(
        "model.initialPromptRealtime",
        &model.initial_prompt_realtime,
        MAX_PROMPT_LEN,
    )?;
    Ok(())
}

fn validate_quality_settings(quality: &QualitySettings) -> Result<(), String> {
    for (path, value, min, max) in [
        (
            "quality.realtimeProcessingPause",
            quality.realtime_processing_pause,
            0.0,
            30.0,
        ),
        (
            "quality.initRealtimeAfterSeconds",
            quality.init_realtime_after_seconds,
            0.0,
            30.0,
        ),
        (
            "quality.earlyTranscriptionOnSilence",
            quality.early_transcription_on_silence,
            0.0,
            30.0,
        ),
        (
            "quality.smartEndpointSpeed",
            quality.smart_endpoint_speed,
            0.5,
            3.0,
        ),
        (
            "quality.endOfSentenceDetectionPause",
            quality.end_of_sentence_detection_pause,
            0.1,
            5.0,
        ),
        (
            "quality.midSentenceDetectionPause",
            quality.mid_sentence_detection_pause,
            0.1,
            10.0,
        ),
        (
            "quality.unknownSentenceDetectionPause",
            quality.unknown_sentence_detection_pause,
            0.1,
            5.0,
        ),
    ] {
        validate_finite_range(path, value, min, max)?;
    }
    Ok(())
}

fn validate_audio_settings(audio: &AudioSettings) -> Result<(), String> {
    validate_optional_non_negative_i64("audio.inputDeviceIndex", audio.input_device_index)?;
    for (path, value, min, max) in [
        ("audio.sampleRate", audio.sample_rate, 8_000, 192_000),
        ("audio.bufferSize", audio.buffer_size, 64, 16_384),
        ("audio.webrtcSensitivity", audio.webrtc_sensitivity, 0, 3),
        (
            "audio.extraRecordingBufferMs",
            audio.extra_recording_buffer_ms,
            0,
            2_000,
        ),
    ] {
        validate_i64_range(path, value, min, max)?;
    }
    for (path, value, min, max) in [
        (
            "audio.sileroSensitivity",
            audio.silero_sensitivity,
            0.0,
            1.0,
        ),
        (
            "audio.postSpeechSilenceDuration",
            audio.post_speech_silence_duration,
            0.0,
            30.0,
        ),
        (
            "audio.minGapBetweenRecordings",
            audio.min_gap_between_recordings,
            0.0,
            30.0,
        ),
        (
            "audio.preRecordingBufferDuration",
            audio.pre_recording_buffer_duration,
            0.0,
            30.0,
        ),
    ] {
        validate_finite_range(path, value, min, max)?;
    }
    validate_collection_len(
        "audio.sileroSensitivityByDeviceName",
        audio.silero_sensitivity_by_device_name.len(),
        MAX_DEVICE_SENSITIVITY_ENTRIES,
    )?;
    for (device, sensitivity) in &audio.silero_sensitivity_by_device_name {
        validate_short_text(
            "audio.sileroSensitivityByDeviceName key",
            device,
            MAX_SHORT_TEXT_LEN,
            true,
        )?;
        validate_finite_range(
            &format!("audio.sileroSensitivityByDeviceName[{device}]"),
            *sensitivity,
            0.0,
            1.0,
        )?;
    }
    validate_optional_non_negative_i64("audio.clamshellMicrophone", audio.clamshell_microphone)?;
    Ok(())
}

fn validate_general_settings(general: &GeneralSettings) -> Result<(), String> {
    validate_i64_range(
        "general.systemAudioReductionWhileDictating",
        general.system_audio_reduction_while_dictating,
        0,
        100,
    )?;
    validate_recording_sound_path(&general.recording_sound_path, "general.recordingSoundPath")?;
    validate_sound_library(&general.recording_sound_library)?;
    validate_hotkey("general.repasteHotkey", &general.repaste_hotkey, true)?;
    validate_optional_non_negative_i64(
        "general.loopbackDeviceIndex",
        general.loopback_device_index,
    )?;
    validate_short_text("general.wakeWord", &general.wake_word, 64, false)?;
    validate_collection_len(
        "general.customWakeWords",
        general.custom_wake_words.len(),
        MAX_CUSTOM_WAKE_WORDS,
    )?;
    for (index, wake_word) in general.custom_wake_words.iter().enumerate() {
        validate_short_text(
            &format!("general.customWakeWords[{index}]"),
            wake_word,
            64,
            true,
        )?;
    }
    validate_finite_range(
        "general.wakeWordSensitivity",
        general.wake_word_sensitivity,
        0.0,
        1.0,
    )?;
    validate_finite_range(
        "general.wakeWordTimeout",
        general.wake_word_timeout,
        1.0,
        30.0,
    )?;
    for (path, value, min, max) in [
        (
            "general.visualizerBarCount",
            general.visualizer_bar_count,
            3,
            21,
        ),
        (
            "general.visualizerRadialDotCount",
            general.visualizer_radial_dot_count,
            6,
            48,
        ),
        (
            "general.visualizerRadialRadius",
            general.visualizer_radial_radius,
            20,
            90,
        ),
        (
            "general.visualizerGridRows",
            general.visualizer_grid_rows,
            3,
            8,
        ),
        (
            "general.visualizerGridColumns",
            general.visualizer_grid_columns,
            3,
            8,
        ),
        (
            "general.visualizerGridSpeed",
            general.visualizer_grid_speed,
            1,
            10,
        ),
        (
            "general.visualizerWaveLineWidth",
            general.visualizer_wave_line_width,
            1,
            6,
        ),
        (
            "general.visualizerWaveSmoothing",
            general.visualizer_wave_smoothing,
            0,
            100,
        ),
        (
            "general.visualizerWaveColorShift",
            general.visualizer_wave_color_shift,
            0,
            100,
        ),
        (
            "general.visualizerAuraBlur",
            general.visualizer_aura_blur,
            0,
            100,
        ),
        (
            "general.visualizerAuraBloom",
            general.visualizer_aura_bloom,
            0,
            100,
        ),
        (
            "general.visualizerAuraColorShift",
            general.visualizer_aura_color_shift,
            0,
            100,
        ),
        (
            "general.historyMaxEntries",
            general.history_max_entries,
            10,
            10_000,
        ),
    ] {
        validate_i64_range(path, value, min, max)?;
    }
    validate_context_list("general.contextAllowList", &general.context_allow_list)?;
    validate_context_list("general.contextDenyList", &general.context_deny_list)?;
    if let Some(onboarded_at) = general.onboarded_at {
        validate_i64_range("general.onboardedAt", onboarded_at, 0, i64::MAX)?;
    }
    validate_text(
        "general.outputDeviceId",
        &general.output_device_id,
        MAX_DEVICE_ID_LEN,
    )?;
    validate_finite_range(
        "general.wordCorrectionThreshold",
        general.word_correction_threshold,
        0.0,
        1.0,
    )?;
    Ok(())
}

fn validate_dictionary(dictionary: &[DictionaryEntry]) -> Result<(), String> {
    validate_collection_len("dictionary", dictionary.len(), MAX_DICTIONARY_ENTRIES)?;
    for (index, entry) in dictionary.iter().enumerate() {
        let base = format!("dictionary[{index}]");
        validate_short_text(&format!("{base}.id"), &entry.id, MAX_ID_LEN, true)?;
        validate_short_text(
            &format!("{base}.term"),
            &entry.term,
            MAX_SHORT_TEXT_LEN,
            true,
        )?;
        if let Some(replacement) = &entry.replacement {
            validate_text(
                &format!("{base}.replacement"),
                replacement,
                MAX_REPLACEMENT_LEN,
            )?;
        }
    }
    Ok(())
}

fn validate_snippets(snippets: &[SnippetEntry]) -> Result<(), String> {
    validate_collection_len("snippets", snippets.len(), MAX_SNIPPETS)?;
    for (index, entry) in snippets.iter().enumerate() {
        let base = format!("snippets[{index}]");
        validate_short_text(&format!("{base}.id"), &entry.id, MAX_ID_LEN, true)?;
        validate_short_text(
            &format!("{base}.trigger"),
            &entry.trigger,
            MAX_SHORT_TEXT_LEN,
            true,
        )?;
        validate_text(
            &format!("{base}.expansion"),
            &entry.expansion,
            MAX_SNIPPET_EXPANSION_LEN,
        )?;
        if entry.expansion.trim().is_empty() {
            return Err(format!("{base}.expansion must not be empty"));
        }
    }
    Ok(())
}

fn validate_llm_settings(llm: &LlmSettings) -> Result<(), String> {
    validate_text("llm.endpoint", &llm.endpoint, MAX_ENDPOINT_LEN)?;
    validate_text(
        "llm.openrouterApiKey",
        &llm.openrouter_api_key,
        MAX_SECRET_LEN,
    )?;
    validate_i64_range("llm.timeout", llm.timeout, 1_000, 30_000)?;
    validate_llm_feature_base("llm.dictation", &llm.dictation.base)?;
    validate_presets_len("llm.dictation.presets", &llm.dictation.presets)?;
    validate_custom_modifiers(
        "llm.dictation.customModifiers",
        &llm.dictation.custom_modifiers,
    )?;
    validate_llm_feature_base("llm.transforms", &llm.transforms.base)?;
    validate_presets_len("llm.transforms.presets", &llm.transforms.presets)?;
    validate_custom_modifiers(
        "llm.transforms.customModifiers",
        &llm.transforms.custom_modifiers,
    )?;
    validate_hotkey("llm.transforms.hotkey", &llm.transforms.hotkey, true)?;
    validate_transforms(&llm.transforms.prompts)?;
    Ok(())
}

fn validate_llm_feature_base(path: &str, base: &LlmFeatureBase) -> Result<(), String> {
    validate_model_id(&format!("{path}.model"), &base.model, false)?;
    validate_model_id(
        &format!("{path}.openrouterModel"),
        &base.openrouter_model,
        false,
    )?;
    validate_model_id(
        &format!("{path}.openrouterFallbackModel"),
        &base.openrouter_fallback_model,
        false,
    )?;
    if let Some(tokens) = base.max_output_tokens {
        validate_i64_range(
            &format!("{path}.maxOutputTokens"),
            tokens,
            1,
            MAX_OUTPUT_TOKENS,
        )?;
    }
    Ok(())
}

fn validate_custom_modifiers(path: &str, items: &[CustomModifier]) -> Result<(), String> {
    validate_collection_len(path, items.len(), MAX_CUSTOM_MODIFIERS)?;
    for (index, modifier) in items.iter().enumerate() {
        let base = format!("{path}[{index}]");
        validate_short_text(&format!("{base}.id"), &modifier.id, MAX_ID_LEN, true)?;
        validate_short_text(
            &format!("{base}.name"),
            &modifier.name,
            MAX_SHORT_TEXT_LEN,
            false,
        )?;
        validate_text(&format!("{base}.prompt"), &modifier.prompt, MAX_PROMPT_LEN)?;
    }
    Ok(())
}

fn validate_transforms(transforms: &[Transform]) -> Result<(), String> {
    validate_collection_len("llm.transforms.prompts", transforms.len(), MAX_TRANSFORMS)?;
    for (index, transform) in transforms.iter().enumerate() {
        let base = format!("llm.transforms.prompts[{index}]");
        validate_short_text(&format!("{base}.id"), &transform.id, MAX_ID_LEN, true)?;
        validate_short_text(
            &format!("{base}.name"),
            &transform.name,
            MAX_SHORT_TEXT_LEN,
            false,
        )?;
        validate_text(&format!("{base}.prompt"), &transform.prompt, MAX_PROMPT_LEN)?;
        validate_hotkey(&format!("{base}.hotkey"), &transform.hotkey, false)?;
    }
    Ok(())
}

fn validate_tts_settings(tts: &TtsSettings) -> Result<(), String> {
    if crate::winstt::tts::catalog::find(&tts.model).is_none() {
        return Err(format!(
            "tts.model is not in the TTS catalog: {}",
            tts.model
        ));
    }
    validate_model_id("tts.model", &tts.model, true)?;
    validate_short_text("tts.voice", &tts.voice, MAX_MODEL_ID_LEN, true)?;
    validate_short_text("tts.lang", &tts.lang, MAX_LANGUAGE_LEN, true)?;
    validate_finite_range("tts.speed", tts.speed, 0.5, 2.0)?;
    validate_hotkey("tts.hotkey", &tts.hotkey, true)?;
    validate_tts_cloud(&tts.cloud)?;
    Ok(())
}

fn validate_tts_cloud(cloud: &TtsCloud) -> Result<(), String> {
    validate_short_text("tts.cloud.voice", &cloud.voice, MAX_MODEL_ID_LEN, false)?;
    validate_model_id("tts.cloud.model", &cloud.model, true)?;
    validate_model_id("tts.cloud.openrouterModel", &cloud.openrouter_model, false)?;
    validate_short_text(
        "tts.cloud.openrouterVoice",
        &cloud.openrouter_voice,
        MAX_MODEL_ID_LEN,
        false,
    )?;
    validate_finite_range("tts.cloud.stability", cloud.stability, 0.0, 1.0)?;
    validate_finite_range("tts.cloud.similarity", cloud.similarity, 0.0, 1.0)?;
    validate_finite_range("tts.cloud.style", cloud.style, 0.0, 1.0)?;
    validate_finite_range("tts.cloud.speed", cloud.speed, 0.7, 1.2)?;
    Ok(())
}

fn validate_integrations(integrations: &IntegrationsSettings) -> Result<(), String> {
    validate_text(
        "integrations.elevenlabs.apiKey",
        &integrations.elevenlabs.api_key,
        MAX_SECRET_LEN,
    )?;
    if let Some(last_verified_at) = integrations.elevenlabs.last_verified_at {
        validate_i64_range(
            "integrations.elevenlabs.lastVerifiedAt",
            last_verified_at,
            0,
            i64::MAX,
        )?;
    }
    Ok(())
}

fn validate_presets_len(path: &str, presets: &[PresetEntry]) -> Result<(), String> {
    validate_collection_len(path, presets.len(), MAX_PRESETS)?;
    for (index, preset) in presets.iter().enumerate() {
        if let Some(target_lang) = &preset.target_lang {
            validate_short_text(
                &format!("{path}[{index}].targetLang"),
                target_lang,
                MAX_LANGUAGE_LEN,
                true,
            )?;
        }
    }
    Ok(())
}

fn validate_sound_library(library: &[SoundLibraryEntry]) -> Result<(), String> {
    validate_collection_len(
        "general.recordingSoundLibrary",
        library.len(),
        MAX_SOUND_LIBRARY_ENTRIES,
    )?;
    for (index, entry) in library.iter().enumerate() {
        let base = format!("general.recordingSoundLibrary[{index}]");
        validate_short_text(&format!("{base}.id"), &entry.id, MAX_ID_LEN, true)?;
        validate_short_text(
            &format!("{base}.name"),
            &entry.name,
            MAX_SHORT_TEXT_LEN,
            true,
        )?;
        validate_recording_sound_path(&entry.path, &format!("{base}.path"))?;
        if entry.path.is_empty() || entry.path.starts_with("builtin:") {
            return Err(format!(
                "{base}.path must point to a managed custom sound file"
            ));
        }
        if !has_extension(&entry.path, &["wav", "mp3"]) {
            return Err(format!("{base}.path must be a .wav or .mp3 file"));
        }
    }
    Ok(())
}

fn validate_recording_sound_path(path: &str, field: &str) -> Result<(), String> {
    validate_text(field, path, MAX_PATH_LEN)?;
    if path.is_empty() {
        return Ok(());
    }
    if let Some(file_name) = path.strip_prefix("builtin:") {
        if BUILTIN_RECORDING_SOUND_FILES.contains(&file_name) {
            return Ok(());
        }
        return Err(format!(
            "{field} is not an allowed built-in recording sound"
        ));
    }
    if has_parent_segment(path) {
        return Err(format!("{field} must not contain path traversal segments"));
    }
    if !has_extension(path, &["wav", "mp3", "ogg", "flac", "m4a", "aac"]) {
        return Err(format!("{field} must use a supported audio extension"));
    }
    Ok(())
}

fn validate_context_list(path: &str, entries: &[String]) -> Result<(), String> {
    validate_collection_len(path, entries.len(), MAX_CONTEXT_LIST_ENTRIES)?;
    for (index, entry) in entries.iter().enumerate() {
        let field = format!("{path}[{index}]");
        validate_short_text(&field, entry, MAX_CONTEXT_ENTRY_LEN, true)?;
        if entry.contains(['/', '\\']) {
            return Err(format!(
                "{field} must be an executable basename or host suffix"
            ));
        }
    }
    Ok(())
}

fn validate_quantization(model_id: &str, quantization: &str) -> Result<(), String> {
    validate_short_text(
        "model.onnxQuantization",
        quantization,
        MAX_SHORT_TEXT_LEN,
        false,
    )?;
    let quant = quantization.trim();
    if quant != quantization {
        return Err(
            "model.onnxQuantization must not contain leading or trailing whitespace".into(),
        );
    }
    const KNOWN_QUANTIZATIONS: &[&str] = &[
        "", "auto", "fp16", "fp16w", "q4", "q4f16", "bnb4", "int8", "uint8",
    ];
    if !KNOWN_QUANTIZATIONS.contains(&quant) {
        return Err(format!("unknown model.onnxQuantization: {quant}"));
    }
    if quant.is_empty() || quant == "auto" {
        return Ok(());
    }
    if let Some(entry) = crate::winstt::catalog::find(model_id) {
        if !entry.available_quantizations.contains(&quant) {
            return Err(format!(
                "model.onnxQuantization '{quant}' is not available for model '{}'",
                entry.id
            ));
        }
    }
    Ok(())
}

fn validate_model_id(path: &str, value: &str, required: bool) -> Result<(), String> {
    validate_short_text(path, value, MAX_MODEL_ID_LEN, required)?;
    if value.is_empty() {
        return Ok(());
    }
    if value.trim() != value {
        return Err(format!(
            "{path} must not contain leading or trailing whitespace"
        ));
    }
    if value.contains("..") || value.contains('\\') || value.contains("://") {
        return Err(format!("{path} has an invalid model id format"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | ':' | '@'))
    {
        return Err(format!("{path} contains unsupported model id characters"));
    }
    if let Some((provider, bare_id)) = crate::winstt::cloud_stt::split_model_id(value) {
        if bare_id.is_empty() {
            return Err(format!("{path} cloud model id is missing a provider model"));
        }
        if provider == crate::winstt::cloud_stt::CloudSttProvider::ElevenLabs
            && !crate::winstt::cloud_stt::cloud_models_for(provider)
                .iter()
                .any(|model| model.id == bare_id)
        {
            return Err(format!("{path} is not in the ElevenLabs STT catalog"));
        }
    }
    Ok(())
}

fn validate_hotkey(path: &str, value: &str, required: bool) -> Result<(), String> {
    validate_short_text(path, value, MAX_HOTKEY_LEN, required)?;
    if value.is_empty() {
        return Ok(());
    }
    if value.trim() != value {
        return Err(format!(
            "{path} must not contain leading or trailing whitespace"
        ));
    }
    let mut seen = Vec::<String>::new();
    let tokens: Vec<&str> = value.split('+').collect();
    if tokens.len() > 8 {
        return Err(format!("{path} has too many key parts"));
    }
    for token in tokens {
        let token = token.trim();
        if token.is_empty() {
            return Err(format!("{path} contains an empty key part"));
        }
        if token.len() > 32 || !is_supported_hotkey_token(token) {
            return Err(format!("{path} contains unsupported key token '{token}'"));
        }
        let normalized = token.to_ascii_lowercase();
        if seen.iter().any(|existing| existing == &normalized) {
            return Err(format!("{path} contains duplicate key token '{token}'"));
        }
        seen.push(normalized);
    }
    Ok(())
}

fn is_supported_hotkey_token(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "lctrl"
            | "rctrl"
            | "ctrl"
            | "control"
            | "lshift"
            | "rshift"
            | "shift"
            | "lalt"
            | "ralt"
            | "alt"
            | "altgr"
            | "lmeta"
            | "rmeta"
            | "meta"
            | "super"
            | "win"
            | "windows"
            | "cmd"
            | "command"
            | "space"
            | "tab"
            | "enter"
            | "return"
            | "escape"
            | "esc"
            | "backspace"
            | "delete"
            | "forwarddelete"
            | "insert"
            | "home"
            | "end"
            | "pageup"
            | "pagedown"
            | "arrowleft"
            | "arrowright"
            | "arrowup"
            | "arrowdown"
    ) || is_function_key(&lower)
        || (token.len() == 1 && token.chars().all(|c| c.is_ascii_graphic() && c != '+'))
}

fn is_function_key(token: &str) -> bool {
    let Some(number) = token.strip_prefix('f') else {
        return false;
    };
    matches!(number.parse::<u8>(), Ok(1..=24))
}

fn validate_text(path: &str, value: &str, max_len: usize) -> Result<(), String> {
    if value.len() > max_len {
        return Err(format!("{path} must be at most {max_len} bytes"));
    }
    if value.contains('\0') {
        return Err(format!("{path} must not contain NUL bytes"));
    }
    Ok(())
}

fn validate_short_text(
    path: &str,
    value: &str,
    max_len: usize,
    required: bool,
) -> Result<(), String> {
    validate_text(path, value, max_len)?;
    if value.chars().any(char::is_control) {
        return Err(format!("{path} must not contain control characters"));
    }
    if required && value.trim().is_empty() {
        return Err(format!("{path} must not be empty"));
    }
    Ok(())
}

fn validate_collection_len(path: &str, len: usize, max_len: usize) -> Result<(), String> {
    if len > max_len {
        return Err(format!("{path} has {len} entries; maximum is {max_len}"));
    }
    Ok(())
}

fn validate_i64_range(path: &str, value: i64, min: i64, max: i64) -> Result<(), String> {
    if value < min || value > max {
        return Err(format!("{path} must be between {min} and {max}"));
    }
    Ok(())
}

fn validate_optional_non_negative_i64(path: &str, value: Option<i64>) -> Result<(), String> {
    if let Some(value) = value {
        validate_i64_range(path, value, 0, i64::MAX)?;
    }
    Ok(())
}

fn validate_finite_range(path: &str, value: f64, min: f64, max: f64) -> Result<(), String> {
    if !value.is_finite() || value < min || value > max {
        return Err(format!(
            "{path} must be a finite number between {min} and {max}"
        ));
    }
    Ok(())
}

fn has_extension(path: &str, allowed: &[&str]) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            let ext = ext.to_ascii_lowercase();
            allowed.iter().any(|allowed| *allowed == ext)
        })
        .unwrap_or(false)
}

fn has_parent_segment(path: &str) -> bool {
    path.split(['/', '\\']).any(|part| part == "..")
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
    // `super::*` already brings in PresetKey / PresetEntry / LiveTranscriptionDisplay /
    // WinsttSettings (imported at module top). `RecordingMode` is only referenced by
    // these tests now (the runtime/wakeword code that used it moved to siblings), so it
    // is imported here rather than at module scope (avoids an unused non-test import).
    use super::*;
    use crate::winstt::settings_schema::RecordingMode;

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

    fn assert_validation_error(settings: WinsttSettings, expected: &str) {
        let err = validate_settings(&settings).unwrap_err();
        assert!(
            err.contains(expected),
            "expected validation error containing '{expected}', got '{err}'"
        );
    }

    #[test]
    fn validates_default_settings() {
        assert!(validate_settings(&WinsttSettings::default()).is_ok());
    }

    #[test]
    fn accepts_frontend_auto_quantization_default() {
        let mut settings = WinsttSettings::default();
        settings.model.onnx_quantization = "auto".into();
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn rejects_malformed_model_id() {
        let mut settings = WinsttSettings::default();
        settings.model.model = "https://example.com/model.onnx".into();
        assert_validation_error(settings, "model.model");
    }

    #[test]
    fn rejects_unpublished_catalog_quantization() {
        let mut settings = WinsttSettings::default();
        settings.model.model = "tiny".into();
        settings.model.onnx_quantization = "int8".into();
        assert_validation_error(settings, "model.onnxQuantization");
    }

    #[test]
    fn accepts_dynamic_openrouter_cloud_stt_id() {
        let mut settings = WinsttSettings::default();
        settings.model.model = "openrouter:microsoft/mai-transcribe-1.5".into();
        settings.model.onnx_quantization = "auto".into();
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn rejects_unknown_elevenlabs_cloud_stt_id() {
        let mut settings = WinsttSettings::default();
        settings.model.model = "elevenlabs:not_real".into();
        assert_validation_error(settings, "ElevenLabs STT catalog");
    }

    #[test]
    fn rejects_unknown_tts_model() {
        let mut settings = WinsttSettings::default();
        settings.tts.model = "not-a-tts-model".into();
        assert_validation_error(settings, "tts.model");
    }

    #[test]
    fn rejects_malformed_hotkey() {
        let mut settings = WinsttSettings::default();
        settings.tts.hotkey = "LCtrl++Space".into();
        assert_validation_error(settings, "tts.hotkey");
    }

    #[test]
    fn rejects_oversized_dictionary() {
        let settings = WinsttSettings {
            dictionary: (0..=MAX_DICTIONARY_ENTRIES)
                .map(|index| DictionaryEntry {
                    id: format!("dict-{index}"),
                    term: "WinSTT".into(),
                    auto_added: None,
                    replacement: None,
                })
                .collect(),
            ..Default::default()
        };
        assert_validation_error(settings, "dictionary");
    }

    #[test]
    fn rejects_invalid_recording_sound_builtin() {
        let mut settings = WinsttSettings::default();
        settings.general.recording_sound_path = "builtin:../recording_sound_default.wav".into();
        assert_validation_error(settings, "recordingSoundPath");
    }

    #[test]
    fn rejects_out_of_range_numeric_setting() {
        let mut settings = WinsttSettings::default();
        settings.quality.smart_endpoint_speed = f64::NAN;
        assert_validation_error(settings, "quality.smartEndpointSpeed");
    }

    #[test]
    fn rejects_context_entries_with_path_separators() {
        let mut settings = WinsttSettings::default();
        settings.general.context_deny_list = vec!["C:/secret/app.exe".into()];
        assert_validation_error(settings, "contextDenyList");
    }

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
