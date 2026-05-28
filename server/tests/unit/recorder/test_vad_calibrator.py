from __future__ import annotations

import struct

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.recorder.application.vad_calibrator import VADCalibrator
from src.recorder.domain.events import (
    AudioChunkRecorded,
    RecordingStarted,
    RecordingStopped,
    TranscriptionCompleted,
    VADSensitivityAdapted,
)


def _chunk_at_amplitude(amp: int, samples: int = 512) -> bytes:
    """Build a constant-amplitude int16 PCM chunk (RMS == |amp|)."""
    return struct.pack(f"<{samples}h", *([amp] * samples))


class _Harness:
    """Wires a calibrator to an in-memory sensitivity slot + event recorder."""

    def __init__(self, *, initial: float = 0.4) -> None:
        self.bus = EventBus()
        self.clock = Clock.fixed_clock(12345.0)
        self.sensitivity = initial
        self.applied: list[float] = []
        self.events: list[VADSensitivityAdapted] = []
        self.bus.subscribe(VADSensitivityAdapted, lambda e: self.events.append(e))
        self.calibrator = VADCalibrator(
            event_bus=self.bus,
            clock=self.clock,
            get_sensitivity=lambda: self.sensitivity,
            set_sensitivity=self._apply,
        )

    def _apply(self, v: float) -> None:
        self.sensitivity = v
        self.applied.append(v)

    def run_recording(
        self,
        chunks: list[bytes],
        *,
        text: str = "hello world",
    ) -> None:
        self.bus.publish(RecordingStarted(timestamp=self.clock.get_current_time()))
        for c in chunks:
            self.bus.publish(AudioChunkRecorded(timestamp=self.clock.get_current_time(), chunk=c))
        self.bus.publish(RecordingStopped(timestamp=self.clock.get_current_time()))
        self.bus.publish(TranscriptionCompleted(timestamp=self.clock.get_current_time(), text=text))


class TestChunkBytesHelper:
    def test_returns_chunk_for_audio_chunk_event(self) -> None:
        # Matching event type → returns the carried PCM bytes (line 100).
        payload = _chunk_at_amplitude(1234, samples=8)
        event = AudioChunkRecorded(timestamp=12345.0, chunk=payload)
        assert VADCalibrator._chunk_bytes(event) == payload

    def test_returns_empty_for_non_chunk_event(self) -> None:
        # Non-AudioChunkRecorded event → defensive fall-through (line 101).
        event = RecordingStarted(timestamp=12345.0)
        assert VADCalibrator._chunk_bytes(event) == b""


class TestTranscribedTextHelper:
    def test_returns_text_for_transcription_event(self) -> None:
        # Matching event type → returns the carried text (line 125).
        event = TranscriptionCompleted(timestamp=12345.0, text="hello world")
        assert VADCalibrator._transcribed_text(event) == "hello world"

    def test_returns_empty_for_non_transcription_event(self) -> None:
        # Non-TranscriptionCompleted event → defensive fall-through (line 126).
        event = RecordingStopped(timestamp=12345.0)
        assert VADCalibrator._transcribed_text(event) == ""


class TestTargetFromSNR:
    def test_returns_min_for_invalid_inputs(self) -> None:
        f = VADCalibrator._target_from_snr
        assert f(0.0, 100.0) == VADCalibrator.MIN_SENSITIVITY
        assert f(50.0, 0.0) == VADCalibrator.MIN_SENSITIVITY
        # peak <= noise → no real SNR
        assert f(100.0, 100.0) == VADCalibrator.MIN_SENSITIVITY
        assert f(100.0, 50.0) == VADCalibrator.MIN_SENSITIVITY

    def test_low_snr_pins_to_min(self) -> None:
        # ratio == 10^0.5 ≈ 3.16 → SNR ≈ 10 dB, exactly the lower bound
        target = VADCalibrator._target_from_snr(100.0, 316.0)
        assert target == VADCalibrator.MIN_SENSITIVITY

    def test_high_snr_pins_to_max(self) -> None:
        # ratio == 100 → SNR == 40 dB, the upper bound
        target = VADCalibrator._target_from_snr(100.0, 10_000.0)
        assert target == VADCalibrator.MAX_SENSITIVITY

    def test_above_high_snr_still_max(self) -> None:
        target = VADCalibrator._target_from_snr(100.0, 100_000.0)
        assert target == VADCalibrator.MAX_SENSITIVITY

    def test_midpoint_snr_lands_midway(self) -> None:
        # 25 dB → halfway between 10 and 40 → midway between MIN and MAX
        ratio = 10 ** (25.0 / 20.0)
        target = VADCalibrator._target_from_snr(100.0, 100.0 * ratio)
        midpoint = (VADCalibrator.MIN_SENSITIVITY + VADCalibrator.MAX_SENSITIVITY) / 2.0
        assert abs(target - midpoint) < 1e-6


class TestCalibratorAdaptation:
    def test_adapts_on_non_empty_transcription(self) -> None:
        # 10 silent + 20 loud frames lets the 10th/90th percentiles land
        # cleanly in the silent/loud regions respectively (no interpolation
        # across the boundary): noise=100, peak=10_000 → SNR == 40 dB → MAX.
        h = _Harness(initial=0.4)
        chunks = [_chunk_at_amplitude(100)] * 10 + [_chunk_at_amplitude(10_000)] * 20
        h.run_recording(chunks)
        # Target 0.7, EMA from 0.4 → 0.3 * 0.7 + 0.7 * 0.4 = 0.49
        assert len(h.applied) == 1
        assert abs(h.applied[0] - 0.49) < 1e-6
        assert len(h.events) == 1
        assert h.events[0].new_sensitivity == h.applied[0]
        assert h.events[0].timestamp == 12345.0

    def test_noisy_environment_lowers_sensitivity(self) -> None:
        # Very low SNR — noise floor close to peak (≈1.94 dB → < LOW_SNR_DB)
        h = _Harness(initial=0.6)
        chunks = [_chunk_at_amplitude(800)] * 10 + [_chunk_at_amplitude(1000)] * 20
        h.run_recording(chunks)
        # Target MIN (0.15); EMA from 0.6 → 0.3 * 0.15 + 0.7 * 0.6 = 0.465
        assert len(h.applied) == 1
        assert abs(h.applied[0] - 0.465) < 1e-6

    def test_no_adapt_on_empty_text(self) -> None:
        h = _Harness()
        chunks = [_chunk_at_amplitude(100)] * 10 + [_chunk_at_amplitude(10_000)] * 20
        h.run_recording(chunks, text="")
        assert h.applied == []
        assert h.events == []

    def test_no_adapt_on_whitespace_only_text(self) -> None:
        h = _Harness()
        chunks = [_chunk_at_amplitude(100)] * 10 + [_chunk_at_amplitude(10_000)] * 20
        h.run_recording(chunks, text="   \n  ")
        assert h.applied == []
        assert h.events == []

    def test_no_adapt_when_too_few_samples(self) -> None:
        h = _Harness()
        # Below MIN_SAMPLES_FOR_ADAPT (20)
        chunks = [_chunk_at_amplitude(10_000)] * 5
        h.run_recording(chunks)
        assert h.applied == []
        assert h.events == []

    def test_clamps_to_max(self) -> None:
        # Start near MAX; high-SNR push should clamp at MAX_SENSITIVITY
        h = _Harness(initial=VADCalibrator.MAX_SENSITIVITY)
        chunks = [_chunk_at_amplitude(100)] * 10 + [_chunk_at_amplitude(10_000)] * 20
        h.run_recording(chunks)
        # target is MAX; EMA blend stays at MAX — equal to current,
        # so APPLY_EPSILON gate fires and nothing changes.
        assert h.applied == []
        assert h.events == []

    def test_clamps_to_min(self) -> None:
        h = _Harness(initial=VADCalibrator.MIN_SENSITIVITY)
        chunks = [_chunk_at_amplitude(800)] * 10 + [_chunk_at_amplitude(1000)] * 20
        h.run_recording(chunks)
        # target MIN, current MIN → no change.
        assert h.applied == []
        assert h.events == []

    def test_zero_amplitude_chunks_ignored(self) -> None:
        # Empty bytes-per-chunk → skipped without affecting collection
        h = _Harness()
        good = [_chunk_at_amplitude(100)] * 10 + [_chunk_at_amplitude(10_000)] * 20
        # Slip in some empty chunks
        chunks = good[:15] + [b""] * 5 + good[15:]
        h.run_recording(chunks)
        # Adaptation should still fire — the 30 real chunks pass the
        # MIN_SAMPLES gate; empties were no-ops.
        assert len(h.applied) == 1

    def test_chunks_outside_recording_window_ignored(self) -> None:
        # Chunks published while NOT collecting are dropped on the floor.
        h = _Harness()
        # Send 30 high-amplitude chunks before recording — should NOT count
        for _ in range(30):
            h.bus.publish(
                AudioChunkRecorded(timestamp=12345.0, chunk=_chunk_at_amplitude(10_000)),
            )
        # Now do a too-short recording — should not have stats from the
        # pre-recording chunks
        h.bus.publish(RecordingStarted(timestamp=12345.0))
        for _ in range(5):
            h.bus.publish(AudioChunkRecorded(timestamp=12345.0, chunk=_chunk_at_amplitude(10_000)))
        h.bus.publish(RecordingStopped(timestamp=12345.0))
        h.bus.publish(TranscriptionCompleted(timestamp=12345.0, text="hi"))
        assert h.applied == []
        # And the stash from after the recording stopped is also ignored
        for _ in range(30):
            h.bus.publish(
                AudioChunkRecorded(timestamp=12345.0, chunk=_chunk_at_amplitude(10_000)),
            )
        h.bus.publish(TranscriptionCompleted(timestamp=12345.0, text="hi"))
        assert h.applied == []

    def test_stats_cleared_between_recordings(self) -> None:
        # First (too-short) recording produces no stats. Second is too short
        # too — and should not reuse the first's samples.
        h = _Harness()
        for _ in range(2):
            h.bus.publish(RecordingStarted(timestamp=12345.0))
            for _ in range(15):  # 15 < MIN_SAMPLES_FOR_ADAPT
                h.bus.publish(AudioChunkRecorded(timestamp=12345.0, chunk=_chunk_at_amplitude(10_000)))
            h.bus.publish(RecordingStopped(timestamp=12345.0))
            h.bus.publish(TranscriptionCompleted(timestamp=12345.0, text="ok"))
        assert h.applied == []

    def test_event_payload_carries_observed_stats(self) -> None:
        h = _Harness()
        chunks = [_chunk_at_amplitude(500)] * 10 + [_chunk_at_amplitude(5_000)] * 20
        h.run_recording(chunks)
        assert len(h.events) == 1
        ev = h.events[0]
        # 10th percentile sits in the low-amplitude region, 90th in the high
        assert ev.noise_floor_rms < ev.speech_peak_rms
        assert ev.noise_floor_rms == 500.0
        assert ev.speech_peak_rms == 5000.0

    def test_constant_amplitude_recording_produces_no_snr(self) -> None:
        # All chunks identical → noise floor == speech peak → no SNR signal
        # → target == MIN. From default 0.4 → 0.3*0.15 + 0.7*0.4 = 0.325.
        h = _Harness(initial=0.4)
        chunks = [_chunk_at_amplitude(5_000)] * 30
        h.run_recording(chunks)
        assert len(h.applied) == 1
        assert abs(h.applied[0] - 0.325) < 1e-6
