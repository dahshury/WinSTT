"""LLM Quantization Level Value Object."""

from __future__ import annotations

from enum import Enum


class LLMQuantizationLevel(Enum):
    """Enumeration of LLM quantization levels.
    
    Quantization reduces model precision to improve performance:
    - FULL: Full precision (float32) - highest quality, slower
    - QUANTIZED_8BIT: 8-bit quantization - good balance
    - QUANTIZED_4BIT: 4-bit quantization - fastest, lowest quality
    """
    
    FULL = "full"
    QUANTIZED_8BIT = "8bit"
    QUANTIZED_4BIT = "4bit"
    
    @property
    def is_full_precision(self) -> bool:
        """Check if this is full precision quantization."""
        return self == LLMQuantizationLevel.FULL
    
    @property
    def is_quantized(self) -> bool:
        """Check if this is reduced precision quantization."""
        return self != LLMQuantizationLevel.FULL
    
    @property
    def bit_depth(self) -> int:
        """Get the bit depth for this quantization level."""
        if self == LLMQuantizationLevel.FULL:
            return 32
        if self == LLMQuantizationLevel.QUANTIZED_8BIT:
            return 8
        if self == LLMQuantizationLevel.QUANTIZED_4BIT:
            return 4
        return 32  # fallback
    
    @property
    def memory_reduction_ratio(self) -> float:
        """Get the memory reduction ratio compared to full precision."""
        if self == LLMQuantizationLevel.FULL:
            return 1.0
        if self == LLMQuantizationLevel.QUANTIZED_8BIT:
            return 0.25  # 4x reduction
        if self == LLMQuantizationLevel.QUANTIZED_4BIT:
            return 0.125  # 8x reduction
        return 1.0
    
    @property
    def performance_impact(self) -> str:
        """Get description of performance impact."""
        if self == LLMQuantizationLevel.FULL:
            return "Highest quality, slower inference"
        if self == LLMQuantizationLevel.QUANTIZED_8BIT:
            return "Good balance of quality and speed"
        if self == LLMQuantizationLevel.QUANTIZED_4BIT:
            return "Fastest inference, lower quality"
        return "Unknown performance impact"
    
    @classmethod
    def from_string(cls, value: str) -> LLMQuantizationLevel:
        """Create quantization level from string value."""
        value_lower = value.lower()
        for quantization in cls:
            if quantization.value.lower() == value_lower:
                return quantization
        
        valid_values = [q.value for q in cls]
        msg = (
            f"Invalid quantization level '{value}'. "
            f"Valid values: {valid_values}"
        )
        raise ValueError(msg)
    
    def __str__(self) -> str:
        """String representation of quantization level."""
        return self.value
    
    def __repr__(self) -> str:
        """Representation of quantization level."""
        return f"LLMQuantizationLevel.{self.name}"
    
    def __eq__(self, other: object) -> bool:
        """Equality comparison."""
        if not isinstance(other, LLMQuantizationLevel):
            return False
        return self.value == other.value
    
    def __hash__(self) -> int:
        """Hash for quantization level."""
        return hash(self.value) 