use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;

// --- catalog invariants ---

#[test]
fn catalog_has_54_voices() {
    assert_eq!(KOKORO_VOICE_CATALOG.len(), 54);
}

#[test]
fn catalog_has_9_languages() {
    assert_eq!(SUPPORTED_LANGUAGES.len(), 9);
}

#[test]
fn every_catalog_language_is_in_supported_languages() {
    let supported: std::collections::HashSet<&str> =
        SUPPORTED_LANGUAGES.iter().map(|(c, _)| *c).collect();
    for v in KOKORO_VOICE_CATALOG {
        assert!(
            supported.contains(v.language),
            "voice {} has unlisted language {}",
            v.id,
            v.language
        );
    }
}

#[test]
fn every_supported_language_has_at_least_one_voice() {
    for (code, _) in SUPPORTED_LANGUAGES {
        assert!(
            KOKORO_VOICE_CATALOG.iter().any(|v| v.language == *code),
            "language {code} has no voices"
        );
    }
}

#[test]
fn voice_ids_are_unique() {
    let mut seen = std::collections::HashSet::new();
    for v in KOKORO_VOICE_CATALOG {
        assert!(seen.insert(v.id), "duplicate voice id {}", v.id);
    }
}

#[test]
fn default_voice_exists() {
    assert!(voice_by_id("af_heart").is_some());
}

#[test]
fn per_language_counts_match_winstt() {
    let expected = [
        ("en-us", 20),
        ("en-gb", 8),
        ("ja", 5),
        ("cmn", 8),
        ("es", 3),
        ("fr", 1),
        ("hi", 4),
        ("it", 2),
        ("pt-br", 3),
    ];
    for (lang, count) in expected {
        assert_eq!(
            voices_for_language(lang).len(),
            count,
            "language {lang} count mismatch"
        );
    }
}

// --- speed clamps ---

#[test]
fn local_speed_clamps_to_0_5_2_0() {
    assert_eq!(clamp_speed(0.1), 0.5);
    assert_eq!(clamp_speed(1.0), 1.0);
    assert_eq!(clamp_speed(3.0), 2.0);
}

#[test]
fn cloud_speed_clamps_to_0_7_1_2() {
    assert_eq!(clamp_cloud_speed(0.1), 0.7);
    assert_eq!(clamp_cloud_speed(1.0), 1.0);
    assert_eq!(clamp_cloud_speed(5.0), 1.2);
}

#[test]
fn clamp_speed_to_range_uses_active_engine_floor() {
    // Supertonic's 0.4 floor must be reachable (the bug: a generic 0.5 floor
    // pre-clipped it). Non-finite collapses to 1.0.
    assert_eq!(clamp_speed_to_range(0.4, (0.4, 1.3)), 0.4);
    assert_eq!(clamp_speed_to_range(0.1, (0.4, 1.3)), 0.4);
    assert_eq!(clamp_speed_to_range(2.0, (0.4, 1.3)), 1.3);
    assert_eq!(clamp_speed_to_range(f32::NAN, (0.4, 1.3)), 1.0);
    // Generic local range still clamps 0.5..2.0.
    assert_eq!(clamp_speed_to_range(0.1, (0.5, 2.0)), 0.5);
}

// --- sentence splitter parity with tts-reader.ts ---

#[test]
fn split_blank_is_empty() {
    assert!(split_sentences("", DEFAULT_MAX_SENTENCE_LEN).is_empty());
    assert!(split_sentences("   \n  ", DEFAULT_MAX_SENTENCE_LEN).is_empty());
}

#[test]
fn split_three_sentences() {
    let out = split_sentences(
        "Hello there. How are you? I am fine!",
        DEFAULT_MAX_SENTENCE_LEN,
    );
    assert_eq!(out, vec!["Hello there.", "How are you?", "I am fine!"]);
}

#[test]
fn split_keeps_trailing_unterminated_run() {
    let out = split_sentences("First. Then this", DEFAULT_MAX_SENTENCE_LEN);
    assert_eq!(out, vec!["First.", "Then this"]);
}

#[test]
fn split_consumes_trailing_quote_after_terminator() {
    let out = split_sentences("He said \"hi.\" Then left.", DEFAULT_MAX_SENTENCE_LEN);
    assert_eq!(out, vec!["He said \"hi.\"", "Then left."]);
}

#[test]
fn split_collapses_multiple_terminators() {
    let out = split_sentences("Wait?! Really.", DEFAULT_MAX_SENTENCE_LEN);
    assert_eq!(out, vec!["Wait?!", "Really."]);
}

#[test]
fn split_caps_overlong_sentence_on_word_boundary() {
    let long = "abcdefghi ".repeat(10);
    let out = split_sentences(long.trim(), 20);
    assert!(out.len() > 1);
    for chunk in &out {
        assert!(chunk.chars().count() <= 20, "chunk too long: {chunk:?}");
    }
}

#[test]
fn split_hard_splits_single_overlong_word() {
    let word = "x".repeat(50);
    let out = split_sentences(&word, 20);
    assert_eq!(out.len(), 3);
    assert_eq!(out[0].chars().count(), 20);
    assert_eq!(out[2].chars().count(), 10);
}

#[test]
fn split_no_terminator_returns_whole() {
    let out = split_sentences("just a plain phrase", DEFAULT_MAX_SENTENCE_LEN);
    assert_eq!(out, vec!["just a plain phrase"]);
}

// --- cloud request builder + classifier + parsers ---

#[test]
fn cloud_url_includes_voice_and_safe_format() {
    let url = build_cloud_url("voice123");
    assert!(url.contains("/voice123?"));
    assert!(url.contains("output_format=mp3_44100_128"));
}

#[test]
fn cloud_body_maps_snake_case_and_clamps_speed() {
    let req = CloudSynthesisRequest {
        api_key: "k".into(),
        voice_id: "v".into(),
        model_id: "eleven_multilingual_v2".into(),
        text: "hi".into(),
        settings: CloudVoiceSettings {
            stability: 0.5,
            similarity: 0.75,
            style: 0.1,
            speaker_boost: true,
            speed: 5.0,
        },
    };
    let body = build_cloud_body(&req);
    assert_eq!(body["text"], "hi");
    assert_eq!(body["model_id"], "eleven_multilingual_v2");
    let vs = &body["voice_settings"];
    assert_eq!(vs["similarity_boost"], 0.75);
    assert_eq!(vs["use_speaker_boost"], true);
    // f32 1.2 serializes as 1.2000000476837158 in JSON — compare with tolerance.
    assert!(
        (vs["speed"].as_f64().unwrap() - 1.2).abs() < 1e-4,
        "speed ~1.2, got {}",
        vs["speed"]
    );
}

#[test]
fn cloud_status_classification_by_http() {
    assert!(classify_cloud_status(401, None).contains("invalid API key"));
    assert!(classify_cloud_status(402, None).contains("paid plan"));
    assert!(classify_cloud_status(429, None).contains("rate limited"));
    assert!(classify_cloud_status(500, None).contains("HTTP 500"));
}

#[test]
fn cloud_status_classification_prefers_detail_status() {
    // a scoped key missing voices_read 401s with missing_permissions — NOT invalid
    assert!(classify_cloud_status(401, Some("missing_permissions"))
        .contains("missing a required permission"));
    assert!(classify_cloud_status(402, Some("quota_exceeded")).contains("quota exceeded"));
    assert!(classify_cloud_status(404, Some("voice_not_found")).contains("voice not found"));
}

#[test]
fn parse_detail_status_reads_nested_field() {
    let body = r#"{"detail":{"status":"quota_exceeded","message":"over quota"}}"#;
    assert_eq!(parse_detail_status(body).as_deref(), Some("quota_exceeded"));
    // string-form detail → no status
    assert_eq!(parse_detail_status(r#"{"detail":"oops"}"#), None);
    assert_eq!(parse_detail_status("not json"), None);
}

#[test]
fn parse_cloud_voices_maps_fields() {
    let body = r#"{"voices":[
            {"voice_id":"abc","name":"Rachel","category":"premade",
             "labels":{"language":"en"},"preview_url":"https://cdn/x.mp3"},
            {"voice_id":"def","name":"Custom"}
        ]}"#;
    let voices = parse_cloud_voices(body);
    assert_eq!(voices.len(), 2);
    assert_eq!(voices[0].id, "abc");
    assert_eq!(voices[0].name, "Rachel");
    assert_eq!(voices[0].language.as_deref(), Some("en"));
    assert_eq!(voices[0].preview_url.as_deref(), Some("https://cdn/x.mp3"));
    assert_eq!(voices[1].id, "def");
    assert!(voices[1].language.is_none());
}

#[test]
fn parse_cloud_voices_handles_garbage() {
    assert!(parse_cloud_voices("not json").is_empty());
    assert!(parse_cloud_voices("{}").is_empty());
}

// --- cloud engine guards ---

#[test]
fn cloud_engine_rejects_missing_key_and_voice() {
    let eng = ElevenLabsEngine::new(String::new(), "m".into(), CloudVoiceSettings::default());
    assert!(matches!(
        eng.synthesize_sentence("hi", "v", "en", 1.0),
        Err(TtsError::Cloud(_))
    ));
    let eng2 = ElevenLabsEngine::new("key".into(), "m".into(), CloudVoiceSettings::default());
    assert!(matches!(
        eng2.synthesize_sentence("hi", "", "en", 1.0),
        Err(TtsError::Cloud(_))
    ));
}

#[test]
fn cloud_engine_refuses_non_https_preview() {
    let eng = ElevenLabsEngine::new("key".into(), "m".into(), CloudVoiceSettings::default());
    assert!(matches!(
        eng.fetch_preview("http://insecure/x.mp3"),
        Err(TtsError::Cloud(_))
    ));
}

#[test]
fn cloud_engine_is_ready_only_with_key() {
    assert!(
        !ElevenLabsEngine::new(String::new(), "m".into(), CloudVoiceSettings::default()).is_ready()
    );
    assert!(
        ElevenLabsEngine::new("k".into(), "m".into(), CloudVoiceSettings::default()).is_ready()
    );
}

// --- streaming sequencing (fake engine, no ort/network) ---

/// A fake engine that returns one short f32 buffer per non-empty sentence.
struct FakeEngine {
    calls: StdMutex<Vec<String>>,
}
impl FakeEngine {
    fn new() -> Self {
        Self {
            calls: StdMutex::new(Vec::new()),
        }
    }
}
impl TtsEngine for FakeEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        _v: &str,
        _l: &str,
        _s: f32,
    ) -> TtsResult<SentenceAudio> {
        self.calls.lock().unwrap().push(text.to_string());
        Ok(SentenceAudio::F32le {
            samples: vec![0.1, 0.2, 0.3],
            sample_rate: KOKORO_SAMPLE_RATE,
        })
    }
    fn list_voices(&self) -> Vec<VoiceInfo> {
        KOKORO_VOICE_CATALOG.to_vec()
    }
    fn is_ready(&self) -> bool {
        true
    }
    fn warm_up(&self) -> TtsResult<()> {
        Ok(())
    }
    fn shutdown(&self) {}
}

struct CollectSink {
    chunks: StdMutex<Vec<SynthesisChunk>>,
    cancel: AtomicBool,
}
impl CollectSink {
    fn new() -> Self {
        Self {
            chunks: StdMutex::new(Vec::new()),
            cancel: AtomicBool::new(false),
        }
    }
}
impl ChunkSink for CollectSink {
    fn push(&self, chunk: SynthesisChunk) -> bool {
        self.chunks.lock().unwrap().push(chunk);
        true
    }
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }
}

#[test]
fn read_aloud_emits_one_chunk_per_sentence_with_final_flag() {
    let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
    let sink = CollectSink::new();
    mgr.read_aloud(
        "rq1",
        "One. Two. Three.",
        "af_heart",
        "en-us",
        || 1.0,
        &sink,
    )
    .unwrap();
    let chunks = sink.chunks.lock().unwrap();
    assert_eq!(chunks.len(), 3);
    // seq is monotonic 0,1,2
    assert_eq!(
        chunks.iter().map(|c| c.seq).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    // only the last is final
    assert!(!chunks[0].is_final);
    assert!(!chunks[1].is_final);
    assert!(chunks[2].is_final);
    // format + sample rate
    assert_eq!(chunks[0].format, Format::F32le);
    assert_eq!(chunks[0].sample_rate, KOKORO_SAMPLE_RATE);
}

#[test]
fn read_aloud_empty_text_is_noop() {
    let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
    let sink = CollectSink::new();
    mgr.read_aloud("rq", "   ", "af_heart", "en-us", || 1.0, &sink)
        .unwrap();
    assert!(sink.chunks.lock().unwrap().is_empty());
}

#[test]
fn read_aloud_cancel_between_sentences_returns_cancelled() {
    let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
    let sink = CollectSink::new();
    // cancel up front → first iteration sees it and bails before any synth
    mgr.cancel("rq");
    let res = mgr.read_aloud("rq", "One. Two.", "af_heart", "en-us", || 1.0, &sink);
    assert!(matches!(res, Err(TtsError::Cancelled)));
    assert!(sink.chunks.lock().unwrap().is_empty());
}

#[test]
fn read_aloud_sink_cancel_stops_production() {
    let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
    let sink = CollectSink::new();
    sink.cancel.store(true, Ordering::Release);
    let res = mgr.read_aloud("rq", "One. Two.", "af_heart", "en-us", || 1.0, &sink);
    assert!(matches!(res, Err(TtsError::Cancelled)));
}

#[test]
fn cancel_all_marks_inflight_requests() {
    let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
    mgr.cancel("a");
    mgr.cancel_all();
    assert!(mgr.is_cancelled("a"));
}

#[test]
fn next_request_id_is_unique_and_prefixed() {
    let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
    let a = mgr.next_request_id();
    let b = mgr.next_request_id();
    assert!(a.starts_with("tts-"));
    assert_ne!(a, b);
}

// --- emitter bridge ---

struct RecordingEmitter {
    chunks: StdMutex<Vec<TtsChunkPayload>>,
    lifecycle: StdMutex<Vec<(String, serde_json::Value)>>,
}
impl RecordingEmitter {
    fn new() -> Self {
        Self {
            chunks: StdMutex::new(Vec::new()),
            lifecycle: StdMutex::new(Vec::new()),
        }
    }
}
impl TtsEventEmitter for RecordingEmitter {
    fn emit_chunk(&self, payload: &TtsChunkPayload) {
        self.chunks.lock().unwrap().push(payload.clone());
    }
    fn emit_lifecycle(&self, event: &str, payload: serde_json::Value) {
        self.lifecycle
            .lock()
            .unwrap()
            .push((event.to_string(), payload));
    }
}

#[test]
fn read_aloud_emit_fires_started_chunks_and_completed() {
    let mgr = TtsManager::new(TtsSource::Local, Arc::new(FakeEngine::new()));
    let emitter = RecordingEmitter::new();
    mgr.read_aloud_emit("rq", "One. Two.", "af_heart", "en-us", || 1.0, &emitter);
    let chunks = emitter.chunks.lock().unwrap();
    assert_eq!(chunks.len(), 2);
    // f32le pcm bytes = 3 samples * 4 bytes
    assert_eq!(chunks[0].pcm.len(), 12);
    assert_eq!(chunks[0].format, "f32le");
    assert!(chunks[1].is_final);
    let life = emitter.lifecycle.lock().unwrap();
    assert_eq!(life[0].0, "tts://started");
    assert_eq!(life.last().unwrap().0, "tts://completed");
    assert_eq!(life.last().unwrap().1["cancelled"], false);
}

#[test]
fn tts_chunk_payload_packs_f32_little_endian() {
    let chunk = SynthesisChunk::f32le(vec![1.0, -1.0], KOKORO_SAMPLE_RATE, 0, true);
    let p = TtsChunkPayload::from_chunk("rq", &chunk);
    assert_eq!(p.pcm.len(), 8);
    // 1.0f32 LE = 00 00 80 3F
    assert_eq!(&p.pcm[0..4], &1.0f32.to_le_bytes());
    assert_eq!(&p.pcm[4..8], &(-1.0f32).to_le_bytes());
    assert!(p.is_final);
    assert_eq!(p.format, "f32le");
}

#[test]
fn error_category_mapping() {
    assert_eq!(
        tts_error_category(&TtsError::Download("x".into())),
        "NETWORK"
    );
    assert_eq!(tts_error_category(&TtsError::Engine("x".into())), "ENGINE");
    assert_eq!(tts_error_category(&TtsError::Cloud("x".into())), "CLOUD");
    assert_eq!(tts_error_category(&TtsError::Invalid("x".into())), "INPUT");
    assert_eq!(tts_error_category(&TtsError::Cancelled), "CANCELLED");
}
