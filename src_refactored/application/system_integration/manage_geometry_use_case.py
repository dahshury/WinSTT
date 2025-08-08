"""Manage Geometry Use Case.

This module implements the ManageGeometryUseCase for managing window geometry
with comprehensive positioning, sizing, and state management.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from src_refactored.domain.system_integration.value_objects.system_operations import (
    GeometryOperation,
    ManagePhase,
    ManageResult,
    PositionMode,
)


class SizeMode(Enum):
    """Window sizing modes."""
    FIXED = "fixed"
    MINIMUM = "minimum"
    MAXIMUM = "maximum"
    PREFERRED = "preferred"
    CONTENT_BASED = "content_based"
    PROPORTIONAL = "proportional"
    CUSTOM = "custom"


class ConstraintType(Enum):
    """Types of geometry constraints."""
    MINIMUM_SIZE = "minimum_size"
    MAXIMUM_SIZE = "maximum_size"
    ASPECT_RATIO = "aspect_ratio"
    SCREEN_BOUNDS = "screen_bounds"
    PARENT_BOUNDS = "parent_bounds"
    CUSTOM = "custom"


class AnimationType(Enum):
    """Types of geometry animations."""
    NONE = "none"
    FADE = "fade"
    SLIDE = "slide"
    SCALE = "scale"
    BOUNCE = "bounce"
    ELASTIC = "elastic"
    CUSTOM = "custom"


@dataclass
class Position:
    """Window position coordinates."""
    x: int
    y: int

    def __post_init__(self):
        self.x = int(self.x)
        self.y = int(self.y)


@dataclass
class Size:
    """Window size dimensions."""
    width: int
    height: int

    def __post_init__(self):
        self.width = max(1, int(self.width))
        self.height = max(1, int(self.height))


@dataclass
class Geometry:
    """Complete window geometry."""
    position: Position
    size: Size

    @property
    def x(self) -> int:
        return self.position.x

    @property
    def y(self) -> int:
        return self.position.y

    @property
    def width(self) -> int:
        return self.size.width

    @property
    def height(self) -> int:
        return self.size.height

    @property
    def right(self) -> int:
        return self.x + self.width

    @property
    def bottom(self) -> int:
        return self.y + self.height


@dataclass
class ScreenInfo:
    """Screen information."""
    geometry: Geometry
    available_geometry: Geometry
    is_primary: bool = False
    scale_factor: float = 1.0
    name: str | None = None


@dataclass
class GeometryConstraint:
    """Geometry constraint definition."""
    constraint_type: ConstraintType
    min_size: Size | None = None
    max_size: Size | None = None
    aspect_ratio: float | None = None
    bounds: Geometry | None = None
    custom_validator: Callable[[Geometry], bool] | None = None
    enabled: bool = True


@dataclass
class PositionConfiguration:
    """Configuration for window positioning."""
    mode: PositionMode
    target_position: Position | None = None
    offset: Position | None = None
    parent_widget: Any | None = None
    screen_index: int | None = None
    remember_position: bool = True
    apply_constraints: bool = True


@dataclass
class SizeConfiguration:
    """Configuration for window sizing."""
    mode: SizeMode
    target_size: Size | None = None
    min_size: Size | None = None
    max_size: Size | None = None
    aspect_ratio: float | None = None
    content_margins: tuple[int, int, int, int] | None = None  # left, top, right, bottom
    remember_size: bool = True
    apply_constraints: bool = True


@dataclass
class AnimationConfiguration:
    """Configuration for geometry animations."""
    animation_type: AnimationType
    duration: float = 0.3  # seconds
    easing_curve: str = "ease_in_out"
    delay: float = 0.0
    auto_start: bool = True
    callback_on_finished: Callable[[], None] | None = None


@dataclass
class PersistenceConfiguration:
    """Configuration for geometry persistence."""
    save_position: bool = True
    save_size: bool = True
    save_state: bool = True
    storage_key: str | None = None
    auto_save: bool = True
    auto_restore: bool = True


@dataclass
class ManageGeometryRequest:
    """Request for geometry management."""
    target_widget: Any
    operation: GeometryOperation
    position_config: PositionConfiguration | None = None
    size_config: SizeConfiguration | None = None
    constraints: list[GeometryConstraint] = field(default_factory=list)
    animation_config: AnimationConfiguration | None = None
    persistence_config: PersistenceConfiguration | None = None
    enable_logging: bool = True
    enable_progress_tracking: bool = True
    operation_timeout: float = 30.0

    def __post_init__(self):
        if self.constraints is None:
            self.constraints = []


@dataclass
class ScreenAnalysisResult:
    """Result of screen analysis."""
    screens: list[ScreenInfo]
    primary_screen: ScreenInfo
    target_screen: ScreenInfo
    total_screen_area: Geometry
    available_area: Geometry
    multi_screen: bool


@dataclass
class ConstraintCheckResult:
    """Result of constraint checking."""
    all_constraints_satisfied: bool
    violated_constraints: list[ConstraintType]
    adjusted_geometry: Geometry | None = None
    constraint_messages: list[str] = field(default_factory=list)

    def __post_init__(self):
        if self.constraint_messages is None:
            self.constraint_messages = []


@dataclass
class GeometryCalculationResult:
    """Result of geometry calculation."""
    calculated_geometry: Geometry
    original_geometry: Geometry
    position_changed: bool
    size_changed: bool
    calculation_method: str
    adjustments_made: list[str] = field(default_factory=list)

    def __post_init__(self,
    ):
        if self.adjustments_made is None:
            self.adjustments_made = []


@dataclass
class AnimationSetupResult:
    """Result of animation setup."""
    animation_created: bool
    animation_configured: bool
    animation_ready: bool
    animation_object: Any | None = None
    error_message: str | None = None


@dataclass
class GeometryApplicationResult:
    """Result of geometry application."""
    geometry_applied: bool
    animation_started: bool
    final_geometry: Geometry
    application_time: float
    error_message: str | None = None


@dataclass
class StatePersistenceResult:
    """Result of state persistence."""
    state_saved: bool
    position_saved: bool
    size_saved: bool
    state_restored: bool
    storage_location: str | None = None
    error_message: str | None = None


@dataclass
class GeometryManagementState:
    """Current state of geometry management."""
    current_phase: ManagePhase
    screen_analysis: ScreenAnalysisResult | None = None
    constraint_check: ConstraintCheckResult | None = None
    geometry_calculation: GeometryCalculationResult | None = None
    animation_setup: AnimationSetupResult | None = None
    geometry_application: GeometryApplicationResult | None = None
    state_persistence: StatePersistenceResult | None = None
    error_message: str | None = None


@dataclass
class ManageGeometryResponse:
    """Response from geometry management."""
    result: ManageResult
    state: GeometryManagementState
    final_geometry: Geometry | None = None
    animation_controller: Any | None = None
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    execution_time: float = 0.0
    phase_times: dict[ManagePhase, float] = field(default_factory=dict)

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []
        if self.phase_times is None:
            self.phase_times = {}


class GeometryValidationServiceProtocol(Protocol):
    """Protocol for geometry validation service."""

    def validate_widget(self, widget: Any,
    ) -> tuple[bool, str | None]:
        """Validate widget for geometry management."""
        ...

    def validate_position_configuration(self, config: PositionConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate position configuration."""
        ...

    def validate_size_configuration(self, config: SizeConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate size configuration."""
        ...

    def validate_constraints(self, constraints: list[GeometryConstraint]) -> tuple[bool, list[str]]:
        """Validate geometry constraints."""
        ...


class ScreenAnalysisServiceProtocol(Protocol):
    """Protocol for screen analysis service."""

    def analyze_screens(self) -> ScreenAnalysisResult:
        """Analyze available screens."""
        ...

    def get_target_screen(self, widget: Any, screen_index: int | None = None) -> ScreenInfo:
        """Get target screen for widget."""
        ...

    def get_screen_at_position(self, position: Position,
    ) -> ScreenInfo | None:
        """Get screen at specific position."""
        ...


class ConstraintServiceProtocol(Protocol):
    """Protocol for constraint checking service."""

    def check_constraints(self,
    geometry: Geometry, constraints: list[GeometryConstraint], screen: ScreenInfo,
    ) -> ConstraintCheckResult:
        """Check geometry against constraints."""
        ...

    def adjust_for_constraints(self,
    geometry: Geometry, constraints: list[GeometryConstraint], screen: ScreenInfo,
    ) -> Geometry:
        """Adjust geometry to satisfy constraints."""
        ...


class GeometryCalculationServiceProtocol(Protocol):
    """Protocol for geometry calculation service."""

    def calculate_position(self, widget: Any, config: PositionConfiguration, screen: ScreenInfo,
    ) -> Position:
        """Calculate target position."""
        ...

    def calculate_size(self, widget: Any, config: SizeConfiguration, screen: ScreenInfo,
    ) -> Size:
        """Calculate target size."""
        ...

    def calculate_geometry(self,
    widget: Any, operation: GeometryOperation, position_config: PositionConfiguration | None, size_config: SizeConfiguration | None, screen: ScreenInfo,
    ) -> GeometryCalculationResult:
        """Calculate complete geometry."""
        ...


class AnimationServiceProtocol(Protocol):
    """Protocol for animation service."""

    def create_geometry_animation(self,
    widget: Any, target_geometry: Geometry, config: AnimationConfiguration,
    ) -> tuple[bool, Any, str | None]:
        """Create geometry animation."""
        ...

    def start_animation(self, animation: Any,
    ) -> tuple[bool, str | None]:
        """Start geometry animation."""
        ...

    def stop_animation(self, animation: Any,
    ) -> tuple[bool, str | None]:
        """Stop geometry animation."""
        ...


class GeometryApplicationServiceProtocol(Protocol):
    """Protocol for geometry application service."""

    def apply_geometry(self,
    widget: Any, geometry: Geometry, animated: bool = False,
    ) -> tuple[bool, Geometry, str | None]:
        """Apply geometry to widget."""
        ...

    def get_current_geometry(self, widget: Any,
    ) -> Geometry:
        """Get current widget geometry."""
        ...

    def set_position(self, widget: Any, position: Position,
    ) -> tuple[bool, str | None]:
        """Set widget position."""
        ...

    def set_size(self, widget: Any, size: Size,
    ) -> tuple[bool, str | None]:
        """Set widget size."""
        ...


class StatePersistenceServiceProtocol(Protocol):
    """Protocol for state persistence service."""

    def save_geometry_state(self,
    widget: Any, geometry: Geometry, config: PersistenceConfiguration,
    ) -> tuple[bool, str | None]:
        """Save geometry state."""
        ...

    def restore_geometry_state(self,
    widget: Any, config: PersistenceConfiguration,
    ) -> tuple[bool, Geometry | None, str | None]:
        """Restore geometry state."""
        ...

    def clear_geometry_state(self, widget: Any, config: PersistenceConfiguration,
    ) -> tuple[bool, str | None]:
        """Clear saved geometry state."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def start_progress(self, total_phases: int,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, phase: ManagePhase, progress: float,
    ) -> None:
        """Update progress for current phase."""
        ...

    def complete_progress(self) -> None:
        """Complete progress tracking."""
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging service."""

    def log_info(self, message: str, **kwargs) -> None:
        """Log info message."""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log warning message."""
        ...

    def log_error(self, message: str, **kwargs) -> None:
        """Log error message."""
        ...


class ManageGeometryUseCase:
    """Use case for managing window geometry."""

    def __init__(
        self,
        validation_service: GeometryValidationServiceProtocol,
        screen_analysis_service: ScreenAnalysisServiceProtocol,
        constraint_service: ConstraintServiceProtocol,
        geometry_calculation_service: GeometryCalculationServiceProtocol,
        animation_service: AnimationServiceProtocol | None = None,
        geometry_application_service: GeometryApplicationServiceProtocol | None = None,
        state_persistence_service: StatePersistenceServiceProtocol | None = None,
        progress_tracking_service: ProgressTrackingServiceProtocol | None = None,
        logger_service: LoggerServiceProtocol | None = None,
    ):
        self._validation_service = validation_service
        self._screen_analysis_service = screen_analysis_service
        self._constraint_service = constraint_service
        self._geometry_calculation_service = geometry_calculation_service
        self._animation_service = animation_service
        self._geometry_application_service = geometry_application_service
        self._state_persistence_service = state_persistence_service
        self._progress_tracking_service = progress_tracking_service
        self._logger_service = logger_service

    def execute(self, request: ManageGeometryRequest,
    ) -> ManageGeometryResponse:
        """Execute geometry management."""
        start_time = time.time()
        phase_times = {}

        state = GeometryManagementState(current_phase=ManagePhase.INITIALIZATION)
        warnings = []

        try:
            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.start_progress(len(ManagePhase))

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Starting geometry management",
                    operation=request.operation.value,
                    widget=str(request.target_widget),
                )

            # Phase 1: Validation
            phase_start = time.time()
            state.current_phase = ManagePhase.VALIDATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.VALIDATION, 0.0)

            # Validate widget
            widget_valid, widget_error = self._validation_service.validate_widget(request.target_widget)
            if not widget_valid:
                state.error_message = f"Invalid widget: {widget_error}"
                return ManageGeometryResponse(
                    result=ManageResult.VALIDATION_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            # Validate position configuration
            if request.position_config:
                position_valid, position_error = self._validation_service.validate_position_configuration(request.position_config)
                if not position_valid:
                    state.error_message = f"Invalid position configuration: {position_error}"
                    return ManageGeometryResponse(
                        result=ManageResult.VALIDATION_ERROR,
                        state=state,
                        error_message=state.error_message,
                        execution_time=time.time() - start_time,
                    )

            # Validate size configuration
            if request.size_config:
                size_valid, size_error = self._validation_service.validate_size_configuration(request.size_config)
                if not size_valid:
                    state.error_message = f"Invalid size configuration: {size_error}"
                    return ManageGeometryResponse(
                        result=ManageResult.VALIDATION_ERROR,
                        state=state,
                        error_message=state.error_message,
                        execution_time=time.time() - start_time,
                    )

            # Validate constraints
            constraints_valid, constraint_errors = self._validation_service.validate_constraints(request.constraints)
            if not constraints_valid:
                warnings.extend(constraint_errors)

            phase_times[ManagePhase.VALIDATION] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.VALIDATION, 1.0)

            # Phase 2: Screen Analysis
            phase_start = time.time()
            state.current_phase = ManagePhase.SCREEN_ANALYSIS

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.SCREEN_ANALYSIS, 0.0)

            screen_analysis = self._screen_analysis_service.analyze_screens()
            target_screen_index = request.position_config.screen_index if request.position_config else None
            target_screen = self._screen_analysis_service.get_target_screen(request.target_widget, target_screen_index)

            screen_analysis.target_screen = target_screen
            state.screen_analysis = screen_analysis

            phase_times[ManagePhase.SCREEN_ANALYSIS] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.SCREEN_ANALYSIS, 1.0)

            # Phase 3: Constraint Checking
            phase_start = time.time()
            state.current_phase = ManagePhase.CONSTRAINT_CHECKING

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.CONSTRAINT_CHECKING, 0.0)

            # Get current geometry for constraint checking
            if self._geometry_application_service is None:
                state.error_message = "Geometry application service is required but not provided"
                return ManageGeometryResponse(
                    result=ManageResult.FAILED,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )
            current_geometry = self._geometry_application_service.get_current_geometry(request.target_widget)

            # Check constraints against current geometry
            constraint_check = self._constraint_service.check_constraints(
                current_geometry, request.constraints, target_screen,
            )
            state.constraint_check = constraint_check

            if not constraint_check.all_constraints_satisfied:
                warnings.extend(constraint_check.constraint_messages)

            phase_times[ManagePhase.CONSTRAINT_CHECKING] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.CONSTRAINT_CHECKING, 1.0)

            # Phase 4: Geometry Calculation
            phase_start = time.time()
            state.current_phase = ManagePhase.GEOMETRY_CALCULATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.GEOMETRY_CALCULATION, 0.0)

            # Calculate target geometry
            geometry_calculation = self._geometry_calculation_service.calculate_geometry(
                request.target_widget,
                request.operation,
                request.position_config,
                request.size_config,
                target_screen,
            )

            # Adjust for constraints
            if request.constraints:
                adjusted_geometry = self._constraint_service.adjust_for_constraints(
                    geometry_calculation.calculated_geometry,
                    request.constraints,
                    target_screen,
                )
                if adjusted_geometry != geometry_calculation.calculated_geometry:
                    geometry_calculation.adjustments_made.append("Adjusted for constraints")
                    geometry_calculation.calculated_geometry = adjusted_geometry

            state.geometry_calculation = geometry_calculation

            phase_times[ManagePhase.GEOMETRY_CALCULATION] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.GEOMETRY_CALCULATION, 1.0)

            # Phase 5: Animation Setup
            phase_start = time.time()
            state.current_phase = ManagePhase.ANIMATION_SETUP

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.ANIMATION_SETUP, 0.0)

            animation_setup = AnimationSetupResult(
                animation_created=False,
                animation_configured=False,
                animation_ready=False,
            )

            if request.animation_config and request.animation_config.animation_type != AnimationType.NONE and self._animation_service:
                animation_created, animation_object, animation_error = self._animation_service.create_geometry_animation(
                    request.target_widget,
                    geometry_calculation.calculated_geometry,
                    request.animation_config,
                )

                animation_setup.animation_created = animation_created
                animation_setup.animation_object = animation_object
                animation_setup.error_message = animation_error

                if animation_created:
                    animation_setup.animation_configured = True
                    animation_setup.animation_ready = True
                else:
                    warnings.append(f"Failed to create animation: {animation_error}")

            state.animation_setup = animation_setup

            phase_times[ManagePhase.ANIMATION_SETUP] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.ANIMATION_SETUP, 1.0)

            # Phase 6: Geometry Application
            phase_start = time.time()
            state.current_phase = ManagePhase.GEOMETRY_APPLICATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.GEOMETRY_APPLICATION, 0.0)

            application_start = time.time()

            # Apply geometry
            use_animation = bool(
                animation_setup.animation_ready and 
                request.animation_config and 
                request.animation_config.auto_start,
            )

            if use_animation and self._animation_service:
                # Start animation
                animation_started, animation_error = self._animation_service.start_animation(animation_setup.animation_object)
                if not animation_started:
                    warnings.append(f"Failed to start animation: {animation_error}")
                    use_animation = False

            if not use_animation:
                # Apply geometry directly
                if self._geometry_application_service is None:
                    state.error_message = "Geometry application service is required but not provided"
                    return ManageGeometryResponse(
                        result=ManageResult.FAILED,
                        state=state,
                        error_message=state.error_message,
                        warnings=warnings,
                        execution_time=time.time() - start_time,
                        phase_times=phase_times,
                    )
                geometry_applied, final_geometry, application_error = self._geometry_application_service.apply_geometry(
                    request.target_widget,
                    geometry_calculation.calculated_geometry,
                    animated=False,
                )
            else:
                # Animation will handle geometry application
                geometry_applied = True
                final_geometry = geometry_calculation.calculated_geometry
                application_error = None

            geometry_application = GeometryApplicationResult(
                geometry_applied=geometry_applied,
                animation_started=bool(use_animation),
                final_geometry=final_geometry,
                application_time=time.time() - application_start,
                error_message=application_error,
            )

            state.geometry_application = geometry_application

            if not geometry_applied:
                state.error_message = f"Failed to apply geometry: {application_error}"
                return ManageGeometryResponse(
                    result=ManageResult.FAILED,
                    state=state,
                    error_message=state.error_message,
                    warnings=warnings,
                    execution_time=time.time() - start_time,
                    phase_times=phase_times,
                )

            phase_times[ManagePhase.GEOMETRY_APPLICATION] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.GEOMETRY_APPLICATION, 1.0)

            # Phase 7: State Persistence
            phase_start = time.time()
            state.current_phase = ManagePhase.STATE_PERSISTENCE

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.STATE_PERSISTENCE, 0.0)

            state_persistence = StatePersistenceResult(
                state_saved=False,
                position_saved=False,
                size_saved=False,
                state_restored=False,
            )

            if request.persistence_config and request.persistence_config.auto_save and self._state_persistence_service:
                state_saved, persistence_error = self._state_persistence_service.save_geometry_state(
                    request.target_widget,
                    final_geometry,
                    request.persistence_config,
                )

                state_persistence.state_saved = state_saved
                state_persistence.position_saved = state_saved and request.persistence_config.save_position
                state_persistence.size_saved = state_saved and request.persistence_config.save_size
                state_persistence.error_message = persistence_error

                if not state_saved:
                    warnings.append(f"Failed to save geometry state: {persistence_error}")

            state.state_persistence = state_persistence

            phase_times[ManagePhase.STATE_PERSISTENCE] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.STATE_PERSISTENCE, 1.0)

            # Phase 8: Finalization
            phase_start = time.time()
            state.current_phase = ManagePhase.FINALIZATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(ManagePhase.FINALIZATION, 0.0)
                self._progress_tracking_service.complete_progress()

            phase_times[ManagePhase.FINALIZATION] = time.time() - phase_start

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Geometry management completed",
                    operation=request.operation.value,
                    final_geometry=f"{final_geometry.x},{final_geometry.y} {final_geometry.width}x{final_geometry.height}",
                    animated=use_animation,
                    warnings_count=len(warnings),
                    execution_time=time.time() - start_time,
                )

            # Determine result
            result = ManageResult.PARTIAL_SUCCESS if warnings else ManageResult.SUCCESS

            return ManageGeometryResponse(
                result=result,
                state=state,
                final_geometry=final_geometry,
                animation_controller=animation_setup.animation_object if animation_setup.animation_ready else None,
                warnings=warnings,
                execution_time=time.time() - start_time,
                phase_times=phase_times,
            )

        except Exception as e:
            error_message = f"Unexpected error during geometry management: {e!s}"
            state.error_message = error_message

            if request.enable_logging and self._logger_service:
                self._logger_service.log_error(
                    "Geometry management failed",
                    error=str(e),
                    phase=state.current_phase.value,
                    execution_time=time.time() - start_time,
                )

            return ManageGeometryResponse(
                result=ManageResult.FAILED,
                state=state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
                phase_times=phase_times,
            )