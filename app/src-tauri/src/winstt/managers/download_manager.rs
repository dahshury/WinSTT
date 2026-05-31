// PORT IMPL — WU-4 (app/PORT/10_frontend_port_plan.md §6 WU-4). Source:
//   frontend/electron/ipc/stt-models.ts (predownload/pause/resume/cancel/delete + the
//     model_download_start/progress/complete + model_cache_changed broadcasts)
//   + frontend/src/features/model-download/* (the renderer contract: per-quant keyed map,
//     coalesced progress, optimistic pause flip)
//   + server streaming_downloader (per-quant byte-level pause/resume capable HF fetch).
//
// DownloadManager runs per-(model_id, quantization) streaming downloads INTO the HF cache without
// changing the loaded model (so the user keeps dictating while a download runs). It owns:
//   - a keyed in-flight registry (`model@quant`) with pause/resume/cancel flags,
//   - the four renderer-facing broadcasts in WinSTT's exact IPC shapes:
//       `stt:model-download-start`    { model, quantization? }
//       `stt:model-download-progress` { model, quantization?, progress, downloadedBytes, totalBytes,
//                                       speedBps, etaSeconds }
//       `stt:model-download-complete` { model, quantization?, cancelled }
//       `stt:model-cache-changed`     { modelId }
//   - delete (per-quant + whole-model) which wipes cache files and re-broadcasts cache-changed.
//
// The byte-streaming engine (HF fetch via `winstt::stt::resolver::resolve`, which needs the engine
// slice's model_id→EngineKind glob resolution) is the §7 engine-swap GATE; until it lands, the fetch
// is a documented SPIKE. Everything around it — the keyed registry, the pause/resume/cancel/delete
// control surface, and the four broadcasts in their exact shapes — compiles and runs unconditionally,
// so the picker's download chrome is wired end-to-end the moment the fetch is filled in.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::{AppHandle, Emitter};

/// Per-(model, quant) control flags shared with the worker thread.
struct DownloadHandle {
    paused: AtomicBool,
    cancelled: AtomicBool,
}

impl DownloadHandle {
    fn new() -> Self {
        Self { paused: AtomicBool::new(false), cancelled: AtomicBool::new(false) }
    }
}

/// Composite key for the in-flight registry: `model@quant` (matches the renderer's `quantKey`).
fn key(model: &str, quant: &str) -> String {
    format!("{model}@{quant}")
}

pub struct DownloadManager {
    app: AppHandle,
    /// In-flight downloads keyed by `model@quant`.
    inflight: Mutex<BTreeMap<String, Arc<DownloadHandle>>>,
    /// Legacy single-slot whole-model download cancel flag (the no-quantization path).
    legacy_cancel: AtomicBool,
}

impl DownloadManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            inflight: Mutex::new(BTreeMap::new()),
            legacy_cancel: AtomicBool::new(false),
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    // ── Broadcasts (WinSTT IPC shapes — byte-identical so the renderer listeners run verbatim) ──

    /// `stt:model-download-start`. `quantization=None` → the legacy whole-model swap-download path.
    fn emit_start(&self, model: &str, quantization: Option<&str>) {
        let _ = self
            .app
            .emit("stt:model-download-start", json!({ "model": model, "quantization": quantization }));
    }

    /// `stt:model-download-progress`. `progress` is the 0.0..1.0 fraction (the renderer multiplies
    /// by 100 and rounds in `normalizeProgressPayload`).
    pub fn emit_progress(
        &self,
        model: &str,
        quantization: Option<&str>,
        downloaded_bytes: u64,
        total_bytes: u64,
        speed_bps: u64,
        eta_seconds: u64,
    ) {
        let progress = if total_bytes > 0 {
            (downloaded_bytes as f64 / total_bytes as f64).min(1.0)
        } else {
            0.0
        };
        let _ = self.app.emit(
            "stt:model-download-progress",
            json!({
                "model": model,
                "quantization": quantization,
                "progress": progress,
                "downloadedBytes": downloaded_bytes,
                "totalBytes": total_bytes,
                "speedBps": speed_bps,
                "etaSeconds": eta_seconds,
            }),
        );
    }

    /// `stt:model-download-complete` + `stt:model-cache-changed` (so the per-quant badge flips AND
    /// the model-state store refetches — both are how the renderer settles the final badge).
    fn emit_complete(&self, model: &str, quantization: Option<&str>, cancelled: bool) {
        let _ = self.app.emit(
            "stt:model-download-complete",
            json!({ "model": model, "quantization": quantization, "cancelled": cancelled }),
        );
        self.emit_cache_changed(model);
    }

    /// `stt:model-cache-changed` — drives `onModelCacheChanged` → model-state refetch.
    pub fn emit_cache_changed(&self, model: &str) {
        let _ = self.app.emit("stt:model-cache-changed", json!({ "modelId": model }));
    }

    // ── Per-quant download control (predownload / pause / resume / cancel) ──

    /// Start (or restart) a per-quant streaming download. Idempotent: re-issuing for a key that's
    /// already in-flight just clears its paused/cancelled flags and re-emits start.
    pub fn predownload_quant(self: &Arc<Self>, model: String, quantization: String) {
        let k = key(&model, &quantization);
        let handle = {
            let mut map = self.inflight.lock().expect("download registry poisoned");
            let h = map.entry(k).or_insert_with(|| Arc::new(DownloadHandle::new())).clone();
            h.paused.store(false, Ordering::Release);
            h.cancelled.store(false, Ordering::Release);
            h
        };
        self.emit_start(&model, Some(&quantization));
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            me.run_quant_download(model, quantization, handle);
        });
    }

    pub fn pause_quant(&self, model: &str, quantization: &str) {
        if let Some(h) = self.inflight.lock().expect("download registry poisoned").get(&key(model, quantization)) {
            h.paused.store(true, Ordering::Release);
        }
    }

    pub fn resume_quant(self: &Arc<Self>, model: String, quantization: String) {
        let k = key(&model, &quantization);
        let existing = self.inflight.lock().expect("download registry poisoned").get(&k).cloned();
        match existing {
            Some(h) => h.paused.store(false, Ordering::Release),
            // Resume after the worker already exited (paused→worker drained): re-kick a fresh fetch.
            // The HF cache + .partial markers make this a Range-resume on disk (server parity).
            None => self.predownload_quant(model, quantization),
        }
    }

    pub fn cancel_quant(&self, model: &str, quantization: &str) {
        let k = key(model, quantization);
        if let Some(h) = self.inflight.lock().expect("download registry poisoned").get(&k) {
            h.cancelled.store(true, Ordering::Release);
            h.paused.store(false, Ordering::Release);
        }
    }

    /// The legacy whole-model swap-download cancel (`STT_CANCEL_DOWNLOAD`, no quantization).
    pub fn cancel_download(&self) {
        self.legacy_cancel.store(true, Ordering::Release);
    }

    pub fn take_legacy_cancel(&self) -> bool {
        self.legacy_cancel.swap(false, Ordering::AcqRel)
    }

    // ── Delete (per-quant + whole-model) ──

    /// Per-quant delete — wipe only the weight files matching `quantization`. Re-broadcasts
    /// cache-changed so the badge drops to "not cached" without a manual refetch.
    pub fn delete_quantization(&self, model: &str, quantization: &str) {
        // First, stop any in-flight download for this key (deleting under it would race).
        self.cancel_quant(model, quantization);
        {
            let mut map = self.inflight.lock().expect("download registry poisoned");
            map.remove(&key(model, quantization));
        }
        // SPIKE: glob the HF cache snapshot for this model and unlink the files whose `.onnx` stem
        // carries `quantization` (+ their `.onnx_data*` sidecars). The cache-path resolution rides
        // `winstt::stt::resolver` (engine-swap §7 gate). The broadcast + registry bookkeeping are real.
        self.emit_cache_changed(model);
    }

    /// Whole-model delete — wipe the entire HF snapshot directory for `model`.
    pub fn delete_model_cache(&self, model: &str) {
        {
            let mut map = self.inflight.lock().expect("download registry poisoned");
            map.retain(|k, h| {
                if k.starts_with(&format!("{model}@")) {
                    h.cancelled.store(true, Ordering::Release);
                    false
                } else {
                    true
                }
            });
        }
        // SPIKE: `std::fs::remove_dir_all` on the resolved HF snapshot dir for this model's repo.
        self.emit_cache_changed(model);
    }

    // ── Worker ──

    /// Per-quant download worker. SPIKE: stream the model's quant files via
    /// `winstt::stt::resolver::resolve` (model_id→EngineKind glob → hf-hub fetch), emitting
    /// `emit_progress` per chunk and honoring `paused`/`cancelled`. Until that lands, complete
    /// immediately as cancelled so the badge clears rather than spinning forever.
    fn run_quant_download(&self, model: String, quantization: String, handle: Arc<DownloadHandle>) {
        // The real loop is: resolve plan → for each planned file → stream bytes → on each chunk:
        //   if handle.cancelled → emit complete(cancelled=true), unlink .partial, return;
        //   while handle.paused && !cancelled → park (.partial preserved for Range-resume);
        //   else → write chunk, emit_progress(...).
        // Final: verify external-data complete → emit complete(cancelled=false).
        if handle.cancelled.load(Ordering::Acquire) {
            self.finish_quant(&model, &quantization, true);
            return;
        }
        // SPIKE placeholder: no engine-kind→glob resolution wired yet, so report cancelled-complete
        // (the renderer drops the in-flight entry; no zombie "downloading" badge). The control
        // surface, registry, and broadcasts above are the durable parts of this slice.
        self.finish_quant(&model, &quantization, true);
    }

    fn finish_quant(&self, model: &str, quantization: &str, cancelled: bool) {
        self.inflight
            .lock()
            .expect("download registry poisoned")
            .remove(&key(model, quantization));
        self.emit_complete(model, Some(quantization), cancelled);
    }

    /// Whether `(model, quant)` has an in-flight download (parity with the renderer's
    /// `isQuantDownloading` guard the swap controller reads).
    pub fn is_downloading(&self, model: &str, quantization: &str) -> bool {
        self.inflight
            .lock()
            .map(|m| m.contains_key(&key(model, quantization)))
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_matches_renderer_quantkey() {
        assert_eq!(key("tiny", "fp16"), "tiny@fp16");
        assert_eq!(key("tiny", ""), "tiny@");
    }
}
