// DRAFT PORT — not yet compiled. Source: WinSTT frontend/src/shared/config/settings-schema.ts
// (the authoritative Zod `appSettingsSchema`; the OpenAPI spec is STALE).
//
// This module ports WinSTT's ~150-field nested settings tree into a single
// specta-typed `WinsttSettings` Rust struct. The nesting mirrors the Zod
// schema's 9 sub-objects exactly (model / quality / audio / general / hotkey /
// dictionary / snippets / llm / tts / integrations) so the reused React
// renderer maps onto it 1:1 over `tauri-specta` bindings.
//
// CONVENTIONS (locked, do not drift):
//   * Field NAMES on the wire are camelCase — the renderer reads/writes the
//     exact same keys WinSTT's electron-store used. Every struct therefore
//     carries `#[serde(rename_all = "camelCase")]` and every enum that needs a
//     specific JSON spelling carries an explicit `#[serde(rename...)]`.
//   * Every field is `#[serde(default = "...")]` (or `#[serde(default)]` for
//     type-default values) so a partial / older persisted JSON never fails the
//     whole parse. This reproduces Zod's per-field `.default()` + `.catch()`
//     "never wipe a whole section on one bad value" guarantee. The matching
//     `Default for WinsttSettings` returns the canonical defaults.
//   * Secrets (`integrations.*.apiKey`, `llm.openrouterApiKey`) are plaintext
//     in this struct but MUST be encrypted at rest by the persistence layer
//     (Handy's `SecretMap` / Tauri `safeStorage` equivalent). See 02_settings.md.
//
// HOT-SWAP vs STARTUP-ONLY: annotated per group below; the canonical machine-
// readable set is `STARTUP_ONLY_KEYS` at the bottom of this file (mirrors
// WinSTT's `STARTUP_ONLY_KEYS_LIST` in electron/ipc/settings.ts, minus the
// retired `model.computeType` — WinSTT is ONNX-only now).

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

// ===========================================================================
// Enums (string unions in the Zod schema → Rust enums with explicit serde spellings)
// ===========================================================================

/// `model.device` — `DeviceTypeSchema` = `["auto", "cpu"]`.
/// ONNX-only WinSTT exposes only auto-vs-CPU; the actual accelerator (DirectML
/// vs CPU) is chosen by the packaging flavor + `device.py`'s EP probe, NOT a
/// persisted user knob. STARTUP-ONLY (binds the ORT EP at session create).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum DeviceType {
    Auto,
    Cpu,
}

/// `model.backend` — `TranscriberBackendSchema`.
/// NOTE(port): the Rust engine (slice 03) is a single unified `ort` runtime, so
/// `faster_whisper` is effectively a legacy default that the load path maps to
/// the ONNX engine. Kept for settings round-trip parity with persisted JSON.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum TranscriberBackend {
    FasterWhisper,
    OnnxAsr,
}

/// `model.modelUnloadTimeout`. IPC normalizes `never` → negative seconds
/// sentinel ("keep loaded forever"), `immediately` → 0 (tear down after each
/// transcription). HOT-SWAP (retunes the idle-unload daemon in place).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ModelUnloadTimeout {
    Immediately,
    Never,
    Min2,
    Min5,
    Min10,
    Min15,
    Hour1,
}

/// `audio.microphoneRelease`. Consolidates Handy's
/// `always_on_microphone` + `lazy_stream_close` + `lazy_close_timeout_seconds`
/// into one picker; the spawn layer fans it back out into those CLI flags.
/// HOT-SWAP (audio-source reconfigure in place).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum MicrophoneRelease {
    Always,
    Immediate,
    Sec30,
    Min1,
    Min5,
}

/// `general.fileTranscriptionFormat`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum FileTranscriptionFormat {
    Txt,
    Srt,
}

/// `general.fileTranscriptionSaveLocation`. `auto` = beside source, `ask` = dialog.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum FileSaveLocation {
    Auto,
    Ask,
}

/// `general.recordingMode`. CONDITIONAL restart: only crossing into/out of
/// `wakeword` (or changing wakeword config while in it) restarts the engine.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum RecordingMode {
    Ptt,
    Toggle,
    Listen,
    Wakeword,
}

/// `general.overlayMode`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayMode {
    FloatingBottom,
    DynamicIsland,
}

/// `general.overlayPosition` — coarse screen-edge gate (distinct from layout style).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum OverlayPosition {
    Auto,
    None,
    Top,
    Bottom,
}

/// `general.visualizerSize` — overlay visualizer height preset.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum VisualizerSize {
    Xs,
    Sm,
    Md,
    Lg,
    Xl,
}

/// `general.liveTranscriptionDisplay`. Also GATES whether realtime is
/// effectively enabled (the `--enable_realtime_transcription` flag) → CONDITIONAL
/// restart when the effective-realtime flag flips.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "kebab-case")]
pub enum LiveTranscriptionDisplay {
    None,
    InApp,
    InPill,
    Both,
}

/// `general.visualizerType`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum VisualizerType {
    Bar,
    Grid,
    Radial,
    Wave,
    Aura,
}

/// `general.visualizerAuraShape`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum VisualizerAuraShape {
    Circle,
    Line,
}

/// `general.onboardedTrack` — which STT track the wizard picked. Empty = wizard
/// not run. Serializes as `""` / `"local"` / `"cloud"`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum OnboardedTrack {
    #[serde(rename = "")]
    Unset,
    Local,
    Cloud,
}

/// `general.autoSubmitKey`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum AutoSubmitKey {
    Enter,
    CtrlEnter,
}

/// `general.recordingRetention`. `never` = keep all; `cap` = oldest beyond
/// historyMaxEntries; days3/weeks2/months3 = absolute age cutoff.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum RecordingRetention {
    Never,
    Cap,
    Days3,
    Weeks2,
    Months3,
}

/// LLM provider for a per-feature config (`llm.dictation` / `llm.transforms`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "kebab-case")]
pub enum LlmProvider {
    Ollama,
    Openrouter,
    AppleIntelligence,
}

/// OpenRouter reasoning effort / verbosity (`low`/`medium`/`high`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum EffortLevel {
    Low,
    Medium,
    High,
}

/// Ollama thinking budget — mirrors Ollama's `ThinkValue` (`off` → `think:false`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingEffort {
    Off,
    Low,
    Medium,
    High,
}

/// LLM preset key (`presetKeySchema`). Built-in cleanup modifiers.
/// Constraints (enforced at the application layer, not by the type): no
/// duplicate keys; ≤1 tone key (Neutral/Formal/Friendly/Technical/Casual);
/// `level` only for Summarize/Concise; `targetLang` only for Translate.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub enum PresetKey {
    Neutral,
    Formal,
    Friendly,
    Technical,
    Casual,
    Concise,
    Summarize,
    Reorder,
    Restructure,
    RewordForClarity,
    Translate,
}

/// `presetLevelSchema` — intensity for summarize/concise (and custom modifiers).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum PresetLevel {
    Light,
    Medium,
    High,
}

/// `tts.source` — local Kokoro vs cloud ElevenLabs.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum TtsSource {
    Local,
    Cloud,
}

// ===========================================================================
// Leaf record structs (re-used across sections)
// ===========================================================================

/// `soundLibraryEntrySchema` — one user-uploaded recording-chime clip.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub struct SoundLibraryEntry {
    pub id: String,
    pub name: String,
    /// Absolute path on disk under `userData/sounds/`.
    pub path: String,
}

/// `dictionaryEntrySchema`. `replacement` absent → vocab-bias word; present →
/// deterministic whole-word replacement applied after LLM cleanup.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryEntry {
    pub id: String,
    pub term: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replacement: Option<String>,
}

/// `snippetEntrySchema` — text-expansion pair.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub struct SnippetEntry {
    pub id: String,
    pub trigger: String,
    pub expansion: String,
}

/// `presetEntrySchema`. `level` valid only for summarize/concise; `targetLang`
/// valid only for translate (cross-field constraints enforced at the app layer).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub struct PresetEntry {
    pub key: PresetKey,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<PresetLevel>,
    /// English name of the target language; only meaningful for `Translate`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_lang: Option<String>,
}

/// `customModifierSchema` — user-authored cleanup modifier. Persists the full
/// definition even while `enabled` is false so the authored name/prompt survives
/// a toggle.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomModifier {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub enabled: bool,
    /// When true a Low/Medium/High switcher tunes the prompt's intensity hint.
    #[serde(default)]
    pub levels_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<PresetLevel>,
}

/// `transformSchema` — a single user-configurable text transform.
/// `builtin: true` entries show a Reset action instead of Delete in the UI.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub hotkey: String,
    #[serde(default)]
    pub builtin: bool,
}

// ===========================================================================
// SECTION: model  (modelSettingsSchema)
// Mostly HOT-SWAP. STARTUP-ONLY here: `device` (binds ORT EP at session create).
// ===========================================================================

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettings {
    /// Catalog id (`tiny`…`large-v3-turbo`, onnx families) OR `<provider>:<id>`
    /// for cloud (`openai:whisper-1`, `elevenlabs:...`) OR a custom-folder id.
    /// HOT-SWAP (in-place engine swap).
    #[serde(default = "ModelSettings::default_model")]
    pub model: String,
    /// Realtime/live-preview model (must support realtime). HOT-SWAP.
    #[serde(default = "ModelSettings::default_realtime_model")]
    pub realtime_model: String,
    /// Forced decode language (`""` = auto-detect). HOT-SWAP.
    #[serde(default = "ModelSettings::default_language")]
    pub language: String,
    /// CPU vs auto-GPU. STARTUP-ONLY.
    #[serde(default)]
    pub device: DeviceType,
    /// Transcriber engine (auto-derived from model id on load). HOT-SWAP.
    #[serde(default)]
    pub backend: TranscriberBackend,
    /// ONNX file quant suffix (`""`, `int8`, `fp16`, `uint8`, `q4`, `q4f16`,
    /// `bnb4`). Free-string (not an enum) — the catalog gates valid values per
    /// model and the server resolves `""`/`auto`. HOT-SWAP.
    #[serde(default)]
    pub onnx_quantization: String,
    /// Whisper decoder-bias prompt (main). HOT-SWAP (read per-utterance).
    /// INVARIANT: Canary/Cohere ignore this slot (untrained) — do not bias them.
    #[serde(default)]
    pub initial_prompt: String,
    /// Decoder-bias prompt for the realtime worker (build-time). HOT-SWAP.
    #[serde(default)]
    pub initial_prompt_realtime: String,
    /// Whisper task=translate (multilingual Whisper only). HOT-SWAP. Zod `.catch(false)`.
    #[serde(default)]
    pub translate_to_english: bool,
    /// Idle-unload policy. HOT-SWAP. Zod `.catch("min5")`.
    #[serde(default)]
    pub model_unload_timeout: ModelUnloadTimeout,
}

impl ModelSettings {
    fn default_model() -> String {
        "tiny".to_string()
    }
    fn default_realtime_model() -> String {
        "tiny".to_string()
    }
    fn default_language() -> String {
        "en".to_string()
    }
}

impl Default for DeviceType {
    fn default() -> Self {
        DeviceType::Auto
    }
}
impl Default for TranscriberBackend {
    fn default() -> Self {
        TranscriberBackend::FasterWhisper
    }
}
impl Default for ModelUnloadTimeout {
    fn default() -> Self {
        ModelUnloadTimeout::Min5
    }
}

impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            model: Self::default_model(),
            realtime_model: Self::default_realtime_model(),
            language: Self::default_language(),
            device: DeviceType::default(),
            backend: TranscriberBackend::default(),
            onnx_quantization: String::new(),
            initial_prompt: String::new(),
            initial_prompt_realtime: String::new(),
            translate_to_english: false,
            model_unload_timeout: ModelUnloadTimeout::default(),
        }
    }
}

// ===========================================================================
// SECTION: quality  (qualitySettingsSchema)
// STARTUP-ONLY: useMainModelForRealtime, realtimeProcessingPause,
// initRealtimeAfterSeconds, earlyTranscriptionOnSilence (realtime pipeline
// bootstrap). The rest are HOT-SWAP.
// ===========================================================================

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct QualitySettings {
    /// Use main model (vs separate realtime model) for live preview. STARTUP-ONLY.
    #[serde(default)]
    pub use_main_model_for_realtime: bool,
    /// Pause between realtime passes (s). STARTUP-ONLY.
    #[serde(default = "QualitySettings::default_realtime_processing_pause")]
    pub realtime_processing_pause: f64,
    /// Delay before spinning up the realtime worker (s). STARTUP-ONLY.
    #[serde(default = "QualitySettings::default_init_realtime_after_seconds")]
    pub init_realtime_after_seconds: f64,
    /// Early-finalize-on-silence threshold (s). STARTUP-ONLY.
    #[serde(default = "QualitySettings::default_early_transcription_on_silence")]
    pub early_transcription_on_silence: f64,
    /// Capitalize first letter of output. HOT-SWAP.
    #[serde(default = "bool_true")]
    pub ensure_sentence_starting_uppercase: bool,
    /// Append terminal period. HOT-SWAP.
    #[serde(default = "bool_true")]
    pub ensure_sentence_ends_with_period: bool,
    /// DistilBERT sentence-completion classifier for endpointing. HOT-SWAP.
    #[serde(default = "bool_true")]
    pub smart_endpoint: bool,
    /// Pause multiplier `(model+whisper)*speed`; higher = more patient.
    /// Range 0.5..3.0. HOT-SWAP.
    #[serde(default = "QualitySettings::default_smart_endpoint_speed")]
    pub smart_endpoint_speed: f64,
    /// Silence after `.!?` before stop (silence-timing fallback). Range 0.1..5.0. HOT-SWAP.
    #[serde(default = "QualitySettings::default_end_of_sentence_detection_pause")]
    pub end_of_sentence_detection_pause: f64,
    /// Silence after `...` before stop. Range 0.1..10.0. HOT-SWAP.
    #[serde(default = "QualitySettings::default_mid_sentence_detection_pause")]
    pub mid_sentence_detection_pause: f64,
    /// Silence after no-terminator speech before stop. Range 0.1..5.0. HOT-SWAP.
    #[serde(default = "QualitySettings::default_unknown_sentence_detection_pause")]
    pub unknown_sentence_detection_pause: f64,
}

impl QualitySettings {
    fn default_realtime_processing_pause() -> f64 {
        0.02
    }
    fn default_init_realtime_after_seconds() -> f64 {
        0.2
    }
    fn default_early_transcription_on_silence() -> f64 {
        0.2
    }
    fn default_smart_endpoint_speed() -> f64 {
        2.0
    }
    fn default_end_of_sentence_detection_pause() -> f64 {
        0.45
    }
    fn default_mid_sentence_detection_pause() -> f64 {
        2.0
    }
    fn default_unknown_sentence_detection_pause() -> f64 {
        1.3
    }
}

impl Default for QualitySettings {
    fn default() -> Self {
        Self {
            use_main_model_for_realtime: false,
            realtime_processing_pause: Self::default_realtime_processing_pause(),
            init_realtime_after_seconds: Self::default_init_realtime_after_seconds(),
            early_transcription_on_silence: Self::default_early_transcription_on_silence(),
            ensure_sentence_starting_uppercase: true,
            ensure_sentence_ends_with_period: true,
            smart_endpoint: true,
            smart_endpoint_speed: Self::default_smart_endpoint_speed(),
            end_of_sentence_detection_pause: Self::default_end_of_sentence_detection_pause(),
            mid_sentence_detection_pause: Self::default_mid_sentence_detection_pause(),
            unknown_sentence_detection_pause: Self::default_unknown_sentence_detection_pause(),
        }
    }
}

// ===========================================================================
// SECTION: audio  (audioSettingsSchema)
// sampleRate / bufferSize / sileroUseOnnx / preRecordingBufferDuration /
// clamshellMicrophone are STARTUP (CLI). The rest are HOT-SWAP.
// ===========================================================================

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    /// Mic index; `null` = system default. HOT-SWAP.
    #[serde(default)]
    pub input_device_index: Option<i64>,
    /// Capture sample rate. STARTUP (CLI).
    #[serde(default = "AudioSettings::default_sample_rate")]
    pub sample_rate: i64,
    /// Audio chunk size. STARTUP (CLI).
    #[serde(default = "AudioSettings::default_buffer_size")]
    pub buffer_size: i64,
    /// Silero VAD sensitivity; trip threshold = `1 - value`. Range 0..1. HOT-SWAP.
    /// INVARIANT: Silero VAD must load CPU-only (CUDA deadlock).
    #[serde(default = "AudioSettings::default_silero_sensitivity")]
    pub silero_sensitivity: f64,
    /// Use ONNX Silero variant. STARTUP (CLI).
    #[serde(default)]
    pub silero_use_onnx: bool,
    /// Silero-based deactivity (Handy parity; config-only, no live consumer). HOT-SWAP (persist-only).
    #[serde(default = "bool_true")]
    pub silero_deactivity_detection: bool,
    /// WebRTC VAD aggressiveness. Range 0..3. HOT-SWAP (`set_mode`).
    #[serde(default = "AudioSettings::default_webrtc_sensitivity")]
    pub webrtc_sensitivity: i64,
    /// Silence after speech before VAD stop (s). HOT-SWAP.
    #[serde(default = "AudioSettings::default_post_speech_silence_duration")]
    pub post_speech_silence_duration: f64,
    /// Min gap between consecutive recordings (s). HOT-SWAP.
    #[serde(default)]
    pub min_gap_between_recordings: f64,
    /// Pre-roll buffer captured before trigger (s). STARTUP.
    #[serde(default = "AudioSettings::default_pre_recording_buffer_duration")]
    pub pre_recording_buffer_duration: f64,
    /// Adaptive-VAD calibration keyed by input-device name (server publishes
    /// `vad_sensitivity_adapted`). HOT-SWAP (re-applied on device switch).
    /// Zod `.catch({})`.
    #[serde(default)]
    pub silero_sensitivity_by_device_name: HashMap<String, f64>,
    /// Alt mic index when laptop lid closed; `null` = disabled. STARTUP. Zod `.catch(null)`.
    #[serde(default)]
    pub clamshell_microphone: Option<i64>,
    /// Mic-stream lifecycle policy. HOT-SWAP. Zod `.catch("immediate")`.
    #[serde(default)]
    pub microphone_release: MicrophoneRelease,
    /// Tail-capture window (ms) after user stop. Range 0..2000. HOT-SWAP. Zod `.catch(0)`.
    #[serde(default)]
    pub extra_recording_buffer_ms: i64,
}

impl AudioSettings {
    fn default_sample_rate() -> i64 {
        16_000
    }
    fn default_buffer_size() -> i64 {
        512
    }
    fn default_silero_sensitivity() -> f64 {
        0.7
    }
    fn default_webrtc_sensitivity() -> i64 {
        3
    }
    fn default_post_speech_silence_duration() -> f64 {
        0.7
    }
    fn default_pre_recording_buffer_duration() -> f64 {
        1.0
    }
}

impl Default for MicrophoneRelease {
    fn default() -> Self {
        MicrophoneRelease::Immediate
    }
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            input_device_index: None,
            sample_rate: Self::default_sample_rate(),
            buffer_size: Self::default_buffer_size(),
            silero_sensitivity: Self::default_silero_sensitivity(),
            silero_use_onnx: false,
            silero_deactivity_detection: true,
            webrtc_sensitivity: Self::default_webrtc_sensitivity(),
            post_speech_silence_duration: Self::default_post_speech_silence_duration(),
            min_gap_between_recordings: 0.0,
            pre_recording_buffer_duration: Self::default_pre_recording_buffer_duration(),
            silero_sensitivity_by_device_name: HashMap::new(),
            clamshell_microphone: None,
            microphone_release: MicrophoneRelease::default(),
            extra_recording_buffer_ms: 0,
        }
    }
}

// ===========================================================================
// SECTION: general  (generalSettingsSchema) — the largest section.
// STARTUP-ONLY: sendCrashReports (Sentry init reads once).
// CONDITIONAL restart: recordingMode↔wakeword boundary; wakeWord /
// wakeWordSensitivity / wakeWordTimeout while in wakeword mode;
// liveTranscriptionDisplay (+ showRecordingOverlay) flipping effective-realtime.
// MAIN-owned (not user controls): onboarded, onboardedAt, onboardedTrack.
// Everything else HOT-SWAP.
// ===========================================================================

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    /// Launch on OS login. HOT-SWAP (Tauri autostart).
    #[serde(default)]
    pub auto_start: bool,
    /// Close → tray instead of quit. HOT-SWAP.
    #[serde(default = "bool_true")]
    pub minimize_to_tray: bool,
    /// Start hidden in tray. HOT-SWAP.
    #[serde(default)]
    pub start_minimized: bool,
    /// Duck system playback to `(100-v)%` while dictating; 0=off, 100=mute.
    /// Range 0..100, UI step 20. HOT-SWAP. Zod `.catch(0)`.
    #[serde(default)]
    pub system_audio_reduction_while_dictating: i64,
    /// Play chime on record start/stop. HOT-SWAP.
    #[serde(default = "bool_true")]
    pub recording_sound: bool,
    /// Active chime clip; `""` = built-in default, else absolute path. HOT-SWAP.
    #[serde(default)]
    pub recording_sound_path: String,
    /// User-uploaded chime clips (copied into `userData/sounds/`). HOT-SWAP. Zod `.catch([])`.
    #[serde(default)]
    pub recording_sound_library: Vec<SoundLibraryEntry>,
    /// Output format for file transcription. HOT-SWAP.
    #[serde(default)]
    pub file_transcription_format: FileTranscriptionFormat,
    /// `auto` = beside source, `ask` = save dialog. HOT-SWAP.
    #[serde(default)]
    pub file_transcription_save_location: FileSaveLocation,
    /// How a recording session starts. CONDITIONAL restart (wakeword boundary).
    #[serde(default)]
    pub recording_mode: RecordingMode,
    /// In toggle mode: continuous press-to-press, disable VAD/silence stop. HOT-SWAP.
    #[serde(default)]
    pub manual_toggle_stop: bool,
    /// Re-paste last transcription — exclusive global shortcut (uiohook accel
    /// format; converted to a Tauri accelerator at registration). HOT-SWAP.
    /// Must be non-empty (Zod `.min(1).catch`).
    #[serde(default = "GeneralSettings::default_repaste_hotkey")]
    pub repaste_hotkey: String,
    /// Loopback device index for `listen` mode; `null` = default. HOT-SWAP.
    #[serde(default)]
    pub loopback_device_index: Option<i64>,
    /// Wake word in `wakeword` mode (Porcupine / openWakeWord keyword; KWS in the
    /// Rust port). CONDITIONAL restart (in wakeword mode).
    #[serde(default = "GeneralSettings::default_wake_word")]
    pub wake_word: String,
    /// Wake-word detector sensitivity. Range 0..1. CONDITIONAL restart.
    #[serde(default = "GeneralSettings::default_wake_word_sensitivity")]
    pub wake_word_sensitivity: f64,
    /// Seconds the gate stays armed after detection. Range 1..30. CONDITIONAL restart.
    #[serde(default = "GeneralSettings::default_wake_word_timeout")]
    pub wake_word_timeout: f64,
    /// Show floating recording pill. CONDITIONAL (affects effective-realtime).
    #[serde(default = "bool_true")]
    pub show_recording_overlay: bool,
    /// Overlay visual layout. HOT-SWAP. Zod `.catch`.
    #[serde(default)]
    pub overlay_mode: OverlayMode,
    /// Whether/where the pill appears. HOT-SWAP. Zod `.catch`.
    #[serde(default)]
    pub overlay_position: OverlayPosition,
    /// Overlay visualizer height preset. HOT-SWAP. Zod `.catch`.
    #[serde(default)]
    pub visualizer_size: VisualizerSize,
    /// Where live preview renders; also gates effective-realtime. CONDITIONAL. Zod `.catch`.
    #[serde(default)]
    pub live_transcription_display: LiveTranscriptionDisplay,
    /// Visualizer style. HOT-SWAP.
    #[serde(default)]
    pub visualizer_type: VisualizerType,
    /// Bars in the visualizer. Range 3..21. HOT-SWAP. Zod `.catch(9)`.
    #[serde(default = "GeneralSettings::default_visualizer_bar_count")]
    pub visualizer_bar_count: i64,
    // --- Radial visualizer knobs ---
    #[serde(default = "GeneralSettings::default_visualizer_radial_dot_count")]
    pub visualizer_radial_dot_count: i64,
    #[serde(default = "GeneralSettings::default_visualizer_radial_radius")]
    pub visualizer_radial_radius: i64,
    // --- Grid visualizer knobs ---
    #[serde(default = "GeneralSettings::default_visualizer_grid_rows")]
    pub visualizer_grid_rows: i64,
    #[serde(default = "GeneralSettings::default_visualizer_grid_columns")]
    pub visualizer_grid_columns: i64,
    #[serde(default = "GeneralSettings::default_visualizer_grid_speed")]
    pub visualizer_grid_speed: i64,
    // --- Wave visualizer knobs ---
    #[serde(default = "GeneralSettings::default_visualizer_wave_line_width")]
    pub visualizer_wave_line_width: i64,
    #[serde(default = "GeneralSettings::default_visualizer_wave_smoothing")]
    pub visualizer_wave_smoothing: i64,
    #[serde(default = "GeneralSettings::default_visualizer_wave_color_shift")]
    pub visualizer_wave_color_shift: i64,
    // --- Aura visualizer knobs ---
    #[serde(default)]
    pub visualizer_aura_shape: VisualizerAuraShape,
    #[serde(default = "GeneralSettings::default_visualizer_aura_blur")]
    pub visualizer_aura_blur: i64,
    #[serde(default)]
    pub visualizer_aura_bloom: i64,
    #[serde(default = "GeneralSettings::default_visualizer_aura_color_shift")]
    pub visualizer_aura_color_shift: i64,
    /// Read focused-window text (UIA/AX) → feed LLM cleanup. HOT-SWAP.
    #[serde(default)]
    pub context_awareness: bool,
    /// Deny-list for context capture (exe basenames / URL host suffixes). HOT-SWAP.
    /// Seeded with common password managers. Zod `.catch(<same seed>)`.
    #[serde(default = "GeneralSettings::default_context_deny_list")]
    pub context_deny_list: Vec<String>,
    /// Per-utterance speaker diarization (~32 MB models, first-run download).
    /// HOT-SWAP (runtime toggle via diarization-toggle method).
    #[serde(default)]
    pub speaker_diarization: bool,
    /// Sentry crash-reporting opt-out. STARTUP-ONLY (Sentry `init()` reads once).
    #[serde(default = "bool_true")]
    pub send_crash_reports: bool,
    /// Opt-in pre-release auto-updates. HOT-SWAP.
    #[serde(default)]
    pub receive_prerelease_updates: bool,
    /// First-run wizard gate (MAIN-owned). Zod `.catch(false)`.
    #[serde(default)]
    pub onboarded: bool,
    /// Epoch-ms when wizard finished/skipped (MAIN-owned). Zod `.catch(null)`.
    #[serde(default)]
    pub onboarded_at: Option<i64>,
    /// Which STT track the wizard picked (MAIN-owned). Zod `.catch("")`.
    #[serde(default)]
    pub onboarded_track: OnboardedTrack,
    /// Output device for TTS + chimes (`MediaDeviceInfo.deviceId`; `""`=default).
    /// HOT-SWAP. Zod `.catch("")`.
    #[serde(default)]
    pub output_device_id: String,
    /// Auto-press a submit key after each paste. HOT-SWAP. Zod `.catch(false)`.
    #[serde(default)]
    pub auto_submit: bool,
    /// Which key combo to inject on auto-submit. HOT-SWAP. Zod `.catch("enter")`.
    #[serde(default)]
    pub auto_submit_key: AutoSubmitKey,
    /// Cap on persisted history entries. Range 10..10000. HOT-SWAP. Zod `.catch(1000)`.
    #[serde(default = "GeneralSettings::default_history_max_entries")]
    pub history_max_entries: i64,
    /// Auto-delete saved WAV recordings policy. HOT-SWAP. Zod `.catch("cap")`.
    #[serde(default)]
    pub recording_retention: RecordingRetention,
    /// Server fuzzy-corrector max score (lower=stricter). Range 0..1. HOT-SWAP. Zod `.catch(0.18)`.
    #[serde(default = "GeneralSettings::default_word_correction_threshold")]
    pub word_correction_threshold: f64,
    /// Strip filler words + collapse 3+ stutters. HOT-SWAP. Zod `.catch(true)`.
    #[serde(default = "bool_true")]
    pub filter_fillers: bool,
    /// Per-user override of the filler-word table. HOT-SWAP. Zod `.catch([])`.
    #[serde(default)]
    pub custom_filler_words: Vec<String>,
}

impl GeneralSettings {
    fn default_repaste_hotkey() -> String {
        "LCtrl+LShift+V".to_string()
    }
    fn default_wake_word() -> String {
        "alexa".to_string()
    }
    fn default_wake_word_sensitivity() -> f64 {
        0.6
    }
    fn default_wake_word_timeout() -> f64 {
        5.0
    }
    fn default_visualizer_bar_count() -> i64 {
        9
    }
    fn default_visualizer_radial_dot_count() -> i64 {
        24
    }
    fn default_visualizer_radial_radius() -> i64 {
        57
    }
    fn default_visualizer_grid_rows() -> i64 {
        5
    }
    fn default_visualizer_grid_columns() -> i64 {
        5
    }
    fn default_visualizer_grid_speed() -> i64 {
        6
    }
    fn default_visualizer_wave_line_width() -> i64 {
        2
    }
    fn default_visualizer_wave_smoothing() -> i64 {
        50
    }
    fn default_visualizer_wave_color_shift() -> i64 {
        5
    }
    fn default_visualizer_aura_blur() -> i64 {
        20
    }
    fn default_visualizer_aura_color_shift() -> i64 {
        5
    }
    fn default_history_max_entries() -> i64 {
        1000
    }
    fn default_word_correction_threshold() -> f64 {
        0.18
    }
    /// The exact seed list from the Zod schema (also used as Zod's `.catch`).
    pub fn default_context_deny_list() -> Vec<String> {
        vec![
            "1password.exe".to_string(),
            "bitwarden.exe".to_string(),
            "keepass.exe".to_string(),
            "keepassxc.exe".to_string(),
            "dashlane.exe".to_string(),
            "lastpass.exe".to_string(),
        ]
    }
}

impl Default for FileTranscriptionFormat {
    fn default() -> Self {
        FileTranscriptionFormat::Txt
    }
}
impl Default for FileSaveLocation {
    fn default() -> Self {
        FileSaveLocation::Auto
    }
}
impl Default for RecordingMode {
    fn default() -> Self {
        RecordingMode::Ptt
    }
}
impl Default for OverlayMode {
    fn default() -> Self {
        OverlayMode::FloatingBottom
    }
}
impl Default for OverlayPosition {
    fn default() -> Self {
        OverlayPosition::Auto
    }
}
impl Default for VisualizerSize {
    fn default() -> Self {
        VisualizerSize::Xs
    }
}
impl Default for LiveTranscriptionDisplay {
    fn default() -> Self {
        LiveTranscriptionDisplay::Both
    }
}
impl Default for VisualizerType {
    fn default() -> Self {
        VisualizerType::Bar
    }
}
impl Default for VisualizerAuraShape {
    fn default() -> Self {
        VisualizerAuraShape::Circle
    }
}
impl Default for OnboardedTrack {
    fn default() -> Self {
        OnboardedTrack::Unset
    }
}
impl Default for AutoSubmitKey {
    fn default() -> Self {
        AutoSubmitKey::Enter
    }
}
impl Default for RecordingRetention {
    fn default() -> Self {
        RecordingRetention::Cap
    }
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            auto_start: false,
            minimize_to_tray: true,
            start_minimized: false,
            system_audio_reduction_while_dictating: 0,
            recording_sound: true,
            recording_sound_path: String::new(),
            recording_sound_library: Vec::new(),
            file_transcription_format: FileTranscriptionFormat::default(),
            file_transcription_save_location: FileSaveLocation::default(),
            recording_mode: RecordingMode::default(),
            manual_toggle_stop: false,
            repaste_hotkey: Self::default_repaste_hotkey(),
            loopback_device_index: None,
            wake_word: Self::default_wake_word(),
            wake_word_sensitivity: Self::default_wake_word_sensitivity(),
            wake_word_timeout: Self::default_wake_word_timeout(),
            show_recording_overlay: true,
            overlay_mode: OverlayMode::default(),
            overlay_position: OverlayPosition::default(),
            visualizer_size: VisualizerSize::default(),
            live_transcription_display: LiveTranscriptionDisplay::default(),
            visualizer_type: VisualizerType::default(),
            visualizer_bar_count: Self::default_visualizer_bar_count(),
            visualizer_radial_dot_count: Self::default_visualizer_radial_dot_count(),
            visualizer_radial_radius: Self::default_visualizer_radial_radius(),
            visualizer_grid_rows: Self::default_visualizer_grid_rows(),
            visualizer_grid_columns: Self::default_visualizer_grid_columns(),
            visualizer_grid_speed: Self::default_visualizer_grid_speed(),
            visualizer_wave_line_width: Self::default_visualizer_wave_line_width(),
            visualizer_wave_smoothing: Self::default_visualizer_wave_smoothing(),
            visualizer_wave_color_shift: Self::default_visualizer_wave_color_shift(),
            visualizer_aura_shape: VisualizerAuraShape::default(),
            visualizer_aura_blur: Self::default_visualizer_aura_blur(),
            visualizer_aura_bloom: 0,
            visualizer_aura_color_shift: Self::default_visualizer_aura_color_shift(),
            context_awareness: false,
            context_deny_list: Self::default_context_deny_list(),
            speaker_diarization: false,
            send_crash_reports: true,
            receive_prerelease_updates: false,
            onboarded: false,
            onboarded_at: None,
            onboarded_track: OnboardedTrack::default(),
            output_device_id: String::new(),
            auto_submit: false,
            auto_submit_key: AutoSubmitKey::default(),
            history_max_entries: Self::default_history_max_entries(),
            recording_retention: RecordingRetention::default(),
            word_correction_threshold: Self::default_word_correction_threshold(),
            filter_fillers: true,
            custom_filler_words: Vec::new(),
        }
    }
}

// ===========================================================================
// SECTION: hotkey  (hotkeySettingsSchema)
// ===========================================================================

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub struct HotkeySettings {
    /// Primary PTT/toggle hotkey (uiohook accelerator). HOT-SWAP (passive).
    /// Must be non-empty (Zod `.min(1).catch`).
    #[serde(default = "HotkeySettings::default_push_to_talk_key")]
    pub push_to_talk_key: String,
}

impl HotkeySettings {
    fn default_push_to_talk_key() -> String {
        "LCtrl+LMeta".to_string()
    }
}

impl Default for HotkeySettings {
    fn default() -> Self {
        Self {
            push_to_talk_key: Self::default_push_to_talk_key(),
        }
    }
}

// ===========================================================================
// SECTION: llm  (llmSettingsSchema)
// All HOT-SWAP — the LLM cleanup runs per-utterance / on demand and re-reads config.
// SECRET: `openrouter_api_key` → encrypt at rest.
// ===========================================================================

/// `llmFeatureBaseShape` — shared across `dictation` and `transforms`.
///
/// `#[serde(flatten)]`-ed into both feature structs, so each field carries its
/// own `#[serde(default = ...)]`: with flatten, serde does NOT honor a `default`
/// on the *flattened field itself* (the combination is rejected at derive time),
/// so the only way to keep "a missing inner key falls back to its default" is to
/// default each inner field independently. This reproduces Zod's per-field
/// `.default()` inside the spread.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct LlmFeatureBase {
    #[serde(default)]
    pub provider: LlmProvider,
    /// Ollama model name.
    #[serde(default)]
    pub model: String,
    /// `modelId` or `modelId@providerSlug`; `""` = Auto.
    #[serde(default)]
    pub openrouter_model: String,
    #[serde(default)]
    pub openrouter_fallback_model: String,
    #[serde(default)]
    pub reasoning_effort: EffortLevel,
    #[serde(default)]
    pub verbosity: EffortLevel,
    #[serde(default)]
    pub max_output_tokens: Option<i64>,
    #[serde(default)]
    pub thinking_effort: ThinkingEffort,
}

impl Default for LlmProvider {
    fn default() -> Self {
        LlmProvider::Ollama
    }
}
impl Default for EffortLevel {
    fn default() -> Self {
        EffortLevel::Medium
    }
}
impl Default for ThinkingEffort {
    fn default() -> Self {
        ThinkingEffort::Medium
    }
}

impl Default for LlmFeatureBase {
    fn default() -> Self {
        Self {
            provider: LlmProvider::default(),
            model: String::new(),
            openrouter_model: String::new(),
            openrouter_fallback_model: String::new(),
            reasoning_effort: EffortLevel::Medium,
            verbosity: EffortLevel::Medium,
            max_output_tokens: None,
            thinking_effort: ThinkingEffort::Medium,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct LlmDictation {
    #[serde(default)]
    pub enabled: bool,
    /// Flattened so the shared fields sit at `llm.dictation.<field>` (matches
    /// Zod's `...llmFeatureBaseShape` spread). Inner-field defaults handle a
    /// partial JSON; see the note on `LlmFeatureBase`.
    #[serde(flatten)]
    pub base: LlmFeatureBase,
    #[serde(default = "default_neutral_presets")]
    pub presets: Vec<PresetEntry>,
    #[serde(default)]
    pub custom_modifiers: Vec<CustomModifier>,
}

impl Default for LlmDictation {
    fn default() -> Self {
        Self {
            enabled: false,
            base: LlmFeatureBase::default(),
            presets: default_neutral_presets(),
            custom_modifiers: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct LlmTransforms {
    #[serde(default)]
    pub enabled: bool,
    #[serde(flatten)]
    pub base: LlmFeatureBase,
    #[serde(default = "default_neutral_presets")]
    pub presets: Vec<PresetEntry>,
    #[serde(default)]
    pub custom_modifiers: Vec<CustomModifier>,
    /// Always non-empty (Zod `.min(1).catch`). The transform's invoke hotkey.
    #[serde(default = "LlmTransforms::default_hotkey")]
    pub hotkey: String,
    /// User-configurable text transforms (built-ins carry `builtin: true`).
    #[serde(default)]
    pub prompts: Vec<Transform>,
}

impl LlmTransforms {
    fn default_hotkey() -> String {
        "LCtrl+LShift+T".to_string()
    }
}

impl Default for LlmTransforms {
    fn default() -> Self {
        Self {
            enabled: false,
            base: LlmFeatureBase::default(),
            presets: default_neutral_presets(),
            custom_modifiers: Vec::new(),
            hotkey: Self::default_hotkey(),
            prompts: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettings {
    /// Shared Ollama endpoint URL.
    #[serde(default = "LlmSettings::default_endpoint")]
    pub endpoint: String,
    /// SECRET — OpenRouter API key. Encrypt at rest (see 02_settings.md).
    #[serde(default)]
    pub openrouter_api_key: String,
    #[serde(default)]
    pub dictation: LlmDictation,
    #[serde(default)]
    pub transforms: LlmTransforms,
    /// Client request timeout (ms). Range 1000..30000. Persisted but NOT applied at network layer.
    #[serde(default = "LlmSettings::default_timeout")]
    pub timeout: i64,
}

impl LlmSettings {
    fn default_endpoint() -> String {
        "http://localhost:11434".to_string()
    }
    fn default_timeout() -> i64 {
        5000
    }
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            endpoint: Self::default_endpoint(),
            openrouter_api_key: String::new(),
            dictation: LlmDictation::default(),
            transforms: LlmTransforms::default(),
            timeout: Self::default_timeout(),
        }
    }
}

// ===========================================================================
// SECTION: tts  (ttsSettingsSchema) — NOT in OpenAPI spec.
// All HOT-SWAP. No per-TTS device — shares `model.device` (see memory
// project_tts_device_follows_model_device).
// SECRET: cloud TTS reuses `integrations.elevenlabs.apiKey` (no new key here).
// ===========================================================================

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct TtsCloud {
    /// ElevenLabs account voice_id.
    #[serde(default)]
    pub voice: String,
    #[serde(default = "TtsCloud::default_model")]
    pub model: String,
    /// 0..1.
    #[serde(default = "TtsCloud::default_stability")]
    pub stability: f64,
    /// 0..1.
    #[serde(default = "TtsCloud::default_similarity")]
    pub similarity: f64,
    /// 0..1.
    #[serde(default)]
    pub style: f64,
    /// 0.7..1.2.
    #[serde(default = "TtsCloud::default_speed")]
    pub speed: f64,
    #[serde(default = "bool_true")]
    pub speaker_boost: bool,
}

impl TtsCloud {
    fn default_model() -> String {
        "eleven_multilingual_v2".to_string()
    }
    fn default_stability() -> f64 {
        0.5
    }
    fn default_similarity() -> f64 {
        0.75
    }
    fn default_speed() -> f64 {
        1.0
    }
}

impl Default for TtsCloud {
    fn default() -> Self {
        Self {
            voice: String::new(),
            model: Self::default_model(),
            stability: Self::default_stability(),
            similarity: Self::default_similarity(),
            style: 0.0,
            speed: Self::default_speed(),
            speaker_boost: true,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct TtsSettings {
    #[serde(default)]
    pub enabled: bool,
    /// Kokoro voice catalog id.
    #[serde(default = "TtsSettings::default_voice")]
    pub voice: String,
    #[serde(default = "TtsSettings::default_lang")]
    pub lang: String,
    /// 0.5..2.0 multiplier.
    #[serde(default = "TtsSettings::default_speed")]
    pub speed: f64,
    /// Read-selection-aloud hotkey. Must be non-empty (Zod `.min(1).catch`).
    #[serde(default = "TtsSettings::default_hotkey")]
    pub hotkey: String,
    /// Local Kokoro vs cloud ElevenLabs.
    #[serde(default)]
    pub source: TtsSource,
    #[serde(default)]
    pub cloud: TtsCloud,
}

impl TtsSettings {
    fn default_voice() -> String {
        "af_heart".to_string()
    }
    fn default_lang() -> String {
        "en-us".to_string()
    }
    fn default_speed() -> f64 {
        1.0
    }
    fn default_hotkey() -> String {
        "LMeta+LShift+E".to_string()
    }
}

impl Default for TtsSource {
    fn default() -> Self {
        TtsSource::Local
    }
}

impl Default for TtsSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            voice: Self::default_voice(),
            lang: Self::default_lang(),
            speed: Self::default_speed(),
            hotkey: Self::default_hotkey(),
            source: TtsSource::default(),
            cloud: TtsCloud::default(),
        }
    }
}

// ===========================================================================
// SECTION: integrations  (integrationsSchema) — cloud STT credentials.
// SECRET: each `api_key` → encrypt at rest. The active cloud STT model is NOT
// here — it is a `<provider>:<id>` string in `model.model`.
// ===========================================================================

/// `providerIntegrationStatusSchema`. `api_key` is plaintext in-memory but
/// MUST be encrypted at rest (`enc:v1:<base64>`); the persistence layer
/// transparently encrypts on save / decrypts on read.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIntegrationStatus {
    /// SECRET — encrypt at rest.
    #[serde(default)]
    pub api_key: String,
    /// Result of the last probe; `null` = never probed.
    #[serde(default)]
    pub verified: Option<bool>,
    /// Epoch-ms of last successful probe.
    #[serde(default)]
    pub last_verified_at: Option<i64>,
}

impl Default for ProviderIntegrationStatus {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            verified: None,
            last_verified_at: None,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationsSettings {
    #[serde(default)]
    pub openai: ProviderIntegrationStatus,
    #[serde(default)]
    pub elevenlabs: ProviderIntegrationStatus,
}

impl Default for IntegrationsSettings {
    fn default() -> Self {
        Self {
            openai: ProviderIntegrationStatus::default(),
            elevenlabs: ProviderIntegrationStatus::default(),
        }
    }
}

// ===========================================================================
// TOP-LEVEL: WinsttSettings  (appSettingsSchema)
// ===========================================================================

/// The complete WinSTT settings tree, nested by the 9 settings tabs, ported
/// 1:1 from `appSettingsSchema` (Zod). Serializes to the exact camelCase JSON
/// the reused React renderer expects.
///
/// Persisted via the Tauri store (one JSON value). Secrets are encrypted at
/// rest by the persistence layer — they are plaintext on this struct.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct WinsttSettings {
    #[serde(default)]
    pub model: ModelSettings,
    #[serde(default)]
    pub quality: QualitySettings,
    #[serde(default)]
    pub audio: AudioSettings,
    #[serde(default)]
    pub general: GeneralSettings,
    #[serde(default)]
    pub hotkey: HotkeySettings,
    /// `[]` default; Zod `.catch([])` (pre-v10 entries fail the parser → wiped).
    #[serde(default)]
    pub dictionary: Vec<DictionaryEntry>,
    #[serde(default)]
    pub snippets: Vec<SnippetEntry>,
    #[serde(default)]
    pub llm: LlmSettings,
    #[serde(default)]
    pub tts: TtsSettings,
    #[serde(default)]
    pub integrations: IntegrationsSettings,
}

impl Default for WinsttSettings {
    fn default() -> Self {
        Self {
            model: ModelSettings::default(),
            quality: QualitySettings::default(),
            audio: AudioSettings::default(),
            general: GeneralSettings::default(),
            hotkey: HotkeySettings::default(),
            dictionary: Vec::new(),
            snippets: Vec::new(),
            llm: LlmSettings::default(),
            tts: TtsSettings::default(),
            integrations: IntegrationsSettings::default(),
        }
    }
}

// ===========================================================================
// Helpers / shared default fns
// ===========================================================================

/// Shared `#[serde(default = ...)]` helper for fields that default to `true`
/// (serde's bool default is `false`, so true-defaulted fields need this).
pub fn bool_true() -> bool {
    true
}

/// The `presetsSchema` default: a single `neutral` tone preset.
fn default_neutral_presets() -> Vec<PresetEntry> {
    vec![PresetEntry {
        key: PresetKey::Neutral,
        level: None,
        target_lang: None,
    }]
}

// ===========================================================================
// Hot-swap classification (machine-readable; mirrors WinSTT's
// STARTUP_ONLY_KEYS_LIST in electron/ipc/settings.ts, minus the retired
// `model.computeType` — WinSTT is ONNX-only).
//
// A settings change triggers an engine restart ONLY when:
//   1. a key in STARTUP_ONLY_KEYS changed; OR
//   2. the wakeword config branch changed (see WAKEWORD_CONFIG_KEYS) while in /
//      crossing wakeword mode; OR
//   3. effective-realtime flipped (liveTranscriptionDisplay / showRecordingOverlay).
// Everything else is hot-swapped in place.
// ===========================================================================

/// Dot-paths that force a full engine restart when changed.
pub const STARTUP_ONLY_KEYS: &[&str] = &[
    "model.device",
    "quality.useMainModelForRealtime",
    "quality.realtimeProcessingPause",
    "quality.initRealtimeAfterSeconds",
    "quality.earlyTranscriptionOnSilence",
    // Sentry init reads once at startup; cannot be cleanly reversed at runtime.
    "general.sendCrashReports",
];

/// Dot-paths that force a restart only while in (or crossing into/out of)
/// wakeword recording mode.
pub const WAKEWORD_CONFIG_KEYS: &[&str] = &[
    "general.recordingMode",
    "general.wakeWord",
    "general.wakeWordSensitivity",
    "general.wakeWordTimeout",
];

/// Dot-paths that can flip whether realtime transcription is *effectively*
/// enabled (the engine's `--enable_realtime_transcription` flag). A restart is
/// needed only when the effective flag actually changes.
pub const REALTIME_EFFECTIVE_KEYS: &[&str] = &[
    "general.liveTranscriptionDisplay",
    "general.showRecordingOverlay",
];

/// Secret dot-paths — encrypted at rest by the persistence layer.
pub const SECRET_KEYS: &[&str] = &[
    "llm.openrouterApiKey",
    "integrations.openai.apiKey",
    "integrations.elevenlabs.apiKey",
];

/// Returns true if a change to `dot_path` unconditionally requires an engine
/// restart (the startup-only set). Wakeword / realtime conditional restarts are
/// state-dependent and handled by the settings-apply layer, not by this fn.
pub fn is_startup_only(dot_path: &str) -> bool {
    STARTUP_ONLY_KEYS.contains(&dot_path)
}

/// Returns true if `dot_path` holds a secret that must be encrypted at rest.
pub fn is_secret(dot_path: &str) -> bool {
    SECRET_KEYS.contains(&dot_path)
}

// ===========================================================================
// Tests — deterministic round-trip + default verification against the Zod schema.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_zod_schema() {
        let s = WinsttSettings::default();

        // model
        assert_eq!(s.model.model, "tiny");
        assert_eq!(s.model.realtime_model, "tiny");
        assert_eq!(s.model.language, "en");
        assert_eq!(s.model.device, DeviceType::Auto);
        assert_eq!(s.model.backend, TranscriberBackend::FasterWhisper);
        assert_eq!(s.model.onnx_quantization, "");
        assert!(!s.model.translate_to_english);
        assert_eq!(s.model.model_unload_timeout, ModelUnloadTimeout::Min5);

        // quality
        assert!(!s.quality.use_main_model_for_realtime);
        assert_eq!(s.quality.realtime_processing_pause, 0.02);
        assert_eq!(s.quality.init_realtime_after_seconds, 0.2);
        assert_eq!(s.quality.early_transcription_on_silence, 0.2);
        assert!(s.quality.ensure_sentence_starting_uppercase);
        assert!(s.quality.ensure_sentence_ends_with_period);
        assert!(s.quality.smart_endpoint);
        assert_eq!(s.quality.smart_endpoint_speed, 2.0);
        assert_eq!(s.quality.end_of_sentence_detection_pause, 0.45);
        assert_eq!(s.quality.mid_sentence_detection_pause, 2.0);
        assert_eq!(s.quality.unknown_sentence_detection_pause, 1.3);

        // audio
        assert_eq!(s.audio.input_device_index, None);
        assert_eq!(s.audio.sample_rate, 16_000);
        assert_eq!(s.audio.buffer_size, 512);
        assert_eq!(s.audio.silero_sensitivity, 0.7);
        assert!(!s.audio.silero_use_onnx);
        assert!(s.audio.silero_deactivity_detection);
        assert_eq!(s.audio.webrtc_sensitivity, 3);
        assert_eq!(s.audio.post_speech_silence_duration, 0.7);
        assert_eq!(s.audio.min_gap_between_recordings, 0.0);
        assert_eq!(s.audio.pre_recording_buffer_duration, 1.0);
        assert_eq!(s.audio.microphone_release, MicrophoneRelease::Immediate);
        assert_eq!(s.audio.extra_recording_buffer_ms, 0);

        // general (spot checks across the largest section)
        assert!(!s.general.auto_start);
        assert!(s.general.minimize_to_tray);
        assert_eq!(s.general.repaste_hotkey, "LCtrl+LShift+V");
        assert_eq!(s.general.recording_mode, RecordingMode::Ptt);
        assert_eq!(s.general.wake_word, "alexa");
        assert_eq!(s.general.wake_word_sensitivity, 0.6);
        assert_eq!(s.general.wake_word_timeout, 5.0);
        assert_eq!(s.general.live_transcription_display, LiveTranscriptionDisplay::Both);
        assert_eq!(s.general.overlay_mode, OverlayMode::FloatingBottom);
        assert_eq!(s.general.overlay_position, OverlayPosition::Auto);
        assert_eq!(s.general.visualizer_size, VisualizerSize::Xs);
        assert_eq!(s.general.visualizer_type, VisualizerType::Bar);
        assert_eq!(s.general.visualizer_bar_count, 9);
        assert_eq!(s.general.visualizer_radial_dot_count, 24);
        assert_eq!(s.general.visualizer_radial_radius, 57);
        assert_eq!(s.general.visualizer_grid_rows, 5);
        assert_eq!(s.general.visualizer_grid_speed, 6);
        assert_eq!(s.general.visualizer_aura_shape, VisualizerAuraShape::Circle);
        assert!(s.general.send_crash_reports);
        assert!(s.general.filter_fillers);
        assert_eq!(s.general.history_max_entries, 1000);
        assert_eq!(s.general.recording_retention, RecordingRetention::Cap);
        assert_eq!(s.general.word_correction_threshold, 0.18);
        assert_eq!(s.general.auto_submit_key, AutoSubmitKey::Enter);
        assert_eq!(s.general.onboarded_track, OnboardedTrack::Unset);
        assert_eq!(
            s.general.context_deny_list,
            vec![
                "1password.exe",
                "bitwarden.exe",
                "keepass.exe",
                "keepassxc.exe",
                "dashlane.exe",
                "lastpass.exe",
            ]
        );

        // hotkey
        assert_eq!(s.hotkey.push_to_talk_key, "LCtrl+LMeta");

        // dictionary / snippets
        assert!(s.dictionary.is_empty());
        assert!(s.snippets.is_empty());

        // llm
        assert_eq!(s.llm.endpoint, "http://localhost:11434");
        assert_eq!(s.llm.timeout, 5000);
        assert!(!s.llm.dictation.enabled);
        assert_eq!(s.llm.dictation.base.provider, LlmProvider::Ollama);
        assert_eq!(s.llm.dictation.base.reasoning_effort, EffortLevel::Medium);
        assert_eq!(s.llm.dictation.base.thinking_effort, ThinkingEffort::Medium);
        assert_eq!(s.llm.dictation.presets.len(), 1);
        assert_eq!(s.llm.dictation.presets[0].key, PresetKey::Neutral);
        assert_eq!(s.llm.transforms.hotkey, "LCtrl+LShift+T");

        // tts
        assert!(!s.tts.enabled);
        assert_eq!(s.tts.voice, "af_heart");
        assert_eq!(s.tts.lang, "en-us");
        assert_eq!(s.tts.speed, 1.0);
        assert_eq!(s.tts.hotkey, "LMeta+LShift+E");
        assert_eq!(s.tts.source, TtsSource::Local);
        assert_eq!(s.tts.cloud.model, "eleven_multilingual_v2");
        assert_eq!(s.tts.cloud.stability, 0.5);
        assert_eq!(s.tts.cloud.similarity, 0.75);
        assert!(s.tts.cloud.speaker_boost);

        // integrations
        assert_eq!(s.integrations.openai.api_key, "");
        assert_eq!(s.integrations.openai.verified, None);
        assert_eq!(s.integrations.elevenlabs.last_verified_at, None);
    }

    #[test]
    fn empty_json_object_yields_all_defaults() {
        // Reproduces Zod `appSettingsSchema.parse({})` — a `{}` persisted blob
        // must hydrate to the full default tree, never error.
        let s: WinsttSettings = serde_json::from_str("{}").expect("empty object must parse");
        assert_eq!(s, WinsttSettings::default());
    }

    #[test]
    fn partial_section_does_not_wipe_other_sections() {
        // One field set in `model`; everything else (including the rest of
        // `model`) must fall back to defaults — the per-field `.default()`
        // guarantee from Zod.
        let json = r#"{ "model": { "language": "fr" } }"#;
        let s: WinsttSettings = serde_json::from_str(json).expect("partial must parse");
        assert_eq!(s.model.language, "fr");
        assert_eq!(s.model.model, "tiny"); // sibling defaulted
        assert_eq!(s.general.repaste_hotkey, "LCtrl+LShift+V"); // other section defaulted
        assert!(s.tts.cloud.speaker_boost);
    }

    #[test]
    fn camel_case_wire_format_round_trips() {
        let s = WinsttSettings::default();
        let v = serde_json::to_value(&s).expect("serialize");
        // Renderer reads these exact keys.
        assert!(v["model"]["realtimeModel"].is_string());
        assert!(v["quality"]["smartEndpointSpeed"].is_number());
        assert!(v["audio"]["microphoneRelease"].is_string());
        assert!(v["general"]["liveTranscriptionDisplay"].is_string());
        assert!(v["general"]["systemAudioReductionWhileDictating"].is_number());
        assert!(v["llm"]["openrouterApiKey"].is_string());
        assert!(v["integrations"]["elevenlabs"]["apiKey"].is_string());
        // flattened LlmFeatureBase fields sit directly under dictation.
        assert!(v["llm"]["dictation"]["openrouterModel"].is_string());
        assert!(v["llm"]["dictation"]["thinkingEffort"].is_string());

        let back: WinsttSettings = serde_json::from_value(v).expect("round-trip");
        assert_eq!(back, s);
    }

    #[test]
    fn flattened_llm_feature_base_partial_fills_inner_defaults() {
        // The riskiest path: `#[serde(flatten)] base: LlmFeatureBase` with a
        // partial inner object. A missing inner key (e.g. `verbosity`) must fall
        // back to the field default rather than fail the parse — the Zod
        // per-field `.default()` guarantee inside the spread.
        let json = r#"{
            "llm": {
                "dictation": { "enabled": true, "provider": "openrouter", "openrouterModel": "x/y" }
            }
        }"#;
        let s: WinsttSettings = serde_json::from_str(json).expect("partial llm must parse");
        assert!(s.llm.dictation.enabled);
        assert_eq!(s.llm.dictation.base.provider, LlmProvider::Openrouter);
        assert_eq!(s.llm.dictation.base.openrouter_model, "x/y");
        // Inner fields absent from JSON → defaults.
        assert_eq!(s.llm.dictation.base.verbosity, EffortLevel::Medium);
        assert_eq!(s.llm.dictation.base.thinking_effort, ThinkingEffort::Medium);
        assert_eq!(s.llm.dictation.base.max_output_tokens, None);
        // Sibling non-flattened fields default too.
        assert_eq!(s.llm.dictation.presets.len(), 1);
        // Shared infra + transforms default.
        assert_eq!(s.llm.endpoint, "http://localhost:11434");
        assert_eq!(s.llm.transforms.hotkey, "LCtrl+LShift+T");
    }

    #[test]
    fn enum_serialization_spellings() {
        // Verify the exact JSON strings the renderer's string unions expect.
        assert_eq!(
            serde_json::to_value(MicrophoneRelease::Sec30).unwrap(),
            serde_json::json!("sec30")
        );
        assert_eq!(
            serde_json::to_value(LiveTranscriptionDisplay::InApp).unwrap(),
            serde_json::json!("in-app")
        );
        assert_eq!(
            serde_json::to_value(OverlayMode::DynamicIsland).unwrap(),
            serde_json::json!("dynamic-island")
        );
        assert_eq!(
            serde_json::to_value(LlmProvider::AppleIntelligence).unwrap(),
            serde_json::json!("apple-intelligence")
        );
        assert_eq!(
            serde_json::to_value(PresetKey::RewordForClarity).unwrap(),
            serde_json::json!("rewordForClarity")
        );
        assert_eq!(
            serde_json::to_value(AutoSubmitKey::CtrlEnter).unwrap(),
            serde_json::json!("ctrl_enter")
        );
        assert_eq!(
            serde_json::to_value(ModelUnloadTimeout::Hour1).unwrap(),
            serde_json::json!("hour1")
        );
        // OnboardedTrack::Unset must serialize to the empty string.
        assert_eq!(
            serde_json::to_value(OnboardedTrack::Unset).unwrap(),
            serde_json::json!("")
        );
        // Round-trip the empty-string variant.
        let t: OnboardedTrack = serde_json::from_value(serde_json::json!("")).unwrap();
        assert_eq!(t, OnboardedTrack::Unset);
    }

    #[test]
    fn startup_only_classification() {
        assert!(is_startup_only("model.device"));
        assert!(is_startup_only("quality.useMainModelForRealtime"));
        assert!(is_startup_only("general.sendCrashReports"));
        // ONNX-only: computeType was retired and must NOT be startup-only.
        assert!(!is_startup_only("model.computeType"));
        // Hot-swap settings must not be startup-only.
        assert!(!is_startup_only("model.onnxQuantization"));
        assert!(!is_startup_only("audio.microphoneRelease"));
        assert!(!is_startup_only("model.model"));
        assert!(!is_startup_only("general.wakeWord")); // conditional, not unconditional
    }

    #[test]
    fn secret_classification() {
        assert!(is_secret("llm.openrouterApiKey"));
        assert!(is_secret("integrations.openai.apiKey"));
        assert!(is_secret("integrations.elevenlabs.apiKey"));
        assert!(!is_secret("model.model"));
        assert!(!is_secret("llm.endpoint"));
    }

    #[test]
    fn dictionary_entry_omits_absent_replacement() {
        let entry = DictionaryEntry {
            id: "1".into(),
            term: "WinSTT".into(),
            replacement: None,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert!(v.get("replacement").is_none()); // vocab-bias word, not a pair
        let pair = DictionaryEntry {
            id: "2".into(),
            term: "win s t t".into(),
            replacement: Some("WinSTT".into()),
        };
        let v2 = serde_json::to_value(&pair).unwrap();
        assert_eq!(v2["replacement"], serde_json::json!("WinSTT"));
    }
}
