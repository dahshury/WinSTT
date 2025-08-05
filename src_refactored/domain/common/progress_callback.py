"""
Progress Callback Interface

Defines the contract for progress reporting in non-blocking operations.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from .value_object import ProgressPercentage


class ProgressCallback(Protocol):
    """Protocol for progress reporting callbacks."""

    def __call__(
        self,
        progress: ProgressPercentage,
        message: str,
        error: str | None = None,
    ) -> None:
        """
        Report progress update.
        
        Args:
            progress: Current progress percentage (0-100)
            message: Human-readable progress message
            error: Optional error message if operation failed
        """
        ...


class BaseProgressCallback(ABC):
    """Abstract base class for progress callbacks."""

    @abstractmethod
    def report_progress(
        self,
        progress: ProgressPercentage,
        message: str,
        error: str | None = None,
    ) -> None:
        """Report progress update."""

    def __call__(
        self,
        progress: ProgressPercentage,
        message: str,
        error: str | None = None,
    ) -> None:
        """Allow callback to be used as callable."""
        self.report_progress(progress, message, error)


class NoOpProgressCallback(BaseProgressCallback):
    """No-operation progress callback for when progress reporting is not needed."""

    def report_progress(
        self,
        progress: ProgressPercentage,
        message: str,
        error: str | None = None,
    ) -> None:
        """Do nothing - no-op implementation."""


class CompositeProgressCallback(BaseProgressCallback):
    """Composite progress callback that forwards to multiple callbacks."""

    def __init__(self, *callbacks: ProgressCallback,
    ):
        self.callbacks = list(callbacks)

    def add_callback(self, callback: ProgressCallback,
    ) -> None:
        """Add a callback to the composite."""
        self.callbacks.append(callback)

    def remove_callback(self, callback: ProgressCallback,
    ) -> None:
        """Remove a callback from the composite."""
        if callback in self.callbacks:
            self.callbacks.remove(callback)

    def report_progress(
        self,
        progress: ProgressPercentage,
        message: str,
        error: str | None = None,
    ) -> None:
        """Report progress to all registered callbacks."""
        for callback in self.callbacks:
            try:
                callback(progress, message, error)
            except Exception:
                # Silently ignore callback errors to prevent cascading failures
                pass