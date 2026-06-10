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
    /// The shared overlay window was shown.
    pub const OVERLAY_SHOW: &str = "overlay:show";
    /// The shared overlay window was hidden.
    pub const OVERLAY_HIDE: &str = "overlay:hide";
    /// Startup progress tick (splash window + parity broadcast).
    pub const STARTUP_PROGRESS: &str = "startup:progress";
    /// Startup finished.
    pub const STARTUP_COMPLETE: &str = "startup:complete";
    /// Proper nouns the cleanup model identified during the last structured-output pass.
    pub const LLM_LEARNED_PROPER_NOUNS: &str = "llm:learned-proper-nouns";
    /// Manual "check for updates" trigger (main → renderer fan-out).
    pub const UPDATER_CHECK: &str = "updater:check";
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
