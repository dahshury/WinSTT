"""
Base Value Object for Domain Layer

Provides immutable value object foundation for domain entities.
Follows DDD principles with equality and validation support.
"""

from __future__ import annotations

from abc import ABC
from dataclasses import dataclass, fields


@dataclass(frozen=True)
class ValueObject(ABC):
    """
    Base class for all value objects in the domain.
    
    Value objects are immutable and defined by their values, not identity.
    They should contain validation logic in __post_init__.
    """

    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components used for equality comparison.
        
        Default implementation returns a tuple of all dataclass field values in
        declaration order. Override in subclasses when a subset or custom
        projection is required.
        """
        try:
            return tuple(getattr(self, f.name) for f in fields(self))
        except Exception:
            # Fallback to instance dict order if fields() is unavailable
            return tuple(getattr(self, name) for name in vars(self))

    def __eq__(self, other: object,
    ) -> bool:
        """Value objects are equal if all their attributes are equal."""
        if not isinstance(other, self.__class__):
            return False
        return self._get_equality_components() == other._get_equality_components()

    def __hash__(self) -> int:
        """Hash based on all attributes for immutable value objects."""
        return hash(self._get_equality_components())


@dataclass(frozen=True)
class ProgressPercentage(ValueObject):
    """Value object for progress percentage with validation (0-100)."""
    value: float

    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (self.value,)

    def __post_init__(self) -> None:
        if not 0.0 <= self.value <= 100.0:
            msg = f"Progress percentage must be between 0 and 100, got {self.value}"
            raise ValueError(msg)

    @property
    def as_ratio(self) -> float:
        """Get progress as ratio (0.0-1.0)."""
        return self.value / 100.0

    @classmethod
    def from_ratio(cls, ratio: float,
    ) -> ProgressPercentage:
        """Create from ratio (0.0-1.0)."""
        return cls(ratio * 100.0)