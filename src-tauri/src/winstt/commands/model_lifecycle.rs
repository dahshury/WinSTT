//! Authoritative STT model acquisition + activation lifecycle.
//!
//! Download and model-switch internals remain specialized, but publish through
//! this one revisioned state machine. Every update is correlated to a request id;
//! stale workers cannot overwrite a newer request for the same model/quant.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use crate::winstt::sync_ext::MutexExt;

static LIFECYCLES: LazyLock<Mutex<BTreeMap<String, SttModelLifecycleSnapshot>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));
static REVISION: AtomicU64 = AtomicU64::new(0);
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SttModelLifecyclePhase {
    Queued,
    Downloading,
    Paused,
    Verifying,
    Installing,
    /// Artifact is fully installed and loadable, but is not necessarily the resident warm model.
    Ready,
    Loading,
    Warming,
    Active,
    Failed,
    Cancelled,
}

impl SttModelLifecyclePhase {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Ready | Self::Active | Self::Failed | Self::Cancelled
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SttModelLifecycleSnapshot {
    pub model_id: String,
    pub quantization: String,
    pub phase: SttModelLifecyclePhase,
    pub request_id: String,
    pub revision: u64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: u64,
    pub eta_seconds: u64,
    /// Time spent on cryptographic and cache-resolvability verification for this request.
    pub verification_ms: Option<u64>,
    pub selected_model: Option<String>,
    pub resident_model: Option<String>,
    pub warm: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LifecycleProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: u64,
    pub eta_seconds: u64,
    pub verification_ms: Option<u64>,
}

fn key(model_id: &str, quantization: &str) -> String {
    format!("{model_id}@{quantization}")
}

fn next_revision() -> u64 {
    REVISION.fetch_add(1, Ordering::AcqRel) + 1
}

fn runtime_fields(app: &AppHandle, model_id: &str) -> (Option<String>, Option<String>, bool) {
    let selected = Some(
        crate::winstt::commands::settings::read_settings_raw(app)
            .model
            .model,
    );
    let resident = app
        .try_state::<std::sync::Arc<crate::managers::transcription::TranscriptionManager>>()
        .and_then(|manager| manager.get_current_model());
    let warm = resident.as_deref() == Some(model_id)
        && app
            .try_state::<std::sync::Arc<crate::managers::transcription::TranscriptionManager>>()
            .is_some_and(|manager| manager.is_model_warm_for(model_id));
    (selected, resident, warm)
}

fn emit(app: &AppHandle, snapshot: &SttModelLifecycleSnapshot) {
    let _ = app.emit(
        crate::winstt::commands::events::names::STT_MODEL_LIFECYCLE,
        snapshot,
    );
}

pub fn begin_download(
    app: &AppHandle,
    model_id: &str,
    quantization: &str,
) -> SttModelLifecycleSnapshot {
    let lifecycle_key = key(model_id, quantization);
    let mut lifecycles = LIFECYCLES.lock_recover();
    if let Some(existing) = lifecycles.get(&lifecycle_key)
        && !existing.phase.is_terminal()
    {
        return existing.clone();
    }
    let request_id = format!(
        "stt-download-{}",
        REQUEST_SEQUENCE.fetch_add(1, Ordering::AcqRel) + 1
    );
    let (selected_model, resident_model, warm) = runtime_fields(app, model_id);
    let snapshot = SttModelLifecycleSnapshot {
        model_id: model_id.to_string(),
        quantization: quantization.to_string(),
        phase: SttModelLifecyclePhase::Queued,
        request_id,
        revision: next_revision(),
        downloaded_bytes: 0,
        total_bytes: 0,
        speed_bps: 0,
        eta_seconds: 0,
        verification_ms: None,
        selected_model,
        resident_model,
        warm,
        error: None,
    };
    lifecycles.insert(lifecycle_key, snapshot.clone());
    drop(lifecycles);
    emit(app, &snapshot);
    snapshot
}

pub fn transition(
    app: &AppHandle,
    model_id: &str,
    quantization: &str,
    request_id: &str,
    phase: SttModelLifecyclePhase,
    progress: Option<LifecycleProgress>,
    error: Option<String>,
) -> Result<SttModelLifecycleSnapshot, String> {
    let lifecycle_key = key(model_id, quantization);
    let mut lifecycles = LIFECYCLES.lock_recover();
    let current = lifecycles
        .get(&lifecycle_key)
        .cloned()
        .ok_or_else(|| format!("no STT lifecycle exists for {lifecycle_key}"))?;
    if current.request_id != request_id {
        return Err(format!(
            "stale STT lifecycle request '{request_id}' for {lifecycle_key}; current request is '{}'",
            current.request_id
        ));
    }
    if !valid_transition(current.phase, phase) {
        return Err(format!(
            "invalid STT lifecycle transition {:?} -> {:?} for {lifecycle_key}",
            current.phase, phase
        ));
    }
    let progress = progress.unwrap_or(LifecycleProgress {
        downloaded_bytes: current.downloaded_bytes,
        total_bytes: current.total_bytes,
        speed_bps: current.speed_bps,
        eta_seconds: current.eta_seconds,
        verification_ms: current.verification_ms,
    });
    // Download progress can arrive many times per second. Runtime ownership only changes during
    // activation/terminal transitions, so keep the previous values on hot progress frames instead
    // of re-reading settings and the transcription manager for every chunk.
    let (selected_model, resident_model, warm) = if phase == current.phase
        && matches!(
            phase,
            SttModelLifecyclePhase::Downloading | SttModelLifecyclePhase::Paused
        ) {
        (
            current.selected_model.clone(),
            current.resident_model.clone(),
            current.warm,
        )
    } else {
        runtime_fields(app, model_id)
    };
    let next = SttModelLifecycleSnapshot {
        phase,
        revision: next_revision(),
        downloaded_bytes: progress.downloaded_bytes.max(current.downloaded_bytes),
        total_bytes: progress
            .total_bytes
            .max(current.total_bytes)
            .max(progress.downloaded_bytes),
        speed_bps: progress.speed_bps,
        eta_seconds: progress.eta_seconds,
        verification_ms: progress.verification_ms.or(current.verification_ms),
        selected_model,
        resident_model,
        warm,
        error,
        ..current
    };
    lifecycles.insert(lifecycle_key, next.clone());
    drop(lifecycles);
    emit(app, &next);
    Ok(next)
}

/// Activation integration for the atomic switch transaction. A new correlated
/// request supersedes a terminal acquisition snapshot, while subsequent phases
/// must carry the same request id.
pub fn transition_activation(
    app: &AppHandle,
    model_id: &str,
    quantization: &str,
    request_id: &str,
    phase: SttModelLifecyclePhase,
    error: Option<String>,
) -> Result<SttModelLifecycleSnapshot, String> {
    let lifecycle_key = key(model_id, quantization);
    let needs_new_request = LIFECYCLES
        .lock_recover()
        .get(&lifecycle_key)
        .is_none_or(|snapshot| snapshot.request_id != request_id);
    if needs_new_request {
        if phase != SttModelLifecyclePhase::Loading && !phase.is_terminal() {
            return Err(format!(
                "new activation request '{request_id}' must begin at loading or a terminal cancellation/failure"
            ));
        }
        let (selected_model, resident_model, warm) = runtime_fields(app, model_id);
        let snapshot = SttModelLifecycleSnapshot {
            model_id: model_id.to_string(),
            quantization: quantization.to_string(),
            phase,
            request_id: request_id.to_string(),
            revision: next_revision(),
            downloaded_bytes: 0,
            total_bytes: 0,
            speed_bps: 0,
            eta_seconds: 0,
            verification_ms: None,
            selected_model,
            resident_model,
            warm,
            error,
        };
        LIFECYCLES
            .lock_recover()
            .insert(lifecycle_key, snapshot.clone());
        emit(app, &snapshot);
        return Ok(snapshot);
    }
    transition(app, model_id, quantization, request_id, phase, None, error)
}

pub fn snapshots() -> Vec<SttModelLifecycleSnapshot> {
    LIFECYCLES.lock_recover().values().cloned().collect()
}

#[tauri::command]
#[specta::specta]
pub fn stt_model_lifecycle_snapshots() -> Vec<SttModelLifecycleSnapshot> {
    snapshots()
}

fn valid_transition(from: SttModelLifecyclePhase, to: SttModelLifecyclePhase) -> bool {
    use SttModelLifecyclePhase as P;
    from == to
        || matches!(
            (from, to),
            (
                P::Queued,
                P::Downloading | P::Paused | P::Ready | P::Failed | P::Cancelled
            ) | (
                P::Downloading,
                P::Paused | P::Verifying | P::Failed | P::Cancelled
            ) | (P::Paused, P::Downloading | P::Failed | P::Cancelled)
                | (P::Verifying, P::Installing | P::Failed | P::Cancelled)
                | (
                    P::Installing,
                    P::Ready | P::Loading | P::Failed | P::Cancelled
                )
                | (P::Loading, P::Warming | P::Failed | P::Cancelled)
                | (P::Warming, P::Active | P::Failed | P::Cancelled)
                | (
                    P::Ready | P::Active | P::Failed | P::Cancelled,
                    P::Queued | P::Loading
                )
        )
}

#[cfg(test)]
fn reset_for_tests() {
    LIFECYCLES.lock_recover().clear();
    REVISION.store(0, Ordering::Release);
    REQUEST_SEQUENCE.store(0, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::{SttModelLifecyclePhase as P, reset_for_tests, valid_transition};

    #[test]
    fn acquisition_and_activation_happy_paths_are_valid() {
        reset_for_tests();
        for transition in [
            (P::Queued, P::Downloading),
            (P::Queued, P::Paused),
            (P::Downloading, P::Paused),
            (P::Paused, P::Downloading),
            (P::Downloading, P::Verifying),
            (P::Verifying, P::Installing),
            (P::Installing, P::Ready),
            (P::Ready, P::Loading),
            (P::Loading, P::Warming),
            (P::Warming, P::Active),
        ] {
            assert!(valid_transition(transition.0, transition.1));
        }
    }

    #[test]
    fn contradictory_or_reversed_transitions_are_rejected() {
        reset_for_tests();
        for transition in [
            (P::Queued, P::Warming),
            (P::Paused, P::Verifying),
            (P::Failed, P::Active),
            (P::Active, P::Downloading),
            (P::Warming, P::Downloading),
        ] {
            assert!(!valid_transition(transition.0, transition.1));
        }
    }
}
