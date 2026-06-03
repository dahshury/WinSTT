// Source: thewh1teagle/kokoro-onnx (src/kokoro_onnx/{__init__.py,config.py}),
//   server/src/synthesizer/infrastructure/{kokoro_synthesizer.py,asset_downloader.py},
//   docs.rs/ort/2.0.0-rc.12 (Session, inputs!, Value, Tensor, execution_providers),
//   docs.rs/zip/8.6 (ZipArchive for the npz voice pack).
//
// In-process Kokoro-82M TTS on OUR ort 2.0.0-rc.12 (NOT kokoroxide — it pins yanked ort 1.16).
// Runs the Kokoro-82M ONNX directly:
//   inputs  : input_ids [1, N+2] i64 (0-padded), style [1, 256] f32 (voice[token_count]),
//             speed [1] f32
//   output  : audio [num_samples] f32 @ 24 kHz mono
//
// The ONNX graph + voice pack are downloaded on first warm-up (the engine code itself is compiled
// in, unlike the Python sys.path support pack — only the two model FILES are fetched). espeak-ng
// G2P lives in `phonemize.rs` (process-separated → GPL "mere aggregation"; see PORT/06_tts.md §1).

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use super::phonemize::{default_phonemizer, Phonemizer, MAX_PHONEME_LENGTH};

/// Kokoro v1.0 emits 24 kHz mono float PCM.
pub const KOKORO_SAMPLE_RATE: u32 = 24_000;
/// Style/voice-embedding dimensionality (the third axis of a `[510,1,256]` pack).
pub const STYLE_DIM: usize = 256;

/// Pinned upstream model-file URLs (PORT/06_tts.md §3; same release the Python
/// downloader uses). Overridable via env for CI / self-host.
/// Kokoro is now a normal HF ONNX model (onnx-community), downloaded through the
/// shared TTS download manager like every other engine — NOT its old
/// thewh1teagle GitHub-release single-npz path. The fp16 graph lives under
/// `onnx/`; each voice is an individual raw-f32 `voices/<id>.bin`.
pub const KOKORO_HF_REPO: &str = "onnx-community/Kokoro-82M-v1.0-ONNX";
pub const KOKORO_FP16_URL: &str =
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_fp16.onnx";

/// EP intent — mirrors the STT slice's `Accelerator` collapse. Kokoro is
/// DirectML-SAFE (82M fp16, NOT in the int8 DML-incompatible STT families), so
/// it follows the model device with a graceful CPU demotion on session-create
/// failure (like WinSTT's CUDA→CPU path).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KokoroDevice {
    Auto,
    DirectMl,
    Cpu,
}

#[derive(Debug)]
pub enum KokoroError {
    /// A model file is missing and `download_assets` was not run / failed.
    AssetsMissing(String),
    /// ONNX session create / inference failure.
    Session(String),
    /// Voice pack parse / unknown voice / token-length overflow.
    Voice(String),
    /// G2P (phonemize) failed.
    Phonemize(String),
}

impl std::fmt::Display for KokoroError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KokoroError::AssetsMissing(m) => write!(f, "kokoro assets missing: {m}"),
            KokoroError::Session(m) => write!(f, "kokoro session error: {m}"),
            KokoroError::Voice(m) => write!(f, "kokoro voice error: {m}"),
            KokoroError::Phonemize(m) => write!(f, "kokoro phonemize error: {m}"),
        }
    }
}

impl std::error::Error for KokoroError {}

pub type KokoroResult<T> = Result<T, KokoroError>;

// ---------------------------------------------------------------------------
// Voice pack — voices-v1.0.bin is an npz (zip of named .npy), one entry per
// voice id, each a [510, 1, 256] f32 array. We select `voice[token_count]`
// → a 256-dim style vector (the Python `voice = voice[len(tokens)]`).
// ---------------------------------------------------------------------------

/// One voice's style table: 510 rows of `STYLE_DIM` floats, flattened.
/// Row `k` is the style vector for an input of `k` UNPADDED tokens.
#[derive(Clone)]
pub struct VoiceStyle {
    /// `rows * STYLE_DIM` f32, row-major. `rows` == MAX_PHONEME_LENGTH.
    data: Vec<f32>,
    rows: usize,
}

impl VoiceStyle {
    /// The 256-dim style vector for a token sequence of length `token_count`,
    /// where `token_count` is the UNPADDED count. Mirrors kokoro_onnx's
    /// `voice = voice[len(tokens)]`, evaluated BEFORE the `[0, *tokens, 0]` pad.
    pub fn row_for(&self, token_count: usize) -> KokoroResult<&[f32]> {
        if token_count >= self.rows {
            return Err(KokoroError::Voice(format!(
                "token count {token_count} >= voice-pack rows {}",
                self.rows
            )));
        }
        let start = token_count * STYLE_DIM;
        Ok(&self.data[start..start + STYLE_DIM])
    }
}

/// Dir-backed voice pack: loads each voice from `voices/<id>.bin` (raw
/// little-endian f32, shape `[rows, 256]`, NO npy/npz header — the
/// onnx-community Kokoro layout, 522240 bytes = 510*256*4 per voice) on first
/// use and caches it. Unifies Kokoro with the other ONNX TTS engines (HF source
/// + per-file download via the shared TTS download manager).
pub struct VoicePack {
    dir: PathBuf,
    cache: Mutex<HashMap<String, VoiceStyle>>,
}

impl VoicePack {
    /// Bind to the directory that holds the per-voice `<id>.bin` files. Files are
    /// loaded lazily (not all 54 at warm-up).
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The 256-dim style row for `voice_id` at the UNPADDED `token_count`. Loads +
    /// caches the voice's raw `.bin` on first access; returns an owned Vec (the
    /// cached table lives behind the Mutex, so we can't hand out a borrow).
    pub fn style_row(&self, voice_id: &str, token_count: usize) -> KokoroResult<Vec<f32>> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| KokoroError::Voice("voice cache poisoned".into()))?;
        if !cache.contains_key(voice_id) {
            let path = self.dir.join(format!("{voice_id}.bin"));
            let style = load_voice_bin(&path)?;
            cache.insert(voice_id.to_string(), style);
        }
        let style = cache.get(voice_id).expect("just inserted");
        Ok(style.row_for(token_count)?.to_vec())
    }
}

/// Load a raw little-endian f32 voice file (`[rows, 256]`, NO header — the
/// onnx-community `voices/<id>.bin` format). The legacy `af.bin` (512 rows) also
/// parses; only the 55 named voices are used by the catalog.
fn load_voice_bin(path: &Path) -> KokoroResult<VoiceStyle> {
    let bytes = std::fs::read(path).map_err(|e| KokoroError::AssetsMissing(e.to_string()))?;
    if !bytes.len().is_multiple_of(4) {
        return Err(KokoroError::Voice("voice .bin not f32-aligned".into()));
    }
    let count = bytes.len() / 4;
    if count == 0 || !count.is_multiple_of(STYLE_DIM) {
        return Err(KokoroError::Voice(format!(
            "voice .bin {count} floats not a multiple of style dim {STYLE_DIM}"
        )));
    }
    let mut data = Vec::with_capacity(count);
    for chunk in bytes.chunks_exact(4) {
        data.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(VoiceStyle {
        data,
        rows: count / STYLE_DIM,
    })
}

// ---------------------------------------------------------------------------
// The ONNX engine
// ---------------------------------------------------------------------------

/// Configuration for the local Kokoro engine.
#[derive(Clone, Debug)]
pub struct KokoroConfig {
    /// `%LOCALAPPDATA%/winstt/tts/kokoro-82m` (host-resolved). Holds `onnx/<graph>`
    /// + `voices/<id>.bin` (onnx-community layout).
    pub cache_dir: PathBuf,
    /// fp16 graph basename under `onnx/` (`model_fp16.onnx` by default).
    pub model_filename: String,
    /// Subdir holding the per-voice raw `.bin` files (`voices` by default).
    pub voices_dir: String,
    pub device: KokoroDevice,
}

impl Default for KokoroConfig {
    fn default() -> Self {
        Self {
            cache_dir: PathBuf::new(),
            model_filename: "model_fp16.onnx".to_string(),
            voices_dir: "voices".to_string(),
            device: KokoroDevice::Auto,
        }
    }
}

impl KokoroConfig {
    pub fn model_path(&self) -> PathBuf {
        self.cache_dir.join("onnx").join(&self.model_filename)
    }
    pub fn voices_dir_path(&self) -> PathBuf {
        self.cache_dir.join(&self.voices_dir)
    }
    pub fn voice_path(&self, voice_id: &str) -> PathBuf {
        self.voices_dir_path().join(format!("{voice_id}.bin"))
    }
    /// True once the model graph + the default voice are on disk (we no longer
    /// ship all voices in one blob, so presence == graph + at least af_heart).
    pub fn assets_present(&self) -> bool {
        self.model_path().exists() && self.voice_path("af_heart").exists()
    }
}

/// Loaded ONNX session + voice pack + phonemizer. Created lazily on warm-up so
/// the ~190 MB first-run download / multi-second session-create never runs on a
/// UI thread (the host calls `warm_up`/`synthesize` from a blocking thread).
struct LoadedKokoro {
    session: ort::session::Session,
    voices: VoicePack,
    /// Active EPs after fallback (for logging which path engaged).
    active_providers: Vec<String>,
    /// The model input name for the token ids — newer Kokoro exports use
    /// `input_ids`, older ones `tokens`. Detected at load from the graph.
    tokens_input: String,
    /// Whether the `speed` input is i64 (newer) or f32 (older). Detected at load.
    speed_is_f32: bool,
}

/// In-process Kokoro-82M engine on ort. `Send + Sync` via the inner `Mutex`
/// (ORT sessions are not re-entrant — mirrors the Python `_synth_lock`).
pub struct KokoroEngine {
    config: KokoroConfig,
    inner: Mutex<Option<LoadedKokoro>>,
    phonemizer: Box<dyn Phonemizer>,
    ready: AtomicBool,
}

impl KokoroEngine {
    pub fn new(config: KokoroConfig) -> Self {
        Self {
            config,
            inner: Mutex::new(None),
            phonemizer: default_phonemizer(),
            ready: AtomicBool::new(false),
        }
    }

    /// Inject a specific phonemizer (tests, or a host that pre-resolved espeak).
    pub fn with_phonemizer(config: KokoroConfig, phonemizer: Box<dyn Phonemizer>) -> Self {
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

    /// Force the ONNX session + voice pack load NOW (blocking, idempotent).
    /// Assets must already be on disk (the host runs `download_assets` first via
    /// the shared resumable downloader). Returns Ok once `ready`.
    pub fn warm_up(&self) -> KokoroResult<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| KokoroError::Session("kokoro engine lock poisoned".into()))?;
        if guard.is_some() {
            return Ok(());
        }
        if !self.config.assets_present() {
            return Err(KokoroError::AssetsMissing(format!(
                "expected {} and {}",
                self.config.model_path().display(),
                self.config.voices_dir_path().display()
            )));
        }
        let loaded = self.load()?;
        *guard = Some(loaded);
        self.ready.store(true, Ordering::Release);
        Ok(())
    }

    /// Synthesize ONE sentence → mono f32 PCM @ 24 kHz. Blocking. Lazily warms
    /// up on first call. `speed` is pre-clamped by the caller.
    pub fn synthesize(
        &self,
        text: &str,
        voice: &str,
        lang: &str,
        speed: f32,
    ) -> KokoroResult<Vec<f32>> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        // G2P → token ids (vocab-filtered, no padding yet).
        let tokens = self
            .phonemizer
            .text_to_tokens(trimmed, lang)
            .map_err(|e| KokoroError::Phonemize(e.to_string()))?;
        if tokens.is_empty() {
            return Ok(Vec::new());
        }
        // Pad: [0, *tokens, 0] for the MODEL INPUT only. NOTE: the style-table index
        // uses the UNPADDED token count (see below), not this padded length.
        let mut padded = Vec::with_capacity(tokens.len() + 2);
        padded.push(0i64);
        padded.extend_from_slice(&tokens);
        padded.push(0i64);
        if padded.len() > MAX_PHONEME_LENGTH {
            return Err(KokoroError::Voice(format!(
                "padded token length {} exceeds {}",
                padded.len(),
                MAX_PHONEME_LENGTH
            )));
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| KokoroError::Session("kokoro engine lock poisoned".into()))?;
        if guard.is_none() {
            if !self.config.assets_present() {
                return Err(KokoroError::AssetsMissing(format!(
                    "expected {} and {}",
                    self.config.model_path().display(),
                    self.config.voices_dir_path().display()
                )));
            }
            *guard = Some(self.load()?);
            self.ready.store(true, Ordering::Release);
        }
        let loaded = guard.as_mut().expect("just initialized");

        // Style vector for the UNPADDED token count. kokoro_onnx does
        // `voice = voice[len(tokens)]` BEFORE padding to `[0, *tokens, 0]`, so the row
        // index is `tokens.len()`, NOT the padded length. Indexing at `padded.len()`
        // (tokens.len()+2) picked the wrong style row → wrong prosody and a longer clip
        // (81000 vs the reference's 65536 samples on the JFK sentence). Match the reference exactly.
        let style_row = loaded.voices.style_row(voice, tokens.len())?;
        self.run_inference(loaded, &padded, &style_row, speed)
    }

    /// Build the ORT session + parse the voice pack + detect the input schema.
    fn load(&self) -> KokoroResult<LoadedKokoro> {
        let voices = VoicePack::new(self.config.voices_dir_path());
        let (session, active_providers) = self.build_session()?;

        // Detect the token-input key from the graph's input node names: the
        // onnx-community export uses `input_ids`, the older kokoro-v1.0 export
        // `tokens`. BOTH take `style [1,256] f32` + `speed [1] f32` — verified at
        // runtime: the onnx-community model rejects an int64 speed
        // ("Unexpected input data type ... expected (tensor(float))"). So speed is
        // always f32 here (the i64 path in run_inference is kept as a guard but
        // unused by the shipped exports).
        let names = input_node_names(&session);
        let tokens_input = if names.iter().any(|n| n == "input_ids") {
            "input_ids".to_string()
        } else {
            "tokens".to_string()
        };
        let speed_is_f32 = true;

        Ok(LoadedKokoro {
            session,
            voices,
            active_providers,
            tokens_input,
            speed_is_f32,
        })
    }

    /// Create the ORT session. Kokoro is **CPU-only**: the kokoro-v1.0 fp16 export's
    /// `/encoder/F0.1/pool/ConvTranspose` HARD-FAILS on DirectML with
    /// `80070057 The parameter is incorrect` — not a clean unsupported-op CPU
    /// fallback, an actual runtime crash. PROVEN identically by BOTH the Python
    /// `kokoro_onnx` path (the reference) and this Rust path (see the tts benchmark), so
    /// the upstream the reference app is likewise CPU-only for Kokoro. We therefore never
    /// register the DirectML EP here regardless of the requested device. An 82M model
    /// on CPU is fast — and faster than DML's per-op launch overhead would be at this
    /// size — once we let ORT use its full intra-op thread pool (below).
    fn build_session(&self) -> KokoroResult<(ort::session::Session, Vec<String>)> {
        use ort::execution_providers::{CPUExecutionProvider, ExecutionProviderDispatch};
        let model_path = self.config.model_path();

        if !matches!(self.config.device, KokoroDevice::Cpu) {
            log::debug!(
                "[tts] Kokoro requested device={:?} → running CPU-only (DML ConvTranspose unsupported)",
                self.config.device
            );
        }
        let dispatch: Vec<ExecutionProviderDispatch> =
            vec![CPUExecutionProvider::default().build()];
        let active = vec!["CPUExecutionProvider".to_string()];

        // NO `with_intra_threads(1)` — that pinned inference to ONE thread and made
        // this path ~2.6× slower than the reference's multi-threaded kokoro_onnx CPU path
        // (1323ms vs ~500ms warm on the same model+phonemes). Omitting it lets ORT use
        // its default intra-op pool (all physical cores), matching onnxruntime's
        // defaults that the reference path relies on.
        let mut builder = ort::session::Session::builder()
            .map_err(|e| KokoroError::Session(format!("session builder: {e}")))?
            .with_execution_providers(dispatch)
            .map_err(|e| KokoroError::Session(format!("register EPs: {e}")))?;
        let session = builder
            .commit_from_file(&model_path)
            .map_err(|e| KokoroError::Session(format!("commit_from_file: {e}")))?;
        Ok((session, active))
    }

    /// Run one forward pass: input_ids + style + speed → audio f32.
    fn run_inference(
        &self,
        loaded: &mut LoadedKokoro,
        padded_tokens: &[i64],
        style_row: &[f32],
        speed: f32,
    ) -> KokoroResult<Vec<f32>> {
        use ort::value::Tensor;

        // Tensor shapes use `usize` + boxed slices, matching the green STT slice
        // (winstt/stt/whisper.rs `Tensor::from_array(([1usize, ..], data.into_boxed_slice()))`).
        let n = padded_tokens.len();
        // tokens / input_ids: [1, n] i64
        let ids_tensor =
            Tensor::from_array(([1usize, n], padded_tokens.to_vec().into_boxed_slice()))
                .map_err(|e| KokoroError::Session(format!("token-ids tensor: {e}")))?;
        // style: [1, 256] f32
        let style_tensor =
            Tensor::from_array(([1usize, STYLE_DIM], style_row.to_vec().into_boxed_slice()))
                .map_err(|e| KokoroError::Session(format!("style tensor: {e}")))?;

        // speed: f32 [1] (canonical kokoro-v1.0 export) or i64 [1] (newer HF re-export).
        let outputs = if loaded.speed_is_f32 {
            let speed_tensor = Tensor::from_array(([1usize], vec![speed].into_boxed_slice()))
                .map_err(|e| KokoroError::Session(format!("speed tensor: {e}")))?;
            loaded
                .session
                .run(ort::inputs! {
                    loaded.tokens_input.as_str() => ids_tensor,
                    "style" => style_tensor,
                    "speed" => speed_tensor,
                })
                .map_err(|e| KokoroError::Session(format!("inference: {e}")))?
        } else {
            // Integer-scalar speed export; round to nearest (min 1).
            let speed_i = speed.round().max(1.0) as i64;
            let speed_tensor = Tensor::from_array(([1usize], vec![speed_i].into_boxed_slice()))
                .map_err(|e| KokoroError::Session(format!("speed tensor: {e}")))?;
            loaded
                .session
                .run(ort::inputs! {
                    loaded.tokens_input.as_str() => ids_tensor,
                    "style" => style_tensor,
                    "speed" => speed_tensor,
                })
                .map_err(|e| KokoroError::Session(format!("inference: {e}")))?
        };

        // Output is the first (only) tensor: f32 audio samples. The graph emits
        // either [num_samples] or [1, num_samples]; flatten either way.
        // `try_extract_tensor::<f32>()` → Ok((&shape, &[f32])) (matches whisper.rs).
        let (_shape, data) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| KokoroError::Session(format!("extract audio: {e}")))?;
        // Trim leading/trailing silence, mirroring kokoro_onnx's `create(trim=True)`
        // (librosa.effects.trim). Kokoro pads ~0.5–0.6s of near-silence around each
        // utterance; without this our clips ran ~24% longer than the reference path
        // (81000 vs 65536 samples on the JFK sentence) — same speech, just dead air.
        // Trimming matches the reference AND makes read-aloud start/stop snappier.
        Ok(trim_silence(data))
    }

    /// Drop the session + voices (idempotent). Rust's Drop releases the native
    /// ORT handle; this lets the host unload before a device-change reload.
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = None;
        }
        self.ready.store(false, Ordering::Release);
    }
}

/// Trim leading/trailing silence — a faithful port of `librosa.effects.trim`
/// (the exact function kokoro_onnx ships in `trim.py` and calls via `trim_audio`)
/// with librosa's defaults: `top_db=60`, `frame_length=2048`, `hop_length=512`,
/// `ref=max`. A frame is "non-silent" when its power exceeds
/// `max_frame_power * 10^(-top_db/10)`; we keep `[first_nonsilent*hop ..
/// (last_nonsilent+1)*hop]` (clamped). Returns the trimmed samples as an owned Vec
/// (matching the previous `data.to_vec()` contract). Conservative: if the clip is
/// shorter than one frame, or all-silent, the input passes through unchanged.
fn trim_silence(audio: &[f32]) -> Vec<f32> {
    const FRAME: usize = 2048;
    const HOP: usize = 512;
    const TOP_DB: f32 = 60.0;
    if audio.len() < FRAME {
        return audio.to_vec();
    }
    let n_frames = 1 + (audio.len() - FRAME) / HOP;
    // Per-frame mean-square power (librosa rms²).
    let mut powers = Vec::with_capacity(n_frames);
    let mut max_p = 0.0f32;
    for i in 0..n_frames {
        let start = i * HOP;
        let frame = &audio[start..start + FRAME];
        let ms: f32 = frame.iter().map(|x| x * x).sum::<f32>() / FRAME as f32;
        if ms > max_p {
            max_p = ms;
        }
        powers.push(ms);
    }
    if max_p <= 0.0 {
        return audio.to_vec();
    }
    // power_to_db(p, ref=max) > -top_db  ⇔  p > max_p * 10^(-top_db/10).
    let thresh = max_p * 10f32.powf(-TOP_DB / 10.0);
    let first = powers.iter().position(|&p| p > thresh);
    let last = powers.iter().rposition(|&p| p > thresh);
    match (first, last) {
        (Some(f), Some(l)) => {
            let start = f * HOP;
            let end = ((l + 1) * HOP).min(audio.len());
            if end > start {
                audio[start..end].to_vec()
            } else {
                audio.to_vec()
            }
        }
        _ => audio.to_vec(),
    }
}

/// Read the input node names from a loaded session, defensively.
///
/// SPIKE: `ort 2.0.0-rc.12` exposes input descriptors via `session.inputs()`
/// returning `&[Outlet]`; the `Outlet`'s public `name` accessor was not fully
/// documented at draft time. The canonical kokoro-v1.0 export uses `tokens`, so
/// if this returns empty (API shape differs at compile), `load` falls back to
/// the canonical schema and synthesis still works. Confirm the exact `Outlet`
/// field/method in the compile loop and tighten this.
fn input_node_names(session: &ort::session::Session) -> Vec<String> {
    // `session.inputs()` → &[Outlet]; `Outlet::name()` is a method (matches
    // winstt/stt/whisper.rs `o.name()`), NOT a field.
    session
        .inputs()
        .iter()
        .map(|o| o.name().to_string())
        .collect()
}

/// Resolve the fp16 graph URL, allowing env override (CI / self-host).
pub fn model_url() -> String {
    std::env::var("WINSTT_KOKORO_MODEL_URL").unwrap_or_else(|_| KOKORO_FP16_URL.to_string())
}
/// Per-voice raw-`.bin` URL on the onnx-community repo.
pub fn voice_url(voice_id: &str) -> String {
    format!("https://huggingface.co/{KOKORO_HF_REPO}/resolve/main/voices/{voice_id}.bin")
}

// ===========================================================================
// Tests (pure parsing logic — no ort / network / model file required)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Write a raw little-endian f32 `[rows, STYLE_DIM]` voice `.bin` (the
    /// onnx-community layout — no header) to a temp file and return its path.
    fn write_voice_bin(tag: &str, rows: usize) -> PathBuf {
        let total = rows * STYLE_DIM;
        let mut bytes = Vec::with_capacity(total * 4);
        for i in 0..total {
            bytes.extend_from_slice(&(i as f32).to_le_bytes());
        }
        let p = std::env::temp_dir().join(format!(
            "winstt_kokoro_{tag}_{}_{rows}.bin",
            std::process::id()
        ));
        std::fs::write(&p, &bytes).unwrap();
        p
    }

    #[test]
    fn load_voice_bin_reads_rows_and_payload() {
        let p = write_voice_bin("ok", 3);
        let style = load_voice_bin(&p).unwrap();
        assert_eq!(style.rows, 3);
        assert_eq!(style.row_for(0).unwrap()[0], 0.0);
        assert_eq!(style.row_for(1).unwrap()[0], STYLE_DIM as f32);
        assert_eq!(style.row_for(1).unwrap().len(), STYLE_DIM);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn row_for_rejects_out_of_range_token_count() {
        let style = VoiceStyle {
            data: vec![0.0; 2 * STYLE_DIM],
            rows: 2,
        };
        assert!(style.row_for(2).is_err()); // == rows → out of range
        assert!(style.row_for(99).is_err());
    }

    #[test]
    fn load_voice_bin_rejects_misaligned() {
        let p = std::env::temp_dir().join(format!("winstt_kokoro_bad_{}.bin", std::process::id()));
        std::fs::write(&p, [0u8; 10]).unwrap(); // 10 bytes: not a multiple of 256*4
        assert!(load_voice_bin(&p).is_err());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn config_uses_onnx_and_voices_layout() {
        let cfg = KokoroConfig {
            cache_dir: PathBuf::from("/tmp/kokoro-82m"),
            ..Default::default()
        };
        assert!(cfg.model_path().ends_with("model_fp16.onnx"));
        let model = cfg.model_path().to_string_lossy().replace('\\', "/");
        assert!(model.contains("onnx/model_fp16.onnx"), "{model}");
        let voice = cfg
            .voice_path("af_heart")
            .to_string_lossy()
            .replace('\\', "/");
        assert!(voice.ends_with("voices/af_heart.bin"), "{voice}");
    }

    #[test]
    fn urls_point_at_onnx_community() {
        assert!(model_url().contains("model_fp16.onnx"));
        assert!(voice_url("af_heart").contains("voices/af_heart.bin"));
        assert!(voice_url("af_heart").contains("onnx-community/Kokoro-82M-v1.0-ONNX"));
    }
}
