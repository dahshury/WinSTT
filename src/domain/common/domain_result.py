"""Enhanced Result Pattern with Domain Error Integration.

This module provides an enhanced Result type that integrates with
domain-specific error types for better error handling and reporting.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Generic, TypeVar

from .errors import DomainError, DomainException, ErrorCategory, ErrorSeverity

if TYPE_CHECKING:
    from collections.abc import Callable

T = TypeVar("T")
U = TypeVar("U")


@dataclass(frozen=True)
class DomainResult(Generic[T]):
    """
    Enhanced Result pattern with domain error integration.
    Provides structured error information and better error handling.
    """
    value: T | None = None
    error: DomainError | None = None
    is_success: bool = True

    @classmethod
    def success(cls, value: T) -> DomainResult[T]:
        """Create a successful result."""
        return cls(value=value, is_success=True)

    @classmethod
    def failure(cls, error: DomainError) -> DomainResult[T]:
        """Create a failure result with domain error."""
        return cls(error=error, is_success=False)

    @classmethod
    def from_exception(cls, exception: DomainException) -> DomainResult[T]:
        """Create a failure result from a domain exception."""
        return cls(error=exception.error, is_success=False)

    @classmethod
    def validation_error(cls, code: str, message: str, context: dict[str, object] | None = None) -> DomainResult[T]:
        """Create a validation error result."""
        error = DomainError(
            code=code,
            message=message,
            category=ErrorCategory.VALIDATION,
            severity=ErrorSeverity.ERROR,
            context=context,
        )
        return cls(error=error, is_success=False)

    @classmethod
    def business_rule_error(cls, code: str, message: str, context: dict[str, object] | None = None) -> DomainResult[T]:
        """Create a business rule violation error result."""
        error = DomainError(
            code=code,
            message=message,
            category=ErrorCategory.BUSINESS_RULE,
            severity=ErrorSeverity.ERROR,
            context=context,
        )
        return cls(error=error, is_success=False)

    @classmethod
    def resource_error(cls, code: str, message: str, context: dict[str, object] | None = None) -> DomainResult[T]:
        """Create a resource error result."""
        error = DomainError(
            code=code,
            message=message,
            category=ErrorCategory.RESOURCE,
            severity=ErrorSeverity.ERROR,
            context=context,
        )
        return cls(error=error, is_success=False)

    @classmethod
    def operation_error(cls, code: str, message: str, context: dict[str, object] | None = None) -> DomainResult[T]:
        """Create an operation error result."""
        error = DomainError(
            code=code,
            message=message,
            category=ErrorCategory.OPERATION,
            severity=ErrorSeverity.ERROR,
            context=context,
        )
        return cls(error=error, is_success=False)

    def map(self, func: Callable[[T], U]) -> DomainResult[U]:
        """Transform the value if successful."""
        if self.is_success and self.value is not None:
            try:
                return DomainResult.success(func(self.value))
            except DomainException as e:
                return DomainResult.from_exception(e)
            except Exception as e:
                error = DomainError(
                    code="OPERATION_FAILED",
                    message=f"Operation failed: {e!s}",
                    category=ErrorCategory.OPERATION,
                    severity=ErrorSeverity.ERROR,
                    inner_error=e,
                )
                return DomainResult.failure(error)
        return DomainResult.failure(self.error or DomainError(
            code="UNKNOWN_ERROR",
            message="Unknown error occurred",
            category=ErrorCategory.OPERATION,
            severity=ErrorSeverity.ERROR,
        ))

    def bind(self, func: Callable[[T], DomainResult[U]]) -> DomainResult[U]:
        """Monadic bind operation for chaining operations."""
        if self.is_success and self.value is not None:
            try:
                return func(self.value)
            except DomainException as e:
                return DomainResult.from_exception(e)
            except Exception as e:
                error = DomainError(
                    code="OPERATION_FAILED",
                    message=f"Operation failed: {e!s}",
                    category=ErrorCategory.OPERATION,
                    severity=ErrorSeverity.ERROR,
                    inner_error=e,
                )
                return DomainResult.failure(error)
        return DomainResult.failure(self.error or DomainError(
            code="UNKNOWN_ERROR",
            message="Unknown error occurred",
            category=ErrorCategory.OPERATION,
            severity=ErrorSeverity.ERROR,
        ))

    def map_error(self, func: Callable[[DomainError], DomainError]) -> DomainResult[T]:
        """Transform the error if failed."""
        if not self.is_success and self.error is not None:
            return DomainResult.failure(func(self.error))
        return self

    def or_else(self, default_value: T) -> T:
        """Get the value or return a default."""
        return self.value if self.is_success and self.value is not None else default_value

    def or_else_get(self, func: Callable[[], T]) -> T:
        """Get the value or compute a default."""
        return self.value if self.is_success and self.value is not None else func()

    def is_failure(self) -> bool:
        """Check if this is a failure result."""
        return not self.is_success

    def get_error(self) -> DomainError:
        """Get the error (raises if successful)."""
        if self.is_success:
            msg = "Cannot get error from successful result"
            raise ValueError(msg)
        return self.error or DomainError(
            code="UNKNOWN_ERROR",
            message="Unknown error occurred",
            category=ErrorCategory.OPERATION,
            severity=ErrorSeverity.ERROR,
        )

    def get_value(self) -> T:
        """Get the value (raises if failed)."""
        if not self.is_success:
            error_msg = str(self.error) if self.error else "Operation failed"
            msg = f"Cannot get value from failed result: {error_msg}"
            raise ValueError(msg)
        if self.value is None:
            msg = "Result value is None"
            raise ValueError(msg)
        return self.value

    def raise_if_failed(self) -> T:
        """Raise domain exception if failed, otherwise return value."""
        if not self.is_success:
            if self.error:
                # Create appropriate domain exception based on error category
                from .errors import (
                    AudioDomainException,
                    ConfigurationException,
                    MediaDomainException,
                    ModelException,
                    SettingsDomainException,
                    SystemIntegrationException,
                    TranscriptionDomainException,
                    WorkerManagementException,
                )
                
                # Map error categories to exception types
                exception_map = {
                    "AUDIO": AudioDomainException,
                    "MODEL": ModelException,
                    "TRANSCRIPTION": TranscriptionDomainException,
                    "MEDIA": MediaDomainException,
                    "SETTINGS": SettingsDomainException,
                    "CONFIGURATION": ConfigurationException,
                    "SYSTEM": SystemIntegrationException,
                    "WORKER": WorkerManagementException,
                }
                
                # Determine exception type based on error code prefix
                exception_type = DomainException
                for prefix, exc_type in exception_map.items():
                    if self.error.code.startswith(prefix):
                        exception_type = exc_type
                        break
                
                raise exception_type(self.error)
            raise DomainException(DomainError(
                code="UNKNOWN_ERROR",
                message="Unknown error occurred",
                category=ErrorCategory.OPERATION,
                severity=ErrorSeverity.ERROR,
            ))
        
        if self.value is None:
            msg = "Result value is None"
            raise ValueError(msg)
        return self.value

    @property
    def error_code(self) -> str | None:
        """Get the error code if failed."""
        return self.error.code if self.error else None

    @property
    def error_message(self) -> str | None:
        """Get the error message if failed."""
        return self.error.message if self.error else None

    @property
    def error_category(self) -> ErrorCategory | None:
        """Get the error category if failed."""
        return self.error.category if self.error else None

    @property
    def error_severity(self) -> ErrorSeverity | None:
        """Get the error severity if failed."""
        return self.error.severity if self.error else None

    @property
    def error_context(self) -> dict[str, object] | None:
        """Get the error context if failed."""
        return self.error.context if self.error else None

    def __bool__(self) -> bool:
        """Boolean conversion returns success status."""
        return self.is_success

    def __str__(self) -> str:
        """String representation."""
        if self.is_success:
            return f"Success({self.value})"
        return f"Failure({self.error})"

    def __repr__(self) -> str:
        """Detailed string representation."""
        if self.is_success:
            return f"DomainResult.success({self.value!r})"
        return f"DomainResult.failure({self.error!r})"


def combine_domain_results(*results: DomainResult[object]) -> DomainResult[tuple[object, ...]]:
    """Combine multiple results into a single result with tuple value."""
    values: list[object] = []
    for result in results:
        if not result.is_success:
            return DomainResult.failure(result.error or DomainError(
                code="UNKNOWN_ERROR",
                message="Unknown error occurred",
                category=ErrorCategory.OPERATION,
                severity=ErrorSeverity.ERROR,
            ))
        values.append(result.value)
    return DomainResult.success(tuple(values))


def sequence_domain_results(results: list[DomainResult[T]]) -> DomainResult[list[T]]:
    """Convert a list of results into a result of list."""
    values: list[T] = []
    for result in results:
        if not result.is_success:
            return DomainResult.failure(result.error or DomainError(
                code="UNKNOWN_ERROR",
                message="Unknown error occurred",
                category=ErrorCategory.OPERATION,
                severity=ErrorSeverity.ERROR,
            ))
        if result.value is None:
            return DomainResult.failure(DomainError(
                code="NULL_VALUE_ERROR",
                message="Successful result has None value",
                category=ErrorCategory.OPERATION,
                severity=ErrorSeverity.ERROR,
            ))
        values.append(result.value)
    return DomainResult.success(values)