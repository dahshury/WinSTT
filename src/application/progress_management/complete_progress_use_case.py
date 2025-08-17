"""Complete Progress Use Case

This module implements the CompleteProgressUseCase for completing progress sessions
and restoring original UI state and progress bar configuration.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol

from src.domain.file_operations.value_objects import CleanupLevel
from src.domain.window_management.value_objects import RestorationMode

if TYPE_CHECKING:
    from src.domain.common.ports.time_port import ITimePort


class CompleteResult(Enum):
    """Enumeration of possible completion results."""
    SUCCESS = "success"
    SESSION_NOT_FOUND = "session_not_found"
    SESSION_ALREADY_COMPLETED = "session_already_completed"
    UI_RESTORATION_ERROR = "ui_restoration_error"
    PROGRESS_BAR_RESTORATION_ERROR = "progress_bar_restoration_error"
    CLEANUP_ERROR = "cleanup_error"
    VALIDATION_ERROR = "validation_error"
    INTERNAL_ERROR = "internal_error"


class CompletePhase(Enum):
    """Enumeration of completion phases."""
    INITIALIZATION = "initialization"
    SESSION_VALIDATION = "session_validation"
    PROGRESS_BAR_RESTORATION = "progress_bar_restoration"
    UI_STATE_RESTORATION = "ui_state_restoration"
    LAYOUT_RESTORATION = "layout_restoration"
    CLEANUP = "cleanup"
    FINALIZATION = "finalization"





@dataclass
class CompletionConfiguration:
    """Configuration for progress completion."""
    restoration_mode: RestorationMode = RestorationMode.FULL_RESTORATION
    cleanup_level: CleanupLevel = CleanupLevel.THOROUGH
    restore_ui_state: bool = True
    restore_progress_bar: bool = True
    collapse_progress_area: bool = True
    hide_progress_bar: bool = True
    force_ui_update: bool = True
    validate_restoration: bool = True
    delay_before_cleanup_ms: int = 100


@dataclass
class CompleteProgressRequest:
    """Request for completing progress session."""
    session_id: str
    configuration: CompletionConfiguration = field(default_factory=CompletionConfiguration)
    force_completion: bool = False
    context_data: dict[str, Any] | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)

    def __post_init__(self):
        if self.context_data is None:
            self.context_data = {}


@dataclass
class RestorationState:
    """State of restoration operations."""
    ui_state_restored: bool
    progress_bar_restored: bool
    layout_restored: bool
    progress_area_collapsed: bool
    cleanup_completed: bool
    restoration_errors: list[str]
    restoration_warnings: list[str]

    def __post_init__(self):
        if self.restoration_errors is None:
            self.restoration_errors = []
        if self.restoration_warnings is None:
            self.restoration_warnings = []


@dataclass
class SessionCompletionSummary:
    """Summary of completed session."""
    session_id: str
    start_time: datetime
    end_time: datetime
    duration_ms: float
    total_updates: int
    final_progress_value: float
    ui_elements_restored: int
    progress_bar_reparented: bool
    completion_successful: bool

    def __post_init__(self):
        self.duration_ms = (self.end_time - self.start_time).total_seconds() * 1000


@dataclass
class CompleteProgressResponse:
    """Response from progress completion operation."""
    result: CompleteResult
    restoration_state: RestorationState | None
    session_summary: SessionCompletionSummary | None
    current_phase: CompletePhase
    progress_percentage: float
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    execution_time_ms: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class SessionLookupServiceProtocol(Protocol,
    ):
    """Protocol for session lookup operations."""

    def get_session(self, session_id: str,
    ) -> Any | None:
        """Get session by ID."""
        ...

    def is_session_active(self, session_id: str,
    ) -> bool:
        """Check if session is active."""
        ...

    def mark_session_completed(self, session_id: str,
    ) -> bool:
        """Mark session as completed."""
        ...

    def remove_session(self, session_id: str,
    ) -> bool:
        """Remove session from active sessions."""
        ...


class ProgressBarRestorationServiceProtocol(Protocol):
    """Protocol for progress bar restoration operations."""

    def restore_progress_bar_parent(self, progress_bar: Any, original_parent: Any,
    ) -> bool:
        """Restore progress bar to original parent."""
        ...

    def restore_progress_bar_geometry(self, progress_bar: Any, original_geometry: Any,
    ) -> bool:
        """Restore progress bar geometry."""
        ...

    def hide_progress_bar(self, progress_bar: Any,
    ) -> bool:
        """Hide progress bar."""
        ...

    def reset_progress_bar_value(self, progress_bar: Any,
    ) -> bool:
        """Reset progress bar to initial value."""
        ...


class UIStateRestorationServiceProtocol(Protocol):
    """Protocol for UI state restoration operations."""

    def restore_ui_elements(
    self,
    parent_window: Any,
    original_state: dict[str,
    Any]) -> dict[str, bool]:
        """Restore UI elements to original state."""
        ...

    def collapse_progress_area(self, target_widget: Any,
    ) -> bool:
        """Collapse progress area to original size."""
        ...

    def force_ui_refresh(self, parent_window: Any,
    ) -> bool:
        """Force UI to refresh and update."""
        ...


class LayoutRestorationServiceProtocol(Protocol):
    """Protocol for layout restoration operations."""

    def restore_widget_layout(self, widget: Any, original_layout_info: dict[str, Any]) -> bool:
        """Restore widget layout configuration."""
        ...

    def remove_widget_from_layout(self, widget: Any, layout: Any,
    ) -> bool:
        """Remove widget from layout safely."""
        ...

    def validate_layout_integrity(self, parent_widget: Any,
    ) -> bool:
        """Validate layout integrity after restoration."""
        ...


class CleanupServiceProtocol(Protocol):
    """Protocol for cleanup operations."""

    def cleanup_session_resources(self, session_id: str, cleanup_level: CleanupLevel,
    ) -> bool:
        """Cleanup session resources."""
        ...

    def cleanup_temporary_widgets(self, session_id: str,
    ) -> int:
        """Cleanup temporary widgets created during session."""
        ...

    def cleanup_event_connections(self, session_id: str,
    ) -> int:
        """Cleanup event connections for session."""
        ...


class ValidationServiceProtocol(Protocol):
    """Protocol for validation operations."""

    def validate_session_completion(self, session_id: str,
    ) -> list[str]:
        """Validate session can be completed."""
        ...

    def validate_restoration_state(self, restoration_state: RestorationState,
    ) -> list[str]:
        """Validate restoration was successful."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress_session(self, session_id: str, total_phases: int,
    ) -> None:
        """Start a new progress tracking session."""
        ...

    def update_progress(self, session_id: str, phase: CompletePhase, percentage: float,
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


class CompleteProgressUseCase:
    """Use case for completing progress sessions and restoring UI state."""

    def __init__(
        self,
        session_lookup_service: SessionLookupServiceProtocol,
        progress_bar_restoration_service: ProgressBarRestorationServiceProtocol,
        ui_restoration_service: UIStateRestorationServiceProtocol,
        layout_restoration_service: LayoutRestorationServiceProtocol,
        cleanup_service: CleanupServiceProtocol,
        validation_service: ValidationServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.session_lookup_service = session_lookup_service
        self.progress_bar_restoration_service = progress_bar_restoration_service
        self.ui_restoration_service = ui_restoration_service
        self.layout_restoration_service = layout_restoration_service
        self.cleanup_service = cleanup_service
        self.validation_service = validation_service
        self.progress_service = progress_service
        self.logger_service = logger_service

    def execute(self, request: CompleteProgressRequest,
    ) -> CompleteProgressResponse:
        """Execute the progress completion operation."""
        start_time = datetime.now(UTC)
        session_id = f"complete_progress_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 7)
            self.progress_service.update_progress(session_id, CompletePhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting progress completion",
                {
                    "session_id": request.session_id,
                    "force_completion": request.force_completion,
                    "restoration_mode": request.configuration.restoration_mode.value,
                },
            )

            # Phase 2: Session Validation
            self.progress_service.update_progress(session_id, CompletePhase.SESSION_VALIDATION, 14.3)

            # Get session
            session = self.session_lookup_service.get_session(request.session_id)
            if not session:
                return self._create_error_response(
                    CompleteResult.SESSION_NOT_FOUND,
                    CompletePhase.SESSION_VALIDATION,
                    14.3,
                    f"Session {request.session_id} not found",
                    start_time,
                )

            # Check if session is already completed (unless forced)
            if not request.force_completion and not self.session_lookup_service.is_session_active(request.session_id):
                return self._create_error_response(
                    CompleteResult.SESSION_ALREADY_COMPLETED,
                    CompletePhase.SESSION_VALIDATION,
                    14.3,
                    f"Session {request.session_id} is already completed",
                    start_time,
                )

            # Validate session can be completed
            if request.configuration.validate_restoration:
                validation_errors = self.validation_service.validate_session_completion(request.session_id)
                if validation_errors:
                    return self._create_error_response(
                        CompleteResult.VALIDATION_ERROR,
                        CompletePhase.SESSION_VALIDATION,
                        14.3,
                        f"Session completion validation failed: {'; '.join(validation_errors)}",
                        start_time,
                    )

            # Initialize restoration state
            restoration_state = RestorationState(
                ui_state_restored=False,
                progress_bar_restored=False,
                layout_restored=False,
                progress_area_collapsed=False,
                cleanup_completed=False,
                restoration_errors=[],
                restoration_warnings=[],
            )

            # Phase 3: Progress Bar Restoration
            self.progress_service.update_progress(session_id, CompletePhase.PROGRESS_BAR_RESTORATION, 28.6)

            if request.configuration.restore_progress_bar and hasattr(session, "progress_bar_info"):
                try:
                    progress_bar_info = session.progress_bar_info
                    if progress_bar_info and progress_bar_info.widget:
                        progress_bar = progress_bar_info.widget

                        # Hide progress bar if configured
                        if request.configuration.hide_progress_bar:
                            if not self.progress_bar_restoration_service.hide_progress_bar(progress_bar):
                                restoration_state.restoration_warnings.append("Failed to hide progress bar")

                        # Reset progress bar value
                        if not self.progress_bar_restoration_service.reset_progress_bar_value(progress_bar):
                            restoration_state.restoration_warnings.append("Failed to reset progress bar value")

                        # Restore original parent if it was reparented
                        if progress_bar_info.original_parent:
                            if self.progress_bar_restoration_service.restore_progress_bar_parent(
                                progress_bar,
                                progress_bar_info.original_parent,
                            ):
                                restoration_state.progress_bar_restored = True
                            else:
                                restoration_state.restoration_errors.append("Failed to restore progress bar parent")

                        # Restore original geometry if available
                        if progress_bar_info.original_geometry:
                            if not self.progress_bar_restoration_service.restore_progress_bar_geometry(
                                progress_bar,
                                progress_bar_info.original_geometry,
                            ):
                                restoration_state.restoration_warnings.append("Failed to restore progress bar geometry")

                except Exception as e:
                    error_msg = f"Progress bar restoration failed: {e!s}"
                    restoration_state.restoration_errors.append(error_msg)
                    self.logger_service.log_error(error_msg, {"session_id": request.session_id})

            # Phase 4: UI State Restoration
            self.progress_service.update_progress(session_id, CompletePhase.UI_STATE_RESTORATION, 42.9)

            if request.configuration.restore_ui_state and hasattr(session, "original_ui_state"):
                try:
                    parent_window = getattr(session, "parent_window", None)
                    if parent_window and session.original_ui_state:
                        restoration_results = self.ui_restoration_service.restore_ui_elements(
                            parent_window,
                            session.original_ui_state,
                        )

                        # Count successful restorations
                        successful_restorations = sum(1 for success in restoration_results.values() if success)
                        total_restorations = len(restoration_results)

                        if successful_restorations == total_restorations:
                            restoration_state.ui_state_restored = True
                        elif successful_restorations > 0:
                            restoration_state.ui_state_restored = True
                            restoration_state.restoration_warnings.append(
                                f"Partial UI restoration: {successful_restorations}/{total_restorations} elements restored",
                            )
                        else:
                            restoration_state.restoration_errors.append("Failed to restore any UI elements")

                except Exception as e:
                    error_msg = f"UI state restoration failed: {e!s}"
                    restoration_state.restoration_errors.append(error_msg)
                    self.logger_service.log_error(error_msg, {"session_id": request.session_id})

            # Phase 5: Layout Restoration
            self.progress_service.update_progress(session_id, CompletePhase.LAYOUT_RESTORATION, 57.2)

            try:
                # Collapse progress area if it was expanded
                if (request.configuration.collapse_progress_area and
                    hasattr(session, "progress_area_expanded") and
                    session.progress_area_expanded):

                    target_widget = getattr(session, "target_widget", None)
                    if target_widget:
                        if self.ui_restoration_service.collapse_progress_area(target_widget):
                            restoration_state.progress_area_collapsed = True
                        else:
                            restoration_state.restoration_warnings.append("Failed to collapse progress area")

                # Validate layout integrity
                parent_window = getattr(session, "parent_window", None)
                if parent_window:
                    if self.layout_restoration_service.validate_layout_integrity(parent_window):
                        restoration_state.layout_restored = True
                    else:
                        restoration_state.restoration_warnings.append("Layout integrity validation failed")

            except Exception as e:
                error_msg = f"Layout restoration failed: {e!s}"
                restoration_state.restoration_warnings.append(error_msg)
                self.logger_service.log_warning(error_msg, {"session_id": request.session_id})

            # Add delay before cleanup if configured
            if request.configuration.delay_before_cleanup_ms > 0:
                time_port: ITimePort | None = getattr(self, "_time_port", None)
                delay_seconds = request.configuration.delay_before_cleanup_ms / 1000.0
                if time_port:
                    time_port.sleep(delay_seconds)
                else:
                    import time as _time
                    _time.sleep(delay_seconds)

            # Phase 6: Cleanup
            self.progress_service.update_progress(session_id, CompletePhase.CLEANUP, 71.5)

            try:
                # Cleanup session resources
                if self.cleanup_service.cleanup_session_resources(
                    request.session_id,
                    request.configuration.cleanup_level,
                ):
                    restoration_state.cleanup_completed = True

                # Cleanup temporary widgets
                temp_widgets_cleaned = self.cleanup_service.cleanup_temporary_widgets(request.session_id)
                if temp_widgets_cleaned > 0:
                    self.logger_service.log_info(
                        f"Cleaned up {temp_widgets_cleaned} temporary widgets",
                        {"session_id": request.session_id},
                    )

                # Cleanup event connections
                connections_cleaned = self.cleanup_service.cleanup_event_connections(request.session_id)
                if connections_cleaned > 0:
                    self.logger_service.log_info(
                        f"Cleaned up {connections_cleaned} event connections",
                        {"session_id": request.session_id},
                    )

            except Exception as e:
                error_msg = f"Cleanup failed: {e!s}"
                restoration_state.restoration_warnings.append(error_msg)
                self.logger_service.log_warning(error_msg, {"session_id": request.session_id})

            # Phase 7: Finalization
            self.progress_service.update_progress(session_id, CompletePhase.FINALIZATION, 85.8)

            # Force UI update if configured
            if request.configuration.force_ui_update:
                try:
                    parent_window = getattr(session, "parent_window", None)
                    if parent_window:
                        self.ui_restoration_service.force_ui_refresh(parent_window)
                except Exception as e:
                    self.logger_service.log_warning(
                        f"Failed to force UI refresh: {e!s}",
                        {"session_id": request.session_id},
                    )

            # Validate final restoration state
            if request.configuration.validate_restoration:
                validation_errors = self.validation_service.validate_restoration_state(restoration_state)
                if validation_errors:
                    restoration_state.restoration_warnings.extend(validation_errors)

            # Mark session as completed and remove from active sessions
            self.session_lookup_service.mark_session_completed(request.session_id)
            self.session_lookup_service.remove_session(request.session_id)

            # Create session summary
            session_summary = SessionCompletionSummary(
                session_id=request.session_id,
                start_time=getattr(session, "start_time", start_time),
                end_time=request.timestamp,
                duration_ms=0.0,  # Will be calculated in __post_init__
                total_updates=getattr(session, "update_count", 0),
                final_progress_value=getattr(session, "current_progress", 0.0),
                ui_elements_restored=len(getattr(session, "original_ui_state", {})),
                progress_bar_reparented=restoration_state.progress_bar_restored,
                completion_successful=len(restoration_state.restoration_errors) == 0,
            )

            self.progress_service.update_progress(session_id, CompletePhase.FINALIZATION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            execution_time = (datetime.now(UTC) - start_time).total_seconds() * 1000

            # Determine result based on restoration state
            if restoration_state.restoration_errors:
                result = CompleteResult.UI_RESTORATION_ERROR if not restoration_state.progress_bar_restored else CompleteResult.PROGRESS_BAR_RESTORATION_ERROR
            else:
                result = CompleteResult.SUCCESS

            self.logger_service.log_info(
                "Progress completion finished",
                {
                    "session_id": request.session_id,
                    "result": result.value,
                    "execution_time_ms": execution_time,
                    "errors": len(restoration_state.restoration_errors),
                    "warnings": len(restoration_state.restoration_warnings),
                },
            )

            return CompleteProgressResponse(
                result=result,
                restoration_state=restoration_state,
                session_summary=session_summary,
                current_phase=CompletePhase.FINALIZATION,
                progress_percentage=100.0,
                warnings=restoration_state.restoration_warnings,
                execution_time_ms=execution_time,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during progress completion",
                {"session_id": request.session_id, "error": str(e)},
            )

            return self._create_error_response(
                CompleteResult.INTERNAL_ERROR,
                CompletePhase.INITIALIZATION,
                0.0,
                f"Unexpected error: {e!s}",
                start_time,
            )

    def _create_error_response(
        self,
        result: CompleteResult,
        phase: CompletePhase,
        progress: float,
        error_message: str,
        start_time: datetime,
    ) -> CompleteProgressResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.now(UTC) - start_time).total_seconds() * 1000

        return CompleteProgressResponse(
            result=result,
            restoration_state=None,
            session_summary=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )