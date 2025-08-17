"""Initialize Main Window Use Case

This module implements the InitializeMainWindowUseCase for setting up the main
application window with all necessary components and configurations.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

from src.domain.ui_coordination.value_objects.ui_abstractions import (
    IUIWidget,
    IUIWindow,
)
from src.domain.ui_coordination.value_objects.window_operations import (
    ComponentType,
    InitializePhase,
    InitializeResult,
    WindowType,
)


@dataclass
class WindowConfiguration:
    """Configuration for main window initialization."""
    window_type: WindowType = WindowType.MAIN_WINDOW
    title: str = "WinSTT"
    width: int = 800
    height: int = 600
    resizable: bool = True
    center_on_screen: bool = True
    always_on_top: bool = False
    frameless: bool = False
    transparent_background: bool = False
    opacity: float = 1.0
    minimum_size: tuple[int, int] = (400, 300)
    maximum_size: tuple[int, int] | None = None


@dataclass
class ComponentConfiguration:
    """Configuration for window components."""
    component_type: ComponentType
    enabled: bool = True
    visible: bool = True
    properties: dict[str, Any] = field(default_factory=dict)
    style_sheet: str | None = None
    layout_constraints: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if self.properties is None:
            self.properties = {}
        if self.layout_constraints is None:
            self.layout_constraints = {}


@dataclass
class InitializeMainWindowRequest:
    """Request for initializing main window."""
    window_configuration: WindowConfiguration
    component_configurations: list[ComponentConfiguration]
    parent_widget: IUIWidget | None = None
    context_data: dict[str, Any] | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()
        if self.context_data is None:
            self.context_data = {}


@dataclass
class InitializedComponent:
    """Information about initialized component."""
    component_type: ComponentType
    widget: IUIWidget | None
    configuration: ComponentConfiguration
    initialization_successful: bool
    error_message: str | None = None


@dataclass
class MainWindowState:
    """State of initialized main window."""
    window: IUIWindow
    configuration: WindowConfiguration
    components: dict[ComponentType, InitializedComponent]
    signals_connected: bool
    layout_configured: bool
    initialization_time: datetime
    is_visible: bool = False

    def __post_init__(self,
    ):
        if not hasattr(self, "components"):
            self.components = {}


@dataclass
class InitializeMainWindowResponse:
    """Response from main window initialization."""
    result: InitializeResult
    window_state: MainWindowState | None
    current_phase: InitializePhase
    progress_percentage: float
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    execution_time_ms: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class WindowFactoryServiceProtocol(Protocol,
    ):
    """Protocol for window factory operations."""

    def create_main_window(
    self,
    configuration: WindowConfiguration,
    parent: IUIWidget | None = None) -> IUIWindow:
        """Create main window with configuration."""
        ...

    def configure_window_properties(self, window: IUIWindow, configuration: WindowConfiguration,
    ) -> bool:
        """Configure window properties."""
        ...

    def center_window_on_screen(self, window: IUIWindow,
    ) -> bool:
        """Center window on screen."""
        ...


class ComponentFactoryServiceProtocol(Protocol):
    """Protocol for component factory operations."""

    def create_component(self,
    component_type: ComponentType, configuration: ComponentConfiguration, parent: IUIWidget,
    ) -> IUIWidget:
        """Create component with configuration."""
        ...

    def configure_component(self, component: IUIWidget, configuration: ComponentConfiguration,
    ) -> bool:
        """Configure component properties."""
        ...

    def validate_component_compatibility(self, component_type: ComponentType, parent: IUIWidget,
    ) -> bool:
        """Validate component is compatible with parent."""
        ...


class LayoutServiceProtocol(Protocol):
    """Protocol for layout operations."""

    def setup_main_layout(self, window: IUIWindow, components: dict[ComponentType, IUIWidget]) -> bool:
        """Setup main window layout with components."""
        ...

    def configure_component_layout(self, component: IUIWidget, constraints: dict[str, Any]) -> bool:
        """Configure component layout constraints."""
        ...

    def validate_layout_integrity(self, window: IUIWindow,
    ) -> bool:
        """Validate layout integrity."""
        ...


class SignalConnectionServiceProtocol(Protocol):
    """Protocol for signal connection operations."""

    def connect_window_signals(self, window: IUIWindow,
    ) -> dict[str, bool]:
        """Connect window-level signals."""
        ...

    def connect_component_signals(self, component: IUIWidget, component_type: ComponentType,
    ) -> dict[str, bool]:
        """Connect component signals."""
        ...

    def validate_signal_connections(self, window: IUIWindow,
    ) -> list[str]:
        """Validate all signal connections."""
        ...


class ValidationServiceProtocol(Protocol):
    """Protocol for validation operations."""

    def validate_window_configuration(self, configuration: WindowConfiguration,
    ) -> list[str]:
        """Validate window configuration."""
        ...

    def validate_component_configurations(
    self,
    configurations: list[ComponentConfiguration]) -> list[str]:
        """Validate component configurations."""
        ...

    def validate_initialization_request(self, request: InitializeMainWindowRequest,
    ) -> list[str]:
        """Validate initialization request."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress_session(self, session_id: str, total_phases: int,
    ) -> None:
        """Start a new progress tracking session."""
        ...

    def update_progress(self, session_id: str, phase: InitializePhase, percentage: float,
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


class InitializeMainWindowUseCase:
    """Use case for initializing main window with all components."""

    def __init__(
        self,
        window_factory_service: WindowFactoryServiceProtocol,
        component_factory_service: ComponentFactoryServiceProtocol,
        layout_service: LayoutServiceProtocol,
        signal_service: SignalConnectionServiceProtocol,
        validation_service: ValidationServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.window_factory_service = window_factory_service
        self.component_factory_service = component_factory_service
        self.layout_service = layout_service
        self.signal_service = signal_service
        self.validation_service = validation_service
        self.progress_service = progress_service
        self.logger_service = logger_service

    def execute(self, request: InitializeMainWindowRequest,
    ) -> InitializeMainWindowResponse:
        """Execute the main window initialization."""
        start_time = datetime.utcnow()
        session_id = f"initialize_main_window_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 7)
            self.progress_service.update_progress(session_id, InitializePhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting main window initialization",
                {
                    "window_title": request.window_configuration.title,
                    "window_size": f"{request.window_configuration.width}x{request.window_configuration.height}",
                    "component_count": len(request.component_configurations),
                },
            )

            # Phase 2: Configuration Validation
            self.progress_service.update_progress(session_id, InitializePhase.CONFIGURATION_VALIDATION, 14.3)

            # Validate initialization request
            request_errors = self.validation_service.validate_initialization_request(request)
            if request_errors:
                return self._create_error_response(
                    InitializeResult(
                        success=False,
                        phase=InitializePhase.CONFIGURATION_VALIDATION,
                        error_message=f"Request validation failed: {'; '.join(request_errors)}",
                    ),
                    InitializePhase.CONFIGURATION_VALIDATION,
                    14.3,
                    f"Request validation failed: {'; '.join(request_errors)}",
                    start_time,
                )

            # Validate window configuration
            window_errors = self.validation_service.validate_window_configuration(request.window_configuration)
            if window_errors:
                return self._create_error_response(
                    InitializeResult(
                        success=False,
                        phase=InitializePhase.CONFIGURATION_VALIDATION,
                        error_message=f"Window configuration validation failed: {'; '.join(window_errors)}",
                    ),
                    InitializePhase.CONFIGURATION_VALIDATION,
                    14.3,
                    f"Window configuration validation failed: {'; '.join(window_errors)}",
                    start_time,
                )

            # Validate component configurations
            component_errors = self.validation_service.validate_component_configurations(
                request.component_configurations,
            )
            if component_errors:
                return self._create_error_response(
                    InitializeResult(
                        success=False,
                        phase=InitializePhase.CONFIGURATION_VALIDATION,
                        error_message=f"Component configuration validation failed: {'; '.join(component_errors)}",
                    ),
                    InitializePhase.CONFIGURATION_VALIDATION,
                    14.3,
                    f"Component configuration validation failed: {'; '.join(component_errors)}",
                    start_time,
                )

            # Phase 3: Window Creation
            self.progress_service.update_progress(session_id, InitializePhase.WINDOW_CREATION, 28.6)

            try:
                # Create main window
                main_window = self.window_factory_service.create_main_window(
                    request.window_configuration,
                    request.parent_widget,
                )

                if not main_window:
                    return self._create_error_response(
                        InitializeResult(
                            success=False,
                            phase=InitializePhase.WINDOW_CREATION,
                            error_message="Failed to create main window",
                        ),
                        InitializePhase.WINDOW_CREATION,
                        28.6,
                        "Failed to create main window",
                        start_time,
                    )

                # Configure window properties
                if not self.window_factory_service.configure_window_properties(
                    main_window,
                    request.window_configuration,
                ):
                    self.logger_service.log_warning(
                        "Failed to configure some window properties",
                        {"window_title": request.window_configuration.title},
                    )

                # Center window if configured
                if request.window_configuration.center_on_screen:
                    if not self.window_factory_service.center_window_on_screen(main_window):
                        self.logger_service.log_warning(
                            "Failed to center window on screen",
                            {"window_title": request.window_configuration.title},
                        )

            except Exception as e:
                return self._create_error_response(
                    InitializeResult(
                        success=False,
                        phase=InitializePhase.WINDOW_CREATION,
                        error_message=f"Window creation failed: {e!s}",
                    ),
                    InitializePhase.WINDOW_CREATION,
                    28.6,
                    f"Window creation failed: {e!s}",
                    start_time,
                )

            # Phase 4: Component Setup
            self.progress_service.update_progress(session_id, InitializePhase.COMPONENT_SETUP, 42.9)

            initialized_components = {}
            component_creation_errors = []

            for component_config in request.component_configurations:
                try:
                    # Validate component compatibility
                    if not self.component_factory_service.validate_component_compatibility(
                        component_config.component_type,
                        main_window,
                    ):
                        error_msg = f"Component {component_config.component_type.value} is not compatible with main window"
                        component_creation_errors.append(error_msg)
                        continue

                    # Create component
                    component = self.component_factory_service.create_component(
                        component_config.component_type,
                        component_config,
                        main_window,
                    )

                    if component:
                        # Configure component
                        config_success = self.component_factory_service.configure_component(
                            component,
                            component_config,
                        )

                        initialized_components[component_config.component_type] = InitializedComponent(
                            component_type=component_config.component_type,
                            widget=component,
                            configuration=component_config,
                            initialization_successful=config_success,
                            error_message=None if config_success else "Configuration failed",
                        )

                        if not config_success:
                            self.logger_service.log_warning(
                                f"Component {component_config.component_type.value} created but configuration failed",
                                {"component_type": component_config.component_type.value},
                            )
                    else:
                        error_msg = f"Failed to create component {component_config.component_type.value}"
                        component_creation_errors.append(error_msg)

                        initialized_components[component_config.component_type] = InitializedComponent(
                            component_type=component_config.component_type,
                            widget=None,
                            configuration=component_config,
                            initialization_successful=False,
                            error_message="Component creation failed",
                        )

                except Exception as e:
                    error_msg = f"Component {component_config.component_type.value} initialization failed: {e!s}"
                    component_creation_errors.append(error_msg)

                    initialized_components[component_config.component_type] = InitializedComponent(
                        component_type=component_config.component_type,
                        widget=None,
                        configuration=component_config,
                        initialization_successful=False,
                        error_message=str(e),
                    )

            # Check if critical components failed
            if component_creation_errors:
                self.logger_service.log_warning(
                    "Some components failed to initialize",
                    {"errors": component_creation_errors},
                )

            # Phase 5: Layout Configuration
            self.progress_service.update_progress(session_id, InitializePhase.LAYOUT_CONFIGURATION, 57.2)

            layout_configured = False
            try:
                # Get successfully created components
                created_components = {
                    comp_type: comp.widget
                    for comp_type, comp in initialized_components.items()
                    if comp.widget is not None
                }

                # Setup main layout
                if self.layout_service.setup_main_layout(main_window, created_components):
                    layout_configured = True

                    # Configure individual component layouts
                    for component_config in request.component_configurations:
                        if (component_config.component_type in initialized_components and
                            initialized_components[component_config.component_type].widget):

                            layout_component: IUIWidget | None = initialized_components[component_config.component_type].widget
                            if layout_component is not None:  # Type guard
                                if not self.layout_service.configure_component_layout(
                                    layout_component,
                                    component_config.layout_constraints,
                                ):
                                    self.logger_service.log_warning(
                                        f"Failed to configure layout for {component_config.component_type.value}",
                                        {"component_type": component_config.component_type.value},
                                    )

                    # Validate layout integrity
                    if not self.layout_service.validate_layout_integrity(main_window):
                        self.logger_service.log_warning(
                            "Layout integrity validation failed",
                            {"window_title": request.window_configuration.title},
                        )
                else:
                    self.logger_service.log_error(
                        "Failed to setup main layout",
                        {"window_title": request.window_configuration.title},
                    )

            except Exception as e:
                return self._create_error_response(
                    InitializeResult(
                        success=False,
                        phase=InitializePhase.LAYOUT_CONFIGURATION,
                        error_message=f"Layout configuration failed: {e!s}",
                    ),
                    InitializePhase.LAYOUT_CONFIGURATION,
                    57.2,
                    f"Layout configuration failed: {e!s}",
                    start_time,
                )

            # Phase 6: Signal Connection
            self.progress_service.update_progress(session_id, InitializePhase.SIGNAL_CONNECTION, 71.5)

            signals_connected = False
            try:
                # Connect window signals
                window_signal_results = self.signal_service.connect_window_signals(main_window)
                window_signals_success = all(window_signal_results.values())

                # Connect component signals
                component_signal_results = {}
                for comp_type, comp in initialized_components.items():
                    if comp.widget:
                        comp_results = self.signal_service.connect_component_signals(
                            comp.widget,
                            comp_type,
                        )
                        component_signal_results[comp_type] = comp_results

                # Check overall signal connection success
                all_component_signals_success = all(
                    all(results.values())
                    for results in component_signal_results.values()
                )

                signals_connected = window_signals_success and all_component_signals_success

                if not signals_connected:
                    self.logger_service.log_warning(
                        "Some signal connections failed",
                        {
                            "window_signals": window_signals_success,
                            "component_signals": all_component_signals_success,
                        },
                    )

                # Validate signal connections
                signal_validation_errors = self.signal_service.validate_signal_connections(main_window)
                if signal_validation_errors:
                    self.logger_service.log_warning(
                        "Signal connection validation issues",
                        {"errors": signal_validation_errors},
                    )

            except Exception as e:
                self.logger_service.log_error(
                    f"Signal connection failed: {e!s}",
                    {"window_title": request.window_configuration.title},
                )

            # Phase 7: Finalization
            self.progress_service.update_progress(session_id, InitializePhase.FINALIZATION, 85.8)

            # Create window state
            window_state = MainWindowState(
                window=main_window,
                configuration=request.window_configuration,
                components=initialized_components,
                signals_connected=signals_connected,
                layout_configured=layout_configured,
                initialization_time=start_time,
                is_visible=False,
            )

            self.progress_service.update_progress(session_id, InitializePhase.FINALIZATION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

            # Determine result
            if component_creation_errors and not any(comp.initialization_successful for comp in initialized_components.values()):
                result = InitializeResult(
                    success=False,
                    phase=InitializePhase.COMPONENT_SETUP,
                    error_message="Some components failed to initialize",
                )
            elif not layout_configured:
                result = InitializeResult(
                    success=False,
                    phase=InitializePhase.LAYOUT_SETUP,
                    error_message="Layout configuration incomplete",
                )
            elif not signals_connected:
                result = InitializeResult(
                    success=False,
                    phase=InitializePhase.SIGNAL_CONNECTION,
                    error_message="Signal connections incomplete",
                )
            else:
                result = InitializeResult(
                    success=True,
                    phase=InitializePhase.FINALIZATION,
                    error_message="Main window initialization successful",
                )

            self.logger_service.log_info(
                "Main window initialization completed",
                {
                    "window_title": request.window_configuration.title,
                    "result": result.success,
                    "execution_time_ms": execution_time,
                    "components_created": len([c for c in initialized_components.values() if c.widget]),
                    "layout_configured": layout_configured,
                    "signals_connected": signals_connected,
                },
            )

            warnings = component_creation_errors.copy()
            if not layout_configured:
                warnings.append("Layout configuration incomplete")
            if not signals_connected:
                warnings.append("Signal connections incomplete")

            return InitializeMainWindowResponse(
                result=result,
                window_state=window_state,
                current_phase=InitializePhase.FINALIZATION,
                progress_percentage=100.0,
                warnings=warnings,
                execution_time_ms=execution_time,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during main window initialization",
                {"error": str(e)},
            )

            return self._create_error_response(
                InitializeResult(
                    success=False,
                    phase=InitializePhase.INITIALIZATION,
                    error_message=f"Unexpected error: {e!s}",
                ),
                InitializePhase.INITIALIZATION,
                0.0,
                f"Unexpected error: {e!s}",
                start_time,
            )

    def _create_error_response(
        self,
        result: InitializeResult,
        phase: InitializePhase,
        progress: float,
        error_message: str,
        start_time: datetime,
    ) -> InitializeMainWindowResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

        return InitializeMainWindowResponse(
            result=result,
            window_state=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )