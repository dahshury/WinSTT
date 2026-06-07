// Reference: E:/DL/Projects/onnx-asr/src/onnx_asr/diarization.py
//         sherpa-onnx 1.13.2 SpeakerEmbeddingExtractor (verified docs.rs 2026-05):
//           SpeakerEmbeddingExtractorConfig { model: Option<String>, num_threads: i32,
//                                             debug: bool, provider: Option<String> }
//           SpeakerEmbeddingExtractor::create(&cfg) -> Option<Self>
//           .create_stream() -> Option<OnlineStream> ; .compute(&stream) -> Option<Vec<f32>>
//           .dim() -> i32 ; .is_ready(&stream) -> bool
//           OnlineStream::accept_waveform(sample_rate: i32, &[f32]) ; .input_finished()
//
// ═════════════════════════════════════════════════════════════════════════════
// 7. Diarizer config + the segmentation/embedding ORCHESTRATION (FFI).
//    Embedding is real sherpa-onnx wiring; segmentation output shape is `// SPIKE:`.
// 8. Real sherpa-onnx embedder (FFI). Gated behind `feature = "sherpa"`.
// ═════════════════════════════════════════════════════════════════════════════

use super::ahc::{active_intervals, ahc_complete_linkage, cosine_distance_matrix};
use super::clustering::OnlineSpeakerClustering;
use super::timeline::merge_adjacent_segments;
use super::types::{EmbeddedSegment, SpeakerSegment};

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

/// Speaker-embedding extractor (wespeaker ResNet34 → 256-d). FFI behind a trait
/// so clustering is testable; the real impl is `SherpaEmbedder` below.
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

/// Real wespeaker speaker-embedding extractor on sherpa-onnx 1.13.2.
///
/// COMPILE NOTE: like `wakeword.rs`, sherpa-onnx is declared UNCONDITIONALLY in
/// Cargo.toml (no `sherpa` cargo feature, and we may not edit Cargo.toml), so the
/// FFI compiles unconditionally. The pure clustering/timeline logic above never
/// touches the FFI and keeps its own tests.
pub struct SherpaEmbedder {
    extractor: sherpa_onnx::SpeakerEmbeddingExtractor,
}

impl SherpaEmbedder {
    pub fn new(cfg: &EmbedderConfig) -> anyhow::Result<Self> {
        let model = cfg
            .model
            .to_str()
            .ok_or_else(|| {
                anyhow::anyhow!("embedding model path not UTF-8: {}", cfg.model.display())
            })?
            .to_string();
        let sherpa_cfg = sherpa_onnx::SpeakerEmbeddingExtractorConfig {
            model: Some(model),
            num_threads: cfg.num_threads.max(1),
            debug: cfg.debug,
            provider: Some(cfg.provider.clone()),
        };
        let extractor = sherpa_onnx::SpeakerEmbeddingExtractor::create(&sherpa_cfg)
            .ok_or_else(|| anyhow::anyhow!("failed to create sherpa SpeakerEmbeddingExtractor"))?;
        Ok(SherpaEmbedder { extractor })
    }

    pub fn dim(&self) -> i32 {
        self.extractor.dim()
    }
}

impl Embedder for SherpaEmbedder {
    fn embed(&mut self, crop: &[f32], sample_rate: u32) -> Option<Vec<f32>> {
        // sherpa flow: create_stream → accept_waveform → input_finished → compute.
        let stream = self.extractor.create_stream()?;
        stream.accept_waveform(sample_rate as i32, crop);
        stream.input_finished();
        if !self.extractor.is_ready(&stream) {
            // Fail-soft: too-short crop → no embedding (mirrors _safe_diarize).
            return None;
        }
        self.extractor.compute(&stream)
    }
}
