// CORE settings service: store I/O + secret seal/open/mask/preserve + cross-field
// normalization + seed_defaults. The on-disk layer every reader/writer funnels
// through.
//
// DEPENDENCY DIRECTION: this is a service-tier module (sits below both the
// `winstt::commands` route layer and the `winstt::managers` / app-level service
// layer). Managers and commands BOTH depend DOWNWARD on it for settings reads —
// the hot recording loops and the legacy app code no longer read settings through
// a route-layer command module. It depends only on the pure-logic tiers
// (`settings_schema`, `secret_storage`, `sync_ext`) and the legacy `crate::settings`
// core; it never reaches back up into commands/managers.

use std::sync::{Arc, Mutex, OnceLock};

use tauri::AppHandle;
use tauri_plugin_store::{Store, StoreExt};

use crate::winstt::commands::secret_storage::{try_decrypt_secret, try_encrypt_secret};
use crate::winstt::settings_schema::{RecordingMode, WinsttSettings};
use crate::winstt::sync_ext::MutexExt;

/// Persisted store key for the full WinSTT settings tree. `pub` because the
/// onboarding command writes the tree directly under this key.
pub const WINSTT_SETTINGS_KEY: &str = "winstt_settings";
/// The settings store file name (under the portable data dir).
pub(crate) const WINSTT_SETTINGS_FILE: &str = "winstt-settings.json";
/// Renderer-facing sentinel substituted for any non-empty secret so the renderer
/// can know a secret exists without receiving its plaintext.
pub(crate) const SECRET_PRESENT_SENTINEL: &str = "__WINSTT_SECRET_PRESENT__";

fn store_path() -> std::path::PathBuf {
    crate::portable::store_path(WINSTT_SETTINGS_FILE)
}

/// Process-wide cached handle to the `winstt-settings.json` store.
///
/// LOAD-BEARING FOR SOUNDNESS (not merely a speed cache): the `StoreExt::store`
/// constructor (`tauri_plugin_store::StoreBuilder::new`, store.rs:58) clones the
/// `AppHandle` on every call. On the Wry runtime that clone clones tao's non-`Send`
/// `Rc<EventLoopRunner>`. The hot recording loops read settings every ~10ms from
/// BACKGROUND threads (the PTT release watchdog and the realtime tick loop), so calling
/// `app.store(..)` there raced the main event loop's `Rc` refcount and tripped a
/// `hint::assert_unchecked` UB precondition inside `Rc::inc_strong` — an unrecoverable
/// `panic_nounwind` abort (observed crash in `winstt-ptt-release-watchdog` /
/// `realtime_manager::process_tick`).
///
/// The `Arc<Store>` is built ONCE on the MAIN thread (`init_settings_store`, from the
/// tauri setup hook). Every later access reuses the cached Arc, and the `Store::{get,
/// set,save}` methods only touch the in-memory cache, `fs::write` the file, or `emit`
/// over the Send proxy channel — none re-clone the `AppHandle` — so they are safe to
/// call from any thread.
static SETTINGS_STORE: OnceLock<Arc<Store<tauri::Wry>>> = OnceLock::new();

/// Build + cache the settings store handle on the MAIN thread. MUST be called once from
/// the tauri setup hook BEFORE any background thread (the spawned startup thread, the
/// realtime worker, the PTT watchdog) reads settings, so every off-thread caller stays
/// on the cached (clone-free) path. Idempotent.
pub fn init_settings_store(app: &AppHandle) {
    if SETTINGS_STORE.get().is_some() {
        return;
    }
    match app.store(store_path()) {
        Ok(store) => {
            let _ = SETTINGS_STORE.set(store);
        }
        Err(err) => {
            log::error!("[settings] failed to initialize settings store handle: {err}");
        }
    }
}

/// Resolve the cached settings store, falling back to building it on first use. The
/// fallback still clones the `AppHandle` once, so `init_settings_store` MUST run on the
/// main thread first to keep every off-thread caller off the unsound clone path.
fn settings_store(app: &AppHandle) -> Result<Arc<Store<tauri::Wry>>, String> {
    if let Some(store) = SETTINGS_STORE.get() {
        return Ok(Arc::clone(store));
    }
    let store = app
        .store(store_path())
        .map_err(|err| format!("winstt settings store: {err}"))?;
    let _ = SETTINGS_STORE.set(Arc::clone(&store));
    Ok(store)
}

/// Process-wide serializer for every read-modify-write of `winstt-settings.json`.
///
/// All four mutating paths are unguarded read→merge→write spans over the SAME store
/// key from different threads — the renderer's per-utterance `{audio}` patch, the
/// LLM learning thread's `{dictation}` appends, the TTS pool, the legacy per-field
/// setters, and the reader-backfill in `settings::store::get_settings`. Without a
/// lock two interleaving patches read the same `previous`, each grafts only its own
/// section, and whichever writes last silently drops the other's section. Holding
/// this lock across the full read+merge+seal+write makes each mutation atomic w.r.t.
/// the others (`tauri_plugin_store` gives no such guarantee for compound RMW).
///
/// LOCK ORDERING (no nested settings-lock acquisition):
///   * The guard wraps ONLY the read+merge+seal+write critical section. Runtime
///     side-effects in `apply_settings_patch` (`apply_*_runtime_settings`, which
///     themselves call `get_settings` / `read_settings`) and the renderer broadcast
///     run AFTER the guard is dropped.
///   * `write_core_settings` re-reads the live tree UNDER the lock and grafts only
///     `core`, so a legacy setter can never lose a renderer-owned section.
///   * `settings::store::get_settings` computes its backfill lock-free, then persists
///     it through `write_core_settings` (a single lock acquisition), so the reader's
///     backfill write can't lose a concurrently-written section and never re-enters.
static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Run `f` with the process-wide settings write lock held. `MutexExt::lock_recover`
/// keeps a panic mid-write from poisoning every later settings write into a wedge.
///
/// `pub(crate)` so `apply_settings_patch` (commands::settings) can wrap its own
/// read+merge+seal+write span in the SAME lock. Do NOT call from within an already
/// guarded span — `std::sync::Mutex` is non-reentrant and would deadlock.
pub(crate) fn with_settings_write_lock<R>(f: impl FnOnce() -> R) -> R {
    let _guard = SETTINGS_WRITE_LOCK.lock_recover();
    f()
}

/// Read the persisted WinSTT settings with secrets OPENED to plaintext.
///
/// This is the single read path every consumer uses (managers for LLM / cloud-STT /
/// verify read API keys straight off the returned struct). Renderer-facing commands
/// must use `read_settings_for_renderer` instead of masking this internal view.
/// The on-disk store holds the sealed `enc:v1:` envelopes; legacy plaintext (no
/// prefix) passes through unchanged.
///
/// Defaults cleanly on a missing / partial blob — every field is `#[serde(default)]`,
/// mirroring Zod `.catch`.
pub fn read_settings(app: &AppHandle) -> WinsttSettings {
    match try_read_settings_raw(app) {
        Ok(mut settings) => {
            if let Err(err) = try_open_secrets_fail_closed(&mut settings) {
                log::warn!(
                    "[settings] failed to open WinSTT settings secrets; returning settings with secrets cleared: {err}"
                );
            }
            settings
        }
        Err(err) => {
            log::warn!("[settings] failed to read WinSTT settings: {err}");
            WinsttSettings::default()
        }
    }
}

pub(crate) fn try_read_settings(app: &AppHandle) -> Result<WinsttSettings, String> {
    let mut settings = try_read_settings_raw(app)?;
    try_open_secrets(&mut settings)?;
    Ok(settings)
}

/// Read the settings for renderer IPC.
///
/// This path masks every non-empty secret value after a best-effort open attempt,
/// so the renderer can keep showing "a secret exists" without receiving plaintext
/// or an encrypted envelope.
pub(crate) fn read_settings_for_renderer(app: &AppHandle) -> WinsttSettings {
    match try_read_settings_raw(app) {
        Ok(mut settings) => {
            if let Err(err) = try_open_secrets(&mut settings) {
                log::warn!(
                    "[settings] failed to open WinSTT settings secrets for renderer; masking stored secret markers: {err}"
                );
            }
            sanitize_settings_for_renderer(&mut settings);
            settings
        }
        Err(err) => {
            log::warn!("[settings] failed to read WinSTT settings for renderer: {err}");
            let mut settings = WinsttSettings::default();
            sanitize_settings_for_renderer(&mut settings);
            settings
        }
    }
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
    let store = settings_store(app)?;
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

pub(crate) fn word_by_word_pasting_effective(settings: &WinsttSettings) -> bool {
    settings.general.word_by_word_pasting
}

pub(crate) fn normalize_cross_field_settings(settings: &mut WinsttSettings) {
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

/// Open (decrypt) the secret fields on a settings tree in place. Idempotent
/// on already-plaintext values (legacy passthrough). Covers the three
/// renderer-facing string secrets AND the embedded `core.post_process_api_keys`
/// SecretMap (the legacy post-processing LLM keys, now single-store + sealed).
fn try_open_secrets(settings: &mut WinsttSettings) -> Result<(), String> {
    settings.llm.openrouter_api_key = try_decrypt_secret(&settings.llm.openrouter_api_key)?;
    settings.integrations.elevenlabs.api_key =
        try_decrypt_secret(&settings.integrations.elevenlabs.api_key)?;
    for value in settings.core.post_process_api_keys.values_mut() {
        *value = try_decrypt_secret(value)?;
    }
    Ok(())
}

fn try_open_secrets_fail_closed(settings: &mut WinsttSettings) -> Result<(), String> {
    match try_open_secrets(settings) {
        Ok(()) => Ok(()),
        Err(err) => {
            clear_secret_fields(settings);
            Err(err)
        }
    }
}

fn clear_secret_fields(settings: &mut WinsttSettings) {
    settings.llm.openrouter_api_key.clear();
    settings.integrations.elevenlabs.api_key.clear();
    for value in settings.core.post_process_api_keys.values_mut() {
        value.clear();
    }
}

/// Seal (encrypt) the secret fields on a settings tree in place, ready for
/// the store. A value that is already a sealed envelope is left as-is via
/// `encrypt_secret`'s idempotence. Covers the three renderer-facing string
/// secrets AND the embedded `core.post_process_api_keys` SecretMap.
pub(crate) fn try_seal_secrets(settings: &mut WinsttSettings) -> Result<(), String> {
    settings.llm.openrouter_api_key = try_encrypt_secret(&settings.llm.openrouter_api_key)?;
    settings.integrations.elevenlabs.api_key =
        try_encrypt_secret(&settings.integrations.elevenlabs.api_key)?;
    for value in settings.core.post_process_api_keys.values_mut() {
        *value = try_encrypt_secret(value)?;
    }
    Ok(())
}

fn mask_secret_for_renderer(value: &mut String) {
    if !value.is_empty() {
        *value = SECRET_PRESENT_SENTINEL.to_string();
    }
}

pub(crate) fn sanitize_settings_for_renderer(settings: &mut WinsttSettings) {
    mask_secret_for_renderer(&mut settings.llm.openrouter_api_key);
    mask_secret_for_renderer(&mut settings.integrations.elevenlabs.api_key);
    // The embedded legacy post-process API keys never cross to the renderer in
    // plaintext (the renderer doesn't use `core` at all, but mask defensively so
    // a future debug surface can't leak them).
    for value in settings.core.post_process_api_keys.values_mut() {
        mask_secret_for_renderer(value);
    }
}

fn preserve_masked_secret(previous: &str, next: &mut String) {
    if next == SECRET_PRESENT_SENTINEL {
        *next = previous.to_string();
    }
}

pub(crate) fn preserve_masked_secrets(previous: &WinsttSettings, next: &mut WinsttSettings) {
    preserve_masked_secret(
        &previous.llm.openrouter_api_key,
        &mut next.llm.openrouter_api_key,
    );
    preserve_masked_secret(
        &previous.integrations.elevenlabs.api_key,
        &mut next.integrations.elevenlabs.api_key,
    );
}

/// SINGLE-STORE BRIDGE write path for the embedded legacy `AppSettings` view.
///
/// `crate::settings::write_settings` (every legacy per-field setter command —
/// bindings, post-process CRUD, custom words, accelerators, log level, …) funnels
/// here. We read the current plaintext WinSTT tree, graft the new `core` onto it,
/// re-seal ALL secrets (incl. the embedded post-process API keys), persist, and
/// re-broadcast nothing (the legacy `core` is renderer-invisible). The non-`core`
/// sections are preserved untouched so a legacy write can't clobber the renderer's
/// model/general/llm/etc. settings.
pub fn write_core_settings(
    app: &AppHandle,
    core: crate::settings::AppSettings,
) -> Result<(), String> {
    // Hold the write lock across the read+graft+seal+write so a concurrent
    // `apply_settings_patch` (renderer section save) can't interleave and drop the
    // freshly-grafted `core` — or have its own section dropped by this write. The
    // live tree is re-read INSIDE the lock so only `core` is replaced.
    with_settings_write_lock(|| {
        let mut next = try_read_settings(app)?; // plaintext (secrets opened)
        next.core = core;
        try_seal_secrets(&mut next)?;
        write_settings_value(app, &next)
    })
}

/// Persist a full settings tree (with secrets ALREADY sealed) to the store and flush.
pub(crate) fn write_settings_value(
    app: &AppHandle,
    settings: &WinsttSettings,
) -> Result<(), String> {
    let store = settings_store(app)?;
    let value = serde_json::to_value(settings).map_err(|e| e.to_string())?;
    store.set(WINSTT_SETTINGS_KEY, value);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

/// One-time-migration marker stored alongside `winstt_settings`. Once the embedded
/// `core` section has been seeded from the legacy `settings_store.json` (or seeded
/// fresh on a brand-new install) this is set to `true` so the seed never re-runs
/// and can't clobber later user edits to bindings / API keys / paste settings.
const CORE_MIGRATED_KEY: &str = "core_migrated";

/// Seed the default settings tree on first run so the store file exists and a cold
/// renderer boots against a complete tree, AND perform the one-time single-store
/// migration of the legacy `AppSettings` (`settings_store.json`) into the embedded
/// `WinsttSettings.core` section. Called once from lib.rs setup.
///
/// Migration semantics (data-preserving, idempotent via [`CORE_MIGRATED_KEY`]):
///   * Fresh install (no `winstt_settings` key): write the default tree (whose
///     `core` is the canonical AppSettings defaults) and mark migrated.
///   * Existing WinsttSettings store, `core` never migrated, legacy
///     `settings_store.json` present: read the legacy AppSettings, seal its
///     secrets (incl. plaintext post-process API keys), graft it onto the
///     persisted tree's `core`, persist, and mark migrated. The user keeps their
///     bindings, audio-feedback, paste, post-process, accelerator, and tray
///     settings — now in the single store, with the API keys encrypted at rest.
///   * Existing store, already migrated: no-op.
pub fn seed_defaults(app: &AppHandle) {
    // Seeds + the one-time migration are a read→graft→write over the same store as the
    // live write paths; serialize them under the shared lock so a concurrent renderer
    // save during startup can't interleave. (Side-effect-free body — no runtime hooks
    // run here — so wrapping the whole thing can't re-enter the lock.)
    with_settings_write_lock(|| {
        let Ok(store) = settings_store(app) else {
            return;
        };

        // Brand-new install: materialize the full default tree and short-circuit.
        if store.get(WINSTT_SETTINGS_KEY).is_none() {
            let defaults = WinsttSettings::default();
            if let Ok(value) = serde_json::to_value(&defaults) {
                store.set(WINSTT_SETTINGS_KEY, value);
                store.set(CORE_MIGRATED_KEY, serde_json::json!(true));
                if let Err(err) = store.save() {
                    log::error!(
                        "[settings] core-migration: failed to persist fresh defaults: {err}"
                    );
                }
            }
            return;
        }

        // Existing store. If the one-time core migration already ran, leave it alone.
        let already_migrated = store
            .get(CORE_MIGRATED_KEY)
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if already_migrated {
            return;
        }

        // Pull the legacy AppSettings out of the old `settings_store.json` (plaintext),
        // if it exists. `load_legacy_app_settings` returns `None` when the legacy store
        // is absent or unreadable — in that case the embedded `core` keeps whatever it
        // already deserialized to (defaults for a pre-migration tree), which is correct.
        let mut current = match try_read_settings(app) {
            Ok(settings) => settings,
            Err(err) => {
                log::warn!("[settings] core-migration: failed to read WinSTT settings: {err}");
                return;
            }
        };
        // NON-DESTRUCTIVE RE-RUN (M6): if a prior migration's settings write succeeded
        // but the flag save below failed, the previous boot already persisted the
        // grafted `core` (so `current.core` now differs from defaults). Re-grafting the
        // stale legacy `settings_store.json` over it would clobber whatever the user
        // edited since. Only graft when `core` is still pristine defaults; otherwise just
        // re-attempt the flag so the migration stops re-running.
        let core_is_pristine = current.core == crate::settings::get_default_settings();
        if core_is_pristine {
            if let Some(legacy) = crate::settings::load_legacy_app_settings(app) {
                log::info!(
                    "[settings] core-migration: seeding embedded `core` from legacy settings_store.json"
                );
                current.core = legacy;
            }
        } else {
            log::warn!(
                "[settings] core-migration: embedded `core` already differs from defaults; \
                 re-marking migrated WITHOUT re-grafting legacy settings (prior flag save likely failed)"
            );
        }

        // Seal secrets (the legacy post-process API keys are plaintext on disk in the
        // old store; this is where they get DPAPI-sealed into the single store).
        let mut to_persist = current;
        if let Err(err) = try_seal_secrets(&mut to_persist) {
            log::warn!("[settings] core-migration: failed to seal secrets: {err}");
            return;
        }
        if let Err(err) = write_settings_value(app, &to_persist) {
            log::warn!("[settings] core-migration: failed to persist migrated settings: {err}");
            return;
        }
        store.set(CORE_MIGRATED_KEY, serde_json::json!(true));
        if let Err(err) = store.save() {
            // LOUD (M6): a swallowed failure here means the next boot re-runs this
            // migration. The non-destructive guard above keeps that re-run from
            // clobbering user edits, but the operator still needs to see it.
            log::error!(
                "[settings] core-migration: settings persisted but failed to save the \
                 `{CORE_MIGRATED_KEY}` flag; migration will retry on next boot: {err}"
            );
        }
    });
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
        assert_eq!(opened.integrations.elevenlabs.api_key, "xi-el-secret");
    }

    /// The single-store migration's load-bearing new behavior: the embedded legacy
    /// `core.post_process_api_keys` SecretMap is sealed at rest (DPAPI) on save and
    /// opened to plaintext on read, exactly like the three string secrets.
    #[cfg(target_os = "windows")]
    #[test]
    fn seal_then_open_round_trips_embedded_post_process_api_keys() {
        let mut s = WinsttSettings::default();
        s.core
            .post_process_api_keys
            .insert("openai".into(), "sk-pp-openai-secret".into());
        s.core
            .post_process_api_keys
            .insert("groq".into(), "gsk-pp-groq-secret".into());
        // Empty key must stay empty (no spurious envelope).
        s.core
            .post_process_api_keys
            .insert("custom".into(), String::new());

        let mut sealed = s.clone();
        try_seal_secrets(&mut sealed).unwrap();
        assert!(is_encrypted(
            sealed.core.post_process_api_keys.get("openai").unwrap()
        ));
        assert!(is_encrypted(
            sealed.core.post_process_api_keys.get("groq").unwrap()
        ));
        assert_eq!(sealed.core.post_process_api_keys.get("custom").unwrap(), "");
        // Plaintext must not leak into the on-disk envelope.
        assert!(!sealed
            .core
            .post_process_api_keys
            .get("openai")
            .unwrap()
            .contains("sk-pp-openai-secret"));

        let mut opened = sealed.clone();
        try_open_secrets(&mut opened).unwrap();
        assert_eq!(
            opened.core.post_process_api_keys.get("openai").unwrap(),
            "sk-pp-openai-secret"
        );
        assert_eq!(
            opened.core.post_process_api_keys.get("groq").unwrap(),
            "gsk-pp-groq-secret"
        );
        assert_eq!(opened.core.post_process_api_keys.get("custom").unwrap(), "");
    }

    /// The renderer-facing snapshot masks the embedded post-process API keys so
    /// they never cross IPC in plaintext, while empty keys stay empty.
    #[test]
    fn renderer_sanitization_masks_embedded_post_process_keys() {
        let mut s = WinsttSettings::default();
        s.core
            .post_process_api_keys
            .insert("openai".into(), "sk-pp-secret".into());
        s.core
            .post_process_api_keys
            .insert("custom".into(), String::new());

        sanitize_settings_for_renderer(&mut s);

        assert_eq!(
            s.core.post_process_api_keys.get("openai").unwrap(),
            SECRET_PRESENT_SENTINEL
        );
        assert_eq!(s.core.post_process_api_keys.get("custom").unwrap(), "");
    }

    #[test]
    fn empty_secret_seals_to_empty() {
        // The default tree has empty secrets — sealing must keep them empty (no
        // spurious envelope on disk), matching the reference's empty-string short-circuit.
        let mut s = WinsttSettings::default();
        try_seal_secrets(&mut s).unwrap();
        assert_eq!(s.llm.openrouter_api_key, "");
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
    fn internal_open_failure_clears_all_secret_fields() {
        let mut s = WinsttSettings::default();
        s.model.model = "nemo-canary-180m-flash".into();
        s.llm.openrouter_api_key = "sk-or-v1-secret".into();
        s.integrations.elevenlabs.api_key = "enc:v1:not-hex-!!!".into();
        s.core
            .post_process_api_keys
            .insert("openai".into(), "sk-pp-secret".into());

        let err = try_open_secrets_fail_closed(&mut s).unwrap_err();

        assert!(err.contains("malformed encrypted secret envelope"));
        assert_eq!(s.llm.openrouter_api_key, "");
        assert_eq!(s.integrations.elevenlabs.api_key, "");
        assert_eq!(s.core.post_process_api_keys.get("openai").unwrap(), "");
        assert_eq!(s.model.model, "nemo-canary-180m-flash");
    }

    #[test]
    fn renderer_sanitization_masks_after_open_failure() {
        let mut s = WinsttSettings::default();
        s.llm.openrouter_api_key = "sk-or-v1-secret".into();
        s.integrations.elevenlabs.api_key = "enc:v1:not-hex-!!!".into();
        s.core
            .post_process_api_keys
            .insert("openai".into(), "sk-pp-secret".into());

        let err = try_open_secrets(&mut s).unwrap_err();
        sanitize_settings_for_renderer(&mut s);

        assert!(err.contains("malformed encrypted secret envelope"));
        assert_eq!(s.llm.openrouter_api_key, SECRET_PRESENT_SENTINEL);
        assert_eq!(s.integrations.elevenlabs.api_key, SECRET_PRESENT_SENTINEL);
        assert_eq!(
            s.core.post_process_api_keys.get("openai").unwrap(),
            SECRET_PRESENT_SENTINEL
        );
    }

    #[test]
    fn renderer_sanitization_masks_non_empty_secrets() {
        let mut s = WinsttSettings::default();
        s.llm.openrouter_api_key = "sk-or-v1-secret".into();
        s.integrations.elevenlabs.api_key = "xi-el-secret".into();

        sanitize_settings_for_renderer(&mut s);

        assert_eq!(s.llm.openrouter_api_key, SECRET_PRESENT_SENTINEL);
        assert_eq!(s.integrations.elevenlabs.api_key, SECRET_PRESENT_SENTINEL);
    }

    #[test]
    fn renderer_sanitization_keeps_empty_secrets_empty() {
        let mut s = WinsttSettings::default();

        sanitize_settings_for_renderer(&mut s);

        assert_eq!(s.llm.openrouter_api_key, "");
        assert_eq!(s.integrations.elevenlabs.api_key, "");
    }

    #[test]
    fn masked_secret_patch_preserves_previous_plaintext_secret() {
        let mut previous = WinsttSettings::default();
        previous.llm.openrouter_api_key = "sk-or-v1-secret".into();
        previous.integrations.elevenlabs.api_key = "xi-el-secret".into();

        let mut next = previous.clone();
        next.llm.openrouter_api_key = SECRET_PRESENT_SENTINEL.into();
        next.integrations.elevenlabs.api_key = SECRET_PRESENT_SENTINEL.into();

        preserve_masked_secrets(&previous, &mut next);

        assert_eq!(next.llm.openrouter_api_key, "sk-or-v1-secret");
        assert_eq!(next.integrations.elevenlabs.api_key, "xi-el-secret");
    }

    #[test]
    fn empty_secret_patch_still_clears_previous_secret() {
        let mut previous = WinsttSettings::default();
        previous.llm.openrouter_api_key = "sk-or-v1-secret".into();
        previous.integrations.elevenlabs.api_key = "xi-el-secret".into();

        let mut next = previous.clone();
        next.llm.openrouter_api_key.clear();
        next.integrations.elevenlabs.api_key.clear();

        preserve_masked_secrets(&previous, &mut next);

        assert_eq!(next.llm.openrouter_api_key, "");
        assert_eq!(next.integrations.elevenlabs.api_key, "");
    }

    // ── H2 concurrency regression: serialized section RMW never loses a section ──
    //
    // The real public write paths (`apply_settings_patch`, `write_core_settings`)
    // can't run here without a live tauri `AppHandle` + plugin-store (and `cargo
    // test` is broken on the dev box — this runs in CI). So we model their exact
    // shape against the SAME `with_settings_write_lock`: a shared in-memory tree
    // standing in for `winstt-settings.json`, and N threads each doing
    // read → graft ONE whole section → write under the lock — the precise span the
    // guard wraps in production. The invariant under test is H2's: a `{audio}` patch
    // racing a `{tts}` patch must not drop either section.

    /// One production-shaped section RMW under the write lock: read the whole tree,
    /// overwrite exactly one section (mirroring `merge_patch_over`'s wholesale
    /// section replacement), write the whole tree back.
    fn locked_section_rmw(
        store: &std::sync::Mutex<WinsttSettings>,
        mutate: impl FnOnce(&mut WinsttSettings),
    ) {
        with_settings_write_lock(|| {
            let mut tree = store.lock_recover().clone();
            mutate(&mut tree);
            *store.lock_recover() = tree;
        });
    }

    #[test]
    fn concurrent_audio_and_tts_section_patches_lose_neither_section() {
        use std::sync::Arc;

        // Distinctive non-default markers so a lost section is unambiguous: the audio
        // writers bump `sample_rate`, the tts writers bump `cloud.speed`. (Both are
        // simple scalar section fields; the point is whole-section graft survival, not
        // the specific field.)
        const ITERATIONS: usize = 200;
        const AUDIO_MARKER: i64 = 32_000;
        const TTS_MARKER: f64 = 1.1;

        let store = Arc::new(std::sync::Mutex::new(WinsttSettings::default()));

        let audio_store = Arc::clone(&store);
        let audio = std::thread::spawn(move || {
            for _ in 0..ITERATIONS {
                locked_section_rmw(&audio_store, |tree| {
                    // Overwrite the WHOLE audio section (as the renderer's `{audio}`
                    // patch does), carrying the marker.
                    let mut audio = tree.audio.clone();
                    audio.sample_rate = AUDIO_MARKER;
                    tree.audio = audio;
                });
                std::thread::yield_now();
            }
        });

        let tts_store = Arc::clone(&store);
        let tts = std::thread::spawn(move || {
            for _ in 0..ITERATIONS {
                locked_section_rmw(&tts_store, |tree| {
                    let mut tts = tree.tts.clone();
                    tts.cloud.speed = TTS_MARKER;
                    tree.tts = tts;
                });
                std::thread::yield_now();
            }
        });

        audio.join().unwrap();
        tts.join().unwrap();

        let final_tree = store.lock_recover().clone();
        // The lock serializes each whole-tree read+write, so the LAST writer of each
        // section wins and NEITHER section is silently reverted by the other thread's
        // stale-read write-back: both markers must be present together.
        assert_eq!(
            final_tree.audio.sample_rate, AUDIO_MARKER,
            "the audio section was lost (overwritten by a stale-read tts write)"
        );
        assert_eq!(
            final_tree.tts.cloud.speed, TTS_MARKER,
            "the tts section was lost (overwritten by a stale-read audio write)"
        );
    }
}
