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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::winstt::downloads::{
    transfer_url_blocking, TransferControl, TransferOutcome, TransferProgress, TransferRequest,
};
use crate::winstt::sync_ext::MutexExt;
use crate::winstt::tts::catalog::{self, TtsEngineId, TtsModelEntry};
use crate::winstt::tts::local_engines::{piper_voice_def, PIPER_DEFAULT_VOICE};
use crate::winstt::tts::voice_by_id;

/// The Kitten ONNX graph filename for a catalog id. Both nano models ship the same
/// `voices.npz` + `config.json`; only the graph file name differs per version.
fn kitten_model_file(model_id: &str) -> &'static str {
    match model_id {
        "kitten-nano-0.2" => "kitten_tts_nano_v0_2.onnx",
        // nano-0.1 (and any future default) uses the v0.1 graph.
        _ => "kitten_tts_nano_v0_1.onnx",
    }
}

fn catalog_model_id(model_id: &str) -> Option<&'static str> {
    catalog::find(model_id).map(|entry| entry.id)
}

fn kokoro_voice_id(voice_id: &str) -> Option<&'static str> {
    voice_by_id(voice_id).map(|voice| voice.id)
}

/// Per-(model,quant) cooperative download flags.
#[derive(Default)]
struct Flags {
    cancel: AtomicBool,
    pause: AtomicBool,
}

impl TransferControl for Flags {
    fn should_cancel(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    fn should_pause(&self) -> bool {
        self.pause.load(Ordering::Acquire)
    }
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
        std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
    }

    fn cached_or_partial_bytes(target: &Path) -> u64 {
        if target.exists() {
            return Self::path_len(target);
        }
        Self::path_len(&Self::partial_path_for(target))
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
                "totalBytes": total.max(downloaded),
            }),
        );
    }

    /// `%LOCALAPPDATA%/winstt/tts/<model-id>/`.
    pub fn model_cache_dir(&self, model_id: &str) -> PathBuf {
        crate::portable::app_data_dir(&self.app)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("tts")
            .join(model_id)
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
                if let Ok(m) = std::fs::metadata(Self::partial_path_for(local)) {
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
            let mut g = self.inflight.lock_recover();
            if g.contains_key(&key) {
                return; // already running
            }
            g.insert(key.clone(), Arc::new(Flags::default()));
        }
        let this = self.clone();
        let model_id = model_id.to_string();
        let quant = quant.to_string();
        std::thread::spawn(move || {
            let outcome = this.download_blocking(&model_id, &quant, true);
            this.inflight
                .lock()
                .unwrap()
                .remove(&Self::key(&model_id, &quant));
            let paused = matches!(outcome, Err(TtsDownloadErr::Paused));
            if !paused {
                let cancelled = matches!(outcome, Err(TtsDownloadErr::Cancelled));
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
        let fallback_total = entry.quant(quant).map(|q| q.size_bytes).unwrap_or(0);
        let mut file_totals: Vec<u64> = manifest
            .iter()
            .map(|(url, target)| {
                let local_bytes = Self::cached_or_partial_bytes(target);
                let remote_bytes = if target.exists() {
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
            .lock()
            .unwrap()
            .entry(Self::key(model_id, quant))
            .or_insert_with(|| Arc::new(Flags::default()))
            .clone();
        flags.pause.store(false, Ordering::Release);

        for (index, (url, target)) in manifest.iter().enumerate() {
            if target.exists() {
                file_downloaded[index] = Self::path_len(target);
                continue;
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
                let flags = Flags::default();
                self.download_one(&url, &target, &flags, None, &mut |_, _| {})
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
        flags: &Flags,
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
