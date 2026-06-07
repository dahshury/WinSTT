// PORT IMPL — models slice (docs/archive/port/10_frontend_port_plan.md §6 WU-4). Source:
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
//
// This module is split into focused submodules that hold the file-private helper clusters which
// never touch `DownloadManager`'s private state — this root keeps the cohesive control + streaming
// state machine (the struct + its full impl), the registry handle, the worker job, the consts, and
// the tests:
//   - `progress`     — per-file progress aggregate + the hf-hub fallback `ProgressHandler` reporter.
//   - `http_meta`    — HF resolve/CDN header parsing + repo file-size fetch (`StreamOutcome` lives
//                      here too as it gates the stream path).
//   - `cache_delete` — per-quant + whole-model HF cache deletion + the `key()` composite-key helper.

mod cache_delete;
mod http_meta;
mod progress;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::winstt::catalog;
use crate::winstt::downloads::{
    transfer_url_blocking, TransferControl, TransferOutcome, TransferRequest,
};
use crate::winstt::stt::cache_probe::{self, CacheState, ProbeModel};
use crate::winstt::stt::resolver;
use crate::winstt::stt::Quantization;

// Re-import the submodule helpers so the impl's call sites resolve unchanged, and so the
// `#[cfg(test)] mod tests` block's `use super::*` keeps reaching `key` / `file_belongs_to_quant` /
// `ProgressAgg` / `header_etag` / `header_size` / `parse_sibling_sizes` / `ensure_cache_ref`.
use cache_delete::*;
use http_meta::*;
use progress::*;

/// Per-(model, quant) control + progress state, shared between the registry and whichever pool
/// worker currently owns the job.
///
/// `paused`/`cancelled` are the hot flags the streamer polls on every chunk. `parked` is the
/// lifecycle bit that lets a PAUSED download RELEASE its pool slot instead of tying up a worker
/// thread: when the worker observes a pause it marks the job parked and RETURNS; `resume`
/// re-enqueues a fresh `run_quant_download` for the same handle. `parked` is only ever read/written
/// while holding the manager's `inflight` lock, so park/resume/cancel transitions are atomic and a
/// key can never be double-run or stranded.
///
/// `agg`/`start` live on the handle (not as `run_quant_download` locals) so the progress total and
/// speed/ETA carry across the pause→resume re-run instead of resetting to 0%.
struct DownloadHandle {
    paused: AtomicBool,
    cancelled: AtomicBool,
    parked: AtomicBool,
    agg: Arc<ProgressAgg>,
    partial_path: Mutex<Option<std::path::PathBuf>>,
    start: Instant,
}

impl DownloadHandle {
    fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            parked: AtomicBool::new(false),
            agg: Arc::new(ProgressAgg::new()),
            partial_path: Mutex::new(None),
            start: Instant::now(),
        }
    }
}

impl TransferControl for DownloadHandle {
    fn should_cancel(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    fn should_pause(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }
}

/// How long a cached HF-scan result stays fresh before the next `cache_snapshot_async` re-scans.
/// Short enough that a download landing outside our own broadcast (e.g. a manual cache edit) still
/// surfaces within a couple seconds; long enough that the picker's rapid back-to-back
/// `list_models_with_state` calls (mount + focus + every keystroke filter) reuse one fs scan.
const CACHE_SCAN_TTL: Duration = Duration::from_millis(2000);

/// Max concurrent per-quant download workers (audit #17, Tier-2 B). "Download all" / rapid quant
/// toggling would otherwise fan out one OS thread per quant, each holding a blocking HF client + a
/// nested `block_on`. This is now the size of a FIXED worker pool — exactly N long-lived threads
/// consume download jobs from a shared queue, so queued quants wait IN THE QUEUE rather than as
/// parked OS threads on a semaphore. Two workers keep two transfers saturating the link without
/// unbounded thread/socket pressure.
const MAX_CONCURRENT_DOWNLOADS: usize = 2;

/// A unit of work handed to a pool worker: the `(model, quant)` to fetch plus its already-registered
/// control handle (registered at ENQUEUE time so a cancel can flip the flag while the job waits in
/// the queue — the worker re-checks `cancelled` on dequeue before spending any network I/O).
struct DownloadJob {
    model: String,
    quantization: String,
    handle: Arc<DownloadHandle>,
}

pub struct DownloadManager {
    app: AppHandle,
    /// In-flight downloads keyed by `model@quant`.
    inflight: Mutex<BTreeMap<String, Arc<DownloadHandle>>>,
    /// Legacy single-slot whole-model download cancel flag (the no-quantization path).
    legacy_cancel: AtomicBool,
    /// Short-TTL memo of the raw HF cache scan (audit #7): the picker fires `list_models_with_state`
    /// repeatedly, and each call otherwise re-walks the whole HF cache. Holds the catalog-wide probe
    /// result + when it was taken; invalidated by `emit_cache_changed` (a download landed) so a fresh
    /// badge is never stale past a real cache mutation.
    scan_memo: Mutex<Option<(Instant, BTreeMap<String, cache_probe::ModelQuantCache>)>>,
    /// Sender into the fixed worker pool's shared job queue. Lazily initialized on the first
    /// `predownload_quant` (the first call that has an `Arc<Self>` to hand the workers), which
    /// spawns exactly `MAX_CONCURRENT_DOWNLOADS` long-lived worker threads. This is the concurrency
    /// bound now (replaces the per-quant `thread::spawn` + `Semaphore`): queued quants sit in the
    /// channel, not as parked OS threads.
    job_tx: OnceLock<Sender<DownloadJob>>,
}

impl DownloadManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            inflight: Mutex::new(BTreeMap::new()),
            legacy_cancel: AtomicBool::new(false),
            scan_memo: Mutex::new(None),
            job_tx: OnceLock::new(),
        }
    }

    pub fn app(&self) -> &AppHandle {
        &self.app
    }

    // ── Broadcasts (WinSTT IPC shapes — byte-identical so the renderer listeners run verbatim) ──

    /// `stt:model-download-start`. `quantization=None` → the legacy whole-model swap-download path.
    fn emit_start(&self, model: &str, quantization: Option<&str>) {
        let _ = self.app.emit(
            "stt:model-download-start",
            json!({ "model": model, "quantization": quantization }),
        );
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

    /// `stt:model-cache-changed` — drives `onModelCacheChanged` → model-state refetch. Also drops
    /// the cached scan memo (audit #7) so the very next `list_models_with_state` re-walks the cache
    /// and reflects the just-changed on-disk state instead of a stale snapshot.
    pub fn emit_cache_changed(&self, model: &str) {
        self.invalidate_scan_memo();
        let _ = self
            .app
            .emit("stt:model-cache-changed", json!({ "modelId": model }));
    }

    /// Drop the memoized HF cache scan so the next probe re-walks the cache.
    pub fn invalidate_scan_memo(&self) {
        if let Ok(mut memo) = self.scan_memo.lock() {
            *memo = None;
        }
    }

    // ── Per-quant download control (predownload / pause / resume / cancel) ──

    /// Start (or restart) a per-quant streaming download. Idempotent: re-issuing for a key that's
    /// already in-flight just clears its paused/cancelled flags and re-emits start.
    pub fn predownload_quant(self: &Arc<Self>, model: String, quantization: String) {
        // Cheap pre-spawn short-circuit (audit #17): if this (model, quant) is ALREADY fully cached
        // on disk, don't register a handle, spawn a thread, or touch the network — just settle the
        // badge. This is the common case behind "download all" / rapid quant toggling and is what
        // turns the per-quant `std::thread::spawn` storm into a no-op. The probe is a local-only
        // `scan_cache()` walk (no HF HEAD/tree fetch) keyed exactly like the picker badge, so a
        // short-circuit here can never disagree with what `list_models_with_state` shows. Only fires
        // when NO in-flight handle exists yet (a re-issue against a live/paused download must fall
        // through to the registry path below so pause/cancel/resume stay intact).
        if !self.is_downloading(&model, &quantization)
            && self.is_quant_fully_cached(&model, &quantization)
        {
            self.emit_start(&model, Some(&quantization));
            self.emit_complete(&model, Some(&quantization), false);
            return;
        }

        // Register/refresh the handle and decide whether to enqueue — all under the registry lock so
        // it's race-free against pause/resume/cancel. This is also the RESUME path (resume_quant
        // delegates here): a parked job re-enters the pool, an active one is left alone.
        //   - brand-new entry                          → enqueue (a worker picks it up),
        //   - existing but PARKED (paused, no worker)   → re-enqueue — THIS is resume,
        //   - existing and ACTIVE (a worker owns it)    → DON'T enqueue (would double-run the key);
        //                                                 just clear the flags so it keeps going.
        // A cancel-while-queued flips `cancelled`; the worker re-checks it on dequeue before any I/O.
        let k = key(&model, &quantization);
        let (handle, should_enqueue) = {
            let mut map = self.inflight.lock().expect("download registry poisoned");
            match map.get(&k) {
                Some(h) => {
                    h.paused.store(false, Ordering::Release);
                    h.cancelled.store(false, Ordering::Release);
                    // `swap(false)`: claim the slot iff it WAS parked (enqueue exactly once); an
                    // active job stays active (parked already false) and is not re-enqueued.
                    let was_parked = h.parked.swap(false, Ordering::AcqRel);
                    (h.clone(), was_parked)
                }
                None => {
                    let h = Arc::new(DownloadHandle::new());
                    map.insert(k.clone(), h.clone());
                    (h, true)
                }
            }
        };
        self.emit_start(&model, Some(&quantization));
        if !should_enqueue {
            return;
        }
        // Hand the job to the fixed worker pool instead of spawning a fresh OS thread per quant.
        let job = DownloadJob {
            model: model.clone(),
            quantization: quantization.clone(),
            handle,
        };
        if self.job_sender().send(job).is_err() {
            // The pool's receiver is gone (would only happen if every worker thread had already
            // exited, which they don't until process teardown). Settle the badge rather than leak an
            // in-flight entry that never completes.
            self.finish_quant(&model, &quantization, true);
        }
    }

    /// The fixed worker pool's job sender, spinning the pool up on first use.
    ///
    /// We init lazily (not in `new`) because the workers need an `Arc<Self>` to call the per-quant
    /// methods, and the manager is only wrapped in an `Arc` AFTER construction (`Arc::new(.. ::new)`
    /// in `lib.rs`). `predownload_quant` is the only enqueue site and already takes `self: &Arc<Self>`,
    /// so the pool is born the first time a download is actually requested. The `OnceLock` guarantees
    /// exactly one pool of exactly `MAX_CONCURRENT_DOWNLOADS` workers regardless of concurrent calls.
    fn job_sender(self: &Arc<Self>) -> &Sender<DownloadJob> {
        self.job_tx.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<DownloadJob>();
            // A single receiver shared across all workers; the `Mutex` serializes `recv()` so each
            // queued job is handed to exactly one idle worker (work-stealing fan-out, FIFO order).
            let rx = Arc::new(Mutex::new(rx));
            for n in 0..MAX_CONCURRENT_DOWNLOADS {
                let me = Arc::clone(self);
                let rx = Arc::clone(&rx);
                let _ = std::thread::Builder::new()
                    .name(format!("stt-download-worker-{n}"))
                    .spawn(move || loop {
                        // Block until a job is available. Holding the lock only across `recv()`
                        // (then dropping it before running) lets the OTHER worker grab the next job
                        // concurrently → up to N transfers in flight, the same bound as the old
                        // 2-permit semaphore. When the `Sender` is dropped at process teardown,
                        // `recv()` returns `Err` and the worker exits cleanly (no leak, no hang).
                        let job = {
                            let guard = match rx.lock() {
                                Ok(g) => g,
                                Err(_) => break, // receiver mutex poisoned → exit the worker
                            };
                            match guard.recv() {
                                Ok(job) => job,
                                Err(_) => break, // channel closed → drain done, exit
                            }
                        };
                        let DownloadJob {
                            model,
                            quantization,
                            handle,
                        } = job;
                        me.run_quant_download(model, quantization, handle);
                    });
            }
            tx
        })
    }

    /// Cheap, NETWORK-FREE check that every required `.onnx` graph for `(model, quant)` is already
    /// present in the HF cache — i.e. the picker would badge this quant "Downloaded". Reuses the
    /// same `cache_probe` scan the badge overlay reads (local `scan_cache()` only; no HF tree/HEAD
    /// fetch), built for the single (model, quant) so it's a constant-size probe. Returns `false`
    /// on any probe gap (unknown alias, scan IO error, off-catalog repo with no cache entry) so the
    /// caller falls through to the real download worker — never a false "already cached".
    fn is_quant_fully_cached(&self, model: &str, quantization: &str) -> bool {
        // Mirror the worker's family/onnx-name resolution so the probe globs match the planned set.
        let (family, onnx_name) = match catalog::find(model) {
            Some(e) => (e.family.as_str().to_string(), e.onnx_model_name.to_string()),
            // Off-catalog repo → the same permissive "custom" assumption the worker uses.
            None => ("custom".to_string(), model.to_string()),
        };
        let probe = ProbeModel {
            id: model.to_string(),
            family,
            onnx_name,
            quantizations: vec![quantization.to_string()],
        };
        // `predownload_quant` is a SYNC `#[tauri::command]`, which Tauri runs on its multi-thread
        // async-runtime worker; a bare `block_on` there panics ("cannot start a runtime from within
        // a runtime"). `block_in_place` releases the worker so the nested `block_on` is safe (same
        // reason as `delete_quantization` / `delete_model_cache` below).
        let probed = tokio::task::block_in_place(|| {
            tauri::async_runtime::block_on(cache_probe::probe_cache(std::slice::from_ref(&probe)))
        });
        matches!(
            probed
                .get(model)
                .and_then(|mqc| mqc.by_quant.get(quantization)),
            Some((CacheState::Cached, _, _))
        )
    }

    pub fn pause_quant(&self, model: &str, quantization: &str) {
        if let Some(h) = self
            .inflight
            .lock()
            .expect("download registry poisoned")
            .get(&key(model, quantization))
        {
            h.paused.store(true, Ordering::Release);
        }
    }

    pub fn resume_quant(self: &Arc<Self>, model: String, quantization: String) {
        // Resume == predownload: it clears `paused` and re-enqueues IFF the job had parked (released
        // its worker on pause). An already-active job just keeps running; one whose worker already
        // exited is re-kicked and continues from its `.incomplete` bytes via HTTP Range.
        self.predownload_quant(model, quantization);
    }

    pub fn cancel_quant(&self, model: &str, quantization: &str) {
        let k = key(model, quantization);
        // Under the registry lock: flag the job cancelled. If it had PARKED (paused → released its
        // worker), no worker will ever observe the flag, so settle it HERE (remove + emit complete);
        // otherwise the active worker sees `cancelled` on its next chunk and finishes itself.
        let settle = {
            let mut map = self.inflight.lock().expect("download registry poisoned");
            match map.get(&k) {
                Some(h) => {
                    h.cancelled.store(true, Ordering::Release);
                    h.paused.store(false, Ordering::Release);
                    if h.parked.load(Ordering::Acquire) {
                        if let Ok(mut partial_path) = h.partial_path.lock() {
                            if let Some(path) = partial_path.take() {
                                let _ = std::fs::remove_file(path);
                            }
                        }
                        map.remove(&k);
                        true
                    } else {
                        false
                    }
                }
                None => false,
            }
        };
        if settle {
            self.emit_complete(model, Some(quantization), true);
        }
    }

    /// Release the current worker's slot for a paused job. Under the registry lock (atomic against
    /// resume/cancel): if the job is STILL paused and not cancelled, mark it `parked` and return
    /// `true` so the worker exits — `resume`/`predownload_quant` re-enqueues it later. Returns
    /// `false` when a resume/cancel already cleared `paused` in the race window, so the worker keeps
    /// going instead of stranding the job.
    fn try_park(&self, handle: &DownloadHandle) -> bool {
        let _guard = self.inflight.lock().expect("download registry poisoned");
        if handle.paused.load(Ordering::Acquire) && !handle.cancelled.load(Ordering::Acquire) {
            handle.parked.store(true, Ordering::Release);
            true
        } else {
            false
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
        // Runs inside a SYNC #[tauri::command] body, which Tauri spawns onto the
        // multi-thread async runtime; a bare `block_on` there panics ("cannot start
        // a runtime from within a runtime"). `block_in_place` releases the worker so
        // the nested `block_on` is safe (mirrors `backend.rs` cloud_transcribe).
        let deleted = tokio::task::block_in_place(|| {
            tauri::async_runtime::block_on(delete_quant_files(model, quant))
        });
        if let Err(e) = deleted {
            log::warn!("[stt-download] per-quant delete failed for {model}@{quantization}: {e}");
        }
        self.emit_cache_changed(model);
    }

    /// Whole-model delete — wipe the entire HF snapshot directory for `model`.
    pub fn delete_model_cache(&self, model: &str) {
        let prefix = format!("{model}@");
        // PARKED (paused, worker-less) entries we evict here have no worker to observe `cancelled`
        // and emit their completion — collect them so we settle their badges below. Active entries'
        // workers see `cancelled` per-chunk and emit themselves.
        let mut parked_removed: Vec<String> = Vec::new();
        {
            let mut map = self.inflight.lock().expect("download registry poisoned");
            map.retain(|k, h| {
                if k.starts_with(&prefix) {
                    h.cancelled.store(true, Ordering::Release);
                    if h.parked.load(Ordering::Acquire) {
                        if let Some(q) = k.strip_prefix(&prefix) {
                            parked_removed.push(q.to_string());
                        }
                    }
                    false
                } else {
                    true
                }
            });
        }
        for q in &parked_removed {
            self.emit_complete(model, Some(q), true);
        }
        // Remove the entire repo cache subdir (`<cache>/models--owner--name/`).
        // block_in_place: same sync-command-on-async-runtime reason as delete_quantization.
        if let Err(e) =
            tokio::task::block_in_place(|| tauri::async_runtime::block_on(delete_repo_cache(model)))
        {
            log::warn!("[stt-download] whole-model delete failed for {model}: {e}");
        }
        self.emit_cache_changed(model);
    }

    // ── Cache probe (overlay for list_models_with_state) ──

    /// Async cache probe (audit #7: the picker-open hot path). `await`s the HF cache scan directly
    /// instead of blocking the command thread, memoizes the raw catalog-wide probe for a short TTL
    /// (so the picker's repeated `list_models_with_state` calls reuse one fs walk), then overlays the
    /// in-flight registry. The TTL memo is dropped by `emit_cache_changed` whenever a download lands.
    pub async fn cache_snapshot_async(
        &self,
        models: &[ProbeModel],
    ) -> BTreeMap<String, BTreeMap<String, (CacheState, u64, u64)>> {
        // Fast path: a fresh memo within the TTL → skip the fs scan entirely.
        if let Some(probed) = self.fresh_scan_memo() {
            return self.overlay_inflight(models, &probed);
        }
        // Miss / stale → one real scan, then memoize.
        let probed = cache_probe::probe_cache(models).await;
        if let Ok(mut memo) = self.scan_memo.lock() {
            *memo = Some((Instant::now(), probed.clone()));
        }
        self.overlay_inflight(models, &probed)
    }

    /// Blocking shim retained for any non-async caller (signature-stable). Prefer
    /// `cache_snapshot_async` — this one blocks the calling thread on the probe.
    pub fn cache_snapshot(
        &self,
        models: &[ProbeModel],
    ) -> BTreeMap<String, BTreeMap<String, (CacheState, u64, u64)>> {
        let probed = tauri::async_runtime::block_on(cache_probe::probe_cache(models));
        self.overlay_inflight(models, &probed)
    }

    /// Return the memoized probe if it's still within the TTL, else `None`.
    fn fresh_scan_memo(&self) -> Option<BTreeMap<String, cache_probe::ModelQuantCache>> {
        let memo = self.scan_memo.lock().ok()?;
        match memo.as_ref() {
            Some((taken, probed)) if taken.elapsed() < CACHE_SCAN_TTL => Some(probed.clone()),
            _ => None,
        }
    }

    /// Overlay the in-flight download registry on a raw probe: a downloading quant that isn't already
    /// fully cached reads `partial` so the badge shows "downloading" rather than a stale `not_cached`.
    fn overlay_inflight(
        &self,
        models: &[ProbeModel],
        probed: &BTreeMap<String, cache_probe::ModelQuantCache>,
    ) -> BTreeMap<String, BTreeMap<String, (CacheState, u64, u64)>> {
        let mut out: BTreeMap<String, BTreeMap<String, (CacheState, u64, u64)>> = BTreeMap::new();
        let inflight = self.inflight.lock().expect("download registry poisoned");
        for m in models {
            let mqc = probed.get(&m.id).cloned().unwrap_or_default();
            let mut by_quant: BTreeMap<String, (CacheState, u64, u64)> = BTreeMap::new();
            for q in &m.quantizations {
                let mut entry =
                    mqc.by_quant
                        .get(q)
                        .copied()
                        .unwrap_or((CacheState::NotCached, 0, 0));
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
        // On dequeue, BEFORE spending any network I/O (plan + stream), re-check the cancel flag.
        // The job may have been cancelled while it waited in the pool's queue for a free worker
        // (cancel-while-queued); this re-check replicates the old post-semaphore-permit re-check so
        // a queued-then-cancelled download still finishes-cancelled instead of transferring. The
        // fixed N-worker pool (not a semaphore) is what now bounds concurrency to N, so there's no
        // permit to acquire here — the worker itself IS the slot.
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
        let planned = match tauri::async_runtime::block_on(resolver::plan_quant_download(
            &model, kind, quant,
        )) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("[stt-download] plan failed for {model}@{quantization}: {e}");
                // No plan → nothing to download. Settle as cancelled so the badge clears rather than
                // spinning forever (the renderer drops the in-flight entry on a cancelled-complete).
                self.finish_quant(&model, &quantization, true);
                return;
            }
        };

        // Stream each planned file. The PRIMARY path is our own chunked HTTP downloader
        // (`stream_file_into_hf_cache`) — plain `GET …/resolve/main/<path>` with HTTP-Range resume
        // and a per-CHUNK pause/cancel check, so stop/pause are honored MID-FILE (the whole point of
        // the rewrite). It writes into hf-hub's own cache layout, so the resolver / cache_probe /
        // delete paths are unchanged. hf-hub's `download_file` (which may use xet, and whose progress
        // handler is observe-only — uninterruptible mid-file, with a poller that leaks if its future
        // is dropped) is kept ONLY as a fallback when our path can't proceed (private repo, missing
        // HEAD metadata, write error) so the bytes always land even if we lose mid-file control there.
        // Progress aggregate + start time live on the HANDLE, so a pause→resume (which re-runs this
        // whole function on a fresh worker) carries the prior progress instead of resetting to 0%.
        let agg = Arc::clone(&handle.agg);
        let start = handle.start;
        // Default client follows the resolve→CDN redirect for content; the no-redirect client reads
        // HF's `x-repo-commit` / `x-linked-etag` / `x-linked-size` headers off the 302 itself (they
        // are NOT present on the CDN response we'd otherwise follow to).
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let http_head = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        // Seed the progress denominator with the WHOLE plan's byte total UP FRONT, fetched in one
        // `?blobs=true` API call (the only single request that returns a `size` for BOTH LFS and
        // plain files — a per-file HEAD's `x-linked-size` covers only LFS blobs, plain files carry
        // no size header, and `?expand=siblings` omits sizes entirely). Without this, `ProgressAgg`'s
        // total only ever included files that had ALREADY started, so the bar lurched 100%→0%→… as
        // each planned file began: a tiny non-LFS `config.json` reports downloaded/downloaded=100%
        // the instant it starts (its size is unknown so the denominator can't exceed the bytes seen),
        // then the first big `.onnx` enlarges the denominator and resets the fraction toward 0, and
        // every subsequent file repeats it. With every planned file's size known here, progress runs
        // a single monotonic 0→100%. Best-effort: an empty/partial map (offline, private/gated repo,
        // off-catalog local model) simply degrades to the old per-file growing total.
        let plan_sizes = fetch_repo_file_sizes(&http, &model);
        if !plan_sizes.is_empty() {
            for p in &planned {
                if let Some(&sz) = plan_sizes.get(p) {
                    // completed=0 only seeds the total; `update_file` keeps the running max, so this
                    // never lowers a file's progress when re-run on a pause→resume.
                    agg.update_file(p, 0, sz);
                }
            }
        }

        for repo_path in &planned {
            // One attempt loop per file. A mid-file PAUSE either parks (releases this worker slot;
            // `return`) or, if a resume raced in first, re-loops to resume the same file in place.
            'file: loop {
                if handle.cancelled.load(Ordering::Acquire) {
                    self.finish_quant(&model, &quantization, true);
                    return;
                }

                // Skip files already complete in cache (cheap resume — also how files finished in a
                // prior pre-pause run are re-counted via the handle's preserved aggregate). Count a
                // cached file as fully done against its seeded size so a resume/partial download's
                // bar starts at the correct baseline instead of reading 0/size for already-present
                // files; an unseeded file (size unknown) is just tracked as before.
                if tauri::async_runtime::block_on(resolver::is_file_cached(&model, repo_path)) {
                    match plan_sizes.get(repo_path) {
                        Some(&sz) => agg.update_file(repo_path, sz, sz),
                        None => agg.mark_file_cached(repo_path),
                    }
                    self.emit_agg(&model, &quantization, &agg, start);
                    break 'file;
                }

                match self.stream_file_into_hf_cache(
                    &http,
                    &http_head,
                    &model,
                    &quantization,
                    repo_path,
                    &handle,
                    &agg,
                    start,
                ) {
                    StreamOutcome::Completed => break 'file,
                    StreamOutcome::Cancelled => {
                        // Partial `.incomplete` is left on disk (resumable); the badge clears.
                        self.finish_quant(&model, &quantization, true);
                        return;
                    }
                    StreamOutcome::Paused => {
                        // Release this pool slot rather than parking the thread: mark the job parked
                        // and RETURN so a queued download can run; `resume` re-enqueues this handle
                        // and `run_quant_download` resumes from the `.incomplete` bytes. If a resume
                        // beat us to the lock (paused already cleared), keep downloading in place.
                        if self.try_park(&handle) {
                            return;
                        }
                        continue 'file;
                    }
                    StreamOutcome::Failed => {
                        // FALLBACK to hf-hub for this file (handles xet / private repos / odd
                        // layouts our plain-HTTP path can't). Mid-file cancel is lost here, but the
                        // bytes are guaranteed to land. Keep the FileReporter so the fallback still
                        // reports progress (with the Start-total seed fix).
                        if handle.cancelled.load(Ordering::Acquire) {
                            self.finish_quant(&model, &quantization, true);
                            return;
                        }
                        let reporter: Arc<dyn hf_hub::progress::ProgressHandler> =
                            Arc::new(FileReporter {
                                agg: Arc::clone(&agg),
                                app: self.app.clone(),
                                model: model.clone(),
                                quantization: quantization.clone(),
                                filename: repo_path.clone(),
                                start,
                            });
                        let handler: hf_hub::progress::Progress = reporter.into();
                        match tauri::async_runtime::block_on(resolver::download_planned_file(
                            &model, repo_path, false, handler,
                        )) {
                            Ok(_) => {
                                agg.mark_file_complete(repo_path);
                                self.emit_agg(&model, &quantization, &agg, start);
                                break 'file;
                            }
                            Err(e) => {
                                if handle.cancelled.load(Ordering::Acquire) {
                                    self.finish_quant(&model, &quantization, true);
                                    return;
                                }
                                log::warn!(
                                    "[stt-download] file fetch failed (hf-hub fallback) {model}@{quantization} {repo_path}: {e}"
                                );
                                self.finish_quant(&model, &quantization, false);
                                return;
                            }
                        }
                    }
                }
            }
        }

        // All planned files present → complete (not cancelled). cache-changed lets the picker
        // re-probe and settle the effective-quant badge to "Downloaded".
        self.finish_quant(&model, &quantization, false);
    }

    /// Our own cancellable, resumable, byte-level-progress downloader for ONE planned file.
    ///
    /// `GET {endpoint}/{owner}/{name}/resolve/main/{repo_path}` straight over HTTP (no xet). Bytes
    /// stage under `blobs/<etag>.incomplete` (the SAME staging name hf-hub uses → either side can
    /// resume the other's partial via HTTP Range), then move to the FINAL file at
    /// `snapshots/<commit>/<repo_path>` + a `refs/main` pointer — the layout the resolver /
    /// cache_probe / cache-only resolve read. Pause/cancel are checked on EVERY chunk → instant
    /// mid-file stop, unlike hf-hub's observe-only progress.
    ///
    /// IMPORTANT: we deliberately do NOT leave a separate completed `blobs/<etag>` copy. hf-hub's
    /// cache-only resolve only needs the snapshot file (+ refs), and on Windows the snapshot is a
    /// real file anyway — so a single file at the snapshot path is a complete, resolvable entry.
    /// Keeping ONLY it means a per-quant delete (which removes the snapshot pointer) actually frees
    /// the bytes, instead of stranding an orphan blob that the fast path below would instantly
    /// "re-download" from. (hf-hub's OWN fallback download still leaves a blob; that path is rare.)
    ///
    /// Returns `Failed` (NOT an error) for anything our plain path can't handle — missing HEAD
    /// metadata, a private repo, a write/IO error — so the caller falls back to hf-hub and the bytes
    /// still land.
    #[allow(clippy::too_many_arguments)]
    fn stream_file_into_hf_cache(
        &self,
        http: &reqwest::Client,
        http_head: &reqwest::Client,
        model: &str,
        quantization: &str,
        repo_path: &str,
        handle: &DownloadHandle,
        agg: &ProgressAgg,
        start: Instant,
    ) -> StreamOutcome {
        use tauri::async_runtime::block_on;

        let Some((owner, name)) = resolver::resolve_repo(model) else {
            return StreamOutcome::Failed;
        };
        let url = format!("https://huggingface.co/{owner}/{name}/resolve/main/{repo_path}");

        // HEAD (no-redirect) for the cache-layout identity: commit + etag + size live on HF's 302,
        // not on the CDN response. Any status is fine as long as those headers are present.
        let head = match block_on(http_head.head(&url).send()) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[stt-download] HEAD failed {model}@{quantization} {repo_path}: {e}");
                return StreamOutcome::Failed;
            }
        };
        let headers = head.headers();
        let (Some(etag), Some(commit)) = (header_etag(headers), header_commit(headers)) else {
            log::warn!(
                "[stt-download] missing commit/etag headers for {model}@{quantization} {repo_path} — falling back to hf-hub"
            );
            return StreamOutcome::Failed;
        };
        let size = header_size(headers).unwrap_or(0);

        let cache_dir = match hf_hub::HFClient::new() {
            Ok(c) => c.cache_dir().to_path_buf(),
            Err(_) => return StreamOutcome::Failed,
        };
        let repo_folder = format!("models--{owner}--{name}");
        let base = cache_dir.join(&repo_folder);
        let snapshot = base.join("snapshots").join(&commit).join(repo_path);
        let ref_file = base.join("refs").join("main");
        // Staging file for the in-flight transfer (NOT a kept blob — it's renamed to `snapshot` on
        // completion). `blobs/<etag>.incomplete` matches hf-hub's staging path for cross-resume.
        let staging = base.join("blobs").join(format!("{etag}.incomplete"));

        // Final file already present (a prior run finished it, or it survived): ensure refs/main and
        // settle. After a delete the snapshot is gone, so this won't fire → a real re-download runs.
        if snapshot.is_file() {
            if let Err(e) = ensure_cache_ref(&ref_file, &commit) {
                log::warn!("[stt-download] ref write failed {model}@{quantization}: {e}");
                return StreamOutcome::Failed;
            }
            if !block_on(resolver::is_file_cached(model, repo_path)) {
                return StreamOutcome::Failed;
            }
            agg.update_file(repo_path, size, size);
            agg.mark_file_complete(repo_path);
            self.emit_agg(model, quantization, agg, start);
            if let Ok(mut partial_path) = handle.partial_path.lock() {
                *partial_path = None;
            }
            return StreamOutcome::Completed;
        }

        for dir in [staging.parent(), snapshot.parent()].into_iter().flatten() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                log::warn!("[stt-download] cache dir create failed {model}@{quantization}: {e}");
                return StreamOutcome::Failed;
            }
        }
        if let Ok(mut partial_path) = handle.partial_path.lock() {
            *partial_path = Some(staging.clone());
        }
        let report = match transfer_url_blocking(
            http,
            TransferRequest {
                delete_partial_on_cancel: true,
                final_path: Some(&snapshot),
                known_total_bytes: (size > 0).then_some(size),
                partial_path: &staging,
                progress_interval: Duration::from_millis(80),
                url: &url,
            },
            Some(handle),
            |progress| {
                let total = progress
                    .total_bytes
                    .unwrap_or(progress.downloaded_bytes)
                    .max(progress.downloaded_bytes);
                agg.update_file(repo_path, progress.downloaded_bytes, total);
                self.emit_agg(model, quantization, agg, start);
            },
        ) {
            Ok(report) => report,
            Err(e) => {
                log::warn!("[stt-download] stream failed {model}@{quantization} {repo_path}: {e}");
                return StreamOutcome::Failed;
            }
        };
        if report.outcome != TransferOutcome::Paused {
            if let Ok(mut partial_path) = handle.partial_path.lock() {
                *partial_path = None;
            }
        }
        match report.outcome {
            TransferOutcome::Cancelled => return StreamOutcome::Cancelled,
            TransferOutcome::Paused => return StreamOutcome::Paused,
            TransferOutcome::Complete => {}
        }

        let final_total = report
            .total_bytes
            .unwrap_or(report.downloaded_bytes)
            .max(report.downloaded_bytes);
        agg.update_file(repo_path, report.downloaded_bytes, final_total);
        self.emit_agg(model, quantization, agg, start);

        // The shared transfer moved the staged bytes to the FINAL snapshot path (no kept blob copy).
        // Finish the HF cache pointer and verify cache-only resolution can see it.
        if let Err(e) = ensure_cache_ref(&ref_file, &commit) {
            log::warn!("[stt-download] ref write failed {model}@{quantization}: {e}");
            return StreamOutcome::Failed;
        }
        // Self-check: hf-hub's OWN cache-only resolve must now find what we placed (correct commit
        // ref + snapshot file, and — for `.onnx` — complete external-data shards). If not, fall back
        // to a real hf-hub fetch rather than claim a success the model loader can't load.
        if !block_on(resolver::is_file_cached(model, repo_path)) {
            log::warn!(
                "[stt-download] streamed file failed cache self-check {model}@{quantization} {repo_path} — falling back to hf-hub"
            );
            return StreamOutcome::Failed;
        }
        agg.update_file(repo_path, report.downloaded_bytes, final_total);
        agg.mark_file_complete(repo_path);
        self.emit_agg(model, quantization, agg, start);
        StreamOutcome::Completed
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
        assert!(file_belongs_to_quant(
            "onnx/encoder_model_fp16.onnx",
            Quantization::Fp16
        ));
        assert!(!file_belongs_to_quant(
            "onnx/encoder_model_fp16.onnx",
            Quantization::Default
        ));
        assert!(file_belongs_to_quant(
            "onnx/encoder_model.onnx",
            Quantization::Default
        ));
        assert!(file_belongs_to_quant("model.int8.onnx", Quantization::Int8));
        // Sidecars attribute by the graph stem's quant tag.
        assert!(file_belongs_to_quant(
            "onnx/decoder_model_merged_fp16.onnx_data",
            Quantization::Fp16
        ));
        assert!(file_belongs_to_quant(
            "onnx/decoder_model_merged_fp16.onnx_data_1",
            Quantization::Fp16
        ));
        assert!(!file_belongs_to_quant(
            "onnx/decoder_model_merged_fp16.onnx_data",
            Quantization::Default
        ));
        assert!(file_belongs_to_quant(
            "onnx/encoder.weights",
            Quantization::Default
        ));
        assert!(file_belongs_to_quant(
            "onnx/encoder.int8.weights",
            Quantization::Int8
        ));
        assert!(!file_belongs_to_quant(
            "onnx/encoder.int8.weights",
            Quantization::Default
        ));
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

    #[test]
    fn header_etag_matches_hf_hub_normalization() {
        use reqwest::header::HeaderMap;
        // Strong etag → quotes stripped.
        let mut h = HeaderMap::new();
        h.insert(reqwest::header::ETAG, "\"abc123\"".parse().unwrap());
        assert_eq!(header_etag(&h), Some("abc123".to_string()));
        // Weak etag → `W/` prefix AND quotes stripped (LFS sha256 blob name).
        let mut h = HeaderMap::new();
        h.insert(reqwest::header::ETAG, "W/\"deadbeef\"".parse().unwrap());
        assert_eq!(header_etag(&h), Some("deadbeef".to_string()));
        // x-linked-etag wins over a plain etag (it's the CONTENT etag for LFS/xet files).
        let mut h = HeaderMap::new();
        h.insert("x-linked-etag", "\"sha256hash\"".parse().unwrap());
        h.insert(reqwest::header::ETAG, "\"gitblob\"".parse().unwrap());
        assert_eq!(header_etag(&h), Some("sha256hash".to_string()));
        // Missing → None (caller falls back to hf-hub).
        assert_eq!(header_etag(&HeaderMap::new()), None);
    }

    #[test]
    fn header_size_prefers_linked_size() {
        use reqwest::header::HeaderMap;
        let mut h = HeaderMap::new();
        h.insert("x-linked-size", "4096".parse().unwrap());
        h.insert(reqwest::header::CONTENT_LENGTH, "12".parse().unwrap());
        assert_eq!(header_size(&h), Some(4096));
        let mut h = HeaderMap::new();
        h.insert(reqwest::header::CONTENT_LENGTH, "777".parse().unwrap());
        assert_eq!(header_size(&h), Some(777));
    }

    #[test]
    fn parses_blobs_sibling_sizes() {
        // A `?blobs=true` body: each sibling carries `rfilename` + `size`. Paths are normalized to
        // forward slashes so they match the download plan's keys; a sibling with no `size` (the
        // shape a non-`blobs` request returns) is skipped so the seed only covers known totals.
        let body = serde_json::json!({
            "siblings": [
                { "rfilename": "config.json", "size": 1234 },
                { "rfilename": "onnx/encoder_model_fp16.onnx", "size": 59370049u64 },
                { "rfilename": "onnx\\decoder_model_fp16.onnx", "size": 31u64 },
                { "rfilename": "README.md" },
            ]
        });
        let sizes = parse_sibling_sizes(&body);
        assert_eq!(sizes.get("config.json"), Some(&1234));
        assert_eq!(sizes.get("onnx/encoder_model_fp16.onnx"), Some(&59370049));
        // Backslash path normalized to the plan's forward-slash key.
        assert_eq!(sizes.get("onnx/decoder_model_fp16.onnx"), Some(&31));
        // No `size` → not seeded (the caller falls back to the growing total for that file).
        assert_eq!(sizes.get("README.md"), None);
        assert_eq!(sizes.len(), 3);
    }

    #[test]
    fn parse_sibling_sizes_empty_on_missing_or_malformed() {
        assert!(parse_sibling_sizes(&serde_json::json!({})).is_empty());
        assert!(parse_sibling_sizes(&serde_json::json!({ "siblings": "nope" })).is_empty());
        assert!(parse_sibling_sizes(&serde_json::json!(null)).is_empty());
    }

    #[test]
    fn ensure_cache_ref_writes_and_is_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ref_file = dir
            .path()
            .join("models--onnx-community--whisper-tiny")
            .join("refs")
            .join("main");

        // Creates parent dirs + writes the commit so a `main`-keyed resolve maps to the snapshot.
        ensure_cache_ref(&ref_file, "commitX").expect("write ref");
        assert_eq!(std::fs::read_to_string(&ref_file).unwrap(), "commitX");
        // Idempotent for the same commit (sibling-quant download of the same revision).
        ensure_cache_ref(&ref_file, "commitX").expect("idempotent");
        assert_eq!(std::fs::read_to_string(&ref_file).unwrap(), "commitX");
        // A new revision overwrites the ref.
        ensure_cache_ref(&ref_file, "commitY").expect("update ref");
        assert_eq!(std::fs::read_to_string(&ref_file).unwrap(), "commitY");
    }
}
