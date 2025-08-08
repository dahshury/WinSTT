"""Model Name Value Object for Transcription Domain."""

from __future__ import annotations

from dataclasses import dataclass

from src_refactored.domain.common import ValueObject


@dataclass(frozen=True)
class ModelName(ValueObject):
    """Value object for transcription model names with validation."""

    value: str

    def __post_init__(self) -> None:
        """Validate model name after initialization."""
        if not self.value or not self.value.strip():
            msg = "Model name cannot be empty"
            raise ValueError(msg)

        # Normalize the model name
        normalized_name = self.value.strip().lower()
        object.__setattr__(self, "value", normalized_name)

    @classmethod
    def from_string(cls, name: str,
    ) -> ModelName:
        """Create from string name."""
        return cls(value=name)

    @classmethod
    def whisper_turbo(cls) -> ModelName:
        """Create Whisper Turbo model name."""
        return cls(value="whisper-turbo")

    @classmethod
    def whisper_large(cls) -> ModelName:
        """Create Whisper Large model name."""
        return cls(value="whisper-large")

    @classmethod
    def whisper_medium(cls) -> ModelName:
        """Create Whisper Medium model name."""
        return cls(value="whisper-medium")

    @classmethod
    def whisper_small(cls) -> ModelName:
        """Create Whisper Small model name."""
        return cls(value="whisper-small")

    @classmethod
    def whisper_base(cls) -> ModelName:
        """Create Whisper Base model name."""
        return cls(value="whisper-base")

    @classmethod
    def lite_whisper_turbo(cls) -> ModelName:
        """Create Lite Whisper Turbo model name."""
        return cls(value="lite-whisper-turbo")

    @classmethod
    def lite_whisper_turbo_fast(cls) -> ModelName:
        """Create Lite Whisper Turbo Fast model name."""
        return cls(value="lite-whisper-turbo-fast")

    def is_whisper_model(self) -> bool:
        """Check if this is a Whisper model."""
        return "whisper" in self.value

    def is_lite_model(self) -> bool:
        """Check if this is a Lite model."""
        return "lite" in self.value

    def get_model_size(self) -> str:
        """Get the model size category."""
        if "large" in self.value:
            return "large"
        if "medium" in self.value:
            return "medium"
        if "small" in self.value:
            return "small"
        if "base" in self.value:
            return "base"
        if "turbo" in self.value:
            return "turbo"
        return "unknown"
    
    def get_memory_requirements(self) -> int:
        """Get estimated memory requirements in MB for this model."""
        size = self.get_model_size()
        
        # Estimated memory requirements for Whisper models
        memory_map = {
            "large": 6000,    # ~6GB for large models
            "medium": 2500,   # ~2.5GB for medium models
            "small": 1200,    # ~1.2GB for small models
            "base": 500,      # ~500MB for base models
            "turbo": 800,     # ~800MB for turbo models
            "unknown": 1000,  # Default fallback
        }
        
        base_memory = memory_map.get(size, 1000)
        
        # Lite models use less memory
        if self.is_lite_model():
            base_memory = int(base_memory * 0.7)  # 30% reduction for lite models
            
        return base_memory

    def __str__(self) -> str:
        """String representation."""
        return self.value

    def __repr__(self) -> str:
        """Representation for debugging."""
        return f"ModelName(value='{self.value}')" 