"""Comprehensive event system service implementation.

This module provides a thread-safe, high-performance event system with:
- Event publishing and subscription
- Priority handling
- Async processing
- Event filtering
- Event history
- Performance metrics
- CQRS pattern support
- Mediator pattern implementation
"""

import logging
import threading
import time
from collections import defaultdict, deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypeVar

from PyQt6.QtCore import QObject, QThread, pyqtSignal

from src_refactored.domain.ui_coordination.value_objects.event_system import (
    EventMetrics,
    EventPriority,
    EventStatus,
    EventSubscription,
    ICommand,
    ICommandHandler,
    IMediator,
    IObservable,
    IObserver,
    IQuery,
    IQueryHandler,
    UIEvent,
)

TEvent = TypeVar("TEvent", bound=UIEvent)
TCommand = TypeVar("TCommand", bound=ICommand)
TQuery = TypeVar("TQuery", bound=IQuery)
TResult = TypeVar("TResult")


class UIEventSystem(QObject, IObservable[UIEvent], IMediator):
    """Comprehensive UI event system with enterprise features."""

    # PyQt signals for cross-thread communication
    event_published = pyqtSignal(UIEvent)
    event_processed = pyqtSignal(UIEvent)
    event_failed = pyqtSignal(UIEvent, str)
    metrics_updated = pyqtSignal(EventMetrics)

    def __init__(self, max_history: int = 1000, max_workers: int = 4):
        """Initialize the event system.
        
        Args:
            max_history: Maximum number of events to keep in history
            max_workers: Maximum number of worker threads for async processing
        """
        super().__init__()
        self._logger = logging.getLogger(__name__)

        # Thread safety
        self._lock = threading.RLock()
        self._subscriptions: dict[type[UIEvent], list[EventSubscription]] = defaultdict(list)
        self._observers: dict[str, IObserver[UIEvent]] = {}

        # Event history and metrics
        self._event_history: deque[UIEvent] = deque(maxlen=max_history)
        self._metrics = EventMetrics()

        # Async processing
        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._processing_queue: dict[EventPriority, deque[UIEvent]] = {
            priority: deque() for priority in EventPriority
        }

        # CQRS handlers
        self._command_handlers: dict[type[ICommand], ICommandHandler] = {}
        self._query_handlers: dict[type[IQuery], IQueryHandler] = {}

        # Performance tracking
        self._processing_times: deque[float] = deque(maxlen=100)

        # Start processing thread
        self._processing_thread = QThread()
        self._processing_thread.started.connect(self._process_events)
        self._processing_thread.start()

    def subscribe(
        self,
        observer: IObserver[UIEvent],
        event_type: type[UIEvent],
        priority: EventPriority = EventPriority.NORMAL,
        is_async: bool = False,
        filter_func: Callable[[UIEvent], bool] | None = None,
    ) -> str:
        """Subscribe to events with advanced options.
        
        Args:
            observer: Observer to handle events
            event_type: Type of events to subscribe to
            priority: Processing priority
            is_async: Whether to process events asynchronously
            filter_func: Optional filter function
            
        Returns:
            Subscription ID for later unsubscription
        """
        with self._lock:
            subscription = EventSubscription(
                event_type=event_type,
                priority=priority,
                is_async=is_async,
                filter_func=filter_func,
                created_at=time.time(),
            )

            self._subscriptions[event_type].append(subscription)
            self._observers[subscription.subscription_id] = observer
            self._metrics.active_subscriptions += 1

            self._logger.debug(
                f"Subscribed {observer.__class__.__name__} to {event_type.__name__} "
                f"with ID {subscription.subscription_id}",
            )

            return subscription.subscription_id

    def unsubscribe(self, subscription_id: str,
    ) -> bool:
        """Unsubscribe from events.
        
        Args:
            subscription_id: ID returned from subscribe()
            
        Returns:
            True if successfully unsubscribed
        """
        with self._lock:
            if subscription_id not in self._observers:
                return False

            # Remove observer
            del self._observers[subscription_id]

            # Remove subscription
            for event_type, subscriptions in self._subscriptions.items():
                self._subscriptions[event_type] = [
                    sub for sub in subscriptions
                    if sub.subscription_id != subscription_id
                ]

            self._metrics.active_subscriptions -= 1
            self._logger.debug(f"Unsubscribed {subscription_id}")
            return True

    def publish(self, event: UIEvent,
    ) -> None:
        """Publish an event to all subscribers.
        
        Args:
            event: Event to publish
        """
        if not event.timestamp:
            event.timestamp = time.time()

        with self._lock:
            # Add to history
            self._event_history.append(event)

            # Update metrics
            self._metrics.events_published += 1

            # Add to processing queue based on priority
            self._processing_queue[event.priority].append(event)

            self._logger.debug(f"Published event {event.event_type} with ID {event.event_id}")

        # Emit PyQt signal
        self.event_published.emit(event)

    def _process_events(self) -> None:
        """Process events from the queue (runs in separate thread)."""
        while True:
            event = self._get_next_event()
            if event:
                self._process_single_event(event)
            else:
                time.sleep(0.01)  # Small delay when no events

    def _get_next_event(self) -> UIEvent | None:
        """Get the next event to process based on priority."""
        with self._lock:
            # Process events in priority order
            for priority in EventPriority:
                if self._processing_queue[priority]:
                    return self._processing_queue[priority].popleft()
            return None

    def _process_single_event(self, event: UIEvent,
    ) -> None:
        """Process a single event.
        
        Args:
            event: Event to process
        """
        start_time = time.time()
        event.status = EventStatus.PROCESSING

        try:
            with self._lock:
                subscriptions = self._subscriptions.get(type(event), [])

            for subscription in subscriptions:
                try:
                    # Apply filter if present
                    if subscription.filter_func and not subscription.filter_func(event):
                        continue

                    observer = self._observers.get(subscription.subscription_id)
                    if not observer:
                        continue

                    # Update subscription metrics
                    subscription.last_triggered = time.time()
                    subscription.trigger_count += 1

                    # Process event
                    if subscription.is_async:
                        self._executor.submit(observer.on_event, event)
                    else:
                        observer.on_event(event)

                except Exception as e:
                    self._logger.exception(
                        f"Error processing event {event.event_id} "
                        f"for subscription {subscription.subscription_id}: {e}",
                    )
                    self._metrics.failed_events += 1
                    event.status = EventStatus.FAILED
                    self.event_failed.emit(event, str(e))
                    return

            # Mark as completed
            event.status = EventStatus.COMPLETED
            self._metrics.events_processed += 1

            # Update performance metrics
            processing_time = time.time() - start_time
            self._processing_times.append(processing_time)
            self._update_performance_metrics()

            self.event_processed.emit(event)

        except Exception as e:
            self._logger.exception(f"Critical error processing event {event.event_id}: {e}")
            event.status = EventStatus.FAILED
            self._metrics.failed_events += 1
            self.event_failed.emit(event, str(e))

    def _update_performance_metrics(self) -> None:
        """Update performance metrics."""
        if not self._processing_times:
            return

        times = list(self._processing_times)
        self._metrics.average_processing_time = sum(times) / len(times)
        self._metrics.peak_processing_time = max(times)
        self._metrics.total_processing_time += times[-1]

        self.metrics_updated.emit(self._metrics)

    def register_command_handler(
        self,
        command_type: type[TCommand],
        handler: ICommandHandler[TCommand],
    ) -> None:
        """Register a command handler.
        
        Args:
            command_type: Type of command to handle
            handler: Handler for the command
        """
        with self._lock:
            self._command_handlers[command_type] = handler
            self._logger.debug(f"Registered command handler for {command_type.__name__}")

    def register_query_handler(
        self,
        query_type: type[TQuery],
        handler: IQueryHandler[TQuery, TResult],
    ) -> None:
        """Register a query handler.
        
        Args:
            query_type: Type of query to handle
            handler: Handler for the query
        """
        with self._lock:
            self._query_handlers[query_type] = handler
            self._logger.debug(f"Registered query handler for {query_type.__name__}")

    def send_command(self, command: ICommand,
    ) -> Any:
        """Send a command through the mediator.
        
        Args:
            command: Command to send
            
        Returns:
            Result from command handler
            
        Raises:
            ValueError: If no handler is registered for the command type
        """
        command_type = type(command)

        with self._lock:
            handler = self._command_handlers.get(command_type)

        if not handler:
            msg = f"No handler registered for command {command_type.__name__}"
            raise ValueError(msg)

        try:
            result = handler.handle(command)
            self._logger.debug(f"Executed command {command_type.__name__}")
            return result
        except Exception as e:
            self._logger.exception(f"Error executing command {command_type.__name__}: {e}",
    )
            raise

    def send_query(self, query: IQuery[TResult]) -> TResult:
        """Send a query through the mediator.
        
        Args:
            query: Query to send
            
        Returns:
            Result from query handler
            
        Raises:
            ValueError: If no handler is registered for the query type
        """
        query_type = type(query)

        with self._lock:
            handler = self._query_handlers.get(query_type)

        if not handler:
            msg = f"No handler registered for query {query_type.__name__}"
            raise ValueError(msg)

        try:
            result = handler.handle(query)
            self._logger.debug(f"Executed query {query_type.__name__}")
            return result
        except Exception as e:
            self._logger.exception(f"Error executing query {query_type.__name__}: {e}")
            raise

    def get_metrics(self,
    ) -> EventMetrics:
        """Get current event system metrics.
        
        Returns:
            Current metrics
        """
        with self._lock:
            return EventMetrics(
                events_published=self._metrics.events_published,
                events_processed=self._metrics.events_processed,
                failed_events=self._metrics.failed_events,
                active_subscriptions=self._metrics.active_subscriptions,
                average_processing_time=self._metrics.average_processing_time,
                peak_processing_time=self._metrics.peak_processing_time,
                total_processing_time=self._metrics.total_processing_time,
            )

    def get_event_history(self, event_type: type[UIEvent] | None = None) -> list[UIEvent]:
        """Get event history, optionally filtered by type.
        
        Args:
            event_type: Optional event type to filter by
            
        Returns:
            List of historical events
        """
        with self._lock:
            if event_type:
                return [event for event in self._event_history if isinstance(event, event_type)]
            return list(self._event_history)

    def clear_history(self) -> None:
        """Clear event history."""
        with self._lock:
            self._event_history.clear()
            self._logger.debug("Cleared event history")

    def shutdown(self) -> None:
        """Shutdown the event system."""
        self._logger.info("Shutting down event system")

        # Stop processing thread
        if self._processing_thread.isRunning():
            self._processing_thread.quit()
            self._processing_thread.wait()

        # Shutdown executor
        self._executor.shutdown(wait=True)

        # Clear all subscriptions
        with self._lock:
            self._subscriptions.clear()
            self._observers.clear()
            self._command_handlers.clear()
            self._query_handlers.clear()

        self._logger.info("Event system shutdown complete")