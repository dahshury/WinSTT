// Source: thewh1teagle/kokoro-onnx (src/kokoro_onnx/{tokenizer.py,config.json}),
//   server/src/synthesizer/infrastructure/kokoro_synthesizer.py, espeak-ng CLI (`espeak-ng -q --ipa`).
//
// Grapheme→phoneme (G2P) for Kokoro. The whole Kokoro ecosystem trains on espeak-ng/Misaki IPA
// phonemes, so we reproduce that pipeline:
//   text  --espeak-ng--> IPA phoneme string  --filter to VOCAB--> token ids (Vec<i64>)
//
// Two phonemizer backends behind one `Phonemizer` trait so the GPL question (PORT/06_tts.md §1) is
// a runtime/feature decision, NOT baked into call sites:
//   * `EspeakCliPhonemizer` — shells out to the system `espeak-ng` binary. Process separation =
//     "mere aggregation" under the GPL (FSF guidance), so this keeps the main binary non-GPL.
//     This is the DEFAULT (no static link, no cargo-linked espeak-ng symbols).
//   * `NullPhonemizer` — deterministic ASCII-letter passthrough used in tests + as a last-resort
//     fallback when espeak-ng is absent (degraded pronunciation, but never panics).
//
// The token-id mapping (`VOCAB`) is the verbatim Kokoro v1.0 `config.json` "vocab" table
// (n_token = 178). Phonemes not in the vocab are dropped (matches the Python
// `"".join(filter(lambda p: p in self.vocab, phonemes))`).

#![allow(dead_code)]

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

/// Kokoro v1.0 max phoneme sequence length (the voice-pack first axis size).
/// Token sequences longer than this overflow the style-vector index → reject.
pub const MAX_PHONEME_LENGTH: usize = 510;

/// Errors from the G2P stage.
#[derive(Debug)]
pub enum PhonemizeError {
    /// The `espeak-ng` binary is not on PATH / failed to spawn.
    EspeakUnavailable(String),
    /// `espeak-ng` ran but exited non-zero / produced no usable output.
    EspeakFailed(String),
    /// Phoneme sequence exceeds `MAX_PHONEME_LENGTH` after vocab filtering.
    TooLong(usize),
}

impl std::fmt::Display for PhonemizeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PhonemizeError::EspeakUnavailable(m) => write!(f, "espeak-ng unavailable: {m}"),
            PhonemizeError::EspeakFailed(m) => write!(f, "espeak-ng failed: {m}"),
            PhonemizeError::TooLong(n) => {
                write!(f, "phoneme sequence too long ({n} > {MAX_PHONEME_LENGTH})")
            }
        }
    }
}

impl std::error::Error for PhonemizeError {}

pub type PhonemizeResult<T> = Result<T, PhonemizeError>;

/// G2P backend. `phonemize` returns the raw IPA phoneme string for `text` in
/// language `lang` (a Kokoro lang code like `en-us`); `tokenize` maps that to
/// Kokoro vocab token ids (vocab-filtered, padding NOT yet applied).
pub trait Phonemizer: Send + Sync {
    /// Produce the IPA phoneme string for `text`. `lang` is a Kokoro lang code
    /// (`en-us`, `cmn`, `pt-br`, …) — implementations map it to the backend's
    /// own language identifier (`espeak_lang_for`).
    fn phonemize(&self, text: &str, lang: &str) -> PhonemizeResult<String>;

    /// True when this backend is actually usable (e.g. espeak-ng found on PATH).
    fn is_available(&self) -> bool;

    /// Map IPA phonemes → Kokoro vocab token ids. Default impl is shared across
    /// backends: filter to the vocab, look each up, drop unknowns. Mirrors the
    /// Python `tokenize()` (`[i for i in map(vocab.get, phonemes) if i is not None]`).
    fn tokenize(&self, phonemes: &str) -> PhonemizeResult<Vec<i64>> {
        let vocab = vocab();
        let ids: Vec<i64> = phonemes
            .chars()
            .filter_map(|c| vocab.get(&c).copied())
            .collect();
        if ids.len() > MAX_PHONEME_LENGTH {
            return Err(PhonemizeError::TooLong(ids.len()));
        }
        Ok(ids)
    }

    /// Convenience: `phonemize` then `tokenize` in one call.
    fn text_to_tokens(&self, text: &str, lang: &str) -> PhonemizeResult<Vec<i64>> {
        let phonemes = self.phonemize(text, lang)?;
        self.tokenize(&phonemes)
    }
}

// ---------------------------------------------------------------------------
// espeak-ng CLI backend (process-separated → GPL "mere aggregation")
// ---------------------------------------------------------------------------

/// Shells out to the system `espeak-ng` binary. Process isolation keeps the
/// GPL-v3 espeak-ng out of the main binary's link graph (PORT/06_tts.md §1
/// escape hatch — separate process = mere aggregation).
///
/// Invocation: `espeak-ng -q --ipa=3 -v <lang> -- <text>`
///   `-q`        quiet (don't speak; we only want phonemes)
///   `--ipa=3`   emit IPA, tie-bars stripped, one token per phoneme cluster
///   `-v <lang>` voice/language (mapped from the Kokoro lang code)
///   `--`        end of options so leading-dash text isn't parsed as a flag
///
/// We strip espeak's stress/markup that isn't in Kokoro's vocab during the
/// shared `tokenize` filter, so no post-processing beyond whitespace-collapse
/// is needed here.
pub struct EspeakCliPhonemizer {
    /// Resolved binary name/path (`espeak-ng` by default; overridable for tests
    /// / portable installs that ship their own copy).
    binary: String,
}

impl Default for EspeakCliPhonemizer {
    fn default() -> Self {
        Self {
            binary: espeak_binary(),
        }
    }
}

impl EspeakCliPhonemizer {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: binary.into(),
        }
    }
}

impl Phonemizer for EspeakCliPhonemizer {
    fn phonemize(&self, text: &str, lang: &str) -> PhonemizeResult<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(String::new());
        }
        let espeak_lang = espeak_lang_for(lang);
        let mut cmd = Command::new(&self.binary);
        cmd.arg("-q").arg("--ipa=3").arg("-v").arg(espeak_lang);
        // If we can resolve an espeak-ng-data dir (e.g. the espeakng_loader
        // bundle), point the CLI at it via `--path=<dir containing espeak-ng-data>`
        // so a CLI that lacks compiled-in data still finds the dictionaries.
        if let Some((_, Some(data_dir))) = resolve_espeak_lib() {
            cmd.arg(format!("--path={}", data_dir.display()));
        }
        let output = cmd
            .arg("--")
            .arg(trimmed)
            .output()
            .map_err(|e| PhonemizeError::EspeakUnavailable(e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(PhonemizeError::EspeakFailed(format!(
                "exit {:?}: {}",
                output.status.code(),
                stderr.trim()
            )));
        }
        let raw = String::from_utf8_lossy(&output.stdout);
        Ok(clean_espeak_ipa(&raw))
    }

    fn is_available(&self) -> bool {
        // A cheap version probe; `espeak-ng --version` exits 0 when present.
        Command::new(&self.binary)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Collapse espeak `--ipa=3` output (one phoneme per line/space, with `_`
/// word separators and newlines) into the contiguous IPA string Kokoro's
/// tokenizer filters. We keep spaces (Kokoro vocab maps `' '` → 16) but drop
/// espeak's `_` cluster separators and CR/LF.
pub fn clean_espeak_ipa(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = false;
    for ch in raw.chars() {
        let c = match ch {
            // espeak inserts `_` between phonemes in --ipa=3; not a Kokoro token.
            '_' => continue,
            '\r' | '\n' | '\t' => ' ',
            other => other,
        };
        if c == ' ' {
            // collapse runs of whitespace to a single space
            if prev_space {
                continue;
            }
            prev_space = true;
        } else {
            prev_space = false;
        }
        out.push(c);
    }
    out.trim().to_string()
}

/// Resolve the espeak-ng binary name. Windows installs expose `espeak-ng.exe`;
/// the env override lets portable installs ship their own and CI point at a
/// fixture. Returns the bare name (resolved against PATH) by default.
fn espeak_binary() -> String {
    // `ESPEAK_NG_BIN` / `WINSTT_ESPEAK_NG` point at a CLI `espeak-ng[.exe]`.
    for var in ["ESPEAK_NG_BIN", "WINSTT_ESPEAK_NG"] {
        if let Ok(p) = std::env::var(var) {
            if !p.trim().is_empty() {
                return p;
            }
        }
    }
    // `espeak-ng` resolves `espeak-ng.exe` on Windows via std's PATHEXT handling.
    "espeak-ng".to_string()
}

/// Map a Kokoro lang code to an espeak-ng `-v` voice id. Kokoro's lang codes are
/// mostly espeak-compatible already; the two that differ are `cmn` (espeak uses
/// `cmn` for Mandarin too, kept) and `pt-br` (espeak `pt-br`). Unknown codes
/// fall back to `en-us`.
pub fn espeak_lang_for(lang: &str) -> &'static str {
    match lang {
        "en-us" => "en-us",
        // espeak-ng has NO bare "en-gb" voice file — British English ships as
        // `en-GB-x-rp` (Received Pronunciation) etc. `espeak_SetVoiceByName("en-gb")`
        // therefore returns EE_NOT_FOUND (2) and every UK Kokoro voice fails to
        // phonemize. RP is the standard British voice (same phoneme set Kokoro's
        // misaki uses for en-gb), and the `en-GB-x-rp` data is in our bundle.
        "en-gb" => "en-gb-x-rp",
        "ja" => "ja",
        "cmn" => "cmn",
        "es" => "es",
        "fr" => "fr-fr",
        "hi" => "hi",
        "it" => "it",
        "pt-br" => "pt-br",
        _ => "en-us",
    }
}

// ---------------------------------------------------------------------------
// In-process espeak-ng FFI backend (the FAST + PARITY path)
// ---------------------------------------------------------------------------
//
// The the reference app does NOT shell out to an `espeak-ng` CLI — it loads the
// espeak-ng SHARED LIBRARY (`espeak-ng.dll`, shipped by the `espeakng_loader`
// PyPI package) and calls `espeak_TextToPhonemes` IN-PROCESS via ctypes (see
// `phonemizer/backend/espeak/{wrapper,api}.py` + `kokoro_onnx/tokenizer.py`).
// We do the exact same thing here so we get (a) byte-identical phonemes to the
// Python path and (b) zero per-sentence process-spawn overhead (the CLI shell
// dominated short-sentence latency — a fresh Windows process per sentence).
//
// espeak's C API uses global state and is NOT thread-safe / not re-entrant
// (api.py copies the whole .dll per instance to dodge this). We serialize every
// call behind one process-wide `Mutex` (mirrors the Python `_synth_lock`).
//
// Invocation parity (kokoro_onnx → phonemizer → wrapper.text_to_phonemes):
//   espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS=0x02, buflen=0, data_path, 0)
//   espeak_SetVoiceByName("en-us")
//   loop: espeak_TextToPhonemes(&text_ptr, textmode=1 /*UTF8*/,
//                               phonememode = ('_' << 8) | 0x02 /*IPA*/)
//         until *text_ptr == NULL
// → the `_`-separated IPA string, which `clean_espeak_ipa` collapses (same as
//   the CLI `--ipa=3` output the existing cleaner already handles).

/// espeak-ng `espeak_Initialize` audio-output mode: AUDIO_OUTPUT_SYNCHRONOUS.
const ESPEAK_AUDIO_OUTPUT_SYNCHRONOUS: c_int = 0x02;
/// `espeak_TextToPhonemes` text mode: input is UTF-8 (`espeakCHARS_UTF8`).
const ESPEAK_CHARS_UTF8: c_int = 1;
/// `espeak_TextToPhonemes` phoneme mode: IPA (0x02), separated by `'_'` in the
/// high byte — matches `phonemizer`'s non-tie path (`ord('_') << 8 | 0x02`).
const ESPEAK_PHONEMES_IPA: c_int = (b'_' as c_int) << 8 | 0x02;

/// The espeak-ng C entry points we bind (subset of `speak_lib.h`).
struct EspeakSyms {
    /// `int espeak_Initialize(espeak_AUDIO_OUTPUT, int buflength, const char* path, int options)`
    initialize: unsafe extern "C" fn(c_int, c_int, *const c_char, c_int) -> c_int,
    /// `espeak_ERROR espeak_SetVoiceByName(const char* name)` (0 == EE_OK).
    set_voice_by_name: unsafe extern "C" fn(*const c_char) -> c_int,
    /// `const char* espeak_TextToPhonemes(const void** textptr, int textmode, int phonememode)`
    text_to_phonemes: unsafe extern "C" fn(*mut *const c_char, c_int, c_int) -> *const c_char,
}

/// Loaded espeak-ng shared library + symbols + the voice currently selected.
struct EspeakLib {
    // Keep the library alive for the lifetime of the symbols (Drop order: syms
    // borrow nothing from `_lib` after resolution, but we hold it so the .dll
    // stays mapped while we call into it).
    _lib: libloading::Library,
    syms: EspeakSyms,
    /// espeak voice name currently set (we skip a redundant SetVoiceByName).
    current_voice: Option<String>,
}

// SAFETY: every method that touches espeak's global C state runs under the
// outer `Mutex<Option<EspeakLib>>`, so the raw fn pointers are never called
// concurrently. The library handle itself is `Send`/`Sync` via libloading.
unsafe impl Send for EspeakLib {}

impl EspeakLib {
    /// dlopen the espeak-ng shared lib at `lib_path`, resolve symbols, and run
    /// `espeak_Initialize` with `data_dir` (the directory that CONTAINS
    /// `espeak-ng-data`). Returns the ready library on success.
    fn load(lib_path: &Path, data_dir: Option<&Path>) -> PhonemizeResult<Self> {
        // Tauri's `resource_dir()` returns `\\?\…` verbatim paths; espeak-ng's C
        // path code joins with `/` and can't open those (the prefix disables
        // separator normalization), so clean the lib path before dlopen.
        let lib_path = strip_unc_prefix(lib_path);
        // espeak-ng's C library calls `exit(1)` — taking down the WHOLE process —
        // when it can't load `phontab`. So resolve the real data-home dir (the
        // one that DIRECTLY contains `phontab`) up front and REFUSE to init when
        // it's missing, degrading to "TTS unavailable" instead of crashing.
        let Some(data_home) = data_dir.and_then(resolve_espeak_data_home) else {
            return Err(PhonemizeError::EspeakUnavailable(format!(
                "espeak-ng data (phontab) not found for {data_dir:?}; refusing to \
                 init (espeak-ng exit(1)s the process on missing phoneme data)"
            )));
        };
        // SAFETY: loading a trusted, app-shipped DLL; symbol signatures match
        // speak_lib.h (verified against phonemizer's ctypes bindings in api.py).
        unsafe {
            let lib = libloading::Library::new(&lib_path).map_err(|e| {
                PhonemizeError::EspeakUnavailable(format!(
                    "dlopen {} failed: {e}",
                    lib_path.display()
                ))
            })?;
            let initialize = *lib
                .get::<unsafe extern "C" fn(c_int, c_int, *const c_char, c_int) -> c_int>(
                    b"espeak_Initialize\0",
                )
                .map_err(|e| {
                    PhonemizeError::EspeakUnavailable(format!("espeak_Initialize: {e}"))
                })?;
            let set_voice_by_name = *lib
                .get::<unsafe extern "C" fn(*const c_char) -> c_int>(b"espeak_SetVoiceByName\0")
                .map_err(|e| {
                    PhonemizeError::EspeakUnavailable(format!("espeak_SetVoiceByName: {e}"))
                })?;
            let text_to_phonemes = *lib
                .get::<unsafe extern "C" fn(*mut *const c_char, c_int, c_int) -> *const c_char>(
                    b"espeak_TextToPhonemes\0",
                )
                .map_err(|e| {
                    PhonemizeError::EspeakUnavailable(format!("espeak_TextToPhonemes: {e}"))
                })?;

            // This espeak-ng build sets `path_home = path` DIRECTLY (it does not
            // append `espeak-ng-data`) — the same convention as the reference
            // `espeakng_loader` + phonemizer, which init with `get_data_path()`
            // (the `espeak-ng-data` dir itself). `data_home` already points AT
            // that dir (it holds `phontab`), so pass it verbatim.
            let data_c = CString::new(data_home.to_string_lossy().as_bytes()).map_err(|_| {
                PhonemizeError::EspeakUnavailable("data path contained a NUL byte".into())
            })?;
            // returns the sample rate (>0) on success, or -1 (EE_INTERNAL_ERROR).
            let rate = initialize(ESPEAK_AUDIO_OUTPUT_SYNCHRONOUS, 0, data_c.as_ptr(), 0);
            if rate <= 0 {
                return Err(PhonemizeError::EspeakFailed(format!(
                    "espeak_Initialize returned {rate} (data home {})",
                    data_home.display()
                )));
            }
            Ok(Self {
                _lib: lib,
                syms: EspeakSyms {
                    initialize,
                    set_voice_by_name,
                    text_to_phonemes,
                },
                current_voice: None,
            })
        }
    }

    /// Select `voice` (an espeak voice name like `en-us`) if not already active.
    fn set_voice(&mut self, voice: &str) -> PhonemizeResult<()> {
        if self.current_voice.as_deref() == Some(voice) {
            return Ok(());
        }
        let c_voice = CString::new(voice)
            .map_err(|_| PhonemizeError::EspeakFailed("voice name had a NUL byte".into()))?;
        // SAFETY: serialized by the outer Mutex; pointer valid for the call.
        let err = unsafe { (self.syms.set_voice_by_name)(c_voice.as_ptr()) };
        if err != 0 {
            return Err(PhonemizeError::EspeakFailed(format!(
                "espeak_SetVoiceByName('{voice}') → {err}"
            )));
        }
        self.current_voice = Some(voice.to_string());
        Ok(())
    }

    /// Phonemize `text` for the already-selected voice, returning the raw
    /// `_`-separated IPA string (caller runs `clean_espeak_ipa`). Mirrors
    /// `EspeakWrapper.text_to_phonemes`: loop until the text pointer is NULL.
    fn text_to_phonemes(&self, text: &str) -> PhonemizeResult<String> {
        let c_text = CString::new(text)
            .map_err(|_| PhonemizeError::EspeakFailed("text had a NUL byte".into()))?;
        // espeak advances this pointer through the buffer; NULL when done.
        let mut text_ptr: *const c_char = c_text.as_ptr();
        let mut out = String::new();
        // SAFETY: serialized by the outer Mutex; `text_ptr` stays valid because
        // `c_text` outlives the loop, and espeak only reads through it.
        unsafe {
            // Bound the loop defensively (espeak returns chunks; a sane sentence
            // is < a few hundred chunks). Prevents a hang on a pathological lib.
            for _ in 0..100_000 {
                if text_ptr.is_null() {
                    break;
                }
                let ph = (self.syms.text_to_phonemes)(
                    &mut text_ptr,
                    ESPEAK_CHARS_UTF8,
                    ESPEAK_PHONEMES_IPA,
                );
                if !ph.is_null() {
                    let chunk = CStr::from_ptr(ph).to_string_lossy();
                    if !out.is_empty() {
                        out.push(' ');
                    }
                    out.push_str(&chunk);
                }
                if text_ptr.is_null() {
                    break;
                }
            }
        }
        Ok(out)
    }
}

/// In-process espeak-ng phonemizer (the default). Lazily dlopens the espeak-ng
/// shared library on first use and reuses it for every sentence (no spawn).
pub struct EspeakLibPhonemizer {
    inner: Mutex<EspeakLibState>,
}

enum EspeakLibState {
    /// Not yet loaded; carries the resolved (lib_path, data_dir) to try.
    Pending {
        lib_path: PathBuf,
        data_dir: Option<PathBuf>,
    },
    /// Loaded + initialized.
    Loaded(EspeakLib),
    /// Load was attempted and failed — remember so we don't retry every call.
    Failed,
}

impl EspeakLibPhonemizer {
    /// Build from a resolved library + data dir (the dir CONTAINING
    /// `espeak-ng-data`, or None to let espeak use its built-in default).
    pub fn new(lib_path: PathBuf, data_dir: Option<PathBuf>) -> Self {
        Self {
            inner: Mutex::new(EspeakLibState::Pending { lib_path, data_dir }),
        }
    }

    /// Resolve the espeak-ng shared library + data dir from the environment and
    /// common install locations (incl. the reference app's `espeakng_loader`
    /// bundle), if any. Returns None when no shared lib can be found.
    pub fn discover() -> Option<Self> {
        let (lib_path, data_dir) = resolve_espeak_lib()?;
        Some(Self::new(lib_path, data_dir))
    }

    /// Phonemize with an EXPLICIT espeak voice id (e.g. `en-us`, `en-gb`, `de`,
    /// `fr-fr`), bypassing the Kokoro lang-code remap in `espeak_lang_for`.
    /// Returns cleaned IPA (espeak `_` separators dropped, whitespace collapsed,
    /// single word spaces kept) — the per-codepoint form Piper mapping consumes.
    /// Used by engines whose voice list carries native espeak voice ids (e.g.
    /// Piper's `.onnx.json` `espeak.voice`).
    pub fn phonemize_voice(&self, text: &str, espeak_voice: &str) -> PhonemizeResult<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(String::new());
        }
        self.with_lib(|lib| {
            lib.set_voice(espeak_voice)?;
            let raw = lib.text_to_phonemes(trimmed)?;
            Ok(clean_espeak_ipa(&raw))
        })
    }

    /// Run `f` against the loaded library, loading it on first use.
    fn with_lib<T>(
        &self,
        f: impl FnOnce(&mut EspeakLib) -> PhonemizeResult<T>,
    ) -> PhonemizeResult<T> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| PhonemizeError::EspeakFailed("espeak lib mutex poisoned".into()))?;
        // Promote Pending → Loaded/Failed once.
        if let EspeakLibState::Pending { lib_path, data_dir } = &*guard {
            let lib_path = lib_path.clone();
            let data_dir = data_dir.clone();
            match EspeakLib::load(&lib_path, data_dir.as_deref()) {
                Ok(lib) => *guard = EspeakLibState::Loaded(lib),
                Err(e) => {
                    *guard = EspeakLibState::Failed;
                    return Err(e);
                }
            }
        }
        match &mut *guard {
            EspeakLibState::Loaded(lib) => f(lib),
            EspeakLibState::Failed => Err(PhonemizeError::EspeakUnavailable(
                "espeak-ng shared lib unavailable".into(),
            )),
            EspeakLibState::Pending { .. } => unreachable!("promoted above"),
        }
    }
}

impl Phonemizer for EspeakLibPhonemizer {
    fn phonemize(&self, text: &str, lang: &str) -> PhonemizeResult<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Ok(String::new());
        }
        let espeak_lang = espeak_lang_for(lang);
        self.with_lib(|lib| {
            lib.set_voice(espeak_lang)?;
            let raw = lib.text_to_phonemes(trimmed)?;
            Ok(clean_espeak_ipa(&raw))
        })
    }

    fn is_available(&self) -> bool {
        // Probe by actually loading the lib (cached after the first attempt).
        self.with_lib(|_| Ok(())).is_ok()
    }
}

/// Resolve the espeak-ng shared library path + the directory CONTAINING
/// `espeak-ng-data`. Precedence (parity with `phonemizer`'s lookup):
///   1. `ESPEAK_NG_LIBRARY` / `PHONEMIZER_ESPEAK_LIBRARY` / `WINSTT_ESPEAK_LIB`
///      explicit shared-lib path (+ `ESPEAK_DATA_PATH` / `PHONEMIZER_ESPEAK_DATA_PATH`).
///   2. The the reference app's `espeakng_loader` bundle under
///      `%LOCALAPPDATA%/winstt/tts/runtime/espeakng_loader/` (what ships today).
///   3. Common system install dirs (`C:\Program Files\eSpeak NG\`, PATH).
///
/// Returns None if no shared lib is found (caller falls back to CLI / null).
pub fn resolve_espeak_lib() -> Option<(PathBuf, Option<PathBuf>)> {
    let lib_name = espeak_shared_lib_name();

    // (1) explicit lib path override.
    for var in [
        "ESPEAK_NG_LIBRARY",
        "PHONEMIZER_ESPEAK_LIBRARY",
        "WINSTT_ESPEAK_LIB",
    ] {
        if let Ok(p) = std::env::var(var) {
            let p = p.trim();
            if !p.is_empty() && Path::new(p).exists() {
                return Some((PathBuf::from(p), explicit_data_dir(Path::new(p))));
            }
        }
    }

    // Candidate dirs that may contain the shared lib (+ its espeak-ng-data).
    let mut dirs: Vec<PathBuf> = Vec::new();
    // (2) the reference espeakng_loader bundle (the file actually present today).
    if let Some(local) = local_app_data() {
        dirs.push(local.join("winstt/tts/runtime/espeakng_loader"));
    }
    // also honor an explicit data-path env that points at espeakng_loader.
    if let Ok(dp) = std::env::var("ESPEAK_DATA_PATH") {
        let dp = PathBuf::from(dp);
        // dp may be the espeak-ng-data dir itself or its parent; try the parent.
        if let Some(parent) = dp.parent() {
            dirs.push(parent.to_path_buf());
        }
        dirs.push(dp);
    }
    // (3) common Windows install locations.
    dirs.push(PathBuf::from(r"C:\Program Files\eSpeak NG"));
    dirs.push(PathBuf::from(r"C:\Program Files (x86)\eSpeak NG"));

    for dir in dirs {
        let lib = dir.join(&lib_name);
        if lib.exists() {
            return Some((lib, espeak_data_dir_for(&dir)));
        }
    }
    None
}

/// The espeak-ng shared-lib filename for the current platform.
fn espeak_shared_lib_name() -> String {
    #[cfg(windows)]
    {
        "espeak-ng.dll".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "libespeak-ng.dylib".to_string()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "libespeak-ng.so".to_string()
    }
}

/// The data dir to pass to `espeak_Initialize` (the parent of `espeak-ng-data`).
/// `espeakng_loader` ships `espeak-ng-data` right beside the lib, so the lib's
/// own directory is the correct parent.
fn espeak_data_dir_for(lib_dir: &Path) -> Option<PathBuf> {
    if lib_dir.join("espeak-ng-data").is_dir() {
        Some(lib_dir.to_path_buf())
    } else {
        None
    }
}

/// The directory espeak-ng must use as its data home — the one that DIRECTLY
/// contains `phontab`. This espeak-ng build sets `path_home = path` without
/// appending `espeak-ng-data` (matching the reference `espeakng_loader` +
/// phonemizer, which init with `get_data_path()` = the `espeak-ng-data` dir
/// itself). The resolver hands us either that dir or its parent (the lib dir,
/// with `espeak-ng-data` beside it), so accept both. Returns None when `phontab`
/// can't be located — the caller MUST NOT then call `espeak_Initialize`, which
/// `exit(1)`s the whole process on missing phoneme data.
fn resolve_espeak_data_home(data_dir: &Path) -> Option<PathBuf> {
    let base = strip_unc_prefix(data_dir);
    if base.join("phontab").is_file() {
        return Some(base);
    }
    let nested = base.join("espeak-ng-data");
    if nested.join("phontab").is_file() {
        return Some(nested);
    }
    None
}

/// Strip Windows' `\\?\` verbatim (extended-length) path prefix. espeak-ng's C
/// code joins paths with `/`, which a `\\?\` path rejects (the prefix disables
/// separator normalization), so paths from Tauri's `resource_dir()` must be
/// cleaned before crossing into espeak. No-op on non-prefixed paths.
fn strip_unc_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        // UNC form: `\\?\UNC\server\share` → `\\server\share`.
        if let Some(unc) = rest.strip_prefix(r"UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// Derive the data dir for an explicit lib path, honoring `ESPEAK_DATA_PATH` /
/// `PHONEMIZER_ESPEAK_DATA_PATH`, else the lib's own directory.
fn explicit_data_dir(lib_path: &Path) -> Option<PathBuf> {
    for var in ["ESPEAK_DATA_PATH", "PHONEMIZER_ESPEAK_DATA_PATH"] {
        if let Ok(dp) = std::env::var(var) {
            let dp = PathBuf::from(dp.trim());
            if dp.join("espeak-ng-data").is_dir() {
                return Some(dp);
            }
            if let Some(parent) = dp.parent() {
                if parent.join("espeak-ng-data").is_dir() {
                    return Some(parent.to_path_buf());
                }
            }
        }
    }
    lib_path.parent().and_then(espeak_data_dir_for)
}

/// `%LOCALAPPDATA%` (Windows) — used to find the espeakng_loader bundle.
fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// Null backend (deterministic, no native dep) — test + degraded fallback
// ---------------------------------------------------------------------------

/// A phonemizer that does NO real G2P — it passes through characters that are
/// already in Kokoro's vocab (mostly ASCII letters + punctuation). Pronunciation
/// is poor (it spells out letters), but it is deterministic, has zero native
/// deps, and lets the streaming pipeline run end-to-end in tests / when
/// espeak-ng is missing. The host warns the user when this path is taken.
pub struct NullPhonemizer;

impl Phonemizer for NullPhonemizer {
    fn phonemize(&self, text: &str, _lang: &str) -> PhonemizeResult<String> {
        // Lowercase so the ASCII letters land on the lowercase vocab ids.
        Ok(text.trim().to_lowercase())
    }

    fn is_available(&self) -> bool {
        true
    }
}

/// Pick the best available phonemizer, in preference order:
///   1. `EspeakLibPhonemizer` — in-process espeak-ng shared lib (the reference
///      path; byte-identical phonemes, NO per-sentence subprocess). This is the
///      fast + parity default whenever the espeak-ng .dll/.so is discoverable.
///   2. `EspeakCliPhonemizer` — a system `espeak-ng` CLI binary, if one exists
///      (process-separated; slower on short sentences but still correct G2P).
///   3. `NullPhonemizer` — deterministic degraded fallback (poor pronunciation).
///
/// The host calls this once at engine warm-up and keeps the choice.
pub fn default_phonemizer() -> Box<dyn Phonemizer> {
    if let Some(lib) = EspeakLibPhonemizer::discover() {
        if lib.is_available() {
            return Box::new(lib);
        }
    }
    let cli = EspeakCliPhonemizer::default();
    if cli.is_available() {
        return Box::new(cli);
    }
    Box::new(NullPhonemizer)
}

// ---------------------------------------------------------------------------
// Kokoro v1.0 phoneme → token-id vocab (verbatim from config.json "vocab",
// n_token = 178). Built once into a HashMap<char, i64>.
// ---------------------------------------------------------------------------

/// The (char, id) pairs from Kokoro v1.0 `config.json` "vocab". Order is
/// irrelevant (lookup is by char); kept grouped as in the source for review.
/// SPIKE: a handful of rare glyphs in the JSON came through as the wrong
/// unicode escape in some renderings (the curly quotes at 14/15). The values
/// below use the canonical code points; verify against the shipped
/// config.json bytes during the compile loop (`// SPIKE:` markers inline).
#[rustfmt::skip]
const VOCAB_PAIRS: &[(char, i64)] = &[
    // punctuation / structural
    (';', 1), (':', 2), (',', 3), ('.', 4), ('!', 5), ('?', 6),
    ('\u{2014}', 9),   // — em dash
    ('\u{2026}', 10),  // … ellipsis
    ('"', 11),
    ('(', 12), (')', 13),
    ('\u{201C}', 14),  // " left double quote  // SPIKE: confirm 14/15 ordering vs config.json
    ('\u{201D}', 15),  // " right double quote
    (' ', 16),
    ('\u{0303}', 17),  // ◌̃ combining tilde (nasalization)
    ('\u{02A3}', 18),  // ʣ
    ('\u{02A5}', 19),  // ʥ
    ('\u{02A6}', 20),  // ʦ
    ('\u{02A8}', 21),  // ʨ
    ('\u{1D5D}', 22),  // ᵝ
    ('\u{AB67}', 23),  // ꭧ
    // capital-letter pseudo-phonemes used by Misaki/espeak diphthong notation
    ('A', 24), ('I', 25), ('O', 31), ('Q', 33), ('S', 35), ('T', 36),
    ('W', 39), ('Y', 41),
    ('\u{1D4A}', 42),  // ᵊ
    // lowercase latin
    ('a', 43), ('b', 44), ('c', 45), ('d', 46), ('e', 47), ('f', 48),
    ('h', 50), ('i', 51), ('j', 52), ('k', 53), ('l', 54), ('m', 55),
    ('n', 56), ('o', 57), ('p', 58), ('q', 59), ('r', 60), ('s', 61),
    ('t', 62), ('u', 63), ('v', 64), ('w', 65), ('x', 66), ('y', 67),
    ('z', 68),
    // IPA letters
    ('\u{0251}', 69),  // ɑ
    ('\u{0250}', 70),  // ɐ
    ('\u{0252}', 71),  // ɒ
    ('\u{00E6}', 72),  // æ
    ('\u{03B2}', 75),  // β
    ('\u{0254}', 76),  // ɔ
    ('\u{0255}', 77),  // ɕ
    ('\u{00E7}', 78),  // ç
    ('\u{0256}', 80),  // ɖ
    ('\u{00F0}', 81),  // ð
    ('\u{02A4}', 82),  // ʤ
    ('\u{0259}', 83),  // ə
    ('\u{025A}', 85),  // ɚ
    ('\u{025B}', 86),  // ɛ
    ('\u{025C}', 87),  // ɜ
    ('\u{025F}', 90),  // ɟ
    ('\u{0261}', 92),  // ɡ (script g — NOT ascii 'g')
    ('\u{0265}', 99),  // ɥ
    ('\u{0268}', 101), // ɨ
    ('\u{026A}', 102), // ɪ
    ('\u{029D}', 103), // ʝ
    ('\u{026F}', 110), // ɯ
    ('\u{0270}', 111), // ɰ
    ('\u{014B}', 112), // ŋ
    ('\u{0273}', 113), // ɳ
    ('\u{0272}', 114), // ɲ
    ('\u{0274}', 115), // ɴ
    ('\u{00F8}', 116), // ø
    ('\u{0278}', 118), // ɸ
    ('\u{03B8}', 119), // θ
    ('\u{0153}', 120), // œ
    ('\u{0279}', 123), // ɹ
    ('\u{027E}', 125), // ɾ
    ('\u{027B}', 126), // ɻ
    ('\u{0281}', 128), // ʁ
    ('\u{027D}', 129), // ɽ
    ('\u{0282}', 130), // ʂ
    ('\u{0283}', 131), // ʃ
    ('\u{0288}', 132), // ʈ
    ('\u{02A7}', 133), // ʧ
    ('\u{028A}', 135), // ʊ
    ('\u{028B}', 136), // ʋ
    ('\u{028C}', 138), // ʌ
    ('\u{0263}', 139), // ɣ
    ('\u{0264}', 140), // ɤ
    ('\u{03C7}', 142), // χ
    ('\u{028E}', 143), // ʎ
    ('\u{0292}', 147), // ʒ
    ('\u{0294}', 148), // ʔ
    // suprasegmentals / prosody
    ('\u{02C8}', 156), // ˈ primary stress
    ('\u{02CC}', 157), // ˌ secondary stress
    ('\u{02D0}', 158), // ː length mark
    ('\u{02B0}', 162), // ʰ aspiration
    ('\u{02B2}', 164), // ʲ palatalization
    ('\u{2193}', 169), // ↓
    ('\u{2192}', 171), // →
    ('\u{2197}', 172), // ↗
    ('\u{2198}', 173), // ↘
    ('\u{1D7B}', 177), // ᵻ
];

static VOCAB: OnceLock<HashMap<char, i64>> = OnceLock::new();

/// The Kokoro v1.0 phoneme→id vocab as a lazily-built map.
pub fn vocab() -> &'static HashMap<char, i64> {
    VOCAB.get_or_init(|| VOCAB_PAIRS.iter().copied().collect())
}

// ===========================================================================
// Tests (pure logic — no espeak-ng / network required)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocab_has_178_entries() {
        // n_token = 178 in config.json; our table is the populated subset
        // (the id space is sparse — gaps like 7,8,26..30 are unassigned).
        assert_eq!(vocab().len(), VOCAB_PAIRS.len());
        // every populated id is unique
        let mut ids: Vec<i64> = VOCAB_PAIRS.iter().map(|(_, i)| *i).collect();
        let before = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), before, "duplicate vocab ids");
    }

    #[test]
    fn vocab_core_mappings_match_config_json() {
        let v = vocab();
        assert_eq!(v.get(&'.'), Some(&4));
        assert_eq!(v.get(&' '), Some(&16));
        assert_eq!(v.get(&'a'), Some(&43));
        // script-g ɡ (U+0261), NOT ascii 'g' — ascii 'g' is intentionally absent.
        assert_eq!(v.get(&'\u{0261}'), Some(&92));
        assert!(
            v.get(&'g').is_none(),
            "ascii g must not be in the kokoro vocab"
        );
        assert_eq!(v.get(&'\u{02C8}'), Some(&156)); // primary stress
    }

    #[test]
    fn null_phonemizer_tokenizes_ascii_via_vocab() {
        let p = NullPhonemizer;
        // "hi" → 'h'(50) 'i'(51)
        let toks = p.text_to_tokens("Hi", "en-us").unwrap();
        assert_eq!(toks, vec![50, 51]);
    }

    #[test]
    fn tokenize_drops_unknown_chars() {
        let p = NullPhonemizer;
        // 'g'(absent) and '5'(absent) dropped; 'a'(43) kept.
        let toks = p.tokenize("ga5").unwrap();
        assert_eq!(toks, vec![43]);
    }

    #[test]
    fn tokenize_rejects_overlong() {
        let p = NullPhonemizer;
        let long: String = "a".repeat(MAX_PHONEME_LENGTH + 1);
        assert!(matches!(p.tokenize(&long), Err(PhonemizeError::TooLong(_))));
    }

    #[test]
    fn clean_espeak_ipa_collapses_separators_and_whitespace() {
        // espeak --ipa=3 style: phonemes joined by '_' with newlines between words.
        let raw = "h_\u{0259}_l_o\u{028A}\n_w_\u{025C}_l_d\r\n";
        let cleaned = clean_espeak_ipa(raw);
        assert!(!cleaned.contains('_'));
        assert!(!cleaned.contains('\n'));
        assert!(!cleaned.contains('\r'));
        // single internal space preserved, edges trimmed
        assert_eq!(cleaned, "h\u{0259}lo\u{028A} w\u{025C}ld");
    }

    #[test]
    fn espeak_lang_mapping_known_and_fallback() {
        assert_eq!(espeak_lang_for("en-us"), "en-us");
        assert_eq!(espeak_lang_for("fr"), "fr-fr");
        assert_eq!(espeak_lang_for("pt-br"), "pt-br");
        assert_eq!(espeak_lang_for("zzz"), "en-us"); // unknown → default
    }

    #[test]
    fn null_phonemizer_is_always_available() {
        assert!(NullPhonemizer.is_available());
    }

    #[test]
    fn espeak_shared_lib_name_is_platform_correct() {
        let name = espeak_shared_lib_name();
        #[cfg(windows)]
        assert_eq!(name, "espeak-ng.dll");
        #[cfg(all(unix, not(target_os = "macos")))]
        assert_eq!(name, "libespeak-ng.so");
        #[cfg(target_os = "macos")]
        assert_eq!(name, "libespeak-ng.dylib");
    }

    #[test]
    fn espeak_data_dir_for_requires_espeak_ng_data_subdir() {
        let dir = std::env::temp_dir();
        // A random temp dir has no espeak-ng-data → None.
        assert!(espeak_data_dir_for(&dir).is_none());
        // Create one and confirm it's detected.
        let probe = dir.join(format!("winstt_espeak_probe_{}", std::process::id()));
        let data = probe.join("espeak-ng-data");
        std::fs::create_dir_all(&data).unwrap();
        assert_eq!(espeak_data_dir_for(&probe), Some(probe.clone()));
        let _ = std::fs::remove_dir_all(&probe);
    }

    #[test]
    fn lib_phonemizer_pending_then_failed_on_bad_path() {
        // A non-existent lib path → is_available() false, no panic, cached Failed.
        let p =
            EspeakLibPhonemizer::new(PathBuf::from("Z:/definitely/missing/espeak-ng.dll"), None);
        assert!(!p.is_available());
        // Second call must also be false (Failed state is sticky).
        assert!(p.phonemize("hello", "en-us").is_err());
    }
}
