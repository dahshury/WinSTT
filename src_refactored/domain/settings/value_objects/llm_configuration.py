"""LLM configuration value object for settings domain."""

from __future__ import annotations

from dataclasses import dataclass

from src_refactored.domain.common import ValueObject

from .model_configuration import Quantization


@dataclass(frozen=True)
class LLMConfiguration(ValueObject):
    """Value object for LLM configuration settings."""

    model_name: str
    quantization: Quantization
    system_prompt: str
    max_tokens: int = 512
    temperature: float = 0.7
    enabled: bool = True

    def _get_equality_components(self) -> tuple:
        """Get components for equality comparison."""
        return (
            self.model_name,
            self.quantization,
            self.system_prompt,
            self.max_tokens,
            self.temperature,
            self.enabled,
        )

    def __post_init__(self):
        """Validate LLM configuration after initialization."""
        if not self.model_name or not self.model_name.strip():
            msg = "Model name cannot be empty"
            raise ValueError(msg)

        if not self.system_prompt or not self.system_prompt.strip():
            msg = "System prompt cannot be empty"
            raise ValueError(msg)

        if self.max_tokens <= 0:
            msg = "Max tokens must be positive"
            raise ValueError(msg)

        if not 0.0 <= self.temperature <= 2.0:
            msg = "Temperature must be between 0.0 and 2.0"
            raise ValueError(msg)

        # Normalize values
        object.__setattr__(self, "model_name", self.model_name.strip())
        object.__setattr__(self, "system_prompt", self.system_prompt.strip())

    @classmethod
    def create_default(cls) -> LLMConfiguration:
        """Create default LLM configuration."""
        return cls(
            model_name="llama-3.2-3b-instruct",
            quantization=Quantization.QUANTIZED,
            system_prompt=(
                "You are a helpful assistant that improves transcribed text by correcting errors, "
                "adding proper punctuation, and enhancing readability while maintaining the original meaning."
            ),
            max_tokens=512,
            temperature=0.7,
            enabled=False,
        )

    def is_valid_for_processing(self) -> bool:
        """Check if the configuration is valid for text processing."""
        return (
            self.enabled and
            bool(self.model_name.strip()) and
            bool(self.system_prompt.strip()) and
            self.max_tokens > 0
        )

    def get_model_filename(self) -> str:
        """Get the expected model filename."""
        quantization_suffix = "_q" if self.quantization == Quantization.QUANTIZED else ""
        # Clean model name for filename
        clean_name = self.model_name.replace("-", "_").replace(".", "_")
        return f"{clean_name}{quantization_suffix}.onnx"

    def estimate_processing_time(self, text_length: int,
    ) -> float:
        """Estimate processing time in seconds based on text length."""
        # Rough estimation: ~100 tokens per second for quantized models
        # ~50 tokens per second for full precision models
        tokens_per_second = 100 if self.quantization == Quantization.QUANTIZED else 50
        estimated_tokens = min(text_length // 4, self.max_tokens)  # Rough token estimation
        return estimated_tokens / tokens_per_second

    def with_enabled(self, enabled: bool,
    ) -> LLMConfiguration:
        """Create a new configuration with different enabled state."""
        return LLMConfiguration(
            model_name=self.model_name,
            quantization=self.quantization,
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
            temperature=self.temperature,
            enabled=enabled,
        )

    def with_model(self, model_name: str,
    ) -> LLMConfiguration:
        """Create a new configuration with different model."""
        return LLMConfiguration(
            model_name=model_name,
            quantization=self.quantization,
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
            temperature=self.temperature,
            enabled=self.enabled,
        )

    def with_quantization(self, quantization: Quantization,
    ) -> LLMConfiguration:
        """Create a new configuration with different quantization."""
        return LLMConfiguration(
            model_name=self.model_name,
            quantization=quantization,
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
            temperature=self.temperature,
            enabled=self.enabled,
        )