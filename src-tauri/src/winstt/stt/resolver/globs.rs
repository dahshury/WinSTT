// Pure repo-id + glob resolution: the alias table, repo-id resolution, per-EngineKind file globs,
// and the POSIX glob matcher (resolver sections 1, 2, 3). No I/O, no async.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::sidecars::file_quantization;
use crate::winstt::stt::{EngineKind, Quantization};
use globset::{GlobBuilder, GlobMatcher};
use once_cell::sync::Lazy;

// ---------------------------------------------------------------------------
// 1. Alias / repo-id resolution (resolver.py `model_repos` + the `/`-in-id rule)
// ---------------------------------------------------------------------------

/// onnx-asr's `model_repos` alias table (resolver.py:19-70), ported verbatim. A bare alias
/// (`nemo-parakeet-tdt-0.6b-v3`) maps to a slashed HF repo id; a model that already contains `/`
/// is used verbatim. The VAD / speaker-embedding aliases are included for completeness (the
/// diarization + VAD slices resolve through the same table).
pub const MODEL_REPOS: &[(&str, &str)] = &[
    ("gigaam-v2-ctc", "istupakov/gigaam-v2-onnx"),
    ("gigaam-v2-rnnt", "istupakov/gigaam-v2-onnx"),
    ("gigaam-v3-ctc", "istupakov/gigaam-v3-onnx"),
    ("gigaam-v3-rnnt", "istupakov/gigaam-v3-onnx"),
    ("gigaam-v3-e2e-ctc", "istupakov/gigaam-v3-onnx"),
    ("gigaam-v3-e2e-rnnt", "istupakov/gigaam-v3-onnx"),
    (
        "nemo-fastconformer-ru-ctc",
        "istupakov/stt_ru_fastconformer_hybrid_large_pc_onnx",
    ),
    (
        "nemo-fastconformer-ru-rnnt",
        "istupakov/stt_ru_fastconformer_hybrid_large_pc_onnx",
    ),
    ("nemo-parakeet-ctc-0.6b", "istupakov/parakeet-ctc-0.6b-onnx"),
    (
        "nemo-parakeet-rnnt-0.6b",
        "istupakov/parakeet-rnnt-0.6b-onnx",
    ),
    (
        "nemo-parakeet-tdt-0.6b-v3",
        "istupakov/parakeet-tdt-0.6b-v3-onnx",
    ),
    ("nemo-canary-1b-v2", "istupakov/canary-1b-v2-onnx"),
    ("whisper-base", "istupakov/whisper-base-onnx"),
    ("moonshine-tiny", "onnx-community/moonshine-tiny-ONNX"),
    ("moonshine-base", "onnx-community/moonshine-base-ONNX"),
    ("moonshine-tiny-zh", "onnx-community/moonshine-tiny-zh-ONNX"),
    ("moonshine-tiny-ja", "onnx-community/moonshine-tiny-ja-ONNX"),
    ("moonshine-tiny-ko", "onnx-community/moonshine-tiny-ko-ONNX"),
    ("moonshine-tiny-ar", "onnx-community/moonshine-tiny-ar-ONNX"),
    ("moonshine-tiny-vi", "onnx-community/moonshine-tiny-vi-ONNX"),
    ("moonshine-base-zh", "onnx-community/moonshine-base-zh-ONNX"),
    ("moonshine-base-ja", "onnx-community/moonshine-base-ja-ONNX"),
    ("moonshine-base-ko", "onnx-community/moonshine-base-ko-ONNX"),
    ("moonshine-tiny-uk", "onnx-community/moonshine-tiny-uk-ONNX"),
    ("moonshine-tiny-fr", "onnx-community/moonshine-tiny-fr-ONNX"),
    (
        "cohere-transcribe",
        "onnx-community/cohere-transcribe-03-2026-ONNX",
    ),
    (
        "dolphin-base-ctc",
        "csukuangfj/sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02",
    ),
    (
        "dolphin-small-ctc",
        "csukuangfj/sherpa-onnx-dolphin-small-ctc-multi-lang-int8-2025-04-02",
    ),
    (
        "zipformer-en",
        "csukuangfj/sherpa-onnx-zipformer-en-2023-06-26",
    ),
    (
        "sense-voice-small",
        "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    ),
    ("silero", "istupakov/silero-vad-onnx"),
    (
        "wespeaker-voxceleb-resnet34-LM",
        "Wespeaker/wespeaker-voxceleb-resnet34-LM",
    ),
];

/// True iff `s` is a well-formed Hugging Face repo-id component (an `owner` or a `name`): non-empty,
/// no path-traversal (`..`), no leading/trailing `/` artifacts, and drawn ONLY from the HF id
/// charset `[A-Za-z0-9._-]`. This is the boundary guard that keeps an untrusted, user-supplied
/// `owner/name` from carrying URL meta-characters or `..` into the fixed HF host URL (SSRF /
/// path-traversal). Mirrors the `[A-Za-z0-9._\-/]` repo-id charset, applied per slash-split component.
fn is_valid_hf_repo_component(s: &str) -> bool {
    if s.is_empty() || s.contains("..") {
        return false;
    }
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Map a catalog id / bare alias to a `(owner, name)` HF repo pair. A model id that already
/// contains `/` is split as-is (`onnx-community/whisper-tiny` → `("onnx-community", "whisper-tiny")`);
/// a bare id is resolved through THREE sources, in order:
///   1. the WinSTT catalog (`catalog::find(id).onnx_model_name`) — the authoritative id→repo map the
///      engine-load path already uses (`transcription.rs` builds `ResolveRequest { model_id:
///      entry.onnx_model_name, .. }`). The catalog ships bare ids like `tiny` / `crisper-whisper` /
///      `nemo-canary-1b-flash` whose real HF repo (`onnx-community/whisper-tiny`, …) lives ONLY in
///      `onnx_model_name`, NOT in `MODEL_REPOS`. Without this lookup the per-quant DownloadManager
///      and the cache probe both passed the bare catalog id straight here, got `None`, and silently
///      settled the download as cancelled (badge cleared → "download does nothing / resets to
///      nothing / stuck at 0%") while the model showed "Not downloaded" even when fully cached.
///   2. the `MODEL_REPOS` onnx-asr alias table (Moonshine/NeMo/GigaAM/… aliases the catalog stores
///      verbatim in `onnx_model_name`, so step 1 already covers catalog rows; this remains for any
///      off-catalog alias callers).
///   3. `None` — caller treats it as a local-dir custom model or errors.
///
/// The catalog's `onnx_model_name` is itself either a slashed repo (Whisper/Cohere/Sense/Vosk) or a
/// `MODEL_REPOS` alias (Moonshine/NeMo/GigaAM), so we recurse through it once: a slash splits
/// directly, an alias falls to step 2. The single-level guard (`!= model`) prevents any self-loop.
pub fn resolve_repo(model: &str) -> Option<(String, String)> {
    if let Some((owner, name)) = model.split_once('/') {
        // SSRF / path-traversal guard: a slashed id is taken verbatim and later
        // interpolated into the fixed HF host URL (e.g. hf-hub `client.model(owner, name)`
        // and `https://huggingface.co/api/models/{owner}/{name}` in http_meta.rs). Reject any
        // owner/name that isn't a well-formed HF id BEFORE it can reach a URL. A real HF repo id
        // only ever uses `[A-Za-z0-9._-]` per component and never contains `..`.
        if !is_valid_hf_repo_component(owner) || !is_valid_hf_repo_component(name) {
            return None;
        }
        return Some((owner.to_string(), name.to_string()));
    }
    // 1. Catalog id → real repo / alias (the engine-load path's source of truth).
    if let Some(entry) = crate::winstt::catalog::find(model) {
        let onnx = entry.onnx_model_name;
        if onnx != model {
            if let Some((owner, name)) = onnx.split_once('/') {
                return Some((owner.to_string(), name.to_string()));
            }
            // onnx_model_name is a bare alias (Moonshine/NeMo/GigaAM) → resolve it via MODEL_REPOS.
            if let Some(repo) = MODEL_REPOS
                .iter()
                .find(|(alias, _)| *alias == onnx)
                .map(|(_, r)| *r)
            {
                let (owner, name) = repo.split_once('/')?;
                return Some((owner.to_string(), name.to_string()));
            }
        }
    }
    // 2. Bare onnx-asr alias not on the catalog.
    let repo = MODEL_REPOS
        .iter()
        .find(|(alias, _)| *alias == model)
        .map(|(_, r)| *r)?;
    let (owner, name) = repo.split_once('/')?;
    Some((owner.to_string(), name.to_string()))
}

// ---------------------------------------------------------------------------
// 2. Per-EngineKind file globs (resolver.py model_base + models/*.py `_get_model_files`)
// ---------------------------------------------------------------------------

/// A logical file requirement: the key the engine loader looks up + the quant-suffixed glob.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileGlob {
    pub key: &'static str,
    /// POSIX glob with `/` separators (NEVER a host `Path` — the Windows backslash bug). May start
    /// with `**/` (recurse any depth) or `*/` (one dir level), and uses `?` (single char) as the
    /// quant-separator wildcard so `?int8` matches BOTH `_int8` and `.int8`.
    pub glob: String,
}

/// Build the quant suffix the way every `_get_model_files` does: `"?" + quant` when a quant is set,
/// else `""`. The leading `?` is a single-char glob that matches the `_` (onnx-community) or `.`
/// (Kaldi/sherpa) separator that precedes the quant tag. `Quantization::Default` → no suffix.
pub(crate) fn quant_suffix(quant: Quantization) -> String {
    match quant {
        Quantization::Default => String::new(),
        q => format!("?{}", q.suffix()),
    }
}

fn granite_quant_dir(quant: Quantization) -> &'static str {
    match quant {
        Quantization::Default => "fp32",
        Quantization::Int8 => "int8",
        Quantization::Fp16w => "fp16w",
        _ => quant.suffix(),
    }
}

/// The logical file globs for one engine kind at one quantization. Ported one-for-one from each
/// family's `_get_model_files` (spec §2.2 table; cross-checked against the onnx-asr source).
/// `config.json` / `config.yaml` are ALWAYS added by `download_set()` so they aren't listed here.
///
/// `model_id` is threaded through so the Kaldi arm can pick the right LAYOUT: Vosk packs nest the
/// graphs one dir down (`am/encoder.onnx` + `lang/tokens.txt`), while icefall / sherpa-onnx
/// zipformer packs ship them at the repo ROOT with an epoch-suffixed name
/// (`encoder-epoch-99-avg-1.onnx` …). This mirrors onnx-asr's `IcefallZipformer._get_model_files`
/// override of `KaldiTransducer._get_model_files` (models/kaldi.py L110-118 vs L39-47).
pub fn file_globs(model_id: &str, kind: EngineKind, quant: Quantization) -> Vec<FileGlob> {
    let s = quant_suffix(quant);
    let g = |key: &'static str, glob: String| FileGlob { key, glob };
    match kind {
        EngineKind::WhisperHf => vec![
            g("encoder", format!("**/encoder_model{s}.onnx")),
            g("decoder", format!("**/decoder_model_merged{s}.onnx")),
            g("vocab", "vocab.json".into()),
            g("added_tokens", "added_tokens.json".into()),
        ],
        EngineKind::WhisperOrt => vec![
            // whisper-base-ort layout: encoder/decoder + vocab.json/added_tokens.json (_ort.py).
            g("encoder", format!("**/encoder_model{s}.onnx")),
            g("decoder", format!("**/decoder_model_merged{s}.onnx")),
            g("vocab", "vocab.json".into()),
            g("added_tokens", "added_tokens.json".into()),
        ],
        EngineKind::Moonshine => vec![
            g("encoder", format!("**/encoder_model{s}.onnx")),
            g("decoder", format!("**/decoder_model{s}.onnx")),
            g(
                "decoder_with_past",
                format!("**/decoder_with_past_model{s}.onnx"),
            ),
            g("tokenizer", "tokenizer.json".into()),
            g("tokenizer_config", "tokenizer_config.json".into()),
        ],
        EngineKind::CohereAsr => vec![
            g("encoder", format!("**/encoder_model{s}.onnx")),
            g("decoder", format!("**/decoder_model_merged{s}.onnx")),
            g("tokenizer", "tokenizer.json".into()),
            g("tokenizer_config", "tokenizer_config.json".into()),
        ],
        EngineKind::GraniteSpeechAr => {
            let d = granite_quant_dir(quant);
            vec![
                g("encoder", format!("{d}/encoder.onnx")),
                g("prompt_encode", format!("{d}/prompt_encode.onnx")),
                g("decode_step", format!("{d}/decode_step.onnx")),
                g("embed_tokens", format!("{d}/embed_tokens.onnx")),
                g("tokenizer", "tokenizer.json".into()),
                g("tokenizer_config", "tokenizer_config.json".into()),
                g("preprocessor_config", "preprocessor_config.json".into()),
                g("chat_template", "chat_template.jinja".into()),
            ]
        }
        EngineKind::GraniteSpeechNar => {
            let d = granite_quant_dir(quant);
            vec![
                g("encoder", format!("{d}/encoder.onnx")),
                g("editor", format!("{d}/editor.onnx")),
                g("embed_tokens", format!("{d}/embed_tokens.onnx")),
                g("tokenizer", "tokenizer.json".into()),
                g("tokenizer_config", "tokenizer_config.json".into()),
                g("preprocessor_config", "preprocessor_config.json".into()),
            ]
        }
        EngineKind::Qwen3Asr => vec![
            // andrewleech/qwen3-asr-*-onnx ships at the repo ROOT. The quant suffix (`?int4`) uses
            // the `.` separator (`encoder.int4.onnx`, `decoder_weights.int4.data`); `embed_tokens.bin`
            // is a single fp16 table shared across precisions, so it carries NO suffix.
            g("encoder", format!("encoder{s}.onnx")),
            g("decoder_init", format!("decoder_init{s}.onnx")),
            g("decoder_step", format!("decoder_step{s}.onnx")),
            // Shared external-data blob for BOTH decoder graphs. Not a `<stem>.onnx_data` sidecar, so
            // the automatic sidecar sweep won't find it — it MUST be an explicit logical-key file.
            g("decoder_weights", format!("decoder_weights{s}.data")),
            g("embed_tokens", "embed_tokens.bin".into()),
            g("tokenizer", "tokenizer.json".into()),
            g("tokenizer_config", "tokenizer_config.json".into()),
        ],
        EngineKind::NemoCtc => vec![
            g("model", format!("model{s}.onnx")),
            g("vocab", "vocab.txt".into()),
        ],
        EngineKind::NemoRnnt | EngineKind::NemoTdt => vec![
            g("encoder", format!("encoder-model{s}.onnx")),
            g("decoder_joint", format!("decoder_joint-model{s}.onnx")),
            g("vocab", "vocab.txt".into()),
        ],
        EngineKind::NemoAed => vec![
            g("encoder", format!("encoder-model{s}.onnx")),
            g("decoder", format!("decoder-model{s}.onnx")),
            g("vocab", "vocab.txt".into()),
        ],
        EngineKind::KaldiTransducer => {
            // onnx-asr splits the Kaldi transducer file set by repo layout (models/kaldi.py):
            //   * `KaldiTransducer` (Vosk) nests one dir down: `*/encoder{?q}.onnx`, `*/tokens.txt`.
            //   * `IcefallZipformer` (sherpa-onnx / icefall zipformer) ships at the ROOT with an
            //     epoch suffix: `encoder-*{?q}.onnx`, `decoder-*{?q}.onnx`, `joiner-*{?q}.onnx`,
            //     `tokens.txt`.
            // We select on the model id the catalog uses (`zipformer-en`, `icefall-zipformer`).
            let id = model_id.to_ascii_lowercase();
            if id.contains("zipformer") || id.contains("icefall") {
                vec![
                    g("encoder", format!("encoder-*{s}.onnx")),
                    g("decoder", format!("decoder-*{s}.onnx")),
                    g("joiner", format!("joiner-*{s}.onnx")),
                    g("vocab", "tokens.txt".into()),
                ]
            } else {
                vec![
                    g("encoder", format!("*/encoder{s}.onnx")),
                    g("decoder", format!("*/decoder{s}.onnx")),
                    g("joiner", format!("*/joiner{s}.onnx")),
                    g("vocab", "*/tokens.txt".into()),
                ]
            }
        }
        EngineKind::GigaamCtc => vec![
            // GigaAM v3 e2e ctc: flat root, `v3_e2e_ctc{sfx}.onnx` (gigaam.py:144). The `v?_` glob
            // also covers v2 (`v2_ctc.onnx`); we use the e2e form the catalog ships.
            g("model", format!("v3_e2e_ctc{s}.onnx")),
            g("vocab", "v3_e2e_ctc_vocab.txt".into()),
        ],
        EngineKind::GigaamRnnt => vec![
            g("encoder", format!("v3_e2e_rnnt_encoder{s}.onnx")),
            g("decoder", format!("v3_e2e_rnnt_decoder{s}.onnx")),
            g("joint", format!("v3_e2e_rnnt_joint{s}.onnx")),
            g("vocab", "v3_e2e_rnnt_vocab.txt".into()),
        ],
        EngineKind::ToneCtc => vec![
            // T-One single-graph streaming CTC (models/tone.py): flat `model{sfx}.onnx` only.
            // T-One has NO tokens.txt — its vocabulary lives in `config.json`
            // (decoder_params.vocabulary), which `download_set()` auto-resolves into the
            // "config" key. `_get_model_files` returns just `{"model": "model{?quant}.onnx"}`.
            g("model", format!("model{s}.onnx")),
        ],
        EngineKind::DolphinCtc | EngineKind::SenseVoiceCtc => vec![
            // Both ship a flat root `model{?quant}.onnx` + `tokens.txt` (dolphin.py / sense_voice.py).
            g("model", format!("model{s}.onnx")),
            g("vocab", "tokens.txt".into()),
        ],
        // sherpa-format streaming packs (driven by WinSTT native ORT streaming engines):
        EngineKind::NemoCtcStreaming => vec![
            // streaming NeMo FastConformer CTC: flat `model{?q}.onnx` + `tokens.txt`.
            g("model", format!("model{s}.onnx")),
            g("vocab", "tokens.txt".into()),
        ],
        EngineKind::NemoRnntStreaming => vec![
            // streaming NeMo RNN-T: flat encoder/decoder/joiner + `tokens.txt`.
            g("encoder", format!("encoder{s}.onnx")),
            g("decoder", format!("decoder{s}.onnx")),
            g("joiner", format!("joiner{s}.onnx")),
            g("vocab", "tokens.txt".into()),
        ],
        EngineKind::KaldiTransducerStreaming => vec![
            // streaming Zipformer2 publishes left-64 and left-128 graph sets in the same repo.
            // Pick left-128 deterministically so the loose epoch glob does not resolve ambiguously.
            g("encoder", format!("encoder-*chunk-16-left-128{s}.onnx")),
            g("decoder", format!("decoder-*chunk-16-left-128{s}.onnx")),
            g("joiner", format!("joiner-*chunk-16-left-128{s}.onnx")),
            g("vocab", "tokens.txt".into()),
        ],
    }
}

/// Resolve a set of glob matches to ONE path, applying a Kaldi-scoped tie-break.
///
/// The icefall/zipformer root globs (`encoder-*{?q}.onnx`) are intentionally loose so they catch
/// the epoch-suffixed name (`encoder-epoch-99-avg-1.onnx`). But for the DEFAULT (unsuffixed) quant
/// the `*` after `encoder-` ALSO spans the `.int8` / `.fp16` separator, so a repo that ships both
/// precisions yields >1 match (`encoder-epoch-99-avg-1.onnx` AND `encoder-epoch-99-avg-1.int8.onnx`).
/// The resolver normally errors on >1 match; for Kaldi we instead pick the file whose stem carries
/// NO recognised quant tag (the shortest stem — the default export). For a NON-Kaldi kind, or when
/// a single match exists, behaviour is unchanged (0 = caller's not-found error, >1 = error).
///
/// `matches` are POSIX repo paths. Returns `Ok(Some(path))` for a unique/resolved match, `Ok(None)`
/// for zero matches (caller raises the family-specific "missing" error), and `Err(())` only when
/// the tie-break could not disambiguate (>1 match that are all untagged, or a non-Kaldi >1).
pub(crate) fn pick_kaldi_tiebreak<'a>(
    kind: EngineKind,
    matches: &[&'a String],
) -> Result<Option<&'a String>, ()> {
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches[0])),
        _ if matches!(
            kind,
            EngineKind::KaldiTransducer | EngineKind::KaldiTransducerStreaming
        ) =>
        {
            // Keep only the matches with NO quant tag on the `.onnx` stem (the default export).
            // `tokens.txt` (vocab) never has a tag, so this only ever fires on the graph globs.
            let untagged: Vec<&&'a String> = matches
                .iter()
                .filter(|p| {
                    let fname: &str = p.rsplit('/').next().unwrap_or(p.as_str());
                    file_quantization(fname) == Quantization::Default
                })
                .collect();
            match untagged.len() {
                1 => Ok(Some(untagged[0])),
                _ => Err(()), // 0 (all tagged) or >1 (ambiguous) → can't disambiguate.
            }
        }
        _ => Err(()), // non-Kaldi: >1 match is genuinely ambiguous → error.
    }
}

// ---------------------------------------------------------------------------
// 3. POSIX glob matching (forward-slash; `**` / `*` / `?` semantics)
// ---------------------------------------------------------------------------

static GLOB_MATCHER_CACHE: Lazy<Mutex<HashMap<String, Option<Arc<GlobMatcher>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Match a POSIX repo path against one of our `_get_model_files` globs. Semantics mirror Python's
/// `pathlib.Path.glob` as onnx-asr uses it:
///   * `**` matches any number of path segments (including zero);
///   * `*`  matches within a single segment (not across `/`);
///   * `?`  matches exactly one character (the quant-separator wildcard);
///   * everything else is literal.
///
/// `path` MUST be a forward-slash POSIX path (an HF repo path is always POSIX). We normalise any
/// stray backslash to `/` defensively so a Windows-side comparison can't silently miss.
pub fn glob_match(glob: &str, path: &str) -> bool {
    let path = path.replace('\\', "/");
    compiled_glob_matcher(glob).is_some_and(|matcher| matcher.is_match(path.as_str()))
}

fn compiled_glob_matcher(glob: &str) -> Option<Arc<GlobMatcher>> {
    // `**` — matches any number of segments. Two forms: `**/rest` and trailing `**`.
    let pattern = globset_pattern(glob);
    let mut cache = GLOB_MATCHER_CACHE.lock().ok()?;
    if let Some(cached) = cache.get(&pattern) {
        return cached.clone();
    }

    let matcher = GlobBuilder::new(&pattern)
        .literal_separator(true)
        .backslash_escape(true)
        .build()
        .ok()
        .map(|glob| Arc::new(glob.compile_matcher()));
    cache.insert(pattern, matcher.clone());
    matcher
}

fn globset_pattern(glob: &str) -> String {
    let mut pattern = String::with_capacity(glob.len());
    for ch in glob.chars() {
        match ch {
            '*' | '?' | '/' => pattern.push(ch),
            '[' | ']' | '{' | '}' | '\\' => {
                pattern.push('\\');
                pattern.push(ch);
            }
            _ => pattern.push(ch),
        }
    }
    pattern
}
