use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode};
use tokio::sync::watch;

/// Max time to wait for the connection to start delivering data (response headers) and for EACH
/// subsequent body chunk. `connect_timeout` only bounds the TCP/TLS handshake — once connected, a
/// server that accepts the socket but never sends bytes (HF CDN / xet stalls, captive portals,
/// flaky links) leaves `Response::chunk().await` blocked forever, which surfaces as a download
/// "stuck at 0%" no matter how long you wait. On elapse we return a `Network` error; the caller
/// resumes via HTTP-Range (the partial `.incomplete` bytes are preserved) or falls back to hf-hub,
/// so a stall self-heals instead of wedging the badge.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// How many times `transfer_url` re-opens a dropped transfer before giving up. A retry only happens
/// when the previous attempt actually appended bytes (see `transfer_url`), so this bounds "the link
/// keeps dying mid-file" rather than spinning on a hard failure like a 404.
const MAX_RESUME_ATTEMPTS: u32 = 4;

#[derive(Debug, thiserror::Error)]
pub enum TransferError {
    #[error("io: {0}")]
    Io(String),
    #[error("network: {0}")]
    Network(String),
    /// The body ended before `expected` bytes arrived. The partial file is left on disk so the next
    /// attempt resumes via HTTP Range instead of restarting.
    #[error("truncated {url}: got {downloaded} of {expected} bytes")]
    Truncated {
        downloaded: u64,
        expected: u64,
        url: String,
    },
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
    /// Subscribe to the current, latched transfer state. `transfer_url` races this receiver against
    /// both the HTTP request and each body read, so pause/cancel does not wait for another chunk.
    fn subscribe(&self) -> watch::Receiver<TransferControlState>;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TransferControlState {
    paused: bool,
    cancelled: bool,
}

impl TransferControlState {
    pub const fn new(paused: bool, cancelled: bool) -> Self {
        Self { paused, cancelled }
    }

    pub const fn is_paused(self) -> bool {
        self.paused
    }

    pub const fn is_cancelled(self) -> bool {
        self.cancelled
    }

    fn requested_outcome(self) -> Option<TransferOutcome> {
        if self.cancelled {
            Some(TransferOutcome::Cancelled)
        } else if self.paused {
            Some(TransferOutcome::Paused)
        } else {
            None
        }
    }
}

/// Cooperative pause/cancel state observed by `transfer_url` through a Tokio watch channel. The
/// three download managers (STT quants, TTS catalog, encoder dictionary) each embed one of these
/// instead of re-declaring an identical `{ paused, cancelled }` pair plus its `TransferControl`
/// impl.
///
/// Semantics are intentionally minimal so each manager keeps its own cancel policy: `cancel` only
/// raises the cancel flag (a manager that also wants to clear a pending pause on cancel calls
/// `resume` afterwards), `resume` clears only the pause bit, and `reset` clears both (the start /
/// re-enqueue path).
pub(crate) struct PauseCancelFlags {
    state: watch::Sender<TransferControlState>,
}

impl Default for PauseCancelFlags {
    fn default() -> Self {
        let (state, _) = watch::channel(TransferControlState::default());
        Self { state }
    }
}

impl PauseCancelFlags {
    pub(crate) fn pause(&self) {
        self.state.send_modify(|state| state.paused = true);
    }

    pub(crate) fn resume(&self) {
        self.state.send_modify(|state| state.paused = false);
    }

    pub(crate) fn cancel(&self) {
        self.state.send_modify(|state| state.cancelled = true);
    }

    pub(crate) fn reset(&self) {
        self.state.send_replace(TransferControlState::default());
    }

    pub(crate) fn is_paused(&self) -> bool {
        self.state.borrow().paused
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.state.borrow().cancelled
    }
}

impl TransferControl for PauseCancelFlags {
    fn subscribe(&self) -> watch::Receiver<TransferControlState> {
        self.state.subscribe()
    }
}

/// Stream `request.url` into `request.partial_path`, resuming a prior partial via HTTP Range, and on
/// success rename it to `request.final_path`.
///
/// A dropped connection mid-body is retried (up to [`MAX_RESUME_ATTEMPTS`]) as long as the previous
/// attempt appended bytes, so a flaky link self-heals by resuming instead of surfacing an error or —
/// far worse — publishing a short file. A failure that writes nothing (404, DNS, offline) breaks out
/// immediately rather than burning retries.
pub async fn transfer_url<F>(
    client: &Client,
    request: TransferRequest<'_>,
    control: Option<&dyn TransferControl>,
    mut on_progress: F,
) -> Result<TransferReport, TransferError>
where
    F: FnMut(TransferProgress),
{
    let partial_len = || fs::metadata(request.partial_path).map_or(0, |metadata| metadata.len());
    let mut bytes_before = partial_len();
    let mut last_error = None;

    for _ in 0..MAX_RESUME_ATTEMPTS {
        match transfer_attempt(client, request, control, &mut on_progress).await {
            Ok(report) => return Ok(report),
            Err(error) => {
                let bytes_now = partial_len();
                let progressed = bytes_now > bytes_before;
                bytes_before = bytes_now;
                last_error = Some(error);
                // No new bytes ⇒ retrying would replay the same failure against the same offset.
                if !progressed {
                    break;
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| {
        TransferError::Network(format!("{}: transfer made no attempt", request.url))
    }))
}

async fn transfer_attempt<F>(
    client: &Client,
    request: TransferRequest<'_>,
    control: Option<&dyn TransferControl>,
    on_progress: &mut F,
) -> Result<TransferReport, TransferError>
where
    F: FnMut(TransferProgress),
{
    if let Some(parent) = request.partial_path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }

    let mut existing_bytes =
        fs::metadata(request.partial_path).map_or(0, |metadata| metadata.len());
    let mut control = control.map(TransferControl::subscribe);
    if let Some(outcome) = requested_outcome(control.as_ref()) {
        return settle_before_open(request, existing_bytes, outcome);
    }
    let mut http_request = client.get(request.url);
    if existing_bytes > 0 {
        http_request = http_request.header(RANGE, format!("bytes={existing_bytes}-"));
    }

    let mut response = match interruptible_http(
        http_request.send(),
        request.url,
        "request",
        control.as_mut(),
    )
    .await
    {
        Ok(response) => response,
        Err(InterruptibleError::Transfer(error)) => return Err(error),
        Err(InterruptibleError::Control(outcome)) => {
            return settle_before_open(request, existing_bytes, outcome);
        }
    };
    let mut status = response.status();

    if existing_bytes > 0 && status == StatusCode::OK {
        drop(response);
        let _ = fs::remove_file(request.partial_path);
        existing_bytes = 0;
        response = match interruptible_http(
            client.get(request.url).send(),
            request.url,
            "request",
            control.as_mut(),
        )
        .await
        {
            Ok(response) => response,
            Err(InterruptibleError::Transfer(error)) => return Err(error),
            Err(InterruptibleError::Control(outcome)) => {
                return settle_before_open(request, existing_bytes, outcome);
            }
        };
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
    // Two different numbers on purpose: `expected_total` comes only from THIS response's own
    // headers and is the authority on completeness, while `total_bytes` may fall back to a catalog
    // estimate (`known_total_bytes`) that is good enough for a progress bar but must never decide
    // whether a file is finished.
    let expected_total = response_expected_total(&response, downloaded);
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
    emit_progress(on_progress, started, resumed_from, downloaded, total_bytes);

    loop {
        if let Some(outcome) = requested_outcome(control.as_ref()) {
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

        let next =
            interruptible_http(response.chunk(), request.url, "read", control.as_mut()).await;
        let Some(bytes) = (match next {
            Ok(bytes) => bytes,
            Err(InterruptibleError::Transfer(error)) => return Err(error),
            Err(InterruptibleError::Control(outcome)) => {
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
        }) else {
            break;
        };
        file.write_all(&bytes).map_err(io_error)?;
        downloaded = downloaded.saturating_add(bytes.len() as u64);

        if last_emit.elapsed() >= request.progress_interval {
            emit_progress(on_progress, started, resumed_from, downloaded, total_bytes);
            last_emit = Instant::now();
        }
    }

    file.flush().map_err(io_error)?;
    drop(file);

    // A body can end EARLY and still look like a clean end-of-stream to reqwest — an HTTP/2 stream
    // reset, a CDN/proxy cutting the connection, a captive portal. Without this check the short
    // `.partial` was renamed into place and reported Complete, which then poisons the cache
    // permanently: every later pass sees the final file exists and skips it, so the corruption only
    // ever surfaces at load time as "Protobuf parsing failed". Leave the partial on disk (no
    // rename, no delete) so the retry in `transfer_url` resumes via Range from where it stopped.
    if let Some(expected) = expected_total
        && downloaded < expected
    {
        return Err(TransferError::Truncated {
            downloaded,
            expected,
            url: request.url.to_string(),
        });
    }

    emit_progress(on_progress, started, resumed_from, downloaded, total_bytes);

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

/// Await a reqwest future under [`IDLE_TIMEOUT`], mapping both a transport error and a stall into a
/// `Network` error. Used for the initial `send` (time-to-first-byte) and every body `chunk` read so
/// neither can hang indefinitely.
async fn with_idle_timeout<T>(
    fut: impl std::future::Future<Output = Result<T, reqwest::Error>>,
    url: &str,
    what: &str,
) -> Result<T, TransferError> {
    match tokio::time::timeout(IDLE_TIMEOUT, fut).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(err)) => Err(TransferError::Network(format!("{what} {url}: {err}"))),
        Err(_) => Err(TransferError::Network(format!(
            "{what} {url}: no data for {}s (stalled)",
            IDLE_TIMEOUT.as_secs()
        ))),
    }
}

enum InterruptibleError {
    Transfer(TransferError),
    Control(TransferOutcome),
}

async fn interruptible_http<T>(
    fut: impl std::future::Future<Output = Result<T, reqwest::Error>>,
    url: &str,
    what: &str,
    control: Option<&mut watch::Receiver<TransferControlState>>,
) -> Result<T, InterruptibleError> {
    let Some(control) = control else {
        return with_idle_timeout(fut, url, what)
            .await
            .map_err(InterruptibleError::Transfer);
    };
    tokio::select! {
        biased;
        outcome = wait_for_requested_outcome(control) => Err(InterruptibleError::Control(outcome)),
        result = with_idle_timeout(fut, url, what) => result.map_err(InterruptibleError::Transfer),
    }
}

async fn wait_for_requested_outcome(
    control: &mut watch::Receiver<TransferControlState>,
) -> TransferOutcome {
    loop {
        if let Some(outcome) = control.borrow_and_update().requested_outcome() {
            return outcome;
        }
        if control.changed().await.is_err() {
            // A transfer owns only the receiver. If a custom controller drops its sender while the
            // transfer is live, that means "keep running", not an implicit cancellation.
            std::future::pending::<()>().await;
        }
    }
}

fn requested_outcome(
    control: Option<&watch::Receiver<TransferControlState>>,
) -> Option<TransferOutcome> {
    control?.borrow().requested_outcome()
}

fn settle_before_open(
    request: TransferRequest<'_>,
    downloaded_bytes: u64,
    outcome: TransferOutcome,
) -> Result<TransferReport, TransferError> {
    if outcome == TransferOutcome::Cancelled && request.delete_partial_on_cancel {
        let _ = fs::remove_file(request.partial_path);
    }
    Ok(TransferReport {
        downloaded_bytes,
        outcome,
        total_bytes: request.known_total_bytes,
    })
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

/// The full size of the resource as declared by THIS response — `Content-Range`'s total on a 206,
/// otherwise `Content-Length` (plus the resume offset). Never falls back to a caller-supplied
/// estimate, which is what makes it safe to decide completeness with. `None` when the server
/// declares no length (chunked without a total), in which case completeness is unknowable and the
/// body's end is taken at face value.
fn response_expected_total(
    response: &reqwest::Response,
    downloaded_before_response: u64,
) -> Option<u64> {
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

fn response_total_bytes(
    response: &reqwest::Response,
    downloaded_before_response: u64,
    known_total_bytes: Option<u64>,
) -> Option<u64> {
    if let Some(total) = known_total_bytes {
        return Some(total.max(downloaded_before_response));
    }
    response_expected_total(response, downloaded_before_response)
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    value.rsplit_once('/')?.1.parse::<u64>().ok()
}

/// True when `path` is an ONNX file that was cut off mid-transfer.
///
/// A `ModelProto` stores its `graph` (field 7) as a length-delimited record, so the header states
/// how many bytes the graph occupies; a file shorter than that ended early. This is the corruption
/// the pre-fix downloader could publish (see `transfer_attempt`) and it is otherwise invisible until
/// ORT fails at load with "Protobuf parsing failed" — by which point the cache looks complete and
/// nothing re-fetches it. Checking it costs one 64-byte read, no network.
///
/// Deliberately conservative: anything unexpected (unreadable file, unknown field order, a varint
/// that does not terminate) returns `false`. A false negative just reproduces today's behaviour,
/// whereas a false positive would re-download a perfectly good multi-GB model forever.
///
/// Works for external-data exports too: `model.onnx` still fully contains its own graph record, with
/// only the tensor payloads living in the `.onnx_data` sidecar.
pub fn onnx_is_truncated(path: &Path) -> bool {
    use std::io::Read;

    let Ok(file_len) = fs::metadata(path).map(|m| m.len()) else {
        return false;
    };
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 64];
    let Ok(read) = file.read(&mut head) else {
        return false;
    };
    let head = &head[..read];

    let mut offset = 0usize;
    loop {
        let Some((key, next)) = read_varint(head, offset) else {
            return false;
        };
        offset = next;
        let (field, wire_type) = (key >> 3, key & 7);
        match (field, wire_type) {
            // graph — the record whose declared length we can compare against the file size.
            (7, 2) => {
                let Some((graph_len, after_len)) = read_varint(head, offset) else {
                    return false;
                };
                return (after_len as u64).saturating_add(graph_len) > file_len;
            }
            // ir_version / model_version: varint, skip the value.
            (1 | 5, 0) => {
                let Some((_, next)) = read_varint(head, offset) else {
                    return false;
                };
                offset = next;
            }
            // producer_name / producer_version / domain / doc_string: length-delimited, skip it.
            (2 | 3 | 4 | 6, 2) => {
                let Some((len, after_len)) = read_varint(head, offset) else {
                    return false;
                };
                let Some(end) = usize::try_from(len)
                    .ok()
                    .and_then(|l| after_len.checked_add(l))
                else {
                    return false;
                };
                if end > head.len() {
                    // The preamble runs past our 64-byte window — rare, and not worth a
                    // bigger read just to guess. Treat as "can't tell".
                    return false;
                }
                offset = end;
            }
            // The graph must precede anything else we care about; bail rather than guess.
            _ => return false,
        }
    }
}

/// Read a protobuf base-128 varint at `offset`, returning `(value, offset_after)`. `None` on
/// truncation or an over-long encoding.
fn read_varint(buf: &[u8], mut offset: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *buf.get(offset)?;
        offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, offset));
        }
    }
    None
}

/// The canonical download progress ratio in `[0, 1]`, 0.0 when the total is unknown/zero.
///
/// SINGLE SOURCE OF TRUTH for the fraction every downloader reports. The per-catalog download
/// managers (STT `download_manager`, TTS `tts_download_manager`, wakeword `wakeword_manager`) keep
/// their own ORCHESTRATION — different transfer mechanisms (hf-hub `ProgressHandler` vs `transfer_url`),
/// different per-file accumulators (name-keyed map vs index-keyed vec vs single-archive snapshot), and
/// different event payload shapes — because those genuinely differ per catalog. What must NOT diverge
/// is this ratio arithmetic, so it lives here and every emit path calls it.
pub fn progress_fraction_of(downloaded: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (downloaded as f64 / total as f64).clamp(0.0, 1.0)
    }
}

fn progress_fraction(downloaded: u64, total_bytes: Option<u64>) -> Option<f64> {
    let total = total_bytes?;
    if total == 0 {
        return None;
    }
    Some(progress_fraction_of(downloaded, total))
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
    use std::sync::Arc;

    /// Build the preamble every one of these exports actually starts with —
    /// `ir_version`, `producer_name`, `producer_version`, then the length-delimited `graph`
    /// header declaring `graph_len` bytes — and pad the body to `body_len`.
    fn onnx_bytes(graph_len: u64, body_len: usize) -> Vec<u8> {
        let mut buf = vec![0x08, 0x09]; // field 1 (ir_version) varint = 9
        buf.extend([0x12, 0x07]); // field 2 (producer_name), len 7
        buf.extend(b"pytorch");
        buf.extend([0x1a, 0x06]); // field 3 (producer_version), len 6
        buf.extend(b"2.12.1");
        buf.push(0x3a); // field 7 (graph), wire type 2
        let mut value = graph_len;
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                buf.push(byte);
                break;
            }
            buf.push(byte | 0x80);
        }
        buf.resize(buf.len() + body_len, 0);
        buf
    }

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(name);
        fs::write(&path, bytes).expect("write fixture");
        path
    }

    #[test]
    fn flags_an_onnx_truncated_mid_transfer() {
        // The shape of the real failure: talker_cache.onnx declared a 911 MB graph but only
        // 621 MB landed, and existence-only checks called that "downloaded".
        let path = write_temp("winstt_truncated.onnx", &onnx_bytes(4096, 100));
        assert!(onnx_is_truncated(&path));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn accepts_a_complete_onnx() {
        let path = write_temp("winstt_complete.onnx", &onnx_bytes(4096, 4096));
        assert!(!onnx_is_truncated(&path));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn accepts_an_onnx_with_trailing_opset_records() {
        // Real files carry ~25 bytes of `opset_import` after the graph, so the file is a
        // little LARGER than header+graph. That must not read as corrupt.
        let path = write_temp("winstt_trailing.onnx", &onnx_bytes(4096, 4096 + 25));
        assert!(!onnx_is_truncated(&path));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn declines_to_judge_non_onnx_or_missing_files() {
        // Conservative by design: a false positive re-downloads a good multi-GB model forever.
        assert!(!onnx_is_truncated(std::path::Path::new("nope.onnx")));
        let path = write_temp("winstt_notonnx.bin", b"this is not a protobuf at all");
        assert!(!onnx_is_truncated(&path));
        let _ = fs::remove_file(path);
    }

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

    #[tokio::test]
    async fn pause_wakes_an_awaiting_transfer_control() {
        let flags = Arc::new(PauseCancelFlags::default());
        let mut receiver = flags.subscribe();
        let waiter = tokio::spawn(async move { wait_for_requested_outcome(&mut receiver).await });

        tokio::task::yield_now().await;
        flags.pause();

        assert_eq!(
            tokio::time::timeout(Duration::from_millis(100), waiter)
                .await
                .expect("pause should wake the waiter")
                .expect("waiter should not panic"),
            TransferOutcome::Paused
        );
    }

    #[test]
    fn cancel_remains_latched_when_pause_is_resumed() {
        let flags = PauseCancelFlags::default();
        flags.pause();
        flags.cancel();
        flags.resume();

        assert!(!flags.is_paused());
        assert!(flags.is_cancelled());
        assert_eq!(
            requested_outcome(Some(&flags.subscribe())),
            Some(TransferOutcome::Cancelled)
        );
    }
}
