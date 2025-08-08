"""Domain Error Types.

This module defines domain-specific error types for consistent error handling.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Any


class ErrorCategory(Enum):
    """Domain error categories."""
    VALIDATION = "validation"
    CONFIGURATION = "configuration"
    TRANSCRIPTION = "transcription"
    AUDIO = "audio"
    FILE_OPERATION = "file_operation"
    WORKER = "worker"
    NETWORK = "network"
    SYSTEM = "system"
    BUSINESS_RULE = "business_rule"


class ErrorSeverity(Enum):
    """Error severity levels."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class DomainError(Exception):
    """Base domain error."""
    
    message: str
    category: ErrorCategory
    severity: ErrorSeverity = ErrorSeverity.MEDIUM
    context: dict[str, Any] | None = None
    inner_exception: Exception | None = None
    
    def __post_init__(self) -> None:
        super().__init__(self.message)
        if self.context is None:
            self.context = {}


@dataclass
class ValidationError(DomainError):
    """Error for validation failures."""
    
    field_name: str | None = None
    invalid_value: Any | None = None
    
    def __post_init__(self) -> None:
        if not hasattr(self, "category"):
            self.category = ErrorCategory.VALIDATION
        super().__post_init__()


@dataclass
class ConfigurationError(DomainError):
    """Error for configuration issues."""
    
    configuration_key: str | None = None
    expected_type: str | None = None
    actual_value: Any | None = None
    
    def __post_init__(self) -> None:
        if not hasattr(self, "category"):
            self.category = ErrorCategory.CONFIGURATION
        super().__post_init__()


@dataclass
class TranscriptionError(DomainError):
    """Error for transcription operations."""
    
    model_name: str | None = None
    file_path: str | None = None
    audio_format: str | None = None
    
    def __post_init__(self) -> None:
        if not hasattr(self, "category"):
            self.category = ErrorCategory.TRANSCRIPTION
        super().__post_init__()


@dataclass
class AudioError(DomainError):
    """Error for audio operations."""
    
    device_id: str | None = None
    sample_rate: int | None = None
    channels: int | None = None
    
    def __post_init__(self) -> None:
        if not hasattr(self, "category"):
            self.category = ErrorCategory.AUDIO
        super().__post_init__()


@dataclass
class FileOperationError(DomainError):
    """Error for file operations."""
    
    file_path: str | None = None
    operation: str | None = None  # read, write, delete, etc.
    
    def __post_init__(self) -> None:
        if not hasattr(self, "category"):
            self.category = ErrorCategory.FILE_OPERATION
        super().__post_init__()


@dataclass
class WorkerError(DomainError):
    """Error for worker operations."""
    
    worker_type: str | None = None
    worker_id: str | None = None
    thread_id: str | None = None
    
    def __post_init__(self) -> None:
        if not hasattr(self, "category"):
            self.category = ErrorCategory.WORKER
        super().__post_init__()


@dataclass
class NetworkError(DomainError):
    """Error for network operations."""
    
    url: str | None = None
    status_code: int | None = None
    timeout: float | None = None
    
    def __post_init__(self) -> None:
        if not hasattr(self, "category"):
            self.category = ErrorCategory.NETWORK
        super().__post_init__()


@dataclass
class SystemError(DomainError):
    """Error for system operations."""
    
    system_resource: str | None = None
    operation: str | None = None
    
    def __post_init__(self) -> None:
        if not hasattr(self, "category"):
            self.category = ErrorCategory.SYSTEM
        super().__post_init__()


@dataclass
class BusinessRuleError(DomainError):
    """Error for business rule violations."""
    
    rule_name: str | None = None
    violated_constraint: str | None = None
    
    def __post_init__(self) -> None:
        if not hasattr(self, "category"):
            self.category = ErrorCategory.BUSINESS_RULE
        super().__post_init__()
