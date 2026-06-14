// The renderer's user-initiated cancel — overlay X button, and (in the reference build)
// the Escape shortcut — sends `STT_ABORT_OPERATION`, which the adapter
// (native-bridge-adapter.ts) routes to the Tauri command `cancel_current_operation`.
//
// In the reference build `handleAbortOperation` did:
//   markSessionAborted  (→ stt:session-aborted broadcast)
//   abort active Ollama chats
//   recorder.abort + clear_audio_queue
//   hide the overlay
//
// In the in-proc Tauri port those steps collapse onto the app's ONE centralized
// cancellation path: `crate::utils::cancel_current_operation` already
//   - cancels the in-flight recording (AudioRecordingManager::cancel_recording)
//   - flips the tray icon to Idle + hides the recording overlay
//   - unloads the model if immediate-unload is enabled
//   - notifies the TranscriptionCoordinator so lifecycle state stays coherent
// We add the WinSTT-specific epilogue — the `stt:session-aborted` broadcast — so the
// reused renderer's `onSessionAborted` listener (usePushToTalk's toggle `isActiveRef`
// reset + visualizer/pill teardown) fires exactly as it did under the reference.
//
// HARD-RULE-safe: NEW file under winstt/commands/. No lib.rs `.manage(...)` edit —
// it reuses the already-managed AudioRecordingManager / TranscriptionManager /
// TranscriptionCoordinator that `utils::cancel_current_operation` reads.

use tauri::AppHandle;

use crate::winstt::commands::dictation::SttEvents;

/// `cancel_current_operation` — abort the in-flight dictation session and reset
/// renderer state. Routes from `STT_ABORT_OPERATION` (overlay X / Escape).
/// Runs the centralized cancel path, then broadcasts `stt:session-aborted` so the
/// renderer drops its local "session active" state. Mirrors `handleAbortOperation`.
#[tauri::command]
#[specta::specta]
pub fn cancel_current_operation(app: AppHandle) {
    // The single source-of-truth cancel: stop recording, reset tray+overlay,
    // maybe-unload, notify coordinator.
    let cancelled = crate::utils::cancel_current_operation(&app);
    // WinSTT epilogue: tell the renderer a user-initiated cancel just landed so it
    // can reset toggle-mode / visualizer / pill state (the renderer's
    // `onSessionAborted` → usePushToTalk `isActiveRef` reset).
    if cancelled {
        SttEvents::session_aborted(&app);
    }
}
