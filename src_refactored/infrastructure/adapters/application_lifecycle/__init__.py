"""Application lifecycle adapters."""

from .pyqt_application_lifecycle_adapter import PyQtApplicationLifecycleAdapter
from .windows_activation_adapter import WindowsActivationAdapter
from .windows_instance_adapter import WindowsInstanceAdapter

__all__ = [
    "PyQtApplicationLifecycleAdapter",
    "WindowsActivationAdapter",
    "WindowsInstanceAdapter",
]