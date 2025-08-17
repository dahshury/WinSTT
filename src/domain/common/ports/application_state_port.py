"""Application State Port for application state management."""

from abc import ABC, abstractmethod
from enum import Enum
from typing import Any

from src.domain.common.result import Result


class ApplicationLifecycleState(Enum):
    """Application lifecycle states."""
    INITIALIZING = "initializing"
    STARTING = "starting"
    RUNNING = "running"
    PAUSING = "pausing"
    PAUSED = "paused"
    RESUMING = "resuming"
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"


class IApplicationStatePort(ABC):
    """Port interface for application state management."""
    
    @abstractmethod
    def get_current_state(self) -> Result[ApplicationLifecycleState]:
        """Get current application state.
        
        Returns:
            Result containing current application state
        """
        ...
    
    @abstractmethod
    def set_state(self, state: ApplicationLifecycleState) -> Result[None]:
        """Set application state.
        
        Args:
            state: New application state
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def get_state_data(self, key: str) -> Result[Any]:
        """Get application state data by key.
        
        Args:
            key: State data key
            
        Returns:
            Result containing state data value
        """
        ...
    
    @abstractmethod
    def set_state_data(self, key: str, value: Any) -> Result[None]:
        """Set application state data.
        
        Args:
            key: State data key
            value: State data value
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def remove_state_data(self, key: str) -> Result[None]:
        """Remove application state data by key.
        
        Args:
            key: State data key to remove
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def get_all_state_data(self) -> Result[dict[str, Any]]:
        """Get all application state data.
        
        Returns:
            Result containing all state data
        """
        ...
    
    @abstractmethod
    def clear_state_data(self) -> Result[None]:
        """Clear all application state data.
        
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def persist_state(self) -> Result[None]:
        """Persist current state to storage.
        
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def restore_state(self) -> Result[None]:
        """Restore state from storage.
        
        Returns:
            Result indicating success or failure
        """
        ...