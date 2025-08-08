"""Cache Key Port Interface.

Defines a strategy interface for generating deterministic cache keys
without binding the application layer to specific hashing/serialization libs.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class ICacheKeyPort(ABC):
    """Port for generating cache keys for external service calls and queries."""

    @abstractmethod
    def generate_key(
        self,
        *,
        service_name: str,
        operation_name: str,
        parameters: dict[str, Any] | None = None,
    ) -> str:
        """Generate a deterministic cache key string.

        Args:
            service_name: The name of the external service
            operation_name: The operation invoked on the service
            parameters: Operation parameters (must be JSON-serializable by the adapter)

        Returns:
            A stable, URL-safe key string.
        """
        ...


