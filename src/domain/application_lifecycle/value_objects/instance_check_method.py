"""Instance Check Method Value Object.

This module contains the InstanceCheckMethod enum for single instance checking methods.
"""

from enum import Enum


class InstanceCheckMethod(Enum):
    """Methods for checking instance."""
    SOCKET_BINDING = "socket_binding"
    FILE_LOCK = "file_lock"
    NAMED_MUTEX = "named_mutex"
    PROCESS_CHECK = "process_check"