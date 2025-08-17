"""Threading Service.

Provides a thin abstraction for background threads.
"""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable


class ThreadingService:
    """Simple service to manage background daemon threads."""

    def start_daemon(
        self,
        target: Callable[..., Any],
        *args: Any,
        name: str | None = None,
        **kwargs: Any,
    ) -> threading.Thread:
        thread = threading.Thread(target=target, args=args, kwargs=kwargs, daemon=True, name=name)
        thread.start()
        return thread

    def join(self, thread: threading.Thread | None, timeout: float | None = None) -> None:
        if thread and thread.is_alive():
            try:
                thread.join(timeout=timeout)
            except Exception:
                # Swallow join errors to avoid cascading failures on shutdown
                pass


