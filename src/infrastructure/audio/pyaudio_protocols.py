"""PyAudio Protocols.

This module defines protocol interfaces used by the PyAudio infrastructure
services. Extracted from the previous monolithic implementation to improve
modularity and adherence to the hexagonal architecture.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from src.domain.audio.value_objects import (
        AudioConfiguration,
    )


class AudioValidationServiceProtocol(Protocol):
    """Protocol for audio validation service."""

    def validate_audio_configuration(self, config: AudioConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate audio configuration."""
        ...

    def validate_stream_configuration(self, config: Any,
    ) -> tuple[bool, str | None]:
        """Validate stream configuration."""
        ...

    def validate_device_compatibility(self,
    device: Any, config: AudioConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate device compatibility with configuration."""
        ...


class DeviceManagementServiceProtocol(Protocol):
    """Protocol for device management service."""

    def enumerate_devices(self) -> tuple[bool, list[Any], str | None]:
        """Enumerate available audio devices."""
        ...

    def get_default_device(self, device_type: Any,
    ) -> tuple[bool, Any | None, str | None]:
        """Get default audio device."""
        ...

    def test_device(self, device: Any, config: AudioConfiguration, duration: float,
    ) -> Any:
        """Test audio device functionality."""
        ...

    def get_device_info(self, device_index: int,
    ) -> tuple[bool, Any | None, str | None]:
        """Get detailed device information."""
        ...


class StreamManagementServiceProtocol(Protocol):
    """Protocol for stream management service."""

    def create_stream(self, config: Any,
    ) -> tuple[bool, Any, str | None]:
        """Create audio stream."""
        ...

    def start_stream(self, stream: Any,
    ) -> tuple[bool, str | None]:
        """Start audio stream."""
        ...

    def stop_stream(self, stream: Any,
    ) -> tuple[bool, str | None]:
        """Stop audio stream."""
        ...

    def close_stream(self, stream: Any,
    ) -> tuple[bool, str | None]:
        """Close audio stream."""
        ...

    def get_stream_info(self, stream: Any,
    ) -> dict[str, Any]:
        """Get stream information."""
        ...


class AudioDataServiceProtocol(Protocol):
    """Protocol for audio data service."""

    def read_audio_data(self,
    stream: Any, chunk_size: int, timeout: float,
    ) -> tuple[bool, Any | None, str | None]:
        """Read audio data from stream."""
        ...

    def write_audio_data(self, stream: Any, data: Any, timeout: float,
    ) -> tuple[bool, str | None]:
        """Write audio data to stream."""
        ...

    def process_audio_callback(self, data: bytes, frame_count: int, config: AudioConfiguration,
    ) -> Any:
        """Process audio callback data."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def start_progress(self, operation: Any,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, operation: Any, progress: float,
    ) -> None:
        """Update progress for current operation."""
        ...

    def complete_progress(self) -> None:
        """Complete progress tracking."""
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging service."""

    def log_info(self, message: str, **kwargs) -> None:
        """Log info message."""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log warning message."""
        ...

    def log_error(self, message: str, **kwargs) -> None:
        """Log error message."""
        ...


__all__ = [
    "AudioValidationServiceProtocol",
    "DeviceManagementServiceProtocol",
    "StreamManagementServiceProtocol",
    "AudioDataServiceProtocol",
    "ProgressTrackingServiceProtocol",
    "LoggerServiceProtocol",
]


