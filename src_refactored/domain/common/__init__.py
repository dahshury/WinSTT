"""Common Domain Components"""

from .abstractions import (
    # CQRS
    ICommand,
    ICommandHandler,
    # Mediator Pattern
    IMediator,
    IObservable,
    # Observer Pattern
    IObserver,
    IQuery,
    IQueryHandler,
    # Repository Pattern
    IRepository,
    # Service Provider
    IServiceProvider,
    # Strategy Pattern
    IStrategy,
    # Type Variables
    T,
    TCommand,
    TEvent,
    TQuery,
    TResult,
    TState,
)
from .aggregate_root import AggregateRoot
from .entity import Entity
from .events import (
    DomainEvent,
    DomainEventType,
    ErrorOccurred,
    ProgressUpdated,
    RecordingStarted,
    RecordingStopped,
    TranscriptionCompleted,
    TranscriptionStarted,
)
from .result import Result
from .value_object import ProgressPercentage, ValueObject

__all__ = [
    # Base Classes
    "AggregateRoot",
    # Events
    "DomainEvent",
    "DomainEventType",
    "Entity",
    "ErrorOccurred",
    # Interfaces
    "ICommand",
    "ICommandHandler",
    "IMediator",
    "IObservable",
    "IObserver",
    "IQuery",
    "IQueryHandler",
    "IRepository",
    "IServiceProvider",
    "IStrategy",
    # Value Objects
    "ProgressPercentage",
    "ProgressUpdated",
    "RecordingStarted",
    "RecordingStopped",
    "Result",
    # Type Variables
    "T",
    "TCommand",
    "TEvent",
    "TQuery",
    "TResult",
    "TState",
    "TranscriptionCompleted",
    "TranscriptionStarted",
    "ValueObject",
]