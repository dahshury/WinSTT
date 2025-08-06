"""LLM Model Name Value Object."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LLMModelName:
    """Value object for LLM model name.
    
    Represents a specific LLM model with validation and business rules.
    """
    
    value: str
    
    def __post_init__(self) -> None:
        """Validate model name after initialization."""
        if not self.value or not self.value.strip():
            msg = "Model name cannot be empty"
            raise ValueError(msg)
        
        if len(self.value) > 100:
            msg = "Model name too long (max 100 characters)"
            raise ValueError(msg)
        
        # Validate format: should be alphanumeric with dots, dashes, underscores
        import re
        if not re.match(r"^[a-zA-Z0-9._-]+$", self.value):
            msg = "Model name contains invalid characters"
            raise ValueError(msg)
    
    def __str__(self) -> str:
        """String representation of model name."""
        return self.value
    
    def __repr__(self) -> str:
        """Representation of model name."""
        return f"LLMModelName(value='{self.value}')"
    
    def __eq__(self, other: object) -> bool:
        """Equality comparison."""
        if not isinstance(other, LLMModelName):
            return False
        return self.value == other.value
    
    def __hash__(self) -> int:
        """Hash for model name."""
        return hash(self.value)
    
    @property
    def is_gemma_model(self) -> bool:
        """Check if this is a Gemma model."""
        return "gemma" in self.value.lower()
    
    @property
    def is_whisper_model(self) -> bool:
        """Check if this is a Whisper model."""
        return "whisper" in self.value.lower()
    
    @property
    def model_family(self) -> str:
        """Get the model family name."""
        parts = self.value.lower().split("-")
        return parts[0] if parts else "unknown"
    
    @classmethod
    def from_string(cls, value: str) -> LLMModelName:
        """Create LLMModelName from string."""
        return cls(value.strip()) 