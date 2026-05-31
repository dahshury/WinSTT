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

use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::runtime::RuntimeInfoPayload;

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
        let _ = app.emit("stt:model-swap-started", json!({ "kind": kind, "name": name }));
    }

    /// `stt:model-swap-completed` — the new model is loaded (clears the in-flight chip; the
    /// model-state store refetches because the new model is now cached).
    pub fn completed(app: &AppHandle, kind: &str, name: &str) {
        let _ = app.emit("stt:model-swap-completed", json!({ "kind": kind, "name": name }));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_strings_match_ts_union() {
        assert_eq!(SwapFailedCategory::OutOfMemory.as_str(), "out_of_memory");
        assert_eq!(SwapFailedCategory::ModelNotFound.as_str(), "model_not_found");
        assert_eq!(SwapFailedCategory::Cancelled.as_str(), "cancelled");
        assert_eq!(SwapFailedCategory::IncompatibleQuantization.as_str(), "incompatible_quantization");
    }
}
