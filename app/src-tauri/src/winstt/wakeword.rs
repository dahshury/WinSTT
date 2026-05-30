// DRAFT PORT — not yet compiled.
// Source (WinSTT reference):
//   server/src/recorder/infrastructure/porcupine_detector.py
//   server/src/recorder/infrastructure/oww_detector.py
//   server/src/recorder/infrastructure/composite_wake_word.py
//   server/src/recorder/bootstrap.py (WAKE_WORD_BACKENDS registry, L938-945)
//   handy_winstt/examples/winstt-port-docs/inventory/04_audio_vad_wake_diar.md (§3)
//   frontend/src/shared/config/settings-schema.ts (general.wakeWord/wakeWordSensitivity/wakeWordTimeout)
// External API (verified 2026-05, sherpa-rs 0.6.8):
//   thewh1teagle/sherpa-rs crates/sherpa-rs/src/keyword_spot.rs
//     KeywordSpotConfig { zipformer_encoder, zipformer_decoder, zipformer_joiner,
//       tokens, keywords, max_active_path, keywords_threshold, keywords_score,
//       num_trailing_blanks, sample_rate, feature_dim, debug, num_threads, provider }
//     KeywordSpot::new(config) -> Result<Self>
//     KeywordSpot::extract_keyword(&mut self, samples: Vec<f32>, sample_rate: u32)
//        -> Result<Option<String>>
//   sherpa-onnx KWS keywords.txt is BPE-tokenized: "▁HE LL O ▁WORLD @hello world"
//   per-keyword tuning suffixes: ":<boost>" (== keywords_score) and "#<threshold>".
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
//      becomes a wake word by tokenizing it into the keywords file. Porcupine's
//      14 fixed keywords and OWW's small bundled set are no longer a ceiling.
//   2. One ONNX runtime (ort/sherpa-onnx) for STT + KWS + diarization — no
//      Picovoice native blob, no OWW's pinned-onnxruntime resolver patch.
//   3. Offline, no access key, vendor-agnostic (matches the torch-free posture).
// The trade-off (a global threshold, see UX CAVEAT below) is handled by emitting
// a PER-KEYWORD `#threshold` suffix in the generated keywords file.

use std::path::{Path, PathBuf};

// NOTE(port): the real import once `sherpa-rs = { version = "0.6.8", features = ["directml"] }`
// is added to Cargo.toml (tracked in PORT/00_cargo_additions.md). Gated so this
// module compiles for the deterministic helpers + tests even before the dep lands.
#[cfg(feature = "sherpa")]
use sherpa_rs::keyword_spot::{KeywordSpot as SherpaKeywordSpot, KeywordSpotConfig};

// ═════════════════════════════════════════════════════════════════════════════
// 1. Public result type — mirrors WinSTT's `WakeWordResult` frozen dataclass.
//    (domain/ports/wake_word.py: { detected: bool, word_index: int, word: str })
// ═════════════════════════════════════════════════════════════════════════════

/// Outcome of feeding one audio chunk to the keyword spotter.
///
/// `word_index` indexes into the keyword list that was compiled into the
/// active keywords file (stable order = order of [`WakeWordConfig::keywords`]).
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
        WakeWordResult { detected: false, word_index: -1, word: String::new() }
    }

    pub fn hit(word_index: i32, word: impl Into<String>) -> Self {
        WakeWordResult { detected: true, word_index, word: word.into() }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Preset registry — maps WinSTT's historical wake-word NAMES (the values the
//    renderer persists in `general.wakeWord`, default "alexa") to the canonical
//    spoken phrase the KWS engine should listen for.
//
//    WinSTT/Porcupine exposed 14 built-in keywords with no signup; openWakeWord
//    added a few "hey_*" phrases. The renderer's `wakeWordBackendFor` selected
//    Porcupine vs OWW vs composite from the NAME alone. In the unified KWS port
//    there is no backend to select — every preset is just a phrase to tokenize.
//
//    Underscores in OWW-style names ("hey_jarvis") are normalized to spaces so
//    the tokenizer sees the real phrase. The `@transcript` half of a keywords
//    line is the human-readable label echoed back on a hit.
// ═════════════════════════════════════════════════════════════════════════════

/// One built-in wake-word preset: the persisted NAME and the phrase to spot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WakeWordPreset {
    /// The value stored in `general.wakeWord` (Porcupine/OWW historical name).
    pub name: &'static str,
    /// The natural-language phrase fed to the BPE tokenizer.
    pub phrase: &'static str,
}

/// The 14 Porcupine 1.9.x built-ins plus the openWakeWord "hey_*" extras that
/// WinSTT shipped. Order is irrelevant (looked up by name); the renderer's
/// dropdown drives which one is active. Anything NOT in this table is treated
/// as a free-form custom phrase (see [`resolve_phrase`]).
pub const WAKE_WORD_PRESETS: &[WakeWordPreset] = &[
    // ── Porcupine 1.9.x built-ins (no access key) ──
    WakeWordPreset { name: "alexa", phrase: "alexa" },
    WakeWordPreset { name: "americano", phrase: "americano" },
    WakeWordPreset { name: "blueberry", phrase: "blueberry" },
    WakeWordPreset { name: "bumblebee", phrase: "bumblebee" },
    WakeWordPreset { name: "computer", phrase: "computer" },
    WakeWordPreset { name: "grapefruit", phrase: "grapefruit" },
    WakeWordPreset { name: "grasshopper", phrase: "grasshopper" },
    WakeWordPreset { name: "hey google", phrase: "hey google" },
    WakeWordPreset { name: "hey siri", phrase: "hey siri" },
    WakeWordPreset { name: "jarvis", phrase: "jarvis" },
    WakeWordPreset { name: "ok google", phrase: "ok google" },
    WakeWordPreset { name: "picovoice", phrase: "picovoice" },
    WakeWordPreset { name: "porcupine", phrase: "porcupine" },
    WakeWordPreset { name: "terminator", phrase: "terminator" },
    // ── openWakeWord "hey_*" phrases WinSTT exposed (underscores → spaces) ──
    WakeWordPreset { name: "hey_jarvis", phrase: "hey jarvis" },
    WakeWordPreset { name: "hey_mycroft", phrase: "hey mycroft" },
    WakeWordPreset { name: "hey_rhasspy", phrase: "hey rhasspy" },
];

/// Resolve a persisted wake-word name into the phrase to spot.
///
/// Lookup is case-insensitive over the preset table; underscores in the INPUT
/// are also normalized so a stale `"hey_google"` resolves the same as
/// `"hey google"`. An unrecognized value is taken as a literal custom phrase
/// (trimmed, lower-cased, underscores→spaces) — open vocabulary means a user
/// can type any trigger and it just works.
pub fn resolve_phrase(name: &str) -> String {
    let normalized = normalize_name(name);
    for preset in WAKE_WORD_PRESETS {
        if normalize_name(preset.name) == normalized {
            return preset.phrase.to_string();
        }
    }
    // Unknown → treat the persisted value itself as the phrase (custom trigger).
    normalized
}

/// Lower-case, trim, and collapse `_`/whitespace runs into single spaces.
fn normalize_name(name: &str) -> String {
    let lowered = name.trim().to_lowercase();
    let mut out = String::with_capacity(lowered.len());
    let mut last_was_space = false;
    for ch in lowered.chars() {
        if ch == '_' || ch.is_whitespace() {
            if !last_was_space && !out.is_empty() {
                out.push(' ');
            }
            last_was_space = true;
        } else {
            out.push(ch);
            last_was_space = false;
        }
    }
    // Drop any trailing space introduced by a terminal separator.
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Keyword-file builder — DETERMINISTIC, fully unit-tested.
//
//    sherpa-onnx KWS reads a `keywords.txt` where each line is the BPE-TOKENIZED
//    phrase, optionally followed by per-keyword tuning and a `@label`:
//
//        ▁HE Y ▁S I RI :2.0 #0.35 @hey siri
//        └─ tokens ──┘ └boost┘└thresh┘ └─ label ─┘
//
//    The token half is produced by `sherpa-onnx-cli text2token` (BPE over the
//    model's bpe.model + tokens.txt). We do NOT reimplement BPE here — that is a
//    model-coupled subprocess/FFI step (see SPEC §A in 05_*.md). What IS
//    deterministic and testable is assembling the file from already-tokenized
//    phrases plus the per-keyword sensitivity → `#threshold` mapping. The
//    builder below operates on `KeywordSpec` rows whose `.tokens` came from
//    text2token, and is the load-bearing logic for the per-keyword UX caveat.
// ═════════════════════════════════════════════════════════════════════════════

/// One fully-resolved keyword line to emit into `keywords.txt`.
#[derive(Debug, Clone, PartialEq)]
pub struct KeywordSpec {
    /// Space-separated BPE tokens, e.g. `"▁HE Y ▁S I RI"` (from text2token).
    pub tokens: String,
    /// Human-readable label echoed on a hit (the `@…` half).
    pub label: String,
    /// Optional per-keyword boost (`keywords_score` override, `:value`).
    pub boost: Option<f32>,
    /// Optional per-keyword detection threshold (`#value`); see UX CAVEAT.
    pub threshold: Option<f32>,
}

impl KeywordSpec {
    /// Render this spec to a single `keywords.txt` line (no trailing newline).
    ///
    /// Ordering matches sherpa-onnx's parser expectation:
    ///   `<tokens> [:<boost>] [#<threshold>] @<label>`
    /// Floats are formatted compactly (no trailing zeros beyond what's needed)
    /// so the file is diff-stable and human-auditable.
    pub fn to_line(&self) -> String {
        let mut line = self.tokens.trim().to_string();
        if let Some(boost) = self.boost {
            line.push_str(&format!(" :{}", fmt_f32(boost)));
        }
        if let Some(threshold) = self.threshold {
            line.push_str(&format!(" #{}", fmt_f32(threshold)));
        }
        line.push_str(" @");
        line.push_str(self.label.trim());
        line
    }
}

/// Format an f32 without a fixed precision: integers stay integral ("2"),
/// fractions keep up to 3 dp with trailing zeros stripped ("0.35", "0.5").
fn fmt_f32(value: f32) -> String {
    if value.fract() == 0.0 {
        return format!("{}", value as i64);
    }
    let mut s = format!("{value:.3}");
    while s.ends_with('0') {
        s.pop();
    }
    if s.ends_with('.') {
        s.pop();
    }
    s
}

/// Assemble a complete `keywords.txt` body from already-tokenized specs.
///
/// Returns the joined lines with a trailing newline (sherpa-onnx tolerates
/// either, but a terminal newline avoids a "last keyword dropped on some
/// readers" class of bug). Empty input yields an empty string.
pub fn build_keywords_file(specs: &[KeywordSpec]) -> String {
    if specs.is_empty() {
        return String::new();
    }
    let mut body = String::new();
    for spec in specs {
        body.push_str(&spec.to_line());
        body.push('\n');
    }
    body
}

/// Convert a UI sensitivity (0.0 = strict … 1.0 = permissive — WinSTT's
/// `general.wakeWordSensitivity`, default 0.6) into a sherpa `#threshold`.
///
/// ⚠️ DIRECTION FLIP. In WinSTT/Porcupine HIGHER sensitivity = MORE permissive
/// (fires more easily). In sherpa-onnx KWS a HIGHER `keywords_threshold`/`#t`
/// means a STRICTER match (the decoded token score must clear it). So we INVERT:
///
///     threshold = THRESHOLD_MAX - sensitivity * (THRESHOLD_MAX - THRESHOLD_MIN)
///
/// With the defaults below, sensitivity 0.6 → threshold ≈ 0.22, i.e. close to
/// sherpa's documented default of 0.25 — preserving WinSTT's out-of-box feel.
/// sensitivity 1.0 → 0.10 (loosest, matches the crate's KeywordSpotConfig
/// default), sensitivity 0.0 → 0.40 (strict).
pub const THRESHOLD_MIN: f32 = 0.10;
pub const THRESHOLD_MAX: f32 = 0.40;

pub fn sensitivity_to_threshold(sensitivity: f32) -> f32 {
    let s = sensitivity.clamp(0.0, 1.0);
    let raw = THRESHOLD_MAX - s * (THRESHOLD_MAX - THRESHOLD_MIN);
    // Round to 2 dp so the emitted #threshold is tidy & diff-stable.
    (raw * 100.0).round() / 100.0
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Configuration — the inputs the manager needs to stand up a KeywordSpot.
// ═════════════════════════════════════════════════════════════════════════════

/// Inference provider for the KWS session.
///
/// INVARIANT (PORT/README §Conventions, 03_stt_engine.md): the zipformer KWS
/// transducer runs fine on DirectML, but we default to CPU because the KWS
/// session is tiny (~3 MB) and runs continuously — keeping the GPU free for the
/// STT model swap. The Silero VAD CPU-only invariant is unrelated (different
/// session) but the same conservative posture applies here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WakeWordProvider {
    #[default]
    Cpu,
    DirectMl,
}

impl WakeWordProvider {
    /// String passed into sherpa's `KeywordSpotConfig::provider`.
    pub fn as_sherpa_str(self) -> &'static str {
        match self {
            WakeWordProvider::Cpu => "cpu",
            WakeWordProvider::DirectMl => "directml",
        }
    }
}

/// Paths to the four files of a sherpa-onnx KWS zipformer model bundle.
/// (encoder/decoder/joiner ONNX + tokens.txt). Downloaded once from the
/// `kws-models` GitHub release — e.g. `sherpa-onnx-kws-zipformer-gigaspeech-3.3M`
/// (English) or `…-zh-en-3M-2025-12-20` (bilingual). bpe.model lives alongside
/// and is consumed by the text2token step (SPEC §A), not at runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KwsModelPaths {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
}

/// Everything needed to build/refresh a live keyword spotter.
#[derive(Debug, Clone, PartialEq)]
pub struct WakeWordConfig {
    pub model: KwsModelPaths,
    /// Path to the generated `keywords.txt` (written by [`build_keywords_file`]).
    pub keywords_file: PathBuf,
    /// Ordered active keyword phrases (label half). Index == `word_index`.
    pub keywords: Vec<String>,
    pub provider: WakeWordProvider,
    /// 0..1 UI sensitivity, mapped to the per-keyword `#threshold`.
    pub sensitivity: f32,
    /// Seconds the wake gate stays armed after a hit (`general.wakeWordTimeout`,
    /// default 5). Enforced by the recorder state machine, NOT this module — we
    /// carry it for the manager to read.
    pub timeout_seconds: f32,
    pub num_threads: Option<i32>,
}

impl WakeWordConfig {
    /// The global `keywords_threshold` for `KeywordSpotConfig`. We push the REAL
    /// per-keyword thresholds into the keywords file (`#t` suffix), and keep the
    /// config global at the LOOSEST end so a per-keyword `#t` can only TIGHTEN,
    /// never loosen below it. (sherpa applies the per-keyword `#t` on top of the
    /// global; a global stricter than a `#t` would mask it.)
    pub fn global_threshold(&self) -> f32 {
        THRESHOLD_MIN
    }

    /// Default boost (`keywords_score`). sherpa default is 1.0–3.0; the crate's
    /// KeywordSpotConfig defaults to 3.0. Short triggers (≤2 syllables) get a
    /// recall spike when boosted — see the SHORT-TRIGGER note in 05_*.md.
    pub fn default_boost(&self) -> f32 {
        3.0
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. The detector — real sherpa-rs wiring (compiled under `feature = "sherpa"`).
//
//    Mirrors `IWakeWordDetector`: `detect(chunk) -> WakeWordResult` + cleanup.
//    sherpa's stateful streaming KWS holds its own internal online-stream; we
//    feed each 16 kHz mono f32 chunk straight in. `extract_keyword` returns the
//    matched LABEL string on a hit (the `@…` half), which we map back to the
//    keyword index via the config's ordered `keywords` vector.
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(feature = "sherpa")]
pub struct WakeWordDetector {
    spotter: SherpaKeywordSpot,
    keywords: Vec<String>,
    sample_rate: u32,
}

#[cfg(feature = "sherpa")]
impl WakeWordDetector {
    /// Build a live spotter from a [`WakeWordConfig`]. The caller must have
    /// already written `config.keywords_file` via [`build_keywords_file`].
    pub fn new(config: &WakeWordConfig) -> anyhow::Result<Self> {
        let sherpa_config = KeywordSpotConfig {
            zipformer_encoder: path_string(&config.model.encoder)?,
            zipformer_decoder: path_string(&config.model.decoder)?,
            zipformer_joiner: path_string(&config.model.joiner)?,
            tokens: path_string(&config.model.tokens)?,
            keywords: path_string(&config.keywords_file)?,
            // Per-keyword `#threshold` in the file TIGHTENS this global floor.
            keywords_threshold: config.global_threshold(),
            keywords_score: config.default_boost(),
            // sherpa-rs / sherpa-onnx defaults (verified against keyword_spot.rs).
            max_active_path: 4,
            num_trailing_blanks: 1,
            sample_rate: 16_000,
            feature_dim: 80,
            debug: false,
            num_threads: config.num_threads,
            provider: Some(config.provider.as_sherpa_str().to_string()),
        };

        let spotter = SherpaKeywordSpot::new(sherpa_config)
            .map_err(|e| anyhow::anyhow!("failed to create sherpa KeywordSpot: {e}"))?;

        Ok(WakeWordDetector { spotter, keywords: config.keywords.clone(), sample_rate: 16_000 })
    }

    /// Feed one 16 kHz mono f32 chunk; report any detection.
    ///
    /// sherpa's spotter is internally stateful and auto-resets after a hit, so
    /// the typical loop is: `for chunk in mic { if detect(chunk).detected { … } }`.
    /// On a match the engine returns the LABEL (`@…` half); we resolve its index
    /// in the active keyword list (`-1` if somehow unknown).
    pub fn detect(&mut self, chunk: &[f32]) -> WakeWordResult {
        match self.spotter.extract_keyword(chunk.to_vec(), self.sample_rate) {
            Ok(Some(label)) => {
                let idx = self.index_of(&label);
                WakeWordResult::hit(idx, label)
            }
            Ok(None) => WakeWordResult::none(),
            Err(e) => {
                // Fail-soft (mirrors OnnxAsrDiarizer._safe_diarize): never crash
                // the recorder thread on a spotter hiccup.
                log::warn!("[wakeword] extract_keyword error: {e}");
                WakeWordResult::none()
            }
        }
    }

    fn index_of(&self, label: &str) -> i32 {
        let needle = label.trim().to_lowercase();
        self.keywords
            .iter()
            .position(|k| k.trim().to_lowercase() == needle)
            .map(|p| p as i32)
            .unwrap_or(-1)
    }

    /// No-op today (sherpa owns the session); kept for `IWakeWordDetector` parity.
    pub fn cleanup(&mut self) {}
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

// ═════════════════════════════════════════════════════════════════════════════
// 6. Tests — only the DETERMINISTIC, pure-logic surface (no ML, no FFI).
// ═════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

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

    // ── keyword-file builder (the load-bearing per-keyword UX path) ────────

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

    // ── config thresholds ──────────────────────────────────────────────────

    #[test]
    fn config_global_threshold_is_the_loosest_floor() {
        let cfg = WakeWordConfig {
            model: KwsModelPaths {
                encoder: PathBuf::from("e.onnx"),
                decoder: PathBuf::from("d.onnx"),
                joiner: PathBuf::from("j.onnx"),
                tokens: PathBuf::from("tokens.txt"),
            },
            keywords_file: PathBuf::from("keywords.txt"),
            keywords: vec!["alexa".to_string()],
            provider: WakeWordProvider::Cpu,
            sensitivity: 0.6,
            timeout_seconds: 5.0,
            num_threads: None,
        };
        // The global must equal the loosest per-keyword threshold so a file
        // `#t` can only tighten, never be masked.
        assert_eq!(cfg.global_threshold(), THRESHOLD_MIN);
        assert!(cfg.global_threshold() <= sensitivity_to_threshold(1.0) + f32::EPSILON);
    }
}
