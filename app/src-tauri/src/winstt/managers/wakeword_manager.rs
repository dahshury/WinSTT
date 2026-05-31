// PORT IMPL. Source: app/PORT/05_*.md §A + lib_wiring.md §2/§3, server wake-word
// backends (porcupine_detector.py / oww_detector.py / composite_wake_word.py).
// Wraps winstt::wakeword (presets + tokenizer + keyword-content builder + the live
// sherpa-onnx KeywordSpotter detector).
//
// WakeWordManager owns the active wake-word configuration (resolved phrase +
// sensitivity→threshold + timeout) AND the live `WakeWordDetector`. It is rebuilt
// on `general.wakeWord` / `wakeWordSensitivity` change. The detector is fed the
// SAME 16 kHz mono f32 chunk the recorder consumer sees (`feed_chunk`, called from
// the audio loop while wakeword mode is active — see the transcription_coordinator
// / actions wiring). On a hit it emits `wake_word_detected`; the audio consumer
// then starts the recording pipeline (recorder INACTIVE→LISTENING + the
// `wakeWordTimeout` countdown, both recorder-side).
//
// NOTE: there is NO `sherpa` cargo feature — Cargo.toml declares `sherpa-onnx`
// UNCONDITIONALLY (linked as a shared DLL). So the detector compiles
// unconditionally; the earlier `#[cfg(feature = "sherpa")]` gates were dead
// (the feature never existed) and have been removed.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use log::{debug, warn};
use tauri::{AppHandle, Emitter};

use crate::winstt::commands::events::WakeWordDetectedPayload;
use crate::winstt::wakeword::{
    build_keyword_content, resolve_phrase, sensitivity_to_threshold, KwsModelPaths,
    WakeWordConfig, WakeWordDetector, WakeWordProvider, WakeWordResult, KWS_BUNDLE_DIRNAME,
    WAKE_WORD_PRESETS,
};

/// One wake-word preset surfaced to the renderer dropdown.
#[derive(Clone, Debug)]
pub struct WakeWordPresetInfo {
    pub name: String,
    pub phrase: String,
}

/// The currently-armed wake-word state (independent of the FFI detector so the
/// manager can answer the command layer + emit even when no model is downloaded).
#[derive(Clone, Debug, Default)]
struct WakeState {
    /// The persisted `general.wakeWord` name (default "alexa"). Empty = disabled.
    name: String,
    /// The resolved spoken phrase fed to the tokenizer.
    phrase: String,
    /// 0..1 UI sensitivity (`general.wakeWordSensitivity`, default 0.6).
    sensitivity: f32,
    /// Seconds the wake gate stays armed after a hit (`general.wakeWordTimeout`).
    timeout_seconds: f32,
}

pub struct WakeWordManager {
    app: AppHandle,
    state: Mutex<WakeState>,
    /// True while wake-word detection is active (recorder in wakeword mode).
    armed: AtomicBool,
    /// The live sherpa-onnx KeywordSpotter, or `None` when the wake word is
    /// disabled OR the KWS model bundle hasn't been downloaded yet (fail-soft).
    detector: Mutex<Option<WakeWordDetector>>,
}

impl WakeWordManager {
    pub fn new(app: &AppHandle) -> Self {
        let manager = Self {
            app: app.clone(),
            state: Mutex::new(WakeState {
                sensitivity: 0.6,
                timeout_seconds: 5.0,
                ..WakeState::default()
            }),
            armed: AtomicBool::new(false),
            detector: Mutex::new(None),
        };
        // Seed the active state + detector from persisted settings so a process
        // started already in wakeword mode is ready before the first arm.
        manager.sync_from_settings();
        manager
    }

    /// The list of built-in presets for the renderer dropdown.
    pub fn list_presets(&self) -> Vec<WakeWordPresetInfo> {
        WAKE_WORD_PRESETS
            .iter()
            .map(|p| WakeWordPresetInfo {
                name: p.name.to_string(),
                phrase: p.phrase.to_string(),
            })
            .collect()
    }

    /// Reconfigure the wake word (name + sensitivity + timeout) and rebuild the
    /// detector. An empty `name` disables it (detector dropped).
    pub fn set_wake_word(
        &self,
        name: &str,
        sensitivity: f32,
        timeout_seconds: f32,
    ) -> Result<(), String> {
        let phrase = if name.trim().is_empty() {
            String::new()
        } else {
            resolve_phrase(name)
        };
        {
            let mut s = self.state.lock().map_err(|_| "wakeword state poisoned")?;
            s.name = name.to_string();
            s.phrase = phrase;
            s.sensitivity = sensitivity.clamp(0.0, 1.0);
            s.timeout_seconds = timeout_seconds.max(0.0);
        }
        self.rebuild_detector()
    }

    /// Re-read `general.wakeWord` / `wakeWordSensitivity` / `wakeWordTimeout` from
    /// the settings store and rebuild. Called on construction; the command layer
    /// also calls `set_wake_word` directly with the renderer-supplied values.
    pub fn sync_from_settings(&self) {
        let general = crate::winstt::commands::settings::read_settings(&self.app).general;
        let name = general.wake_word;
        let sensitivity = general.wake_word_sensitivity as f32;
        let timeout = general.wake_word_timeout as f32;
        if let Err(e) = self.set_wake_word(&name, sensitivity, timeout) {
            warn!("Wake-word sync from settings failed: {e}");
        }
    }

    /// The resolved `#threshold` for the current sensitivity (direction-flipped).
    pub fn current_threshold(&self) -> f32 {
        let s = self.state.lock().map(|s| s.sensitivity).unwrap_or(0.6);
        sensitivity_to_threshold(s)
    }

    pub fn current_phrase(&self) -> String {
        self.state.lock().map(|s| s.phrase.clone()).unwrap_or_default()
    }

    pub fn timeout_seconds(&self) -> f32 {
        self.state.lock().map(|s| s.timeout_seconds).unwrap_or(5.0)
    }

    pub fn is_armed(&self) -> bool {
        self.armed.load(Ordering::Acquire)
    }

    /// True when a live detector is built (a valid phrase + a present model
    /// bundle). The audio consumer can cheaply skip the feed when this is false.
    pub fn has_detector(&self) -> bool {
        self.detector.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Arm/disarm wake-word detection (recorder entering/leaving wakeword mode).
    /// On arm, the streaming state is reset so a stale partial decode from a
    /// previous session can't fire a phantom hit on the first new chunk.
    pub fn set_armed(&self, armed: bool) {
        let was = self.armed.swap(armed, Ordering::AcqRel);
        if armed && !was {
            if let Ok(mut guard) = self.detector.lock() {
                if let Some(det) = guard.as_mut() {
                    det.reset();
                }
            }
        }
    }

    /// Feed one 16 kHz mono f32 chunk to the detector (from the audio consumer
    /// feed). On a hit, emits `wake_word_detected` and returns the result.
    /// No-op (returns `none`) when not armed or no detector is built.
    pub fn feed_chunk(&self, chunk: &[f32]) -> WakeWordResult {
        if !self.is_armed() {
            return WakeWordResult::none();
        }
        let Ok(mut guard) = self.detector.lock() else {
            return WakeWordResult::none();
        };
        let Some(det) = guard.as_mut() else {
            return WakeWordResult::none();
        };
        let result = det.detect(chunk);
        // Drop the lock before emitting so an event handler can't deadlock by
        // re-entering the manager (e.g. a synchronous set_armed on the same path).
        drop(guard);
        if result.detected {
            self.emit_detected(&result);
        }
        result
    }

    fn emit_detected(&self, result: &WakeWordResult) {
        debug!(
            "Wake word detected: '{}' (index {})",
            result.word, result.word_index
        );
        // Reuse the canonical specta-typed payload registered in lib.rs / events.rs
        // so the renderer's `wake_word_detected` listener reads `{ word, wordIndex }`
        // unchanged (camelCase via the struct's serde rename).
        let _ = self.app.emit(
            "wake_word_detected",
            WakeWordDetectedPayload {
                word: result.word.clone(),
                word_index: result.word_index,
            },
        );
    }

    /// Resolve the KWS model bundle directory (under the app data dir). The
    /// download manager populates it; we only read it here.
    fn bundle_dir(&self) -> PathBuf {
        crate::portable::app_data_dir(&self.app)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("wakeword")
            .join(KWS_BUNDLE_DIRNAME)
    }

    /// Rebuild the live detector from the current state.
    ///
    /// Drops the detector when the wake word is disabled (blank phrase) or the
    /// KWS model bundle isn't fully downloaded yet — both are valid, non-error
    /// states (the manager stays inert until the model lands / a word is set).
    /// Only a genuine sherpa `create` failure surfaces as an `Err`.
    fn rebuild_detector(&self) -> Result<(), String> {
        let (phrase, sensitivity, timeout) = {
            let s = self.state.lock().map_err(|_| "wakeword state poisoned")?;
            (s.phrase.clone(), s.sensitivity, s.timeout_seconds)
        };

        // Disabled → drop the detector and stop.
        if phrase.trim().is_empty() {
            self.store_detector(None);
            return Ok(());
        }

        // Model bundle not present → inert (the download manager will fetch it;
        // a later sync/set_wake_word rebuilds once the files exist).
        let model = KwsModelPaths::from_bundle_dir(&self.bundle_dir());
        if !model.all_present() {
            debug!(
                "KWS model bundle missing at {}; wake word '{phrase}' stays inert until downloaded",
                self.bundle_dir().display()
            );
            self.store_detector(None);
            return Ok(());
        }

        // Build the inline keyword content (tokens + #threshold + @label) for the
        // single active phrase, then stand up the spotter.
        let keywords_content = build_keyword_content(&phrase, sensitivity);
        if keywords_content.trim().is_empty() {
            self.store_detector(None);
            return Ok(());
        }

        let config = WakeWordConfig {
            model,
            keywords_file: None,
            keywords_content: Some(keywords_content),
            keywords: vec![phrase.trim().to_lowercase()],
            provider: self.resolve_provider(),
            sensitivity,
            timeout_seconds: timeout,
            num_threads: Some(1),
        };

        match WakeWordDetector::new(&config) {
            Ok(detector) => {
                debug!("Built KWS detector for wake word '{phrase}'");
                self.store_detector(Some(detector));
                Ok(())
            }
            Err(e) => {
                self.store_detector(None);
                Err(format!("failed to build wake-word detector: {e}"))
            }
        }
    }

    /// Pick the sherpa provider from the shared model device setting (TTS/STT
    /// share `model.device`). The tiny KWS session runs continuously, so CPU is
    /// the conservative default unless the user explicitly chose Auto/DirectML.
    fn resolve_provider(&self) -> WakeWordProvider {
        use crate::winstt::settings_schema::DeviceType;
        match crate::winstt::commands::settings::read_settings(&self.app)
            .model
            .device
        {
            DeviceType::Auto => WakeWordProvider::DirectMl,
            DeviceType::Cpu => WakeWordProvider::Cpu,
        }
    }

    fn store_detector(&self, detector: Option<WakeWordDetector>) {
        if let Ok(mut guard) = self.detector.lock() {
            *guard = detector;
        }
    }
}
