// Source: docs.rs/sherpa-onnx/1.13.2 (KeywordSpotter / KeywordSpotterConfig /
//         OnlineModelConfig / OnlineTransducerModelConfig / OnlineStream / KeywordResult),
//         verified 2026-05-31 via docs.rs source (src/kws.rs, src/online_asr.rs).
// WinSTT reference (behavior parity target):
//   server/src/recorder/infrastructure/porcupine_detector.py
//   server/src/recorder/infrastructure/oww_detector.py
//   server/src/recorder/infrastructure/composite_wake_word.py
//   server/src/recorder/bootstrap.py (WAKE_WORD_BACKENDS registry, L938-945)
//   frontend/src/shared/config/settings-schema.ts (general.wakeWord/wakeWordSensitivity/wakeWordTimeout)
//
// ─────────────────────────────────────────────────────────────────────────────
// REAL sherpa-onnx 1.13.2 KWS API (the ONLY thing that changed vs the sherpa-rs draft):
//   pub struct KeywordSpotterConfig {
//       pub feat_config: sys::FeatureConfig,           // { sample_rate: i32, feature_dim: i32 }
//       pub model_config: OnlineModelConfig,           // transducer { encoder/decoder/joiner: Option<String> }, tokens, provider…
//       pub max_active_paths: i32,                     // default 4
//       pub num_trailing_blanks: i32,                  // default 1
//       pub keywords_score: f32,                       // default 1.0 (== Porcupine :boost)
//       pub keywords_threshold: f32,                   // default 0.25 (GLOBAL #threshold floor)
//       pub keywords_file: Option<String>,             // path to keywords.txt
//       pub keywords_buf: Option<String>,              // OR inline keywords content (we use this)
//   }
//   impl Default for KeywordSpotterConfig { /* sr=16000, dim=80, paths=4, blanks=1, score=1.0, thr=0.25 */ }
//   KeywordSpotter::create(&KeywordSpotterConfig) -> Option<Self>          (Send + Sync + Drop)
//   KeywordSpotter::create_stream(&self) -> OnlineStream                   (uses config keywords)
//   KeywordSpotter::create_stream_with_keywords(&self, &str) -> OnlineStream (inline keyword content)
//   KeywordSpotter::is_ready(&self, &OnlineStream) -> bool
//   KeywordSpotter::decode(&self, &OnlineStream)
//   KeywordSpotter::get_result(&self, &OnlineStream) -> Option<KeywordResult>
//   KeywordSpotter::reset(&self, &OnlineStream)
//   OnlineStream::accept_waveform(&self, sample_rate: i32, samples: &[f32])
//   OnlineStream::input_finished(&self)
//   pub struct KeywordResult { keyword: String, tokens: String, tokens_arr: Vec<String>,
//                              timestamps: Vec<f32>, start_time: f32, json: String }
//
// Canonical streaming loop (from the crate's module example):
//   stream.accept_waveform(sr, samples);
//   while kws.is_ready(&stream) { kws.decode(&stream); }
//   if let Some(r) = kws.get_result(&stream) { /* r.keyword non-empty == HIT */ }
//   kws.reset(&stream);   // re-arm after a hit
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN NOTE — why sherpa-onnx KWS replaces Porcupine + openWakeWord
// ─────────────────────────────────────────────────────────────────────────────
// WinSTT's Python server had THREE wake-word backends behind `IWakeWordDetector`:
//   • PorcupineDetector  (pvporcupine 1.9.x — 14 built-in keywords, no access key)
//   • OWWDetector        (openWakeWord ONNX — alexa/hey_jarvis/hey_mycroft/…)
//   • CompositeWakeWord  (BOTH must fire within 1.5 s — only "alexa" supported by both)
// The Rust port (locked decision: "wake word = sherpa-onnx KWS") collapses all
// three to ONE open-vocabulary zipformer-transducer keyword spotter. Benefits:
//   1. Open vocabulary — ANY phrase ("computer", "hey winstt", "take a note")
//      becomes a wake word by tokenizing it into the keywords content.
//   2. One ONNX runtime (sherpa-onnx) for KWS + diarization — no Picovoice native
//      blob, no OWW's pinned-onnxruntime resolver patch.
//   3. Offline, no access key, vendor-agnostic (matches the torch-free posture).
// The trade-off (a global threshold, see UX CAVEAT below) is handled by emitting
// a PER-KEYWORD `#threshold` suffix in the generated keywords content.
//
// ─────────────────────────────────────────────────────────────────────────────
// COMPILE NOTE — no `#[cfg(feature = "sherpa")]` gate any more.
// The draft gated the live detector behind a `sherpa` cargo feature; Cargo.toml
// declares `sherpa-onnx = "1.13.2"` UNCONDITIONALLY (no such feature, and we may
// not edit Cargo.toml), so the detector compiles unconditionally. The deterministic
// helpers (presets / keyword-file builder / sensitivity mapping) never touched the
// FFI and keep their own unit tests.
//
// ─────────────────────────────────────────────────────────────────────────────
// MODULE LAYOUT — this root file owns the shared `WakeWordResult` type + the
// pure path helpers, and re-exports the public surface of the submodules so every
// existing `crate::winstt::wakeword::*` path stays valid:
//   • presets          — preset registry, runtime-engine routing, phrase resolution
//   • tokenize         — keyword-content builder + sensitivity→threshold + BPE/char tokenization
//   • config           — provider enum, KWS/legacy path structs, WakeWordConfig
//   • sherpa_detector  — live sherpa-onnx 1.13.2 KeywordSpotter detector
//   • legacy_porcupine — runtime-loaded pvporcupine 1.9.5 FFI detector
// ─────────────────────────────────────────────────────────────────────────────

use std::ffi::CString;
use std::path::Path;

mod config;
mod legacy_porcupine;
mod presets;
mod sherpa_detector;
mod tokenize;

pub use config::{
    KwsModelPaths, LegacyPorcupinePaths, WakeWordConfig, WakeWordProvider, KWS_BPE_FILE,
    KWS_BUNDLE_DIRNAME, KWS_DECODER_FILE, KWS_DECODER_INT8_FILE, KWS_ENCODER_FILE,
    KWS_ENCODER_INT8_FILE, KWS_JOINER_FILE, KWS_JOINER_INT8_FILE, KWS_TOKENS_FILE,
};
pub use legacy_porcupine::LegacyPorcupineDetector;
pub use presets::{
    is_legacy_porcupine_keyword, resolve_phrase, wakeword_runtime_engine_for_name, WakeWordPreset,
    WakeWordRuntimeEngine, LEGACY_PORCUPINE_KEYWORDS, WAKE_WORD_PRESETS,
};
pub use sherpa_detector::WakeWordDetector;
pub use tokenize::{
    build_keyword_content, build_keyword_content_with_vocabulary, build_keywords_file,
    keyword_label, load_token_vocabulary, sensitivity_to_threshold, tokenize_phrase,
    tokenize_phrase_for_kws_model, tokenize_phrase_with_sentencepiece,
    tokenize_phrase_with_vocabulary, KeywordSpec, THRESHOLD_MAX, THRESHOLD_MIN,
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. Public result type — mirrors WinSTT's `WakeWordResult` frozen dataclass.
//    (domain/ports/wake_word.py: { detected: bool, word_index: int, word: str })
// ═════════════════════════════════════════════════════════════════════════════

/// Outcome of feeding one audio chunk to the keyword spotter.
///
/// `word_index` indexes into the keyword list that was compiled into the
/// active keywords content (stable order = order of [`WakeWordConfig::keywords`]).
/// `-1` means "detected, but the spotter returned a phrase we did not register"
/// (should not happen with a generated file, but kept honest).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakeWordResult {
    pub detected: bool,
    pub word_index: i32,
    pub word: String,
}

impl WakeWordResult {
    pub fn none() -> Self {
        WakeWordResult {
            detected: false,
            word_index: -1,
            word: String::new(),
        }
    }

    pub fn hit(word_index: i32, word: impl Into<String>) -> Self {
        WakeWordResult {
            detected: true,
            word_index,
            word: word.into(),
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared pure path helpers — used by both detector submodules.
// ═════════════════════════════════════════════════════════════════════════════

fn cstring_path(path: &Path) -> anyhow::Result<CString> {
    if !path.exists() {
        anyhow::bail!("Porcupine path does not exist: {}", path.display());
    }
    let s = path
        .to_str()
        .ok_or_else(|| anyhow::anyhow!("Porcupine path is not valid UTF-8: {}", path.display()))?;
    CString::new(s).map_err(|err| anyhow::anyhow!("Porcupine path contains NUL byte: {err}"))
}

fn normalize_keyword_label(label: &str) -> String {
    label.trim().to_lowercase().replace('_', " ")
}

/// Validate a model path exists and render it as a UTF-8 string for the FFI
/// config. sherpa's C config takes `const char*`; a non-UTF-8 Windows path
/// would silently truncate, so we reject it loudly here.
fn path_string(path: &Path) -> anyhow::Result<String> {
    if !path.exists() {
        anyhow::bail!("KWS model file does not exist: {}", path.display());
    }
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("KWS model path is not valid UTF-8: {}", path.display()))
}

/// Lossy path → String for the OPTIONAL keywords-file path (existence already
/// implied by the manager; we don't hard-fail keyword-file rendering the way we
/// do for required model files).
fn path_string_lossy(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Tests — only the deterministic, pure-logic surface (no ML, no FFI).
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::presets::normalize_name;
    use super::tokenize::{char_tokenize_phrase, fmt_f32};
    use super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;

    // ── preset resolution ──────────────────────────────────────────────────

    #[test]
    fn resolve_known_preset_returns_phrase() {
        assert_eq!(resolve_phrase("alexa"), "alexa");
        assert_eq!(resolve_phrase("jarvis"), "jarvis");
        assert_eq!(resolve_phrase("hey google"), "hey google");
    }

    #[test]
    fn resolve_is_case_insensitive() {
        assert_eq!(resolve_phrase("ALEXA"), "alexa");
        assert_eq!(resolve_phrase("Computer"), "computer");
    }

    #[test]
    fn resolve_normalizes_oww_underscore_names() {
        // The OWW-style persisted name "hey_jarvis" must spot "hey jarvis".
        assert_eq!(resolve_phrase("hey_jarvis"), "hey jarvis");
        // A stale underscore variant of a space-named preset resolves the same.
        assert_eq!(resolve_phrase("hey_google"), "hey google");
    }

    #[test]
    fn resolve_unknown_is_taken_as_custom_phrase() {
        assert_eq!(resolve_phrase("hey winstt"), "hey winstt");
        assert_eq!(resolve_phrase("  Take_A_Note  "), "take a note");
    }

    #[test]
    fn default_wake_word_alexa_is_present() {
        // settings-schema.ts defaults general.wakeWord to "alexa".
        assert!(WAKE_WORD_PRESETS.iter().any(|p| p.name == "alexa"));
    }

    // ── name normalization ─────────────────────────────────────────────────

    #[test]
    fn legacy_porcupine_keywords_are_known_builtins() {
        assert!(is_legacy_porcupine_keyword("alexa"));
        assert!(is_legacy_porcupine_keyword("hey_google"));
        assert!(is_legacy_porcupine_keyword("pico clock"));
        assert!(!is_legacy_porcupine_keyword("hey winstt"));
    }

    #[test]
    fn runtime_engine_routes_custom_phrases_to_sherpa() {
        assert_eq!(
            wakeword_runtime_engine_for_name("hey winstt"),
            WakeWordRuntimeEngine::SherpaKws
        );
    }

    #[cfg(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "x86_64")
    ))]
    #[test]
    fn runtime_engine_routes_supported_builtins_to_legacy_porcupine() {
        assert_eq!(
            wakeword_runtime_engine_for_name("computer"),
            WakeWordRuntimeEngine::LegacyPorcupine
        );
    }

    #[test]
    fn normalize_collapses_separators() {
        assert_eq!(normalize_name("hey__jarvis"), "hey jarvis");
        assert_eq!(normalize_name("ok   google"), "ok google");
        assert_eq!(normalize_name("_alexa_"), "alexa");
    }

    // ── f32 formatting ─────────────────────────────────────────────────────

    #[test]
    fn fmt_f32_keeps_integers_integral() {
        assert_eq!(fmt_f32(2.0), "2");
        assert_eq!(fmt_f32(3.0), "3");
    }

    #[test]
    fn fmt_f32_strips_trailing_zeros() {
        assert_eq!(fmt_f32(0.5), "0.5");
        assert_eq!(fmt_f32(0.35), "0.35");
        assert_eq!(fmt_f32(0.250), "0.25");
    }

    // ── sensitivity → threshold (the direction-flip invariant) ─────────────

    #[test]
    fn sensitivity_inverts_to_threshold() {
        // Higher UI sensitivity → looser (lower) sherpa threshold.
        let strict = sensitivity_to_threshold(0.0);
        let mid = sensitivity_to_threshold(0.6);
        let loose = sensitivity_to_threshold(1.0);
        assert!(strict > mid, "0.0 sensitivity must be the strictest");
        assert!(mid > loose, "1.0 sensitivity must be the loosest");
    }

    #[test]
    fn sensitivity_endpoints_hit_bounds() {
        assert_eq!(sensitivity_to_threshold(0.0), THRESHOLD_MAX);
        assert_eq!(sensitivity_to_threshold(1.0), THRESHOLD_MIN);
    }

    #[test]
    fn sensitivity_default_matches_sherpa_feel() {
        // WinSTT default 0.6 should land near sherpa's documented 0.25 default.
        let t = sensitivity_to_threshold(0.6);
        assert!((t - 0.22).abs() < 0.01, "got {t}, expected ~0.22");
    }

    #[test]
    fn sensitivity_clamps_out_of_range() {
        assert_eq!(sensitivity_to_threshold(-5.0), THRESHOLD_MAX);
        assert_eq!(sensitivity_to_threshold(99.0), THRESHOLD_MIN);
    }

    // ── keyword-content builder (the load-bearing per-keyword UX path) ─────

    #[test]
    fn to_line_tokens_only() {
        let spec = KeywordSpec {
            tokens: "▁HE Y ▁S I RI".to_string(),
            label: "hey siri".to_string(),
            boost: None,
            threshold: None,
        };
        assert_eq!(spec.to_line(), "▁HE Y ▁S I RI @hey siri");
    }

    #[test]
    fn to_line_with_boost_and_threshold_order() {
        // Order MUST be: tokens :boost #threshold @label
        let spec = KeywordSpec {
            tokens: "▁A L E X A".to_string(),
            label: "alexa".to_string(),
            boost: Some(2.0),
            threshold: Some(0.35),
        };
        assert_eq!(spec.to_line(), "▁A L E X A :2 #0.35 @alexa");
    }

    #[test]
    fn to_line_trims_token_and_label_whitespace() {
        let spec = KeywordSpec {
            tokens: "  ▁C O M P U T E R  ".to_string(),
            label: "  computer  ".to_string(),
            boost: None,
            threshold: Some(0.2),
        };
        assert_eq!(spec.to_line(), "▁C O M P U T E R #0.2 @computer");
    }

    #[test]
    fn build_keywords_file_joins_with_newlines_and_trailing_nl() {
        let specs = vec![
            KeywordSpec {
                tokens: "▁A L E X A".to_string(),
                label: "alexa".to_string(),
                boost: None,
                threshold: Some(sensitivity_to_threshold(0.6)),
            },
            KeywordSpec {
                tokens: "▁J AR VI S".to_string(),
                label: "jarvis".to_string(),
                boost: None,
                threshold: Some(sensitivity_to_threshold(0.6)),
            },
        ];
        let body = build_keywords_file(&specs);
        assert_eq!(body, "▁A L E X A #0.22 @alexa\n▁J AR VI S #0.22 @jarvis\n");
        assert!(body.ends_with('\n'));
    }

    #[test]
    fn build_keywords_file_empty_is_empty() {
        assert_eq!(build_keywords_file(&[]), "");
    }

    // ── phrase tokenization (the bridge before the engine) ─────────────────

    #[test]
    fn tokenize_known_preset_uses_verified_bpe() {
        // Generated from the bundle's bpe.model with SentencePiece.
        assert_eq!(tokenize_phrase("alexa"), "▁A LE X A");
        assert_eq!(tokenize_phrase("computer"), "▁COMP U TER");
        assert_eq!(tokenize_phrase("hey siri"), "▁HE Y ▁S I RI");
        assert_eq!(tokenize_phrase("HEY SIRI"), "▁HE Y ▁S I RI");
        assert_eq!(tokenize_phrase("ok google"), "▁O K ▁GO O G LE");
    }

    #[test]
    fn tokenize_unknown_phrase_falls_back_to_chars() {
        assert_eq!(tokenize_phrase("hey winstt"), "▁H E Y ▁W I N S T T");
        assert_eq!(tokenize_phrase("custom"), "▁C U S T O M");
    }

    #[test]
    fn tokenize_with_vocabulary_prefers_model_native_pieces() {
        let vocab = HashSet::from([
            "▁N".to_string(),
            "OV".to_string(),
            "A".to_string(),
            "▁W".to_string(),
            "IN".to_string(),
            "S".to_string(),
            "T".to_string(),
        ]);
        assert_eq!(tokenize_phrase_with_vocabulary("nova", &vocab), "▁N OV A");
        assert_eq!(
            tokenize_phrase_with_vocabulary("winstt", &vocab),
            "▁W IN S T T"
        );
    }

    #[test]
    fn char_tokenize_marks_each_word_start() {
        // Each word gets its own ▁ word-start marker.
        assert_eq!(char_tokenize_phrase("hey winstt"), "▁H E Y ▁W I N S T T");
    }

    #[test]
    fn tokenize_blank_phrase_is_empty() {
        assert_eq!(tokenize_phrase("   "), "");
        assert_eq!(tokenize_phrase(""), "");
    }

    #[test]
    fn build_keyword_content_emits_tokens_threshold_label() {
        // alexa @0.6 sensitivity → #0.22, exact BPE-tokenized, labelled.
        let body = build_keyword_content("alexa", 0.6);
        assert_eq!(body, "▁A LE X A #0.22 @alexa\n");
        assert!(body.ends_with('\n'));
    }

    #[test]
    fn build_keyword_content_blank_is_empty() {
        assert_eq!(build_keyword_content("", 0.6), "");
    }

    #[test]
    fn build_keyword_content_preset_uses_bpe_tokens() {
        let body = build_keyword_content("hey siri", 0.6);
        assert_eq!(body, "▁HE Y ▁S I RI #0.22 @hey_siri\n");
    }

    #[test]
    fn keyword_label_is_single_sherpa_token() {
        assert_eq!(keyword_label("hey google"), "hey_google");
        assert_eq!(keyword_label("  HEY   WinSTT  "), "hey_winstt");
    }

    #[test]
    fn build_keyword_content_with_vocabulary_uses_runtime_tokens() {
        let vocab = HashSet::from([
            "▁A".to_string(),
            "LE".to_string(),
            "X".to_string(),
            "A".to_string(),
        ]);
        let body = build_keyword_content_with_vocabulary("alexa", 0.6, &vocab);
        assert_eq!(body, "▁A LE X A #0.22 @alexa\n");
    }

    // ── KWS bundle path resolution ─────────────────────────────────────────

    #[test]
    fn kws_paths_from_bundle_dir_joins_known_files() {
        let dir = Path::new("/tmp/kws");
        let paths = KwsModelPaths::from_bundle_dir(dir);
        assert_eq!(paths.encoder, dir.join(KWS_ENCODER_FILE));
        assert_eq!(paths.tokens, dir.join(KWS_TOKENS_FILE));
    }

    #[test]
    fn kws_int8_paths_from_bundle_dir_joins_quantized_files() {
        let dir = Path::new("/tmp/kws");
        let paths = KwsModelPaths::from_bundle_dir_int8(dir);
        assert_eq!(paths.encoder, dir.join(KWS_ENCODER_INT8_FILE));
        assert_eq!(paths.decoder, dir.join(KWS_DECODER_INT8_FILE));
        assert_eq!(paths.joiner, dir.join(KWS_JOINER_INT8_FILE));
        assert_eq!(paths.tokens, dir.join(KWS_TOKENS_FILE));
    }

    #[test]
    fn kws_paths_all_present_false_when_missing() {
        let paths = KwsModelPaths::from_bundle_dir(Path::new("/definitely/not/here"));
        assert!(!paths.all_present());
    }

    // ── result helpers ─────────────────────────────────────────────────────

    #[test]
    fn wake_result_none_is_not_detected() {
        let r = WakeWordResult::none();
        assert!(!r.detected);
        assert_eq!(r.word_index, -1);
    }

    #[test]
    fn wake_result_hit_carries_index_and_word() {
        let r = WakeWordResult::hit(2, "computer");
        assert!(r.detected);
        assert_eq!(r.word_index, 2);
        assert_eq!(r.word, "computer");
    }

    // ── provider mapping ───────────────────────────────────────────────────

    #[test]
    fn provider_maps_to_sherpa_strings() {
        assert_eq!(WakeWordProvider::Cpu.as_sherpa_str(), "cpu");
        assert_eq!(WakeWordProvider::DirectMl.as_sherpa_str(), "directml");
        assert_eq!(WakeWordProvider::default(), WakeWordProvider::Cpu);
    }

    #[test]
    fn wakeword_provider_stays_cpu_for_all_stt_accelerators() {
        assert_eq!(
            WakeWordProvider::from_stt_accelerator(crate::winstt::stt::Accelerator::DirectMl),
            WakeWordProvider::Cpu
        );
        assert_eq!(
            WakeWordProvider::from_stt_accelerator(crate::winstt::stt::Accelerator::Cpu),
            WakeWordProvider::Cpu
        );
        assert_eq!(
            WakeWordProvider::from_stt_accelerator(crate::winstt::stt::Accelerator::Cuda),
            WakeWordProvider::Cpu
        );
    }

    // ── config thresholds ──────────────────────────────────────────────────

    fn sample_config() -> WakeWordConfig {
        WakeWordConfig {
            model: KwsModelPaths {
                encoder: PathBuf::from("e.onnx"),
                decoder: PathBuf::from("d.onnx"),
                joiner: PathBuf::from("j.onnx"),
                tokens: PathBuf::from("tokens.txt"),
            },
            keywords_file: None,
            keywords_content: Some("▁A L E X A #0.22 @alexa\n".to_string()),
            keywords: vec!["alexa".to_string()],
            provider: WakeWordProvider::Cpu,
            sensitivity: 0.6,
            timeout_seconds: 5.0,
            num_threads: None,
            keywords_score: None,
        }
    }

    #[test]
    fn config_global_threshold_is_the_loosest_floor() {
        let cfg = sample_config();
        // The global must equal the loosest per-keyword threshold so a content
        // `#t` can only tighten, never be masked.
        assert_eq!(cfg.global_threshold(), THRESHOLD_MIN);
        assert!(cfg.global_threshold() <= sensitivity_to_threshold(1.0) + f32::EPSILON);
    }

    #[test]
    fn config_default_boost_matches_porcupine_feel() {
        let cfg = sample_config();
        assert_eq!(cfg.default_boost(), 3.0);
    }

    #[test]
    fn config_keywords_inline_prefers_content() {
        let cfg = sample_config();
        assert_eq!(cfg.keywords_inline(), Some("▁A L E X A #0.22 @alexa\n"));
        let empty = WakeWordConfig {
            keywords_content: None,
            ..sample_config()
        };
        assert_eq!(empty.keywords_inline(), None);
    }

    // ── path helpers (no model files required) ─────────────────────────────

    #[test]
    fn path_string_lossy_round_trips_ascii() {
        assert_eq!(path_string_lossy(Path::new("keywords.txt")), "keywords.txt");
    }

    #[test]
    fn path_string_rejects_missing_required_file() {
        // A required model file that does not exist must hard-fail (loud), so the
        // detector never stands up against a half-downloaded bundle.
        let err = path_string(Path::new("definitely-not-a-real-kws-file.onnx"));
        assert!(err.is_err());
    }
}
