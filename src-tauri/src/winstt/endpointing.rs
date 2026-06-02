#![allow(dead_code)]
// STUB: not yet wired — the pure endpoint/noise-break logic below is fully
// implemented + unit-tested, but it is NOT yet hooked into the recorder
// pipeline (no caller computes preview pauses through `compute_pause` /
// `should_fire_noise_break` yet). The `dead_code` allow keeps the compiled-but-
// unused symbols quiet until the wiring lands (PORT/04_*.md).
//
// PORT IMPL — Sources:
//   - server/src/stt_server/text_processing.py  (the dynamic-silence formula)
//   - server/src/recorder/infrastructure/distilbert_classifier.py  (classifier)
//   - server/src/recorder/application/pipeline.py  (silence_endpoint_enabled gate)
//   - memory: project_ptt_silence_endpoint_sync_race, project_noise_break
//
// ============================================================================
// WHAT THIS MODULE IS
// ============================================================================
// Two cleanly-separable concerns:
//
//   (A) DYNAMIC-SILENCE ENDPOINT FORMULA — pure, deterministic arithmetic.
//       Ported FULLY to real Rust + unit tests. On every realtime-preview
//       update, this recomputes `post_speech_silence_duration` (the silence
//       window after which the recorder finalizes the utterance) from the live
//       preview text. Two paths: a classifier-driven "smart endpoint" and a
//       punctuation-heuristic fallback. Both are below.
//
//   (B) DistilBERT SENTENCE-COMPLETION CLASSIFIER — heavy ML. Ported as a
//       TRAIT + a fail-soft `NullClassifier` + acceptance tests for the
//       integration contract. A real `OnnxDistilbertClassifier` (ort +
//       tokenizers) is SPEC'd here but NOT speculatively implemented — see the
//       big SPEC block before `SentenceClassifier`.
//
// The endpoint formula CONSUMES the classifier through the trait, so (A) is
// fully testable against a fake classifier without any model.
//
// ============================================================================
// PARITY CONSTANTS (verbatim from the Python)
// ============================================================================
// SMART_ENDPOINT_MIN_PAUSE = 0.9   (hard floor on the computed pause)
// interpolate_detection(p) = clamp(1.0 - p, 0.0, 1.0)        (= model_pause)
// get_whisper_pause(text):  "..."->4.5  "."->0.4  "!"->0.3  "?"->0.2  else 1.8
// pause = (model_pause + whisper_pause) * detection_speed   then max(pause, 0.9)
//
// detection_speed default: EndpointConfig=1.5 but the RUNTIME value used in
// text_processing.py is ServerState.detection_speed = 2.0 (CLI-overridable).
// HIGHER detection_speed = LONGER pause. We default to 2.0 to match the live
// server, and expose it as a field so the host can override from settings.
//
// Heuristic-fallback pauses (state.py defaults, used when smart endpoint OFF):
//   mid_sentence_detection_pause     = 2.0
//   end_of_sentence_detection_pause  = 0.45
//   unknown_sentence_detection_pause = 1.3

/// Hard floor on the smart-endpoint computed pause. Whisper's realtime preview
/// almost always ends phrases with a period, which the classifier readily
/// scores "complete"; without a floor the window collapses to ~0.7 s and the
/// recording hard-stops mid-thought while the user just draws breath. 0.9 s is
/// RealtimeSTT's own natural minimum for a confidently-complete sentence at
/// detection_speed=2.0: ((1-0.95) + 0.4) * 2.0 ≈ 0.9.
pub const SMART_ENDPOINT_MIN_PAUSE: f32 = 0.9;

/// Trailing-punctuation -> pause(seconds) table. Public so tests / callers can
/// assert parity.
pub fn get_whisper_pause(text: &str) -> f32 {
    // Order matters: "..." must be tested before "." (a string ending in "..."
    // also ends in ".").
    if text.ends_with("...") {
        return 4.5;
    }
    if text.ends_with('.') {
        return 0.4;
    }
    if text.ends_with('!') {
        return 0.3;
    }
    if text.ends_with('?') {
        return 0.2;
    }
    1.8
}

/// Linear interpolation of the classifier probability into a "model pause":
/// prob 0.0 -> 1.0 s, prob 1.0 -> 0.0 s, clamped to [0, 1].
pub fn interpolate_detection(prob: f32) -> f32 {
    (1.0 - prob).clamp(0.0, 1.0)
}

/// Heuristic-fallback pauses (used when the smart-endpoint classifier is off or
/// unavailable). Defaults mirror `ServerState` (state.py).
#[derive(Debug, Clone, Copy)]
pub struct HeuristicPauses {
    pub mid_sentence: f32,
    pub end_of_sentence: f32,
    pub unknown: f32,
}

impl Default for HeuristicPauses {
    fn default() -> Self {
        Self {
            mid_sentence: 2.0,
            end_of_sentence: 0.45,
            unknown: 1.3,
        }
    }
}

/// East-Asian full stop (U+3002) is treated as a sentence end alongside `.!?`,
/// matching `sentence_end()` in text_processing.py.
const IDEOGRAPHIC_FULL_STOP: char = '\u{3002}';

fn ends_with_ellipsis(t: &str) -> bool {
    if t.ends_with("...") {
        return true;
    }
    // Python: len(t) > 1 and t[:-1].endswith("...") — i.e. "...X" where the
    // last char is a single trailing token after the ellipsis (e.g. "...'").
    if t.chars().count() <= 1 {
        return false;
    }
    // Drop the final char and test for a trailing "...".
    let mut without_last = t.to_string();
    without_last.pop();
    without_last.ends_with("...")
}

fn sentence_end(t: &str) -> bool {
    match t.chars().last() {
        Some(c) => c == '.' || c == '!' || c == '?' || c == IDEOGRAPHIC_FULL_STOP,
        None => false,
    }
}

/// Heuristic post-speech-silence pause given the current and previous preview
/// text. Mirrors the `else` branch of `text_detected()` in text_processing.py.
///
///   - ellipsis-terminated      -> mid_sentence (wait, user is mid-thought)
///   - sentence_end now AND prev sentence_end AND prev NOT ellipsis -> end_of_sentence
///   - otherwise                -> unknown
pub fn heuristic_pause(text: &str, prev_text: &str, p: &HeuristicPauses) -> f32 {
    if ends_with_ellipsis(text) {
        return p.mid_sentence;
    }
    if sentence_end(text) && sentence_end(prev_text) && !ends_with_ellipsis(prev_text) {
        return p.end_of_sentence;
    }
    p.unknown
}

// ============================================================================
// (B) SENTENCE-COMPLETION CLASSIFIER
// ============================================================================
//
// SPEC — OnnxDistilbertClassifier (NOT implemented here; build during the
// compile loop, behind this trait):
//
//   Model: `KoljaB/SentenceFinishedClassification` (DistilBERT for sequence
//   classification, 2 classes; class 1 = "complete sentence").
//
//   ⚠️ DISTRIBUTION GAP: the KoljaB HF repo ships ONLY PyTorch weights
//   (`pytorch_model.bin` / safetensors) + the tokenizer — it has NO
//   `model.onnx`. The Python server reaches it via `transformers` + `torch`
//   (the single optional torch dependency, `[sentence-classifier]` extra). A
//   pure-Rust ort path CANNOT load it as-is. Required ONE-TIME offline export:
//       optimum-cli export onnx \
//         --model KoljaB/SentenceFinishedClassification \
//         --task text-classification distilbert-sentence-finished-onnx/
//   then vendor/host `model.onnx` (+ `tokenizer.json`, `config.json`) as a
//   downloadable asset (mirror the WinSTT TTS-pack distribution pattern:
//   dahshury/winstt-assets, public repo — see memory:
//   project_private_repo_breaks_pack_distribution). This is a prerequisite,
//   tracked in PORT/04_*.md. Until the export exists, ship `NullClassifier`
//   (smart endpoint silently falls back to the heuristic path — exactly what
//   the Python does when transformers isn't installed).
//
//   Runtime (Rust):
//     - Tokenizer: `tokenizers` crate, load `tokenizer.json` (the fast
//       DistilBERT WordPiece tokenizer). Encode with truncation max_length=128.
//       Produce input_ids (i64) + attention_mask (i64).
//     - Session: `ort` InferenceSession on CPU (this is a tiny model; no need
//       for DirectML, and it dodges every DML-incompatible-family concern).
//     - Inputs: {"input_ids": [1,L] i64, "attention_mask": [1,L] i64}.
//       (DistilBERT has NO token_type_ids.)
//     - Output: logits [1, 2] f32. softmax; return probs[0][1] (P[complete]).
//     - Preprocess: strip trailing non-alpha (regex `[^a-zA-Z]+$`) BEFORE
//       tokenizing — matches `_TRAILING_NON_ALPHA`. Empty after strip -> 0.0.
//     - Cache: LRU(maxsize=512) keyed on the cleaned string (the Python uses
//       functools.lru_cache). Optional but matches latency profile.
//     - Fail-soft: any load/inference error -> `is_available()=false`,
//       `classify()=0.0` (NEVER panic — endpointing must degrade to heuristic).
//
//   ACCEPTANCE (must hold once implemented):
//     1. classify("The sky is blue.") > classify("When the sky")   (complete > partial)
//     2. classify("") == 0.0 and classify("...") == 0.0            (empty-after-strip)
//     3. is_available() == false after a load failure; classify() == 0.0 then.
//     4. trailing punctuation/whitespace does not change the result vs. the
//        same text without it (because of the strip): classify("Hi.") ==
//        classify("Hi") (both clean to "Hi").
//
// The strip + empty-guard are PURE and ARE implemented + tested below
// (`clean_for_classification`) so the eventual ONNX impl can reuse them and the
// acceptance items (2) and (4) are already locked.

/// Probability that `text` is a complete sentence, in [0, 1]. Returns 0.0 when
/// the classifier is unavailable (fail-soft).
pub trait SentenceClassifier {
    fn classify(&self, text: &str) -> f32;
    fn is_available(&self) -> bool;
}

/// Strip trailing non-ASCII-alpha characters for cleaner classification.
/// Mirrors `_TRAILING_NON_ALPHA = re.compile(r"[^a-zA-Z]+$")` then `.strip()`.
/// Returns the cleaned string; empty string means "nothing to classify".
pub fn clean_for_classification(text: &str) -> String {
    let trimmed = text.trim();
    // Drop a trailing run of non-[a-zA-Z] characters.
    let end = trimmed
        .char_indices()
        .rev()
        .find(|&(_, c)| c.is_ascii_alphabetic())
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    trimmed[..end].to_string()
}

/// Always-unavailable classifier. Ship this until the ONNX export exists; the
/// smart-endpoint path falls back to the heuristic, exactly like the Python
/// server with `transformers` absent.
#[derive(Debug, Default, Clone, Copy)]
pub struct NullClassifier;

impl SentenceClassifier for NullClassifier {
    fn classify(&self, _text: &str) -> f32 {
        0.0
    }
    fn is_available(&self) -> bool {
        false
    }
}

// ============================================================================
// (A) THE ENDPOINT CONTROLLER (ties formula + classifier + gating together)
// ============================================================================

/// Configuration for the dynamic-silence endpoint. Maps to WinSTT settings.
#[derive(Debug, Clone, Copy)]
pub struct EndpointConfig {
    /// Master "the server may auto-end the recording" switch. PTT and
    /// toggle+manualToggleStop set this FALSE so ONLY the user's hotkey defines
    /// the boundary. When false, `compute_pause` returns `None` (don't touch
    /// `post_speech_silence_duration`) AND the noise-break must be suppressed
    /// (handled by the caller — see `NoiseBreak`). See memory:
    /// project_ptt_silence_endpoint_sync_race.
    pub silence_endpoint_enabled: bool,
    /// Whether the classifier-driven smart endpoint is on. Maps to
    /// `quality.smartEndpoint` -> server `silence_timing`/`smart_endpoint`.
    pub smart_endpoint_enabled: bool,
    /// HIGHER = LONGER pause. Runtime default 2.0 (ServerState), NOT 1.5
    /// (EndpointConfig) — we match the live server.
    pub detection_speed: f32,
    /// Heuristic fallback pauses.
    pub heuristic: HeuristicPauses,
}

impl Default for EndpointConfig {
    fn default() -> Self {
        Self {
            silence_endpoint_enabled: true,
            smart_endpoint_enabled: false,
            detection_speed: 2.0,
            heuristic: HeuristicPauses::default(),
        }
    }
}

/// Computes the post-speech-silence pause for the current preview tick.
///
/// `classifier` is consulted only on the smart-endpoint path AND only when it
/// reports `is_available()`. `prev_text` is the previous preview text (for the
/// heuristic two-sentence-end rule). Returns:
///   - `None`  -> do NOT change `post_speech_silence_duration` (auto-stop is
///                disabled for this mode; PTT/manual-toggle own the boundary).
///   - `Some(s)` -> set `recorder.post_speech_silence_duration = s`.
pub fn compute_pause<C: SentenceClassifier + ?Sized>(
    cfg: &EndpointConfig,
    classifier: &C,
    text: &str,
    prev_text: &str,
) -> Option<f32> {
    if !cfg.silence_endpoint_enabled {
        // PTT / manual-toggle: leave the (long, hold-time) pause untouched.
        return None;
    }
    if cfg.smart_endpoint_enabled && classifier.is_available() {
        let prob = classifier.classify(text);
        let model_pause = interpolate_detection(prob);
        let whisper_pause = get_whisper_pause(text);
        let pause = (model_pause + whisper_pause) * cfg.detection_speed;
        return Some(pause.max(SMART_ENDPOINT_MIN_PAUSE));
    }
    Some(heuristic_pause(text, prev_text, &cfg.heuristic))
}

// ============================================================================
// NOISE-BREAK (suffix-repetition stuck-transcription guard)
// ============================================================================
//
// Source: text_processing.py `text_detected()` repetition block + state.py
// defaults + memory: project_noise_break, project_ptt_silence_endpoint_sync_race.
//
// When the realtime model gets STUCK (hallucinates a repeating tail), force-stop
// the recording. Gates (ALL must pass to FIRE):
//   1. >= min_texts preview updates within `window_seconds`.
//   2. trailing-`tail_len`-chars similarity(first, last) > min_similarity.
//   3. len(first_text) > min_chars.
//   4. silence_endpoint_enabled (MASTER gate) — suppressed for PTT/manual-toggle
//      so holding PTT through silence can't trigger a mid-hold paste.
//   5. recent audio variance <= variance_threshold — if the user is still
//      audibly speaking (high RMS variance), it's Whisper hallucinating at low
//      SNR, NOT a stuck session; suppress so real speech isn't truncated.
//
// The similarity metric and the audio-variance computation are stateful/IO in
// the Python; here we expose the PURE DECISION (`should_fire`) given already-
// computed inputs, plus the constants. Wiring (collecting preview texts + audio
// levels) is the recorder pipeline's job — see 04_*.md.

/// Defaults mirror `ServerState` (state.py).
#[derive(Debug, Clone, Copy)]
pub struct NoiseBreakConfig {
    pub window_seconds: f32,
    pub min_texts: usize,
    pub min_similarity: f32,
    pub min_chars: usize,
    pub variance_threshold: f32,
}

impl Default for NoiseBreakConfig {
    fn default() -> Self {
        Self {
            window_seconds: 3.0,
            min_texts: 3,
            min_similarity: 0.99,
            min_chars: 15,
            variance_threshold: 0.025,
        }
    }
}

/// Inputs to the noise-break decision, pre-computed by the caller for the
/// current window. `first_text`/`last_text` are the oldest/newest preview texts
/// in the rolling window; `texts_in_window` is the count; `similarity` is the
/// trailing-tail SequenceMatcher ratio; `audio_variance` is the std-dev of
/// recent audio levels (0.0 when fewer than 2 samples -> treated as "no signal",
/// which does NOT suppress).
#[derive(Debug, Clone, Copy)]
pub struct NoiseBreakInput<'a> {
    pub silence_endpoint_enabled: bool,
    pub texts_in_window: usize,
    pub first_text: &'a str,
    pub similarity: f32,
    pub audio_variance: f32,
}

/// Pure decision: should the recorder be force-stopped for stuck transcription?
pub fn should_fire_noise_break(cfg: &NoiseBreakConfig, input: &NoiseBreakInput<'_>) -> bool {
    if input.texts_in_window < cfg.min_texts {
        return false;
    }
    // similarity + length gates (text_processing.py).
    let first_len = input.first_text.chars().count();
    if !(input.similarity > cfg.min_similarity && first_len > cfg.min_chars) {
        return false;
    }
    // MASTER gate: PTT / manual-toggle suppress auto-stop entirely.
    if !input.silence_endpoint_enabled {
        return false;
    }
    // Audio-variance gate: still-active audio => Whisper hallucinating, suppress.
    if input.audio_variance > cfg.variance_threshold {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    // ---- whisper_pause table ----
    #[test]
    fn whisper_pause_table() {
        assert!(approx(get_whisper_pause("I was thinking..."), 4.5));
        assert!(approx(get_whisper_pause("The sky is blue."), 0.4));
        assert!(approx(get_whisper_pause("Wow!"), 0.3));
        assert!(approx(get_whisper_pause("Really?"), 0.2));
        assert!(approx(get_whisper_pause("When the sky"), 1.8));
        assert!(approx(get_whisper_pause(""), 1.8));
    }

    #[test]
    fn whisper_pause_ellipsis_beats_period() {
        // "..." ends with "." too; ellipsis branch must win.
        assert!(approx(get_whisper_pause("hmm..."), 4.5));
    }

    // ---- interpolate_detection ----
    #[test]
    fn interpolate_detection_endpoints_and_clamp() {
        assert!(approx(interpolate_detection(0.0), 1.0));
        assert!(approx(interpolate_detection(1.0), 0.0));
        assert!(approx(interpolate_detection(0.5), 0.5));
        assert!(approx(interpolate_detection(1.5), 0.0)); // clamp low
        assert!(approx(interpolate_detection(-0.5), 1.0)); // clamp high
    }

    // ---- smart-endpoint formula ----
    struct FixedClassifier {
        prob: f32,
        available: bool,
    }
    impl SentenceClassifier for FixedClassifier {
        fn classify(&self, _t: &str) -> f32 {
            self.prob
        }
        fn is_available(&self) -> bool {
            self.available
        }
    }

    #[test]
    fn smart_pause_formula_and_floor() {
        let cfg = EndpointConfig {
            smart_endpoint_enabled: true,
            detection_speed: 2.0,
            ..Default::default()
        };
        // Confident-complete period sentence: prob=0.95 -> model=0.05,
        // whisper=0.4 -> (0.45)*2.0 = 0.9 == floor.
        let clf = FixedClassifier {
            prob: 0.95,
            available: true,
        };
        let p = compute_pause(&cfg, &clf, "The sky is blue.", "").unwrap();
        assert!(approx(p, 0.9));

        // Partial mid-phrase: prob=0.1 -> model=0.9, whisper=1.8 ->
        // (2.7)*2.0 = 5.4 (well above floor).
        let clf2 = FixedClassifier {
            prob: 0.1,
            available: true,
        };
        let p2 = compute_pause(&cfg, &clf2, "When the sky", "").unwrap();
        assert!(approx(p2, 5.4));
    }

    #[test]
    fn smart_pause_floor_enforced() {
        let cfg = EndpointConfig {
            smart_endpoint_enabled: true,
            detection_speed: 1.0, // low speed to drive pause under the floor
            ..Default::default()
        };
        // prob=1.0 -> model=0.0, whisper("?")=0.2 -> 0.2*1.0 = 0.2 -> floored to 0.9.
        let clf = FixedClassifier {
            prob: 1.0,
            available: true,
        };
        let p = compute_pause(&cfg, &clf, "Really?", "").unwrap();
        assert!(approx(p, SMART_ENDPOINT_MIN_PAUSE));
    }

    #[test]
    fn smart_falls_back_to_heuristic_when_classifier_unavailable() {
        let cfg = EndpointConfig {
            smart_endpoint_enabled: true,
            ..Default::default()
        };
        // Classifier off -> heuristic path. "blah" no sentence end -> unknown=1.3.
        let p = compute_pause(&cfg, &NullClassifier, "blah", "").unwrap();
        assert!(approx(p, 1.3));
    }

    // ---- heuristic fallback ----
    #[test]
    fn heuristic_ellipsis_is_mid_sentence() {
        let p = HeuristicPauses::default();
        assert!(approx(heuristic_pause("I think...", "anything", &p), 2.0));
        // "...'" form (ellipsis + one trailing token).
        assert!(approx(heuristic_pause("wait...'", "x", &p), 2.0));
    }

    #[test]
    fn heuristic_two_sentence_ends_is_end_of_sentence() {
        let p = HeuristicPauses::default();
        // both end in sentence punctuation, prev not ellipsis -> 0.45.
        assert!(approx(heuristic_pause("Done.", "Hello.", &p), 0.45));
        // ideographic full stop counts.
        assert!(approx(heuristic_pause("好。", "你好。", &p), 0.45));
    }

    #[test]
    fn heuristic_prev_ellipsis_blocks_end_of_sentence() {
        let p = HeuristicPauses::default();
        // prev IS ellipsis -> the end-of-sentence branch is blocked -> unknown.
        assert!(approx(heuristic_pause("Done.", "wait...", &p), 1.3));
    }

    #[test]
    fn heuristic_unknown_default() {
        let p = HeuristicPauses::default();
        // current has no sentence end -> unknown (1.3).
        assert!(approx(heuristic_pause("still going", "Hello.", &p), 1.3));
        // current ends sentence but prev does not -> unknown.
        assert!(approx(heuristic_pause("Done.", "still going", &p), 1.3));
    }

    // ---- silence_endpoint_enabled gating ----
    #[test]
    fn ptt_disabled_returns_none() {
        let cfg = EndpointConfig {
            silence_endpoint_enabled: false,
            smart_endpoint_enabled: true,
            ..Default::default()
        };
        // PTT: never touch post_speech_silence_duration.
        let clf = FixedClassifier {
            prob: 0.9,
            available: true,
        };
        assert!(compute_pause(&cfg, &clf, "Done.", "").is_none());
        assert!(compute_pause(&cfg, &NullClassifier, "Done.", "").is_none());
    }

    // ---- classifier cleaning (acceptance items 2 + 4 pre-locked) ----
    #[test]
    fn clean_strips_trailing_non_alpha() {
        assert_eq!(clean_for_classification("Hi."), "Hi");
        assert_eq!(clean_for_classification("Hi"), "Hi");
        assert_eq!(clean_for_classification("Hello, world!!! "), "Hello, world");
        assert_eq!(clean_for_classification("  spaced  "), "spaced");
    }

    #[test]
    fn clean_empty_and_all_punct() {
        assert_eq!(clean_for_classification(""), "");
        assert_eq!(clean_for_classification("..."), "");
        assert_eq!(clean_for_classification("123!?."), "");
    }

    #[test]
    fn null_classifier_is_failsoft() {
        assert_eq!(NullClassifier.classify("anything"), 0.0);
        assert!(!NullClassifier.is_available());
    }

    // ---- noise-break decision ----
    #[test]
    fn noise_break_fires_on_stuck_session() {
        let cfg = NoiseBreakConfig::default();
        let input = NoiseBreakInput {
            silence_endpoint_enabled: true,
            texts_in_window: 3,
            first_text: "this is a long enough stuck phrase",
            similarity: 0.995,
            audio_variance: 0.001, // flat -> stuck
        };
        assert!(should_fire_noise_break(&cfg, &input));
    }

    #[test]
    fn noise_break_suppressed_when_endpoint_disabled() {
        let cfg = NoiseBreakConfig::default();
        let input = NoiseBreakInput {
            silence_endpoint_enabled: false, // PTT
            texts_in_window: 5,
            first_text: "this is a long enough stuck phrase",
            similarity: 0.999,
            audio_variance: 0.0,
        };
        assert!(!should_fire_noise_break(&cfg, &input));
    }

    #[test]
    fn noise_break_suppressed_when_audio_still_active() {
        let cfg = NoiseBreakConfig::default();
        let input = NoiseBreakInput {
            silence_endpoint_enabled: true,
            texts_in_window: 4,
            first_text: "this is a long enough stuck phrase",
            similarity: 0.999,
            audio_variance: 0.05, // > 0.025 -> user still speaking
        };
        assert!(!should_fire_noise_break(&cfg, &input));
    }

    #[test]
    fn noise_break_needs_min_texts_and_length_and_similarity() {
        let cfg = NoiseBreakConfig::default();
        let base = NoiseBreakInput {
            silence_endpoint_enabled: true,
            texts_in_window: 3,
            first_text: "this is a long enough stuck phrase",
            similarity: 0.999,
            audio_variance: 0.0,
        };
        // too few texts
        let mut a = base;
        a.texts_in_window = 2;
        assert!(!should_fire_noise_break(&cfg, &a));
        // too low similarity
        let mut b = base;
        b.similarity = 0.5;
        assert!(!should_fire_noise_break(&cfg, &b));
        // too short first_text (<= 15 chars)
        let mut c = base;
        c.first_text = "short";
        assert!(!should_fire_noise_break(&cfg, &c));
    }
}
