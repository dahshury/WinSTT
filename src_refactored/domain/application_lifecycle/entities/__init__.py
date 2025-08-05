"""Application Lifecycle Domain Entities.

This module contains the domain entities for application lifecycle management.
"""

from .activation_configuration import ActivationConfiguration
from .shutdown_configuration import ShutdownConfiguration
from .single_instance_configuration import SingleInstanceConfiguration
from .startup_configuration import StartupConfiguration
from .window_info import WindowInfo

__all__ = [
    "ActivationConfiguration",
    "ShutdownConfiguration",
    "SingleInstanceConfiguration",
    "StartupConfiguration",
    "WindowInfo",
]