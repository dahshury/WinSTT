"""System integration domain."""

from .entities import EventSystemIntegration, SystemTrayIntegration, WorkerThreadCoordination
from .value_objects import ThreadReference, TrayIconPath

__all__ = [
    "EventSystemIntegration",
    "SystemTrayIntegration",
    "ThreadReference",
    "TrayIconPath",
    "WorkerThreadCoordination",
]