"""Domain Entity Base Class."""

from __future__ import annotations

from abc import ABC
from typing import Generic, TypeVar

T = TypeVar("T")


class Entity(ABC, Generic[T]):
    """Base class for domain entities with identity."""

    def __init__(self, entity_id: T,
    ):
        self._id = entity_id
        self._created_at = self._current_timestamp()
        self._updated_at = self._created_at

    @property
    def id(self) -> T:
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
        """Entities are equal if they have the same ID and type."""
        if not isinstance(other, Entity):
            return False
        return self._id == other._id and type(self) == type(other)

    def __hash__(self) -> int:
        """Hash based on entity ID and type."""
        return hash((self._id, type(self)))

    @staticmethod
    def _current_timestamp() -> float:
        """Get current timestamp."""
        import time
        return time.time()

    def __invariants__(self) -> None:
        """Override in subclasses to define entity invariants."""

    def validate(self) -> None:
        """Validate entity invariants."""
        if self._id is None:
            msg = "Entity ID cannot be None"
            raise ValueError(msg)
        self.__invariants__(,
    )