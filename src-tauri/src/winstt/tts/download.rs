use super::kokoro::{self, KokoroConfig};
use super::voices::KOKORO_VOICE_CATALOG;
use crate::winstt::downloads::{
    transfer_url_blocking, TransferControl, TransferOutcome, TransferRequest,
};

// ---------------------------------------------------------------------------
// Asset download (resumable; mirrors asset_downloader.py + the STT slice).
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum DownloadError {
    Cancelled,
    Paused,
    Network(String),
}

/// Cooperative download controls (the host implements these against its
/// pause/cancel UI + a Tauri progress event). Mirrors the Python
/// `(on_progress, should_pause, should_cancel)` triple.
pub trait DownloadControl: Send + Sync {
    fn on_progress(&self, fraction: f64, downloaded: u64, total: u64);
    fn should_pause(&self) -> bool {
        false
    }
    fn should_cancel(&self) -> bool {
        false
    }
}

/// Download the two Kokoro model files into `cfg.cache_dir`, resumable via HTTP
/// Range (`.partial` → atomic rename). Returns once both are present.
///
/// Blocking wrapper around the async reqwest client via
/// `tauri::async_runtime::block_on` — the existing reqwest dep enables only
/// `json`/`stream`/`multipart` (no `blocking` feature), and the command layer
/// already runs every TTS call on a `spawn_blocking` worker, so blocking on the
/// shared runtime here is safe (we are never on the async pump). Matches the
/// Python `download_with_progress` semantics (`.partial` + Range resume + the
/// pause/cancel cooperative checks).
pub fn download_kokoro_assets(
    cfg: &KokoroConfig,
    control: Option<&dyn DownloadControl>,
) -> Result<(), DownloadError> {
    // onnx-community layout: the fp16 graph under onnx/ + one raw .bin per voice
    // under voices/. (Primary downloads go through the shared TTS download
    // manager; this is the engine's self-contained fallback.)
    let mut jobs: Vec<(String, std::path::PathBuf)> = vec![(kokoro::model_url(), cfg.model_path())];
    for v in KOKORO_VOICE_CATALOG {
        jobs.push((kokoro::voice_url(v.id), cfg.voice_path(v.id)));
    }
    let client = reqwest::Client::builder()
        .user_agent("WinSTT/0.1")
        .build()
        .map_err(|e| DownloadError::Network(e.to_string()))?;

    for (url, target) in jobs {
        if target.exists() {
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| DownloadError::Network(e.to_string()))?;
        }
        download_one(&client, &url, &target, control)?;
    }
    Ok(())
}

/// Stream one URL → `target` with Range resume + pause/cancel. Blocking shim
/// over the async body.
fn download_one(
    client: &reqwest::Client,
    url: &str,
    target: &std::path::Path,
    control: Option<&dyn DownloadControl>,
) -> Result<(), DownloadError> {
    let partial = target.with_extension("partial");
    let control_adapter = DownloadControlAdapter { control };
    let report = transfer_url_blocking(
        client,
        TransferRequest {
            delete_partial_on_cancel: true,
            final_path: Some(target),
            known_total_bytes: None,
            partial_path: &partial,
            progress_interval: std::time::Duration::from_millis(100),
            url,
        },
        Some(&control_adapter),
        |progress| {
            if let Some(c) = control {
                c.on_progress(
                    progress.progress_fraction.unwrap_or(0.0),
                    progress.downloaded_bytes,
                    progress.total_bytes.unwrap_or(0),
                );
            }
        },
    )
    .map_err(|e| DownloadError::Network(e.to_string()))?;

    match report.outcome {
        TransferOutcome::Complete => {
            if let Some(c) = control {
                c.on_progress(
                    1.0,
                    report.downloaded_bytes,
                    report.total_bytes.unwrap_or(report.downloaded_bytes),
                );
            }
            Ok(())
        }
        TransferOutcome::Paused => Err(DownloadError::Paused),
        TransferOutcome::Cancelled => Err(DownloadError::Cancelled),
    }
}

struct DownloadControlAdapter<'a> {
    control: Option<&'a dyn DownloadControl>,
}

impl TransferControl for DownloadControlAdapter<'_> {
    fn should_cancel(&self) -> bool {
        self.control
            .map(|control| control.should_cancel())
            .unwrap_or(false)
    }

    fn should_pause(&self) -> bool {
        self.control
            .map(|control| control.should_pause())
            .unwrap_or(false)
    }
}
