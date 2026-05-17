from __future__ import annotations

from src.building_blocks.errors import DomainError


class InvalidStateTransition(DomainError):
    """Raised when an invalid state machine transition is attempted."""


class DownloadCancelledError(DomainError):
    """Raised when a model download is cancelled by the user."""
