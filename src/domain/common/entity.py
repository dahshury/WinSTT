"""Domain Entity Base Class."""

from __future__ import annotations

from abc import ABC
from typing import TYPE_CHECKING

from .domain_utils import DomainIdentityGenerator

if TYPE_CHECKING:
    from collections.abc import Hashable


class Entity(ABC):
    """Base class for domain entities with identity."""

    def __init__(self, entity_id: Hashable,
    ):
        self._id: Hashable = entity_id
        self._created_at = self._current_timestamp()
        self._updated_at = self._created_at

    @property
    def id(self) -> Hashable:
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

    def __eq__(self, other: object) -> bool:
        """Entities are equal if they have the same ID and type."""
        if not isinstance(other, Entity):
            return False
        return self._id == other._id and type(self) == type(other)

    def __hash__(self) -> int:
        """Hash based on entity ID and type."""
        return hash((self._id, type(self)))

    # Provide a no-op __post_init__ so dataclass-based subclasses can safely call super()
    def __post_init__(self) -> None:  # - lifecycle hook
        """Dataclass post-init hook for subclasses."""
        # Ensure updated timestamp consistency
        self._updated_at = self._created_at

    @staticmethod
    def _current_timestamp() -> float:
        """Get current timestamp."""
        return DomainIdentityGenerator.generate_timestamp()

    def __invariants__(self) -> None:
        """Override in subclasses to define entity invariants."""

    def validate(self) -> None:
        """Validate entity invariants."""
        if self._id is None:
            msg = "Entity ID cannot be None"
            raise ValueError(msg)
        self.__invariants__()