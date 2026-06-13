// Piper (VITS) per-voice TTS on ort 2.0.0-rc.12.
//
// Recipe verified verbatim from OHF-Voice/piper1-gpl (voice.py, phoneme_ids.py,
// const.py, config.py, phonemize_espeak.py) + a real en_US-lessac-medium.onnx.json
// (see TTS research run, model:piper):
//   text --espeak-ng IPA (voice = json.espeak.voice)--> phoneme string
//        --NFD codepoints, map via json.phoneme_id_map with PAD interleave + BOS/EOS-->
//        input ids
//   inputs : input [1,T] i64, input_lengths [1] i64 (=T), scales [3] f32
//            = [noise_scale, length_scale, noise_w]; (+ sid [1] i64 iff num_speakers>1)
//   output : waveform f32 in [-1,1] @ json.audio.sample_rate (22050 for lessac-medium)
//
// Each VOICE is its own {voice}.onnx + {voice}.onnx.json (no shared model, no quant
// matrix). Reuses the bundled espeak-ng via EspeakLibPhonemizer::phonemize_voice
// (explicit espeak voice id — NOT the Kokoro lang remap).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use super::phonemize::EspeakLibPhonemizer;

/// Piper PAD/BOS/EOS phoneme keys (const.py).
const PIPER_PAD: &str = "_";
const PIPER_BOS: &str = "^";
const PIPER_EOS: &str = "$";

const DEFAULT_NOISE_SCALE: f32 = 0.667;
const DEFAULT_LENGTH_SCALE: f32 = 1.0;
const DEFAULT_NOISE_W: f32 = 0.8;

#[derive(Debug, thiserror::Error)]
pub enum PiperError {
    #[error("piper assets missing: {0}")]
    AssetsMissing(String),
    #[error("piper config error: {0}")]
    Config(String),
    #[error("piper session error: {0}")]
    Session(String),
    #[error("piper phonemize error: {0}")]
    Phonemize(String),
}
pub type PiperResult<T> = Result<T, PiperError>;

/// Parsed `{voice}.onnx.json`.
#[derive(Clone, Debug)]
pub struct PiperVoiceConfig {
    pub sample_rate: u32,
    pub espeak_voice: String,
    pub num_speakers: i64,
    pub noise_scale: f32,
    pub length_scale: f32,
    pub noise_w: f32,
    /// phoneme string-key → id list (values are usually a single id).
    pub phoneme_id_map: HashMap<String, Vec<i64>>,
}

impl PiperVoiceConfig {
    pub fn from_json_path(path: &Path) -> PiperResult<Self> {
        let raw =
            std::fs::read_to_string(path).map_err(|e| PiperError::AssetsMissing(e.to_string()))?;
        let v: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| PiperError::Config(format!("parse json: {e}")))?;
        let sample_rate = v
            .get("audio")
            .and_then(|a| a.get("sample_rate"))
            .and_then(|s| s.as_u64())
            .ok_or_else(|| PiperError::Config("missing audio.sample_rate".into()))?
            as u32;
        let espeak_voice = v
            .get("espeak")
            .and_then(|e| e.get("voice"))
            .and_then(|s| s.as_str())
            .unwrap_or("en-us")
            .to_string();
        let num_speakers = v.get("num_speakers").and_then(|s| s.as_i64()).unwrap_or(1);
        let inf = v.get("inference");
        let f = |key: &str, def: f32| -> f32 {
            inf.and_then(|i| i.get(key))
                .and_then(|x| x.as_f64())
                .map(|x| x as f32)
                .unwrap_or(def)
        };
        let noise_scale = f("noise_scale", DEFAULT_NOISE_SCALE);
        let length_scale = f("length_scale", DEFAULT_LENGTH_SCALE);
        let noise_w = f("noise_w", DEFAULT_NOISE_W);
        let mut phoneme_id_map: HashMap<String, Vec<i64>> = HashMap::new();
        let map = v
            .get("phoneme_id_map")
            .and_then(|m| m.as_object())
            .ok_or_else(|| PiperError::Config("missing phoneme_id_map".into()))?;
        for (k, val) in map {
            let ids: Vec<i64> = val
                .as_array()
                .map(|arr| arr.iter().filter_map(|x| x.as_i64()).collect())
                .unwrap_or_default();
            if !ids.is_empty() {
                phoneme_id_map.insert(k.clone(), ids);
            }
        }
        for required in [PIPER_PAD, PIPER_BOS, PIPER_EOS] {
            if !phoneme_id_map.contains_key(required) {
                return Err(PiperError::Config(format!(
                    "phoneme_id_map missing required key {required:?}"
                )));
            }
        }
        Ok(Self {
            sample_rate,
            espeak_voice,
            num_speakers,
            noise_scale,
            length_scale,
            noise_w,
            phoneme_id_map,
        })
    }
}

#[derive(Clone, Debug)]
pub struct PiperConfig {
    /// Directory holding `{voice}.onnx` + `{voice}.onnx.json`.
    pub cache_dir: PathBuf,
    /// Voice stem, e.g. `en_US-lessac-medium`.
    pub voice_stem: String,
}
impl PiperConfig {
    pub fn model_path(&self) -> PathBuf {
        self.cache_dir.join(format!("{}.onnx", self.voice_stem))
    }
    pub fn json_path(&self) -> PathBuf {
        self.cache_dir
            .join(format!("{}.onnx.json", self.voice_stem))
    }
    pub fn assets_present(&self) -> bool {
        self.model_path().exists() && self.json_path().exists()
    }
}

struct LoadedPiper {
    session: ort::session::Session,
    cfg: PiperVoiceConfig,
}

pub struct PiperEngine {
    config: PiperConfig,
    inner: Mutex<Option<LoadedPiper>>,
    phonemizer: Option<EspeakLibPhonemizer>,
    ready: AtomicBool,
}

impl PiperEngine {
    pub fn new(config: PiperConfig) -> Self {
        Self {
            config,
            inner: Mutex::new(None),
            phonemizer: EspeakLibPhonemizer::discover(),
            ready: AtomicBool::new(false),
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    pub fn warm_up(&self) -> PiperResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| PiperError::Session("piper lock poisoned".into()))?;
        if guard.is_none() {
            *guard = Some(self.load()?);
            self.ready.store(true, Ordering::Release);
        }
        Ok(())
    }

    pub fn synthesize(&self, text: &str, speed: f32) -> PiperResult<(Vec<f32>, u32)> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok((Vec::new(), 0));
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| PiperError::Session("piper lock poisoned".into()))?;
        if guard.is_none() {
            *guard = Some(self.load()?);
            self.ready.store(true, Ordering::Release);
        }
        let loaded = guard.as_mut().expect("just initialized");

        let phonemizer = self
            .phonemizer
            .as_ref()
            .ok_or_else(|| PiperError::Phonemize("espeak-ng shared lib not found".into()))?;
        let phonemes = phonemizer
            .phonemize_voice(trimmed, &loaded.cfg.espeak_voice)
            .map_err(|e| PiperError::Phonemize(e.to_string()))?;

        let ids = phonemes_to_ids(&phonemes, &loaded.cfg.phoneme_id_map);
        if ids.is_empty() {
            return Ok((Vec::new(), loaded.cfg.sample_rate));
        }
        let sr = loaded.cfg.sample_rate;
        let audio = self.run_inference(loaded, &ids, speed)?;
        Ok((audio, sr))
    }

    fn load(&self) -> PiperResult<LoadedPiper> {
        if !self.config.assets_present() {
            return Err(PiperError::AssetsMissing(format!(
                "expected {} and {}",
                self.config.model_path().display(),
                self.config.json_path().display()
            )));
        }
        let cfg = PiperVoiceConfig::from_json_path(&self.config.json_path())?;
        let session = self.build_session()?;
        Ok(LoadedPiper { session, cfg })
    }

    /// CPU session (start conservative like Kokoro; VITS has no fp16 ConvTranspose
    /// but DML benefit at this size is unproven — benchmark before enabling).
    fn build_session(&self) -> PiperResult<ort::session::Session> {
        let model_path = self.config.model_path();
        let (session, _) = super::provider::build_session(
            &model_path,
            super::types::TtsDevice::Cpu,
            super::provider::TtsOrtProviderPolicy::CpuOnly {
                reason: "Piper DirectML policy is not validated yet",
            },
            "Piper",
        )
        .map_err(PiperError::Session)?;
        Ok(session)
    }

    fn run_inference(
        &self,
        loaded: &mut LoadedPiper,
        ids: &[i64],
        speed: f32,
    ) -> PiperResult<Vec<f32>> {
        use ort::value::Tensor;
        let t = ids.len();
        let input = Tensor::from_array(([1usize, t], ids.to_vec().into_boxed_slice()))
            .map_err(|e| PiperError::Session(format!("input tensor: {e}")))?;
        let input_lengths = Tensor::from_array(([1usize], vec![t as i64].into_boxed_slice()))
            .map_err(|e| PiperError::Session(format!("input_lengths tensor: {e}")))?;
        // length_scale: larger = slower. Honor speed as a divisor (speed>0).
        let length_scale = if speed > 0.0 {
            loaded.cfg.length_scale / speed
        } else {
            loaded.cfg.length_scale
        };
        let scales = Tensor::from_array((
            [3usize],
            vec![loaded.cfg.noise_scale, length_scale, loaded.cfg.noise_w].into_boxed_slice(),
        ))
        .map_err(|e| PiperError::Session(format!("scales tensor: {e}")))?;

        let outputs = if loaded.cfg.num_speakers > 1 {
            let sid = Tensor::from_array(([1usize], vec![0i64].into_boxed_slice()))
                .map_err(|e| PiperError::Session(format!("sid tensor: {e}")))?;
            loaded
                .session
                .run(ort::inputs! {
                    "input" => input,
                    "input_lengths" => input_lengths,
                    "scales" => scales,
                    "sid" => sid,
                })
                .map_err(|e| PiperError::Session(format!("inference: {e}")))?
        } else {
            loaded
                .session
                .run(ort::inputs! {
                    "input" => input,
                    "input_lengths" => input_lengths,
                    "scales" => scales,
                })
                .map_err(|e| PiperError::Session(format!("inference: {e}")))?
        };
        let (_shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| PiperError::Session(format!("extract audio: {e}")))?;
        Ok(data.to_vec())
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
        self.ready.store(false, Ordering::Release);
    }
}

/// Build the Piper id sequence: BOS, PAD, then for each phoneme codepoint its
/// id(s) followed by PAD, then EOS. Unknown codepoints are skipped. Verbatim port
/// of piper1-gpl `phonemes_to_ids`. `phonemes` is the cleaned espeak IPA string
/// (per-codepoint); NFD is skipped (espeak output + the map share espeak's form).
fn phonemes_to_ids(phonemes: &str, id_map: &HashMap<String, Vec<i64>>) -> Vec<i64> {
    let mut ids: Vec<i64> = Vec::with_capacity(phonemes.len() * 2 + 4);
    if let Some(bos) = id_map.get(PIPER_BOS) {
        ids.extend_from_slice(bos);
    }
    if let Some(pad) = id_map.get(PIPER_PAD) {
        ids.extend_from_slice(pad);
    }
    let pad = id_map.get(PIPER_PAD).cloned().unwrap_or_default();
    for ch in phonemes.chars() {
        let key = ch.to_string();
        if let Some(phoneme_ids) = id_map.get(&key) {
            ids.extend_from_slice(phoneme_ids);
            ids.extend_from_slice(&pad);
        }
        // unknown phoneme codepoints are silently skipped (matches piper warn+skip)
    }
    if let Some(eos) = id_map.get(PIPER_EOS) {
        ids.extend_from_slice(eos);
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_map() -> HashMap<String, Vec<i64>> {
        let mut m = HashMap::new();
        m.insert("_".to_string(), vec![0]);
        m.insert("^".to_string(), vec![1]);
        m.insert("$".to_string(), vec![2]);
        m.insert("a".to_string(), vec![10]);
        m.insert("b".to_string(), vec![11]);
        m
    }

    #[test]
    fn phonemes_to_ids_interleaves_pad_bos_eos() {
        let m = tiny_map();
        // "ab" → BOS PAD a PAD b PAD EOS = 1 0 10 0 11 0 2
        assert_eq!(phonemes_to_ids("ab", &m), vec![1, 0, 10, 0, 11, 0, 2]);
    }

    #[test]
    fn phonemes_to_ids_skips_unknown() {
        let m = tiny_map();
        // 'z' unknown → skipped: BOS PAD a PAD EOS
        assert_eq!(phonemes_to_ids("az", &m), vec![1, 0, 10, 0, 2]);
    }
}
