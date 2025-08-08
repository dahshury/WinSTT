"""Model Download Configuration Value Object.

Defines configuration for model downloads.
Extracted from infrastructure/transcription/model_download_service.py
"""

from dataclasses import dataclass

from src_refactored.domain.common.value_object import ValueObject
from src_refactored.domain.transcription.value_objects.transcription_quality import (
    TranscriptionQuality,
)


@dataclass(frozen=True)
class ModelDownloadConfig(ValueObject):
    """Configuration for model downloads.
    
    Encapsulates all parameters needed for downloading ML models.
    """
    cache_path: str
    model_type: str = "whisper-turbo"
    quality: TranscriptionQuality = TranscriptionQuality.QUANTIZED
    timeout: int = 30
    chunk_size: int = 1024

    def __post_init__(self) -> None:
        """Validate model download configuration."""
        if not self.cache_path:
            msg = "Cache path is required"
            raise ValueError(msg)

        if not self.model_type:
            msg = "Model type is required"
            raise ValueError(msg)

        if self.timeout <= 0:
            msg = "Timeout must be positive"
            raise ValueError(msg)

        if self.chunk_size <= 0:
            msg = "Chunk size must be positive"
            raise ValueError(msg)

    @property
    def is_high_quality(self) -> bool:
        """Check if high quality models should be downloaded."""
        return self.quality.is_high_quality

    @property
    def is_optimized(self) -> bool:
        """Check if optimized models should be downloaded."""
        return self.quality.is_optimized

    @property
    def quality_suffix(self,
    ) -> str:
        """Get the quality suffix for model filenames."""
        return self.quality.value