"""
Base Value Object for Domain Layer

Provides immutable value object foundation for domain entities.
Follows DDD principles with equality and validation support.
"""

from __future__ import annotations

from abc import ABC
from dataclasses import dataclass


@dataclass(frozen=True)
class ValueObject(ABC):
    """
    Base class for all value objects in the domain.
    
    Value objects are immutable and defined by their values, not identity.
    They should contain validation logic in __post_init__.
    """

    def __eq__(self, other: object,
    ) -> bool:
        """Value objects are equal if all their attributes are equal."""
        if not isinstance(other, self.__class__):
            return False
        return self.__dict__ == other.__dict__

    def __hash__(self) -> int:
        """Hash based on all attributes for immutable value objects."""
        return hash(tuple(sorted(self.__dict__.items())))


@dataclass(frozen=True)
class ProgressPercentage(ValueObject):
    """Value object for progress percentage with validation (0-100)."""
    value: float

    def __post_init__(self):
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