"""Audio Configuration Value Objects.

This module defines audio configuration value objects that represent
business concepts for audio system configuration.
"""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from src_refactored.domain.common.value_object import ValueObject

from .audio_format import AudioFormatType
from .playback_mode import PlaybackMode, VolumeMode
from .recording_state import RecordingMode, RecordingQuality


@dataclass(frozen=True)
class AudioConfiguration(ValueObject):
    """Base audio configuration value object."""

    sample_rate: int = 44100
    channels: int = 1
    format: AudioFormatType = AudioFormatType.WAV
    chunk_size: int = 1024
    device_index: int | None = None
    latency: float | None = None

    def _get_equality_components(self,
    ) -> tuple:
        return (
            self.sample_rate,
            self.channels,
            self.format,
            self.chunk_size,
            self.device_index,
            self.latency,
        )

    def __invariants__(self) -> None:
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
    """Configuration for audio recording operations."""

    device_id: int | None = None
    sample_rate: int = 44100
    channels: int = 1
    bit_depth: int = 16
    format: AudioFormatType = AudioFormatType.WAV
    quality: RecordingQuality = RecordingQuality.MEDIUM
    mode: RecordingMode = RecordingMode.MANUAL
    max_duration: float | None = None  # seconds
    auto_save: bool = False
    output_directory: Path | None = None
    filename_template: str = "recording_{timestamp}"
    enable_compression: bool = False
    compression_level: int = 5  # 0-9 for applicable formats
    enable_noise_reduction: bool = False
    enable_auto_gain: bool = False
    silence_threshold: float = 0.01
    silence_duration: float = 2.0  # seconds of silence to stop voice activation
    buffer_size: int = 4096

    def _get_equality_components(self,
    ) -> tuple:
        return (
            self.device_id,
            self.sample_rate,
            self.channels,
            self.bit_depth,
            self.format,
            self.quality,
            self.mode,
            self.max_duration,
            self.auto_save,
            self.output_directory,
            self.filename_template,
            self.enable_compression,
            self.compression_level,
            self.enable_noise_reduction,
            self.enable_auto_gain,
            self.silence_threshold,
            self.silence_duration,
            self.buffer_size,
        )

    def __invariants__(self) -> None:
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
    """Configuration for audio playback operations."""

    device_id: int | None = None
    sample_rate: int = 44100
    channels: int = 2
    bit_depth: int = 16
    format: AudioFormatType = AudioFormatType.WAV
    mode: PlaybackMode = PlaybackMode.NORMAL
    volume: float = 1.0  # 0.0 to 1.0
    speed: float = 1.0   # 0.5 to 2.0
    volume_mode: VolumeMode = VolumeMode.MEDIUM
    enable_crossfade: bool = False
    crossfade_duration: float = 0.5  # seconds
    enable_equalizer: bool = False
    equalizer_bands: list[float] | None = None
    enable_effects: bool = False
    effects_chain: list[str] | None = None
    buffer_size: int = 4096
    prebuffer_size: int = 8192
    enable_gapless: bool = False

    def _get_equality_components(self,
    ) -> tuple:
        return (
            self.device_id,
            self.sample_rate,
            self.channels,
            self.bit_depth,
            self.format,
            self.mode,
            self.volume,
            self.speed,
            self.volume_mode,
            self.enable_crossfade,
            self.crossfade_duration,
            self.enable_equalizer,
            tuple(self.equalizer_bands) if self.equalizer_bands else None,
            self.enable_effects,
            tuple(self.effects_chain) if self.effects_chain else None,
            self.buffer_size,
            self.prebuffer_size,
            self.enable_gapless,
        )

    def __invariants__(self) -> None:
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
    """Configuration for audio streaming operations."""

    input_device_id: int | None = None
    output_device_id: int | None = None
    sample_rate: int = 44100
    channels: int = 1
    format: AudioFormatType = AudioFormatType.WAV
    frames_per_buffer: int = 1024
    buffer_size: int = 8192
    enable_echo_cancellation: bool = False
    enable_noise_suppression: bool = False
    enable_auto_gain: bool = False
    latency: float = 0.1  # seconds
    non_blocking: bool = False
    timeout: float = 1.0
    callback: Callable[[bytes, int], None] | None = None
    error_callback: Callable[[str], None] | None = None
    audio_config: AudioConfiguration | None = None

    def _get_equality_components(self,
    ) -> tuple:
        return (
            self.input_device_id,
            self.output_device_id,
            self.sample_rate,
            self.channels,
            self.format,
            self.frames_per_buffer,
            self.buffer_size,
            self.enable_echo_cancellation,
            self.enable_noise_suppression,
            self.enable_auto_gain,
            self.latency,
            self.non_blocking,
            self.timeout,
            self.callback,
            self.error_callback,
            self.audio_config,
        )

    def __invariants__(self) -> None:
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