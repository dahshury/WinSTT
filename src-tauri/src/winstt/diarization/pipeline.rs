// Reference: <onnx-asr>/src/onnx_asr/diarization.py
//         WeSpeaker ResNet34 embedding model on WinSTT's shared `ort` runtime.
//
// ═════════════════════════════════════════════════════════════════════════════
// 7. Diarizer config + the segmentation/embedding orchestration.
//    Embedding is direct ORT WeSpeaker wiring; segmentation stays behind a trait.
// ═════════════════════════════════════════════════════════════════════════════

use std::collections::BTreeMap;

use ndarray::Array2;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;

use super::ahc::{active_intervals, ahc_complete_linkage, cosine_distance_matrix};
use super::clustering::OnlineSpeakerClustering;
use super::timeline::merge_adjacent_segments;
use super::types::{EmbeddedSegment, SpeakerSegment};
use crate::winstt::stt::families::frontend;
use crate::winstt::stt::{
    execution_providers, num_cpus_best_effort, pick_intra_op_threads, provider_label, Accelerator,
};

/// Hysteresis + duration thresholds for the segmentation→interval stage.
/// Mirrors `Diarizer.__init__` defaults.
#[derive(Debug, Clone, Copy)]
pub struct DiarizerConfig {
    pub onset: f32,
    pub offset: f32,
    pub min_segment_duration: f64,
    pub merge_gap_duration: f64,
    pub min_embedding_duration: f64,
}

impl Default for DiarizerConfig {
    fn default() -> Self {
        DiarizerConfig {
            onset: 0.5,
            offset: 0.35,
            min_segment_duration: 0.5,
            merge_gap_duration: 0.3,
            min_embedding_duration: 0.5,
        }
    }
}

pub const DIARIZER_SAMPLE_RATE: u32 = 16_000;

/// Per-frame, per-local-speaker probabilities from the segmentation model.
/// Row-major `num_frames × num_local_speakers`, plus the frame step in samples.
pub struct SegmentationOutput {
    /// `probs[frame][local_speaker]`.
    pub probs: Vec<Vec<f32>>,
    pub num_local_speakers: usize,
    /// Audio samples advanced per frame (`frame_to_sec = frame_step / 16000`).
    pub frame_step: usize,
}

/// The segmentation model (pyannote-segmentation-3.0 powerset). The concrete
/// session is FFI; this trait isolates it so the interval→embed→cluster pipeline
/// is testable with a fake.
pub trait Segmenter: Send {
    /// Run segmentation on a 16 kHz mono waveform → per-frame powerset probs.
    fn speaker_probs(&mut self, waveform: &[f32], sample_rate: u32) -> Option<SegmentationOutput>;
}

/// Speaker-embedding extractor (WeSpeaker ResNet34 -> 256-d). Kept behind a trait
/// so clustering is testable; the real impl is `OrtEmbedder` below.
pub trait Embedder: Send {
    /// Compute one embedding for a 16 kHz mono crop. `None` on failure.
    fn embed(&mut self, crop: &[f32], sample_rate: u32) -> Option<Vec<f32>>;
}

/// Stateless single-utterance diarizer: segmentation → activity intervals →
/// per-interval embeddings. Clustering is applied by the caller
/// (`SessionDiarizer` for session-stable IDs; AHC for the offline path).
pub struct Diarizer<S: Segmenter, E: Embedder> {
    seg: S,
    emb: E,
    cfg: DiarizerConfig,
}

impl<S: Segmenter, E: Embedder> Diarizer<S, E> {
    pub fn new(seg: S, emb: E, cfg: DiarizerConfig) -> Self {
        Diarizer { seg, emb, cfg }
    }

    /// Segmentation → activity intervals → embeddings, WITHOUT clustering.
    /// Mirrors `Diarizer.diarize_with_embeddings`.
    pub fn diarize_with_embeddings(
        &mut self,
        waveform: &[f32],
        sample_rate: u32,
    ) -> Vec<EmbeddedSegment> {
        if sample_rate != DIARIZER_SAMPLE_RATE || waveform.is_empty() {
            return Vec::new();
        }
        let seg = match self.seg.speaker_probs(waveform, sample_rate) {
            Some(s) if !s.probs.is_empty() => s,
            _ => return Vec::new(),
        };

        let frame_step = seg.frame_step.max(1);
        let frame_to_sec = frame_step as f64 / DIARIZER_SAMPLE_RATE as f64;
        let min_frames = (self.cfg.min_segment_duration / frame_to_sec).max(1.0) as usize;
        let merge_frames = (self.cfg.merge_gap_duration / frame_to_sec).max(1.0) as usize;
        let min_emb_frames = (self.cfg.min_embedding_duration / frame_to_sec).max(1.0) as usize;

        // (local_id, start_f, end_f) candidate intervals long enough to embed.
        let mut segments: Vec<(usize, usize, usize)> = Vec::new();
        for local_id in 0..seg.num_local_speakers {
            // Column-extract the local speaker's probability track.
            let track: Vec<f32> = seg.probs.iter().map(|row| row[local_id]).collect();
            for (s, e) in active_intervals(
                &track,
                self.cfg.onset,
                self.cfg.offset,
                min_frames,
                merge_frames,
            ) {
                if e - s >= min_emb_frames {
                    segments.push((local_id, s, e));
                }
            }
        }
        if segments.is_empty() {
            return Vec::new();
        }

        let mut out = Vec::with_capacity(segments.len());
        for (local, s, e) in segments {
            let start_s = (s * frame_step).min(waveform.len());
            let end_s = (e * frame_step).min(waveform.len());
            if end_s <= start_s {
                continue;
            }
            let crop = &waveform[start_s..end_s];
            let embedding = match self.emb.embed(crop, DIARIZER_SAMPLE_RATE) {
                Some(v) => v,
                None => continue,
            };
            // Mean per-frame probability over the interval = active_ratio.
            let span = (e - s).max(1) as f32;
            let active_ratio = seg.probs[s..e].iter().map(|row| row[local]).sum::<f32>() / span;
            out.push(EmbeddedSegment {
                start: s as f64 * frame_to_sec,
                end: e as f64 * frame_to_sec,
                embedding,
                active_ratio,
            });
        }
        out
    }

    /// Offline diarization with cosine AHC (NO session-stable IDs).
    /// Mirrors `Diarizer.diarize`.
    pub fn diarize(
        &mut self,
        waveform: &[f32],
        sample_rate: u32,
        num_speakers: Option<usize>,
        threshold: f32,
    ) -> Vec<SpeakerSegment> {
        let embedded = self.diarize_with_embeddings(waveform, sample_rate);
        if embedded.is_empty() {
            return Vec::new();
        }
        let embeddings: Vec<Vec<f32>> = embedded.iter().map(|s| s.embedding.clone()).collect();
        let distances = cosine_distance_matrix(&embeddings);
        let labels = ahc_complete_linkage(&distances, num_speakers, threshold);
        let triples: Vec<SpeakerSegment> = embedded
            .iter()
            .enumerate()
            .map(|(i, s)| SpeakerSegment::new(s.start, s.end, labels[i]))
            .collect();
        merge_adjacent_segments(triples, 0.05)
    }
}

/// Per-utterance diarizer with SESSION-stable identity. Wraps a [`Diarizer`] and
/// a persistent [`OnlineSpeakerClustering`]. Mirrors `SessionDiarizer`.
pub struct SessionDiarizer<S: Segmenter, E: Embedder> {
    diarizer: Diarizer<S, E>,
    clustering: OnlineSpeakerClustering,
}

impl<S: Segmenter, E: Embedder> SessionDiarizer<S, E> {
    pub fn new(diarizer: Diarizer<S, E>, clustering: OnlineSpeakerClustering) -> Self {
        SessionDiarizer {
            diarizer,
            clustering,
        }
    }

    pub fn reset(&mut self) {
        self.clustering.reset();
    }

    pub fn num_known_speakers(&self) -> usize {
        self.clustering.num_known_speakers()
    }

    /// Diarize one utterance; speaker IDs persist across calls.
    pub fn diarize(&mut self, waveform: &[f32], sample_rate: u32) -> Vec<SpeakerSegment> {
        let local = self.diarizer.diarize_with_embeddings(waveform, sample_rate);
        if local.is_empty() {
            return Vec::new();
        }
        let embeddings: Vec<Vec<f32>> = local.iter().map(|s| s.embedding.clone()).collect();
        let ratios: Vec<f32> = local.iter().map(|s| s.active_ratio).collect();
        let global_ids = self.clustering.assign(&embeddings, Some(&ratios));
        let triples: Vec<SpeakerSegment> = local
            .iter()
            .enumerate()
            .map(|(i, s)| SpeakerSegment::new(s.start, s.end, global_ids[i]))
            .collect();
        merge_adjacent_segments(triples, 0.05)
    }
}

/// Config for the wespeaker speaker-embedding session.
#[derive(Debug, Clone)]
pub struct EmbedderConfig {
    /// Path to the wespeaker ResNet34 ONNX (e.g. wespeaker-voxceleb-resnet34-LM).
    pub model: std::path::PathBuf,
    pub num_threads: i32,
    /// `"cpu"` / `"directml"`. Embedding is small; CPU is the safe default.
    pub provider: String,
    pub debug: bool,
}

impl Default for EmbedderConfig {
    fn default() -> Self {
        EmbedderConfig {
            model: std::path::PathBuf::new(),
            num_threads: 1,
            provider: "cpu".to_string(),
            debug: false,
        }
    }
}

/// Real WeSpeaker speaker-embedding extractor on the app's shared ORT runtime.
pub struct OrtEmbedder {
    session: Session,
    input_name: String,
    output_dim: usize,
    sample_rate: u32,
    normalize_samples: bool,
    feature_normalize_type: String,
    fbanks: Array2<f32>,
    active_providers: Vec<String>,
}

impl OrtEmbedder {
    pub fn new(cfg: &EmbedderConfig) -> anyhow::Result<Self> {
        if cfg.model.as_os_str().is_empty() {
            anyhow::bail!("embedding model path is empty");
        }

        let providers = providers_from_embedder_cfg(&cfg.provider);
        let is_gpu = providers
            .first()
            .is_some_and(|provider| !matches!(provider, Accelerator::Cpu));
        let mut builder = Session::builder()
            .map_err(|e| anyhow::anyhow!("Session::builder: {e}"))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| anyhow::anyhow!("embedding opt level: {e}"))?;
        if is_gpu {
            builder = builder
                .with_intra_threads(pick_intra_op_threads(true, num_cpus_best_effort()))
                .map_err(|e| anyhow::anyhow!("embedding intra threads: {e}"))?
                .with_memory_pattern(false)
                .map_err(|e| anyhow::anyhow!("embedding disable mem pattern: {e}"))?;
        } else if cfg.num_threads > 0 {
            builder = builder
                .with_intra_threads(cfg.num_threads as usize)
                .map_err(|e| anyhow::anyhow!("embedding intra threads: {e}"))?;
        }
        builder = builder
            .with_execution_providers(execution_providers(&providers))
            .map_err(|e| anyhow::anyhow!("embedding register EPs: {e}"))?;

        let session = builder.commit_from_file(&cfg.model).map_err(|e| {
            anyhow::anyhow!("embedding commit_from_file {}: {e}", cfg.model.display())
        })?;
        let input = session
            .inputs()
            .first()
            .ok_or_else(|| anyhow::anyhow!("embedding model has no inputs"))?;
        let input_name = input.name().to_string();
        let feature_dim = input
            .dtype()
            .tensor_shape()
            .and_then(|shape| shape.get(2).copied())
            .filter(|&dim| dim > 0)
            .map_or(frontend::KALDI_N_MELS, |dim| dim as usize);
        if feature_dim != frontend::KALDI_N_MELS {
            anyhow::bail!(
                "embedding model expects {feature_dim} features, WinSTT diarization supplies {}",
                frontend::KALDI_N_MELS
            );
        }

        let metadata = session_metadata(&session);
        let output_dim = metadata
            .get("output_dim")
            .and_then(|value| value.parse::<usize>().ok())
            .or_else(|| {
                session
                    .outputs()
                    .first()
                    .and_then(|output| output.dtype().tensor_shape())
                    .and_then(|shape| shape.get(1).copied())
                    .filter(|&dim| dim > 0)
                    .map(|dim| dim as usize)
            })
            .unwrap_or(256);
        let sample_rate = metadata
            .get("sample_rate")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(DIARIZER_SAMPLE_RATE);
        let normalize_samples = metadata
            .get("normalize_samples")
            .is_none_or(|value| matches!(value.as_str(), "1" | "true" | "True" | "TRUE"));
        let feature_normalize_type = metadata
            .get("feature_normalize_type")
            .cloned()
            .unwrap_or_default();
        let active_providers = providers.iter().map(provider_label).collect();

        Ok(Self {
            session,
            input_name,
            output_dim,
            sample_rate,
            normalize_samples,
            feature_normalize_type,
            fbanks: frontend::build_kaldi_mel_filterbank(),
            active_providers,
        })
    }

    pub fn dim(&self) -> i32 {
        self.output_dim as i32
    }

    pub fn active_providers(&self) -> &[String] {
        &self.active_providers
    }
}

impl Embedder for OrtEmbedder {
    fn embed(&mut self, crop: &[f32], sample_rate: u32) -> Option<Vec<f32>> {
        if crop.is_empty() || sample_rate != self.sample_rate {
            return None;
        }

        let scaled;
        let samples = if self.normalize_samples {
            crop
        } else {
            scaled = crop
                .iter()
                .map(|sample| sample * 32768.0)
                .collect::<Vec<_>>();
            &scaled
        };

        let mut features = frontend::compute_kaldi_fbank(samples, &self.fbanks);
        if features.nrows() == 0 {
            return None;
        }
        if self.feature_normalize_type == "global-mean" {
            subtract_global_mean(&mut features);
        }

        let frames = features.nrows();
        let feat_dim = features.ncols();
        let input = features
            .into_shape_with_order((1, frames, feat_dim))
            .ok()
            .and_then(|array| Tensor::from_array(array).ok())?;
        let outputs = self
            .session
            .run(ort::inputs![self.input_name.as_str() => input])
            .ok()?;
        let (_shape, data) = outputs[0].try_extract_tensor::<f32>().ok()?;
        if data.is_empty() {
            return None;
        }

        Some(data.iter().copied().take(self.output_dim).collect())
    }
}

fn providers_from_embedder_cfg(provider: &str) -> Vec<Accelerator> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "cuda" => vec![Accelerator::Cuda, Accelerator::Cpu],
        "directml" | "dml" => vec![Accelerator::DirectMl, Accelerator::Cpu],
        _ => vec![Accelerator::Cpu],
    }
}

fn session_metadata(session: &Session) -> BTreeMap<String, String> {
    let Ok(metadata) = session.metadata() else {
        return BTreeMap::new();
    };
    let mut out = BTreeMap::new();
    if let Ok(keys) = metadata.custom_keys() {
        for key in keys {
            if let Some(value) = metadata.custom(&key) {
                out.insert(key, value);
            }
        }
    }
    out
}

fn subtract_global_mean(features: &mut Array2<f32>) {
    let rows = features.nrows();
    if rows == 0 {
        return;
    }
    for col in 0..features.ncols() {
        let mean = (0..rows).map(|row| features[[row, col]]).sum::<f32>() / rows as f32;
        for row in 0..rows {
            features[[row, col]] -= mean;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn provider_config_maps_to_accelerators() {
        assert_eq!(
            providers_from_embedder_cfg("directml"),
            vec![Accelerator::DirectMl, Accelerator::Cpu]
        );
        assert_eq!(
            providers_from_embedder_cfg("cuda"),
            vec![Accelerator::Cuda, Accelerator::Cpu]
        );
        assert_eq!(providers_from_embedder_cfg("cpu"), vec![Accelerator::Cpu]);
    }

    #[test]
    fn global_mean_normalization_zeroes_column_means() {
        let mut features = Array2::from_shape_vec((3, 2), vec![1.0, 4.0, 2.0, 5.0, 3.0, 6.0])
            .expect("test feature matrix shape is valid");
        subtract_global_mean(&mut features);
        for col in 0..features.ncols() {
            let mean = (0..features.nrows())
                .map(|row| features[[row, col]])
                .sum::<f32>()
                / features.nrows() as f32;
            assert!(
                mean.abs() < 1e-6,
                "expected near-zero mean for column {col}, got {mean}"
            );
        }
    }

    #[test]
    fn cached_wespeaker_embedder_smoke_if_available() -> anyhow::Result<()> {
        let Some(model) = find_cached_wespeaker_model() else {
            eprintln!("skipping WeSpeaker smoke test: no cached ONNX model found");
            return Ok(());
        };
        let cfg = EmbedderConfig {
            model,
            num_threads: 1,
            provider: "cpu".to_string(),
            debug: false,
        };
        let mut embedder = OrtEmbedder::new(&cfg)?;
        let samples = (0..DIARIZER_SAMPLE_RATE)
            .map(|i| {
                let t = i as f32 / DIARIZER_SAMPLE_RATE as f32;
                (2.0 * std::f32::consts::PI * 440.0 * t).sin() * 0.05
            })
            .collect::<Vec<_>>();
        let embedding = embedder
            .embed(&samples, DIARIZER_SAMPLE_RATE)
            .ok_or_else(|| anyhow::anyhow!("cached WeSpeaker model returned no embedding"))?;
        assert_eq!(embedding.len(), embedder.dim() as usize);
        assert!(embedding.iter().all(|value| value.is_finite()));
        Ok(())
    }

    fn find_cached_wespeaker_model() -> Option<PathBuf> {
        let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
        let root = PathBuf::from(home)
            .join(".cache")
            .join("huggingface")
            .join("hub");
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let path_str = path.to_string_lossy().to_ascii_lowercase();
                if path_str.contains("wespeaker") && path_str.ends_with(".onnx") {
                    return Some(path);
                }
            }
        }
        None
    }
}
