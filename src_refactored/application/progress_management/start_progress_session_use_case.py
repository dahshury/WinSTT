"""Start Progress Session Use Case

This module implements the StartProgressSessionUseCase for initiating progress tracking
sessions with UI state management and progress bar setup.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any, Protocol


class StartResult(Enum):
    """Enumeration of possible session start results."""
    SUCCESS = "success"
    SESSION_ALREADY_EXISTS = "session_already_exists"
    UI_SETUP_ERROR = "ui_setup_error"
    PROGRESS_BAR_ERROR = "progress_bar_error"
    VALIDATION_ERROR = "validation_error"
    INTERNAL_ERROR = "internal_error"


class StartPhase(Enum):
    """Enumeration of session start phases for progress tracking."""
    INITIALIZATION = "initialization"
    SESSION_VALIDATION = "session_validation"
    UI_STATE_SETUP = "ui_state_setup"
    PROGRESS_BAR_SETUP = "progress_bar_setup"
    LAYOUT_CONFIGURATION = "layout_configuration"
    VISIBILITY_MANAGEMENT = "visibility_management"
    COMPLETION = "completion"


class ProgressBarLocation(Enum):
    """Enumeration of progress bar locations."""
    MAIN_WINDOW = "main_window"
    DIALOG = "dialog"
    CUSTOM_WIDGET = "custom_widget"
    FLOATING = "floating"


class UIStateMode(Enum):
    """Enumeration of UI state modes during progress."""
    DISABLED = "disabled"
    READ_ONLY = "read_only"
    PARTIAL_DISABLED = "partial_disabled"
    NORMAL = "normal"


@dataclass
class ProgressSessionConfiguration:
    """Configuration for progress session startup."""
    disable_ui_elements: bool
    expand_progress_area: bool
    reparent_progress_bar: bool
    progress_bar_height: int = 20
    ui_state_mode: UIStateMode = UIStateMode.DISABLED
    progress_bar_location: ProgressBarLocation = ProgressBarLocation.DIALOG
    auto_show_progress: bool = True
    store_original_state: bool = True


@dataclass
class ProgressBarInfo:
    """Information about progress bar setup."""
    widget: Any  # QProgressBar
    original_parent: Any | None = None
    original_geometry: Any | None = None  # QRect
    original_visibility: bool = False
    current_location: ProgressBarLocation = ProgressBarLocation.MAIN_WINDOW


@dataclass
class StartProgressSessionRequest:
    """Request for starting progress session."""
    session_id: str
    parent_window: Any  # QMainWindow
    target_widget: Any | None = None  # QWidget for progress placement
    configuration: ProgressSessionConfiguration
    context_data: dict[str, Any]
    timestamp: datetime


@dataclass
class ProgressSessionState:
    """State of progress session."""
    session_id: str
    is_active: bool
    progress_bar_info: ProgressBarInfo | None
    ui_elements_disabled: bool
    progress_area_expanded: bool
    original_ui_state: dict[str, Any]
    start_time: datetime
    configuration: ProgressSessionConfiguration
    context_data: dict[str, Any]


@dataclass
class StartProgressSessionResponse:
    """Response from progress session start operation."""
    result: StartResult
    session_state: ProgressSessionState | None
    current_phase: StartPhase
    progress_percentage: float
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    execution_time_ms: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class SessionValidationServiceProtocol(Protocol,
    ):
    """Protocol for session validation operations."""

    def validate_session_id(self, session_id: str,
    ) -> list[str]:
        """Validate session ID format and uniqueness."""
        ...

    def check_session_exists(self, session_id: str,
    ) -> bool:
        """Check if session already exists."""
        ...

    def validate_parent_window(self, parent_window: Any,
    ) -> bool:
        """Validate parent window is accessible."""
        ...


class UIStateManagementServiceProtocol(Protocol):
    """Protocol for UI state management operations."""

    def disable_ui_elements(self, parent_window: Any, mode: UIStateMode,
    ) -> dict[str, Any]:
        """Disable UI elements and return original state."""
        ...

    def store_original_ui_state(self, parent_window: Any,
    ) -> dict[str, Any]:
        """Store original UI state for restoration."""
        ...

    def expand_progress_area(self, target_widget: Any, height: int,
    ) -> bool:
        """Expand progress area to accommodate progress bar."""
        ...


class ProgressBarManagementServiceProtocol(Protocol):
    """Protocol for progress bar management operations."""

    def get_progress_bar(self, parent_window: Any,
    ) -> Any | None:
        """Get progress bar from parent window."""
        ...

    def store_progress_bar_state(self, progress_bar: Any,
    ) -> ProgressBarInfo:
        """Store original progress bar state."""
        ...

    def reparent_progress_bar(self, progress_bar: Any, target_widget: Any,
    ) -> bool:
        """Reparent progress bar to target widget."""
        ...

    def setup_progress_bar_layout(self, progress_bar: Any, target_widget: Any,
    ) -> bool:
        """Setup progress bar in target layout."""
        ...


class VisibilityManagementServiceProtocol(Protocol):
    """Protocol for visibility management operations."""

    def show_progress_bar(self, progress_bar: Any,
    ) -> bool:
        """Show progress bar with proper visibility."""
        ...

    def update_widget_visibility(self, widget: Any, visible: bool,
    ) -> bool:
        """Update widget visibility."""
        ...

    def force_widget_update(self, widget: Any,
    ) -> bool:
        """Force widget to update its display."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress_session(self, session_id: str, total_phases: int,
    ) -> None:
        """Start a new progress tracking session."""
        ...

    def update_progress(self, session_id: str, phase: StartPhase, percentage: float,
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


class StartProgressSessionUseCase:
    """Use case for starting progress sessions with UI state management."""

    def __init__(
        self,
        session_validation_service: SessionValidationServiceProtocol,
        ui_state_service: UIStateManagementServiceProtocol,
        progress_bar_service: ProgressBarManagementServiceProtocol,
        visibility_service: VisibilityManagementServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.session_validation_service = session_validation_service
        self.ui_state_service = ui_state_service
        self.progress_bar_service = progress_bar_service
        self.visibility_service = visibility_service
        self.progress_service = progress_service
        self.logger_service = logger_service
        self._active_sessions: dict[str, ProgressSessionState] = {}

    def execute(self, request: StartProgressSessionRequest,
    ) -> StartProgressSessionResponse:
        """Execute the progress session start operation."""
        start_time = datetime.now(UTC)
        session_id = f"start_session_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 7)
            self.progress_service.update_progress(session_id, StartPhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting progress session",
                {
                    "session_id": request.session_id,
                    "parent_window": str(type(request.parent_window).__name__),
                    "configuration": request.configuration.__dict__,
                },
            )

            # Phase 2: Session Validation
            self.progress_service.update_progress(session_id, StartPhase.SESSION_VALIDATION, 14.3)

            # Validate session ID
            session_errors = self.session_validation_service.validate_session_id(request.session_id)
            if session_errors:
                return self._create_error_response(
                    StartResult.VALIDATION_ERROR,
                    StartPhase.SESSION_VALIDATION,
                    14.3,
                    f"Session validation failed: {'; '.join(session_errors)}",
                    start_time,
                )

            # Check if session already exists
            if self.session_validation_service.check_session_exists(request.session_id):
                return self._create_error_response(
                    StartResult.SESSION_ALREADY_EXISTS,
                    StartPhase.SESSION_VALIDATION,
                    14.3,
                    f"Session {request.session_id} already exists",
                    start_time,
                )

            # Validate parent window
            if not self.session_validation_service.validate_parent_window(request.parent_window):
                return self._create_error_response(
                    StartResult.VALIDATION_ERROR,
                    StartPhase.SESSION_VALIDATION,
                    14.3,
                    "Parent window is not accessible",
                    start_time,
                )

            # Phase 3: UI State Setup
            self.progress_service.update_progress(session_id, StartPhase.UI_STATE_SETUP, 28.6)

            original_ui_state = {}
            ui_elements_disabled = False

            try:
                if request.configuration.store_original_state:
                    original_ui_state = self.ui_state_service.store_original_ui_state(request.parent_window)

                if request.configuration.disable_ui_elements:
                    disabled_state = self.ui_state_service.disable_ui_elements(
                        request.parent_window,
                        request.configuration.ui_state_mode,
                    )
                    original_ui_state.update(disabled_state)
                    ui_elements_disabled = True

            except Exception as e:
                return self._create_error_response(
                    StartResult.UI_SETUP_ERROR,
                    StartPhase.UI_STATE_SETUP,
                    28.6,
                    f"Failed to setup UI state: {e!s}",
                    start_time,
                )

            # Phase 4: Progress Bar Setup
            self.progress_service.update_progress(session_id, StartPhase.PROGRESS_BAR_SETUP, 42.9)

            progress_bar_info = None
            progress_area_expanded = False

            try:
                # Get progress bar from parent window
                progress_bar = self.progress_bar_service.get_progress_bar(request.parent_window)

                if progress_bar and request.configuration.reparent_progress_bar:
                    # Store original progress bar state
                    progress_bar_info = self.progress_bar_service.store_progress_bar_state(progress_bar)

                    # Expand progress area if needed
                    if request.configuration.expand_progress_area and request.target_widget and self.ui_state_service.expand_progress_area(
                            request.target_widget,
                            request.configuration.progress_bar_height,
                        ):                       
                            progress_area_expanded = True

                    # Reparent progress bar
                    if request.target_widget:
                        if not self.progress_bar_service.reparent_progress_bar(progress_bar, request.target_widget):
                            self.logger_service.log_warning(
                                "Failed to reparent progress bar",
                                {"session_id": request.session_id},
                            )
                        else:
                            progress_bar_info.current_location = request.configuration.progress_bar_location

            except Exception as e:
                return self._create_error_response(
                    StartResult.PROGRESS_BAR_ERROR,
                    StartPhase.PROGRESS_BAR_SETUP,
                    42.9,
                    f"Failed to setup progress bar: {e!s}",
                    start_time,
                )

            # Phase 5: Layout Configuration
            self.progress_service.update_progress(session_id, StartPhase.LAYOUT_CONFIGURATION, 57.2)

            try:
                if progress_bar_info and request.target_widget:
                    if not self.progress_bar_service.setup_progress_bar_layout(
                        progress_bar_info.widget,
                        request.target_widget,
                    ):
                        self.logger_service.log_warning(
                            "Failed to setup progress bar layout",
                            {"session_id": request.session_id},
                        )

            except Exception as e:
                self.logger_service.log_warning(
                    "Layout configuration warning",
                    {"session_id": request.session_id, "error": str(e)},
                )

            # Phase 6: Visibility Management
            self.progress_service.update_progress(session_id, StartPhase.VISIBILITY_MANAGEMENT, 71.5)

            try:
                if progress_bar_info and request.configuration.auto_show_progress:
                    if self.visibility_service.show_progress_bar(progress_bar_info.widget):
                        # Force update to ensure visibility
                        self.visibility_service.force_widget_update(progress_bar_info.widget)
                        if request.target_widget:
                            self.visibility_service.force_widget_update(request.target_widget)

            except Exception as e:
                self.logger_service.log_warning(
                    "Visibility management warning",
                    {"session_id": request.session_id, "error": str(e)},
                )

            # Phase 7: Completion
            self.progress_service.update_progress(session_id, StartPhase.COMPLETION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            # Create session state
            session_state = ProgressSessionState(
                session_id=request.session_id,
                is_active=True,
                progress_bar_info=progress_bar_info,
                ui_elements_disabled=ui_elements_disabled,
                progress_area_expanded=progress_area_expanded,
                original_ui_state=original_ui_state,
                start_time=start_time,
                configuration=request.configuration,
                context_data=request.context_data,
            )

            # Store active session
            self._active_sessions[request.session_id] = session_state

            execution_time = (datetime.now(UTC) - start_time).total_seconds() * 1000

            self.logger_service.log_info(
                "Progress session started successfully",
                {
                    "session_id": request.session_id,
                    "execution_time_ms": execution_time,
                    "ui_disabled": ui_elements_disabled,
                    "progress_bar_reparented": progress_bar_info is not None,
                },
            )

            return StartProgressSessionResponse(
                result=StartResult.SUCCESS,
                session_state=session_state,
                current_phase=StartPhase.COMPLETION,
                progress_percentage=100.0,
                execution_time_ms=execution_time,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during progress session start",
                {"session_id": request.session_id, "error": str(e)},
            )

            return self._create_error_response(
                StartResult.INTERNAL_ERROR,
                StartPhase.INITIALIZATION,
                0.0,
                f"Unexpected error: {e!s}",
                start_time,
            )

    def get_active_session(self, session_id: str,
    ) -> ProgressSessionState | None:
        """Get active session by ID."""
        return self._active_sessions.get(session_id)

    def get_all_active_sessions(self) -> dict[str, ProgressSessionState]:
        """Get all active sessions."""
        return self._active_sessions.copy()

    def _create_error_response(
        self,
        result: StartResult,
        phase: StartPhase,
        progress: float,
        error_message: str,
        start_time: datetime,
    ) -> StartProgressSessionResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.now(UTC) - start_time).total_seconds() * 1000

        return StartProgressSessionResponse(
            result=result,
            session_state=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )