//! Batch (PTT-release) transcribe path: silence gate, cloud route, engine
//! `catch_unwind` + panic / degenerate-decode recovery.
//!
//! This file only adds an `impl TranscriptionManager` block on the type defined in the
//! module root; all shared free helpers / types / consts live in [`super`].

use super::{
    dc_immune_rms, is_degenerate_decode_error, is_silent_recording,
    local_final_decode_audio_with_silence, next_transcription_request_id, LoadedEngine,
    ModelStateEvent, TranscriptionManager, LOCAL_FINAL_DECODE_SILENCE_PAD_MS, SILENCE_AC_FLOOR,
};
use crate::winstt::stt::BackendRoute;
use anyhow::Result;
use log::{debug, error, info, warn};
use std::panic::{catch_unwind, AssertUnwindSafe};
use tauri::Emitter;

impl TranscriptionManager {
    pub fn get_current_model(&self) -> Option<String> {
        let current_model = self.lock_current_model();
        current_model.clone()
    }

    pub fn transcribe(&self, audio: Vec<f32>) -> Result<String> {
        let request_id = next_transcription_request_id();

        #[cfg(debug_assertions)]
        if std::env::var("WINSTT_FORCE_TRANSCRIPTION_FAILURE").is_ok() {
            error!("[stt][{request_id}] simulated transcription failure requested");
            return Err(anyhow::anyhow!(
                "Simulated transcription failure (WINSTT_FORCE_TRANSCRIPTION_FAILURE)"
            ));
        }

        // Update last activity timestamp
        self.touch_activity();

        let st = std::time::Instant::now();

        debug!("[stt][{request_id}] audio_samples={}", audio.len());

        if audio.is_empty() {
            debug!("[stt][{request_id}] empty audio vector");
            self.maybe_unload_immediately("empty audio");
            return Ok(String::new());
        }

        // SILENCE GATE (all engine paths: cloud / winstt-catalog)
        // A recording can be NON-empty yet carry NO actual speech — pure silence / room
        // tone (the Silero VAD at threshold 0.3 keeps near-silent frames on some mics), or
        // a dead Bluetooth/A2DP/virtual device emitting a constant DC offset. Fed to
        // Whisper, that makes the greedy decoder HALLUCINATE phantom text — observed as a
        // pasted "Thank you." on pure silence (rms≈0.00004), and as a ">12s wall of garbled
        // multilingual text" for the DC-offset dead-mic case. Reject both: an empty result
        // makes the caller emit `no_audio_detected` (actions.rs) → honest "no audio" pill.
        //
        // Gate on DC-immune AC energy (`SILENCE_AC_FLOOR`, empirically between real speech
        // and silence — see the const) OR the DC-dominated dead-device fingerprint. The
        // earlier gate required `rms < 0.0008 AND dc_dominated`, which let GENUINE digital
        // silence through (rms≈0, mean≈0 → not DC-dominated) — the "Thank you." bug. Audio
        // here is RAW (pre-`peak_normalize`).
        if is_silent_recording(&audio) {
            let rms = dc_immune_rms(&audio);
            debug!(
                "[stt][{request_id}] silent recording skipped; rms={rms:.6}; ac_floor={SILENCE_AC_FLOOR}"
            );
            debug!(
                "Recording RMS {rms:.6} below speech floor (ac_floor {SILENCE_AC_FLOOR}) — \
                 no audio (skipping decode)"
            );
            self.maybe_unload_immediately("silent audio");
            return Ok(String::new());
        }

        // The user's selected model comes from the WinSTT picker. `desired_model_id` reads the
        // picker store through the backend (audit #14).
        let desired = self.desired_model_id();

        // ── Cloud STT route ──────────────────────────────────────────────
        // When the selected model carries a cloud prefix (openai:/elevenlabs:), there is NO
        // local engine — ship the captured audio to the provider. The WinSTT-specific round-trip
        // (CloudSttManager call + the nested-runtime block_in_place/block_on branch + the cloud
        // dictionary/filler post-processing) is owned by the backend (audit #14). The core only
        // decides to take the cloud path here — BEFORE the engine lock, since cloud ids have no
        // LoadedEngine — and unloads any resident local engine after.
        if self.backend.route_of(&desired) == BackendRoute::Cloud {
            let filtered = match self
                .backend
                .cloud_transcribe(&self.app_handle, &desired, &audio)
            {
                Ok(text) => text,
                Err(e) => {
                    error!(
                        "[stt][{request_id}] cloud transcription failed for model '{desired}': {e}"
                    );
                    return Err(e);
                }
            };
            self.maybe_unload_immediately("cloud transcription");
            return Ok(filtered);
        }

        let local_audio = local_final_decode_audio_with_silence(&audio);
        debug!(
            "[stt][{request_id}] local_final_decode_samples={} final_silence_pad_ms={}",
            local_audio.len(),
            LOCAL_FINAL_DECODE_SILENCE_PAD_MS
        );

        // Check if model is loaded, if not try to load it
        {
            // If the model is loading, wait for it to complete.
            let mut is_loading = self.lock_is_loading();
            while *is_loading {
                is_loading = self
                    .loading_condvar
                    .wait(is_loading)
                    .unwrap_or_else(|poisoned| {
                        warn!(
                        "[stt][{request_id}] is_loading mutex poisoned while waiting; recovering"
                    );
                        poisoned.into_inner()
                    });
            }

            let engine_guard = self.lock_engine();
            if engine_guard.is_none() {
                error!(
                    "[stt][{request_id}] no loaded transcription engine for selected model '{desired}'"
                );
                return Err(anyhow::anyhow!("Model is not loaded for transcription."));
            }
        }

        // Engine inputs (language / translate / initial prompt) and post-processing are owned by
        // the WinSTT backend.
        let backend = self.backend.clone();
        let app_handle = self.app_handle.clone();

        // Perform transcription with the appropriate engine.
        // We use catch_unwind to prevent engine panics from poisoning the mutex,
        // which would make the app hang indefinitely on subsequent operations.
        let result = {
            let mut engine_guard = self.lock_engine();

            // Take the engine out so we own it during transcription.
            // If the engine panics, we simply don't put it back (effectively unloading it)
            // instead of poisoning the mutex.
            let mut engine = match engine_guard.take() {
                Some(e) => e,
                None => {
                    error!(
                        "[stt][{request_id}] engine unavailable after load wait for selected model '{desired}'"
                    );
                    return Err(anyhow::anyhow!(
                        "Model failed to load after auto-load attempt. Please check your model settings."
                    ));
                }
            };

            // Release the lock before transcribing — no mutex held during the engine call
            drop(engine_guard);

            let transcribe_result = catch_unwind(AssertUnwindSafe(|| -> Result<String> {
                match &mut engine {
                    LoadedEngine::Winstt(winstt_engine) => {
                        backend.decode(&app_handle, winstt_engine.as_mut(), &local_audio)
                    }
                }
            }));
            match transcribe_result {
                Ok(inner_result) => {
                    if let Err(e) = &inner_result {
                        if is_degenerate_decode_error(e) {
                            error!(
                                "[stt][{request_id}] transcription failed for model '{desired}': {e}"
                            );
                            warn!(
                                "[stt][{request_id}] dropping corrupted engine for model '{desired}' after degenerate decode; next load will recycle DirectML unless repeated failures trigger CPU fallback"
                            );
                            engine.shutdown();
                            {
                                let mut current_model = self
                                    .current_model_id
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                *current_model = None;
                            }
                            self.clear_warmed_model();
                            let detail = e.to_string();
                            let _ = self.app_handle.emit(
                                "model-state-changed",
                                ModelStateEvent {
                                    event_type: "unloaded".to_string(),
                                    model_id: None,
                                    model_name: None,
                                    error: Some(detail.clone()),
                                },
                            );
                            return Err(anyhow::anyhow!(detail));
                        }
                    }
                    // Success or normal error — put the engine back
                    let mut engine_guard = self.lock_engine();
                    *engine_guard = Some(engine);
                    inner_result.map_err(|e| {
                        error!(
                            "[stt][{request_id}] transcription failed for model '{desired}': {e}"
                        );
                        e
                    })?
                }
                Err(panic_payload) => {
                    // Engine panicked — do NOT put it back (it's in an unknown state).
                    // The engine is dropped here, effectively unloading it.
                    let panic_msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                        s.to_string()
                    } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                        s.clone()
                    } else {
                        "unknown panic".to_string()
                    };
                    error!(
                        "[stt][{request_id}] transcription engine panicked for model '{desired}': {}. Model has been unloaded.",
                        panic_msg
                    );
                    engine.shutdown();

                    // Clear the model ID so it will be reloaded on next attempt
                    {
                        let mut current_model = self
                            .current_model_id
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        *current_model = None;
                    }
                    self.clear_warmed_model();

                    let _ = self.app_handle.emit(
                        "model-state-changed",
                        ModelStateEvent {
                            event_type: "unloaded".to_string(),
                            model_id: None,
                            model_name: None,
                            error: Some(format!("Engine panicked: {}", panic_msg)),
                        },
                    );

                    return Err(anyhow::anyhow!(
                        "Transcription engine panicked: {}. The model has been unloaded and will reload on next attempt.",
                        panic_msg
                    ));
                }
            }
        };

        let et = std::time::Instant::now();
        let final_result = result;
        let output_chars = final_result.chars().count();
        self.mark_model_warmed_if_current(&desired);

        info!(
            "[stt][{request_id}] transcription completed in {}ms model='{}' output_chars={} output_empty={}",
            (et - st).as_millis(),
            desired,
            output_chars,
            output_chars == 0
        );

        self.maybe_unload_immediately("transcription");

        Ok(final_result)
    }
}

#[cfg(test)]
mod tests {
    /// Single-store-per-field guard (audit finding "Dual settings source-of-truth"): the
    /// transcribe path must read `language` from WinsttSettings.model.language ONLY, never
    /// from the AppSettings language field. This source-level assertion fails if the removed
    /// dual read is reintroduced into this file's hot path. The forbidden identifier is
    /// assembled at runtime so the test's own source doesn't trip the check.
    #[test]
    fn transcribe_path_does_not_read_appsettings_language() {
        let src = include_str!("decode.rs");
        let forbidden = format!("selected_{}", "language");
        assert!(
            !src.contains(&forbidden),
            "the transcribe path must not read the AppSettings language field — language is owned \
             solely by WinsttSettings.model.language (see crate::winstt::stt::backend)"
        );
    }
}
