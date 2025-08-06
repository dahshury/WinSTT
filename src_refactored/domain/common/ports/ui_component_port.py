"""UI Component Port for domain layer abstractions."""

from abc import ABC, abstractmethod
from enum import Enum
from typing import Any

from src_refactored.domain.common.result import Result


class UIEventType(Enum):
    """Types of UI events."""
    WORKER_START_REQUESTED = "worker_start_requested"
    WORKER_STOP_REQUESTED = "worker_stop_requested"
    WORKER_STATUS_REQUESTED = "worker_status_requested"
    TRANSCRIPTION_REQUESTED = "transcription_requested"
    RECORDING_STARTED = "recording_started"
    RECORDING_STOPPED = "recording_stopped"


class UIEvent:
    """UI event data structure."""
    
    def __init__(self, event_type: UIEventType, data: dict[str, Any] | None = None):
        """Initialize UI event.
        
        Args:
            event_type: Type of the event
            data: Event data payload
        """
        self.event_type = event_type
        self.data = data or {}


class IUIComponent(ABC):
    """Interface for UI components in the domain layer."""
    
    @abstractmethod
    def initialize(self) -> Result[None]:
        """Initialize the UI component.
        
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def cleanup(self) -> None:
        """Cleanup component resources."""
        ...


class IUIEventHandler(ABC):
    """Interface for handling UI events."""
    
    @abstractmethod
    def handle_event(self, event: UIEvent) -> Result[None]:
        """Handle a UI event.
        
        Args:
            event: The UI event to handle
            
        Returns:
            Result indicating success or failure
        """
        ...
