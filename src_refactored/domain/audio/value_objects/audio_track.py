"""Audio Track Value Objects.

This module defines value objects for audio tracks and recordings
in the domain.
"""

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np

from src_refactored.domain.common.value_object import ValueObject

from .audio_format import AudioFormatType
from .duration import Duration


@dataclass(frozen=True)
class AudioTrack(ValueObject):
    """Audio track information."""

    track_id: str
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    duration: Duration | None = None
    sample_rate: int = 44100
    channels: int = 2
    bit_depth: int = 16
    audio_format: AudioFormatType = AudioFormatType.WAV
    file_path: Path | None = None
    file_size_bytes: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)

    def _get_equality_components(self) -> tuple:
        return (
            self.track_id,
            self.title,
            self.artist,
            self.album,
            self.duration,
            self.sample_rate,
            self.channels,
            self.bit_depth,
            self.audio_format,
            self.file_path,
            self.file_size_bytes,
            tuple(sorted(self.metadata.items())),
            tuple(sorted(self.tags)),
        )

    def __invariants__(self) -> None:
        if not self.track_id or not self.track_id.strip():
            msg = "Track ID cannot be empty"
            raise ValueError(msg)
        if self.sample_rate <= 0:
            msg = "Sample rate must be positive"
            raise ValueError(msg)
        if self.channels <= 0:
            msg = "Channels must be positive"
            raise ValueError(msg)
        if self.bit_depth <= 0:
            msg = "Bit depth must be positive"
            raise ValueError(msg)
        if self.file_size_bytes is not None and self.file_size_bytes < 0:
            msg = "File size cannot be negative"
            raise ValueError(msg)
        if self.duration and self.duration.total_seconds <= 0:
            msg = "Duration must be positive"
            raise ValueError(msg)

    @property
    def is_mono(self) -> bool:
        """Check if track is mono."""
        return self.channels == 1

    @property
    def is_stereo(self) -> bool:
        """Check if track is stereo."""
        return self.channels == 2

    @property
    def is_high_quality(self,
    ) -> bool:
        """Check if track is considered high quality."""
        return (
            self.sample_rate >= 44100 and
            self.bit_depth >= 16 and
            self.audio_format in [AudioFormatType.WAV, AudioFormatType.FLAC]
        )

    @property
    def estimated_bitrate(self) -> int:
        """Estimate bitrate in bits per second."""
        return self.sample_rate * self.channels * self.bit_depth

    @property
    def has_metadata(self) -> bool:
        """Check if track has metadata."""
        return bool(self.title or self.artist or self.album or self.metadata)

    def get_display_name(self) -> str:
        """Get display name for the track."""
        if self.title:
            if self.artist:
                return f"{self.artist} - {self.title}"
            return self.title
        if self.file_path:
            return self.file_path.stem
        return self.track_id

    def with_metadata(self, **metadata: Any,
    ) -> "AudioTrack":
        """Create a new track with additional metadata."""
        new_metadata = {**self.metadata, **metadata}
        return AudioTrack(
            track_id=self.track_id,
            title=self.title,
            artist=self.artist,
            album=self.album,
            duration=self.duration,
            sample_rate=self.sample_rate,
            channels=self.channels,
            bit_depth=self.bit_depth,
            audio_format=self.audio_format,
            file_path=self.file_path,
            file_size_bytes=self.file_size_bytes,
            metadata=new_metadata,
            tags=self.tags,
        )

    def with_tags(self, *tags: str,
    ) -> "AudioTrack":
        """Create a new track with additional tags."""
        new_tags = list(set(self.tags + list(tags)))
        return AudioTrack(
            track_id=self.track_id,
            title=self.title,
            artist=self.artist,
            album=self.album,
            duration=self.duration,
            sample_rate=self.sample_rate,
            channels=self.channels,
            bit_depth=self.bit_depth,
            audio_format=self.audio_format,
            file_path=self.file_path,
            file_size_bytes=self.file_size_bytes,
            metadata=self.metadata,
            tags=new_tags,
        )


@dataclass(frozen=True)
class RecordingMetadata(ValueObject):
    """Metadata for audio recordings."""

    recording_id: str
    start_time: datetime
    end_time: datetime | None = None
    duration: Duration | None = None
    sample_rate: int = 44100
    channels: int = 1
    bit_depth: int = 16
    audio_format: AudioFormatType = AudioFormatType.WAV
    file_size_bytes: int | None = None
    file_path: Path | None = None
    device_name: str | None = None
    quality_metrics: dict[str, float] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    notes: str | None = None

    def _get_equality_components(self) -> tuple:
        return (
            self.recording_id,
            self.start_time,
            self.end_time,
            self.duration,
            self.sample_rate,
            self.channels,
            self.bit_depth,
            self.audio_format,
            self.file_size_bytes,
            self.file_path,
            self.device_name,
            tuple(sorted(self.quality_metrics.items())),
            tuple(sorted(self.tags)),
            self.notes,
        )

    def __invariants__(self) -> None:
        if not self.recording_id or not self.recording_id.strip():
            msg = "Recording ID cannot be empty"
            raise ValueError(msg)
        if self.sample_rate <= 0:
            msg = "Sample rate must be positive"
            raise ValueError(msg)
        if self.channels <= 0:
            msg = "Channels must be positive"
            raise ValueError(msg)
        if self.bit_depth <= 0:
            msg = "Bit depth must be positive"
            raise ValueError(msg)
        if self.file_size_bytes is not None and self.file_size_bytes < 0:
            msg = "File size cannot be negative"
            raise ValueError(msg)
        if self.end_time and self.end_time < self.start_time:
            msg = "End time cannot be before start time"
            raise ValueError(msg)
        if self.duration and self.duration.total_seconds <= 0:
            msg = "Duration must be positive"
            raise ValueError(msg)

    @property
    def is_completed(self) -> bool:
        """Check if recording is completed."""
        return self.end_time is not None

    @property
    def calculated_duration(self) -> Duration | None:
        """Calculate duration from start and end times."""
        if not self.end_time:
            return None

        delta = self.end_time - self.start_time
        return Duration(seconds=delta.total_seconds())

    @property
    def is_mono(self) -> bool:
        """Check if recording is mono."""
        return self.channels == 1

    @property
    def is_stereo(self) -> bool:
        """Check if recording is stereo."""
        return self.channels == 2

    @property
    def estimated_bitrate(self) -> int:
        """Estimate bitrate in bits per second."""
        return self.sample_rate * self.channels * self.bit_depth

    @property
    def has_quality_metrics(self) -> bool:
        """Check if recording has quality metrics."""
        return bool(self.quality_metrics)

    def get_quality_score(self) -> float | None:
        """Get overall quality score if available."""
        return self.quality_metrics.get("overall_score")

    def get_signal_to_noise_ratio(self) -> float | None:
        """Get signal-to-noise ratio if available."""
        return self.quality_metrics.get("snr")

    def to_audio_track(self,
    ) -> AudioTrack:
        """Convert recording metadata to audio track."""
        return AudioTrack(
            track_id=self.recording_id,
            title=f"Recording {self.recording_id}",
            duration=self.duration or self.calculated_duration,
            sample_rate=self.sample_rate,
            channels=self.channels,
            bit_depth=self.bit_depth,
            audio_format=self.audio_format,
            file_path=self.file_path,
            file_size_bytes=self.file_size_bytes,
            metadata={
                "recording_start": self.start_time.isoformat(),
                "recording_end": self.end_time.isoformat() if self.end_time else None,
                "device_name": self.device_name,
                "notes": self.notes,
                **self.quality_metrics,
            },
            tags=["recording", *self.tags],
        )


@dataclass(frozen=True)
class RecordingData(ValueObject):
    """Audio recording data chunk."""

    data: np.ndarray
    metadata: RecordingMetadata
    timestamp: datetime
    chunk_id: int
    is_final: bool = False
    rms_level: float | None = None
    peak_level: float | None = None
    silence_detected: bool = False

    def _get_equality_components(self) -> tuple:
        return (
            self.data.tobytes() if self.data is not None else None,
            self.metadata,
            self.timestamp,
            self.chunk_id,
            self.is_final,
            self.rms_level,
            self.peak_level,
            self.silence_detected,
        )

    def __invariants__(self) -> None:
        if self.data is None:
            msg = "Recording data cannot be None"
            raise ValueError(msg)
        if self.chunk_id < 0:
            msg = "Chunk ID cannot be negative"
            raise ValueError(msg)
        if self.rms_level is not None and (self.rms_level < 0 or self.rms_level > 1.0):
            msg = "RMS level must be between 0 and 1"
            raise ValueError(msg)
        if self.peak_level is not None and (self.peak_level < 0 or self.peak_level > 1.0):
            msg = "Peak level must be between 0 and 1"
            raise ValueError(msg)

    @property
    def frame_count(self) -> int:
        """Get number of audio frames in this chunk."""
        if len(self.data.shape) == 1:
            return len(self.data) // self.metadata.channels
        return self.data.shape[0]

    @property
    def duration_seconds(self) -> float:
        """Calculate duration of this chunk in seconds."""
        return self.frame_count / self.metadata.sample_rate

    @property
    def size_bytes(self) -> int:
        """Get size of data in bytes."""
        return self.data.nbytes

    @property
    def is_clipping(self) -> bool:
        """Check if this chunk has clipping."""
        return self.peak_level is not None and self.peak_level >= 0.95

    @property
    def is_quiet(self) -> bool:
        """Check if this chunk is quiet."""
        return self.rms_level is not None and self.rms_level < 0.01

    @property
    def signal_quality(self,
    ) -> str:
        """Get signal quality assessment for this chunk."""
        if self.silence_detected:
            return "silence"
        if self.is_clipping:
            return "clipping"
        if self.is_quiet:
            return "quiet"
        if self.rms_level and self.rms_level > 0.1:
            return "good"
        return "low"