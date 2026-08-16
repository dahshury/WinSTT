// Generic TTS model download manager — gives the multi-provider picker the same
// download UX as STT (progress / pause / resume / cancel / delete + per-model
// cache state), but self-contained for the TTS catalog (HF-hosted ONNX models).
//
// Files for a model land under `%LOCALAPPDATA%/winstt/tts/<model-id>/`, preserving
// each file's HF sub-path (so the engines' cache_dir layout matches). Download is
// resumable via HTTP Range (`.partial` → atomic rename), mirroring the Kokoro
// downloader in tts/mod.rs. Progress is aggregated across a model's file set
// against the catalog's quant size.
//
// Wire contract (events):
//   tts:model-download-progress { model, quantization, progress, downloadedBytes, totalBytes }
//   tts:model-download-complete { model, quantization, cancelled }
//   tts:model-cache-changed     { modelId }

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::winstt::downloads::{
    PauseCancelFlags, TransferOutcome, TransferProgress, TransferRequest, onnx_is_truncated,
    transfer_url_blocking,
};
use crate::winstt::sync_ext::MutexExt;
use crate::winstt::tts::catalog::{self, TtsEngineId, TtsModelEntry};
use crate::winstt::tts::local_engines::{PIPER_DEFAULT_VOICE, piper_voice_def};
use crate::winstt::tts::voice_by_id;

fn catalog_model_id(model_id: &str) -> Option<&'static str> {
    catalog::find(model_id).map(|entry| entry.id)
}

fn kokoro_voice_id(voice_id: &str) -> Option<&'static str> {
    voice_by_id(voice_id).map(|voice| voice.id)
}

/// Per-quant cache state (mirrors the STT `CacheState` strings the picker reads).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtsCacheState {
    Cached,
    Partial,
    NotCached,
}
impl TtsCacheState {
    pub fn as_str(self) -> &'static str {
        match self {
            TtsCacheState::Cached => "cached",
            TtsCacheState::Partial => "partial",
            TtsCacheState::NotCached => "not_cached",
        }
    }
}

#[derive(Clone, Debug)]
pub struct TtsCacheInfo {
    pub state: TtsCacheState,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub progress: f64,
}

pub struct TtsDownloadManager {
    app: AppHandle,
    client: reqwest::Client,
    inflight: Mutex<HashMap<String, Arc<PauseCancelFlags>>>,
}

impl TtsDownloadManager {
    pub fn new(app: &AppHandle) -> Self {
        let client = reqwest::Client::builder()
            .user_agent("WinSTT/0.1")
            .build()
            .expect("reqwest TLS init");
        let manager = Self {
            app: app.clone(),
            client,
            inflight: Mutex::new(HashMap::new()),
        };
        manager.cleanup_legacy_supertonic_cache();
        manager
    }

    fn key(model_id: &str, quant: &str) -> String {
        format!("{model_id}@{quant}")
    }

    fn partial_path_for(target: &Path) -> PathBuf {
        target.with_file_name(format!(
            "{}.partial",
            target.file_name().and_then(|n| n.to_str()).unwrap_or("dl")
        ))
    }

    fn path_len(path: &Path) -> u64 {
        std::fs::metadata(path).map_or(0, |m| m.len())
    }

    fn cached_or_partial_bytes(target: &Path) -> u64 {
        if Self::is_cached_file(target) {
            return Self::path_len(target);
        }
        Self::path_len(&Self::partial_path_for(target))
    }

    /// A cached file counts as present only if it is also structurally intact. Existence alone used
    /// to be the test, which let a mid-transfer truncation sit in the cache forever: every pass saw
    /// the file, skipped it, and reported the model 100% downloaded, while loading it failed with
    /// "Protobuf parsing failed". See [`onnx_is_truncated`].
    fn is_cached_file(target: &Path) -> bool {
        if !target.exists() {
            return false;
        }
        if target.extension().is_some_and(|e| e == "onnx") && onnx_is_truncated(target) {
            log::warn!(
                "[tts] cached ONNX is truncated, will re-download: {}",
                target.display()
            );
            return false;
        }
        true
    }

    fn remote_content_length(&self, url: &str) -> Option<u64> {
        tauri::async_runtime::block_on(async {
            self.client
                .head(url)
                .send()
                .await
                .ok()
                .filter(|r| r.status().is_success())
                .and_then(|r| r.content_length())
        })
    }

    fn aggregate_total(file_totals: &[u64], fallback_total: u64) -> u64 {
        let known_sum = file_totals.iter().copied().sum::<u64>();
        if known_sum > 0 && file_totals.iter().all(|t| *t > 0) {
            known_sum
        } else {
            known_sum.max(fallback_total)
        }
    }

    fn emit_catalog_progress(&self, model_id: &str, quant: &str, downloaded: u64, total: u64) {
        let progress = crate::winstt::downloads::progress_fraction_of(downloaded, total);
        let _ = self.app.emit(
            "tts:catalog-model-download-progress",
            json!({
                "model": model_id,
                "quantization": quant,
                "progress": progress,
                "downloadedBytes": downloaded,
                "totalBytes": total.max(downloaded),
            }),
        );
    }

    /// `%LOCALAPPDATA%/winstt/tts/<model-id>/`.
    pub fn model_cache_dir(&self, model_id: &str) -> PathBuf {
        crate::winstt::tts::cache_dir(&self.app, model_id)
    }

    fn cleanup_legacy_supertonic_cache(&self) {
        for legacy_id in ["supertonic-en", "supertonic"] {
            let dir = self.model_cache_dir(legacy_id);
            if !dir.exists() {
                continue;
            }
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => log::info!("[tts] removed legacy Supertonic cache at {}", dir.display()),
                Err(err) => log::warn!(
                    "[tts] failed to remove legacy Supertonic cache at {}: {err}",
                    dir.display()
                ),
            }
        }
    }

    /// The (HF-url, local-absolute-path) pairs to fetch for a model+quant.
    /// Local paths mirror the HF sub-path except where an engine wants them flat.
    pub fn manifest(&self, entry: &TtsModelEntry, quant: &str) -> Vec<(String, PathBuf)> {
        Self::manifest_in(entry, quant, &self.model_cache_dir(entry.id))
    }

    /// [`Self::manifest`] against an EXPLICIT model directory.
    ///
    /// The whole manifest is a pure function of (row, quant, dir) — nothing here reads
    /// runtime state — and splitting the directory out is what lets the catalog-wide
    /// size audit in this module's tests walk every row without an `AppHandle`.
    pub fn manifest_in(entry: &TtsModelEntry, quant: &str, dir: &Path) -> Vec<(String, PathBuf)> {
        let url = |p: &str| {
            format!(
                "https://huggingface.co/{}/resolve/main/{}",
                entry.hf_repo, p
            )
        };
        // Qwen3-TTS Voice Design pulls weights + config/tokenizer from TWO repos, so
        // it emits fully-qualified (url, local) pairs directly (the shared `url()`
        // only knows `entry.hf_repo`). See PORT_SPEC §1 + BUILD_PLAN "Wiring".
        if matches!(entry.engine, TtsEngineId::Qwen3Tts) {
            return Self::qwen3_tts_manifest(entry, quant, dir);
        }
        // Orpheus pulls the LLM from `entry.hf_repo` and the SNAC vocoder from a SECOND repo
        // (onnx-community/snac_24khz-ONNX), so it emits fully-qualified (url, local) pairs.
        if matches!(entry.engine, TtsEngineId::Orpheus) {
            return Self::orpheus_manifest(entry, dir);
        }
        // Spark pulls the LLM/vocoder/tokenizer from `entry.hf_repo` (Fhrozen) and the zero-shot
        // CLONING graphs from a SECOND repo (DgDev91/SparkTTS-ONNX), so it also emits fully-qualified
        // pairs. The 4 cloning graphs land flat in the cache dir for `SparkEngine::load_cloning`.
        if matches!(entry.engine, TtsEngineId::Spark) {
            return Self::spark_manifest(entry, dir);
        }
        // NeuTTS-2e pulls the backbone from `entry.hf_repo` and the NeuCodec decoder from one
        // of TWO first-party repos (one per precision), so it emits fully-qualified pairs.
        if matches!(entry.engine, TtsEngineId::NeuTts) {
            return Self::neutts_manifest(entry, quant, dir);
        }
        // OmniVoice spans THREE repos: the fused step graph (+ its 2.45 GB external-data
        // sidecar) is only published by the WebGPU-demo asset repo, tokenizer.json by upstream
        // k2-fsa, and the four audio_tokenizer graphs by onnx-community.
        if matches!(entry.engine, TtsEngineId::OmniVoice) {
            return Self::omnivoice_manifest(dir);
        }
        // (hf_path, local_relative)
        let pairs: Vec<(String, String)> = match entry.engine {
            TtsEngineId::Kitten => {
                // The graph filename differs per Kitten model (v0.1 vs v0.2); the
                // voices.npz + config.json names are shared. Read the graph name from
                // the catalog id so the right model file is fetched from its repo.
                let graph = catalog::kitten_model_file(entry.id);
                vec![
                    (graph.to_string(), graph.to_string()),
                    ("voices.npz".into(), "voices.npz".into()),
                    ("config.json".into(), "config.json".into()),
                ]
            }
            TtsEngineId::Piper => {
                // Piper is unlike the other engines: each "voice" is its OWN full VITS
                // model (~30-90 MB), and the curated set totals ~3.4 GB — far too large
                // to ship as one model download. So the model download is the DEFAULT
                // voice's two files; every other voice is fetched on first selection via
                // `ensure_voice`. Files land FLAT (`{stem}.onnx[.json]`) for the engine's
                // cache_dir. (Pending a product call on whether to bundle all of them.)
                let def = piper_voice_def(PIPER_DEFAULT_VOICE);
                match def {
                    Some(d) => vec![
                        (
                            format!("{}/{}.onnx", d.subdir, d.stem),
                            format!("{}.onnx", d.stem),
                        ),
                        (
                            format!("{}/{}.onnx.json", d.subdir, d.stem),
                            format!("{}.onnx.json", d.stem),
                        ),
                    ],
                    None => Vec::new(),
                }
            }
            TtsEngineId::Supertonic => {
                let mut v: Vec<(String, String)> = Vec::new();
                for g in [
                    "duration_predictor",
                    "text_encoder",
                    "vector_estimator",
                    "vocoder",
                ] {
                    v.push((format!("onnx/{g}.onnx"), format!("onnx/{g}.onnx")));
                }
                v.push(("onnx/tts.json".into(), "onnx/tts.json".into()));
                v.push((
                    "onnx/unicode_indexer.json".into(),
                    "onnx/unicode_indexer.json".into(),
                ));
                for nm in ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] {
                    v.push((
                        format!("voice_styles/{nm}.json"),
                        format!("voice_styles/{nm}.json"),
                    ));
                }
                v
            }
            TtsEngineId::Kokoro => {
                // onnx-community layout: the quant graph + ALL 54 voice `.bin`s
                // (~510 KB each, ~28 MB total) in ONE download — so every voice works
                // the moment the model finishes downloading (no per-voice lazy fetch /
                // missing-voice surprises). (`ensure_voice` stays as a no-op safety for
                // partial caches.)
                let mut v: Vec<(String, String)> = Vec::new();
                let graph = match quant {
                    "fp32" => "model.onnx",
                    "q8f16" => "model_q8f16.onnx",
                    _ => "model_fp16.onnx",
                };
                v.push((format!("onnx/{graph}"), format!("onnx/{graph}")));
                for vi in crate::winstt::tts::KOKORO_VOICE_CATALOG {
                    v.push((
                        format!("voices/{}.bin", vi.id),
                        format!("voices/{}.bin", vi.id),
                    ));
                }
                v
            }
            // Audio8: single repo, fixed file set (int4 AR graphs + fp16 codec decoder +
            // tokenizer + the registration encoder that makes runtime cloning possible).
            // The two tiny manifest JSONs upstream ships are NOT fetched — their values
            // are inlined as constants in `audio8.rs` (this port pins one export).
            TtsEngineId::Audio8 => [
                "slow_ar_int4.onnx",
                "slow_ar_int4.onnx.data",
                "fast_ar_int4.onnx",
                "fast_ar_int4.onnx.data",
                "codec_decoder_fp16.onnx",
                "codec_decoder_fp16.onnx.data",
                "registration/codec_encoder_fp16.onnx",
                "registration/codec_encoder_fp16.onnx.data",
                "tokenizer/tokenizer.json",
            ]
            .iter()
            .map(|p| ((*p).to_string(), (*p).to_string()))
            .collect(),
            // Chatterbox emits fully-qualified pairs: only the multilingual repo publishes
            // a `default_voice.wav`, so turbo/nano borrow it from there (second repo).
            TtsEngineId::Chatterbox => return Self::chatterbox_manifest(entry, quant, dir),
            // Handled above via early return (two-repo / multi-repo, fully-qualified URLs).
            TtsEngineId::Qwen3Tts => unreachable!("qwen3-tts manifest is built above"),
            TtsEngineId::Orpheus => unreachable!("orpheus manifest is built above"),
            TtsEngineId::Spark => unreachable!("spark manifest is built above"),
            TtsEngineId::NeuTts => unreachable!("neutts manifest is built above"),
            TtsEngineId::OmniVoice => unreachable!("omnivoice manifest is built above"),
        };
        pairs
            .into_iter()
            .map(|(hf, local)| (url(&hf), dir.join(local)))
            .collect()
    }

    /// Chatterbox manifest — the 4 graphs (each with its external-data sidecar) + tokenizer
    /// + the per-export config JSONs, plus the shared `default_voice.wav`.
    ///
    /// Two things make this multi-repo / per-graph rather than one suffix + one repo:
    ///   * every export picks its quant suffix PER GRAPH (nano MIXES q4 / fp16 / q4f16), so
    ///     the filenames come from `catalog::chatterbox_graph_set` — the SAME function the
    ///     engine loads through, so the fetched files and the opened sessions cannot drift;
    ///   * only `onnx-community/chatterbox-multilingual-ONNX` publishes a default reference
    ///     clip, so turbo/nano fetch `default_voice.wav` from there. Without it the
    ///     "Default voice" entry (the non-cloning affordance) has nothing to condition on.
    ///
    /// The config JSONs are tiny (< 2 KB total) and document the export's `kv_cache_dtype`
    /// / layer count, which is exactly what the engine introspects — worth keeping beside
    /// the weights for diagnosis.
    fn chatterbox_manifest(
        entry: &TtsModelEntry,
        quant: &str,
        dir: &Path,
    ) -> Vec<(String, PathBuf)> {
        let repo_url = |p: &str| {
            format!(
                "https://huggingface.co/{}/resolve/main/{}",
                entry.hf_repo, p
            )
        };
        let graphs = catalog::chatterbox_graph_set(entry.id, quant);
        let mut pairs: Vec<(String, PathBuf)> = Vec::new();
        for g in [
            graphs.language_model,
            graphs.embed_tokens,
            graphs.speech_encoder,
            graphs.conditional_decoder,
        ] {
            pairs.push((repo_url(&format!("onnx/{g}")), dir.join("onnx").join(g)));
            let sidecar = format!("{g}_data");
            pairs.push((
                repo_url(&format!("onnx/{sidecar}")),
                dir.join("onnx").join(&sidecar),
            ));
        }
        pairs.push((repo_url("tokenizer.json"), dir.join("tokenizer.json")));
        // The multilingual export ships neither the HF config JSONs nor a GPT-2 tokenizer
        // config; turbo/nano do. Guard so the older entry's file set is unchanged.
        if entry.id != "chatterbox-multilingual" {
            for f in [
                "tokenizer_config.json",
                "config.json",
                "generation_config.json",
                "preprocessor_config.json",
            ] {
                pairs.push((repo_url(f), dir.join(f)));
            }
        }
        pairs.push((
            "https://huggingface.co/onnx-community/chatterbox-multilingual-ONNX/resolve/main/default_voice.wav".to_string(),
            dir.join("default_voice.wav"),
        ));
        pairs
    }

    /// Qwen3-TTS Voice Design manifest (PORT_SPEC §1 + BUILD_PLAN "Wiring"):
    ///   - ONNX weights from `entry.hf_repo` (onnx-community) under the quant subdir
    ///     `cpu_int4|cpu_fp16|cpu_fp32` at repo ROOT → local `<subdir>/<file>`.
    ///     int4 = 6 single-file `.onnx` + `manifest.json`; fp16/fp32 ADD the
    ///     talker's external `talker_cache.onnx.data` sidecar.
    ///   - config/tokenizer from the SEPARATE `Qwen/<checkpoint>` repo → local dir ROOT
    ///     (config.json, generation_config.json, tokenizer_config.json, vocab.json,
    ///     merges.txt).
    ///
    /// `tok_encoder.onnx` is deliberately NOT fetched for either checkpoint: it is the
    /// audio tokenizer used only by the base (clone-from-clip) path, which the ONNX
    /// pipeline here never runs — fetching it would add 225 MB of dead weight and would
    /// make the aggregate progress bar stall short of 100 %.
    fn qwen3_tts_manifest(
        entry: &TtsModelEntry,
        quant: &str,
        dir: &Path,
    ) -> Vec<(String, PathBuf)> {
        let subdir = match quant {
            "fp16" => "cpu_fp16",
            "fp32" => "cpu_fp32",
            // int4 is the default/maintained recipe (also covers an empty quant).
            _ => "cpu_int4",
        };
        let weights_url = |p: &str| {
            format!(
                "https://huggingface.co/{}/resolve/main/{}",
                entry.hf_repo, p
            )
        };
        // The Qwen config/tokenizer repo (public, ungated) — NOT `entry.hf_repo`. It is
        // `Qwen/` + the onnx-community repo's own name, which is also its `base_model`.
        let base_repo = entry
            .hf_repo
            .rsplit('/')
            .next()
            .unwrap_or("Qwen3-TTS-12Hz-1.7B-VoiceDesign");
        let config_url =
            |f: &str| format!("https://huggingface.co/Qwen/{base_repo}/resolve/main/{f}");

        let mut pairs: Vec<(String, PathBuf)> = Vec::new();

        // Six generation sub-models + the wiring manifest, under the quant subdir.
        for onnx in [
            "text_embed.onnx",
            "codec_embed.onnx",
            "talker_cache.onnx",
            "code_predictor.onnx",
            "residual_embed.onnx",
            "tok_decoder.onnx",
        ] {
            pairs.push((
                weights_url(&format!("{subdir}/{onnx}")),
                dir.join(subdir).join(onnx),
            ));
        }
        // The talker's weights spill into an external-data sidecar only once the graph
        // exceeds the 2 GB protobuf limit — so WHICH quants have one is per checkpoint,
        // not a blanket "not int4" rule: the 1.7B has it for fp16 AND fp32, the 0.6B only
        // for fp32 (its fp16 talker is a single 892 MB file). Fetching a sidecar that does
        // not exist 404s the whole download, so this is keyed off the real file trees.
        let has_talker_sidecar = match entry.id {
            "qwen3-tts-0.6b-customvoice" => subdir == "cpu_fp32",
            _ => subdir != "cpu_int4",
        };
        if has_talker_sidecar {
            let sidecar = "talker_cache.onnx.data";
            pairs.push((
                weights_url(&format!("{subdir}/{sidecar}")),
                dir.join(subdir).join(sidecar),
            ));
        }
        pairs.push((
            weights_url(&format!("{subdir}/manifest.json")),
            dir.join(subdir).join("manifest.json"),
        ));

        // Config + tokenizer from the Qwen repo → dir ROOT (self-contained model dir).
        for f in [
            "config.json",
            "generation_config.json",
            "tokenizer_config.json",
            "vocab.json",
            "merges.txt",
        ] {
            pairs.push((config_url(f), dir.join(f)));
        }

        pairs
    }

    /// Orpheus manifest: q4 Llama (+ external data shards) + tokenizer from `entry.hf_repo`, and the
    /// SNAC 24 kHz vocoder decoder from the SEPARATE `onnx-community/snac_24khz-ONNX` repo. Local
    /// layout: `onnx/` (LLM, so `.onnx_data` sidecars resolve) + `snac/decoder_model.onnx` + root
    /// `tokenizer.json` — matching `OrpheusLocalEngine`'s fixed load paths.
    fn orpheus_manifest(entry: &TtsModelEntry, dir: &Path) -> Vec<(String, PathBuf)> {
        let llm_url = |p: &str| {
            format!(
                "https://huggingface.co/{}/resolve/main/{}",
                entry.hf_repo, p
            )
        };
        let snac_url = |p: &str| {
            format!("https://huggingface.co/onnx-community/snac_24khz-ONNX/resolve/main/{p}")
        };
        let mut pairs: Vec<(String, PathBuf)> = Vec::new();
        for f in [
            "onnx/model_q4.onnx",
            "onnx/model_q4.onnx_data",
            "onnx/model_q4.onnx_data_1",
        ] {
            pairs.push((llm_url(f), dir.join(f)));
        }
        pairs.push((llm_url("tokenizer.json"), dir.join("tokenizer.json")));
        pairs.push((
            snac_url("onnx/decoder_model.onnx"),
            dir.join("snac").join("decoder_model.onnx"),
        ));
        pairs
    }

    /// NeuTTS-2e manifest: the Qwen3 backbone + tokenizer/config from `entry.hf_repo`, and the
    /// NeuCodec decoder from the matching FIRST-PARTY `neuphonic/neucodec-onnx-decoder[-int8]`
    /// repo. Both decoder repos publish their graph as `model.onnx`, so the local name is
    /// disambiguated per rung by `catalog::neutts_graph_set` (the same mapping the engine loads
    /// through) and both precisions can sit in one cache dir.
    ///
    /// The upstream `LICENSE` is fetched deliberately, not incidentally: the backbone ships
    /// under the NeuTTS Open License v1.0, whose §4(a) requires that recipients of the Work get
    /// a copy of the License. It costs 11 KB and lands beside the weights it governs. (The
    /// speaker references this engine needs are NOT downloaded — they are ~11 KB of NeuCodec
    /// codes bundled in `neutts.rs`, since the upstream ships them only inside a Python wheel.)
    fn neutts_manifest(entry: &TtsModelEntry, quant: &str, dir: &Path) -> Vec<(String, PathBuf)> {
        let set = catalog::neutts_graph_set(quant);
        let backbone_url = |p: &str| {
            format!(
                "https://huggingface.co/{}/resolve/main/{}",
                entry.hf_repo, p
            )
        };
        let mut pairs: Vec<(String, PathBuf)> =
            vec![(backbone_url(set.backbone), dir.join(set.backbone))];
        for f in ["tokenizer.json", "config.json", "LICENSE"] {
            pairs.push((backbone_url(f), dir.join(f)));
        }
        pairs.push((
            format!(
                "https://huggingface.co/{}/resolve/main/model.onnx",
                set.codec_repo
            ),
            dir.join(set.codec),
        ));
        pairs
    }

    /// OmniVoice manifest: the fused step graph + its external-data sidecar from
    /// `tritueviet/omnivoice-webgpu-assets`, `tokenizer.json` from upstream `k2-fsa/OmniVoice`,
    /// and the four `audio_tokenizer/` graphs from `onnx-community/OmniVoice-Onnx`.
    ///
    /// The seven files below sum to EXACTLY the catalog row's `size_bytes`
    /// (3,204,087,210) — four consumers key off that equality (cache badge, aggregate
    /// download total, download estimate, and the picker's fit hint). That is no longer a
    /// promise in a comment: `every_catalog_size_equals_the_bytes_its_manifest_actually_fetches`
    /// enforces it for this row and every other one in the catalog.
    ///
    /// Deliberately NOT fetched: `chat_template.jinja` (stock Qwen3 tool-calling template,
    /// carries none of the OmniVoice tokens), `tokenizer_config.json`, `config.json`, and
    /// everything under the export's `int4/`, `cuda/` and `audio_tokenizer/fp16/` trees. Each
    /// would add dead weight and strand the aggregate progress bar short of 100%.
    fn omnivoice_manifest(dir: &Path) -> Vec<(String, PathBuf)> {
        let step = |p: &str| {
            format!("https://huggingface.co/tritueviet/omnivoice-webgpu-assets/resolve/main/{p}")
        };
        let upstream =
            |p: &str| format!("https://huggingface.co/k2-fsa/OmniVoice/resolve/main/{p}");
        let onnx_community = |p: &str| {
            format!("https://huggingface.co/onnx-community/OmniVoice-Onnx/resolve/main/{p}")
        };
        let mut pairs: Vec<(String, PathBuf)> = vec![
            (step("omnivoice_step.onnx"), dir.join("omnivoice_step.onnx")),
            // MUST land beside the .onnx under this EXACT name: the step proto's external
            // initializers all carry `location: "omnivoice_step.data"`, which ORT resolves
            // relative to the model file's directory on a path-based load. Verified by parsing
            // the proto — 256 initializers, one location string, max(offset+length) exactly
            // 2,450,280,448.
            (step("omnivoice_step.data"), dir.join("omnivoice_step.data")),
            (upstream("tokenizer.json"), dir.join("tokenizer.json")),
        ];
        for graph in [
            "acoustic_encoder",
            "semantic_encoder",
            "quantizer_encoder",
            "higgs_decoder",
        ] {
            pairs.push((
                onnx_community(&format!("audio_tokenizer/{graph}.onnx")),
                dir.join("audio_tokenizer").join(format!("{graph}.onnx")),
            ));
        }
        pairs
    }

    /// Spark manifest: Qwen0.5B LLM + BiCodec vocoder + tokenizer from `entry.hf_repo` (Fhrozen),
    /// plus the 4 zero-shot CLONING graphs from `DgDev91/SparkTTS-ONNX` (wav2vec2 fp16 + mel +
    /// speaker + encoder-quantizer) flattened into the cache dir for `SparkEngine::load_cloning`.
    fn spark_manifest(entry: &TtsModelEntry, dir: &Path) -> Vec<(String, PathBuf)> {
        let base_url = |p: &str| {
            format!(
                "https://huggingface.co/{}/resolve/main/{}",
                entry.hf_repo, p
            )
        };
        let clone_url =
            |p: &str| format!("https://huggingface.co/DgDev91/SparkTTS-ONNX/resolve/main/{p}");
        let mut pairs: Vec<(String, PathBuf)> = vec![
            (
                base_url("LLM/onnx/model_q4.onnx"),
                dir.join("model_q4.onnx"),
            ),
            (base_url("bicodec.onnx"), dir.join("bicodec.onnx")),
            (base_url("LLM/tokenizer.json"), dir.join("tokenizer.json")),
            (
                base_url("LLM/tokenizer_config.json"),
                dir.join("tokenizer_config.json"),
            ),
        ];
        for f in [
            "wav2vec2_model_fp16.onnx",
            "mel_spectrogram.onnx",
            "speaker_encoder_tokenizer.onnx",
            "bicodec_encoder_quantizer.onnx",
        ] {
            pairs.push((clone_url(f), dir.join(f)));
        }
        pairs
    }

    /// Per-quant cache state: all files present → cached; some bytes → partial.
    pub fn cache_info(&self, model_id: &str, quant: &str) -> TtsCacheInfo {
        let Some(entry) = catalog::find(model_id) else {
            return TtsCacheInfo {
                state: TtsCacheState::NotCached,
                downloaded_bytes: 0,
                total_bytes: 0,
                progress: 0.0,
            };
        };
        let total = entry.quant(quant).map_or(0, |q| q.size_bytes);
        let manifest = self.manifest(entry, quant);
        let mut all_present = !manifest.is_empty();
        let mut downloaded: u64 = 0;
        for (_, local) in &manifest {
            if Self::is_cached_file(local) {
                downloaded += Self::path_len(local);
            } else {
                all_present = false;
                // A truncated cached file still counts its bytes toward progress — they are the
                // resume offset, not wasted work.
                downloaded +=
                    Self::path_len(local).max(Self::path_len(&Self::partial_path_for(local)));
            }
        }
        let state = if all_present {
            TtsCacheState::Cached
        } else if downloaded > 0 {
            TtsCacheState::Partial
        } else {
            TtsCacheState::NotCached
        };
        let progress = if total > 0 {
            (downloaded as f64 / total as f64).clamp(0.0, 1.0)
        } else if all_present {
            1.0
        } else {
            0.0
        };
        TtsCacheInfo {
            state,
            downloaded_bytes: downloaded,
            total_bytes: total.max(downloaded),
            progress,
        }
    }

    pub fn is_present(&self, model_id: &str, quant: &str) -> bool {
        self.cache_info(model_id, quant).state == TtsCacheState::Cached
    }

    pub fn pause(&self, model_id: &str, quant: &str) {
        if let Some(f) = self
            .inflight
            .lock_recover()
            .get(&Self::key(model_id, quant))
        {
            f.pause();
        }
    }
    pub fn cancel(&self, model_id: &str, quant: &str) {
        if let Some(f) = self
            .inflight
            .lock_recover()
            .get(&Self::key(model_id, quant))
        {
            f.cancel();
        }
    }

    /// Start (or resume) a background download for model+quant.
    pub fn predownload(self: &Arc<Self>, model_id: &str, quant: &str) {
        let key = Self::key(model_id, quant);
        {
            let mut g = self.inflight.lock_recover();
            if g.contains_key(&key) {
                return; // already running
            }
            g.insert(key, Arc::new(PauseCancelFlags::default()));
        }
        let this = self.clone();
        let model_id = model_id.to_string();
        let quant = quant.to_string();
        std::thread::spawn(move || {
            let outcome = this.download_blocking(&model_id, &quant, true);
            this.inflight
                .lock_recover()
                .remove(&Self::key(&model_id, &quant));
            let paused = matches!(outcome, Err(TtsDownloadErr::Paused));
            if !paused {
                let cancelled = matches!(outcome, Err(TtsDownloadErr::Cancelled));
                if let Err(err) = &outcome
                    && !cancelled
                {
                    crate::winstt::observability::IssueBuilder::new(
                        "tts_download",
                        "model_download",
                        "TTS model download failed",
                    )
                    .detail(err.to_string())
                    .model_id(model_id.clone())
                    .context("quantization", quant.clone())
                    .record(Some(&this.app));
                }
                let _ = this.app.emit(
                    "tts:catalog-model-download-complete",
                    json!({ "model": model_id, "quantization": quant, "cancelled": cancelled }),
                );
            }
            let _ = this
                .app
                .emit("tts:model-cache-changed", json!({ "modelId": model_id }));
        });
    }

    /// Blocking download of the whole manifest with aggregate progress. Used by
    /// `predownload` (in a thread) and by read-aloud's lazy ensure-present.
    pub fn download_blocking(
        &self,
        model_id: &str,
        quant: &str,
        emit: bool,
    ) -> Result<(), TtsDownloadErr> {
        let entry =
            catalog::find(model_id).ok_or_else(|| TtsDownloadErr::Other("unknown model".into()))?;
        let manifest = self.manifest(entry, quant);
        if manifest.is_empty() {
            return Err(TtsDownloadErr::Other("no download manifest".into()));
        }
        let fallback_total = entry.quant(quant).map_or(0, |q| q.size_bytes);
        let mut file_totals: Vec<u64> = manifest
            .iter()
            .map(|(url, target)| {
                let local_bytes = Self::cached_or_partial_bytes(target);
                let remote_bytes = if Self::is_cached_file(target) {
                    Some(local_bytes)
                } else {
                    self.remote_content_length(url)
                };
                remote_bytes.unwrap_or(0).max(local_bytes)
            })
            .collect();
        let mut file_downloaded: Vec<u64> = manifest
            .iter()
            .map(|(_, target)| Self::cached_or_partial_bytes(target))
            .collect();
        let initial_downloaded = file_downloaded.iter().copied().sum::<u64>();
        let initial_total = Self::aggregate_total(&file_totals, fallback_total);
        if emit && initial_total > 0 {
            self.emit_catalog_progress(model_id, quant, initial_downloaded, initial_total);
        }
        let flags = self
            .inflight
            .lock_recover()
            .entry(Self::key(model_id, quant))
            .or_insert_with(|| Arc::new(PauseCancelFlags::default()))
            .clone();
        flags.resume();

        for (index, (url, target)) in manifest.iter().enumerate() {
            if Self::is_cached_file(target) {
                file_downloaded[index] = Self::path_len(target);
                continue;
            }
            // A truncated cached file is a resume point, not garbage: move it to the `.partial`
            // path so the transfer picks up via HTTP Range instead of re-fetching gigabytes.
            if target.exists() {
                let partial = Self::partial_path_for(target);
                if Self::path_len(target) > Self::path_len(&partial) {
                    let _ = std::fs::remove_file(&partial);
                    if let Err(err) = std::fs::rename(target, &partial) {
                        log::warn!(
                            "[tts] could not stage truncated {} for resume: {err}",
                            target.display()
                        );
                        let _ = std::fs::remove_file(target);
                    }
                } else {
                    let _ = std::fs::remove_file(target);
                }
            }
            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p).map_err(|e| TtsDownloadErr::Network(e.to_string()))?;
            }
            let known_total = (file_totals[index] > 0).then_some(file_totals[index]);
            self.download_one(
                url,
                target,
                &flags,
                known_total,
                &mut |file_bytes, file_total| {
                    file_downloaded[index] = file_bytes;
                    if let Some(total) = file_total {
                        file_totals[index] = file_totals[index].max(total).max(file_bytes);
                    }
                    if emit {
                        let downloaded = file_downloaded.iter().copied().sum::<u64>();
                        let total = Self::aggregate_total(&file_totals, fallback_total);
                        self.emit_catalog_progress(model_id, quant, downloaded, total);
                    }
                },
            )?;
        }
        Ok(())
    }

    /// Ensure ONE voice's files are on disk, fetching just that voice on first use
    /// (the model download only ships the DEFAULT voice; see `manifest`). Cheap no-op
    /// when the voice is already cached or the model bundles its full voice set in the
    /// model download (Kitten / Supertonic / cloning models). The blocking fetch is a
    /// few hundred KB (Kokoro) to ~63 MB (a fresh Piper voice), so a first-time
    /// selection has a delay instead of failing because the voice was never fetched.
    ///
    /// Per-engine on-demand voices:
    ///   - Kokoro: `voices/<voice>.bin` (~510 KB).
    ///   - Piper: the curated voice's `<stem>.onnx` + `<stem>.onnx.json` (~63 MB),
    ///     flattened into the model dir so the engine's `cache_dir` finds them.
    pub fn ensure_voice(&self, model_id: &str, voice_id: &str) -> Result<(), TtsDownloadErr> {
        let Some(entry) = catalog::find(model_id) else {
            return Ok(());
        };
        if voice_id.is_empty() {
            return Ok(());
        }
        match entry.engine {
            TtsEngineId::Kokoro => {
                let Some(voice_id) = kokoro_voice_id(voice_id) else {
                    return Ok(());
                };
                let target = self
                    .model_cache_dir(model_id)
                    .join("voices")
                    .join(format!("{voice_id}.bin"));
                if target.exists() {
                    return Ok(());
                }
                if let Some(p) = target.parent() {
                    std::fs::create_dir_all(p)
                        .map_err(|e| TtsDownloadErr::Network(e.to_string()))?;
                }
                let url = format!(
                    "https://huggingface.co/{}/resolve/main/voices/{voice_id}.bin",
                    entry.hf_repo
                );
                let flags = PauseCancelFlags::default();
                self.download_one(&url, &target, &flags, None, &mut |_, _| {})
            }
            TtsEngineId::Piper => {
                // Unknown voice id → the engine falls back to the default voice (which
                // the model download already fetched), so nothing to do here.
                let Some(def) = piper_voice_def(voice_id) else {
                    return Ok(());
                };
                let dir = self.model_cache_dir(model_id);
                let flags = PauseCancelFlags::default();
                for ext in ["onnx", "onnx.json"] {
                    let target = dir.join(format!("{}.{ext}", def.stem));
                    if target.exists() {
                        continue;
                    }
                    if let Some(p) = target.parent() {
                        std::fs::create_dir_all(p)
                            .map_err(|e| TtsDownloadErr::Network(e.to_string()))?;
                    }
                    let url = format!(
                        "https://huggingface.co/{}/resolve/main/{}/{}.{ext}",
                        entry.hf_repo, def.subdir, def.stem
                    );
                    self.download_one(&url, &target, &flags, None, &mut |_, _| {})?;
                }
                Ok(())
            }
            // Other engines bundle their fixed voice set in the model download.
            _ => Ok(()),
        }
    }

    /// Stream one URL → target with Range resume + cooperative pause/cancel.
    fn download_one(
        &self,
        url: &str,
        target: &std::path::Path,
        flags: &PauseCancelFlags,
        known_total_bytes: Option<u64>,
        on_bytes: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<(), TtsDownloadErr> {
        let partial = Self::partial_path_for(target);
        let report = transfer_url_blocking(
            &self.client,
            TransferRequest {
                delete_partial_on_cancel: true,
                final_path: Some(target),
                known_total_bytes,
                partial_path: &partial,
                progress_interval: std::time::Duration::from_millis(100),
                url,
            },
            Some(flags),
            |progress: TransferProgress| on_bytes(progress.downloaded_bytes, progress.total_bytes),
        )
        .map_err(|e| TtsDownloadErr::Network(e.to_string()))?;
        match report.outcome {
            TransferOutcome::Complete => Ok(()),
            TransferOutcome::Paused => Err(TtsDownloadErr::Paused),
            TransferOutcome::Cancelled => Err(TtsDownloadErr::Cancelled),
        }
    }

    /// Delete a model's cached files (whole-model). Emits cache-changed.
    pub fn delete(&self, model_id: &str) {
        let Some(model_id) = catalog_model_id(model_id) else {
            log::warn!("[tts] refusing to delete unknown TTS model cache id: {model_id}");
            return;
        };
        let dir = self.model_cache_dir(model_id);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = self
            .app
            .emit("tts:model-cache-changed", json!({ "modelId": model_id }));
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TtsDownloadErr {
    #[error("cancelled")]
    Cancelled,
    #[error("paused")]
    Paused,
    #[error("network: {0}")]
    Network(String),
    #[error("{0}")]
    Other(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_total_prefers_known_manifest_sum_over_stale_fallback() {
        assert_eq!(
            TtsDownloadManager::aggregate_total(&[100, 200, 300], 1_000),
            600
        );
    }

    #[test]
    fn aggregate_total_uses_fallback_until_every_file_size_is_known() {
        assert_eq!(
            TtsDownloadManager::aggregate_total(&[100, 0, 300], 1_000),
            1_000
        );
    }

    /// The true upstream size of every blob the TTS manifests fetch, keyed by (HF repo,
    /// repo-relative path). Read from `https://huggingface.co/api/models/<repo>?blobs=true`
    /// on 2026-07-25 and, for every row this machine has cached
    /// (`chatterbox-multilingual`, `kokoro-82m`, `orpheus-3b`, `spark-tts-0.5b`),
    /// cross-checked byte for byte against the files on disk.
    ///
    /// This table — not the catalog — is the ground truth: `TtsQuant::size_bytes` is a
    /// DERIVED sum, audited below. When the audit fails, re-read the blobs API and fix
    /// the number here; never edit a catalog size to make a test pass, because four
    /// consumers key off the equality (the cache badge, the aggregate download total,
    /// the download estimate and the picker's fit hint) and a size invented to satisfy
    /// the test just moves the lie.
    ///
    /// One row per file, kept off rustfmt so the table reads as data.
    #[rustfmt::skip]
    const BLOB_BYTES: &[(&str, &str, u64)] = &[
        // Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4
        ("Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4", "slow_ar_int4.onnx", 900_218),
        ("Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4", "slow_ar_int4.onnx.data", 290_267_090),
        ("Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4", "fast_ar_int4.onnx", 156_318),
        ("Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4", "fast_ar_int4.onnx.data", 35_055_104),
        ("Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4", "codec_decoder_fp16.onnx", 594_319),
        ("Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4", "codec_decoder_fp16.onnx.data", 260_741_440),
        ("Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4", "registration/codec_encoder_fp16.onnx", 940_787),
        ("Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4", "registration/codec_encoder_fp16.onnx.data", 414_425_088),
        ("Audio8/Audio8-TTS-Preview-0.6B-ONNX-INT4", "tokenizer/tokenizer.json", 12_217_872),

        // Danny-Dasilva/neutts-2e-onnx
        ("Danny-Dasilva/neutts-2e-onnx", "config.json", 1_652),
        ("Danny-Dasilva/neutts-2e-onnx", "LICENSE", 11_081),
        ("Danny-Dasilva/neutts-2e-onnx", "model_int8.onnx", 349_402_919),
        ("Danny-Dasilva/neutts-2e-onnx", "model.onnx", 1_390_321_808),
        ("Danny-Dasilva/neutts-2e-onnx", "tokenizer.json", 24_063_947),

        // DgDev91/SparkTTS-ONNX
        ("DgDev91/SparkTTS-ONNX", "bicodec_encoder_quantizer.onnx", 122_407_119),
        ("DgDev91/SparkTTS-ONNX", "mel_spectrogram.onnx", 4_500_887),
        ("DgDev91/SparkTTS-ONNX", "speaker_encoder_tokenizer.onnx", 23_852_747),
        ("DgDev91/SparkTTS-ONNX", "wav2vec2_model_fp16.onnx", 631_289_801),

        // Fhrozen/Spark-TTS-0.5B-ONNX
        ("Fhrozen/Spark-TTS-0.5B-ONNX", "bicodec.onnx", 385_417_099),
        ("Fhrozen/Spark-TTS-0.5B-ONNX", "LLM/onnx/model_q4.onnx", 819_707_255),
        ("Fhrozen/Spark-TTS-0.5B-ONNX", "LLM/tokenizer_config.json", 2_577_032),
        ("Fhrozen/Spark-TTS-0.5B-ONNX", "LLM/tokenizer.json", 14_129_172),

        // k2-fsa/OmniVoice
        ("k2-fsa/OmniVoice", "tokenizer.json", 11_423_986),

        // KittenML/kitten-tts-nano-0.2
        ("KittenML/kitten-tts-nano-0.2", "config.json", 177),
        ("KittenML/kitten-tts-nano-0.2", "kitten_tts_nano_v0_2.onnx", 23_804_156),
        ("KittenML/kitten-tts-nano-0.2", "voices.npz", 10_294),

        // neuphonic/neucodec-onnx-decoder
        ("neuphonic/neucodec-onnx-decoder", "model.onnx", 782_565_930),

        // neuphonic/neucodec-onnx-decoder-int8
        ("neuphonic/neucodec-onnx-decoder-int8", "model.onnx", 312_292_102),

        // onnx-community/chatterbox-multilingual-ONNX
        ("onnx-community/chatterbox-multilingual-ONNX", "default_voice.wav", 714_320),
        ("onnx-community/chatterbox-multilingual-ONNX", "onnx/conditional_decoder.onnx", 6_350_448),
        ("onnx-community/chatterbox-multilingual-ONNX", "onnx/conditional_decoder.onnx_data", 533_970_816),
        ("onnx-community/chatterbox-multilingual-ONNX", "onnx/embed_tokens.onnx", 13_286),
        ("onnx-community/chatterbox-multilingual-ONNX", "onnx/embed_tokens.onnx_data", 68_390_912),
        ("onnx-community/chatterbox-multilingual-ONNX", "onnx/language_model_q4.onnx", 227_911),
        ("onnx-community/chatterbox-multilingual-ONNX", "onnx/language_model_q4.onnx_data", 353_621_248),
        ("onnx-community/chatterbox-multilingual-ONNX", "onnx/speech_encoder.onnx", 1_184_608),
        ("onnx-community/chatterbox-multilingual-ONNX", "onnx/speech_encoder.onnx_data", 591_274_880),
        ("onnx-community/chatterbox-multilingual-ONNX", "tokenizer.json", 71_798),

        // onnx-community/Kokoro-82M-v1.0-ONNX
        ("onnx-community/Kokoro-82M-v1.0-ONNX", "onnx/model_fp16.onnx", 163_234_740),

        // onnx-community/OmniVoice-Onnx
        ("onnx-community/OmniVoice-Onnx", "audio_tokenizer/acoustic_encoder.onnx", 205_546_480),
        ("onnx-community/OmniVoice-Onnx", "audio_tokenizer/higgs_decoder.onnx", 86_500_102),
        ("onnx-community/OmniVoice-Onnx", "audio_tokenizer/quantizer_encoder.onnx", 12_131_293),
        ("onnx-community/OmniVoice-Onnx", "audio_tokenizer/semantic_encoder.onnx", 436_736_856),

        // onnx-community/orpheus-3b-0.1-ft-ONNX
        ("onnx-community/orpheus-3b-0.1-ft-ONNX", "onnx/model_q4.onnx", 281_966),
        ("onnx-community/orpheus-3b-0.1-ft-ONNX", "onnx/model_q4.onnx_data", 2_085_583_936),
        ("onnx-community/orpheus-3b-0.1-ft-ONNX", "onnx/model_q4.onnx_data_1", 337_790_976),
        ("onnx-community/orpheus-3b-0.1-ft-ONNX", "tokenizer.json", 15_722_697),

        // onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp16/code_predictor.onnx", 285_552_428),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp16/codec_embed.onnx", 6_291_797),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp16/manifest.json", 667),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp16/residual_embed.onnx", 69_215_780),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp16/talker_cache.onnx", 891_756_744),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp16/text_embed.onnx", 634_920_759),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp16/tok_decoder.onnx", 458_268_831),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp32/code_predictor.onnx", 570_723_513),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp32/codec_embed.onnx", 12_583_206),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp32/manifest.json", 667),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp32/residual_embed.onnx", 138_419_704),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp32/talker_cache.onnx", 4_551_308),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp32/talker_cache.onnx.data", 1_774_452_736),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp32/text_embed.onnx", 1_269_839_332),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_fp32/tok_decoder.onnx", 458_268_831),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_int4/code_predictor.onnx", 91_668_866),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_int4/codec_embed.onnx", 2_015_779),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_int4/manifest.json", 667),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_int4/residual_embed.onnx", 22_179_258),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_int4/talker_cache.onnx", 288_573_853),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_int4/text_embed.onnx", 203_384_915),
        ("onnx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice", "cpu_int4/tok_decoder.onnx", 458_268_831),

        // onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp16/code_predictor.onnx", 354_761_116),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp16/codec_embed.onnx", 12_583_253),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp16/manifest.json", 667),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp16/residual_embed.onnx", 138_421_796),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp16/talker_cache.onnx", 4_562_040),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp16/talker_cache.onnx.data", 2_831_388_672),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp16/text_embed.onnx", 639_117_111),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp16/tok_decoder.onnx", 458_268_831),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp32/code_predictor.onnx", 709_140_126),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp32/codec_embed.onnx", 25_166_118),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp32/manifest.json", 667),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp32/residual_embed.onnx", 276_831_737),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp32/talker_cache.onnx", 4_551_434),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp32/talker_cache.onnx.data", 5_662_834_688),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp32/text_embed.onnx", 1_278_232_036),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_fp32/tok_decoder.onnx", 458_268_831),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_int4/code_predictor.onnx", 113_841_219),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_int4/codec_embed.onnx", 4_031_014),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_int4/manifest.json", 667),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_int4/residual_embed.onnx", 44_346_842),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_int4/talker_cache.onnx", 911_514_323),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_int4/text_embed.onnx", 204_732_501),
        ("onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "cpu_int4/tok_decoder.onnx", 458_268_831),

        // onnx-community/snac_24khz-ONNX
        ("onnx-community/snac_24khz-ONNX", "onnx/decoder_model.onnx", 52_600_822),

        // owensong/chatterbox-nano-ONNX
        ("owensong/chatterbox-nano-ONNX", "config.json", 1_206),
        ("owensong/chatterbox-nano-ONNX", "generation_config.json", 55),
        ("owensong/chatterbox-nano-ONNX", "onnx/conditional_decoder_q4.onnx", 2_179_022),
        ("owensong/chatterbox-nano-ONNX", "onnx/conditional_decoder_q4.onnx_data", 246_397_384),
        ("owensong/chatterbox-nano-ONNX", "onnx/embed_tokens_fp16.onnx", 1_520),
        ("owensong/chatterbox-nano-ONNX", "onnx/embed_tokens_fp16.onnx_data", 87_304_704),
        ("owensong/chatterbox-nano-ONNX", "onnx/language_model_q4f16.onnx", 522_078),
        ("owensong/chatterbox-nano-ONNX", "onnx/language_model_q4f16.onnx_data", 55_911_658),
        ("owensong/chatterbox-nano-ONNX", "onnx/speech_encoder_q4f16.onnx", 1_219_352),
        ("owensong/chatterbox-nano-ONNX", "onnx/speech_encoder_q4f16.onnx_data", 176_273_652),
        ("owensong/chatterbox-nano-ONNX", "preprocessor_config.json", 130),
        ("owensong/chatterbox-nano-ONNX", "tokenizer_config.json", 414),
        ("owensong/chatterbox-nano-ONNX", "tokenizer.json", 3_562_272),

        // Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
        ("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", "config.json", 4_908),
        ("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", "generation_config.json", 245),
        ("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", "merges.txt", 1_671_839),
        ("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", "tokenizer_config.json", 7_344),
        ("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", "vocab.json", 2_776_833),

        // Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign
        ("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "config.json", 4_421),
        ("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "generation_config.json", 245),
        ("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "merges.txt", 1_671_839),
        ("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "tokenizer_config.json", 7_344),
        ("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "vocab.json", 2_776_833),

        // ResembleAI/chatterbox-turbo-ONNX
        ("ResembleAI/chatterbox-turbo-ONNX", "config.json", 1_188),
        ("ResembleAI/chatterbox-turbo-ONNX", "generation_config.json", 55),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/conditional_decoder_q4.onnx", 2_179_022),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/conditional_decoder_q4.onnx_data", 246_397_384),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/conditional_decoder_q4f16.onnx", 2_394_210),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/conditional_decoder_q4f16.onnx_data", 162_996_136),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/embed_tokens_q4.onnx", 2_844),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/embed_tokens_q4.onnx_data", 37_286_384),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/embed_tokens_q4f16.onnx", 2_548),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/embed_tokens_q4f16.onnx_data", 33_648_688),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/language_model_q4.onnx", 274_572),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/language_model_q4.onnx_data", 204_456_572),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/language_model_q4f16.onnx", 276_803),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/language_model_q4f16.onnx_data", 183_981_430),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/speech_encoder_q4.onnx", 1_200_346),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/speech_encoder_q4.onnx_data", 229_560_112),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/speech_encoder_q4f16.onnx", 1_217_655),
        ("ResembleAI/chatterbox-turbo-ONNX", "onnx/speech_encoder_q4f16.onnx_data", 177_289_008),
        ("ResembleAI/chatterbox-turbo-ONNX", "preprocessor_config.json", 130),
        ("ResembleAI/chatterbox-turbo-ONNX", "tokenizer_config.json", 414),
        ("ResembleAI/chatterbox-turbo-ONNX", "tokenizer.json", 3_562_272),

        // rhasspy/piper-voices
        ("rhasspy/piper-voices", "en/en_US/lessac/medium/en_US-lessac-medium.onnx", 63_201_294),
        ("rhasspy/piper-voices", "en/en_US/lessac/medium/en_US-lessac-medium.onnx.json", 4_885),

        // Supertone/supertonic-3
        ("Supertone/supertonic-3", "onnx/duration_predictor.onnx", 3_700_147),
        ("Supertone/supertonic-3", "onnx/text_encoder.onnx", 36_416_150),
        ("Supertone/supertonic-3", "onnx/tts.json", 8_253),
        ("Supertone/supertonic-3", "onnx/unicode_indexer.json", 277_676),
        ("Supertone/supertonic-3", "onnx/vector_estimator.onnx", 256_534_781),
        ("Supertone/supertonic-3", "onnx/vocoder.onnx", 101_424_195),
        ("Supertone/supertonic-3", "voice_styles/F1.json", 292_046),
        ("Supertone/supertonic-3", "voice_styles/F2.json", 292_423),
        ("Supertone/supertonic-3", "voice_styles/F3.json", 290_794),
        ("Supertone/supertonic-3", "voice_styles/F4.json", 291_808),
        ("Supertone/supertonic-3", "voice_styles/F5.json", 291_479),
        ("Supertone/supertonic-3", "voice_styles/M1.json", 291_748),
        ("Supertone/supertonic-3", "voice_styles/M2.json", 292_055),
        ("Supertone/supertonic-3", "voice_styles/M3.json", 290_198),
        ("Supertone/supertonic-3", "voice_styles/M4.json", 291_522),
        ("Supertone/supertonic-3", "voice_styles/M5.json", 291_469),

        // tritueviet/omnivoice-webgpu-assets
        ("tritueviet/omnivoice-webgpu-assets", "omnivoice_step.data", 2_450_280_448),
        ("tritueviet/omnivoice-webgpu-assets", "omnivoice_step.onnx", 1_468_045),
    ];

    /// Kokoro's 54 voice tensors are all the same shape — 510 style vectors x 256 dims x
    /// fp32 = 522,240 B — so one structural fact stands in for 54 identical table rows.
    /// Each was still confirmed individually against the blobs API (the histogram of all
    /// 54 sizes has exactly one bucket), and `af_heart.bin` in this machine's cache
    /// matches to the byte.
    const KOKORO_VOICE_BYTES: u64 = 522_240;
    const KOKORO_REPO: &str = "onnx-community/Kokoro-82M-v1.0-ONNX";

    /// Split an HF resolve URL back into (repo, repo-relative path). Panics rather than
    /// returning `None`: a manifest URL that is not an HF resolve URL is a bug the audit
    /// must not skip past.
    fn hf_repo_path(url: &str) -> (&str, &str) {
        let rest = url
            .strip_prefix("https://huggingface.co/")
            .unwrap_or_else(|| panic!("not a huggingface.co URL: {url}"));
        rest.split_once("/resolve/main/")
            .unwrap_or_else(|| panic!("no /resolve/main/ in manifest URL: {url}"))
    }

    fn verified_blob_bytes(url: &str) -> Option<u64> {
        let (repo, path) = hf_repo_path(url);
        if repo == KOKORO_REPO && path.starts_with("voices/") && path.ends_with(".bin") {
            return Some(KOKORO_VOICE_BYTES);
        }
        BLOB_BYTES
            .iter()
            .find(|(r, p, _)| *r == repo && *p == path)
            .map(|(_, _, bytes)| *bytes)
    }

    /// Every (row, quant) in the catalog, not just the one that happened to get a test.
    ///
    /// `size_bytes` is the denominator of the download bar, the number the "Cached"
    /// badge is measured against, the download estimate on the card and the input to
    /// the picker's fit hint. Nothing in the shipping code re-derives it, so a wrong
    /// number is invisible until a user watches a bar stall — which is exactly how
    /// `chatterbox-multilingual` (over by 94,179,773 B → stuck at 94.3%),
    /// `kokoro-82m` (over by one voice file), `spark-tts-0.5b` (a rounded guess) and
    /// all three `qwen3-tts-1.7b-voicedesign` rungs drifted. This is the gate that
    /// makes the sum authoritative for the whole catalog.
    #[test]
    fn every_catalog_size_equals_the_bytes_its_manifest_actually_fetches() {
        // A row carrying no rung would make the inner loop a no-op, which is the one
        // way "every row" quietly becomes "some rows" — a coverage hole in an audit is
        // worse than no audit, because the green tick is what stops anyone re-checking.
        // So count what is actually summed and pin it against the catalog's own length.
        assert!(
            !catalog::TTS_CATALOG.is_empty(),
            "the catalog is empty, so this audit measured nothing"
        );
        let mut audited_pairs = 0usize;
        for entry in catalog::TTS_CATALOG {
            assert!(
                !entry.quants.is_empty(),
                "{} declares no quant: it can never be downloaded, and it would slip \
                 through this audit unmeasured",
                entry.id
            );
            for quant in entry.quants {
                audited_pairs += 1;
                let dir = Path::new("/tts").join(entry.id);
                let manifest = TtsDownloadManager::manifest_in(entry, quant.id, &dir);
                assert!(
                    !manifest.is_empty(),
                    "{}@{} declares {} bytes but fetches no files",
                    entry.id,
                    quant.id,
                    quant.size_bytes
                );
                let mut sum: u64 = 0;
                for (url, local) in &manifest {
                    let bytes = verified_blob_bytes(url).unwrap_or_else(|| {
                        panic!(
                            "{}@{}: no verified size for {url}. Read it from \
                             https://huggingface.co/api/models/<repo>?blobs=true and add it \
                             to BLOB_BYTES — do NOT adjust the catalog to match a guess.",
                            entry.id, quant.id
                        )
                    });
                    sum += bytes;
                    assert!(
                        local.starts_with(&dir),
                        "{}@{} writes {} outside its own cache dir",
                        entry.id,
                        quant.id,
                        local.display()
                    );
                }
                assert_eq!(
                    quant.size_bytes,
                    sum,
                    "{}@{} declares {} but its manifest fetches {} ({} off)",
                    entry.id,
                    quant.id,
                    quant.size_bytes,
                    sum,
                    quant.size_bytes.abs_diff(sum)
                );
            }
        }
        assert!(
            audited_pairs >= catalog::TTS_CATALOG.len(),
            "audited only {audited_pairs} (row, quant) pairs across {} catalog rows",
            catalog::TTS_CATALOG.len()
        );
    }

    /// A file listed twice would be counted twice in the total above AND downloaded
    /// twice at runtime, so the audit is only meaningful if each manifest is a set.
    #[test]
    fn no_manifest_fetches_the_same_file_twice() {
        for entry in catalog::TTS_CATALOG {
            for quant in entry.quants {
                let dir = Path::new("/tts").join(entry.id);
                let manifest = TtsDownloadManager::manifest_in(entry, quant.id, &dir);
                let mut locals: Vec<&Path> = manifest.iter().map(|(_, l)| l.as_path()).collect();
                let count = locals.len();
                locals.sort_unstable();
                locals.dedup();
                assert_eq!(
                    locals.len(),
                    count,
                    "{}@{} writes the same local path twice",
                    entry.id,
                    quant.id
                );
                let mut urls: Vec<&str> = manifest.iter().map(|(u, _)| u.as_str()).collect();
                urls.sort_unstable();
                urls.dedup();
                assert_eq!(
                    urls.len(),
                    count,
                    "{}@{} fetches the same URL twice",
                    entry.id,
                    quant.id
                );
            }
        }
    }

    /// The table is only trustworthy while every row in it is a file some manifest
    /// really asks for: a stale row is an unverified number sitting next to verified
    /// ones, and a duplicate key silently shadows.
    #[test]
    fn the_blob_table_has_no_duplicate_or_orphaned_rows() {
        let mut keys: Vec<(&str, &str)> = BLOB_BYTES.iter().map(|(r, p, _)| (*r, *p)).collect();
        let declared = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), declared, "duplicate key in BLOB_BYTES");

        let mut fetched: Vec<(String, String)> = Vec::new();
        for entry in catalog::TTS_CATALOG {
            for quant in entry.quants {
                let dir = Path::new("/tts").join(entry.id);
                for (url, _) in TtsDownloadManager::manifest_in(entry, quant.id, &dir) {
                    let (repo, path) = hf_repo_path(&url);
                    fetched.push((repo.to_string(), path.to_string()));
                }
            }
        }
        for (repo, path) in BLOB_BYTES.iter().map(|(r, p, _)| (*r, *p)) {
            assert!(
                fetched.iter().any(|(r, p)| r == repo && p == path),
                "{repo}/{path} is in BLOB_BYTES but no manifest fetches it"
            );
        }
        // The one wildcard rule must stay pinned to the voice set it stands for.
        let voices = fetched
            .iter()
            .filter(|(r, p)| r == KOKORO_REPO && p.starts_with("voices/"))
            .count();
        assert_eq!(voices, crate::winstt::tts::KOKORO_VOICE_CATALOG.len());
        assert_eq!(voices, 54);
    }

    /// ORT resolves external initializers by the `location` string baked into the proto,
    /// relative to the .onnx's own directory. The step graph's 256 external initializers
    /// all carry `location: "omnivoice_step.data"`, so the sidecar MUST land beside the
    /// graph under exactly that name — a rename fails at `commit_from_file`, i.e. AFTER
    /// a 2.45 GB download.
    #[test]
    fn omnivoice_external_data_sidecar_keeps_its_exact_name_beside_the_graph() {
        let dir = Path::new("/tts/omnivoice-0.6b");
        let pairs = TtsDownloadManager::omnivoice_manifest(dir);
        let graph = pairs
            .iter()
            .find(|(_, l)| l.file_name().is_some_and(|f| f == "omnivoice_step.onnx"))
            .expect("step graph");
        let sidecar = pairs
            .iter()
            .find(|(_, l)| l.file_name().is_some_and(|f| f == "omnivoice_step.data"))
            .expect("step sidecar");
        assert_eq!(graph.1.parent(), sidecar.1.parent());
        // The four tokenizer graphs live in their own subdir, which the engine mirrors.
        for g in [
            "acoustic_encoder",
            "semantic_encoder",
            "quantizer_encoder",
            "higgs_decoder",
        ] {
            let f = format!("{g}.onnx");
            let pair = pairs
                .iter()
                .find(|(_, l)| l.file_name().is_some_and(|n| n == f.as_str()))
                .unwrap_or_else(|| panic!("{f} missing"));
            assert_eq!(pair.1.parent(), Some(dir.join("audio_tokenizer").as_path()));
        }
    }

    #[test]
    fn catalog_model_id_rejects_path_components() {
        assert_eq!(catalog_model_id("../kokoro-82m"), None);
        assert_eq!(catalog_model_id("kokoro-82m/../../x"), None);
        assert_eq!(catalog_model_id("kokoro-82m"), Some("kokoro-82m"));
    }

    #[test]
    fn kokoro_voice_id_rejects_path_components() {
        assert_eq!(kokoro_voice_id("../af_heart"), None);
        assert_eq!(kokoro_voice_id("af_heart/../../x"), None);
        assert_eq!(kokoro_voice_id("af_heart"), Some("af_heart"));
    }
}
