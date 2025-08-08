"""Audio configuration value object for settings domain."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from src_refactored.domain.common import ValueObject

if TYPE_CHECKING:
    from .file_path import AudioFilePath


@dataclass(frozen=True)
class AudioConfiguration(ValueObject):
    """Value object for audio configuration settings."""

    sample_rate: int
    channels: int
    bit_depth: int
    buffer_size: int
    enable_noise_reduction: bool = True
    recording_sound_enabled: bool = False
    recording_sound_path: AudioFilePath | None = None
    auto_gain_control: bool = False
    echo_cancellation: bool = False
    noise_suppression: bool = False
    voice_activity_detection: bool = False

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.sample_rate,
            self.channels,
            self.bit_depth,
            self.buffer_size,
            self.enable_noise_reduction,
            self.recording_sound_enabled,
            self.recording_sound_path,
        )

    def __post_init__(self,
    ):
        """Validate audio configuration after initialization."""
        # Validate sample rate
        valid_sample_rates = {8000, 16000, 22050, 44100, 48000, 96000}
        if self.sample_rate not in valid_sample_rates:
            msg = f"Invalid sample rate: {self.sample_rate}. Must be one of {valid_sample_rates}"
            raise ValueError(msg,
    )

        # Validate channels
        if self.channels not in {1, 2}:
            msg = f"Invalid channel count: {self.channels}. Must be 1 (mono) or 2 (stereo)"
            raise ValueError(msg)

        # Validate bit depth
        valid_bit_depths = {8, 16, 24, 32}
        if self.bit_depth not in valid_bit_depths:
            msg = f"Invalid bit depth: {self.bit_depth}. Must be one of {valid_bit_depths}"
            raise ValueError(msg)

        # Validate buffer size
        if self.buffer_size <= 0 or (self.buffer_size & (self.buffer_size - 1),
    ) != 0:
            msg = f"Buffer size must be a positive power of 2, got: {self.buffer_size}"
            raise ValueError(msg)

        # Validate recording sound configuration
        if self.recording_sound_enabled and self.recording_sound_path is None:
            msg = "Recording sound path must be provided when recording sound is enabled"
            raise ValueError(msg)

        # File existence/access checks must be performed via application services
        # using FileSystemPort, not within the domain value object.

    @classmethod
    def create_default(cls,
    ) -> AudioConfiguration:
        """Create default audio configuration."""
        return cls(
            sample_rate=16000,
            channels=1,
            bit_depth=16,
            buffer_size=1024,
            enable_noise_reduction=True,
            recording_sound_enabled=False,
            recording_sound_path=None,
        )

    @classmethod
    def create_high_quality(cls) -> AudioConfiguration:
        """Create high-quality audio configuration."""
        return cls(
            sample_rate=48000,
            channels=2,
            bit_depth=24,
            buffer_size=2048,
            enable_noise_reduction=True,
            recording_sound_enabled=False,
            recording_sound_path=None,
        )

    def is_high_quality(self) -> bool:
        """Check if this is a high-quality configuration."""
        return (
            self.sample_rate >= 44100 and
            self.bit_depth >= 16 and
            self.channels >= 1
        )

    def is_optimized_for_speech(self) -> bool:
        """Check if this configuration is optimized for speech recognition."""
        return (
            self.sample_rate == 16000 and
            self.channels == 1 and
            self.bit_depth == 16
        )

    def get_bytes_per_second(self) -> int:
        """Calculate bytes per second for this configuration."""
        return self.sample_rate * self.channels * (self.bit_depth // 8)

    def get_buffer_duration_ms(self) -> float:
        """Get buffer duration in milliseconds."""
        samples_per_second = self.sample_rate * self.channels
        return (self.buffer_size / samples_per_second) * 1000

    def with_recording_sound(
    self,
    enabled: bool,
    sound_path: AudioFilePath | None = None) -> AudioConfiguration:
        """Create a new configuration with different recording sound settings."""
        return AudioConfiguration(
            sample_rate=self.sample_rate,
            channels=self.channels,
            bit_depth=self.bit_depth,
            buffer_size=self.buffer_size,
            enable_noise_reduction=self.enable_noise_reduction,
            recording_sound_enabled=enabled,
            recording_sound_path=sound_path if enabled else None,
        )

    def with_quality_preset(self, preset: str,
    ) -> AudioConfiguration:
        """Create a new configuration with a quality preset."""
        if preset == "speech":
            return AudioConfiguration(
                sample_rate=16000,
                channels=1,
                bit_depth=16,
                buffer_size=1024,
                enable_noise_reduction=self.enable_noise_reduction,
                recording_sound_enabled=self.recording_sound_enabled,
                recording_sound_path=self.recording_sound_path,
            )
        if preset == "high_quality":
            return AudioConfiguration(
                sample_rate=48000,
                channels=2,
                bit_depth=24,
                buffer_size=2048,
                enable_noise_reduction=self.enable_noise_reduction,
                recording_sound_enabled=self.recording_sound_enabled,
                recording_sound_path=self.recording_sound_path,
            )
        msg = f"Unknown quality preset: {preset}"
        raise ValueError(msg)