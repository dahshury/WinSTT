// Recording-mode transition PHASE — the renderer-facing "preparing" window that
// spans the model work a mode change triggers.
//
// `settings::RECORDING_MODE_TRANSITIONS_IN_FLIGHT` already guards the narrow
// teardown window inside `apply_settings_patch` (it exists so `start_listen`
// can't open loopback over a still-live PTT capture). That guard is deliberately
// short: it lives on the settings command thread and must NOT be held across a
// model load, or `start_listen` would deadlock waiting on a transition that is
// itself waiting for `start_listen`.
//
// This module owns the LONGER, UI-facing half of the same boundary: from the
// moment a mode change is committed until the new mode's engine is actually able
// to transcribe. That covers
//   * Listen → Ptt/Toggle/Wakeword — the shared engine still holds the streaming
//     model, so the main model has to be loaded before the first dictation (the
//     stall users saw at the END of their first utterance);
//   * any mode → Listen — `start_listen` loads the native-streaming model before
//     opening WASAPI (the "listen mode is dead for 3-5 seconds" report);
//   * any mode → Wakeword — the KWS bundle is built into an ORT session on arm.
// Ptt ↔ Toggle loads nothing, so it reports Ready immediately and the UI never
// flickers a spinner for it.
//
// The state is process-global (a mode change can originate from the settings
// window, the tray menu, or the PTT+ArrowUp cycle gesture) and is published as
// the plain `recording:mode-transition` event plus a pull command for windows
// that mount mid-transition.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

use crate::winstt::commands::events::names;
use crate::winstt::settings_schema::RecordingMode;

/// Lifecycle of one mode change, as the renderer sees it.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModeTransitionPhase {
    /// No mode change is being prepared — controls are live.
    Idle,
    /// A mode change is committed but its engine is not usable yet.
    Preparing,
    /// The target mode's engine is loaded and ready to transcribe.
    Ready,
    /// Preparation failed; `error` carries the reason. Controls unlock so the
    /// user can pick a different mode.
    Failed,
}

impl ModeTransitionPhase {
    /// Both terminal phases leave the controls interactive; only `Preparing`
    /// locks them.
    fn is_settled(self) -> bool {
        !matches!(self, Self::Preparing)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModeTransitionPayload {
    /// Monotonic id of the transition this phase belongs to. A late `Ready` from
    /// a superseded transition carries an older generation and is dropped.
    pub generation: u64,
    pub from: RecordingMode,
    pub to: RecordingMode,
    pub phase: ModeTransitionPhase,
    pub error: Option<String>,
}

impl ModeTransitionPayload {
    fn idle() -> Self {
        Self {
            generation: 0,
            from: RecordingMode::Ptt,
            to: RecordingMode::Ptt,
            phase: ModeTransitionPhase::Idle,
            error: None,
        }
    }
}

static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Mirrors `STATE.phase == Preparing` so the hotkey thread can gate a press
/// without taking the state mutex on its hot path.
static PREPARING: AtomicBool = AtomicBool::new(false);
static STATE: Lazy<Mutex<ModeTransitionPayload>> =
    Lazy::new(|| Mutex::new(ModeTransitionPayload::idle()));

fn lock_state() -> std::sync::MutexGuard<'static, ModeTransitionPayload> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn publish(app: &AppHandle, payload: &ModeTransitionPayload) {
    PREPARING.store(
        matches!(payload.phase, ModeTransitionPhase::Preparing),
        Ordering::Release,
    );
    let _ = app.emit(names::RECORDING_MODE_TRANSITION, payload);
}

/// Open a transition. Returns its generation — pass it back to
/// [`complete`] / [`fail`] so a superseded transition can't settle a newer one.
pub(crate) fn begin(app: &AppHandle, from: RecordingMode, to: RecordingMode) -> u64 {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let payload = {
        let mut state = lock_state();
        *state = ModeTransitionPayload {
            generation,
            from,
            to,
            phase: ModeTransitionPhase::Preparing,
            error: None,
        };
        state.clone()
    };
    log::info!("[recording-mode] preparing {from:?} -> {to:?} (generation {generation})");
    publish(app, &payload);
    generation
}

fn settle(
    app: &AppHandle,
    generation: u64,
    phase: ModeTransitionPhase,
    error: Option<String>,
) -> bool {
    let payload = {
        let mut state = lock_state();
        // A newer transition already owns the UI; this one lost the race and
        // must not clear its spinner.
        if state.generation != generation || state.phase.is_settled() {
            return false;
        }
        state.phase = phase;
        state.error = error;
        state.clone()
    };
    match payload.phase {
        ModeTransitionPhase::Failed => log::warn!(
            "[recording-mode] preparation for {:?} failed: {}",
            payload.to,
            payload.error.as_deref().unwrap_or("unknown error")
        ),
        _ => log::info!("[recording-mode] {:?} is ready", payload.to),
    }
    publish(app, &payload);
    true
}

pub(crate) fn complete(app: &AppHandle, generation: u64) {
    settle(app, generation, ModeTransitionPhase::Ready, None);
}

pub(crate) fn fail(app: &AppHandle, generation: u64, error: impl Into<String>) {
    settle(
        app,
        generation,
        ModeTransitionPhase::Failed,
        Some(error.into()),
    );
}

/// The generation of the in-flight transition into `target`, if one is waiting.
/// Used by the runtime that the transition handed off to (Listen's
/// renderer-driven `start_listen`) so it can settle the phase it inherited
/// without knowing the generation up front.
pub(crate) fn pending_generation_for(target: RecordingMode) -> Option<u64> {
    let state = lock_state();
    (state.phase == ModeTransitionPhase::Preparing && state.to == target)
        .then_some(state.generation)
}

/// Settle an inherited transition into `target`. No-op when the mode has moved
/// on (the user switched away while the runtime was still starting).
pub(crate) fn complete_pending_for(app: &AppHandle, target: RecordingMode) {
    if let Some(generation) = pending_generation_for(target) {
        complete(app, generation);
    }
}

pub(crate) fn fail_pending_for(app: &AppHandle, target: RecordingMode, error: impl Into<String>) {
    if let Some(generation) = pending_generation_for(target) {
        fail(app, generation, error);
    }
}

/// True while a mode change is committed but not yet usable. Read by the hotkey
/// dispatch path so a PTT/toggle press during the switch can't start a recording
/// against an engine that is mid-load.
pub(crate) fn is_preparing() -> bool {
    PREPARING.load(Ordering::Acquire)
}

/// Whether `generation` is still the transition the UI is showing.
pub(crate) fn is_current_generation(generation: u64) -> bool {
    lock_state().generation == generation
}

/// Serializes the two paths that load a model on behalf of a mode change: the
/// preparation worker (main model, on leaving Listen) and `start_listen` (native
/// streaming model, on entering it). They share ONE engine slot, and
/// `TranscriptionManager`'s own loading flag only makes them queue — it does not
/// order them. Without this lock, `listen → ptt → listen` typed faster than a load
/// takes could let the main-model load win the race and evict the streaming model
/// out from under a live listen session.
///
/// The worker re-checks [`is_current_generation`] after acquiring, so a
/// preparation that lost its claim while waiting skips its load entirely instead
/// of stomping the winner.
static MODEL_PREPARATION_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn lock_model_preparation() -> std::sync::MutexGuard<'static, ()> {
    MODEL_PREPARATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Current phase for a window that mounted (or was re-shown) mid-transition —
/// events alone would leave it showing a live control during a switch.
#[tauri::command]
#[specta::specta]
pub fn recording_mode_transition_state() -> ModeTransitionPayload {
    lock_state().clone()
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    *lock_state() = ModeTransitionPayload::idle();
    PREPARING.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The transition state is process-global by design, so these tests can't run
    /// concurrently with each other — one test's `begin` would bump the generation
    /// another is mid-assertion on.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn serialized() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reset_for_test();
        guard
    }

    // The state machine is exercised without an AppHandle by driving the same
    // mutex the emit path reads; `publish` is the only piece needing Tauri.
    fn begin_headless(from: RecordingMode, to: RecordingMode) -> u64 {
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let mut state = lock_state();
        *state = ModeTransitionPayload {
            generation,
            from,
            to,
            phase: ModeTransitionPhase::Preparing,
            error: None,
        };
        PREPARING.store(true, Ordering::Release);
        generation
    }

    fn settle_headless(generation: u64, phase: ModeTransitionPhase) -> bool {
        let mut state = lock_state();
        if state.generation != generation || state.phase.is_settled() {
            return false;
        }
        state.phase = phase;
        PREPARING.store(false, Ordering::Release);
        true
    }

    #[test]
    fn ready_clears_the_preparing_flag() {
        let _serialized = serialized();
        let generation = begin_headless(RecordingMode::Ptt, RecordingMode::Listen);
        assert!(is_preparing());
        assert!(settle_headless(generation, ModeTransitionPhase::Ready));
        assert!(!is_preparing());
    }

    #[test]
    fn a_superseded_generation_cannot_settle_the_current_transition() {
        let _serialized = serialized();
        let stale = begin_headless(RecordingMode::Ptt, RecordingMode::Listen);
        let current = begin_headless(RecordingMode::Listen, RecordingMode::Ptt);
        assert!(!settle_headless(stale, ModeTransitionPhase::Ready));
        assert!(is_preparing());
        assert!(settle_headless(current, ModeTransitionPhase::Ready));
        assert!(!is_preparing());
    }

    #[test]
    fn settling_twice_is_a_no_op() {
        let _serialized = serialized();
        let generation = begin_headless(RecordingMode::Ptt, RecordingMode::Wakeword);
        assert!(settle_headless(generation, ModeTransitionPhase::Ready));
        assert!(!settle_headless(generation, ModeTransitionPhase::Failed));
        assert_eq!(lock_state().phase, ModeTransitionPhase::Ready);
    }

    #[test]
    fn pending_generation_matches_only_the_live_target() {
        let _serialized = serialized();
        let generation = begin_headless(RecordingMode::Ptt, RecordingMode::Listen);
        assert_eq!(
            pending_generation_for(RecordingMode::Listen),
            Some(generation)
        );
        assert_eq!(pending_generation_for(RecordingMode::Ptt), None);
        assert!(settle_headless(generation, ModeTransitionPhase::Ready));
        assert_eq!(pending_generation_for(RecordingMode::Listen), None);
    }
}
