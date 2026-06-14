//! Managed download for the encoder dictionary model — user-opted, with start / pause / resume /
//! cancel, live progress, background continuation, and cross-window status. Built on the generic
//! [`crate::winstt::downloads::transfer_url`] streamer (HTTP Range resume + per-chunk pause/cancel).
//!
//! Two files from `onnx-community/mmBERT-base-ONNX` land in `<app-data>/encoder-dict/`:
//! `tokenizer.json` (small, first) then `model_int8.onnx` (~310 MB). Progress + lifecycle are
//! broadcast to all windows via `encoder-dict:download-*` events; a window that (re)opens the tab
//! seeds itself with [`status`].

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::winstt::downloads::{transfer_url, TransferControl, TransferOutcome, TransferRequest};

use super::{model_dir, MODEL_FILENAME, TOKENIZER_FILENAME};

const REPO: &str = "onnx-community/mmBERT-base-ONNX";
/// (repo path, local filename) — small file first so the big model dominates the visible bar.
const FILES: &[(&str, &str)] = &[
    ("tokenizer.json", TOKENIZER_FILENAME),
    ("onnx/model_int8.onnx", MODEL_FILENAME),
];

pub const EVT_PROGRESS: &str = "encoder-dict:download-progress";
pub const EVT_COMPLETE: &str = "encoder-dict:download-complete";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Downloading,
    Paused,
}

/// Pause/cancel signals for the active transfer.
struct Control {
    paused: AtomicBool,
    cancelled: AtomicBool,
}

impl TransferControl for Control {
    fn should_cancel(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    fn should_pause(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }
}

/// Current download status for the UI (mirrors the `encoder-dict:download-progress` payload).
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EncoderDownloadStatus {
    /// "absent" | "downloading" | "paused" | "present"
    pub state: String,
    pub progress: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Default)]
struct Inner {
    downloaded: u64,
    total: u64,
}

/// Singleton manager, registered as Tauri state.
pub struct EncoderModelDownloader {
    app: AppHandle,
    control: Arc<Control>,
    phase: Mutex<Phase>,
    progress: Mutex<Inner>,
}

impl EncoderModelDownloader {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            control: Arc::new(Control {
                paused: AtomicBool::new(false),
                cancelled: AtomicBool::new(false),
            }),
            phase: Mutex::new(Phase::Idle),
            progress: Mutex::new(Inner::default()),
        }
    }

    fn set_phase(&self, p: Phase) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = p;
    }
    fn phase(&self) -> Phase {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Snapshot for `encoder_dict_status` (seeds a freshly-opened tab).
    pub fn status(&self) -> EncoderDownloadStatus {
        if super::is_model_present(&self.app) {
            return EncoderDownloadStatus {
                state: "present".into(),
                progress: 1.0,
                downloaded_bytes: 0,
                total_bytes: 0,
            };
        }
        let prog = self.progress.lock().unwrap_or_else(|e| e.into_inner());
        let state = match self.phase() {
            Phase::Downloading => "downloading",
            Phase::Paused => "paused",
            Phase::Idle => "absent",
        };
        let progress = if prog.total > 0 {
            prog.downloaded as f64 / prog.total as f64
        } else {
            0.0
        };
        EncoderDownloadStatus {
            state: state.into(),
            progress,
            downloaded_bytes: prog.downloaded,
            total_bytes: prog.total,
        }
    }

    fn emit_progress(&self, downloaded: u64, total: u64, paused: bool) {
        {
            let mut p = self.progress.lock().unwrap_or_else(|e| e.into_inner());
            p.downloaded = downloaded;
            p.total = total;
        }
        let progress = if total > 0 {
            downloaded as f64 / total as f64
        } else {
            0.0
        };
        let _ = self.app.emit(
            EVT_PROGRESS,
            json!({
                "state": if paused { "paused" } else { "downloading" },
                "downloadedBytes": downloaded,
                "totalBytes": total,
                "progress": progress,
            }),
        );
    }

    fn emit_complete(&self, present: bool, cancelled: bool) {
        let _ = self
            .app
            .emit(EVT_COMPLETE, json!({ "present": present, "cancelled": cancelled }));
    }

    /// Start (or resume) the download. Idempotent: a no-op if already present or in flight.
    pub fn start(self: &Arc<Self>) {
        if super::is_model_present(&self.app) {
            self.emit_complete(true, false);
            return;
        }
        if matches!(self.phase(), Phase::Downloading) {
            return;
        }
        self.control.paused.store(false, Ordering::Release);
        self.control.cancelled.store(false, Ordering::Release);
        self.set_phase(Phase::Downloading);
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            this.run().await;
        });
    }

    pub fn pause(&self) {
        if matches!(self.phase(), Phase::Downloading) {
            self.control.paused.store(true, Ordering::Release);
        }
    }

    pub fn cancel(&self) {
        self.control.cancelled.store(true, Ordering::Release);
        // If parked (paused, no worker running), settle synchronously.
        if matches!(self.phase(), Phase::Paused) {
            self.cleanup_partials();
            self.set_phase(Phase::Idle);
            *self.progress.lock().unwrap_or_else(|e| e.into_inner()) = Inner::default();
            self.emit_complete(false, true);
        }
    }

    fn cleanup_partials(&self) {
        if let Some(dir) = model_dir(&self.app) {
            for (_, fname) in FILES {
                let _ = std::fs::remove_file(dir.join(format!("{fname}.part")));
            }
        }
    }

    async fn run(self: Arc<Self>) {
        let Some(dir) = model_dir(&self.app) else {
            self.set_phase(Phase::Idle);
            self.emit_complete(false, false);
            return;
        };
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::warn!("[encoder-dict] create dir failed: {e}");
            self.set_phase(Phase::Idle);
            self.emit_complete(false, false);
            return;
        }
        let client = reqwest::Client::builder()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        // Bytes from files already fully on disk (so resume/skip aggregates correctly).
        let mut completed: u64 = 0;
        for (_, fname) in FILES {
            let f = dir.join(fname);
            if f.is_file() {
                completed += std::fs::metadata(&f).map(|m| m.len()).unwrap_or(0);
            }
        }

        for (repo_path, fname) in FILES {
            let final_path = dir.join(fname);
            if final_path.is_file() {
                continue; // already have it
            }
            let partial = dir.join(format!("{fname}.part"));
            let url = format!("https://huggingface.co/{REPO}/resolve/main/{repo_path}");
            let base = completed;
            let this = Arc::clone(&self);
            let report = transfer_url(
                &client,
                TransferRequest {
                    url: &url,
                    partial_path: &partial,
                    final_path: Some(&final_path),
                    known_total_bytes: None,
                    progress_interval: Duration::from_millis(100),
                    delete_partial_on_cancel: true,
                },
                Some(&*self.control),
                |p| {
                    let total = base + p.total_bytes.unwrap_or(p.downloaded_bytes);
                    this.emit_progress(base + p.downloaded_bytes, total, false);
                },
            )
            .await;

            match report {
                Ok(r) if r.outcome == TransferOutcome::Complete => {
                    completed += r.downloaded_bytes;
                }
                Ok(r) if r.outcome == TransferOutcome::Paused => {
                    self.set_phase(Phase::Paused);
                    let total = self.progress.lock().map(|p| p.total).unwrap_or(0);
                    self.emit_progress(completed, total, true);
                    return;
                }
                Ok(_) => {
                    // Cancelled.
                    self.cleanup_partials();
                    self.set_phase(Phase::Idle);
                    *self.progress.lock().unwrap_or_else(|e| e.into_inner()) = Inner::default();
                    self.emit_complete(false, true);
                    return;
                }
                Err(e) => {
                    log::warn!("[encoder-dict] download {repo_path} failed: {e}");
                    self.set_phase(Phase::Idle);
                    self.emit_complete(false, false);
                    return;
                }
            }
        }

        self.set_phase(Phase::Idle);
        self.emit_complete(true, false);
    }
}
