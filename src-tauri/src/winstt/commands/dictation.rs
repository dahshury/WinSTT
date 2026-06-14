// Main window dictation core (overlay + PTT + live transcription).
// Reference: frontend/src/shared/api/ipc-client.ts
// (sttSetParameter / sttGetParameter / sttCallMethod / sttReloadModel wrappers).
//
// The STT dictation-core command seam the reused renderer drives. WinSTT's renderer
// never talks to the recorder directly — it goes through three generic primitives:
//   - sttSetParameter(parameter, value)  → STT_SET_PARAMETER  → winstt_set_parameter
//   - sttGetParameter(parameter)         → STT_GET_PARAMETER  → winstt_get_parameter
//   - sttCallMethod(method, args)        → STT_CALL_METHOD    → winstt_call_method
//   - sttReloadModel(kind, name)         → STT_RELOAD_MODEL   → set_winstt_model
// (the adapter ROUTE map in native-bridge-adapter.ts encodes exactly these names).
//
// This file ALSO centralizes the STT lifecycle/level *event* emitters (the MISSING
// set flagged for WU-3): recording-start/stop, vad-start/stop, transcription-start,
// full-sentence, no-audio-detected, transcription-failed, audio-level, connection
// -change, server-status, session-aborted. They are emitted as PLAIN string events
// (NOT specta-collected) in WinSTT's byte-identical IPC shape so the reused renderer's
// `onRecordingStart`/`onFullSentence`/`onAudioLevel`/… listeners work unchanged
// (lib_wiring.md §4b). The emit call sites live inside core files (the
// transcription coordinator / audio consumer / VAD loop); this module gives them a
// single typed helper so those one-liner edits stay mechanical (see libWiring note).

use tauri::{AppHandle, Emitter, Manager};

use crate::managers::audio::AudioRecordingManager;
use crate::winstt::commands::settings::read_settings;
use crate::winstt::managers::diarization_manager::DiarizationManager;
use crate::TranscriptionCoordinator;
use std::sync::Arc;

/// The transcribe binding id the dictation pipeline drives. The renderer owns the
/// hotkey (PTT/toggle) and only sends `set_microphone(true/false)`; on the backend
/// that flips the recorder through the coordinator using this binding so the
/// existing TranscribeAction (model preload + overlay + paste pipeline) runs.
const DICTATION_BINDING: &str = "transcribe";

// ── STT_SET_PARAMETER / STT_GET_PARAMETER ──────────────────────────────────────
//
// WinSTT's `sttSetParameter` sends `{ parameter, value }` (ipc-client.ts L204);
// `value` is an arbitrary JSON scalar (bool / number / string / base64), kept as
// `serde_json::Value` so every AllowedParameter shape round-trips without a per-key
// enum. The adapter's `normalizeArgs` forwards the object verbatim, so Tauri maps
// `{ parameter, value }` onto the two named params below.

/// `winstt_set_parameter` — the hot-swappable knob path. WU-3's slices push three:
///   - `silence_endpoint_enabled` (bool) — PTT disables the VAD silence endpoint
///   - `silence_timing` (bool)           — PTT disables smart-endpoint pause tuning
///   - `is_recording` (bool)             — recorder state mirror
/// The full AllowedParameter set (spec/openapi.yaml) covers ~40 keys also driven by
/// other slices (model/quant/prompt/vad); each routes here. The recorder-config
/// knobs that don't need an immediate reaction are folded into the live recorder
/// settings; the rest are accepted as no-ops until their owning subsystem lands so
/// the renderer's fire-and-forget `send()` never errors.
///
/// Every persisted setting is owned SOLELY by `WinsttSettings` (written via
/// `winstt_set_settings`, read straight from there by the STT pipeline): `language` /
/// `translate_to_english` / `custom_words` / `initial_prompt` from the STT config, and
/// `model_unload_timeout_seconds` whose on-save handler (`apply_model_runtime_settings`)
/// mirrors the value into the `AppSettings` shadow AND warms/reloads the model. So this
/// command has NO settings-write branch — there is no second AppSettings-shadow write
/// path. `onnx_quantization` / `model` trigger a reload through the model slice; all of
/// these are accepted here as no-ops so the renderer's fire-and-forget `send()` (if ever
/// sent) never errors (the reference's `set_parameter` was also best-effort).
#[tauri::command]
#[specta::specta]
pub fn winstt_set_parameter(app: AppHandle, parameter: String, value: serde_json::Value) {
    match parameter.as_str() {
        // Recorder auto-stop disables — applied to the live audio manager so a PTT
        // hold can't be ended early by the VAD silence endpoint / smart-endpoint
        // pause (memory: project_ptt_silence_endpoint_sync_race). In this in-proc
        // port the PTT key release is the authoritative recording boundary
        // (set_microphone(false) stops the recorder directly), so the VAD silence
        // endpoint never gets a chance to end a PTT hold early — the flag is a
        // structural ack. Recorded for completeness; the behavioural guarantee is
        // already provided by the explicit-stop architecture.
        "silence_endpoint_enabled" | "silence_timing" | "smart_endpoint_enabled" => {
            if let Some(rm) = app.try_state::<Arc<AudioRecordingManager>>() {
                apply_endpoint_flag(&rm, &parameter, value.as_bool().unwrap_or(false));
            }
        }
        "is_recording" => {
            // Renderer-driven mirror only; the manager owns the authoritative flag.
        }
        // Every other AllowedParameter (model/quant/prompt/vad knobs + the
        // WinsttSettings-owned `language`/`translate_to_english`/`custom_words`/
        // `model_unload_timeout_seconds`) is owned by its subsystem slice or persisted
        // canonically via `winstt_set_settings`; accept silently so the renderer's
        // send() is a no-fail fire-and-forget (the reference's set_parameter was also
        // best-effort).
        _ => {}
    }
}

/// `winstt_get_parameter` — the few readbacks the renderer issues (e.g. recorder
/// state). Returns `null` for unknown keys (the renderer's `invokeOrDefault`
/// supplies its declared fallback).
#[tauri::command]
#[specta::specta]
pub fn winstt_get_parameter(app: AppHandle, parameter: String) -> serde_json::Value {
    match parameter.as_str() {
        "is_recording" => app
            .try_state::<Arc<AudioRecordingManager>>()
            .map(|rm| serde_json::Value::Bool(rm.is_recording()))
            .unwrap_or(serde_json::Value::Bool(false)),
        _ => serde_json::Value::Null,
    }
}

/// Apply a recorder auto-stop disable flag. Kept as a single function so the
/// 04_* VAD plumb-through (when the live recorder config is mutable in place) has
/// exactly one site to wire; until then it is a structural no-op that never panics.
fn apply_endpoint_flag(_rm: &AudioRecordingManager, _parameter: &str, _enabled: bool) {
    // SPIKE (04_* VAD): forward to the live VAD/endpointing config on the recorder.
    // The PTT race fix only requires that this CALL succeed synchronously before the
    // microphone is opened — which it does. The behavioural effect lands with VAD.
}

// ── STT_CALL_METHOD ─────────────────────────────────────────────────────────────

/// `winstt_call_method` — dispatch the ~3 recorder methods the renderer invokes by
/// name (ipc-client.ts `sttCallMethod`). WinSTT bundles `wakeup()` with
/// `set_microphone(true)` server-side; here `set_microphone(true)` starts the
/// dictation recording through the coordinator (which runs the TranscribeAction
/// = model preload + overlay + paste pipeline) and `set_microphone(false)` stops it.
#[tauri::command]
#[specta::specta]
pub fn winstt_call_method(app: AppHandle, method: String, args: Option<Vec<serde_json::Value>>) {
    let args = args.unwrap_or_default();
    match method.as_str() {
        "set_microphone" => {
            let on = args.first().and_then(|v| v.as_bool()).unwrap_or(false);
            set_microphone(&app, on);
        }
        // abort/stop/shutdown → cancel the in-flight session (discard recording +
        // abort cleanup + hide overlay). Mirrors STT_ABORT_OPERATION exactly so a
        // method-style abort and the wrapper-style abort converge on one path: run
        // the centralized cancel, then broadcast `stt:session-aborted` (same epilogue
        // as winstt::commands::cancel::cancel_current_operation) so the renderer's
        // onSttSessionAborted resets toggle/visualizer/pill state. Without this the
        // renderer's `abortServerRecorderIfConnected("abort")` path would tear down
        // the recorder but leave the pill armed.
        "abort" | "stop" | "shutdown" => {
            if crate::utils::cancel_current_operation(&app) {
                SttEvents::session_aborted(&app);
            }
        }
        "clear_audio_queue" => {
            if let Some(rm) = app.try_state::<Arc<AudioRecordingManager>>() {
                rm.cancel_recording();
            }
        }
        "wakeup" => {
            // wakeup() alone (no mic) — a no-op start hint; the recorder is woken
            // lazily by set_microphone in this port (engine is in-proc, no warm
            // round-trip to a separate server process to amortize).
        }
        "request_diarization_toggle" => {
            let enabled = args.first().and_then(|v| v.as_bool()).unwrap_or(false);
            request_diarization_toggle(&app, enabled);
        }
        // `text` (inject text) and any other server method have no renderer caller in
        // the WU-3 surface; accept silently.
        _ => {}
    }
}

/// Start (on=true) / stop (on=false) the dictation recording via the
/// coordinator. `push_to_talk: true` makes the press start and the release stop
/// (matching WinSTT's PTT, where the renderer sends mic on at press and mic off at
/// release). Toggle mode in WinSTT also routes through this same set_microphone
/// pair (the renderer flips currentActive), so push_to_talk semantics are correct
/// for both: each call is an explicit start or explicit stop of THIS binding.
fn set_microphone(app: &AppHandle, on: bool) {
    let Some(coordinator) = app.try_state::<TranscriptionCoordinator>() else {
        return;
    };
    coordinator.send_input(DICTATION_BINDING, "", on, true);
}

/// Toggle listen-mode diarization at runtime (request_diarization_toggle). Emits the
/// diarization-toggle lifecycle events the renderer listens for. Diarization wiring
/// proper is WU-9 (05_* listen/diar); this only flips the manager flag + reports it.
fn request_diarization_toggle(app: &AppHandle, enabled: bool) {
    // Payload shapes are byte-identical to WinSTT's DiarizationTogglePayload
    // (`{ enabled }`) and DiarizationToggleCompletedPayload (`{ enabled, message }`).
    let _ = app.emit(
        "stt:diarization-toggle-started",
        serde_json::json!({ "enabled": enabled }),
    );
    let applied = app
        .try_state::<Arc<DiarizationManager>>()
        .map(|dm| dm.set_enabled(enabled))
        .unwrap_or(false);
    let message = if applied {
        "Diarization enabled"
    } else {
        "Diarization disabled"
    };
    let _ = app.emit(
        "stt:diarization-toggle-completed",
        serde_json::json!({ "enabled": applied, "message": message }),
    );
}

// ── STT_RELOAD_MODEL ────────────────────────────────────────────────────────────

/// `set_winstt_model` — request a (main | realtime) model reload. The reused
/// renderer's `sttReloadModel(kind, name, quantization?)` sends `{ kind, name, quantization }`. The actual engine
/// swap is WU-4 (lib_wiring §7, internal to TranscriptionManager); for WU-3 this
/// kicks `initiate_model_load` so the main-model reload path is live, and
/// returns a structural ack. Realtime-kind reloads are owned by 04_*.
#[tauri::command]
#[specta::specta]
pub fn set_winstt_model(app: AppHandle, kind: String, name: String, quantization: Option<String>) {
    if kind == "realtime" {
        // SPIKE (04_*): realtime worker model rebuild — owned by the realtime slice.
        return;
    }
    // Drive the FULL swap lifecycle (started → load → completed/failed + runtime-info push) so the
    // picker's "Switching…" chip resolves and a FAILED load surfaces as `stt:model-swap-failed`
    // (rollback + toast) instead of being swallowed → the renderer silently adopting runtime "tiny".
    crate::winstt::commands::swap_events::perform_model_swap_with_quantization(
        &app,
        &kind,
        &name,
        quantization.as_deref(),
    );
}

// ── STT lifecycle / level EVENT emitters (MISSING set — WU-3) ───────────────────
//
// Plain string events in WinSTT's byte-identical IPC shape. The renderer's
// ipc-client.ts wrappers read: onRealtimeText → `{text,is_final}`, onFullSentence → `{text}`,
// onAudioLevel → `{level}`, onTranscriptionStart → `{audioBase64}`, onConnectionChange
// → `{connected}`, onServerStatus → `{status}`; the no-payload events
// (recording-start/stop, vad-start/stop, no-audio-detected, transcription-failed,
// session-aborted) carry nothing. Event NAMES match the adapter ROUTE map.

/// A thin facade so the core emit sites (coordinator / audio consumer / VAD
/// loop) have ONE typed entrypoint instead of scattered raw `app.emit("stt:...")`.
/// Every method swallows the emit error (a dropped lifecycle event must never crash
/// the audio thread). Usage from a wiring site: `SttEvents::recording_start(app)`.
pub struct SttEvents;

impl SttEvents {
    /// `stt:recording-start` — a new recording cycle began. The renderer wipes the
    /// realtime/ephemeral state and arms `isRecordingActive` (the overlay pill gate).
    pub fn recording_start(app: &AppHandle) {
        log::info!("[stt] emit stt:recording-start (visualizer arm)");
        // Ducking is sequenced by `TranscribeAction::start` (duck_then_play_recording_chime):
        // background audio is ducked BEFORE the chime plays, and the chime — played in
        // WinSTT's own protected process — is never attenuated.
        crate::tray::on_tray_recording_start(app);
        let _ = app.emit("stt:recording-start", ());
    }

    /// `stt:recording-stop` — the recorder stopped (VAD silence or PTT release). The
    /// renderer snaps the visualizer to zero; the pill stays until a terminal event.
    pub fn recording_stop(app: &AppHandle) {
        crate::winstt::ducking::request_restore();
        crate::tray::on_tray_recording_stop(app);
        let _ = app.emit("stt:recording-stop", ());
    }

    /// `stt:vad-start` — speech onset detected (drives `setSpeaking(true)`).
    pub fn vad_start(app: &AppHandle) {
        let _ = app.emit("stt:vad-start", ());
    }

    /// `stt:vad-stop` — speech offset (drives `setSpeaking(false)`).
    pub fn vad_stop(app: &AppHandle) {
        let _ = app.emit("stt:vad-stop", ());
    }

    /// `stt:transcription-start` — transcription kicked off; carries the recorded
    /// audio (base64) for history playback. `audio_base64` may be `None`.
    pub fn transcription_start(app: &AppHandle, audio_base64: Option<&str>) {
        crate::tray::on_tray_transcription_start(app);
        let _ = app.emit(
            "stt:transcription-start",
            serde_json::json!({ "audioBase64": audio_base64 }),
        );
    }

    /// `stt:full-sentence` — a finalized transcription (post-LLM-cleanup if enabled).
    /// `onFullSentence` reads `.text`. This is a TERMINAL event (resets pill).
    pub fn full_sentence(app: &AppHandle, text: &str) {
        crate::tray::on_tray_transcription_stop(app);
        crate::tray::on_tray_idle(app);
        let _ = app.emit("stt:full-sentence", serde_json::json!({ "text": text }));
    }

    /// `stt:preview-ready` — preview-before-pasting is on: the finalized text is
    /// held back from auto-paste so the renderer can show the editable preview
    /// pill. Carries both the RAW transcript (`original`, the re-process source)
    /// and the auto-processed `text` (what the pill shows). NOT terminal — the
    /// pill stays up via `isPreviewActive` until `confirm_paste`/`cancel_preview`.
    /// Same renderer event as `full_sentence`, but without dictation terminal side effects.
    /// Listen mode keeps capturing after each transcript row.
    pub fn listen_sentence(app: &AppHandle, text: &str) {
        let _ = app.emit("stt:full-sentence", serde_json::json!({ "text": text }));
    }

    pub fn preview_ready(app: &AppHandle, original: &str, text: &str) {
        let _ = app.emit(
            "stt:preview-ready",
            serde_json::json!({ "original": original, "text": text }),
        );
    }

    /// `stt:no-audio-detected` — the recorder captured nothing usable. TERMINAL.
    pub fn no_audio_detected(app: &AppHandle) {
        crate::winstt::ducking::request_restore();
        crate::tray::on_tray_transcription_stop(app);
        crate::tray::on_tray_idle(app);
        let _ = app.emit("stt:no-audio-detected", ());
    }

    /// `stt:transcription-failed` — a genuine transcriber error (honest pill vs the
    /// misleading "no audio detected"). TERMINAL. Memory:
    /// project_whisper_incomplete_vocab_and_transcription_failed.
    pub fn transcription_failed(app: &AppHandle, message: Option<&str>) {
        crate::winstt::ducking::request_restore();
        crate::tray::on_tray_transcription_stop(app);
        crate::tray::on_tray_idle(app);
        let _ = app.emit(
            "stt:transcription-failed",
            serde_json::json!({ "message": message }),
        );
    }

    /// `stt:audio-level` — RMS audio level (0.0..1.0) for the live visualizer.
    /// High-frequency: emitted per audio chunk from the consumer; `onAudioLevel`
    /// reads `.level`.
    pub fn audio_level(app: &AppHandle, level: f32) {
        crate::tray::on_tray_audio_level(app, level);
        let _ = app.emit("stt:audio-level", serde_json::json!({ "level": level }));
    }

    /// `stt:realtime-text` — the live (raw) realtime preview. NOTE: the adapter maps
    /// STT_REALTIME_TEXT → the `realtime:update` event
    /// (RealtimeUpdatePayload `{text,is_final}`), so the realtime worker emits THAT; this
    /// helper exists for parity / direct use.
    /// ORDERING (risk §6): emit `realtime:stabilized` BEFORE `realtime:update`.
    pub fn realtime_text(app: &AppHandle, text: &str) {
        Self::realtime_text_with_final(app, text, false);
    }

    pub fn realtime_text_with_final(app: &AppHandle, text: &str, is_final: bool) {
        let _ = app.emit(
            crate::winstt::commands::events::names::REALTIME_UPDATE,
            serde_json::json!({ "text": text, "is_final": is_final }),
        );
    }

    /// `realtime:stabilized` — the UI-safe MONOTONIC live preview (stabilizer output).
    /// Emitted BEFORE `realtime:update` on every realtime tick (mirrors RealtimeSTT's
    /// `on_realtime_transcription_stabilized` → `..._update` ordering in
    /// recorder_service.py:2852-2853). The renderer's live-preview pane consumes this;
    /// `realtime:update` carries the raw assembled text for noise-break/logging consumers.
    pub fn realtime_stabilized(app: &AppHandle, text: &str) {
        Self::realtime_stabilized_with_final(app, text, false);
    }

    pub fn realtime_stabilized_with_final(app: &AppHandle, text: &str, is_final: bool) {
        let _ = app.emit(
            crate::winstt::commands::events::names::REALTIME_STABILIZED,
            serde_json::json!({ "text": text, "is_final": is_final }),
        );
    }

    /// `stt:session-aborted` — a user-initiated cancel just landed. The renderer
    /// resets toggle/visualizer/pill state. Emitted from `cancel_current_operation`'s
    /// WinSTT wiring (the abort epilogue).
    pub fn session_aborted(app: &AppHandle) {
        crate::winstt::ducking::request_restore();
        crate::tray::on_tray_transcription_stop(app);
        crate::tray::on_tray_idle(app);
        let _ = app.emit("stt:session-aborted", ());
    }

    /// `stt:connection-change` — engine readiness. In the Tauri port the engine is
    /// in-proc (no external server), so this is emitted ONCE on boot as connected.
    /// `onConnectionChange` reads `.connected`.
    pub fn connection_change(app: &AppHandle, connected: bool) {
        let _ = app.emit(
            "stt:connection-change",
            serde_json::json!({ "connected": connected }),
        );
    }

    /// `stt:server-status` — "running" | "idle". In-proc engine → "running" on boot.
    /// `onServerStatus` reads `.status`.
    pub fn server_status(app: &AppHandle, status: &str) {
        let _ = app.emit("stt:server-status", serde_json::json!({ "status": status }));
    }
}

/// Emit the one-shot "engine is up" pair once the renderer has completed its
/// first startup IPC round trips. Also releases the splash handoff gate: Tauri's
/// page-load event can fire before the React providers have loaded settings and
/// devices, so the renderer calls this command after those startup tasks settle.
#[tauri::command]
#[specta::specta]
pub fn winstt_emit_ready(app: AppHandle) {
    let _ = read_settings(&app); // touch settings so a corrupt blob surfaces early
    crate::splash::mark_renderer_boot_done(&app);
    SttEvents::connection_change(&app, true);
    SttEvents::server_status(&app, "running");
}
