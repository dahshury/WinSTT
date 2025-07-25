"""
UI Event System and Mediator Implementation

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
        """Handle the command."""
        raise NotImplementedError

class IQueryHandler(Generic[TQuery, TResult]):
    """Interface for query handlers."""
    
    def handle(self, query: TQuery) -> Result[TResult]:
        """Handle the query."""
        raise NotImplementedError

# ============================================================================
# UI EVENT SYSTEM
# ============================================================================

class UIEventSystem(IObservable[UIEvent], IMediator):
    """
    Comprehensive event system for the UI layer.
    
    Features:
    - Thread-safe event publishing and subscription
    - Event priority handling
    - Async event processing
    - Event filtering
    - Weak reference management for automatic cleanup
    - Command/Query separation (CQRS)
    - Event replay and history
    - Performance monitoring
    """
    
    def __init__(self, max_workers: int = 4):
        self._subscriptions: dict[type[UIEvent], list[EventSubscription]] = {}
        self._command_handlers: dict[type[ICommand], ICommandHandler] = {}
        self._query_handlers: dict[type[IQuery], IQueryHandler] = {}
        self._event_history: list[UIEvent] = []
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._is_processing = False
        self._event_queue: list[UIEvent] = []
        self._max_history = 1000
        
        # Performance metrics
        self._metrics = {
            "events_published": 0,
            "events_processed": 0,
            "failed_events": 0,
            "active_subscriptions": 0,
        }
    
    def subscribe(self, 
                  observer: IObserver[TEvent], 
                  event_type: type[TEvent],
                  priority: EventPriority = EventPriority.NORMAL,
                  filter_func: Callable[[TEvent], bool] | None = None,
                  is_async: bool = False) -> str:
        """
        Subscribe to events with advanced options.
        
        Args:
            observer: The observer to notify
            event_type: Type of events to subscribe to
            priority: Event processing priority
            filter_func: Optional filter function for events
            is_async: Whether to process events asynchronously
            
        Returns:
            Subscription ID for later unsubscription
        """
        with self._lock:
            if event_type not in self._subscriptions:
                self._subscriptions[event_type] = []
            
            subscription = EventSubscription(
                observer=observer,
                event_type=event_type,
                priority=priority,
                filter_func=filter_func,
                is_async=is_async,
            )
            
            self._subscriptions[event_type].append(subscription)
            
            # Sort by priority (highest first)
            self._subscriptions[event_type].sort(
                key=lambda s: s.priority.value, 
                reverse=True,
            )
            
            self._metrics["active_subscriptions"] += 1
            return subscription.subscription_id
    
    def unsubscribe(self, observer: IObserver[TEvent]) -> None:
        """Unsubscribe an observer from all events."""
        with self._lock:
            for event_type, subscriptions in self._subscriptions.items():
                self._subscriptions[event_type] = [
                    sub for sub in subscriptions 
                    if sub.observer != observer
                ]
                self._clean_dead_references(event_type)
    
    def unsubscribe_by_id(self, subscription_id: str) -> bool:
        """Unsubscribe by subscription ID."""
        with self._lock:
            for event_type, subscriptions in self._subscriptions.items():
                original_count = len(subscriptions)
                self._subscriptions[event_type] = [
                    sub for sub in subscriptions 
                    if sub.subscription_id != subscription_id
                ]
                if len(self._subscriptions[event_type]) < original_count:
                    self._metrics["active_subscriptions"] -= 1
                    return True
            return False
    
    def notify_observers(self, event: UIEvent) -> None:
        """Notify all observers of an event."""
        self.publish_event(event)
    
    def publish_event(self, event: UIEvent) -> None:
        """
        Publish an event to all subscribers.
        
        Args:
            event: The event to publish
        """
        with self._lock:
            self._metrics["events_published"] += 1
            
            # Add to history
            self._add_to_history(event)
            
            # Get subscribers for this event type
            event_type = type(event)
            if event_type not in self._subscriptions:
                return
            
            # Clean up dead references
            self._clean_dead_references(event_type)
            
            # Process subscriptions
            subscriptions = self._subscriptions[event_type].copy()
            
        # Process outside the lock to avoid deadlocks
        self._process_event_subscriptions(event, subscriptions)
    
    def _process_event_subscriptions(self, event: UIEvent, subscriptions: list[EventSubscription]) -> None:
        """Process event subscriptions outside the main lock."""
        for subscription in subscriptions:
            try:
                # Apply filter if present
                if subscription.filter_func and not subscription.filter_func(event):
                    continue
                
                # Process async or sync
                if subscription.is_async:
                    self._executor.submit(self._notify_observer_safe, subscription.observer, event)
                else:
                    self._notify_observer_safe(subscription.observer, event)
                    
                self._metrics["events_processed"] += 1
                
            except Exception as e:
                self._metrics["failed_events"] += 1
                # Log error but don't stop processing other subscriptions
                print(f"Error processing event subscription: {e}")
    
    def _notify_observer_safe(self, observer: IObserver[UIEvent], event: UIEvent) -> None:
        """Safely notify an observer, handling any exceptions."""
        try:
            observer.notify(event)
        except Exception as e:
            self._metrics["failed_events"] += 1
            # Could log to a proper logger here
            print(f"Error notifying observer: {e}")
    
    def _clean_dead_references(self, event_type: type[UIEvent]) -> None:
        """Clean up dead weak references."""
        if event_type in self._subscriptions:
            original_count = len(self._subscriptions[event_type])
            self._subscriptions[event_type] = [
                sub for sub in self._subscriptions[event_type]
                if sub.observer is not None  # Remove dead references
            ]
            removed = original_count - len(self._subscriptions[event_type])
            self._metrics["active_subscriptions"] -= removed
    
    def _add_to_history(self, event: UIEvent) -> None:
        """Add event to history with size limit."""
        self._event_history.append(event)
        if len(self._event_history) > self._max_history:
            self._event_history = self._event_history[-self._max_history:]
    
    # ============================================================================
    # COMMAND PATTERN IMPLEMENTATION
    # ============================================================================
    
    def register_command_handler(self, command_type: type[TCommand], handler: ICommandHandler[TCommand]) -> None:
        """Register a command handler."""
        with self._lock:
            self._command_handlers[command_type] = handler
    
    def send_command(self, command: ICommand) -> Result[Any]:
        """Send a command through the mediator."""
        command_type = type(command)
        
        with self._lock:
            if command_type not in self._command_handlers:
                return Result.failure(f"No handler registered for command {command_type.__name__}")
            
            handler = self._command_handlers[command_type]
        
        try:
            return handler.handle(command)
        except Exception as e:
            return Result.failure(f"Command handling failed: {e!s}")
    
    def register_query_handler(self, query_type: type[TQuery], handler: IQueryHandler[TQuery, TResult]) -> None:
        """Register a query handler."""
        with self._lock:
            self._query_handlers[query_type] = handler
    
    def send_query(self, query: IQuery[TResult]) -> Result[TResult]:
        """Send a query through the mediator."""
        query_type = type(query)
        
        with self._lock:
            if query_type not in self._query_handlers:
                return Result.failure(f"No handler registered for query {query_type.__name__}")
            
            handler = self._query_handlers[query_type]
        
        try:
            return handler.handle(query)
        except Exception as e:
            return Result.failure(f"Query handling failed: {e!s}")
    
    # ============================================================================
    # EVENT REPLAY AND HISTORY
    # ============================================================================
    
    def get_event_history(self, event_type: type[UIEvent] | None = None, limit: int | None = None) -> list[UIEvent]:
        """Get event history, optionally filtered by type."""
        with self._lock:
            events = self._event_history.copy()
        
        if event_type:
            events = [e for e in events if isinstance(e, event_type)]
        
        if limit:
            events = events[-limit:]
            
        return events
    
    def replay_events(self, 
                      events: list[UIEvent] | None = None, 
                      from_timestamp: float | None = None,
                      to_timestamp: float | None = None) -> None:
        """Replay events to current subscribers."""
        if events is None:
            events = self._event_history.copy()
        
        # Filter by timestamp if provided
        if from_timestamp or to_timestamp:
            filtered_events = []
            for event in events:
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
        """Clear event history."""
        with self._lock:
            self._event_history.clear()
    
    # ============================================================================
    # METRICS AND MONITORING
    # ============================================================================
    
    def get_metrics(self) -> dict[str, Any]:
        """Get performance metrics."""
        with self._lock:
            return self._metrics.copy()
    
    def reset_metrics(self) -> None:
        """Reset performance metrics."""
        with self._lock:
            self._metrics = {
                "events_published": 0,
                "events_processed": 0,
                "failed_events": 0,
                "active_subscriptions": len([
                    sub for subs in self._subscriptions.values() for sub in subs
                ]),
            }
    
    def get_subscription_count(self, event_type: type[UIEvent] | None = None) -> int:
        """Get subscription count for an event type or all events."""
        with self._lock:
            if event_type:
                return len(self._subscriptions.get(event_type, []))
            return sum(len(subs) for subs in self._subscriptions.values())
    
    # ============================================================================
    # LIFECYCLE MANAGEMENT
    # ============================================================================
    
    def shutdown(self) -> None:
        """Shutdown the event system and cleanup resources."""
        with self._lock:
            self._executor.shutdown(wait=True)
            self._subscriptions.clear()
            self._command_handlers.clear()
            self._query_handlers.clear()
            self._event_history.clear()

# ============================================================================
# PREDEFINED UI EVENTS
# ============================================================================

@dataclass(frozen=True)
class WidgetCreatedEvent(UIEvent):
    """Event fired when a widget is created."""
    widget_id: str
    widget_type: str
    parent_id: str | None = None

@dataclass(frozen=True)
class WidgetDestroyedEvent(UIEvent):
    """Event fired when a widget is destroyed."""
    widget_id: str
    widget_type: str

@dataclass(frozen=True)
class StateChangedEvent(UIEvent):
    """Event fired when UI state changes."""
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
# EVENT DECORATORS
# ============================================================================

def event_handler(event_type: type[TEvent], priority: EventPriority = EventPriority.NORMAL):
    """
    Decorator to mark a method as an event handler.
    
    Usage:
        @event_handler(StateChangedEvent, EventPriority.HIGH)
        def handle_state_change(self, event: StateChangedEvent):
            pass
    """
    def decorator(func):
        func._event_type = event_type
        func._event_priority = priority
        func._is_event_handler = True
        return func
    return decorator

def command_handler(command_type: type[TCommand]):
    """
    Decorator to mark a class as a command handler.
    
    Usage:
        @command_handler(MyCommand)
        class MyCommandHandler:
            def handle(self, command: MyCommand) -> Result[Any]:
                pass
    """
    def decorator(cls):
        cls._command_type = command_type
        cls._is_command_handler = True
        return cls
    return decorator

def query_handler(query_type: type[TQuery]):
    """
    Decorator to mark a class as a query handler.
    
    Usage:
        @query_handler(MyQuery)
        class MyQueryHandler:
            def handle(self, query: MyQuery) -> Result[TResult]:
                pass
    """
    def decorator(cls):
        cls._query_type = query_type
        cls._is_query_handler = True
        return cls
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
    # Predefined Events
    "WidgetCreatedEvent",
    "WidgetDestroyedEvent",
    "command_handler",
    # Decorators
    "event_handler",
    "query_handler",
] 