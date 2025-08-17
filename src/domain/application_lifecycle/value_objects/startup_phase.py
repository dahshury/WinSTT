"""Startup Phase Value Object.

This module contains the StartupPhase enum for application startup phases.
"""

from enum import Enum


class StartupPhase(Enum):
    """Phases of application startup."""
    ENVIRONMENT_SETUP = "environment_setup"
    LOGGING_SETUP = "logging_setup"
    WARNINGS_SUPPRESSION = "warnings_suppression"
    FRAMEWORK_INITIALIZATION = "framework_initialization"
    SINGLE_INSTANCE_CHECK = "single_instance_check"
    WINDOW_CREATION = "window_creation"
    APPLICATION_READY = "application_ready"
    ERROR = "error"