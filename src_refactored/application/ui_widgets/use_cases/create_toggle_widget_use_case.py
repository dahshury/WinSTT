"""Create Toggle Widget Use Case

This module implements the CreateToggleWidgetUseCase for creating custom toggle switch widgets
with styling and validation.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from ....domain.ui_widgets.value_objects.ui_widget_operations import (
    CreatePhase,
    CreateResult,
    ToggleSize,
    ToggleStyle,
)


@dataclass
class ToggleWidgetConfiguration:
    """Configuration for toggle widget creation."""
    style: ToggleStyle
    size: ToggleSize
    custom_width: int | None = None
    custom_height: int | None = None
    initial_value: bool = False
    enabled: bool = True
    tooltip: str | None = None
    object_name: str | None = None
    custom_stylesheet: str | None = None


@dataclass
class CreateToggleWidgetRequest:
    """Request for creating a toggle widget."""
    configuration: ToggleWidgetConfiguration
    parent_widget: Any | None = None  # QWidget
    connect_signals: bool = True
    validate_parent: bool = True
    timestamp: datetime = None

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()


@dataclass
class CreatedToggleWidget:
    """Container for created toggle widget information."""
    widget: Any  # QSlider (ToggleSwitch)
    widget_id: str
    configuration: ToggleWidgetConfiguration
    creation_timestamp: datetime
    parent_widget: Any | None = None
    connected_signals: list[str] = None

    def __post_init__(self):
        if self.connected_signals is None:
            self.connected_signals = []


@dataclass
class CreateToggleWidgetResponse:
    """Response from toggle widget creation operation."""
    result: CreateResult
    created_widget: CreatedToggleWidget | None
    current_phase: CreatePhase
    progress_percentage: float
    error_message: str | None = None
    warnings: list[str] = None
    execution_time_ms: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class WidgetFactoryServiceProtocol(Protocol,
    ):
    """Protocol for widget creation operations."""

    def create_toggle_switch(self, parent: Any | None = None) -> Any:
        """Create a new toggle switch widget."""
        ...

    def set_widget_properties(self, widget: Any, configuration: ToggleWidgetConfiguration,
    ) -> bool:
        """Set widget properties based on configuration."""
        ...

    def validate_widget_creation(self, widget: Any,
    ) -> bool:
        """Validate that widget was created successfully."""
        ...


class WidgetStylingServiceProtocol(Protocol):
    """Protocol for widget styling operations."""

    def apply_toggle_style(self, widget: Any, style: ToggleStyle, size: ToggleSize,
    ) -> bool:
        """Apply styling to toggle widget."""
        ...

    def apply_custom_stylesheet(self, widget: Any, stylesheet: str,
    ) -> bool:
        """Apply custom stylesheet to widget."""
        ...

    def get_default_stylesheet(self, style: ToggleStyle, size: ToggleSize,
    ) -> str:
        """Get default stylesheet for style and size combination."""
        ...

    def validate_stylesheet(self, stylesheet: str,
    ) -> list[str]:
        """Validate stylesheet syntax and return errors."""
        ...


class WidgetValidationServiceProtocol(Protocol):
    """Protocol for widget validation operations."""

    def validate_parent_widget(self, parent: Any,
    ) -> bool:
        """Validate parent widget is suitable for toggle switch."""
        ...

    def validate_widget_configuration(self, config: ToggleWidgetConfiguration,
    ) -> list[str]:
        """Validate widget configuration and return errors."""
        ...

    def validate_size_parameters(
    self,
    size: ToggleSize,
    width: int | None,
    height: int | None) -> list[str]:
        """Validate size parameters."""
        ...


class SignalConnectionServiceProtocol(Protocol):
    """Protocol for signal connection operations."""

    def connect_toggle_signals(self, widget: Any, configuration: ToggleWidgetConfiguration,
    ) -> list[str]:
        """Connect toggle widget signals and return list of connected signals."""
        ...

    def disconnect_widget_signals(self, widget: Any,
    ) -> bool:
        """Disconnect all widget signals."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress_session(self, session_id: str, total_phases: int,
    ) -> None:
        """Start a new progress tracking session."""
        ...

    def update_progress(self, session_id: str, phase: CreatePhase, percentage: float,
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


class CreateToggleWidgetUseCase:
    """Use case for creating custom toggle switch widgets with styling and validation."""

    def __init__(
        self,
        widget_factory_service: WidgetFactoryServiceProtocol,
        styling_service: WidgetStylingServiceProtocol,
        validation_service: WidgetValidationServiceProtocol,
        signal_service: SignalConnectionServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.widget_factory_service = widget_factory_service
        self.styling_service = styling_service
        self.validation_service = validation_service
        self.signal_service = signal_service
        self.progress_service = progress_service
        self.logger_service = logger_service

    def execute(self, request: CreateToggleWidgetRequest,
    ) -> CreateToggleWidgetResponse:
        """Execute the toggle widget creation operation."""
        start_time = datetime.utcnow()
        session_id = f"create_toggle_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 7)
            self.progress_service.update_progress(session_id, CreatePhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting toggle widget creation",
                {
                    "session_id": session_id,
                    "style": request.configuration.style.value,
                    "size": request.configuration.size.value,
                },
            )

            # Phase 2: Parameter Validation
            self.progress_service.update_progress(session_id, CreatePhase.PARAMETER_VALIDATION, 15.0)

            # Validate parent widget if required
            if request.validate_parent and request.parent_widget:
                if not self.validation_service.validate_parent_widget(request.parent_widget):
                    return self._create_error_response(
                        CreateResult.PARENT_ERROR,
                        CreatePhase.PARAMETER_VALIDATION,
                        15.0,
                        "Invalid parent widget provided",
                        start_time,
                    )

            # Validate configuration
config_errors = (
    self.validation_service.validate_widget_configuration(request.configuration))
            if config_errors:
                return self._create_error_response(
                    CreateResult.VALIDATION_ERROR,
                    CreatePhase.PARAMETER_VALIDATION,
                    15.0,
                    f"Configuration validation failed: {'; '.join(config_errors)}",
                    start_time,
                )

            # Validate size parameters
            size_errors = self.validation_service.validate_size_parameters(
                request.configuration.size,
                request.configuration.custom_width,
                request.configuration.custom_height,
            )
            if size_errors:
                return self._create_error_response(
                    CreateResult.VALIDATION_ERROR,
                    CreatePhase.PARAMETER_VALIDATION,
                    15.0,
                    f"Size validation failed: {'; '.join(size_errors)}",
                    start_time,
                )

            # Phase 3: Widget Creation
            self.progress_service.update_progress(session_id, CreatePhase.WIDGET_CREATION, 30.0)

            try:
toggle_widget = (
    self.widget_factory_service.create_toggle_switch(request.parent_widget))

                if not self.widget_factory_service.validate_widget_creation(toggle_widget,
    ):
                    return self._create_error_response(
                        CreateResult.INTERNAL_ERROR,
                        CreatePhase.WIDGET_CREATION,
                        30.0,
                        "Failed to create toggle widget",
                        start_time,
                    )

                # Set basic properties
                if not self.widget_factory_service.set_widget_properties(toggle_widget, request.configuration):
                    return self._create_error_response(
                        CreateResult.INTERNAL_ERROR,
                        CreatePhase.WIDGET_CREATION,
                        30.0,
                        "Failed to set widget properties",
                        start_time,
                    )

            except Exception as e:
                return self._create_error_response(
                    CreateResult.INTERNAL_ERROR,
                    CreatePhase.WIDGET_CREATION,
                    30.0,
                    f"Error creating widget: {e!s}",
                    start_time,
                )

            # Phase 4: Styling Application
            self.progress_service.update_progress(session_id, CreatePhase.STYLING_APPLICATION, 50.0)

            try:
                # Apply custom stylesheet if provided
                if request.configuration.custom_stylesheet:
                    stylesheet_errors
 = (
    self.styling_service.validate_stylesheet(request.configuration.custom_stylesheet,)
    )
                    if stylesheet_errors:
                        return self._create_error_response(
                            CreateResult.STYLING_ERROR,
                            CreatePhase.STYLING_APPLICATION,
                            50.0,
                            f"Invalid stylesheet: {'; '.join(stylesheet_errors)}",
                            start_time,
                        )

                    if not self.styling_service.apply_custom_stylesheet(toggle_widget,
                    request.configuration.custom_stylesheet):
                        return self._create_error_response(
                            CreateResult.STYLING_ERROR,
                            CreatePhase.STYLING_APPLICATION,
                            50.0,
                            "Failed to apply custom stylesheet",
                            start_time,
                        )
                elif not self.styling_service.apply_toggle_style(
                    toggle_widget,
                    request.configuration.style,
                    request.configuration.size,
                ):
                    return self._create_error_response(
                        CreateResult.STYLING_ERROR,
                        CreatePhase.STYLING_APPLICATION,
                        50.0,
                        "Failed to apply default styling",
                        start_time,
                    )

            except Exception as e:
                return self._create_error_response(
                    CreateResult.STYLING_ERROR,
                    CreatePhase.STYLING_APPLICATION,
                    50.0,
                    f"Error applying styling: {e!s}",
                    start_time,
                )

            # Phase 5: Parent Attachment
            self.progress_service.update_progress(session_id, CreatePhase.PARENT_ATTACHMENT, 70.0)

            # Widget is already attached to parent during creation if parent was provided

            # Phase 6: Event Connection
            self.progress_service.update_progress(session_id, CreatePhase.EVENT_CONNECTION, 85.0)

            connected_signals = []
            if request.connect_signals:
                try:
                    connected_signals = self.signal_service.connect_toggle_signals(toggle_widget,
                    request.configuration)
                except Exception as e:
                    self.logger_service.log_warning(
                        "Failed to connect some signals",
                        {"session_id": session_id, "error": str(e)},
                    )

            # Phase 7: Completion
            self.progress_service.update_progress(session_id, CreatePhase.COMPLETION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            widget_id = f"toggle_{id(toggle_widget)}"

            created_widget = CreatedToggleWidget(
                widget=toggle_widget,
                widget_id=widget_id,
                configuration=request.configuration,
                creation_timestamp=datetime.utcnow()
                parent_widget=request.parent_widget,
                connected_signals=connected_signals,
            )

            execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

            self.logger_service.log_info(
                "Toggle widget creation completed successfully",
                {
                    "session_id": session_id,
                    "widget_id": widget_id,
                    "execution_time_ms": execution_time,
                },
            )

            return CreateToggleWidgetResponse(
                result=CreateResult.SUCCESS,
                created_widget=created_widget,
                current_phase=CreatePhase.COMPLETION,
                progress_percentage=100.0,
                execution_time_ms=execution_time,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during toggle widget creation",
                {"session_id": session_id, "error": str(e)},
            )

            return self._create_error_response(
                CreateResult.INTERNAL_ERROR,
                CreatePhase.INITIALIZATION,
                0.0,
                f"Unexpected error: {e!s}",
                start_time,
            )

    def _create_error_response(
        self,
        result: CreateResult,
        phase: CreatePhase,
        progress: float,
        error_message: str,
        start_time: datetime,
    ) -> CreateToggleWidgetResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

        return CreateToggleWidgetResponse(
            result=result,
            created_widget=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )