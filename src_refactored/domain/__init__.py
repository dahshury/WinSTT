"""Domain layer package."""

# Settings domain
# Media domain
# Common domain components
from .common import (
    AggregateRoot,
    DomainEvent,
    Entity,
    ValueObject,
)
from .media import (
    BatchProcessingSession,
    ConversionJob,
    ConversionQuality,
    FileFormat,
    MediaDuration,
    MediaFile,
    MediaType,
    QualityPreset,
)
from .settings import (
    AudioConfiguration,
    AudioFilePath,
    FilePath,
    KeyCombination,
    LLMConfiguration,
    ModelConfiguration,
    ModelFilePath,
    ModelType,
    Quantization,
    UserPreferences,
)

__all__ = [
    "AggregateRoot",
    "AudioConfiguration",
    "AudioFilePath",
    "BatchProcessingSession",
    "ConversionJob",
    "ConversionQuality",
    "DomainEvent",
    # Shared domain components
    "Entity",
    "FileFormat",
    "FilePath",
    "KeyCombination",
    "LLMConfiguration",
    "MediaDuration",
    # Media domain
    "MediaFile",
    "MediaType",
    "ModelConfiguration",
    "ModelFilePath",
    "ModelType",
    "QualityPreset",
    "Quantization",
    # Settings domain
    "UserPreferences",
    "ValueObject",
]