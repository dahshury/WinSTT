// Source: <onnx-asr>/src/onnx_asr/diarization.py
//
// ═════════════════════════════════════════════════════════════════════════════
// 2. OnlineSpeakerClustering — PURE ARITHMETIC port of diart's clustering.
//    State persists across `assign` calls → session-stable global speaker IDs.
//    Verbatim port of diarization.py:40-198.
// ═════════════════════════════════════════════════════════════════════════════

use super::types::{dot, l2_normalize};

/// Default constants (DiarizationConfig / onnx-asr defaults).
pub const DEFAULT_DELTA_NEW: f32 = 0.5;
pub const DEFAULT_RHO_UPDATE: f32 = 0.3;
pub const DEFAULT_EMA_ALPHA: f32 = 0.5;
/// WinSTT `DiarizationConfig.max_speakers = 8`; onnx-asr default is 20.
pub const DEFAULT_MAX_SPEAKERS: usize = 8;

/// Incremental cosine-distance speaker clustering with persistent centroids.
///
/// Each [`assign`](OnlineSpeakerClustering::assign) takes a batch of new speaker
/// embeddings and matches them against the running set of global centroids:
/// 1. cosine distance to every ACTIVE centroid;
/// 2. if the closest is within `delta_new` → reuse that id (and EMA-update the
///    centroid iff `active_ratio >= rho_update`);
/// 3. else if a slot is free → mint a new centroid;
/// 4. else → forced reuse of the closest (label aliasing — accepted cap).
#[derive(Debug, Clone)]
pub struct OnlineSpeakerClustering {
    delta_new: f32,
    rho_update: f32,
    max_speakers: usize,
    ema_alpha: f32,
    /// `(max_speakers, dim)` lazily allocated on first `assign`.
    pub(super) centers: Option<Vec<Vec<f32>>>,
    active: Vec<bool>,
}

impl Default for OnlineSpeakerClustering {
    fn default() -> Self {
        Self::new(
            DEFAULT_DELTA_NEW,
            DEFAULT_RHO_UPDATE,
            DEFAULT_MAX_SPEAKERS,
            DEFAULT_EMA_ALPHA,
        )
    }
}

impl OnlineSpeakerClustering {
    pub fn new(delta_new: f32, rho_update: f32, max_speakers: usize, ema_alpha: f32) -> Self {
        OnlineSpeakerClustering {
            delta_new,
            rho_update,
            max_speakers: max_speakers.max(1),
            ema_alpha,
            centers: None,
            active: Vec::new(),
        }
    }

    /// Distinct global speaker IDs created so far this session.
    pub fn num_known_speakers(&self) -> usize {
        self.active.iter().filter(|&&a| a).count()
    }

    /// Centroid slots remaining before hitting `max_speakers`.
    pub fn num_free_slots(&self) -> usize {
        self.max_speakers - self.num_known_speakers()
    }

    /// Drop all centroids — next `assign` starts a fresh session.
    pub fn reset(&mut self) {
        self.centers = None;
        self.active.clear();
    }

    fn ensure_centers(&mut self, embedding_dim: usize) {
        if self.centers.is_none() {
            self.centers = Some(vec![vec![0.0f32; embedding_dim]; self.max_speakers]);
            self.active = vec![false; self.max_speakers];
        }
    }

    /// Place `embedding` into the first free slot, returning its global id.
    /// Caller guarantees a free slot exists.
    fn add_centroid(&mut self, embedding: &[f32]) -> i64 {
        let Some(centers) = self.centers.as_mut() else {
            return 0;
        };
        for (i, active) in self.active.iter_mut().enumerate() {
            if !*active {
                centers[i].clear();
                centers[i].extend_from_slice(embedding);
                *active = true;
                return i as i64;
            }
        }
        // Unreachable when callers respect `num_free_slots`; degrade to slot 0.
        0
    }

    fn update_centroid(&mut self, centroid_id: usize, embedding: &[f32]) {
        let alpha = self.ema_alpha;
        let Some(centers) = self.centers.as_mut() else {
            return;
        };
        let c = &mut centers[centroid_id];
        for (slot, &e) in c.iter_mut().zip(embedding.iter()) {
            *slot = alpha * e + (1.0 - alpha) * *slot;
        }
    }

    /// Match new embeddings to global speaker IDs; return per-input IDs.
    ///
    /// `embeddings`: `n` rows of `dim` floats. `active_ratios`: optional `n`-long
    /// speech-fraction per row (default all 1.0). Returns `n` int64 speaker IDs,
    /// stable across calls.
    pub fn assign(&mut self, embeddings: &[Vec<f32>], active_ratios: Option<&[f32]>) -> Vec<i64> {
        let n = embeddings.len();
        if n == 0 {
            return Vec::new();
        }
        let dim = embeddings[0].len();
        if let Some(r) = active_ratios {
            debug_assert_eq!(r.len(), n, "active_ratios length must match embeddings");
        }
        self.ensure_centers(dim);

        let mut labels = vec![0i64; n];
        for (i, emb) in embeddings.iter().enumerate() {
            let ratio = active_ratios.map_or(1.0f32, |r| r[i]);

            if self.num_known_speakers() == 0 {
                labels[i] = if self.num_free_slots() > 0 {
                    self.add_centroid(emb)
                } else {
                    0
                };
                continue;
            }

            // Cosine distance against ACTIVE centroids only.
            let emb_n = l2_normalize(emb);
            let mut closest_global: i64 = -1;
            let mut closest_dist = f32::INFINITY;
            {
                if let Some(centers) = self.centers.as_ref() {
                    for (j, &active) in self.active.iter().enumerate() {
                        if !active {
                            continue;
                        }
                        let ctr_n = l2_normalize(&centers[j]);
                        let cos = dot(&ctr_n, &emb_n);
                        let dist = 1.0 - cos;
                        if dist < closest_dist {
                            closest_dist = dist;
                            closest_global = j as i64;
                        }
                    }
                }
            }

            if closest_dist <= self.delta_new {
                labels[i] = closest_global;
                if ratio >= self.rho_update {
                    self.update_centroid(closest_global as usize, emb);
                }
            } else if self.num_free_slots() > 0 {
                labels[i] = self.add_centroid(emb);
            } else {
                // No room → forced reuse of closest (label aliasing, accepted).
                labels[i] = closest_global;
            }
        }
        labels
    }
}
