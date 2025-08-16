"""Comprehensive event system service implementation (Presentation)."""

import logging
import threading
import time
from collections import defaultdict, deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypeVar

from PyQt6.QtCore import QObject, QThread, pyqtSignal

from src_refactored.domain.common.result import Result
from src_refactored.domain.ui_coordination.value_objects.event_system import (
    EventMetrics,
    EventPriority,
    EventSubscription,
    ICommand,
    ICommandHandler,
    IObserver,
    IQuery,
    IQueryHandler,
    UIEvent,
)

TEvent = TypeVar("TEvent", bound=UIEvent)
TCommand = TypeVar("TCommand", bound=ICommand)
TQuery = TypeVar("TQuery", bound=IQuery)
TResult = TypeVar("TResult")


class UIEventSystem(QObject):
    """Comprehensive UI event system with enterprise features."""

    # PyQt signals for cross-thread communication
    event_published = pyqtSignal(UIEvent)
    event_processed = pyqtSignal(UIEvent)
    event_failed = pyqtSignal(UIEvent, str)
    metrics_updated = pyqtSignal(EventMetrics)

    def __init__(self, max_history: int = 1000, max_workers: int = 4):
        super().__init__()
        self._logger = logging.getLogger(__name__)

        # Thread safety
        self._lock = threading.RLock()
        self._subscriptions: dict[type[UIEvent], list[EventSubscription]] = defaultdict(list)
        self._observers: dict[str, IObserver] = {}

        # Event history and metrics
        self._event_history: deque[UIEvent] = deque(maxlen=max_history)
        self._metrics = EventMetrics()
        # Local counters to avoid mutating frozen metrics value object
        self._ev_count: int = 0
        self._failed_count: int = 0
        self._retry_count: int = 0
        self._processing_time_ms_total: float = 0.0
        self._last_processed_at: float = 0.0

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

    # ABC-compatible signature (matches IObservable)
    def subscribe(self, observer: IObserver[UIEvent]) -> str:  # type: ignore[override]
        return self.subscribe_with_options(observer, UIEvent)

    # Extended API with options for internal usage
    def subscribe_with_options(
        self,
        observer: IObserver[UIEvent],
        event_type: type[UIEvent],
        priority: EventPriority = EventPriority.NORMAL,
        is_async: bool = False,
        filter_func: Callable[[UIEvent], bool] | None = None,
    ) -> str:
        with self._lock:
            # Adapt to domain value object shape
            subscription = EventSubscription(
                event_type=event_type.__name__,
                subscriber_id=f"sub_{len(self._observers)+1}",
                priority=priority,
                filter_criteria={},
            )
            self._subscriptions[event_type].append(subscription)
            # Use subscriber_id as key
            self._observers[subscription.subscriber_id] = observer
            # Metrics is a ValueObject with read-only fields in some variants; skip mutation
            self._logger.debug(
                f"Subscribed {observer.__class__.__name__} to {event_type.__name__} "
                f"with ID {subscription.subscriber_id}",
            )
            return subscription.subscriber_id

    def unsubscribe(self, subscription_id: str) -> None:  # type: ignore[override]
        with self._lock:
            if subscription_id in self._observers:
                del self._observers[subscription_id]
                for event_type, subscriptions in self._subscriptions.items():
                    self._subscriptions[event_type] = [
                        sub for sub in subscriptions if sub.subscriber_id != subscription_id
                    ]
                self._logger.debug(f"Unsubscribed {subscription_id}")

    def publish(self, event: UIEvent,
    ) -> None:
        # Ensure timestamp is set; UIEvent from domain may be frozen
        # Do not mutate event; timestamp is treated as read-only in domain
        with self._lock:
            self._event_history.append(event)
            # Enqueue with default priority
            self._processing_queue[EventPriority.NORMAL].append(event)
            self._logger.debug(f"Published event {event.event_type}")
        self.event_published.emit(event)

    def _process_events(self) -> None:
        while True:
            event = self._get_next_event()
            if event:
                self._process_single_event(event)
            else:
                time.sleep(0.01)

    def _get_next_event(self) -> UIEvent | None:
        with self._lock:
            for priority in EventPriority:
                if self._processing_queue[priority]:
                    return self._processing_queue[priority].popleft()
            return None

    def _process_single_event(self, event: UIEvent,
    ) -> None:
        start_time = time.time()
        # Track status locally through metrics only
        try:
            with self._lock:
                subscriptions = self._subscriptions.get(type(event), [])
            for subscription in subscriptions:
                try:
                    # Domain subscription does not carry a filter function; deliver directly
                    observer = self._observers.get(subscription.subscriber_id)
                    if not observer:
                        continue
                    # Execute synchronously; domain subscription doesn't carry async flags
                    observer.on_next(event)
                except Exception as e:
                    self._logger.exception(
                        f"Error processing event for subscription {subscription.subscriber_id}: {e}",
                    )
                    # Skip mutating read-only metrics
                    self.event_failed.emit(event, str(e))
                    return
            processing_time = time.time() - start_time
            self._processing_times.append(processing_time)
            self._ev_count += 1
            self._processing_time_ms_total += processing_time * 1000.0
            self._last_processed_at = time.time()
            self.event_processed.emit(event)
        except Exception as e:
            self._logger.exception(f"Critical error processing event: {e}")
            self._failed_count += 1
            self.event_failed.emit(event, str(e))

    def _update_performance_metrics(self) -> None:
        if not self._processing_times:
            return
        list(self._processing_times)
        # Emit snapshot metrics using domain value object
        snapshot = EventMetrics(
            event_count=self._ev_count,
            processing_time_ms=self._processing_time_ms_total,
            failed_count=self._failed_count,
            retry_count=self._retry_count,
            last_processed_at=self._last_processed_at,
        )
        self.metrics_updated.emit(snapshot)

    def register_command_handler(
        self,
        command_type: type[TCommand],
        handler: ICommandHandler[TCommand],
    ) -> None:
        with self._lock:
            self._command_handlers[command_type] = handler
            self._logger.debug(f"Registered command handler for {command_type.__name__}")

    def register_query_handler(
        self,
        query_type: type[TQuery],
        handler: IQueryHandler[TQuery, TResult],
    ) -> None:
        with self._lock:
            self._query_handlers[query_type] = handler
            self._logger.debug(f"Registered query handler for {query_type.__name__}")

    def send_command(self, command: ICommand,
    ) -> Any:
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
            self._logger.exception(f"Error executing command {command_type.__name__}: {e}")
            raise

    def send_query(self, query: IQuery[TResult]) -> Result[TResult]:  # type: ignore[override]
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
        with self._lock:
            return EventMetrics(
                event_count=self._ev_count,
                processing_time_ms=self._processing_time_ms_total,
                failed_count=self._failed_count,
                retry_count=self._retry_count,
                last_processed_at=self._last_processed_at,
            )

    def get_event_history(self, event_type: type[UIEvent] | None = None) -> list[UIEvent]:
        with self._lock:
            if event_type:
                return [event for event in self._event_history if isinstance(event, event_type)]
            return list(self._event_history)

    def clear_history(self) -> None:
        with self._lock:
            self._event_history.clear()
            self._logger.debug("Cleared event history")

