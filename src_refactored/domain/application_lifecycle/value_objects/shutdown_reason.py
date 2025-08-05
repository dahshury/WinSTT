"""Shutdown Reason Value Object.

This module contains the ShutdownReason enum for application shutdown reasons.
"""

from enum import Enum


class ShutdownReason(Enum):
    """Reasons for application shutdown."""
    USER_REQUEST = "user_request"
    SYSTEM_SHUTDOWN = "system_shutdown"
    CRITICAL_ERROR = "critical_error"
    FORCED_EXIT = "forced_exit"
    RESTART_REQUEST = "restart_request"