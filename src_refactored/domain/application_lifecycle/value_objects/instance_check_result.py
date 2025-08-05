"""Instance Check Result Value Object.

This module contains the InstanceCheckResult enum for single instance checking results.
"""

from enum import Enum


class InstanceCheckResult(Enum):
    """Results of instance checking."""
    FIRST_INSTANCE = "first_instance"
    ALREADY_RUNNING = "already_running"
    CHECK_FAILED = "check_failed"
    ACTIVATION_SUCCESS = "activation_success"
    ACTIVATION_FAILED = "activation_failed"