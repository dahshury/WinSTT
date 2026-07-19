// SpeakerMemoryLive — Rust port of the diarization playground's WhoSpeaksLive
// clustering backend (`examples/diarization-playground/js/cluster/whospeakslive.js`),
// itself a faithful port of KoljaB/WhoSpeaksLive
// `src/speakers/speaker_embedding_cluster.py::SpeakerMemory`.
//
// This is the transcription-independent "one embedding in, one stable decision out"
// core: append-only global speaker ids, decaying-EMA centroids, and a rich
// new-speaker gate (5 "distinct" conditions + a short-late spawn block) that keeps
// the speaker count honest over long sessions. `-1` means unknown/deferred.
//
// Every constant is the WhoSpeaksLive source default (mirrored by the playground's
// param schema). Quality is derived purely from turn DURATION (`duration_quality`),
// matching the Python; the caller's segmentation confidence is intentionally ignored.

const EPS: f32 = 1e-12;

#[inline]
fn sigmoid(x: f32) -> f32 {
    let c = x.clamp(-60.0, 60.0);
    1.0 / (1.0 + (-c).exp())
}

#[inline]
fn clamp01(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

/// Cosine similarity; returns 0.0 on a zero-norm operand (Python parity).
pub(crate) fn cosine_sim(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom < EPS { 0.0 } else { dot / denom }
}

/// L2-normalized copy; returns the input unchanged when its norm is ~0.
pub(crate) fn normalized(src: &[f32]) -> Vec<f32> {
    let n: f32 = src.iter().map(|v| v * v).sum::<f32>().sqrt();
    if n < EPS {
        return src.to_vec();
    }
    src.iter().map(|v| v / n).collect()
}

/// In-place L2 normalization (no-op on ~zero norm).
pub(crate) fn l2_normalize_in_place(v: &mut [f32]) {
    let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > EPS {
        for x in v.iter_mut() {
            *x /= n;
        }
    }
}

struct Profile {
    centroid: Vec<f32>,
    speech_seconds: f32,
    sentence_count: u32,
}

struct Candidate {
    centroid: Vec<f32>,
    speech_seconds: f32,
    sentence_count: u32,
}

/// WhoSpeaksLive source defaults (`speaker_embedding_cluster.py SpeakerMemory.__init__`,
/// as mirrored by the playground's cascade param schema) — EXCEPT the enrollment
/// durations, which are latency-tuned deviations: the source demands a 2.0 s turn
/// before a NEW speaker may enroll, and in fast dialogue (short exchanges) that
/// gate can never fire, leaving the second voice permanently mislabeled as the
/// first. 1.6 s / 0.8 s (first) / 3.0 s (late-relaxed) enroll within one short
/// utterance while the duplicate-similarity and distinct gates still hold the
/// speaker count honest. NB 1.2 s was tried and FAILED the E2E exact-count gate
/// (a phantom third profile on the 2-speaker reference clip) — don't re-lower
/// without re-running `cargo run --release --example diarize_e2e`.
pub struct SpeakerMemoryConfig {
    pub same_speaker_similarity: f32,
    pub similarity_temperature: f32,
    pub new_speaker_threshold: f32,
    pub duplicate_profile_similarity: f32,
    pub unknown_short_threshold: f32,
    pub min_first_speaker_seconds: f32,
    pub min_new_speaker_seconds: f32,
    pub late_new_speaker_min_seconds: f32,
    pub max_speakers: usize,
    pub min_margin: f32,
    pub margin_temperature: f32,
    pub update_unknown_max: f32,
    /// Staged new-speaker confirmations; `<= 1` creates immediately.
    pub new_speaker_confirmation_count: u32,
    pub new_speaker_confirmation_similarity: f32,
    pub max_pending_new_speakers: usize,
}

impl Default for SpeakerMemoryConfig {
    fn default() -> Self {
        Self {
            same_speaker_similarity: 0.45,
            similarity_temperature: 0.07,
            new_speaker_threshold: 0.58,
            duplicate_profile_similarity: 0.4,
            unknown_short_threshold: 0.86,
            min_first_speaker_seconds: 0.8,
            min_new_speaker_seconds: 1.6,
            late_new_speaker_min_seconds: 3.0,
            max_speakers: 10,
            min_margin: 0.05,
            margin_temperature: 0.035,
            update_unknown_max: 0.55,
            new_speaker_confirmation_count: 1,
            new_speaker_confirmation_similarity: 0.52,
            max_pending_new_speakers: 6,
        }
    }
}

pub struct SpeakerMemoryLive {
    cfg: SpeakerMemoryConfig,
    profiles: Vec<Profile>,
    candidates: Vec<Candidate>,
}

impl SpeakerMemoryLive {
    pub fn new(cfg: SpeakerMemoryConfig) -> Self {
        Self {
            cfg,
            profiles: Vec::new(),
            candidates: Vec::new(),
        }
    }

    pub fn reset(&mut self) {
        self.profiles.clear();
        self.candidates.clear();
    }

    pub fn speaker_count(&self) -> usize {
        self.profiles.len()
    }

    /// WhoSpeaksLive `_duration_quality`: linear ramp from 0.45 s to 2.6 s, floored at 0.25.
    fn duration_quality(duration_seconds: f32) -> f32 {
        ((duration_seconds - 0.45) / (2.6 - 0.45)).clamp(0.25, 1.0)
    }

    fn create_profile(&mut self, emb_unit: &[f32], duration: f32, sentence_count: u32) -> i32 {
        self.profiles.push(Profile {
            centroid: normalized(emb_unit),
            speech_seconds: duration.max(0.0),
            sentence_count: sentence_count.max(1),
        });
        (self.profiles.len() - 1) as i32
    }

    /// Decaying-EMA centroid update (Python `SpeakerProfile.update`).
    fn update_profile(&mut self, idx: usize, emb_unit: &[f32], duration: f32, weight: f32) {
        let p = &mut self.profiles[idx];
        let w = clamp01(weight);
        for (c, e) in p.centroid.iter_mut().zip(emb_unit.iter()) {
            *c = *c * (1.0 - w) + e * w;
        }
        l2_normalize_in_place(&mut p.centroid);
        p.sentence_count += 1;
        p.speech_seconds += duration.max(0.0);
    }

    /// Python `_should_create_new_profile` — the heart of WhoSpeaksLive's
    /// speaker-count control (5 "distinct" conditions + short-late spawn block).
    fn should_create_new(
        &self,
        unknown_probability: f32,
        top_similarity: f32,
        margin: f32,
        duration: f32,
    ) -> bool {
        let cfg = &self.cfg;
        if duration < cfg.min_new_speaker_seconds {
            return false;
        }
        if self.profiles.len() >= cfg.max_speakers {
            return false;
        }

        let dup = cfg.duplicate_profile_similarity;
        let long_low_margin_distinct = duration >= cfg.late_new_speaker_min_seconds
            && unknown_probability >= 0.3
            && top_similarity < dup + 0.05
            && margin < cfg.min_margin.max(0.1);

        if unknown_probability < cfg.new_speaker_threshold && !long_low_margin_distinct {
            return false;
        }

        let clearly_distinct = top_similarity < dup;
        let ambiguously_distinct = unknown_probability >= cfg.new_speaker_threshold.max(0.8)
            && top_similarity < dup + 0.04
            && margin < cfg.min_margin.max(0.08);
        let long_ambiguously_distinct = duration >= cfg.late_new_speaker_min_seconds
            && unknown_probability >= cfg.new_speaker_threshold
            && top_similarity < dup + 0.04
            && margin < cfg.min_margin.max(0.08);
        let long_weakly_distinct = duration >= cfg.late_new_speaker_min_seconds
            && unknown_probability >= 0.25
            && top_similarity < dup
            && margin < cfg.min_margin.max(0.12);

        if !(clearly_distinct
            || ambiguously_distinct
            || long_ambiguously_distinct
            || long_weakly_distinct
            || long_low_margin_distinct)
        {
            return false;
        }

        // Guard against short late spawns once several speakers already exist.
        if self.profiles.len() >= 4
            && duration < cfg.late_new_speaker_min_seconds
            && top_similarity >= (dup - 0.15).max(0.25)
        {
            return false;
        }
        true
    }

    /// Pick the pending candidate closest to `emb_unit` above the confirmation bar.
    fn best_candidate(&self, emb_unit: &[f32]) -> Option<usize> {
        let mut best: Option<usize> = None;
        let mut best_sim = -1.0f32;
        for (i, c) in self.candidates.iter().enumerate() {
            let sim = cosine_sim(emb_unit, &c.centroid);
            if sim > best_sim {
                best_sim = sim;
                best = Some(i);
            }
        }
        match best {
            Some(i) if best_sim >= self.cfg.new_speaker_confirmation_similarity => Some(i),
            _ => None,
        }
    }

    fn add_candidate(&mut self, emb_unit: &[f32], duration: f32) {
        self.candidates.push(Candidate {
            centroid: normalized(emb_unit),
            speech_seconds: duration.max(0.0),
            sentence_count: 1,
        });
        if self.candidates.len() > self.cfg.max_pending_new_speakers {
            // Evict the weakest (fewest sentences, then least speech).
            self.candidates.sort_by(|a, b| {
                a.sentence_count.cmp(&b.sentence_count).then(
                    a.speech_seconds
                        .partial_cmp(&b.speech_seconds)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
            });
            self.candidates.remove(0);
        }
    }

    fn update_candidate(cand: &mut Candidate, emb_unit: &[f32], duration: f32) {
        // Running EMA on the candidate centroid; weight decays with observation count.
        let w = (1.0 / ((cand.sentence_count as f32 + 1.0).powf(0.35)).max(1.0)).min(0.5);
        for (c, e) in cand.centroid.iter_mut().zip(emb_unit.iter()) {
            *c = *c * (1.0 - w) + e * w;
        }
        l2_normalize_in_place(&mut cand.centroid);
        cand.sentence_count += 1;
        cand.speech_seconds += duration.max(0.0);
    }

    /// Python `_create_or_stage_new_profile_locked`. Returns global id, or -1 if staged.
    fn create_or_stage(&mut self, emb_unit: &[f32], duration: f32) -> i32 {
        if self.cfg.new_speaker_confirmation_count <= 1 {
            return self.create_profile(emb_unit, duration, 1);
        }
        let Some(ci) = self.best_candidate(emb_unit) else {
            self.add_candidate(emb_unit, duration);
            return -1;
        };
        Self::update_candidate(&mut self.candidates[ci], emb_unit, duration);
        let cand = &self.candidates[ci];
        if cand.sentence_count >= self.cfg.new_speaker_confirmation_count
            && cand.speech_seconds >= self.cfg.min_new_speaker_seconds
        {
            let cand = self.candidates.remove(ci);
            return self.create_profile(&cand.centroid, cand.speech_seconds, cand.sentence_count);
        }
        -1
    }

    /// Assign one pooled turn embedding. Returns the 0-based global speaker id,
    /// or -1 when UNKNOWN / deferred / staged.
    pub fn assign_turn(&mut self, emb: &[f32], duration: f32) -> i32 {
        let cfg_min_first = self.cfg.min_first_speaker_seconds;
        let emb_unit = normalized(emb);
        let quality = Self::duration_quality(duration);

        // First-ever speaker (Python classify, empty-profiles branch).
        if self.profiles.is_empty() {
            if duration < cfg_min_first {
                return -1;
            }
            return self.create_profile(&emb_unit, duration, 1);
        }

        // Score against existing profiles (`_score_locked`).
        let sims: Vec<f32> = self
            .profiles
            .iter()
            .map(|p| cosine_sim(&emb_unit, &p.centroid))
            .collect();
        let mut top_idx = 0usize;
        for (i, &s) in sims.iter().enumerate().skip(1) {
            if s > sims[top_idx] {
                top_idx = i;
            }
        }
        let top_similarity = sims[top_idx];
        let mut second_similarity = -1.0f32;
        for (i, &s) in sims.iter().enumerate() {
            if i != top_idx && s > second_similarity {
                second_similarity = s;
            }
        }
        let multi = self.profiles.len() > 1;
        let margin = if multi {
            top_similarity - second_similarity
        } else {
            1.0
        };

        let cfg = &self.cfg;
        let same_probability =
            sigmoid((top_similarity - cfg.same_speaker_similarity) / cfg.similarity_temperature);
        let margin_probability = if multi {
            sigmoid((margin - cfg.min_margin) / cfg.margin_temperature)
        } else {
            1.0
        };
        let maturity = (0.45 + 0.55 * (self.profiles[top_idx].speech_seconds / 8.0)).min(1.0);
        let known_mass =
            clamp01(same_probability * margin_probability * maturity * (0.55 + 0.45 * quality));
        let unknown_probability = clamp01(1.0 - known_mass);

        let single_profile_weak_short = self.profiles.len() == 1
            && duration < cfg.min_new_speaker_seconds
            && top_similarity
                < (cfg.same_speaker_similarity + 0.12).max(cfg.duplicate_profile_similarity + 0.08);

        if self.should_create_new(unknown_probability, top_similarity, margin, duration) {
            return self.create_or_stage(&emb_unit, duration);
        }
        if single_profile_weak_short
            || (unknown_probability >= cfg.unknown_short_threshold
                && duration < cfg.min_new_speaker_seconds)
        {
            return -1; // deferred to UNKNOWN
        }

        // Assign to the top profile; EMA-update it when confident enough.
        if unknown_probability <= cfg.update_unknown_max && quality >= 0.35 {
            let mut weight = (0.08 + 0.18 * quality).min(0.28);
            weight /= (self.profiles[top_idx].sentence_count as f32)
                .powf(0.35)
                .max(1.0);
            self.update_profile(top_idx, &emb_unit, duration, weight);
        }
        top_idx as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(dim: usize, hot: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; dim];
        v[hot] = 1.0;
        v
    }

    /// A vector leaning mostly toward axis `hot` with a small `lean` toward `other`.
    fn leaning(dim: usize, hot: usize, other: usize, lean: f32) -> Vec<f32> {
        let mut v = vec![0.0f32; dim];
        v[hot] = 1.0;
        v[other] = lean;
        normalized(&v)
    }

    #[test]
    fn first_speaker_requires_min_first_duration() {
        let mut m = SpeakerMemoryLive::new(SpeakerMemoryConfig::default());
        // Below min_first_speaker_seconds (0.8) → deferred.
        assert_eq!(m.assign_turn(&unit(8, 0), 0.5), -1);
        assert_eq!(m.speaker_count(), 0);
        // Long enough → profile 0.
        assert_eq!(m.assign_turn(&unit(8, 0), 2.0), 0);
        assert_eq!(m.speaker_count(), 1);
    }

    #[test]
    fn same_voice_reassigns_to_same_profile() {
        let mut m = SpeakerMemoryLive::new(SpeakerMemoryConfig::default());
        assert_eq!(m.assign_turn(&unit(8, 0), 3.0), 0);
        // Nearly identical embedding, long turn → same speaker, no new profile.
        assert_eq!(m.assign_turn(&leaning(8, 0, 1, 0.05), 3.0), 0);
        assert_eq!(m.speaker_count(), 1);
    }

    #[test]
    fn distinct_voice_spawns_second_profile() {
        let mut m = SpeakerMemoryLive::new(SpeakerMemoryConfig::default());
        assert_eq!(m.assign_turn(&unit(8, 0), 3.0), 0);
        // Orthogonal embedding, long turn → clearly distinct → new profile.
        assert_eq!(m.assign_turn(&unit(8, 1), 3.0), 1);
        assert_eq!(m.speaker_count(), 2);
        // Back to the first voice.
        assert_eq!(m.assign_turn(&leaning(8, 0, 1, 0.08), 3.0), 0);
        assert_eq!(m.speaker_count(), 2);
    }

    #[test]
    fn short_distinct_turn_is_deferred_not_spawned() {
        let mut m = SpeakerMemoryLive::new(SpeakerMemoryConfig::default());
        assert_eq!(m.assign_turn(&unit(8, 0), 3.0), 0);
        // Distinct but shorter than min_new_speaker_seconds (1.2) → -1, not a spawn.
        let got = m.assign_turn(&unit(8, 1), 0.9);
        assert_eq!(got, -1);
        assert_eq!(m.speaker_count(), 1);
    }

    #[test]
    fn max_speakers_caps_profile_creation() {
        let cfg = SpeakerMemoryConfig {
            max_speakers: 2,
            ..Default::default()
        };
        let mut m = SpeakerMemoryLive::new(cfg);
        assert_eq!(m.assign_turn(&unit(8, 0), 3.0), 0);
        assert_eq!(m.assign_turn(&unit(8, 1), 3.0), 1);
        // A third orthogonal voice cannot spawn; it resolves to an existing id or -1.
        let got = m.assign_turn(&unit(8, 2), 4.0);
        assert!(got < 2, "no third profile may be created, got {got}");
        assert_eq!(m.speaker_count(), 2);
    }

    #[test]
    fn confirmation_staging_delays_profile_creation() {
        let cfg = SpeakerMemoryConfig {
            new_speaker_confirmation_count: 2,
            ..Default::default()
        };
        let mut m = SpeakerMemoryLive::new(cfg);
        assert_eq!(m.assign_turn(&unit(8, 0), 3.0), 0);
        // First distinct observation stages a candidate (-1, no profile yet).
        assert_eq!(m.assign_turn(&unit(8, 1), 3.0), -1);
        assert_eq!(m.speaker_count(), 1);
        // Second observation of the same distinct voice confirms → profile 1.
        assert_eq!(m.assign_turn(&leaning(8, 1, 2, 0.05), 3.0), 1);
        assert_eq!(m.speaker_count(), 2);
    }

    #[test]
    fn ema_update_moves_centroid_toward_new_observation() {
        let mut m = SpeakerMemoryLive::new(SpeakerMemoryConfig::default());
        assert_eq!(m.assign_turn(&unit(8, 0), 3.0), 0);
        let before = m.profiles[0].centroid.clone();
        let obs = leaning(8, 0, 1, 0.2);
        assert_eq!(m.assign_turn(&obs, 3.0), 0);
        let after = &m.profiles[0].centroid;
        assert!(cosine_sim(after, &obs) > cosine_sim(&before, &obs));
        // Centroid stays unit-norm.
        let n: f32 = after.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((n - 1.0).abs() < 1e-5);
    }

    #[test]
    fn reset_clears_all_state() {
        let mut m = SpeakerMemoryLive::new(SpeakerMemoryConfig::default());
        assert_eq!(m.assign_turn(&unit(8, 0), 3.0), 0);
        m.reset();
        assert_eq!(m.speaker_count(), 0);
        assert_eq!(m.assign_turn(&unit(8, 1), 3.0), 0);
    }
}
