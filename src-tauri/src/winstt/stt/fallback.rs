// Offline graceful-degradation helpers shared by the STT pipeline.
//
// When a CLOUD STT model can't be reached (no internet / provider down) the app must not simply
// lose the utterance. Two behaviors, both keyed off `cloud_stt::provider_appears_offline`:
//
//   1. If a LOCAL catalog model is fully cached on disk, the in-flight utterance is salvaged by
//      decoding the SAME audio on that local engine (`decode.rs`), and the settings source is
//      auto-reverted to Local by the renderer (driven by the `cloud:connectivity` offline event).
//   2. If NO local model exists, there is nothing to fall back to — the record-start gate
//      (`transcribe.rs`) skips the doomed capture and emits `stt:pipeline-unavailable` so the
//      overlay can show an offline error (or, with the overlay disabled, simply suppresses the
//      recording chime).
//
// The "is a local model available, and which one" question is answered by the SAME HF cache probe
// the picker uses (`runtime::probe_cache_states`, TTL-memoized), restricted to families whose Rust
// engine is actually wired (`backend::engine_kind_for`). Preference order: the factory-default
// model (`tiny`) when it is fully cached — the deterministic target every other fallback resolves
// to — else the SMALLEST fully cached decodable model. (This salvage runs OFFLINE mid-utterance,
// so unlike the renderer's stale-selection fallback it cannot download the default; an arbitrary
// cached model beats losing the utterance.)

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::winstt::managers::DownloadManager;

/// Plain-string event (mirrors `stt:cloud-error` / `cloud:connectivity`): the selected STT pipeline
/// cannot run because the cloud provider is unreachable AND no local fallback model is installed.
/// The renderer maps `reason` to a localized message and shows a transient overlay error pill.
pub const STT_PIPELINE_UNAVAILABLE: &str = "stt:pipeline-unavailable";

/// Resolve the best LOCAL STT model to fall back to when cloud is unreachable: the smallest fully
/// cached model whose family has a wired Rust engine, or `None` if nothing usable is on disk.
///
/// Async because the underlying HF cache scan is async; the sync record/transcribe paths use
/// [`resolve_local_stt_fallback`] which drives this on the ambient/global runtime.
pub async fn resolve_local_stt_fallback_async(downloads: &DownloadManager) -> Option<String> {
    let cache = crate::winstt::commands::runtime::probe_cache_states(downloads).await;

    let mut best: Option<(u64, String)> = None;
    for (model_id, by_quant) in &cache {
        // Only fall back to a model whose Rust engine is actually validated — a cached but
        // unwired family (e.g. an experimental export) would decode to a clean "no Rust engine
        // yet" error, defeating the salvage.
        let decodable = crate::winstt::catalog::find(model_id)
            .and_then(crate::winstt::stt::backend::engine_kind_for)
            .is_some();
        if !decodable {
            continue;
        }
        let is_default = crate::winstt::catalog::canonical_model_id(model_id)
            == crate::winstt::settings_schema::DEFAULT_STT_MODEL_ID;
        for info in by_quant.values() {
            if info.state != "cached" {
                continue;
            }
            // The cached factory default wins outright; size only breaks ties
            // among the non-default candidates.
            if is_default {
                return Some(crate::winstt::settings_schema::DEFAULT_STT_MODEL_ID.to_string());
            }
            let size = info.total_bytes.max(info.downloaded_bytes);
            if best.as_ref().is_none_or(|(best_size, _)| size < *best_size) {
                best = Some((size, model_id.clone()));
            }
        }
    }

    best.map(|(_, id)| crate::winstt::catalog::canonical_model_id(&id).to_string())
}

/// Sync wrapper over [`resolve_local_stt_fallback_async`] safe from BOTH a tokio worker (actions'
/// `spawn(async)`) and a plain `std::thread` (the loopback consumer / coordinator). Mirrors the
/// runtime-context branch documented in `backend::cloud_transcribe`.
pub fn resolve_local_stt_fallback(app: &AppHandle) -> Option<String> {
    let downloads = app.state::<Arc<DownloadManager>>().inner().clone();
    let fut = async move { resolve_local_stt_fallback_async(&downloads).await };
    if tokio::runtime::Handle::try_current().is_ok() {
        tokio::task::block_in_place(|| tauri::async_runtime::block_on(fut))
    } else {
        tauri::async_runtime::block_on(fut)
    }
}

/// Emit `stt:pipeline-unavailable` so the overlay can surface an offline error. `reason` is a stable
/// code the renderer localizes (`"offline_no_local"`).
pub fn emit_stt_pipeline_unavailable(app: &AppHandle, reason: &str, provider: Option<&str>) {
    let _ = app.emit(
        STT_PIPELINE_UNAVAILABLE,
        serde_json::json!({
            "pipeline": "stt",
            "reason": reason,
            "provider": provider,
        }),
    );
}
