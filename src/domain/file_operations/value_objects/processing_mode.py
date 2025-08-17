"""Processing Mode Value Object

Defines the modes for file processing operations.
"""

from enum import Enum


class ProcessingMode(Enum):
    """File processing modes."""
    IMMEDIATE = "immediate"
    QUEUED = "queued"
    BACKGROUND = "background"
    USER_TRIGGERED = "user_triggered"