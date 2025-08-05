"""UI Abstractions and Base Classes

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
        """Chain operations that return Results."""
        if self.is_success and self.value is not None:
            return func(self.value)
        return self

# ============================================================================
# EVENT SYSTEM
# ============================================================================

@dataclass(frozen=True)
class UIEvent:
    """Base class for all UI events."""
    event_id: str
    timestamp: float
    source: str
    
    def __post_init__(self):
        if not self.event_id:
            raise ValueError("Event ID cannot be empty")
        if not self.source:
            raise ValueError("Event source cannot be empty")

class UIEventType(Enum):
    """Standard UI event types."""
    WIDGET_CREATED = "widget_created"
    WIDGET_DESTROYED = "widget_destroyed"
    STATE_CHANGED = "state_changed"
    USER_ACTION = "user_action"
    VALIDATION_FAILED = "validation_failed"
    PROGRESS_UPDATED = "progress_updated"
    ERROR_OCCURRED = "error_occurred"

# ============================================================================
# COMMAND AND QUERY PATTERNS (CQRS)
# ============================================================================

class ICommand(Protocol):
    """Interface for commands that modify state."""
    
    def execute(self) -> Result[Any]:
        """Execute the command."""
        ...
    
    def undo(self) -> Result[Any]:
        """Undo the command if possible."""
        ...
    
    def can_execute(self) -> bool:
        """Check if command can be executed."""
        ...

class IQuery(Protocol, Generic[TResult]):
    """Interface for queries that read data."""
    
    def execute(self) -> Result[TResult]:
        """Execute the query and return result."""
        ...

# ============================================================================
# OBSERVER PATTERN
# ============================================================================

class IObserver(Protocol, Generic[TEvent]):
    """Observer interface for event handling."""
    
    def notify(self, event: TEvent) -> None:
        """Handle the event notification."""
        ...

class IObservable(Protocol, Generic[TEvent]):
    """Observable interface for event publishing."""
    
    def subscribe(self, observer: IObserver[TEvent]) -> None:
        """Subscribe an observer to events."""
        ...
    
    def unsubscribe(self, observer: IObserver[TEvent]) -> None:
        """Unsubscribe an observer from events."""
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
# SERVICE PROVIDER PATTERN
# ============================================================================

class IServiceProvider(Protocol):
    """Service provider interface for dependency injection."""
    
    def get_service(self, service_type: type[T]) -> T:
        """Get a service instance."""
        ...
    
    def register_singleton(self, service_type: type[T], implementation: T) -> None:
        """Register a singleton service."""
        ...
    
    def register_transient(self, service_type: type[T], factory: Callable[[], T]) -> None:
        """Register a transient service."""
        ...

# ============================================================================
# UI COMPONENT PATTERNS
# ============================================================================

class IUIComponent(Protocol):
    """Base interface for UI components."""
    
    @property
    def widget(self) -> QWidget:
        """Get the underlying Qt widget."""
        ...
    
    def initialize(self) -> Result[None]:
        """Initialize the component."""
        ...
    
    def cleanup(self) -> None:
        """Clean up component resources."""
        ...

class IUIState(Protocol, Generic[TState]):
    """Interface for UI state management."""
    
    @property
    def current_state(self) -> TState:
        """Get the current state."""
        ...
    
    def update_state(self, new_state: TState) -> Result[None]:
        """Update the state."""
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
    """Factory interface for creating UI objects."""
    
    def create(self, **kwargs) -> Result[T]:
        """Create an instance."""
        ...

# ============================================================================
# MVP PATTERN INTERFACES
# ============================================================================

class IView(Protocol):
    """View interface for MVP pattern."""
    
    def show_error(self, message: str) -> None:
        """Show error message."""
        ...
    
    def show_success(self, message: str) -> None:
        """Show success message."""
        ...
    
    def show_loading(self, is_loading: bool) -> None:
        """Show/hide loading indicator."""
        ...

class IPresenter(Protocol):
    """Presenter interface for MVP pattern."""
    
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
    """Strategy interface for algorithm encapsulation."""
    
    def execute(self, context: T) -> Result[TResult]:
        """Execute the strategy."""
        ...

# ============================================================================
# REPOSITORY PATTERN
# ============================================================================

class IUIRepository(Protocol, Generic[T]):
    """Repository interface for data access."""
    
    def save(self, entity: T) -> Result[None]:
        """Save an entity."""
        ...
    
    def load(self, identifier: str) -> Result[T]:
        """Load an entity by identifier."""
        ...
    
    def delete(self, identifier: str) -> Result[None]:
        """Delete an entity by identifier."""
        ...

# ============================================================================
# DOMAIN-DRIVEN DESIGN BASE CLASSES
# ============================================================================

class UIAggregateRoot(QObject):
    """Base class for UI aggregate roots."""
    
    def __init__(self):
        super().__init__()
        self._domain_events: list[UIEvent] = []
        self._is_initialized = False
    
    def add_domain_event(self, event: UIEvent) -> None:
        """Add a domain event."""
        self._domain_events.append(event)
    
    def get_domain_events(self) -> list[UIEvent]:
        """Get all domain events."""
        return self._domain_events.copy()
    
    def clear_domain_events(self) -> None:
        """Clear all domain events."""
        self._domain_events.clear()
    
    @property
    def is_initialized(self) -> bool:
        """Check if aggregate is initialized."""
        return self._is_initialized
    
    def mark_as_initialized(self) -> None:
        """Mark aggregate as initialized."""
        self._is_initialized = True

# ============================================================================
# VALUE OBJECTS FOR UI POSITIONING
# ============================================================================

@dataclass(frozen=True)
class UIPosition:
    """Value object for UI positioning."""
    x: int
    y: int
    
    def __post_init__(self):
        if self.x < 0 or self.y < 0:
            raise ValueError("Position coordinates must be non-negative")

@dataclass(frozen=True)
class UISize:
    """Value object for UI sizing."""
    width: int
    height: int
    
    def __post_init__(self):
        if self.width <= 0 or self.height <= 0:
            raise ValueError("Size dimensions must be positive")

@dataclass(frozen=True)
class UIBounds:
    """Value object for UI bounds (position + size)."""
    position: UIPosition
    size: UISize
    
    @property
    def right(self) -> int:
        """Get right edge coordinate."""
        return self.position.x + self.size.width
    
    @property
    def bottom(self) -> int:
        """Get bottom edge coordinate."""
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
        """Compare entities by ID."""
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
    "ICommand",
    "IMediator",
    "IObservable",
    "IObserver",
    "IPresenter",
    "IQuery",
    "IServiceProvider",
    "IStrategy",
    "IUIComponent",
    "IUIFactory",
    "IUIRepository",
    "IUIState",
    "IUIValidator",
    "IView",
    "Result",
    "T",
    "TCommand",
    "TEvent",
    "TQuery",
    "TResult",
    "TState",
    "UIAggregateRoot",
    "UIBounds",
    "UIEntity",
    "UIEvent",
    "UIEventType",
    "UIPosition",
    "UISize",
]