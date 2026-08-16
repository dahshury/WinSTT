use rubato::{Fft, FixedSync, Resampler, audioadapter_buffers::direct::InterleavedSlice};
use std::time::Duration;

const RESAMPLER_CHUNK_SIZE: usize = 1024;

pub struct FrameResampler {
    resampler: Option<Fft<f32>>,
    chunk_in: usize,
    in_buf: Vec<f32>,
    frame_samples: usize,
    pending: Vec<f32>,
    in_hz: usize,
    out_hz: usize,
    /// REAL input samples handed to `push` SINCE the last `finish` (never the zero-pad
    /// `finish` injects). Drives `finish`'s expected-output computation so the caller can
    /// strip the synthetic tail padding. Reset to 0 by `finish` so each flush measures only
    /// its own window — the resampler is reused across recordings (idle audio flows through
    /// it continuously), and windowing lets idle real input/output cancel out, leaving just
    /// this flush's padding.
    total_in: u64,
    /// Output samples actually emitted as full frames (via `emit_frames` and the final
    /// padded frame in `finish`) SINCE the last `finish`. Compared against the expected real
    /// output in `finish` to derive the synthetic-pad count, then reset to 0.
    emitted_out: usize,
}

impl FrameResampler {
    pub fn try_new(in_hz: usize, out_hz: usize, frame_dur: Duration) -> Result<Self, String> {
        let frame_samples = ((out_hz as f64 * frame_dur.as_secs_f64()).round()) as usize;
        if frame_samples == 0 {
            return Err("frame duration too short".to_string());
        }

        // Use fixed chunk size instead of GCD-based
        let chunk_in = RESAMPLER_CHUNK_SIZE;

        let resampler = if in_hz != out_hz {
            Some(
                Fft::<f32>::new(in_hz, out_hz, chunk_in, 1, FixedSync::Input)
                    .map_err(|err| format!("failed to create resampler: {err}"))?,
            )
        } else {
            None
        };

        Ok(Self {
            resampler,
            chunk_in,
            in_buf: Vec::with_capacity(chunk_in),
            frame_samples,
            pending: Vec::with_capacity(frame_samples),
            in_hz,
            out_hz,
            total_in: 0,
            emitted_out: 0,
        })
    }

    pub fn push(&mut self, mut src: &[f32], mut emit: impl FnMut(&[f32])) {
        self.total_in += src.len() as u64;

        if self.resampler.is_none() {
            self.emit_frames(src, &mut emit);
            return;
        }

        while !src.is_empty() {
            let space = self.chunk_in - self.in_buf.len();
            let take = space.min(src.len());
            self.in_buf.extend_from_slice(&src[..take]);
            src = &src[take..];

            if self.in_buf.len() == self.chunk_in {
                if let Some(resampler) = self.resampler.as_mut()
                    && let Ok(input) =
                        InterleavedSlice::new(self.in_buf.as_slice(), 1, self.chunk_in)
                    && let Ok(out) = resampler.process(&input, None)
                {
                    self.emit_frames(&out.take_data(), &mut emit);
                }
                self.in_buf.clear();
            }
        }
    }

    /// Flush the resampler and the trailing partial frame, returning the number of
    /// SYNTHETIC samples this instance emitted as a result of zero-padding — both the
    /// resampler-chunk zero-pad spillover (padding the last short input chunk up to
    /// `chunk_in`) and the final partial frame's zero-pad. The emit contract still yields
    /// only full `frame_samples` frames (Silero requires exactly `frame_samples`), so the
    /// caller strips synthetic tail silence by truncating its accumulated output by this
    /// count. Callers that treat `finish` as a statement may ignore the return value.
    pub fn finish(&mut self, mut emit: impl FnMut(&[f32])) -> usize {
        // `Fft` has an internal OUTPUT DELAY (`output_delay()`): the last real samples
        // handed to `push` are still stuck inside its delay line when `finish` begins, and it
        // also emits exactly `output_delay` warmup samples at the START of every accounting
        // window (the delay line is zero-primed at construction, and this `finish` re-primes it
        // with zeros, so the NEXT window opens the same way). Two consequences the flush below
        // must handle so truncation never eats a real word ending:
        //   1. DRAIN: feed enough trailing zero input to push the delayed REAL tail all the way
        //      out — one padded partial chunk is NOT enough when the leftover is large.
        //   2. ACCOUNT: the `output_delay` leading transient is counted in `emitted_out` but is
        //      not real content, so `expected` adds it back — otherwise `synthetic` over-counts
        //      and the tail truncation cuts the last ~`output_delay` samples of real audio.
        let mut delay_out = 0usize;

        if self.resampler.is_some() {
            // Guarded by is_some(); re-borrowed below per process() call so `emit_frames`
            // (which needs &mut self) can run between calls.
            delay_out = self.resampler.as_ref().unwrap().output_delay();

            // Real 16 kHz output still OWED when finish begins: the delay line's `delay_out`
            // plus the resampled worth of the still-unprocessed real leftover in `in_buf`.
            let real_leftover = self.in_buf.len();
            let real_owed = ((real_leftover as u128 * self.out_hz as u128
                + (self.in_hz as u128 / 2))
                / self.in_hz as u128) as usize
                + delay_out;

            // Pad the trailing partial input chunk to a full chunk (FixedIn requires exactly
            // `chunk_in` per call); its trailing zeros begin flushing the delay line. Then keep
            // feeding all-zero chunks until finish has emitted at least `real_owed` samples —
            // i.e. the delayed REAL tail has fully emerged. Hard-capped so a pathological ratio
            // can never spin forever; the emit contract still yields only full frames.
            const MAX_FINISH_CHUNKS: usize = 64;
            self.in_buf.resize(self.chunk_in, 0.0);
            let mut finish_out = 0usize;
            for _ in 0..MAX_FINISH_CHUNKS {
                let processed = {
                    let resampler = self.resampler.as_mut().unwrap();
                    InterleavedSlice::new(self.in_buf.as_slice(), 1, self.chunk_in)
                        .map_err(|_| ())
                        .and_then(|input| resampler.process(&input, None).map_err(|_| ()))
                };
                match processed {
                    Ok(out) => {
                        let out = out.take_data();
                        finish_out += out.len();
                        self.emit_frames(&out, &mut emit);
                    }
                    Err(_) => break,
                }
                if finish_out >= real_owed {
                    break;
                }
                // Subsequent chunks are pure zero input to keep draining the delay line.
                self.in_buf.clear();
                self.in_buf.resize(self.chunk_in, 0.0);
            }
            self.in_buf.clear();
        }

        // Emit any remaining pending frame (padded with zeros)
        if !self.pending.is_empty() {
            self.pending.resize(self.frame_samples, 0.0);
            emit(&self.pending);
            self.emitted_out += self.frame_samples;
            self.pending.clear();
        }

        // Expected REAL output = round(total_in * out_hz / in_hz) in exact integer math (u128 to
        // avoid overflow) PLUS the `output_delay` leading transient every window carries (see the
        // block above). Everything emitted beyond that is zero-pad this flush injected — the
        // chunk-boundary spillover, the delay-flush zeros, and the final-frame pad. saturating_sub
        // errs toward keeping audio when rounding leaves emitted < expected.
        let expected = ((self.total_in as u128 * self.out_hz as u128 + (self.in_hz as u128 / 2))
            / self.in_hz as u128) as usize
            + delay_out;
        let synthetic = self.emitted_out.saturating_sub(expected);

        // Open a fresh accounting window: both buffers are now empty, so 0/0 is the correct
        // baseline for the next recording. Without this, cumulative counts would make later
        // recordings report every prior flush's padding and over-truncate.
        self.total_in = 0;
        self.emitted_out = 0;

        synthetic
    }

    fn emit_frames(&mut self, mut data: &[f32], emit: &mut impl FnMut(&[f32])) {
        while !data.is_empty() {
            let space = self.frame_samples - self.pending.len();
            let take = space.min(data.len());
            self.pending.extend_from_slice(&data[..take]);
            data = &data[take..];

            if self.pending.len() == self.frame_samples {
                emit(&self.pending);
                self.emitted_out += self.frame_samples;
                self.pending.clear();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_dur_for(samples: usize, hz: usize) -> Duration {
        Duration::from_secs_f64(samples as f64 / hz as f64)
    }

    #[test]
    fn identity_passthrough_chunks_into_fixed_frames() {
        // in == out -> no resampler; pure 160-sample reframing, content preserved.
        let mut r = FrameResampler::try_new(16_000, 16_000, frame_dur_for(160, 16_000)).unwrap();
        let input: Vec<f32> = (0..320).map(|i| i as f32).collect();
        let mut frames: Vec<Vec<f32>> = Vec::new();
        r.push(&input, |f| frames.push(f.to_vec()));
        assert_eq!(frames.len(), 2, "320 samples -> two 160-frames");
        assert_eq!(frames[0], (0..160).map(|i| i as f32).collect::<Vec<_>>());
        assert_eq!(frames[1], (160..320).map(|i| i as f32).collect::<Vec<_>>());
    }

    #[test]
    fn frames_accumulate_across_push_calls() {
        let mut r = FrameResampler::try_new(16_000, 16_000, frame_dur_for(160, 16_000)).unwrap();
        let mut frames: Vec<Vec<f32>> = Vec::new();
        r.push(&vec![1.0; 100], |f| frames.push(f.to_vec()));
        assert!(frames.is_empty(), "100 < 160, nothing emitted yet");
        r.push(&vec![1.0; 60], |f| frames.push(f.to_vec()));
        assert_eq!(frames.len(), 1, "100 + 60 = 160 -> one frame");
        assert_eq!(frames[0].len(), 160);
    }

    #[test]
    fn finish_zero_pads_the_trailing_partial_frame() {
        let mut r = FrameResampler::try_new(16_000, 16_000, frame_dur_for(160, 16_000)).unwrap();
        let mut frames: Vec<Vec<f32>> = Vec::new();
        r.push(&vec![0.7; 200], |f| frames.push(f.to_vec())); // 1 full frame + 40 pending
        assert_eq!(frames.len(), 1);
        r.finish(|f| frames.push(f.to_vec()));
        assert_eq!(frames.len(), 2, "finish flushes the padded partial");
        let last = &frames[1];
        assert_eq!(last.len(), 160);
        assert!(last[..40].iter().all(|&x| (x - 0.7).abs() < 1e-6));
        assert!(last[40..].iter().all(|&x| x == 0.0), "tail zero-padded");
    }

    #[test]
    fn rejects_zero_length_frame_duration() {
        assert!(FrameResampler::try_new(16_000, 16_000, Duration::from_nanos(1)).is_err());
    }

    #[test]
    fn finish_reports_final_frame_pad_at_identity_rate() {
        // 16 kHz identity, 160-sample frames, 250 real samples: one full frame (160) plus a
        // 90-sample pending tail. finish pads that tail to 160 -> 70 synthetic zeros, which
        // is exactly the count finish must report so the caller can truncate them.
        let mut r = FrameResampler::try_new(16_000, 16_000, frame_dur_for(160, 16_000)).unwrap();
        let mut emitted = 0usize;
        r.push(&vec![0.5; 250], |f| emitted += f.len());
        assert_eq!(emitted, 160, "one full frame emitted during push");
        let synthetic = r.finish(|f| emitted += f.len());
        assert_eq!(synthetic, 70, "160 - 90 = 70 zero-pad samples");
        assert_eq!(emitted, 320, "two full frames total after finish");
        assert_eq!(emitted - synthetic, 250, "real content == samples pushed");
    }

    #[test]
    fn finish_reports_zero_synthetic_on_frame_aligned_identity() {
        // 320 real samples == exactly two 160-frames: no partial frame, no pad.
        let mut r = FrameResampler::try_new(16_000, 16_000, frame_dur_for(160, 16_000)).unwrap();
        let mut emitted = 0usize;
        r.push(&vec![0.25; 320], |f| emitted += f.len());
        let synthetic = r.finish(|f| emitted += f.len());
        assert_eq!(synthetic, 0);
        assert_eq!(emitted, 320);
    }

    #[test]
    fn finish_synthetic_count_at_48k_input_leaves_at_least_expected_real_output() {
        // 48 kHz -> 16 kHz, exactly 1 s of input (48000 samples). Real output is
        // round(48000 * 16000 / 48000) = 16000; the emitted stream additionally carries the
        // resampler's `output_delay` leading transient (accounted for by `finish`). Stripping
        // the reported synthetic zero-pad must leave AT LEAST the 16000 real samples — never
        // fewer (which would mean a real word ending was truncated).
        let mut r = FrameResampler::try_new(48_000, 16_000, frame_dur_for(480, 16_000)).unwrap();
        let mut emitted = 0usize;
        r.push(&vec![0.3; 48_000], |f| emitted += f.len());
        let synthetic = r.finish(|f| emitted += f.len());
        assert_eq!(emitted % 480, 0, "only full 480-sample frames are emitted");
        assert!(
            emitted.saturating_sub(synthetic) >= 16_000,
            "stripping synthetic must keep >= the 16000 real samples (kept={}, emitted={emitted}, synthetic={synthetic})",
            emitted.saturating_sub(synthetic)
        );
    }

    #[test]
    fn finish_preserves_final_marker_tone_through_48k_downsample() {
        // Regression for the resampler output-delay tail loss: build 1 s of 48 kHz input whose
        // LAST 100 ms (4800 samples) is a loud marker and whose body is silent. After push +
        // finish and stripping the reported synthetic zero-pad (exactly what the recorder does
        // at Cmd::Stop), the marker MUST survive at the tail — proving the internal delay was
        // drained rather than left to swallow the final word.
        let mut r = FrameResampler::try_new(48_000, 16_000, frame_dur_for(480, 16_000)).unwrap();
        let marker_start_in = 48_000 - 4_800; // last 100 ms
        let input: Vec<f32> = (0..48_000)
            .map(|i| if i >= marker_start_in { 0.9 } else { 0.0 })
            .collect();
        let mut out: Vec<f32> = Vec::new();
        r.push(&input, |f| out.extend_from_slice(f));
        let synthetic = r.finish(|f| out.extend_from_slice(f));
        let keep = out.len().saturating_sub(synthetic);
        out.truncate(keep);

        // Marker is ~1600 samples @16 kHz (100 ms). The kept buffer may carry a short
        // leading-silence transient, so assert on the TAIL (final word survived) and a body
        // region (structure intact), not on exact length.
        assert!(
            out.len() >= 16_000,
            "kept buffer lost real content: len={}",
            out.len()
        );
        let tail = &out[out.len() - 1_500..]; // small guard vs. resampler edge ringing
        let tail_rms = (tail.iter().map(|&x| x * x).sum::<f32>() / tail.len() as f32).sqrt();
        assert!(
            tail_rms > 0.3,
            "final-word marker truncated by the resampler tail: tail_rms={tail_rms}"
        );
        let body = &out[2_000..8_000];
        let body_rms = (body.iter().map(|&x| x * x).sum::<f32>() / body.len() as f32).sqrt();
        assert!(
            body_rms < 0.1,
            "silent body region should stay silent: body_rms={body_rms}"
        );
    }

    #[test]
    fn finish_windows_per_flush_across_reused_recordings() {
        // The resampler is reused across recordings (idle audio flows through it between
        // finishes). Each finish must report ONLY its own window's pad, not a growing
        // cumulative total. Simulate: idle push, then a recording push, then finish — twice.
        let mut r = FrameResampler::try_new(16_000, 16_000, frame_dur_for(160, 16_000)).unwrap();

        // Recording 1: 250 real samples -> 70 pad (as in the identity test).
        r.push(&vec![0.5; 250], |_| {});
        assert_eq!(r.finish(|_| {}), 70);

        // Between recordings: idle audio flows through the same resampler.
        r.push(&vec![0.1; 320], |_| {}); // two whole frames, no partial

        // Recording 2: another 250 real samples. If accounting were cumulative, this would
        // report 140; windowed, it reports this flush's 70 pad only (idle 320 canceled out).
        r.push(&vec![0.5; 250], |_| {});
        assert_eq!(
            r.finish(|_| {}),
            70,
            "second flush reports its own pad, not the accumulated total"
        );
    }
}
