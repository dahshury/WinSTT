// DRAFT PORT — not yet compiled. Source: server/src/recorder/infrastructure/composite_vad.py
//
// CompositeVAD: synchronous AND-gate of WebRTC + Silero, with a WebRTC
// short-circuit. This is a PARITY port — the locked decision is "VAD = lean on
// Handy" (its `SileroVad` + `SmoothedVad`), so this module is OPTIONAL in the
// shipped pipeline. It exists so the WinSTT composite semantics can be dropped
// in 1:1 if Handy's SmoothedVad proves too permissive (Handy uses Silero only;
// WinSTT requires BOTH WebRTC and Silero to agree, which is materially stricter
// on fan/keyboard transients).
//
// Divergence note carried from WinSTT's CLAUDE.md §12: the RealtimeSTT monolith
// ran Silero ASYNC in a background thread; WinSTT (and this port) run a
// SYNCHRONOUS AND. Keep it synchronous.
//
// AND-gate semantics (verbatim from composite_vad.py):
//   1. run WebRTC first.
//   2. if WebRTC says NOT speech -> return {is_speech:false, confidence:webrtc.confidence}
//      WITHOUT running Silero (short-circuit; Silero inference is the expensive leg).
//   3. else is_speech = webrtc.is_speech && silero.is_speech
//           confidence = min(webrtc.confidence, silero.confidence)
//
// `reset()` resets both legs.
//
// This module is intentionally trait-based and decoupled from any concrete ORT
// session so it is unit-testable with fakes (see tests below). The Silero leg
// MUST be CPU-pinned when instantiated for real (memory:
// project_silero_vad_cpu_pin_invariant) — that is the concrete adapter's
// responsibility, not this combinator's.

/// One VAD decision for a chunk. Mirrors WinSTT's `VADResult`
/// (`{is_speech: bool, confidence: f32}`). NOTE this is the *WinSTT-shaped*
/// result; Handy's `VoiceActivityDetector` trait uses a frame-pass-through enum
/// instead — adapt at the boundary if both are wired (see 04_*.md §wiring).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VadResult {
    pub is_speech: bool,
    pub confidence: f32,
}

impl VadResult {
    pub fn speech(confidence: f32) -> Self {
        Self {
            is_speech: true,
            confidence,
        }
    }
    pub fn silence(confidence: f32) -> Self {
        Self {
            is_speech: false,
            confidence,
        }
    }
}

/// A per-chunk boolean+confidence VAD (the WinSTT `IVoiceActivityDetector`
/// shape). `detect` takes int16 PCM bytes (or samples — implementor's choice);
/// the combinator only forwards the slice unchanged so both legs see identical
/// input.
pub trait ChunkVad {
    fn detect(&mut self, chunk: &[i16]) -> VadResult;
    fn reset(&mut self);
}

/// AND-gate of a WebRTC leg and a Silero leg with WebRTC short-circuit.
pub struct CompositeVad<W: ChunkVad, S: ChunkVad> {
    webrtc: W,
    silero: S,
}

impl<W: ChunkVad, S: ChunkVad> CompositeVad<W, S> {
    pub fn new(webrtc: W, silero: S) -> Self {
        Self { webrtc, silero }
    }

    /// Run the AND-gate. WebRTC short-circuits: if it says no-speech, Silero is
    /// never invoked and its confidence is irrelevant.
    pub fn detect(&mut self, chunk: &[i16]) -> VadResult {
        let webrtc = self.webrtc.detect(chunk);
        if !webrtc.is_speech {
            return VadResult::silence(webrtc.confidence);
        }
        let silero = self.silero.detect(chunk);
        let is_speech = webrtc.is_speech && silero.is_speech;
        let confidence = webrtc.confidence.min(silero.confidence);
        VadResult {
            is_speech,
            confidence,
        }
    }

    pub fn reset(&mut self) {
        self.webrtc.reset();
        self.silero.reset();
    }
}

impl<W: ChunkVad, S: ChunkVad> ChunkVad for CompositeVad<W, S> {
    fn detect(&mut self, chunk: &[i16]) -> VadResult {
        CompositeVad::detect(self, chunk)
    }
    fn reset(&mut self) {
        CompositeVad::reset(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted fake VAD: returns the next queued result and records how many
    /// times `detect` was called (to prove the short-circuit).
    struct FakeVad {
        results: Vec<VadResult>,
        idx: usize,
        calls: usize,
        resets: usize,
    }
    impl FakeVad {
        fn new(results: Vec<VadResult>) -> Self {
            Self {
                results,
                idx: 0,
                calls: 0,
                resets: 0,
            }
        }
        fn always(r: VadResult) -> Self {
            Self::new(vec![r; 8])
        }
    }
    impl ChunkVad for FakeVad {
        fn detect(&mut self, _chunk: &[i16]) -> VadResult {
            self.calls += 1;
            let r = self.results[self.idx.min(self.results.len() - 1)];
            self.idx += 1;
            r
        }
        fn reset(&mut self) {
            self.resets += 1;
        }
    }

    #[test]
    fn webrtc_silence_short_circuits_silero() {
        let webrtc = FakeVad::always(VadResult::silence(0.0));
        let silero = FakeVad::always(VadResult::speech(0.99));
        let mut comp = CompositeVad::new(webrtc, silero);
        let r = comp.detect(&[0, 0, 0]);
        assert!(!r.is_speech);
        // confidence comes from WebRTC alone on the short-circuit path.
        assert_eq!(r.confidence, 0.0);
        // Silero must NOT have been called.
        assert_eq!(comp.silero.calls, 0);
        assert_eq!(comp.webrtc.calls, 1);
    }

    #[test]
    fn both_speech_is_speech_with_min_confidence() {
        let webrtc = FakeVad::always(VadResult::speech(0.8));
        let silero = FakeVad::always(VadResult::speech(0.6));
        let mut comp = CompositeVad::new(webrtc, silero);
        let r = comp.detect(&[1, 2, 3]);
        assert!(r.is_speech);
        // min(0.8, 0.6) = 0.6.
        assert_eq!(r.confidence, 0.6);
        assert_eq!(comp.silero.calls, 1);
    }

    #[test]
    fn webrtc_speech_silero_silence_gates_to_silence() {
        let webrtc = FakeVad::always(VadResult::speech(0.9));
        let silero = FakeVad::always(VadResult::silence(0.1));
        let mut comp = CompositeVad::new(webrtc, silero);
        let r = comp.detect(&[1, 2, 3]);
        assert!(!r.is_speech);
        // min(0.9, 0.1) = 0.1 — Silero WAS consulted (WebRTC said speech).
        assert_eq!(r.confidence, 0.1);
        assert_eq!(comp.silero.calls, 1);
    }

    #[test]
    fn reset_propagates_to_both_legs() {
        let webrtc = FakeVad::always(VadResult::speech(0.5));
        let silero = FakeVad::always(VadResult::speech(0.5));
        let mut comp = CompositeVad::new(webrtc, silero);
        comp.reset();
        assert_eq!(comp.webrtc.resets, 1);
        assert_eq!(comp.silero.resets, 1);
    }

    #[test]
    fn confidence_min_is_symmetric() {
        // Whichever leg is lower wins the min, regardless of order.
        let webrtc = FakeVad::always(VadResult::speech(0.2));
        let silero = FakeVad::always(VadResult::speech(0.95));
        let mut comp = CompositeVad::new(webrtc, silero);
        assert_eq!(comp.detect(&[1]).confidence, 0.2);
    }
}
