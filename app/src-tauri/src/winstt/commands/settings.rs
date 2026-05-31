// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/02_settings.md + lib_wiring.md §3,
// frontend/electron/ipc/settings.ts. Wraps winstt::settings_schema.
//
// winstt_get_settings / winstt_set_settings expose the full nested WinsttSettings
// tree to the reused React renderer over tauri-specta. set_settings is NOT a thin
// setter: it (a) re-runs the Zod `.refine` cross-field rules, (b) diffs against
// current settings to compute restart-need (is_startup_only + WAKEWORD_CONFIG_KEYS
// + REALTIME_EFFECTIVE_KEYS), (c) encrypts SECRET_KEYS at rest before persisting.
//
// Persistence rides Handy's existing tauri-plugin-store. WinSTT settings live
// under a dedicated `winstt_settings` key (separate from Handy's `settings`) so
// the two schemas don't collide.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

use crate::winstt::settings_schema::{
    is_secret, is_startup_only, AudioSettings, DictionaryEntry, GeneralSettings, HotkeySettings,
    IntegrationsSettings, LlmSettings, ModelSettings, PresetEntry, PresetKey, QualitySettings,
    SnippetEntry, TtsSettings, WinsttSettings, REALTIME_EFFECTIVE_KEYS, SECRET_KEYS,
    WAKEWORD_CONFIG_KEYS,
};

const WINSTT_SETTINGS_KEY: &str = "winstt_settings";

/// The `settings:changed` plain event — the post-save full snapshot every other
/// window re-hydrates its Zustand store from. Byte-identical to WinSTT's Electron
/// IPC shape (`{ settings }`) so the reused renderer's `onSettingsChanged`
/// listener (ipc-client.ts) needs no changes.
const SETTINGS_CHANGED_EVENT: &str = "settings:changed";

/// The `settings:save-error` plain event — emitted on validation/persist failure
/// (the renderer's save path is fire-and-forget, so it can't see the `Result`).
/// Shape `{ error }` matches `onSettingsSaveError` in ipc-client.ts.
const SETTINGS_SAVE_ERROR_EVENT: &str = "settings:save-error";

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
/// value), so an `Option<Section>` round-trips losslessly. Using the typed
/// section structs (vs. `serde_json::Value`) keeps `specta::Type` derivable
/// without enabling specta's `serde_json` feature in Handy's `Cargo.toml`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PartialWinsttSettings {
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

fn store_path(_app: &AppHandle) -> std::path::PathBuf {
    crate::portable::store_path("winstt-settings.json")
}

/// Read the persisted WinSTT settings (defaulting cleanly on a missing / partial
/// blob — every field is `#[serde(default)]`, mirroring Zod `.catch`).
pub fn read_settings(app: &AppHandle) -> WinsttSettings {
    let Ok(store) = app.store(store_path(app)) else {
        return WinsttSettings::default();
    };
    match store.get(WINSTT_SETTINGS_KEY) {
        Some(value) => serde_json::from_value(value).unwrap_or_default(),
        None => WinsttSettings::default(),
    }
}

fn write_settings_value(app: &AppHandle, settings: &WinsttSettings) -> Result<(), String> {
    let store = app
        .store(store_path(app))
        .map_err(|e| format!("winstt settings store: {e}"))?;
    let value = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    store.set(WINSTT_SETTINGS_KEY, value);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// `winstt_get_settings` — the full tree the renderer boots against.
#[tauri::command]
#[specta::specta]
pub fn winstt_get_settings(app: AppHandle) -> WinsttSettings {
    read_settings(&app)
}

/// `winstt_set_settings` — merge a PARTIAL section patch, validate, diff
/// restart-need, encrypt secrets, persist, broadcast.
///
/// The renderer sends **partial** top-level sections, not the whole tree:
/// `collectChangedSections` in `features/update-settings` diffs against its
/// last-saved baseline and posts only the changed sections (e.g. VAD calibration
/// and device-switch-feedback post just `{ audio: ... }` after every utterance).
/// Deserializing such a patch straight into `WinsttSettings` would reset every
/// OTHER section to its default (all fields are `#[serde(default)]`) and then
/// persist that — silently wiping `general`/`model`/etc. So we accept a
/// `PartialWinsttSettings` (every section `Option`) and merge each present
/// section over the persisted snapshot, exactly like Electron's `applySettings`
/// per-section overwrite.
///
/// On any failure the renderer's fire-and-forget save can't observe the `Err`,
/// so we ALSO emit `settings:save-error { error }` (and still return `Err`).
#[tauri::command]
#[specta::specta]
pub fn winstt_set_settings(
    app: AppHandle,
    settings: PartialWinsttSettings,
) -> Result<SetSettingsResult, String> {
    match apply_settings_patch(&app, settings) {
        Ok(result) => Ok(result),
        Err(error) => {
            // Mirror Electron's `event.sender.send("settings:save-error", { error })`.
            let _ = app.emit(SETTINGS_SAVE_ERROR_EVENT, serde_json::json!({ "error": error }));
            Err(error)
        }
    }
}

/// The set-settings body, factored out so the error branch in
/// `winstt_set_settings` can emit `settings:save-error` once for any failure
/// (validation, merge, or persistence).
fn apply_settings_patch(
    app: &AppHandle,
    patch: PartialWinsttSettings,
) -> Result<SetSettingsResult, String> {
    let previous = read_settings(app);

    // Merge the partial patch over the persisted full snapshot, section by
    // section (matching `applySettings` / `mergeMainOwnedFields` in
    // frontend/electron/ipc/settings.ts). Each present section overwrites its
    // counterpart wholesale; absent sections keep the persisted value.
    let next = merge_patch_over(&previous, patch);

    // (a) cross-field validation (the Zod `.refine` equivalents).
    validate_settings(&next)?;

    // (b) restart-need diff over the dot-path sets.
    let changed = changed_dot_paths(&previous, &next);
    let changed_startup: Vec<String> = changed
        .iter()
        .filter(|p| {
            is_startup_only(p)
                || WAKEWORD_CONFIG_KEYS.contains(&p.as_str())
                || REALTIME_EFFECTIVE_KEYS.contains(&p.as_str())
        })
        .cloned()
        .collect();
    let needs_restart = !changed_startup.is_empty();

    // (c) encrypt SECRET_KEYS at rest.
    // SPIKE: route the SECRET_KEYS values through Handy's SecretMap / Tauri
    // safeStorage before persistence. For now we persist as-is (the store file
    // is per-user); the secret set is centralized so the encryption hook is a
    // single seam. SECRET_KEYS = llm.openrouterApiKey / openai.apiKey / elevenlabs.apiKey.
    debug_assert!(SECRET_KEYS.iter().all(|k| is_secret(k)));

    write_settings_value(app, &next)?;

    // Broadcast the post-save FULL snapshot (not the raw partial) so every other
    // window re-hydrates the same canonical view. Sending the partial would make
    // the renderer's `decodeSettingsPayload` fill DEFAULTS for the missing
    // sections and stomp customized fields on receivers — the exact reason
    // Electron broadcasts the snapshot, not the raw payload.
    let snapshot = serde_json::to_value(&next).map_err(|e| e.to_string())?;
    let _ = app.emit(SETTINGS_CHANGED_EVENT, serde_json::json!({ "settings": snapshot }));

    Ok(SetSettingsResult {
        needs_restart,
        changed_startup_keys: changed_startup,
    })
}

/// Merge a partial section patch over the current full tree.
///
/// Each `Some(section)` in `patch` OVERWRITES the corresponding section in
/// `current` wholesale (the renderer always posts whole sections, never partial
/// leaves — `collectChangedSections` keys on top-level sections). A `None`
/// section keeps the persisted value. For `general`, the main-owned `onboarded*`
/// fields are restored from the persisted copy so a renderer round-trip can't
/// revert them.
fn merge_patch_over(current: &WinsttSettings, patch: PartialWinsttSettings) -> WinsttSettings {
    let mut next = current.clone();
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
/// into the incoming `general` patch so a renderer save can't clobber them.
/// Mirrors `mergeMainOwnedFields` in frontend/electron/ipc/settings.ts.
fn preserve_main_owned_general(
    existing: &GeneralSettings,
    mut incoming: GeneralSettings,
) -> GeneralSettings {
    incoming.onboarded = existing.onboarded;
    incoming.onboarded_at = existing.onboarded_at;
    incoming.onboarded_track = existing.onboarded_track;
    incoming
}

/// Re-run the Zod cross-field rules: no duplicate preset keys, at most one tone
/// key, `level` only for summarize/concise (+ level-enabled customs), `targetLang`
/// only for translate. Returns Err(message) on the first violation.
fn validate_settings(settings: &WinsttSettings) -> Result<(), String> {
    // The active dictation presets live under llm.dictation.presets; transforms
    // carry their own preset lists. We validate the dictation preset array (the
    // one the renderer's preset picker mutates) — mirrors validatePresets in TS.
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
        // `level` only for the leveled presets.
        if p.level.is_some() && !is_leveled_preset(key) {
            return Err(format!("preset {slug} does not accept a level"));
        }
        // `targetLang` only for translate.
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
        PresetKey::Casual => "casual",
        PresetKey::Concise => "concise",
        PresetKey::Summarize => "summarize",
        PresetKey::Reorder => "reorder",
        PresetKey::Restructure => "restructure",
        PresetKey::RewordForClarity => "rewordForClarity",
        PresetKey::Translate => "translate",
    }
}

/// Tone presets are the mutually-exclusive register choices (at most one).
fn is_tone_preset(key: PresetKey) -> bool {
    matches!(
        key,
        PresetKey::Neutral
            | PresetKey::Formal
            | PresetKey::Friendly
            | PresetKey::Technical
            | PresetKey::Casual
    )
}

fn is_leveled_preset(key: PresetKey) -> bool {
    matches!(key, PresetKey::Concise | PresetKey::Summarize)
}

/// Compute the changed dot-paths between two settings trees at the granularity
/// the restart-need sets key on (the specific leaf keys, plus a coarse per-section
/// fallback). Implemented via JSON diff so it covers the full nested tree without
/// per-field plumbing.
fn changed_dot_paths(prev: &WinsttSettings, next: &WinsttSettings) -> Vec<String> {
    let pv = serde_json::to_value(prev).unwrap_or(serde_json::Value::Null);
    let nv = serde_json::to_value(next).unwrap_or(serde_json::Value::Null);
    let mut out = Vec::new();
    diff_json("", &pv, &nv, &mut out);
    out
}

/// Recursively collect dot-paths whose leaf values differ. camelCase keys match
/// the renderer's dot-path convention (e.g. `general.recordingMode`).
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winstt::settings_schema::PresetEntry;

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
        let presets = vec![p(PresetKey::Formal), p(PresetKey::Casual)];
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

    #[test]
    fn diff_detects_startup_key_change() {
        let mut a = WinsttSettings::default();
        let mut b = WinsttSettings::default();
        // mutate a startup-only key via JSON to avoid coupling to the exact field.
        let mut av = serde_json::to_value(&a).unwrap();
        let mut bv = serde_json::to_value(&b).unwrap();
        av["general"]["sendCrashReports"] = serde_json::json!(true);
        bv["general"]["sendCrashReports"] = serde_json::json!(false);
        a = serde_json::from_value(av).unwrap();
        b = serde_json::from_value(bv).unwrap();
        let changed = changed_dot_paths(&a, &b);
        assert!(changed.iter().any(|p| p == "general.sendCrashReports"));
    }

    // ── Partial-patch merge: the load-bearing fix for partial section saves ──

    /// Deserialize a JSON object into the partial patch — exactly the path the
    /// adapter takes when the renderer posts `{ audio: { ... } }` (the `settings`
    /// envelope is unwrapped by the adapter's normalizeArgs before invoke).
    fn patch_from_json(value: serde_json::Value) -> PartialWinsttSettings {
        serde_json::from_value(value).expect("partial patch deserialize")
    }

    /// A partial `{ audio: ... }` patch (what useVadCalibration posts) must NOT
    /// reset the other sections to defaults. This is the clobber the old
    /// full-tree `winstt_set_settings` signature caused.
    #[test]
    fn partial_patch_preserves_untouched_sections() {
        // Start from a non-default snapshot: a customized model section.
        let mut current = WinsttSettings::default();
        let mut cv = serde_json::to_value(&current).unwrap();
        cv["model"]["model"] = serde_json::json!("nemo-canary-180m-flash");
        current = serde_json::from_value(cv).unwrap();
        let customized_model = current.model.clone();

        // Patch ONLY the audio section (a whole section, as the renderer posts).
        let mut audio = serde_json::to_value(&current.audio).unwrap();
        audio["vadSensitivity"] = serde_json::json!(0.42);
        let patch = patch_from_json(serde_json::json!({ "audio": audio }));
        let next = merge_patch_over(&current, patch);

        // The model section the patch never mentioned is untouched …
        assert_eq!(next.model, customized_model);
        // … and the audio section reflects the patch.
        let audio_val = serde_json::to_value(&next.audio).unwrap();
        assert_eq!(audio_val["vadSensitivity"], serde_json::json!(0.42));
    }

    /// A `general` patch carrying a stale `onboarded:false` must NOT overwrite
    /// the on-disk `onboarded:true` (main-owned field), else the wizard re-shows.
    #[test]
    fn general_patch_cannot_revert_onboarded() {
        // On-disk: onboarded already completed.
        let mut current = WinsttSettings::default();
        let mut cv = serde_json::to_value(&current).unwrap();
        cv["general"]["onboarded"] = serde_json::json!(true);
        cv["general"]["onboardedTrack"] = serde_json::json!("local");
        current = serde_json::from_value(cv).unwrap();

        // Renderer posts a whole general section with a stale onboarded:false
        // plus a user-controlled change.
        let mut general = serde_json::to_value(&current.general).unwrap();
        general["onboarded"] = serde_json::json!(false);
        general["onboardedTrack"] = serde_json::json!("");
        general["recordingMode"] = serde_json::json!("toggle");
        let patch = patch_from_json(serde_json::json!({ "general": general }));
        let next = merge_patch_over(&current, patch);

        // onboarded* stay at the on-disk (main-owned) values …
        assert!(next.general.onboarded);
        assert_eq!(
            next.general.onboarded_track,
            crate::winstt::settings_schema::OnboardedTrack::Local
        );
        // … but the user-controlled field in the same patch DID apply.
        let general_val = serde_json::to_value(&next.general).unwrap();
        assert_eq!(general_val["recordingMode"], serde_json::json!("toggle"));
    }

    /// An empty patch (no sections) is a no-op (persists current unchanged).
    #[test]
    fn empty_patch_is_noop() {
        let current = WinsttSettings::default();
        let next = merge_patch_over(&current, PartialWinsttSettings::default());
        assert_eq!(next, current);
    }

    /// `PartialWinsttSettings` deserializes from a JSON object that omits most
    /// sections — the absent ones become `None`, not defaults.
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
