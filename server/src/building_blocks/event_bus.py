from __future__ import annotations

import contextlib
import logging
import threading
from collections import defaultdict
from collections.abc import Callable

logger = logging.getLogger(__name__)

EventHandler = Callable[..., None]


class EventBus:
    def __init__(self) -> None:
        self._handlers: dict[type, list[EventHandler]] = defaultdict(list)
        self._lock = threading.Lock()

    def subscribe(self, event_type: type, handler: EventHandler) -> None:
        with self._lock:
            if handler not in self._handlers[event_type]:
                self._handlers[event_type].append(handler)

    def unsubscribe(self, event_type: type, handler: EventHandler) -> None:
        with self._lock, contextlib.suppress(ValueError):
            self._handlers[event_type].remove(handler)

    def publish(self, event: object) -> None:
        with self._lock:
            handlers = list(self._handlers.get(type(event), []))
        for handler in handlers:
            try:
                handler(event)
            except Exception:
                logger.exception("Handler %s failed for event %s", handler, event)
