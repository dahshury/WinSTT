"""Time Service.

Provides time-related utilities as an infrastructure service.
"""

from __future__ import annotations

import time


class TimeService:
    """Simple time provider returning wall-clock seconds."""

    def now_seconds(self) -> float:
        return time.time()


