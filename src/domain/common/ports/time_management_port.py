"""Time Management Port.

This module defines the port for time-related operations
without direct dependency on system time implementations.
"""

from abc import ABC, abstractmethod
from datetime import datetime
from typing import TYPE_CHECKING

from src.domain.common.result import Result

if TYPE_CHECKING:
    from src.domain.common.value_objects import Timestamp


class TimeManagementPort(ABC):
    """Port for time management operations."""

    @abstractmethod
    def get_current_time(self) -> Result["Timestamp"]:
        """Get the current system time.
        
        Returns:
            Result with current Timestamp
        """

    @abstractmethod
    def get_current_timestamp_ms(self) -> Result[float]:
        """Get the current timestamp in milliseconds.
        
        Returns:
            Result with timestamp in milliseconds
        """

    @abstractmethod
    def get_current_datetime(self) -> Result[datetime]:
        """Get the current system time as a datetime object.
        
        Returns:
            Result with current datetime
        """

    @abstractmethod
    def sleep(self, duration_seconds: float) -> Result[None]:
        """Sleep for the specified duration.
        
        Args:
            duration_seconds: Duration to sleep in seconds
            
        Returns:
            Result of operation
        """

    @abstractmethod
    def measure_execution_time(self, operation_id: str) -> Result[str]:
        """Start measuring execution time for an operation.
        
        Args:
            operation_id: Unique identifier for the operation
            
        Returns:
            Result with measurement ID
        """

    @abstractmethod
    def get_execution_time_ms(self, measurement_id: str) -> Result[float]:
        """Get elapsed time for a measurement.
        
        Args:
            measurement_id: Measurement identifier
            
        Returns:
            Result with elapsed time in milliseconds
        """

    @abstractmethod
    def stop_measurement(self, measurement_id: str) -> Result[float]:
        """Stop a time measurement and get final duration.
        
        Args:
            measurement_id: Measurement identifier
            
        Returns:
            Result with total elapsed time in milliseconds
        """

