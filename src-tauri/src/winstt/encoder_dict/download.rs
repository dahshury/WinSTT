//! Managed download for the encoder dictionary model — user-opted, with start / pause / resume /
//! cancel, live progress, background continuation, and cross-window status. Built on the generic
//! [`crate::winstt::downloads::transfer_url`] streamer (HTTP Range resume + per-chunk pause/cancel).
//!
//! Two files from `onnx-community/mmBERT-base-ONNX` land in `<app-data>/encoder-dict/`:
//! `tokenizer.json` (small, first) then `model_int8.onnx` (~310 MB). Progress + lifecycle are
//! broadcast to all windows via `encoder-dict:download-*` events; a window that (re)opens the tab
//! seeds itself with [`status`].

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::winstt::downloads::{transfer_url, PauseCancelFlags, TransferOutcome, TransferRequest};

use super::{model_dir, MODEL_FILENAME, TOKENIZER_FILENAME};

const REPO: &str = "onnx-community/mmBERT-base-ONNX";
/// (repo path, local filename) — small file first so the big model dominates the visible bar.
const FILES: &[(&str, &str)] = &[
    ("tokenizer.json", TOKENIZER_FILENAME),
    ("onnx/model_int8.onnx", MODEL_FILENAME),
];
/// Sidecar holding the known total byte count. The in-memory total is lost on app restart, so we
/// persist it once known — that way a partial download shows its real % when the tab is reopened in a
/// later session instead of an indeterminate bar. Best-effort; absence just means "% not yet known".
const TOTAL_FILENAME: &str = ".total";

pub const EVT_PROGRESS: &str = "encoder-dict:download-progress";
pub const EVT_COMPLETE: &str = "encoder-dict:download-complete";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    Downloading,
    Paused,
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
    pub speed_bps: u64,
}

#[derive(Default)]
struct Inner {
    downloaded: u64,
    total: u64,
}

/// Singleton manager, registered as Tauri state.
pub struct EncoderModelDownloader {
    app: AppHandle,
    control: Arc<PauseCancelFlags>,
    phase: Mutex<Phase>,
    progress: Mutex<Inner>,
    /// When the (most recent) download began — drives the speed/ETA readout. Preserved across
    /// pause→resume (mirrors the STT DownloadManager's handle-level start), cleared on settle.
    started_at: Mutex<Option<Instant>>,
}

impl EncoderModelDownloader {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            control: Arc::new(PauseCancelFlags::default()),
            phase: Mutex::new(Phase::Idle),
            progress: Mutex::new(Inner::default()),
            started_at: Mutex::new(None),
        }
    }

    /// Speed (bytes/s) and ETA (s) from the elapsed time since the download began — same formula as
    /// the STT download `FileReporter`.
    fn speed_eta(&self, downloaded: u64, total: u64) -> (u64, u64) {
        let elapsed = self
            .started_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0)
            .max(0.001);
        let speed = (downloaded as f64 / elapsed) as u64;
        let eta = if speed > 0 && total > downloaded {
            (total - downloaded) / speed
        } else {
            0
        };
        (speed, eta)
    }

    fn set_phase(&self, p: Phase) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = p;
    }
    fn phase(&self) -> Phase {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Bytes physically present for the model: fully-downloaded files at their final name plus any
    /// in-progress `.part`. Survives restarts (unlike the in-memory `progress`), so a partial
    /// download is remembered and resumable instead of looking absent.
    fn bytes_on_disk(&self) -> u64 {
        let Some(dir) = model_dir(&self.app) else {
            return 0;
        };
        let mut total = 0u64;
        for (_, fname) in FILES {
            if let Ok(m) = std::fs::metadata(dir.join(fname)) {
                total += m.len();
            } else if let Ok(m) = std::fs::metadata(dir.join(format!("{fname}.part"))) {
                total += m.len();
            }
        }
        total
    }

    /// Read the persisted total (sidecar) so a partial download shows its real % after a restart.
    fn persisted_total(&self) -> u64 {
        model_dir(&self.app)
            .and_then(|dir| std::fs::read_to_string(dir.join(TOTAL_FILENAME)).ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0)
    }

    fn write_total(&self, total: u64) {
        if total == 0 {
            return;
        }
        if let Some(dir) = model_dir(&self.app) {
            let _ = std::fs::write(dir.join(TOTAL_FILENAME), total.to_string());
        }
    }

    fn remove_total(&self) {
        if let Some(dir) = model_dir(&self.app) {
            let _ = std::fs::remove_file(dir.join(TOTAL_FILENAME));
        }
    }

    /// Snapshot for `encoder_dict_status` (seeds a freshly-opened tab). DISK is authoritative for how
    /// far the download got: the in-memory counter is empty on a fresh launch, so a `.part` left from
    /// a previous session is reported as a resumable "paused" download — never as "absent" (which
    /// would wrongly prompt a fresh re-download).
    pub fn status(&self) -> EncoderDownloadStatus {
        if super::is_model_present(&self.app) {
            return EncoderDownloadStatus {
                state: "present".into(),
                progress: 1.0,
                downloaded_bytes: 0,
                total_bytes: 0,
                speed_bps: 0,
            };
        }
        let (mem_downloaded, mem_total) = {
            let prog = self.progress.lock().unwrap_or_else(|e| e.into_inner());
            (prog.downloaded, prog.total)
        };
        let downloaded = mem_downloaded.max(self.bytes_on_disk());
        let total = if mem_total > 0 {
            mem_total
        } else {
            self.persisted_total()
        };
        let phase = self.phase();
        let state = match phase {
            Phase::Downloading => "downloading",
            Phase::Paused => "paused",
            // Idle, but bytes already on disk → a partial from an earlier session: resumable.
            Phase::Idle if downloaded > 0 => "paused",
            Phase::Idle => "absent",
        };
        let progress = if total > 0 {
            (downloaded as f64 / total as f64).clamp(0.0, 1.0)
        } else {
            0.0
        };
        // Only report a live speed while actively downloading (paused/idle = 0).
        let speed_bps = if matches!(phase, Phase::Downloading) {
            self.speed_eta(downloaded, total).0
        } else {
            0
        };
        EncoderDownloadStatus {
            state: state.into(),
            progress,
            downloaded_bytes: downloaded,
            total_bytes: total,
            speed_bps,
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
        // Freeze the speed readout at 0 while paused (no transfer happening).
        let (speed_bps, eta_seconds) = if paused {
            (0, 0)
        } else {
            self.speed_eta(downloaded, total)
        };
        let _ = self.app.emit(
            EVT_PROGRESS,
            json!({
                "state": if paused { "paused" } else { "downloading" },
                "downloadedBytes": downloaded,
                "totalBytes": total,
                "progress": progress,
                "speedBps": speed_bps,
                "etaSeconds": eta_seconds,
            }),
        );
    }

    fn emit_complete(&self, present: bool, cancelled: bool) {
        let _ = self.app.emit(
            EVT_COMPLETE,
            json!({ "present": present, "cancelled": cancelled }),
        );
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
        self.control.reset();
        self.set_phase(Phase::Downloading);
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            this.run().await;
        });
    }

    pub fn pause(&self) {
        if matches!(self.phase(), Phase::Downloading) {
            self.control.pause();
        }
    }

    pub fn cancel(&self) {
        self.control.cancel();
        // If parked (paused, no worker running), settle synchronously.
        if matches!(self.phase(), Phase::Paused) {
            self.cleanup_partials();
            self.set_phase(Phase::Idle);
            self.clear_progress();
            self.emit_complete(false, true);
        }
    }

    /// Delete the downloaded model + any partials and drop the loaded engine — used when the user
    /// turns the on-device dictionary off. Cancels any in-flight transfer first.
    pub fn remove(&self) {
        self.control.cancel();
        if let Some(dir) = model_dir(&self.app) {
            for (_, fname) in FILES {
                let _ = std::fs::remove_file(dir.join(fname));
                let _ = std::fs::remove_file(dir.join(format!("{fname}.part")));
            }
        }
        self.remove_total();
        super::clear_loaded();
        self.set_phase(Phase::Idle);
        self.clear_progress();
        self.emit_complete(false, false);
    }

    fn cleanup_partials(&self) {
        if let Some(dir) = model_dir(&self.app) {
            for (_, fname) in FILES {
                let _ = std::fs::remove_file(dir.join(format!("{fname}.part")));
            }
        }
        self.remove_total();
    }

    /// Reset the progress aggregate + the start clock (called on a terminal outcome — NOT on pause,
    /// which must preserve both so a resume keeps its byte count and speed baseline).
    fn clear_progress(&self) {
        *self.progress.lock().unwrap_or_else(|e| e.into_inner()) = Inner::default();
        *self.started_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
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
            .expect("reqwest TLS init");

        // Start the speed/ETA clock once (preserved across pause→resume).
        {
            let mut s = self.started_at.lock().unwrap_or_else(|e| e.into_inner());
            if s.is_none() {
                *s = Some(Instant::now());
            }
        }

        // Seed the REAL total up front: the `?blobs=true` model-info API returns a size for BOTH LFS
        // and plain files, so the bar shows ~344 MB from the first frame instead of lurching from the
        // small tokenizer's size. Reuses the STT download manager's sibling-size parser. Best-effort:
        // 0 (offline/parse miss) falls back to the per-file growing total.
        let known_total: u64 = {
            let url = format!("https://huggingface.co/api/models/{REPO}?blobs=true");
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<serde_json::Value>().await {
                        Ok(body) => {
                            let sizes =
                                crate::winstt::managers::download_manager::http_meta::parse_sibling_sizes(
                                    &body,
                                );
                            FILES
                                .iter()
                                .filter_map(|(rp, _)| sizes.get(*rp).copied())
                                .sum()
                        }
                        Err(_) => 0,
                    }
                }
                _ => 0,
            }
        };
        // Persist the total so a partial shows its real % if the tab is reopened next session.
        self.write_total(known_total);

        // Bytes from files already fully on disk (so resume/skip aggregates correctly).
        let mut completed: u64 = 0;
        for (_, fname) in FILES {
            let f = dir.join(fname);
            if f.is_file() {
                completed += std::fs::metadata(&f).map_or(0, |m| m.len());
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
                    let downloaded = base + p.downloaded_bytes;
                    let total = if known_total > 0 {
                        known_total
                    } else {
                        base + p.total_bytes.unwrap_or(p.downloaded_bytes)
                    };
                    this.emit_progress(downloaded, total, false);
                },
            )
            .await;

            match report {
                Ok(r) if r.outcome == TransferOutcome::Complete => {
                    completed += r.downloaded_bytes;
                }
                Ok(r) if r.outcome == TransferOutcome::Paused => {
                    self.set_phase(Phase::Paused);
                    let total = if known_total > 0 {
                        known_total
                    } else {
                        self.progress.lock().map_or(0, |p| p.total)
                    };
                    // Include the in-progress file's partial bytes — emitting only `completed` (the
                    // fully-finished files) collapsed the bar to ~0% on every pause.
                    self.emit_progress(completed + r.downloaded_bytes, total, true);
                    return;
                }
                Ok(_) => {
                    // Cancelled.
                    self.cleanup_partials();
                    self.set_phase(Phase::Idle);
                    self.clear_progress();
                    self.emit_complete(false, true);
                    return;
                }
                Err(e) => {
                    log::warn!("[encoder-dict] download {repo_path} failed: {e}");
                    self.set_phase(Phase::Idle);
                    *self.started_at.lock().unwrap_or_else(|e| e.into_inner()) = None;
                    self.emit_complete(false, false);
                    return;
                }
            }
        }

        self.set_phase(Phase::Idle);
        self.clear_progress();
        self.remove_total();
        self.emit_complete(true, false);
        // Warm the just-downloaded model in the background if the feature is on, so the first
        // dictation right after the download lands fast instead of cold-loading mid-utterance.
        let settings = crate::winstt::settings_store::read_settings(&self.app);
        if settings.general.encoder_dictionary_enabled {
            super::preload_async(&self.app);
        }
    }
}
