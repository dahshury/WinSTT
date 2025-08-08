"""Thread Instance Entity.

This module defines the domain entity for thread instances.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from src_refactored.domain.common.domain_utils import DomainIdentityGenerator


class ThreadState(Enum):
    """Thread state enumeration."""
    NOT_STARTED = "not_started"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FINISHED = "finished"
    ERROR = "error"


@dataclass
class ThreadInstance:
    """Domain entity representing a thread instance."""
    
    thread_id: str
    name: str
    is_daemon: bool = False
    state: ThreadState = ThreadState.NOT_STARTED
    created_at: float = field(default_factory=DomainIdentityGenerator.generate_timestamp)
    started_at: float | None = None
    finished_at: float | None = None
    properties: dict[str, Any] = field(default_factory=dict)
    error_message: str | None = None
    
    def start(self) -> None:
        """Mark thread as started."""
        self.state = ThreadState.RUNNING
        self.started_at = DomainIdentityGenerator.generate_timestamp()
        self.finished_at = None
        self.error_message = None
    
    def stop(self) -> None:
        """Mark thread as stopped."""
        self.state = ThreadState.STOPPED
        if not self.finished_at:
            self.finished_at = DomainIdentityGenerator.generate_timestamp()
    
    def finish(self) -> None:
        """Mark thread as finished normally."""
        self.state = ThreadState.FINISHED
        self.finished_at = DomainIdentityGenerator.generate_timestamp()
    
    def set_error(self, error_message: str) -> None:
        """Set thread error state.
        
        Args:
            error_message: Error message
        """
        self.state = ThreadState.ERROR
        self.error_message = error_message
        self.finished_at = DomainIdentityGenerator.generate_timestamp()
    
    def set_stopping(self) -> None:
        """Mark thread as stopping."""
        self.state = ThreadState.STOPPING
    
    def set_starting(self) -> None:
        """Mark thread as starting."""
        self.state = ThreadState.STARTING
    
    def is_running(self) -> bool:
        """Check if thread is running.
        
        Returns:
            True if thread is in running state
        """
        return self.state == ThreadState.RUNNING
    
    def is_alive(self) -> bool:
        """Check if thread is alive.
        
        Returns:
            True if thread is running or starting
        """
        return self.state in (ThreadState.RUNNING, ThreadState.STARTING)
    
    def is_finished(self) -> bool:
        """Check if thread is finished.
        
        Returns:
            True if thread finished normally or with error
        """
        return self.state in (ThreadState.FINISHED, ThreadState.STOPPED, ThreadState.ERROR)
    
    def get_runtime(self) -> float:
        """Get thread runtime in seconds.
        
        Returns:
            Runtime in seconds since start
        """
        if not self.started_at:
            return 0.0
        
        end_value = self.finished_at or DomainIdentityGenerator.generate_timestamp()
        return float(end_value - (self.started_at or end_value))
    
    def set_property(self, key: str, value: Any) -> None:
        """Set thread property.
        
        Args:
            key: Property key
            value: Property value
        """
        self.properties[key] = value
    
    def get_property(self, key: str, default: Any = None) -> Any:
        """Get thread property.
        
        Args:
            key: Property key
            default: Default value if key not found
            
        Returns:
            Property value or default
        """
        return self.properties.get(key, default)
