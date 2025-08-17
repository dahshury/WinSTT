"""Hardware Capabilities Port.

Defines an abstract port for querying hardware/model acceleration capabilities
without importing runtime-specific libraries in the domain or presentation layers.
"""

from abc import ABC, abstractmethod
from collections.abc import Sequence


class IHardwareCapabilitiesPort(ABC):
    """Port interface for hardware/model acceleration capabilities."""

    @abstractmethod
    def has_gpu_acceleration(self) -> bool:
        """Return True if GPU acceleration is available for models (e.g., ONNX)."""
        ...

    @abstractmethod
    def get_available_providers(self) -> Sequence[str]:
        """Return a list of available execution providers, if applicable."""
        ...


