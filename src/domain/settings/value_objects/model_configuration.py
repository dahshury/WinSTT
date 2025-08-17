"""Model configuration value object for settings domain."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src.domain.common import ValueObject


class ModelType(Enum):
    """Enumeration of supported model types."""

    WHISPER_TURBO = "whisper-turbo"
    LITE_WHISPER_TURBO = "lite-whisper-turbo"
    LITE_WHISPER_TURBO_FAST = "lite-whisper-turbo-fast"

    @classmethod
    def from_string(cls, value: str,
    ) -> ModelType:
        """Create ModelType from string value."""
        for model_type in cls:
            if model_type.value == value:
                return model_type
        msg = f"Unknown model type: {value}"
        raise ValueError(msg)

    def get_display_name(self) -> str:
        """Get human-readable display name."""
        display_names = {
            ModelType.WHISPER_TURBO: "Whisper Turbo",
            ModelType.LITE_WHISPER_TURBO: "Lite Whisper Turbo",
            ModelType.LITE_WHISPER_TURBO_FAST: "Lite Whisper Turbo Fast",
        }
        return display_names.get(self, self.value)


class Quantization(Enum):
    """Enumeration of quantization options."""

    FULL = "Full"
    QUANTIZED = "Quantized"

    @classmethod
    def from_string(cls, value: str,
    ) -> Quantization:
        """Create Quantization from string value."""
        for quantization in cls:
            if quantization.value == value:
                return quantization
        msg = f"Unknown quantization: {value}"
        raise ValueError(msg)


@dataclass(frozen=True)
class ModelConfiguration(ValueObject):
    """Value object for model configuration settings."""

    model_type: ModelType
    quantization: Quantization
    use_gpu: bool
    max_memory: int | None = None

    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (
            self.model_type,
            self.quantization,
            self.use_gpu,
            self.max_memory,
        )

    def __post_init__(self) -> None:
        """Validate model configuration after initialization."""
        if self.max_memory is not None and self.max_memory <= 0:
            msg = "Max memory must be positive"
            raise ValueError(msg)

        # GPU usage validation
        if self.use_gpu and not self._is_gpu_available():
            # Note: In a real implementation, you might want to just log a warning
            # instead of raising an exception
            pass  # Allow configuration even if GPU is not available

    def _is_gpu_available(self) -> bool:
        """Check if GPU is available for inference."""
        try:
            import onnxruntime as ort
            providers = ort.get_available_providers()
            return any(provider in providers for provider in ["CUDAExecutionProvider", "DmlExecutionProvider"])
        except ImportError:
            return False

    @property
    def requires_download(self) -> bool:
        """Check if the model requires downloading."""
        # This would typically check if the model files exist locally
        # For now, we'll assume all models might need downloading
        return True

    @property
    def estimated_size_mb(self) -> int:
        """Get estimated model size in MB."""
        size_map = {
            (ModelType.WHISPER_TURBO, Quantization.FULL): 1550,
            (ModelType.WHISPER_TURBO, Quantization.QUANTIZED): 800,
            (ModelType.LITE_WHISPER_TURBO, Quantization.FULL): 1200,
            (ModelType.LITE_WHISPER_TURBO, Quantization.QUANTIZED): 600,
            (ModelType.LITE_WHISPER_TURBO_FAST, Quantization.FULL): 800,
            (ModelType.LITE_WHISPER_TURBO_FAST, Quantization.QUANTIZED): 400,
        }
        return size_map.get((self.model_type, self.quantization), 1000)

    def get_model_filename(self) -> str:
        """Get the expected model filename."""
        quantization_suffix = "_q" if self.quantization == Quantization.QUANTIZED else ""
        return f"{self.model_type.value}{quantization_suffix}.onnx"

    def is_compatible_with_gpu(self) -> bool:
        """Check if this configuration is compatible with GPU usage."""
        return self.use_gpu and self._is_gpu_available()

    def get_execution_providers(self) -> list[str]:
        """Get the execution providers for this configuration."""
        if self.use_gpu and self._is_gpu_available():
            try:
                import onnxruntime as ort
                available_providers = ort.get_available_providers()

                # Prefer CUDA over DirectML
                if "CUDAExecutionProvider" in available_providers:
                    return ["CUDAExecutionProvider", "CPUExecutionProvider"]
                if "DmlExecutionProvider" in available_providers:
                    return ["DmlExecutionProvider", "CPUExecutionProvider"]
            except ImportError:
                pass

        return ["CPUExecutionProvider"]