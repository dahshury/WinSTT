use super::{SpeechLabel, VadFrame, VoiceActivityDetector};
use anyhow::Result;
use std::collections::VecDeque;

/// Outcome of one smoothing state transition, WITHOUT borrowing the detector — lets
/// `push_frame` and `push_frame_labeled` share the exact same state machine and then
/// each build their own return shape (the borrowing `VadFrame` vs. the owned
/// `SpeechLabel`) from it.
enum SmoothedDecision {
    /// Onset frame: `push_frame` emits prefill + current as one Speech payload;
    /// `push_frame_labeled` reports `retro_frames` pre-roll entries to flip.
    Onset { retro_frames: usize },
    /// Ongoing/hangover speech: emit just the current frame.
    Speech,
    /// Non-speech.
    Noise,
}

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
            frame_buffer: VecDeque::with_capacity(prefill_frames + 1),
            hangover_counter: 0,
            onset_counter: 0,
            in_speech: false,
            temp_out: Vec::new(),
        }
    }

    fn push_prefill_frame(&mut self, frame: &[f32]) {
        let max_frames = self.prefill_frames + 1;
        if self.frame_buffer.len() == max_frames
            && let Some(mut recycled) = self.frame_buffer.pop_front()
        {
            recycled.clear();
            recycled.extend_from_slice(frame);
            self.frame_buffer.push_back(recycled);
            return;
        }

        self.frame_buffer.push_back(frame.to_vec());
    }

    /// Advance the smoothing state machine by one frame and report the transition
    /// WITHOUT borrowing `self` — the single source of truth both `push_frame` and
    /// `push_frame_labeled` build on so the two APIs can never drift. Buffers the frame
    /// for pre-roll and delegates the voiced/unvoiced decision to the inner VAD (whose
    /// error is propagated, preserving `push_frame`'s failure behavior).
    fn advance(&mut self, frame: &[f32]) -> Result<SmoothedDecision> {
        // 1. Buffer every incoming frame for possible pre-roll
        self.push_prefill_frame(frame);

        // 2. Delegate to the wrapped boolean VAD
        let is_voice = self.inner_vad.is_voice(frame)?;

        Ok(match (self.in_speech, is_voice) {
            // Potential start of speech - need to accumulate onset frames
            (false, true) => {
                self.onset_counter += 1;
                if self.onset_counter >= self.onset_frames {
                    // We have enough consecutive voice frames to trigger speech
                    self.in_speech = true;
                    self.hangover_counter = self.hangover_frames;
                    self.onset_counter = 0; // Reset for next time

                    // Pre-roll = every buffered frame EXCEPT the current one (which gets
                    // its own entry). This equals the count `push_frame` prepends minus the
                    // triggering frame, so the labeled mask flips exactly the same samples
                    // the old gating path prepended.
                    let retro_frames = self.frame_buffer.len().saturating_sub(1);
                    SmoothedDecision::Onset { retro_frames }
                } else {
                    // Not enough frames yet, still silence
                    SmoothedDecision::Noise
                }
            }

            // Ongoing Speech
            (true, true) => {
                self.hangover_counter = self.hangover_frames;
                SmoothedDecision::Speech
            }

            // End of Speech or interruption during onset phase
            (true, false) => {
                if self.hangover_counter > 0 {
                    self.hangover_counter -= 1;
                    SmoothedDecision::Speech
                } else {
                    self.in_speech = false;
                    SmoothedDecision::Noise
                }
            }

            // Silence or broken onset sequence
            (false, false) => {
                self.onset_counter = 0; // Reset onset counter on silence
                SmoothedDecision::Noise
            }
        })
    }
}

impl VoiceActivityDetector for SmoothedVad {
    fn push_frame<'a>(&'a mut self, frame: &'a [f32]) -> Result<VadFrame<'a>> {
        match self.advance(frame)? {
            SmoothedDecision::Onset { .. } => {
                // Collect prefill + current frame
                self.temp_out.clear();
                for buf in &self.frame_buffer {
                    self.temp_out.extend_from_slice(buf);
                }
                Ok(VadFrame::Speech(&self.temp_out))
            }
            SmoothedDecision::Speech => Ok(VadFrame::Speech(frame)),
            SmoothedDecision::Noise => Ok(VadFrame::Noise),
        }
    }

    fn push_frame_labeled(&mut self, frame: &[f32]) -> Result<SpeechLabel> {
        Ok(match self.advance(frame)? {
            SmoothedDecision::Onset { retro_frames } => SpeechLabel {
                is_speech: true,
                retro_frames,
            },
            SmoothedDecision::Speech => SpeechLabel {
                is_speech: true,
                retro_frames: 0,
            },
            SmoothedDecision::Noise => SpeechLabel {
                is_speech: false,
                retro_frames: 0,
            },
        })
    }

    fn reset(&mut self) {
        self.inner_vad.reset();
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
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

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

    struct ResetTrackingVad(Arc<AtomicBool>);

    impl VoiceActivityDetector for ResetTrackingVad {
        fn push_frame<'a>(&'a mut self, _frame: &'a [f32]) -> Result<VadFrame<'a>> {
            Ok(VadFrame::Noise)
        }

        fn reset(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn reset_propagates_to_the_inner_detector() {
        let reset = Arc::new(AtomicBool::new(false));
        let mut vad = SmoothedVad::new(Box::new(ResetTrackingVad(Arc::clone(&reset))), 1, 1, 1);

        vad.reset();

        assert!(reset.load(Ordering::SeqCst));
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

    #[test]
    fn labeled_onset_reports_preroll_count_then_zero() {
        // prefill=2, onset=1: two idle frames buffered, so the onset frame reports 2
        // retro frames (the two pre-roll entries the mask must flip to speech).
        let mut vad = smoothed([false, false, true, true, false], 2, 1, 1);
        assert_eq!(
            vad.push_frame_labeled(&F).unwrap(),
            SpeechLabel {
                is_speech: false,
                retro_frames: 0
            }
        );
        assert_eq!(
            vad.push_frame_labeled(&F).unwrap(),
            SpeechLabel {
                is_speech: false,
                retro_frames: 0
            }
        );
        assert_eq!(
            vad.push_frame_labeled(&F).unwrap(),
            SpeechLabel {
                is_speech: true,
                retro_frames: 2
            },
            "onset carries the two buffered pre-roll frames"
        );
        assert_eq!(
            vad.push_frame_labeled(&F).unwrap(),
            SpeechLabel {
                is_speech: true,
                retro_frames: 0
            },
            "ongoing speech has no further pre-roll"
        );
    }

    #[test]
    fn labeled_preroll_capped_by_prefill_and_saturates_when_empty() {
        // prefill=0: the onset frame is the only buffered frame, so retro_frames is 0
        // (nothing preceding to flip) even though onset triggers immediately.
        let mut vad = smoothed([true], 0, 1, 1);
        assert_eq!(
            vad.push_frame_labeled(&F).unwrap(),
            SpeechLabel {
                is_speech: true,
                retro_frames: 0
            }
        );
    }

    #[test]
    fn mask_tail_carries_hangover_when_stopped_right_after_last_word() {
        // Regression for PTT-release-after-final-word: the capture mask must NOT end in an
        // abrupt `false` when the user releases while the smoother is still in hangover. Model
        // a real release: several voiced frames (onset reached), then the last inner-VAD frame
        // scores non-speech (a fading word ending Silero often mislabels) at the instant of
        // release. With hangover=15, that trailing frame is still labeled speech, so the mask
        // tail stays `true` and downstream compaction/pad keep the full ending.
        let hangover = 15;
        let mut vad = smoothed(
            [true, true, true, false], // onset=3 reached, then release scores non-speech
            0,
            hangover,
            3,
        );
        assert!(
            !vad.push_frame_labeled(&F).unwrap().is_speech,
            "onset frame 1"
        );
        assert!(
            !vad.push_frame_labeled(&F).unwrap().is_speech,
            "onset frame 2"
        );
        assert!(
            vad.push_frame_labeled(&F).unwrap().is_speech,
            "onset reached"
        );
        // The final frame at release, though the inner VAD called it non-speech, is held speech
        // by the hangover — the mask tail the recorder hands downstream ends `true`.
        assert!(
            vad.push_frame_labeled(&F).unwrap().is_speech,
            "release-instant frame kept speech by hangover -> mask tail is not abruptly false"
        );
    }

    #[test]
    fn labeled_matches_push_frame_speech_verdict() {
        // The labeled API must advance the SAME state machine as push_frame: run both
        // over identical scripts and confirm the is_speech verdict agrees frame-by-frame.
        let script = [false, true, true, true, false, false, false, true];
        let mut a = smoothed(script, 3, 2, 2);
        let mut b = smoothed(script, 3, 2, 2);
        for _ in 0..script.len() {
            let via_push = a.push_frame(&F).unwrap().is_speech();
            let via_label = b.push_frame_labeled(&F).unwrap().is_speech;
            assert_eq!(via_push, via_label);
        }
    }
}
