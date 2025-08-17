"""Application Lifecycle Domain Value Objects.

This module contains the value objects for application lifecycle management."""

from .enable_phase import EnablePhase
from .instance_check_method import InstanceCheckMethod
from .instance_check_result import InstanceCheckResult
from .shutdown_phase import ShutdownPhase
from .shutdown_reason import ShutdownReason
from .shutdown_result import ShutdownResult
from .startup_phase import StartupPhase
from .startup_result import StartupResult

__all__ = [
    "EnablePhase",
    "InstanceCheckMethod",
    "InstanceCheckResult",
    "ShutdownPhase",
    "ShutdownReason",
    "ShutdownResult",
    "StartupPhase",
    "StartupResult",
]