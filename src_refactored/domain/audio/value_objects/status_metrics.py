"""Audio Status and Metrics Value Objects.

This module defines value objects for audio status tracking
and performance metrics in the domain.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum

from src_refactored.domain.common.domain_utils import DomainIdentityGenerator
from src_refactored.domain.common.value_object import ValueObject

from .audio_format import AudioFormat
from .duration import Duration
from .sample_rate import SampleRate


class ServiceStatus(Enum):
    """Audio service status."""
    IDLE = "idle"
    INITIALIZING = "initializing"
    READY = "ready"
    ACTIVE = "active"
    PAUSED = "paused"
    STOPPING = "stopping"
    ERROR = "error"
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class RecordingStatus(ValueObject):
    """Recording status information."""

    is_recording: bool
    current_duration: Duration
    file_size_bytes: int = 0
    frames_recorded: int = 0
    peak_level: float = 0.0
    average_level: float = 0.0
    sample_rate: SampleRate | None = None
    channels: int = 1
    audio_format: AudioFormat | None = None
    last_update: datetime = field(default_factory=lambda: datetime.fromtimestamp(DomainIdentityGenerator.generate_timestamp()))

    def _get_equality_components(self,
    ) -> tuple:
        return (
            self.is_recording,
            self.current_duration,
            self.file_size_bytes,
            self.frames_recorded,
            self.peak_level,
            self.average_level,
            self.sample_rate,
            self.channels,
            self.audio_format,
            self.last_update,
        )

    def __invariants__(self) -> None:
        if self.file_size_bytes < 0:
            msg = "File size cannot be negative"
            raise ValueError(msg)
        if self.frames_recorded < 0:
            msg = "Frames recorded cannot be negative"
            raise ValueError(msg)
        if self.peak_level < 0 or self.peak_level > 1.0:
            msg = "Peak level must be between 0 and 1"
            raise ValueError(msg)
        if self.average_level < 0 or self.average_level > 1.0:
            msg = "Average level must be between 0 and 1"
            raise ValueError(msg)
        if self.channels <= 0:
            msg = "Channels must be positive"
            raise ValueError(msg)

    @property
    def estimated_bitrate(self) -> int | None:
        """Estimate current bitrate in bits per second."""
        if not self.sample_rate or self.current_duration.total_seconds() <= 0:
            return None

        bits_per_sample = 16  # Default assumption
        if self.audio_format:
            # Map format to bit depth (simplified)
            bits_per_sample = self.audio_format.bit_depth

        return int(self.sample_rate.value * self.channels * bits_per_sample)

    @property
    def is_clipping(self) -> bool:
        """Check if audio is clipping (peak level too high)."""
        return self.peak_level >= 0.95

    @property
    def is_too_quiet(self) -> bool:
        """Check if audio level is too low."""
        return self.average_level < 0.01

    @property
    def signal_quality(self) -> str:
        """Get signal quality assessment."""
        if self.is_clipping:
            return "clipping"
        if self.is_too_quiet:
            return "too_quiet"
        if self.average_level > 0.1:
            return "good"
        return "low"


@dataclass(frozen=True)
class PlaybackStatus(ValueObject):
    """Playback status information."""

    is_playing: bool
    current_position: Duration
    total_duration: Duration
    volume_level: float = 1.0
    is_muted: bool = False
    playback_rate: float = 1.0
    frames_played: int = 0
    buffer_health: float = 100.0
    last_update: datetime = field(default_factory=lambda: datetime.fromtimestamp(DomainIdentityGenerator.generate_timestamp()))

    def _get_equality_components(self,
    ) -> tuple:
        return (
            self.is_playing,
            self.current_position,
            self.total_duration,
            self.volume_level,
            self.is_muted,
            self.playback_rate,
            self.frames_played,
            self.buffer_health,
            self.last_update,
        )

    def __invariants__(self) -> None:
        if self.volume_level < 0 or self.volume_level > 1.0:
            msg = "Volume level must be between 0 and 1"
            raise ValueError(msg)
        if self.playback_rate <= 0:
            msg = "Playback rate must be positive"
            raise ValueError(msg)
        if self.frames_played < 0:
            msg = "Frames played cannot be negative"
            raise ValueError(msg)
        if self.buffer_health < 0 or self.buffer_health > 100:
            msg = "Buffer health must be between 0 and 100"
            raise ValueError(msg)
        if self.current_position.total_seconds() > self.total_duration.total_seconds():
            msg = "Current position cannot exceed total duration"
            raise ValueError(msg)

    @property
    def progress_percent(self) -> float:
        """Get playback progress as percentage."""
        if self.total_duration.total_seconds() <= 0:
            return 0.0
        return (self.current_position.total_seconds() / self.total_duration.total_seconds()) * 100

    @property
    def remaining_duration(self) -> Duration:
        """Get remaining playback duration."""
        remaining_seconds = max(0, self.total_duration.total_seconds() - self.current_position.total_seconds())
        return Duration(seconds=remaining_seconds)

    @property
    def effective_volume(self) -> float:
        """Get effective volume (considering mute state)."""
        return 0.0 if self.is_muted else self.volume_level

    @property
    def is_buffer_healthy(self) -> bool:
        """Check if playback buffer is healthy."""
        return self.buffer_health >= 50.0

    @property
    def estimated_completion_time(self) -> datetime | None:
        """Estimate when playback will complete."""
        if not self.is_playing or self.playback_rate <= 0:
            return None
        # Use last_update as reference if available to avoid fetching current system time
        if self.last_update is None:
            return None
        remaining_seconds = self.remaining_duration.total_seconds() / self.playback_rate
        return self.last_update + timedelta(seconds=remaining_seconds)


@dataclass(frozen=True)
class RecordingMetrics(ValueObject):
    """Recording performance metrics."""

    total_duration: Duration
    total_frames: int = 0
    dropped_frames: int = 0
    peak_level: float = 0.0
    average_level: float = 0.0
    dynamic_range: float = 0.0
    signal_to_noise_ratio: float | None = None
    clipping_events: int = 0
    silence_periods: int = 0
    file_size_bytes: int = 0
    compression_ratio: float | None = None

    def _get_equality_components(self,
    ) -> tuple:
        return (
            self.total_duration,
            self.total_frames,
            self.dropped_frames,
            self.peak_level,
            self.average_level,
            self.dynamic_range,
            self.signal_to_noise_ratio,
            self.clipping_events,
            self.silence_periods,
            self.file_size_bytes,
            self.compression_ratio,
        )

    def __invariants__(self) -> None:
        if self.total_frames < 0:
            msg = "Total frames cannot be negative"
            raise ValueError(msg)
        if self.dropped_frames < 0:
            msg = "Dropped frames cannot be negative"
            raise ValueError(msg)
        if self.dropped_frames > self.total_frames:
            msg = "Dropped frames cannot exceed total frames"
            raise ValueError(msg)
        if self.peak_level < 0 or self.peak_level > 1.0:
            msg = "Peak level must be between 0 and 1"
            raise ValueError(msg)
        if self.average_level < 0 or self.average_level > 1.0:
            msg = "Average level must be between 0 and 1"
            raise ValueError(msg)
        if self.dynamic_range < 0:
            msg = "Dynamic range cannot be negative"
            raise ValueError(msg)
        if self.clipping_events < 0:
            msg = "Clipping events cannot be negative"
            raise ValueError(msg)
        if self.silence_periods < 0:
            msg = "Silence periods cannot be negative"
            raise ValueError(msg)
        if self.file_size_bytes < 0:
            msg = "File size cannot be negative"
            raise ValueError(msg)

    @property
    def drop_rate_percent(self) -> float:
        """Calculate frame drop rate percentage."""
        if self.total_frames == 0:
            return 0.0
        return (self.dropped_frames / self.total_frames) * 100

    @property
    def quality_score(self) -> float:
        """Calculate overall quality score (0-100,
    )."""
        score = 100.0

        # Penalize for dropped frames
        score -= self.drop_rate_percent * 2

        # Penalize for clipping
        if self.total_duration.total_seconds() > 0:
            clipping_rate = self.clipping_events / self.total_duration.total_seconds()
            score -= min(clipping_rate * 10, 30)

        # Penalize for low signal level
        if self.average_level < 0.1:
            score -= 20

        # Bonus for good SNR
        if self.signal_to_noise_ratio and self.signal_to_noise_ratio > 40:
            score += 10

        return max(0.0, min(100.0, score))

    @property
    def is_high_quality(self) -> bool:
        """Check if recording is considered high quality."""
        return (
            self.quality_score >= 80 and
            self.drop_rate_percent < 1.0 and
            self.clipping_events == 0 and
            self.average_level >= 0.1
        )


@dataclass(frozen=True)
class PlaybackMetrics(ValueObject):
    """Playback performance metrics."""

    total_duration: Duration
    frames_played: int = 0
    frames_skipped: int = 0
    buffer_underruns: int = 0
    average_latency_ms: float = 0.0
    peak_latency_ms: float = 0.0
    cpu_usage_percent: float = 0.0
    memory_usage_bytes: int = 0
    error_count: int = 0
    warning_count: int = 0

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.total_duration,
            self.frames_played,
            self.frames_skipped,
            self.buffer_underruns,
            self.average_latency_ms,
            self.peak_latency_ms,
            self.cpu_usage_percent,
            self.memory_usage_bytes,
            self.error_count,
            self.warning_count,
        )

    def __invariants__(self) -> None:
        if self.total_duration.total_seconds() <= 0:
            msg = "Total duration must be positive"
            raise ValueError(msg)
        if self.frames_played < 0:
            msg = "Frames played cannot be negative"
            raise ValueError(msg)
        if self.frames_skipped < 0:
            msg = "Frames skipped cannot be negative"
            raise ValueError(msg)
        if self.buffer_underruns < 0:
            msg = "Buffer underruns cannot be negative"
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
        if self.error_count < 0:
            msg = "Error count cannot be negative"
            raise ValueError(msg)
        if self.warning_count < 0:
            msg = "Warning count cannot be negative"
            raise ValueError(msg)

    @property
    def skip_rate_percent(self) -> float:
        """Calculate frame skip rate percentage."""
        total_frames = self.frames_played + self.frames_skipped
        if total_frames == 0:
            return 0.0
        return (self.frames_skipped / total_frames) * 100

    @property
    def performance_score(self) -> float:
        """Calculate overall performance score (0-100,
    )."""
        score = 100.0

        # Penalize for skipped frames
        score -= self.skip_rate_percent * 3

        # Penalize for buffer underruns
        if self.total_duration.total_seconds() > 0:
            underrun_rate = self.buffer_underruns / self.total_duration.total_seconds()
            score -= min(underrun_rate * 20, 40)

        # Penalize for high latency
        if self.average_latency_ms > 100:
            score -= min((self.average_latency_ms - 100) / 10, 30)

        # Penalize for high CPU usage
        if self.cpu_usage_percent > 80:
            score -= (self.cpu_usage_percent - 80) / 2

        return max(0.0, min(100.0, score))

    @property
    def is_smooth_playback(self) -> bool:
        """Check if playback is smooth."""
        return (
            self.skip_rate_percent < 0.1 and
            self.buffer_underruns == 0 and
            self.average_latency_ms < 50
        )

    @property
    def is_healthy(self) -> bool:
        """Check if the status is healthy."""
        return self.error_count == 0 and self.warning_count <= 2