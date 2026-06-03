use super::{VadFrame, VoiceActivityDetector};
use anyhow::Result;
use std::collections::VecDeque;

pub struct SmoothedVad {
    inner_vad: Box<dyn VoiceActivityDetector>,
    prefill_frames: usize,
    hangover_frames: usize,
    onset_frames: usize,

    frame_buffer: VecDeque<Vec<f32>>,
    hangover_counter: usize,
    onset_counter: usize,
    in_speech: bool,

    temp_out: Vec<f32>,
}

impl SmoothedVad {
    pub fn new(
        inner_vad: Box<dyn VoiceActivityDetector>,
        prefill_frames: usize,
        hangover_frames: usize,
        onset_frames: usize,
    ) -> Self {
        Self {
            inner_vad,
            prefill_frames,
            hangover_frames,
            onset_frames,
            frame_buffer: VecDeque::new(),
            hangover_counter: 0,
            onset_counter: 0,
            in_speech: false,
            temp_out: Vec::new(),
        }
    }
}

impl VoiceActivityDetector for SmoothedVad {
    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
        // 1. Buffer every incoming frame for possible pre-roll
        self.frame_buffer.push_back(frame.to_vec());
        while self.frame_buffer.len() > self.prefill_frames + 1 {
            self.frame_buffer.pop_front();
        }

        // 2. Delegate to the wrapped boolean VAD
        let is_voice = self.inner_vad.is_voice(frame)?;

        match (self.in_speech, is_voice) {
            // Potential start of speech - need to accumulate onset frames
            (false, true) => {
                self.onset_counter += 1;
                if self.onset_counter >= self.onset_frames {
                    // We have enough consecutive voice frames to trigger speech
                    self.in_speech = true;
                    self.hangover_counter = self.hangover_frames;
                    self.onset_counter = 0; // Reset for next time

                    // Collect prefill + current frame
                    self.temp_out.clear();
                    for buf in &self.frame_buffer {
                        self.temp_out.extend(buf);
                    }
                    Ok(VadFrame::Speech(&self.temp_out))
                } else {
                    // Not enough frames yet, still silence
                    Ok(VadFrame::Noise)
                }
            }

            // Ongoing Speech
            (true, true) => {
                self.hangover_counter = self.hangover_frames;
                Ok(VadFrame::Speech(frame))
            }

            // End of Speech or interruption during onset phase
            (true, false) => {
                if self.hangover_counter > 0 {
                    self.hangover_counter -= 1;
                    Ok(VadFrame::Speech(frame))
                } else {
                    self.in_speech = false;
                    Ok(VadFrame::Noise)
                }
            }

            // Silence or broken onset sequence
            (false, false) => {
                self.onset_counter = 0; // Reset onset counter on silence
                Ok(VadFrame::Noise)
            }
        }
    }

    fn reset(&mut self) {
        self.frame_buffer.clear();
        self.hangover_counter = 0;
        self.onset_counter = 0;
        self.in_speech = false;
        self.temp_out.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// A VAD whose voiced/unvoiced decision follows a fixed script — lets us drive
    /// the SmoothedVad state machine deterministically. Only `push_frame` is needed;
    /// SmoothedVad calls `is_voice`, whose trait default delegates here.
    struct ScriptedVad {
        script: VecDeque<bool>,
    }
    impl ScriptedVad {
        fn new(seq: impl IntoIterator<Item = bool>) -> Self {
            Self {
                script: seq.into_iter().collect(),
            }
        }
    }
    impl VoiceActivityDetector for ScriptedVad {
        fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
            let voiced = self.script.pop_front().unwrap_or(false);
            Ok(if voiced {
                VadFrame::Speech(frame)
            } else {
                VadFrame::Noise
            })
        }
    }

    fn smoothed(
        seq: impl IntoIterator<Item = bool>,
        prefill: usize,
        hangover: usize,
        onset: usize,
    ) -> SmoothedVad {
        SmoothedVad::new(Box::new(ScriptedVad::new(seq)), prefill, hangover, onset)
    }

    const F: [f32; 2] = [0.5, 0.5];

    #[test]
    fn onset_requires_consecutive_voiced_frames() {
        let mut vad = smoothed([true, true, true], 0, 2, 3);
        assert!(!vad.push_frame(&F).unwrap().is_speech(), "1st is onset");
        assert!(!vad.push_frame(&F).unwrap().is_speech(), "2nd is onset");
        assert!(
            vad.push_frame(&F).unwrap().is_speech(),
            "3rd triggers speech"
        );
    }

    #[test]
    fn onset_counter_resets_on_silence() {
        let mut vad = smoothed([true, true, false, true, true, true], 0, 2, 3);
        assert!(!vad.push_frame(&F).unwrap().is_speech());
        assert!(!vad.push_frame(&F).unwrap().is_speech());
        assert!(
            !vad.push_frame(&F).unwrap().is_speech(),
            "silence resets onset"
        );
        assert!(!vad.push_frame(&F).unwrap().is_speech());
        assert!(!vad.push_frame(&F).unwrap().is_speech());
        assert!(
            vad.push_frame(&F).unwrap().is_speech(),
            "needs 3 fresh consecutive voiced frames"
        );
    }

    #[test]
    fn hangover_keeps_speech_open_then_closes() {
        let mut vad = smoothed([true, true, true, false, false, false], 0, 2, 3);
        let _ = vad.push_frame(&F).unwrap();
        let _ = vad.push_frame(&F).unwrap();
        assert!(vad.push_frame(&F).unwrap().is_speech(), "onset reached");
        assert!(
            vad.push_frame(&F).unwrap().is_speech(),
            "1st silence: hangover"
        );
        assert!(
            vad.push_frame(&F).unwrap().is_speech(),
            "2nd silence: hangover"
        );
        assert!(
            !vad.push_frame(&F).unwrap().is_speech(),
            "hangover exhausted -> noise"
        );
    }

    #[test]
    fn reset_clears_in_speech_state() {
        let mut vad = smoothed([true, true, true, true], 0, 2, 3);
        let _ = vad.push_frame(&F).unwrap();
        let _ = vad.push_frame(&F).unwrap();
        assert!(vad.push_frame(&F).unwrap().is_speech());
        vad.reset();
        assert!(
            !vad.push_frame(&F).unwrap().is_speech(),
            "after reset, one voiced frame is onset again"
        );
    }

    #[test]
    fn speech_trigger_emits_prefill_preroll() {
        // prefill=2, onset=1: the two buffered frames are prepended to the
        // triggering frame, so the first Speech payload carries all three.
        let mut vad = smoothed([false, false, true], 2, 1, 1);
        let a = [1.0f32, 1.0];
        let b = [2.0f32, 2.0];
        let c = [3.0f32, 3.0];
        assert!(!vad.push_frame(&a).unwrap().is_speech());
        assert!(!vad.push_frame(&b).unwrap().is_speech());
        match vad.push_frame(&c).unwrap() {
            VadFrame::Speech(out) => assert_eq!(out, &[1.0, 1.0, 2.0, 2.0, 3.0, 3.0]),
            VadFrame::Noise => panic!("expected speech with pre-roll"),
        }
    }
}
