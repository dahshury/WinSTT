"""Transcription Configuration Value Object.

Defines configuration for transcription sessions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from src_refactored.domain.common.value_object import ValueObject

from .transcription_quality import TranscriptionQuality

if TYPE_CHECKING:
    from .language import Language


@dataclass(frozen=True)
class TranscriptionConfiguration(ValueObject):
    """Configuration for transcription sessions.
    
    Encapsulates all parameters needed for configuring a transcription session.
    """
    language: Language | None = None
    task: str = "transcribe"  # or "translate"
    quality: TranscriptionQuality = TranscriptionQuality.FULL
    return_segments: bool = True
    enable_vad: bool = True  # Voice Activity Detection
    
    def __post_init__(self):
        """Validate transcription configuration parameters."""
        if self.task not in ("transcribe", "translate"):
            msg = f"Invalid task: {self.task}. Must be 'transcribe' or 'translate'"
            raise ValueError(msg)
    
    @property
    def is_translation_task(self) -> bool:
        """Check if this is a translation task."""
        return self.task == "translate"
    
    @property
    def is_transcription_task(self) -> bool:
        """Check if this is a transcription task."""
        return self.task == "transcribe"
    
    @property
    def language_code(self) -> str | None:
        """Get the language code if language is specified."""
        return self.language.code.value if self.language else None