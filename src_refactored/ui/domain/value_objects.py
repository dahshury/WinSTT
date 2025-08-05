"""UI Domain Value Objects

This module contains immutable value objects that represent concepts
in the UI domain, with built-in validation and business rules.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


@dataclass(frozen=True)
class WindowDimensions:
    """Value object for window dimensions with validation."""
    width: int
    height: int
    
    def __post_init__(self):
        if self.width < 100 or self.width > 3840:
            msg = f"Invalid width: {self.width}. Must be between 100 and 3840."
            raise ValueError(msg)
        if self.height < 100 or self.height > 2160:
            msg = f"Invalid height: {self.height}. Must be between 100 and 2160."
            raise ValueError(msg)
    
    @property
    def aspect_ratio(self) -> float:
        """Calculate aspect ratio."""
        return self.width / self.height
    
    @property
    def area(self) -> int:
        """Calculate area in pixels."""
        return self.width * self.height

@dataclass(frozen=True)
class StyleConfiguration:
    """Value object for UI styling configuration."""
    theme: str
    primary_color: str
    secondary_color: str
    font_family: str
    font_size: int
    
    def __post_init__(self):
        if self.theme not in ["dark", "light", "auto"]:
            msg = f"Invalid theme: {self.theme}"
            raise ValueError(msg)
        
        if not self._is_valid_color(self.primary_color):
            msg = f"Invalid primary color: {self.primary_color}"
            raise ValueError(msg)
        
        if not self._is_valid_color(self.secondary_color):
            msg = f"Invalid secondary color: {self.secondary_color}"
            raise ValueError(msg)
        
        if self.font_size < 8 or self.font_size > 72:
            msg = f"Invalid font size: {self.font_size}. Must be between 8 and 72."
            raise ValueError(msg)
    
    def _is_valid_color(self, color: str) -> bool:
        """Validate color format (hex or named)."""
        if color.startswith('#') and len(color) == 7:
            try:
                int(color[1:], 16)
                return True
            except ValueError:
                return False
        return color.lower() in ['red', 'green', 'blue', 'black', 'white', 'gray', 'yellow', 'orange', 'purple']

@dataclass(frozen=True)
class KeyCombination:
    """Value object for keyboard shortcuts."""
    modifiers: list[str]
    key: str
    
    def __post_init__(self):
        valid_modifiers = ['ctrl', 'alt', 'shift', 'meta']
        for modifier in self.modifiers:
            if modifier.lower() not in valid_modifiers:
                msg = f"Invalid modifier: {modifier}"
                raise ValueError(msg)
        
        if not self.key:
            msg = "Key cannot be empty"
            raise ValueError(msg)
        
        if len(self.key) > 1 and self.key.lower() not in ['space', 'enter', 'tab', 'escape', 'backspace', 'delete']:
            msg = f"Invalid key: {self.key}"
            raise ValueError(msg)
    
    @classmethod
    def from_string(cls, key_string: str) -> KeyCombination:
        """Create KeyCombination from string like 'Ctrl+Alt+S'."""
        parts = [part.strip().lower() for part in key_string.split('+')]
        if len(parts) < 1:
            raise ValueError("Invalid key combination string")
        
        key = parts[-1]
        modifiers = parts[:-1]
        
        return cls(modifiers, key)
    
    def to_string(self) -> str:
        """Convert to string representation."""
        parts = [mod.capitalize() for mod in self.modifiers] + [self.key.capitalize()]
        return '+'.join(parts)

@dataclass(frozen=True)
class AudioConfiguration:
    """Value object for audio settings."""
    sample_rate: int
    channels: int
    bit_depth: int
    buffer_size: int
    enable_noise_reduction: bool = True
    
    def __post_init__(self):
        if self.sample_rate not in [16000, 22050, 44100, 48000]:
            msg = f"Invalid sample rate: {self.sample_rate}"
            raise ValueError(msg)
        
        if self.channels not in [1, 2]:
            msg = f"Invalid channel count: {self.channels}"
            raise ValueError(msg)
        
        if self.bit_depth not in [16, 24, 32]:
            msg = f"Invalid bit depth: {self.bit_depth}"
            raise ValueError(msg)
        
        if self.buffer_size < 256 or self.buffer_size > 8192:
            msg = f"Invalid buffer size: {self.buffer_size}"
            raise ValueError(msg)

class ModelType(Enum):
    """Available model types for transcription."""
    WHISPER_TURBO = "whisper-turbo"
    LITE_WHISPER_TURBO = "lite-whisper-turbo"
    LITE_WHISPER_TURBO_FAST = "lite-whisper-turbo-fast"

class Quantization(Enum):
    """Model quantization options."""
    FULL = "Full"
    QUANTIZED = "Quantized"

@dataclass(frozen=True)
class ModelConfiguration:
    """Value object for model configuration."""
    model_type: ModelType
    quantization: Quantization
    use_gpu: bool
    max_memory: int | None = None
    
    def __post_init__(self):
        if self.max_memory is not None:
            if self.max_memory < 512 or self.max_memory > 32768:
                msg = f"Invalid max memory: {self.max_memory}. Must be between 512 and 32768 MB."
                raise ValueError(msg)
        
        # GPU validation
        if self.use_gpu and self.max_memory is None:
            # Default GPU memory if not specified
            object.__setattr__(self, 'max_memory', 4096)
    
    @property
    def requires_download(self) -> bool:
        """Check if model requires download."""
        return True  # All models require initial download
    
    @property
    def estimated_size_mb(self) -> int:
        """Get estimated model size in MB."""
        size_map = {
            ModelType.WHISPER_TURBO: 1550 if self.quantization == Quantization.FULL else 800,
            ModelType.LITE_WHISPER_TURBO: 800 if self.quantization == Quantization.FULL else 400,
            ModelType.LITE_WHISPER_TURBO_FAST: 400 if self.quantization == Quantization.FULL else 200,
        }
        return size_map.get(self.model_type, 1000)

@dataclass(frozen=True)
class LLMConfiguration:
    """Value object for LLM configuration."""
    model_name: str
    quantization: Quantization
    system_prompt: str
    max_tokens: int = 512
    temperature: float = 0.7
    
    def __post_init__(self):
        if not self.model_name:
            msg = "Model name cannot be empty"
            raise ValueError(msg)
        
        if self.max_tokens < 1 or self.max_tokens > 4096:
            msg = f"Invalid max tokens: {self.max_tokens}. Must be between 1 and 4096."
            raise ValueError(msg)
        
        if self.temperature < 0.0 or self.temperature > 2.0:
            msg = f"Invalid temperature: {self.temperature}. Must be between 0.0 and 2.0."
            raise ValueError(msg)
        
        if not self.system_prompt:
            msg = "System prompt cannot be empty"
            raise ValueError(msg)

@dataclass(frozen=True)
class OutputConfiguration:
    """Value object for output configuration."""
    format_type: str
    include_timestamps: bool
    output_directory: str | None = None
    
    def __post_init__(self):
        valid_formats = ['text', 'json', 'srt', 'vtt', 'csv']
        if self.format_type not in valid_formats:
            msg = f"Invalid format type: {self.format_type}. Must be one of {valid_formats}."
            raise ValueError(msg)
        
        if self.output_directory is not None:
            import os
            if not os.path.isdir(self.output_directory):
                msg = f"Output directory does not exist: {self.output_directory}"
                raise ValueError(msg)

__all__ = [
    "AudioConfiguration",
    "KeyCombination",
    "LLMConfiguration",
    "ModelConfiguration",
    "ModelType",
    "OutputConfiguration",
    "Quantization",
    "StyleConfiguration",
    "WindowDimensions",
]