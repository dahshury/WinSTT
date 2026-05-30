// DRAFT PORT — not yet compiled. Source: server/src/recorder/application/vad_calibrator.py
//
// Cross-utterance adaptive Silero VAD sensitivity.
//
// The calibrator collects per-chunk RMS samples during each recording, and on a
// successful (non-empty) transcription derives a new target sensitivity from the
// observed SNR, EMA-blends it with the current value, clamps, and applies it to
// the live SileroVad sensitivity via injected getter/setter closures.
//
// Per-device PERSISTENCE lives entirely on the renderer side (keyed by
// input-device name `sileroSensitivityByDeviceName`); this engine stays
// device-agnostic — it only emits an `Adaptation` describing the new value so
// the host (lib.rs command/event layer) can relay it to the renderer.
//
// Invariant carry-over (memory/project_silero_vad_cpu_pin_invariant.md): the
// *sensitivity* knob this calibrator mutates is a pure scalar; loading Silero
// itself must remain CPU-pinned. Nothing here touches the ORT session.
//
// Python parity reference (constants verbatim):
//   MIN_SENSITIVITY=0.15  MAX_SENSITIVITY=0.7  EMA_ALPHA=0.3
//   LOW_SNR_DB=10.0       HIGH_SNR_DB=40.0
//   MIN_SAMPLES_FOR_ADAPT=20  NOISE_FLOOR_PCT=10  SPEECH_PEAK_PCT=90
//   APPLY_EPSILON=1e-4
//   SNR_dB = 20*log10(peak/noise); linear map LOW->MIN, HIGH->MAX.

/// Hard bounds on adapted sensitivity. Below MIN, Silero rejects even clear
/// speech; above MAX it accepts almost any non-silence chunk.
pub const MIN_SENSITIVITY: f32 = 0.15;
pub const MAX_SENSITIVITY: f32 = 0.7;
/// Blend factor for new observations into the running value. Lower = slower to
/// react but more stable; higher = follows the room faster but jitters.
pub const EMA_ALPHA: f32 = 0.3;
/// SNR (dB) -> target sensitivity mapping endpoints. Below LOW -> MIN (noisy
/// room, be strict); above HIGH -> MAX (quiet room, catch whispers).
pub const LOW_SNR_DB: f32 = 10.0;
pub const HIGH_SNR_DB: f32 = 40.0;
/// Need at least this many frame-RMS samples in a recording before we trust the
/// percentile estimates. ~0.5 s of audio at 32 ms frames.
pub const MIN_SAMPLES_FOR_ADAPT: usize = 20;
/// Percentiles used to estimate ambient noise floor and speech peak.
pub const NOISE_FLOOR_PCT: f64 = 10.0;
pub const SPEECH_PEAK_PCT: f64 = 90.0;
/// Skip publishing when the EMA-clamped value is essentially unchanged.
pub const APPLY_EPSILON: f32 = 1e-4;

/// Emitted whenever a recording's stats produce a (sufficiently different) new
/// sensitivity. Mirrors the Python `VADSensitivityAdapted` event payload. The
/// host relays this to the renderer for per-device persistence.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Adaptation {
    pub new_sensitivity: f32,
    pub noise_floor_rms: f32,
    pub speech_peak_rms: f32,
}

/// Adaptive Silero sensitivity tracker.
///
/// Lifecycle (driven by the recorder pipeline):
///   1. `on_recording_started()`  — wipe sample buffer, begin collecting.
///   2. `on_chunk(pcm_i16)`        — accumulate per-chunk RMS (only while collecting).
///   3. `on_recording_stopped()`   — stop collecting; freeze pending stats if enough samples.
///   4. `on_transcription_completed(text, get, set)` — if text non-empty AND
///      stats pending, derive+blend+clamp the new sensitivity, apply via `set`,
///      and return `Some(Adaptation)` describing it (or `None` if no-op).
///
/// `get`/`set` are closures onto the live SileroVad sensitivity so the
/// calibrator never holds a reference to the VAD itself (keeps borrow rules
/// trivial and matches the Python getter/setter-callback design).
#[derive(Debug, Default)]
pub struct VadCalibrator {
    rms_samples: Vec<f32>,
    collecting: bool,
    /// (noise_floor_rms, speech_peak_rms) frozen at recording stop; consumed on
    /// the next transcription-completed callback.
    pending_stats: Option<(f32, f32)>,
}

impl VadCalibrator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on_recording_started(&mut self) {
        self.rms_samples.clear();
        self.collecting = true;
        self.pending_stats = None;
    }

    /// Accumulate the RMS of one int16 PCM chunk. No-op unless collecting.
    pub fn on_chunk(&mut self, pcm_i16: &[i16]) {
        if !self.collecting || pcm_i16.is_empty() {
            return;
        }
        self.rms_samples.push(rms_i16(pcm_i16));
    }

    pub fn on_recording_stopped(&mut self) {
        self.collecting = false;
        if self.rms_samples.len() < MIN_SAMPLES_FOR_ADAPT {
            self.pending_stats = None;
            return;
        }
        let noise = percentile(&self.rms_samples, NOISE_FLOOR_PCT);
        let peak = percentile(&self.rms_samples, SPEECH_PEAK_PCT);
        self.pending_stats = Some((noise, peak));
    }

    /// Apply adaptation on a successful (non-empty) transcription.
    ///
    /// Returns `Some(Adaptation)` when the sensitivity actually changed (and was
    /// applied via `set`), else `None`. `transcribed_text` is the final
    /// transcript: empty/whitespace-only text means "no usable utterance" and is
    /// skipped (mirrors Python `text.strip()` guard).
    pub fn on_transcription_completed<G, S>(
        &mut self,
        transcribed_text: &str,
        get: G,
        mut set: S,
    ) -> Option<Adaptation>
    where
        G: Fn() -> f32,
        S: FnMut(f32),
    {
        let stats = self.pending_stats.take()?;
        if transcribed_text.trim().is_empty() {
            return None;
        }
        let (noise, peak) = stats;
        let target = target_from_snr(noise, peak);
        let current = get();
        let blended = EMA_ALPHA * target + (1.0 - EMA_ALPHA) * current;
        let clamped = blended.clamp(MIN_SENSITIVITY, MAX_SENSITIVITY);
        if (clamped - current).abs() < APPLY_EPSILON {
            return None;
        }
        set(clamped);
        Some(Adaptation {
            new_sensitivity: clamped,
            noise_floor_rms: noise,
            speech_peak_rms: peak,
        })
    }
}

/// RMS of one int16 PCM frame, computed in f32 the same way Python does:
/// `sqrt(mean(samples^2))` over the float-promoted samples (NOT normalized to
/// [-1,1] — the calibrator works on raw int16-magnitude RMS, and the SNR is a
/// ratio so the absolute scale cancels).
pub fn rms_i16(pcm_i16: &[i16]) -> f32 {
    if pcm_i16.is_empty() {
        return 0.0;
    }
    let mut acc = 0.0f64;
    for &s in pcm_i16 {
        let v = s as f64;
        acc += v * v;
    }
    (acc / pcm_i16.len() as f64).sqrt() as f32
}

/// Linear-interpolation percentile matching numpy's default ("linear" method),
/// which is what `np.percentile` uses. `pct` is in [0, 100].
///
/// numpy linear interpolation: rank = (n-1) * pct/100; lower=floor(rank),
/// upper=ceil(rank); result = sorted[lower] + (rank-lower)*(sorted[upper]-sorted[lower]).
pub fn percentile(samples: &[f32], pct: f64) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sorted: Vec<f32> = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if sorted.len() == 1 {
        return sorted[0];
    }
    let rank = (sorted.len() as f64 - 1.0) * (pct / 100.0);
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    let frac = (rank - lower as f64) as f32;
    sorted[lower] + frac * (sorted[upper] - sorted[lower])
}

/// Map observed RMS noise/peak to a target Silero sensitivity. Low SNR (noisy)
/// maps to the strict end; high SNR (quiet) maps to the permissive end.
pub fn target_from_snr(noise: f32, peak: f32) -> f32 {
    if !has_usable_snr(noise, peak) {
        return MIN_SENSITIVITY;
    }
    let snr_db = 20.0 * (peak / noise).log10();
    sensitivity_for_snr_db(snr_db)
}

fn has_usable_snr(noise: f32, peak: f32) -> bool {
    noise > 0.0 && peak > 0.0 && peak > noise
}

fn sensitivity_for_snr_db(snr_db: f32) -> f32 {
    if snr_db <= LOW_SNR_DB {
        return MIN_SENSITIVITY;
    }
    if snr_db >= HIGH_SNR_DB {
        return MAX_SENSITIVITY;
    }
    let t = (snr_db - LOW_SNR_DB) / (HIGH_SNR_DB - LOW_SNR_DB);
    MIN_SENSITIVITY + t * (MAX_SENSITIVITY - MIN_SENSITIVITY)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    #[test]
    fn rms_of_constant_signal() {
        // RMS of a constant 100 is 100.
        assert!(approx(rms_i16(&[100, 100, 100, 100]), 100.0));
        // RMS of +/-100 alternating is 100.
        assert!(approx(rms_i16(&[100, -100, 100, -100]), 100.0));
    }

    #[test]
    fn rms_empty_is_zero() {
        assert_eq!(rms_i16(&[]), 0.0);
    }

    #[test]
    fn percentile_matches_numpy_linear() {
        // numpy: np.percentile([10,20,30,40,50], 10) == 14.0,
        //        np.percentile([10,20,30,40,50], 90) == 46.0.
        let s = [10.0f32, 20.0, 30.0, 40.0, 50.0];
        assert!(approx(percentile(&s, 10.0), 14.0));
        assert!(approx(percentile(&s, 90.0), 46.0));
        // 50th percentile of this set is the median 30.
        assert!(approx(percentile(&s, 50.0), 30.0));
    }

    #[test]
    fn percentile_single_and_endpoints() {
        assert!(approx(percentile(&[7.0], 90.0), 7.0));
        let s = [1.0f32, 2.0, 3.0, 4.0];
        assert!(approx(percentile(&s, 0.0), 1.0));
        assert!(approx(percentile(&s, 100.0), 4.0));
    }

    #[test]
    fn snr_below_low_clamps_to_min() {
        // peak/noise = 1.5 -> 20*log10(1.5) ≈ 3.52 dB <= 10 -> MIN.
        assert!(approx(target_from_snr(100.0, 150.0), MIN_SENSITIVITY));
    }

    #[test]
    fn snr_above_high_clamps_to_max() {
        // peak/noise = 1000 -> 60 dB >= 40 -> MAX.
        assert!(approx(target_from_snr(1.0, 1000.0), MAX_SENSITIVITY));
    }

    #[test]
    fn snr_midpoint_interpolates() {
        // SNR = 25 dB is the midpoint of [10, 40] -> halfway between MIN and MAX.
        // 25 dB => peak/noise = 10^(25/20) = 17.7827941...
        let noise = 1.0f32;
        let peak = 10f32.powf(25.0 / 20.0);
        let expected = MIN_SENSITIVITY + 0.5 * (MAX_SENSITIVITY - MIN_SENSITIVITY);
        assert!(approx(target_from_snr(noise, peak), expected));
    }

    #[test]
    fn unusable_snr_returns_min() {
        assert!(approx(target_from_snr(0.0, 10.0), MIN_SENSITIVITY));
        assert!(approx(target_from_snr(10.0, 0.0), MIN_SENSITIVITY));
        // peak <= noise (no headroom) -> MIN.
        assert!(approx(target_from_snr(50.0, 40.0), MIN_SENSITIVITY));
    }

    #[test]
    fn no_adapt_when_too_few_samples() {
        let mut cal = VadCalibrator::new();
        cal.on_recording_started();
        // Only 5 samples (< MIN_SAMPLES_FOR_ADAPT=20) of strong-SNR audio.
        for _ in 0..5 {
            cal.on_chunk(&[1000, -1000]);
        }
        cal.on_recording_stopped();
        let current = 0.3f32;
        let out = cal.on_transcription_completed("hello world", || current, |_| {});
        assert!(out.is_none());
    }

    #[test]
    fn no_adapt_when_text_empty() {
        let mut cal = VadCalibrator::new();
        cal.on_recording_started();
        // Mixed quiet/loud frames so percentiles differ -> high SNR.
        for i in 0..40 {
            if i % 2 == 0 {
                cal.on_chunk(&[5, -5]);
            } else {
                cal.on_chunk(&[8000, -8000]);
            }
        }
        cal.on_recording_stopped();
        let out = cal.on_transcription_completed("   ", || 0.3, |_| {});
        assert!(out.is_none());
    }

    #[test]
    fn adapt_applies_blended_clamped_value() {
        let mut cal = VadCalibrator::new();
        cal.on_recording_started();
        // Build a high-SNR distribution: 10th pctile small, 90th pctile large.
        for i in 0..40 {
            if i < 20 {
                cal.on_chunk(&[10, -10]); // quiet floor
            } else {
                cal.on_chunk(&[10000, -10000]); // loud speech
            }
        }
        cal.on_recording_stopped();

        let mut applied: Option<f32> = None;
        let current = 0.3f32;
        let out = cal.on_transcription_completed(
            "the quick brown fox",
            || current,
            |v| applied = Some(v),
        );
        let adapt = out.expect("should adapt on strong SNR + non-empty text");
        // Target is MAX (0.7) here; blended = 0.3*0.7 + 0.7*0.3 = 0.42.
        assert!(approx(adapt.new_sensitivity, 0.42));
        assert_eq!(applied, Some(adapt.new_sensitivity));
        // Always within hard bounds.
        assert!(adapt.new_sensitivity >= MIN_SENSITIVITY);
        assert!(adapt.new_sensitivity <= MAX_SENSITIVITY);
    }

    #[test]
    fn no_adapt_when_change_below_epsilon() {
        let mut cal = VadCalibrator::new();
        cal.on_recording_started();
        // Low SNR -> target MIN (0.15). If current is already 0.15 the blend is a
        // no-op (0.3*0.15 + 0.7*0.15 = 0.15) and stays under APPLY_EPSILON.
        for _ in 0..40 {
            cal.on_chunk(&[120, -120]); // flat -> noise≈peak -> unusable SNR -> MIN
        }
        cal.on_recording_stopped();
        let mut applied = false;
        let out = cal.on_transcription_completed("hi", || MIN_SENSITIVITY, |_| applied = true);
        assert!(out.is_none());
        assert!(!applied);
    }

    #[test]
    fn chunks_ignored_when_not_collecting() {
        let mut cal = VadCalibrator::new();
        // No on_recording_started -> not collecting.
        cal.on_chunk(&[5000, -5000]);
        cal.on_recording_stopped();
        // pending_stats stays None -> no adaptation.
        let out = cal.on_transcription_completed("text", || 0.3, |_| {});
        assert!(out.is_none());
    }
}
