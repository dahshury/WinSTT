// Store I/O + secret seal/open/mask/preserve + cross-field normalization +
// seed_defaults. The on-disk layer every reader/writer funnels through.

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use super::{SECRET_PRESENT_SENTINEL, WINSTT_SETTINGS_FILE, WINSTT_SETTINGS_KEY};
use crate::winstt::commands::secret_storage::{try_decrypt_secret, try_encrypt_secret};
use crate::winstt::settings_schema::{RecordingMode, WinsttSettings};

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

pub(super) fn try_read_settings(app: &AppHandle) -> Result<WinsttSettings, String> {
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

pub(super) fn word_by_word_pasting_effective(settings: &WinsttSettings) -> bool {
    settings.general.word_by_word_pasting
}

pub(super) fn normalize_cross_field_settings(settings: &mut WinsttSettings) {
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
pub(super) fn try_seal_secrets(settings: &mut WinsttSettings) -> Result<(), String> {
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

pub(super) fn sanitize_settings_for_renderer(settings: &mut WinsttSettings) {
    mask_secret_for_renderer(&mut settings.llm.openrouter_api_key);
    mask_secret_for_renderer(&mut settings.integrations.openai.api_key);
    mask_secret_for_renderer(&mut settings.integrations.elevenlabs.api_key);
}

fn preserve_masked_secret(previous: &str, next: &mut String) {
    if next == SECRET_PRESENT_SENTINEL {
        *next = previous.to_string();
    }
}

pub(super) fn preserve_masked_secrets(previous: &WinsttSettings, next: &mut WinsttSettings) {
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
pub(super) fn write_settings_value(
    app: &AppHandle,
    settings: &WinsttSettings,
) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "windows")]
    use crate::winstt::commands::secret_storage::is_encrypted;

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
}
