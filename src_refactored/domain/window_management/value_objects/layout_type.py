"""Layout Type Value Object

Defines the possible types of UI layouts.
"""

from enum import Enum


class LayoutType(Enum):
    """Enumeration of layout types."""
    VERTICAL_BOX = "vertical_box"
    HORIZONTAL_BOX = "horizontal_box"
    GRID = "grid"
    FORM = "form"
    STACK = "stack"
    SPLITTER = "splitter"
    DOCK = "dock"
    ABSOLUTE = "absolute"
    FLOW = "flow"