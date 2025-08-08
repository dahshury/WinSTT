"""Event system integration entity for system integration domain."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any

from src_refactored.domain.common import Entity
from src_refactored.domain.common.domain_utils import DomainIdentityGenerator

try:
    from datetime import datetime
except Exception:  # pragma: no cover - fallback if datetime import is restricted
    datetime = None  # type: ignore

if TYPE_CHECKING:
    from collections.abc import Callable


class EventType(Enum):
    """Enumeration of event types."""
    SYSTEM = "system"
    USER_INPUT = "user_input"
    AUDIO = "audio"
    MODEL = "model"
    UI = "ui"
    HOTKEY = "hotkey"
    TRAY = "tray"
    THREAD = "thread"
    ERROR = "error"
    CUSTOM = "custom"


class EventPriority(Enum):
    """Enumeration of event priorities."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


class EventStatus(Enum):
    """Enumeration of event processing status."""
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class EventData:
    """Value object for event data."""
    event_id: str
    event_type: EventType
    priority: EventPriority
    payload: dict[str, Any]
    source: str
    timestamp: datetime
    correlation_id: str | None = None

    def __post_init__(self) -> None:
        """Validate event data."""
        if not self.event_id or not self.event_id.strip():
            msg = "Event ID cannot be empty"
            raise ValueError(msg)

        if not self.source or not self.source.strip():
            msg = "Event source cannot be empty"
            raise ValueError(msg)

        if not isinstance(self.payload, dict):
            msg = "Event payload must be a dictionary"
            raise ValueError(msg)

    def get_payload_value(self, key: str, default: Any = None,
    ) -> Any:
        """Get value from payload with default."""
        return self.payload.get(key, default)

    def has_payload_key(self, key: str,
    ) -> bool:
        """Check if payload contains key."""
        return key in self.payload

    def add_payload_data(self, key: str, value: Any,
    ) -> None:
        """Add data to payload."""
        self.payload[key] = value

    def get_age_seconds(self) -> float:
        """Get event age in seconds."""
        # Assuming EventData.timestamp is a datetime; convert to seconds since an arbitrary base
        # For domain determinism, we approximate age using domain timestamp minus a coarse seconds value
        base_seconds = getattr(self.timestamp, "timestamp", lambda: 0.0)()
        return float(DomainIdentityGenerator.generate_timestamp() - base_seconds)


@dataclass
class EventHandler:
    """Value object for event handler configuration."""
    handler_id: str
    event_types: set[EventType]
    callback: Callable[[EventData], Any]
    priority: EventPriority = EventPriority.NORMAL
    enabled: bool = True
    max_retries: int = 3
    timeout_seconds: float = 30.0

    def __post_init__(self) -> None:
        """Validate event handler."""
        if not self.handler_id or not self.handler_id.strip():
            msg = "Handler ID cannot be empty"
            raise ValueError(msg)

        if not self.event_types:
            msg = "Handler must handle at least one event type"
            raise ValueError(msg)

        if not callable(self.callback):
            msg = "Handler callback must be callable"
            raise ValueError(msg,
    )

        if self.max_retries < 0:
            msg = f"Max retries cannot be negative, got: {self.max_retries}"
            raise ValueError(msg)

        if self.timeout_seconds <= 0:
            msg = f"Timeout must be positive, got: {self.timeout_seconds}"
            raise ValueError(msg)

    def can_handle(self, event_type: EventType,
    ) -> bool:
        """Check if handler can handle event type."""
        return self.enabled and event_type in self.event_types


@dataclass
class EventProcessingResult:
    """Value object for event processing result."""
    event_id: str
    handler_id: str
    status: EventStatus
    result: Any | None = None
    error: str | None = None
    processing_time_ms: float = 0.0
    retry_count: int = 0

    def is_successful(self) -> bool:
        """Check if processing was successful."""
        return self.status == EventStatus.COMPLETED

    def is_failed(self) -> bool:
        """Check if processing failed."""
        return self.status == EventStatus.FAILED

    def needs_retry(self,
    ) -> bool:
        """Check if processing needs retry."""
        return self.status == EventStatus.FAILED and self.error is not None


@dataclass
class EventFilter:
    """Value object for event filtering."""
    filter_id: str
    event_types: set[EventType] | None = None
    sources: set[str] | None = None
    priorities: set[EventPriority] | None = None
    payload_filters: dict[str, Any] | None = None
    enabled: bool = True

    def __post_init__(self) -> None:
        """Validate event filter."""
        if not self.filter_id or not self.filter_id.strip():
            msg = "Filter ID cannot be empty"
            raise ValueError(msg,
    )

    def matches(self, event: EventData,
    ) -> bool:
        """Check if event matches filter criteria."""
        if not self.enabled:
            return True

        # Check event type
        if self.event_types and event.event_type not in self.event_types:
            return False

        # Check source
        if self.sources and event.source not in self.sources:
            return False

        # Check priority
        if self.priorities and event.priority not in self.priorities:
            return False

        # Check payload filters
        if self.payload_filters:
            for key, expected_value in self.payload_filters.items():
                if not event.has_payload_key(key):
                    return False
                if event.get_payload_value(key) != expected_value:
                    return False

        return True


class EventSystemIntegration(Entity):
    """Entity for event system integration and management.

    Note: This contains behavior that belongs to an infrastructure adapter.
    It should be moved to an infra service implementing the domain event bus port.
    """

    def __init__(
        self,
        system_id: str,
        max_queue_size: int = 1000,
        enable_metrics: bool = True,
    ):
        """Initialize event system integration."""
        super().__init__(system_id)
        self._system_id = system_id
        self._max_queue_size = max_queue_size
        self._enable_metrics = enable_metrics

        # Event management
        self._event_queue: list[EventData] = []
        self._handlers: dict[str, EventHandler] = {}
        self._filters: dict[str, EventFilter] = {}
        self._processing_results: dict[str, list[EventProcessingResult]] = {}

        # Event routing
        self._event_routes: dict[EventType, set[str]] = {}  # event_type -> handler_ids
        self._global_handlers: set[str] = set()  # handlers that process all events

        # Metrics
        self._event_count: dict[EventType, int] = {}
        self._processing_times: dict[str, list[float]] = {}  # handler_id -> processing_times
        self._error_count: dict[str, int] = {}  # handler_id -> error_count

        # State
        self._is_processing: bool = False
        self._processing_paused: bool = False

        # Callbacks
        self._event_callbacks: dict[str, Callable[[EventData], None]] = {}
        self._error_callback: Callable[[str, Exception], None] | None = None

    @property
    def system_id(self) -> str:
        """Get system ID."""
        return self._system_id

    @property
    def queue_size(self) -> int:
        """Get current queue size."""
        return len(self._event_queue)

    @property
    def max_queue_size(self) -> int:
        """Get maximum queue size."""
        return self._max_queue_size

    @property
    def is_processing(self) -> bool:
        """Check if system is processing events."""
        return self._is_processing

    @property
    def is_paused(self) -> bool:
        """Check if processing is paused."""
        return self._processing_paused

    @property
    def handler_count(self) -> int:
        """Get number of registered handlers."""
        return len(self._handlers)

    def register_handler(self, handler: EventHandler,
    ) -> None:
        """Register an event handler."""
        if handler.handler_id in self._handlers:
            msg = f"Handler with ID '{handler.handler_id}' already exists"
            raise ValueError(msg)

        self._handlers[handler.handler_id] = handler

        # Update routing
        for event_type in handler.event_types:
            if event_type not in self._event_routes:
                self._event_routes[event_type] = set()
            self._event_routes[event_type].add(handler.handler_id,
    )

        # Initialize metrics
        if self._enable_metrics:
            self._processing_times[handler.handler_id] = []
            self._error_count[handler.handler_id] = 0

    def unregister_handler(self, handler_id: str,
    ) -> None:
        """Unregister an event handler."""
        if handler_id not in self._handlers:
            msg = f"Handler with ID '{handler_id}' does not exist"
            raise ValueError(msg)

        handler = self._handlers[handler_id]

        # Update routing
        for event_type in handler.event_types:
            if event_type in self._event_routes:
                self._event_routes[event_type].discard(handler_id)
                if not self._event_routes[event_type]:
                    del self._event_routes[event_type]

        # Remove from global handlers
        self._global_handlers.discard(handler_id,
    )

        # Clean up
        del self._handlers[handler_id]
        if handler_id in self._processing_times:
            del self._processing_times[handler_id]
        if handler_id in self._error_count:
            del self._error_count[handler_id]
        if handler_id in self._processing_results:
            del self._processing_results[handler_id]

    def get_handler(self, handler_id: str,
    ) -> EventHandler | None:
        """Get event handler by ID."""
        return self._handlers.get(handler_id)

    def register_global_handler(self, handler_id: str,
    ) -> None:
        """Register handler to process all events."""
        if handler_id not in self._handlers:
            msg = f"Handler with ID '{handler_id}' does not exist"
            raise ValueError(msg)

        self._global_handlers.add(handler_id,
    )

    def unregister_global_handler(self, handler_id: str,
    ) -> None:
        """Unregister global handler."""
        self._global_handlers.discard(handler_id)

    def add_filter(self, event_filter: EventFilter,
    ) -> None:
        """Add event filter."""
        if event_filter.filter_id in self._filters:
            msg = f"Filter with ID '{event_filter.filter_id}' already exists"
            raise ValueError(msg,
    )

        self._filters[event_filter.filter_id] = event_filter

    def remove_filter(self, filter_id: str,
    ) -> None:
        """Remove event filter."""
        if filter_id not in self._filters:
            msg = f"Filter with ID '{filter_id}' does not exist"
            raise ValueError(msg,
    )

        del self._filters[filter_id]

    def get_filter(self, filter_id: str,
    ) -> EventFilter | None:
        """Get event filter by ID."""
        return self._filters.get(filter_id)

    def publish_event(self, event: EventData,
    ) -> None:
        """Publish an event to the system."""
        # Check queue size
        if len(self._event_queue) >= self._max_queue_size:
            msg = f"Event queue is full (max size: {self._max_queue_size})"
            raise ValueError(msg)

        # Apply filters
        for event_filter in self._filters.values():
            if not event_filter.matches(event):
                return  # Event filtered out

        # Add to queue
        self._event_queue.append(event)

        # Update metrics
        if self._enable_metrics:
            if event.event_type not in self._event_count:
                self._event_count[event.event_type] = 0
            self._event_count[event.event_type] += 1

        # Trigger event callback
        callback = self._event_callbacks.get("event_published")
        if callback:
            try:
                callback(event)
            except Exception:
                pass  # Don't let callback errors affect event publishing

    def process_events(self,
    ) -> list[EventProcessingResult]:
        """Process all events in the queue."""
        if self._processing_paused:
            return []

        self._is_processing = True
        results = []

        try:
            # Process events by priority
            events_to_process = sorted(
                self._event_queue,
                key=lambda e: (e.priority.value, e.timestamp),
            )

            for event in events_to_process:
                event_results = self._process_single_event(event)
                results.extend(event_results)

            # Clear processed events
            self._event_queue.clear()

        finally:
            self._is_processing = False

        return results

    def _process_single_event(self, event: EventData,
    ) -> list[EventProcessingResult]:
        """Process a single event."""
        results = []

        # Get handlers for this event type
        handler_ids = set()

        # Add specific handlers
        if event.event_type in self._event_routes:
            handler_ids.update(self._event_routes[event.event_type])

        # Add global handlers
        handler_ids.update(self._global_handlers)

        # Process with each handler
        for handler_id in handler_ids:
            handler = self._handlers.get(handler_id)
            if not handler or not handler.can_handle(event.event_type,
    ):
                continue

            result = self._execute_handler(handler, event)
            results.append(result)

            # Store result
            if handler_id not in self._processing_results:
                self._processing_results[handler_id] = []
            self._processing_results[handler_id].append(result)

        return results

    def _execute_handler(self, handler: EventHandler, event: EventData,
    ) -> EventProcessingResult:
        """Execute a handler for an event."""
        start_time = DomainIdentityGenerator.generate_timestamp()
        result = EventProcessingResult(
            event_id=event.event_id,
            handler_id=handler.handler_id,
            status=EventStatus.PROCESSING,
        )

        try:
            # Execute handler callback
            handler_result = handler.callback(event)

            # Calculate processing time
            processing_time = float(DomainIdentityGenerator.generate_timestamp() - start_time) * 1000.0

            # Update result
            result.status = EventStatus.COMPLETED
            result.result = handler_result
            result.processing_time_ms = processing_time

            # Update metrics
            if self._enable_metrics:
                self._processing_times[handler.handler_id].append(processing_time)

        except Exception as e:
            # Calculate processing time
            processing_time = float(DomainIdentityGenerator.generate_timestamp() - start_time) * 1000.0

            # Update result
            result.status = EventStatus.FAILED
            result.error = str(e)
            result.processing_time_ms = processing_time

            # Update metrics
            if self._enable_metrics:
                self._error_count[handler.handler_id] += 1

            # Call error callback
            if self._error_callback:
                try:
                    self._error_callback(handler.handler_id, e)
                except Exception:
                    pass  # Don't let error callback errors affect processing

        return result

    def pause_processing(self) -> None:
        """Pause event processing."""
        self._processing_paused = True

    def resume_processing(self) -> None:
        """Resume event processing."""
        self._processing_paused = False

    def clear_queue(self) -> None:
        """Clear all events from queue."""
        self._event_queue.clear()

    def get_queue_events(self) -> list[EventData]:
        """Get copy of current queue events."""
        return self._event_queue.copy()

    def get_events_by_type(self, event_type: EventType,
    ) -> list[EventData]:
        """Get events of specific type from queue."""
        return [event for event in self._event_queue if event.event_type == event_type]

    def get_processing_results(self, handler_id: str,
    ) -> list[EventProcessingResult]:
        """Get processing results for a handler."""
        return self._processing_results.get(handler_id, []).copy()

    def get_handler_metrics(self, handler_id: str,
    ) -> dict[str, Any]:
        """Get metrics for a specific handler."""
        if not self._enable_metrics or handler_id not in self._handlers:
            return {}

        processing_times = self._processing_times.get(handler_id, [])
        error_count = self._error_count.get(handler_id, 0)

        return {
            "handler_id": handler_id,
            "total_processed": len(processing_times),
            "error_count": error_count,
            "success_rate": 1.0 - (error_count / max(1, len(processing_times))),
            "avg_processing_time_ms": sum(processing_times) / max(1, len(processing_times)),
            "min_processing_time_ms": min(processing_times) if processing_times else 0,
            "max_processing_time_ms": max(processing_times) if processing_times else 0,
        }

    def get_system_metrics(self) -> dict[str, Any]:
        """Get overall system metrics."""
        if not self._enable_metrics:
            return {}

        total_events = sum(self._event_count.values())
        total_errors = sum(self._error_count.values())

        return {
            "system_id": self._system_id,
            "total_events_processed": total_events,
            "total_errors": total_errors,
            "current_queue_size": len(self._event_queue),
            "registered_handlers": len(self._handlers),
            "active_filters": len([f for f in self._filters.values() if f.enabled]),
            "events_by_type": dict(self._event_count),
            "error_rate": total_errors / max(1, total_events),
            "is_processing": self._is_processing,
            "is_paused": self._processing_paused,
        }

    def set_event_callback(self, callback_name: str, callback: Callable[[EventData], None]) -> None:
        """Set event callback."""
        self._event_callbacks[callback_name] = callback

    def set_error_callback(self, callback: Callable[[str, Exception], None]) -> None:
        """Set error callback."""
        self._error_callback = callback

    def reset_metrics(self) -> None:
        """Reset all metrics."""
        if self._enable_metrics:
            self._event_count.clear()
            self._processing_times.clear()
            self._error_count.clear()
            self._processing_results.clear()

            # Reinitialize for existing handlers
            for handler_id in self._handlers:
                self._processing_times[handler_id] = []
                self._error_count[handler_id] = 0