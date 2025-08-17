"""Settings Domain Module."""

from .entities import (
    HotkeyBinding,
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
    # Value Objects
    "AudioConfiguration",
    "AudioFilePath",
    "FilePath",
    # Entities
    "HotkeyBinding",
    "KeyCombination",
    "LLMConfiguration",
    "ModelConfiguration",
    "ModelFilePath",
    "ModelType",
    "Quantization",
    "SettingsConfiguration",
    "UserPreferences",
]