// Background model-bundle download + extraction + the download-snapshot/status
// state machine for the wake-word manager. Extracted verbatim from the
// `wakeword_manager` root module: every item here is a free function (or small
// helper type) that operates on the shared `Arc` handles threaded in as explicit
// arguments — it never touches `&self` because the download runs on a spawned
// thread. The manager impl in the root calls into these via `download::*`.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use super::{
    WakeWordDownloadPhase, WakeWordModelDownloadSnapshot, WakeWordModelStatusPayload,
    DOWNLOAD_CONTROL_CANCEL, DOWNLOAD_CONTROL_PAUSE, DOWNLOAD_PROGRESS_EMIT_INTERVAL,
    KWS_MODEL_DOWNLOAD_URL, LEGACY_PORCUPINE_WHEEL_SHA256, LEGACY_PORCUPINE_WHEEL_URL,
    WAKEWORD_MODEL_STATUS_EVENT,
};
use crate::winstt::downloads::{transfer_url, TransferControl, TransferOutcome, TransferRequest};
use crate::winstt::wakeword::{
    KwsModelPaths, LegacyPorcupinePaths, WakeWordRuntimeEngine, KWS_BUNDLE_DIRNAME,
};

pub(super) fn wakeword_model_root_dir(app: &AppHandle) -> PathBuf {
    crate::portable::app_data_dir(app)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("wakeword")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum WakeWordDownloadOutcome {
    Complete,
    Paused,
    Cancelled,
}

pub(super) fn download_model_bundle_for_engine(
    app: &AppHandle,
    engine: WakeWordRuntimeEngine,
    inflight: &Arc<AtomicBool>,
    control: &Arc<AtomicU8>,
    snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>,
) -> Result<WakeWordDownloadOutcome, String> {
    match engine {
        WakeWordRuntimeEngine::LegacyPorcupine => {
            download_legacy_porcupine_bundle(app, inflight, control, snapshot)
        }
        WakeWordRuntimeEngine::SherpaKws => {
            download_kws_model_bundle(app, inflight, control, snapshot)
        }
    }
}

pub(super) fn download_legacy_porcupine_bundle(
    app: &AppHandle,
    inflight: &Arc<AtomicBool>,
    control: &Arc<AtomicU8>,
    snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>,
) -> Result<WakeWordDownloadOutcome, String> {
    let root = wakeword_model_root_dir(app);
    let final_bundle = root.join(LegacyPorcupinePaths::DIRNAME);
    let final_paths = LegacyPorcupinePaths::from_root(&final_bundle);
    if final_paths.all_present_for_keyword("alexa") {
        return Ok(WakeWordDownloadOutcome::Complete);
    }

    fs::create_dir_all(&root)
        .map_err(|err| format!("create wakeword model directory {}: {err}", root.display()))?;

    let wheel_path = root.join("pvporcupine-1.9.5-py3-none-any.whl.partial");
    let staging_dir = root.join(".pvporcupine-1.9.5.download");

    let result: Result<WakeWordDownloadOutcome, String> = (|| {
        remove_path_if_exists(&staging_dir)?;
        fs::create_dir_all(&staging_dir).map_err(|err| {
            format!(
                "create legacy Porcupine staging directory {}: {err}",
                staging_dir.display()
            )
        })?;

        match tauri::async_runtime::block_on(download_wakeword_file(
            LEGACY_PORCUPINE_WHEEL_URL,
            &wheel_path,
            app,
            inflight,
            control,
            snapshot,
        ))? {
            WakeWordDownloadOutcome::Complete => {}
            WakeWordDownloadOutcome::Paused => return Ok(WakeWordDownloadOutcome::Paused),
            WakeWordDownloadOutcome::Cancelled => {
                return Ok(WakeWordDownloadOutcome::Cancelled);
            }
        }
        if requested_download_action(control) == Some(WakeWordDownloadOutcome::Cancelled) {
            return Ok(WakeWordDownloadOutcome::Cancelled);
        }
        verify_sha256(&wheel_path, LEGACY_PORCUPINE_WHEEL_SHA256)?;
        extract_zip_archive(&wheel_path, &staging_dir)?;

        let staged_paths = LegacyPorcupinePaths::from_root(&staging_dir);
        if !staged_paths.all_present_for_keyword("alexa") {
            return Err(
                "downloaded pvporcupine wheel did not contain expected runtime files".into(),
            );
        }

        remove_path_if_exists(&final_bundle)?;
        fs::rename(&staging_dir, &final_bundle).map_err(|err| {
            format!(
                "install legacy Porcupine bundle {} -> {}: {err}",
                staging_dir.display(),
                final_bundle.display()
            )
        })?;
        Ok(WakeWordDownloadOutcome::Complete)
    })();

    if !matches!(result, Ok(WakeWordDownloadOutcome::Paused)) {
        let _ = fs::remove_file(&wheel_path);
    }
    if staging_dir.exists() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    let outcome = result?;
    if outcome != WakeWordDownloadOutcome::Complete {
        return Ok(outcome);
    }

    if !LegacyPorcupinePaths::from_root(&final_bundle).all_present_for_keyword("alexa") {
        return Err(format!(
            "installed legacy Porcupine bundle is incomplete at {}",
            final_bundle.display()
        ));
    }

    Ok(WakeWordDownloadOutcome::Complete)
}

pub(super) fn download_kws_model_bundle(
    app: &AppHandle,
    inflight: &Arc<AtomicBool>,
    control: &Arc<AtomicU8>,
    snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>,
) -> Result<WakeWordDownloadOutcome, String> {
    let root = wakeword_model_root_dir(app);
    let final_bundle = root.join(KWS_BUNDLE_DIRNAME);
    if KwsModelPaths::from_bundle_dir(&final_bundle).all_present() {
        return Ok(WakeWordDownloadOutcome::Complete);
    }

    fs::create_dir_all(&root)
        .map_err(|err| format!("create wakeword model directory {}: {err}", root.display()))?;

    let archive_path = root.join(format!("{KWS_BUNDLE_DIRNAME}.tar.bz2.partial"));
    let staging_dir = root.join(format!(".{KWS_BUNDLE_DIRNAME}.download"));

    let result = (|| {
        remove_path_if_exists(&staging_dir)?;
        fs::create_dir_all(&staging_dir).map_err(|err| {
            format!(
                "create wakeword model staging directory {}: {err}",
                staging_dir.display()
            )
        })?;

        match tauri::async_runtime::block_on(download_kws_archive(
            KWS_MODEL_DOWNLOAD_URL,
            &archive_path,
            app,
            inflight,
            control,
            snapshot,
        ))? {
            WakeWordDownloadOutcome::Complete => {}
            WakeWordDownloadOutcome::Paused => return Ok(WakeWordDownloadOutcome::Paused),
            WakeWordDownloadOutcome::Cancelled => {
                return Ok(WakeWordDownloadOutcome::Cancelled);
            }
        }
        if requested_download_action(control) == Some(WakeWordDownloadOutcome::Cancelled) {
            return Ok(WakeWordDownloadOutcome::Cancelled);
        }
        extract_kws_archive(&archive_path, &staging_dir)?;

        let staged_bundle = staging_dir.join(KWS_BUNDLE_DIRNAME);
        if !KwsModelPaths::from_bundle_dir(&staged_bundle).all_present() {
            return Err(format!(
                "downloaded archive did not contain the complete {KWS_BUNDLE_DIRNAME} bundle"
            ));
        }

        remove_path_if_exists(&final_bundle)?;
        fs::rename(&staged_bundle, &final_bundle).map_err(|err| {
            format!(
                "install wakeword model bundle {} -> {}: {err}",
                staged_bundle.display(),
                final_bundle.display()
            )
        })?;
        Ok(WakeWordDownloadOutcome::Complete)
    })();

    if !matches!(result, Ok(WakeWordDownloadOutcome::Paused)) {
        let _ = fs::remove_file(&archive_path);
    }
    let _ = fs::remove_dir_all(&staging_dir);
    let outcome = result?;
    if outcome != WakeWordDownloadOutcome::Complete {
        return Ok(outcome);
    }

    if !KwsModelPaths::from_bundle_dir(&final_bundle).all_present() {
        return Err(format!(
            "installed wakeword model bundle is incomplete at {}",
            final_bundle.display()
        ));
    }

    Ok(WakeWordDownloadOutcome::Complete)
}

pub(super) async fn download_kws_archive(
    url: &str,
    target: &Path,
    app: &AppHandle,
    inflight: &Arc<AtomicBool>,
    control: &Arc<AtomicU8>,
    snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>,
) -> Result<WakeWordDownloadOutcome, String> {
    download_wakeword_file(url, target, app, inflight, control, snapshot).await
}

pub(super) async fn download_wakeword_file(
    url: &str,
    target: &Path,
    app: &AppHandle,
    inflight: &Arc<AtomicBool>,
    control: &Arc<AtomicU8>,
    snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>,
) -> Result<WakeWordDownloadOutcome, String> {
    if let Some(outcome) = requested_download_action(control) {
        return Ok(outcome);
    }
    let client = reqwest::Client::new();
    let control_adapter = WakeWordTransferControl {
        control: control.as_ref(),
    };
    let report = transfer_url(
        &client,
        TransferRequest {
            delete_partial_on_cancel: true,
            final_path: None,
            known_total_bytes: None,
            partial_path: target,
            progress_interval: DOWNLOAD_PROGRESS_EMIT_INTERVAL,
            url,
        },
        Some(&control_adapter),
        |progress| {
            update_download_snapshot(
                snapshot,
                progress.downloaded_bytes,
                progress.total_bytes,
                progress.speed_bps,
                progress.eta_seconds,
            );
            emit_wakeword_model_status(app, &status_for_app(app, inflight, snapshot));
        },
    )
    .await
    .map_err(|err| err.to_string())?;

    match report.outcome {
        TransferOutcome::Complete if report.downloaded_bytes == 0 => Err(format!(
            "downloaded empty wakeword model archive from {url}"
        )),
        TransferOutcome::Complete => Ok(WakeWordDownloadOutcome::Complete),
        TransferOutcome::Paused => Ok(WakeWordDownloadOutcome::Paused),
        TransferOutcome::Cancelled => Ok(WakeWordDownloadOutcome::Cancelled),
    }
}

pub(super) fn verify_sha256(path: &Path, expected_hex: &str) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|err| format!("open {}: {err}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|err| format!("read {} for sha256: {err}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected_hex {
        return Err(format!(
            "sha256 mismatch for {}: expected {expected_hex}, got {actual}",
            path.display()
        ));
    }
    Ok(())
}

pub(super) fn extract_kws_archive(archive_path: &Path, staging_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path)
        .map_err(|err| format!("open archive {}: {err}", archive_path.display()))?;
    let decoder = bzip2::read::BzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(staging_dir)
        .map_err(|err| format!("extract archive {}: {err}", archive_path.display()))
}

pub(super) fn extract_zip_archive(archive_path: &Path, staging_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path)
        .map_err(|err| format!("open archive {}: {err}", archive_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|err| format!("read zip archive {}: {err}", archive_path.display()))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|err| format!("read zip entry {i}: {err}"))?;
        let Some(enclosed) = entry.enclosed_name().map(|path| path.to_owned()) else {
            continue;
        };
        let out_path = staging_dir.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)
                .map_err(|err| format!("create zip dir {}: {err}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("create zip parent {}: {err}", parent.display()))?;
        }
        let mut out = fs::File::create(&out_path)
            .map_err(|err| format!("create extracted file {}: {err}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|err| format!("extract zip file {}: {err}", out_path.display()))?;
    }
    Ok(())
}

pub(super) fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let metadata =
        fs::metadata(path).map_err(|err| format!("inspect path {}: {err}", path.display()))?;
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|err| format!("remove dir {}: {err}", path.display()))
    } else {
        fs::remove_file(path).map_err(|err| format!("remove file {}: {err}", path.display()))
    }
}

pub(super) fn requested_download_action(
    control: &Arc<AtomicU8>,
) -> Option<WakeWordDownloadOutcome> {
    match control.load(Ordering::Acquire) {
        DOWNLOAD_CONTROL_PAUSE => Some(WakeWordDownloadOutcome::Paused),
        DOWNLOAD_CONTROL_CANCEL => Some(WakeWordDownloadOutcome::Cancelled),
        _ => None,
    }
}

struct WakeWordTransferControl<'a> {
    control: &'a AtomicU8,
}

impl TransferControl for WakeWordTransferControl<'_> {
    fn should_cancel(&self) -> bool {
        self.control.load(Ordering::Acquire) == DOWNLOAD_CONTROL_CANCEL
    }

    fn should_pause(&self) -> bool {
        self.control.load(Ordering::Acquire) == DOWNLOAD_CONTROL_PAUSE
    }
}

pub(super) fn download_artifact_label(engine: WakeWordRuntimeEngine) -> &'static str {
    match engine {
        WakeWordRuntimeEngine::LegacyPorcupine => "pvporcupine 1.9.5 wheel",
        WakeWordRuntimeEngine::SherpaKws => "sherpa-onnx KWS archive",
    }
}

pub(super) fn partial_download_path_for_engine(
    app: &AppHandle,
    engine: WakeWordRuntimeEngine,
) -> PathBuf {
    let root = wakeword_model_root_dir(app);
    match engine {
        WakeWordRuntimeEngine::LegacyPorcupine => {
            root.join("pvporcupine-1.9.5-py3-none-any.whl.partial")
        }
        WakeWordRuntimeEngine::SherpaKws => {
            root.join(format!("{KWS_BUNDLE_DIRNAME}.tar.bz2.partial"))
        }
    }
}

pub(super) fn staging_dir_for_engine(app: &AppHandle, engine: WakeWordRuntimeEngine) -> PathBuf {
    let root = wakeword_model_root_dir(app);
    match engine {
        WakeWordRuntimeEngine::LegacyPorcupine => root.join(".pvporcupine-1.9.5.download"),
        WakeWordRuntimeEngine::SherpaKws => root.join(format!(".{KWS_BUNDLE_DIRNAME}.download")),
    }
}

pub(super) fn partial_download_bytes_for_engine(
    app: &AppHandle,
    engine: WakeWordRuntimeEngine,
) -> Option<u64> {
    fs::metadata(partial_download_path_for_engine(app, engine))
        .ok()
        .map(|m| m.len())
        .filter(|bytes| *bytes > 0)
}

pub(super) fn cleanup_partial_download_for_engine(app: &AppHandle, engine: WakeWordRuntimeEngine) {
    let _ = fs::remove_file(partial_download_path_for_engine(app, engine));
    let _ = fs::remove_dir_all(staging_dir_for_engine(app, engine));
}

pub(super) fn hydrate_paused_snapshot_from_partial(
    app: &AppHandle,
    engine: WakeWordRuntimeEngine,
    snapshot: &mut WakeWordModelDownloadSnapshot,
) {
    if snapshot.engine == Some(engine) && snapshot.phase != WakeWordDownloadPhase::Idle {
        return;
    }
    let Some(downloaded_bytes) = partial_download_bytes_for_engine(app, engine) else {
        return;
    };
    snapshot.artifact_label = Some(download_artifact_label(engine).to_string());
    snapshot.downloaded_bytes = Some(downloaded_bytes);
    snapshot.engine = Some(engine);
    snapshot.error = None;
    snapshot.phase = WakeWordDownloadPhase::Paused;
}

pub(super) fn model_status_from_snapshot(
    engine: WakeWordRuntimeEngine,
    available: bool,
    downloading: bool,
    snapshot: WakeWordModelDownloadSnapshot,
) -> WakeWordModelStatusPayload {
    let progress = if available {
        Some(1.0)
    } else {
        match (snapshot.downloaded_bytes, snapshot.total_bytes) {
            (Some(downloaded), Some(total)) if total > 0 => {
                Some(((downloaded as f32) / (total as f32)).clamp(0.0, 1.0))
            }
            _ => None,
        }
    };
    let phase = if available {
        WakeWordDownloadPhase::Complete
    } else if downloading {
        WakeWordDownloadPhase::Downloading
    } else if snapshot.error.is_some() {
        WakeWordDownloadPhase::Failed
    } else {
        snapshot.phase
    };
    WakeWordModelStatusPayload {
        available,
        artifact_label: snapshot
            .artifact_label
            .unwrap_or_else(|| download_artifact_label(engine).to_string()),
        downloaded_bytes: snapshot.downloaded_bytes,
        download_size_label: engine.download_size_label().to_string(),
        downloading: phase == WakeWordDownloadPhase::Downloading,
        engine: engine.id().to_string(),
        engine_label: engine.label().to_string(),
        eta_seconds: snapshot.eta_seconds,
        error: snapshot.error,
        phase,
        progress,
        quality_label: engine.accuracy_label().to_string(),
        speed_bps: snapshot.speed_bps,
        total_bytes: snapshot.total_bytes,
    }
}

pub(super) fn status_for_app(
    app: &AppHandle,
    inflight: &Arc<AtomicBool>,
    snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>,
) -> WakeWordModelStatusPayload {
    let snapshot = snapshot
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_default();
    let engine = snapshot.engine.unwrap_or(WakeWordRuntimeEngine::SherpaKws);
    let available = match engine {
        WakeWordRuntimeEngine::LegacyPorcupine => {
            let final_bundle = wakeword_model_root_dir(app).join(LegacyPorcupinePaths::DIRNAME);
            LegacyPorcupinePaths::from_root(final_bundle).all_present_for_keyword("alexa")
        }
        WakeWordRuntimeEngine::SherpaKws => {
            let final_bundle = wakeword_model_root_dir(app).join(KWS_BUNDLE_DIRNAME);
            KwsModelPaths::from_bundle_dir(&final_bundle).all_present()
        }
    };
    model_status_from_snapshot(
        engine,
        available,
        inflight.load(Ordering::Acquire) && snapshot.engine == Some(engine),
        snapshot,
    )
}

pub(super) fn emit_wakeword_model_status(app: &AppHandle, status: &WakeWordModelStatusPayload) {
    let _ = app.emit(WAKEWORD_MODEL_STATUS_EVENT, status);
}

pub(super) fn reset_download_snapshot(
    snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>,
    engine: WakeWordRuntimeEngine,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
) {
    if let Ok(mut guard) = snapshot.lock() {
        *guard = WakeWordModelDownloadSnapshot {
            artifact_label: Some(download_artifact_label(engine).to_string()),
            downloaded_bytes,
            engine: Some(engine),
            eta_seconds: None,
            error: None,
            phase: WakeWordDownloadPhase::Downloading,
            speed_bps: None,
            total_bytes,
        };
    }
}

pub(super) fn clear_download_snapshot(
    snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>,
    engine: WakeWordRuntimeEngine,
) {
    if let Ok(mut guard) = snapshot.lock() {
        *guard = WakeWordModelDownloadSnapshot {
            artifact_label: Some(download_artifact_label(engine).to_string()),
            engine: Some(engine),
            phase: WakeWordDownloadPhase::Idle,
            ..WakeWordModelDownloadSnapshot::default()
        };
    }
}

pub(super) fn update_download_snapshot(
    snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    speed_bps: Option<f32>,
    eta_seconds: Option<f32>,
) {
    if let Ok(mut guard) = snapshot.lock() {
        guard.downloaded_bytes = Some(downloaded_bytes);
        guard.eta_seconds = eta_seconds;
        guard.error = None;
        guard.phase = WakeWordDownloadPhase::Downloading;
        guard.speed_bps = speed_bps;
        guard.total_bytes = total_bytes;
    }
}

pub(super) fn mark_download_complete(snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>) {
    if let Ok(mut guard) = snapshot.lock() {
        if guard.downloaded_bytes.is_none() {
            guard.downloaded_bytes = guard.total_bytes;
        }
        guard.eta_seconds = None;
        guard.error = None;
        guard.phase = WakeWordDownloadPhase::Complete;
        guard.speed_bps = None;
    }
}

pub(super) fn mark_download_paused(snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>) {
    if let Ok(mut guard) = snapshot.lock() {
        guard.eta_seconds = None;
        guard.error = None;
        guard.phase = WakeWordDownloadPhase::Paused;
        guard.speed_bps = None;
    }
}

pub(super) fn mark_download_failed(
    snapshot: &Arc<Mutex<WakeWordModelDownloadSnapshot>>,
    error: String,
) {
    if let Ok(mut guard) = snapshot.lock() {
        guard.eta_seconds = None;
        guard.error = Some(error);
        guard.phase = WakeWordDownloadPhase::Failed;
        guard.speed_bps = None;
    }
}
