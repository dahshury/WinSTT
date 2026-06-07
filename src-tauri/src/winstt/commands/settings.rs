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
    is_secret, AudioSettings, DictionaryEntry, GeneralSettings, GlobalSettings, HotkeySettings,
    IntegrationsSettings, LiveTranscriptionDisplay, LlmSettings, ModelSettings, PresetEntry,
    PresetKey, QualitySettings, SnippetEntry, TtsSettings, WinsttSettings, SECRET_KEYS,
};

use self::persistence::{
    normalize_cross_field_settings, preserve_masked_secrets, sanitize_settings_for_renderer,
    try_read_settings, try_seal_secrets, word_by_word_pasting_effective, write_settings_value,
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
pub use self::persistence::{read_settings, recording_mode, seed_defaults};
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
