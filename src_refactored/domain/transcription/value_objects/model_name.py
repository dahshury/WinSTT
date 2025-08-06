"""Model Name Value Object for Transcription Domain."""

from __future__ import annotations

from dataclasses import dataclass

from src_refactored.domain.common import ValueObject


@dataclass(frozen=True)
class ModelName(ValueObject):
    """Value object for transcription model names with validation."""

    value: str

    def __post_init__(self):
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

    def __str__(self) -> str:
        """String representation."""
        return self.value

    def __repr__(self) -> str:
        """Representation for debugging."""
        return f"ModelName(value='{self.value}')" 