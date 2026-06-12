use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use std::time::Duration;

// Make this a constant you can tweak
const RESAMPLER_CHUNK_SIZE: usize = 1024;

pub struct FrameResampler {
    resampler: Option<Fft<f32>>,
    chunk_in: usize,
    in_buf: Vec<f32>,
    frame_samples: usize,
    pending: Vec<f32>,
}

impl FrameResampler {
    pub fn new(in_hz: usize, out_hz: usize, frame_dur: Duration) -> Self {
        let frame_samples = ((out_hz as f64 * frame_dur.as_secs_f64()).round()) as usize;
        assert!(frame_samples > 0, "frame duration too short");

        // Use fixed chunk size instead of GCD-based
        let chunk_in = RESAMPLER_CHUNK_SIZE;

        let resampler = (in_hz != out_hz).then(|| {
            Fft::<f32>::new(in_hz, out_hz, chunk_in, 1, 1, FixedSync::Input)
                .expect("Failed to create resampler")
        });

        Self {
            resampler,
            chunk_in,
            in_buf: Vec::with_capacity(chunk_in),
            frame_samples,
            pending: Vec::with_capacity(frame_samples),
        }
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
                if let Ok(input) = InterleavedSlice::new(&self.in_buf, 1, self.in_buf.len()) {
                    if let Ok(out) = self.resampler.as_mut().unwrap().process(&input, 0, None) {
                        // let duration = start.elapsed();
                        // log::debug!("Resampler took: {:?}", duration);
                        let out_data = out.take_data();
                        self.emit_frames(&out_data, &mut emit);
                    }
                }
                self.in_buf.clear();
            }
        }
    }

    pub fn finish(&mut self, mut emit: impl FnMut(&[f32])) {
        // Process any remaining input samples
        let out_data = if let Some(ref mut resampler) = self.resampler {
            if !self.in_buf.is_empty() {
                // Pad with zeros to reach chunk size
                self.in_buf.resize(self.chunk_in, 0.0);
                if let Ok(input) = InterleavedSlice::new(&self.in_buf, 1, self.in_buf.len()) {
                    if let Ok(out) = resampler.process(&input, 0, None) {
                        Some(out.take_data())
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        if let Some(out_data) = out_data {
            self.emit_frames(&out_data, &mut emit);
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
        let mut r = FrameResampler::new(16_000, 16_000, frame_dur_for(160, 16_000));
        let input: Vec<f32> = (0..320).map(|i| i as f32).collect();
        let mut frames: Vec<Vec<f32>> = Vec::new();
        r.push(&input, |f| frames.push(f.to_vec()));
        assert_eq!(frames.len(), 2, "320 samples -> two 160-frames");
        assert_eq!(frames[0], (0..160).map(|i| i as f32).collect::<Vec<_>>());
        assert_eq!(frames[1], (160..320).map(|i| i as f32).collect::<Vec<_>>());
    }

    #[test]
    fn frames_accumulate_across_push_calls() {
        let mut r = FrameResampler::new(16_000, 16_000, frame_dur_for(160, 16_000));
        let mut frames: Vec<Vec<f32>> = Vec::new();
        r.push(&vec![1.0; 100], |f| frames.push(f.to_vec()));
        assert!(frames.is_empty(), "100 < 160, nothing emitted yet");
        r.push(&vec![1.0; 60], |f| frames.push(f.to_vec()));
        assert_eq!(frames.len(), 1, "100 + 60 = 160 -> one frame");
        assert_eq!(frames[0].len(), 160);
    }

    #[test]
    fn finish_zero_pads_the_trailing_partial_frame() {
        let mut r = FrameResampler::new(16_000, 16_000, frame_dur_for(160, 16_000));
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
    #[should_panic(expected = "frame duration too short")]
    fn rejects_zero_length_frame_duration() {
        let _ = FrameResampler::new(16_000, 16_000, Duration::from_nanos(1));
    }
}
