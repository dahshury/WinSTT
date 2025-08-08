"""Event Publisher Service.

This module implements the event publisher service for coordinating
domain events across the application layer.
"""

from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, TypeVar

from src_refactored.domain.common.events import DomainEvent
from src_refactored.domain.common.ports.concurrency_port import IConcurrencyPort
from src_refactored.domain.common.ports.time_port import ITimePort
from src_refactored.domain.common.result import Result

T = TypeVar("T", bound=DomainEvent)


@dataclass
class EventSubscription:
    """Represents an event subscription."""
    event_type: type[DomainEvent]
    handler: Callable[[Any], None]
    priority: int = 0
    is_async: bool = False
    max_retries: int = 3
    retry_delay_seconds: float = 1.0
    timeout_seconds: float = 30.0
    created_at: datetime = field(default_factory=datetime.utcnow)


@dataclass
class EventPublishingConfiguration:
    """Configuration for event publishing."""
    enable_async_publishing: bool = True
    max_concurrent_handlers: int = 10
    default_timeout_seconds: float = 30.0
    enable_event_persistence: bool = False
    enable_dead_letter_queue: bool = True
    enable_metrics: bool = True
    enable_tracing: bool = True
    batch_size: int = 100
    batch_timeout_seconds: float = 5.0


class EventHandlerProtocol(Protocol):
    """Protocol for event handlers."""
    def handle(self, event: DomainEvent) -> None: ...


class AsyncEventHandlerProtocol(Protocol):
    """Protocol for async event handlers."""
    async def handle_async(self, event: DomainEvent) -> None: ...


class EventPersistenceProtocol(Protocol):
    """Protocol for event persistence."""
    def save_event(self, event: DomainEvent) -> Result[None]: ...
    def get_events(self, event_type: type[DomainEvent], limit: int) -> Result[list[DomainEvent]]: ...
    def mark_event_processed(self, event_id: str) -> Result[None]: ...


class DeadLetterQueueProtocol(Protocol):
    """Protocol for dead letter queue."""
    def add_failed_event(self, event: DomainEvent, error: str, retry_count: int) -> None: ...
    def get_failed_events(self, limit: int) -> list[tuple[DomainEvent, str, int]]: ...
    def remove_failed_event(self, event_id: str) -> None: ...


class EventMetricsProtocol(Protocol):
    """Protocol for event metrics."""
    def record_event_published(self, event_type: str) -> None: ...
    def record_event_processed(self, event_type: str, duration: float) -> None: ...
    def record_event_failed(self, event_type: str, error: str) -> None: ...
    def record_handler_execution(self, handler_name: str, duration: float, success: bool) -> None: ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging service."""
    def log_info(self, message: str, **kwargs) -> None: ...
    def log_error(self, message: str, **kwargs) -> None: ...
    def log_warning(self, message: str, **kwargs) -> None: ...
    def log_debug(self, message: str, **kwargs) -> None: ...


class EventPublisher:
    """Publisher for coordinating domain events.
    
    This publisher manages event subscriptions, publishing, and coordination
    across the application layer with support for async processing.
    """

    def __init__(
        self,
        configuration: EventPublishingConfiguration,
        concurrency_service: IConcurrencyPort,
        time_service: ITimePort,
        event_persistence: EventPersistenceProtocol | None = None,
        dead_letter_queue: DeadLetterQueueProtocol | None = None,
        metrics_service: EventMetricsProtocol | None = None,
        logger_service: LoggerServiceProtocol | None = None,
    ):
        self._configuration = configuration
        self._concurrency_service = concurrency_service
        self._time_service = time_service
        self._event_persistence = event_persistence
        self._dead_letter_queue = dead_letter_queue
        self._metrics_service = metrics_service
        self._logger = logger_service
        
        # Event subscriptions organized by event type
        self._subscriptions: dict[type[DomainEvent], list[EventSubscription]] = defaultdict(list)
        
        # Event queue for batch processing
        self._event_queue: list[DomainEvent] = []
        self._queue_lock = self._concurrency_service.create_lock("event_queue_lock") if configuration.enable_async_publishing else None
        
        # Active handlers tracking
        self._active_handlers: set[str] = set()
        
        # Statistics
        self._stats = {
            "events_published": 0,
            "events_processed": 0,
            "events_failed": 0,
            "handlers_executed": 0,
        }

    def subscribe(
        self,
        event_type: type[T],
        handler: Callable[[T], None],
        priority: int = 0,
        is_async: bool = False,
        max_retries: int = 3,
        retry_delay_seconds: float = 1.0,
        timeout_seconds: float = 30.0,
    ) -> str:
        """Subscribe to domain events.
        
        Args:
            event_type: Type of event to subscribe to
            handler: Handler function for the event
            priority: Handler priority (higher numbers execute first)
            is_async: Whether handler should be executed asynchronously
            max_retries: Maximum number of retries on failure
            retry_delay_seconds: Delay between retries
            timeout_seconds: Handler execution timeout
            
        Returns:
            Subscription ID for unsubscribing
        """
        subscription = EventSubscription(
            event_type=event_type,
            handler=handler,
            priority=priority,
            is_async=is_async,
            max_retries=max_retries,
            retry_delay_seconds=retry_delay_seconds,
            timeout_seconds=timeout_seconds,
        )
        
        # Add subscription and sort by priority
        self._subscriptions[event_type].append(subscription)
        self._subscriptions[event_type].sort(key=lambda s: s.priority, reverse=True)
        
        subscription_id = f"{event_type.__name__}_{id(subscription)}"
        
        if self._logger:
            self._logger.log_info(
                "Event subscription added",
                event_type=event_type.__name__,
                subscription_id=subscription_id,
                priority=priority,
                is_async=is_async,
            )
        
        return subscription_id

    def unsubscribe(self, event_type: type[DomainEvent], subscription_id: str) -> bool:
        """Unsubscribe from domain events.
        
        Args:
            event_type: Type of event to unsubscribe from
            subscription_id: Subscription ID returned from subscribe
            
        Returns:
            True if subscription was found and removed
        """
        subscriptions = self._subscriptions.get(event_type, [])
        
        for i, subscription in enumerate(subscriptions):
            if f"{event_type.__name__}_{id(subscription)}" == subscription_id:
                subscriptions.pop(i)
                
                if self._logger:
                    self._logger.log_info(
                        "Event subscription removed",
                        event_type=event_type.__name__,
                        subscription_id=subscription_id,
                    )
                
                return True
        
        return False

    def publish(self, event: DomainEvent) -> Result[None]:
        """Publish a domain event.
        
        Args:
            event: Domain event to publish
            
        Returns:
            Result indicating success or failure
        """
        try:
            # Record metrics
            if self._metrics_service:
                self._metrics_service.record_event_published(event.__class__.__name__)
            
            # Persist event if enabled
            if self._configuration.enable_event_persistence and self._event_persistence:
                persistence_result = self._event_persistence.save_event(event)
                if not persistence_result.is_success and self._logger:
                    self._logger.log_warning(
                        "Failed to persist event",
                        event_id=event.event_id,
                        error=persistence_result.error,
                    )
            
            # Add to queue for batch processing or process immediately
            if self._configuration.enable_async_publishing:
                return self._add_to_queue(event)
            return self._process_event_immediately(event)
                
        except Exception as e:
            error_msg = f"Error publishing event: {e!s}"
            if self._logger:
                self._logger.log_error(error_msg, event_id=event.event_id)
            return Result.failure(error_msg)

    async def publish_async(self, event: DomainEvent) -> Result[None]:
        """Publish a domain event asynchronously.
        
        Args:
            event: Domain event to publish
            
        Returns:
            Result indicating success or failure
        """
        try:
            # Record metrics
            if self._metrics_service:
                self._metrics_service.record_event_published(event.__class__.__name__)
            
            # Persist event if enabled
            if self._configuration.enable_event_persistence and self._event_persistence:
                persistence_result = self._event_persistence.save_event(event)
                if not persistence_result.is_success and self._logger:
                    self._logger.log_warning(
                        "Failed to persist event",
                        event_id=event.event_id,
                        error=persistence_result.error,
                    )
            
            # Process event asynchronously
            return await self._process_event_async(event)
                
        except Exception as e:
            error_msg = f"Error publishing event asynchronously: {e!s}"
            if self._logger:
                self._logger.log_error(error_msg, event_id=event.event_id)
            return Result.failure(error_msg)

    def _add_to_queue(self, event: DomainEvent) -> Result[None]:
        """Add event to processing queue."""
        try:
            self._event_queue.append(event)
            self._stats["events_published"] += 1
            
            # Process queue if batch size reached
            if len(self._event_queue) >= self._configuration.batch_size:
                return self._process_queue_batch()
            
            return Result.success(None)
            
        except Exception as e:
            return Result.failure(f"Error adding event to queue: {e!s}")

    def _process_event_immediately(self, event: DomainEvent) -> Result[None]:
        """Process event immediately without queuing."""
        try:
            start_time = self._time_service.get_current_time()
            
            # Get subscriptions for this event type
            subscriptions = self._subscriptions.get(event.__class__, [])
            
            if not subscriptions:
                if self._logger:
                    self._logger.log_debug(
                        "No subscriptions found for event",
                        event_type=event.__class__.__name__,
                        event_id=event.event_id,
                    )
                return Result.success(None)
            
            # Execute handlers
            failed_handlers = []
            for subscription in subscriptions:
                handler_result = self._execute_handler(subscription, event)
                if not handler_result.is_success:
                    failed_handlers.append((subscription, handler_result.error or "Unknown error"))
            
            # Record metrics
            duration = self._time_service.get_current_time() - start_time
            if self._metrics_service:
                self._metrics_service.record_event_processed(event.__class__.__name__, duration)
            
            self._stats["events_processed"] += 1
            
            # Handle failures
            if failed_handlers:
                self._handle_failed_handlers(event, failed_handlers)
                return Result.failure(f"Some handlers failed for event {event.event_id}")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error processing event immediately: {e!s}"
            if self._logger:
                self._logger.log_error(error_msg, event_id=event.event_id)
            return Result.failure(error_msg)

    async def _process_event_async(self, event: DomainEvent) -> Result[None]:
        """Process event asynchronously."""
        try:
            start_time = self._time_service.get_current_time()
            
            # Get subscriptions for this event type
            subscriptions = self._subscriptions.get(event.__class__, [])
            
            if not subscriptions:
                if self._logger:
                    self._logger.log_debug(
                        "No subscriptions found for event",
                        event_type=event.__class__.__name__,
                        event_id=event.event_id,
                    )
                return Result.success(None)
            
            # Execute handlers concurrently
            tasks = []
            for subscription in subscriptions:
                if subscription.is_async:
                    task = self._execute_handler_async(subscription, event)
                else:
                    task = self._concurrency_service.to_thread(self._execute_handler, subscription, event)
                tasks.append(task)
            
            # Wait for all handlers with concurrency limit
            semaphore = self._concurrency_service.create_semaphore(self._configuration.max_concurrent_handlers)
            
            async def execute_with_semaphore(task):
                async with semaphore:
                    return await task
            
            results = await self._concurrency_service.gather(
                *[execute_with_semaphore(task) for task in tasks],
                return_exceptions=True,
            )
            
            # Process results
            failed_handlers = []
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    failed_handlers.append((subscriptions[i], str(result)))
                elif isinstance(result, Result) and not result.is_success:
                    failed_handlers.append((subscriptions[i], result.error or "Unknown error"))
            
            # Record metrics
            duration = self._time_service.get_current_time() - start_time
            if self._metrics_service:
                self._metrics_service.record_event_processed(event.__class__.__name__, duration)
            
            self._stats["events_processed"] += 1
            
            # Handle failures
            if failed_handlers:
                self._handle_failed_handlers(event, failed_handlers)
                return Result.failure(f"Some handlers failed for event {event.event_id}")
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Error processing event asynchronously: {e!s}"
            if self._logger:
                self._logger.log_error(error_msg, event_id=event.event_id)
            return Result.failure(error_msg)

    def _execute_handler(self, subscription: EventSubscription, event: DomainEvent) -> Result[None]:
        """Execute a single event handler."""
        handler_name = getattr(subscription.handler, "__name__", str(subscription.handler))
        start_time = self._time_service.get_current_time()
        
        try:
            # Execute handler with retry logic
            for attempt in range(subscription.max_retries + 1):
                try:
                    subscription.handler(event)
                    
                    # Record success metrics
                    duration = self._time_service.get_current_time() - start_time
                    if self._metrics_service:
                        self._metrics_service.record_handler_execution(handler_name, duration, True)
                    
                    self._stats["handlers_executed"] += 1
                    return Result.success(None)
                    
                except Exception as e:
                    if attempt < subscription.max_retries:
                        if self._logger:
                            self._logger.log_warning(
                                "Handler execution failed, retrying",
                                handler_name=handler_name,
                                attempt=attempt + 1,
                                max_retries=subscription.max_retries,
                                error=str(e),
                            )
                        self._time_service.sleep(subscription.retry_delay_seconds)
                    else:
                        # Final failure
                        duration = self._time_service.get_current_time() - start_time
                        if self._metrics_service:
                            self._metrics_service.record_handler_execution(handler_name, duration, False)
                            self._metrics_service.record_event_failed(event.__class__.__name__, str(e))
                        
                        self._stats["events_failed"] += 1
                        return Result.failure(f"Handler failed after {subscription.max_retries + 1} attempts: {e!s}")
            
            return Result.failure("Unexpected handler execution path")
            
        except Exception as e:
            error_msg = f"Unexpected error executing handler: {e!s}"
            if self._logger:
                self._logger.log_error(error_msg, handler_name=handler_name, event_id=event.event_id)
            return Result.failure(error_msg)

    async def _execute_handler_async(self, subscription: EventSubscription, event: DomainEvent) -> Result[None]:
        """Execute a single event handler asynchronously."""
        handler_name = getattr(subscription.handler, "__name__", str(subscription.handler))
        start_time = self._time_service.get_current_time()
        
        try:
            # Execute handler with retry logic
            for attempt in range(subscription.max_retries + 1):
                try:
                    # Execute with timeout
                    async def _execute_handler_safely() -> None:
                        """Execute handler safely regardless of sync/async nature."""
                        if subscription.is_async:
                            # Async handler - await directly
                            handler_result = subscription.handler(event)  # type: ignore[func-returns-value]
                            if hasattr(handler_result, "__await__"):
                                await handler_result
                            # If not awaitable, handler was already called above
                        else:
                            # Sync handler - call directly in async context
                            subscription.handler(event)
                    
                    # Execute with timeout
                    await self._concurrency_service.wait_for(
                        _execute_handler_safely(),
                        timeout=subscription.timeout_seconds,
                    )
                    
                    # Record success metrics
                    duration = self._time_service.get_current_time() - start_time
                    if self._metrics_service:
                        self._metrics_service.record_handler_execution(handler_name, duration, True)
                    
                    self._stats["handlers_executed"] += 1
                    return Result.success(None)
                    
                except (TimeoutError, Exception) as e:
                    if attempt < subscription.max_retries:
                        if self._logger:
                            self._logger.log_warning(
                                "Async handler execution failed, retrying",
                                handler_name=handler_name,
                                attempt=attempt + 1,
                                max_retries=subscription.max_retries,
                                error=str(e),
                            )
                        await self._concurrency_service.sleep(subscription.retry_delay_seconds)
                    else:
                        # Final failure
                        duration = self._time_service.get_current_time() - start_time
                        if self._metrics_service:
                            self._metrics_service.record_handler_execution(handler_name, duration, False)
                            self._metrics_service.record_event_failed(event.__class__.__name__, str(e))
                        
                        self._stats["events_failed"] += 1
                        return Result.failure(f"Async handler failed after {subscription.max_retries + 1} attempts: {e!s}")
            
            return Result.failure("Unexpected async handler execution path")
            
        except Exception as e:
            error_msg = f"Unexpected error executing async handler: {e!s}"
            if self._logger:
                self._logger.log_error(error_msg, handler_name=handler_name, event_id=event.event_id)
            return Result.failure(error_msg)

    def _handle_failed_handlers(self, event: DomainEvent, failed_handlers: list[tuple[EventSubscription, str]]) -> None:
        """Handle failed event handlers."""
        if self._configuration.enable_dead_letter_queue and self._dead_letter_queue:
            for subscription, error in failed_handlers:
                self._dead_letter_queue.add_failed_event(event, error, subscription.max_retries)
        
        if self._logger:
            for subscription, error in failed_handlers:
                handler_name = getattr(subscription.handler, "__name__", str(subscription.handler))
                self._logger.log_error(
                    "Event handler failed",
                    handler_name=handler_name,
                    event_id=event.event_id,
                    error=error,
                )

    def _process_queue_batch(self) -> Result[None]:
        """Process a batch of events from the queue."""
        try:
            if not self._event_queue:
                return Result.success(None)
            
            # Get batch of events
            batch = self._event_queue[:self._configuration.batch_size]
            self._event_queue = self._event_queue[self._configuration.batch_size:]
            
            # Process each event in the batch
            failed_events = []
            for event in batch:
                result = self._process_event_immediately(event)
                if not result.is_success:
                    failed_events.append((event, result.error))
            
            if failed_events:
                return Result.failure(f"Failed to process {len(failed_events)} events in batch")
            
            return Result.success(None)
            
        except Exception as e:
            return Result.failure(f"Error processing event batch: {e!s}")

    def get_statistics(self) -> dict[str, Any]:
        """Get event publishing statistics."""
        return {
            **self._stats,
            "active_subscriptions": sum(len(subs) for subs in self._subscriptions.values()),
            "queued_events": len(self._event_queue),
            "active_handlers": len(self._active_handlers),
        }

    def clear_statistics(self) -> None:
        """Clear event publishing statistics."""
        self._stats = {
            "events_published": 0,
            "events_processed": 0,
            "events_failed": 0,
            "handlers_executed": 0,
        }