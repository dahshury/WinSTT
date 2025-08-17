"""Timer Management Service for debounce operations and delayed execution.

This service provides centralized timer management functionality with debouncing,
extracted from settings_dialog.py (lines 146-148, 1407-1408).
"""

import weakref
from collections.abc import Callable
from typing import Any

from PyQt6.QtCore import QObject, QTimer, pyqtSignal

from src.domain.ui_coordination.value_objects.timer_management import TimerType


class TimerManagementService(QObject):
    """Service for managing timers with debouncing and delayed operations.
    
    Extracted from settings_dialog.py timer management patterns.
    """

    # Signals for timer events
    timer_started = pyqtSignal(str, str)  # timer_id, timer_type
    timer_stopped = pyqtSignal(str)  # timer_id
    timer_triggered = pyqtSignal(str)  # timer_id
    debounce_triggered = pyqtSignal(str)  # timer_id

    def __init__(self):
        """Initialize the timer management service."""
        super().__init__()
        self.timers: dict[str, QTimer] = {}
        self.timer_callbacks: dict[str, Callable] = {}
        self.timer_types: dict[str, TimerType] = {}
        self.timer_intervals: dict[str, int] = {}
        self.debounce_timers: dict[str, QTimer] = {}

        # Default intervals for different timer types
        self.default_intervals = {
            TimerType.DEBOUNCE: 200,  # 200ms debounce (from settings_dialog.py)
            TimerType.DELAY: 100,
            TimerType.PERIODIC: 1000,
            TimerType.SINGLE_SHOT: 0,
            TimerType.PROGRESS_RESET: 200,  # Progress bar reset delay
        }

    def create_timer(self, timer_id: str, timer_type: TimerType = TimerType.SINGLE_SHOT,
                    interval: int | None = None, callback: Callable | None = None) -> bool:
        """Create a new timer with specified configuration.
        
        Args:
            timer_id: Unique identifier for the timer
            timer_type: Type of timer to create
            interval: Timer interval in milliseconds (uses default if None)
            callback: Function to call when timer triggers
            
        Returns:
            True if timer was created, False if timer_id already exists
        """
        if timer_id in self.timers:
            return False

        # Create timer
        timer = QTimer(self)

        # Set interval
        if interval is None:
            interval = self.default_intervals[timer_type]
        timer.setInterval(interval,
    )

        # Configure timer based on type
        if timer_type in [TimerType.SINGLE_SHOT, TimerType.DEBOUNCE, TimerType.DELAY, TimerType.PROGRESS_RESET]:
            timer.setSingleShot(True)
        else:
            timer.setSingleShot(False)

        # Connect callback
        if callback:
            timer.timeout.connect(callback)
            self.timer_callbacks[timer_id] = callback

        # Connect internal signal
        timer.timeout.connect(lambda: self._on_timer_triggered(timer_id))

        # Store timer information
        self.timers[timer_id] = timer
        self.timer_types[timer_id] = timer_type
        self.timer_intervals[timer_id] = interval

        return True

    def create_debounce_timer(self, timer_id: str, interval: int = 200,
                             callback: Callable | None = None) -> bool:
        """Create a debounce timer (extracted from settings_dialog.py pattern).
        
        Args:
            timer_id: Unique identifier for the timer
            interval: Debounce interval in milliseconds (default 200ms)
            callback: Function to call when debounce period expires
            
        Returns:
            True if timer was created, False if timer_id already exists
        """
        return self.create_timer(timer_id, TimerType.DEBOUNCE, interval, callback)

    def create_progress_reset_timer(self, timer_id: str, callback: Callable | None = None) -> bool:
        """Create a progress reset timer (extracted from settings_dialog.py pattern).
        
        Args:
            timer_id: Unique identifier for the timer
            callback: Function to call when timer expires
            
        Returns:
            True if timer was created, False if timer_id already exists
        """
        return self.create_timer(timer_id, TimerType.PROGRESS_RESET, 200, callback)

    def start_timer(self, timer_id: str,
    ) -> bool:
        """Start a timer.
        
        Args:
            timer_id: Identifier of the timer to start
            
        Returns:
            True if timer was started, False if timer doesn't exist
        """
        if timer_id not in self.timers:
            return False

        timer = self.timers[timer_id]
        timer_type = self.timer_types[timer_id]

        # For debounce timers, stop if already running
        if timer_type == TimerType.DEBOUNCE and timer.isActive():
            timer.stop()

        timer.start()
        self.timer_started.emit(timer_id, timer_type.value)

        return True

    def stop_timer(self, timer_id: str,
    ) -> bool:
        """Stop a timer.
        
        Args:
            timer_id: Identifier of the timer to stop
            
        Returns:
            True if timer was stopped, False if timer doesn't exist
        """
        if timer_id not in self.timers:
            return False

        timer = self.timers[timer_id]
        if timer.isActive():
            timer.stop()
            self.timer_stopped.emit(timer_id)

        return True

    def restart_timer(self, timer_id: str,
    ) -> bool:
        """Restart a timer (stop and start).
        
        Args:
            timer_id: Identifier of the timer to restart
            
        Returns:
            True if timer was restarted, False if timer doesn't exist
        """
        if timer_id not in self.timers:
            return False

        self.stop_timer(timer_id)
        return self.start_timer(timer_id)

    def is_timer_active(self, timer_id: str,
    ) -> bool | None:
        """Check if a timer is currently active.
        
        Args:
            timer_id: Identifier of the timer to check
            
        Returns:
            True if active, False if inactive, None if timer doesn't exist
        """
        if timer_id not in self.timers:
            return None

        return self.timers[timer_id].isActive()

    def get_timer_interval(self, timer_id: str,
    ) -> int | None:
        """Get the interval of a timer.
        
        Args:
            timer_id: Identifier of the timer
            
        Returns:
            Timer interval in milliseconds or None if timer doesn't exist
        """
        return self.timer_intervals.get(timer_id)

    def set_timer_interval(self, timer_id: str, interval: int,
    ) -> bool:
        """Set the interval of a timer.
        
        Args:
            timer_id: Identifier of the timer
            interval: New interval in milliseconds
            
        Returns:
            True if interval was set, False if timer doesn't exist
        """
        if timer_id not in self.timers:
            return False

        self.timers[timer_id].setInterval(interval)
        self.timer_intervals[timer_id] = interval

        return True

    def get_timer_type(self, timer_id: str,
    ) -> TimerType | None:
        """Get the type of a timer.
        
        Args:
            timer_id: Identifier of the timer
            
        Returns:
            Timer type or None if timer doesn't exist
        """
        return self.timer_types.get(timer_id)

    def remove_timer(self, timer_id: str,
    ) -> bool:
        """Remove a timer and clean up resources.
        
        Args:
            timer_id: Identifier of the timer to remove
            
        Returns:
            True if timer was removed, False if timer doesn't exist
        """
        if timer_id not in self.timers:
            return False

        # Stop timer if active
        self.stop_timer(timer_id)

        # Clean up resources
        timer = self.timers[timer_id]
        timer.deleteLater()

        del self.timers[timer_id]
        del self.timer_types[timer_id]
        del self.timer_intervals[timer_id]

        if timer_id in self.timer_callbacks:
            del self.timer_callbacks[timer_id]

        return True

    def get_active_timers(self) -> list[str]:
        """Get list of all active timer IDs.
        
        Returns:
            List of active timer identifiers
        """
        return [timer_id for timer_id, timer in self.timers.items() if timer.isActive()]

    def get_all_timers(self) -> list[str]:
        """Get list of all timer IDs.
        
        Returns:
            List of all timer identifiers
        """
        return list(self.timers.keys())

    def debounce_call(self, operation_id: str, callback: Callable, interval: int = 200) -> None:
        """Debounce a function call (extracted from settings_dialog.py pattern).
        
        Args:
            operation_id: Unique identifier for the debounced operation
            callback: Function to call after debounce period
            interval: Debounce interval in milliseconds
        """
        timer_id = f"debounce_{operation_id}"

        # Remove existing timer if it exists
        if timer_id in self.timers:
            self.remove_timer(timer_id,
    )

        # Create new debounce timer
        self.create_debounce_timer(timer_id, interval, callback)
        self.start_timer(timer_id)

    def single_shot_call(self, operation_id: str, callback: Callable, delay: int = 0) -> None:
        """Execute a function after a delay (similar to QTimer.singleShot pattern).
        
        Args:
            operation_id: Unique identifier for the delayed operation
            callback: Function to call after delay
            delay: Delay in milliseconds
        """
        timer_id = f"single_shot_{operation_id}"

        # Remove existing timer if it exists
        if timer_id in self.timers:
            self.remove_timer(timer_id,
    )

        # Create single shot timer
        self.create_timer(timer_id, TimerType.SINGLE_SHOT, delay, callback)
        self.start_timer(timer_id)

    def create_progress_flag_reset(self, flag_name: str, target_object: Any,
                                  delay: int = 200) -> str:
        """Create a timer to reset a progress flag (extracted from settings_dialog.py).
        
        Args:
            flag_name: Name of the flag attribute to reset
            target_object: Object containing the flag
            delay: Delay before resetting the flag
            
        Returns:
            Timer ID for the created timer
        """
        timer_id = f"flag_reset_{flag_name}"

        # Create callback using weak reference to prevent memory leaks
        weak_ref = weakref.ref(target_object)

        def reset_flag():
            obj = weak_ref()
            if obj is not None:
                setattr(obj, flag_name, False)

        # Remove existing timer if it exists
        if timer_id in self.timers:
            self.remove_timer(timer_id)

        # Create progress reset timer
        self.create_progress_reset_timer(timer_id, reset_flag)

        return timer_id

    def start_progress_flag_reset(self, flag_name: str, target_object: Any,
                                 delay: int = 200,
    ) -> str:
        """Start a timer to reset a progress flag after delay.
        
        Args:
            flag_name: Name of the flag attribute to reset
            target_object: Object containing the flag
            delay: Delay before resetting the flag
            
        Returns:
            Timer ID for the started timer
        """
        timer_id = self.create_progress_flag_reset(flag_name, target_object, delay)
        self.start_timer(timer_id)
        return timer_id

    def _on_timer_triggered(self, timer_id: str,
    ) -> None:
        """Internal handler for timer triggers.
        
        Args:
            timer_id: ID of the timer that triggered
        """
        timer_type = self.timer_types.get(timer_id)

        # Emit appropriate signals
        self.timer_triggered.emit(timer_id)

        if timer_type == TimerType.DEBOUNCE:
            self.debounce_triggered.emit(timer_id)

        # Clean up single-shot timers
        if timer_type in [TimerType.SINGLE_SHOT, TimerType.DEBOUNCE,
                         TimerType.DELAY, TimerType.PROGRESS_RESET]:
            # Don't remove immediately, let the callback complete first
            QTimer.singleShot(0, lambda: self._cleanup_single_shot_timer(timer_id))

    def _cleanup_single_shot_timer(self, timer_id: str,
    ) -> None:
        """Clean up a single-shot timer after it has triggered.
        
        Args:
            timer_id: ID of the timer to clean up
        """
        if timer_id in self.timers and not self.timers[timer_id].isActive():
            # Only clean up if timer is not active (has completed)
            timer_type = self.timer_types.get(timer_id)
            if timer_type in [TimerType.SINGLE_SHOT, TimerType.DEBOUNCE,
                             TimerType.DELAY, TimerType.PROGRESS_RESET]:
                # Keep the timer for potential reuse, just clear callback
                if timer_id in self.timer_callbacks:
                    del self.timer_callbacks[timer_id]

    def cleanup_all(self) -> None:
        """Clean up all timers and resources."""
        # Stop all active timers
        for timer_id in list(self.timers.keys()):
            self.remove_timer(timer_id)

        # Clear all collections
        self.timers.clear()
        self.timer_callbacks.clear()
        self.timer_types.clear()
        self.timer_intervals.clear()
        self.debounce_timers.clear()

    def get_timer_statistics(self) -> dict[str, Any]:
        """Get statistics about managed timers.
        
        Returns:
            Dictionary with timer statistics
        """
        active_count = len(self.get_active_timers())
        total_count = len(self.timers)

        type_counts: dict[str, int] = {}
        for timer_type in self.timer_types.values():
            type_counts[timer_type.value] = type_counts.get(timer_type.value, 0) + 1

        return {
            "total_timers": total_count,
            "active_timers": active_count,
            "inactive_timers": total_count - active_count,
            "timers_by_type": type_counts,
        }