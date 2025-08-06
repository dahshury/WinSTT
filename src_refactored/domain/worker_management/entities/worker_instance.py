"""Worker Instance Entity.

This module defines the domain entity for worker instances.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from src_refactored.domain.worker_management.value_objects.worker_operations import WorkerType


class WorkerState(Enum):
    """Worker state enumeration."""
    INACTIVE = "inactive"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    ERROR = "error"


@dataclass
class WorkerInstance:
    """Domain entity representing a worker instance."""
    
    worker_id: str
    worker_type: WorkerType
    name: str
    state: WorkerState = WorkerState.INACTIVE
    created_at: datetime = field(default_factory=datetime.utcnow)
    started_at: datetime | None = None
    stopped_at: datetime | None = None
    properties: dict[str, Any] = field(default_factory=dict)
    error_message: str | None = None
    
    def start(self) -> None:
        """Mark worker as started."""
        self.state = WorkerState.RUNNING
        self.started_at = datetime.utcnow()
        self.stopped_at = None
        self.error_message = None
    
    def stop(self) -> None:
        """Mark worker as stopped."""
        self.state = WorkerState.STOPPED
        self.stopped_at = datetime.utcnow()
    
    def set_error(self, error_message: str) -> None:
        """Set worker error state.
        
        Args:
            error_message: Error message
        """
        self.state = WorkerState.ERROR
        self.error_message = error_message
        self.stopped_at = datetime.utcnow()
    
    def set_stopping(self) -> None:
        """Mark worker as stopping."""
        self.state = WorkerState.STOPPING
    
    def set_starting(self) -> None:
        """Mark worker as starting."""
        self.state = WorkerState.STARTING
    
    def is_active(self) -> bool:
        """Check if worker is active.
        
        Returns:
            True if worker is running or starting
        """
        return self.state in (WorkerState.RUNNING, WorkerState.STARTING)
    
    def is_running(self) -> bool:
        """Check if worker is running.
        
        Returns:
            True if worker is in running state
        """
        return self.state == WorkerState.RUNNING
    
    def get_uptime(self) -> float:
        """Get worker uptime in seconds.
        
        Returns:
            Uptime in seconds since start
        """
        if not self.started_at:
            return 0.0
        
        end_time = self.stopped_at or datetime.utcnow()
        return (end_time - self.started_at).total_seconds()
    
    def set_property(self, key: str, value: Any) -> None:
        """Set worker property.
        
        Args:
            key: Property key
            value: Property value
        """
        self.properties[key] = value
    
    def get_property(self, key: str, default: Any = None) -> Any:
        """Get worker property.
        
        Args:
            key: Property key
            default: Default value if key not found
            
        Returns:
            Property value or default
        """
        return self.properties.get(key, default)
