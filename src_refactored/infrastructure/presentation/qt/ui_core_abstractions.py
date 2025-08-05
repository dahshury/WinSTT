"""UI Core Abstractions and Patterns.

This module provides core UI abstractions, patterns, and utilities that preserve
existing UI patterns while enabling dependency injection and modular architecture.
"""

import abc
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Generic, Protocol, TypeVar

from PyQt6.QtCore import QMutex, QObject, QTimer, pyqtSignal
from PyQt6.QtWidgets import QDialog, QWidget

from src_refactored.domain.common.result import Result
from src_refactored.domain.common.value_object import ValueObject

T = TypeVar("T")
TWidget = TypeVar("TWidget", bound=QWidget)
TDialog = TypeVar("TDialog", bound=QDialog)


class UIState(Enum):
    """Enumeration of UI component states."""
    CREATED = "created"
    INITIALIZING = "initializing"
    READY = "ready"
    BUSY = "busy"
    ERROR = "error"
    DISPOSING = "disposing"
    DISPOSED = "disposed"


class UIEventType(Enum):
    """Enumeration of UI event types."""
    SHOW = "show"
    HIDE = "hide"
    CLOSE = "close"
    FOCUS_IN = "focus_in"
    FOCUS_OUT = "focus_out"
    RESIZE = "resize"
    MOVE = "move"
    STATE_CHANGE = "state_change"
    ERROR = "error"


@dataclass(frozen=True)
class UIEvent(ValueObject):
    """Value object representing a UI event."""
    event_type: UIEventType
    source_id: str
    timestamp: datetime = field(default_factory=datetime.utcnow)
    data: dict[str, Any] = field(default_factory=dict)

    def _get_equality_components(self) -> tuple:
        return (self.event_type, self.source_id, self.timestamp, tuple(sorted(self.data.items())))


@dataclass(frozen=True)
class UIConfiguration(ValueObject):
    """Value object for UI component configuration."""
    component_id: str
    component_type: str
    properties: dict[str, Any] = field(default_factory=dict)
    styles: dict[str, str] = field(default_factory=dict)
    signals: list[str] = field(default_factory=list)

    def _get_equality_components(self) -> tuple:
        return (
            self.component_id,
            self.component_type,
            tuple(sorted(self.properties.items())),
            tuple(sorted(self.styles.items())),
            tuple(sorted(self.signals)),
        )


class IUIComponent(Protocol):
    """Protocol for UI components."""

    @property
    def component_id(self) -> str:
        """Get the component ID."""
        ...

    @property
    def state(self) -> UIState:
        """Get the current state."""
        ...

    def initialize(self) -> Result[None]:
        """Initialize the component."""
        ...

    def cleanup(self) -> Result[None]:
        """Cleanup the component."""
        ...

    def get_configuration(self) -> UIConfiguration:
        """Get the component configuration."""
        ...


class IUIEventHandler(Protocol):
    """Protocol for UI event handlers."""

    def handle_event(self, event: UIEvent) -> Result[None]:
        """Handle a UI event."""
        ...

    def can_handle(self, event_type: UIEventType) -> bool:
        """Check if this handler can handle the event type."""
        ...


class IUILifecycleManager(Protocol):
    """Protocol for UI lifecycle management."""

    def register_component(self, component: IUIComponent) -> Result[None]:
        """Register a UI component."""
        ...

    def unregister_component(self, component_id: str) -> Result[None]:
        """Unregister a UI component."""
        ...

    def get_component(self, component_id: str) -> IUIComponent | None:
        """Get a registered component."""
        ...


class UIComponentBase(QObject, IUIComponent):
    """Base class for UI components with lifecycle management."""

    # Lifecycle signals
    state_changed = pyqtSignal(str, str)  # component_id, new_state
    error_occurred = pyqtSignal(str, str)  # component_id, error_message
    event_emitted = pyqtSignal(object)  # UIEvent

    def __init__(self, component_id: str, component_type: str, parent=None):
        """Initialize the UI component base.
        
        Args:
            component_id: Unique identifier for the component
            component_type: Type of the component
            parent: Parent QObject
        """
        super().__init__(parent)

        self._component_id = component_id
        self._component_type = component_type
        self._state = UIState.CREATED
        self._configuration = UIConfiguration(
            component_id=component_id,
            component_type=component_type,
        )

        # Event handling
        self._event_handlers: list[IUIEventHandler] = []
        self._event_history: list[UIEvent] = []
        self._max_event_history = 100

        # Lifecycle management
        self._initialization_time: datetime | None = None
        self._cleanup_time: datetime | None = None
        self._error_count = 0

        # Thread safety
        self._mutex = QMutex()

        # Logger
        self.logger = logging.getLogger(f"{__name__}.{component_type}.{component_id}")

    @property
    def component_id(self) -> str:
        """Get the component ID."""
        return self._component_id

    @property
    def state(self) -> UIState:
        """Get the current state."""
        return self._state

    @property
    def component_type(self) -> str:
        """Get the component type."""
        return self._component_type

    def initialize(self) -> Result[None]:
        """Initialize the component."""
        try:
            if self._state != UIState.CREATED:
                return Result.failure(f"Component {self._component_id} is not in CREATED state")

            self._set_state(UIState.INITIALIZING)

            # Perform initialization
            init_result = self._do_initialize()
            if not init_result.is_success:
                self._set_state(UIState.ERROR)
                return init_result

            self._initialization_time = datetime.utcnow()
            self._set_state(UIState.READY)

            self.logger.info(f"Component {self._component_id} initialized successfully")
            return Result.success(None)

        except Exception as e:
            self._set_state(UIState.ERROR)
            self._error_count += 1
            error_msg = f"Failed to initialize component {self._component_id}: {e!s}"
            self.logger.exception(error_msg)
            self.error_occurred.emit(self._component_id, error_msg)
            return Result.failure(error_msg)

    def cleanup(self) -> Result[None]:
        """Cleanup the component."""
        try:
            if self._state == UIState.DISPOSED:
                return Result.success(None)

            self._set_state(UIState.DISPOSING)

            # Perform cleanup
            cleanup_result = self._do_cleanup()
            if not cleanup_result.is_success:
                self.logger.warning(f"Cleanup issues for component {self._component_id}: {cleanup_result.error()}")

            self._cleanup_time = datetime.utcnow()
            self._set_state(UIState.DISPOSED)

            # Clear event handlers and history
            self._event_handlers.clear()
            self._event_history.clear()

            self.logger.info(f"Component {self._component_id} cleaned up successfully")
            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to cleanup component {self._component_id}: {e!s}"
            self.logger.exception(error_msg)
            self.error_occurred.emit(self._component_id, error_msg)
            return Result.failure(error_msg)

    def get_configuration(self) -> UIConfiguration:
        """Get the component configuration."""
        return self._configuration

    def add_event_handler(self, handler: IUIEventHandler) -> None:
        """Add an event handler.
        
        Args:
            handler: Event handler to add
        """
        if handler not in self._event_handlers:
            self._event_handlers.append(handler)

    def remove_event_handler(self, handler: IUIEventHandler) -> None:
        """Remove an event handler.
        
        Args:
            handler: Event handler to remove
        """
        if handler in self._event_handlers:
            self._event_handlers.remove(handler)

    def emit_event(self, event_type: UIEventType, data: dict[str, Any] | None = None) -> None:
        """Emit a UI event.
        
        Args:
            event_type: Type of event to emit
            data: Optional event data
        """
        try:
            event = UIEvent(
                event_type=event_type,
                source_id=self._component_id,
                data=data or {},
            )

            # Add to history
            self._add_to_event_history(event)

            # Handle event with registered handlers
            for handler in self._event_handlers:
                if handler.can_handle(event_type):
                    try:
                        handler.handle_event(event)
                    except Exception as e:
                        self.logger.exception(f"Error in event handler: {e}")

            # Emit PyQt signal
            self.event_emitted.emit(event)

        except Exception as e:
            self.logger.exception(f"Error emitting event: {e}")

    def get_event_history(self, event_type: UIEventType = None, limit: int | None = None) -> list[UIEvent]:
        """Get event history.
        
        Args:
            event_type: Optional filter by event type
            limit: Optional limit on number of events
            
        Returns:
            List of events
        """
        events = self._event_history

        if event_type:
            events = [e for e in events if e.event_type == event_type]

        if limit:
            events = events[-limit:]

        return events

    def get_statistics(self) -> dict[str, Any]:
        """Get component statistics.
        
        Returns:
            Dictionary with component statistics
        """
        return {
            "component_id": self._component_id,
            "component_type": self._component_type,
            "state": self._state.value,
            "initialization_time": self._initialization_time,
            "cleanup_time": self._cleanup_time,
            "error_count": self._error_count,
            "event_count": len(self._event_history),
            "handler_count": len(self._event_handlers),
            "uptime_seconds": (
                (datetime.utcnow() - self._initialization_time).total_seconds()
                if self._initialization_time else 0
            ),
        }

    def _set_state(self, new_state: UIState) -> None:
        """Set the component state.
        
        Args:
            new_state: New state to set
        """
        old_state = self._state
        self._state = new_state

        # Emit state change signal
        self.state_changed.emit(self._component_id, new_state.value)

        # Emit state change event
        self.emit_event(UIEventType.STATE_CHANGE, {
            "old_state": old_state.value,
            "new_state": new_state.value,
        })

        self.logger.debug(f"State changed from {old_state.value} to {new_state.value}")

    def _add_to_event_history(self, event: UIEvent) -> None:
        """Add event to history.
        
        Args:
            event: Event to add
        """
        self._event_history.append(event)

        # Trim history if it exceeds maximum
        if len(self._event_history) > self._max_event_history:
            self._event_history = self._event_history[-self._max_event_history:]

    @abc.abstractmethod
    def _do_initialize(self) -> Result[None]:
        """Perform component-specific initialization.
        
        Returns:
            Result indicating success or failure
        """

    @abc.abstractmethod
    def _do_cleanup(self) -> Result[None]:
        """Perform component-specific cleanup.
        
        Returns:
            Result indicating success or failure
        """


class UIWidgetComponent(UIComponentBase, Generic[TWidget]):
    """Base class for UI components that wrap Qt widgets."""

    def __init__(self, component_id: str, widget: TWidget, parent=None):
        """Initialize the widget component.
        
        Args:
            component_id: Unique identifier for the component
            widget: Qt widget to wrap
            parent: Parent QObject
        """
        super().__init__(component_id, widget.__class__.__name__, parent)
        self._widget = widget

        # Connect widget signals if available
        self._connect_widget_signals()

    @property
    def widget(self) -> TWidget:
        """Get the wrapped widget."""
        return self._widget

    def show(self) -> None:
        """Show the widget."""
        self._widget.show()
        self.emit_event(UIEventType.SHOW)

    def hide(self) -> None:
        """Hide the widget."""
        self._widget.hide()
        self.emit_event(UIEventType.HIDE)

    def close(self) -> bool:
        """Close the widget."""
        result = self._widget.close()
        if result:
            self.emit_event(UIEventType.CLOSE)
        return result

    def _connect_widget_signals(self) -> None:
        """Connect widget signals to component events."""
        try:
            # Connect common widget signals if they exist
            if hasattr(self._widget, "destroyed"):
                self._widget.destroyed.connect(
                    lambda: self.emit_event(UIEventType.CLOSE),
                )

            # Connect focus signals if available
            if hasattr(self._widget, "focusInEvent"):
                original_focus_in = self._widget.focusInEvent
                def focus_in_wrapper(event):
                    original_focus_in(event)
                    self.emit_event(UIEventType.FOCUS_IN)
                self._widget.focusInEvent = focus_in_wrapper

            if hasattr(self._widget, "focusOutEvent"):
                original_focus_out = self._widget.focusOutEvent
                def focus_out_wrapper(event):
                    original_focus_out(event)
                    self.emit_event(UIEventType.FOCUS_OUT)
                self._widget.focusOutEvent = focus_out_wrapper

        except Exception as e:
            self.logger.warning(f"Failed to connect some widget signals: {e}")

    def _do_initialize(self) -> Result[None]:
        """Initialize the widget component."""
        try:
            # Perform widget-specific initialization
            if hasattr(self._widget, "initialize"):
                self._widget.initialize()

            return Result.success(None)

        except Exception as e:
            return Result.failure(f"Widget initialization failed: {e!s}")

    def _do_cleanup(self) -> Result[None]:
        """Cleanup the widget component."""
        try:
            # Perform widget-specific cleanup
            if hasattr(self._widget, "cleanup"):
                self._widget.cleanup()

            # Close widget if still open
            if self._widget and not self._widget.isHidden():
                self._widget.close()

            return Result.success(None)

        except Exception as e:
            return Result.failure(f"Widget cleanup failed: {e!s}")


class UIDialogComponent(UIWidgetComponent[TDialog]):
    """Base class for dialog components."""

    # Dialog-specific signals
    dialog_accepted = pyqtSignal(str)  # component_id
    dialog_rejected = pyqtSignal(str)  # component_id
    dialog_finished = pyqtSignal(str, int)  # component_id, result

    def __init__(self, component_id: str, dialog: TDialog, parent=None):
        """Initialize the dialog component.
        
        Args:
            component_id: Unique identifier for the component
            dialog: Qt dialog to wrap
            parent: Parent QObject
        """
        super().__init__(component_id, dialog, parent)

        # Connect dialog-specific signals
        self._connect_dialog_signals()

    def exec(self) -> int:
        """Execute the dialog modally.
        
        Returns:
            Dialog result code
        """
        self.emit_event(UIEventType.SHOW, {"modal": True})
        result = self._widget.exec()
        self.emit_event(UIEventType.CLOSE, {"result": result})
        return result

    def accept(self) -> None:
        """Accept the dialog."""
        self._widget.accept()
        self.dialog_accepted.emit(self._component_id)

    def reject(self) -> None:
        """Reject the dialog."""
        self._widget.reject()
        self.dialog_rejected.emit(self._component_id)

    def _connect_dialog_signals(self) -> None:
        """Connect dialog-specific signals."""
        try:
            if hasattr(self._widget, "accepted"):
                self._widget.accepted.connect(
                    lambda: self.dialog_accepted.emit(self._component_id),
                )

            if hasattr(self._widget, "rejected"):
                self._widget.rejected.connect(
                    lambda: self.dialog_rejected.emit(self._component_id),
                )

            if hasattr(self._widget, "finished"):
                self._widget.finished.connect(
                    lambda result: self.dialog_finished.emit(self._component_id, result),
                )

        except Exception as e:
            self.logger.warning(f"Failed to connect dialog signals: {e}")


class UILifecycleManager(QObject, IUILifecycleManager):
    """Manager for UI component lifecycle."""

    # Manager signals
    component_registered = pyqtSignal(str)  # component_id
    component_unregistered = pyqtSignal(str)  # component_id
    lifecycle_error = pyqtSignal(str, str)  # component_id, error_message

    def __init__(self, parent=None):
        """Initialize the lifecycle manager.
        
        Args:
            parent: Parent QObject
        """
        super().__init__(parent)

        self._components: dict[str, IUIComponent] = {}
        self._component_dependencies: dict[str, list[str]] = {}
        self._initialization_order: list[str] = []

        # Thread safety
        self._mutex = QMutex()

        # Statistics
        self._registration_count = 0
        self._initialization_count = 0
        self._cleanup_count = 0

        # Logger
        self.logger = logging.getLogger(__name__)

        # Cleanup timer for periodic maintenance
        self._cleanup_timer = QTimer()
        self._cleanup_timer.timeout.connect(self._periodic_maintenance)
        self._cleanup_timer.start(60000)  # Every minute

    def register_component(self, component: IUIComponent) -> Result[None]:
        """Register a UI component.
        
        Args:
            component: Component to register
            
        Returns:
            Result indicating success or failure
        """
        try:
            component_id = component.component_id

            if component_id in self._components:
                return Result.failure(f"Component {component_id} is already registered")

            with self._mutex:
                self._components[component_id] = component
                self._registration_count += 1

            # Connect component signals
            if hasattr(component, "state_changed"):
                component.state_changed.connect(self._on_component_state_changed)
            if hasattr(component, "error_occurred"):
                component.error_occurred.connect(self._on_component_error)

            self.component_registered.emit(component_id)
            self.logger.info(f"Component {component_id} registered successfully")

            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to register component {component.component_id}: {e!s}"
            self.logger.exception(error_msg)
            self.lifecycle_error.emit(component.component_id, error_msg)
            return Result.failure(error_msg)

    def unregister_component(self, component_id: str) -> Result[None]:
        """Unregister a UI component.
        
        Args:
            component_id: ID of component to unregister
            
        Returns:
            Result indicating success or failure
        """
        try:
            if component_id not in self._components:
                return Result.failure(f"Component {component_id} is not registered")

            component = self._components[component_id]

            # Cleanup component
            cleanup_result = component.cleanup()
            if not cleanup_result.is_success:
                self.logger.warning(f"Component cleanup issues: {cleanup_result.error()}")

            # Remove from tracking
            with self._mutex:
                del self._components[component_id]
                if component_id in self._component_dependencies:
                    del self._component_dependencies[component_id]
                if component_id in self._initialization_order:
                    self._initialization_order.remove(component_id)

            self.component_unregistered.emit(component_id)
            self.logger.info(f"Component {component_id} unregistered successfully")

            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to unregister component {component_id}: {e!s}"
            self.logger.exception(error_msg)
            self.lifecycle_error.emit(component_id, error_msg)
            return Result.failure(error_msg)

    def get_component(self, component_id: str) -> IUIComponent | None:
        """Get a registered component.
        
        Args:
            component_id: ID of component to get
            
        Returns:
            Component instance or None if not found
        """
        return self._components.get(component_id)

    def initialize_all_components(self) -> Result[None]:
        """Initialize all registered components.
        
        Returns:
            Result indicating success or failure
        """
        try:
            failed_components = []

            for component_id, component in self._components.items():
                try:
                    init_result = component.initialize()
                    if init_result.is_success:
                        self._initialization_count += 1
                        if component_id not in self._initialization_order:
                            self._initialization_order.append(component_id)
                    else:
                        failed_components.append((component_id, init_result.error()))
                        self.logger.error(f"Failed to initialize {component_id}: {init_result.error()}")
                except Exception as e:
                    failed_components.append((component_id, str(e)))
                    self.logger.exception(f"Exception initializing {component_id}: {e}")

            if failed_components:
                error_msg = f"Failed to initialize {len(failed_components)} components"
                return Result.failure(error_msg)

            self.logger.info(f"Successfully initialized {len(self._components)} components")
            return Result.success(None)

        except Exception as e:
            error_msg = f"Error during component initialization: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)

    def cleanup_all_components(self) -> Result[None]:
        """Cleanup all registered components.
        
        Returns:
            Result indicating success or failure
        """
        try:
            # Cleanup in reverse initialization order
            cleanup_order = list(reversed(self._initialization_order))

            # Add any components not in initialization order
            for component_id in self._components:
                if component_id not in cleanup_order:
                    cleanup_order.append(component_id)

            failed_cleanups = []

            for component_id in cleanup_order:
                if component_id in self._components:
                    try:
                        component = self._components[component_id]
                        cleanup_result = component.cleanup()
                        if cleanup_result.is_success:
                            self._cleanup_count += 1
                        else:
                            failed_cleanups.append((component_id, cleanup_result.error()))
                    except Exception as e:
                        failed_cleanups.append((component_id, str(e)))
                        self.logger.exception(f"Exception cleaning up {component_id}: {e}")

            # Clear all components
            with self._mutex:
                self._components.clear()
                self._component_dependencies.clear()
                self._initialization_order.clear()

            if failed_cleanups:
                self.logger.warning(f"Failed to cleanup {len(failed_cleanups)} components")

            self.logger.info("Component cleanup completed")
            return Result.success(None)

        except Exception as e:
            error_msg = f"Error during component cleanup: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)

    def get_component_statistics(self) -> dict[str, Any]:
        """Get lifecycle manager statistics.
        
        Returns:
            Dictionary with statistics
        """
        component_states = {}
        for component_id, component in self._components.items():
            component_states[component_id] = component.state.value

        return {
            "total_components": len(self._components),
            "registration_count": self._registration_count,
            "initialization_count": self._initialization_count,
            "cleanup_count": self._cleanup_count,
            "component_states": component_states,
            "initialization_order": self._initialization_order.copy(),
        }

    def _on_component_state_changed(self, component_id: str, new_state: str):
        """Handle component state change.
        
        Args:
            component_id: ID of the component
            new_state: New state value
        """
        self.logger.debug(f"Component {component_id} state changed to {new_state}")

    def _on_component_error(self, component_id: str, error_message: str):
        """Handle component error.
        
        Args:
            component_id: ID of the component
            error_message: Error message
        """
        self.logger.error(f"Component {component_id} error: {error_message}")
        self.lifecycle_error.emit(component_id, error_message)

    def _periodic_maintenance(self):
        """Perform periodic maintenance tasks."""
        try:
            # Check for disposed components and remove them
            disposed_components = []
            for component_id, component in self._components.items():
                if component.state == UIState.DISPOSED:
                    disposed_components.append(component_id)

            for component_id in disposed_components:
                self.unregister_component(component_id)

            if disposed_components:
                self.logger.info(f"Removed {len(disposed_components)} disposed components")

        except Exception as e:
            self.logger.exception(f"Error during periodic maintenance: {e}")


class UIEventBus(QObject):
    """Event bus for UI component communication."""

    # Event bus signals
    event_published = pyqtSignal(object)  # UIEvent
    subscriber_added = pyqtSignal(str, str)  # event_type, subscriber_id
    subscriber_removed = pyqtSignal(str, str)  # event_type, subscriber_id

    def __init__(self, parent=None):
        """Initialize the event bus.
        
        Args:
            parent: Parent QObject
        """
        super().__init__(parent)

        self._subscribers: dict[UIEventType, list[Callable[[UIEvent], None]]] = {}
        self._subscriber_ids: dict[str, list[UIEventType]] = {}

        # Thread safety
        self._mutex = QMutex()

        # Statistics
        self._event_count = 0
        self._subscriber_count = 0

        # Logger
        self.logger = logging.getLogger(__name__)

    def subscribe(self, event_type: UIEventType, callback: Callable[[UIEvent], None], subscriber_id: str | None = None) -> str:
        """Subscribe to events of a specific type.
        
        Args:
            event_type: Type of events to subscribe to
            callback: Callback function to handle events
            subscriber_id: Optional subscriber ID
            
        Returns:
            Subscriber ID
        """
        if subscriber_id is None:
            subscriber_id = f"subscriber_{self._subscriber_count}"

        with self._mutex:
            if event_type not in self._subscribers:
                self._subscribers[event_type] = []

            self._subscribers[event_type].append(callback)

            if subscriber_id not in self._subscriber_ids:
                self._subscriber_ids[subscriber_id] = []
            self._subscriber_ids[subscriber_id].append(event_type)

            self._subscriber_count += 1

        self.subscriber_added.emit(event_type.value, subscriber_id)
        self.logger.debug(f"Subscriber {subscriber_id} added for {event_type.value}")

        return subscriber_id

    def unsubscribe(self, subscriber_id: str) -> None:
        """Unsubscribe a subscriber from all events.
        
        Args:
            subscriber_id: ID of subscriber to remove
        """
        with self._mutex:
            if subscriber_id in self._subscriber_ids:
                event_types = self._subscriber_ids[subscriber_id]

                for event_type in event_types:
                    # Note: This is a simplified implementation
                    # In practice, you'd need to track callback-subscriber mapping
                    self.subscriber_removed.emit(event_type.value, subscriber_id)

                del self._subscriber_ids[subscriber_id]

        self.logger.debug(f"Subscriber {subscriber_id} unsubscribed")

    def publish(self, event: UIEvent) -> None:
        """Publish an event to all subscribers.
        
        Args:
            event: Event to publish
        """
        try:
            subscribers = self._subscribers.get(event.event_type, [])

            for callback in subscribers:
                try:
                    callback(event)
                except Exception as e:
                    self.logger.exception(f"Error in event subscriber: {e}")

            self._event_count += 1
            self.event_published.emit(event)

        except Exception as e:
            self.logger.exception(f"Error publishing event: {e}")

    def get_statistics(self) -> dict[str, Any]:
        """Get event bus statistics.
        
        Returns:
            Dictionary with statistics
        """
        return {
            "total_events_published": self._event_count,
            "total_subscribers": self._subscriber_count,
            "event_types_with_subscribers": list(self._subscribers.keys()),
            "active_subscribers": len(self._subscriber_ids),
        }


class UIPatternPreserver:
    """Utility class for preserving existing UI patterns during refactoring."""

    @staticmethod
    def wrap_existing_widget(widget: QWidget, component_id: str | None = None) -> UIWidgetComponent:
        """Wrap an existing widget in a UI component.
        
        Args:
            widget: Existing widget to wrap
            component_id: Optional component ID
            
        Returns:
            UI component wrapping the widget
        """
        if component_id is None:
            component_id = f"{widget.__class__.__name__}_{id(widget)}"

        return UIWidgetComponent(component_id, widget)

    @staticmethod
    def wrap_existing_dialog(dialog: QDialog, component_id: str | None = None) -> UIDialogComponent:
        """Wrap an existing dialog in a UI component.
        
        Args:
            dialog: Existing dialog to wrap
            component_id: Optional component ID
            
        Returns:
            UI component wrapping the dialog
        """
        if component_id is None:
            component_id = f"{dialog.__class__.__name__}_{id(dialog)}"

        return UIDialogComponent(component_id, dialog)

    @staticmethod
    def preserve_signal_connections(source_widget: QWidget, target_component: UIComponentBase) -> None:
        """Preserve existing signal connections when migrating to components.
        
        Args:
            source_widget: Original widget with signal connections
            target_component: Target component to receive signals
        """
        # This is a placeholder for signal preservation logic
        # In practice, this would analyze existing connections and recreate them

    @staticmethod
    def migrate_widget_properties(source_widget: QWidget, target_component: UIWidgetComponent) -> None:
        """Migrate widget properties to component configuration.
        
        Args:
            source_widget: Source widget
            target_component: Target component
        """
        try:
            # Extract common properties
            properties = {
                "geometry": source_widget.geometry(),
                "size_policy": source_widget.sizePolicy(),
                "minimum_size": source_widget.minimumSize(),
                "maximum_size": source_widget.maximumSize(),
                "enabled": source_widget.isEnabled(),
                "visible": source_widget.isVisible(),
                "style_sheet": source_widget.styleSheet(),
                "tool_tip": source_widget.toolTip(),
                "status_tip": source_widget.statusTip(),
                "what_this": source_widget.whatsThis(),
            }

            # Update component configuration
            config = target_component.get_configuration()
            updated_config = UIConfiguration(
                component_id=config.component_id,
                component_type=config.component_type,
                properties={**config.properties, **properties},
                styles=config.styles,
                signals=config.signals,
            )

            target_component._configuration = updated_config

        except Exception as e:
            logging.getLogger(__name__).warning(f"Failed to migrate some properties: {e}")