// Settings persistence + apply. Wraps
// winstt::settings_schema (the ~150-field nested WinsttSettings tree).
//
// winstt_get_settings_snapshot / winstt_patch_settings expose the nested settings tree
// to the reused React renderer over tauri-specta. They are NOT thin getters/setters:
//
//   * winstt_get_settings_snapshot → reads the persisted store with its revision, opens secrets
//     for backend use, then masks those fields before returning the full nested tree
//     to the renderer (defaulting cleanly on a missing / partial blob).
//
//   * winstt_patch_settings → rejects stale revisions, then merges the PARTIAL section patch over
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
// dedicated `winstt_settings` key in `winstt-settings.json`.
//
// Runtime invariant: settings saves in this port must not emit manual restart events.
// Former restart-only settings are live-read or applied through targeted in-process
// reload/arm/disarm paths.
//
// This module root holds the public wire surface (commands + types + constants),
// the `apply_settings_patch` orchestrator, and the merge/validate/effective-realtime
// helpers. The cohesive concern clusters live in sibling submodules:
//   * `persistence`    — store I/O + secret seal/open/mask + cross-field normalization.
//   * `learning`       — auto-apply dictation learning appenders.
//   * `runtime`        — on-save runtime side-effects (model/tts/llm/history/audio/autostart).
//   * `wakeword`       — wakeword runtime state machine.
//   * `recording_mode` — recording-mode boundaries (finalize loopback and mic
//     captures through their normal output paths) whenever
//     `general.recordingMode` changes.

mod learning;
mod recording_mode;
mod runtime;
mod wakeword;

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter, Manager};

use crate::winstt::settings_schema::{
    AppProfileRule, AudioSettings, CustomModifier, DictionaryEntry, GeneralSettings,
    GlobalSettings, HotkeySettings, IntegrationsSettings, LiveTranscriptionDisplay, LlmFeatureBase,
    LlmSettings, ModelSettings, PresetEntry, PresetKey, QualitySettings, SECRET_KEYS, SnippetEntry,
    SoundLibraryEntry, TtsCloud, TtsSettings, WinsttSettings, is_secret,
};

use self::recording_mode::apply_recording_mode_runtime_settings;
use self::runtime::{
    apply_audio_runtime_settings, apply_autostart_setting, apply_encoder_dict_runtime_settings,
    apply_history_retention_settings, apply_llm_runtime_settings, apply_model_runtime_settings,
    apply_model_runtime_settings_after_stt_switch, apply_tts_runtime_settings,
};
use self::wakeword::apply_wakeword_runtime_settings;
use crate::winstt::settings_store::{
    normalize_cross_field_settings, preserve_masked_secrets, read_settings_for_renderer,
    sanitize_settings_for_renderer, settings_revision, try_read_settings, try_seal_secrets,
    with_settings_write_lock, word_by_word_pasting_effective, write_settings_value,
};

// Re-export the cluster items used outside this module. Visibilities mirror each
// item's original declaration (crate-internal
// helpers stay `pub(crate)`; the three `pub` reader entry points stay `pub`).
// Items that are only used WITHIN their own submodule (e.g. `should_keep_stt_model_warm`,
// `warm_llm_models_async`, `sync_wakeword_runtime_from_settings`) are intentionally
// NOT re-exported here — re-exporting an unused path would trip `-D warnings`.
pub(crate) use self::learning::auto_apply_dictation_learning;
pub(crate) use self::runtime::{
    core_timeout_from_winstt, enabled_ollama_models, ollama_models_for_enabled_features,
    should_warm_tts, warm_tts_async,
};
pub(crate) use self::wakeword::{
    disarm_wakeword_runtime_for_onboarding, rearm_wakeword_runtime_if_active,
    sync_wakeword_runtime_from_settings_in_background,
};
// The settings READ path + on-disk service now lives in the core
// `crate::winstt::settings_store` module (managers depend on it DOWNWARD). These
// re-exports provide the route-layer surface and secret sentinels.
pub use crate::winstt::settings_store::WINSTT_SETTINGS_KEY;
pub(crate) use crate::winstt::settings_store::read_settings_raw;
pub(crate) use crate::winstt::settings_store::{SECRET_PRESENT_SENTINEL, is_masked_secret};
pub use crate::winstt::settings_store::{
    init_settings_store, read_settings, recording_mode, seed_defaults, write_core_settings,
};

/// The `settings:changed` plain event — the post-save masked snapshot plus
/// revision and changed-section metadata. Other windows ignore stale revisions,
/// merge their still-dirty fields, and rebase instead of overwriting blindly.
pub(crate) const SETTINGS_CHANGED_EVENT: &str = "settings:changed";

/// The `settings:save-error` plain event — emitted on validation/persist failure
/// (the renderer's save path is fire-and-forget, so it can't see the `Result`).
/// Shape `{ error }` matches `onSettingsSaveError` in ipc-client.ts.
const SETTINGS_SAVE_ERROR_EVENT: &str = "settings:save-error";

/// Number of recording-mode saves that have persisted their new value but have
/// not yet completed the old mode's runtime teardown. The renderer updates mode
/// controls optimistically, so `start_listen` uses this boundary to avoid opening
/// loopback in the narrow window before the settings command finishes cleanup.
static RECORDING_MODE_TRANSITIONS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

struct RecordingModeTransitionGuard;

impl RecordingModeTransitionGuard {
    fn begin() -> Self {
        RECORDING_MODE_TRANSITIONS_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for RecordingModeTransitionGuard {
    fn drop(&mut self) {
        RECORDING_MODE_TRANSITIONS_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(crate) fn recording_mode_transition_in_progress() -> bool {
    RECORDING_MODE_TRANSITIONS_IN_FLIGHT.load(Ordering::SeqCst) != 0
}

/// One authoritative, renderer-safe settings snapshot and its monotonic process
/// revision. The revision prevents two windows from silently overwriting each
/// other with patches based on different snapshots.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub revision: u64,
    pub settings: WinsttSettings,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RevisionedSettingsPatch {
    pub base_revision: u64,
    pub settings: PartialWinsttSettings,
}

/// A revisioned patch always returns the latest authoritative snapshot. On a
/// conflict `applied` is false and the caller rebases its still-dirty fields on
/// `snapshot` before retrying; no stale write reaches disk.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatchResponse {
    pub applied: bool,
    pub snapshot: SettingsSnapshot,
    pub changed_sections: Vec<String>,
}

/// The partial section patch the renderer posts to `winstt_patch_settings`.
///
/// The renderer (`collectChangedSections` in `features/update-settings`) diffs
/// against its last-saved baseline and sends only the changed top-level sections
/// (e.g. VAD calibration and device-switch-feedback post just `{ audio }` after
/// every utterance). Every field is `Option` so an absent section deserializes
/// to `None` (= "leave the persisted value untouched") rather than resetting to a
/// default — preventing unrelated sections from being clobbered.
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

#[tauri::command]
#[specta::specta]
pub fn winstt_get_settings_snapshot(app: AppHandle) -> SettingsSnapshot {
    settings_snapshot(&app)
}

// ASYNC on purpose. A plain `#[tauri::command]` body runs INLINE on the thread
// that pumps the window event loop, and the save fan-out below blocks: it takes
// the settings write lock, rewrites the store, and — when `general.recordingMode`
// changes — finalizes the old mode's capture, which joins the loopback consumer
// and then waits up to 5 s for the transcription coordinator to acknowledge.
// On the event-loop thread that is a multi-second freeze of every window, which
// is what made leaving listen mode look like a hang.
#[tauri::command]
#[specta::specta]
pub async fn winstt_patch_settings(
    app: AppHandle,
    window: tauri::Window,
    request: RevisionedSettingsPatch,
) -> Result<SettingsPatchResponse, String> {
    let base_revision = request.base_revision;
    let sections = patch_section_names(&request.settings).join(",");
    log::debug!(
        "[settings] revisioned save from window '{}' base={base_revision} sections=[{sections}]",
        window.label(),
    );
    let app_for_patch = app.clone();
    let patch = request.settings;
    let applied = tauri::async_runtime::spawn_blocking(move || {
        apply_settings_patch_inner(
            &app_for_patch,
            patch,
            true,
            Some(base_revision),
            PatchOrigin::Renderer,
        )
    })
    .await
    .map_err(|error| format!("settings save task panicked: {error}"))?;
    match applied {
        Ok(applied) => Ok(SettingsPatchResponse {
            applied: true,
            snapshot: SettingsSnapshot {
                revision: applied.revision,
                settings: applied.snapshot,
            },
            changed_sections: applied.changed_sections,
        }),
        Err(ApplyPatchError::Conflict { actual, .. }) => {
            log::debug!(
                "[settings] rejected stale save from window '{}': base={base_revision}, current={actual}",
                window.label(),
            );
            Ok(SettingsPatchResponse {
                applied: false,
                snapshot: settings_snapshot(&app),
                changed_sections: Vec::new(),
            })
        }
        Err(ApplyPatchError::Other(error)) => {
            let _ = app.emit(
                SETTINGS_SAVE_ERROR_EVENT,
                serde_json::json!({ "error": error }),
            );
            Err(error)
        }
    }
}

fn settings_snapshot(app: &AppHandle) -> SettingsSnapshot {
    with_settings_write_lock(|| SettingsSnapshot {
        revision: settings_revision(),
        settings: read_settings_for_renderer(app),
    })
}

/// The top-level section names present in a partial save.
fn patch_section_names(patch: &PartialWinsttSettings) -> Vec<&'static str> {
    [
        ("global", patch.global.is_some()),
        ("model", patch.model.is_some()),
        ("quality", patch.quality.is_some()),
        ("audio", patch.audio.is_some()),
        ("general", patch.general.is_some()),
        ("hotkey", patch.hotkey.is_some()),
        ("dictionary", patch.dictionary.is_some()),
        ("snippets", patch.snippets.is_some()),
        ("llm", patch.llm.is_some()),
        ("tts", patch.tts.is_some()),
        ("integrations", patch.integrations.is_some()),
    ]
    .into_iter()
    .filter_map(|(name, present)| present.then_some(name))
    .collect()
}

/// Internal patch entry point for backend-owned settings mutations.
pub fn apply_settings_patch(app: &AppHandle, patch: PartialWinsttSettings) -> Result<(), String> {
    apply_settings_patch_inner(app, patch, true, None, PatchOrigin::Backend)
        .map(|_| ())
        .map_err(ApplyPatchError::into_string)
}

/// Replace every renderer-owned settings section from a trusted import/reset.
/// Unlike an ordinary renderer patch, a replacement may intentionally restore
/// several customized sections to their defaults in one operation.
pub(crate) fn apply_settings_replacement(
    app: &AppHandle,
    settings: &WinsttSettings,
) -> Result<SettingsSnapshot, String> {
    let applied = apply_settings_patch_inner(
        app,
        full_tree_patch(settings),
        true,
        None,
        PatchOrigin::TrustedReplacement,
    )
    .map_err(ApplyPatchError::into_string)?;
    Ok(SettingsSnapshot {
        revision: applied.revision,
        settings: applied.snapshot,
    })
}

/// Reset every renderer-owned settings section through the trusted replacement
/// path. The command broadcasts the canonical snapshot exactly like a normal
/// save, but cannot be mistaken for an unhydrated renderer dumping defaults.
///
/// `(async)` keeps it off the main thread: resetting can change the microphone release
/// policy or input device, which restarts the capture stream — seconds of blocking device
/// work that must not run on the UI thread. The normal settings-patch command is already
/// async for the same reason.
#[tauri::command(async)]
#[specta::specta]
pub fn settings_reset_defaults(app: AppHandle) -> Result<SettingsSnapshot, String> {
    apply_settings_replacement(&app, &WinsttSettings::default())
}

/// Persist and broadcast a settings patch whose STT model lifecycle is already owned by the
/// caller. All non-STT runtime side effects still run; only the duplicate model reload is skipped.
pub(super) fn apply_settings_patch_after_stt_switch(
    app: &AppHandle,
    patch: PartialWinsttSettings,
) -> Result<(), String> {
    apply_settings_patch_inner(app, patch, false, None, PatchOrigin::Backend)
        .map(|_| ())
        .map_err(ApplyPatchError::into_string)
}

struct AppliedPatch {
    revision: u64,
    snapshot: WinsttSettings,
    changed_sections: Vec<String>,
}

enum ApplyPatchError {
    Conflict { expected: u64, actual: u64 },
    Other(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PatchOrigin {
    /// A current-schema patch sent by a renderer window. Invalid requested
    /// values are rejected; the acknowledgement must never claim they applied.
    Renderer,
    /// A narrow mutation produced by backend-owned code. Legacy values in the
    /// same whole section may be salvaged so an unrelated update can proceed.
    Backend,
    /// A user-confirmed import/reset. Full-tree defaults are intentional here,
    /// not the unhydrated-renderer wipe shape guarded on ordinary patches.
    TrustedReplacement,
}

impl ApplyPatchError {
    fn into_string(self) -> String {
        match self {
            Self::Conflict { expected, actual } => {
                format!("settings revision conflict: expected {expected}, current {actual}")
            }
            Self::Other(error) => error,
        }
    }
}

impl From<String> for ApplyPatchError {
    fn from(value: String) -> Self {
        Self::Other(value)
    }
}

fn apply_settings_patch_inner(
    app: &AppHandle,
    patch: PartialWinsttSettings,
    apply_stt_model_runtime: bool,
    expected_revision: Option<u64>,
    origin: PatchOrigin,
) -> Result<AppliedPatch, ApplyPatchError> {
    let section_names = patch_section_names(&patch);
    // The full read→merge→seal→write span runs UNDER the process-wide settings write
    // lock so two concurrent section patches (e.g. the renderer's per-utterance
    // `{audio}` save racing the LLM learning thread's `{dictation}` append) can't both
    // read the same `previous`, each graft only their own section, and have the last
    // writer silently drop the other's section (H2). Runtime side-effects and the
    // renderer broadcast run AFTER the lock is released — they call back into
    // `get_settings` / `read_settings`, so keeping them outside the guard avoids any
    // nested settings-lock acquisition (the lock is non-reentrant).
    let (previous, next, changed, revision, _recording_mode_guard, changed_sections) =
        with_settings_write_lock(|| {
            let actual_revision = settings_revision();
            if let Some(expected) = expected_revision
                && expected != actual_revision
            {
                return Err(ApplyPatchError::Conflict {
                    expected,
                    actual: actual_revision,
                });
            }
            // `previous` here is the PLAINTEXT view (secrets opened). The renderer's patch
            // is plaintext too, so the merge + diff operate entirely in plaintext — like
            // the reference's `snapshotSettings`, which decrypts before diffing.
            let previous = try_read_settings(app).map_err(ApplyPatchError::Other)?;

            if origin == PatchOrigin::Renderer {
                reject_renderer_wholesale_reset(&previous, &patch)
                    .map_err(ApplyPatchError::Other)?;
            }

            // Merge the partial patch over the persisted full snapshot, section by section
            // (matching `applySettings` / `mergeMainOwnedFields`). Each present section
            // overwrites its counterpart wholesale; absent sections keep the persisted
            // value; `general` preserves the main-owned `onboarded*` fields.
            let mut next = merge_patch_over_with_origin(&previous, patch, origin);
            preserve_masked_secrets(&previous, &mut next);

            // (a) cross-field validation (the Zod `.refine` equivalents) — scoped to
            //     the sections this patch posts, so a bad value already persisted in
            //     an UNTOUCHED section can't reject unrelated saves forever. A section
            //     that fails is SALVAGED field-by-field (validation rules drift across
            //     app versions — catalogs, allowlists, numeric ranges — and a save must
            //     never be permanently wedged by state an older version wrote); only a
            //     section that is still invalid after salvage rejects the patch.
            if origin == PatchOrigin::Renderer {
                validate_sections(&next, &section_names).map_err(ApplyPatchError::Other)?;
            } else {
                salvage_invalid_sections(&mut next, &previous, &section_names)
                    .map_err(ApplyPatchError::Other)?;
            }

            let changed_sections = changed_section_names(&previous, &next);

            if next == previous {
                return Ok((
                    previous,
                    next,
                    false,
                    actual_revision,
                    None,
                    changed_sections,
                ));
            }

            // (c) seal the secret fields at rest, then persist. Clone so runtime
            //     side-effects keep the plaintext `next`; only the on-disk copy is
            //     sealed and the renderer broadcast is masked below.
            let mut to_persist = next.clone();
            try_seal_secrets(&mut to_persist).map_err(ApplyPatchError::Other)?;
            debug_assert!(SECRET_KEYS.iter().all(|k| is_secret(k)));
            let recording_mode_guard = (previous.general.recording_mode
                != next.general.recording_mode)
                .then(RecordingModeTransitionGuard::begin);
            write_settings_value(app, &to_persist).map_err(ApplyPatchError::Other)?;

            Ok((
                previous,
                next,
                true,
                settings_revision(),
                recording_mode_guard,
                changed_sections,
            ))
        })?;
    if !changed {
        let mut snapshot = next;
        sanitize_settings_for_renderer(&mut snapshot);
        return Ok(AppliedPatch {
            revision,
            snapshot,
            changed_sections,
        });
    }
    if previous.general.recording_mode != next.general.recording_mode
        || previous.general.wake_word != next.general.wake_word
    {
        log::debug!(
            "[settings] saved recordingMode={:?}; wake-word setting changed={}",
            next.general.recording_mode,
            previous.general.wake_word != next.general.wake_word
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
    if apply_stt_model_runtime {
        apply_model_runtime_settings(app, &previous, &next);
    } else {
        apply_model_runtime_settings_after_stt_switch(app, &previous, &next);
    }
    apply_tts_runtime_settings(app, &previous, &next);
    apply_encoder_dict_runtime_settings(app, &previous, &next);
    apply_llm_runtime_settings(app, &previous, &next);
    apply_wakeword_runtime_settings(app, &previous, &next);
    apply_recording_mode_runtime_settings(app, &previous, &next);
    apply_history_retention_settings(app, &previous, &next);
    apply_audio_runtime_settings(app, &previous, &next);
    apply_autostart_setting(app, &previous, &next);
    if previous.general.overlay_mode != next.general.overlay_mode
        || previous.general.overlay_position != next.general.overlay_position
        || previous.general.show_recording_overlay != next.general.show_recording_overlay
    {
        crate::winstt::commands::overlay::reposition_overlay_if_visible(app);
    }
    crate::tray::set_tray_visualizer_style_from_general(&next.general);
    if let Some(realtime) =
        app.try_state::<std::sync::Arc<crate::winstt::managers::RealtimeManager>>()
    {
        realtime.notify_external_conditions_changed();
    }

    // (d) broadcast the post-save full snapshot (not the raw partial) so every
    //     other window re-hydrates the same canonical view. Secret fields are
    //     masked before crossing IPC; a later save that echoes the sentinel
    //     preserves the stored secret, while an empty string still clears it.
    let mut renderer_next = next;
    sanitize_settings_for_renderer(&mut renderer_next);
    let _ = app.emit(
        SETTINGS_CHANGED_EVENT,
        serde_json::json!({
            "revision": revision,
            "changedSections": changed_sections,
            "settings": renderer_next,
        }),
    );

    Ok(AppliedPatch {
        revision,
        snapshot: renderer_next,
        changed_sections,
    })
}

/// Did any WinSTT-tree global hotkey's accelerator OR enable flag change between two
/// snapshots? Used to trigger `reconcile_winstt_hotkeys` on save. Covers the
/// transforms hotkey + enable, post-processing profile swap hotkey + enable, the TTS
/// read-aloud hotkey + enable, and the re-paste hotkey (no enable flag). The PTT
/// hotkey is intentionally excluded — the renderer owns its registration via
/// `hotkey_register`.
fn winstt_hotkeys_changed(prev: &WinsttSettings, next: &WinsttSettings) -> bool {
    prev.llm.transforms.hotkey != next.llm.transforms.hotkey
        || prev.llm.transforms.enabled != next.llm.transforms.enabled
        || prev.llm.profile_swap_hotkey != next.llm.profile_swap_hotkey
        || prev.llm.dictation.enabled != next.llm.dictation.enabled
        || prev.tts.hotkey != next.tts.hotkey
        || prev.tts.enabled != next.tts.enabled
        || prev.general.repaste_hotkey != next.general.repaste_hotkey
}

/// `isRealtimeEnabled({ showRecordingOverlay, liveTranscriptionDisplay, wordByWordPasting })`
/// ported from shared/lib/realtime-enabled.ts. The pill path ("in-pill"/"both") gates on
/// the overlay being shown; in-app/both always render. Word-by-word paste also needs the
/// realtime worker even when the visual preview is off.
///
/// Focus-AGNOSTIC capability gate: does ANY realtime surface exist for these settings? Used
/// by config-time callers (restart-key diffing, tests). The realtime worker uses
/// [`effective_realtime_with_focus`] instead, which additionally skips the model when the
/// only surface is the in-app panel and no WinSTT window is focused to show it.
pub fn effective_realtime(settings: &WinsttSettings) -> bool {
    // `app_focused = true` ⇒ the in-app panel counts as a renderable surface, preserving the
    // original focus-agnostic semantics for capability checks.
    effective_realtime_with_focus(settings, true)
}

/// Focus-AWARE realtime gate used by the recording worker. The in-app live-transcription
/// panel renders INSIDE the main WinSTT window, so it's only visible when one of our windows
/// holds OS focus; when unfocused, running the realtime model purely to feed that invisible
/// panel is wasted work. The pill overlay is a SEPARATE always-on-top window that stays
/// visible regardless of focus, and word-by-word pasting types the text (no visible surface
/// needed) — both keep running while unfocused.
///   - none:    never (no surface renders).
///   - in-app:  only when a WinSTT window is focused (the panel is otherwise invisible).
///   - in-pill: only when the overlay is shown (focus-agnostic — the pill floats on top).
///   - both:    overlay shown (pill visible) OR a window focused (in-app visible).
pub fn effective_realtime_with_focus(settings: &WinsttSettings, app_focused: bool) -> bool {
    if word_by_word_pasting_effective(settings) {
        return true;
    }

    let overlay = settings.general.show_recording_overlay;
    match settings.general.live_transcription_display {
        LiveTranscriptionDisplay::None => false,
        LiveTranscriptionDisplay::InApp => app_focused,
        LiveTranscriptionDisplay::InPill => overlay,
        LiveTranscriptionDisplay::Both => overlay || app_focused,
    }
}

/// Merge a partial section patch over the current full tree. Each `Some(section)`
/// OVERWRITES wholesale; a `None` section keeps the persisted value. For `general`,
/// the main-owned `onboarded*` fields are restored from the persisted copy so a
/// renderer round-trip can't revert them. Mirrors the reference's `applySettings`.
#[cfg(test)]
fn merge_patch_over(current: &WinsttSettings, patch: PartialWinsttSettings) -> WinsttSettings {
    merge_patch_over_with_origin(current, patch, PatchOrigin::Backend)
}

fn merge_patch_over_with_origin(
    current: &WinsttSettings,
    patch: PartialWinsttSettings,
    origin: PatchOrigin,
) -> WinsttSettings {
    // The wholesale-reset guard (`accept_section`) only arms for FULL-TREE
    // patches: a diff-based renderer save posts a SUBSET of sections, and a
    // single section landing on exact defaults there is a legitimate edit
    // (e.g. toggling the one customized `llm` field back off). A patch posting
    // EVERY section is the "whole store dumped" shape — the only producer of
    // that with defaulted sections is an unhydrated/empty-cache window.
    let full_tree = patch_is_full_tree(&patch) && origin != PatchOrigin::TrustedReplacement;
    let mut next = current.clone();
    if let Some(global) = accept_section("global", &current.global, patch.global, full_tree) {
        next.global = global;
    }
    if let Some(model) = accept_section("model", &current.model, patch.model, full_tree) {
        next.model = model;
    }
    if let Some(quality) = accept_section("quality", &current.quality, patch.quality, full_tree) {
        next.quality = quality;
    }
    if let Some(audio) = accept_section("audio", &current.audio, patch.audio, full_tree) {
        next.audio = audio;
    }
    if let Some(general) = accept_section("general", &current.general, patch.general, full_tree) {
        next.general = preserve_main_owned_general(&current.general, general);
    }
    if let Some(hotkey) = accept_section("hotkey", &current.hotkey, patch.hotkey, full_tree) {
        next.hotkey = hotkey;
    }
    if let Some(dictionary) = accept_section(
        "dictionary",
        &current.dictionary,
        patch.dictionary,
        full_tree,
    ) {
        next.dictionary = dictionary;
    }
    if let Some(snippets) = accept_section("snippets", &current.snippets, patch.snippets, full_tree)
    {
        next.snippets = snippets;
    }
    if let Some(llm) = accept_section("llm", &current.llm, patch.llm, full_tree) {
        next.llm = llm;
    }
    if let Some(tts) = accept_section("tts", &current.tts, patch.tts, full_tree) {
        next.tts = tts;
    }
    if let Some(integrations) = accept_section(
        "integrations",
        &current.integrations,
        patch.integrations,
        full_tree,
    ) {
        next.integrations = integrations;
    }
    normalize_cross_field_settings(&mut next);
    if origin != PatchOrigin::Renderer {
        heal_model_quantization(&mut next);
    }
    next
}

fn full_tree_patch(settings: &WinsttSettings) -> PartialWinsttSettings {
    PartialWinsttSettings {
        global: Some(settings.global),
        model: Some(settings.model.clone()),
        quality: Some(settings.quality.clone()),
        audio: Some(settings.audio.clone()),
        general: Some(settings.general.clone()),
        hotkey: Some(settings.hotkey.clone()),
        dictionary: Some(settings.dictionary.clone()),
        snippets: Some(settings.snippets.clone()),
        llm: Some(settings.llm.clone()),
        tts: Some(settings.tts.clone()),
        integrations: Some(settings.integrations.clone()),
    }
}

/// Sections that actually differ after merge, normalization, validation, and
/// secret preservation. This is the only truthful value for acknowledgements
/// and cross-window broadcasts: posted keys can be unchanged, and one posted
/// section can canonically change a sibling through a cross-field invariant.
fn changed_section_names(previous: &WinsttSettings, next: &WinsttSettings) -> Vec<String> {
    [
        ("global", previous.global != next.global),
        ("model", previous.model != next.model),
        ("quality", previous.quality != next.quality),
        ("audio", previous.audio != next.audio),
        ("general", previous.general != next.general),
        ("hotkey", previous.hotkey != next.hotkey),
        ("dictionary", previous.dictionary != next.dictionary),
        ("snippets", previous.snippets != next.snippets),
        ("llm", previous.llm != next.llm),
        ("tts", previous.tts != next.tts),
        ("integrations", previous.integrations != next.integrations),
    ]
    .into_iter()
    .filter(|(_, changed)| *changed)
    .map(|(name, _)| name.to_string())
    .collect()
}

fn resets_customized_section<T: Default + PartialEq>(current: &T, incoming: Option<&T>) -> bool {
    incoming.is_some_and(|value| *value == T::default() && *current != T::default())
}

/// A renderer full-tree defaults dump is the known unhydrated-cache corruption
/// shape. Reject the command explicitly so its Result cannot claim `applied`
/// after silently retaining persisted values. Confirmed reset/import actions
/// use [`PatchOrigin::TrustedReplacement`] and never pass through this guard.
fn reject_renderer_wholesale_reset(
    current: &WinsttSettings,
    patch: &PartialWinsttSettings,
) -> Result<(), String> {
    if !patch_is_full_tree(patch) {
        return Ok(());
    }
    let rejected = [
        (
            "global",
            resets_customized_section(&current.global, patch.global.as_ref()),
        ),
        (
            "model",
            resets_customized_section(&current.model, patch.model.as_ref()),
        ),
        (
            "quality",
            resets_customized_section(&current.quality, patch.quality.as_ref()),
        ),
        (
            "audio",
            resets_customized_section(&current.audio, patch.audio.as_ref()),
        ),
        (
            "general",
            resets_customized_section(&current.general, patch.general.as_ref()),
        ),
        (
            "hotkey",
            resets_customized_section(&current.hotkey, patch.hotkey.as_ref()),
        ),
        (
            "dictionary",
            resets_customized_section(&current.dictionary, patch.dictionary.as_ref()),
        ),
        (
            "snippets",
            resets_customized_section(&current.snippets, patch.snippets.as_ref()),
        ),
        (
            "llm",
            resets_customized_section(&current.llm, patch.llm.as_ref()),
        ),
        (
            "tts",
            resets_customized_section(&current.tts, patch.tts.as_ref()),
        ),
        (
            "integrations",
            resets_customized_section(&current.integrations, patch.integrations.as_ref()),
        ),
    ]
    .into_iter()
    .filter_map(|(name, reset)| reset.then_some(name))
    .collect::<Vec<_>>();
    if rejected.is_empty() {
        return Ok(());
    }
    Err(format!(
        "rejected full-tree settings patch that would reset customized section(s): {}; use the confirmed reset/import command",
        rejected.join(", ")
    ))
}

/// HEAL an unusable `{model.model, model.onnxQuantization}` couple instead of
/// letting `validate_quantization` reject the whole save.
///
/// The couple goes inconsistent transiently by design: quant picks, model swaps,
/// runtime fallbacks, and cross-window adoption each persist at different times,
/// so a debounced section save can post a precision that belongs to a model other
/// than the one currently in `model.model` (observed live: `fp16w` posted while
/// `model` still read `alphacep/vosk-model-small-ru` mid-switch). The renderer
/// mirrors (`resolveSwapQuantization` / `reconcileAdoptedQuant`) and the swap
/// path's `reconcile_persisted_quant` each guard their own write, but any NEW
/// write path re-opens the hole — healing at the merge choke point closes the
/// class. Resets to `""` (the universal default every catalog entry ships; the
/// server re-resolves it per model), matching `reconcile_persisted_quant`. The
/// swap that caused the mismatch persists its own correct couple on completion.
fn heal_model_quantization(next: &mut WinsttSettings) {
    if let Err(detail) = validate_quantization(&next.model.model, &next.model.onnx_quantization) {
        log::warn!(
            "[settings] healed model.onnxQuantization '{}' for model '{}' to the universal \
             default ({detail})",
            next.model.onnx_quantization,
            next.model.model,
        );
        next.model.onnx_quantization = String::new();
    }
}

/// True when the patch posts EVERY top-level section — the "whole store dumped"
/// shape that arms the wholesale-reset guard in [`accept_section`].
fn patch_is_full_tree(patch: &PartialWinsttSettings) -> bool {
    patch.global.is_some()
        && patch.model.is_some()
        && patch.quality.is_some()
        && patch.audio.is_some()
        && patch.general.is_some()
        && patch.hotkey.is_some()
        && patch.dictionary.is_some()
        && patch.snippets.is_some()
        && patch.llm.is_some()
        && patch.tts.is_some()
        && patch.integrations.is_some()
}

/// A section is posted WHOLE (`collectChangedSections` copies the entire section
/// value), so `merge_patch_over` replaces it wholesale. Within a FULL-TREE patch
/// (`in_full_tree_patch`), an incoming section that is ALL-DEFAULTS while the
/// persisted one is customized is REJECTED (kept at the current value), not
/// merged (finding #21, hardened 2026-07-12).
///
/// Rationale: that exact shape is what a renderer window with an unhydrated /
/// empty-cache store posts at boot (observed live via the save-origin trace: the
/// main window posted a full defaults tree ~60s after boot — wakeWord back to
/// "alexa", model back to "tiny" — wiping the user's real settings the moment the
/// disk write path was fixed). A whole-store dump where sections land on EXACTLY
/// every schema default is "no information", not user intent. Diff-based partial
/// saves are exempt: there a defaults-equal section is a legitimate edit (the
/// user toggled the section's one customized field back off).
fn accept_section<T: PartialEq + Default>(
    section: &str,
    current: &T,
    incoming: Option<T>,
    in_full_tree_patch: bool,
) -> Option<T> {
    let incoming = incoming?;
    if in_full_tree_patch && reject_wholesale_reset(section, current, &incoming) {
        return None;
    }
    Some(incoming)
}

/// True (and logs) when `incoming` is the all-defaults section over a customized
/// `current` — the corrupt/unhydrated-renderer shape `accept_section` drops.
fn reject_wholesale_reset<T: PartialEq + Default>(
    section: &str,
    current: &T,
    incoming: &T,
) -> bool {
    if *incoming == T::default() && *current != T::default() {
        log::warn!(
            "[settings] `{section}` patch resets the whole section to defaults; \
             REJECTED; kept the persisted section (finding #21)"
        );
        return true;
    }
    false
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

/// Full-tree validation over every section. Production paths validate SCOPED
/// subsets via [`validate_sections`] (the patch path passes the posted sections,
/// the swap path passes `["model"]`); tests assert the complete ruleset here.
#[cfg(test)]
pub(super) fn validate_settings(settings: &WinsttSettings) -> Result<(), String> {
    validate_sections(
        settings,
        &[
            "global",
            "model",
            "quality",
            "audio",
            "general",
            "hotkey",
            "dictionary",
            "snippets",
            "llm",
            "tts",
            "integrations",
        ],
    )
}

/// Field-level salvage of patched sections that fail validation — the write-time
/// mirror of `settings_store::salvage_section_fields` (which salvages PARSE
/// failures), with the section validator as the oracle instead of serde.
///
/// Why: validation rules drift between app versions (catalog memberships, hotkey
/// token allowlists, builtin-asset lists, numeric ranges, endpoint rules). A
/// section is always posted WHOLE, so one field persisted under an older rule
/// set would otherwise make every future save of that section fail — observed
/// classes: a retired TTS catalog id breaking even the pill's speed slider, a
/// once-allowed non-loopback Ollama endpoint breaking background auto-learning.
///
/// Strategy per failing section: rebuild over a base (the PERSISTED section if
/// it still validates, else the schema defaults), then layer each incoming field
/// one at a time, keeping it only while the section stays valid. Good edits in
/// the same save survive; only the offending field reverts (to its persisted
/// value, or its default when the persisted value is itself the drifted one).
/// Array sections (dictionary/snippets) salvage per ENTRY instead. Errors only
/// if a section is somehow still invalid after salvage (defaults always
/// validate, so that would be a bug).
fn salvage_invalid_sections(
    next: &mut WinsttSettings,
    previous: &WinsttSettings,
    sections: &[&str],
) -> Result<(), String> {
    let failing: Vec<&str> = sections
        .iter()
        .copied()
        .filter(|section| validate_sections(next, &[*section]).is_err())
        .collect();
    if failing.is_empty() {
        return Ok(());
    }
    let mut tree = serde_json::to_value(&*next).map_err(|e| e.to_string())?;
    let previous_tree = serde_json::to_value(previous).map_err(|e| e.to_string())?;
    let defaults_tree =
        serde_json::to_value(WinsttSettings::default()).map_err(|e| e.to_string())?;
    for section in failing {
        let incoming = tree
            .get(section)
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let base = if validate_sections(previous, &[section]).is_ok() {
            previous_tree.get(section).cloned()
        } else {
            defaults_tree.get(section).cloned()
        }
        .unwrap_or(serde_json::Value::Null);
        salvage_section_value(&mut tree, section, incoming, base)?;
    }
    *next = serde_json::from_value(tree).map_err(|e| e.to_string())?;
    validate_sections(next, sections)
}

/// Salvage one section in `tree`: layer `incoming` over `base` piecewise
/// (object → per field, array → per entry), keeping each piece only while
/// `validate_sections` accepts the section. Logs every dropped piece.
fn salvage_section_value(
    tree: &mut serde_json::Value,
    section: &str,
    incoming: serde_json::Value,
    base: serde_json::Value,
) -> Result<(), String> {
    let section_valid = |tree: &serde_json::Value| -> Result<bool, String> {
        let candidate: WinsttSettings =
            serde_json::from_value(tree.clone()).map_err(|e| e.to_string())?;
        Ok(validate_sections(&candidate, &[section]).is_ok())
    };
    match incoming {
        serde_json::Value::Object(fields) => {
            tree[section] = base;
            for (field, value) in fields {
                let kept = tree[section]
                    .as_object()
                    .and_then(|obj| obj.get(&field).cloned());
                tree[section][&field] = value;
                if !section_valid(tree)? {
                    log::warn!(
                        "[settings] salvaged `{section}.{field}`: incoming value fails current \
                         validation; kept the persisted/default value instead"
                    );
                    match kept {
                        Some(previous_value) => tree[section][&field] = previous_value,
                        None => {
                            if let Some(obj) = tree[section].as_object_mut() {
                                obj.remove(&field);
                            }
                        }
                    }
                }
            }
        }
        serde_json::Value::Array(entries) => {
            tree[section] = serde_json::Value::Array(Vec::new());
            for (index, entry) in entries.into_iter().enumerate() {
                if let Some(items) = tree[section].as_array_mut() {
                    items.push(entry);
                }
                if !section_valid(tree)? {
                    log::warn!(
                        "[settings] salvaged `{section}[{index}]`: entry fails current \
                         validation; dropped it"
                    );
                    if let Some(items) = tree[section].as_array_mut() {
                        items.pop();
                    }
                }
            }
        }
        other => {
            tree[section] = other;
            if !section_valid(tree)? {
                log::warn!(
                    "[settings] salvaged `{section}`: value fails current validation; reset to \
                     the persisted/default value"
                );
                tree[section] = base;
            }
        }
    }
    Ok(())
}

/// Validate only the named top-level sections of a merged tree.
///
/// The patch path validates ONLY the sections the caller actually posts: an
/// invalid value already sitting in a PERSISTED, untouched section (e.g. an app
/// update retiring a quantization the catalog used to publish, or a stale LLM
/// model id) must degrade that one section — never permanently reject every
/// future save of every other section, and never fail an STT model swap.
pub(super) fn validate_sections(
    settings: &WinsttSettings,
    sections: &[&str],
) -> Result<(), String> {
    for section in sections {
        match *section {
            "model" => validate_model_settings(&settings.model)?,
            "quality" => validate_quality_settings(&settings.quality)?,
            "audio" => validate_audio_settings(&settings.audio)?,
            "general" => validate_general_settings(&settings.general)?,
            "hotkey" => validate_hotkey(
                "hotkey.pushToTalkKey",
                &settings.hotkey.push_to_talk_key,
                true,
            )?,
            "dictionary" => validate_dictionary(&settings.dictionary)?,
            "snippets" => validate_snippets(&settings.snippets)?,
            "llm" => {
                validate_llm_settings(&settings.llm)?;
                validate_presets(&settings.llm.dictation.presets)?;
                validate_presets(&settings.llm.transforms.presets)?;
                crate::winstt::llm::validate_loopback_ollama_endpoint(&settings.llm.endpoint)?;
            }
            "tts" => validate_tts_settings(&settings.tts)?,
            "integrations" => validate_integrations(&settings.integrations)?,
            // `global` has no field validators (enum-typed; serde rejects bad values).
            _ => {}
        }
    }
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
const MAX_APP_PROFILES: usize = 128;
const MAX_PRESETS: usize = 10;
const MAX_SOUND_LIBRARY_ENTRIES: usize = 50;
const MAX_CONTEXT_LIST_ENTRIES: usize = 256;
const MAX_CONTEXT_ENTRY_LEN: usize = 253;
const MAX_CUSTOM_WAKE_WORDS: usize = 32;
const MAX_DEVICE_SENSITIVITY_ENTRIES: usize = 128;
const MAX_DEVICE_ID_LEN: usize = 512;
const MAX_PATH_LEN: usize = 4096;
const MAX_OUTPUT_TOKENS: i64 = 200_000;
const BUILTIN_RECORDING_SOUND_FILES: &[&str] = &["marimba_start.wav"];

fn validate_model_settings(model: &ModelSettings) -> Result<(), String> {
    validate_model_id("model.model", &model.model, true)?;
    // `realtimeModel` is OPTIONAL: `""` is the "no live-preview model" state.
    // The renderer's swap logic clears it whenever the chosen main model has no
    // native-streaming companion (see apply-swap.ts `realtimePatchForMainSwap`),
    // `cleanup` clears it on quant deletion, and `runtime.rs` already maps empty
    // → `None`. Requiring it non-empty rejected the WHOLE save when a user picked
    // a non-streaming model (e.g. GigaAM RU), reverting their pick to the default.
    validate_model_id("model.realtimeModel", &model.realtime_model, false)?;
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
            0.1,
            10.0,
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
        (
            "general.dictionaryContextChars",
            general.dictionary_context_chars,
            220,
            1000,
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
    validate_hotkey("llm.profileSwapHotkey", &llm.profile_swap_hotkey, true)?;
    validate_model_id("llm.localModel", &llm.local_model, false)?;
    validate_llm_feature_base("llm.dictation", &llm.dictation.base)?;
    validate_short_text(
        "llm.dictation.configurationId",
        &llm.dictation.configuration_id,
        MAX_ID_LEN,
        false,
    )?;
    validate_presets_len("llm.dictation.presets", &llm.dictation.presets)?;
    validate_custom_modifiers(
        "llm.dictation.customModifiers",
        &llm.dictation.custom_modifiers,
    )?;
    validate_llm_feature_base("llm.readAloud", &llm.read_aloud.base)?;
    validate_short_text(
        "llm.readAloud.configurationId",
        &llm.read_aloud.configuration_id,
        MAX_ID_LEN,
        false,
    )?;
    validate_presets_len("llm.readAloud.presets", &llm.read_aloud.presets)?;
    validate_presets(&llm.read_aloud.presets)?;
    validate_custom_modifiers(
        "llm.readAloud.customModifiers",
        &llm.read_aloud.custom_modifiers,
    )?;
    validate_llm_feature_base("llm.transforms", &llm.transforms.base)?;
    validate_short_text(
        "llm.transforms.configurationId",
        &llm.transforms.configuration_id,
        MAX_ID_LEN,
        false,
    )?;
    validate_presets_len("llm.transforms.presets", &llm.transforms.presets)?;
    validate_custom_modifiers(
        "llm.transforms.customModifiers",
        &llm.transforms.custom_modifiers,
    )?;
    validate_hotkey("llm.transforms.hotkey", &llm.transforms.hotkey, true)?;
    validate_app_profiles(&llm.app_profiles.rules)?;
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
    let mut ids = std::collections::HashSet::new();
    for (index, modifier) in items.iter().enumerate() {
        let base = format!("{path}[{index}]");
        validate_short_text(&format!("{base}.id"), &modifier.id, MAX_ID_LEN, true)?;
        if !ids.insert(modifier.id.as_str()) {
            return Err(format!("{path}: duplicate modifier id `{}`", modifier.id));
        }
        validate_short_text(
            &format!("{base}.name"),
            &modifier.name,
            MAX_SHORT_TEXT_LEN,
            false,
        )?;
        validate_text(&format!("{base}.prompt"), &modifier.prompt, MAX_PROMPT_LEN)?;
        if matches!(
            modifier.level,
            Some(crate::winstt::settings_schema::PresetLevel::Caveman)
        ) {
            return Err(format!(
                "{base}.level: caveman is reserved for the concise preset"
            ));
        }
    }
    Ok(())
}

fn validate_app_profiles(rules: &[AppProfileRule]) -> Result<(), String> {
    validate_collection_len("llm.appProfiles.rules", rules.len(), MAX_APP_PROFILES)?;
    let mut ids = std::collections::HashSet::new();
    for (index, rule) in rules.iter().enumerate() {
        let path = format!("llm.appProfiles.rules[{index}]");
        validate_short_text(&format!("{path}.id"), &rule.id, MAX_ID_LEN, true)?;
        if !ids.insert(rule.id.as_str()) {
            return Err(format!(
                "llm.appProfiles.rules: duplicate rule id `{}`",
                rule.id
            ));
        }
        validate_short_text(
            &format!("{path}.appExe"),
            &rule.app_exe,
            MAX_SHORT_TEXT_LEN,
            false,
        )?;
        validate_text(
            &format!("{path}.titlePattern"),
            &rule.title_pattern,
            MAX_SHORT_TEXT_LEN,
        )?;
        validate_text(
            &format!("{path}.urlPattern"),
            &rule.url_pattern,
            MAX_ENDPOINT_LEN,
        )?;
        validate_short_text(
            &format!("{path}.configurationId"),
            &rule.configuration_id,
            MAX_ID_LEN,
            false,
        )?;
        validate_short_text(
            &format!("{path}.configurationName"),
            &rule.configuration_name,
            MAX_SHORT_TEXT_LEN,
            false,
        )?;
        validate_llm_feature_base(&format!("{path}.config"), &rule.config.base)?;
        validate_presets_len(&format!("{path}.config.presets"), &rule.config.presets)?;
        validate_presets(&rule.config.presets)?;
        validate_custom_modifiers(
            &format!("{path}.config.customModifiers"),
            &rule.config.custom_modifiers,
        )?;
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
    // Supertonic supports 0.4x; all other local engines clamp to their own
    // narrower floor at synthesis time.
    validate_finite_range("tts.speed", tts.speed, 0.4, 2.0)?;
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
        "", "auto", "fp16", "fp16w", "q4", "q4f16", "bnb4", "int8", "uint8", "int4",
    ];
    if !KNOWN_QUANTIZATIONS.contains(&quant) {
        return Err(format!("unknown model.onnxQuantization: {quant}"));
    }
    if quant.is_empty() || quant == "auto" {
        return Ok(());
    }
    if let Some(entry) = crate::winstt::catalog::find(model_id)
        && !entry.available_quantizations.contains(&quant)
    {
        return Err(format!(
            "model.onnxQuantization '{quant}' is not available for model '{}'",
            entry.id
        ));
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
    let binding_id = if path == "hotkey.pushToTalkKey" {
        "transcribe"
    } else {
        "settingsHotkey"
    };
    crate::shortcut::validate_binding_for_active_backend(binding_id, value)
        .map_err(|error| format!("{path} is not a usable global shortcut: {error}"))?;
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
        .is_some_and(|ext| {
            let ext = ext.to_ascii_lowercase();
            allowed.iter().any(|allowed| *allowed == ext)
        })
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
        if matches!(
            p.level,
            Some(crate::winstt::settings_schema::PresetLevel::Caveman)
        ) && key != PresetKey::Concise
        {
            return Err("caveman level is only allowed for concise".into());
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
    fn caveman_level_is_concise_only() {
        use crate::winstt::settings_schema::PresetLevel;

        let concise = vec![PresetEntry {
            key: PresetKey::Concise,
            level: Some(PresetLevel::Caveman),
            target_lang: None,
        }];
        let summarize = vec![PresetEntry {
            key: PresetKey::Summarize,
            level: Some(PresetLevel::Caveman),
            target_lang: None,
        }];
        assert!(validate_presets(&concise).is_ok());
        assert!(validate_presets(&summarize).is_err());
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
    fn rejects_invalid_read_aloud_presets() {
        let mut settings = WinsttSettings::default();
        settings.llm.read_aloud.presets = vec![p(PresetKey::Neutral), p(PresetKey::Formal)];
        assert_validation_error(settings, "one tone preset");
    }

    #[test]
    fn rejects_invalid_app_profile_snapshot() {
        let mut settings = WinsttSettings::default();
        let mut rule = AppProfileRule {
            id: "editor".into(),
            ..Default::default()
        };
        rule.config.base.max_output_tokens = Some(MAX_OUTPUT_TOKENS + 1);
        settings.llm.app_profiles.rules.push(rule);
        assert_validation_error(settings, "appProfiles.rules[0].config.maxOutputTokens");
    }

    #[test]
    fn rejects_duplicate_app_profile_ids() {
        let mut settings = WinsttSettings::default();
        let rule = AppProfileRule {
            id: "editor".into(),
            ..Default::default()
        };
        settings.llm.app_profiles.rules = vec![rule.clone(), rule];
        assert_validation_error(settings, "duplicate rule id");
    }

    #[test]
    fn accepts_supertonic_minimum_speed() {
        let mut settings = WinsttSettings::default();
        settings.tts.model = "supertonic-3".into();
        settings.tts.speed = 0.4;
        assert!(validate_settings(&settings).is_ok());

        settings.tts.speed = 0.39;
        assert_validation_error(settings, "tts.speed");
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
    fn accepts_empty_realtime_model() {
        // Regression: selecting a non-streaming main model (e.g. GigaAM RU)
        // clears the realtime slot to "". The save must succeed rather than
        // reverting the user's main-model pick (issue #35).
        let mut settings = WinsttSettings::default();
        settings.model.realtime_model = String::new();
        assert!(validate_settings(&settings).is_ok());
    }

    #[test]
    fn rejects_unpublished_catalog_quantization() {
        let mut settings = WinsttSettings::default();
        settings.model.model = "tiny".into();
        settings.model.onnx_quantization = "int8".into();
        assert_validation_error(settings, "model.onnxQuantization");
    }

    #[test]
    fn accepts_qwen3_int4_quantization() {
        let mut settings = WinsttSettings::default();
        settings.model.model = "qwen3-asr-0.6b".into();
        settings.model.onnx_quantization = "int4".into();
        assert!(validate_settings(&settings).is_ok());
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
    fn in_app_preview_requires_focus_when_worker_gates_on_it() {
        // The in-app panel lives inside the main window: invisible when unfocused, so the
        // realtime worker must NOT run the model just to feed it. With focus it renders.
        let mut settings = WinsttSettings::default();
        settings.general.live_transcription_display = LiveTranscriptionDisplay::InApp;
        settings.general.word_by_word_pasting = false;
        assert!(effective_realtime_with_focus(&settings, true));
        assert!(!effective_realtime_with_focus(&settings, false));
        // Capability gate stays focus-agnostic (in-app is a possible surface).
        assert!(effective_realtime(&settings));
    }

    #[test]
    fn pill_overlay_runs_realtime_even_when_unfocused() {
        // The pill is an always-on-top floating window the user watches while dictating into
        // ANOTHER app — it must keep updating regardless of WinSTT focus.
        let mut settings = WinsttSettings::default();
        settings.general.live_transcription_display = LiveTranscriptionDisplay::InPill;
        settings.general.show_recording_overlay = true;
        settings.general.word_by_word_pasting = false;
        assert!(effective_realtime_with_focus(&settings, false));
        assert!(effective_realtime_with_focus(&settings, true));
    }

    #[test]
    fn both_display_unfocused_follows_pill_visibility() {
        // "both" = in-app + pill. Unfocused, the in-app half is hidden, so realtime is only
        // worth running when the pill is actually visible (overlay shown).
        let mut settings = WinsttSettings::default();
        settings.general.live_transcription_display = LiveTranscriptionDisplay::Both;
        settings.general.word_by_word_pasting = false;

        settings.general.show_recording_overlay = true;
        assert!(effective_realtime_with_focus(&settings, false));

        settings.general.show_recording_overlay = false;
        assert!(!effective_realtime_with_focus(&settings, false));
        // Focused, the in-app half is visible even with the overlay off.
        assert!(effective_realtime_with_focus(&settings, true));
    }

    #[test]
    fn word_by_word_paste_runs_realtime_unfocused() {
        // Pasting types the text — no visible surface needed, so focus is irrelevant.
        let mut settings = WinsttSettings::default();
        settings.general.live_transcription_display = LiveTranscriptionDisplay::None;
        settings.general.word_by_word_pasting = true;
        assert!(effective_realtime_with_focus(&settings, false));
    }

    // ── partial-patch merge ────────────────────────────────────────────────────

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

    // ── quantization healing at the merge choke point ──────────────────────────

    /// The live repro (2026-07-16): mid-switch, a debounced model-section save
    /// posted the NEW model's precision while `model.model` still held the OLD
    /// model. The merge must heal the couple instead of letting validation
    /// reject the whole save from every window.
    #[test]
    fn model_patch_heals_quantization_the_model_does_not_ship() {
        let current = WinsttSettings::default();
        let mut model = serde_json::to_value(&current.model).unwrap();
        model["model"] = serde_json::json!("alphacep/vosk-model-small-ru");
        model["onnxQuantization"] = serde_json::json!("fp16w");
        let patch = patch_from_json(serde_json::json!({ "model": model }));

        let next = merge_patch_over(&current, patch);

        assert_eq!(next.model.model, "alphacep/vosk-model-small-ru");
        assert_eq!(next.model.onnx_quantization, "");
        assert!(validate_settings(&next).is_ok());
    }

    #[test]
    fn model_patch_heals_unknown_quantization_token() {
        let current = WinsttSettings::default();
        let mut model = serde_json::to_value(&current.model).unwrap();
        model["onnxQuantization"] = serde_json::json!("mxfp4");
        let patch = patch_from_json(serde_json::json!({ "model": model }));

        let next = merge_patch_over(&current, patch);

        assert_eq!(next.model.onnx_quantization, "");
        assert!(validate_settings(&next).is_ok());
    }

    #[test]
    fn model_patch_keeps_a_valid_quantization_couple() {
        let current = WinsttSettings::default();
        let mut model = serde_json::to_value(&current.model).unwrap();
        model["model"] = serde_json::json!("qwen3-asr-0.6b");
        model["onnxQuantization"] = serde_json::json!("int4");
        let patch = patch_from_json(serde_json::json!({ "model": model }));

        let next = merge_patch_over(&current, patch);

        assert_eq!(next.model.onnx_quantization, "int4");
    }

    #[test]
    fn model_patch_keeps_the_auto_sentinel() {
        let current = WinsttSettings::default();
        let mut model = serde_json::to_value(&current.model).unwrap();
        model["model"] = serde_json::json!("alphacep/vosk-model-small-ru");
        model["onnxQuantization"] = serde_json::json!("auto");
        let patch = patch_from_json(serde_json::json!({ "model": model }));

        let next = merge_patch_over(&current, patch);

        assert_eq!(next.model.onnx_quantization, "auto");
    }

    // ── per-patch section validation ────────────────────────────────────────────

    /// A bad value already persisted in an UNTOUCHED section must not reject
    /// saves of unrelated sections (nor STT swaps, which validate `["model"]`).
    #[test]
    fn stale_invalid_section_does_not_block_unrelated_saves() {
        let mut settings = WinsttSettings::default();
        settings.tts.model = "not-a-tts-model".into();

        assert!(validate_sections(&settings, &["audio", "model"]).is_ok());
        assert!(validate_sections(&settings, &["tts"]).is_err());
        assert!(validate_settings(&settings).is_err());
    }

    // ── validation-drift salvage ────────────────────────────────────────────────

    /// A drifted field (persisted under an older rule set, re-posted because
    /// sections travel whole) must not reject the save; the good edits in the
    /// same section survive and only the offending field reverts.
    #[test]
    fn salvage_keeps_good_edits_and_reverts_the_drifted_field() {
        let previous = WinsttSettings::default();
        let mut next = WinsttSettings::default();
        next.quality.smart_endpoint_speed = 99.0; // outside 0.5–3.0 (drifted)
        next.quality.realtime_processing_pause = 5.0; // a legitimate edit

        salvage_invalid_sections(&mut next, &previous, &["quality"]).unwrap();

        assert_eq!(
            next.quality.smart_endpoint_speed,
            previous.quality.smart_endpoint_speed
        );
        assert_eq!(next.quality.realtime_processing_pause, 5.0);
        assert!(validate_sections(&next, &["quality"]).is_ok());
    }

    /// When the PERSISTED value of the drifted field is itself invalid (the
    /// classic upgrade case: an app update retired a TTS catalog id), the field
    /// falls back to its schema default and the save still lands.
    #[test]
    fn salvage_falls_back_to_defaults_when_previous_is_also_invalid() {
        let mut previous = WinsttSettings::default();
        previous.tts.model = "retired-tts-model".into();
        let mut next = previous.clone();
        next.tts.speed = 1.5; // the user just moved the speed slider

        salvage_invalid_sections(&mut next, &previous, &["tts"]).unwrap();

        assert_eq!(next.tts.model, WinsttSettings::default().tts.model);
        assert_eq!(next.tts.speed, 1.5);
        assert!(validate_sections(&next, &["tts"]).is_ok());
    }

    /// Array sections salvage per entry: one bad element is dropped, the rest
    /// of the list survives.
    #[test]
    fn salvage_drops_only_the_invalid_array_entries() {
        let previous = WinsttSettings::default();
        let mut next = WinsttSettings {
            dictionary: vec![
                DictionaryEntry {
                    id: "good".into(),
                    term: "WinSTT".into(),
                    auto_added: None,
                    replacement: None,
                },
                DictionaryEntry {
                    id: "bad".into(),
                    term: String::new(), // term is required
                    auto_added: None,
                    replacement: None,
                },
            ],
            ..WinsttSettings::default()
        };

        salvage_invalid_sections(&mut next, &previous, &["dictionary"]).unwrap();

        assert_eq!(next.dictionary.len(), 1);
        assert_eq!(next.dictionary[0].id, "good");
    }

    /// Valid patches take the fast path untouched.
    #[test]
    fn salvage_is_a_noop_for_valid_sections() {
        let previous = WinsttSettings::default();
        let mut next = WinsttSettings::default();
        next.quality.realtime_processing_pause = 5.0;
        let expected = next.clone();

        salvage_invalid_sections(&mut next, &previous, &["quality", "audio"]).unwrap();

        assert_eq!(next, expected);
    }

    /// A full-tree PartialWinsttSettings built from `tree` (all 11 sections posted).
    fn full_tree_patch(tree: &WinsttSettings) -> PartialWinsttSettings {
        patch_from_json(serde_json::to_value(tree).unwrap())
    }

    #[test]
    fn full_tree_defaults_dump_is_rejected_per_section() {
        // The unhydrated-window boot shape (finding #21, observed live via the
        // save-origin trace): a renderer with an empty settings cache dumps a
        // FULL all-defaults tree, silently reverting the user's model/wake word.
        // Its defaulted sections must be dropped, keeping the persisted values.
        let mut current = WinsttSettings::default();
        let mut cv = serde_json::to_value(&current).unwrap();
        cv["model"]["model"] = serde_json::json!("nemo-canary-180m-flash");
        cv["general"]["wakeWord"] = serde_json::json!("terminator");
        current = serde_json::from_value(cv).unwrap();

        let patch = full_tree_patch(&WinsttSettings::default());
        let next = merge_patch_over(&current, patch);

        assert_eq!(next.model.model, "nemo-canary-180m-flash");
        assert_eq!(next.general.wake_word, "terminator");
    }

    #[test]
    fn renderer_full_tree_defaults_dump_returns_an_explicit_error() {
        let mut current = WinsttSettings::default();
        current.model.model = "nemo-canary-180m-flash".into();
        current.dictionary.push(DictionaryEntry {
            id: "term-1".into(),
            term: "WinSTT".into(),
            auto_added: None,
            replacement: None,
        });
        let patch = full_tree_patch(&WinsttSettings::default());

        let error = reject_renderer_wholesale_reset(&current, &patch)
            .expect_err("unhydrated full defaults dump must be rejected");

        assert!(error.contains("model"));
        assert!(error.contains("dictionary"));
    }

    #[test]
    fn trusted_replacement_can_restore_every_section_to_defaults() {
        let mut current = WinsttSettings::default();
        current.model.model = "nemo-canary-180m-flash".into();
        current.general.wake_word = "terminator".into();
        current.dictionary.push(DictionaryEntry {
            id: "term-1".into(),
            term: "WinSTT".into(),
            auto_added: None,
            replacement: None,
        });

        let next = merge_patch_over_with_origin(
            &current,
            full_tree_patch(&WinsttSettings::default()),
            PatchOrigin::TrustedReplacement,
        );

        assert_eq!(next.model, WinsttSettings::default().model);
        assert_eq!(
            next.general.wake_word,
            WinsttSettings::default().general.wake_word
        );
        assert!(next.dictionary.is_empty());
    }

    #[test]
    fn renderer_invalid_value_is_rejected_instead_of_healed() {
        let current = WinsttSettings::default();
        let mut model = serde_json::to_value(&current.model).unwrap();
        model["onnxQuantization"] = serde_json::json!("not-a-quantization");
        let patch = patch_from_json(serde_json::json!({ "model": model }));

        let next = merge_patch_over_with_origin(&current, patch, PatchOrigin::Renderer);
        let error = validate_sections(&next, &["model"])
            .expect_err("current-schema renderer input must be rejected");

        assert!(error.contains("unknown model.onnxQuantization"));
        assert_eq!(next.model.onnx_quantization, "not-a-quantization");
    }

    #[test]
    fn changed_sections_report_the_canonical_before_after_diff() {
        let mut previous = WinsttSettings::default();
        previous.llm.dictation.enabled = true;
        let mut next = previous.clone();
        next.general.word_by_word_pasting = true;
        normalize_cross_field_settings(&mut next);

        assert_eq!(
            changed_section_names(&previous, &next),
            vec!["general".to_string(), "llm".to_string()]
        );
        assert!(changed_section_names(&next, &next).is_empty());
    }

    #[test]
    fn partial_defaults_section_is_a_legit_edit_and_accepted() {
        // A DIFF-based save posting one defaults-equal section is the user
        // toggling that section's only customized field back off — it must
        // apply (this was the "second toggle never persists" regression risk).
        let mut current = WinsttSettings::default();
        current.llm.dictation.enabled = true;

        let patch = patch_from_json(serde_json::json!({
            "llm": serde_json::to_value(&WinsttSettings::default().llm).unwrap(),
        }));
        let next = merge_patch_over(&current, patch);

        assert!(!next.llm.dictation.enabled);
    }

    #[test]
    fn full_tree_with_customized_sections_still_applies() {
        // The guard must ONLY reject defaults-over-customized inside a full
        // dump — customized incoming sections in the same dump replace normally.
        let mut current = WinsttSettings::default();
        let mut cv = serde_json::to_value(&current).unwrap();
        cv["general"]["wakeWord"] = serde_json::json!("terminator");
        current = serde_json::from_value(cv).unwrap();

        let mut tree = current.clone();
        let mut tv = serde_json::to_value(&tree).unwrap();
        tv["general"]["wakeWord"] = serde_json::json!("jarvis");
        tree = serde_json::from_value(tv).unwrap();
        let patch = full_tree_patch(&tree);
        let next = merge_patch_over(&current, patch);

        assert_eq!(next.general.wake_word, "jarvis");
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
