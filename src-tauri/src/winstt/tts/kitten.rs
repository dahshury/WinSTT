// PORT IMPL — KittenTTS nano (StyleTTS2-derived, single-graph) on ort 2.0.0-rc.12.
//
// Recipe verified verbatim from KittenML/KittenTTS `kittentts/onnx_model.py` +
// devnen/Kitten-TTS-Server `engine.py` (see TTS research run, model:kitten):
//   text --espeak-ng IPA(with_stress)--> phonemes
//        --basic_english_tokenize (re.findall \w+|[^\w\s]) + ' '.join--> phoneme string
//        --StyleTTS2 dense symbol table (char->index)--> ids
//        --[0] ++ ids ++ [0]--> input_ids
//   inputs : input_ids [1,N] i64, style [1,256] f32 (voice row = min(text_chars, rows-1)),
//            speed [1] f32
//   output : waveform f32 @ 24 kHz mono; DROP the last 5000 samples (KittenML tail crop)
//
// Differences from kokoro.rs (do NOT copy Kokoro's vocab/indexing here):
//  * vocab is the DENSE positional StyleTTS2 table (not Kokoro's sparse config.json map);
//  * the voice row is indexed by RAW INPUT TEXT char count (not token count);
//  * the tail trim is a fixed -5000 crop (not librosa energy trim).
// Reuses the shared espeak-ng phonemizer (phonemize.rs) and a local npz/npy parser.

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use regex::Regex;

use super::phonemize::{default_phonemizer, Phonemizer};

/// KittenTTS emits 24 kHz mono float PCM.
pub const KITTEN_SAMPLE_RATE: u32 = 24_000;
/// StyleTTS2 reference-style embedding dim.
pub const KITTEN_STYLE_DIM: usize = 256;
/// KittenML drops this many trailing samples (fixed tail crop, not an energy trim).
const KITTEN_TAIL_CROP: usize = 5000;
/// Default voice when none/unknown requested.
pub const KITTEN_DEFAULT_VOICE: &str = "expr-voice-5-m";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KittenDevice {
    Auto,
    DirectMl,
    Cpu,
}

#[derive(Debug)]
pub enum KittenError {
    AssetsMissing(String),
    Session(String),
    Voice(String),
    Phonemize(String),
}

impl std::fmt::Display for KittenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KittenError::AssetsMissing(m) => write!(f, "kitten assets missing: {m}"),
            KittenError::Session(m) => write!(f, "kitten session error: {m}"),
            KittenError::Voice(m) => write!(f, "kitten voice error: {m}"),
            KittenError::Phonemize(m) => write!(f, "kitten phonemize error: {m}"),
        }
    }
}
impl std::error::Error for KittenError {}
pub type KittenResult<T> = Result<T, KittenError>;

// ---------------------------------------------------------------------------
// StyleTTS2 dense symbol table (char -> contiguous index). Total positions =
// 178 (matches n_token). _pad(1) + _punctuation(16) + _letters(52) + _letters_ipa(109).
// Order is load-bearing: index == position in this concatenation. Duplicate
// chars (the apostrophe appears twice in _letters_ipa) resolve to the LAST index,
// matching Python `dicts[symbols[i]] = i`.
// ---------------------------------------------------------------------------

const KITTEN_PAD: &str = "$";
// ; : , . ! ? ¡ ¿ —(U+2014) …(U+2026) "(U+0022) «(U+00AB) »(U+00BB) “(U+201C) ”(U+201D) space
const KITTEN_PUNCTUATION: &str =
    ";:,.!?\u{00A1}\u{00BF}\u{2014}\u{2026}\"\u{00AB}\u{00BB}\u{201C}\u{201D} ";
const KITTEN_LETTERS: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// 109 IPA glyphs; trailing 4 written as escapes: ' U+0329(combining) ' ᵻ(U+1D7B).
const KITTEN_LETTERS_IPA: &str = "\u{0251}\u{0250}\u{0252}\u{00E6}\u{0253}\u{0299}\u{03B2}\u{0254}\u{0255}\u{00E7}\u{0257}\u{0256}\u{00F0}\u{02A4}\u{0259}\u{0258}\u{025A}\u{025B}\u{025C}\u{025D}\u{025E}\u{025F}\u{0284}\u{0261}\u{0260}\u{0262}\u{029B}\u{0266}\u{0267}\u{0127}\u{0265}\u{029C}\u{0268}\u{026A}\u{029D}\u{026D}\u{026C}\u{026B}\u{026E}\u{029F}\u{0271}\u{026F}\u{0270}\u{014B}\u{0273}\u{0272}\u{0274}\u{00F8}\u{0275}\u{0278}\u{03B8}\u{0153}\u{0276}\u{0298}\u{0279}\u{027A}\u{027E}\u{027B}\u{0280}\u{0281}\u{027D}\u{0282}\u{0283}\u{0288}\u{02A7}\u{0289}\u{028A}\u{028B}\u{2C71}\u{028C}\u{0263}\u{0264}\u{028D}\u{03C7}\u{028E}\u{028F}\u{0291}\u{0290}\u{0292}\u{0294}\u{02A1}\u{0295}\u{02A2}\u{01C0}\u{01C1}\u{01C2}\u{01C3}\u{02C8}\u{02CC}\u{02D0}\u{02D1}\u{02BC}\u{02B4}\u{02B0}\u{02B1}\u{02B2}\u{02B7}\u{02E0}\u{02E4}\u{02DE}\u{2193}\u{2191}\u{2192}\u{2197}\u{2198}\u{0027}\u{0329}\u{0027}\u{1D7B}";

static KITTEN_VOCAB: OnceLock<HashMap<char, i64>> = OnceLock::new();

/// The dense StyleTTS2 char->id map (last-wins on duplicate chars).
fn kitten_vocab() -> &'static HashMap<char, i64> {
    KITTEN_VOCAB.get_or_init(|| {
        let mut symbols: Vec<char> = Vec::new();
        symbols.extend(KITTEN_PAD.chars());
        symbols.extend(KITTEN_PUNCTUATION.chars());
        symbols.extend(KITTEN_LETTERS.chars());
        symbols.extend(KITTEN_LETTERS_IPA.chars());
        // enumerate → (char, index); collect last-wins (matches Python dict assign).
        symbols
            .into_iter()
            .enumerate()
            .map(|(i, c)| (c, i as i64))
            .collect()
    })
}

/// Number of symbol POSITIONS (not unique chars). Used as a self-check.
fn kitten_symbol_count() -> usize {
    KITTEN_PAD.chars().count()
        + KITTEN_PUNCTUATION.chars().count()
        + KITTEN_LETTERS.chars().count()
        + KITTEN_LETTERS_IPA.chars().count()
}

static BASIC_TOKENIZE_RE: OnceLock<Regex> = OnceLock::new();
fn basic_tokenize_re() -> &'static Regex {
    BASIC_TOKENIZE_RE.get_or_init(|| Regex::new(r"\w+|[^\w\s]").expect("valid regex"))
}

/// `' '.join(re.findall(r"\w+|[^\w\s]", phonemes))` then char->id via the dense
/// vocab (dropping misses). Mirrors KittenTTS basic_english_tokenize + TextCleaner.
fn kitten_text_to_ids(phonemes: &str) -> Vec<i64> {
    let joined = basic_tokenize_re()
        .find_iter(phonemes)
        .map(|m| m.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let vocab = kitten_vocab();
    joined
        .chars()
        .filter_map(|c| vocab.get(&c).copied())
        .collect()
}

// ---------------------------------------------------------------------------
// Voice pack — voices.npz (zip of <expr-voice-*>.npy f32 arrays). Each array is
// [rows, 256] (or [256] / [1,256]); the style row is min(text_chars, rows-1).
// ---------------------------------------------------------------------------

struct KittenVoiceStyle {
    data: Vec<f32>, // rows * 256, row-major
    rows: usize,
}
impl KittenVoiceStyle {
    fn row_for(&self, text_char_len: usize) -> &[f32] {
        let idx = text_char_len.min(self.rows.saturating_sub(1));
        let start = idx * KITTEN_STYLE_DIM;
        &self.data[start..start + KITTEN_STYLE_DIM]
    }
}

struct KittenVoices {
    voices: HashMap<String, KittenVoiceStyle>,
}
impl KittenVoices {
    fn load(path: &Path) -> KittenResult<Self> {
        let file =
            std::fs::File::open(path).map_err(|e| KittenError::AssetsMissing(e.to_string()))?;
        let mut zip = zip::ZipArchive::new(file)
            .map_err(|e| KittenError::Voice(format!("voices.npz not a valid zip: {e}")))?;
        let mut voices = HashMap::new();
        for i in 0..zip.len() {
            let mut entry = zip
                .by_index(i)
                .map_err(|e| KittenError::Voice(e.to_string()))?;
            let name = entry.name().to_string();
            let id = name.strip_suffix(".npy").unwrap_or(&name).to_string();
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry
                .read_to_end(&mut bytes)
                .map_err(|e| KittenError::Voice(e.to_string()))?;
            let (data, rows) = parse_npy_f32_rows(&bytes, KITTEN_STYLE_DIM)?;
            voices.insert(id, KittenVoiceStyle { data, rows });
        }
        if voices.is_empty() {
            return Err(KittenError::Voice("voices.npz contained no voices".into()));
        }
        Ok(Self { voices })
    }

    fn get(&self, voice_id: &str) -> KittenResult<&KittenVoiceStyle> {
        if let Some(v) = self.voices.get(voice_id) {
            return Ok(v);
        }
        // fall back to the default voice if the requested one is unknown
        self.voices
            .get(KITTEN_DEFAULT_VOICE)
            .or_else(|| self.voices.values().next())
            .ok_or_else(|| KittenError::Voice(format!("unknown voice id '{voice_id}'")))
    }

    fn ids(&self) -> impl Iterator<Item = &str> {
        self.voices.keys().map(|s| s.as_str())
    }
}

/// Minimal little-endian `<f4` `.npy` parser → (flat f32, rows) where
/// `rows = total / dim`. Accepts v1/v2 headers, C-order only.
fn parse_npy_f32_rows(bytes: &[u8], dim: usize) -> KittenResult<(Vec<f32>, usize)> {
    const MAGIC: &[u8] = b"\x93NUMPY";
    if bytes.len() < 10 || &bytes[0..6] != MAGIC {
        return Err(KittenError::Voice("bad .npy magic".into()));
    }
    let major = bytes[6];
    let (header_len, header_start) = if major >= 2 {
        if bytes.len() < 12 {
            return Err(KittenError::Voice("truncated .npy v2 header".into()));
        }
        (
            u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize,
            12usize,
        )
    } else {
        (u16::from_le_bytes([bytes[8], bytes[9]]) as usize, 10usize)
    };
    let header_end = header_start + header_len;
    if bytes.len() < header_end {
        return Err(KittenError::Voice("truncated .npy header".into()));
    }
    let header = std::str::from_utf8(&bytes[header_start..header_end])
        .map_err(|_| KittenError::Voice("non-utf8 .npy header".into()))?;
    if !header.contains("<f4") {
        return Err(KittenError::Voice(format!("voice dtype not <f4: {header}")));
    }
    if header.contains("'fortran_order': True") {
        return Err(KittenError::Voice("fortran-order voice unsupported".into()));
    }
    let payload = &bytes[header_end..];
    if !payload.len().is_multiple_of(4) {
        return Err(KittenError::Voice("voice payload not f32-aligned".into()));
    }
    let count = payload.len() / 4;
    if dim == 0 || !count.is_multiple_of(dim) {
        return Err(KittenError::Voice(format!(
            "voice payload {count} floats not a multiple of dim {dim}"
        )));
    }
    let mut data = Vec::with_capacity(count);
    for chunk in payload.chunks_exact(4) {
        data.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok((data, count / dim))
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct KittenConfig {
    pub cache_dir: PathBuf,
    pub model_filename: String,
    pub voices_filename: String,
    pub device: KittenDevice,
}
impl Default for KittenConfig {
    fn default() -> Self {
        Self {
            cache_dir: PathBuf::new(),
            model_filename: "kitten_tts_nano_v0_1.onnx".to_string(),
            voices_filename: "voices.npz".to_string(),
            device: KittenDevice::Cpu,
        }
    }
}
impl KittenConfig {
    pub fn model_path(&self) -> PathBuf {
        self.cache_dir.join(&self.model_filename)
    }
    pub fn voices_path(&self) -> PathBuf {
        self.cache_dir.join(&self.voices_filename)
    }
    pub fn assets_present(&self) -> bool {
        self.model_path().exists() && self.voices_path().exists()
    }
}

struct LoadedKitten {
    session: ort::session::Session,
    voices: KittenVoices,
    active_providers: Vec<String>,
}

pub struct KittenEngine {
    config: KittenConfig,
    inner: Mutex<Option<LoadedKitten>>,
    phonemizer: Box<dyn Phonemizer>,
    ready: AtomicBool,
}

impl KittenEngine {
    pub fn new(config: KittenConfig) -> Self {
        Self {
            config,
            inner: Mutex::new(None),
            phonemizer: default_phonemizer(),
            ready: AtomicBool::new(false),
        }
    }
    pub fn with_phonemizer(config: KittenConfig, phonemizer: Box<dyn Phonemizer>) -> Self {
        Self {
            config,
            inner: Mutex::new(None),
            phonemizer,
            ready: AtomicBool::new(false),
        }
    }
    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }
    pub fn active_providers(&self) -> Vec<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|k| k.active_providers.clone()))
            .unwrap_or_default()
    }

    pub fn warm_up(&self) -> KittenResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| KittenError::Session("kitten lock poisoned".into()))?;
        if guard.is_some() {
            return Ok(());
        }
        if !self.config.assets_present() {
            return Err(KittenError::AssetsMissing(format!(
                "expected {} and {}",
                self.config.model_path().display(),
                self.config.voices_path().display()
            )));
        }
        *guard = Some(self.load()?);
        self.ready.store(true, Ordering::Release);
        Ok(())
    }

    /// Synthesize ONE sentence → mono f32 PCM @ 24 kHz. `lang` is accepted for
    /// trait parity but KittenTTS is English-only (espeak voice en-us).
    pub fn synthesize(
        &self,
        text: &str,
        voice: &str,
        _lang: &str,
        speed: f32,
    ) -> KittenResult<Vec<f32>> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        // espeak IPA (with stress; spaces preserved) — KittenTTS is en-us only.
        let phonemes = self
            .phonemizer
            .phonemize(trimmed, "en-us")
            .map_err(|e| KittenError::Phonemize(e.to_string()))?;
        let mapped = kitten_text_to_ids(&phonemes);
        if mapped.is_empty() {
            return Ok(Vec::new());
        }
        // [0] ++ ids ++ [0] (v0.1 / kitten_tts_nano_v0_1.onnx — no middle 10).
        let mut input_ids = Vec::with_capacity(mapped.len() + 2);
        input_ids.push(0i64);
        input_ids.extend_from_slice(&mapped);
        input_ids.push(0i64);

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| KittenError::Session("kitten lock poisoned".into()))?;
        if guard.is_none() {
            if !self.config.assets_present() {
                return Err(KittenError::AssetsMissing(format!(
                    "expected {} and {}",
                    self.config.model_path().display(),
                    self.config.voices_path().display()
                )));
            }
            *guard = Some(self.load()?);
            self.ready.store(true, Ordering::Release);
        }
        let loaded = guard.as_mut().expect("just initialized");

        // Style row indexed by RAW INPUT TEXT char count (NOT token count).
        let text_chars = trimmed.chars().count();
        let style_row = loaded.voices.get(voice)?.row_for(text_chars).to_vec();
        self.run_inference(loaded, &input_ids, &style_row, speed)
    }

    fn load(&self) -> KittenResult<LoadedKitten> {
        let voices = KittenVoices::load(&self.config.voices_path())?;
        let (session, active_providers) = self.build_session()?;
        Ok(LoadedKitten {
            session,
            voices,
            active_providers,
        })
    }

    /// CPU-only session (StyleTTS2 graphs share Kokoro's DML ConvTranspose risk;
    /// 15M params is CPU-fast). Full intra-op pool (no `with_intra_threads(1)`).
    fn build_session(&self) -> KittenResult<(ort::session::Session, Vec<String>)> {
        use ort::execution_providers::{CPUExecutionProvider, ExecutionProviderDispatch};
        let model_path = self.config.model_path();
        let dispatch: Vec<ExecutionProviderDispatch> =
            vec![CPUExecutionProvider::default().build()];
        let active = vec!["CPUExecutionProvider".to_string()];
        let mut builder = ort::session::Session::builder()
            .map_err(|e| KittenError::Session(format!("session builder: {e}")))?
            .with_execution_providers(dispatch)
            .map_err(|e| KittenError::Session(format!("register EPs: {e}")))?;
        let session = builder
            .commit_from_file(&model_path)
            .map_err(|e| KittenError::Session(format!("commit_from_file: {e}")))?;
        Ok((session, active))
    }

    fn run_inference(
        &self,
        loaded: &mut LoadedKitten,
        input_ids: &[i64],
        style_row: &[f32],
        speed: f32,
    ) -> KittenResult<Vec<f32>> {
        use ort::value::Tensor;
        let n = input_ids.len();
        let ids_tensor = Tensor::from_array(([1usize, n], input_ids.to_vec().into_boxed_slice()))
            .map_err(|e| KittenError::Session(format!("input_ids tensor: {e}")))?;
        let style_tensor = Tensor::from_array((
            [1usize, KITTEN_STYLE_DIM],
            style_row.to_vec().into_boxed_slice(),
        ))
        .map_err(|e| KittenError::Session(format!("style tensor: {e}")))?;
        let speed_tensor = Tensor::from_array(([1usize], vec![speed].into_boxed_slice()))
            .map_err(|e| KittenError::Session(format!("speed tensor: {e}")))?;
        let outputs = loaded
            .session
            .run(ort::inputs! {
                "input_ids" => ids_tensor,
                "style" => style_tensor,
                "speed" => speed_tensor,
            })
            .map_err(|e| KittenError::Session(format!("inference: {e}")))?;
        let (_shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| KittenError::Session(format!("extract audio: {e}")))?;
        // Fixed tail crop of 5000 samples (KittenML behaviour); clamp for short clips.
        let keep = data.len().saturating_sub(KITTEN_TAIL_CROP);
        Ok(data[..keep].to_vec())
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
        self.ready.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbol_table_is_178_positions() {
        assert_eq!(
            kitten_symbol_count(),
            178,
            "StyleTTS2 symbol table must be 178 positions"
        );
    }

    #[test]
    fn vocab_core_mappings() {
        let v = kitten_vocab();
        assert_eq!(v.get(&'$'), Some(&0)); // pad
        assert_eq!(v.get(&';'), Some(&1)); // first punctuation
        assert_eq!(v.get(&' '), Some(&16)); // last punctuation (space)
        assert_eq!(v.get(&'A'), Some(&17)); // first letter
        assert_eq!(v.get(&'Z'), Some(&42));
        assert_eq!(v.get(&'a'), Some(&43));
        assert_eq!(v.get(&'z'), Some(&68));
        assert_eq!(v.get(&'\u{0251}'), Some(&69)); // ɑ — first IPA
                                                   // ascii 'g' IS in the dense table (unlike Kokoro), at letter position.
        assert!(v.get(&'g').is_some());
    }

    #[test]
    fn basic_tokenize_respaces_punctuation() {
        // "ðə, kwɪk." → word/punct split, single-space join.
        let ids = kitten_text_to_ids("\u{00F0}\u{0259}, kw\u{026A}k.");
        assert!(!ids.is_empty());
    }

    #[test]
    fn npy_parser_rows() {
        // build a [2,256] f32 npy
        let rows = 2usize;
        let total = rows * KITTEN_STYLE_DIM;
        let data: Vec<f32> = (0..total).map(|i| i as f32).collect();
        let header = format!(
            "{{'descr': '<f4', 'fortran_order': False, 'shape': ({rows}, {KITTEN_STYLE_DIM}), }}"
        );
        let mut hb = header.into_bytes();
        let unpadded = 10 + hb.len() + 1;
        let pad = (64 - (unpadded % 64)) % 64;
        hb.extend(std::iter::repeat_n(b' ', pad));
        hb.push(b'\n');
        let mut buf = Vec::new();
        buf.extend_from_slice(b"\x93NUMPY");
        buf.push(1);
        buf.push(0);
        buf.extend_from_slice(&(hb.len() as u16).to_le_bytes());
        buf.extend_from_slice(&hb);
        for f in &data {
            buf.extend_from_slice(&f.to_le_bytes());
        }
        let (out, r) = parse_npy_f32_rows(&buf, KITTEN_STYLE_DIM).unwrap();
        assert_eq!(r, rows);
        assert_eq!(out.len(), total);
    }
}
