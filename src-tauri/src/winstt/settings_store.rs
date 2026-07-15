// CORE settings service: store I/O + secret seal/open/mask/preserve + cross-field
// normalization + seed_defaults. The on-disk layer every reader/writer funnels
// through.
//
// DEPENDENCY DIRECTION: this is a service-tier module (sits below both the
// `winstt::commands` route layer and the `winstt::managers` / app-level service
// layer). Managers and commands BOTH depend DOWNWARD on it for settings reads —
// the hot recording loops and backend services no longer read settings through
// a route-layer command module. It depends only on the pure-logic tiers
// (`settings_schema`, `secret_storage`, `sync_ext`) and the backend `crate::settings`
// core; it never reaches back up into commands/managers.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Serialize, de::DeserializeOwned};
use tauri::AppHandle;
use tauri_plugin_store::{Store, StoreExt};

use crate::winstt::commands::secret_storage::{try_decrypt_secret, try_encrypt_secret};
use crate::winstt::settings_schema::{
    AudioSettings, DictionaryEntry, GeneralSettings, GlobalSettings, HotkeySettings,
    IntegrationsSettings, LlmSettings, ModelSettings, QualitySettings, RecordingMode, SnippetEntry,
    TtsSettings, WinsttSettings,
};
use crate::winstt::sync_ext::MutexExt;

/// Persisted store key for the full WinSTT settings tree. `pub` because the
/// onboarding command writes the tree directly under this key.
pub const WINSTT_SETTINGS_KEY: &str = "winstt_settings";
/// The settings store file name (under the portable data dir).
pub(crate) const WINSTT_SETTINGS_FILE: &str = "winstt-settings.json";
/// Renderer-facing sentinel substituted for any non-empty secret so the renderer
/// can know a secret exists without receiving its plaintext.
pub(crate) const SECRET_PRESENT_SENTINEL: &str = "__WINSTT_SECRET_PRESENT__";
/// Renderer→backend sentinel that signals an EXPLICIT user clear of a stored
/// secret. Distinct from an incidental empty string (which a pre-hydration or
/// programmatic save can post before the renderer has loaded the masked
/// `SECRET_PRESENT_SENTINEL`): an empty incoming secret is treated as "keep the
/// stored key" so it can't silently wipe a real DPAPI-sealed key (finding #41).
/// A deliberate clear must post THIS value. Keep in sync with the renderer's
/// `SECRET_CLEAR_SENTINEL` in `shared/config/settings-schema/secrets.ts`.
pub(crate) const SECRET_CLEAR_SENTINEL: &str = "__WINSTT_SECRET_CLEAR__";

/// The RESOLVED absolute directory holding `winstt-settings.json`, captured once
/// from an `AppHandle` (portable `Data/` dir, else the OS app-data dir).
///
/// LOAD-BEARING (the "settings never persist across dev restarts" bug):
/// `portable::store_path` returns a BARE RELATIVE path (`"winstt-settings.json"`)
/// in non-portable mode. The tauri-plugin-store builder resolves that relative
/// path against the APP-DATA dir — but `durable_save_store`'s `atomic_write_json`
/// used it directly against the process CWD. Reads (plugin load at boot) and
/// writes (every save) therefore hit DIFFERENT FILES: boot read
/// `%APPDATA%\com.winstt.winstt\winstt-settings.json` while saves landed in
/// `<cwd>\winstt-settings.json` (`src-tauri\` or `target\debug\` under
/// `tauri dev`). Every setting change was silently lost on restart unless the
/// plugin's graceful-exit flush ran — which dev kills/hot-reloads never do.
/// Resolving ONCE against the app handle makes read, write, `.bak`, and
/// `.corrupt` all point at the SAME absolute file in every launch mode.
static RESOLVED_STORE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Capture the absolute store dir from `app`. Idempotent; called by
/// `init_settings_store` (main thread, setup hook) and the `settings_store`
/// lazy fallback, both of which run before any read/write path needs it.
fn resolve_store_dir(app: &AppHandle) {
    let _ = RESOLVED_STORE_DIR.get_or_init(|| {
        crate::portable::app_data_dir(app).unwrap_or_else(|err| {
            log::error!("[settings] app-data dir unresolved ({err}); falling back to CWD");
            PathBuf::from(".")
        })
    });
}

fn store_path() -> PathBuf {
    match RESOLVED_STORE_DIR.get() {
        Some(dir) => dir.join(WINSTT_SETTINGS_FILE),
        // Pre-resolution fallback (should not happen in practice — both store
        // constructors resolve first): the portable-aware relative path.
        None => crate::portable::store_path(WINSTT_SETTINGS_FILE),
    }
}

/// Sibling `.bak` path holding a copy of the last known-good settings file, used
/// to recover when the primary file is torn/truncated by a crash mid-write
/// (finding #47a). `winstt-settings.json` → `winstt-settings.json.bak`.
fn backup_store_path() -> PathBuf {
    let mut name = store_path().into_os_string();
    name.push(".bak");
    PathBuf::from(name)
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
static SETTINGS_RAW_CACHE: OnceLock<Mutex<Option<WinsttSettings>>> = OnceLock::new();

/// Monotonic process-local revision for the canonical settings snapshot.
///
/// Every durable settings write advances this counter while holding
/// `SETTINGS_WRITE_LOCK`. Renderer clients use it for optimistic concurrency:
/// a patch based on an older snapshot is rejected and rebased instead of
/// silently overwriting a newer write from another window.
static SETTINGS_REVISION: AtomicU64 = AtomicU64::new(0);

pub(crate) fn settings_revision() -> u64 {
    SETTINGS_REVISION.load(Ordering::Acquire)
}

/// Build + cache the settings store handle on the MAIN thread. MUST be called once from
/// the tauri setup hook BEFORE any background thread (the spawned startup thread, the
/// realtime worker, the PTT watchdog) reads settings, so every off-thread caller stays
/// on the cached (clone-free) path. Idempotent.
pub fn init_settings_store(app: &AppHandle) {
    resolve_store_dir(app);
    if SETTINGS_STORE.get().is_some() {
        return;
    }
    match build_settings_store(app) {
        Ok(store) => {
            repair_wedged_store_on_boot(&store);
            let _ = SETTINGS_STORE.set(store);
        }
        Err(err) => {
            log::error!("[settings] failed to initialize settings store handle: {err}");
        }
    }
}

/// Build the store handle with the plugin's debounced auto-save DISABLED.
///
/// Every mutation of this store funnels through `write_settings_value` /
/// `seed_defaults` (there are no external `store.set` writers — verified), which
/// persist through [`durable_save_store`]'s temp+fsync+rename. The plugin's
/// default auto-save is a plain, non-atomic `fs::write` fired 100 ms after every
/// `set`; leaving it on would let a crash tear the file AFTER our durable write
/// already committed it (finding #47a). Disabling it makes the atomic path the
/// only writer.
///
/// KNOWN QUIRK (finding #2): every `store.set` still emits the plugin's own
/// `store://change` event synchronously — BEFORE our durable write and the
/// `settings:changed` broadcast — and the plugin exposes no opt-out. No renderer
/// subscribes to it (verified); keep it that way. `settings:changed` is the only
/// settings event a renderer may consume: it is emitted after the durable write,
/// with the full masked snapshot.
fn build_settings_store(app: &AppHandle) -> Result<Arc<Store<tauri::Wry>>, String> {
    app.store_builder(store_path())
        .disable_auto_save()
        .build()
        .map_err(|err| format!("winstt settings store: {err}"))
}

/// Resolve the cached settings store, falling back to building it on first use. The
/// fallback still clones the `AppHandle` once, so `init_settings_store` MUST run on the
/// main thread first to keep every off-thread caller off the unsound clone path.
fn settings_store(app: &AppHandle) -> Result<Arc<Store<tauri::Wry>>, String> {
    if let Some(store) = SETTINGS_STORE.get() {
        return Ok(Arc::clone(store));
    }
    resolve_store_dir(app);
    let store = build_settings_store(app)?;
    let _ = SETTINGS_STORE.set(Arc::clone(&store));
    Ok(store)
}

fn settings_raw_cache() -> &'static Mutex<Option<WinsttSettings>> {
    SETTINGS_RAW_CACHE.get_or_init(|| Mutex::new(None))
}

fn cached_raw_settings() -> Option<WinsttSettings> {
    settings_raw_cache().lock_recover().clone()
}

fn update_raw_settings_cache(settings: &WinsttSettings) {
    *settings_raw_cache().lock_recover() = Some(settings.clone());
}

/// Process-wide serializer for every read-modify-write of `winstt-settings.json`.
///
/// All four mutating paths are unguarded read→merge→write spans over the SAME store
/// key from different threads — the renderer's per-utterance `{audio}` patch, the
/// LLM learning thread's `{dictation}` appends, the TTS pool, the per-field
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
///     `core`, so a backend setter can never lose a renderer-owned section.
///   * `settings::store::get_settings` computes its backfill lock-free, then persists
///     it through `write_core_settings` (a single lock acquisition), so the reader's
///     backfill write can't lose a concurrently-written section and never re-enters.
///
/// CROSS-PROCESS (finding #3, deliberately not locked): this mutex only covers ONE
/// process. Two WinSTT processes (debug-only — single-instance is release-gated) do
/// last-writer-wins at whole-file granularity. An OS advisory lock here (std
/// `File::lock`, available since Rust 1.89 — no extra dependency) would NOT fix
/// that: torn bytes are already impossible (temp+fsync+rename), and the actual
/// hazard — lost updates — comes from each process's `SETTINGS_RAW_CACHE` + plugin
/// cache serving stale reads for the RMW. Correctness would need a disk re-read +
/// cache invalidation under the lock, a redesign disproportionate to a
/// debug-only scenario. Revisit only if multi-process becomes a supported mode.
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
/// The on-disk store holds sealed `enc:v1:` envelopes.
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
    if let Some(settings) = cached_raw_settings() {
        return Ok(settings);
    }

    let store = settings_store(app)?;
    let settings = match store.get(WINSTT_SETTINGS_KEY) {
        Some(value) => parse_settings_value(value),
        None => Ok(WinsttSettings::default()),
    }?;
    update_raw_settings_cache(&settings);
    Ok(settings)
}

fn parse_settings_value(value: serde_json::Value) -> Result<WinsttSettings, String> {
    // Every field is `#[serde(default)]`, so a MISSING key already falls back to
    // its default. A key that is PRESENT but wrong-typed (e.g. `recordingMode: 42`
    // from a hand-edited or downgrade-mangled file) still fails the whole-tree
    // parse, though — serde's `default` only covers absence, not a decode error.
    // The strict path is the fast common case; on failure we recover per-field so
    // one bad value can no longer wipe the WHOLE tree back to defaults (nor wedge
    // every later save by making `try_read_settings` error forever) — this mirrors
    // Zod's `.catch` "never let one bad field nuke the rest" guarantee (finding #47b).
    let mut settings = match serde_json::from_value::<WinsttSettings>(value.clone()) {
        Ok(settings) => settings,
        Err(err) => {
            log::warn!(
                "[settings] persisted WinSTT settings failed strict parse ({err}); \
                 recovering per field"
            );
            recover_settings_value(value)
        }
    };
    normalize_cross_field_settings(&mut settings);
    Ok(settings)
}

/// Per-field fallback for a settings blob that failed the strict parse. Each
/// top-level section is decoded in isolation, then an invalid object section is
/// rebuilt from its defaults one persisted field at a time. Only fields that make
/// that section fail are dropped; good sibling fields survive. Non-object sections
/// (the dictionary/snippet arrays) still recover as one value. If the whole tree
/// still can't decode after that, fall back to full defaults as a last resort.
fn recover_settings_value(mut value: serde_json::Value) -> WinsttSettings {
    let defaults = serde_json::to_value(WinsttSettings::default())
        .expect("WinsttSettings defaults must serialize");
    if let Some(obj) = value.as_object_mut() {
        salvage_section_fields::<GlobalSettings>(obj, &defaults, "global");
        salvage_section_fields::<ModelSettings>(obj, &defaults, "model");
        salvage_section_fields::<QualitySettings>(obj, &defaults, "quality");
        salvage_section_fields::<AudioSettings>(obj, &defaults, "audio");
        salvage_section_fields::<GeneralSettings>(obj, &defaults, "general");
        salvage_section_fields::<HotkeySettings>(obj, &defaults, "hotkey");
        salvage_section_fields::<Vec<DictionaryEntry>>(obj, &defaults, "dictionary");
        salvage_section_fields::<Vec<SnippetEntry>>(obj, &defaults, "snippets");
        salvage_section_fields::<LlmSettings>(obj, &defaults, "llm");
        salvage_section_fields::<TtsSettings>(obj, &defaults, "tts");
        salvage_section_fields::<IntegrationsSettings>(obj, &defaults, "integrations");
        salvage_section_fields::<crate::settings::AppSettings>(obj, &defaults, "core");
    }
    serde_json::from_value::<WinsttSettings>(value).unwrap_or_else(|err| {
        log::error!(
            "[settings] per-field recovery still failed ({err}); falling back to full defaults"
        );
        WinsttSettings::default()
    })
}

/// Salvage an invalid object section one current field at a time over its
/// serialized defaults.
fn salvage_section_fields<T: DeserializeOwned + Serialize>(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    defaults: &serde_json::Value,
    key: &str,
) {
    let Some(section) = obj.get(key) else {
        return;
    };
    if serde_json::from_value::<T>(section.clone()).is_ok() {
        return;
    }

    let Some(persisted_fields) = section.as_object() else {
        log::warn!("[settings] dropping unparseable `{key}` section; restoring its defaults");
        obj.remove(key);
        return;
    };
    let Some(default_fields) = defaults.get(key).and_then(serde_json::Value::as_object) else {
        log::warn!("[settings] dropping unparseable `{key}` section; restoring its defaults");
        obj.remove(key);
        return;
    };

    let mut recovered = default_fields.clone();
    for (field, persisted) in persisted_fields {
        let mut candidate = recovered.clone();
        candidate.insert(field.clone(), persisted.clone());
        if serde_json::from_value::<T>(serde_json::Value::Object(candidate.clone())).is_ok() {
            recovered = candidate;
        } else {
            log::warn!(
                "[settings] dropping unparseable `{key}.{field}` field; restoring its default"
            );
        }
    }
    obj.insert(key.to_string(), serde_json::Value::Object(recovered));
}

pub(crate) fn word_by_word_pasting_effective(settings: &WinsttSettings) -> bool {
    settings.general.word_by_word_pasting
}

pub(crate) fn normalize_cross_field_settings(settings: &mut WinsttSettings) {
    if settings.general.word_by_word_pasting {
        settings.general.preview_before_pasting = false;
        settings.llm.dictation.enabled = false;
        settings.llm.transforms.enabled = false;
    }
}

/// The current recording mode, read cheaply from the in-memory settings store (NO secret
/// decryption). Used on the hotkey thread to decide whether to dispatch the recorder in-process
/// (PTT) vs leaving it renderer/server-driven — so the press path stays fast.
pub fn recording_mode(app: &AppHandle) -> RecordingMode {
    read_settings_raw(app).general.recording_mode
}

/// Open the encrypted renderer-facing secret fields on a settings tree in place.
fn try_open_secrets(settings: &mut WinsttSettings) -> Result<(), String> {
    settings.llm.openrouter_api_key = try_decrypt_secret(&settings.llm.openrouter_api_key)?;
    settings.integrations.elevenlabs.api_key =
        try_decrypt_secret(&settings.integrations.elevenlabs.api_key)?;
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
}

/// Seal the plaintext secret fields on a settings tree for persistence.
pub(crate) fn try_seal_secrets(settings: &mut WinsttSettings) -> Result<(), String> {
    settings.llm.openrouter_api_key = try_encrypt_secret(&settings.llm.openrouter_api_key)?;
    settings.integrations.elevenlabs.api_key =
        try_encrypt_secret(&settings.integrations.elevenlabs.api_key)?;
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
}

/// Reconcile one incoming secret field against the stored one before sealing:
///   * `SECRET_PRESENT_SENTINEL` (renderer echoing "a key exists") → keep stored.
///   * `SECRET_CLEAR_SENTINEL` (explicit user clear) → clear to empty.
///   * empty incoming with a stored key present → KEEP stored. An empty string is
///     ambiguous — a genuine clear looks identical to a pre-hydration / programmatic
///     save that posts the section before the masked sentinel was ever loaded — so
///     treating it as "keep" stops an incidental empty from silently wiping a real
///     DPAPI-sealed key (finding #41). A deliberate clear must post the sentinel.
///   * anything else (a freshly typed/pasted key) → use incoming.
fn preserve_masked_secret(previous: &str, next: &mut String) {
    if next == SECRET_PRESENT_SENTINEL {
        *next = previous.to_string();
    } else if next == SECRET_CLEAR_SENTINEL {
        next.clear();
    } else if next.is_empty() && !previous.is_empty() {
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

/// Write path for the backend-only `AppSettings` section.
///
/// `crate::settings::write_settings` (bindings, accelerators, log level, and other
/// backend-owned controls) funnels
/// here. We read the current plaintext WinSTT tree, graft the new `core` onto it,
/// re-seal ALL secrets (incl. the embedded post-process API keys), persist, and
/// re-broadcast nothing (`core` is renderer-invisible). The non-`core` sections
/// are preserved untouched so a backend write cannot clobber the renderer's
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
    durable_save_store(&store)?;
    update_raw_settings_cache(settings);
    SETTINGS_REVISION.fetch_add(1, Ordering::AcqRel);
    Ok(())
}

/// Atomically + durably persist the ENTIRE store cache to disk, replacing the
/// plugin's plain (non-atomic, backup-less) `store.save()` (finding #47a):
///   1. serialize every key to pretty JSON,
///   2. write it to a sibling temp file and `fsync` it,
///   3. `rename` the temp over the target (atomic on Windows + POSIX),
///   4. refresh a `.bak` copy of the now-good file for crash recovery.
///
/// A mid-write crash can therefore leave only the temp file behind (ignored on
/// next boot); the primary file is never observed torn.
fn durable_save_store(store: &Store<tauri::Wry>) -> Result<(), String> {
    let mut map = serde_json::Map::new();
    for (key, value) in store.entries() {
        map.insert(key, value);
    }
    atomic_write_json(&store_path(), &serde_json::Value::Object(map))
}

fn atomic_write_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("settings store path has no parent dir: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;

    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        // fsync the bytes to stable storage BEFORE the rename so the swap can't
        // publish an empty/partial inode after a power loss.
        file.sync_all().map_err(|e| e.to_string())?;
    }
    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    // Best-effort: keep a copy of the last known-good file for boot recovery.
    let mut bak = path.as_os_str().to_owned();
    bak.push(".bak");
    if let Err(err) = std::fs::copy(path, PathBuf::from(bak)) {
        log::debug!("[settings] failed to refresh settings .bak (non-fatal): {err}");
    }
    Ok(())
}

/// Sidecar holding the raw bytes of a settings file that failed to parse, kept for
/// forensics when the store is repaired on boot. `winstt-settings.json.corrupt`.
fn corrupt_store_path() -> PathBuf {
    let mut name = store_path().into_os_string();
    name.push(".corrupt");
    PathBuf::from(name)
}

/// Boot-time self-heal so a corrupt store can never wedge the app (finding
/// #47b/#47c). Runs once, on the MAIN thread, right after the store is built:
///   * If `winstt_settings` is present but fails the strict parse, rewrite the
///     per-section-recovered tree to disk (preserving good sections) after copying
///     the corrupt file aside — so the file is clean and later saves start good.
///   * If `winstt_settings` is absent (the plugin couldn't load a torn file),
///     restore from the last-good `.bak` before the fresh-default seed runs.
fn repair_wedged_store_on_boot(store: &Store<tauri::Wry>) {
    if let Some(value) = store.get(WINSTT_SETTINGS_KEY) {
        if serde_json::from_value::<WinsttSettings>(value.clone()).is_ok() {
            return;
        }
        log::error!(
            "[settings] persisted settings are corrupt; backing up and rewriting a recovered tree"
        );
        if let Err(err) = std::fs::copy(store_path(), corrupt_store_path()) {
            log::debug!("[settings] failed to snapshot corrupt settings (non-fatal): {err}");
        }
        let mut recovered = recover_settings_value(value);
        normalize_cross_field_settings(&mut recovered);
        persist_recovered_settings(store, &recovered);
        return;
    }
    restore_settings_from_backup(store);
}

fn persist_recovered_settings(store: &Store<tauri::Wry>, recovered: &WinsttSettings) {
    match serde_json::to_value(recovered) {
        Ok(value) => {
            store.set(WINSTT_SETTINGS_KEY, value);
            if let Err(err) = durable_save_store(store) {
                log::error!("[settings] failed to persist recovered settings: {err}");
            } else {
                log::info!("[settings] rewrote per-section-recovered settings to disk");
            }
        }
        Err(err) => log::error!("[settings] failed to serialize recovered settings: {err}"),
    }
}

fn restore_settings_from_backup(store: &Store<tauri::Wry>) {
    let Ok(bytes) = std::fs::read(backup_store_path()) else {
        return;
    };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_slice::<serde_json::Value>(&bytes)
    else {
        return;
    };
    if !map.contains_key(WINSTT_SETTINGS_KEY) {
        return;
    }
    log::warn!("[settings] primary settings file unreadable; restoring from last-good .bak");
    for (key, value) in map {
        store.set(key, value);
    }
    if let Err(err) = durable_save_store(store) {
        log::error!("[settings] failed to persist settings restored from .bak: {err}");
    }
}

/// Materialize the canonical default tree on first run.
pub fn seed_defaults(app: &AppHandle) {
    with_settings_write_lock(|| {
        let Ok(store) = settings_store(app) else {
            return;
        };
        if store.get(WINSTT_SETTINGS_KEY).is_some() {
            return;
        }

        let defaults = WinsttSettings::default();
        if let Ok(value) = serde_json::to_value(&defaults) {
            store.set(WINSTT_SETTINGS_KEY, value);
            if let Err(err) = durable_save_store(&store) {
                log::error!("[settings] failed to persist fresh defaults: {err}");
            } else {
                update_raw_settings_cache(&defaults);
            }
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
    fn parse_settings_value_recovers_only_the_malformed_field() {
        // A present-but-wrong-typed field (here `general.recordingMode: 42`) must NOT
        // fail the whole-tree parse (finding #47b). Only the offending FIELD recovers
        // to its default; good fields in the same and other sections survive.
        let mut value = serde_json::to_value(WinsttSettings::default()).unwrap();
        value["model"]["model"] = serde_json::json!("nemo-canary-180m-flash");
        value["general"]["overlayMode"] = serde_json::json!("floating-bottom");
        value["general"]["recordingMode"] = serde_json::json!(42);

        let settings = parse_settings_value(value).expect("must recover, not error");

        // The corrupt field fell back to its default …
        assert_eq!(
            settings.general.recording_mode,
            WinsttSettings::default().general.recording_mode
        );
        // … while good values in both the same and another section were retained.
        assert_eq!(
            settings.general.overlay_mode,
            crate::winstt::settings_schema::OverlayMode::FloatingBottom
        );
        assert_eq!(settings.model.model, "nemo-canary-180m-flash");
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
        s.llm.openrouter_api_key = "enc:v1:not-hex-!!!".into();
        s.integrations.elevenlabs.api_key = "enc:v1:not-hex-!!!".into();

        let err = try_open_secrets_fail_closed(&mut s).unwrap_err();

        assert!(err.contains("malformed encrypted secret envelope"));
        assert_eq!(s.llm.openrouter_api_key, "");
        assert_eq!(s.integrations.elevenlabs.api_key, "");
        assert_eq!(s.model.model, "nemo-canary-180m-flash");
    }

    #[test]
    fn renderer_sanitization_masks_after_open_failure() {
        let mut s = WinsttSettings::default();
        s.llm.openrouter_api_key = "enc:v1:not-hex-!!!".into();
        s.integrations.elevenlabs.api_key = "enc:v1:not-hex-!!!".into();

        let err = try_open_secrets(&mut s).unwrap_err();
        sanitize_settings_for_renderer(&mut s);

        assert!(err.contains("malformed encrypted secret envelope"));
        assert_eq!(s.llm.openrouter_api_key, SECRET_PRESENT_SENTINEL);
        assert_eq!(s.integrations.elevenlabs.api_key, SECRET_PRESENT_SENTINEL);
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
    fn incidental_empty_secret_patch_keeps_previous_secret() {
        // SAFER contract (finding #41): an EMPTY incoming secret is ambiguous — a
        // pre-hydration / programmatic save posts the section before the masked
        // sentinel was ever loaded, and that empty must NOT wipe a real stored key.
        let mut previous = WinsttSettings::default();
        previous.llm.openrouter_api_key = "sk-or-v1-secret".into();
        previous.integrations.elevenlabs.api_key = "xi-el-secret".into();

        let mut next = previous.clone();
        next.llm.openrouter_api_key.clear();
        next.integrations.elevenlabs.api_key.clear();

        preserve_masked_secrets(&previous, &mut next);

        assert_eq!(next.llm.openrouter_api_key, "sk-or-v1-secret");
        assert_eq!(next.integrations.elevenlabs.api_key, "xi-el-secret");
    }

    #[test]
    fn explicit_clear_sentinel_clears_previous_secret() {
        // A DELIBERATE user clear posts `SECRET_CLEAR_SENTINEL`, which still wipes the
        // stored key — the escape hatch that keeps clearing possible under the
        // empty-keeps-previous contract above.
        let mut previous = WinsttSettings::default();
        previous.llm.openrouter_api_key = "sk-or-v1-secret".into();
        previous.integrations.elevenlabs.api_key = "xi-el-secret".into();

        let mut next = previous.clone();
        next.llm.openrouter_api_key = SECRET_CLEAR_SENTINEL.into();
        next.integrations.elevenlabs.api_key = SECRET_CLEAR_SENTINEL.into();

        preserve_masked_secrets(&previous, &mut next);

        assert_eq!(next.llm.openrouter_api_key, "");
        assert_eq!(next.integrations.elevenlabs.api_key, "");
    }

    #[test]
    fn newly_typed_secret_patch_replaces_previous_secret() {
        // A fresh non-empty, non-sentinel value is a real new key — it replaces.
        let mut previous = WinsttSettings::default();
        previous.llm.openrouter_api_key = "sk-or-v1-old".into();

        let mut next = previous.clone();
        next.llm.openrouter_api_key = "sk-or-v1-new".into();

        preserve_masked_secrets(&previous, &mut next);

        assert_eq!(next.llm.openrouter_api_key, "sk-or-v1-new");
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

    // ── #47b per-field recovery ──────────────────────────────────────────────────

    #[test]
    fn recover_settings_value_drops_only_the_corrupt_field() {
        let mut value = serde_json::to_value(WinsttSettings::default()).unwrap();
        value["model"]["language"] = serde_json::json!("fr"); // good custom value
        value["audio"]["sampleRate"] = serde_json::json!(48_000); // good sibling field
        value["audio"]["microphoneRelease"] = serde_json::json!(12345); // corrupt enum

        let recovered = recover_settings_value(value);

        // Only corrupt `audio.microphoneRelease` defaults; both good values survive.
        assert_eq!(
            recovered.audio.microphone_release,
            WinsttSettings::default().audio.microphone_release
        );
        assert_eq!(recovered.audio.sample_rate, 48_000);
        assert_eq!(recovered.model.language, "fr");
    }

    #[test]
    fn recover_settings_value_falls_back_to_defaults_when_root_is_not_an_object() {
        // A non-object root can't be section-recovered → full defaults, never a panic.
        let recovered = recover_settings_value(serde_json::json!("not an object"));
        assert_eq!(recovered, WinsttSettings::default());
    }

    // ── #47a atomic + durable write ──────────────────────────────────────────────

    #[test]
    fn atomic_write_json_persists_and_refreshes_backup() {
        let dir = std::env::temp_dir().join(format!("winstt_atomic_write_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let value = serde_json::json!({ "winstt_settings": { "model": { "model": "tiny" } } });

        atomic_write_json(&path, &value).expect("atomic write succeeds");

        // Primary file holds valid JSON …
        let on_disk: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(on_disk, value);
        // … and a `.bak` copy of the last-good file exists for recovery.
        let mut bak = path.as_os_str().to_owned();
        bak.push(".bak");
        let bak: serde_json::Value =
            serde_json::from_slice(&std::fs::read(PathBuf::from(bak)).unwrap()).unwrap();
        assert_eq!(bak, value);
        // No temp file left behind.
        assert!(!dir.join("settings.json.tmp").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
