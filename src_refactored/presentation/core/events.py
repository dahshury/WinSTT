"""UI Event System and Mediator Implementation

This module provides a comprehensive event-driven architecture for the UI layer,
implementing the Mediator pattern for decoupled communication between components.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Generic

from .abstractions import (
    ICommand,
    IMediator,
    IObservable,
    IObserver,
    IQuery,
    Result,
    TCommand,
    TEvent,
    TQuery,
    TResult,
    UIEvent,
)

if TYPE_CHECKING:
    from collections.abc import Callable

# ============================================================================
# EVENT PRIORITY AND ROUTING
# ============================================================================

class EventPriority(Enum):
    """Event priority levels for processing order."""
    LOW = 1
    NORMAL = 2
    HIGH = 3
    CRITICAL = 4

@dataclass
class EventSubscription(Generic[TEvent]):
    """Represents an event subscription with metadata."""
    observer: IObserver[TEvent]
    event_type: type[TEvent]
    priority: EventPriority = EventPriority.NORMAL
    filter_func: Callable[[TEvent], bool] | None = None
    is_async: bool = False
    subscription_id: str = field(default_factory=lambda: __import__("uuid").uuid4().hex)

# ============================================================================
# COMMAND AND QUERY HANDLERS
# ============================================================================

class ICommandHandler(Generic[TCommand]):
    """Interface for command handlers."""
    
    def handle(self, command: TCommand) -> Result[Any]:
        """Handle the command and return a result."""
        raise NotImplementedError

class IQueryHandler(Generic[TQuery, TResult]):
    """Interface for query handlers."""
    
    def handle(self, query: TQuery) -> Result[TResult]:
        """Handle the query and return a result."""
        raise NotImplementedError

# ============================================================================
# MAIN EVENT SYSTEM
# ============================================================================

class UIEventSystem(IObservable[UIEvent], IMediator):
    """Comprehensive event system with mediator pattern implementation.
    
    Features:
    - Priority-based event processing
    - Async event handling
    - Event filtering
    - Command/Query handling (CQRS)
    - Event history and replay
    - Performance monitoring
    - Thread-safe operations
    """
    
    def __init__(self, max_workers: int = 4):
        self._subscriptions: dict[type[UIEvent], list[EventSubscription]] = {}
        self._command_handlers: dict[type[ICommand], ICommandHandler] = {}
        self._query_handlers: dict[type[IQuery], IQueryHandler] = {}
        self._event_history: list[UIEvent] = []
        self._max_history_size = 1000
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._metrics = {
            "events_published": 0,
            "events_processed": 0,
            "commands_sent": 0,
            "queries_sent": 0,
            "errors_occurred": 0,
        }
    
    def subscribe(self, 
                  observer: IObserver[TEvent], 
                  event_type: type[TEvent],
                  priority: EventPriority = EventPriority.NORMAL,
                  filter_func: Callable[[TEvent], bool] | None = None,
                  is_async: bool = False) -> str:
        """Subscribe an observer to events of a specific type.
        
        Args:
            observer: The observer to subscribe
            event_type: The type of events to observe
            priority: Processing priority for this subscription
            filter_func: Optional filter function for events
            is_async: Whether to process events asynchronously
            
        Returns:
            Subscription ID for later unsubscription
        """
        with self._lock:
            subscription = EventSubscription(
                observer=observer,
                event_type=event_type,
                priority=priority,
                filter_func=filter_func,
                is_async=is_async,
            )
            
            if event_type not in self._subscriptions:
                self._subscriptions[event_type] = []
            
            self._subscriptions[event_type].append(subscription)
            
            # Sort by priority (highest first)
            self._subscriptions[event_type].sort(
                key=lambda s: s.priority.value, 
                reverse=True,
            )
            
            return subscription.subscription_id
    
    def unsubscribe(self, observer: IObserver[TEvent]) -> None:
        """Unsubscribe an observer from all events."""
        with self._lock:
            for event_type in list(self._subscriptions.keys()):
                self._subscriptions[event_type] = [
                    sub for sub in self._subscriptions[event_type]
                    if sub.observer != observer
                ]
                if not self._subscriptions[event_type]:
                    del self._subscriptions[event_type]
    
    def unsubscribe_by_id(self, subscription_id: str) -> bool:
        """Unsubscribe by subscription ID.
        
        Returns:
            True if subscription was found and removed, False otherwise
        """
        with self._lock:
            for event_type in list(self._subscriptions.keys()):
                original_count = len(self._subscriptions[event_type])
                self._subscriptions[event_type] = [
                    sub for sub in self._subscriptions[event_type]
                    if sub.subscription_id != subscription_id
                ]
                if len(self._subscriptions[event_type]) < original_count:
                    if not self._subscriptions[event_type]:
                        del self._subscriptions[event_type]
                    return True
            return False
    
    def notify_observers(self, event: UIEvent) -> None:
        """Notify all observers of an event (IObservable implementation)."""
        self.publish_event(event)
    
    def publish_event(self, event: UIEvent) -> None:
        """Publish an event to all relevant subscribers."""
        with self._lock:
            self._metrics["events_published"] += 1
            self._add_to_history(event)
            
            # Get subscriptions for this event type and its base classes
            relevant_subscriptions = []
            for event_type, subscriptions in self._subscriptions.items():
                if isinstance(event, event_type):
                    relevant_subscriptions.extend(subscriptions)
            
            if relevant_subscriptions:
                # Sort by priority
                relevant_subscriptions.sort(
                    key=lambda s: s.priority.value, 
                    reverse=True,
                )
                
                # Clean up any dead references
                self._clean_dead_references(type(event))
                
                # Process subscriptions
                self._process_event_subscriptions(event, relevant_subscriptions)
    
    def _process_event_subscriptions(self, event: UIEvent, subscriptions: list[EventSubscription]) -> None:
        """Process event subscriptions with filtering and async handling."""
        for subscription in subscriptions:
            try:
                # Apply filter if present
                if subscription.filter_func and not subscription.filter_func(event):
                    continue
                
                if subscription.is_async:
                    # Process asynchronously
                    self._executor.submit(self._notify_observer_safe, subscription.observer, event)
                else:
                    # Process synchronously
                    self._notify_observer_safe(subscription.observer, event)
                
                self._metrics["events_processed"] += 1
                
            except Exception as e:
                self._metrics["errors_occurred"] += 1
                # Log error but continue processing other subscriptions
                print(f"Error processing event subscription: {e}")
    
    def _notify_observer_safe(self, observer: IObserver[UIEvent], event: UIEvent) -> None:
        """Safely notify an observer, handling any exceptions."""
        try:
            observer.notify(event)
        except Exception as e:
            self._metrics["errors_occurred"] += 1
            print(f"Error notifying observer {observer}: {e}")
    
    def _clean_dead_references(self, event_type: type[UIEvent]) -> None:
        """Clean up any dead weak references in subscriptions."""
        if event_type in self._subscriptions:
            # Filter out any None observers (dead weak references)
            self._subscriptions[event_type] = [
                sub for sub in self._subscriptions[event_type]
                if sub.observer is not None
            ]
            
            if not self._subscriptions[event_type]:
                del self._subscriptions[event_type]
    
    def _add_to_history(self, event: UIEvent) -> None:
        """Add event to history with size management."""
        self._event_history.append(event)
        
        # Maintain history size limit
        if len(self._event_history) > self._max_history_size:
            self._event_history = self._event_history[-self._max_history_size:]
    
    # ========================================================================
    # COMMAND HANDLING (CQRS)
    # ========================================================================
    
    def register_command_handler(self, command_type: type[TCommand], handler: ICommandHandler[TCommand]) -> None:
        """Register a command handler."""
        with self._lock:
            self._command_handlers[command_type] = handler
    
    def send_command(self, command: ICommand) -> Result[Any]:
        """Send a command for processing."""
        with self._lock:
            self._metrics["commands_sent"] += 1
            
            command_type = type(command)
            handler = self._command_handlers.get(command_type)
            
            if not handler:
                self._metrics["errors_occurred"] += 1
                return Result.failure(f"No handler registered for command type: {command_type.__name__}")
            
            try:
                return handler.handle(command)
            except Exception as e:
                self._metrics["errors_occurred"] += 1
                return Result.failure(f"Error handling command: {e!s}")
    
    def register_query_handler(self, query_type: type[TQuery], handler: IQueryHandler[TQuery, TResult]) -> None:
        """Register a query handler."""
        with self._lock:
            self._query_handlers[query_type] = handler
    
    def send_query(self, query: IQuery[TResult]) -> Result[TResult]:
        """Send a query for processing."""
        with self._lock:
            self._metrics["queries_sent"] += 1
            
            query_type = type(query)
            handler = self._query_handlers.get(query_type)
            
            if not handler:
                self._metrics["errors_occurred"] += 1
                return Result.failure(f"No handler registered for query type: {query_type.__name__}")
            
            try:
                return handler.handle(query)
            except Exception as e:
                self._metrics["errors_occurred"] += 1
                return Result.failure(f"Error handling query: {e!s}")
    
    # ========================================================================
    # EVENT HISTORY AND REPLAY
    # ========================================================================
    
    def get_event_history(self, event_type: type[UIEvent] | None = None, limit: int | None = None) -> list[UIEvent]:
        """Get event history, optionally filtered by type and limited."""
        with self._lock:
            events = self._event_history
            
            if event_type:
                events = [e for e in events if isinstance(e, event_type)]
            
            if limit:
                events = events[-limit:]
            
            return events.copy()
    
    def replay_events(self, 
                      events: list[UIEvent] | None = None, 
                      from_timestamp: float | None = None,
                      to_timestamp: float | None = None) -> None:
        """Replay events from history or provided list."""
        if events is None:
            events = self._event_history
        
        # Filter by timestamp if specified
        if from_timestamp or to_timestamp:
            filtered_events = []
            for event in events:
                if hasattr(event, "timestamp"):
                    if from_timestamp and event.timestamp < from_timestamp:
                        continue
                    if to_timestamp and event.timestamp > to_timestamp:
                        continue
                filtered_events.append(event)
            events = filtered_events
        
        # Replay events
        for event in events:
            self.publish_event(event)
    
    def clear_history(self) -> None:
        """Clear the event history."""
        with self._lock:
            self._event_history.clear()
    
    # ========================================================================
    # METRICS AND MONITORING
    # ========================================================================
    
    def get_metrics(self) -> dict[str, Any]:
        """Get performance metrics."""
        with self._lock:
            return {
                **self._metrics.copy(),
                "subscription_count": sum(len(subs) for subs in self._subscriptions.values()),
                "event_types_count": len(self._subscriptions),
                "history_size": len(self._event_history),
                "command_handlers_count": len(self._command_handlers),
                "query_handlers_count": len(self._query_handlers),
            }
    
    def reset_metrics(self) -> None:
        """Reset performance metrics."""
        with self._lock:
            self._metrics = {
                "events_published": 0,
                "events_processed": 0,
                "commands_sent": 0,
                "queries_sent": 0,
                "errors_occurred": 0,
            }
    
    def get_subscription_count(self, event_type: type[UIEvent] | None = None) -> int:
        """Get the number of subscriptions for a specific event type or all."""
        with self._lock:
            if event_type:
                return len(self._subscriptions.get(event_type, []))
            return sum(len(subs) for subs in self._subscriptions.values())
    
    def shutdown(self) -> None:
        """Shutdown the event system and clean up resources."""
        with self._lock:
            # Clear all subscriptions
            self._subscriptions.clear()
            self._command_handlers.clear()
            self._query_handlers.clear()
            
            # Shutdown thread pool
            self._executor.shutdown(wait=True)
            
            # Clear history
            self._event_history.clear()

# ============================================================================
# PREDEFINED UI EVENTS
# ============================================================================

@dataclass(frozen=True)
class WidgetCreatedEvent(UIEvent):
    """Event fired when a UI widget is created."""
    widget_id: str
    widget_type: str
    parent_id: str | None = None

@dataclass(frozen=True)
class WidgetDestroyedEvent(UIEvent):
    """Event fired when a UI widget is destroyed."""
    widget_id: str
    widget_type: str

@dataclass(frozen=True)
class StateChangedEvent(UIEvent):
    """Event fired when component state changes."""
    component_id: str
    old_state: Any
    new_state: Any
    change_type: str

@dataclass(frozen=True)
class UserActionEvent(UIEvent):
    """Event fired when user performs an action."""
    action_type: str
    target_id: str
    data: dict[str, Any] | None = None

@dataclass(frozen=True)
class ValidationFailedEvent(UIEvent):
    """Event fired when validation fails."""
    component_id: str
    field_name: str
    error_message: str
    invalid_value: Any

@dataclass(frozen=True)
class ProgressUpdatedEvent(UIEvent):
    """Event fired when progress is updated."""
    operation_id: str
    progress_percentage: float
    status_message: str | None = None

@dataclass(frozen=True)
class ErrorOccurredEvent(UIEvent):
    """Event fired when an error occurs."""
    error_type: str
    error_message: str
    component_id: str | None = None
    stack_trace: str | None = None

# ============================================================================
# DECORATORS FOR AUTOMATIC REGISTRATION
# ============================================================================

def event_handler(event_type: type[TEvent], priority: EventPriority = EventPriority.NORMAL):
    """Decorator for automatic event handler registration."""
    def decorator(observer_class):
        # Store metadata for later registration
        if not hasattr(observer_class, "_event_handlers"):
            observer_class._event_handlers = []
        observer_class._event_handlers.append({
            "event_type": event_type,
            "priority": priority,
        })
        return observer_class
    return decorator

def command_handler(command_type: type[TCommand]):
    """Decorator for automatic command handler registration."""
    def decorator(handler_class):
        # Store metadata for later registration
        if not hasattr(handler_class, "_command_type"):
            handler_class._command_type = command_type
        return handler_class
    return decorator

def query_handler(query_type: type[TQuery]):
    """Decorator for automatic query handler registration."""
    def decorator(handler_class):
        # Store metadata for later registration
        if not hasattr(handler_class, "_query_type"):
            handler_class._query_type = query_type
        return handler_class
    return decorator

__all__ = [
    "ErrorOccurredEvent",
    "EventPriority",
    "EventSubscription",
    "ICommandHandler",
    "IQueryHandler",
    "ProgressUpdatedEvent",
    "StateChangedEvent",
    "UIEventSystem",
    "UserActionEvent",
    "ValidationFailedEvent",
    "WidgetCreatedEvent",
    "WidgetDestroyedEvent",
    "command_handler",
    "event_handler",
    "query_handler",
]