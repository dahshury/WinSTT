"""
UI Abstractions and Base Classes

This module defines the core abstractions that form the foundation of our UI architecture.
Following Domain-Driven Design principles and SOLID design patterns.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Generic, Protocol, TypeVar

from PyQt6.QtCore import QObject

if TYPE_CHECKING:
    from collections.abc import Callable

    from PyQt6.QtWidgets import QWidget

# Type Variables for Generic Patterns
T = TypeVar("T")
TCommand = TypeVar("TCommand", bound="ICommand")
TQuery = TypeVar("TQuery", bound="IQuery")
TResult = TypeVar("TResult")
TState = TypeVar("TState")
TEvent = TypeVar("TEvent", bound="UIEvent")

# ============================================================================
# RESULT PATTERN (Railway-Oriented Programming)
# ============================================================================

@dataclass(frozen=True)
class Result(Generic[T]):
    """
    Functional Result pattern for handling success/failure states.
    Eliminates exception-driven control flow.
    """
    value: T | None = None
    error: str | None = None
    is_success: bool = True
    
    @classmethod
    def success(cls, value: T) -> Result[T]:
        """Create a successful result."""
        return cls(value=value, is_success=True)
    
    @classmethod
    def failure(cls, error: str) -> Result[T]:
        """Create a failure result."""
        return cls(error=error, is_success=False)
    
    def map(self, func) -> Result:
        """Transform the value if successful."""
        if self.is_success and self.value is not None:
            try:
                return Result.success(func(self.value))
            except Exception as e:
                return Result.failure(str(e))
        return self
    
    def bind(self, func) -> Result:
        """Monadic bind operation for chaining operations."""
        if self.is_success and self.value is not None:
            return func(self.value)
        return self

# ============================================================================
# DOMAIN EVENTS
# ============================================================================

@dataclass(frozen=True)
class UIEvent:
    """Base class for all UI domain events."""
    event_id: str
    timestamp: float
    source: str
    
    def __post_init__(self):
        import time
        import uuid
        if not self.event_id:
            object.__setattr__(self, "event_id", str(uuid.uuid4()))
        if not self.timestamp:
            object.__setattr__(self, "timestamp", time.time())

class UIEventType(Enum):
    """Enumeration of UI event types."""
    WIDGET_CREATED = "widget_created"
    WIDGET_DESTROYED = "widget_destroyed"
    STATE_CHANGED = "state_changed"
    USER_ACTION = "user_action"
    VALIDATION_FAILED = "validation_failed"
    PROGRESS_UPDATED = "progress_updated"
    ERROR_OCCURRED = "error_occurred"

# ============================================================================
# COMMAND PATTERN INTERFACES
# ============================================================================

class ICommand(Protocol):
    """Interface for command pattern implementation."""
    
    def execute(self) -> Result[Any]:
        """Execute the command."""
        ...
    
    def undo(self) -> Result[Any]:
        """Undo the command (if supported)."""
        ...
    
    def can_execute(self) -> bool:
        """Check if command can be executed."""
        ...

class IQuery(Protocol, Generic[TResult]):
    """Interface for query pattern implementation (CQRS)."""
    
    def execute(self) -> Result[TResult]:
        """Execute the query and return result."""
        ...

# ============================================================================
# OBSERVER PATTERN
# ============================================================================

class IObserver(Protocol, Generic[TEvent]):
    """Observer interface for event notifications."""
    
    def notify(self, event: TEvent) -> None:
        """Handle event notification."""
        ...

class IObservable(Protocol, Generic[TEvent]):
    """Observable interface for event publishers."""
    
    def subscribe(self, observer: IObserver[TEvent]) -> None:
        """Subscribe an observer."""
        ...
    
    def unsubscribe(self, observer: IObserver[TEvent]) -> None:
        """Unsubscribe an observer."""
        ...
    
    def notify_observers(self, event: TEvent) -> None:
        """Notify all observers of an event."""
        ...

# ============================================================================
# MEDIATOR PATTERN
# ============================================================================

class IMediator(Protocol):
    """Mediator interface for decoupled communication."""
    
    def send_command(self, command: ICommand) -> Result[Any]:
        """Send a command through the mediator."""
        ...
    
    def send_query(self, query: IQuery[TResult]) -> Result[TResult]:
        """Send a query through the mediator."""
        ...
    
    def publish_event(self, event: UIEvent) -> None:
        """Publish an event through the mediator."""
        ...

# ============================================================================
# DEPENDENCY INJECTION ABSTRACTIONS
# ============================================================================

class IServiceProvider(Protocol):
    """Service provider interface for dependency injection."""
    
    def get_service(self, service_type: type[T]) -> T:
        """Get a service by type."""
        ...
    
    def register_singleton(self, service_type: type[T], implementation: T) -> None:
        """Register a singleton service."""
        ...
    
    def register_transient(self, service_type: type[T], factory: Callable[[], T]) -> None:
        """Register a transient service."""
        ...

# ============================================================================
# UI COMPONENT ABSTRACTIONS
# ============================================================================

class IUIComponent(Protocol):
    """Base interface for all UI components."""
    
    @property
    def widget(self) -> QWidget:
        """Get the underlying Qt widget."""
        ...
    
    def initialize(self) -> Result[None]:
        """Initialize the component."""
        ...
    
    def cleanup(self) -> None:
        """Cleanup resources."""
        ...

class IUIState(Protocol, Generic[TState]):
    """Interface for UI state management."""
    
    @property
    def current_state(self) -> TState:
        """Get current state."""
        ...
    
    def update_state(self, new_state: TState) -> Result[None]:
        """Update state with validation."""
        ...
    
    def reset_state(self) -> None:
        """Reset to initial state."""
        ...

class IUIValidator(Protocol, Generic[T]):
    """Interface for UI validation."""
    
    def validate(self, value: T) -> Result[T]:
        """Validate a value."""
        ...

class IUIFactory(Protocol, Generic[T]):
    """Interface for UI factories."""
    
    def create(self, **kwargs) -> Result[T]:
        """Create an instance."""
        ...

# ============================================================================
# PRESENTER/VIEW PATTERN (MVP)
# ============================================================================

class IView(Protocol):
    """View interface in MVP pattern."""
    
    def show_error(self, message: str) -> None:
        """Display error message."""
        ...
    
    def show_success(self, message: str) -> None:
        """Display success message."""
        ...
    
    def show_loading(self, is_loading: bool) -> None:
        """Show/hide loading state."""
        ...

class IPresenter(Protocol):
    """Presenter interface in MVP pattern."""
    
    def attach_view(self, view: IView) -> None:
        """Attach a view to this presenter."""
        ...
    
    def detach_view(self) -> None:
        """Detach the current view."""
        ...

# ============================================================================
# STRATEGY PATTERN
# ============================================================================

class IStrategy(Protocol, Generic[T, TResult]):
    """Strategy interface for behavior variations."""
    
    def execute(self, context: T) -> Result[TResult]:
        """Execute the strategy."""
        ...

# ============================================================================
# REPOSITORY PATTERN FOR UI STATE
# ============================================================================

class IUIRepository(Protocol, Generic[T]):
    """Repository interface for UI state persistence."""
    
    def save(self, entity: T) -> Result[None]:
        """Save an entity."""
        ...
    
    def load(self, identifier: str) -> Result[T]:
        """Load an entity by identifier."""
        ...
    
    def delete(self, identifier: str) -> Result[None]:
        """Delete an entity."""
        ...

# ============================================================================
# AGGREGATE ROOT FOR UI COMPONENTS
# ============================================================================

class UIAggregateRoot(QObject):
    """
    Base class for UI aggregate roots following DDD principles.
    Manages domain events and ensures consistency within aggregates.
    """
    
    def __init__(self):
        super().__init__()
        self._domain_events: list[UIEvent] = []
        self._is_initialized = False
    
    def add_domain_event(self, event: UIEvent) -> None:
        """Add a domain event to be published."""
        self._domain_events.append(event)
    
    def get_domain_events(self) -> list[UIEvent]:
        """Get all pending domain events."""
        return self._domain_events.copy()
    
    def clear_domain_events(self) -> None:
        """Clear all pending domain events."""
        self._domain_events.clear()
    
    @property
    def is_initialized(self) -> bool:
        """Check if aggregate is initialized."""
        return self._is_initialized
    
    def mark_as_initialized(self) -> None:
        """Mark aggregate as initialized."""
        self._is_initialized = True

# ============================================================================
# VALUE OBJECTS FOR UI
# ============================================================================

@dataclass(frozen=True)
class UIPosition:
    """Value object for UI positioning."""
    x: int
    y: int
    
    def __post_init__(self):
        if self.x < 0 or self.y < 0:
            msg = "Position coordinates must be non-negative"
            raise ValueError(msg)

@dataclass(frozen=True)
class UISize:
    """Value object for UI sizing."""
    width: int
    height: int
    
    def __post_init__(self):
        if self.width <= 0 or self.height <= 0:
            msg = "Size dimensions must be positive"
            raise ValueError(msg)

@dataclass(frozen=True)
class UIBounds:
    """Value object for UI boundaries."""
    position: UIPosition
    size: UISize
    
    @property
    def right(self) -> int:
        return self.position.x + self.size.width
    
    @property
    def bottom(self) -> int:
        return self.position.y + self.size.height

# ============================================================================
# ENTITY BASE CLASS
# ============================================================================

class UIEntity:
    """Base class for UI entities with identity."""
    
    def __init__(self, entity_id: str):
        self._id = entity_id
        self._created_at = self._current_timestamp()
        self._updated_at = self._created_at
    
    @property
    def id(self) -> str:
        """Get entity identifier."""
        return self._id
    
    @property
    def created_at(self) -> float:
        """Get creation timestamp."""
        return self._created_at
    
    @property
    def updated_at(self) -> float:
        """Get last update timestamp."""
        return self._updated_at
    
    def mark_as_updated(self) -> None:
        """Mark entity as updated."""
        self._updated_at = self._current_timestamp()
    
    def __eq__(self, other) -> bool:
        """Entities are equal if they have the same ID."""
        if not isinstance(other, UIEntity):
            return False
        return self._id == other._id
    
    def __hash__(self) -> int:
        """Hash based on entity ID."""
        return hash(self._id)
    
    @staticmethod
    def _current_timestamp() -> float:
        """Get current timestamp."""
        import time
        return time.time()

__all__ = [
    # Command/Query Interfaces
    "ICommand",
    # Mediator Pattern
    "IMediator",
    "IObservable",
    # Observer Pattern
    "IObserver",
    "IPresenter",
    "IQuery",
    # Dependency Injection
    "IServiceProvider",
    # Strategy Pattern
    "IStrategy",
    # UI Interfaces
    "IUIComponent",
    "IUIFactory",
    # Repository Pattern
    "IUIRepository",
    "IUIState",
    "IUIValidator",
    # MVP Pattern
    "IView",
    # Result Pattern
    "Result",
    # Type Variables
    "T",
    "TCommand",
    "TEvent",
    "TQuery",
    "TResult",
    "TState",
    # DDD Building Blocks
    "UIAggregateRoot",
    "UIBounds",
    "UIEntity",
    # Events
    "UIEvent",
    "UIEventType",
    # Value Objects
    "UIPosition",
    "UISize",
] 