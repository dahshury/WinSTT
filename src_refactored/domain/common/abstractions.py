"""Domain Abstractions and Base Classes

Mirrors the existing src/ui/core/abstractions.py with comprehensive architectural patterns.
Following Domain-Driven Design principles and SOLID design patterns.

Note: Result pattern is imported from separate module to avoid duplication.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Generic, Protocol, TypeVar

# Import Result pattern from separate module

if TYPE_CHECKING:
    from .events import DomainEvent
    from .result import Result

# Import DomainEvent now that circular dependency is resolved
from .domain_utils import DomainIdentityGenerator

# Type Variables for Generic Patterns  
T = TypeVar("T")
TCommand = TypeVar("TCommand", bound="ICommand", contravariant=True)
TQuery = TypeVar("TQuery", bound="IQuery", contravariant=True)
TResult = TypeVar("TResult", covariant=True)
TState = TypeVar("TState")
TEvent = TypeVar("TEvent", bound="DomainEvent")
TRequest = TypeVar("TRequest")
TObserverData = TypeVar("TObserverData", contravariant=True)
TStrategyContext = TypeVar("TStrategyContext", contravariant=True)
TQueryResult = TypeVar("TQueryResult")
TResponse = TypeVar("TResponse")

# ============================================================================
# USE CASE PATTERN
# ============================================================================

class UseCase(Generic[TRequest, TResponse], ABC):
    """Base class for use cases in the application layer.
    
    Use cases represent application-specific business rules and orchestrate
    domain objects to perform specific operations.
    """
    
    @abstractmethod
    def execute(self, request: TRequest) -> TResponse:
        """Execute the use case with the given request.
        
        Args:
            request: The request object containing input parameters
            
        Returns:
            The response object containing the result
        """

# Note: Result pattern is imported from .result module to avoid duplication

# ============================================================================
# DOMAIN EVENTS
# ============================================================================

# Note: DomainEvent and DomainEventType are defined in events.py to avoid duplication

# ============================================================================
# COMMAND PATTERN INTERFACES (CQRS)
# ============================================================================

class ICommand(Protocol):
    """Interface for commands in CQRS pattern."""

class IQuery(Protocol, Generic[TResult]):
    """Interface for queries in CQRS pattern."""

class ICommandHandler(Protocol, Generic[TCommand]):
    """Interface for command handlers."""

    @abstractmethod
    def handle(self, command: TCommand,
    ) -> Result[None]:
        """Handle a command and return result."""

class IQueryHandler(Protocol, Generic[TQuery, TQueryResult]):
    """Interface for query handlers."""

    @abstractmethod
    def handle(self, query: TQuery,
    ) -> Result[TQueryResult]:
        """Handle a query and return result with data."""

# ============================================================================
# OBSERVER PATTERN
# ============================================================================

class IObserver(Protocol, Generic[TObserverData]):
    """Interface for observers."""

    @abstractmethod
    def update(self, data: TObserverData,
    ) -> None:
        """Receive update notification."""

class IObservable(Protocol, Generic[T]):
    """Interface for observable objects."""

    @abstractmethod
    def subscribe(self, observer: IObserver[T]) -> None:
        """Subscribe an observer."""

    @abstractmethod
    def unsubscribe(self, observer: IObserver[T]) -> None:
        """Unsubscribe an observer."""

    @abstractmethod
    def notify(self, data: T,
    ) -> None:
        """Notify all observers."""

# ============================================================================
# MEDIATOR PATTERN
# ============================================================================

class IMediator(Protocol):
    """Interface for mediator pattern."""

    @abstractmethod
    def send_command(self, command: ICommand,
    ) -> Result[None]:
        """Send a command through the mediator."""

    @abstractmethod
    def send_query(self, query: IQuery[TResult]) -> Result[TResult]:
        """Send a query through the mediator."""

# ============================================================================
# DEPENDENCY INJECTION
# ============================================================================

class IServiceProvider(Protocol):
    """Interface for dependency injection service provider."""

    @abstractmethod
    def get_service(self, service_type: type[T]) -> Result[T]:
        """Get a service instance by type."""

    @abstractmethod
    def register_singleton(self, service_type: type[T], implementation: type[T]) -> None:
        """Register a singleton service."""

    @abstractmethod
    def register_transient(self, service_type: type[T], implementation: type[T]) -> None:
        """Register a transient service."""

# ============================================================================
# STRATEGY PATTERN
# ============================================================================

class IStrategy(Protocol, Generic[TStrategyContext]):
    """Interface for strategy pattern."""

    @abstractmethod
    def execute(self, context: TStrategyContext,
    ) -> Result[Any]:
        """Execute the strategy."""

# ============================================================================
# REPOSITORY PATTERN
# ============================================================================

class IRepository(Protocol, Generic[T]):
    """Interface for repository pattern."""

    @abstractmethod
    def get_by_id(self, entity_id: str,
    ) -> Result[T]:
        """Get entity by ID."""

    @abstractmethod
    def save(self, entity: T,
    ) -> Result[None]:
        """Save entity."""

    @abstractmethod
    def delete(self, entity_id: str,
    ) -> Result[None]:
        """Delete entity by ID."""

# ============================================================================
# AGGREGATE ROOT (DDD)
# ============================================================================

class AggregateRoot(ABC):
    """
    Base class for aggregate roots in Domain-Driven Design.
    Manages domain events and ensures consistency boundaries.
    """

    def __init__(self, aggregate_id: str,
    ):
        self.aggregate_id = aggregate_id
        self._domain_events: list[DomainEvent] = []
        self._version = 0

    def add_domain_event(self, event: DomainEvent,
    ) -> None:
        """Add a domain event to be raised."""
        self._domain_events.append(event)

    def clear_domain_events(self) -> None:
        """Clear all domain events."""
        self._domain_events.clear()

    @property
    def domain_events(self) -> list[DomainEvent]:
        """Get domain events."""
        return self._domain_events.copy()

    @property
    def version(self) -> int:
        """Get aggregate version for optimistic concurrency."""
        return self._version

    def increment_version(self) -> None:
        """Increment version for concurrency control."""
        self._version += 1

# ============================================================================
# ENTITY BASE CLASS (DDD)
# ============================================================================

@dataclass
class Entity:
    """
    Base class for entities in Domain-Driven Design.
    Entities have identity and can change over time.
    """
    entity_id: str = field(default="")
    created_at: float = field(default=0.0)
    updated_at: float = field(default=0.0)

    def __post_init__(self):
        if not self.entity_id:
            object.__setattr__(self, "entity_id", DomainIdentityGenerator.generate_domain_id("entity"))
        if not self.created_at:
            current_time = DomainIdentityGenerator.generate_timestamp()
            object.__setattr__(self, "created_at", current_time)
            object.__setattr__(self, "updated_at", current_time)

    def update_timestamp(self) -> None:
        """Update the last modified timestamp."""
        object.__setattr__(self, "updated_at", DomainIdentityGenerator.generate_timestamp())

    def __eq__(self, other: object,
    ) -> bool:
        """Entities are equal if they have the same ID."""
        if not isinstance(other, Entity):
            return False
        return self.entity_id == other.entity_id

    def __hash__(self) -> int:
        """Hash based on entity ID."""
        return hash(self.entity_id)