"""Event system domain value objects.

This module contains domain concepts for the comprehensive event system
with CQRS, mediator pattern, and event management.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Generic, TypeVar
from uuid import uuid4

TEvent = TypeVar("TEvent")
TCommand = TypeVar("TCommand")
TQuery = TypeVar("TQuery")
TResult = TypeVar("TResult")


class EventPriority(Enum):
    """Event processing priority levels."""
    CRITICAL = 1
    HIGH = 2
    NORMAL = 3
    LOW = 4
    BACKGROUND = 5


class EventStatus(Enum):
    """Event processing status."""
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class UIEvent:
    """Base class for all UI events."""
    event_id: str = field(default_factory=lambda: str(uuid4()))
    event_type: str = field(default="")
    timestamp: float = field(default=0.0)
    source: str = field(default="",
    )
    data: dict[str, Any] = field(default_factory=dict)
    priority: EventPriority = EventPriority.NORMAL
    status: EventStatus = EventStatus.PENDING
    correlation_id: str | None = None
    causation_id: str | None = None

    def __post_init__(self) -> None:
        """Set event type from class name if not provided."""
        if not self.event_type:
            self.event_type = self.__class__.__name__


@dataclass
class EventSubscription:
    """Represents an event subscription."""
    subscription_id: str = field(default_factory=lambda: str(uuid4()))
    event_type: type[UIEvent] = field(default=UIEvent,
    )
    priority: EventPriority = EventPriority.NORMAL
    is_async: bool = False
    filter_func: Any = None  # Callable[[UIEvent], bool] | None
    created_at: float = field(default=0.0)
    last_triggered: float = field(default=0.0,
    )
    trigger_count: int = 0


class IObserver(ABC, Generic[TEvent]):
    """Observer interface for event handling."""

    @abstractmethod
    def on_event(self, event: TEvent,
    ) -> None:
        """Handle an event."""


class IObservable(ABC, Generic[TEvent]):
    """Observable interface for event publishing."""

    @abstractmethod
    def subscribe(self, observer: IObserver[TEvent], event_type: type[TEvent]) -> str:
        """Subscribe to events."""

    @abstractmethod
    def unsubscribe(self, subscription_id: str,
    ) -> bool:
        """Unsubscribe from events."""

    @abstractmethod
    def publish(self, event: TEvent,
    ) -> None:
        """Publish an event."""


class ICommand(ABC):
    """Base interface for commands in CQRS pattern."""


class IQuery(ABC, Generic[TResult]):
    """Base interface for queries in CQRS pattern."""


class ICommandHandler(ABC, Generic[TCommand]):
    """Interface for command handlers."""

    @abstractmethod
    def handle(self, command: TCommand,
    ) -> Any:
        """Handle a command."""


class IQueryHandler(ABC, Generic[TQuery, TResult]):
    """Interface for query handlers."""

    @abstractmethod
    def handle(self, query: TQuery,
    ) -> TResult:
        """Handle a query."""


class IMediator(ABC):
    """Mediator interface for command/query handling."""

    @abstractmethod
    def send_command(self, command: ICommand,
    ) -> Any:
        """Send a command."""

    @abstractmethod
    def send_query(self, query: IQuery[TResult]) -> TResult:
        """Send a query."""


@dataclass
class EventMetrics:
    """Metrics for event system performance."""
    events_published: int = 0
    events_processed: int = 0
    failed_events: int = 0
    active_subscriptions: int = 0
    average_processing_time: float = 0.0
    peak_processing_time: float = 0.0
    total_processing_time: float = 0.0