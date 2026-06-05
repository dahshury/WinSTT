//! Shared audio conditioning helpers for STT and wakeword paths.
//!
//! Batch STT can safely peak-normalize a completed utterance because it can see the
//! whole buffer first. Wakeword detection is streaming, so it uses a slower bounded
//! RMS normalizer instead; per-frame peak normalization would boost room noise and
//! increase false accepts.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AudioFrameStats {
    pub peak: f32,
    pub rms: f32,
    pub mean: f32,
}

impl AudioFrameStats {
    pub fn from_samples(samples: &[f32]) -> Self {
        if samples.is_empty() {
            return Self {
                peak: 0.0,
                rms: 0.0,
                mean: 0.0,
            };
        }

        let len = samples.len() as f32;
        let mean = samples.iter().copied().sum::<f32>() / len;
        let mut peak = 0.0_f32;
        let mut sum_sq = 0.0_f32;
        for sample in samples {
            let centered = *sample - mean;
            peak = peak.max(centered.abs());
            sum_sq += centered * centered;
        }

        Self {
            peak,
            rms: (sum_sq / len).sqrt(),
            mean,
        }
    }
}

/// Peak-normalize to 0.95. This mirrors the original WinSTT batch STT
/// `_peak_normalize` chokepoint and is intentionally one-shot.
pub(crate) fn peak_normalize(audio: &[f32]) -> Vec<f32> {
    let peak = audio.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    if peak <= 0.0 {
        return audio.to_vec();
    }
    let gain = 0.95 / peak;
    audio.iter().map(|&x| x * gain).collect()
}

#[derive(Clone, Copy, Debug)]
pub struct StreamingRmsNormalizerConfig {
    /// RMS target for frames that carry plausible speech energy.
    pub target_rms: f32,
    /// Do not boost frames below this AC RMS floor; treat them as silence/noise.
    pub active_rms_floor: f32,
    /// Lower gain bound. Allows loud frames to be attenuated.
    pub min_gain: f32,
    /// Upper gain bound. Keeps quiet speech boost from turning noise into speech.
    pub max_gain: f32,
    /// Peak limiter after DC removal and gain.
    pub limiter_peak: f32,
    /// 0..1 smoothing when gain must increase.
    pub attack: f32,
    /// 0..1 smoothing when gain relaxes downward/toward unity.
    pub release: f32,
    /// Remove per-frame DC offset before detector input.
    pub remove_dc: bool,
}

impl StreamingRmsNormalizerConfig {
    /// Wakeword default: bounded RMS leveling with conservative boost and a hard
    /// limiter. This intentionally resembles rustpotter's gain-normalizer shape
    /// (bounded gain, no threshold chasing), but permits limited boost for quiet
    /// mics because sherpa KWS does not enroll a per-user reference level.
    pub fn wakeword() -> Self {
        Self {
            target_rms: 0.035,
            active_rms_floor: 0.003,
            min_gain: 0.35,
            max_gain: 4.0,
            limiter_peak: 0.95,
            attack: 0.55,
            release: 0.12,
            remove_dc: true,
        }
    }
}

#[derive(Clone, Debug)]
pub struct NormalizedFrame {
    pub samples: Vec<f32>,
    pub raw: AudioFrameStats,
    pub normalized: AudioFrameStats,
    pub gain: f32,
    pub active: bool,
}

#[derive(Clone, Debug)]
pub struct StreamingRmsNormalizer {
    config: StreamingRmsNormalizerConfig,
    gain: f32,
}

impl StreamingRmsNormalizer {
    pub fn new(config: StreamingRmsNormalizerConfig) -> Self {
        Self { config, gain: 1.0 }
    }

    pub fn wakeword() -> Self {
        Self::new(StreamingRmsNormalizerConfig::wakeword())
    }

    pub fn reset(&mut self) {
        self.gain = 1.0;
    }

    pub fn gain(&self) -> f32 {
        self.gain
    }

    pub fn process(&mut self, samples: &[f32]) -> NormalizedFrame {
        let raw = AudioFrameStats::from_samples(samples);
        let active = raw.rms >= self.config.active_rms_floor;
        let desired_gain = if active {
            let by_rms = self.config.target_rms / raw.rms.max(1e-9);
            let by_peak = if raw.peak > 0.0 {
                self.config.limiter_peak / raw.peak
            } else {
                self.config.max_gain
            };
            by_rms
                .min(by_peak)
                .clamp(self.config.min_gain, self.config.max_gain)
        } else {
            1.0
        };

        let smoothing = if desired_gain > self.gain {
            self.config.attack
        } else {
            self.config.release
        }
        .clamp(0.0, 1.0);
        self.gain += (desired_gain - self.gain) * smoothing;
        self.gain = self.gain.clamp(self.config.min_gain, self.config.max_gain);

        let mut out = Vec::with_capacity(samples.len());
        for sample in samples {
            let centered = if self.config.remove_dc {
                *sample - raw.mean
            } else {
                *sample
            };
            out.push(
                (centered * self.gain).clamp(-self.config.limiter_peak, self.config.limiter_peak),
            );
        }

        let normalized = AudioFrameStats::from_samples(&out);
        NormalizedFrame {
            samples: out,
            raw,
            normalized,
            gain: self.gain,
            active,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    #[test]
    fn peak_normalize_scales_to_095() {
        assert_eq!(peak_normalize(&[0.0, 0.0]), vec![0.0, 0.0]);

        let out = peak_normalize(&[0.5, -0.25]);
        assert!(approx(out[0], 0.95));
        assert!(approx(out[1], -0.475));
    }

    #[test]
    fn frame_stats_are_dc_immune() {
        let stats = AudioFrameStats::from_samples(&[0.5, 0.5, 0.5]);
        assert!(approx(stats.mean, 0.5));
        assert!(approx(stats.rms, 0.0));
        assert!(approx(stats.peak, 0.0));
    }

    #[test]
    fn streaming_normalizer_does_not_boost_silence() {
        let mut normalizer = StreamingRmsNormalizer::wakeword();
        let frame = normalizer.process(&[0.0001, -0.0001, 0.0001, -0.0001]);
        assert!(!frame.active);
        assert!(approx(frame.gain, 1.0));
        assert!(frame.normalized.rms < 0.001);
    }

    #[test]
    fn streaming_normalizer_boosts_quiet_active_audio() {
        let mut normalizer = StreamingRmsNormalizer::new(StreamingRmsNormalizerConfig {
            target_rms: 0.04,
            active_rms_floor: 0.003,
            min_gain: 0.35,
            max_gain: 4.0,
            limiter_peak: 0.95,
            attack: 1.0,
            release: 1.0,
            remove_dc: true,
        });
        let input = [0.006, -0.006, 0.006, -0.006];
        let frame = normalizer.process(&input);
        assert!(frame.active);
        assert!(approx(frame.gain, 4.0));
        assert!(frame.normalized.rms > frame.raw.rms);
    }

    #[test]
    fn streaming_normalizer_attenuates_and_limits_loud_audio() {
        let mut normalizer = StreamingRmsNormalizer::new(StreamingRmsNormalizerConfig {
            target_rms: 0.04,
            active_rms_floor: 0.003,
            min_gain: 0.35,
            max_gain: 4.0,
            limiter_peak: 0.5,
            attack: 1.0,
            release: 1.0,
            remove_dc: true,
        });
        let frame = normalizer.process(&[0.9, -0.9, 0.9, -0.9]);
        assert!(frame.gain < 1.0);
        assert!(frame.normalized.peak <= 0.50001);
    }

    #[test]
    fn streaming_normalizer_reset_restores_unity_gain() {
        let mut normalizer = StreamingRmsNormalizer::wakeword();
        let _ = normalizer.process(&[0.006, -0.006, 0.006, -0.006]);
        assert!(normalizer.gain() > 1.0);
        normalizer.reset();
        assert!(approx(normalizer.gain(), 1.0));
    }
}
