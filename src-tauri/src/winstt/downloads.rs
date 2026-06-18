use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode};

#[derive(Debug, thiserror::Error)]
pub enum TransferError {
    #[error("io: {0}")]
    Io(String),
    #[error("network: {0}")]
    Network(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransferOutcome {
    Complete,
    Paused,
    Cancelled,
}

#[derive(Clone, Copy, Debug)]
pub struct TransferReport {
    pub downloaded_bytes: u64,
    pub outcome: TransferOutcome,
    pub total_bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug)]
pub struct TransferProgress {
    pub downloaded_bytes: u64,
    pub eta_seconds: Option<f32>,
    pub progress_fraction: Option<f64>,
    pub resumed_from: u64,
    pub speed_bps: Option<f32>,
    pub total_bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug)]
pub struct TransferRequest<'a> {
    pub delete_partial_on_cancel: bool,
    pub final_path: Option<&'a Path>,
    pub known_total_bytes: Option<u64>,
    pub partial_path: &'a Path,
    pub progress_interval: Duration,
    pub url: &'a str,
}

pub trait TransferControl: Send + Sync {
    fn should_cancel(&self) -> bool {
        false
    }

    fn should_pause(&self) -> bool {
        false
    }
}

impl TransferControl for AtomicBool {
    fn should_cancel(&self) -> bool {
        self.load(Ordering::Acquire)
    }
}

pub async fn transfer_url<F>(
    client: &Client,
    request: TransferRequest<'_>,
    control: Option<&dyn TransferControl>,
    mut on_progress: F,
) -> Result<TransferReport, TransferError>
where
    F: FnMut(TransferProgress),
{
    if let Some(parent) = request.partial_path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }

    let existing_bytes = fs::metadata(request.partial_path).map_or(0, |metadata| metadata.len());
    let mut http_request = client.get(request.url);
    if existing_bytes > 0 {
        http_request = http_request.header(RANGE, format!("bytes={existing_bytes}-"));
    }

    let mut response = http_request
        .send()
        .await
        .map_err(|err| TransferError::Network(format!("request {}: {err}", request.url)))?;
    let mut status = response.status();

    if existing_bytes > 0 && status == StatusCode::OK {
        drop(response);
        let _ = fs::remove_file(request.partial_path);
        response = client
            .get(request.url)
            .send()
            .await
            .map_err(|err| TransferError::Network(format!("request {}: {err}", request.url)))?;
        status = response.status();
    }

    if !status.is_success() {
        return Err(TransferError::Network(format!(
            "HTTP {status} for {}",
            request.url
        )));
    }

    let appending = existing_bytes > 0 && status == StatusCode::PARTIAL_CONTENT;
    let mut downloaded = if appending { existing_bytes } else { 0 };
    let resumed_from = downloaded;
    let total_bytes = response_total_bytes(&response, downloaded, request.known_total_bytes);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(appending)
        .write(true)
        .truncate(!appending)
        .open(request.partial_path)
        .map_err(io_error)?;

    let started = Instant::now();
    let mut last_emit = Instant::now()
        .checked_sub(request.progress_interval)
        .unwrap_or_else(Instant::now);
    emit_progress(
        &mut on_progress,
        started,
        resumed_from,
        downloaded,
        total_bytes,
    );

    loop {
        if let Some(outcome) = requested_outcome(control) {
            file.flush().map_err(io_error)?;
            drop(file);
            if outcome == TransferOutcome::Cancelled && request.delete_partial_on_cancel {
                let _ = fs::remove_file(request.partial_path);
            }
            return Ok(TransferReport {
                downloaded_bytes: downloaded,
                outcome,
                total_bytes,
            });
        }

        let Some(bytes) = response
            .chunk()
            .await
            .map_err(|err| TransferError::Network(format!("read {}: {err}", request.url)))?
        else {
            break;
        };
        file.write_all(&bytes).map_err(io_error)?;
        downloaded = downloaded.saturating_add(bytes.len() as u64);

        if last_emit.elapsed() >= request.progress_interval {
            emit_progress(
                &mut on_progress,
                started,
                resumed_from,
                downloaded,
                total_bytes,
            );
            last_emit = Instant::now();
        }
    }

    file.flush().map_err(io_error)?;
    drop(file);
    emit_progress(
        &mut on_progress,
        started,
        resumed_from,
        downloaded,
        total_bytes,
    );

    if let Some(final_path) = request.final_path {
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        fs::rename(request.partial_path, final_path).map_err(io_error)?;
    }

    Ok(TransferReport {
        downloaded_bytes: downloaded,
        outcome: TransferOutcome::Complete,
        total_bytes,
    })
}

pub fn transfer_url_blocking<F>(
    client: &Client,
    request: TransferRequest<'_>,
    control: Option<&dyn TransferControl>,
    on_progress: F,
) -> Result<TransferReport, TransferError>
where
    F: FnMut(TransferProgress),
{
    tauri::async_runtime::block_on(transfer_url(client, request, control, on_progress))
}

fn requested_outcome(control: Option<&dyn TransferControl>) -> Option<TransferOutcome> {
    let control = control?;
    if control.should_cancel() {
        return Some(TransferOutcome::Cancelled);
    }
    if control.should_pause() {
        return Some(TransferOutcome::Paused);
    }
    None
}

fn emit_progress<F>(
    on_progress: &mut F,
    started: Instant,
    resumed_from: u64,
    downloaded: u64,
    total_bytes: Option<u64>,
) where
    F: FnMut(TransferProgress),
{
    let (speed_bps, eta_seconds) =
        download_rate_estimate(started, resumed_from, downloaded, total_bytes);
    on_progress(TransferProgress {
        downloaded_bytes: downloaded,
        eta_seconds,
        progress_fraction: progress_fraction(downloaded, total_bytes),
        resumed_from,
        speed_bps,
        total_bytes,
    });
}

fn response_total_bytes(
    response: &reqwest::Response,
    downloaded_before_response: u64,
    known_total_bytes: Option<u64>,
) -> Option<u64> {
    if let Some(total) = known_total_bytes {
        return Some(total.max(downloaded_before_response));
    }
    if response.status() == StatusCode::PARTIAL_CONTENT {
        if let Some(total) = response
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(parse_content_range_total)
        {
            return Some(total);
        }
        return response
            .content_length()
            .map(|remaining| downloaded_before_response.saturating_add(remaining));
    }
    response.content_length()
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    value.rsplit_once('/')?.1.parse::<u64>().ok()
}

fn progress_fraction(downloaded: u64, total_bytes: Option<u64>) -> Option<f64> {
    let total = total_bytes?;
    if total == 0 {
        return None;
    }
    Some((downloaded as f64 / total as f64).clamp(0.0, 1.0))
}

fn download_rate_estimate(
    started: Instant,
    resumed_from: u64,
    downloaded: u64,
    total_bytes: Option<u64>,
) -> (Option<f32>, Option<f32>) {
    let elapsed = started.elapsed().as_secs_f64();
    let transferred = downloaded.saturating_sub(resumed_from);
    if elapsed <= 0.0 || transferred == 0 {
        return (None, None);
    }
    let speed = (transferred as f64 / elapsed).max(0.0);
    let eta = total_bytes.and_then(|total| {
        if total <= downloaded || speed <= 0.0 {
            None
        } else {
            Some(((total - downloaded) as f64 / speed) as f32)
        }
    });
    (Some(speed as f32), eta)
}

fn io_error(err: std::io::Error) -> TransferError {
    TransferError::Io(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_range_totals() {
        assert_eq!(parse_content_range_total("bytes 10-19/100"), Some(100));
        assert_eq!(parse_content_range_total("bytes */4096"), Some(4096));
        assert_eq!(parse_content_range_total("bytes 10-19/*"), None);
        assert_eq!(parse_content_range_total("not a range"), None);
    }

    #[test]
    fn reports_progress_fraction_when_total_is_known() {
        assert_eq!(progress_fraction(50, Some(200)), Some(0.25));
        assert_eq!(progress_fraction(250, Some(200)), Some(1.0));
        assert_eq!(progress_fraction(50, Some(0)), None);
        assert_eq!(progress_fraction(50, None), None);
    }
}
