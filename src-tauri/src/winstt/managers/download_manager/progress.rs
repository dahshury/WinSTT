// Progress accounting for per-quant downloads: the per-file aggregate that folds individual file
// byte deltas into a model-level total, plus the hf-hub `ProgressHandler` fallback reporter. Neither
// touches `DownloadManager`'s private state — they operate over plain args / `Arc`-shared fields.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::winstt::sync_ext::MutexExt;

// ── Aggregate progress across the planned files of one quant download ──────────────────────────

/// Folds per-file `(bytes_completed, total_bytes)` deltas into a model-level running total. Each
/// file is tracked by name so a progress delta updates the right slot. The denominator is normally
/// SEEDED with every planned file's size up front (see `fetch_repo_file_sizes` in
/// `run_quant_download`) so the bar is one monotonic 0→100%; `update_file` keeps the running max
/// total, so the only time the denominator grows mid-download is the best-effort fallback when that
/// seed couldn't be fetched (then a file's total appears as its first HEAD/progress event lands).
pub(super) struct ProgressAgg {
    /// `filename → (completed, total)`.
    files: Mutex<BTreeMap<String, (u64, u64)>>,
}

impl ProgressAgg {
    pub(super) fn new() -> Self {
        Self {
            files: Mutex::new(BTreeMap::new()),
        }
    }

    /// Update one file's live byte counts from an hf-hub progress event.
    pub(super) fn update_file(&self, name: &str, completed: u64, total: u64) {
        let mut m = self.files.lock_recover();
        let slot = m.entry(name.to_string()).or_insert((0, 0));
        slot.0 = completed.max(slot.0);
        if total > slot.1 {
            slot.1 = total;
        }
    }

    /// Mark a planned file already-cached (counts toward both completed + total once its size is
    /// learned via the cache-hit fast-path; for our purposes we treat cached files as size 0 here
    /// and let live downloads dominate the bar — the final `complete` event is authoritative).
    pub(super) fn mark_file_cached(&self, name: &str) {
        let mut m = self.files.lock_recover();
        m.entry(name.to_string()).or_insert((0, 0));
    }

    /// Mark a file complete: clamp completed == total.
    pub(super) fn mark_file_complete(&self, name: &str) {
        let mut m = self.files.lock_recover();
        if let Some(slot) = m.get_mut(name) {
            if slot.1 > 0 {
                slot.0 = slot.1;
            }
        }
    }

    /// Aggregate `(downloaded, total)` across all tracked files.
    pub(super) fn totals(&self) -> (u64, u64) {
        let m = self.files.lock_recover();
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
pub(super) struct FileReporter {
    pub(super) agg: Arc<ProgressAgg>,
    pub(super) app: AppHandle,
    pub(super) model: String,
    pub(super) quantization: String,
    /// Repo path of the file this reporter tracks — the single aggregate key all of
    /// this fetch's events fold under (so the HEAD-reported total seeded on `Start`
    /// survives xet events that report `total_bytes=0`).
    pub(super) filename: String,
    pub(super) start: Instant,
}

impl FileReporter {
    /// Emit the aggregate model-level progress (downloaded/total across every planned file).
    fn emit(&self) {
        let (downloaded, total) = self.agg.totals();
        let progress = if total > 0 {
            (downloaded as f64 / total as f64).min(1.0)
        } else {
            0.0
        };
        let elapsed = self.start.elapsed().as_secs_f64().max(0.001);
        let speed = (downloaded as f64 / elapsed) as u64;
        let eta = if speed > 0 && total > downloaded {
            (total - downloaded) / speed
        } else {
            0
        };
        // Diagnostic: log only the cases that matter (a 0 denominator — the xet
        // "stuck at 0%" symptom this seeds Start.total_bytes to prevent — or a
        // finished file), so a live download doesn't spam ~10 lines/sec.
        if total == 0 || downloaded >= total {
            log::debug!(
                "[stt-download] progress {}@{} {downloaded}/{total} ({:.0}%)",
                self.model,
                self.quantization,
                progress * 100.0,
            );
        }
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
                DownloadEvent::Start { total_bytes, .. } => {
                    // The AUTHORITATIVE size, from the HEAD round-trip. xet transfers
                    // routinely report `total_bytes=0` in their per-file/aggregate
                    // progress events (the size is known up-front, not from the chunked
                    // reconstruction stream), which left the model-level bar dividing by
                    // 0 → stuck at 0% for the entire download. Seed the denominator here,
                    // keyed by this file's repo path; `update_file` keeps the max total,
                    // so later 0-total events can't lower it. A multi-file plan sums each
                    // file's own Start total.
                    self.agg.update_file(&self.filename, 0, *total_bytes);
                    // Do not emit denominator-only progress. On a resumed partial download, the
                    // first visible frame must be the existing byte offset, not a transient 0%.
                }
                DownloadEvent::Progress { files } => {
                    for f in files {
                        self.agg
                            .update_file(&f.filename, f.bytes_completed, f.total_bytes);
                    }
                    self.emit();
                }
                DownloadEvent::AggregateProgress {
                    bytes_completed,
                    total_bytes,
                    ..
                } => {
                    // Fold the xet batch under THIS file's key (not a synthetic
                    // "__xet_batch__"): xet's per-file Progress events use the same
                    // repo-path filename, so a shared key lets `update_file`'s max()
                    // merge the two streams instead of double-counting them, and it
                    // preserves the Start-seeded total as the denominator floor.
                    self.agg
                        .update_file(&self.filename, *bytes_completed, *total_bytes);
                    self.emit();
                }
                DownloadEvent::Complete => {}
            }
        }
    }
}
