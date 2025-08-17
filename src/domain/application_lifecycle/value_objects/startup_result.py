"""Startup Result Value Object.

This module contains the StartupResult enum for application startup results.
"""

from enum import Enum


class StartupResult(Enum):
    """Results of startup process."""
    SUCCESS = "success"
    ALREADY_RUNNING = "already_running"
    INITIALIZATION_FAILED = "initialization_failed"
    WINDOW_CREATION_FAILED = "window_creation_failed"
    CRITICAL_ERROR = "critical_error"