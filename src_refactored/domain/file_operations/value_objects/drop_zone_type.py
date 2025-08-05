"""Drop Zone Type Value Object

Defines the types of drop zones for drag and drop operations.
"""

from enum import Enum


class DropZoneType(Enum):
    """Types of drop zones."""
    WIDGET = "widget"
    WINDOW = "window"
    AREA = "area"
    CUSTOM = "custom"