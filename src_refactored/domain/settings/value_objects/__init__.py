"""Settings domain value objects."""

from .audio_configuration import AudioConfiguration
from .file_path import AudioFilePath, FilePath, ModelFilePath
from .key_combination import KeyCombination
from .llm_configuration import LLMConfiguration
from .model_configuration import ModelConfiguration, ModelType, Quantization

__all__ = [
    "AudioConfiguration",
    "AudioFilePath",
    "FilePath",
    "KeyCombination",
    "LLMConfiguration",
    "ModelConfiguration",
    "ModelFilePath",
    "ModelType",
    "Quantization",
]