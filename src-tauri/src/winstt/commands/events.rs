// Specta-typed events the WinSTT port emits. Each derives the same set as the
// `HistoryUpdatePayload` (Clone + Serialize + Deserialize + specta::Type +
// tauri_specta::Event) so it can be registered in `collect_events![]` and emitted
// type-safely via the `Event` trait (`Payload { .. }.emit(&app)`).
//
// lib_wiring.md §4a lists these under `winstt::stt::*` / `winstt::wakeword::*`,
// but those modules predate this slice; centralizing them here keeps the heavy
// engine/wakeword modules free of specta deps. The orchestrator collects them as
// `winstt::commands::events::*` (note in modDecls/libWiring).
//
// NOTE: high-frequency streaming channels (llm:reasoning-delta, tts:chunk,
// stt:cloud-error, file-transcribe-progress, wakeword:detected, realtime-*) are
// emitted as PLAIN string events from the managers (matching WinSTT's IPC shape
// so the reused renderer's listeners work unchanged — lib_wiring §4b). The typed
// events below are the structured payloads the renderer consumes type-safely.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};
use tauri_specta::Event;

/// Canonical backend event names. Every renderer-facing event the backend emits
/// is named here ONCE (`namespace:kebab`) so the emit site and the frontend
/// listener can never drift independently — the renamed string lives in exactly
/// one place. The `emit-coverage` frontend test asserts each ROUTE event resolves
/// to one of these consts, and each const has a frontend listener (or an explicit
/// allowlist entry). Add a const here when introducing a new event.
pub mod names {
    /// Wake-word detected (INACTIVE → LISTENING cue). Renderer reshapes to `{ word }`.
    pub const WAKEWORD_DETECTED: &str = "wakeword:detected";
    /// Raw realtime preview (pre-stabilization) — drives the noise-break heuristic.
    pub const REALTIME_UPDATE: &str = "realtime:update";
    /// UI-safe MONOTONIC realtime preview (stabilizer output).
    pub const REALTIME_STABILIZED: &str = "realtime:stabilized";
    /// Model load/swap lifecycle changed — refreshes the tray menu.
    pub const MODEL_STATE_CHANGED: &str = "model:state-changed";
    /// A paste into the focused app failed (clipboard/typing path).
    pub const PASTE_ERROR: &str = "output:paste-error";
    /// A recording could not start / aborted with an error.
    pub const RECORDING_ERROR: &str = "recording:error";
    /// WASAPI loopback capture started for Listen mode.
    pub const LOOPBACK_STARTED: &str = "stt:loopback-started";
    /// WASAPI loopback capture stopped for Listen mode.
    pub const LOOPBACK_STOPPED: &str = "stt:loopback-stopped";
    /// Authoritative ongoing Listen-session transcript snapshot.
    pub const LISTEN_SESSION_CHANGED: &str = "listen:session-changed";
    /// An atomic STT model transaction started.
    pub const STT_MODEL_SWAP_STARTED: &str = "stt:model-swap-started";
    /// An atomic STT model transaction committed.
    pub const STT_MODEL_SWAP_COMPLETED: &str = "stt:model-swap-completed";
    /// An atomic STT model transaction failed or was superseded.
    pub const STT_MODEL_SWAP_FAILED: &str = "stt:model-swap-failed";
    /// Authoritative per-model/quant acquisition and activation snapshot.
    pub const STT_MODEL_LIFECYCLE: &str = "stt:model-lifecycle";
    /// Authoritative selected/resident STT runtime snapshot.
    pub const STT_RUNTIME_INFO: &str = "stt:runtime-info";
    /// The shared overlay window was shown.
    pub const OVERLAY_SHOW: &str = "overlay:show";
    /// The shared overlay window should animate out; payload is its hide generation.
    pub const OVERLAY_HIDE: &str = "overlay:hide";
    /// Startup progress tick (splash window + parity broadcast).
    pub const STARTUP_PROGRESS: &str = "startup:progress";
    /// Startup finished.
    pub const STARTUP_COMPLETE: &str = "startup:complete";
    /// Proper nouns the cleanup model identified during the last structured-output pass.
    pub const LLM_LEARNED_PROPER_NOUNS: &str = "llm:learned-proper-nouns";
    /// Cycle to the next saved post-processing profile in renderer-owned order.
    pub const LLM_PROFILE_SWAP: &str = "llm:profile-swap";
    /// A per-app post-processing rule matched at recording start.
    pub const LLM_APP_PROFILE_ACTIVE: &str = "llm:app-profile-active";
    /// The transcribe (PTT) hotkey was held while ArrowUp was pressed — advance to
    /// the next recording mode (ptt → toggle → listen → wakeword → ptt). Emitted by
    /// the WinSTT-owned cycle-gesture keyboard hook; the main renderer owns the
    /// mode-cycle order and applies + persists the new mode.
    pub const RECORDING_MODE_CYCLE: &str = "recording:mode-cycle";
    /// A recording-mode change is preparing (loading the new mode's model) or has
    /// settled. Drives the mode switcher's spinner + disabled state.
    pub const RECORDING_MODE_TRANSITION: &str = "recording:mode-transition";
    /// Manual "check for updates" trigger (main → renderer fan-out).
    pub const UPDATER_CHECK: &str = "updater:check";
    /// The settings window was shown by `open_window` (payload: whether it was
    /// already visible). The keep-alive settings renderer replays its enter
    /// animation on this — window focus/visibility are not reliably delivered
    /// by WebView2 across a native hide/show cycle.
    pub const SETTINGS_WINDOW_SHOWN: &str = "settings:window-shown";
    /// Fresh RAM/VRAM snapshot delivered to the prewarmed footprint renderer
    /// immediately before its hover window is shown.
    pub const MODEL_FOOTPRINT_RESOURCES: &str = "model-footprint:resources";
    /// Latest window-local panel rectangle for the detached model picker.
    pub const MODEL_PICKER_ANCHOR: &str = "model-picker:anchor";
    /// Model-picker close generation whose renderer animation must complete.
    pub const MODEL_PICKER_CLOSING: &str = "model-picker:closing";
    /// One existing, privacy-gated app log record for Settings > About.
    pub const DIAGNOSTICS_LOG_LINE: &str = "diagnostics:log-line";
    /// Encoder-dictionary model download progress/status changed.
    pub const ENCODER_DICT_DOWNLOAD_PROGRESS: &str = "encoder-dict:download-progress";
    /// Encoder-dictionary model download reached a terminal outcome.
    pub const ENCODER_DICT_DOWNLOAD_COMPLETE: &str = "encoder-dict:download-complete";
    /// The downloaded encoder-dictionary model could not be loaded.
    pub const ENCODER_DICT_MODEL_ERROR: &str = "encoder-dict:model-error";
}

/// Emit the shared `output:paste-error` event. Centralizes the previously
/// duplicated `paste-error` emits (clipboard / preview / transcribe / loopback
/// paths all signal the same renderer toast).
pub fn emit_paste_error(app: &AppHandle) {
    let _ = app.emit(names::PASTE_ERROR, ());
}

/// Raw realtime preview (pre-stabilization) — drives the noise-break heuristic.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeUpdatePayload {
    pub text: String,
    pub is_final: bool,
}

/// Wake-word detected (INACTIVE → LISTENING transition cue).
///
/// Emitted as a PLAIN string event (`names::WAKEWORD_DETECTED`) rather than a
/// typed `collect_events!` payload: the renderer listens on the exact event
/// string and reshapes the JSON, and a Rust-internal listener (lib.rs) starts a
/// dictation cycle off the same string. This struct just fixes the emitted shape.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeWordDetectedPayload {
    pub word: String,
    pub word_index: i32,
}
