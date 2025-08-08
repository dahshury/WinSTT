"""Worker Configuration Value Objects

This module contains value objects related to worker configuration,
including worker setup, initialization parameters, and runtime settings.
"""

from dataclasses import dataclass, field
from typing import Any

from src_refactored.domain.common.value_object import ValueObject
from src_refactored.domain.llm.value_objects.llm_model_name import LLMModelName
from src_refactored.domain.llm.value_objects.llm_quantization_level import LLMQuantizationLevel
from src_refactored.domain.transcription.value_objects.model_name import ModelName
from src_refactored.domain.transcription.value_objects.quantization_level import QuantizationLevel
from src_refactored.domain.worker_management.value_objects.worker_operations import WorkerType


@dataclass(frozen=True)
class WorkerConfiguration(ValueObject):
    """Configuration for worker initialization"""
    worker_type: WorkerType
    enabled: bool = True
    model_name: ModelName | None = None
    quantization_level: QuantizationLevel | None = None
    llm_model_name: LLMModelName | None = None
    llm_quantization_level: LLMQuantizationLevel | None = None
    auto_start: bool = True
    timeout_seconds: int = 30
    retry_count: int = 3
    cleanup_on_failure: bool = True
    custom_parameters: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (
            self.worker_type,
            self.enabled,
            self.model_name,
            self.quantization_level,
            self.llm_model_name,
            self.llm_quantization_level,
            self.auto_start,
            self.timeout_seconds,
            self.retry_count,
            self.cleanup_on_failure,
            tuple(sorted(self.custom_parameters.items())) if self.custom_parameters else (),
        )

    def __invariants__(self) -> None:
        """Validate worker configuration invariants."""
        if self.timeout_seconds <= 0:
            msg = "Timeout seconds must be positive"
            raise ValueError(msg)
        if self.retry_count < 0:
            msg = "Retry count cannot be negative"
            raise ValueError(msg)
        if self.worker_type == WorkerType.TRANSCRIBER and not self.model_name:
            msg = "Transcriber worker requires model_name"
            raise ValueError(msg)
        if self.worker_type == WorkerType.LLM and not self.llm_model_name:
            msg = "LLM worker requires llm_model_name"
            raise ValueError(msg)

    def is_model_worker(self,
    ) -> bool:
        """Check if this is a model-based worker."""
        return self.worker_type in [WorkerType.TRANSCRIBER, WorkerType.LLM]

    def requires_gpu(self) -> bool:
        """Check if this worker configuration requires GPU resources."""
        # Check all conditions that would require GPU
        conditions = [
            # LLM workers generally benefit from GPU
            self.worker_type == WorkerType.LLM,
            
            # Check transcription model quantization
            self.quantization_level is not None and getattr(self.quantization_level, "requires_gpu", False),
            
            # Check LLM quantization
            self.llm_quantization_level is not None and getattr(self.llm_quantization_level, "requires_gpu", False),
        ]
        
        return any(conditions)

    def get_memory_requirements(self) -> int:
        """Get estimated memory requirements in MB."""
        base_memory = 100  # Base memory for worker

        if self.worker_type == WorkerType.TRANSCRIBER and self.model_name:
            base_memory += self.model_name.get_memory_requirements()

        if self.worker_type == WorkerType.LLM and self.llm_model_name:
            base_memory += self.llm_model_name.get_memory_requirements()

        return base_memory