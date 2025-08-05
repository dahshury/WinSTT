"""Drag and drop operations domain value objects.

This module contains domain concepts related to drag and drop operations
that are independent of infrastructure concerns.
"""

from dataclasses import dataclass
from typing import Any


@dataclass
class DragDropEventData:
    """Domain data container for drag and drop events."""
    files: list[str]
    position: tuple[float, float] | None = None
    metadata: dict[str, Any] | None = None

    @property
    def has_files(self) -> bool:
        """Check if event contains files."""
        return bool(self.files)

    @property
    def file_count(self) -> int:
        """Get number of files in the event."""
        return len(self.files)

    @property
    def has_position(self) -> bool:
        """Check if event has position information."""
        return self.position is not None