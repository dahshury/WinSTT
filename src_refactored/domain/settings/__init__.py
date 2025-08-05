"""Settings domain."""

from .entities import (
    HotkeyBinding,
    KeyInfo,
    KeyType,
    RecordingState,
    SettingsConfiguration,
    UserPreferences,
)
from .value_objects import (
    AudioConfiguration,
    AudioFilePath,
    FilePath,
    KeyCombination,
    LLMConfiguration,
    ModelConfiguration,
    ModelFilePath,
    ModelType,
    Quantization,
)

__all__ = [
    "AudioConfiguration",
    "AudioFilePath",
    # Value Objects
    "FilePath",
    "HotkeyBinding",
    "KeyCombination",
    "KeyInfo",
    "KeyType",
    "LLMConfiguration",
    "ModelConfiguration",
    "ModelFilePath",
    "ModelType",
    "Quantization",
    "RecordingState",
    "SettingsConfiguration",
    # Entities
    "UserPreferences",
]