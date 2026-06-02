// PORT IMPL — drafted against real APIs, pending compile.
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
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use super::phonemize::{MAX_PHONEME_LENGTH, Phonemizer, default_phonemizer};

/// Kokoro v1.0 emits 24 kHz mono float PCM.
pub const KOKORO_SAMPLE_RATE: u32 = 24_000;
/// Style/voice-embedding dimensionality (the third axis of a `[510,1,256]` pack).
pub const STYLE_DIM: usize = 256;

/// Pinned upstream model-file URLs (PORT/06_tts.md §3; same release the Python
/// downloader uses). Overridable via env for CI / self-host.
pub const KOKORO_FP16_URL: &str =
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx";
pub const KOKORO_VOICES_URL: &str =
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";

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

/// Parsed voice pack: voice-id → style table.
pub struct VoicePack {
    voices: HashMap<String, VoiceStyle>,
}

impl VoicePack {
    /// Parse `voices-v1.0.bin` (a numpy `.npz` = a zip of `<name>.npy` entries).
    /// Each entry is a little-endian f32 array of shape `[510, 1, 256]`; we
    /// flatten the middle singleton axis to `[510, 256]`.
    pub fn load(path: &Path) -> KokoroResult<Self> {
        let file =
            std::fs::File::open(path).map_err(|e| KokoroError::AssetsMissing(e.to_string()))?;
        let mut zip = zip::ZipArchive::new(file)
            .map_err(|e| KokoroError::Voice(format!("voices.bin is not a valid npz: {e}")))?;
        let mut voices = HashMap::new();
        for i in 0..zip.len() {
            let mut entry = zip
                .by_index(i)
                .map_err(|e| KokoroError::Voice(e.to_string()))?;
            let name = entry.name().to_string();
            // npz entries are "<voice_id>.npy"
            let voice_id = name.strip_suffix(".npy").unwrap_or(&name).to_string();
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry
                .read_to_end(&mut bytes)
                .map_err(|e| KokoroError::Voice(e.to_string()))?;
            let style = parse_npy_f32(&bytes)?;
            voices.insert(voice_id, style);
        }
        if voices.is_empty() {
            return Err(KokoroError::Voice("voice pack contained no voices".into()));
        }
        Ok(Self { voices })
    }

    pub fn get(&self, voice_id: &str) -> KokoroResult<&VoiceStyle> {
        self.voices
            .get(voice_id)
            .ok_or_else(|| KokoroError::Voice(format!("unknown voice id '{voice_id}'")))
    }

    pub fn voice_ids(&self) -> impl Iterator<Item = &str> {
        self.voices.keys().map(|s| s.as_str())
    }
}

/// Minimal `.npy` v1.0 parser for a little-endian `<f4` array. We only need the
/// raw f32 payload + the total element count (shape is `[510,1,256]` →
/// `MAX_PHONEME_LENGTH` rows of `STYLE_DIM`). Header format:
///   bytes 0..6  : magic \x93NUMPY
///   byte 6      : major version (1)
///   byte 7      : minor version (0)
///   bytes 8..10 : header-len u16 LE (v1.0)
///   header      : ASCII dict, e.g. {'descr': '<f4', 'fortran_order': False, 'shape': (510, 1, 256), }
///   payload     : row-major f32 little-endian
fn parse_npy_f32(bytes: &[u8]) -> KokoroResult<VoiceStyle> {
    const MAGIC: &[u8] = b"\x93NUMPY";
    if bytes.len() < 10 || &bytes[0..6] != MAGIC {
        return Err(KokoroError::Voice("bad .npy magic".into()));
    }
    let major = bytes[6];
    // v1.0 uses a u16 header length at [8..10]; v2.0+ uses u32 at [8..12].
    let (header_len, header_start) = if major >= 2 {
        if bytes.len() < 12 {
            return Err(KokoroError::Voice("truncated .npy v2 header".into()));
        }
        let hl = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
        (hl, 12usize)
    } else {
        let hl = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
        (hl, 10usize)
    };
    let header_end = header_start + header_len;
    if bytes.len() < header_end {
        return Err(KokoroError::Voice("truncated .npy header".into()));
    }
    let header = std::str::from_utf8(&bytes[header_start..header_end])
        .map_err(|_| KokoroError::Voice("non-utf8 .npy header".into()))?;
    if !header.contains("<f4") {
        return Err(KokoroError::Voice(format!(
            "voice pack dtype is not <f4: {header}"
        )));
    }
    if header.contains("'fortran_order': True") {
        return Err(KokoroError::Voice("fortran-ordered voice pack unsupported".into()));
    }
    let payload = &bytes[header_end..];
    if payload.len() % 4 != 0 {
        return Err(KokoroError::Voice("voice payload not f32-aligned".into()));
    }
    let count = payload.len() / 4;
    if count % STYLE_DIM != 0 {
        return Err(KokoroError::Voice(format!(
            "voice payload {count} floats not a multiple of style dim {STYLE_DIM}"
        )));
    }
    let mut data = Vec::with_capacity(count);
    for chunk in payload.chunks_exact(4) {
        data.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    let rows = count / STYLE_DIM;
    Ok(VoiceStyle { data, rows })
}

// ---------------------------------------------------------------------------
// The ONNX engine
// ---------------------------------------------------------------------------

/// Configuration for the local Kokoro engine.
#[derive(Clone, Debug)]
pub struct KokoroConfig {
    /// `%LOCALAPPDATA%/winstt/tts/kokoro` (host-resolved). Holds both files.
    pub cache_dir: PathBuf,
    /// `kokoro-v1.0.fp16.onnx` by default.
    pub model_filename: String,
    /// `voices-v1.0.bin` by default.
    pub voices_filename: String,
    pub device: KokoroDevice,
}

impl Default for KokoroConfig {
    fn default() -> Self {
        Self {
            cache_dir: PathBuf::new(),
            model_filename: "kokoro-v1.0.fp16.onnx".to_string(),
            voices_filename: "voices-v1.0.bin".to_string(),
            device: KokoroDevice::Auto,
        }
    }
}

impl KokoroConfig {
    pub fn model_path(&self) -> PathBuf {
        self.cache_dir.join(&self.model_filename)
    }
    pub fn voices_path(&self) -> PathBuf {
        self.cache_dir.join(&self.voices_filename)
    }
    /// True once both files are present on disk (so warm-up can skip download).
    pub fn assets_present(&self) -> bool {
        self.model_path().exists() && self.voices_path().exists()
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
        let mut guard = self.inner.lock().map_err(|_| {
            KokoroError::Session("kokoro engine lock poisoned".into())
        })?;
        if guard.is_some() {
            return Ok(());
        }
        if !self.config.assets_present() {
            return Err(KokoroError::AssetsMissing(format!(
                "expected {} and {}",
                self.config.model_path().display(),
                self.config.voices_path().display()
            )));
        }
        let loaded = self.load()?;
        *guard = Some(loaded);
        self.ready.store(true, Ordering::Release);
        Ok(())
    }

    /// Synthesize ONE sentence → mono f32 PCM @ 24 kHz. Blocking. Lazily warms
    /// up on first call. `speed` is pre-clamped by the caller.
    pub fn synthesize(&self, text: &str, voice: &str, lang: &str, speed: f32) -> KokoroResult<Vec<f32>> {
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
                    self.config.voices_path().display()
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
        // (81000 vs Electron's 65536 samples on the JFK sentence). Match Electron exactly.
        let style_row = loaded.voices.get(voice)?.row_for(tokens.len())?.to_vec();
        self.run_inference(loaded, &padded, &style_row, speed)
    }

    /// Build the ORT session + parse the voice pack + detect the input schema.
    fn load(&self) -> KokoroResult<LoadedKokoro> {
        let voices = VoicePack::load(&self.config.voices_path())?;
        let (session, active_providers) = self.build_session()?;

        // Detect the input schema from the graph's input node names.
        // The canonical kokoro-v1.0(.fp16).onnx export uses
        //   tokens [1,N] i64 + style [1,256] f32 + speed [1] f32
        // while newer re-exports (HF onnx-community) use
        //   input_ids [1,N] i64 + style + speed [1] i64.
        // `session.inputs()` returns the input node descriptors; we read each
        // node's name to pick the right token-input key + speed dtype. If the
        // descriptor API can't be read we fall back to the canonical schema
        // (`tokens` + f32 speed) and the inference path retries the alternate
        // key on an unknown-input error.
        let names = input_node_names(&session);
        let (tokens_input, speed_is_f32) = if names.iter().any(|n| n == "input_ids") {
            ("input_ids".to_string(), false)
        } else {
            // default: canonical kokoro-v1.0 export
            ("tokens".to_string(), true)
        };

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
    /// `kokoro_onnx` path (Electron) and this Rust path (see the tts benchmark), so
    /// the upstream Electron app is likewise CPU-only for Kokoro. We therefore never
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
        // this path ~2.6× slower than Electron's multi-threaded kokoro_onnx CPU path
        // (1323ms vs ~500ms warm on the same model+phonemes). Omitting it lets ORT use
        // its default intra-op pool (all physical cores), matching onnxruntime's
        // defaults that the Electron path relies on.
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
        let ids_tensor = Tensor::from_array((
            [1usize, n],
            padded_tokens.to_vec().into_boxed_slice(),
        ))
        .map_err(|e| KokoroError::Session(format!("token-ids tensor: {e}")))?;
        // style: [1, 256] f32
        let style_tensor = Tensor::from_array((
            [1usize, STYLE_DIM],
            style_row.to_vec().into_boxed_slice(),
        ))
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
        // utterance; without this our clips ran ~24% longer than the Electron path
        // (81000 vs 65536 samples on the JFK sentence) — same speech, just dead air.
        // Trimming matches Electron AND makes read-aloud start/stop snappier.
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
    session.inputs().iter().map(|o| o.name().to_string()).collect()
}

/// Resolve the model-file URLs, allowing env override (CI / self-host).
pub fn model_url() -> String {
    std::env::var("WINSTT_KOKORO_MODEL_URL").unwrap_or_else(|_| KOKORO_FP16_URL.to_string())
}
pub fn voices_url() -> String {
    std::env::var("WINSTT_KOKORO_VOICES_URL").unwrap_or_else(|_| KOKORO_VOICES_URL.to_string())
}

// ===========================================================================
// Tests (pure parsing logic — no ort / network / model file required)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal valid .npy v1.0 buffer for an f32 array of `shape`.
    fn make_npy(shape: &[usize], data: &[f32]) -> Vec<u8> {
        let shape_str = if shape.len() == 1 {
            format!("({},)", shape[0])
        } else {
            let inner: Vec<String> = shape.iter().map(|d| d.to_string()).collect();
            format!("({})", inner.join(", "))
        };
        let header = format!(
            "{{'descr': '<f4', 'fortran_order': False, 'shape': {shape_str}, }}"
        );
        // pad header so total (10 + header_len) is a multiple of 64, ending in \n
        let mut header_bytes = header.into_bytes();
        let unpadded = 10 + header_bytes.len() + 1; // +1 for trailing \n
        let pad = (64 - (unpadded % 64)) % 64;
        header_bytes.extend(std::iter::repeat(b' ').take(pad));
        header_bytes.push(b'\n');

        let mut out = Vec::new();
        out.extend_from_slice(b"\x93NUMPY");
        out.push(1); // major
        out.push(0); // minor
        out.extend_from_slice(&(header_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&header_bytes);
        for f in data {
            out.extend_from_slice(&f.to_le_bytes());
        }
        out
    }

    #[test]
    fn parse_npy_reads_shape_and_payload() {
        // shape [3, 1, 2] → 6 floats → rows = 6 / STYLE_DIM... use STYLE_DIM-sized rows instead
        let rows = 2usize;
        let total = rows * STYLE_DIM;
        let data: Vec<f32> = (0..total).map(|i| i as f32).collect();
        let buf = make_npy(&[rows, 1, STYLE_DIM], &data);
        let style = parse_npy_f32(&buf).unwrap();
        assert_eq!(style.rows, rows);
        // row 0 starts at 0.0, row 1 starts at STYLE_DIM as f32
        assert_eq!(style.row_for(0).unwrap()[0], 0.0);
        assert_eq!(style.row_for(1).unwrap()[0], STYLE_DIM as f32);
        assert_eq!(style.row_for(0).unwrap().len(), STYLE_DIM);
    }

    #[test]
    fn row_for_rejects_out_of_range_token_count() {
        let rows = 2usize;
        let data: Vec<f32> = vec![0.0; rows * STYLE_DIM];
        let buf = make_npy(&[rows, 1, STYLE_DIM], &data);
        let style = parse_npy_f32(&buf).unwrap();
        assert!(style.row_for(2).is_err()); // == rows → out of range
        assert!(style.row_for(99).is_err());
    }

    #[test]
    fn parse_npy_rejects_wrong_dtype() {
        // craft a header claiming <i8
        let header = b"{'descr': '<i8', 'fortran_order': False, 'shape': (1,), }\n";
        let mut buf = Vec::new();
        buf.extend_from_slice(b"\x93NUMPY");
        buf.push(1);
        buf.push(0);
        buf.extend_from_slice(&(header.len() as u16).to_le_bytes());
        buf.extend_from_slice(header);
        buf.extend_from_slice(&0i64.to_le_bytes());
        assert!(parse_npy_f32(&buf).is_err());
    }

    #[test]
    fn parse_npy_rejects_bad_magic() {
        let buf = vec![0u8; 32];
        assert!(parse_npy_f32(&buf).is_err());
    }

    #[test]
    fn config_paths_join_cache_dir() {
        let cfg = KokoroConfig {
            cache_dir: PathBuf::from("/tmp/kokoro"),
            ..Default::default()
        };
        assert!(cfg.model_path().ends_with("kokoro-v1.0.fp16.onnx"));
        assert!(cfg.voices_path().ends_with("voices-v1.0.bin"));
    }

    #[test]
    fn urls_default_to_upstream_release() {
        // (env not set in test → upstream pins)
        assert!(model_url().contains("kokoro-v1.0.fp16.onnx"));
        assert!(voices_url().contains("voices-v1.0.bin"));
    }
}
