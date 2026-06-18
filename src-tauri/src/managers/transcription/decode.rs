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
use std::sync::mpsc::{self, Sender};
use std::time::{Duration, Instant};
use tauri::Emitter;

const SLOW_TRANSCRIPTION_MS: u128 = 30_000;
const TRANSCRIPTION_WATCHDOG_THRESHOLDS_MS: [u64; 4] = [10_000, 30_000, 60_000, 120_000];
const TRANSCRIPTION_SAMPLE_RATE: usize = 16_000;

fn samples_to_ms(samples: usize) -> u64 {
    ((samples as u128 * 1000) / TRANSCRIPTION_SAMPLE_RATE as u128) as u64
}

struct TranscriptionWatchdog {
    stop: Sender<()>,
}

impl TranscriptionWatchdog {
    fn start(
        app_handle: tauri::AppHandle,
        request_id: String,
        model_id: String,
        raw_samples: usize,
        local_samples: usize,
        started: Instant,
    ) -> Self {
        let (stop, stop_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut previous = Duration::from_millis(0);
            for threshold_ms in TRANSCRIPTION_WATCHDOG_THRESHOLDS_MS {
                let threshold = Duration::from_millis(threshold_ms);
                match stop_rx.recv_timeout(threshold.saturating_sub(previous)) {
                    Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                previous = threshold;

                let elapsed_ms = started.elapsed().as_millis() as u64;
                warn!(
                    "[stt][{request_id}] transcription still running after {elapsed_ms}ms model='{model_id}' raw_audio_ms={} local_audio_ms={}",
                    samples_to_ms(raw_samples),
                    samples_to_ms(local_samples)
                );
                crate::winstt::observability::IssueBuilder::new(
                    "stt",
                    "transcription_watchdog",
                    "STT transcription is still running",
                )
                .detail(format!("still running after {elapsed_ms}ms"))
                .kind("timeout")
                .severity("warn")
                .model_id(model_id.clone())
                .request_id(request_id.clone())
                .duration_ms(elapsed_ms)
                .user_visible(false)
                .context("thresholdMs", threshold_ms.to_string())
                .context("rawSamples", raw_samples.to_string())
                .context("rawAudioMs", samples_to_ms(raw_samples).to_string())
                .context("localFinalDecodeSamples", local_samples.to_string())
                .context(
                    "localFinalDecodeAudioMs",
                    samples_to_ms(local_samples).to_string(),
                )
                .record(Some(&app_handle));
            }
        });
        Self { stop }
    }
}

impl Drop for TranscriptionWatchdog {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

impl TranscriptionManager {
    pub fn get_current_model(&self) -> Option<String> {
        let current_model = self.lock_current_model();
        current_model.clone()
    }

    pub fn transcribe(&self, audio: Vec<f32>) -> Result<String> {
        let desired = self.desired_model_id();
        self.transcribe_with_selected_model(&desired, audio)
    }

    pub fn transcribe_with_model(&self, model_id: &str, audio: Vec<f32>) -> Result<String> {
        let desired = crate::winstt::catalog::canonical_model_id(model_id).to_string();
        self.transcribe_with_selected_model(&desired, audio)
    }

    fn transcribe_with_selected_model(&self, desired: &str, audio: Vec<f32>) -> Result<String> {
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

        // ── Cloud STT route ──────────────────────────────────────────────
        // When the selected model carries a cloud prefix (openai:/elevenlabs:), there is NO
        // local engine — ship the captured audio to the provider. The WinSTT-specific round-trip
        // (CloudSttManager call + the nested-runtime block_in_place/block_on branch + the cloud
        // dictionary/filler post-processing) is owned by the backend (audit #14). The core only
        // decides to take the cloud path here — BEFORE the engine lock, since cloud ids have no
        // LoadedEngine — and unloads any resident local engine after.
        if self.backend.route_of(desired) == BackendRoute::Cloud {
            let filtered = match self
                .backend
                .cloud_transcribe(&self.app_handle, desired, &audio)
            {
                Ok(text) => text,
                Err(e) => {
                    error!(
                        "[stt][{request_id}] cloud transcription failed for model '{desired}': {e}"
                    );
                    crate::winstt::observability::IssueBuilder::new(
                        "stt",
                        "cloud_transcription",
                        "Cloud STT transcription failed",
                    )
                    .detail(e.to_string())
                    .model_id(desired.to_string())
                    .request_id(request_id.clone())
                    .duration_ms(st.elapsed().as_millis() as u64)
                    .record(Some(&self.app_handle));
                    return Err(e);
                }
            };
            self.maybe_unload_immediately("cloud transcription");
            return Ok(filtered);
        }

        self.load_model_blocking(desired).map_err(|e| {
            crate::winstt::observability::IssueBuilder::new(
                "stt",
                "model_load_for_transcription",
                "STT model could not be prepared for transcription",
            )
            .detail(e.to_string())
            .model_id(desired.to_string())
            .request_id(request_id.clone())
            .duration_ms(st.elapsed().as_millis() as u64)
            .record(Some(&self.app_handle));
            anyhow::anyhow!("failed to load model '{desired}': {e}")
        })?;

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
                crate::winstt::observability::IssueBuilder::new(
                    "stt",
                    "transcription",
                    "No STT engine was loaded for transcription",
                )
                .detail("engine state was empty after model load wait")
                .model_id(desired.to_string())
                .request_id(request_id.clone())
                .severity("error")
                .record(Some(&self.app_handle));
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
                    crate::winstt::observability::IssueBuilder::new(
                        "stt",
                        "transcription",
                        "STT engine became unavailable before transcription",
                    )
                    .detail("engine mutex was empty after load wait")
                    .model_id(desired.to_string())
                    .request_id(request_id.clone())
                    .severity("error")
                    .record(Some(&self.app_handle));
                    return Err(anyhow::anyhow!(
                        "Model failed to load after auto-load attempt. Please check your model settings."
                    ));
                }
            };

            // Release the lock before transcribing — no mutex held during the engine call
            drop(engine_guard);

            let _watchdog = TranscriptionWatchdog::start(
                app_handle.clone(),
                request_id.clone(),
                desired.to_string(),
                audio.len(),
                local_audio.len(),
                st,
            );
            let transcribe_result = catch_unwind(AssertUnwindSafe(|| -> Result<String> {
                match &mut engine {
                    LoadedEngine::Winstt(winstt_engine) => backend.decode(
                        &app_handle,
                        winstt_engine.as_mut(),
                        &local_audio,
                        &request_id,
                    ),
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
                            crate::winstt::observability::IssueBuilder::new(
                                "stt",
                                "transcription",
                                "STT transcription failed and the engine was unloaded",
                            )
                            .detail(detail.clone())
                            .model_id(desired.to_string())
                            .request_id(request_id.clone())
                            .duration_ms(st.elapsed().as_millis() as u64)
                            .severity("error")
                            .record(Some(&self.app_handle));
                            let _ = self.app_handle.emit(
                                crate::winstt::commands::events::names::MODEL_STATE_CHANGED,
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
                        crate::winstt::observability::IssueBuilder::new(
                            "stt",
                            "transcription",
                            "STT transcription failed",
                        )
                        .detail(e.to_string())
                        .model_id(desired.to_string())
                        .request_id(request_id.clone())
                        .duration_ms(st.elapsed().as_millis() as u64)
                        .record(Some(&self.app_handle));
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
                    crate::winstt::observability::IssueBuilder::new(
                        "stt",
                        "transcription",
                        "STT transcription engine panicked",
                    )
                    .detail(panic_msg.clone())
                    .kind("panic")
                    .severity("error")
                    .model_id(desired.to_string())
                    .request_id(request_id.clone())
                    .duration_ms(st.elapsed().as_millis() as u64)
                    .record(Some(&self.app_handle));
                    engine.shutdown();

                    // Clear the model ID so it will be reloaded on next attempt
                    {
                        let mut current_model = self.lock_current_model();
                        *current_model = None;
                    }
                    self.clear_warmed_model();

                    let _ = self.app_handle.emit(
                        crate::winstt::commands::events::names::MODEL_STATE_CHANGED,
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
        self.mark_model_warmed_if_current(desired);

        info!(
            "[stt][{request_id}] transcription completed in {}ms model='{}' output_chars={} output_empty={}",
            (et - st).as_millis(),
            desired,
            output_chars,
            output_chars == 0
        );
        let elapsed_ms = (et - st).as_millis();
        if elapsed_ms >= SLOW_TRANSCRIPTION_MS {
            crate::winstt::observability::IssueBuilder::new(
                "stt",
                "transcription",
                "STT transcription was slow",
            )
            .detail(format!("completed in {elapsed_ms}ms"))
            .kind("timeout")
            .severity("warn")
            .model_id(desired.to_string())
            .request_id(request_id)
            .duration_ms(elapsed_ms as u64)
            .remediation("Use a smaller or quantized model, shorten the dictation, or switch execution device.")
            .user_visible(false)
            .record(Some(&self.app_handle));
        }

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
