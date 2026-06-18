use rubato::{FftFixedIn, Resampler};
use std::time::Duration;

// Make this a constant you can tweak
const RESAMPLER_CHUNK_SIZE: usize = 1024;

pub struct FrameResampler {
    resampler: Option<FftFixedIn<f32>>,
    chunk_in: usize,
    in_buf: Vec<f32>,
    frame_samples: usize,
    pending: Vec<f32>,
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
                FftFixedIn::<f32>::new(in_hz, out_hz, chunk_in, 1, 1)
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
        })
    }

    pub fn push(&mut self, mut src: &[f32], mut emit: impl FnMut(&[f32])) {
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
                // let start = std::time::Instant::now();
                if let Some(resampler) = self.resampler.as_mut() {
                    if let Ok(out) = resampler.process(&[&self.in_buf[..]], None) {
                        // let duration = start.elapsed();
                        // log::debug!("Resampler took: {:?}", duration);
                        self.emit_frames(&out[0], &mut emit);
                    }
                }
                self.in_buf.clear();
            }
        }
    }

    pub fn finish(&mut self, mut emit: impl FnMut(&[f32])) {
        // Process any remaining input samples
        if let Some(ref mut resampler) = self.resampler {
            if !self.in_buf.is_empty() {
                // Pad with zeros to reach chunk size
                self.in_buf.resize(self.chunk_in, 0.0);
                if let Ok(out) = resampler.process(&[&self.in_buf[..]], None) {
                    self.emit_frames(&out[0], &mut emit);
                }
            }
        }

        // Emit any remaining pending frame (padded with zeros)
        if !self.pending.is_empty() {
            self.pending.resize(self.frame_samples, 0.0);
            emit(&self.pending);
            self.pending.clear();
        }
    }

    fn emit_frames(&mut self, mut data: &[f32], emit: &mut impl FnMut(&[f32])) {
        while !data.is_empty() {
            let space = self.frame_samples - self.pending.len();
            let take = space.min(data.len());
            self.pending.extend_from_slice(&data[..take]);
            data = &data[take..];

            if self.pending.len() == self.frame_samples {
                emit(&self.pending);
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
}
