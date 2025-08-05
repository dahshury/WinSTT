"""Shutdown Phase Value Object.

This module contains the ShutdownPhase enum for application shutdown phases.
"""

from enum import Enum


class ShutdownPhase(Enum):
    """Phases of application shutdown."""
    INITIATED = "initiated"
    SAVING_STATE = "saving_state"
    STOPPING_WORKERS = "stopping_workers"
    CLEANING_RESOURCES = "cleaning_resources"
    CLOSING_CONNECTIONS = "closing_connections"
    FINALIZING = "finalizing"
    COMPLETED = "completed"
    ERROR = "error"