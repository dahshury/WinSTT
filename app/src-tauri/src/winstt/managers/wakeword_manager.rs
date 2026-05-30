// PORT IMPL — drafted against real APIs, pending compile. Source: app/PORT/05_*.md §A + lib_wiring.md §2/§5,
// server wake-word backends. Wraps winstt::wakeword (presets + keyword builder + detector).
//
// WakeWordManager owns the active wake-word configuration (resolved phrase +
// sensitivity→threshold + ordered keyword labels) and, when the `sherpa` feature
// is enabled, the live `WakeWordDetector`. It is rebuilt on `general.wakeWord` /
// `wakeWordSensitivity` change. The recorder-state transition on a hit
// (INACTIVE → LISTENING + `wakeWordTimeout`) is driven by the audio consumer feed
// in the recording manager; this manager exposes `feed_chunk` (the detection
// step) and emits `wake_word_detected`.
//
// The detector is feature-gated because the sherpa-onnx KWS dep + the BPE
// text2token step are not yet wired (PROGRESS: wakeword still gated). The
// deterministic state + arming + keyword-spec assembly compile unconditionally.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};

use crate::winstt::wakeword::{
    resolve_phrase, sensitivity_to_threshold, WakeWordResult, WAKE_WORD_PRESETS,
};

/// One wake-word preset surfaced to the renderer dropdown.
#[derive(Clone, Debug)]
pub struct WakeWordPresetInfo {
    pub name: String,
    pub phrase: String,
}

/// The currently-armed wake-word state (independent of the FFI detector so the
/// manager can answer the command layer + emit even when KWS isn't compiled in).
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
    #[cfg(feature = "sherpa")]
    detector: Mutex<Option<crate::winstt::wakeword::WakeWordDetector>>,
}

impl WakeWordManager {
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            state: Mutex::new(WakeState {
                sensitivity: 0.6,
                timeout_seconds: 5.0,
                ..WakeState::default()
            }),
            armed: AtomicBool::new(false),
            #[cfg(feature = "sherpa")]
            detector: Mutex::new(None),
        }
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

    /// Reconfigure the wake word (name + sensitivity + timeout). Rebuilds the
    /// detector when the KWS feature is compiled in. An empty `name` disables it.
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
            s.phrase = phrase.clone();
            s.sensitivity = sensitivity.clamp(0.0, 1.0);
            s.timeout_seconds = timeout_seconds.max(0.0);
        }
        self.rebuild_detector()?;
        Ok(())
    }

    /// The resolved `#threshold` for the current sensitivity (direction-flipped).
    pub fn current_threshold(&self) -> f32 {
        let s = self
            .state
            .lock()
            .map(|s| s.sensitivity)
            .unwrap_or(0.6);
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

    /// Arm/disarm wake-word detection (recorder entering/leaving wakeword mode).
    pub fn set_armed(&self, armed: bool) {
        self.armed.store(armed, Ordering::Release);
    }

    /// Feed one 16 kHz mono f32 chunk to the detector (from the audio consumer
    /// feed). On a hit, emits `wake_word_detected` and returns the result.
    /// No-op (returns `none`) when not armed or KWS isn't compiled in.
    pub fn feed_chunk(&self, chunk: &[f32]) -> WakeWordResult {
        if !self.is_armed() {
            return WakeWordResult::none();
        }
        #[cfg(feature = "sherpa")]
        {
            if let Ok(mut guard) = self.detector.lock() {
                if let Some(det) = guard.as_mut() {
                    let result = det.detect(chunk);
                    if result.detected {
                        self.emit_detected(&result);
                    }
                    return result;
                }
            }
        }
        let _ = chunk;
        WakeWordResult::none()
    }

    fn emit_detected(&self, result: &WakeWordResult) {
        let _ = self.app.emit(
            "wake_word_detected",
            serde_json::json!({
                "wordIndex": result.word_index,
                "word": result.word,
            }),
        );
    }

    /// Rebuild the live detector from the current config. When the KWS feature is
    /// absent this is a no-op (the deterministic state is still updated).
    #[cfg(feature = "sherpa")]
    fn rebuild_detector(&self) -> Result<(), String> {
        // SPIKE: the WakeWordConfig assembly (model paths + BPE text2token of the
        // resolved phrase into keyword specs) is wired in the KWS compile loop
        // (05_*.md §A). Until the model bundle download + text2token subprocess
        // land, leave the detector unset (manager stays inert but valid).
        if let Ok(mut guard) = self.detector.lock() {
            *guard = None;
        }
        Ok(())
    }

    #[cfg(not(feature = "sherpa"))]
    fn rebuild_detector(&self) -> Result<(), String> {
        Ok(())
    }
}
