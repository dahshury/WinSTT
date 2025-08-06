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
    # Use Case Pattern
    UseCase,
)
from .aggregate_root import AggregateRoot
from .domain_result import (
    DomainResult,
    combine_domain_results,
    sequence_domain_results,
)
from .entity import Entity
from .errors import (
    # Audio Domain Errors
    AudioDomainException,
    AudioProcessingException,
    AudioSessionException,
    AudioValidationException,
    # Configuration Errors
    ConfigurationException,
    ConversionException,
    # Base Error Types
    DomainError,
    DomainException,
    ErrorCategory,
    ErrorSeverity,
    # External Service Errors
    ExternalServiceException,
    # Hotkey Errors
    HotkeyException,
    # LLM Service Errors
    LLMServiceException,
    # Media Domain Errors
    MediaDomainException,
    MediaFileException,
    # Model Errors
    ModelException,
    # Progress Management Errors
    ProgressException,
    ProgressManagementException,
    # Settings Domain Errors
    SettingsDomainException,
    # System Integration Errors
    SystemIntegrationException,
    SystemResourceException,
    # Transcription Domain Errors
    TranscriptionDomainException,
    TranscriptionException,
    # Worker Management Errors
    WorkerException,
    WorkerManagementException,
)
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
from .value_objects import (
    Identifier,
    Timestamp,
    Version,
)

__all__ = [
    # Base Classes
    "AggregateRoot",
    # Audio Domain Errors
    "AudioDomainException",
    "AudioProcessingException",
    "AudioSessionException",
    "AudioValidationException",
    # Configuration Errors
    "ConfigurationException",
    "ConversionException",
    # Base Error Types
    "DomainError",
    # Events
    "DomainEvent",
    "DomainEventType",
    "DomainException",
    # Domain Result
    "DomainResult",
    "Entity",
    # Error Categories and Severity
    "ErrorCategory",
    "ErrorOccurred",
    "ErrorSeverity",
    # External Service Errors
    "ExternalServiceException",
    # Hotkey Errors
    "HotkeyException",
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
    "Identifier",
    # LLM Service Errors
    "LLMServiceException",
    # Media Domain Errors
    "MediaDomainException",
    "MediaFileException",
    # Model Errors
    "ModelException",
    # Progress Management Errors
    "ProgressException",
    "ProgressManagementException",
    "ProgressPercentage",
    "ProgressUpdated",
    "RecordingStarted",
    "RecordingStopped",
    "Result",
    # Settings Domain Errors
    "SettingsDomainException",
    # System Integration Errors
    "SystemIntegrationException",
    "SystemResourceException",
    # Type Variables
    "T",
    "TCommand",
    "TEvent",
    "TQuery",
    "TResult",
    "TState",
    "Timestamp",
    # Transcription Domain Errors
    "TranscriptionCompleted",
    "TranscriptionDomainException",
    "TranscriptionException",
    "TranscriptionStarted",
    "UseCase",
    "ValueObject",
    "Version",
    # Worker Management Errors
    "WorkerException",
    "WorkerManagementException",
    # Domain Result Helper Functions
    "combine_domain_results",
    "sequence_domain_results",
]