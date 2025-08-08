"""Sample Rate Value Object for Audio Domain."""

from __future__ import annotations

from dataclasses import dataclass

from src_refactored.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class SampleRate(ValueObject):
    """Sample rate value object for audio operations."""
    value: int

    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (self.value,)

    # Standard audio sample rates
    SUPPORTED_RATES: frozenset[int] = frozenset({
        8000,   # Telephone quality
        16000,  # Speech recognition standard
        22050,  # Low quality audio
        44100,  # CD quality
        48000,  # Professional audio
        96000,  # High-resolution audio
    })

    def __post_init__(self) -> None:
        if self.value <= 0:
            msg = f"Sample rate must be positive, got {self.value}"
            raise ValueError(msg)

        if self.value not in self.SUPPORTED_RATES:
            supported = ", ".join(str(rate) for rate in sorted(self.SUPPORTED_RATES))
            msg = (
                f"Unsupported sample rate {self.value}. "
                f"Supported rates: {supported}"
            )
            raise ValueError(
                msg,
            )

    @property
    def is_speech_quality(self) -> bool:
        """Check if sample rate is suitable for speech recognition."""
        return self.value >= 16000

    @property
    def nyquist_frequency(self) -> float:
        """Get the Nyquist frequency (half the sample rate)."""
        return self.value / 2.0

    @classmethod
    def speech_standard(cls) -> SampleRate:
        """Create standard speech recognition sample rate (16kHz)."""
        return cls(16000)

    @classmethod
    def cd_quality(cls) -> SampleRate:
        """Create CD quality sample rate (44.1kHz)."""
        return cls(44100)