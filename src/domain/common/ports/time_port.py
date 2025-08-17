"""Time Port Interface.

This module defines the port interface for time operations in the domain layer.
"""

from abc import ABC, abstractmethod
from datetime import datetime


class ITimePort(ABC):
    """Port interface for time operations."""

    @abstractmethod
    def get_current_time(self) -> float:
        """Get current time as timestamp.
        
        Returns:
            Current time as seconds since epoch
        """
        ...

    @abstractmethod
    def get_current_datetime(self) -> datetime:
        """Get current datetime.
        
        Returns:
            Current datetime object
        """
        ...

    @abstractmethod
    def sleep(self, duration: float) -> None:
        """Sleep for specified duration.
        
        Args:
            duration: Sleep duration in seconds
        """
        ...

    @abstractmethod
    def get_monotonic_time(self) -> float:
        """Get monotonic time for performance measurements.
        
        Returns:
            Monotonic time in seconds
        """
        ...

    @abstractmethod
    def format_duration(self, duration: float) -> str:
        """Format duration for display.
        
        Args:
            duration: Duration in seconds
            
        Returns:
            Formatted duration string
        """
        ...

    @abstractmethod
    def get_timestamp_string(self, timestamp: float | None = None) -> str:
        """Get timestamp as string.
        
        Args:
            timestamp: Optional timestamp, uses current time if None
            
        Returns:
            Formatted timestamp string
        """
        ...
