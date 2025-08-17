"""Synchronization Service.

Provides primitives like locks.
"""

from __future__ import annotations

import threading


class SyncService:
    """Create synchronization primitives."""

    def create_lock(self) -> threading.Lock:
        return threading.Lock()


