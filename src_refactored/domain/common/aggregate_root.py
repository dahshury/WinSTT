"""Domain Aggregate Root Base Class."""

from __future__ import annotations

from abc import ABC
from typing import TYPE_CHECKING, Generic, TypeVar

from .entity import Entity

if TYPE_CHECKING:
    from .events import DomainEvent

T = TypeVar("T")


class AggregateRoot(Entity[T], ABC, Generic[T]):
    """
    Base class for domain aggregate roots following DDD principles.
    Manages domain events and ensures consistency within aggregates.
    """

    def __init__(self, entity_id: T,
    ):
        super().__init__(entity_id)
        self._domain_events: list[DomainEvent] = []
        self._is_initialized = False

    def add_domain_event(self, event: DomainEvent,
    ) -> None:
        """Add a domain event to be published."""
        self._domain_events.append(event)

    def get_domain_events(self) -> list[DomainEvent]:
        """Get all pending domain events."""
        return self._domain_events.copy()

    def clear_domain_events(self) -> None:
        """Clear all pending domain events."""
        self._domain_events.clear()

    @property
    def is_initialized(self) -> bool:
        """Check if aggregate is initialized."""
        return self._is_initialized

    def mark_as_initialized(self) -> None:
        """Mark aggregate as initialized."""
        self._is_initialized = True
        self.mark_as_updated()

    def __invariants__(self) -> None:
        """Override in subclasses to define aggregate invariants."""

    def validate(self) -> None:
        """Validate aggregate invariants."""
        self.__invariants__()