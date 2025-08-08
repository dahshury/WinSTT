"""Model Configuration Value Object.

This module contains the ModelConfiguration value object for representing
transcription model configuration settings.
"""

from dataclasses import dataclass, field
from typing import Any

from src_refactored.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class ModelConfiguration(ValueObject):
    """Model configuration value object for transcription models."""
    
    model_type: str
    model_size: str
    model_path: str | None
    language: str | None
    task: str
    device: str
    compute_type: str
    beam_size: int
    best_of: int
    temperature: float
    compression_ratio_threshold: float
    log_prob_threshold: float
    no_speech_threshold: float
    condition_on_previous_text: bool
    initial_prompt: str | None
    word_timestamps: bool
    prepend_punctuations: str
    append_punctuations: str
    custom_parameters: dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self) -> None:
        """Validate model configuration."""
        if self.beam_size < 1:
            msg = "Beam size must be at least 1"
            raise ValueError(msg)
        if self.best_of < self.beam_size:
            msg = "best_of must be >= beam_size"
            raise ValueError(msg)
        if not 0.0 <= self.temperature <= 1.0:
            msg = "Temperature must be between 0.0 and 1.0"
            raise ValueError(msg)
        if self.compression_ratio_threshold < 1.0:
            msg = "Compression ratio threshold must be >= 1.0"
            raise ValueError(msg)
        if not 0.0 <= self.no_speech_threshold <= 1.0:
            msg = "No speech threshold must be between 0.0 and 1.0"
            raise ValueError(msg)
    
    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "model_type": self.model_type,
            "model_size": self.model_size,
            "model_path": self.model_path,
            "language": self.language,
            "task": self.task,
            "device": self.device,
            "compute_type": self.compute_type,
            "beam_size": self.beam_size,
            "best_of": self.best_of,
            "temperature": self.temperature,
            "compression_ratio_threshold": self.compression_ratio_threshold,
            "log_prob_threshold": self.log_prob_threshold,
            "no_speech_threshold": self.no_speech_threshold,
            "condition_on_previous_text": self.condition_on_previous_text,
            "initial_prompt": self.initial_prompt,
            "word_timestamps": self.word_timestamps,
            "prepend_punctuations": self.prepend_punctuations,
            "append_punctuations": self.append_punctuations,
            "custom_parameters": self.custom_parameters,
        }
    
    @classmethod
    def from_dict(cls, config_dict: dict[str, Any]) -> "ModelConfiguration":
        """Create from dictionary."""
        return cls(**config_dict)
    
    def __str__(self) -> str:
        return f"ModelConfiguration({self.model_type}/{self.model_size})"
    
    def __repr__(self) -> str:
        return f"ModelConfiguration(model_type='{self.model_type}', model_size='{self.model_size}')"
