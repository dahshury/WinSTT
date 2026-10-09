// Paradee-8M (sahilmahendrakar/Paradee-8M-v1.0, Apache-2.0) — an 8.07M-parameter single-voice
// English TTS distilled from Kokoro-82M (teacher voice `af_heart`), shipped by its author as ONE
// ONNX graph. Reference: `paradee/tts.py` + `web/misaki.js` in github.com/sahilmahendrakar/paradee.
//
//   text --eSpeak-ng IPA (en-us)--> --eSpeak→misaki respelling--> phonemes
//        --Kokoro v1.0 vocab (identical to Paradee's config.json "vocab")--> ids
//        --[0] ++ ids[..510] ++ [0]--> input_ids
//   inputs : input_ids [1, T] i64 (T <= 512), speed [1] f32
//   output : waveform  [1, N] f32 @ 24 kHz mono
//
// Differences from kokoro.rs: NO style/voice input (the af_heart voice is baked into the weights),
// and the phonemes MUST be in misaki's spelling — Paradee only ever saw misaki in training and
// mumbles on raw eSpeak spelling (see `phonemize::misaki`). The graph already contains the
// author's phase-locking filter, so no post-processing beyond the silence trim is needed.

use std::path::PathBuf;

use super::phonemize::{MisakiPhonemizer, Phonemizer, default_phonemizer, vocab};
use super::provider::LazyOrtEngine;

/// Paradee emits 24 kHz mono float PCM (config.json `sample_rate`).
pub const PARADEE_SAMPLE_RATE: u32 = 24_000;
/// The one voice Paradee speaks (its teacher's) — also the only `VoiceInfo` id.
pub const PARADEE_VOICE: &str = "af_heart";
/// The graph WinSTT ships (under `onnx/` on the hub and in the cache dir). The int8 rung is
/// the one its author recommends; the 4x larger fp32 graph "sounds the same".
pub const PARADEE_GRAPH: &str = "paradee_int8.onnx";
/// The text side has 512 positions, two of which are the pad tokens at each end.
const PARADEE_MAX_IDS: usize = 510;
/// The Kokoro vocab id of a space — where an over-long phoneme run is cut.
const SPACE_ID: i64 = 16;
/// Paradee speaks American English only.
const PARADEE_LANG: &str = "en-us";

#[derive(Debug, thiserror::Error)]
pub enum ParadeeError {
    #[error("paradee assets missing: {0}")]
    AssetsMissing(String),
    #[error("paradee session error: {0}")]
    Session(String),
    #[error("paradee phonemize error: {0}")]
    Phonemize(String),
}
pub type ParadeeResult<T> = Result<T, ParadeeError>;

/// Map misaki phonemes to Kokoro vocab ids (unknown symbols dropped, like the reference's
/// `[vocab[c] for c in phonemes if c in vocab]`).
fn phonemes_to_ids(phonemes: &str) -> Vec<i64> {
    let vocab = vocab();
    phonemes
        .chars()
        .filter_map(|c| vocab.get(&c).copied())
        .collect()
}

/// Split ids into model-sized runs: a run longer than [`PARADEE_MAX_IDS`] is cut at its last space
/// that fits (the reference's `ps.rfind(" ", 0, MAX_PHONEMES)`), or hard at the limit when there is
/// none. Leading spaces of the remainder are dropped. Each run is returned PADDED (`[0, .., 0]`).
fn padded_runs(ids: &[i64]) -> Vec<Vec<i64>> {
    let mut runs = Vec::new();
    let mut rest = ids;
    while !rest.is_empty() {
        let take = if rest.len() <= PARADEE_MAX_IDS {
            rest.len()
        } else {
            rest[..PARADEE_MAX_IDS]
                .iter()
                .rposition(|&id| id == SPACE_ID)
                .filter(|&cut| cut > 0)
                .unwrap_or(PARADEE_MAX_IDS)
        };
        let mut run = Vec::with_capacity(take + 2);
        run.push(0);
        run.extend_from_slice(&rest[..take]);
        run.push(0);
        runs.push(run);
        rest = &rest[take..];
        while rest.first() == Some(&SPACE_ID) {
            rest = &rest[1..];
        }
    }
    runs
}

#[derive(Clone, Debug)]
pub struct ParadeeConfig {
    /// `%LOCALAPPDATA%/winstt/tts/paradee-8m/` (holds `onnx/<graph>` as on the hub).
    pub cache_dir: PathBuf,
    /// Graph path relative to `cache_dir` (`onnx/paradee_int8.onnx` or `onnx/paradee.onnx`).
    pub model_file: String,
}
impl ParadeeConfig {
    /// The shipping layout: `<cache_dir>/onnx/`[`PARADEE_GRAPH`].
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir,
            model_file: format!("onnx/{PARADEE_GRAPH}"),
        }
    }

    pub fn model_path(&self) -> PathBuf {
        self.cache_dir.join(&self.model_file)
    }
}

struct LoadedParadee {
    session: ort::session::Session,
}

pub struct ParadeeEngine {
    config: ParadeeConfig,
    inner: LazyOrtEngine<LoadedParadee>,
    phonemizer: Box<dyn Phonemizer>,
}

impl ParadeeEngine {
    /// The shipping engine: eSpeak-ng G2P respelled to misaki.
    pub fn new(config: ParadeeConfig) -> Self {
        Self::with_phonemizer(
            config,
            Box::new(MisakiPhonemizer::new(default_phonemizer(), &[PARADEE_LANG])),
        )
    }

    /// Inject the G2P (tests / the WER probe, which compares raw eSpeak against misaki).
    pub fn with_phonemizer(config: ParadeeConfig, phonemizer: Box<dyn Phonemizer>) -> Self {
        Self {
            config,
            inner: LazyOrtEngine::new(),
            phonemizer,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.inner.is_ready()
    }

    fn assets_missing(&self) -> ParadeeError {
        ParadeeError::AssetsMissing(format!("expected {}", self.config.model_path().display()))
    }

    pub fn warm_up(&self) -> ParadeeResult<()> {
        self.inner.warm_up(
            || ParadeeError::Session("paradee lock poisoned".into()),
            || self.load(),
        )
    }

    fn load(&self) -> ParadeeResult<LoadedParadee> {
        let path = self.config.model_path();
        if !path.exists() {
            return Err(self.assets_missing());
        }
        // 8M params of convolutions: CPU is the only sensible target (and the StyleTTS2-style
        // ConvTranspose path is the one that hard-fails on DirectML for Kokoro).
        let session = super::provider::cpu_session(
            &path,
            "8M StyleTTS2-derived graph; DirectML ConvTranspose path unvalidated",
            "Paradee",
        )
        .map_err(ParadeeError::Session)?;
        Ok(LoadedParadee { session })
    }

    /// The phoneme string the engine would feed the model for `text` (diagnostics / tests).
    pub fn phonemes(&self, text: &str) -> ParadeeResult<String> {
        self.phonemizer
            .phonemize(text.trim(), PARADEE_LANG)
            .map_err(|e| ParadeeError::Phonemize(e.to_string()))
    }

    /// Synthesize ONE sentence → mono f32 PCM @ 24 kHz. Paradee is English-only and has one
    /// voice, so there is no voice/lang argument.
    pub fn synthesize(&self, text: &str, speed: f32) -> ParadeeResult<Vec<f32>> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let ids = phonemes_to_ids(&self.phonemes(trimmed)?);
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let runs = padded_runs(&ids);
        self.inner.with_loaded(
            || ParadeeError::Session("paradee lock poisoned".into()),
            || ParadeeError::Session("paradee session was not initialized".into()),
            || self.load(),
            |loaded| {
                let mut audio = Vec::new();
                for run in &runs {
                    audio.extend(run_graph(&mut loaded.session, run, speed)?);
                }
                Ok(super::kokoro::trim_silence(&audio))
            },
        )
    }

    pub fn shutdown(&self) {
        self.inner.shutdown();
    }
}

fn run_graph(
    session: &mut ort::session::Session,
    padded_ids: &[i64],
    speed: f32,
) -> ParadeeResult<Vec<f32>> {
    use ort::value::Tensor;
    let ids = Tensor::from_array((
        [1usize, padded_ids.len()],
        padded_ids.to_vec().into_boxed_slice(),
    ))
    .map_err(|e| ParadeeError::Session(format!("input_ids tensor: {e}")))?;
    let speed = Tensor::from_array(([1usize], vec![speed].into_boxed_slice()))
        .map_err(|e| ParadeeError::Session(format!("speed tensor: {e}")))?;
    let outputs = session
        .run(ort::inputs! { "input_ids" => ids, "speed" => speed })
        .map_err(|e| ParadeeError::Session(format!("inference: {e}")))?;
    let (_shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|e| ParadeeError::Session(format!("extract waveform: {e}")))?;
    Ok(data.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_use_the_kokoro_vocab_and_drop_unknowns() {
        // ˈ=156, I=25, space=16; the digit is not a token.
        assert_eq!(phonemes_to_ids("ˈI 7"), vec![156, 25, 16]);
    }

    #[test]
    fn short_runs_are_padded_once() {
        assert_eq!(padded_runs(&[5, 16, 6]), vec![vec![0, 5, 16, 6, 0]]);
        assert!(padded_runs(&[]).is_empty());
    }

    #[test]
    fn long_runs_cut_at_the_last_space_that_fits() {
        // 600 ids with a space at 400: the first run ends before it, the second starts after it.
        let mut ids = vec![43i64; 600];
        ids[400] = SPACE_ID;
        let runs = padded_runs(&ids);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].len(), 400 + 2);
        assert_eq!(runs[1].len(), 199 + 2);
        assert!(runs.iter().all(|r| r.len() <= PARADEE_MAX_IDS + 2));
        assert!(runs.iter().all(|r| r[0] == 0 && *r.last().unwrap() == 0));
    }

    #[test]
    fn spaceless_overflow_is_cut_hard_at_the_limit() {
        let runs = padded_runs(&vec![43i64; 1100]);
        let lens: Vec<usize> = runs.iter().map(Vec::len).collect();
        assert_eq!(lens, vec![512, 512, 82]);
    }

    /// Real-weights probe: synthesizes `WINSTT_G2P_SENTENCES` (one per line) with Paradee through
    /// BOTH the raw eSpeak spelling and the misaki respelling, writing
    /// `paradee_{espeak,misaki}_{NN}.wav` + the phoneme strings into `WINSTT_G2P_OUT` for an
    /// external ASR/WER pass. Needs the eSpeak-ng shared lib (`ESPEAK_NG_LIBRARY`) and
    /// `WINSTT_PARADEE_DIR` (a local copy of the HF repo).
    #[test]
    #[ignore = "needs the Paradee weights + eSpeak-ng; see the doc comment"]
    fn paradee_g2p_probe_writes_wavs() {
        use super::super::phonemize::EspeakLibPhonemizer;
        let dir = PathBuf::from(std::env::var("WINSTT_PARADEE_DIR").expect("WINSTT_PARADEE_DIR"));
        let out = PathBuf::from(std::env::var("WINSTT_G2P_OUT").expect("WINSTT_G2P_OUT"));
        let text = std::fs::read_to_string(std::env::var("WINSTT_G2P_SENTENCES").unwrap()).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        let espeak = || {
            Box::new(EspeakLibPhonemizer::discover().expect("espeak lib")) as Box<dyn Phonemizer>
        };
        let mut config = ParadeeConfig::new(dir);
        if let Ok(graph) = std::env::var("WINSTT_PARADEE_GRAPH") {
            config.model_file = graph;
        }
        for (tag, engine) in [
            (
                "espeak",
                ParadeeEngine::with_phonemizer(config.clone(), espeak()),
            ),
            (
                "misaki",
                ParadeeEngine::with_phonemizer(
                    config,
                    Box::new(MisakiPhonemizer::new(espeak(), &[PARADEE_LANG])),
                ),
            ),
        ] {
            let mut log = String::new();
            let t = std::time::Instant::now();
            let mut total = 0usize;
            for (i, line) in text.lines().filter(|l| !l.trim().is_empty()).enumerate() {
                let pcm = engine.synthesize(line, 1.0).expect("synthesize");
                total += pcm.len();
                log.push_str(&format!("{i:02}\t{}\n", engine.phonemes(line).unwrap()));
                crate::winstt::tts::write_probe_wav(
                    &out.join(format!("paradee_{tag}_{i:02}.wav")),
                    &pcm,
                    PARADEE_SAMPLE_RATE,
                );
            }
            let secs = total as f64 / f64::from(PARADEE_SAMPLE_RATE);
            println!(
                "PARADEE {tag}: {secs:.1}s audio in {:.2}s (RTF {:.3})",
                t.elapsed().as_secs_f64(),
                t.elapsed().as_secs_f64() / secs
            );
            std::fs::write(out.join(format!("paradee_{tag}_phonemes.tsv")), log).unwrap();
        }
    }
}
