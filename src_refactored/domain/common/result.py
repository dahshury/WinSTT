"""Result Pattern for Domain Layer."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Generic, TypeVar

if TYPE_CHECKING:
    from collections.abc import Callable

T = TypeVar("T")
U = TypeVar("U")


@dataclass(frozen=True)
class Result(Generic[T]):
    """
    Functional Result pattern for handling success/failure states.
    Eliminates exception-driven control flow in domain operations.
    """
    value: T | None = None
    error: str | None = None
    is_success: bool = True

    @classmethod
    def success(cls, value: T,
    ) -> Result[T]:
        """Create a successful result."""
        return cls(value=value, is_success=True)

    @classmethod
    def failure(cls, error: str,
    ) -> Result[T]:
        """Create a failure result."""
        return cls(error=error, is_success=False)

    def map(self, func: Callable[[T], U]) -> Result[U]:
        """Transform the value if successful."""
        if self.is_success and self.value is not None:
            try:
                return Result.success(func(self.value))
            except Exception as e:
                return Result.failure(str(e))
        return Result.failure(self.error or "Unknown error")

    def bind(self, func: Callable[[T], Result[U]]) -> Result[U]:
        """Monadic bind operation for chaining operations."""
        if self.is_success and self.value is not None:
            return func(self.value)
        return Result.failure(self.error or "Unknown error")

    def map_error(self, func: Callable[[str], str]) -> Result[T]:
        """Transform the error message if failed."""
        if not self.is_success and self.error is not None:
            return Result.failure(func(self.error))
        return self

    def or_else(self, default_value: T,
    ) -> T:
        """Get the value or return a default."""
        return self.value if self.is_success and self.value is not None else default_value

    def or_else_get(self, func: Callable[[], T]) -> T:
        """Get the value or compute a default."""
        return self.value if self.is_success and self.value is not None else func()

    def is_failure(self) -> bool:
        """Check if this is a failure result."""
        return not self.is_success

    def get_error(self) -> str:
        """Get the error message, or empty string if successful."""
        return self.error or ""

    def get_value(self) -> T:
        """Get the value, raising an exception if failed."""
        if self.is_success and self.value is not None:
            return self.value
        msg = f"Cannot get value from failed result: {self.error}"
        raise ValueError(msg)

    def __bool__(self) -> bool:
        """Allow using Result in boolean context."""
        return self.is_success

    def __str__(self) -> str:
        """String representation of the result."""
        if self.is_success:
            return f"Success({self.value})"
        return f"Failure({self.error})"

    def __repr__(self) -> str:
        """Detailed string representation."""
        return self.__str__()


# Utility functions for working with Results

def combine_results(*results: Result,
    ) -> Result[tuple]:
    """Combine multiple results into a single result with tuple value."""
    values = []
    for result in results:
        if not result.is_success:
            return Result.failure(result.error or "Unknown error")
        values.append(result.value)
    return Result.success(tuple(values))


def sequence_results(results: list[Result[T]]) -> Result[list[T]]:
    """Convert a list of Results into a Result of list."""
    values = []
    for result in results:
        if not result.is_success:
            return Result.failure(result.error or "Unknown error")
        values.append(result.value)
    return Result.success(values)