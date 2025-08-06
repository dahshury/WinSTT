"""Progress Information Value Objects.

This module defines value objects for progress tracking and status reporting.
"""

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any


class ProgressStatus(Enum):
    """Progress status enumeration."""
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


@dataclass(frozen=True)
class ProgressInfo:
    """Progress information value object."""
    
    operation_id: str
    percentage: float  # 0.0 to 100.0
    status: ProgressStatus
    current_step: str | None = None
    total_steps: int | None = None
    current_step_number: int | None = None
    message: str | None = None
    start_time: datetime | None = None
    estimated_completion: datetime | None = None
    metadata: dict[str, Any] | None = None
    
    def __post_init__(self):
        """Validate progress info values."""
        if not (0.0 <= self.percentage <= 100.0):
            msg = "Percentage must be between 0.0 and 100.0"
            raise ValueError(msg)
        
        if self.current_step_number and self.total_steps:
            if not (1 <= self.current_step_number <= self.total_steps):
                msg = "Current step number must be between 1 and total steps"
                raise ValueError(msg)
    
    @property
    def is_complete(self) -> bool:
        """Check if progress is complete."""
        return self.status == ProgressStatus.COMPLETED
    
    @property
    def is_active(self) -> bool:
        """Check if progress is currently active."""
        return self.status == ProgressStatus.IN_PROGRESS
    
    @property
    def has_failed(self) -> bool:
        """Check if progress has failed."""
        return self.status == ProgressStatus.FAILED
    
    @classmethod
    def create_started(
        cls,
        operation_id: str,
        message: str | None = None,
        total_steps: int | None = None,
    ) -> "ProgressInfo":
        """Create progress info for started operation."""
        return cls(
            operation_id=operation_id,
            percentage=0.0,
            status=ProgressStatus.IN_PROGRESS,
            message=message,
            total_steps=total_steps,
            current_step_number=1 if total_steps else None,
            start_time=datetime.utcnow(),
        )
    
    @classmethod
    def create_completed(
        cls,
        operation_id: str,
        message: str | None = None,
    ) -> "ProgressInfo":
        """Create progress info for completed operation."""
        return cls(
            operation_id=operation_id,
            percentage=100.0,
            status=ProgressStatus.COMPLETED,
            message=message or "Operation completed successfully",
        )
    
    @classmethod
    def create_failed(
        cls,
        operation_id: str,
        error_message: str,
    ) -> "ProgressInfo":
        """Create progress info for failed operation."""
        return cls(
            operation_id=operation_id,
            percentage=0.0,
            status=ProgressStatus.FAILED,
            message=error_message,
        )
