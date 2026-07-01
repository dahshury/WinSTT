// Reference: server wake-word backends
// (porcupine_detector.py / oww_detector.py / composite_wake_word.py).
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
//
// The background model-bundle download + extraction + download-snapshot/status
// state machine lives in the `download` submodule (all free functions over the
// shared `Arc` handles, with no `&self` coupling because the download runs on a
// spawned thread). The manager impl below calls into them via `download::*`.

mod download;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

use crate::winstt::audio_conditioning::{NormalizedFrame, StreamingRmsNormalizer};
use crate::winstt::commands::events::WakeWordDetectedPayload;
use crate::winstt::observability::IssueBuilder;
use crate::winstt::wakeword::{
    build_keywords_file, keyword_label, resolve_phrase, sensitivity_to_threshold,
    tokenize_phrase_for_kws_model, wakeword_runtime_engine_for_name, KeywordSpec, KwsModelPaths,
    LegacyPorcupineDetector, LegacyPorcupinePaths, WakeWordConfig, WakeWordDetector,
    WakeWordProvider, WakeWordResult, WakeWordRuntimeEngine, KWS_BUNDLE_DIRNAME, WAKE_WORD_PRESETS,
};

use download::{
    cleanup_partial_download_for_engine, clear_download_snapshot, download_model_bundle_for_engine,
    emit_wakeword_model_status, hydrate_paused_snapshot_from_partial, mark_download_complete,
    mark_download_failed, mark_download_paused, model_status_from_snapshot,
    partial_download_bytes_for_engine, reset_download_snapshot, status_for_app,
    wakeword_model_root_dir, WakeWordDownloadOutcome,
};

pub(super) const KWS_MODEL_DOWNLOAD_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2";
pub(super) const KWS_MODEL_DOWNLOAD_SHA256: &str =
    "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a";
pub(super) const LEGACY_PORCUPINE_WHEEL_URL: &str = "https://files.pythonhosted.org/packages/49/73/56fe355fe0f124616935510fb68bb46800df343cef0996eeb0b4869745a5/pvporcupine-1.9.5-py3-none-any.whl";
pub(super) const LEGACY_PORCUPINE_WHEEL_SHA256: &str =
    "8f4e95c966f72258b417743e13e8c571d2fb79cdf2fe59571e6766638787481d";
pub(super) const WAKEWORD_MODEL_STATUS_EVENT: &str = "wakeword:model-status";
pub(super) const DOWNLOAD_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const DOWNLOAD_CONTROL_NONE: u8 = 0;
pub(super) const DOWNLOAD_CONTROL_PAUSE: u8 = 1;
pub(super) const DOWNLOAD_CONTROL_CANCEL: u8 = 2;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WakeWordDownloadPhase {
    #[default]
    Idle,
    Downloading,
    Paused,
    Complete,
    Failed,
}

#[derive(Clone, Debug, Default)]
pub(super) struct WakeWordModelDownloadSnapshot {
    pub(super) artifact_label: Option<String>,
    pub(super) downloaded_bytes: Option<u64>,
    pub(super) engine: Option<WakeWordRuntimeEngine>,
    pub(super) eta_seconds: Option<f32>,
    pub(super) error: Option<String>,
    pub(super) phase: WakeWordDownloadPhase,
    pub(super) speed_bps: Option<f32>,
    pub(super) total_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WakeWordModelStatusPayload {
    pub available: bool,
    pub artifact_label: String,
    pub downloaded_bytes: Option<u64>,
    pub download_size_label: String,
    pub downloading: bool,
    pub engine: String,
    pub engine_label: String,
    pub eta_seconds: Option<f32>,
    pub error: Option<String>,
    pub phase: WakeWordDownloadPhase,
    pub progress: Option<f32>,
    pub quality_label: String,
    pub speed_bps: Option<f32>,
    pub total_bytes: Option<u64>,
}

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

enum ActiveWakeWordDetector {
    LegacyPorcupine(LegacyPorcupineDetector),
    Sherpa(WakeWordDetector),
}

impl ActiveWakeWordDetector {
    fn detect(&mut self, chunk: &[f32]) -> WakeWordResult {
        match self {
            ActiveWakeWordDetector::LegacyPorcupine(detector) => detector.detect(chunk),
            ActiveWakeWordDetector::Sherpa(detector) => detector.detect(chunk),
        }
    }

    fn reset(&mut self) {
        match self {
            ActiveWakeWordDetector::LegacyPorcupine(detector) => detector.reset(),
            ActiveWakeWordDetector::Sherpa(detector) => detector.reset(),
        }
    }
}

pub struct WakeWordManager {
    app: AppHandle,
    state: Mutex<WakeState>,
    /// True while wake-word detection is active (recorder in wakeword mode).
    armed: AtomicBool,
    /// The live detector, or `None` when the wake word is disabled OR the
    /// selected engine bundle hasn't been downloaded yet (fail-soft).
    detector: Mutex<Option<ActiveWakeWordDetector>>,
    /// Guards the background model fetch so repeated settings/runtime re-arms do
    /// not start parallel downloads or reopen the microphone with no detector.
    model_download_inflight: Arc<AtomicBool>,
    model_download_control: Arc<AtomicU8>,
    model_download_snapshot: Arc<Mutex<WakeWordModelDownloadSnapshot>>,
    /// Streaming input conditioner for KWS frames. This is intentionally separate
    /// from STT's batch peak-normalizer: wakeword mode must not boost silence
    /// frame-by-frame, but it should level quiet/loud speech before sherpa sees it.
    audio_normalizer: Mutex<StreamingRmsNormalizer>,
    feed_log_counter: AtomicU64,
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
            model_download_inflight: Arc::new(AtomicBool::new(false)),
            model_download_control: Arc::new(AtomicU8::new(DOWNLOAD_CONTROL_NONE)),
            model_download_snapshot: Arc::new(Mutex::new(WakeWordModelDownloadSnapshot::default())),
            audio_normalizer: Mutex::new(StreamingRmsNormalizer::wakeword()),
            feed_log_counter: AtomicU64::new(0),
        };
        // Do not build the sherpa detector in the constructor. When the saved
        // mode is wakeword, startup arms it on a background thread so the app can
        // paint before KWS session creation and microphone open work run.
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
        let result = self.rebuild_detector();
        emit_wakeword_model_status(&self.app, &self.model_status());
        result
    }

    /// Re-read `general.wakeWord` / `wakeWordSensitivity` / `wakeWordTimeout` from
    /// the settings store and rebuild. Called on construction; the command layer
    /// also calls `set_wake_word` directly with the renderer-supplied values.
    pub fn sync_from_settings(&self) {
        let general = crate::winstt::settings_store::read_settings_raw(&self.app).general;
        let name = general.wake_word;
        let sensitivity = general.wake_word_sensitivity as f32;
        let timeout = general.wake_word_timeout as f32;
        if let Err(e) = self.set_wake_word(&name, sensitivity, timeout) {
            warn!("Wake-word sync from settings failed: {e}");
        }
    }

    /// Refresh the selected phrase/runtime metadata without constructing a
    /// detector. Used by the status command while the app is not in wakeword
    /// mode, so the dialog describes the runtime that will actually be needed.
    pub fn sync_selection_from_settings(&self) {
        let general = crate::winstt::settings_store::read_settings_raw(&self.app).general;
        let phrase = if general.wake_word.trim().is_empty() {
            String::new()
        } else {
            resolve_phrase(&general.wake_word)
        };
        match self.state.lock() {
            Ok(mut s) => {
                s.name = general.wake_word;
                s.phrase = phrase;
                s.sensitivity = general.wake_word_sensitivity as f32;
                s.timeout_seconds = general.wake_word_timeout as f32;
            }
            Err(_) => warn!("Wake-word state poisoned during status sync"),
        }
    }

    /// The resolved `#threshold` for the current sensitivity (direction-flipped).
    pub fn current_threshold(&self) -> f32 {
        let s = self.state.lock().map_or(0.6, |s| s.sensitivity);
        sensitivity_to_threshold(s)
    }

    pub fn current_phrase(&self) -> String {
        self.state
            .lock()
            .map(|s| s.phrase.clone())
            .unwrap_or_default()
    }

    pub fn current_engine(&self) -> WakeWordRuntimeEngine {
        self.state
            .lock()
            .map_or(WakeWordRuntimeEngine::SherpaKws, |s| {
                wakeword_runtime_engine_for_name(&s.name)
            })
    }

    pub fn timeout_seconds(&self) -> f32 {
        self.state.lock().map_or(5.0, |s| s.timeout_seconds)
    }

    pub fn is_armed(&self) -> bool {
        self.armed.load(Ordering::Acquire)
    }

    /// True when a live detector is built (a valid phrase + a present model
    /// bundle). The audio consumer can cheaply skip the feed when this is false.
    pub fn has_detector(&self) -> bool {
        self.detector.lock().is_ok_and(|g| g.is_some())
    }

    pub fn has_model_bundle(&self) -> bool {
        self.has_model_bundle_for(self.current_engine())
    }

    pub fn model_bundle_download_inflight(&self) -> bool {
        self.model_download_inflight.load(Ordering::Acquire)
    }

    pub fn model_status(&self) -> WakeWordModelStatusPayload {
        let engine = self.current_engine();
        let mut snapshot = self
            .model_download_snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_default();
        let downloading = self.model_bundle_download_inflight() && snapshot.engine == Some(engine);
        if !downloading && !self.has_model_bundle_for(engine) {
            hydrate_paused_snapshot_from_partial(&self.app, engine, &mut snapshot);
        }
        model_status_from_snapshot(
            engine,
            self.has_model_bundle_for(engine),
            downloading,
            snapshot,
        )
    }

    /// Start a single background download for the runtime selected by the
    /// current wake phrase. Returns true only for the caller that scheduled it.
    pub fn start_model_bundle_download_if_missing(&self) -> bool {
        let engine = self.current_engine();
        if self.has_model_bundle_for(engine) {
            mark_download_complete(&self.model_download_snapshot);
            emit_wakeword_model_status(&self.app, &self.model_status());
            return false;
        }
        if self.model_download_inflight.swap(true, Ordering::AcqRel) {
            return false;
        }

        let app = self.app.clone();
        let inflight = Arc::clone(&self.model_download_inflight);
        let control = Arc::clone(&self.model_download_control);
        let snapshot = Arc::clone(&self.model_download_snapshot);
        control.store(DOWNLOAD_CONTROL_NONE, Ordering::Release);
        let partial_bytes = partial_download_bytes_for_engine(&app, engine);
        reset_download_snapshot(&snapshot, engine, partial_bytes, None);
        emit_wakeword_model_status(&app, &status_for_app(&app, &inflight, &snapshot));
        match std::thread::Builder::new()
            .name("winstt-wakeword-model-download".to_string())
            .spawn(move || {
                info!("[wakeword] downloading {} runtime assets", engine.label());
                let result =
                    download_model_bundle_for_engine(&app, engine, &inflight, &control, &snapshot);

                match result {
                    Ok(WakeWordDownloadOutcome::Complete) => {
                        info!("[wakeword] {} runtime assets ready", engine.label());
                        inflight.store(false, Ordering::Release);
                        control.store(DOWNLOAD_CONTROL_NONE, Ordering::Release);
                        mark_download_complete(&snapshot);
                        emit_wakeword_model_status(
                            &app,
                            &status_for_app(&app, &inflight, &snapshot),
                        );
                        crate::winstt::commands::settings::rearm_wakeword_runtime_if_active(&app);
                    }
                    Ok(WakeWordDownloadOutcome::Paused) => {
                        info!(
                            "[wakeword] {} runtime asset download paused",
                            engine.label()
                        );
                        inflight.store(false, Ordering::Release);
                        control.store(DOWNLOAD_CONTROL_NONE, Ordering::Release);
                        mark_download_paused(&snapshot);
                        emit_wakeword_model_status(
                            &app,
                            &status_for_app(&app, &inflight, &snapshot),
                        );
                    }
                    Ok(WakeWordDownloadOutcome::Cancelled) => {
                        info!(
                            "[wakeword] {} runtime asset download cancelled",
                            engine.label()
                        );
                        inflight.store(false, Ordering::Release);
                        control.store(DOWNLOAD_CONTROL_NONE, Ordering::Release);
                        clear_download_snapshot(&snapshot, engine);
                        emit_wakeword_model_status(
                            &app,
                            &status_for_app(&app, &inflight, &snapshot),
                        );
                    }
                    Err(err) => {
                        warn!(
                            "[wakeword] failed to download {} runtime assets: {err}",
                            engine.label()
                        );
                        let detail = err.clone();
                        inflight.store(false, Ordering::Release);
                        control.store(DOWNLOAD_CONTROL_NONE, Ordering::Release);
                        mark_download_failed(&snapshot, err);
                        IssueBuilder::new(
                            "wakeword_download",
                            "model_bundle_download",
                            "Wake-word runtime asset download failed",
                        )
                        .detail(detail)
                        .model_id(engine.label().to_string())
                        .record(Some(&app));
                        emit_wakeword_model_status(
                            &app,
                            &status_for_app(&app, &inflight, &snapshot),
                        );
                    }
                }
            }) {
            Ok(_) => true,
            Err(err) => {
                self.model_download_inflight.store(false, Ordering::Release);
                self.model_download_control
                    .store(DOWNLOAD_CONTROL_NONE, Ordering::Release);
                mark_download_failed(&self.model_download_snapshot, err.to_string());
                emit_wakeword_model_status(&self.app, &self.model_status());
                warn!("[wakeword] failed to start KWS model download thread: {err}");
                IssueBuilder::new(
                    "wakeword_download",
                    "worker_spawn",
                    "Wake-word runtime download worker failed to start",
                )
                .detail(err.to_string())
                .model_id(engine.label().to_string())
                .record(Some(&self.app));
                false
            }
        }
    }

    pub fn pause_model_bundle_download(&self) -> WakeWordModelStatusPayload {
        if self.model_bundle_download_inflight() {
            self.model_download_control
                .store(DOWNLOAD_CONTROL_PAUSE, Ordering::Release);
        }
        self.model_status()
    }

    pub fn resume_model_bundle_download(&self) -> WakeWordModelStatusPayload {
        self.model_download_control
            .store(DOWNLOAD_CONTROL_NONE, Ordering::Release);
        let _ = self.start_model_bundle_download_if_missing();
        self.model_status()
    }

    pub fn cancel_model_bundle_download(&self) -> WakeWordModelStatusPayload {
        let engine = self.current_engine();
        if self.model_bundle_download_inflight() {
            self.model_download_control
                .store(DOWNLOAD_CONTROL_CANCEL, Ordering::Release);
            return self.model_status();
        }
        cleanup_partial_download_for_engine(&self.app, engine);
        clear_download_snapshot(&self.model_download_snapshot, engine);
        emit_wakeword_model_status(&self.app, &self.model_status());
        self.model_status()
    }

    /// Arm/disarm wake-word detection (recorder entering/leaving wakeword mode).
    /// On arm, the streaming state is reset so a stale partial decode from a
    /// previous session can't fire a phantom hit on the first new chunk.
    pub fn set_armed(&self, armed: bool) -> bool {
        let was = self.armed.swap(armed, Ordering::AcqRel);
        if armed && !was {
            self.reset_audio_normalizer();
            if let Ok(mut guard) = self.detector.lock() {
                if let Some(det) = guard.as_mut() {
                    det.reset();
                }
            }
        }
        was
    }

    /// Drop the active wake-word detector during app shutdown so the native
    /// sherpa/Porcupine session releases before process teardown.
    pub fn shutdown_runtime(&self) {
        self.armed.store(false, Ordering::Release);
        self.store_detector(None);
    }

    /// Feed one 16 kHz mono f32 chunk to the detector (from the audio consumer
    /// feed). On a hit, emits `wake_word_detected` and returns the result.
    /// No-op (returns `none`) when not armed or no detector is built.
    pub fn feed_chunk(&self, chunk: &[f32]) -> WakeWordResult {
        if !self.is_armed() {
            return WakeWordResult::none();
        }
        // Recover a poisoned lock instead of giving up: a panic inside the native
        // sherpa `detect()` would otherwise poison this mutex and make every later
        // `feed_chunk` silently no-op forever. Mirrors the recorder's VAD poison
        // discipline (warn + carry on with the inner guard).
        let mut guard = self.detector.lock().unwrap_or_else(|p| {
            warn!("Wake-word detector lock poisoned; recovering inner guard");
            p.into_inner()
        });
        let Some(det) = guard.as_mut() else {
            return WakeWordResult::none();
        };
        let conditioned = {
            let mut normalizer = self.audio_normalizer.lock().unwrap_or_else(|p| {
                warn!("Wake-word audio normalizer lock poisoned; recovering inner state");
                p.into_inner()
            });
            normalizer.process(chunk)
        };
        self.log_live_feed_sample(&conditioned);
        // Contain a native-inference panic so it can't poison the lock and freeze
        // detection; treat a panicking frame as "no hit".
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            det.detect(&conditioned.samples)
        }))
        .unwrap_or_else(|_| {
            warn!("Wake-word detect panicked; treating chunk as no-hit");
            WakeWordResult::none()
        });
        // Drop the lock before emitting so an event handler can't deadlock by
        // re-entering the manager (e.g. a synchronous set_armed on the same path).
        drop(guard);
        if result.detected {
            self.armed.store(false, Ordering::Release);
            self.emit_detected(&result);
        }
        result
    }

    fn emit_detected(&self, result: &WakeWordResult) {
        info!(
            "Wake word detected: '{}' (index {})",
            result.word, result.word_index
        );
        // Emit the canonical `wakeword:detected` event so the renderer's listener
        // reads `{ word, wordIndex }` (camelCase via the struct's serde rename).
        let _ = self.app.emit(
            crate::winstt::commands::events::names::WAKEWORD_DETECTED,
            WakeWordDetectedPayload {
                word: result.word.clone(),
                word_index: result.word_index,
            },
        );
    }

    fn log_live_feed_sample(&self, frame: &NormalizedFrame) {
        let tick = self.feed_log_counter.fetch_add(1, Ordering::Relaxed);
        if !tick.is_multiple_of(500) {
            return;
        }
        debug!(
            "[wakeword] live feed phrase='{}' frame_len={} raw_peak={:.4} raw_rms={:.4} norm_peak={:.4} norm_rms={:.4} gain={:.2} active={}",
            self.current_phrase(),
            frame.samples.len(),
            frame.raw.peak,
            frame.raw.rms,
            frame.normalized.peak,
            frame.normalized.rms,
            frame.gain,
            frame.active
        );
    }

    fn reset_audio_normalizer(&self) {
        match self.audio_normalizer.lock() {
            Ok(mut normalizer) => normalizer.reset(),
            Err(poisoned) => {
                warn!("Wake-word audio normalizer lock poisoned during reset; recovering");
                poisoned.into_inner().reset();
            }
        }
    }

    /// Resolve the KWS model bundle directory (under the app data dir). The
    /// download manager populates it; we only read it here.
    fn bundle_dir(&self) -> PathBuf {
        crate::portable::app_data_dir(&self.app)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("wakeword")
            .join(KWS_BUNDLE_DIRNAME)
    }

    fn legacy_porcupine_dir(&self) -> PathBuf {
        wakeword_model_root_dir(&self.app).join(LegacyPorcupinePaths::DIRNAME)
    }

    fn has_model_bundle_for(&self, engine: WakeWordRuntimeEngine) -> bool {
        match engine {
            WakeWordRuntimeEngine::LegacyPorcupine => {
                let phrase = self.current_phrase();
                LegacyPorcupinePaths::from_root(self.legacy_porcupine_dir())
                    .all_present_for_keyword(&phrase)
            }
            WakeWordRuntimeEngine::SherpaKws => {
                KwsModelPaths::from_bundle_dir(&self.bundle_dir()).all_present()
            }
        }
    }

    /// Rebuild the live detector from the current state.
    ///
    /// Drops the detector when the wake word is disabled (blank phrase) or the
    /// KWS model bundle isn't fully downloaded yet — both are valid, non-error
    /// states (the manager stays inert until the model lands / a word is set).
    /// Only a genuine sherpa `create` failure surfaces as an `Err`.
    fn rebuild_detector(&self) -> Result<(), String> {
        let (name, phrase, sensitivity, timeout) = {
            let s = self.state.lock().map_err(|_| "wakeword state poisoned")?;
            (
                s.name.clone(),
                s.phrase.clone(),
                s.sensitivity,
                s.timeout_seconds,
            )
        };

        // Disabled → drop the detector and stop.
        if phrase.trim().is_empty() {
            self.store_detector(None);
            return Ok(());
        }

        let engine = wakeword_runtime_engine_for_name(&name);
        if engine == WakeWordRuntimeEngine::LegacyPorcupine {
            let paths = LegacyPorcupinePaths::from_root(self.legacy_porcupine_dir());
            if !paths.all_present_for_keyword(&phrase) {
                debug!(
                    "legacy Porcupine bundle missing at {}; wake word '{phrase}' stays inert until downloaded",
                    paths.root.display()
                );
                self.store_detector(None);
                return Ok(());
            }
            return match LegacyPorcupineDetector::new(&paths, &phrase, sensitivity) {
                Ok(detector) => {
                    debug!("Built legacy Porcupine detector for wake word '{phrase}'");
                    self.store_detector(Some(ActiveWakeWordDetector::LegacyPorcupine(detector)));
                    Ok(())
                }
                Err(e) => {
                    let detail = format!("failed to build legacy Porcupine detector: {e}");
                    self.store_detector(None);
                    IssueBuilder::new(
                        "wakeword",
                        "detector_build",
                        "Wake-word detector failed to build",
                    )
                    .detail(detail.clone())
                    .model_id(engine.label().to_string())
                    .context("phrase", phrase.clone())
                    .record(Some(&self.app));
                    Err(detail)
                }
            };
        }

        // Model bundle not present → inert (the download manager will fetch it;
        // a later sync/set_wake_word rebuilds once the files exist).
        let bundle_dir = self.bundle_dir();
        let int8_model = KwsModelPaths::from_bundle_dir_int8(&bundle_dir);
        let fp32_model = KwsModelPaths::from_bundle_dir(&bundle_dir);
        let model = if int8_model.all_present() {
            debug!("[wakeword] using int8 KWS model bundle");
            int8_model
        } else {
            fp32_model
        };
        if !model.all_present() {
            debug!(
                "KWS model bundle missing at {}; wake word '{phrase}' stays inert until downloaded",
                bundle_dir.display()
            );
            self.store_detector(None);
            return Ok(());
        }

        // Build the inline keyword content (tokens + #threshold + @label) for the
        // single active phrase, then stand up the spotter.
        let tokens = match tokenize_phrase_for_kws_model(&phrase, &model) {
            Ok(tokens) => tokens,
            Err(e) => {
                self.store_detector(None);
                IssueBuilder::new(
                    "wakeword",
                    "tokenize_phrase",
                    "Wake-word phrase tokenization failed",
                )
                .detail(e.clone())
                .model_id(engine.label().to_string())
                .context("phrase", phrase.clone())
                .record(Some(&self.app));
                return Err(e);
            }
        };
        let keywords_content = build_keywords_file(&[KeywordSpec {
            tokens,
            label: keyword_label(&phrase),
            boost: None,
            threshold: Some(sensitivity_to_threshold(sensitivity)),
        }]);
        if keywords_content.trim().is_empty() {
            self.store_detector(None);
            return Ok(());
        }
        debug!("[wakeword] keyword content for '{phrase}': {keywords_content:?}");

        let config = WakeWordConfig {
            model,
            keywords_file: None,
            keywords_content: Some(keywords_content),
            keywords: vec![phrase.trim().to_lowercase()],
            provider: self.resolve_provider(),
            sensitivity,
            timeout_seconds: timeout,
            num_threads: Some(1),
            keywords_score: None,
        };

        match WakeWordDetector::new(&config) {
            Ok(detector) => {
                debug!("Built KWS detector for wake word '{phrase}'");
                self.store_detector(Some(ActiveWakeWordDetector::Sherpa(detector)));
                Ok(())
            }
            Err(e) => {
                let detail = format!("failed to build wake-word detector: {e}");
                self.store_detector(None);
                IssueBuilder::new(
                    "wakeword",
                    "detector_build",
                    "Wake-word detector failed to build",
                )
                .detail(detail.clone())
                .model_id(engine.label().to_string())
                .context("phrase", phrase)
                .record(Some(&self.app));
                Err(detail)
            }
        }
    }

    /// Pick the sherpa provider from the shared model device setting (TTS/STT
    /// share `model.device`) through the same platform-aware STT resolver.
    fn resolve_provider(&self) -> WakeWordProvider {
        let device = crate::winstt::settings_store::read_settings_raw(&self.app)
            .model
            .device;
        WakeWordProvider::from_stt_accelerator(crate::winstt::stt::resolve_accelerator(device))
    }

    fn store_detector(&self, detector: Option<ActiveWakeWordDetector>) {
        self.reset_audio_normalizer();
        if let Ok(mut guard) = self.detector.lock() {
            *guard = detector;
        }
    }
}
