"""State management service for UI state tracking and transitions.

This module provides infrastructure services for managing UI state,
state transitions, and state persistence.
"""

import copy
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from PyQt6 import QtCore
from PyQt6.QtCore import QObject, QSettings, QTimer, pyqtSignal

from src_refactored.domain.ui_coordination.value_objects.state_management import (
    StateDefinition,
    StateTransition,
    StateTransitionResult,
)


@dataclass
class InfrastructureStateTransition:
    """Infrastructure state transition with PyQt timestamp."""
    domain_transition: StateTransition
    timestamp: QtCore.QDateTime = field(default_factory=QtCore.QDateTime.currentDateTime)

    @classmethod
    def from_domain(cls, domain_transition: StateTransition,
    ) -> "InfrastructureStateTransition":
        """Create from domain transition."""
        return cls(domain_transition=domain_transition)

    def to_domain(self) -> StateTransition:
        """Convert to domain transition."""
        return self.domain_transition


class StateManagementService(QObject):
    """Service for managing UI state and transitions.
    
    This service provides infrastructure-only logic for state management
    without business logic dependencies.
    """

    # Signals for state events
    state_changed = pyqtSignal(str, str, dict)  # from_state, to_state, data
    state_entered = pyqtSignal(str, dict)       # state, data
    state_exited = pyqtSignal(str, dict)        # state, data
    transition_failed = pyqtSignal(str, str, str)  # from_state, to_state, error
    state_timeout = pyqtSignal(str)             # state

    def __init__(self, parent: QObject | None = None):
        """Initialize the state management service.
        
        Args:
            parent: Parent QObject
        """
        super().__init__(parent)

        # State definitions
        self._states: dict[str, StateDefinition] = {}

        # Current state tracking
        self._current_state: str | None = None
        self._previous_state: str | None = None
        self._state_data: dict[str, Any] = {}

        # Transition tracking
        self._transition_history: list[StateTransition] = []
        self._max_history_size: int = 100

        # Action handlers
        self._entry_actions: dict[str, Callable[[str, dict[str, Any]], None]] = {}
        self._exit_actions: dict[str, Callable[[str, dict[str, Any]], None]] = {}
        self._transition_guards: dict[str, Callable[[str, str, dict[str, Any]], bool]] = {}

        # State timeouts
        self._state_timers: dict[str, QTimer] = {}

        # Persistence
        self._settings: QSettings | None = None
        self._persistence_key: str = "ui_state"

        # State snapshots for undo/redo
        self._state_snapshots: list[dict[str, Any]] = []
        self._snapshot_index: int = -1
        self._max_snapshots: int = 50

    def define_state(self,
                    name: str,
                    data: dict[str, Any] | None = None,
                    entry_actions: list[str] | None = None,
                    exit_actions: list[str] | None = None,
                    allowed_transitions: set[str] | None = None,
                    is_persistent: bool = False,
                    timeout_ms: int | None = None) -> None:
        """Define a new state.
        
        Args:
            name: State name
            data: Initial state data
            entry_actions: Actions to execute on state entry
            exit_actions: Actions to execute on state exit
            allowed_transitions: Set of allowed target states
            is_persistent: Whether state should be persisted
            timeout_ms: Optional timeout for automatic state transition
        """
        state_def = StateDefinition(
            name=name,
            data=data or {},
            entry_actions=entry_actions or [],
            exit_actions=exit_actions or [],
            allowed_transitions=allowed_transitions or set(),
            is_persistent=is_persistent,
            timeout_ms=timeout_ms,
        )

        self._states[name] = state_def

    def remove_state(self, name: str,
    ) -> bool:
        """Remove a state definition.
        
        Args:
            name: State name
            
        Returns:
            True if state was removed, False if not found
        """
        if name in self._states:
            # Stop timer if running
            self._stop_state_timer(name)

            # Remove from definitions
            del self._states[name]

            # Reset current state if it was the removed state
            if self._current_state == name:
                self._current_state = None
                self._state_data.clear()

            return True

        return False

    def set_initial_state(self, state_name: str, data: dict[str, Any] | None = None) -> bool:
        """Set the initial state.
        
        Args:
            state_name: Initial state name
            data: Initial state data
            
        Returns:
            True if state was set, False if state doesn't exist
        """
        if state_name not in self._states:
            return False

        self._current_state = state_name
        self._state_data = data or {}

        # Execute entry actions
        self._execute_entry_actions(state_name)

        # Start timeout timer if configured
        self._start_state_timer(state_name)

        # Create snapshot
        self._create_snapshot()

        # Emit signal
        self.state_entered.emit(state_name, self._state_data)

        return True

    def transition_to(self,
                     target_state: str,
                     trigger: str = "manual",
                     data: dict[str, Any] | None = None) -> StateTransitionResult:
        """Transition to a new state.
        
        Args:
            target_state: Target state name
            trigger: Transition trigger
            data: Additional transition data
            
        Returns:
            StateTransitionResult indicating success or failure
        """
        # Validate target state exists
        if target_state not in self._states:
            return StateTransitionResult.INVALID

        # Get current state info
        from_state = self._current_state
        transition_data = data or {}

        # Check if transition is allowed
        if from_state and from_state in self._states:
            current_state_def = self._states[from_state]
            if not current_state_def.can_transition_to(target_state):
                self._record_transition(from_state, target_state, trigger,
                                      transition_data, StateTransitionResult.BLOCKED,
                                      "Transition not allowed")
                self.transition_failed.emit(from_state or "", target_state, "Transition not allowed")
                return StateTransitionResult.BLOCKED

        # Check transition guards
        guard_key = f"{from_state or 'any'}_{target_state}"
        if guard_key in self._transition_guards:
            guard_func = self._transition_guards[guard_key]
            if not guard_func(from_state or "", target_state, transition_data):
                self._record_transition(from_state, target_state, trigger,
                                      transition_data, StateTransitionResult.BLOCKED,
                                      "Transition blocked by guard")
                self.transition_failed.emit(from_state or "", target_state, "Transition blocked by guard")
                return StateTransitionResult.BLOCKED

        try:
            # Execute exit actions for current state
            if from_state:
                self._execute_exit_actions(from_state)
                self._stop_state_timer(from_state)
                self.state_exited.emit(from_state, self._state_data)

            # Update state
            self._previous_state = from_state
            self._current_state = target_state

            # Merge transition data with state data
            target_state_def = self._states[target_state]
            self._state_data = copy.deepcopy(target_state_def.data)
            self._state_data.update(transition_data)

            # Execute entry actions for new state
            self._execute_entry_actions(target_state)

            # Start timeout timer if configured
            self._start_state_timer(target_state)

            # Create snapshot
            self._create_snapshot()

            # Record successful transition
            self._record_transition(from_state, target_state, trigger,
                                  transition_data, StateTransitionResult.SUCCESS)

            # Emit signals
            self.state_entered.emit(target_state, self._state_data)
            self.state_changed.emit(from_state or "", target_state, self._state_data)

            return StateTransitionResult.SUCCESS

        except Exception as e:
            error_msg = f"Transition failed: {e!s}"
            self._record_transition(from_state, target_state, trigger,
                                  transition_data, StateTransitionResult.FAILED, error_msg)
            self.transition_failed.emit(from_state or "", target_state, error_msg)
            return StateTransitionResult.FAILED

    def get_current_state(self) -> str | None:
        """Get the current state name.
        
        Returns:
            Current state name or None if no state is set
        """
        return self._current_state

    def get_previous_state(self) -> str | None:
        """Get the previous state name.
        
        Returns:
            Previous state name or None if no previous state
        """
        return self._previous_state

    def get_state_data(self, key: str | None = None) -> dict[str, Any] | Any | None:
        """Get state data.
        
        Args:
            key: Optional key to get specific data item
            
        Returns:
            State data dictionary or specific value if key provided
        """
        if key is None:
            return copy.deepcopy(self._state_data)
        return self._state_data.get(key)

    def set_state_data(self, key: str, value: Any,
    ) -> None:
        """Set state data.
        
        Args:
            key: Data key
            value: Data value
        """
        self._state_data[key] = value

    def update_state_data(self, data: dict[str, Any]) -> None:
        """Update state data.
        
        Args:
            data: Data to merge with current state data
        """
        self._state_data.update(data)

    def is_in_state(self, state_name: str,
    ) -> bool:
        """Check if currently in specified state.
        
        Args:
            state_name: State name to check
            
        Returns:
            True if in specified state, False otherwise
        """
        return self._current_state == state_name

    def can_transition_to(self, target_state: str,
    ) -> bool:
        """Check if transition to target state is possible.
        
        Args:
            target_state: Target state name
            
        Returns:
            True if transition is possible, False otherwise
        """
        if target_state not in self._states:
            return False

        if not self._current_state:
            return True

        current_state_def = self._states[self._current_state]
        return current_state_def.can_transition_to(target_state)

    def register_entry_action(
    self,
    action_name: str,
    handler: Callable[[str,
    dict[str,
    Any]],
    None]) -> None:
        """Register an entry action handler.
        
        Args:
            action_name: Action name
            handler: Action handler function
        """
        self._entry_actions[action_name] = handler

    def register_exit_action(
    self,
    action_name: str,
    handler: Callable[[str,
    dict[str,
    Any]],
    None]) -> None:
        """Register an exit action handler.
        
        Args:
            action_name: Action name
            handler: Action handler function
        """
        self._exit_actions[action_name] = handler

    def register_transition_guard(self,
                                 from_state: str,
                                 to_state: str,
                                 guard: Callable[[str, str, dict[str, Any]], bool]) -> None:
        """Register a transition guard.
        
        Args:
            from_state: Source state (use 'any' for any state)
            to_state: Target state
            guard: Guard function that returns True to allow transition
        """
        guard_key = f"{from_state}_{to_state}"
        self._transition_guards[guard_key] = guard

    def get_transition_history(self, limit: int | None = None) -> list[StateTransition]:
        """Get transition history.
        
        Args:
            limit: Optional limit on number of transitions to return
            
        Returns:
            List of state transitions
        """
        if limit is None:
            return copy.deepcopy(self._transition_history)
        return copy.deepcopy(self._transition_history[-limit:])

    def clear_transition_history(self) -> None:
        """Clear transition history."""
        self._transition_history.clear()

    def undo_state(self) -> bool:
        """Undo to previous state snapshot.
        
        Returns:
            True if undo was successful, False otherwise
        """
        if self._snapshot_index > 0:
            self._snapshot_index -= 1
            snapshot = self._state_snapshots[self._snapshot_index]
            self._restore_snapshot(snapshot)
            return True
        return False

    def redo_state(self) -> bool:
        """Redo to next state snapshot.
        
        Returns:
            True if redo was successful, False otherwise
        """
        if self._snapshot_index < len(self._state_snapshots) - 1:
            self._snapshot_index += 1
            snapshot = self._state_snapshots[self._snapshot_index]
            self._restore_snapshot(snapshot)
            return True
        return False

    def can_undo(self) -> bool:
        """Check if undo is possible.
        
        Returns:
            True if undo is possible, False otherwise
        """
        return self._snapshot_index > 0

    def can_redo(self) -> bool:
        """Check if redo is possible.
        
        Returns:
            True if redo is possible, False otherwise
        """
        return self._snapshot_index < len(self._state_snapshots) - 1

    def enable_persistence(self, settings: QSettings, key: str = "ui_state") -> None:
        """Enable state persistence.
        
        Args:
            settings: QSettings instance for persistence
            key: Settings key for state data
        """
        self._settings = settings
        self._persistence_key = key

    def save_persistent_state(self) -> None:
        """Save persistent state to settings."""
        if not self._settings or not self._current_state:
            return

        current_state_def = self._states.get(self._current_state,
    )
        if not current_state_def or not current_state_def.is_persistent:
            return

        state_info = {
            "current_state": self._current_state,
            "state_data": self._state_data,
            "timestamp": QtCore.QDateTime.currentDateTime().toString(QtCore.Qt.DateFormat.ISODate),
        }

        self._settings.setValue(self._persistence_key, json.dumps(state_info))

    def load_persistent_state(self) -> bool:
        """Load persistent state from settings.
        
        Returns:
            True if state was loaded, False otherwise
        """
        if not self._settings:
            return False

        state_json = self._settings.value(self._persistence_key, "")
        if not state_json:
            return False

        try:
            state_info = json.loads(state_json)
            state_name = state_info.get("current_state",
    )
            state_data = state_info.get("state_data", {})

            if state_name and state_name in self._states:
                state_def = self._states[state_name]
                if state_def.is_persistent:
                    return self.set_initial_state(state_name, state_data)
        except (json.JSONDecodeError, KeyError):
            pass

        return False

    def _execute_entry_actions(self, state_name: str,
    ) -> None:
        """Execute entry actions for a state.
        
        Args:
            state_name: State name
        """
        if state_name not in self._states:
            return

        state_def = self._states[state_name]
        for action_name in state_def.entry_actions:
            if action_name in self._entry_actions:
                try:
                    self._entry_actions[action_name](state_name, self._state_data)
                except Exception:
                    # Log error but don't fail transition
                    pass

    def _execute_exit_actions(self, state_name: str,
    ) -> None:
        """Execute exit actions for a state.
        
        Args:
            state_name: State name
        """
        if state_name not in self._states:
            return

        state_def = self._states[state_name]
        for action_name in state_def.exit_actions:
            if action_name in self._exit_actions:
                try:
                    self._exit_actions[action_name](state_name, self._state_data)
                except Exception:
                    # Log error but don't fail transition
                    pass

    def _start_state_timer(self, state_name: str,
    ) -> None:
        """Start timeout timer for a state.
        
        Args:
            state_name: State name
        """
        if state_name not in self._states:
            return

        state_def = self._states[state_name]
        if state_def.timeout_ms is None:
            return

        # Stop existing timer
        self._stop_state_timer(state_name)

        # Create and start new timer
        timer = QTimer()
        timer.setSingleShot(True)
        timer.timeout.connect(lambda: self._handle_state_timeout(state_name))
        timer.start(state_def.timeout_ms)

        self._state_timers[state_name] = timer

    def _stop_state_timer(self, state_name: str,
    ) -> None:
        """Stop timeout timer for a state.
        
        Args:
            state_name: State name
        """
        if state_name in self._state_timers:
            self._state_timers[state_name].stop()
            del self._state_timers[state_name]

    def _handle_state_timeout(self, state_name: str,
    ) -> None:
        """Handle state timeout.
        
        Args:
            state_name: State name that timed out
        """
        if self._current_state == state_name:
            self.state_timeout.emit(state_name)

    def _record_transition(self,
                          from_state: str | None,
                          to_state: str,
                          trigger: str,
                          data: dict[str, Any],
                          result: StateTransitionResult,
                          error_message: str = "",
    ) -> None:
        """Record a state transition.
        
        Args:
            from_state: Source state
            to_state: Target state
            trigger: Transition trigger
            data: Transition data
            result: Transition result
            error_message: Error message if failed
        """
        transition = StateTransition(
            from_state=from_state or "",
            to_state=to_state,
            trigger=trigger,
            data=copy.deepcopy(data),
            result=result,
            error_message=error_message,
        )

        self._transition_history.append(transition)

        # Limit history size
        if len(self._transition_history) > self._max_history_size:
            self._transition_history.pop(0)

    def _create_snapshot(self) -> None:
        """Create a state snapshot for undo/redo."""
        snapshot = {
            "current_state": self._current_state,
            "previous_state": self._previous_state,
            "state_data": copy.deepcopy(self._state_data),
        }

        # Remove any snapshots after current index (for new branch)
        if self._snapshot_index < len(self._state_snapshots) - 1:
            self._state_snapshots = self._state_snapshots[:self._snapshot_index + 1]

        # Add new snapshot
        self._state_snapshots.append(snapshot)
        self._snapshot_index = len(self._state_snapshots) - 1

        # Limit snapshot history
        if len(self._state_snapshots) > self._max_snapshots:
            self._state_snapshots.pop(0)
            self._snapshot_index -= 1

    def _restore_snapshot(self, snapshot: dict[str, Any]) -> None:
        """Restore state from snapshot.
        
        Args:
            snapshot: State snapshot to restore
        """
        old_state = self._current_state

        self._current_state = snapshot["current_state"]
        self._previous_state = snapshot["previous_state"]
        self._state_data = copy.deepcopy(snapshot["state_data"])

        # Emit state change signal
        if old_state != self._current_state:
            self.state_changed.emit(old_state or "", self._current_state or "", self._state_data)

    def get_state_definitions(self) -> dict[str, StateDefinition]:
        """Get all state definitions.
        
        Returns:
            Dictionary of state definitions
        """
        return copy.deepcopy(self._states)

    def set_max_history_size(self, size: int,
    ) -> None:
        """Set maximum transition history size.
        
        Args:
            size: Maximum history size
        """
        self._max_history_size = size

        # Trim current history if needed
        if len(self._transition_history) > size:
            self._transition_history = self._transition_history[-size:]

    def set_max_snapshots(self, size: int,
    ) -> None:
        """Set maximum snapshot history size.
        
        Args:
            size: Maximum snapshot size
        """
        self._max_snapshots = size

        # Trim current snapshots if needed
        if len(self._state_snapshots) > size:
            removed_count = len(self._state_snapshots,
    ) - size
            self._state_snapshots = self._state_snapshots[removed_count:]
            self._snapshot_index = max(0, self._snapshot_index - removed_count)

    def cleanup(self) -> None:
        """Clean up service resources."""
        # Stop all timers
        for timer in self._state_timers.values():
            timer.stop()
        self._state_timers.clear()

        # Save persistent state if enabled
        self.save_persistent_state()

        # Clear state
        self._current_state = None
        self._previous_state = None
        self._state_data.clear()
        self._transition_history.clear()
        self._state_snapshots.clear()
        self._snapshot_index = -1

    def __del__(self):
        """Destructor to ensure cleanup."""
        self.cleanup()


class StateManagementManager:
    """High-level manager for state management functionality.
    
    Provides a simplified interface for common state management patterns.
    """

    def __init__(self, parent: QObject | None = None):
        """Initialize the state management manager.
        
        Args:
            parent: Parent QObject
        """
        self.service = StateManagementService(parent)

    def setup_recording_states(self) -> None:
        """Setup states for audio recording workflow."""
        # Define recording states
        self.service.define_state(
            "idle",
            data={"recording": False, "transcribing": False},
            allowed_transitions={"recording", "settings"},
        )

        self.service.define_state(
            "recording",
            data={"recording": True, "transcribing": False},
            allowed_transitions={"transcribing", "idle"},
            timeout_ms=300000,  # 5 minute timeout
        )

        self.service.define_state(
            "transcribing",
            data={"recording": False, "transcribing": True},
            allowed_transitions={"idle", "error"},
        )

        self.service.define_state(
            "settings",
            data={"recording": False, "transcribing": False, "in_settings": True},
            allowed_transitions={"idle"},
        )

        self.service.define_state(
            "error",
            data={"recording": False, "transcribing": False, "has_error": True},
            allowed_transitions={"idle"},
        )

        # Set initial state
        self.service.set_initial_state("idle")

    def setup_download_states(self) -> None:
        """Setup states for model download workflow."""
        # Define download states
        self.service.define_state(
            "ready",
            data={"downloading": False, "progress": 0},
            allowed_transitions={"downloading"},
        )

        self.service.define_state(
            "downloading",
            data={"downloading": True, "progress": 0},
            allowed_transitions={"completed", "error", "paused"},
        )

        self.service.define_state(
            "paused",
            data={"downloading": False, "paused": True},
            allowed_transitions={"downloading", "ready"},
        )

        self.service.define_state(
            "completed",
            data={"downloading": False, "progress": 100, "completed": True},
            allowed_transitions={"ready"},
        )

        self.service.define_state(
            "error",
            data={"downloading": False, "has_error": True},
            allowed_transitions={"ready"},
        )

        # Set initial state
        self.service.set_initial_state("ready")

    def setup_ui_states(self, persistent: bool = True,
    ) -> None:
        """Setup general UI states.
        
        Args:
            persistent: Whether to enable state persistence
        """
        # Define UI states
        self.service.define_state(
            "normal",
            data={"minimized": False, "fullscreen": False},
            allowed_transitions={"minimized", "fullscreen", "settings"},
            is_persistent=persistent,
        )

        self.service.define_state(
            "minimized",
            data={"minimized": True, "fullscreen": False},
            allowed_transitions={"normal", "fullscreen"},
            is_persistent=persistent,
        )

        self.service.define_state(
            "fullscreen",
            data={"minimized": False, "fullscreen": True},
            allowed_transitions={"normal", "minimized"},
            is_persistent=persistent,
        )

        self.service.define_state(
            "settings",
            data={"in_settings": True},
            allowed_transitions={"normal"},
        )

        # Set initial state
        self.service.set_initial_state("normal")

    def start_recording(self) -> bool:
        """Start recording state transition.
        
        Returns:
            True if transition was successful, False otherwise
        """
        result = self.service.transition_to("recording", "start_recording")
        return result == StateTransitionResult.SUCCESS

    def stop_recording(self) -> bool:
        """Stop recording and transition to transcribing.
        
        Returns:
            True if transition was successful, False otherwise
        """
        result = self.service.transition_to("transcribing", "stop_recording")
        return result == StateTransitionResult.SUCCESS

    def complete_transcription(self) -> bool:
        """Complete transcription and return to idle.
        
        Returns:
            True if transition was successful, False otherwise
        """
        result = self.service.transition_to("idle", "transcription_complete")
        return result == StateTransitionResult.SUCCESS

    def enter_settings(self) -> bool:
        """Enter settings state.
        
        Returns:
            True if transition was successful, False otherwise
        """
        result = self.service.transition_to("settings", "open_settings")
        return result == StateTransitionResult.SUCCESS

    def exit_settings(self) -> bool:
        """Exit settings and return to previous state.
        
        Returns:
            True if transition was successful, False otherwise
        """
        # Determine target state based on previous state
        previous = self.service.get_previous_state()
        target = previous if previous and previous != "settings" else "idle"

        result = self.service.transition_to(target, "close_settings")
        return result == StateTransitionResult.SUCCESS

    def set_error_state(self, error_message: str,
    ) -> bool:
        """Set error state.
        
        Args:
            error_message: Error message
            
        Returns:
            True if transition was successful, False otherwise
        """
        result = (
            self.service.transition_to("error", "error_occurred", {"error_message": error_message})
        )
        return result == StateTransitionResult.SUCCESS

    def is_recording(self) -> bool:
        """Check if currently recording.
        
        Returns:
            True if in recording state, False otherwise
        """
        return self.service.is_in_state("recording")

    def is_transcribing(self) -> bool:
        """Check if currently transcribing.
        
        Returns:
            True if in transcribing state, False otherwise
        """
        return self.service.is_in_state("transcribing")

    def is_in_settings(self) -> bool:
        """Check if currently in settings.
        
        Returns:
            True if in settings state, False otherwise
        """
        return self.service.is_in_state("settings")

    def get_service(self) -> StateManagementService:
        """Get the underlying state management service.
        
        Returns:
            StateManagementService instance
        """
        return self.service