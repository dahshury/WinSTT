"""Audio Configuration Value Objects.

This module defines audio configuration value objects that represent
business concepts for audio system configuration.
"""

from dataclasses import dataclass

from src_refactored.domain.audio.value_objects.audio_format import AudioFormat
from src_refactored.domain.audio.value_objects.audio_quality import AudioQuality
from src_refactored.domain.audio.value_objects.channel_count import ChannelCount
from src_refactored.domain.audio.value_objects.sample_rate import SampleRate
from src_refactored.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class AudioConfiguration(ValueObject):
    """Audio configuration value object."""
    sample_rate: SampleRate
    channels: ChannelCount
    format: AudioFormat
    chunk_size: int
    buffer_size: int
    device_id: str | None = None
    input_device_id: str | None = None
    output_device_id: str | None = None

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.sample_rate,
            self.channels,
            self.format,
            self.chunk_size,
            self.buffer_size,
            self.device_id,
            self.input_device_id,
            self.output_device_id,
        )

    def __post_init__(self):
        if self.sample_rate not in [8000, 16000, 22050, 44100, 48000, 96000]:
            msg = "Unsupported sample rate"
            raise ValueError(msg)
        if self.channels not in [1, 2]:
            msg = "Only mono and stereo audio supported"
            raise ValueError(msg)
        if self.chunk_size <= 0 or self.chunk_size > 8192:
            msg = "Chunk size must be between 1 and 8192"
            raise ValueError(msg)


@dataclass(frozen=True)
class RecordingConfiguration(ValueObject):
    """Recording configuration value object."""
    audio_config: AudioConfiguration
    format: AudioFormat
    quality: AudioQuality
    file_path: str | None = None
    max_duration: float | None = None
    auto_stop: bool = True
    silence_threshold: float = 0.01
    silence_duration: float = 2.0

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.audio_config,
            self.format,
            self.quality,
            self.file_path,
            self.max_duration,
            self.auto_stop,
            self.silence_threshold,
            self.silence_duration,
        )

    def __post_init__(self):
        if self.sample_rate not in [8000, 16000, 22050, 44100, 48000, 96000]:
            msg = "Unsupported sample rate"
            raise ValueError(msg)
        if self.channels not in [1, 2]:
            msg = "Only mono and stereo audio supported"
            raise ValueError(msg)
        if self.bit_depth not in [8, 16, 24, 32]:
            msg = "Unsupported bit depth"
            raise ValueError(msg)
        if self.compression_level < 0 or self.compression_level > 9:
            msg = "Compression level must be between 0 and 9"
            raise ValueError(msg)
        if self.silence_threshold < 0 or self.silence_threshold > 1:
            msg = "Silence threshold must be between 0 and 1"
            raise ValueError(msg)
        if self.silence_duration < 0:
            msg = "Silence duration must be non-negative"
            raise ValueError(msg)
        if self.buffer_size <= 0:
            msg = "Buffer size must be positive"
            raise ValueError(msg)


@dataclass(frozen=True)
class PlaybackConfiguration(ValueObject):
    """Playback configuration value object."""
    audio_config: AudioConfiguration
    volume: float = 1.0
    speed: float = 1.0
    loop: bool = False
    auto_play: bool = True
    fade_in: float = 0.0
    fade_out: float = 0.0

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.audio_config,
            self.volume,
            self.speed,
            self.loop,
            self.auto_play,
            self.fade_in,
            self.fade_out,
        )

    def __post_init__(self):
        if self.sample_rate not in [8000, 16000, 22050, 44100, 48000, 96000]:
            msg = "Unsupported sample rate"
            raise ValueError(msg)
        if self.channels not in [1, 2]:
            msg = "Only mono and stereo audio supported"
            raise ValueError(msg)
        if self.bit_depth not in [8, 16, 24, 32]:
            msg = "Unsupported bit depth"
            raise ValueError(msg)
        if self.volume < 0 or self.volume > 1:
            msg = "Volume must be between 0 and 1"
            raise ValueError(msg)
        if self.speed < 0.1 or self.speed > 4.0:
            msg = "Speed must be between 0.1 and 4.0"
            raise ValueError(msg)
        if self.crossfade_duration < 0:
            msg = "Crossfade duration must be non-negative"
            raise ValueError(msg)
        if self.buffer_size <= 0:
            msg = "Buffer size must be positive"
            raise ValueError(msg)
        if self.prebuffer_size <= 0:
            msg = "Prebuffer size must be positive"
            raise ValueError(msg)


@dataclass(frozen=True)
class StreamConfiguration(ValueObject):
    """Stream configuration value object."""
    audio_config: AudioConfiguration
    stream_type: str
    buffer_size: int = 4096
    latency: float = 0.1
    auto_start: bool = True

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.audio_config,
            self.stream_type,
            self.buffer_size,
            self.latency,
            self.auto_start,
        )

    def __post_init__(self):
        if self.sample_rate not in [8000, 16000, 22050, 44100, 48000, 96000]:
            msg = "Unsupported sample rate"
            raise ValueError(msg)
        if self.channels not in [1, 2]:
            msg = "Only mono and stereo audio supported"
            raise ValueError(msg)
        if self.frames_per_buffer <= 0:
            msg = "Frames per buffer must be positive"
            raise ValueError(msg)
        if self.buffer_size <= 0:
            msg = "Buffer size must be positive"
            raise ValueError(msg)
        if self.latency < 0:
            msg = "Latency must be non-negative"
            raise ValueError(msg)
        if self.timeout < 0:
            msg = "Timeout must be non-negative"
            raise ValueError(msg)