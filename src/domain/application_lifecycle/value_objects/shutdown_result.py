"""Shutdown Result Value Object.

This module contains the ShutdownResult enum for application shutdown results.
"""

from enum import Enum


class ShutdownResult(Enum):
    """Results of shutdown process."""
    SUCCESS = "success"
    PARTIAL_SUCCESS = "partial_success"
    FAILED = "failed"
    FORCED = "forced"