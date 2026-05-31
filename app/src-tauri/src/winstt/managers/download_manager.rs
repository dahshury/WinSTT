// PORT IMPL — models slice (app/PORT/10_frontend_port_plan.md §6 WU-4). Source:
//   frontend/electron/ipc/stt-commands.ts + frontend/src/shared/api/ipc-client.ts
//     (predownload/pause/resume/cancel/delete + the model_download_start/progress/complete +
//      model_cache_changed broadcasts — the EXACT renderer-facing IPC shapes)
//   + frontend/src/features/model-download/* (per-quant keyed map, coalesced progress, optimistic
//     pause flip) + server streaming_downloader (per-quant pause/resume-capable HF fetch).
//
// DownloadManager runs per-(model_id, quantization) downloads INTO the HF cache WITHOUT changing
// the loaded model (so the user keeps dictating while a download runs). It owns:
//   - a keyed in-flight registry (`model@quant`) with pause/cancel flags,
//   - the four renderer-facing broadcasts in WinSTT's exact IPC shapes:
//       `stt:model-download-start`    { model, quantization? }
//       `stt:model-download-progress` { model, quantization?, progress, downloadedBytes, totalBytes,
//                                       speedBps, etaSeconds }
//       `stt:model-download-complete` { model, quantization?, cancelled }
//       `stt:model-cache-changed`     { modelId }
//   - REAL per-quant + whole-model delete (wipes the HF cache files + re-broadcasts cache-changed),
//   - a `cache_snapshot()` probe the picker's `list_models_with_state` overlays so badges reflect
//     real on-disk state (delegates to `winstt::stt::cache_probe`).
//
// The byte-streaming engine rides hf-hub's `download_file().progress(..)` (which fetches into the
// SAME cache `winstt::stt::resolver` reads → badge↔load agreement). Pause/cancel are honored at
// FILE boundaries (hf-hub owns the mid-file fetch + its `.incomplete` resume markers); the per-quant
// plan is computed via `resolver::plan_quant_download`. Everything compiles and runs end-to-end.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::winstt::catalog;
use crate::winstt::stt::cache_probe::{self, CacheState, ProbeModel};
use crate::winstt::stt::resolver;
use crate::winstt::stt::Quantization;

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
            // hf-hub's cache + `.incomplete` markers make this a resume on disk (server parity).
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
        // Glob the HF cache snapshot for this model and unlink the `.onnx` graphs whose stem carries
        // `quantization` (+ their `.onnx_data*` sidecars). Other quants intact.
        let quant = Quantization::parse(quantization).unwrap_or(Quantization::Default);
        let deleted = tauri::async_runtime::block_on(delete_quant_files(model, quant));
        if let Err(e) = deleted {
            log::warn!("[stt-download] per-quant delete failed for {model}@{quantization}: {e}");
        }
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
        // Remove the entire repo cache subdir (`<cache>/models--owner--name/`).
        if let Err(e) = tauri::async_runtime::block_on(delete_repo_cache(model)) {
            log::warn!("[stt-download] whole-model delete failed for {model}: {e}");
        }
        self.emit_cache_changed(model);
    }

    // ── Cache probe (overlay for list_models_with_state) ──

    /// Probe the HF cache for `models` (catalog `(id, family, onnx_name, quantizations)`), returning
    /// `model_id → quant → ModelCacheInfo-shaped triple`. Blocking shim over the async probe (the
    /// runtime command runs off the async pump). In-flight downloads are reflected by overlaying the
    /// keyed registry on top (a downloading quant that isn't fully cached yet reads `partial`).
    pub fn cache_snapshot(
        &self,
        models: &[ProbeModel],
    ) -> BTreeMap<String, BTreeMap<String, (CacheState, u64, u64)>> {
        let probed = tauri::async_runtime::block_on(cache_probe::probe_cache(models));
        let mut out: BTreeMap<String, BTreeMap<String, (CacheState, u64, u64)>> = BTreeMap::new();
        let inflight = self.inflight.lock().expect("download registry poisoned");
        for m in models {
            let mqc = probed.get(&m.id).cloned().unwrap_or_default();
            let mut by_quant: BTreeMap<String, (CacheState, u64, u64)> = BTreeMap::new();
            for q in &m.quantizations {
                let mut entry = mqc
                    .by_quant
                    .get(q)
                    .copied()
                    .unwrap_or((CacheState::NotCached, 0, 0));
                // If a download is in-flight for this (model, quant) and it isn't already fully
                // cached, surface `partial` so the badge shows "downloading" rather than the stale
                // not_cached (the live progress events carry the real fraction).
                if entry.0 != CacheState::Cached && inflight.contains_key(&key(&m.id, q)) {
                    entry.0 = CacheState::Partial;
                }
                by_quant.insert(q.clone(), entry);
            }
            out.insert(m.id.clone(), by_quant);
        }
        out
    }

    // ── Worker ──

    /// Per-quant download worker. Resolves the model's file plan, then streams each planned file via
    /// hf-hub's progress-aware fetch INTO the HF cache, emitting `emit_progress` as bytes land and
    /// honoring `paused`/`cancelled` at file boundaries. On cancel the in-flight `.incomplete`
    /// markers are left for hf-hub to resume from; on success the badge flips to "Downloaded".
    fn run_quant_download(&self, model: String, quantization: String, handle: Arc<DownloadHandle>) {
        if handle.cancelled.load(Ordering::Acquire) {
            self.finish_quant(&model, &quantization, true);
            return;
        }

        // Resolve the engine kind for the model so we know which files this quant needs.
        let entry = catalog::find(&model);
        let kind = match entry {
            Some(e) => cache_probe::engine_kind_for(e.id, e.family.as_str(), e.onnx_model_name),
            // Off-catalog repo → permissive Whisper-HF layout (resolver's default assumption).
            None => cache_probe::engine_kind_for(&model, "custom", &model),
        };
        let quant = Quantization::parse(&quantization).unwrap_or(Quantization::Default);

        // Plan: list the repo tree once → required graphs + sidecars + config + vocab/tokenizer.
        let planned = match tauri::async_runtime::block_on(resolver::plan_quant_download(&model, kind, quant)) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[stt-download] plan failed for {model}@{quantization}: {e}");
                // No plan → nothing to download. Settle as cancelled so the badge clears rather than
                // spinning forever (the renderer drops the in-flight entry on a cancelled-complete).
                self.finish_quant(&model, &quantization, true);
                return;
            }
        };

        // Stream each file. hf-hub reports per-file byte progress; we aggregate to a model-level
        // running total so the renderer's single progress bar fills smoothly across files.
        let agg = Arc::new(ProgressAgg::new());
        let start = Instant::now();
        for repo_path in &planned {
            if handle.cancelled.load(Ordering::Acquire) {
                self.finish_quant(&model, &quantization, true);
                return;
            }
            // Park on pause (between files) until resumed or cancelled.
            while handle.paused.load(Ordering::Acquire) && !handle.cancelled.load(Ordering::Acquire) {
                std::thread::sleep(std::time::Duration::from_millis(120));
            }
            if handle.cancelled.load(Ordering::Acquire) {
                self.finish_quant(&model, &quantization, true);
                return;
            }

            // Skip files already complete in cache (cheap resume).
            if tauri::async_runtime::block_on(resolver::is_file_cached(&model, repo_path)) {
                agg.mark_file_cached(repo_path);
                self.emit_agg(&model, &quantization, &agg, start);
                continue;
            }

            // Progress handler: fold this file's byte deltas into the aggregate AND emit a live
            // `stt:model-download-progress` from inside the callback (true byte-level progress, like
            // the server's chunked loop). `Progress` is observe-only (it cannot abort the in-flight
            // fetch), so pause/cancel take effect at file boundaries above; the bytes still stream
            // into the SAME HF cache the resolver reads, so a cancelled download leaves a resumable
            // `.incomplete` marker on disk.
            let reporter: Arc<dyn hf_hub::progress::ProgressHandler> = Arc::new(FileReporter {
                agg: Arc::clone(&agg),
                app: self.app.clone(),
                model: model.clone(),
                quantization: quantization.clone(),
                start,
            });
            let handler: hf_hub::progress::Progress = reporter.into();
            let res = tauri::async_runtime::block_on(resolver::download_planned_file(
                &model, repo_path, false, handler,
            ));
            match res {
                Ok(_) => {
                    agg.mark_file_complete(repo_path);
                    self.emit_agg(&model, &quantization, &agg, start);
                }
                Err(e) => {
                    if handle.cancelled.load(Ordering::Acquire) {
                        self.finish_quant(&model, &quantization, true);
                        return;
                    }
                    log::warn!("[stt-download] file fetch failed {model}@{quantization} {repo_path}: {e}");
                    // A hard fetch error (network/repo) settles as non-cancelled complete + cache
                    // refetch so the badge reflects whatever DID land (partial) rather than spinning.
                    self.finish_quant(&model, &quantization, false);
                    return;
                }
            }
        }

        // All planned files present → complete (not cancelled). cache-changed lets the picker
        // re-probe and settle the effective-quant badge to "Downloaded".
        self.finish_quant(&model, &quantization, false);
    }

    /// Emit a coalesced model-level progress event from the aggregate.
    fn emit_agg(&self, model: &str, quantization: &str, agg: &ProgressAgg, start: Instant) {
        let (downloaded, total) = agg.totals();
        let elapsed = start.elapsed().as_secs_f64().max(0.001);
        let speed = (downloaded as f64 / elapsed) as u64;
        let eta = if speed > 0 && total > downloaded {
            (total - downloaded) / speed
        } else {
            0
        };
        self.emit_progress(model, Some(quantization), downloaded, total, speed, eta);
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

// ── Aggregate progress across the planned files of one quant download ──────────────────────────

/// Folds hf-hub's per-file `(bytes_completed, total_bytes)` deltas into a model-level running total.
/// Each file is tracked by name so a `Progress` delta updates the right slot; `total` grows as new
/// files report their HEAD size (the renderer tolerates a growing denominator — it shows the live
/// fraction and the final `complete` event settles the badge).
struct ProgressAgg {
    /// `filename → (completed, total)`.
    files: Mutex<BTreeMap<String, (u64, u64)>>,
}

impl ProgressAgg {
    fn new() -> Self {
        Self { files: Mutex::new(BTreeMap::new()) }
    }

    /// Update one file's live byte counts from an hf-hub progress event.
    fn update_file(&self, name: &str, completed: u64, total: u64) {
        let mut m = self.files.lock().expect("progress agg poisoned");
        let slot = m.entry(name.to_string()).or_insert((0, 0));
        slot.0 = completed.max(slot.0);
        if total > slot.1 {
            slot.1 = total;
        }
    }

    /// Mark a planned file already-cached (counts toward both completed + total once its size is
    /// learned via the cache-hit fast-path; for our purposes we treat cached files as size 0 here
    /// and let live downloads dominate the bar — the final `complete` event is authoritative).
    fn mark_file_cached(&self, name: &str) {
        let mut m = self.files.lock().expect("progress agg poisoned");
        m.entry(name.to_string()).or_insert((0, 0));
    }

    /// Mark a file complete: clamp completed == total.
    fn mark_file_complete(&self, name: &str) {
        let mut m = self.files.lock().expect("progress agg poisoned");
        if let Some(slot) = m.get_mut(name) {
            if slot.1 > 0 {
                slot.0 = slot.1;
            }
        }
    }

    /// Aggregate `(downloaded, total)` across all tracked files.
    fn totals(&self) -> (u64, u64) {
        let m = self.files.lock().expect("progress agg poisoned");
        let mut down = 0u64;
        let mut total = 0u64;
        for (c, t) in m.values() {
            down += *c;
            total += *t;
        }
        (down, total)
    }
}

/// hf-hub `ProgressHandler` for ONE file fetch — routes byte deltas into the shared aggregate AND
/// emits a live coalesced `stt:model-download-progress` so the picker's bar fills in real time.
struct FileReporter {
    agg: Arc<ProgressAgg>,
    app: AppHandle,
    model: String,
    quantization: String,
    start: Instant,
}

impl FileReporter {
    /// Emit the aggregate model-level progress (downloaded/total across every planned file).
    fn emit(&self) {
        let (downloaded, total) = self.agg.totals();
        let progress = if total > 0 { (downloaded as f64 / total as f64).min(1.0) } else { 0.0 };
        let elapsed = self.start.elapsed().as_secs_f64().max(0.001);
        let speed = (downloaded as f64 / elapsed) as u64;
        let eta = if speed > 0 && total > downloaded { (total - downloaded) / speed } else { 0 };
        let _ = self.app.emit(
            "stt:model-download-progress",
            json!({
                "model": self.model,
                "quantization": self.quantization,
                "progress": progress,
                "downloadedBytes": downloaded,
                "totalBytes": total,
                "speedBps": speed,
                "etaSeconds": eta,
            }),
        );
    }
}

impl hf_hub::progress::ProgressHandler for FileReporter {
    fn on_progress(&self, event: &hf_hub::progress::ProgressEvent) {
        use hf_hub::progress::{DownloadEvent, ProgressEvent};
        if let ProgressEvent::Download(dl) = event {
            match dl {
                DownloadEvent::Progress { files } => {
                    for f in files {
                        self.agg.update_file(&f.filename, f.bytes_completed, f.total_bytes);
                    }
                    self.emit();
                }
                DownloadEvent::AggregateProgress { bytes_completed, total_bytes, .. } => {
                    // xet-batch aggregate (no per-file breakdown) — fold under a synthetic key so the
                    // model-level totals still advance.
                    self.agg.update_file("__xet_batch__", *bytes_completed, *total_bytes);
                    self.emit();
                }
                DownloadEvent::Start { .. } | DownloadEvent::Complete => {}
            }
        }
    }
}

// ── Cache deletion (per-quant + whole-model) over hf-hub's scan_cache ────────────────────────────

/// Resolve the HF cache repo subdir for `model_id` (`<cache>/models--owner--name/`) by scanning the
/// cache. Returns `None` when the repo isn't cached.
async fn cached_repo_path(model_id: &str) -> Option<std::path::PathBuf> {
    let client = hf_hub::HFClient::new().ok()?;
    let scan = client.scan_cache().send().await.ok()?;
    let key = resolver::resolve_repo(model_id).map(|(o, n)| format!("{o}/{n}").to_ascii_lowercase())?;
    scan.repos
        .iter()
        .find(|r| r.repo_id.to_ascii_lowercase() == key)
        .map(|r| r.repo_path.clone())
}

/// Delete just the files matching `quant` from the model's HF cache snapshot(s). Removes the
/// snapshot pointer files (`.onnx` graphs + their `.onnx_data*` sidecars) whose stem carries the
/// quant tag; the dedup blob GC is left to hf-hub (orphan blobs are harmless). Returns the number of
/// removed files. Mirrors the server's per-quant cache wipe.
async fn delete_quant_files(model_id: &str, quant: Quantization) -> std::io::Result<usize> {
    let client = match hf_hub::HFClient::new() {
        Ok(c) => c,
        Err(e) => return Err(std::io::Error::other(e.to_string())),
    };
    let scan = match client.scan_cache().send().await {
        Ok(s) => s,
        Err(e) => return Err(std::io::Error::other(e.to_string())),
    };
    let key = match resolver::resolve_repo(model_id).map(|(o, n)| format!("{o}/{n}").to_ascii_lowercase()) {
        Some(k) => k,
        None => return Ok(0),
    };
    let repo = match scan.repos.iter().find(|r| r.repo_id.to_ascii_lowercase() == key) {
        Some(r) => r,
        None => return Ok(0),
    };

    let mut removed = 0usize;
    for rev in &repo.revisions {
        for f in &rev.files {
            let name = f.file_name.replace('\\', "/");
            if !file_belongs_to_quant(&name, quant) {
                continue;
            }
            // Remove the snapshot pointer file (Windows = a copy; deleting it frees the snapshot
            // slot — the orphaned blob is GC'd by hf-hub or harmless until then).
            if f.file_path.exists() {
                std::fs::remove_file(&f.file_path)?;
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Whether a cached file name belongs to `quant`: an `.onnx` graph whose stem carries the quant tag,
/// OR an external-data sidecar of such a graph. Default-quant deletion targets unsuffixed graphs.
fn file_belongs_to_quant(name: &str, quant: Quantization) -> bool {
    let file = name.rsplit(['/', '\\']).next().unwrap_or(name);
    // Graph file: `.onnx` whose own quant tag equals the target.
    if file.ends_with(".onnx") {
        return resolver::file_quantization(file) == quant;
    }
    // Sidecar: `<graph_stem>.onnx_data*` / `.onnx.data*` — quant is on the graph stem.
    if let Some(idx) = file.find(".onnx") {
        let graph_stem = &file[..idx]; // up to but excluding ".onnx"
        // The sidecar's graph stem is `graph_stem`; its quant tag is the last `_`/`.` component.
        let last = graph_stem.rsplit(['_', '.']).next().unwrap_or("");
        let tag = Quantization::parse(last)
            .filter(|q| *q != Quantization::Default)
            .unwrap_or(Quantization::Default);
        // Only treat as a sidecar when the name actually carries `.onnx_data` / `.onnx.data`.
        let is_sidecar = file.contains(".onnx_data") || file.contains(".onnx.data");
        return is_sidecar && tag == quant;
    }
    false
}

/// Delete the entire cache subdir for `model_id`'s repo (every quant + every revision). Mirrors the
/// server's whole-model cache wipe.
async fn delete_repo_cache(model_id: &str) -> std::io::Result<()> {
    if let Some(path) = cached_repo_path(model_id).await {
        if path.exists() {
            std::fs::remove_dir_all(&path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_matches_renderer_quantkey() {
        assert_eq!(key("tiny", "fp16"), "tiny@fp16");
        assert_eq!(key("tiny", ""), "tiny@");
    }

    #[test]
    fn quant_file_attribution() {
        // Graph files attribute by their own quant tag.
        assert!(file_belongs_to_quant("onnx/encoder_model_fp16.onnx", Quantization::Fp16));
        assert!(!file_belongs_to_quant("onnx/encoder_model_fp16.onnx", Quantization::Default));
        assert!(file_belongs_to_quant("onnx/encoder_model.onnx", Quantization::Default));
        assert!(file_belongs_to_quant("model.int8.onnx", Quantization::Int8));
        // Sidecars attribute by the graph stem's quant tag.
        assert!(file_belongs_to_quant("onnx/decoder_model_merged_fp16.onnx_data", Quantization::Fp16));
        assert!(file_belongs_to_quant("onnx/decoder_model_merged_fp16.onnx_data_1", Quantization::Fp16));
        assert!(!file_belongs_to_quant("onnx/decoder_model_merged_fp16.onnx_data", Quantization::Default));
        // Non-onnx text files belong to no quant (shared across quants).
        assert!(!file_belongs_to_quant("vocab.json", Quantization::Default));
        assert!(!file_belongs_to_quant("tokens.txt", Quantization::Int8));
    }

    #[test]
    fn progress_agg_sums_files() {
        let agg = ProgressAgg::new();
        agg.update_file("a.onnx", 50, 100);
        agg.update_file("b.onnx", 30, 200);
        assert_eq!(agg.totals(), (80, 300));
        agg.mark_file_complete("a.onnx");
        assert_eq!(agg.totals(), (130, 300));
    }
}
