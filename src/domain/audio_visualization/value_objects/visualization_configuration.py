"""Visualization Configuration Value Objects.

This module defines value objects for visualization configuration,
including startup and shutdown configurations.
"""

from dataclasses import dataclass

from src.domain.common.value_object import ValueObject

from .visualization_control import ProcessorType, ShutdownStrategy


@dataclass(frozen=True)
class VisualizationConfiguration(ValueObject):
    """Configuration for visualization startup."""
    processor_type: ProcessorType = ProcessorType.AUDIO_PROCESSOR
    auto_start_processor: bool = True
    enable_signal_connections: bool = True
    validate_audio_device: bool = True
    timeout: float | None = 10.0
    retry_attempts: int = 3
    progress_callback_interval: float = 0.1

    def _get_equality_components(self,
    ) -> tuple[object, ...]:
        return (
            self.processor_type,
            self.auto_start_processor,
            self.enable_signal_connections,
            self.validate_audio_device,
            self.timeout,
            self.retry_attempts,
            self.progress_callback_interval,
        )

    def __invariants__(self) -> None:
        if self.timeout is not None and self.timeout <= 0:
            msg = "Timeout must be positive"
            raise ValueError(msg)
        if self.retry_attempts < 0:
            msg = "Retry attempts cannot be negative"
            raise ValueError(msg)
        if self.progress_callback_interval <= 0:
            msg = "Progress callback interval must be positive"
            raise ValueError(msg)


@dataclass(frozen=True)
class VisualizationStopConfiguration(ValueObject):
    """Configuration for visualization shutdown."""
    shutdown_strategy: ShutdownStrategy = ShutdownStrategy.GRACEFUL
    disconnect_signals: bool = True
    cleanup_resources: bool = True
    wait_for_completion: bool = True
    timeout: float | None = 5.0
    force_stop_on_timeout: bool = True
    progress_callback_interval: float = 0.1

    def _get_equality_components(self,
    ) -> tuple[object, ...]:
        return (
            self.shutdown_strategy,
            self.disconnect_signals,
            self.cleanup_resources,
            self.wait_for_completion,
            self.timeout,
            self.force_stop_on_timeout,
            self.progress_callback_interval,
        )

    def __invariants__(self) -> None:
        if self.timeout is not None and self.timeout <= 0:
            msg = "Timeout must be positive"
            raise ValueError(msg)
        if self.progress_callback_interval <= 0:
            msg = "Progress callback interval must be positive"
            raise ValueError(msg,
    )