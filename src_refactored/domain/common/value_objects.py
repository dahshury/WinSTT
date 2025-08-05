"""
Domain Value Objects

Mirrors the existing src/ui/domain/value_objects.py with comprehensive validation.
Contains immutable value objects that represent concepts in the domain.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .value_object import ValueObject


@dataclass(frozen=True)
class WindowDimensions(ValueObject):
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
class StyleConfiguration(ValueObject):
    """Value object for UI styling configuration."""
    theme: str
    primary_color: str
    secondary_color: str
    font_family: str
    font_size: int

    def __post_init__(self,
    ):
        if self.theme not in ["dark", "light", "auto"]:
            msg = f"Invalid theme: {self.theme}"
            raise ValueError(msg)
        if self.font_size < 8 or self.font_size > 72:
            msg = f"Invalid font size: {self.font_size}"
            raise ValueError(msg)
        if not self._is_valid_color(self.primary_color):
            msg = f"Invalid primary color: {self.primary_color}"
            raise ValueError(msg)
        if not self._is_valid_color(self.secondary_color):
            msg = f"Invalid secondary color: {self.secondary_color}"
            raise ValueError(msg,
    )

    def _is_valid_color(self, color: str,
    ) -> bool:
        """Validate color format (hex or rgb)."""
        if color.startswith("#") and len(color) == 7:
            try:
                int(color[1:], 16)
                return True
            except ValueError:
                return False
        return color in ["red", "green", "blue", "white", "black", "transparent"]


@dataclass(frozen=True)
class KeyCombination(ValueObject):
    """Value object for keyboard key combinations."""
    modifiers: list[str]
    key: str

    def __post_init__(self):
        valid_modifiers = {"CTRL", "ALT", "SHIFT", "META", "CMD"}
        for modifier in self.modifiers:
            if modifier.upper() not in valid_modifiers:
                msg = f"Invalid modifier: {modifier}"
                raise ValueError(msg)

        if not self.key:
            msg = "Key cannot be empty"
            raise ValueError(msg)

        # Ensure modifiers are unique and uppercase
        unique_modifiers = list({mod.upper() for mod in self.modifiers},
    )
        object.__setattr__(self, "modifiers", sorted(unique_modifiers))

    @classmethod
    def from_string(cls, key_string: str,
    ) -> KeyCombination:
        """Create from string like 'CTRL+ALT+A'."""
        parts = [part.strip().upper() for part in key_string.split("+")]
        if len(parts) < 1:
            msg = "Invalid key combination string"
            raise ValueError(msg,
    )

        key = parts[-1]
        modifiers = parts[:-1]
        return cls(modifiers=modifiers, key=key)

    def to_string(self) -> str:
        """Convert to string representation."""
        if self.modifiers:
            return "+".join([*self.modifiers, self.key])
        return self.key


@dataclass(frozen=True)
class AudioConfiguration(ValueObject):
    """Value object for audio configuration."""
    sample_rate: int
    channels: int
    bit_depth: int
    buffer_size: int

    def __post_init__(self):
        if self.sample_rate not in [8000, 16000, 22050, 44100, 48000]:
            msg = f"Invalid sample rate: {self.sample_rate}"
            raise ValueError(msg)
        if self.channels not in [1, 2]:
            msg = f"Invalid channels: {self.channels}"
            raise ValueError(msg)
        if self.bit_depth not in [16, 24, 32]:
            msg = f"Invalid bit depth: {self.bit_depth}"
            raise ValueError(msg)
        if self.buffer_size < 64 or self.buffer_size > 8192:
            msg = f"Invalid buffer size: {self.buffer_size}"
            raise ValueError(msg)


class ModelType(Enum):
    """Enumeration of supported model types."""
    WHISPER_TURBO = "whisper-turbo"
    LITE_WHISPER_TURBO = "lite-whisper-turbo"
    LITE_WHISPER_TURBO_FAST = "lite-whisper-turbo-fast"


class Quantization(Enum):
    """Enumeration of quantization levels."""
    FULL = "full"
    QUANTIZED = "quantized"


@dataclass(frozen=True)
class ModelConfiguration(ValueObject):
    """Value object for model configuration."""
    model_type: ModelType
    quantization: Quantization
    language: str
    task: str

    def __post_init__(self):
        if self.language and len(self.language,
    ) != 2:
            msg = f"Language must be 2-character code, got: {self.language}"
            raise ValueError(msg)
        if self.task not in ["transcribe", "translate"]:
            msg = f"Invalid task: {self.task}"
            raise ValueError(msg)

    @property
    def estimated_size_mb(self) -> float:
        """Estimate model size in MB."""
        base_sizes = {
            ModelType.WHISPER_TURBO: 244.0,
            ModelType.LITE_WHISPER_TURBO: 152.0,
            ModelType.LITE_WHISPER_TURBO_FAST: 65.0,
        }
        base_size = base_sizes.get(self.model_type, 244.0)
        if self.quantization == Quantization.QUANTIZED:
            return base_size * 0.5  # Rough estimate for quantized models
        return base_size

    @property
    def is_compatible_with_gpu(self) -> bool:
        """Check if model is compatible with GPU acceleration."""
        return self.quantization == Quantization.FULL


@dataclass(frozen=True)
class LLMConfiguration(ValueObject):
    """Value object for LLM configuration."""
    enabled: bool
    model_path: str
    prompt_template: str
    max_tokens: int
    temperature: float

    def __post_init__(self):
        if self.max_tokens < 1 or self.max_tokens > 4096:
            msg = f"Invalid max_tokens: {self.max_tokens}"
            raise ValueError(msg)
        if not 0.0 <= self.temperature <= 2.0:
            msg = f"Invalid temperature: {self.temperature}"
            raise ValueError(msg)
        if not self.prompt_template.strip():
            msg = "Prompt template cannot be empty"
            raise ValueError(msg)


@dataclass(frozen=True)
class OutputConfiguration(ValueObject):
    """Value object for output configuration."""
    format: str
    output_directory: str
    filename_template: str

    def __post_init__(self,
    ):
        valid_formats = ["txt", "srt", "vtt", "json"]
        if self.format not in valid_formats:
            msg = f"Invalid format: {self.format}. Must be one of {valid_formats}"
            raise ValueError(msg)
        if not self.output_directory:
            msg = "Output directory cannot be empty"
            raise ValueError(msg)
        if not self.filename_template:
            msg = "Filename template cannot be empty"
            raise ValueError(msg,
    )