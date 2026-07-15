// Source: WinSTT frontend/src/shared/config/settings-schema.ts
// (the authoritative Zod `appSettingsSchema`; the OpenAPI spec is STALE).
//
// This module ports WinSTT's ~150-field nested settings tree into a single
// specta-typed `WinsttSettings` Rust struct. The nesting mirrors the Zod
// schema's 10 sub-objects exactly (global / model / quality / audio / general /
// hotkey / dictionary / snippets / llm / tts / integrations) so the reused React
// renderer maps onto it 1:1 over `tauri-specta` bindings.
//
// CONVENTIONS (locked, do not drift):
//   * Field NAMES on the wire are camelCase — the renderer reads/writes the
//     exact keys used by the current renderer. Every struct therefore
//     carries `#[serde(rename_all = "camelCase")]` and every enum that needs a
//     specific JSON spelling carries an explicit `#[serde(rename...)]`.
//   * Every field is `#[serde(default = "...")]` (or `#[serde(default)]` for
//     type-default values), and `Default for WinsttSettings` returns the
//     canonical fresh-install tree.
//   * Secrets (`integrations.*.apiKey`, `llm.openrouterApiKey`) are plaintext
//     in this struct but MUST be encrypted at rest by the persistence layer
//     (`SecretMap` / Tauri `safeStorage` equivalent).
//
// HOT-SWAP classification: annotated per group below. `STARTUP_ONLY_KEYS`
// intentionally stays empty in this Tauri port because runtime-owned settings
// are live-read or applied through targeted in-process reloads.

#![expect(
    clippy::derivable_impls,
    reason = "explicit Default impls document the settings-schema defaults (parity with the Zod schema)"
)]

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

// ===========================================================================
// Enums (string unions in the Zod schema → Rust enums with explicit serde spellings)
// ===========================================================================

/// `model.device` — `DeviceTypeSchema` = `["auto", "cpu"]`.
/// ONNX-only WinSTT exposes only auto-vs-CPU; the actual accelerator (DirectML
/// vs CPU) is chosen by the packaging flavor + `device.py`'s EP probe, NOT a
/// persisted user knob. In this port, changes trigger an in-process model reload.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum DeviceType {
    Auto,
    Cpu,
}

/// `global.modelUnloadTimeout`. IPC normalizes `never` → negative seconds
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

/// `audio.microphoneRelease`. Single WinSTT-owned microphone release policy.
/// HOT-SWAP (audio manager reconfigures in place).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum MicrophoneRelease {
    Always,
    Immediate,
    Sec30,
    Min1,
    Min5,
}

/// One entry in `general.fileTranscriptionFormats`.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum FileTranscriptionFormat {
    Txt,
    Srt,
    Vtt,
    Json,
    Csv,
}

/// `general.fileTranscriptionSaveLocation`. `auto` = beside source, `ask` = dialog.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum FileSaveLocation {
    Auto,
    Ask,
}

/// `general.recordingMode`. HOT-SWAP: crossing into/out of wakeword arms or
/// disarms the detector in-process.
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
/// effectively enabled. HOT-SWAP: the realtime worker re-reads
/// `effective_realtime` every loop tick and self-gates, so toggling this (incl.
/// disabling live transcription entirely) takes effect with no restart.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "kebab-case")]
pub enum LiveTranscriptionDisplay {
    None,
    InApp,
    InPill,
    Both,
}

/// `general.contextAppMode`. Chooses whether context capture reads every app
/// except the deny-list or only apps/sites explicitly selected by the user.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ContextAppMode {
    AllExceptDenied,
    SelectedOnly,
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
#[serde(rename_all = "camelCase")]
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

/// OpenRouter verbosity (`low`/`medium`/`high`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum EffortLevel {
    Low,
    Medium,
    High,
}

/// Off/Low/Medium/High effort scale, shared by Ollama's thinking budget AND
/// OpenRouter's reasoning effort. `off` disables the thinking pass entirely:
/// for Ollama → `think: false`; for OpenRouter → `reasoning: { enabled: false }`.
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
/// duplicate keys; ≤1 tone key (Neutral/Formal/Friendly/Technical);
/// `level` only for Summarize/Concise; `targetLang` only for Translate.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub enum PresetKey {
    Neutral,
    Formal,
    Friendly,
    Technical,
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
    Caveman,
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
    /// True when the entry was inserted by the LLM dictionary tool rather than
    /// typed manually in Settings. Omitted for manually added entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_added: Option<bool>,
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

/// `presetEntrySchema`. `level` valid only for summarize/concise, with Caveman
/// restricted to concise; `targetLang` valid only for translate (cross-field
/// constraints enforced at the app layer).
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
    /// Caveman is reserved for the built-in Concise modifier.
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
// Model changes are hot-applied. Same-model load-input changes reload the
// resident engine in-process.
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
    /// Forced language for a multilingual/prompt realtime model (Nemotron-3.5), independent of the
    /// main model's `language`. `""` = whole-utterance auto-detect. HOT-SWAP (reloads the realtime
    /// engine so the encoder `prompt_index` is re-bound).
    #[serde(default)]
    pub realtime_language: String,
    /// Forced decode language (`""` = auto-detect). HOT-SWAP.
    #[serde(default = "ModelSettings::default_language")]
    pub language: String,
    /// Full auto language detection. When false, `language_candidates` can constrain detection.
    #[serde(default)]
    pub auto_detect_language: bool,
    /// Candidate decode languages used when `auto_detect_language` is false.
    #[serde(default)]
    pub language_candidates: Vec<String>,
    /// CPU vs auto-GPU. HOT-SWAP through targeted model reload.
    #[serde(default)]
    pub device: DeviceType,
    /// ONNX file quant suffix (`""`, `int8`, `fp16`, `uint8`, `int4`, `q4`,
    /// `q4f16`, `bnb4`). Free-string (not an enum) — the catalog gates valid values per
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
    /// Native decoder translation target. `""` = off (plain transcription). A
    /// concrete code (e.g. `"en"`, `"de"`) asks the engine to emit that language
    /// instead of the source. Multilingual Whisper can only ever target English
    /// (`<|translate|>` is English-only), so any non-empty value there behaves as
    /// "translate to English"; NeMo Canary honors the concrete target token and
    /// can render any→any among its languages. Every other family silently falls
    /// through to normal transcription. HOT-SWAP.
    #[serde(default)]
    pub translate_target_language: String,
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
impl Default for ModelUnloadTimeout {
    fn default() -> Self {
        ModelUnloadTimeout::Min15
    }
}

impl Default for ModelSettings {
    fn default() -> Self {
        Self {
            model: Self::default_model(),
            realtime_model: Self::default_realtime_model(),
            realtime_language: String::new(),
            language: Self::default_language(),
            auto_detect_language: false,
            language_candidates: Vec::new(),
            device: DeviceType::default(),
            // "auto" = RAM/VRAM-aware recommended pick; "" would mean EXPLICIT fp32 (see backend.rs).
            onnx_quantization: "auto".into(),
            initial_prompt: String::new(),
            initial_prompt_realtime: String::new(),
            translate_target_language: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettings {
    /// Idle-unload policy shared by local STT, realtime preview, local TTS, and
    /// Ollama keep-alive. HOT-SWAP. Zod `.catch("min15")`.
    #[serde(default)]
    pub model_unload_timeout: ModelUnloadTimeout,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            model_unload_timeout: ModelUnloadTimeout::default(),
        }
    }
}

// ===========================================================================
// SECTION: quality  (qualitySettingsSchema)
// All HOT-SWAP / live-read in the Rust port. The realtime worker re-reads the
// timing knobs every loop tick, and `useMainModelForRealtime` is retained only
// for renderer/store parity because this port uses a single shared STT engine.
// ===========================================================================

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct QualitySettings {
    /// Use main model (vs separate realtime model) for live preview. HOT-SWAP / parity-only.
    #[serde(default)]
    pub use_main_model_for_realtime: bool,
    /// Pause between realtime passes (s). HOT-SWAP.
    #[serde(default = "QualitySettings::default_realtime_processing_pause")]
    pub realtime_processing_pause: f64,
    /// Delay before spinning up the realtime worker (s). HOT-SWAP.
    #[serde(default = "QualitySettings::default_init_realtime_after_seconds")]
    pub init_realtime_after_seconds: f64,
    /// Early-finalize-on-silence threshold (s). HOT-SWAP / config-only in this port.
    #[serde(default = "QualitySettings::default_early_transcription_on_silence")]
    pub early_transcription_on_silence: f64,
    /// Rule-based sentence casing/final-period cleanup for raw recognizer output.
    #[serde(default)]
    pub format_basic_punctuation_casing: bool,
    /// Convert spoken punctuation, quote, layout, and technical symbol commands.
    #[serde(default)]
    pub format_spoken_commands: bool,
    /// Remove exact fillers and adjacent duplicate words.
    #[serde(default)]
    pub format_filler_repeat_cleanup: bool,
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
            format_basic_punctuation_casing: false,
            format_spoken_commands: false,
            format_filler_repeat_cleanup: false,
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
// sampleRate / bufferSize / sileroUseOnnx / preRecordingBufferDuration are
// STARTUP (CLI). The rest are HOT-SWAP.
// ===========================================================================

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    /// Mic index; `null` = system default. HOT-SWAP.
    #[serde(default)]
    pub input_device_index: Option<i64>,
    /// Microphone preference order (cpal device NAMES, highest first). When
    /// non-empty, the first CONNECTED entry wins on every stream open,
    /// overriding `input_device_index` (which the renderer keeps re-pointed at
    /// the same effective device). Empty = plain index selection. HOT-SWAP.
    /// Zod `.catch([])`.
    #[serde(default)]
    pub input_device_priority: Vec<String>,
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
    /// Silero-based deactivity (config-only, no live consumer). HOT-SWAP (persist-only).
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
    /// Per-device Silero VAD sensitivity, keyed by input-device name. Re-applied
    /// to the live sensitivity on device switch. HOT-SWAP. Zod `.catch({})`.
    #[serde(default)]
    pub silero_sensitivity_by_device_name: HashMap<String, f64>,
    /// Alt mic index when laptop lid closed; `null` = disabled. HOT-SWAP. Zod `.catch(null)`.
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
            input_device_priority: Vec::new(),
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
// Wakeword mode/config is HOT-SWAP in the Rust port: the wakeword runtime
// arms/disarms/reconfigures its detector from the saved settings.
// HOT-SWAP: liveTranscriptionDisplay / showRecordingOverlay (effective-realtime is
// re-read live by the realtime worker — no restart even when fully disabled).
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
    /// Active chime clip; `""` = original built-in default, `builtin:<file>` =
    /// allow-listed bundled alternate, else absolute library path. HOT-SWAP.
    #[serde(default)]
    pub recording_sound_path: String,
    /// User-uploaded chime clips (copied into `userData/sounds/`). HOT-SWAP. Zod `.catch([])`.
    #[serde(default)]
    pub recording_sound_library: Vec<SoundLibraryEntry>,
    /// Output formats for file transcription. HOT-SWAP.
    #[serde(default = "GeneralSettings::default_file_transcription_formats")]
    pub file_transcription_formats: Vec<FileTranscriptionFormat>,
    /// `auto` = beside source, `ask` = save dialog. HOT-SWAP.
    #[serde(default)]
    pub file_transcription_save_location: FileSaveLocation,
    /// How a recording session starts. HOT-SWAP, including wakeword arm/disarm.
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
    /// Wake phrase in `wakeword` mode. Presets and custom phrases both run
    /// through the local sherpa KWS detector. HOT-SWAP via wakeword runtime refresh.
    #[serde(default = "GeneralSettings::default_wake_word")]
    pub wake_word: String,
    /// User-saved custom wake phrases for the renderer combobox. Runtime listens
    /// only to `wake_word`; this list is persisted UI catalog state.
    #[serde(default)]
    pub custom_wake_words: Vec<String>,
    /// Wake-word detector sensitivity. Range 0..1. HOT-SWAP via runtime refresh.
    #[serde(default = "GeneralSettings::default_wake_word_sensitivity")]
    pub wake_word_sensitivity: f64,
    /// Seconds the gate stays armed after detection. Range 1..30. HOT-SWAP via runtime refresh.
    #[serde(default = "GeneralSettings::default_wake_word_timeout")]
    pub wake_word_timeout: f64,
    /// Show floating recording pill. HOT-SWAP (affects effective-realtime, which the
    /// realtime worker re-reads live — no restart).
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
    /// Where live preview renders; also gates effective-realtime. HOT-SWAP (worker
    /// re-reads it live — no restart, even when disabled). Zod `.catch`.
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
    /// Context capture app scope. HOT-SWAP. Zod `.catch("all-except-denied")`.
    #[serde(default)]
    pub context_app_mode: ContextAppMode,
    /// Allow-list for selected-only context capture (exe basenames / URL hosts).
    /// HOT-SWAP. Empty means no app text is captured in selected-only mode.
    #[serde(default)]
    pub context_allow_list: Vec<String>,
    /// Deny-list for context capture (exe basenames / URL host suffixes). HOT-SWAP.
    /// Seeded with common password managers. Zod `.catch(<same seed>)`.
    #[serde(default = "GeneralSettings::default_context_deny_list")]
    pub context_deny_list: Vec<String>,
    /// Tier-2 OCR fallback (report R3): when context awareness captured no usable
    /// text (canvas apps, remote desktops, games — surfaces UIA returns nothing
    /// for), screenshot the PINNED window and OCR it ON-DEVICE. DEFAULT FALSE:
    /// screenshot capture is the industry-unanimous opt-in tier. The recognized
    /// text never leaves the machine — it feeds only the local LLM cleanup step,
    /// exactly like the UIA text. HOT-SWAP (read per-capture from settings).
    #[serde(default)]
    pub context_screen_ocr: bool,
    /// Per-utterance speaker diarization (~32 MB models, first-run download).
    /// HOT-SWAP (runtime toggle via diarization-toggle method).
    #[serde(default)]
    pub speaker_diarization: bool,
    /// Sentry crash-reporting opt-out. Persisted live; never prompts for restart.
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
    /// Gate auto-paste behind an editable preview pill the user confirms before
    /// pasting. HOT-SWAP. Only effective when the recording pill is shown (the
    /// preview IS the pill). Zod `.catch(false)`.
    #[serde(default)]
    pub preview_before_pasting: bool,
    /// Stream generated realtime text directly into the focused app while recording.
    /// HOT-SWAP. Effective only for native-streaming main models. Mutually exclusive
    /// with preview-before-pasting. Zod `.catch(false)`.
    #[serde(default)]
    pub word_by_word_pasting: bool,
    /// Master switch for transcription history. When false, nothing is persisted:
    /// no history rows, no transform rows, no WAV recordings. Existing data stays on
    /// disk until deleted explicitly. HOT-SWAP. Zod `.catch(true)`.
    #[serde(default = "GeneralSettings::default_history_enabled")]
    pub history_enabled: bool,
    /// Cap on persisted history entries. Range 10..10000. HOT-SWAP. Zod `.catch(1000)`.
    #[serde(default = "GeneralSettings::default_history_max_entries")]
    pub history_max_entries: i64,
    /// Auto-delete saved WAV recordings policy. HOT-SWAP. Zod `.catch("cap")`.
    #[serde(default)]
    pub recording_retention: RecordingRetention,
    /// Master switch for the on-device (encoder) dictionary fallback + its model. When false, the
    /// non-LLM vocabulary path is off entirely: the model is never downloaded/run and the
    /// Vocabulary tab's dictionary is inert unless LLM cleanup is on. HOT-SWAP. Zod `.catch(true)`.
    #[serde(default = "GeneralSettings::default_encoder_dictionary_enabled")]
    pub encoder_dictionary_enabled: bool,
    /// How much surrounding text (bytes each side of a word) the on-device dictionary reads when
    /// judging whether a word is a mis-hearing. Lower = faster (masked-LM cost grows with the square
    /// of the text length); higher reads more context, which can catch borderline corrections in long
    /// dictation but is slower. Default 220 is the fastest step and works for most speech. HOT-SWAP.
    /// Zod `.catch(220)`.
    #[serde(default = "GeneralSettings::default_dictionary_context_chars")]
    pub dictionary_context_chars: i64,
    /// When LLM cleanup is on, the dictionary (preferred terms + replacement pairs) is injected
    /// into the cleanup prompt and the LLM owns corrections. Turn OFF to keep the dictionary out
    /// of the prompt and offload corrections to the on-device encoder model instead (replacement
    /// pairs stay deterministic either way). No effect when LLM cleanup is off. HOT-SWAP.
    /// Zod `.catch(true)`.
    #[serde(default = "GeneralSettings::default_llm_handles_dictionary")]
    pub llm_handles_dictionary: bool,
    /// When LLM cleanup is on, snippets are injected into the cleanup prompt and the LLM expands
    /// them contextually (the deterministic fuzzy expander is skipped). Turn OFF to keep snippets
    /// out of the prompt and rely on the deterministic fuzzy trigger→expansion replacement
    /// instead. No effect when LLM cleanup is off. HOT-SWAP. Zod `.catch(true)`.
    #[serde(default = "GeneralSettings::default_llm_handles_snippets")]
    pub llm_handles_snippets: bool,
}

impl GeneralSettings {
    pub fn effective_file_transcription_formats(&self) -> Vec<FileTranscriptionFormat> {
        let configured = if self.file_transcription_formats.is_empty() {
            Self::default_file_transcription_formats()
        } else {
            self.file_transcription_formats.clone()
        };
        let mut formats = Vec::with_capacity(configured.len());
        for format in configured {
            if !formats.contains(&format) {
                formats.push(format);
            }
        }
        formats
    }

    fn default_file_transcription_formats() -> Vec<FileTranscriptionFormat> {
        vec![FileTranscriptionFormat::Txt]
    }

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
    fn default_history_enabled() -> bool {
        true
    }
    fn default_history_max_entries() -> i64 {
        1000
    }
    fn default_dictionary_context_chars() -> i64 {
        220
    }
    fn default_encoder_dictionary_enabled() -> bool {
        true
    }
    fn default_llm_handles_dictionary() -> bool {
        true
    }
    fn default_llm_handles_snippets() -> bool {
        true
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
        OverlayMode::DynamicIsland
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
impl Default for ContextAppMode {
    fn default() -> Self {
        ContextAppMode::AllExceptDenied
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
            system_audio_reduction_while_dictating: 60,
            recording_sound: true,
            recording_sound_path: String::new(),
            recording_sound_library: Vec::new(),
            file_transcription_formats: Self::default_file_transcription_formats(),
            file_transcription_save_location: FileSaveLocation::default(),
            recording_mode: RecordingMode::default(),
            manual_toggle_stop: false,
            repaste_hotkey: Self::default_repaste_hotkey(),
            loopback_device_index: None,
            wake_word: Self::default_wake_word(),
            custom_wake_words: Vec::new(),
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
            context_app_mode: ContextAppMode::default(),
            context_allow_list: Vec::new(),
            context_deny_list: Self::default_context_deny_list(),
            context_screen_ocr: false,
            speaker_diarization: false,
            send_crash_reports: true,
            receive_prerelease_updates: false,
            onboarded: false,
            onboarded_at: None,
            onboarded_track: OnboardedTrack::default(),
            output_device_id: String::new(),
            auto_submit: false,
            auto_submit_key: AutoSubmitKey::default(),
            preview_before_pasting: false,
            word_by_word_pasting: false,
            history_enabled: Self::default_history_enabled(),
            history_max_entries: Self::default_history_max_entries(),
            recording_retention: RecordingRetention::default(),
            encoder_dictionary_enabled: Self::default_encoder_dictionary_enabled(),
            dictionary_context_chars: Self::default_dictionary_context_chars(),
            llm_handles_dictionary: Self::default_llm_handles_dictionary(),
            llm_handles_snippets: Self::default_llm_handles_snippets(),
        }
    }
}

// ===========================================================================
// SECTION: hotkey  (hotkeySettingsSchema)
// ===========================================================================

// The push-to-talk default is platform-specific. A modifier-only combo
// (`LCtrl+LMeta`) can only be armed on Windows, where the low-level keyboard hook
// observes and swallows the held modifiers system-wide. Tauri's global-shortcut
// backend (used on macOS/Linux) requires a non-modifier key, so a modifier-only
// default would register NOTHING there and leave a fresh install with no dictation
// hotkey. Every non-Windows default is therefore a FULL accelerator, chosen to
// avoid colliding with the other shipped defaults (`read_aloud` = `LCtrl+Space`,
// `transforms` = `LCtrl+LShift+T`).
#[cfg(target_os = "windows")]
pub const DEFAULT_PUSH_TO_TALK_KEY: &str = "LCtrl+LMeta";
// macOS Option is represented as `Alt` in the app's hotkey vocabulary (the token
// `validate_hotkey`/`is_supported_hotkey_token` recognizes and the low-level hook
// emits) — `Option` is not a valid token, so the default must spell it `Alt`.
#[cfg(target_os = "macos")]
pub const DEFAULT_PUSH_TO_TALK_KEY: &str = "Alt+Space";
#[cfg(target_os = "linux")]
pub const DEFAULT_PUSH_TO_TALK_KEY: &str = "Ctrl+Alt+Space";
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub const DEFAULT_PUSH_TO_TALK_KEY: &str = "Alt+Space";

/// zod-canonical push-to-talk key for the Rust↔zod parity fixture. The runtime
/// default above is platform-specific, but the parity fixture mirrors what the
/// single JS bundle's `appSettingsSchema.parse({})` produces — identical on every
/// OS — so the committed fixture must NOT depend on the builder's platform. See
/// `default_fixture_json`.
const FIXTURE_PUSH_TO_TALK_KEY: &str = "LCtrl+LMeta";

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
        DEFAULT_PUSH_TO_TALK_KEY.to_string()
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
    #[serde(default = "default_reasoning_effort")]
    pub reasoning_effort: ThinkingEffort,
    #[serde(default)]
    pub verbosity: EffortLevel,
    #[serde(default)]
    pub max_output_tokens: Option<i64>,
    #[serde(default)]
    pub thinking_effort: ThinkingEffort,
}

/// OpenRouter reasoning effort defaults to Medium (not the enum's `Off`
/// default, which is the right zero value only for Ollama's `thinking_effort`).
fn default_reasoning_effort() -> ThinkingEffort {
    ThinkingEffort::Medium
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
        ThinkingEffort::Off
    }
}

impl Default for LlmFeatureBase {
    fn default() -> Self {
        Self {
            provider: LlmProvider::default(),
            model: String::new(),
            openrouter_model: String::new(),
            openrouter_fallback_model: String::new(),
            reasoning_effort: ThinkingEffort::Medium,
            verbosity: EffortLevel::Medium,
            max_output_tokens: None,
            thinking_effort: ThinkingEffort::Off,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct LlmDictation {
    #[serde(default)]
    pub enabled: bool,
    /// Optional Ollama tool-calling dictionary suggestions. Backend execution
    /// still requires the selected model to advertise the `tools` capability.
    #[serde(default)]
    pub dictionary_auto_add_enabled: bool,
    /// Flattened so the shared fields sit at `llm.dictation.<field>` (matches
    /// Zod's `...llmFeatureBaseShape` spread). Inner-field defaults handle a
    /// partial JSON; see the note on `LlmFeatureBase`.
    #[serde(flatten)]
    pub base: LlmFeatureBase,
    #[serde(default = "default_dictation_presets")]
    pub presets: Vec<PresetEntry>,
    #[serde(default)]
    pub custom_modifiers: Vec<CustomModifier>,
}

impl Default for LlmDictation {
    fn default() -> Self {
        Self {
            enabled: false,
            dictionary_auto_add_enabled: false,
            base: LlmFeatureBase::default(),
            presets: default_dictation_presets(),
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

/// A denormalized saved-configuration snapshot used by a per-app rule. The
/// global `enabled` and dictionary-auto-add switches deliberately do not live
/// here: an app rule changes how enabled post-processing runs, never whether it
/// runs.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppProfileConfig {
    #[serde(flatten)]
    pub base: LlmFeatureBase,
    #[serde(default = "default_neutral_presets")]
    pub presets: Vec<PresetEntry>,
    #[serde(default)]
    pub custom_modifiers: Vec<CustomModifier>,
}

impl Default for AppProfileConfig {
    fn default() -> Self {
        Self {
            base: LlmFeatureBase::default(),
            presets: default_neutral_presets(),
            custom_modifiers: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppProfileRule {
    #[serde(default)]
    pub id: String,
    #[serde(default = "bool_true")]
    pub enabled: bool,
    #[serde(default)]
    pub app_exe: String,
    #[serde(default)]
    pub title_pattern: String,
    #[serde(default)]
    pub url_pattern: String,
    #[serde(default)]
    pub configuration_id: String,
    #[serde(default)]
    pub configuration_name: String,
    #[serde(default)]
    pub config: AppProfileConfig,
}

impl Default for AppProfileRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            enabled: true,
            app_exe: String::new(),
            title_pattern: String::new(),
            url_pattern: String::new(),
            configuration_id: String::new(),
            configuration_name: String::new(),
            config: AppProfileConfig::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppProfilesSettings {
    #[serde(default)]
    pub rules: Vec<AppProfileRule>,
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
    /// Global shortcut that cycles through saved post-processing profiles.
    #[serde(default = "LlmSettings::default_profile_swap_hotkey")]
    pub profile_swap_hotkey: String,
    #[serde(default)]
    pub dictation: LlmDictation,
    #[serde(default)]
    pub transforms: LlmTransforms,
    #[serde(default)]
    pub app_profiles: AppProfilesSettings,
    /// Client request timeout (ms). Range 1000..30000. Applied (via
    /// `llm::llm_request_timeout`) to every cloud LLM round-trip: the
    /// dictation and transform OpenRouter attempts.
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
    fn default_profile_swap_hotkey() -> String {
        "LCtrl+LShift+P".to_string()
    }
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            endpoint: Self::default_endpoint(),
            openrouter_api_key: String::new(),
            profile_swap_hotkey: Self::default_profile_swap_hotkey(),
            dictation: LlmDictation::default(),
            transforms: LlmTransforms::default(),
            app_profiles: AppProfilesSettings::default(),
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

/// Which cloud TTS provider the Cloud source synthesizes through. ElevenLabs
/// (account voices via `integrations.elevenlabs.apiKey`) or OpenRouter (dedicated
/// `/audio/speech` speech models, reusing the shared `llm.openrouterApiKey`).
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum TtsCloudProvider {
    #[default]
    Elevenlabs,
    Openrouter,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct TtsCloud {
    /// Active cloud TTS provider (ElevenLabs or OpenRouter).
    #[serde(default)]
    pub provider: TtsCloudProvider,
    /// ElevenLabs account voice_id.
    #[serde(default)]
    pub voice: String,
    #[serde(default = "TtsCloud::default_model")]
    pub model: String,
    /// OpenRouter speech model id (e.g. `microsoft/mai-voice-2`), active when
    /// `provider == openrouter`. Dynamic — the picker scans `output_modalities=speech`.
    #[serde(default)]
    pub openrouter_model: String,
    /// OpenRouter voice id from the selected model's supported_voices catalog.
    #[serde(default)]
    pub openrouter_voice: String,
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
            provider: TtsCloudProvider::default(),
            voice: String::new(),
            model: Self::default_model(),
            openrouter_model: String::new(),
            openrouter_voice: String::new(),
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
    /// Local TTS catalog id selecting WHICH engine/model synthesizes
    /// (kokoro-82m / kitten-nano-0.2 / piper / supertonic-3).
    /// `voice` below is the voice WITHIN this model. Cloud source ignores this.
    #[serde(default = "TtsSettings::default_model")]
    pub model: String,
    /// ONNX weights quant/precision for the selected local model (mirrors
    /// `model.onnxQuantization` for STT). Free-string gated by the catalog per
    /// model; empty → the model's default quant. Currently only Qwen3-TTS Voice
    /// Design ships a quant ladder (`int4`|`fp16`|`fp32`); other engines ignore it.
    /// HOT-SWAP (the engine is rebuilt when the fingerprint changes).
    #[serde(default)]
    pub quantization: String,
    /// Voice catalog id WITHIN the selected model.
    #[serde(default = "TtsSettings::default_voice")]
    pub voice: String,
    /// Reference-clip transcript for cloning models that need it (`cloning ==
    /// zero_shot_audio_transcript`, e.g. Spark). Auto-filled by transcribing the uploaded
    /// reference clip with the selected STT model, then user-editable. Empty otherwise.
    /// HOT-SWAP (the Spark engine is rebuilt when this changes).
    #[serde(default)]
    pub clone_ref_text: String,
    #[serde(default = "TtsSettings::default_lang")]
    pub lang: String,
    /// 0.4..2.0 multiplier (Supertonic slider reaches 0.4; other engines 0.5).
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
    fn default_model() -> String {
        "kokoro-82m".to_string()
    }
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
        "LCtrl+Space".to_string()
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
            model: Self::default_model(),
            quantization: String::new(),
            voice: Self::default_voice(),
            clone_ref_text: String::new(),
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
    pub elevenlabs: ProviderIntegrationStatus,
}

impl Default for IntegrationsSettings {
    fn default() -> Self {
        Self {
            elevenlabs: ProviderIntegrationStatus::default(),
        }
    }
}

// ===========================================================================
// TOP-LEVEL: WinsttSettings  (appSettingsSchema)
// ===========================================================================

/// The complete WinSTT settings tree, nested by the settings sections, ported
/// 1:1 from `appSettingsSchema` (Zod). Serializes to the exact camelCase JSON
/// the reused React renderer expects.
///
/// Persisted via the Tauri store (one JSON value). Secrets are encrypted at
/// rest by the persistence layer — they are plaintext on this struct.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
#[serde(rename_all = "camelCase")]
pub struct WinsttSettings {
    #[serde(default)]
    pub global: GlobalSettings,
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
    /// Backend-only fields that have no renderer-facing settings section: the hotkey
    /// `bindings` map, audio-feedback and paste/clipboard settings, the keyboard
    /// implementation, accelerators, and tray/debug/update-check toggles.
    /// The renderer never reads or writes `core`.
    #[serde(default = "crate::settings::get_default_settings")]
    pub core: crate::settings::AppSettings,
}

impl Default for WinsttSettings {
    fn default() -> Self {
        Self {
            global: GlobalSettings::default(),
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
            core: crate::settings::get_default_settings(),
        }
    }
}

/// Canonical Rust↔zod settings-defaults parity fixture, as pretty JSON with a
/// trailing newline.
///
/// This is the renderer-facing default surface: `WinsttSettings::default()`
/// serialized with the backend-only `core` section removed. `core` is the
/// embedded `AppSettings` view, which the renderer never sees (zod strips it),
/// and which also carries machine-dependent (`core.appLanguage` reads the host
/// locale) and `HashMap`-ordered fields that cannot live in a byte-stable
/// committed fixture. Both the fixture regenerator and the Rust parity test go
/// through this function so they cannot drift.
pub fn default_fixture_json() -> Result<String, serde_json::Error> {
    let mut value = serde_json::to_value(WinsttSettings::default())?;
    if let Some(map) = value.as_object_mut() {
        map.remove("core");
    }
    // Pin the push-to-talk key to the zod-canonical value: the runtime default is
    // platform-specific (see `DEFAULT_PUSH_TO_TALK_KEY`), but the parity fixture must
    // be identical on every OS so it can be compared against the platform-independent
    // zod default AND stay byte-stable regardless of which OS regenerated it.
    if let Some(push_to_talk_key) = value
        .get_mut("hotkey")
        .and_then(|hotkey| hotkey.get_mut("pushToTalkKey"))
    {
        *push_to_talk_key = serde_json::json!(FIXTURE_PUSH_TO_TALK_KEY);
    }
    let mut json = serde_json::to_string_pretty(&value)?;
    json.push('\n');
    Ok(json)
}

// ===========================================================================
// Helpers / shared default fns
// ===========================================================================

/// Shared `#[serde(default = ...)]` helper for fields that default to `true`
/// (serde's bool default is `false`, so true-defaulted fields need this).
pub fn bool_true() -> bool {
    true
}

/// The transform `presetsSchema` default: a single `neutral` tone preset.
fn default_neutral_presets() -> Vec<PresetEntry> {
    vec![PresetEntry {
        key: PresetKey::Neutral,
        level: None,
        target_lang: None,
    }]
}

/// Dictation post-processing defaults: neutral tone plus clarity modifiers.
fn default_dictation_presets() -> Vec<PresetEntry> {
    vec![
        PresetEntry {
            key: PresetKey::Neutral,
            level: None,
            target_lang: None,
        },
        PresetEntry {
            key: PresetKey::Reorder,
            level: None,
            target_lang: None,
        },
        PresetEntry {
            key: PresetKey::Restructure,
            level: None,
            target_lang: None,
        },
        PresetEntry {
            key: PresetKey::RewordForClarity,
            level: None,
            target_lang: None,
        },
    ]
}

// ===========================================================================
// Hot-swap classification.
//
// The Rust/Tauri port has no externally managed STT server process. Settings that
// used to be CLI/startup-only are either read live
// (realtime timing/display, wakeword config, crash-report opt-out) or applied by
// a targeted in-process reload (model.device / quantization). Therefore no
// settings path should surface "restart the STT server/app" while the app is running.
// ===========================================================================

/// Dot-paths that require a full app relaunch when changed.
///
/// Intentionally empty: every setting is hot-applied, persisted-only, or handled
/// by an in-process model/wakeword reload.
pub const STARTUP_ONLY_KEYS: &[&str] = &[];

/// Dot-paths that drive wakeword runtime reconfiguration while in (or crossing
/// into/out of) wakeword recording mode.
pub const WAKEWORD_CONFIG_KEYS: &[&str] = &[
    "general.recordingMode",
    "general.wakeWord",
    "general.wakeWordSensitivity",
    "general.wakeWordTimeout",
];

/// Dot-paths that can flip whether realtime transcription is *effectively*
/// enabled. NO restart on change: the realtime worker
/// (`winstt::managers::realtime_manager`) re-reads `effective_realtime` every loop
/// tick and self-gates, so a flip (incl. fully disabling) is hot. Kept as a
/// documented set of the keys that gate the effective flag.
pub const REALTIME_EFFECTIVE_KEYS: &[&str] = &[
    "general.liveTranscriptionDisplay",
    "general.showRecordingOverlay",
];

/// Secret dot-paths — encrypted at rest by the persistence layer.
pub const SECRET_KEYS: &[&str] = &["llm.openrouterApiKey", "integrations.elevenlabs.apiKey"];

/// Returns true if a change to `dot_path` unconditionally requires an app/server
/// restart. This should remain false for all user-editable settings in the Rust port.
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
    fn app_profiles_default_to_no_rules() {
        assert!(LlmSettings::default().app_profiles.rules.is_empty());
    }

    #[test]
    fn app_profile_rule_accepts_partial_camel_case_json() {
        let profiles: AppProfilesSettings = serde_json::from_value(serde_json::json!({
            "rules": [{
                "id": "gmail",
                "urlPattern": "gmail.com",
                "config": { "model": "qwen3:4b" }
            }]
        }))
        .expect("partial app-profile JSON should receive current defaults");
        let rule = &profiles.rules[0];
        assert!(rule.enabled);
        assert_eq!(rule.url_pattern, "gmail.com");
        assert_eq!(rule.config.base.model, "qwen3:4b");
        assert_eq!(rule.config.presets, default_neutral_presets());
    }

    #[test]
    fn app_profile_rule_round_trips_camel_case_field_names() {
        let rule = AppProfileRule {
            id: "mail".into(),
            title_pattern: "Inbox".into(),
            configuration_id: "builtin:formal".into(),
            ..Default::default()
        };
        let value = serde_json::to_value(rule).expect("app profile should serialize");
        assert_eq!(value["titlePattern"], "Inbox");
        assert_eq!(value["configurationId"], "builtin:formal");
        assert!(value.get("title_pattern").is_none());
    }

    #[test]
    fn effective_formats_default_to_txt_and_dedupe() {
        let mut general = GeneralSettings::default();
        assert_eq!(
            general.effective_file_transcription_formats(),
            vec![FileTranscriptionFormat::Txt]
        );
        general.file_transcription_formats = vec![
            FileTranscriptionFormat::Vtt,
            FileTranscriptionFormat::Json,
            FileTranscriptionFormat::Vtt,
        ];
        assert_eq!(
            general.effective_file_transcription_formats(),
            vec![FileTranscriptionFormat::Vtt, FileTranscriptionFormat::Json]
        );
    }

    #[test]
    fn recording_retention_uses_frontend_wire_values() {
        assert_eq!(
            serde_json::to_value(RecordingRetention::Days3).unwrap(),
            serde_json::json!("days3")
        );
    }

    #[test]
    fn defaults_match_zod_schema() {
        let s = WinsttSettings::default();

        // model
        assert_eq!(s.model.model, "tiny");
        assert_eq!(s.model.realtime_model, "tiny");
        assert_eq!(s.model.language, "en");
        assert!(!s.model.auto_detect_language);
        assert!(s.model.language_candidates.is_empty());
        assert_eq!(s.model.device, DeviceType::Auto);
        assert_eq!(s.model.onnx_quantization, "auto");
        assert!(s.model.translate_target_language.is_empty());
        assert_eq!(s.global.model_unload_timeout, ModelUnloadTimeout::Min15);

        // quality
        assert!(!s.quality.use_main_model_for_realtime);
        assert_eq!(s.quality.realtime_processing_pause, 0.02);
        assert_eq!(s.quality.init_realtime_after_seconds, 0.2);
        assert_eq!(s.quality.early_transcription_on_silence, 0.2);
        assert!(!s.quality.format_basic_punctuation_casing);
        assert!(!s.quality.format_spoken_commands);
        assert!(!s.quality.format_filler_repeat_cleanup);
        assert!(s.quality.smart_endpoint);
        assert_eq!(s.quality.smart_endpoint_speed, 2.0);
        assert_eq!(s.quality.end_of_sentence_detection_pause, 0.45);
        assert_eq!(s.quality.mid_sentence_detection_pause, 2.0);
        assert_eq!(s.quality.unknown_sentence_detection_pause, 1.3);

        // audio
        assert_eq!(s.audio.input_device_index, None);
        assert!(s.audio.input_device_priority.is_empty());
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
        assert!(s.general.custom_wake_words.is_empty());
        assert_eq!(s.general.wake_word_sensitivity, 0.6);
        assert_eq!(s.general.wake_word_timeout, 5.0);
        assert_eq!(
            s.general.live_transcription_display,
            LiveTranscriptionDisplay::Both
        );
        assert_eq!(s.general.overlay_mode, OverlayMode::DynamicIsland);
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
        assert!(s.general.history_enabled);
        assert_eq!(s.general.history_max_entries, 1000);
        assert_eq!(s.general.recording_retention, RecordingRetention::Cap);
        assert_eq!(s.general.dictionary_context_chars, 220);
        assert_eq!(s.general.auto_submit_key, AutoSubmitKey::Enter);
        assert!(!s.general.word_by_word_pasting);
        assert_eq!(s.general.onboarded_track, OnboardedTrack::Unset);
        assert_eq!(s.general.context_app_mode, ContextAppMode::AllExceptDenied);
        assert!(s.general.context_allow_list.is_empty());
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
        assert_eq!(s.hotkey.push_to_talk_key, DEFAULT_PUSH_TO_TALK_KEY);

        // dictionary / snippets
        assert!(s.dictionary.is_empty());
        assert!(s.snippets.is_empty());

        // llm
        assert_eq!(s.llm.endpoint, "http://localhost:11434");
        assert_eq!(s.llm.timeout, 5000);
        assert_eq!(s.llm.profile_swap_hotkey, "LCtrl+LShift+P");
        assert!(!s.llm.dictation.enabled);
        assert!(!s.llm.dictation.dictionary_auto_add_enabled);
        assert_eq!(s.llm.dictation.base.provider, LlmProvider::Ollama);
        assert_eq!(
            s.llm.dictation.base.reasoning_effort,
            ThinkingEffort::Medium
        );
        assert_eq!(s.llm.dictation.base.thinking_effort, ThinkingEffort::Off);
        assert_eq!(s.llm.dictation.presets.len(), 4);
        assert_eq!(s.llm.dictation.presets[0].key, PresetKey::Neutral);
        assert_eq!(s.llm.dictation.presets[1].key, PresetKey::Reorder);
        assert_eq!(s.llm.dictation.presets[2].key, PresetKey::Restructure);
        assert_eq!(s.llm.dictation.presets[3].key, PresetKey::RewordForClarity);
        assert_eq!(s.llm.transforms.hotkey, "LCtrl+LShift+T");

        // tts
        assert!(!s.tts.enabled);
        assert_eq!(s.tts.voice, "af_heart");
        assert_eq!(s.tts.lang, "en-us");
        assert_eq!(s.tts.speed, 1.0);
        assert_eq!(s.tts.hotkey, "LCtrl+Space");
        assert_eq!(s.tts.source, TtsSource::Local);
        assert_eq!(s.tts.cloud.model, "eleven_multilingual_v2");
        assert_eq!(s.tts.cloud.stability, 0.5);
        assert_eq!(s.tts.cloud.similarity, 0.75);
        assert!(s.tts.cloud.speaker_boost);

        // integrations
        assert_eq!(s.integrations.elevenlabs.api_key, "");
        assert_eq!(s.integrations.elevenlabs.verified, None);
        assert_eq!(s.integrations.elevenlabs.last_verified_at, None);
    }

    #[test]
    fn default_fixture_matches_committed() {
        // Rust is canonical. This locks `WinsttSettings::default()` (minus the
        // backend-only `core` section) to the committed parity fixture, which the
        // zod side (`defaults-parity.test.ts`) must reproduce from
        // `appSettingsSchema.parse({})`. Any new field or changed default fails
        // here AND on the zod side, catching Rust↔zod drift in CI.
        let generated = default_fixture_json().expect("default fixture serializes");
        let committed = include_str!("../../../spec/fixtures/winstt-settings.default.json");
        assert_eq!(
            generated, committed,
            "settings default fixture is out of date — regenerate with \
             `cargo run --example export_settings_fixture` (from src-tauri) and commit \
             spec/fixtures/winstt-settings.default.json",
        );
    }

    #[test]
    fn modifier_only_push_to_talk_survives_deserialize() {
        // Assert against the literal input because the runtime default is
        // platform-specific.
        let s: WinsttSettings = serde_json::from_value(serde_json::json!({
            "hotkey": { "pushToTalkKey": "LCtrl+LMeta" }
        }))
        .unwrap();
        assert_eq!(s.hotkey.push_to_talk_key, "LCtrl+LMeta");
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
    fn translate_target_language_accepts_the_current_string_field() {
        let target: WinsttSettings =
            serde_json::from_str(r#"{ "model": { "translateTargetLanguage": "de" } }"#)
                .expect("current string target must parse");
        assert_eq!(target.model.translate_target_language, "de");
    }

    #[test]
    fn camel_case_wire_format_round_trips() {
        let s = WinsttSettings::default();
        let v = serde_json::to_value(&s).expect("serialize");
        // Renderer reads these exact keys.
        assert!(v["model"]["realtimeModel"].is_string());
        assert!(v["model"]["autoDetectLanguage"].is_boolean());
        assert!(v["model"]["languageCandidates"].is_array());
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
        assert_eq!(s.llm.dictation.base.thinking_effort, ThinkingEffort::Off);
        assert_eq!(s.llm.dictation.base.max_output_tokens, None);
        // Sibling non-flattened fields default too.
        assert_eq!(s.llm.dictation.presets.len(), 4);
        // Shared infra + transforms default.
        assert_eq!(s.llm.endpoint, "http://localhost:11434");
        assert_eq!(s.llm.profile_swap_hotkey, "LCtrl+LShift+P");
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
        assert!(STARTUP_ONLY_KEYS.is_empty());
        assert!(!is_startup_only("model.device"));
        assert!(!is_startup_only("quality.useMainModelForRealtime"));
        assert!(!is_startup_only("general.sendCrashReports"));
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
        assert!(is_secret("integrations.elevenlabs.apiKey"));
        assert!(!is_secret("model.model"));
        assert!(!is_secret("llm.endpoint"));
    }

    #[test]
    fn dictionary_entry_omits_absent_replacement() {
        let entry = DictionaryEntry {
            id: "1".into(),
            term: "WinSTT".into(),
            auto_added: None,
            replacement: None,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert!(v.get("replacement").is_none()); // vocab-bias word, not a pair
        assert!(v.get("autoAdded").is_none()); // manually added entry
        let pair = DictionaryEntry {
            id: "2".into(),
            term: "win s t t".into(),
            auto_added: None,
            replacement: Some("WinSTT".into()),
        };
        let v2 = serde_json::to_value(&pair).unwrap();
        assert_eq!(v2["replacement"], serde_json::json!("WinSTT"));
    }

    #[test]
    fn dictionary_entry_serializes_auto_added_marker() {
        let entry = DictionaryEntry {
            id: "1".into(),
            term: "WinSTT".into(),
            auto_added: Some(true),
            replacement: None,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["autoAdded"], serde_json::json!(true));
    }
}
