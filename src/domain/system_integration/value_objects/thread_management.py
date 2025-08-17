"""Domain value objects for thread management operations.

This module defines domain concepts related to thread management,
including thread information and management configurations.
"""

from dataclasses import dataclass
from typing import Any

from .system_operations import ThreadState


@dataclass
class ThreadInfo:
    """Information about a managed thread."""
    name: str
    state: ThreadState
    worker_class_name: str
    worker_instance_id: str | None = None
    metadata: dict[str, Any] | None = None