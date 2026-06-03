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

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::winstt::tts::catalog::{self, TtsEngineId, TtsModelEntry};
use crate::winstt::tts::local_engines::{piper_voice_def, PIPER_DEFAULT_VOICE};

/// The Kitten ONNX graph filename for a catalog id. Both nano models ship the same
/// `voices.npz` + `config.json`; only the graph file name differs per version.
fn kitten_model_file(model_id: &str) -> &'static str {
    match model_id {
        "kitten-nano-0.2" => "kitten_tts_nano_v0_2.onnx",
        // nano-0.1 (and any future default) uses the v0.1 graph.
        _ => "kitten_tts_nano_v0_1.onnx",
    }
}

/// Per-(model,quant) cooperative download flags.
#[derive(Default)]
struct Flags {
    cancel: AtomicBool,
    pause: AtomicBool,
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
    inflight: Mutex<HashMap<String, Arc<Flags>>>,
}

impl TtsDownloadManager {
    pub fn new(app: &AppHandle) -> Self {
        let client = reqwest::Client::builder()
            .user_agent("WinSTT/0.1")
            .build()
            .unwrap_or_default();
        Self {
            app: app.clone(),
            client,
            inflight: Mutex::new(HashMap::new()),
        }
    }

    fn key(model_id: &str, quant: &str) -> String {
        format!("{model_id}@{quant}")
    }

    /// `%LOCALAPPDATA%/winstt/tts/<model-id>/`.
    pub fn model_cache_dir(&self, model_id: &str) -> PathBuf {
        crate::portable::app_data_dir(&self.app)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("tts")
            .join(model_id)
    }

    /// The (HF-url, local-absolute-path) pairs to fetch for a model+quant.
    /// Local paths mirror the HF sub-path except where an engine wants them flat.
    pub fn manifest(&self, entry: &TtsModelEntry, quant: &str) -> Vec<(String, PathBuf)> {
        let dir = self.model_cache_dir(entry.id);
        let url = |p: &str| {
            format!(
                "https://huggingface.co/{}/resolve/main/{}",
                entry.hf_repo, p
            )
        };
        // (hf_path, local_relative)
        let pairs: Vec<(String, String)> = match entry.engine {
            TtsEngineId::Kitten => {
                // The graph filename differs per Kitten model (v0.1 vs v0.2); the
                // voices.npz + config.json names are shared. Read the graph name from
                // the catalog id so the right model file is fetched from its repo.
                let graph = kitten_model_file(entry.id);
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
                for g in ["text_encoder", "latent_denoiser", "voice_decoder"] {
                    v.push((format!("onnx/{g}.onnx"), format!("onnx/{g}.onnx")));
                    v.push((format!("onnx/{g}.onnx_data"), format!("onnx/{g}.onnx_data")));
                }
                for nm in ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"] {
                    v.push((format!("voices/{nm}.bin"), format!("voices/{nm}.bin")));
                }
                v.push(("tokenizer.json".into(), "tokenizer.json".into()));
                v.push(("config.json".into(), "config.json".into()));
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
            TtsEngineId::Chatterbox => {
                // 4 graphs (each with an external-data sidecar) + tokenizer + default voice.
                let backbone = match quant {
                    "fp16" => "language_model_fp16",
                    "q4f16" => "language_model_q4f16",
                    "fp32" => "language_model",
                    _ => "language_model_q4",
                };
                let mut v: Vec<(String, String)> = Vec::new();
                for g in [
                    backbone,
                    "embed_tokens",
                    "speech_encoder",
                    "conditional_decoder",
                ] {
                    v.push((format!("onnx/{g}.onnx"), format!("onnx/{g}.onnx")));
                    v.push((format!("onnx/{g}.onnx_data"), format!("onnx/{g}.onnx_data")));
                }
                v.push(("tokenizer.json".into(), "tokenizer.json".into()));
                v.push(("default_voice.wav".into(), "default_voice.wav".into()));
                v
            }
        };
        pairs
            .into_iter()
            .map(|(hf, local)| (url(&hf), dir.join(local)))
            .collect()
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
        let total = entry.quant(quant).map(|q| q.size_bytes).unwrap_or(0);
        let manifest = self.manifest(entry, quant);
        let mut all_present = !manifest.is_empty();
        let mut downloaded: u64 = 0;
        for (_, local) in &manifest {
            if let Ok(m) = std::fs::metadata(local) {
                downloaded += m.len();
            } else {
                all_present = false;
                if let Ok(m) = std::fs::metadata(local.with_extension(format!(
                    "{}.partial",
                    local.extension().and_then(|e| e.to_str()).unwrap_or("")
                ))) {
                    downloaded += m.len();
                }
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
            .lock()
            .unwrap()
            .get(&Self::key(model_id, quant))
        {
            f.pause.store(true, Ordering::Release);
        }
    }
    pub fn cancel(&self, model_id: &str, quant: &str) {
        if let Some(f) = self
            .inflight
            .lock()
            .unwrap()
            .get(&Self::key(model_id, quant))
        {
            f.cancel.store(true, Ordering::Release);
        }
    }

    /// Start (or resume) a background download for model+quant.
    pub fn predownload(self: &Arc<Self>, model_id: &str, quant: &str) {
        let key = Self::key(model_id, quant);
        {
            let mut g = self.inflight.lock().unwrap();
            if g.contains_key(&key) {
                return; // already running
            }
            g.insert(key.clone(), Arc::new(Flags::default()));
        }
        let this = self.clone();
        let model_id = model_id.to_string();
        let quant = quant.to_string();
        std::thread::spawn(move || {
            let cancelled = matches!(
                this.download_blocking(&model_id, &quant, true),
                Err(TtsDownloadErr::Cancelled)
            );
            this.inflight
                .lock()
                .unwrap()
                .remove(&Self::key(&model_id, &quant));
            let _ = this.app.emit(
                "tts:catalog-model-download-complete",
                json!({ "model": model_id, "quantization": quant, "cancelled": cancelled }),
            );
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
        let total = entry.quant(quant).map(|q| q.size_bytes).unwrap_or(0);
        let flags = self
            .inflight
            .lock()
            .unwrap()
            .entry(Self::key(model_id, quant))
            .or_insert_with(|| Arc::new(Flags::default()))
            .clone();
        flags.pause.store(false, Ordering::Release);

        let mut base: u64 = 0;
        for (url, target) in &manifest {
            if target.exists() {
                base += std::fs::metadata(target).map(|m| m.len()).unwrap_or(0);
                continue;
            }
            if let Some(p) = target.parent() {
                std::fs::create_dir_all(p).map_err(|e| TtsDownloadErr::Network(e.to_string()))?;
            }
            let base_snapshot = base;
            let mut last_file_bytes = 0u64;
            self.download_one(url, target, &flags, &mut |file_bytes| {
                last_file_bytes = file_bytes;
                if emit {
                    let downloaded = base_snapshot + file_bytes;
                    let progress = if total > 0 {
                        (downloaded as f64 / total as f64).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let _ = self.app.emit(
                        "tts:catalog-model-download-progress",
                        json!({
                            "model": model_id,
                            "quantization": quant,
                            "progress": progress,
                            "downloadedBytes": downloaded,
                            "totalBytes": total,
                        }),
                    );
                }
            })?;
            base += last_file_bytes;
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
                let flags = Flags::default();
                self.download_one(&url, &target, &flags, &mut |_| {})
            }
            TtsEngineId::Piper => {
                // Unknown voice id → the engine falls back to the default voice (which
                // the model download already fetched), so nothing to do here.
                let Some(def) = piper_voice_def(voice_id) else {
                    return Ok(());
                };
                let dir = self.model_cache_dir(model_id);
                let flags = Flags::default();
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
                    self.download_one(&url, &target, &flags, &mut |_| {})?;
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
        flags: &Flags,
        on_bytes: &mut dyn FnMut(u64),
    ) -> Result<(), TtsDownloadErr> {
        use std::io::Write;
        use tauri::async_runtime::block_on;

        let partial = target.with_file_name(format!(
            "{}.partial",
            target.file_name().and_then(|n| n.to_str()).unwrap_or("dl")
        ));
        let resume_from = partial.metadata().map(|m| m.len()).unwrap_or(0);
        let mut req = self.client.get(url);
        if resume_from > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
        }
        let mut resp = block_on(req.send()).map_err(|e| TtsDownloadErr::Network(e.to_string()))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(TtsDownloadErr::Network(format!("HTTP {status} for {url}")));
        }
        let resuming = resume_from > 0 && status.as_u16() == 206;
        let mut downloaded = if resuming { resume_from } else { 0 };
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(resuming)
            .write(true)
            .truncate(!resuming)
            .open(&partial)
            .map_err(|e| TtsDownloadErr::Network(e.to_string()))?;
        loop {
            if flags.cancel.load(Ordering::Acquire) {
                drop(file);
                let _ = std::fs::remove_file(&partial);
                return Err(TtsDownloadErr::Cancelled);
            }
            if flags.pause.load(Ordering::Acquire) {
                return Err(TtsDownloadErr::Paused);
            }
            let next =
                block_on(resp.chunk()).map_err(|e| TtsDownloadErr::Network(e.to_string()))?;
            let Some(bytes) = next else { break };
            file.write_all(&bytes)
                .map_err(|e| TtsDownloadErr::Network(e.to_string()))?;
            downloaded += bytes.len() as u64;
            on_bytes(downloaded);
        }
        drop(file);
        std::fs::rename(&partial, target).map_err(|e| TtsDownloadErr::Network(e.to_string()))?;
        Ok(())
    }

    /// Delete a model's cached files (whole-model). Emits cache-changed.
    pub fn delete(&self, model_id: &str) {
        let dir = self.model_cache_dir(model_id);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = self
            .app
            .emit("tts:model-cache-changed", json!({ "modelId": model_id }));
    }
}

#[derive(Debug)]
pub enum TtsDownloadErr {
    Cancelled,
    Paused,
    Network(String),
    Other(String),
}
impl std::fmt::Display for TtsDownloadErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TtsDownloadErr::Cancelled => write!(f, "cancelled"),
            TtsDownloadErr::Paused => write!(f, "paused"),
            TtsDownloadErr::Network(m) => write!(f, "network: {m}"),
            TtsDownloadErr::Other(m) => write!(f, "{m}"),
        }
    }
}
impl std::error::Error for TtsDownloadErr {}
