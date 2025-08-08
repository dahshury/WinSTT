"""UI Abstractions and Base Classes

This module defines the core abstractions that form the foundation of our UI architecture.
Following Domain-Driven Design principles and SOLID design patterns.

FIXED: Removed PyQt6 dependencies to follow hexagonal architecture principles.
Framework-specific implementations should use adapters in the infrastructure layer.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Generic, Protocol, TypeVar

from src_refactored.domain.common.result import Result

if TYPE_CHECKING:
    from collections.abc import Callable

# Type Variables for Generic Patterns
T = TypeVar("T")
TCommand = TypeVar("TCommand", bound="ICommand")
TQuery = TypeVar("TQuery", bound="IQuery")
TResult = TypeVar("TResult")
TState = TypeVar("TState")
TEvent = TypeVar("TEvent", bound="UIEvent")
TObservedEvent = TypeVar("TObservedEvent")
TWidget = TypeVar("TWidget", covariant=True)  # Generic widget type instead of QWidget
TQueryResult = TypeVar("TQueryResult")
TValidatorType = TypeVar("TValidatorType")
TFactoryResult = TypeVar("TFactoryResult")
TRepoType = TypeVar("TRepoType")
TStrategyContext = TypeVar("TStrategyContext", contravariant=True)
TStrategyResult = TypeVar("TStrategyResult")

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
            msg = "Event ID cannot be empty"
            raise ValueError(msg)
        if not self.source:
            msg = "Event source cannot be empty"
            raise ValueError(msg)

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

class IQuery(Generic[TQueryResult], ABC):
    """Interface for queries that read data."""

    @abstractmethod
    def execute(self) -> Result[TQueryResult]:
        """Execute the query and return result."""
        ...

# ============================================================================
# OBSERVER PATTERN
# ============================================================================

class IObserver(Protocol):
    """Observer interface for event handling."""
    
    def notify(self, event: Any) -> None:
        """Handle the event notification."""
        ...

class IObservable(Protocol):
    """Observable interface for event publishing."""
    
    def subscribe(self, observer: IObserver) -> None:
        """Subscribe an observer to events."""
        ...
    
    def unsubscribe(self, observer: IObserver) -> None:
        """Unsubscribe an observer from events."""
        ...
    
    def notify_observers(self, event: Any) -> None:
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
    
    def send_query(self, query: IQuery[T]) -> Result[T]:
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
# UI COMPONENT PATTERNS (FRAMEWORK-AGNOSTIC)
# ============================================================================

class IUIComponent(Protocol, Generic[TWidget]):
    """Base interface for UI components - framework agnostic."""
    
    @property
    def widget(self) -> TWidget:
        """Get the underlying framework widget."""
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

class IUIValidator(Generic[TValidatorType], ABC):
    """Interface for UI validation."""
    
    @abstractmethod
    def validate(self, value: TValidatorType) -> Result[TValidatorType]:
        """Validate a value."""
        ...

class IUIFactory(Generic[TFactoryResult], ABC):
    """Factory interface for creating UI objects."""
    
    @abstractmethod
    def create(self, **kwargs) -> Result[TFactoryResult]:
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

class IStrategy(Generic[TStrategyContext, TStrategyResult], ABC):
    """Strategy interface for algorithm encapsulation."""
    
    @abstractmethod
    def execute(self, context: TStrategyContext) -> Result[TStrategyResult]:
        """Execute the strategy."""
        ...

# ============================================================================
# REPOSITORY PATTERN
# ============================================================================

class IUIRepository(Generic[TRepoType], ABC):
    """Repository interface for data access."""
    
    @abstractmethod
    def save(self, entity: TRepoType) -> Result[None]:
        """Save an entity."""
        ...
    
    @abstractmethod
    def load(self, identifier: str) -> Result[TRepoType]:
        """Load an entity by identifier."""
        ...
    
    @abstractmethod
    def delete(self, identifier: str) -> Result[None]:
        """Delete an entity by identifier."""
        ...

# ============================================================================
# PRESENTATION BASE CLASSES (FRAMEWORK-AGNOSTIC)
# ============================================================================

class UIPresenterBase:
    """Base class for UI presenters - framework agnostic.
    
    Replaces the previous UIAggregateRoot that had PyQt6 dependencies.
    """
    
    def __init__(self, presenter_id: str):
        self._presenter_id = presenter_id
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
    def presenter_id(self) -> str:
        """Get presenter identifier."""
        return self._presenter_id
    
    @property
    def is_initialized(self) -> bool:
        """Check if presenter is initialized."""
        return self._is_initialized
    
    def mark_as_initialized(self) -> None:
        """Mark presenter as initialized."""
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
    "TWidget",
    "UIBounds",
    "UIEntity",
    "UIEvent",
    "UIEventType",
    "UIPosition",
    "UIPresenterBase",
    "UISize",
]