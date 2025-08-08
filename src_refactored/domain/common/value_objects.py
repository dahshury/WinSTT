"""Common Domain Value Objects

This module contains value objects that are truly shared across multiple domains
and don't belong to any specific domain context.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from .domain_utils import DomainIdentityGenerator
from .value_object import ValueObject


@dataclass(frozen=True)
class Timestamp(ValueObject):
    """Value object for timestamps with timezone awareness."""
    value: datetime
    
    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (self.value,)
    
    def __post_init__(self) -> None:
        if self.value is None:
            msg = "Timestamp value cannot be None"
            raise ValueError(msg)
    
    # Domain should not directly fetch system time. Prefer passing a timestamp
    # from the application layer or use a time/clock port in application services.
    
    @classmethod
    def from_iso_string(cls, iso_string: str) -> Timestamp:
        """Create timestamp from ISO format string."""
        try:
            dt = datetime.fromisoformat(iso_string.replace("Z", "+00:00"))
            return cls(dt)
        except ValueError as e:
            msg = f"Invalid ISO timestamp format: {iso_string}"
            raise ValueError(msg) from e
    
    def to_iso_string(self) -> str:
        """Convert to ISO format string."""
        return self.value.isoformat()

    @classmethod
    def now(cls) -> Timestamp:
        """Create a timestamp for the current time using domain time source."""
        return cls(datetime.fromtimestamp(DomainIdentityGenerator.generate_timestamp()))
    
    def is_before(self, other: Timestamp) -> bool:
        """Check if this timestamp is before another."""
        return self.value < other.value
    
    def is_after(self, other: Timestamp) -> bool:
        """Check if this timestamp is after another."""
        return self.value > other.value


@dataclass(frozen=True)
class Identifier(ValueObject):
    """Value object for unique identifiers."""
    value: str
    
    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (self.value,)
    
    def __post_init__(self) -> None:
        if not self.value or not self.value.strip():
            msg = "Identifier value cannot be empty"
            raise ValueError(msg)
        
        if len(self.value) > 255:
            msg = "Identifier value cannot exceed 255 characters"
            raise ValueError(msg)
    
    @classmethod
    def generate(cls) -> Identifier:
        """Generate a new unique identifier."""
        return cls(DomainIdentityGenerator.generate_domain_id("identifier"))
    
    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True)
class Version(ValueObject):
    """Value object for version numbers."""
    major: int
    minor: int
    patch: int
    
    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (self.major, self.minor, self.patch)
    
    def __post_init__(self) -> None:
        if self.major < 0 or self.minor < 0 or self.patch < 0:
            msg = "Version numbers cannot be negative"
            raise ValueError(msg)
    
    @classmethod
    def from_string(cls, version_string: str) -> Version:
        """Create version from string like '1.2.3'."""
        try:
            parts = version_string.split(".")
            if len(parts) != 3:
                msg = "Version must have exactly 3 parts"
                raise ValueError(msg)
            
            major, minor, patch = map(int, parts)
            return cls(major, minor, patch)
        except (ValueError, TypeError) as e:
            msg = f"Invalid version format: {version_string}"
            raise ValueError(msg) from e
    
    def to_string(self) -> str:
        """Convert to string format."""
        return f"{self.major}.{self.minor}.{self.patch}"
    
    def is_compatible_with(self, other: Version) -> bool:
        """Check if this version is compatible with another."""
        return self.major == other.major
    
    def is_newer_than(self, other: Version) -> bool:
        """Check if this version is newer than another."""
        return (self.major, self.minor, self.patch) > (other.major, other.minor, other.patch)
    
    def __str__(self) -> str:
        return self.to_string()


__all__ = [
    "Identifier",
    "Timestamp",
    "Version",
]