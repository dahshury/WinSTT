"""Platform Service Port Interface.

This module defines the port interface for platform-specific operations.
"""

from abc import ABC, abstractmethod
from typing import Any


class IPlatformServicePort(ABC):
    """Port interface for platform-specific operations."""

    @abstractmethod
    def get_win32gui_module(self) -> Any | None:
        """Get the win32gui module if available.
        
        Returns:
            The win32gui module if available, None otherwise
        """
        ...

    @abstractmethod
    def is_windows_platform(self) -> bool:
        """Check if running on Windows platform.
        
        Returns:
            True if running on Windows
        """
        ...

    @abstractmethod
    def get_platform_info(self) -> dict[str, str]:
        """Get platform information.
        
        Returns:
            Dictionary containing platform details
        """
        ...

    @abstractmethod
    def has_capability(self, capability: str) -> bool:
        """Check if platform has specific capability.
        
        Args:
            capability: The capability to check for
            
        Returns:
            True if capability is available
        """
        ...
