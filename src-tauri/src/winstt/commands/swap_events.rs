// PORT IMPL — WU-4 (app/PORT/10_frontend_port_plan.md §6 WU-4 + lib_wiring.md §7). Source:
//   frontend/src/shared/api/ipc-client.ts (onModelSwapStarted / onModelSwapCompleted /
//     onModelSwapFailed / onRuntimeInfo + ModelSwapPayload / ModelSwapFailedPayload /
//     RuntimeInfoPayload shapes)
//   + server/src/recorder/domain/swap_errors.py (SwapErrorCategory) + control_handler emits.
//
// PLAIN-event emit façade for the model-swap lifecycle + the runtime-info push. These are emitted
// from the engine-swap path INSIDE Handy's TranscriptionManager (lib_wiring §7 — a localized edit to
// the manager's transcribe/initiate_model_load body, NOT a re-registration). Centralizing the
// byte-identical shapes here means the §7 edit just calls `SwapEvents::started(app, kind, name)`
// instead of hand-rolling `app.emit("stt:model-swap-started", …)` at the edit site.
//
// They are PLAIN string events (NOT collected) because the reused renderer subscribes via
// `ipc-client.ts`'s `on(IPC.STT_MODEL_SWAP_*)` — the adapter routes those channels to `listen()`,
// and the JSON shape below is exactly what the renderer's `data as ModelSwapPayload` cast expects.
//
// Event NAMES match the WU-0 adapter ROUTE map:
//   IPC.STT_MODEL_SWAP_STARTED   → "stt:model-swap-started"   { kind, name }
//   IPC.STT_MODEL_SWAP_COMPLETED → "stt:model-swap-completed" { kind, name }
//   IPC.STT_MODEL_SWAP_FAILED    → "stt:model-swap-failed"    { kind, name, category, detail, reason }
//   IPC.STT_RUNTIME_INFO         → "stt:runtime-info"         (RuntimeInfoPayload)

use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use super::runtime::{self, RuntimeInfoPayload};

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
    /// `stt:model-swap-started` — the engine began loading new weights (control plane briefly stalls;
    /// the picker shows "Switching to {name}..." while `activeMain` is set).
    pub fn started(app: &AppHandle, kind: &str, name: &str) {
        let _ = app.emit(
            "stt:model-swap-started",
            json!({ "kind": kind, "name": name }),
        );
    }

    /// `stt:model-swap-completed` — the new model is loaded (clears the in-flight chip; the
    /// model-state store refetches because the new model is now cached).
    pub fn completed(app: &AppHandle, kind: &str, name: &str) {
        let _ = app.emit(
            "stt:model-swap-completed",
            json!({ "kind": kind, "name": name }),
        );
    }

    /// `stt:model-swap-failed` — the swap failed; the renderer fires `SwapFailureToast` and rolls the
    /// picker back to the previous model. `reason` is the localized headline, `detail` the raw error.
    pub fn failed(
        app: &AppHandle,
        kind: &str,
        name: &str,
        category: SwapFailedCategory,
        reason: &str,
        detail: &str,
    ) {
        let _ = app.emit(
            "stt:model-swap-failed",
            json!({
                "kind": kind,
                "name": name,
                "category": category.as_str(),
                "reason": reason,
                "detail": detail,
            }),
        );
    }

    /// `stt:runtime-info` — push the active-EP + loaded-model snapshot (on `server_ready` and after
    /// each completed swap) so `useSyncActiveModel` reconciles the picker with what's actually loaded.
    pub fn runtime_info(app: &AppHandle, info: &RuntimeInfoPayload) {
        let _ = app.emit("stt:runtime-info", info);
    }
}

/// Drive the FULL main-model swap lifecycle off the command thread.
///
/// This is what `set_winstt_model(kind="main", name)` must call (the dictation slice owns that
/// command's signature; it delegates here — see the lib-wiring report). The renderer's swap store
/// sets the "Switching to {name}..." chip on `model-swap-started` and CLEARS it only on
/// `model-swap-completed` / `model-swap-failed` — so this orchestration is what makes the picker's
/// switch spinner resolve instead of spinning forever.
///
/// Sequence (mirrors the server's `request_model_swap`):
///   1. emit `model-swap-started` (confirms the swap, arms the chip),
///   2. ask Handy's `TranscriptionManager` to (re)load the model on its worker,
///   3. on success → push fresh `runtime-info` (so the active-model chip reconciles) + emit
///      `model-swap-completed`; on failure → emit `model-swap-failed` with a classified category.
///
/// The model SELECTION is already persisted to settings by the renderer's `update(...)` before this
/// fires, so `get_runtime_info` reflects the new id even before the engine finishes loading; the
/// engine LOAD itself rides `TranscriptionManager::load_model_blocking`, which returns the concrete
/// load result for every supported local engine. This module owns only the renderer lifecycle
/// events around that load.
pub fn perform_model_swap(app: &AppHandle, kind: &str, name: &str) {
    // Realtime-kind reloads are owned by the realtime slice (04_*) — only the main model swaps here.
    if kind != "main" {
        return;
    }
    SwapEvents::started(app, kind, name);

    let app = app.clone();
    let kind = kind.to_string();
    let name = name.to_string();
    std::thread::spawn(move || {
        // Load the REQUESTED model synchronously and observe the real result. We pass `name`
        // explicitly (NOT re-reading settings) because the renderer's persist of `model.model` is
        // debounced ~300ms — re-reading here would load the stale/default "tiny" and "succeed".
        let load_result: Result<(), String> =
            match app.try_state::<Arc<crate::managers::transcription::TranscriptionManager>>() {
                Some(tm) => tm.load_model_blocking(&name),
                None => Err("transcription manager not initialized".to_string()),
            };

        match load_result {
            Ok(()) => {
                // Push the reconciled runtime snapshot BEFORE completed (the renderer reads the new
                // active model off runtime-info, then clears the chip on completed).
                if let Some(tm) =
                    app.try_state::<Arc<crate::managers::transcription::TranscriptionManager>>()
                {
                    let info = runtime::runtime_info_snapshot(&app, tm.inner().as_ref());
                    SwapEvents::runtime_info(&app, &info);
                }
                SwapEvents::completed(&app, &kind, &name);
            }
            Err(detail) => {
                SwapEvents::failed(
                    &app,
                    &kind,
                    &name,
                    classify_swap_error(&detail),
                    "Failed to load model",
                    &detail,
                );
            }
        }
    });
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
}
