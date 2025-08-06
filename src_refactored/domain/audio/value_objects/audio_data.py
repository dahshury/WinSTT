"""Audio Data Value Objects.

This module defines value objects for representing audio data
and related concepts in the domain.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Any

import numpy as np

from src_refactored.domain.common.value_object import ValueObject

from .audio_format import AudioFormat
from .sample_rate import SampleRate


class StreamState(Enum):
    """Audio stream states."""
    IDLE = "idle"
    STARTING = "starting"
    RUNNING = "running"
    PAUSED = "paused"
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"


@dataclass(frozen=True)
class AudioData(ValueObject):
    """Audio data value object."""

    data: np.ndarray
    sample_rate: SampleRate
    channels: int
    audio_format: AudioFormat
    timestamp: datetime | None = None
    duration: timedelta | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple:
        return (
            self.data.tobytes() if self.data is not None else None,
            self.sample_rate,
            self.channels,
            self.audio_format,
            self.timestamp,
            self.duration,
            tuple(sorted(self.metadata.items())),
        )

    def __invariants__(self) -> None:
        if self.data is None:
            msg = "Audio data cannot be None"
            raise ValueError(msg)
        if self.channels <= 0:
            msg = "Channels must be positive"
            raise ValueError(msg)
        if len(self.data.shape,
    ) not in [1, 2]:
            msg = "Audio data must be 1D or 2D array"
            raise ValueError(msg)
        if len(self.data.shape) == 2 and self.data.shape[1] != self.channels:
            msg = "Audio data channels mismatch"
            raise ValueError(msg)
        if self.duration and self.duration.total_seconds() <= 0:
            msg = "Duration must be positive"
            raise ValueError(msg)

    @property
    def frame_count(self) -> int:
        """Get number of audio frames."""
        if len(self.data.shape) == 1:
            return len(self.data) // self.channels
        return self.data.shape[0]

    @property
    def calculated_duration(self) -> timedelta:
        """Calculate duration from frame count and sample rate."""
        seconds = self.frame_count / self.sample_rate.value
        return timedelta(seconds=seconds)

    @property
    def size_bytes(self) -> int:
        """Get size in bytes."""
        return self.data.nbytes

    @property
    def is_mono(self) -> bool:
        """Check if audio is mono."""
        return self.channels == 1

    @property
    def is_stereo(self,
    ) -> bool:
        """Check if audio is stereo."""
        return self.channels == 2

    def get_channel_data(self, channel: int,
    ) -> np.ndarray:
        """Get data for specific channel."""
        if channel >= self.channels:
            msg = f"Channel {channel} not available (max: {self.channels - 1})"
            raise ValueError(msg)

        if self.is_mono:
            return self.data

        if len(self.data.shape,
    ) == 1:
            # Interleaved format
            return self.data[channel::self.channels]
        # Non-interleaved format
        return self.data[:, channel]

    def to_mono(self) -> "AudioData":
        """Convert to mono by averaging channels."""
        if self.is_mono:
            return self

        if len(self.data.shape) == 1:
            # Interleaved format
            mono_data = np.mean([
                self.data[i::self.channels] for i in range(self.channels)
            ], axis=0)
        else:
            # Non-interleaved format
            mono_data = np.mean(self.data, axis=1)

        return AudioData(
            data=mono_data,
            sample_rate=self.sample_rate,
            channels=1,
            audio_format=self.audio_format,
            timestamp=self.timestamp,
            duration=self.duration,
            metadata=self.metadata,
        )


@dataclass(frozen=True)
class AudioBuffer(ValueObject):
    """Audio buffer value object for streaming."""

    buffer_id: str
    data: list[AudioData]
    max_size: int
    current_size: int = 0
    is_full: bool = False
    created_at: datetime = field(default_factory=datetime.now)

    def _get_equality_components(self,
    ) -> tuple:
        return (
            self.buffer_id,
            tuple(self.data),
            self.max_size,
            self.current_size,
            self.is_full,
            self.created_at,
        )

    def __invariants__(self) -> None:
        if not self.buffer_id:
            msg = "Buffer ID cannot be empty"
            raise ValueError(msg)
        if self.max_size <= 0:
            msg = "Max size must be positive"
            raise ValueError(msg)
        if self.current_size < 0:
            msg = "Current size cannot be negative"
            raise ValueError(msg)
        if self.current_size > self.max_size:
            msg = "Current size cannot exceed max size"
            raise ValueError(msg)
        if len(self.data) != self.current_size:
            msg = "Data length must match current size"
            raise ValueError(msg)

    @property
    def available_space(self) -> int:
        """Get available space in buffer."""
        return self.max_size - self.current_size

    @property
    def utilization_percent(self) -> float:
        """Get buffer utilization percentage."""
        return (self.current_size / self.max_size) * 100

    @property
    def total_duration(self) -> timedelta:
        """Get total duration of all audio data in buffer."""
        total_seconds = sum(
            audio.calculated_duration.total_seconds() for audio in self.data
        )
        return timedelta(seconds=total_seconds)


@dataclass(frozen=True)
class StreamMetrics(ValueObject):
    """Stream performance metrics."""

    frames_processed: int = 0
    frames_dropped: int = 0
    buffer_underruns: int = 0
    buffer_overruns: int = 0
    average_latency_ms: float = 0.0
    peak_latency_ms: float = 0.0
    cpu_usage_percent: float = 0.0
    memory_usage_bytes: int = 0
    start_time: datetime | None = None
    last_update: datetime | None = None

    def _get_equality_components(self,
    ) -> tuple:
        return (
            self.frames_processed,
            self.frames_dropped,
            self.buffer_underruns,
            self.buffer_overruns,
            self.average_latency_ms,
            self.peak_latency_ms,
            self.cpu_usage_percent,
            self.memory_usage_bytes,
            self.start_time,
            self.last_update,
        )

    def __invariants__(self) -> None:
        if self.frames_processed < 0:
            msg = "Frames processed cannot be negative"
            raise ValueError(msg)
        if self.frames_dropped < 0:
            msg = "Frames dropped cannot be negative"
            raise ValueError(msg)
        if self.buffer_underruns < 0:
            msg = "Buffer underruns cannot be negative"
            raise ValueError(msg)
        if self.buffer_overruns < 0:
            msg = "Buffer overruns cannot be negative"
            raise ValueError(msg)
        if self.average_latency_ms < 0:
            msg = "Average latency cannot be negative"
            raise ValueError(msg)
        if self.peak_latency_ms < 0:
            msg = "Peak latency cannot be negative"
            raise ValueError(msg)
        if self.cpu_usage_percent < 0 or self.cpu_usage_percent > 100:
            msg = "CPU usage must be between 0 and 100"
            raise ValueError(msg)
        if self.memory_usage_bytes < 0:
            msg = "Memory usage cannot be negative"
            raise ValueError(msg)

    @property
    def drop_rate_percent(self) -> float:
        """Calculate frame drop rate percentage."""
        if self.frames_processed == 0:
            return 0.0
        return (self.frames_dropped / (self.frames_processed + self.frames_dropped)) * 100

    @property
    def uptime(self) -> timedelta | None:
        """Get stream uptime."""
        if not self.start_time:
            return None
        end_time = self.last_update or datetime.now()
        return end_time - self.start_time

    @property
    def is_healthy(self) -> bool:
        """Check if stream metrics indicate healthy operation."""
        return (
            self.drop_rate_percent < 1.0 and  # Less than 1% drop rate
            self.average_latency_ms < 100.0 and  # Less than 100ms latency
            self.cpu_usage_percent < 80.0  # Less than 80% CPU usage
        )