"""Timer management domain value objects.

This module contains domain concepts related to timer management
that are independent of infrastructure concerns.
"""

from enum import Enum


class TimerType(Enum):
    """Enumeration of timer types for domain operations."""
    DEBOUNCE = "debounce"
    DELAY = "delay"
    PERIODIC = "periodic"
    SINGLE_SHOT = "single_shot"
    PROGRESS_RESET = "progress_reset"