// ═════════════════════════════════════════════════════════════════════════════
// 4. Configuration — the inputs the manager needs to stand up a KeywordSpotter.
// ═════════════════════════════════════════════════════════════════════════════

use std::path::{Path, PathBuf};

use super::presets::normalize_name;
use super::tokenize::THRESHOLD_MIN;

/// Inference provider for the KWS session.
///
/// INVARIANT: the KWS session is tiny and runs continuously, so keep it on CPU
/// regardless of the STT accelerator. This also avoids sherpa-onnx's DirectML
/// provider probe during startup, which logs a misleading "DirectML is for
/// Windows only" fallback from the native library on some Windows builds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WakeWordProvider {
    #[default]
    Cpu,
    DirectMl,
}

impl WakeWordProvider {
    pub fn from_stt_accelerator(_accel: crate::winstt::stt::Accelerator) -> Self {
        WakeWordProvider::Cpu
    }

    /// String passed into sherpa's `OnlineModelConfig::provider`.
    pub fn as_sherpa_str(self) -> &'static str {
        match self {
            WakeWordProvider::Cpu => "cpu",
            WakeWordProvider::DirectMl => "directml",
        }
    }
}

/// Paths to the four files of a sherpa-onnx KWS zipformer model bundle.
/// (encoder/decoder/joiner ONNX + tokens.txt). Downloaded once from the
/// `kws-models` GitHub release — e.g. `sherpa-onnx-kws-zipformer-gigaspeech-3.3M`
/// (English) or `…-zh-en-3M-2025-12-20` (bilingual). `bpe.model` lives alongside
/// these files and is used at runtime for exact keyword tokenization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KwsModelPaths {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
}

/// The gigaspeech English KWS bundle (the default wake-word model). Files match
/// the upstream `kws-models` release layout
/// (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`):
/// `encoder/decoder/joiner-epoch-12-avg-2-chunk-16-left-64.onnx` + `tokens.txt`.
pub const KWS_BUNDLE_DIRNAME: &str = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
pub const KWS_ENCODER_FILE: &str = "encoder-epoch-12-avg-2-chunk-16-left-64.onnx";
pub const KWS_DECODER_FILE: &str = "decoder-epoch-12-avg-2-chunk-16-left-64.onnx";
pub const KWS_JOINER_FILE: &str = "joiner-epoch-12-avg-2-chunk-16-left-64.onnx";
pub const KWS_ENCODER_INT8_FILE: &str = "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const KWS_DECODER_INT8_FILE: &str = "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const KWS_JOINER_INT8_FILE: &str = "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx";
pub const KWS_TOKENS_FILE: &str = "tokens.txt";
pub const KWS_BPE_FILE: &str = "bpe.model";

impl KwsModelPaths {
    /// Resolve the four bundle files under `bundle_dir` (the directory the model
    /// archive was extracted into). Pure path joining — does NOT check existence
    /// (use [`KwsModelPaths::all_present`] for that).
    pub fn from_bundle_dir(bundle_dir: &Path) -> Self {
        KwsModelPaths {
            encoder: bundle_dir.join(KWS_ENCODER_FILE),
            decoder: bundle_dir.join(KWS_DECODER_FILE),
            joiner: bundle_dir.join(KWS_JOINER_FILE),
            tokens: bundle_dir.join(KWS_TOKENS_FILE),
        }
    }

    /// Resolve the quantized int8 model files in the same upstream bundle.
    /// The token vocabulary is shared with the fp32 files.
    pub fn from_bundle_dir_int8(bundle_dir: &Path) -> Self {
        KwsModelPaths {
            encoder: bundle_dir.join(KWS_ENCODER_INT8_FILE),
            decoder: bundle_dir.join(KWS_DECODER_INT8_FILE),
            joiner: bundle_dir.join(KWS_JOINER_INT8_FILE),
            tokens: bundle_dir.join(KWS_TOKENS_FILE),
        }
    }

    /// True only when all four required files exist on disk (a complete bundle).
    /// The detector cannot stand up against a partial download, so the manager
    /// gates `WakeWordDetector::new` on this.
    pub fn all_present(&self) -> bool {
        self.encoder.exists()
            && self.decoder.exists()
            && self.joiner.exists()
            && self.tokens.exists()
    }

    pub fn bpe_model(&self) -> PathBuf {
        self.tokens
            .parent()
            .map(|dir| dir.join(KWS_BPE_FILE))
            .unwrap_or_else(|| PathBuf::from(KWS_BPE_FILE))
    }
}

/// Extracted pvporcupine 1.9.5 wheel layout under the app data wakeword dir.
/// The detector loads the native library dynamically so the main binary does not
/// link against or bundle Porcupine by default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyPorcupinePaths {
    pub root: PathBuf,
}

impl LegacyPorcupinePaths {
    pub const DIRNAME: &'static str = "pvporcupine-1.9.5";

    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn library(&self) -> PathBuf {
        self.package_root().join(Self::library_relative_path())
    }

    pub fn model(&self) -> PathBuf {
        self.package_root()
            .join("lib")
            .join("common")
            .join("porcupine_params.pv")
    }

    pub fn keyword(&self, keyword: &str) -> PathBuf {
        self.package_root()
            .join("resources")
            .join("keyword_files")
            .join(Self::keyword_platform_dir())
            .join(format!(
                "{}_{}.ppn",
                normalize_name(keyword),
                Self::keyword_platform_suffix()
            ))
    }

    pub fn all_present_for_keyword(&self, keyword: &str) -> bool {
        self.library().exists() && self.model().exists() && self.keyword(keyword).exists()
    }

    pub fn platform_supported() -> bool {
        Self::library_relative_path_opt().is_some()
    }

    fn package_root(&self) -> PathBuf {
        self.root.join("pvporcupine")
    }

    fn library_relative_path() -> PathBuf {
        Self::library_relative_path_opt().unwrap_or_else(|| PathBuf::from("__unsupported__"))
    }

    fn library_relative_path_opt() -> Option<PathBuf> {
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        {
            return Some(PathBuf::from("lib/windows/amd64/libpv_porcupine.dll"));
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            return Some(PathBuf::from("lib/linux/x86_64/libpv_porcupine.so"));
        }
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        {
            return Some(PathBuf::from("lib/mac/x86_64/libpv_porcupine.dylib"));
        }
        #[allow(unreachable_code)]
        None
    }

    fn keyword_platform_dir() -> &'static str {
        #[cfg(target_os = "windows")]
        {
            return "windows";
        }
        #[cfg(target_os = "linux")]
        {
            return "linux";
        }
        #[cfg(target_os = "macos")]
        {
            return "mac";
        }
        #[allow(unreachable_code)]
        "unsupported"
    }

    fn keyword_platform_suffix() -> &'static str {
        #[cfg(target_os = "windows")]
        {
            return "windows";
        }
        #[cfg(target_os = "linux")]
        {
            return "linux";
        }
        #[cfg(target_os = "macos")]
        {
            return "mac";
        }
        #[allow(unreachable_code)]
        "unsupported"
    }
}

/// Everything needed to build/refresh a live keyword spotter.
#[derive(Debug, Clone, PartialEq)]
pub struct WakeWordConfig {
    pub model: KwsModelPaths,
    /// Path to the generated `keywords.txt`, if the keywords are written to disk.
    /// `None` ⇒ pass the keyword content inline via `keywords_content`
    /// (`keywords_buf` — no temp file). The manager picks one; both are honored.
    pub keywords_file: Option<PathBuf>,
    /// Inline keywords content (the body produced by [`build_keywords_file`]).
    /// Used as sherpa's `keywords_buf` when present; lets the detector stand up
    /// without writing a temp file. Required if `keywords_file` is `None`.
    pub keywords_content: Option<String>,
    /// Ordered active keyword phrases (label half). Index == `word_index`.
    pub keywords: Vec<String>,
    pub provider: WakeWordProvider,
    /// 0..1 UI sensitivity, mapped to the per-keyword `#threshold`.
    pub sensitivity: f32,
    /// Seconds the wake gate stays armed after a hit (`general.wakeWordTimeout`,
    /// default 5). Enforced by the recorder state machine, NOT this module — we
    /// carry it for the manager to read.
    pub timeout_seconds: f32,
    pub num_threads: Option<i32>,
    /// Global sherpa `keywords_score`. `None` keeps the WinSTT default.
    pub keywords_score: Option<f32>,
}

impl WakeWordConfig {
    /// The global `keywords_threshold` for `KeywordSpotterConfig`. We push the REAL
    /// per-keyword thresholds into the keywords content (`#t` suffix), and keep the
    /// config global at the LOOSEST end so a per-keyword `#t` can only TIGHTEN,
    /// never loosen below it. (sherpa applies the per-keyword `#t` on top of the
    /// global; a global stricter than a `#t` would mask it.)
    pub fn global_threshold(&self) -> f32 {
        THRESHOLD_MIN
    }

    /// Default boost (`keywords_score`). sherpa default is 1.0; we lift it to 3.0
    /// to match Porcupine's out-of-box recall for 3+ token phrases. Short triggers
    /// (≤2 syllables) get a recall spike when boosted — see the SHORT-TRIGGER note
    /// in 05_*.md (mitigated per-keyword via `:boost`/`#threshold` suffixes).
    pub fn default_boost(&self) -> f32 {
        self.keywords_score.unwrap_or(3.0)
    }

    /// Resolve the keyword content the detector should hand to sherpa, preferring
    /// the on-disk file when present (sherpa reads it itself), else the inline buf.
    /// Returns `None` when neither is set (the detector then has zero keywords —
    /// a programming error the manager guards against, but we don't panic).
    pub(super) fn keywords_inline(&self) -> Option<&str> {
        self.keywords_content.as_deref()
    }
}
