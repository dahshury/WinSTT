"""Transcription Request Value Object.

Defines configuration for transcription requests.
Extracted from infrastructure/transcription/onnx_transcription_service.py
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import TYPE_CHECKING

import numpy as np

from src_refactored.domain.common.value_object import ValueObject

if TYPE_CHECKING:
    from src_refactored.domain.transcription.value_objects.language import Language


@dataclass(frozen=True)
class TranscriptionRequest(ValueObject):
    """Transcription request configuration.
    
    Encapsulates all parameters needed for a transcription request.
    """
    audio_input: str | io.BytesIO | np.ndarray
    language: Language | None = None
    task: str = "transcribe"  # or "translate"
    return_segments: bool = True

    def __post_init__(self):
        """Validate transcription request parameters."""
        if not self.audio_input:
            msg = "Audio input is required"
            raise ValueError(msg,
    )

        if self.task not in ("transcribe", "translate"):
            msg = f"Invalid task: {self.task}. Must be 'transcribe' or 'translate'"
            raise ValueError(msg)

    @property
    def is_translation_request(self) -> bool:
        """Check if this is a translation request."""
        return self.task == "translate"

    @property
    def is_transcription_request(self) -> bool:
        """Check if this is a transcription request."""
        return self.task == "transcribe"

    @property
    def has_language_specified(self) -> bool:
        """Check if a specific language is specified."""
        return self.language is not None

    @property
    def audio_input_type(self) -> str:
        """Get the type of audio input."""
        if isinstance(self.audio_input, str):
            return "file_path"
        if isinstance(self.audio_input, io.BytesIO):
            return "byte_stream"
        if isinstance(self.audio_input, np.ndarray):
            return "numpy_array"
        return "unknown"