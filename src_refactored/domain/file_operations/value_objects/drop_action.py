"""Drop Action Value Object

Defines the possible actions for drag and drop operations.
"""

from enum import Enum


class DropAction(Enum):
    """Types of drop actions."""
    COPY = "copy"
    MOVE = "move"
    LINK = "link"
    IGNORE = "ignore"
    ASK_USER = "ask_user"