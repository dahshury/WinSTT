"""Reparent Progress Bar Use Case

This module implements the ReparentProgressBarUseCase for safely reparenting
progress bars between widgets with proper error handling and state management.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any, Protocol

from src.domain.window_management.value_objects import ReparentDirection


class ReparentResult(Enum):
    """Enumeration of possible reparenting results."""
    SUCCESS = "success"
    PROGRESS_BAR_NOT_FOUND = "progress_bar_not_found"
    TARGET_WIDGET_INVALID = "target_widget_invalid"
    SOURCE_WIDGET_INVALID = "source_widget_invalid"
    REPARENTING_FAILED = "reparenting_failed"
    LAYOUT_ERROR = "layout_error"
    GEOMETRY_ERROR = "geometry_error"
    VALIDATION_ERROR = "validation_error"
    RUNTIME_ERROR = "runtime_error"
    INTERNAL_ERROR = "internal_error"


class ReparentPhase(Enum):
    """Enumeration of reparenting phases."""
    INITIALIZATION = "initialization"
    WIDGET_VALIDATION = "widget_validation"
    STATE_BACKUP = "state_backup"
    LAYOUT_REMOVAL = "layout_removal"
    PARENT_CHANGE = "parent_change"
    LAYOUT_INSERTION = "layout_insertion"
    GEOMETRY_ADJUSTMENT = "geometry_adjustment"
    VALIDATION = "validation"
    COMPLETION = "completion"





class LayoutStrategy(Enum):
    """Enumeration of layout strategies."""
    PRESERVE_POSITION = "preserve_position"
    APPEND_TO_LAYOUT = "append_to_layout"
    INSERT_AT_INDEX = "insert_at_index"
    REPLACE_WIDGET = "replace_widget"
    CUSTOM_PLACEMENT = "custom_placement"


@dataclass
class ReparentConfiguration:
    """Configuration for progress bar reparenting."""
    layout_strategy: LayoutStrategy = LayoutStrategy.APPEND_TO_LAYOUT
    preserve_geometry: bool = True
    preserve_visibility: bool = True
    preserve_properties: bool = True
    backup_original_state: bool = True
    validate_after_reparent: bool = True
    handle_runtime_errors: bool = True
    force_layout_update: bool = True
    insertion_index: int | None = None


@dataclass
class ProgressBarState:
    """State information for progress bar."""
    widget: Any  # QProgressBar
    parent: Any | None = None
    geometry: Any | None = None  # QRect
    visibility: bool = False
    layout: Any | None = None
    layout_index: int = -1
    properties: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if self.properties is None:
            self.properties = {}


@dataclass
class ReparentProgressBarRequest:
    """Request for reparenting progress bar."""
    progress_bar: Any  # QProgressBar
    target_widget: Any  # QWidget
    source_widget: Any | None = None  # QWidget
    direction: ReparentDirection = ReparentDirection.TO_TARGET
    configuration: ReparentConfiguration = field(default_factory=ReparentConfiguration)
    context_data: dict[str, Any] | None = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()
        if self.configuration is None:
            self.configuration = ReparentConfiguration()
        if self.context_data is None:
            self.context_data = {}


@dataclass
class ReparentOperation:
    """Information about reparenting operation."""
    direction: ReparentDirection
    source_state: ProgressBarState
    target_state: ProgressBarState
    layout_changed: bool
    geometry_changed: bool
    visibility_changed: bool
    properties_preserved: bool
    operation_successful: bool

    def __post_init__(self):
        self.layout_changed = self.source_state.layout != self.target_state.layout
        self.geometry_changed = self.source_state.geometry != self.target_state.geometry
        self.visibility_changed = self.source_state.visibility != self.target_state.visibility


@dataclass
class ReparentProgressBarResponse:
    """Response from progress bar reparenting operation."""
    result: ReparentResult
    operation: ReparentOperation | None
    current_phase: ReparentPhase
    progress_percentage: float
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    execution_time_ms: float = 0.0
    runtime_error_handled: bool = False

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class WidgetValidationServiceProtocol(Protocol,
    ):
    """Protocol for widget validation operations."""

    def validate_progress_bar(self, progress_bar: Any,
    ) -> list[str]:
        """Validate progress bar widget."""
        ...

    def validate_target_widget(self, widget: Any,
    ) -> list[str]:
        """Validate target widget for reparenting."""
        ...

    def validate_widget_hierarchy(self, child: Any, parent: Any,
    ) -> bool:
        """Validate widget hierarchy is valid."""
        ...

    def is_widget_deleted(self, widget: Any,
    ) -> bool:
        """Check if widget has been deleted."""
        ...


class StateBackupServiceProtocol(Protocol):
    """Protocol for state backup operations."""

    def backup_progress_bar_state(self, progress_bar: Any,
    ) -> ProgressBarState:
        """Backup current progress bar state."""
        ...

    def backup_widget_properties(self, widget: Any,
    ) -> dict[str, Any]:
        """Backup widget properties."""
        ...

    def restore_progress_bar_state(self, progress_bar: Any, state: ProgressBarState,
    ) -> bool:
        """Restore progress bar state."""
        ...


class LayoutManagementServiceProtocol(Protocol):
    """Protocol for layout management operations."""

    def remove_widget_from_layout(self, widget: Any,
    ) -> tuple[Any | None, int]:
        """Remove widget from its current layout, return (layout, index)."""
        ...

    def add_widget_to_layout(self,
    widget: Any, target_widget: Any, strategy: LayoutStrategy, index: int | None = None) -> bool:
        """Add widget to target layout using specified strategy."""
        ...

    def get_widget_layout(self, widget: Any,
    ) -> Any | None:
        """Get layout containing the widget."""
        ...

    def validate_layout_integrity(self, layout: Any,
    ) -> bool:
        """Validate layout integrity."""
        ...


class GeometryManagementServiceProtocol(Protocol):
    """Protocol for geometry management operations."""

    def preserve_widget_geometry(self, widget: Any, target_parent: Any,
    ) -> bool:
        """Preserve widget geometry when changing parent."""
        ...

    def adjust_widget_geometry(self, widget: Any, target_parent: Any,
    ) -> bool:
        """Adjust widget geometry for new parent."""
        ...

    def get_widget_geometry(self, widget: Any,
    ) -> Any | None:
        """Get widget geometry."""
        ...


class ReparentingServiceProtocol(Protocol):
    """Protocol for core reparenting operations."""

    def change_widget_parent(self, widget: Any, new_parent: Any,
    ) -> bool:
        """Change widget parent safely."""
        ...

    def handle_runtime_error(self, widget: Any, error: Exception,
    ) -> bool:
        """Handle runtime errors during reparenting."""
        ...

    def force_widget_update(self, widget: Any,
    ) -> bool:
        """Force widget to update after reparenting."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress_session(self, session_id: str, total_phases: int,
    ) -> None:
        """Start a new progress tracking session."""
        ...

    def update_progress(self, session_id: str, phase: ReparentPhase, percentage: float,
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


class ReparentProgressBarUseCase:
    """Use case for safely reparenting progress bars between widgets."""

    def __init__(
        self,
        widget_validation_service: WidgetValidationServiceProtocol,
        state_backup_service: StateBackupServiceProtocol,
        layout_service: LayoutManagementServiceProtocol,
        geometry_service: GeometryManagementServiceProtocol,
        reparenting_service: ReparentingServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.widget_validation_service = widget_validation_service
        self.state_backup_service = state_backup_service
        self.layout_service = layout_service
        self.geometry_service = geometry_service
        self.reparenting_service = reparenting_service
        self.progress_service = progress_service
        self.logger_service = logger_service

    def execute(self, request: ReparentProgressBarRequest,
    ) -> ReparentProgressBarResponse:
        """Execute the progress bar reparenting operation."""
        start_time = datetime.now(UTC)
        session_id = f"reparent_progress_bar_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 9)
            self.progress_service.update_progress(session_id, ReparentPhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting progress bar reparenting",
                {
                    "progress_bar": str(type(request.progress_bar).__name__),
                    "target_widget": str(type(request.target_widget).__name__),
                    "direction": request.direction.value,
                    "layout_strategy": request.configuration.layout_strategy.value,
                },
            )

            # Phase 2: Widget Validation
            self.progress_service.update_progress(session_id, ReparentPhase.WIDGET_VALIDATION, 11.1)

            # Validate progress bar
            progress_bar_errors = self.widget_validation_service.validate_progress_bar(request.progress_bar)
            if progress_bar_errors:
                return self._create_error_response(
                    ReparentResult.PROGRESS_BAR_NOT_FOUND,
                    ReparentPhase.WIDGET_VALIDATION,
                    11.1,
                    f"Progress bar validation failed: {'; '.join(progress_bar_errors)}",
                    start_time,
                )

            # Check if progress bar has been deleted (common Qt issue)
            if self.widget_validation_service.is_widget_deleted(request.progress_bar):
                return self._create_error_response(
                    ReparentResult.RUNTIME_ERROR,
                    ReparentPhase.WIDGET_VALIDATION,
                    11.1,
                    "Progress bar has been deleted",
                    start_time,
                )

            # Validate target widget
            target_errors = self.widget_validation_service.validate_target_widget(request.target_widget)
            if target_errors:
                return self._create_error_response(
                    ReparentResult.TARGET_WIDGET_INVALID,
                    ReparentPhase.WIDGET_VALIDATION,
                    11.1,
                    f"Target widget validation failed: {'; '.join(target_errors)}",
                    start_time,
                )

            # Validate source widget if provided
            if request.source_widget:
                source_errors = self.widget_validation_service.validate_target_widget(request.source_widget)
                if source_errors:
                    return self._create_error_response(
                        ReparentResult.SOURCE_WIDGET_INVALID,
                        ReparentPhase.WIDGET_VALIDATION,
                        11.1,
                        f"Source widget validation failed: {'; '.join(source_errors)}",
                        start_time,
                    )

            # Validate widget hierarchy
            if not self.widget_validation_service.validate_widget_hierarchy(
                request.progress_bar,
                request.target_widget,
            ):
                return self._create_error_response(
                    ReparentResult.VALIDATION_ERROR,
                    ReparentPhase.WIDGET_VALIDATION,
                    11.1,
                    "Invalid widget hierarchy for reparenting",
                    start_time,
                )

            # Phase 3: State Backup
            self.progress_service.update_progress(session_id, ReparentPhase.STATE_BACKUP, 22.2)

            source_state = None
            try:
                if request.configuration.backup_original_state:
                    source_state = self.state_backup_service.backup_progress_bar_state(request.progress_bar)

                    # Backup additional properties if configured
                    if request.configuration.preserve_properties:
                        source_state.properties = self.state_backup_service.backup_widget_properties(
                            request.progress_bar,
                        )

            except Exception as e:
                self.logger_service.log_warning(
                    f"State backup warning: {e!s}",
                    {"progress_bar": str(type(request.progress_bar).__name__)},
                )
                source_state = ProgressBarState(widget=request.progress_bar)

            # Phase 4: Layout Removal
            self.progress_service.update_progress(session_id, ReparentPhase.LAYOUT_REMOVAL, 33.3)

            original_layout = None
            original_index = -1

            try:
                # Remove from current layout
                original_layout, original_index = self.layout_service.remove_widget_from_layout(
                    request.progress_bar,
                )

                if source_state:
                    source_state.layout = original_layout
                    source_state.layout_index = original_index

            except Exception as e:
                if request.configuration.handle_runtime_errors:
                    self.logger_service.log_warning(
                        f"Layout removal warning: {e!s}",
                        {"progress_bar": str(type(request.progress_bar).__name__)},
                    )
                else:
                    return self._create_error_response(
                        ReparentResult.LAYOUT_ERROR,
                        ReparentPhase.LAYOUT_REMOVAL,
                        33.3,
                        f"Failed to remove widget from layout: {e!s}",
                        start_time,
                    )

            # Phase 5: Parent Change
            self.progress_service.update_progress(session_id, ReparentPhase.PARENT_CHANGE, 44.4)

            runtime_error_handled = False
            try:
                # Change parent
                if not self.reparenting_service.change_widget_parent(
                    request.progress_bar,
                    request.target_widget,
                ):
                    return self._create_error_response(
                        ReparentResult.REPARENTING_FAILED,
                        ReparentPhase.PARENT_CHANGE,
                        44.4,
                        "Failed to change widget parent",
                        start_time,
                    )

            except RuntimeError as e:
                if request.configuration.handle_runtime_errors:
                    if self.reparenting_service.handle_runtime_error(request.progress_bar, e):
                        runtime_error_handled = True
                        self.logger_service.log_info(
                            "Runtime error handled during reparenting",
                            {"error": str(e)},
                        )
                    else:
                        return self._create_error_response(
                            ReparentResult.RUNTIME_ERROR,
                            ReparentPhase.PARENT_CHANGE,
                            44.4,
                            f"Runtime error during reparenting: {e!s}",
                            start_time,
                        )
                else:
                    return self._create_error_response(
                        ReparentResult.RUNTIME_ERROR,
                        ReparentPhase.PARENT_CHANGE,
                        44.4,
                        f"Runtime error during reparenting: {e!s}",
                        start_time,
                    )
            except Exception as e:
                return self._create_error_response(
                    ReparentResult.REPARENTING_FAILED,
                    ReparentPhase.PARENT_CHANGE,
                    44.4,
                    f"Unexpected error during reparenting: {e!s}",
                    start_time,
                )

            # Phase 6: Layout Insertion
            self.progress_service.update_progress(session_id, ReparentPhase.LAYOUT_INSERTION, 55.5)

            try:
                # Add to target layout
                if not self.layout_service.add_widget_to_layout(
                    request.progress_bar,
                    request.target_widget,
                    request.configuration.layout_strategy,
                    request.configuration.insertion_index,
                ):
                    self.logger_service.log_warning(
                        "Failed to add widget to target layout",
                        {"target_widget": str(type(request.target_widget).__name__)},
                    )

            except Exception as e:
                self.logger_service.log_warning(
                    f"Layout insertion warning: {e!s}",
                    {"target_widget": str(type(request.target_widget).__name__)},
                )

            # Phase 7: Geometry Adjustment
            self.progress_service.update_progress(session_id, ReparentPhase.GEOMETRY_ADJUSTMENT, 66.6)

            try:
                if request.configuration.preserve_geometry:
                    if not self.geometry_service.preserve_widget_geometry(
                        request.progress_bar,
                        request.target_widget,
                    ):
                        self.logger_service.log_warning(
                            "Failed to preserve widget geometry",
                            {"progress_bar": str(type(request.progress_bar).__name__)},
                        )
                elif not self.geometry_service.adjust_widget_geometry(
                    request.progress_bar,
                    request.target_widget,
                ):
                    self.logger_service.log_warning(
                        "Failed to adjust widget geometry",
                        {"progress_bar": str(type(request.progress_bar).__name__)},
                    )

            except Exception as e:
                self.logger_service.log_warning(
                    f"Geometry adjustment warning: {e!s}",
                    {"progress_bar": str(type(request.progress_bar).__name__)},
                )

            # Phase 8: Validation
            self.progress_service.update_progress(session_id, ReparentPhase.VALIDATION, 77.7)

            target_state = None
            try:
                if request.configuration.validate_after_reparent:
                    # Backup new state for comparison
                    target_state = self.state_backup_service.backup_progress_bar_state(request.progress_bar)

                    # Validate new layout
                    new_layout = self.layout_service.get_widget_layout(request.progress_bar)
                    if new_layout and not self.layout_service.validate_layout_integrity(new_layout):
                        self.logger_service.log_warning(
                            "Layout integrity validation failed after reparenting",
                            {"progress_bar": str(type(request.progress_bar).__name__)},
                        )

            except Exception as e:
                self.logger_service.log_warning(
                    f"Post-reparent validation warning: {e!s}",
                    {"progress_bar": str(type(request.progress_bar).__name__)},
                )
                target_state = ProgressBarState(widget=request.progress_bar)

            # Phase 9: Completion
            self.progress_service.update_progress(session_id, ReparentPhase.COMPLETION, 88.8)

            # Force widget update if configured
            if request.configuration.force_layout_update:
                try:
                    self.reparenting_service.force_widget_update(request.progress_bar)
                    self.reparenting_service.force_widget_update(request.target_widget)
                except Exception as e:
                    self.logger_service.log_warning(
                        f"Force update warning: {e!s}",
                        {"progress_bar": str(type(request.progress_bar).__name__)},
                    )

            # Create operation summary
            if not target_state:
                target_state = ProgressBarState(widget=request.progress_bar)
            if not source_state:
                source_state = ProgressBarState(widget=request.progress_bar)

            operation = ReparentOperation(
                direction=request.direction,
                source_state=source_state,
                target_state=target_state,
                layout_changed=True,  # Will be calculated in __post_init__
                geometry_changed=True,  # Will be calculated in __post_init__
                visibility_changed=True,  # Will be calculated in __post_init__
                properties_preserved=request.configuration.preserve_properties,
                operation_successful=True,
            )

            self.progress_service.update_progress(session_id, ReparentPhase.COMPLETION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

            self.logger_service.log_info(
                "Progress bar reparenting completed successfully",
                {
                    "progress_bar": str(type(request.progress_bar).__name__),
                    "target_widget": str(type(request.target_widget).__name__),
                    "execution_time_ms": execution_time,
                    "runtime_error_handled": runtime_error_handled,
                },
            )

            return ReparentProgressBarResponse(
                result=ReparentResult.SUCCESS,
                operation=operation,
                current_phase=ReparentPhase.COMPLETION,
                progress_percentage=100.0,
                execution_time_ms=execution_time,
                runtime_error_handled=runtime_error_handled,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during progress bar reparenting",
                {
                    "progress_bar": str(type(request.progress_bar).__name__),
                    "error": str(e),
                },
            )

            return self._create_error_response(
                ReparentResult.INTERNAL_ERROR,
                ReparentPhase.INITIALIZATION,
                0.0,
                f"Unexpected error: {e!s}",
                start_time,
            )

    def _create_error_response(
        self,
        result: ReparentResult,
        phase: ReparentPhase,
        progress: float,
        error_message: str,
        start_time: datetime,
    ) -> ReparentProgressBarResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

        return ReparentProgressBarResponse(
            result=result,
            operation=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )