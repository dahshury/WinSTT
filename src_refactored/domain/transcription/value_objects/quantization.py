"""Quantization Value Object for Transcription Domain."""

from __future__ import annotations

from enum import Enum


class Quantization(Enum):
    """Enumeration of quantization levels for model optimization.
    
    Quantization reduces model precision to improve performance:
    - FULL: Full precision (float32) - highest quality, slower
    - QUANTIZED: Reduced precision (int8/int16) - lower quality, faster
    """

    FULL = "Full"
    QUANTIZED = "Quantized"

    @property
    def is_full_precision(self) -> bool:
        """Check if this is full precision quantization."""
        return self == Quantization.FULL

    @property
    def is_quantized(self) -> bool:
        """Check if this is reduced precision quantization."""
        return self == Quantization.QUANTIZED

    @property
    def performance_impact(self) -> str:
        """Get description of performance impact."""
        if self == Quantization.FULL:
            return "Higher quality, slower inference"
        return "Lower quality, faster inference"

    @classmethod
    def from_string(cls, value: str,
    ) -> Quantization:
        """Create quantization from string value."""
        value_upper = value.upper()
        for quantization in cls:
            if quantization.value.upper() == value_upper:
                return quantization

        valid_values = [q.value for q in cls]
        msg = (
            f"Invalid quantization value '{value}'. "
            f"Valid values: {valid_values}"
        )
        raise ValueError(
            msg,
        )

    def __str__(self) -> str:
        """String representation of quantization."""
        return self.value