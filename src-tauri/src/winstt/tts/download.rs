use super::kokoro::{self, KokoroConfig};
use super::voices::KOKORO_VOICE_CATALOG;

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
///
/// SPIKE: the STT slice will ship a shared `asset_downloader.rs` with the exact
/// `.partial`/Range/pause logic; once it lands, delegate to it (one downloader
/// in the app) instead of this self-contained copy.
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
    use std::io::Write;
    use tauri::async_runtime::block_on;

    let partial = target.with_extension("partial");
    let resume_from = partial.metadata().map(|m| m.len()).unwrap_or(0);

    let mut req = client.get(url);
    if resume_from > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }
    let mut resp = block_on(req.send()).map_err(|e| DownloadError::Network(e.to_string()))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(DownloadError::Network(format!("HTTP {status} for {url}")));
    }
    // If the server ignored Range (200 not 206), restart cleanly.
    let resuming = resume_from > 0 && status.as_u16() == 206;
    let mut downloaded = if resuming { resume_from } else { 0 };
    let total = resp.content_length().map(|cl| downloaded + cl).unwrap_or(0);

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(resuming)
        .write(true)
        .truncate(!resuming)
        .open(&partial)
        .map_err(|e| DownloadError::Network(e.to_string()))?;

    loop {
        if let Some(c) = control {
            if c.should_cancel() {
                drop(file);
                let _ = std::fs::remove_file(&partial);
                return Err(DownloadError::Cancelled);
            }
            if c.should_pause() {
                // leave .partial for the next resume
                return Err(DownloadError::Paused);
            }
        }
        // `chunk()` reads the next body frame; None = done.
        let next = block_on(resp.chunk()).map_err(|e| DownloadError::Network(e.to_string()))?;
        let Some(bytes) = next else { break };
        file.write_all(&bytes)
            .map_err(|e| DownloadError::Network(e.to_string()))?;
        downloaded += bytes.len() as u64;
        if let Some(c) = control {
            let frac = if total > 0 {
                downloaded as f64 / total as f64
            } else {
                0.0
            };
            c.on_progress(frac, downloaded, total);
        }
    }
    drop(file);
    std::fs::rename(&partial, target).map_err(|e| DownloadError::Network(e.to_string()))?;
    if let Some(c) = control {
        c.on_progress(1.0, downloaded, downloaded);
    }
    Ok(())
}
