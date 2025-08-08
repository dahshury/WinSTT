"""Event system value objects and interfaces for UI coordination.

This module provides domain-level abstractions for the event system following
Domain-Driven Design principles.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Generic, TypeVar

from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject


class EventPriority(Enum):
    """Event priority levels."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


class EventStatus(Enum):
    """Event processing status."""
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class EventMetrics(ValueObject):
    """Event performance metrics."""
    event_count: int = 0
    processing_time_ms: float = 0.0
    failed_count: int = 0
    retry_count: int = 0
    last_processed_at: float = 0.0
    
    @property
    def success_rate(self) -> float:
        """Calculate success rate."""
        if self.event_count == 0:
            return 0.0
        return (self.event_count - self.failed_count) / self.event_count
    
    @property
    def average_processing_time(self) -> float:
        """Calculate average processing time."""
        if self.event_count == 0:
            return 0.0
        return self.processing_time_ms / self.event_count


@dataclass(frozen=True)
class EventSubscription(ValueObject):
    """Event subscription configuration."""
    event_type: str
    subscriber_id: str
    priority: EventPriority = EventPriority.NORMAL
    filter_criteria: dict[str, Any] = field(default_factory=dict)
    max_retries: int = 3
    is_active: bool = True


# Command interfaces for CQRS pattern
class ICommand(ABC):
    """Base interface for commands in CQRS pattern."""


TCommand = TypeVar("TCommand", bound=ICommand)
TResult = TypeVar("TResult")


class ICommandHandler(ABC, Generic[TCommand]):
    """Base interface for command handlers."""
    
    @abstractmethod
    def handle(self, command: TCommand) -> Result[Any]:
        """Handle the command.
        
        Args:
            command: Command to handle
            
        Returns:
            Result of command execution
        """
        ...


class IQuery(ABC, Generic[TResult]):
    """Base interface for queries in CQRS pattern."""


TQuery = TypeVar("TQuery", bound=IQuery)


class IQueryHandler(ABC, Generic[TQuery, TResult]):
    """Base interface for query handlers."""
    
    @abstractmethod
    def handle(self, query: TQuery) -> Result[TResult]:
        """Handle the query.
        
        Args:
            query: Query to handle
            
        Returns:
            Result of query execution
        """
        ...


class IEvent(ABC):
    """Base interface for domain events."""
    
    @property
    @abstractmethod
    def event_type(self) -> str:
        """Get the event type identifier."""
        ...
    
    @property
    @abstractmethod
    def timestamp(self) -> float:
        """Get the event timestamp."""
        ...


class IEventHandler(ABC):
    """Base interface for event handlers."""
    
    @abstractmethod
    def handle(self, event: IEvent) -> Result[None]:
        """Handle the event.
        
        Args:
            event: Event to handle
            
        Returns:
            Result of event handling
        """
        ...


class IEventBus(ABC):
    """Port interface for event bus operations."""
    
    @abstractmethod
    def publish(self, event: IEvent) -> Result[None]:
        """Publish an event.
        
        Args:
            event: Event to publish
            
        Returns:
            Result of publishing operation
        """
        ...
    
    @abstractmethod
    def subscribe(self, subscription: EventSubscription, handler: IEventHandler) -> Result[str]:
        """Subscribe to events.
        
        Args:
            subscription: Subscription configuration
            handler: Event handler
            
        Returns:
            Result containing subscription ID
        """
        ...
    
    @abstractmethod
    def unsubscribe(self, subscription_id: str) -> Result[None]:
        """Unsubscribe from events.
        
        Args:
            subscription_id: ID of subscription to remove
            
        Returns:
            Result of unsubscription operation
        """
        ...
    
    @abstractmethod
    def get_metrics(self) -> Result[EventMetrics]:
        """Get event bus metrics.
        
        Returns:
            Result containing current metrics
        """
        ...


class IMediator(ABC):
    """Port interface for mediator pattern implementation."""
    
    @abstractmethod
    def send_command(self, command: ICommand) -> Result[Any]:
        """Send a command for processing.
        
        Args:
            command: Command to send
            
        Returns:
            Result of command processing
        """
        ...
    
    @abstractmethod
    def send_query(self, query: IQuery) -> Result[Any]:
        """Send a query for processing.
        
        Args:
            query: Query to send
            
        Returns:
            Result of query processing
        """
        ...
    
    @abstractmethod
    def publish_event(self, event: IEvent) -> Result[None]:
        """Publish an event.
        
        Args:
            event: Event to publish
            
        Returns:
            Result of publishing operation
        """
        ...


# Observer pattern interfaces
T = TypeVar("T")


class IObserver(Generic[T], ABC):
    """Observer interface for the observer pattern."""
    
    @abstractmethod
    def on_next(self, value: T) -> None:
        """Handle next value.
        
        Args:
            value: The value to handle
        """
        ...
    
    @abstractmethod
    def on_error(self, error: Exception) -> None:
        """Handle error.
        
        Args:
            error: The error to handle
        """
        ...
    
    @abstractmethod
    def on_complete(self) -> None:
        """Handle completion."""
        ...


class IObservable(Generic[T], ABC):
    """Observable interface for the observer pattern."""
    
    @abstractmethod
    def subscribe(self, observer: IObserver[T]) -> str:
        """Subscribe an observer.
        
        Args:
            observer: Observer to subscribe
            
        Returns:
            Subscription ID
        """
        ...
    
    @abstractmethod
    def unsubscribe(self, subscription_id: str) -> None:
        """Unsubscribe an observer.
        
        Args:
            subscription_id: ID of subscription to remove
        """
        ...


# UI-specific event base class
@dataclass(frozen=True)
class UIEvent(ValueObject):
    """Base class for UI events."""
    event_type: str
    timestamp: float
    source_component: str = ""
    target_component: str = ""
    event_data: dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        if self.event_data is None:
            object.__setattr__(self, "event_data", {})
