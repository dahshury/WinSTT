//! Realtime live-preview + native-streaming + final-reuse fast path.
//!
//! This file only adds an `impl TranscriptionManager` block on the type defined in the
//! module root; all shared free helpers / types / consts live in [`super`].

use super::{
    dc_immune_rms, is_silent_recording, native_stream_final_tail_with_silence, LoadedEngine,
    LoadedTranscriptionCapabilities, RealtimeReuse, RealtimeStreamOutcome, RealtimeStreamText,
    TranscriptionManager, NATIVE_STREAM_FINAL_SILENCE_PAD_MS, NATIVE_STREAM_SAMPLE_RATE,
    SILENCE_AC_FLOOR,
};
use crate::winstt::stt::SttResult;
use log::{info, warn};

impl TranscriptionManager {
    /// Realtime live-preview decode: ONE raw pass for the live transcription overlay.
    ///
    /// Ported from the reference server's `_transcribe_realtime_window` /
    /// `_safe_transcribe` (recorder_service.py:2765-2781). Key contract:
    ///
    /// * NON-BLOCKING on the engine — `try_lock` only. If the engine mutex is contended
    ///   (a batch decode holds it) OR no engine is loaded (`None`, or `take()`n out mid-batch),
    ///   return `None` immediately. Blocking here would stall the final batch decode on PTT
    ///   release (the worst-case latency the spec calls out). A skipped tick is normal: the
    ///   worker simply publishes nothing this iteration and tries again.
    /// * PEEK, never `take()` — the guard borrows the engine in place via `match &mut *guard`,
    ///   so a racing batch `transcribe()`'s `engine_guard.take()` still works the instant this
    ///   releases the lock. The lock is held only for the decode itself, which is acceptable
    ///   precisely because the worker bails (returns `None`) the moment a batch decode wants it.
    /// * WinSTT (ort/whisper-DML) engine ONLY — realtime is whisper/ort for now (single
    ///   shared engine; there is NO separate realtime engine). Any other `LoadedEngine` arm
    ///   returns `None`.
    /// * RAW text only — no silence gate, no history, no custom-words/filler/post-processing.
    ///   The stabilizer + assembly happen in the realtime worker.
    /// * `catch_unwind` around the decode (mirrors the batch path) so a realtime panic can't
    ///   poison the worker; returns `None` on panic.
    ///
    /// REUSES THE MAIN ENGINE: there is deliberately no second realtime engine in this port —
    /// do not wire one. The the reference server's separate realtime transcriber maps to this single
    /// in-proc engine, shared with the batch path under the same mutex.
    pub fn transcribe_realtime(&self, audio: &[f32], language: Option<&str>) -> Option<String> {
        if audio.is_empty() {
            return None;
        }
        // Silence backstop (same floor as the batch gate): a low-AC-energy window is the
        // ambient/silence the Silero VAD let through — decoding it makes Whisper hallucinate
        // ("Thank you.") into the LIVE PREVIEW, which would reveal the pill on silence.
        // Return None so the watermark/preview pick up no phantom text.
        if dc_immune_rms(audio) < SILENCE_AC_FLOOR {
            return None;
        }
        // Non-blocking: bail the instant the engine is busy (batch decode), but RECOVER
        // from poison instead of treating it like contention. The previous `Err(_) =>
        // return None` collapsed `Poisoned` into the WouldBlock case, so a single panic
        // (which poisons the mutex) wedged live preview forever — every subsequent tick
        // saw a poisoned lock and returned None. Mirror `lock_engine`: WouldBlock skips
        // the tick (a batch decode owns the lock), Poisoned is recovered via
        // `into_inner()` so realtime keeps working after a one-off panic.
        let mut guard = match self.engine.try_lock() {
            Ok(g) => g,
            Err(std::sync::TryLockError::WouldBlock) => return None, // batch decode owns it — skip
            Err(std::sync::TryLockError::Poisoned(p)) => {
                warn!("Engine mutex poisoned by a previous panic, recovering (realtime)");
                p.into_inner()
            }
        };

        // The WinSTT-arm realtime decode (peak-normalize + configured-language opts) is owned by
        // the backend (audit #14). The core keeps only the `try_lock` non-blocking + poison
        // recovery + `catch_unwind` discipline. The backend borrows `&mut dyn Transcriber` in
        // place (PEEK, never `take()`); it must NOT lock the mutex.
        let backend = self.backend.clone();
        let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match &mut *guard {
                Some(LoadedEngine::Winstt(e)) => {
                    backend.decode_realtime(e.as_mut(), audio, language)
                }
                // No local engine loaded, or taken out by a batch decode.
                _ => None,
            }
        }));

        let text = match decoded {
            Ok(text) => text,
            Err(_) => {
                warn!("Realtime decode panicked — skipping tick");
                None
            }
        };
        drop(guard);
        if text.is_some() {
            if let Some(model_id) = self.get_current_model() {
                self.mark_model_warmed_if_current(&model_id);
            }
        }
        text
    }

    /// Capability peek for final-reuse policy. This blocks because final reuse runs on the
    /// transcription blocking pool after release; waiting here lets any in-flight realtime
    /// `stream_accept` finish and publish its covered-sample cache before finalization consumes it.
    fn loaded_capabilities(&self) -> LoadedTranscriptionCapabilities {
        let guard = self.engine.lock().unwrap_or_else(|p| {
            warn!("Engine mutex poisoned by a previous panic, recovering (capability peek)");
            p.into_inner()
        });
        match &*guard {
            Some(LoadedEngine::Winstt(e)) => {
                let kind = e.kind();
                LoadedTranscriptionCapabilities {
                    final_reuse_safe: kind.final_reuse_safe(),
                    native_streaming: e.supports_native_streaming(),
                }
            }
            None => LoadedTranscriptionCapabilities::CONSERVATIVE,
        }
    }

    fn run_native_stream_finalize(
        engine: &mut Option<LoadedEngine>,
        tail: &[f32],
    ) -> Option<SttResult<String>> {
        match engine {
            Some(LoadedEngine::Winstt(e)) if e.supports_native_streaming() => {
                if !tail.is_empty() {
                    if let Err(err) = e.stream_accept(tail) {
                        return Some(Err(err));
                    }
                }
                Some(e.stream_finalize())
            }
            _ => None,
        }
    }

    /// Feed any final tail samples the realtime tick did not see, then flush the loaded
    /// native-streaming engine's right context and return its final stream text.
    /// This is deliberately blocking and is called from the transcription blocking pool: after
    /// release, final paste should wait for the engine's own end-of-stream callback instead of
    /// guessing a fixed microphone hold-open duration.
    fn finalize_native_stream_text(&self, tail: &[f32]) -> Option<String> {
        let started = std::time::Instant::now();
        let final_tail = native_stream_final_tail_with_silence(tail);
        info!(
            "[realtime-final] native stream finalizing captured_tail_samples={} silence_pad_ms={} fed_tail_samples={} fed_tail_ms={}",
            tail.len(),
            NATIVE_STREAM_FINAL_SILENCE_PAD_MS,
            final_tail.len(),
            (final_tail.len() as f32 / NATIVE_STREAM_SAMPLE_RATE as f32 * 1000.0).round() as u64
        );
        let mut guard = self.engine.lock().unwrap_or_else(|p| {
            warn!("Engine mutex poisoned by a previous panic, recovering (stream_finalize)");
            p.into_inner()
        });
        let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            Self::run_native_stream_finalize(&mut guard, &final_tail)
        }));
        let text = match decoded {
            Ok(Some(Ok(text))) => text,
            Ok(Some(Err(err))) => {
                warn!("Native stream finalize failed: {err}");
                return None;
            }
            Ok(None) => return None,
            Err(_) => {
                warn!("Native stream finalize panicked");
                return None;
            }
        };
        drop(guard);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            info!(
                "[realtime-final] native stream finalized in {}ms final_chars={}",
                started.elapsed().as_millis(),
                trimmed.chars().count()
            );
            Some(trimmed.to_string())
        }
    }

    /// Peek whether the loaded engine does NATIVE streaming (carries cross-chunk cache state so the
    /// realtime worker can feed only new samples per tick). `Some(true/false)` when an engine is
    /// loaded; `None` when none is loaded yet OR the lock is contended (caller keeps probing / uses
    /// the window path). Non-blocking.
    pub fn realtime_native_streaming(&self) -> Option<bool> {
        match self.engine.try_lock() {
            // realtime is WinSTT-arm-only; any other loaded engine → window path (returns
            // nothing from transcribe_realtime, so the preview is simply empty for it).
            Ok(guard) => (*guard)
                .as_ref()
                .map(|LoadedEngine::Winstt(e)| e.supports_native_streaming()),
            Err(_) => None,
        }
    }

    /// Feed the next chunk of NEW 16 kHz samples into the loaded native-streaming engine (cache
    /// carried internally) and return the incremental text. NON-BLOCKING (`try_lock`, like
    /// `transcribe_realtime`): a contended lock yields [`RealtimeStreamOutcome::Skipped`] so the
    /// worker retries the same samples next tick instead of dropping them. A non-streaming engine
    /// yields [`RealtimeStreamOutcome::NotStreaming`]. `catch_unwind` so a decode panic can't wedge
    /// the worker.
    pub fn stream_accept_realtime(
        &self,
        generation: u64,
        covered: usize,
        new_samples: &[f32],
    ) -> RealtimeStreamOutcome {
        if new_samples.is_empty() {
            return RealtimeStreamOutcome::Text(RealtimeStreamText::interim(String::new()));
        }
        let mut guard = match self.engine.try_lock() {
            Ok(g) => g,
            Err(std::sync::TryLockError::WouldBlock) => return RealtimeStreamOutcome::Skipped,
            Err(std::sync::TryLockError::Poisoned(p)) => {
                warn!("Engine mutex poisoned by a previous panic, recovering (stream_accept)");
                p.into_inner()
            }
        };
        let decoded =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match &mut *guard {
                Some(LoadedEngine::Winstt(e)) if e.supports_native_streaming() => {
                    Some(e.stream_accept(new_samples))
                }
                _ => None,
            }));
        let (outcome, did_decode, cache_text) = match decoded {
            Ok(Some(Ok(update))) => {
                let text = update.text;
                (
                    RealtimeStreamOutcome::Text(RealtimeStreamText {
                        text: text.clone(),
                        is_final: update.is_final,
                    }),
                    true,
                    Some(text),
                )
            }
            Ok(Some(Err(err))) => {
                warn!("Native stream decode failed; retrying same samples: {err}");
                (RealtimeStreamOutcome::Skipped, false, None)
            }
            Ok(None) => (RealtimeStreamOutcome::NotStreaming, false, None),
            Err(_) => {
                warn!("Native stream decode panicked; retrying same samples");
                (RealtimeStreamOutcome::Skipped, false, None)
            }
        };
        if let Some(raw_text) = cache_text {
            info!(
                "[realtime-final] cached native stream generation={} covered_samples={} chars={}",
                generation,
                covered,
                raw_text.chars().count()
            );
            *self.realtime_reuse.lock().unwrap() = Some(RealtimeReuse {
                generation,
                covered,
                raw_text,
            });
        }
        drop(guard);
        if did_decode {
            if let Some(model_id) = self.get_current_model() {
                self.mark_model_warmed_if_current(&model_id);
            }
        }
        outcome
    }

    /// Zero the loaded native-streaming engine's stream state (new utterance). No-op for a
    /// non-streaming or unloaded engine. This waits for any in-flight final decode so a quick
    /// release+re-press cannot carry the previous stream's text/cache into the new recording.
    pub fn stream_reset_realtime(&self) {
        let mut guard = self.engine.lock().unwrap_or_else(|p| {
            warn!("Engine mutex poisoned by a previous panic, recovering (stream_reset)");
            p.into_inner()
        });
        if let Some(LoadedEngine::Winstt(e)) = &mut *guard {
            if e.supports_native_streaming() {
                e.stream_reset();
            }
        }
    }

    /// Cache the latest realtime full-buffer decode for the final-paste reuse fast path. Called by
    /// the realtime worker after each successful full-buffer decode; overwrites any prior entry
    /// (only the freshest, most-complete decode matters). Empty text is never cached (so reuse can
    /// never resurrect a blank/silent tick).
    pub fn cache_realtime_reuse(&self, generation: u64, covered: usize, raw_text: &str) {
        if raw_text.trim().is_empty() {
            return;
        }
        *self.realtime_reuse.lock().unwrap() = Some(RealtimeReuse {
            generation,
            covered,
            raw_text: raw_text.to_string(),
        });
    }

    /// Drop the realtime-reuse cache without promoting it to the final transcript.
    /// Preview-before-pasting needs a fresh batch decode so the editable/rewrite
    /// surface starts from the main finalization path, not the live preview cache.
    pub fn clear_realtime_reuse(&self) {
        let _ = self.realtime_reuse.lock().unwrap().take();
    }

    /// Satisfy the FINAL transcription by REUSING the realtime worker's last full-buffer decode —
    /// avoiding a redundant re-decode of audio the live engine already transcribed (the live decode
    /// used the same engine on the same growing buffer, so it == the final decode sans
    /// post-processing). Returns the post-processed final text when ALL hold:
    ///   * a cached decode exists for THIS recording `generation`,
    ///   * the whole recording is not silent (defer to `transcribe`'s silence gate otherwise — the
    ///     realtime path skips that gate and may have hallucinated on near-silence), and
    ///   * for non-native streaming, the audio past what the cached decode covered carries no speech.
    ///     Native-streaming engines receive that tail before finalizing the stream.
    ///
    /// Returns `None` (→ caller does a fresh `transcribe`) otherwise. The cache is consumed either
    /// way so a stale decode can't leak into the next recording.
    pub fn try_reuse_realtime(&self, generation: u64, samples: &[f32]) -> Option<String> {
        // Context-dependent engines (attention enc-dec: Whisper/Canary/Cohere) must re-decode with
        // proper VAD-segmentation — the chunked realtime watermark text has arbitrary cut points and
        // is lower quality than a clean-boundary final. Only the frame-synchronous (CTC / transducer
        // / native-streaming) families, which carry no cross-utterance text context, reuse the live
        // output.
        let capabilities = self.loaded_capabilities();
        // Consume the cache after the capability wait above. For native streaming, that wait also
        // lets an in-flight realtime `stream_accept` publish the newest covered sample count before
        // finalization computes and feeds the remaining tail.
        let entry = self.realtime_reuse.lock().unwrap().take()?;
        if !capabilities.final_reuse_safe {
            return None;
        }
        if entry.generation != generation {
            return None;
        }
        // Whole-recording silence → let the batch path's gate emit the honest "no audio".
        if is_silent_recording(samples) {
            return None;
        }
        // Trailing audio the realtime decode never saw (last partial chunk + extra-buffer tail).
        // Native-streaming engines can accept that tail before finalizing. Window-redecode engines
        // cannot, so speech-bearing tail must fall back to a fresh final decode.
        let covered = entry.covered.min(samples.len());
        let tail = &samples[covered..];
        info!(
            "[realtime-final] reuse candidate generation={} native={} covered_samples={} total_samples={} tail_samples={} cached_chars={}",
            generation,
            capabilities.native_streaming,
            covered,
            samples.len(),
            tail.len(),
            entry.raw_text.chars().count()
        );
        let raw_text = if capabilities.native_streaming {
            let finalized = if tail.is_empty() {
                self.finalize_native_stream_text(tail)
                    .unwrap_or_else(|| entry.raw_text.clone())
            } else {
                self.finalize_native_stream_text(tail)?
            };
            if !tail.is_empty()
                && finalized.chars().count() <= entry.raw_text.chars().count()
                && dc_immune_rms(tail) >= SILENCE_AC_FLOOR
            {
                info!(
                    "[realtime-final] native stream final text did not grow despite speech-bearing tail; falling back to fresh decode"
                );
                return None;
            }
            finalized
        } else {
            if !tail.is_empty() && dc_immune_rms(tail) >= SILENCE_AC_FLOOR {
                return None;
            }
            entry.raw_text
        };
        // A reuse hit IS a completed transcription — keep the idle-unload watcher from evicting the
        // engine out from under an actively-dictating user (the `transcribe` path it bypasses is
        // where `touch_activity` normally runs).
        self.touch_activity();
        // Same cleanup the WinSTT `decode` path applies, so reuse == a fresh decode would produce.
        let ws = crate::winstt::commands::settings::read_settings(&self.app_handle);
        Some(crate::winstt::stt::backend::winstt_postprocess(
            &raw_text, &ws,
        ))
    }
}
