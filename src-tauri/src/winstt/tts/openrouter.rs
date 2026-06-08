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
/// mp3 keeps parity with the ElevenLabs path — the renderer decodes mp3 chunks.
pub const OPENROUTER_TTS_FORMAT: &str = "mp3";

/// Build the JSON body for OpenRouter `POST /api/v1/audio/speech`. REAL CODE — tested.
pub fn build_openrouter_speech_body(
    model: &str,
    voice: &str,
    text: &str,
    speed: f32,
) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": OPENROUTER_TTS_FORMAT,
        "speed": clamp_cloud_speed(speed),
    })
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

    /// One-shot synthesis → mp3 bytes. Async so it can be raced against a cancel
    /// signal (dropping the future aborts the in-flight POST).
    async fn fetch_mp3(&self, voice: &str, text: &str, speed: f32) -> TtsResult<Vec<u8>> {
        let body = build_openrouter_speech_body(&self.model_id, voice, text, speed);
        let resp = self
            .client
            .post(OPENROUTER_SPEECH_URL)
            .bearer_auth(&self.api_key)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| TtsError::Cloud(format!("OpenRouter speech request failed: {e}")))?;
        let status = resp.status().as_u16();
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
        Ok(bytes)
    }

    /// One live preview synthesis call; the resulting mp3 is returned directly
    /// to the playback pipeline.
    pub fn fetch_preview(&self, voice: &str, text: &str, speed: f32) -> TtsResult<Vec<u8>> {
        use tauri::async_runtime::block_on;
        match self.validate(voice, text)? {
            None => Ok(Vec::new()),
            Some(t) => block_on(self.fetch_mp3(voice, &t, speed)),
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
                let bytes = block_on(self.fetch_mp3(voice, &t, speed))?;
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
                    res = self.fetch_mp3(voice, &t, speed) => res,
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
        let b = build_openrouter_speech_body("microsoft/mai-voice-2", "narrator", "Hello", 1.0);
        assert_eq!(b["model"], "microsoft/mai-voice-2");
        assert_eq!(b["input"], "Hello");
        assert_eq!(b["voice"], "narrator");
        assert_eq!(b["response_format"], "mp3");
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
