"""
Processing Status Entity

Represents the status of long-running operations with progress tracking.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from src_refactored.domain.common.value_object import ProgressPercentage, ValueObject


class ProcessingState(Enum):
    """States for processing operations."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class ProcessingStatusData(ValueObject):
    """Value object for processing status data."""
    state: ProcessingState
    progress: ProgressPercentage
    message: str
    error: str | None = None

    def __post_init__(self):
        if self.state == ProcessingState.FAILED and not self.error:
            msg = "Failed processing status must have an error message"
            raise ValueError(msg)


@dataclass
class ProcessingStatus:
    """Entity representing the status of a processing operation."""
    operation_id: str
    started_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now,
    )
    data: ProcessingStatusData = field(default_factory=lambda: ProcessingStatusData(
        state=ProcessingState.PENDING,
        progress=ProgressPercentage(0.0),
        message="Initializing...",
    ))

    def update_progress(self, progress: ProgressPercentage, message: str,
    ) -> None:
        """Update progress and message."""
        self.data = ProcessingStatusData(
            state=ProcessingState.RUNNING,
            progress=progress,
            message=message,
        )
        self.updated_at = datetime.now()

    def complete(self, message: str = "Completed successfully",
    ) -> None:
        """Mark as completed."""
        self.data = ProcessingStatusData(
            state=ProcessingState.COMPLETED,
            progress=ProgressPercentage(100.0),
            message=message,
        )
        self.updated_at = datetime.now()

    def fail(self, error: str,
    ) -> None:
        """Mark as failed with error."""
        self.data = ProcessingStatusData(
            state=ProcessingState.FAILED,
            progress=self.data.progress,
            message=f"Failed: {error}",
            error=error,
        )
        self.updated_at = datetime.now()

    def cancel(self, message: str = "Operation cancelled",
    ) -> None:
        """Mark as cancelled."""
        self.data = ProcessingStatusData(
            state=ProcessingState.CANCELLED,
            progress=self.data.progress,
            message=message,
        )
        self.updated_at = datetime.now()

    @property
    def is_active(self) -> bool:
        """Check if processing is still active."""
        return self.data.state in (ProcessingState.PENDING, ProcessingState.RUNNING)

    @property
    def is_finished(self) -> bool:
        """Check if processing is finished (completed, failed, or cancelled)."""
        return not self.is_active