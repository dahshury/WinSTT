//! Optional native speech LLM. The CPU IQ4 path fits ordinary system RAM,
//! including this project's 12 GB Ampere machine, without requiring NVFP4.
mod response;
pub mod runtime;

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};

use super::{
    EngineConfig, EngineKind, Segment, SttError, SttResult, TranscribeOptions, Transcriber,
    Transcription, WordResult,
};

pub struct NemotronEngine {
    child: Child,
    client: reqwest::blocking::Client,
    endpoint: String,
    name: String,
    providers: Vec<String>,
    api_key: String,
    _log: tempfile::NamedTempFile,
}

fn error(message: impl std::fmt::Display) -> SttError {
    SttError::Inference(format!("Nemotron Transcribe: {message}"))
}

pub fn chat_body(audio: &[f32], opts: &TranscribeOptions) -> SttResult<Value> {
    let wav = encode_wav(audio)?;
    let language = match opts.language.as_deref() {
        Some(language) => format!(" The source language is {language}."),
        None if !opts.language_candidates.is_empty() => format!(
            " Source language candidates: {}. Keep the language as spoken.",
            opts.language_candidates.join(", ")
        ),
        None => String::new(),
    };
    let mut instruction = opts.asr_instruction.clone().unwrap_or_else(|| {
        if opts.translate {
            format!("Translate the supplied speech into {}. Return only the translated text.{language}", opts.translate_target_language.as_deref().unwrap_or("en"))
        } else {
            format!("Produce a verbatim transcript with punctuation and capitalization. Preserve fillers, repetitions and named entities. Keep the language as spoken. Return only the transcript.{language}")
        }
    });
    if opts.asr_instruction.is_some() && opts.translate {
        instruction.push_str(&format!(
            "\nTranslate the resulting text into {}. Return only the translated text.",
            opts.translate_target_language.as_deref().unwrap_or("en")
        ));
    }
    if opts.diarization {
        instruction.push_str("\nStart each speaker turn with <spk:0>, <spk:1>, <spk:2>, or <spk:3>. Assign one consistent tag per speaker throughout this recording. Do not invent speaker names.");
    }
    Ok(json!({
        "model": super::prompting::NEMOTRON_TRANSCRIBE_ID,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": instruction},
            {"type": "input_audio", "input_audio": {"data": base64::prelude::BASE64_STANDARD.encode(wav), "format": "wav"}}
        ]}],
        "temperature": 0, "stream": false,
        "word_timestamps": opts.return_word_timestamps || opts.return_timestamps || opts.diarization,
    }))
}

fn encode_wav(audio: &[f32]) -> SttResult<Vec<u8>> {
    let bytes = audio
        .len()
        .checked_mul(2)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| error("audio is too long"))?;
    let riff = bytes
        .checked_add(36)
        .ok_or_else(|| error("audio is too long"))?;
    let mut wav = Vec::with_capacity(bytes as usize + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.extend_from_slice(&32000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&bytes.to_le_bytes());
    for sample in audio {
        let sample = if sample.is_finite() {
            (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16
        } else {
            0
        };
        wav.write_all(&sample.to_le_bytes()).map_err(error)?;
    }
    Ok(wav)
}

impl NemotronEngine {
    pub fn load(cfg: &EngineConfig) -> SttResult<Self> {
        if !super::inference::is_worker_invocation() {
            return Err(error(
                "this optional runtime must run inside the supervised inference worker",
            ));
        }
        let program = cfg
            .resolved
            .files
            .get("runtime")
            .ok_or_else(|| error("optional native runtime is not installed"))?;
        let decoder = cfg
            .resolved
            .files
            .get("decoder")
            .ok_or_else(|| error("missing decoder GGUF"))?;
        let encoder = cfg
            .resolved
            .files
            .get("encoder")
            .ok_or_else(|| error("missing encoder GGUF"))?;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(error)?;
        let port = listener.local_addr().map_err(error)?.port();
        drop(listener);
        let log = tempfile::NamedTempFile::new().map_err(error)?;
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(error)?;
        let api_key = secret
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut command = Command::new(program);
        command.env("NEMO_SPEECH_HTTP_API_KEY", &api_key);
        command
            .args([
                "serve",
                "--quiet",
                "--backend",
                "cpu",
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
            ])
            .arg("--asr-model")
            .arg(decoder)
            .arg("--asr.model.name")
            .arg(super::prompting::NEMOTRON_TRANSCRIBE_ID)
            .arg("--asr.salm.encoder_path")
            .arg(encoder)
            .args([
                "--asr.salm.max_sequences",
                "1",
                "--asr.salm.n_ctx_per_sequence",
                "73728",
                "--asr.salm.max_context",
                "73728",
                "--asr.salm.mtp_draft",
                "0",
                "--asr.salm.encoder_max_batch",
                "1",
                "--asr.salm.encoder_ahead_seconds",
                "60",
                "--http.threads",
                "2",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log.reopen().map_err(error)?));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let child = command.spawn().map_err(error)?;
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3600))
            .build()
            .map_err(error)?;
        let mut engine = Self {
            child,
            client,
            endpoint: format!("http://127.0.0.1:{port}"),
            name: cfg.model_name.clone(),
            providers: vec!["CPU".into()],
            api_key,
            _log: log,
        };
        let deadline = Instant::now() + Duration::from_secs(170);
        while Instant::now() < deadline {
            if let Some(status) = engine.child.try_wait().map_err(error)? {
                let detail = std::fs::read_to_string(engine._log.path()).unwrap_or_default();
                return Err(error(format!(
                    "native runtime exited ({status}): {}",
                    detail
                        .chars()
                        .rev()
                        .take(1500)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                )));
            }
            if engine
                .client
                .get(format!("{}/ready", engine.endpoint))
                .timeout(Duration::from_secs(1))
                .send()
                .is_ok_and(|reply| reply.status().is_success())
            {
                return Ok(engine);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(error(
            "native runtime did not become ready within its load deadline",
        ))
    }
}

impl Drop for NemotronEngine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Transcriber for NemotronEngine {
    fn kind(&self) -> EngineKind {
        EngineKind::NemotronTranscribe
    }
    fn model_name(&self) -> &str {
        &self.name
    }
    fn is_ready(&self) -> bool {
        true
    }
    fn active_providers(&self) -> &[String] {
        &self.providers
    }
    fn supports_word_timestamps(&self) -> bool {
        true
    }
    fn warmup(&mut self, _: &[f32], _: &TranscribeOptions) -> SttResult<()> {
        Ok(())
    }
    fn transcribe(&mut self, audio: &[f32], opts: &TranscribeOptions) -> SttResult<Transcription> {
        if audio.len() < 320 {
            return Ok(Transcription::default());
        }
        if self.child.try_wait().map_err(error)?.is_some() {
            return Err(error(
                "native runtime has exited; reload this optional model",
            ));
        }
        let reply = self
            .client
            .post(format!("{}/v1/chat/completions", self.endpoint))
            .bearer_auth(&self.api_key)
            .json(&chat_body(audio, opts)?)
            .send()
            .map_err(error)?;
        let status = reply.status();
        let result: Value = reply.json().map_err(error)?;
        if !status.is_success() {
            return Err(error(format!(
                "request failed ({status}): {}",
                result.get("error").unwrap_or(&Value::Null)
            )));
        }
        response::parse(&result, audio.len() as f32 / 16000.0, opts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diarization_adds_speaker_contract_without_replacing_asr_instructions() {
        let opts = TranscribeOptions {
            diarization: true,
            asr_instruction: Some("Omit verbal fillers.".into()),
            ..Default::default()
        };
        let body = chat_body(&[0.0; 320], &opts).unwrap();
        let instruction = body["messages"][0]["content"][0]["text"].as_str().unwrap();
        assert!(instruction.starts_with("Omit verbal fillers."));
        assert!(instruction.contains("<spk:0>"));
        assert_eq!(body["word_timestamps"], true);
    }

    #[test]
    fn instruction_is_an_audio_user_message_without_text_cleanup_schema() {
        let opts = TranscribeOptions {
            asr_instruction: Some("Omit fillers.".into()),
            initial_prompt_text: Some("Context bias must not leak".into()),
            ..Default::default()
        };
        let body = chat_body(&[0.0; 320], &opts).unwrap();
        assert_eq!(body["messages"][0]["content"][0]["text"], "Omit fillers.");
        assert_eq!(
            body["messages"][0]["content"][1]["input_audio"]["format"],
            "wav"
        );
        assert!(body.get("response_format").is_none());
        assert!(!body.to_string().contains("Context bias"));
    }
}
