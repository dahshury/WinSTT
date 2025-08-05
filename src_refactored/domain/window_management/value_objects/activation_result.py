"""Activation Result Value Object

Defines the possible results of window activation operations.
"""

from enum import Enum


class ActivationResult(Enum):
    """Results of window activation."""
    SUCCESS = "success"
    WINDOW_NOT_FOUND = "window_not_found"
    ACTIVATION_FAILED = "activation_failed"
    PERMISSION_DENIED = "permission_denied"
    TIMEOUT = "timeout"
    ERROR = "error"