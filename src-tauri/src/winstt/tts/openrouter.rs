use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::types::{
    clamp_cloud_speed, ChunkSink, SentenceAudio, SynthesisChunk, TtsEngine, TtsError, TtsResult,
    VoiceInfo,
};

// ---------------------------------------------------------------------------
// Cloud OpenRouter TTS engine (reqwest)
//
// OpenRouter exposes an OpenAI-compatible `POST /api/v1/audio/speech` that
// returns audio bytes (mp3) for a `{ model, input, voice, response_format }`
// body. It mirrors the ElevenLabs cloud engine (one-shot mp3 per sentence,
// raced against the cancel flag). Voices are per-model and come from the
// OpenRouter model catalog's `supported_voices` field. The key is the SHARED
// `llm.openrouterApiKey` (same as STT + LLM).
// ---------------------------------------------------------------------------

pub const OPENROUTER_SPEECH_URL: &str = "https://openrouter.ai/api/v1/audio/speech";
/// Default `response_format`: mp3 keeps parity with the ElevenLabs path (the
/// renderer decodes mp3 chunks). Models that reject mp3 (Gemini TTS) override
/// this via [`preferred_speech_format`] / the pcm fallback.
pub const OPENROUTER_TTS_FORMAT: &str = "mp3";

/// Build the JSON body for OpenRouter `POST /api/v1/audio/speech`. `format` is
/// the `response_format` the target model accepts. REAL CODE — tested.
pub fn build_openrouter_speech_body(
    model: &str,
    voice: &str,
    text: &str,
    speed: f32,
    format: &str,
) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": format,
        "speed": clamp_cloud_speed(speed),
    })
}

/// OpenRouter's `/audio/speech` is OpenAI-compatible and answers mp3 for almost
/// every speech model — EXCEPT Gemini TTS, which rejects mp3 (`HTTP 400`) and
/// only emits raw `audio/pcm`. Pick the format up front so the hot read path
/// doesn't eat a wasted 400 round-trip; unknown pcm-only models are still caught
/// by the [`speech_error_wants_pcm`] retry.
fn preferred_speech_format(model_id: &str) -> &'static str {
    if model_id.to_ascii_lowercase().contains("gemini") {
        "pcm"
    } else {
        OPENROUTER_TTS_FORMAT
    }
}

/// True when a `/audio/speech` failure really means "this model only speaks
/// PCM" — an unknown Gemini-like model the heuristic missed. The upstream
/// message (surfaced verbatim by [`classify_openrouter_speech_status`]) names
/// `pcm` + `response_format`, so a lowercase contains-check routes the one-shot
/// pcm retry instead of surfacing a dead-end error.
fn speech_error_wants_pcm(err: &TtsError) -> bool {
    matches!(err, TtsError::Cloud(msg) if {
        let m = msg.to_ascii_lowercase();
        m.contains("pcm") && m.contains("response_format")
    })
}

/// Pull `rate=`/`channels=` out of a `audio/pcm; rate=24000; channels=1`
/// content-type. Defaults to 24 kHz mono — Gemini/OpenAI PCM's standard shape —
/// when a parameter is absent. REAL CODE — tested.
pub fn parse_pcm_params(content_type: &str) -> (u32, u16) {
    let mut rate = 24_000u32;
    let mut channels = 1u16;
    for part in content_type.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix("rate=") {
            if let Ok(n) = v.trim().parse::<u32>() {
                if n > 0 {
                    rate = n;
                }
            }
        } else if let Some(v) = part.strip_prefix("channels=") {
            if let Ok(n) = v.trim().parse::<u16>() {
                if n > 0 {
                    channels = n;
                }
            }
        }
    }
    (rate, channels)
}

/// Prepend a 44-byte canonical WAV header to raw little-endian s16 PCM. The
/// renderer plays cloud audio by handing the bytes to Web Audio's
/// `decodeAudioData`, which rejects HEADERLESS PCM — so Gemini's raw `audio/pcm`
/// must be wrapped before it can ride the same "encoded container" chunk path
/// the mp3 providers use. REAL CODE — tested.
pub fn pcm_s16le_to_wav(pcm: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    const BITS_PER_SAMPLE: u16 = 16;
    let block_align = channels * (BITS_PER_SAMPLE / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    let data_len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // audio format = PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// Normalize a `/audio/speech` response into bytes the renderer can decode: an
/// encoded container (mp3/wav) passes through untouched, while raw `audio/pcm`
/// (Gemini TTS) is wrapped in a WAV header. The result always rides a
/// `SynthesisChunk::mp3` "encoded container" chunk. REAL CODE — tested.
pub fn normalize_speech_audio(bytes: Vec<u8>, content_type: &str) -> Vec<u8> {
    let ct = content_type.to_ascii_lowercase();
    if ct.starts_with("audio/pcm") || ct.starts_with("audio/l16") {
        let (rate, channels) = parse_pcm_params(&ct);
        return pcm_s16le_to_wav(&bytes, rate, channels);
    }
    bytes
}

/// Human-readable reason for a failed `/audio/speech` call. OpenRouter error
/// bodies are `{"error":{"message","code"}}`. REAL CODE — tested.
pub fn classify_openrouter_speech_status(status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(str::to_string)
        });
    match (status, msg) {
        (401 | 403, _) => "OpenRouter: invalid API key".to_string(),
        (429, _) => "OpenRouter: rate limited".to_string(),
        (_, Some(m)) => format!("OpenRouter speech: {m}"),
        (s, None) => format!("OpenRouter speech error: HTTP {s}"),
    }
}

pub struct OpenRouterTtsEngine {
    client: reqwest::Client,
    api_key: String,
    model_id: String,
    ready: AtomicBool,
}

impl OpenRouterTtsEngine {
    pub fn new(api_key: String, model_id: String) -> Self {
        let ready = AtomicBool::new(!api_key.is_empty());
        Self {
            client: reqwest::Client::new(),
            api_key,
            model_id,
            ready,
        }
    }

    /// Validate the per-call inputs. `Ok(None)` = empty text (renders an empty
    /// mp3 chunk); `Ok(Some(text))` = the trimmed text to synthesize; `Err` for a
    /// missing key / model / voice.
    fn validate(&self, voice: &str, text: &str) -> TtsResult<Option<String>> {
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("OpenRouter API key not configured".into()));
        }
        if self.model_id.is_empty() {
            return Err(TtsError::Cloud(
                "No OpenRouter speech model selected".into(),
            ));
        }
        if voice.is_empty() {
            return Err(TtsError::Cloud("No OpenRouter voice selected".into()));
        }
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        Ok(Some(trimmed.to_string()))
    }

    /// One `/audio/speech` POST for a specific `response_format`. Returns the raw
    /// body bytes plus the response Content-Type (so the caller can tell raw PCM
    /// from an encoded container), or a classified cloud error. Async so it can
    /// be raced against a cancel signal (dropping the future aborts the POST).
    async fn request_speech(
        &self,
        voice: &str,
        text: &str,
        speed: f32,
        format: &str,
    ) -> TtsResult<(Vec<u8>, String)> {
        let body = build_openrouter_speech_body(&self.model_id, voice, text, speed, format);
        let resp = self
            .client
            .post(OPENROUTER_SPEECH_URL)
            .bearer_auth(&self.api_key)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&body)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| TtsError::Cloud(format!("OpenRouter speech request failed: {e}")))?;
        let status = resp.status().as_u16();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if !(200..300).contains(&status) {
            let body = resp.text().await.unwrap_or_default();
            return Err(TtsError::Cloud(classify_openrouter_speech_status(
                status, &body,
            )));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| TtsError::Cloud(format!("OpenRouter speech read failed: {e}")))?
            .to_vec();
        Ok((bytes, content_type))
    }

    /// One-shot synthesis → decodable container bytes. mp3 passes through; raw
    /// `audio/pcm` (Gemini TTS) is wrapped in a WAV header. Requests the format
    /// the model accepts up front and retries once as pcm if an unknown model
    /// turns out to be pcm-only. Async so it can be raced against a cancel signal.
    async fn fetch_audio(&self, voice: &str, text: &str, speed: f32) -> TtsResult<Vec<u8>> {
        let format = preferred_speech_format(&self.model_id);
        let (bytes, content_type) = match self.request_speech(voice, text, speed, format).await {
            Ok(ok) => ok,
            Err(e) if format != "pcm" && speech_error_wants_pcm(&e) => {
                self.request_speech(voice, text, speed, "pcm").await?
            }
            Err(e) => return Err(e),
        };
        Ok(normalize_speech_audio(bytes, &content_type))
    }

    /// One live preview synthesis call; the resulting mp3 is returned directly
    /// to the playback pipeline.
    pub fn fetch_preview(&self, voice: &str, text: &str, speed: f32) -> TtsResult<Vec<u8>> {
        use tauri::async_runtime::block_on;
        match self.validate(voice, text)? {
            None => Ok(Vec::new()),
            Some(t) => block_on(self.fetch_audio(voice, &t, speed)),
        }
    }
}

impl TtsEngine for OpenRouterTtsEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        speed: f32,
    ) -> TtsResult<SentenceAudio> {
        use tauri::async_runtime::block_on;
        match self.validate(voice, text)? {
            None => Ok(SentenceAudio::Mp3 { bytes: Vec::new() }),
            Some(t) => {
                let bytes = block_on(self.fetch_audio(voice, &t, speed))?;
                Ok(SentenceAudio::Mp3 { bytes })
            }
        }
    }

    /// Race the in-flight POST against the sink's cancel flag (TTS island X /
    /// dictation overlay X), exactly like the ElevenLabs engine.
    fn synthesize_stream(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        speed: f32,
        sink: &dyn ChunkSink,
    ) -> TtsResult<()> {
        use tauri::async_runtime::block_on;
        let bytes = match self.validate(voice, text)? {
            None => Vec::new(),
            Some(t) => block_on(async {
                tokio::select! {
                    biased;
                    () = async {
                        while !sink.is_cancelled() {
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                    } => Err(TtsError::Cancelled),
                    res = self.fetch_audio(voice, &t, speed) => res,
                }
            })?,
        };
        sink.push(SynthesisChunk::mp3(bytes, 0, false));
        Ok(())
    }

    fn list_voices(&self) -> Vec<VoiceInfo> {
        // The manager/UI consume OpenRouter's model-level supported_voices
        // catalog. Engine trait voices stay empty because they are model-scoped.
        Vec::new()
    }

    fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    fn warm_up(&self) -> TtsResult<()> {
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("OpenRouter API key not configured".into()));
        }
        Ok(())
    }

    fn shutdown(&self) {
        self.ready.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_has_openai_compatible_shape() {
        let b =
            build_openrouter_speech_body("microsoft/mai-voice-2", "narrator", "Hello", 1.0, "mp3");
        assert_eq!(b["model"], "microsoft/mai-voice-2");
        assert_eq!(b["input"], "Hello");
        assert_eq!(b["voice"], "narrator");
        assert_eq!(b["response_format"], "mp3");
    }

    #[test]
    fn body_carries_requested_format() {
        let b = build_openrouter_speech_body(
            "google/gemini-3.1-flash-tts-preview",
            "Zephyr",
            "Hi",
            1.0,
            "pcm",
        );
        assert_eq!(b["response_format"], "pcm");
    }

    #[test]
    fn gemini_prefers_pcm_others_mp3() {
        assert_eq!(
            preferred_speech_format("google/gemini-3.1-flash-tts-preview"),
            "pcm"
        );
        assert_eq!(preferred_speech_format("hexgrad/kokoro-82m"), "mp3");
        assert_eq!(preferred_speech_format("microsoft/mai-voice-2"), "mp3");
    }

    #[test]
    fn pcm_only_error_triggers_retry() {
        // The verbatim upstream Gemini message, classified.
        let err = TtsError::Cloud(classify_openrouter_speech_status(
            400,
            r#"{"error":{"message":"Gemini TTS only supports response_format=\"pcm\". Got \"mp3\".","code":400}}"#,
        ));
        assert!(speech_error_wants_pcm(&err));
        // A plain auth failure must NOT route to the pcm retry.
        assert!(!speech_error_wants_pcm(&TtsError::Cloud(
            classify_openrouter_speech_status(401, "")
        )));
    }

    #[test]
    fn parse_pcm_params_reads_rate_and_channels() {
        assert_eq!(
            parse_pcm_params("audio/pcm; rate=24000; channels=1"),
            (24_000, 1)
        );
        assert_eq!(
            parse_pcm_params("audio/pcm;rate=48000;channels=2"),
            (48_000, 2)
        );
        // Missing params fall back to Gemini/OpenAI's 24 kHz mono default.
        assert_eq!(parse_pcm_params("audio/pcm"), (24_000, 1));
    }

    #[test]
    fn pcm_is_wrapped_only_when_raw() {
        // Raw PCM → 44-byte WAV header prepended, RIFF/WAVE magic + sample data.
        let pcm = vec![1u8, 2, 3, 4];
        let wav = normalize_speech_audio(pcm.clone(), "audio/pcm; rate=24000; channels=1");
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[44..], &pcm[..]);
        // An encoded container (mp3) is passed through verbatim.
        let mp3 = vec![0xFFu8, 0xFB, 0x90, 0x00];
        assert_eq!(normalize_speech_audio(mp3.clone(), "audio/mpeg"), mp3);
    }

    #[test]
    fn wav_header_encodes_format_fields() {
        let wav = pcm_s16le_to_wav(&[0u8; 480], 24_000, 1);
        // channels @22, sample_rate @24, bits_per_sample @34 (little-endian).
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            24_000
        );
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16);
    }

    #[test]
    fn classify_status_extracts_provider_message() {
        assert_eq!(
            classify_openrouter_speech_status(401, ""),
            "OpenRouter: invalid API key"
        );
        assert_eq!(
            classify_openrouter_speech_status(
                400,
                r#"{"error":{"message":"bad voice","code":400}}"#
            ),
            "OpenRouter speech: bad voice"
        );
        assert_eq!(
            classify_openrouter_speech_status(500, "not json"),
            "OpenRouter speech error: HTTP 500"
        );
    }
}
