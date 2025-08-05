"""Event Filter Service.

This module provides infrastructure services for managing application-wide
event filtering, including installation, configuration, and event handling.
"""

from collections.abc import Callable

from PyQt6.QtCore import QEvent, QObject, pyqtSignal
from PyQt6.QtWidgets import QApplication

from logger import setup_logger
from src.domain.common.result import Result
from src_refactored.domain.system_integration.value_objects.event_filtering import (
    EventFilterConfig,
    EventType,
    FilterScope,
)


class EventFilterService(QObject):
    """Service for managing application event filters."""

    # Signals
    filter_installed = pyqtSignal(str)  # filter_id
    filter_removed = pyqtSignal(str)    # filter_id
    event_filtered = pyqtSignal(str, str)  # filter_id, event_type
    filter_error = pyqtSignal(str, str)    # filter_id, error_message

    def __init__(self):
        """Initialize the event filter service."""
        super().__init__()
        self.logger = setup_logger()
        self._filters: dict[str, EventFilterConfig] = {}
        self._event_handlers: dict[str, Callable] = {}
        self._installed_filters: list[str] = []

    def register_filter(self, config: EventFilterConfig,
                       handler: Callable | None = None) -> Result[None]:
        """Register an event filter configuration.
        
        Args:
            config: Event filter configuration
            handler: Optional custom event handler function
            
        Returns:
            Result indicating success or failure
        """
        try:
            if config.filter_id in self._filters:
                return Result.failure(f"Filter {config.filter_id} already registered")

            self._filters[config.filter_id] = config

            if handler:
                self._event_handlers[config.filter_id] = handler

            self.logger.info("Registered event filter: {config.filter_id}")
            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to register filter {config.filter_id}: {e!s}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg,
    )

    def install_filter(self, filter_id: str, target: QObject | None = None) -> Result[None]:
        """Install an event filter.
        
        Args:
            filter_id: ID of the filter to install
            target: Target object for widget/window scope filters
            
        Returns:
            Result indicating success or failure
        """
        try:
            config = self._filters.get(filter_id)
            if not config:
                return Result.failure(f"Filter {filter_id} not registered")

            if not config.enabled:
                return Result.failure(f"Filter {filter_id} is disabled")

            if filter_id in self._installed_filters:
                return Result.failure(f"Filter {filter_id} already installed")

            # Install based on scope
            if config.scope == FilterScope.APPLICATION_WIDE:
                app = QApplication.instance()
                if app:
                    app.installEventFilter(self)
                else:
                    return Result.failure("No QApplication instance available")

            elif config.scope == FilterScope.WINDOW_ONLY:
                if not target:
                    return Result.failure("Target window required for window scope filter")
                target.installEventFilter(self)

            elif config.scope == FilterScope.WIDGET_ONLY:
                if not target:
                    return Result.failure("Target widget required for widget scope filter")
                target.installEventFilter(self)

            self._installed_filters.append(filter_id)
            self.filter_installed.emit(filter_id)
            self.logger.info("Installed event filter: {filter_id}")

            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to install filter {filter_id}: {e!s}"
            self.logger.exception(error_msg,
    )
            self.filter_error.emit(filter_id, error_msg)
            return Result.failure(error_msg)

    def remove_filter(self, filter_id: str, target: QObject | None = None) -> Result[None]:
        """Remove an installed event filter.
        
        Args:
            filter_id: ID of the filter to remove
            target: Target object for widget/window scope filters
            
        Returns:
            Result indicating success or failure
        """
        try:
            if filter_id not in self._installed_filters:
                return Result.success(None)  # Already removed

            config = self._filters.get(filter_id)
            if not config:
                return Result.failure(f"Filter {filter_id} not registered")

            # Remove based on scope
            if config.scope == FilterScope.APPLICATION_WIDE:
                app = QApplication.instance()
                if app:
                    app.removeEventFilter(self,
    )

            elif config.scope in [FilterScope.WINDOW_ONLY, FilterScope.WIDGET_ONLY]:
                if target:
                    target.removeEventFilter(self)

            self._installed_filters.remove(filter_id)
            self.filter_removed.emit(filter_id)
            self.logger.info("Removed event filter: {filter_id}")

            return Result.success(None)

        except Exception as e:
            error_msg = f"Failed to remove filter {filter_id}: {e!s}"
            self.logger.exception(error_msg,
    )
            self.filter_error.emit(filter_id, error_msg)
            return Result.failure(error_msg)

    def eventFilter(self, obj: QObject, event: QEvent,
    ) -> bool:
        """Qt event filter implementation.
        
        Args:
            obj: Object that received the event
            event: The event
            
        Returns:
            True if event should be filtered out, False otherwise
        """
        try:
            # Process each installed filter
            for filter_id in self._installed_filters:
                config = self._filters.get(filter_id)
                if not config or not config.enabled:
                    continue

                # Check if this event type should be handled
                event_type = self._get_event_type(event,
    )
                if not self._should_handle_event(config, event_type):
                    continue

                # Use custom handler if available
                if filter_id in self._event_handlers:
                    handler = self._event_handlers[filter_id]
                    result = handler(obj, event)
                    if result:
                        self.event_filtered.emit(filter_id, event_type.value)
                        return True
                else:
                    # Default handling
                    result = self._default_event_handler(obj, event, config)
                    if result:
                        self.event_filtered.emit(filter_id, event_type.value)
                        return True

            return False

        except Exception as e:
            self.logger.exception(f"Error in event filter: {e!s}")
            return False

    def _get_event_type(self, event: QEvent,
    ) -> EventType:
        """Get event type from QEvent."""
        event_type_map = {
            QEvent.Type.KeyPress: EventType.KEY_PRESS,
            QEvent.Type.KeyRelease: EventType.KEY_RELEASE,
            QEvent.Type.MouseButtonPress: EventType.MOUSE_PRESS,
            QEvent.Type.MouseButtonRelease: EventType.MOUSE_RELEASE,
            QEvent.Type.MouseMove: EventType.MOUSE_MOVE,
            QEvent.Type.FocusIn: EventType.FOCUS_IN,
            QEvent.Type.FocusOut: EventType.FOCUS_OUT,
            QEvent.Type.Close: EventType.CLOSE,
            QEvent.Type.Resize: EventType.RESIZE,
        }

        return event_type_map.get(event.type(), EventType.ALL)

    def _should_handle_event(self, config: EventFilterConfig, event_type: EventType,
    ) -> bool:
        """Check if event should be handled by filter."""
        if EventType.ALL in config.event_types:
            return True
        return event_type in config.event_types

    def _default_event_handler(self, obj: QObject, event: QEvent,
                              config: EventFilterConfig,
    ) -> bool:
        """Default event handler implementation.
        
        This is a simplified version that mimics the original main_window eventFilter.
        """
        # For now, just log the event and don't filter it
        # This can be extended based on specific requirements
        return False

    def get_installed_filters(self) -> list[str]:
        """Get list of installed filter IDs.
        
        Returns:
            List of installed filter IDs
        """
        return self._installed_filters.copy()

    def get_filter_config(self, filter_id: str,
    ) -> EventFilterConfig | None:
        """Get filter configuration.
        
        Args:
            filter_id: ID of the filter
            
        Returns:
            Filter configuration if found, None otherwise
        """
        return self._filters.get(filter_id)

    def enable_filter(self, filter_id: str,
    ) -> Result[None]:
        """Enable a filter.
        
        Args:
            filter_id: ID of the filter to enable
            
        Returns:
            Result indicating success or failure
        """
        config = self._filters.get(filter_id)
        if not config:
            return Result.failure(f"Filter {filter_id} not found")

        config.enabled = True
        self.logger.info("Enabled filter: {filter_id}")
        return Result.success(None)

    def disable_filter(self, filter_id: str,
    ) -> Result[None]:
        """Disable a filter.
        
        Args:
            filter_id: ID of the filter to disable
            
        Returns:
            Result indicating success or failure
        """
        config = self._filters.get(filter_id)
        if not config:
            return Result.failure(f"Filter {filter_id} not found")

        config.enabled = False
        self.logger.info("Disabled filter: {filter_id}")
        return Result.success(None)

    @classmethod
    def create_for_main_window(cls) -> "EventFilterService":
        """Factory method to create service configured for main window.
        
        Returns:
            Configured EventFilterService instance
        """
        service = cls()

        # Register default application-wide filter
        default_config = EventFilterConfig(
            filter_id="main_window_filter",
            scope=FilterScope.APPLICATION_WIDE,
            event_types=[EventType.ALL],
            enabled=True,
        )

        service.register_filter(default_config)

        return service