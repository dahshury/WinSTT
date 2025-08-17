"""System infrastructure services package.

This package contains infrastructure services for system-level operations,
including environment management, platform detection, single instance control,
logging, subprocess management, and tray icon functionality.
"""

from .environment_service import EnvironmentService
from .logging_service import LoggingService
from .platform_service import PlatformCapabilities, PlatformService
from .single_instance_service import SingleInstanceManager, SingleInstanceService
from .subprocess_service import SubprocessService
from .tray_icon_service import TrayIconService

__all__ = [
    "EnvironmentService",
    "LoggingService",
    "PlatformCapabilities",
    "PlatformService",
    "SingleInstanceManager",
    "SingleInstanceService",
    "SubprocessService",
    "TrayIconService",
]