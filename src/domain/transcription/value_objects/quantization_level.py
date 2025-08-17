"""Quantization Level Value Object for Transcription Domain."""

from __future__ import annotations

from dataclasses import dataclass

from src.domain.common import ValueObject


@dataclass(frozen=True)
class QuantizationLevel(ValueObject):
    """Value object for quantization levels with validation."""

    value: str

    def __post_init__(self) -> None:
        """Validate quantization level after initialization."""
        if not self.value or not self.value.strip():
            msg = "Quantization level cannot be empty"
            raise ValueError(msg)

        # Normalize the quantization level
        normalized_level = self.value.strip().lower()
        object.__setattr__(self, "value", normalized_level)

    @classmethod
    def from_string(cls, level: str,
    ) -> QuantizationLevel:
        """Create from string level."""
        return cls(value=level)

    @classmethod
    def full(cls) -> QuantizationLevel:
        """Create full precision quantization level."""
        return cls(value="full")

    @classmethod
    def quantized(cls) -> QuantizationLevel:
        """Create quantized precision level."""
        return cls(value="quantized")

    @classmethod
    def int8(cls) -> QuantizationLevel:
        """Create int8 quantization level."""
        return cls(value="int8")

    @classmethod
    def int16(cls) -> QuantizationLevel:
        """Create int16 quantization level."""
        return cls(value="int16")

    @classmethod
    def float16(cls) -> QuantizationLevel:
        """Create float16 quantization level."""
        return cls(value="float16")

    def is_full_precision(self) -> bool:
        """Check if this is full precision quantization."""
        return self.value in ["full", "float32"]

    def is_quantized(self) -> bool:
        """Check if this is reduced precision quantization."""
        return self.value in ["quantized", "int8", "int16", "float16"]

    def is_integer_quantized(self) -> bool:
        """Check if this is integer quantization."""
        return self.value in ["int8", "int16"]

    def is_float_quantized(self) -> bool:
        """Check if this is float quantization."""
        return self.value in ["float16"]

    def get_precision_bits(self) -> int:
        """Get the precision in bits."""
        if self.value == "int8":
            return 8
        if self.value in {"int16", "float16"}:
            return 16
        if self.value in ["full", "float32"]:
            return 32
        return 0

    def get_performance_impact(self) -> str:
        """Get description of performance impact."""
        if self.is_full_precision():
            return "Higher quality, slower inference"
        if self.is_integer_quantized():
            return "Lower quality, faster inference"
        if self.is_float_quantized():
            return "Balanced quality and speed"
        return "Unknown performance impact"
    
    def requires_gpu(self) -> bool:
        """Check if this quantization level requires GPU for optimal performance."""
        # Full precision models typically benefit from GPU acceleration
        # Quantized models can run efficiently on CPU
        return self.is_full_precision()

    def __str__(self) -> str:
        """String representation."""
        return self.value

    def __repr__(self) -> str:
        """Representation for debugging."""
        return f"QuantizationLevel(value='{self.value}')" 