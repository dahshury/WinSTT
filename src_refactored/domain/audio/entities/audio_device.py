"""Audio Device Entity.

This module defines the AudioDevice entity that represents
audio input/output devices in the domain.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from src_refactored.domain.common.entity import Entity
from src_refactored.domain.common.value_object import ValueObject


class DeviceType(Enum):
    """Audio device types."""
    INPUT = "input"
    OUTPUT = "output"
    BOTH = "both"


@dataclass(frozen=True)
class DeviceCapabilities(ValueObject):
    """Audio device capabilities."""

    max_input_channels: int
    max_output_channels: int
    default_sample_rate: float
    supported_sample_rates: list[float]
    latency_low: float = 0.0
    latency_high: float = 0.0
    host_api: str | None = None

    def _get_equality_components(self,
    ) -> tuple:
        return (
            self.max_input_channels,
            self.max_output_channels,
            self.default_sample_rate,
            tuple(self.supported_sample_rates)
            self.latency_low,
            self.latency_high,
            self.host_api,
        )

    def __invariants__(self) -> None:
        if self.max_input_channels < 0:
            msg = "Max input channels cannot be negative"
            raise ValueError(msg)
        if self.max_output_channels < 0:
            msg = "Max output channels cannot be negative"
            raise ValueError(msg)
        if self.default_sample_rate <= 0:
            msg = "Default sample rate must be positive"
            raise ValueError(msg)
        if not self.supported_sample_rates:
            msg = "Supported sample rates cannot be empty"
            raise ValueError(msg)
        if self.latency_low < 0:
            msg = "Low latency cannot be negative"
            raise ValueError(msg)
        if self.latency_high < self.latency_low:
            msg = "High latency cannot be less than low latency"
            raise ValueError(msg)

    @property
    def supports_input(self) -> bool:
        """Check if device supports input."""
        return self.max_input_channels > 0

    @property
    def supports_output(self) -> bool:
        """Check if device supports output."""
        return self.max_output_channels > 0

    @property
    def device_type(self) -> DeviceType:
        """Get device type based on capabilities."""
        if self.supports_input and self.supports_output:
            return DeviceType.BOTH
        if self.supports_input:
            return DeviceType.INPUT
        if self.supports_output:
            return DeviceType.OUTPUT
        msg = "Device must support at least input or output"
        raise ValueError(msg)


@dataclass
class AudioDevice(Entity[int],
    ):
    """Audio device entity representing physical audio hardware."""

    device_id: int
    name: str
    capabilities: DeviceCapabilities
    is_default_input: bool = False
    is_default_output: bool = False
    is_available: bool = True
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        super().__init__(self.device_id)
        self.validate()

    def __invariants__(self) -> None:
        if not self.name or not self.name.strip():
            msg = "Device name cannot be empty"
            raise ValueError(msg)
        if self.device_id < 0:
            msg = "Device ID cannot be negative"
            raise ValueError(msg)
        if not self.capabilities:
            msg = "Device must have capabilities"
            raise ValueError(msg)

    @property
    def supports_sample_rate(self) -> bool:
        """Check if device supports a specific sample rate."""
        def check_rate(sample_rate: float) -> bool:
            return sample_rate in self.capabilities.supported_sample_rates
        return check_rate

    @property
    def can_record(self) -> bool:
        """Check if device can be used for recording."""
        return self.capabilities.supports_input and self.is_available

    @property
    def can_playback(self,
    ) -> bool:
        """Check if device can be used for playback."""
        return self.capabilities.supports_output and self.is_available

    def set_availability(self, available: bool,
    ) -> None:
        """Set device availability status."""
        self.is_available = available
        self.mark_as_updated()

    def update_metadata(self, metadata: dict[str, Any]) -> None:
        """Update device metadata."""
        self.metadata.update(metadata)
        self.mark_as_updated()

    def get_optimal_buffer_size(self, sample_rate: float,
    ) -> int:
        """Get optimal buffer size for the given sample rate."""
        # Calculate based on latency and sample rate
        target_latency = self.capabilities.latency_low
        if target_latency <= 0:
            target_latency = 0.01  # 10ms default

        buffer_size = int(sample_rate * target_latency,
    )

        # Round to nearest power of 2 for efficiency
        power = 1
        while power < buffer_size:
            power *= 2

        return min(power, 8192)  # Cap at 8192 samples