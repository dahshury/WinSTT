// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/05_*.md (Loopback/Diarization)
// + lib_wiring.md §3, server listen mode. Wraps managers::{LoopbackManager, DiarizationManager}.
//
// Listen-mode commands. start_listen turns on WASAPI loopback capture (system
// audio → the same recording pipeline) and diarization; stop_listen turns both
// off. The diarized subtitles + speaker segments are emitted as events.

use std::sync::Arc;

use tauri::State;

use crate::winstt::managers::{DiarizationManager, LoopbackManager};

/// `start_listen` — begin loopback capture (+ diarization when requested).
#[tauri::command]
#[specta::specta]
pub fn start_listen(
    loopback: State<'_, Arc<LoopbackManager>>,
    diarization: State<'_, Arc<DiarizationManager>>,
    diarize: bool,
) -> Result<(), String> {
    diarization.set_enabled(diarize);
    diarization.reset();
    loopback.start()
}

/// `stop_listen` — stop loopback capture + diarization.
#[tauri::command]
#[specta::specta]
pub fn stop_listen(
    loopback: State<'_, Arc<LoopbackManager>>,
    diarization: State<'_, Arc<DiarizationManager>>,
) {
    loopback.stop();
    diarization.set_enabled(false);
}
