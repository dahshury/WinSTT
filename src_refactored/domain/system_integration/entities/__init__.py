"""System integration domain entities."""

from .system_tray_integration import SystemTrayIntegration
from .worker_thread_coordination import WorkerThreadCoordination

__all__ = [
    "SystemTrayIntegration",
    "WorkerThreadCoordination",
]