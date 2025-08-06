"""Event Bus Infrastructure.

This module provides event bus capabilities for the WinSTT application,
enabling decoupled communication between components through domain events.
"""

import inspect
import logging
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from threading import Lock, RLock
from typing import Any, Generic, Protocol, TypeVar

from PyQt6.QtCore import QObject, QTimer, pyqtSignal

from src_refactored.domain.common.events import DomainEvent
from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject

T = TypeVar("T")
E = TypeVar("E", bound=DomainEvent)


class EventPriority(Enum):
    """Enumeration of event priorities."""
    LOW = 1
    NORMAL = 2
    HIGH = 3
    CRITICAL = 4


class EventDeliveryMode(Enum):
    """Enumeration of event delivery modes."""
    SYNC = "sync"  # Synchronous delivery
    ASYNC = "async"  # Asynchronous delivery
    QUEUED = "queued"  # Queued for batch processing
    IMMEDIATE = "immediate"  # Immediate delivery (bypass queue)


class EventHandlerType(Enum):
    """Enumeration of event handler types."""
    FUNCTION = "function"
    METHOD = "method"
    OBJECT = "object"
    LAMBDA = "lambda"


@dataclass(frozen=True)
class EventMetadata(ValueObject):
    """Value object representing event metadata."""
    event_id: str
    event_type: str
    timestamp: datetime
    source: str
    priority: EventPriority = EventPriority.NORMAL
    delivery_mode: EventDeliveryMode = EventDeliveryMode.ASYNC
    correlation_id: str | None = None
    causation_id: str | None = None
    version: int = 1
    metadata: dict[str, Any] = field(default_factory=dict)
    
    def _get_equality_components(self) -> tuple:
        return (
            self.event_id,
            self.event_type,
            self.timestamp,
            self.source,
            self.priority,
            self.delivery_mode,
            self.correlation_id,
            self.causation_id,
            self.version,
            tuple(sorted(self.metadata.items())),
        )
    
    @classmethod
    def create(cls, event_id: str, event_type: str, source: str,
               priority: EventPriority = EventPriority.NORMAL,
               delivery_mode: EventDeliveryMode = EventDeliveryMode.ASYNC,
               **kwargs) -> "EventMetadata":
        """Create event metadata.
        
        Args:
            event_id: Event identifier
            event_type: Event type
            source: Event source
            priority: Event priority
            delivery_mode: Event delivery mode
            **kwargs: Additional metadata
            
        Returns:
            Event metadata
        """
        return cls(
            event_id=event_id,
            event_type=event_type,
            timestamp=datetime.utcnow(),
            source=source,
            priority=priority,
            delivery_mode=delivery_mode,
            metadata=kwargs,
        )
    
    def with_correlation_id(self, correlation_id: str) -> "EventMetadata":
        """Create new metadata with correlation ID.
        
        Args:
            correlation_id: Correlation identifier
            
        Returns:
            New event metadata
        """
        return EventMetadata(
            event_id=self.event_id,
            event_type=self.event_type,
            timestamp=self.timestamp,
            source=self.source,
            priority=self.priority,
            delivery_mode=self.delivery_mode,
            correlation_id=correlation_id,
            causation_id=self.causation_id,
            version=self.version,
            metadata=self.metadata,
        )
    
    def with_causation_id(self, causation_id: str) -> "EventMetadata":
        """Create new metadata with causation ID.
        
        Args:
            causation_id: Causation identifier
            
        Returns:
            New event metadata
        """
        return EventMetadata(
            event_id=self.event_id,
            event_type=self.event_type,
            timestamp=self.timestamp,
            source=self.source,
            priority=self.priority,
            delivery_mode=self.delivery_mode,
            correlation_id=self.correlation_id,
            causation_id=causation_id,
            version=self.version,
            metadata=self.metadata,
        )


@dataclass
class EventEnvelope(Generic[E]):
    """Envelope containing event and metadata."""
    event: E
    metadata: EventMetadata
    retry_count: int = 0
    max_retries: int = 3
    last_error: str | None = None
    
    @property
    def event_type(self) -> str:
        """Get event type.
        
        Returns:
            Event type
        """
        return self.metadata.event_type
    
    @property
    def event_id(self) -> str:
        """Get event ID.
        
        Returns:
            Event ID
        """
        return self.metadata.event_id
    
    @property
    def can_retry(self) -> bool:
        """Check if event can be retried.
        
        Returns:
            True if event can be retried
        """
        return self.retry_count < self.max_retries
    
    def increment_retry(self, error: str) -> None:
        """Increment retry count.
        
        Args:
            error: Error message
        """
        self.retry_count += 1
        self.last_error = error


class IEventHandler(Protocol[E]):
    """Protocol for event handlers."""
    
    def handle(self, event: E, metadata: EventMetadata) -> None:
        """Handle an event.
        
        Args:
            event: Domain event
            metadata: Event metadata
        """
        ...
    
    def can_handle(self, event_type: str) -> bool:
        """Check if handler can handle event type.
        
        Args:
            event_type: Event type
            
        Returns:
            True if handler can handle the event type
        """
        ...


class IEventBus(Protocol):
    """Protocol for event bus."""
    
    def publish(self, event: DomainEvent, metadata: EventMetadata | None = None) -> Result[None]:
        """Publish an event.
        
        Args:
            event: Domain event
            metadata: Optional event metadata
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    def subscribe(self, event_type: type[E], handler: IEventHandler[E]) -> Result[str]:
        """Subscribe to an event type.
        
        Args:
            event_type: Event type to subscribe to
            handler: Event handler
            
        Returns:
            Result containing subscription ID
        """
        ...
    
    def unsubscribe(self, subscription_id: str) -> Result[None]:
        """Unsubscribe from events.
        
        Args:
            subscription_id: Subscription identifier
            
        Returns:
            Result indicating success or failure
        """
        ...


class EventHandler(Generic[E]):
    """Base event handler implementation."""
    
    def __init__(self, handler_id: str, event_type: type[E], 
                 handler_func: Callable[[E, EventMetadata], None],
                 handler_type: EventHandlerType = EventHandlerType.FUNCTION):
        """Initialize event handler.
        
        Args:
            handler_id: Handler identifier
            event_type: Event type
            handler_func: Handler function
            handler_type: Handler type
        """
        self.handler_id = handler_id
        self.event_type = event_type
        self.handler_func = handler_func
        self.handler_type = handler_type
        self._is_active = True
        
        self.logger = logging.getLogger(__name__)
    
    def handle(self, event: E, metadata: EventMetadata) -> None:
        """Handle an event.
        
        Args:
            event: Domain event
            metadata: Event metadata
            
        Raises:
            Exception: If handler execution fails
        """
        if not self._is_active:
            return
        
        try:
            self.handler_func(event, metadata)
            self.logger.debug(f"Handler {self.handler_id} processed event {metadata.event_id}")
            
        except Exception as e:
            self.logger.exception(f"Handler {self.handler_id} failed to process event {metadata.event_id}: {e}")
            raise
    
    def can_handle(self, event_type: str) -> bool:
        """Check if handler can handle event type.
        
        Args:
            event_type: Event type
            
        Returns:
            True if handler can handle the event type
        """
        return self._is_active and self.event_type.__name__ == event_type
    
    def activate(self) -> None:
        """Activate the handler."""
        self._is_active = True
    
    def deactivate(self) -> None:
        """Deactivate the handler."""
        self._is_active = False
    
    def is_active(self) -> bool:
        """Check if handler is active.
        
        Returns:
            True if handler is active
        """
        return self._is_active


class EventBus(QObject, IEventBus):
    """Event bus implementation with PyQt signals."""
    
    # Signals
    event_published = pyqtSignal(str, object, object)  # event_type, event, metadata
    event_handled = pyqtSignal(str, str, str)  # event_id, handler_id, event_type
    event_failed = pyqtSignal(str, str, str, str)  # event_id, handler_id, event_type, error
    handler_registered = pyqtSignal(str, str)  # subscription_id, event_type
    handler_unregistered = pyqtSignal(str, str)  # subscription_id, event_type
    
    def __init__(self, bus_id: str | None = None, max_queue_size: int = 1000):
        """Initialize event bus.
        
        Args:
            bus_id: Optional bus identifier
            max_queue_size: Maximum queue size for async events
        """
        super().__init__()
        self.bus_id = bus_id or f"eventbus_{id(self)}"
        self.max_queue_size = max_queue_size
        
        self._handlers: dict[str, list[EventHandler]] = defaultdict(list)
        self._subscriptions: dict[str, EventHandler] = {}
        self._event_queue: deque = deque(maxlen=max_queue_size)
        self._processing_queue = False
        self._lock = RLock()
        
        # Statistics
        self._stats = {
            "events_published": 0,
            "events_handled": 0,
            "events_failed": 0,
            "handlers_registered": 0,
            "queue_size": 0,
        }
        
        # Queue processing timer
        self._queue_timer = QTimer()
        self._queue_timer.timeout.connect(self._process_queue)
        self._queue_timer.start(100)  # Process queue every 100ms
        
        self.logger = logging.getLogger(__name__)
        self.logger.info(f"Event bus {self.bus_id} initialized")
    
    def publish(self, event: DomainEvent, metadata: EventMetadata | None = None) -> Result[None]:
        """Publish an event.
        
        Args:
            event: Domain event
            metadata: Optional event metadata
            
        Returns:
            Result indicating success or failure
        """
        try:
            # Create metadata if not provided
            if not metadata:
                metadata = EventMetadata.create(
                    event_id=f"{event.__class__.__name__}_{id(event)}",
                    event_type=event.__class__.__name__,
                    source=self.bus_id,
                )
            
            # Create envelope
            envelope = EventEnvelope(event=event, metadata=metadata)
            
            with self._lock:
                self._stats["events_published"] += 1
                
                # Handle based on delivery mode
                if metadata.delivery_mode in (EventDeliveryMode.IMMEDIATE, EventDeliveryMode.SYNC):
                    self._deliver_event_sync(envelope)
                else:  # ASYNC or QUEUED
                    self._queue_event(envelope)
            
            self.event_published.emit(metadata.event_type, event, metadata)
            self.logger.debug(f"Published event {metadata.event_id} of type {metadata.event_type}")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to publish event: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def subscribe(self, event_type: type[E], handler: IEventHandler[E] | Callable[[E, EventMetadata], None],
                 handler_id: str | None = None) -> Result[str]:
        """Subscribe to an event type.
        
        Args:
            event_type: Event type to subscribe to
            handler: Event handler or handler function
            handler_id: Optional handler identifier
            
        Returns:
            Result containing subscription ID
        """
        try:
            # Generate handler ID if not provided
            if not handler_id:
                handler_id = f"{event_type.__name__}_handler_{len(self._handlers[event_type.__name__])}"
            
            # Create handler wrapper if needed
            if callable(handler) and not isinstance(handler, EventHandler):
                handler_type = EventHandlerType.FUNCTION
                if inspect.ismethod(handler):
                    handler_type = EventHandlerType.METHOD
                elif hasattr(handler, "__name__") and handler.__name__ == "<lambda>":
                    handler_type = EventHandlerType.LAMBDA
                
                # Cast handler to the expected type for EventHandler
                from typing import cast
                handler_func = cast("Callable[[event_type, EventMetadata], None]", handler)
                event_handler = EventHandler(
                    handler_id=handler_id,
                    event_type=event_type,
                    handler_func=handler_func,
                    handler_type=handler_type,
                )
            else:
                event_handler = handler
            
            with self._lock:
                # Check for duplicate subscription
                if handler_id in self._subscriptions:
                    return Result.failure(f"Handler {handler_id} already registered")
                
                # Register handler
                event_type_name = event_type.__name__
                self._handlers[event_type_name].append(event_handler)
                self._subscriptions[handler_id] = event_handler
                self._stats["handlers_registered"] += 1
            
            self.handler_registered.emit(handler_id, event_type_name)
            self.logger.info(f"Registered handler {handler_id} for event type {event_type_name}")
            
            return Result.success(handler_id)
            
        except Exception as e:
            error_msg = f"Failed to subscribe handler: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def unsubscribe(self, subscription_id: str) -> Result[None]:
        """Unsubscribe from events.
        
        Args:
            subscription_id: Subscription identifier
            
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                if subscription_id not in self._subscriptions:
                    return Result.failure(f"Subscription {subscription_id} not found")
                
                handler = self._subscriptions[subscription_id]
                event_type_name = handler.event_type.__name__
                
                # Remove from handlers list
                if event_type_name in self._handlers:
                    self._handlers[event_type_name] = [
                        h for h in self._handlers[event_type_name] 
                        if h.handler_id != subscription_id
                    ]
                    
                    # Clean up empty handler lists
                    if not self._handlers[event_type_name]:
                        del self._handlers[event_type_name]
                
                # Remove from subscriptions
                del self._subscriptions[subscription_id]
            
            self.handler_unregistered.emit(subscription_id, event_type_name)
            self.logger.info(f"Unregistered handler {subscription_id} for event type {event_type_name}")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to unsubscribe handler: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def _queue_event(self, envelope: EventEnvelope) -> None:
        """Queue an event for async processing.
        
        Args:
            envelope: Event envelope
        """
        with self._lock:
            if len(self._event_queue) >= self.max_queue_size:
                # Remove oldest event if queue is full
                removed = self._event_queue.popleft()
                self.logger.warning(f"Event queue full, dropped event {removed.event_id}")
            
            self._event_queue.append(envelope)
            self._stats["queue_size"] = len(self._event_queue)
    
    def _process_queue(self) -> None:
        """Process queued events."""
        if self._processing_queue:
            return
        
        try:
            self._processing_queue = True
            
            # Process events in batches
            batch_size = min(10, len(self._event_queue))
            
            for _ in range(batch_size):
                with self._lock:
                    if not self._event_queue:
                        break
                    envelope = self._event_queue.popleft()
                    self._stats["queue_size"] = len(self._event_queue)
                
                try:
                    self._deliver_event_sync(envelope)
                except Exception as e:
                    self.logger.exception(f"Failed to process queued event {envelope.event_id}: {e}")
                    
                    # Retry logic
                    if envelope.can_retry:
                        envelope.increment_retry(str(e))
                        with self._lock:
                            self._event_queue.append(envelope)
                            self._stats["queue_size"] = len(self._event_queue)
                    else:
                        self.logger.exception(f"Event {envelope.event_id} failed after {envelope.max_retries} retries")
                        with self._lock:
                            self._stats["events_failed"] += 1
                        
                        self.event_failed.emit(
                            envelope.event_id, 
                            "queue_processor", 
                            envelope.event_type, 
                            envelope.last_error or str(e),
                        )
        
        finally:
            self._processing_queue = False
    
    def _deliver_event_sync(self, envelope: EventEnvelope) -> None:
        """Deliver event synchronously to handlers.
        
        Args:
            envelope: Event envelope
            
        Raises:
            Exception: If event delivery fails
        """
        event_type_name = envelope.event_type
        
        with self._lock:
            handlers = self._handlers.get(event_type_name, [])
            active_handlers = [h for h in handlers if h.is_active()]
        
        if not active_handlers:
            self.logger.debug(f"No active handlers for event type {event_type_name}")
            return
        
        # Sort handlers by priority (if metadata has priority info)
        if hasattr(envelope.metadata, "priority"):
            active_handlers.sort(key=lambda h: envelope.metadata.priority.value, reverse=True)
        
        # Deliver to each handler
        for handler in active_handlers:
            try:
                handler.handle(envelope.event, envelope.metadata)
                
                with self._lock:
                    self._stats["events_handled"] += 1
                
                self.event_handled.emit(
                    envelope.event_id,
                    handler.handler_id,
                    event_type_name,
                )
                
            except Exception as e:
                error_msg = f"Handler {handler.handler_id} failed: {e!s}"
                self.logger.exception(error_msg)
                
                with self._lock:
                    self._stats["events_failed"] += 1
                
                self.event_failed.emit(
                    envelope.event_id,
                    handler.handler_id,
                    event_type_name,
                    error_msg,
                )
                
                # Continue with other handlers
                continue
    
    def get_handler_count(self, event_type: str | None = None) -> int:
        """Get number of registered handlers.
        
        Args:
            event_type: Optional event type filter
            
        Returns:
            Number of handlers
        """
        with self._lock:
            if event_type:
                return len(self._handlers.get(event_type, []))
            return sum(len(handlers) for handlers in self._handlers.values())
    
    def get_queue_size(self) -> int:
        """Get current queue size.
        
        Returns:
            Queue size
        """
        with self._lock:
            return len(self._event_queue)
    
    def get_statistics(self) -> dict[str, Any]:
        """Get event bus statistics.
        
        Returns:
            Statistics dictionary
        """
        with self._lock:
            stats = self._stats.copy()
            stats["queue_size"] = len(self._event_queue)
            stats["handler_count"] = self.get_handler_count()
            stats["event_types"] = list(self._handlers.keys())
            return stats
    
    def clear_queue(self) -> Result[None]:
        """Clear the event queue.
        
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                cleared_count = len(self._event_queue)
                self._event_queue.clear()
                self._stats["queue_size"] = 0
            
            self.logger.info(f"Cleared {cleared_count} events from queue")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to clear queue: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def shutdown(self) -> Result[None]:
        """Shutdown the event bus.
        
        Returns:
            Result indicating success or failure
        """
        try:
            # Stop queue processing
            self._queue_timer.stop()
            
            # Process remaining events
            while self._event_queue:
                try:
                    self._process_queue()
                except Exception as e:
                    self.logger.exception(f"Error processing remaining events: {e}")
                    break
            
            # Clear handlers and subscriptions
            with self._lock:
                self._handlers.clear()
                self._subscriptions.clear()
                self._event_queue.clear()
            
            self.logger.info(f"Event bus {self.bus_id} shutdown")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to shutdown event bus: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)


class EventBusManager:
    """Manager for multiple event buses."""
    
    def __init__(self):
        """Initialize event bus manager."""
        self._buses: dict[str, EventBus] = {}
        self._default_bus: EventBus | None = None
        self._lock = Lock()
        
        self.logger = logging.getLogger(__name__)
    
    def create_bus(self, bus_id: str, max_queue_size: int = 1000, 
                   set_as_default: bool = False) -> Result[EventBus]:
        """Create an event bus.
        
        Args:
            bus_id: Bus identifier
            max_queue_size: Maximum queue size
            set_as_default: Whether to set as default bus
            
        Returns:
            Result containing the created bus
        """
        try:
            with self._lock:
                if bus_id in self._buses:
                    return Result.failure(f"Bus '{bus_id}' already exists")
                
                bus = EventBus(bus_id, max_queue_size)
                self._buses[bus_id] = bus
                
                if set_as_default or not self._default_bus:
                    self._default_bus = bus
                
                self.logger.info(f"Created event bus '{bus_id}'")
                return Result.success(bus)
                
        except Exception as e:
            error_msg = f"Failed to create event bus: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def get_bus(self, bus_id: str | None = None) -> EventBus | None:
        """Get an event bus.
        
        Args:
            bus_id: Optional bus identifier (uses default if not provided)
            
        Returns:
            Event bus or None if not found
        """
        with self._lock:
            if bus_id:
                return self._buses.get(bus_id)
            return self._default_bus
    
    def remove_bus(self, bus_id: str) -> Result[None]:
        """Remove an event bus.
        
        Args:
            bus_id: Bus identifier
            
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                if bus_id not in self._buses:
                    return Result.failure(f"Bus '{bus_id}' not found")
                
                bus = self._buses[bus_id]
                
                # Shutdown the bus
                shutdown_result = bus.shutdown()
                if not shutdown_result.is_success:
                    self.logger.warning(f"Failed to shutdown bus '{bus_id}': {shutdown_result.error()}")
                
                # Remove from registry
                del self._buses[bus_id]
                
                # Update default bus if needed
                if self._default_bus == bus:
                    self._default_bus = next(iter(self._buses.values())) if self._buses else None
                
                self.logger.info(f"Removed event bus '{bus_id}'")
                return Result.success(None)
                
        except Exception as e:
            error_msg = f"Failed to remove event bus: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def get_all_buses(self) -> list[str]:
        """Get list of all bus IDs.
        
        Returns:
            List of bus IDs
        """
        with self._lock:
            return list(self._buses.keys())
    
    def get_default_bus_id(self) -> str | None:
        """Get default bus ID.
        
        Returns:
            Default bus ID or None
        """
        with self._lock:
            return self._default_bus.bus_id if self._default_bus else None
    
    def set_default_bus(self, bus_id: str) -> Result[None]:
        """Set default bus.
        
        Args:
            bus_id: Bus identifier
            
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                if bus_id not in self._buses:
                    return Result.failure(f"Bus '{bus_id}' not found")
                
                self._default_bus = self._buses[bus_id]
                self.logger.info(f"Set default bus to '{bus_id}'")
                return Result.success(None)
                
        except Exception as e:
            error_msg = f"Failed to set default bus: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def shutdown_all(self) -> Result[None]:
        """Shutdown all event buses.
        
        Returns:
            Result indicating success or failure
        """
        try:
            with self._lock:
                bus_ids = list(self._buses.keys())
            
            for bus_id in bus_ids:
                result = self.remove_bus(bus_id)
                if not result.is_success:
                    self.logger.warning(f"Failed to remove bus '{bus_id}': {result.error()}")
            
            self.logger.info("All event buses shutdown")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to shutdown all buses: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)


# Global event bus manager instance
_event_bus_manager = EventBusManager()


# Convenience functions
def get_event_bus(bus_id: str | None = None) -> EventBus | None:
    """Get an event bus.
    
    Args:
        bus_id: Optional bus identifier
        
    Returns:
        Event bus or None
    """
    return _event_bus_manager.get_bus(bus_id)


def create_event_bus(bus_id: str, max_queue_size: int = 1000, 
                    set_as_default: bool = False) -> Result[EventBus]:
    """Create an event bus.
    
    Args:
        bus_id: Bus identifier
        max_queue_size: Maximum queue size
        set_as_default: Whether to set as default bus
        
    Returns:
        Result containing the created bus
    """
    return _event_bus_manager.create_bus(bus_id, max_queue_size, set_as_default)


def publish_event(event: DomainEvent, metadata: EventMetadata | None = None, 
                 bus_id: str | None = None) -> Result[None]:
    """Publish an event.
    
    Args:
        event: Domain event
        metadata: Optional event metadata
        bus_id: Optional bus identifier
        
    Returns:
        Result indicating success or failure
    """
    bus = get_event_bus(bus_id)
    if not bus:
        return Result.failure(f"Event bus '{bus_id or 'default'}' not found")
    
    return bus.publish(event, metadata)


def subscribe_to_event(event_type: type[E], 
                      handler: IEventHandler[E] | Callable[[E, EventMetadata], None],
                      handler_id: str | None = None, bus_id: str | None = None) -> Result[str]:
    """Subscribe to an event type.
    
    Args:
        event_type: Event type to subscribe to
        handler: Event handler
        handler_id: Optional handler identifier
        bus_id: Optional bus identifier
        
    Returns:
        Result containing subscription ID
    """
    bus = get_event_bus(bus_id)
    if not bus:
        return Result.failure(f"Event bus '{bus_id or 'default'}' not found")
    
    return bus.subscribe(event_type, handler, handler_id)


def unsubscribe_from_event(subscription_id: str, bus_id: str | None = None) -> Result[None]:
    """Unsubscribe from events.
    
    Args:
        subscription_id: Subscription identifier
        bus_id: Optional bus identifier
        
    Returns:
        Result indicating success or failure
    """
    bus = get_event_bus(bus_id)
    if not bus:
        return Result.failure(f"Event bus '{bus_id or 'default'}' not found")
    
    return bus.unsubscribe(subscription_id)


def initialize_default_event_bus() -> Result[EventBus]:
    """Initialize the default event bus.
    
    Returns:
        Result containing the default event bus
    """
    return create_event_bus("default", set_as_default=True)


def shutdown_event_buses() -> Result[None]:
    """Shutdown all event buses.
    
    Returns:
        Result indicating success or failure
    """
    return _event_bus_manager.shutdown_all()