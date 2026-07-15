// Model-swap event surface. Reference:
//   frontend/src/shared/api/ipc-client.ts (onModelSwapStarted / onModelSwapCompleted /
//     onModelSwapFailed / onRuntimeInfo + ModelSwapPayload / ModelSwapFailedPayload /
//     RuntimeInfoPayload shapes)
//   + server/src/recorder/domain/swap_errors.py (SwapErrorCategory) + control_handler emits.
//
// PLAIN-event emit façade for the model-swap lifecycle + the runtime-info push. These are emitted
// from the engine-swap path inside TranscriptionManager (lib_wiring §7 — a localized edit to
// the manager's transcribe/initiate_model_load body, NOT a re-registration). Centralizing the
// byte-identical shapes here means the §7 edit just calls `SwapEvents::started(app, kind, name)`
// instead of hand-rolling `app.emit("stt:model-swap-started", …)` at the edit site.
//
// They are PLAIN string events (NOT collected) because the reused renderer subscribes via
// `ipc-client.ts`'s `on(IPC.STT_MODEL_SWAP_*)` — the adapter routes those channels to `listen()`,
// and the JSON shape below is exactly what the renderer's `data as ModelSwapPayload` cast expects.
//
// Event names match the renderer's canonical event constants:
//   IPC.STT_MODEL_SWAP_STARTED   → "stt:model-swap-started"   { kind, name }
//   IPC.STT_MODEL_SWAP_COMPLETED → "stt:model-swap-completed" { kind, name }
//   IPC.STT_MODEL_SWAP_FAILED    → "stt:model-swap-failed"    { kind, name, category, detail, reason }
//   IPC.STT_RUNTIME_INFO         → "stt:runtime-info"         (RuntimeInfoPayload)

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use super::runtime::{self, RuntimeInfoPayload};
use crate::winstt::commands::model_lifecycle::{SttModelLifecyclePhase, transition_activation};

static STT_SWITCH_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static STT_SWITCH_REVISION: AtomicU64 = AtomicU64::new(0);
static STT_SWITCH_LATEST: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SttSwitchModelRequest {
    pub kind: SttSwitchKind,
    pub model_id: String,
    pub quantization: Option<String>,
    pub device: Option<crate::winstt::settings_schema::DeviceType>,
    /// Optional realtime companion selected by the renderer's compatibility policy. When omitted,
    /// the existing realtime selection is preserved.
    pub realtime_model: Option<String>,
    pub request_id: String,
    #[serde(default)]
    pub force_reload: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SttSwitchKind {
    Main,
    Realtime,
}

impl SttSwitchKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Realtime => "realtime",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SttSwitchStatus {
    Completed,
    Failed,
    Superseded,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SttModelSnapshot {
    pub selected_model: String,
    pub selected_realtime_model: String,
    pub resident_model: Option<String>,
    pub resident_realtime_model: Option<String>,
    pub warm: bool,
    pub quantization: String,
    pub device: crate::winstt::settings_schema::DeviceType,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SttSwitchRollbackSnapshot {
    pub succeeded: bool,
    pub error: Option<String>,
    pub before: SttModelSnapshot,
    pub after: SttModelSnapshot,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SttSwitchModelResult {
    pub request_id: String,
    pub revision: u64,
    pub kind: SttSwitchKind,
    pub status: SttSwitchStatus,
    pub snapshot: SttModelSnapshot,
    pub rollback: Option<SttSwitchRollbackSnapshot>,
    pub error: Option<String>,
}

/// Stable swap-failure category — mirrors the renderer's `ModelSwapFailedCategory`
/// (ipc-client.ts) / the server's `SwapErrorCategory`. Adding a variant is a wire-format
/// extension; keep in sync with the TS union.
#[derive(Clone, Copy, Debug)]
pub enum SwapFailedCategory {
    Cancelled,
    Network,
    ModelNotFound,
    IncompatibleQuantization,
    ModelCorrupt,
    OutOfMemory,
    DiskFull,
    PermissionDenied,
    Superseded,
    Unknown,
}

impl SwapFailedCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            SwapFailedCategory::Cancelled => "cancelled",
            SwapFailedCategory::Network => "network",
            SwapFailedCategory::ModelNotFound => "model_not_found",
            SwapFailedCategory::IncompatibleQuantization => "incompatible_quantization",
            SwapFailedCategory::ModelCorrupt => "model_corrupt",
            SwapFailedCategory::OutOfMemory => "out_of_memory",
            SwapFailedCategory::DiskFull => "disk_full",
            SwapFailedCategory::PermissionDenied => "permission_denied",
            SwapFailedCategory::Superseded => "superseded",
            SwapFailedCategory::Unknown => "unknown",
        }
    }
}

/// Emit façade for the model-swap lifecycle. `kind` is `"main"` | `"realtime"` (matches the
/// renderer's `ModelSwapKind`). Every method swallows the emit error so a dropped lifecycle event
/// can never crash the swap worker thread.
pub struct SwapEvents;

impl SwapEvents {
    /// `stt:runtime-info` — push the active-EP + loaded-model snapshot (on `server_ready` and after
    /// each completed swap) so `useSyncActiveModel` reconciles the picker with what's actually loaded.
    pub fn runtime_info(app: &AppHandle, info: &RuntimeInfoPayload) {
        let _ = app.emit(super::events::names::STT_RUNTIME_INFO, info);
    }

    fn started_correlated(
        app: &AppHandle,
        kind: SttSwitchKind,
        name: &str,
        request_id: &str,
        revision: u64,
    ) {
        let _ = app.emit(
            super::events::names::STT_MODEL_SWAP_STARTED,
            json!({
                "kind": kind.as_str(),
                "name": name,
                "requestId": request_id,
                "revision": revision,
                "snapshot": model_snapshot(app),
                "rollback": null,
            }),
        );
    }

    fn completed_correlated(app: &AppHandle, name: &str, result: &SttSwitchModelResult) {
        let _ = app.emit(
            super::events::names::STT_MODEL_SWAP_COMPLETED,
            json!({
                "kind": result.kind.as_str(),
                "name": name,
                "requestId": result.request_id,
                "revision": result.revision,
                "snapshot": result.snapshot,
                "rollback": result.rollback,
            }),
        );
    }

    fn failed_correlated(
        app: &AppHandle,
        name: &str,
        result: &SttSwitchModelResult,
        category: SwapFailedCategory,
        detail: &str,
    ) {
        let _ = app.emit(
            super::events::names::STT_MODEL_SWAP_FAILED,
            json!({
                "kind": result.kind.as_str(),
                "name": name,
                "requestId": result.request_id,
                "revision": result.revision,
                "category": category.as_str(),
                "reason": if matches!(category, SwapFailedCategory::Superseded) {
                    "Model switch superseded"
                } else {
                    "Failed to load model"
                },
                "detail": detail,
                "snapshot": result.snapshot,
                "rollback": result.rollback,
            }),
        );
    }
}

/// Atomically switch either STT slot. The backend validates and loads from transaction-local
/// model/precision/device inputs, waits for warmup, and only then commits the model section.
#[tauri::command]
#[specta::specta]
pub async fn stt_switch_model(
    app: AppHandle,
    request: SttSwitchModelRequest,
) -> SttSwitchModelResult {
    let revision = STT_SWITCH_REVISION.fetch_add(1, Ordering::AcqRel) + 1;
    STT_SWITCH_LATEST.store(revision, Ordering::Release);
    let fallback_request_id = request.request_id.clone();
    let fallback_kind = request.kind;
    let fallback_target = request.model_id.clone();
    let fallback_app = app.clone();

    match tauri::async_runtime::spawn_blocking(move || {
        perform_atomic_model_switch(&app, request, revision)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let detail = format!("model switch worker failed: {error}");
            let result = switch_result(
                &fallback_app,
                &fallback_request_id,
                revision,
                fallback_kind,
                SttSwitchStatus::Failed,
                Some(detail.clone()),
                None,
            );
            SwapEvents::failed_correlated(
                &fallback_app,
                &fallback_target,
                &result,
                SwapFailedCategory::Unknown,
                &detail,
            );
            result
        }
    }
}

fn perform_atomic_model_switch(
    app: &AppHandle,
    request: SttSwitchModelRequest,
    revision: u64,
) -> SttSwitchModelResult {
    let _transaction = STT_SWITCH_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let target_model = if request.model_id.trim().is_empty() {
        String::new()
    } else {
        crate::winstt::catalog::canonical_model_id(request.model_id.trim()).to_string()
    };

    if !should_execute_queued_switch(revision, STT_SWITCH_LATEST.load(Ordering::Acquire)) {
        let detail = "a newer model switch request is already pending";
        let result = switch_result(
            app,
            &request.request_id,
            revision,
            request.kind,
            SttSwitchStatus::Superseded,
            Some(detail.to_string()),
            None,
        );
        SwapEvents::failed_correlated(
            app,
            &target_model,
            &result,
            SwapFailedCategory::Superseded,
            detail,
        );
        transition_atomic_lifecycle(
            app,
            request.kind,
            &target_model,
            &model_snapshot(app).quantization,
            &request.request_id,
            SttModelLifecyclePhase::Cancelled,
            Some(detail.to_string()),
        );
        return result;
    }

    if request.request_id.trim().is_empty() {
        let detail = "requestId is empty";
        let result = switch_result(
            app,
            &request.request_id,
            revision,
            request.kind,
            SttSwitchStatus::Failed,
            Some(detail.to_string()),
            None,
        );
        SwapEvents::failed_correlated(
            app,
            &target_model,
            &result,
            SwapFailedCategory::Unknown,
            detail,
        );
        transition_atomic_lifecycle(
            app,
            request.kind,
            &target_model,
            &model_snapshot(app).quantization,
            &request.request_id,
            SttModelLifecyclePhase::Failed,
            Some(detail.to_string()),
        );
        return result;
    }

    if app
        .try_state::<Arc<crate::winstt::managers::FileTranscribeManager>>()
        .is_some_and(|manager| manager.is_active())
    {
        let detail = "file transcription queue is active";
        let result = switch_result(
            app,
            &request.request_id,
            revision,
            request.kind,
            SttSwitchStatus::Failed,
            Some(detail.to_string()),
            None,
        );
        SwapEvents::failed_correlated(
            app,
            &target_model,
            &result,
            SwapFailedCategory::Cancelled,
            detail,
        );
        transition_atomic_lifecycle(
            app,
            request.kind,
            &target_model,
            &model_snapshot(app).quantization,
            &request.request_id,
            SttModelLifecyclePhase::Cancelled,
            Some(detail.to_string()),
        );
        return result;
    }

    let previous = crate::winstt::settings_store::read_settings_raw(app);
    let mut next = previous.clone();
    let requested_realtime_model = match request.kind {
        SttSwitchKind::Main => request.realtime_model.clone(),
        SttSwitchKind::Realtime => Some(target_model.clone()),
    };
    let load_model_id = match request.kind {
        SttSwitchKind::Main => {
            next.model.model.clone_from(&target_model);
            target_model.clone()
        }
        SttSwitchKind::Realtime => previous.model.model.clone(),
    };
    let requested_quantization = request
        .quantization
        .as_deref()
        .unwrap_or(&previous.model.onnx_quantization);
    next.model.onnx_quantization =
        reconcile_persisted_quant(&load_model_id, requested_quantization);
    if let Some(device) = request.device {
        next.model.device = device;
    }
    if let Some(realtime_model) = &requested_realtime_model {
        next.model.realtime_model.clone_from(realtime_model);
    }
    if let Err(detail) = super::settings::validate_settings(&next) {
        let result = switch_result(
            app,
            &request.request_id,
            revision,
            request.kind,
            SttSwitchStatus::Failed,
            Some(detail.clone()),
            None,
        );
        SwapEvents::failed_correlated(
            app,
            &target_model,
            &result,
            classify_swap_error(&detail),
            &detail,
        );
        transition_atomic_lifecycle(
            app,
            request.kind,
            &target_model,
            &next.model.onnx_quantization,
            &request.request_id,
            SttModelLifecyclePhase::Failed,
            Some(detail),
        );
        return result;
    }

    let Some(transcription) =
        app.try_state::<Arc<crate::managers::transcription::TranscriptionManager>>()
    else {
        let detail = "transcription manager not initialized";
        let result = switch_result(
            app,
            &request.request_id,
            revision,
            request.kind,
            SttSwitchStatus::Failed,
            Some(detail.to_string()),
            None,
        );
        SwapEvents::failed_correlated(
            app,
            &target_model,
            &result,
            SwapFailedCategory::Unknown,
            detail,
        );
        transition_atomic_lifecycle(
            app,
            request.kind,
            &target_model,
            &next.model.onnx_quantization,
            &request.request_id,
            SttModelLifecyclePhase::Failed,
            Some(detail.to_string()),
        );
        return result;
    };

    SwapEvents::started_correlated(
        app,
        request.kind,
        &target_model,
        &request.request_id,
        revision,
    );
    transition_atomic_lifecycle(
        app,
        request.kind,
        &target_model,
        &next.model.onnx_quantization,
        &request.request_id,
        SttModelLifecyclePhase::Loading,
        None,
    );
    let force_reload = request.force_reload
        || match request.kind {
            SttSwitchKind::Main => {
                previous.model.model == target_model
                    && (previous.model.onnx_quantization != next.model.onnx_quantization
                        || previous.model.device != next.model.device
                        || requested_realtime_model.as_deref()
                            != Some(previous.model.realtime_model.as_str()))
            }
            SttSwitchKind::Realtime => {
                previous.model.realtime_model != target_model
                    || previous.model.onnx_quantization != next.model.onnx_quantization
                    || previous.model.device != next.model.device
            }
        };
    if let Err(detail) = transcription.switch_model_blocking(
        &load_model_id,
        Some(&next.model.onnx_quantization),
        Some(next.model.device),
        Some(&next.model.realtime_model),
        force_reload,
    ) {
        let result = switch_result(
            app,
            &request.request_id,
            revision,
            request.kind,
            SttSwitchStatus::Failed,
            Some(detail.clone()),
            None,
        );
        SwapEvents::failed_correlated(
            app,
            &target_model,
            &result,
            classify_swap_error(&detail),
            &detail,
        );
        transition_atomic_lifecycle(
            app,
            request.kind,
            &target_model,
            &next.model.onnx_quantization,
            &request.request_id,
            SttModelLifecyclePhase::Failed,
            Some(detail),
        );
        return result;
    }
    transition_atomic_lifecycle(
        app,
        request.kind,
        &target_model,
        &next.model.onnx_quantization,
        &request.request_id,
        SttModelLifecyclePhase::Warming,
        None,
    );
    transcription.wait_until_warm(&load_model_id, std::time::Duration::from_secs(120));

    // The load/warm may take minutes. Rebase the transaction-owned fields over the freshest model
    // section so a concurrent language/prompt edit is never replaced by the pre-load snapshot.
    let current = crate::winstt::settings_store::read_settings_raw(app);
    let rebased_model = rebase_switched_model_section(
        current.model,
        &next.model,
        request.kind,
        requested_realtime_model.as_deref(),
    );
    let patch = super::settings::PartialWinsttSettings {
        model: Some(rebased_model),
        ..Default::default()
    };
    if let Err(detail) = super::settings::apply_settings_patch_after_stt_switch(app, patch) {
        let before_rollback = model_snapshot(app);
        // The engine changed but the authoritative selection could not be committed. Best-effort
        // rollback keeps resident state aligned with the still-persisted settings.
        let rollback = transcription.switch_model_blocking(
            &previous.model.model,
            Some(&previous.model.onnx_quantization),
            Some(previous.model.device),
            Some(&previous.model.realtime_model),
            true,
        );
        if rollback.is_err() {
            // Never leave the failed target resident under the previous persisted selection.
            // An unloaded engine is recoverable on next dictation; a mismatched resident engine is
            // not an honest authoritative state.
            let _ = transcription.unload_model();
        }
        let rollback_error = rollback.err();
        let rollback_snapshot = SttSwitchRollbackSnapshot {
            succeeded: rollback_error.is_none(),
            error: rollback_error,
            before: before_rollback,
            after: model_snapshot(app),
        };
        let result = switch_result(
            app,
            &request.request_id,
            revision,
            request.kind,
            SttSwitchStatus::Failed,
            Some(detail.clone()),
            Some(rollback_snapshot),
        );
        SwapEvents::failed_correlated(
            app,
            &target_model,
            &result,
            SwapFailedCategory::PermissionDenied,
            &detail,
        );
        transition_atomic_lifecycle(
            app,
            request.kind,
            &target_model,
            &next.model.onnx_quantization,
            &request.request_id,
            SttModelLifecyclePhase::Failed,
            Some(detail),
        );
        return result;
    }

    let info = runtime::runtime_info_snapshot(app, transcription.inner().as_ref());
    SwapEvents::runtime_info(app, &info);
    let result = switch_result(
        app,
        &request.request_id,
        revision,
        request.kind,
        SttSwitchStatus::Completed,
        None,
        None,
    );
    SwapEvents::completed_correlated(app, &target_model, &result);
    transition_atomic_lifecycle(
        app,
        request.kind,
        &target_model,
        &next.model.onnx_quantization,
        &request.request_id,
        SttModelLifecyclePhase::Active,
        None,
    );
    result
}

fn transition_atomic_lifecycle(
    app: &AppHandle,
    kind: SttSwitchKind,
    model_id: &str,
    quantization: &str,
    request_id: &str,
    phase: SttModelLifecyclePhase,
    error: Option<String>,
) {
    // The lifecycle registry currently models the resident main engine. Realtime companion
    // selection remains correlated by the atomic swap events/result until the runtime exposes an
    // independently queryable realtime resident/warm state.
    if kind != SttSwitchKind::Main {
        return;
    }
    if let Err(detail) =
        transition_activation(app, model_id, quantization, request_id, phase, error)
    {
        log::warn!("[stt-lifecycle] activation transition rejected: {detail}");
    }
}

fn rebase_switched_model_section(
    mut current: crate::winstt::settings_schema::ModelSettings,
    loaded: &crate::winstt::settings_schema::ModelSettings,
    kind: SttSwitchKind,
    requested_realtime_model: Option<&str>,
) -> crate::winstt::settings_schema::ModelSettings {
    if kind == SttSwitchKind::Main {
        current.model.clone_from(&loaded.model);
    }
    current
        .onnx_quantization
        .clone_from(&loaded.onnx_quantization);
    current.device = loaded.device;
    if let Some(realtime_model) = requested_realtime_model {
        current.realtime_model = realtime_model.to_string();
    }
    current
}

fn should_execute_queued_switch(revision: u64, latest_revision: u64) -> bool {
    revision == latest_revision
}

/// Rebuild the selected engine after a settings-owned load input (for example realtime language)
/// has already committed. This deliberately reuses the same serialized transaction and correlated
/// lifecycle as renderer-initiated model switches; there is no second reload owner.
pub fn schedule_selected_model_rebuild(app: &AppHandle, kind: SttSwitchKind) {
    let settings = crate::winstt::settings_store::read_settings_raw(app);
    let model_id = match kind {
        SttSwitchKind::Main => settings.model.model.clone(),
        SttSwitchKind::Realtime => settings.model.realtime_model.clone(),
    };
    if model_id.trim().is_empty() {
        return;
    }
    let request = SttSwitchModelRequest {
        kind,
        model_id,
        quantization: Some(settings.model.onnx_quantization.clone()),
        device: Some(settings.model.device),
        realtime_model: match kind {
            SttSwitchKind::Main => Some(settings.model.realtime_model),
            SttSwitchKind::Realtime => None,
        },
        request_id: format!(
            "settings-{}-{}",
            kind.as_str(),
            STT_SWITCH_REVISION.load(Ordering::Acquire) + 1
        ),
        force_reload: true,
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = stt_switch_model(app, request).await;
    });
}

fn switch_result(
    app: &AppHandle,
    request_id: &str,
    revision: u64,
    kind: SttSwitchKind,
    status: SttSwitchStatus,
    error: Option<String>,
    rollback: Option<SttSwitchRollbackSnapshot>,
) -> SttSwitchModelResult {
    SttSwitchModelResult {
        request_id: request_id.to_string(),
        revision,
        kind,
        status,
        snapshot: model_snapshot(app),
        rollback,
        error,
    }
}

fn model_snapshot(app: &AppHandle) -> SttModelSnapshot {
    let settings = crate::winstt::settings_store::read_settings_raw(app);
    let transcription =
        app.try_state::<Arc<crate::managers::transcription::TranscriptionManager>>();
    let resident_model = transcription
        .as_ref()
        .and_then(|manager| manager.get_current_model());
    let resident_realtime_model = transcription.as_ref().and_then(|manager| {
        runtime::runtime_info_snapshot(app, manager.inner().as_ref()).realtime_model
    });
    let warm = resident_model.as_deref().is_some_and(|model_id| {
        transcription
            .as_ref()
            .is_some_and(|manager| manager.is_model_warm_for(model_id))
    });
    SttModelSnapshot {
        selected_model: settings.model.model,
        selected_realtime_model: settings.model.realtime_model,
        resident_model,
        resident_realtime_model,
        warm,
        quantization: settings.model.onnx_quantization,
        device: settings.model.device,
    }
}

/// Resolve the precision to persist for `model_id`, given the currently-persisted
/// `current_quant`. The `""`/`auto` sentinels are universally valid (the loader
/// re-resolves them per model); a concrete precision the target model doesn't ship
/// (e.g. an `fp16` carried onto a model whose catalog list omits it) is reset to
/// `""` so the persisted `{model, onnxQuantization}` couple can never be rejected
/// by `validate_quantization`. Mirrors the renderer's `resolveSwapQuantization` /
/// `reconcileAdoptedQuant` so both persistence paths agree.
fn reconcile_persisted_quant(model_id: &str, current_quant: &str) -> String {
    if current_quant.is_empty() || current_quant == "auto" {
        return current_quant.to_string();
    }
    match crate::winstt::catalog::find(model_id) {
        Some(entry) if !entry.available_quantizations.contains(&current_quant) => String::new(),
        _ => current_quant.to_string(),
    }
}

/// Map a raw load-error string to the renderer's `ModelSwapFailedCategory`. Mirrors the server's
/// `SwapErrorCategory` classifier heuristics (substring match on the exception text).
fn classify_swap_error(detail: &str) -> SwapFailedCategory {
    let d = detail.to_ascii_lowercase();
    if d.contains("cancel") {
        SwapFailedCategory::Cancelled
    } else if d.contains("network") || d.contains("connect") || d.contains("timed out") {
        SwapFailedCategory::Network
    } else if d.contains("not found") || d.contains("missing") || d.contains("no such") {
        SwapFailedCategory::ModelNotFound
    } else if d.contains("quantiz") {
        SwapFailedCategory::IncompatibleQuantization
    } else if d.contains("corrupt") || d.contains("invalid") || d.contains("parse") {
        SwapFailedCategory::ModelCorrupt
    } else if d.contains("memory") || d.contains("oom") || d.contains("alloc") {
        SwapFailedCategory::OutOfMemory
    } else if d.contains("disk") || d.contains("space") {
        SwapFailedCategory::DiskFull
    } else if d.contains("permission") || d.contains("denied") || d.contains("access") {
        SwapFailedCategory::PermissionDenied
    } else {
        SwapFailedCategory::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_strings_match_ts_union() {
        assert_eq!(SwapFailedCategory::OutOfMemory.as_str(), "out_of_memory");
        assert_eq!(
            SwapFailedCategory::ModelNotFound.as_str(),
            "model_not_found"
        );
        assert_eq!(SwapFailedCategory::Cancelled.as_str(), "cancelled");
        assert_eq!(
            SwapFailedCategory::IncompatibleQuantization.as_str(),
            "incompatible_quantization"
        );
    }

    #[test]
    fn queued_switch_is_superseded_only_before_it_mutates_the_engine() {
        assert!(!should_execute_queued_switch(7, 8));
        assert!(should_execute_queued_switch(8, 8));
    }

    #[test]
    fn explicit_quantization_is_reconciled_against_the_loaded_main_model() {
        assert_eq!(
            reconcile_persisted_quant("alphacep/vosk-model-small-ru", "fp16w"),
            ""
        );
    }

    #[test]
    fn explicit_quantization_is_kept_when_the_loaded_main_model_offers_it() {
        assert_eq!(
            reconcile_persisted_quant("granite-speech-4.1-2b-nar", "fp16w"),
            "fp16w"
        );
    }

    #[test]
    fn switch_commit_rebases_owned_fields_without_clobbering_concurrent_model_edits() {
        let mut current = crate::winstt::settings_schema::ModelSettings::default();
        current.language = "fr".into();
        current.initial_prompt = "concurrent prompt".into();
        current.realtime_model = "current-realtime".into();
        let mut loaded = current.clone();
        loaded.model = "nemo-canary-180m-flash".into();
        loaded.onnx_quantization = "int8".into();
        loaded.device = crate::winstt::settings_schema::DeviceType::Cpu;
        loaded.language = "en".into();
        loaded.initial_prompt = "stale prompt".into();

        let mut expected = current.clone();
        expected.model = loaded.model.clone();
        expected.onnx_quantization = loaded.onnx_quantization.clone();
        expected.device = loaded.device;

        assert_eq!(
            rebase_switched_model_section(current, &loaded, SttSwitchKind::Main, None),
            expected
        );
    }

    #[test]
    fn realtime_switch_rebases_only_shared_load_inputs_and_realtime_selection() {
        let mut current = crate::winstt::settings_schema::ModelSettings::default();
        current.model = "main-current".into();
        current.realtime_model = "realtime-old".into();
        current.language = "fr".into();
        let mut loaded = current.clone();
        loaded.model = "stale-main".into();
        loaded.realtime_model = "realtime-new".into();
        loaded.onnx_quantization = "int8".into();
        loaded.device = crate::winstt::settings_schema::DeviceType::Cpu;

        let rebased = rebase_switched_model_section(
            current,
            &loaded,
            SttSwitchKind::Realtime,
            Some("realtime-new"),
        );

        assert_eq!(rebased.model, "main-current");
        assert_eq!(rebased.realtime_model, "realtime-new");
        assert_eq!(rebased.language, "fr");
        assert_eq!(rebased.onnx_quantization, "int8");
        assert_eq!(
            rebased.device,
            crate::winstt::settings_schema::DeviceType::Cpu
        );
    }
}
