"""Manage Window State Use Case

This module implements the ManageWindowStateUseCase for managing window state
including minimization, maximization, restoration, and state persistence.
"""

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Protocol

from src_refactored.domain.main_window.value_objects.window_state_management import (
    ManagePhase,
    ManageResult,
    StateTransition,
    WindowState,
)


class GeometryMode(Enum):
    """Enumeration of geometry management modes."""
    PRESERVE = "preserve"
    RESTORE_PREVIOUS = "restore_previous"
    USE_DEFAULT = "use_default"
    CALCULATE_OPTIMAL = "calculate_optimal"
    CENTER_ON_SCREEN = "center_on_screen"
    CENTER_ON_PARENT = "center_on_parent"
    CUSTOM_POSITION = "custom_position"


class PersistenceMode(Enum):
    """Enumeration of state persistence modes."""
    NONE = "none"
    SESSION_ONLY = "session_only"
    PERSISTENT = "persistent"
    AUTO_SAVE = "auto_save"
    MANUAL_SAVE = "manual_save"


class AnimationMode(Enum):
    """Enumeration of animation modes for state transitions."""
    NONE = "none"
    SYSTEM_DEFAULT = "system_default"
    SMOOTH = "smooth"
    FAST = "fast"
    CUSTOM = "custom"


@dataclass
class WindowGeometry:
    """Window geometry information."""
    x: int
    y: int
    width: int
    height: int
    screen_index: int = 0
    is_valid: bool = True

    def to_tuple(self,
    ) -> tuple[int, int, int, int]:
        """Convert to tuple format."""
        return (self.x, self.y, self.width, self.height)

    @classmethod
    def from_tuple(cls, geometry: tuple[int, int, int, int], screen_index: int = 0,
    ) -> "WindowGeometry":
        """Create from tuple format."""
        return cls(
            x=geometry[0],
            y=geometry[1],
            width=geometry[2],
            height=geometry[3],
            screen_index=screen_index,
        )


@dataclass
class StateTransitionConfiguration:
    """Configuration for state transitions."""
    transition_type: StateTransition
    target_state: WindowState
    geometry_mode: GeometryMode = GeometryMode.PRESERVE
    animation_mode: AnimationMode = AnimationMode.SYSTEM_DEFAULT
    animation_duration_ms: int = 250
    preserve_focus: bool = True
    update_taskbar: bool = True
    notify_state_change: bool = True
    custom_geometry: WindowGeometry | None = None
    force_transition: bool = False


@dataclass
class PersistenceConfiguration:
    """Configuration for state persistence."""
    persistence_mode: PersistenceMode
    storage_key: str
    include_geometry: bool = True
    include_state: bool = True
    include_screen_info: bool = True
    auto_save_interval_ms: int = 5000
    max_history_entries: int = 10
    encrypt_data: bool = False
    compression_enabled: bool = True


@dataclass
class ValidationConfiguration:
    """Configuration for state validation."""
    validate_geometry_bounds: bool = True
    validate_screen_availability: bool = True
    validate_state_compatibility: bool = True
    allow_offscreen_windows: bool = False
    min_window_size: tuple[int, int] = (100, 50)
    max_window_size: tuple[int, int] | None = None
    enforce_aspect_ratio: bool = False
    aspect_ratio_tolerance: float = 0.1


@dataclass
class ManageWindowStateRequest:
    """Request for managing window state."""
    window: Any  # QWidget or similar
    transition_config: StateTransitionConfiguration
    persistence_config: PersistenceConfiguration | None = None
    validation_config: ValidationConfiguration | None = None
    context_data: dict[str, Any] | None = None
    timestamp: datetime = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()
        if self.context_data is None:
            self.context_data = {}
        if self.validation_config is None:
            self.validation_config = ValidationConfiguration(,
    )


@dataclass
class WindowStateSnapshot:
    """Snapshot of window state at a point in time."""
    state: WindowState
    geometry: WindowGeometry
    is_visible: bool
    is_active: bool
    is_enabled: bool
    z_order: int
    opacity: float
    window_flags: int
    screen_index: int
    timestamp: datetime
    additional_properties: dict[str, Any] = None

    def __post_init__(self):
        if self.additional_properties is None:
            self.additional_properties = {}


@dataclass
class StateTransitionResult:
    """Result of a state transition operation."""
    transition_type: StateTransition
    previous_state: WindowState
    new_state: WindowState
    previous_geometry: WindowGeometry
    new_geometry: WindowGeometry
    transition_successful: bool
    animation_completed: bool
    duration_ms: float
    error_message: str | None = None


@dataclass
class PersistenceResult:
    """Result of state persistence operation."""
    persistence_mode: PersistenceMode
    operation_type: str  # save, load, clear
    storage_key: str
    data_size_bytes: int
    operation_successful: bool
    entries_count: int
    error_message: str | None = None


@dataclass
class WindowStateManagementState:
    """Current state of window state management."""
    current_snapshot: WindowStateSnapshot
    previous_snapshot: WindowStateSnapshot | None
    transition_history: list[StateTransitionResult]
    persistence_info: PersistenceResult | None
    validation_results: list[str]
    management_active: bool
    last_update_time: datetime
    session_start_time: datetime

    def __post_init__(self):
        if not hasattr(self, "transition_history") or self.transition_history is None:
            self.transition_history = []
        if not hasattr(self, "validation_results") or self.validation_results is None:
            self.validation_results = []


@dataclass
class ManageWindowStateResponse:
    """Response from window state management."""
    result: ManageResult
    management_state: WindowStateManagementState | None
    current_phase: ManagePhase
    progress_percentage: float
    transition_result: StateTransitionResult | None = None
    persistence_result: PersistenceResult | None = None
    error_message: str | None = None
    warnings: list[str] = None
    execution_time_ms: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class WindowValidationServiceProtocol(Protocol,
    ):
    """Protocol for window validation operations."""

    def validate_window_object(self, window: Any,
    ) -> list[str]:
        """Validate window object."""
        ...

    def validate_state_transition(self, current_state: WindowState, target_state: WindowState,
    ) -> list[str]:
        """Validate state transition compatibility."""
        ...

    def validate_geometry_bounds(self, geometry: WindowGeometry, config: ValidationConfiguration,
    ) -> list[str]:
        """Validate geometry bounds."""
        ...

    def validate_screen_availability(self, geometry: WindowGeometry,
    ) -> list[str]:
        """Validate screen availability for geometry."""
        ...


class StateBackupServiceProtocol(Protocol):
    """Protocol for state backup operations."""

    def create_state_snapshot(self, window: Any,
    ) -> WindowStateSnapshot:
        """Create snapshot of current window state."""
        ...

    def backup_current_state(self, window: Any, backup_key: str,
    ) -> bool:
        """Backup current window state."""
        ...

    def restore_state_from_backup(self, window: Any, backup_key: str,
    ) -> bool:
        """Restore window state from backup."""
        ...

    def clear_state_backup(self, backup_key: str,
    ) -> bool:
        """Clear state backup."""
        ...


class StateTransitionServiceProtocol(Protocol):
    """Protocol for state transition operations."""

    def execute_state_transition(self, window: Any, config: StateTransitionConfiguration,
    ) -> StateTransitionResult:
        """Execute state transition."""
        ...

    def get_current_window_state(self, window: Any,
    ) -> WindowState:
        """Get current window state."""
        ...

    def set_window_state(
    self,
    window: Any,
    state: WindowState,
    geometry: WindowGeometry | None = None) -> bool:
        """Set window state."""
        ...

    def animate_state_transition(self, window: Any, config: StateTransitionConfiguration,
    ) -> bool:
        """Animate state transition."""
        ...


class GeometryManagementServiceProtocol(Protocol):
    """Protocol for geometry management operations."""

    def get_current_geometry(self, window: Any,
    ) -> WindowGeometry:
        """Get current window geometry."""
        ...

    def set_window_geometry(self, window: Any, geometry: WindowGeometry,
    ) -> bool:
        """Set window geometry."""
        ...

    def calculate_optimal_geometry(self,
window: Any, mode: GeometryMode, reference_geometry: WindowGeometry | None = (
    None) -> WindowGeometry:)
        """Calculate optimal geometry based on mode."""
        ...

    def center_window_on_screen(self, window: Any, screen_index: int = 0,
    ) -> WindowGeometry:
        """Center window on specified screen."""
        ...

    def get_screen_geometry(self, screen_index: int = 0) -> WindowGeometry:
        """Get screen geometry."""
        ...


class StatePersistenceServiceProtocol(Protocol,
    ):
    """Protocol for state persistence operations."""

    def save_window_state(self,
    state_snapshot: WindowStateSnapshot, config: PersistenceConfiguration,
    ) -> PersistenceResult:
        """Save window state to persistent storage."""
        ...

    def load_window_state(self, config: PersistenceConfiguration,
    ) -> WindowStateSnapshot | None:
        """Load window state from persistent storage."""
        ...

    def clear_saved_state(self, config: PersistenceConfiguration,
    ) -> bool:
        """Clear saved window state."""
        ...

    def get_state_history(self, config: PersistenceConfiguration,
    ) -> list[WindowStateSnapshot]:
        """Get window state history."""
        ...

    def setup_auto_save(self, window: Any, config: PersistenceConfiguration,
    ) -> bool:
        """Setup automatic state saving."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress_session(self, session_id: str, total_phases: int,
    ) -> None:
        """Start a new progress tracking session."""
        ...

    def update_progress(self, session_id: str, phase: ManagePhase, percentage: float,
    ) -> None:
        """Update progress for current phase."""
        ...

    def complete_progress_session(self, session_id: str,
    ) -> None:
        """Complete progress tracking session."""
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging operations."""

    def log_info(self, message: str, context: dict[str, Any] | None = None) -> None:
        """Log info message."""
        ...

    def log_warning(self, message: str, context: dict[str, Any] | None = None) -> None:
        """Log warning message."""
        ...

    def log_error(self, message: str, context: dict[str, Any] | None = None) -> None:
        """Log error message."""
        ...


class ManageWindowStateUseCase:
    """Use case for managing window state including minimization, maximization, and persistence."""

    def __init__(
        self,
        validation_service: WindowValidationServiceProtocol,
        backup_service: StateBackupServiceProtocol,
        transition_service: StateTransitionServiceProtocol,
        geometry_service: GeometryManagementServiceProtocol,
        persistence_service: StatePersistenceServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.validation_service = validation_service
        self.backup_service = backup_service
        self.transition_service = transition_service
        self.geometry_service = geometry_service
        self.persistence_service = persistence_service
        self.progress_service = progress_service
        self.logger_service = logger_service

    def execute(self, request: ManageWindowStateRequest,
    ) -> ManageWindowStateResponse:
        """Execute window state management."""
        start_time = datetime.utcnow()
        session_id = f"manage_window_state_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 7)
            self.progress_service.update_progress(session_id, ManagePhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting window state management",
                {
                    "transition_type": request.transition_config.transition_type.value,
                    "target_state": request.transition_config.target_state.value,
                    "geometry_mode": request.transition_config.geometry_mode.value,
                    "persistence_enabled": request.persistence_config is not None,
                },
            )

            # Phase 2: Validation
            self.progress_service.update_progress(session_id, ManagePhase.VALIDATION, 14.3)

            validation_errors = []

            # Validate window object
            window_errors = self.validation_service.validate_window_object(request.window)
            validation_errors.extend(window_errors)

            # Get current state for validation
            current_state = self.transition_service.get_current_window_state(request.window)

            # Validate state transition
            transition_errors = self.validation_service.validate_state_transition(
                current_state,
                request.transition_config.target_state,
            )
            validation_errors.extend(transition_errors)

            # Validate geometry if custom geometry is provided
            if request.transition_config.custom_geometry:
                geometry_errors = self.validation_service.validate_geometry_bounds(
                    request.transition_config.custom_geometry,
                    request.validation_config,
                )
                validation_errors.extend(geometry_errors)

                # Validate screen availability
                screen_errors = self.validation_service.validate_screen_availability(
                    request.transition_config.custom_geometry,
                )
                validation_errors.extend(screen_errors)

            if validation_errors and not request.transition_config.force_transition:
                return self._create_error_response(
                    ManageResult.VALIDATION_ERROR,
                    ManagePhase.VALIDATION,
                    14.3,
                    f"Validation failed: {'; '.join(validation_errors)}",
                    start_time,
                )

            # Phase 3: State Backup
            self.progress_service.update_progress(session_id, ManagePhase.STATE_BACKUP, 28.6)

            # Create current state snapshot
            current_snapshot = self.backup_service.create_state_snapshot(request.window)

            # Backup current state for potential restoration
            backup_key = f"window_state_backup_{session_id}"
            backup_success = self.backup_service.backup_current_state(request.window, backup_key)

            if not backup_success:
                self.logger_service.log_warning(
                    "Failed to create state backup",
                    {"backup_key": backup_key},
                )

            # Phase 4: State Transition
            self.progress_service.update_progress(session_id, ManagePhase.STATE_TRANSITION, 42.9)

            transition_result = None
            try:
                # Execute state transition
                transition_result = self.transition_service.execute_state_transition(
                    request.window,
                    request.transition_config,
                )

                if not transition_result.transition_successful:
                    # Attempt to restore from backup
                    if backup_success:
                        self.backup_service.restore_state_from_backup(request.window, backup_key)

                    return self._create_error_response(
                        ManageResult.STATE_CHANGE_FAILED,
                        ManagePhase.STATE_TRANSITION,
                        42.9,
                        f"State transition failed: {transition_result.error_message or 'Unknown error'}",
                        start_time,
                    )

            except Exception as e:
                # Attempt to restore from backup on exception
                if backup_success:
                    try:
                        self.backup_service.restore_state_from_backup(request.window, backup_key)
                    except Exception as restore_error:
                        self.logger_service.log_error(
                            f"Failed to restore state after transition error: {restore_error!s}",
                            {"original_error": str(e)},
                        )

                return self._create_error_response(
                    ManageResult.STATE_CHANGE_FAILED,
                    ManagePhase.STATE_TRANSITION,
                    42.9,
                    f"State transition exception: {e!s}",
                    start_time,
                )

            # Phase 5: Geometry Adjustment
            self.progress_service.update_progress(session_id, ManagePhase.GEOMETRY_ADJUSTMENT, 57.1)

            geometry_warnings = []
            final_geometry = transition_result.new_geometry

            try:
                # Handle geometry mode
                if request.transition_config.geometry_mode != GeometryMode.PRESERVE:
                    if request.transition_config.geometry_mode
                     ==  GeometryMode.CUSTOM_POSITION and request.transition_config.custom_geometry:
                        # Use custom geometry
                        final_geometry = request.transition_config.custom_geometry
                    else:
                        # Calculate optimal geometry
                        final_geometry = self.geometry_service.calculate_optimal_geometry(
                            request.window,
                            request.transition_config.geometry_mode,
                            current_snapshot.geometry,
                        )

                    # Apply geometry if different from current
                    if (final_geometry.x != transition_result.new_geometry.x or
                        final_geometry.y != transition_result.new_geometry.y or
                        final_geometry.width != transition_result.new_geometry.width or
                        final_geometry.height != transition_result.new_geometry.height):

                        geometry_success = self.geometry_service.set_window_geometry(
                            request.window,
                            final_geometry,
                        )

                        if not geometry_success:
                            geometry_warnings.append("Failed to apply calculated geometry")
final_geometry = (
    transition_result.new_geometry  # Fallback to transition geometry)

                # Validate final geometry
                if request.validation_config.validate_geometry_bounds:
                    final_geometry_errors = self.validation_service.validate_geometry_bounds(
                        final_geometry,
                        request.validation_config,
                    )
                    if final_geometry_errors:
                        geometry_warnings.extend(final_geometry_errors)

            except Exception as e:
                geometry_warnings.append(f"Geometry adjustment error: {e!s}")
                self.logger_service.log_warning(
                    f"Geometry adjustment failed: {e!s}",
                    {"transition_type": request.transition_config.transition_type.value},
                )

            # Phase 6: Persistence
            self.progress_service.update_progress(session_id, ManagePhase.PERSISTENCE, 71.4)

            persistence_result = None
if request.persistence_config and request.persistence_config.persistence_mode ! = (
    PersistenceMode.NONE:)
                try:
                    # Create updated snapshot for persistence
                    updated_snapshot = self.backup_service.create_state_snapshot(request.window)

                    # Save state to persistent storage
                    persistence_result = self.persistence_service.save_window_state(
                        updated_snapshot,
                        request.persistence_config,
                    )

                    if not persistence_result.operation_successful:
                        self.logger_service.log_warning(
                            "Failed to persist window state",
                            {
                                "storage_key": request.persistence_config.storage_key,
                                "error": persistence_result.error_message,
                            },
                        )

                    # Setup auto-save if configured
                    if request.persistence_config.persistence_mode == PersistenceMode.AUTO_SAVE:
                        auto_save_success = self.persistence_service.setup_auto_save(
                            request.window,
                            request.persistence_config,
                        )

                        if not auto_save_success:
                            self.logger_service.log_warning(
                                "Failed to setup auto-save for window state",
                                {"storage_key": request.persistence_config.storage_key},
                            )

                except Exception as e:
                    self.logger_service.log_error(
                        f"Persistence operation failed: {e!s}",
                        {
    "storage_key": request.persistence_config.storage_key if request.persistence_config else "unknown"},
                    )

                    persistence_result = PersistenceResult(
                        persistence_mode=request.persistence_config.persistence_mode,
                        operation_type="save",
                        storage_key=request.persistence_config.storage_key,
                        data_size_bytes=0,
                        operation_successful=False,
                        entries_count=0,
                        error_message=str(e),
                    )

            # Phase 7: Finalization
            self.progress_service.update_progress(session_id, ManagePhase.FINALIZATION, 85.7)

            # Create final state snapshot
            final_snapshot = self.backup_service.create_state_snapshot(request.window)

            # Update transition result with final geometry
            if transition_result:
                transition_result.new_geometry = final_geometry

            # Create management state
            management_state = WindowStateManagementState(
                current_snapshot=final_snapshot,
                previous_snapshot=current_snapshot,
                transition_history=[transition_result] if transition_result else [],
                persistence_info=persistence_result,
                validation_results=validation_errors,
                management_active=True,
                last_update_time=datetime.utcnow()
                session_start_time=start_time,
            )

            # Clean up backup
            if backup_success:
                self.backup_service.clear_state_backup(backup_key)

            self.progress_service.update_progress(session_id, ManagePhase.FINALIZATION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

            # Determine final result
            if not transition_result or not transition_result.transition_successful:
                result = ManageResult.STATE_CHANGE_FAILED
            elif persistence_result and not persistence_result.operation_successful:
                result = ManageResult.PERSISTENCE_FAILED
            elif geometry_warnings or validation_errors:
                result = ManageResult.SUCCESS  # Success with warnings
            else:
                result = ManageResult.SUCCESS

            all_warnings = geometry_warnings + validation_errors

            self.logger_service.log_info(
                "Window state management completed",
                {
                    "transition_type": request.transition_config.transition_type.value,
                    "target_state": request.transition_config.target_state.value,
                    "result": result.value,
                    "execution_time_ms": execution_time,
                    "transition_successful": transition_result.transition_successful if transition_result else False,
                    "persistence_successful": persistence_result.operation_successful if persistence_result else None,
                    "warnings_count": len(all_warnings),
                },
            )

            return ManageWindowStateResponse(
                result=result,
                management_state=management_state,
                current_phase=ManagePhase.FINALIZATION,
                progress_percentage=100.0,
                transition_result=transition_result,
                persistence_result=persistence_result,
                warnings=all_warnings,
                execution_time_ms=execution_time,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during window state management",
                {"error": str(e)},
            )

            return self._create_error_response(
                ManageResult.INTERNAL_ERROR,
                ManagePhase.INITIALIZATION,
                0.0,
                f"Unexpected error: {e!s}",
                start_time,
            )

    def _create_error_response(
        self,
        result: ManageResult,
        phase: ManagePhase,
        progress: float,
        error_message: str,
        start_time: datetime,
    ) -> ManageWindowStateResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

        return ManageWindowStateResponse(
            result=result,
            management_state=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )