"""Cross-utterance adaptive Silero VAD sensitivity.

The calibrator subscribes to recording lifecycle events on the EventBus,
collects per-chunk RMS samples during each recording, and on a successful
(non-empty) transcription derives a new target sensitivity from the
observed SNR, EMA-blends it with the current value, and applies it to the
live ``SileroVAD`` instance via injected getter/setter callbacks.

The per-device persistence half lives entirely on the renderer side: after
each adaptation the server publishes :class:`VADSensitivityAdapted`, the
renderer keys the new value by the currently-selected input-device name,
and on the next device switch the renderer sends back a ``set_parameter``
with the persisted value for the newly-selected device. The server stays
device-agnostic.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import TYPE_CHECKING

import numpy as np

from src.recorder.domain.events import (
    AudioChunkRecorded,
    RecorderEvent,
    RecordingStarted,
    RecordingStopped,
    TranscriptionCompleted,
    VADSensitivityAdapted,
)

if TYPE_CHECKING:
    from src.building_blocks.clock import Clock
    from src.building_blocks.event_bus import EventBus


class VADCalibrator:
    """Adaptive Silero sensitivity tracker.

    Subscribes to :class:`RecordingStarted`, :class:`AudioChunkRecorded`,
    :class:`RecordingStopped`, and :class:`TranscriptionCompleted`. Derives
    a target sensitivity from observed SNR and EMA-blends.
    """

    #: Hard bounds on adapted sensitivity. Below MIN, Silero rejects even
    #: clear speech; above MAX, it accepts almost any non-silence chunk.
    MIN_SENSITIVITY = 0.15
    MAX_SENSITIVITY = 0.7
    #: Blend factor for new observations into the running value. Lower =
    #: slower to react but more stable; higher = follows the room faster
    #: but jitters between recordings.
    EMA_ALPHA = 0.3
    #: SNR (dB) → target sensitivity mapping. Below LOW_SNR_DB → MIN
    #: sensitivity (noisy room, be strict). Above HIGH_SNR_DB → MAX
    #: sensitivity (quiet room, catch whispers). Linear in between.
    LOW_SNR_DB = 10.0
    HIGH_SNR_DB = 40.0
    #: Need at least this many frame-RMS samples in a recording before we
    #: trust the percentile estimates. ~0.5 s of audio at 32 ms frames.
    MIN_SAMPLES_FOR_ADAPT = 20
    #: Percentiles used to estimate ambient noise floor and speech peak
    #: from the per-frame RMS distribution within one recording.
    NOISE_FLOOR_PCT = 10
    SPEECH_PEAK_PCT = 90
    #: Skip publishing when the EMA-clamped value is essentially unchanged
    #: from the last applied value. Avoids a steady stream of identical
    #: events in stable environments.
    APPLY_EPSILON = 1e-4

    def __init__(
        self,
        *,
        event_bus: EventBus,
        clock: Clock,
        get_sensitivity: Callable[[], float],
        set_sensitivity: Callable[[float], None],
    ) -> None:
        self._event_bus = event_bus
        self._clock = clock
        self._get = get_sensitivity
        self._set = set_sensitivity
        self._rms_samples: list[float] = []
        self._collecting = False
        self._pending_stats: tuple[float, float] | None = None
        event_bus.subscribe(RecordingStarted, self._on_recording_started)
        event_bus.subscribe(AudioChunkRecorded, self._on_chunk)
        event_bus.subscribe(RecordingStopped, self._on_recording_stopped)
        event_bus.subscribe(TranscriptionCompleted, self._on_transcription_completed)

    def _on_recording_started(self, _event: RecorderEvent) -> None:
        self._rms_samples = []
        self._collecting = True
        self._pending_stats = None

    def _on_chunk(self, event: RecorderEvent) -> None:
        if not self._collecting:
            return
        chunk = event.chunk if isinstance(event, AudioChunkRecorded) else b""
        if not chunk:
            return
        samples = np.frombuffer(chunk, dtype=np.int16).astype(np.float32)
        rms = float(np.sqrt(np.mean(samples * samples)))
        self._rms_samples.append(rms)

    def _on_recording_stopped(self, _event: RecorderEvent) -> None:
        self._collecting = False
        if len(self._rms_samples) < self.MIN_SAMPLES_FOR_ADAPT:
            self._pending_stats = None
            return
        noise = float(np.percentile(self._rms_samples, self.NOISE_FLOOR_PCT))
        peak = float(np.percentile(self._rms_samples, self.SPEECH_PEAK_PCT))
        self._pending_stats = (noise, peak)

    def _on_transcription_completed(self, event: RecorderEvent) -> None:
        stats = self._pending_stats
        self._pending_stats = None
        if stats is None:
            return
        text = event.text if isinstance(event, TranscriptionCompleted) else ""
        if not text.strip():
            return
        noise, peak = stats
        target = self._target_from_snr(noise, peak)
        current = self._get()
        blended = self.EMA_ALPHA * target + (1.0 - self.EMA_ALPHA) * current
        clamped = max(self.MIN_SENSITIVITY, min(self.MAX_SENSITIVITY, blended))
        if abs(clamped - current) < self.APPLY_EPSILON:
            return
        self._set(clamped)
        self._event_bus.publish(
            VADSensitivityAdapted(
                timestamp=self._clock.get_current_time(),
                new_sensitivity=clamped,
                noise_floor_rms=noise,
                speech_peak_rms=peak,
            )
        )

    @classmethod
    def _target_from_snr(cls, noise: float, peak: float) -> float:
        """Map observed RMS noise/peak to a target Silero sensitivity.

        Low SNR (noisy room) maps to the strict end so Silero stops
        agreeing with WebRTC on noise-driven false triggers. High SNR
        (quiet room) maps to the permissive end so quieter speech still
        trips the gate.
        """
        if noise <= 0.0 or peak <= 0.0 or peak <= noise:
            return cls.MIN_SENSITIVITY
        snr_db = 20.0 * math.log10(peak / noise)
        if snr_db <= cls.LOW_SNR_DB:
            return cls.MIN_SENSITIVITY
        if snr_db >= cls.HIGH_SNR_DB:
            return cls.MAX_SENSITIVITY
        t = (snr_db - cls.LOW_SNR_DB) / (cls.HIGH_SNR_DB - cls.LOW_SNR_DB)
        return cls.MIN_SENSITIVITY + t * (cls.MAX_SENSITIVITY - cls.MIN_SENSITIVITY)
