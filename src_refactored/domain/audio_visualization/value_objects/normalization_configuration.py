"""Audio Normalization Configuration Value Objects.

This module defines value objects for audio normalization configuration,
including normalization parameters and settings.
"""

from dataclasses import dataclass

from src_refactored.domain.common.value_object import ValueObject

from .normalization_types import NormalizationMethod


@dataclass(frozen=True)
class NormalizationConfig(ValueObject):
    """Configuration for audio normalization."""
    method: NormalizationMethod = NormalizationMethod.SPEECH_OPTIMIZED
    target_amplitude: float = 0.5
    min_rms_threshold: float = 0.01
    max_amplitude: float = 1.0
    enable_clipping_protection: bool = True
    smoothing_factor: float = 0.1
    noise_floor: float = 0.001

    def _get_equality_components(self,
    ) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (
            self.method,
            self.target_amplitude,
            self.min_rms_threshold,
            self.max_amplitude,
            self.enable_clipping_protection,
            self.smoothing_factor,
            self.noise_floor,
        )

    def __invariants__(self) -> None:
        """Validate normalization configuration invariants."""
        if not 0.0 < self.target_amplitude <= 1.0:
            msg = "Target amplitude must be between 0.0 and 1.0"
            raise ValueError(msg)
        if not 0.0 <= self.min_rms_threshold <= 1.0:
            msg = "Min RMS threshold must be between 0.0 and 1.0"
            raise ValueError(msg)
        if not 0.0 < self.max_amplitude <= 1.0:
            msg = "Max amplitude must be between 0.0 and 1.0"
            raise ValueError(msg)
        if not 0.0 <= self.smoothing_factor <= 1.0:
            msg = "Smoothing factor must be between 0.0 and 1.0"
            raise ValueError(msg)
        if not 0.0 <= self.noise_floor <= 1.0:
            msg = "Noise floor must be between 0.0 and 1.0"
            raise ValueError(msg)
        if self.target_amplitude > self.max_amplitude:
            msg = "Target amplitude cannot exceed max amplitude"
            raise ValueError(msg)

    def is_speech_optimized(self) -> bool:
        """Check if configuration is optimized for speech."""
        return self.method == NormalizationMethod.SPEECH_OPTIMIZED

    def requires_clipping_protection(self) -> bool:
        """Check if clipping protection is enabled."""
        return self.enable_clipping_protection

    def get_effective_target(self,
    ) -> float:
        """Get the effective target amplitude considering max amplitude."""
        return min(self.target_amplitude, self.max_amplitude)