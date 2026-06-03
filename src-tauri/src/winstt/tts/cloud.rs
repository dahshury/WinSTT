use std::sync::atomic::{AtomicBool, Ordering};

use super::types::{clamp_cloud_speed, SentenceAudio, TtsEngine, TtsError, TtsResult, VoiceInfo};

// ---------------------------------------------------------------------------
// Cloud ElevenLabs engine (reqwest)
// ---------------------------------------------------------------------------

/// ElevenLabs voice-settings tuning, read from the encrypted store per call.
#[derive(Clone, Debug, PartialEq)]
pub struct CloudVoiceSettings {
    pub stability: f32,
    pub similarity: f32,
    pub style: f32,
    pub speaker_boost: bool,
    pub speed: f32,
}

impl Default for CloudVoiceSettings {
    fn default() -> Self {
        Self {
            stability: 0.5,
            similarity: 0.75,
            style: 0.0,
            speaker_boost: true,
            speed: 1.0,
        }
    }
}

/// Inputs for one cloud synthesis call.
#[derive(Clone, Debug)]
pub struct CloudSynthesisRequest {
    pub api_key: String,
    pub voice_id: String,
    pub model_id: String,
    pub text: String,
    pub settings: CloudVoiceSettings,
}

pub const ELEVENLABS_TTS_BASE: &str = "https://api.elevenlabs.io/v1/text-to-speech";
pub const ELEVENLABS_VOICES_URL: &str = "https://api.elevenlabs.io/v2/voices?page_size=100";
pub const ELEVENLABS_SUBSCRIPTION_URL: &str = "https://api.elevenlabs.io/v1/user/subscription";
/// mp3 is the ONLY format available on every ElevenLabs tier (raw pcm 402s on free).
pub const CLOUD_OUTPUT_FORMAT: &str = "mp3_44100_128";

/// Build the JSON request body for `POST /v1/text-to-speech/{voice_id}`.
/// REAL CODE — unit-tested. Field names are ElevenLabs' on-wire snake_case.
pub fn build_cloud_body(req: &CloudSynthesisRequest) -> serde_json::Value {
    serde_json::json!({
        "text": req.text,
        "model_id": req.model_id,
        "voice_settings": {
            "stability": req.settings.stability,
            "similarity_boost": req.settings.similarity,
            "style": req.settings.style,
            "use_speaker_boost": req.settings.speaker_boost,
            "speed": clamp_cloud_speed(req.settings.speed),
        }
    })
}

/// Full POST URL for a voice id, with the tier-safe output format.
pub fn build_cloud_url(voice_id: &str) -> String {
    format!("{ELEVENLABS_TTS_BASE}/{voice_id}?output_format={CLOUD_OUTPUT_FORMAT}")
}

/// Classify an ElevenLabs HTTP status + optional `detail.status` body field into
/// a human-readable reason. Mirrors `tts-cloud.ts` HTTP_STATUS_MESSAGE +
/// memory `project_elevenlabs_scoped_key_verify` (a scoped key missing
/// `voices_read` is NOT an invalid key). REAL CODE — tested.
pub fn classify_cloud_status(status: u16, detail_status: Option<&str>) -> String {
    if let Some(d) = detail_status {
        match d {
            "quota_exceeded" => return "ElevenLabs: character quota exceeded".to_string(),
            "missing_permissions" => {
                return "ElevenLabs: this API key is missing a required permission".to_string()
            }
            "invalid_api_key" => return "ElevenLabs: invalid API key".to_string(),
            "voice_not_found" => return "ElevenLabs: voice not found".to_string(),
            _ => {}
        }
    }
    match status {
        401 | 403 => "ElevenLabs: invalid API key".to_string(),
        402 => "ElevenLabs: this voice needs a paid plan (cloned & professional voices require a subscription)".to_string(),
        429 => "ElevenLabs: rate limited".to_string(),
        s => format!("ElevenLabs error: HTTP {s}"),
    }
}

/// Pull the `detail.status` discriminator out of an ElevenLabs error body, if
/// present (the body shape is `{"detail": {"status": "...", "message": "..."}}`
/// OR `{"detail": "..."}`). REAL CODE — tested.
pub fn parse_detail_status(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.get("detail")?
        .get("status")?
        .as_str()
        .map(|s| s.to_string())
}

/// One live ElevenLabs voice (from `/v2/voices`). Surfaced to the renderer
/// cloud-voice picker (includes the account's cloned voices).
#[derive(Clone, Debug, PartialEq)]
pub struct CloudVoice {
    pub id: String,
    pub name: String,
    pub language: Option<String>,
    pub category: Option<String>,
    pub preview_url: Option<String>,
}

/// Parse a `/v2/voices` JSON body into `CloudVoice`s. REAL CODE — tested.
pub fn parse_cloud_voices(body: &str) -> Vec<CloudVoice> {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let arr = match v.get("voices").and_then(|x| x.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    arr.iter()
        .filter_map(|entry| {
            let id = entry.get("voice_id")?.as_str()?.to_string();
            let name = entry
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let language = entry
                .get("labels")
                .and_then(|l| l.get("language"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let category = entry
                .get("category")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            let preview_url = entry
                .get("preview_url")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            Some(CloudVoice {
                id,
                name,
                language,
                category,
                preview_url,
            })
        })
        .collect()
}

/// Cloud engine. `synthesize_sentence` POSTs `build_cloud_body` via reqwest and
/// returns the mp3 bytes as ONE chunk (ElevenLabs convert is one-shot).
///
/// Uses the async `reqwest::Client` driven by `tauri::async_runtime::block_on`
/// (the existing reqwest dep has no `blocking` feature; the command layer runs
/// every cloud call on a `spawn_blocking` worker so blocking here is safe).
pub struct ElevenLabsEngine {
    client: reqwest::Client,
    api_key: String,
    model_id: String,
    settings: CloudVoiceSettings,
    ready: AtomicBool,
}

impl ElevenLabsEngine {
    pub fn new(api_key: String, model_id: String, settings: CloudVoiceSettings) -> Self {
        let ready = AtomicBool::new(!api_key.is_empty());
        Self {
            client: reqwest::Client::new(),
            api_key,
            model_id,
            settings,
            ready,
        }
    }

    /// Fetch the live `/v2/voices` list (includes cloned voices). The host calls
    /// this for the cloud-voice picker (not via `list_voices`, which is static).
    pub fn fetch_voices(&self) -> TtsResult<Vec<CloudVoice>> {
        use tauri::async_runtime::block_on;
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("ElevenLabs API key not configured".into()));
        }
        let resp = block_on(
            self.client
                .get(ELEVENLABS_VOICES_URL)
                .header("xi-api-key", &self.api_key)
                .send(),
        )
        .map_err(|e| TtsError::Cloud(format!("ElevenLabs voices request failed: {e}")))?;
        let status = resp.status().as_u16();
        let body = block_on(resp.text())
            .map_err(|e| TtsError::Cloud(format!("ElevenLabs voices read failed: {e}")))?;
        if !(200..300).contains(&status) {
            return Err(TtsError::Cloud(classify_cloud_status(
                status,
                parse_detail_status(&body).as_deref(),
            )));
        }
        Ok(parse_cloud_voices(&body))
    }

    /// Fetch a CDN preview mp3 for a voice (no character credits). Refuses any
    /// non-https URL (trust-boundary check, PORT/06_tts.md §4).
    pub fn fetch_preview(&self, preview_url: &str) -> TtsResult<Vec<u8>> {
        use tauri::async_runtime::block_on;
        if !preview_url.starts_with("https://") {
            return Err(TtsError::Cloud("refusing non-https preview url".into()));
        }
        let resp = block_on(self.client.get(preview_url).send())
            .map_err(|e| TtsError::Cloud(format!("preview fetch failed: {e}")))?;
        if !resp.status().is_success() {
            return Err(TtsError::Cloud(format!("preview HTTP {}", resp.status())));
        }
        block_on(resp.bytes())
            .map(|b| b.to_vec())
            .map_err(|e| TtsError::Cloud(format!("preview read failed: {e}")))
    }
}

impl TtsEngine for ElevenLabsEngine {
    fn synthesize_sentence(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        speed: f32,
    ) -> TtsResult<SentenceAudio> {
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("ElevenLabs API key not configured".into()));
        }
        if voice.is_empty() {
            return Err(TtsError::Cloud("No ElevenLabs voice selected".into()));
        }
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(SentenceAudio::Mp3 { bytes: Vec::new() });
        }
        use tauri::async_runtime::block_on;
        let req = CloudSynthesisRequest {
            api_key: self.api_key.clone(),
            voice_id: voice.to_string(),
            model_id: self.model_id.clone(),
            text: trimmed.to_string(),
            settings: CloudVoiceSettings {
                speed: clamp_cloud_speed(speed),
                ..self.settings.clone()
            },
        };
        let resp = block_on(
            self.client
                .post(build_cloud_url(voice))
                .header("xi-api-key", &self.api_key)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .json(&build_cloud_body(&req))
                .send(),
        )
        .map_err(|e| TtsError::Cloud(format!("ElevenLabs request failed: {e}")))?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            let body = block_on(resp.text()).unwrap_or_default();
            return Err(TtsError::Cloud(classify_cloud_status(
                status,
                parse_detail_status(&body).as_deref(),
            )));
        }
        let bytes = block_on(resp.bytes())
            .map_err(|e| TtsError::Cloud(format!("ElevenLabs read failed: {e}")))?
            .to_vec();
        Ok(SentenceAudio::Mp3 { bytes })
    }

    fn list_voices(&self) -> Vec<VoiceInfo> {
        // Cloud voices come from a live GET /v2/voices fetch, not the static catalog.
        Vec::new()
    }

    fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    fn warm_up(&self) -> TtsResult<()> {
        if self.api_key.is_empty() {
            return Err(TtsError::Cloud("ElevenLabs API key not configured".into()));
        }
        Ok(())
    }

    fn shutdown(&self) {
        self.ready.store(false, Ordering::Release);
    }
}
