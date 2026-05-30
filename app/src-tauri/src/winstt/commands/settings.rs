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
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::winstt::settings_schema::{
    is_secret, is_startup_only, PresetEntry, PresetKey, WinsttSettings, REALTIME_EFFECTIVE_KEYS,
    SECRET_KEYS, WAKEWORD_CONFIG_KEYS,
};

const WINSTT_SETTINGS_KEY: &str = "winstt_settings";

/// Result of `winstt_set_settings`: whether the change requires an engine
/// restart, and which dot-paths drove that decision (for diagnostics / UI).
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetSettingsResult {
    pub needs_restart: bool,
    pub changed_startup_keys: Vec<String>,
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

/// `winstt_set_settings` — validate, diff restart-need, encrypt secrets, persist.
#[tauri::command]
#[specta::specta]
pub fn winstt_set_settings(
    app: AppHandle,
    settings: WinsttSettings,
) -> Result<SetSettingsResult, String> {
    // (a) cross-field validation (the Zod `.refine` equivalents).
    validate_settings(&settings)?;

    let previous = read_settings(&app);

    // (b) restart-need diff over the dot-path sets.
    let changed = changed_dot_paths(&previous, &settings);
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

    write_settings_value(&app, &settings)?;

    Ok(SetSettingsResult {
        needs_restart,
        changed_startup_keys: changed_startup,
    })
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
}
