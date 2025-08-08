"""UI Status Port for domain layer.

This port defines the interface for UI status updates and notifications
following DDD principles.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum


class StatusType(Enum):
    """Type of status message."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    SUCCESS = "success"
    PROGRESS = "progress"
    RECORDING = "recording"
    TRANSCRIBING = "transcribing"


class StatusDuration(Enum):
    """Duration for status display."""
    BRIEF = 2000  # 2 seconds
    NORMAL = 3000  # 3 seconds
    LONG = 5000  # 5 seconds
    PERSISTENT = -1  # Until manually cleared


@dataclass
class StatusMessage:
    """Domain object for status messages."""
    text: str
    type: StatusType
    duration: StatusDuration = StatusDuration.NORMAL
    progress_value: float | None = None  # 0-100 for progress
    filename: str | None = None  # For file operations
    auto_clear: bool = True
    show_progress_bar: bool = False

    def __post_init__(self):
        """Validate status message."""
        if self.type == StatusType.PROGRESS:
            if self.progress_value is None:
                error_msg = "Progress status requires progress_value"
                raise ValueError(error_msg)
            if not 0 <= self.progress_value <= 100:  # noqa: PLR2004
                error_msg = "Progress value must be between 0 and 100"
                raise ValueError(error_msg)
            self.show_progress_bar = True


@dataclass 
class StatusClearRequest:
    """Request to clear status."""
    clear_progress: bool = True
    reset_to_default: bool = True
    default_message: str = "Ready for transcription"


class UIStatusPort(ABC):
    """Port for UI status updates."""
    
    @abstractmethod
    def show_status(self, message: StatusMessage) -> None:
        """Show a status message."""
        ...
    
    @abstractmethod
    def clear_status(self, request: StatusClearRequest) -> None:
        """Clear current status."""
        ...
    
    @abstractmethod
    def show_progress(self, value: float, text: str = "", filename: str = "") -> None:
        """Show progress update."""
        ...
    
    @abstractmethod
    def hide_progress(self) -> None:
        """Hide progress bar."""
        ...
