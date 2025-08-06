"""Integrate Visualization Use Case

This module implements the IntegrateVisualizationUseCase for integrating
visualization components into the main window with proper configuration and management.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Protocol

from src_refactored.domain.main_window.value_objects.window_operations import (
    IntegratePhase,
    IntegrateResult,
    RenderingMode,
    VisualizationType,
)


class DataSourceType(Enum):
    """Enumeration of data source types."""
    AUDIO_STREAM = "audio_stream"
    FILE_DATA = "file_data"
    REAL_TIME = "real_time"
    BUFFERED = "buffered"
    CALLBACK = "callback"
    SIGNAL = "signal"


class UpdateMode(Enum):
    """Enumeration of update modes."""
    CONTINUOUS = "continuous"
    ON_DEMAND = "on_demand"
    TIMER_BASED = "timer_based"
    EVENT_DRIVEN = "event_driven"
    MANUAL = "manual"


@dataclass
class VisualizationConfiguration:
    """Configuration for visualization component."""
    visualization_type: VisualizationType
    rendering_mode: RenderingMode = RenderingMode.AUTO
    update_mode: UpdateMode = UpdateMode.CONTINUOUS
    refresh_rate_fps: int = 60
    buffer_size: int = 1024
    color_scheme: dict[str, str] = field(default_factory=dict)
    dimensions: tuple[int, int] = (400, 200)
    enable_antialiasing: bool = True
    enable_transparency: bool = False
    background_color: str = "#000000"
    grid_enabled: bool = True
    labels_enabled: bool = True
    legend_enabled: bool = False

    def __post_init__(self,
    ):
        if self.color_scheme is None:
            self.color_scheme = {
                "primary": "#00FF00",
                "secondary": "#FFFF00",
                "background": "#000000",
                "grid": "#333333",
                "text": "#FFFFFF",
            }


@dataclass
class DataBindingConfiguration:
    """Configuration for data binding."""
    data_source_type: DataSourceType
    source_identifier: str
    update_interval_ms: int = 16  # ~60 FPS
    buffer_management: str = "circular"
    data_transformation: str | None = None
    filtering_enabled: bool = True
    normalization_enabled: bool = True
    scaling_factor: float = 1.0
    offset: float = 0.0
    channel_mapping: dict[int, str] = field(default_factory=dict)

    def __post_init__(self):
        if self.channel_mapping is None:
            self.channel_mapping = {0: "left", 1: "right"}


@dataclass
class RenderingConfiguration:
    """Configuration for rendering setup."""
    rendering_mode: RenderingMode
    vsync_enabled: bool = True
    double_buffering: bool = True
    multisample_level: int = 4
    texture_filtering: str = "linear"
    shader_quality: str = "high"
    performance_mode: bool = False
    memory_limit_mb: int = 256
    thread_count: int = 1
    gpu_acceleration: bool = True


@dataclass
class IntegrationConfiguration:
    """Configuration for visualization integration."""
    container_widget: Any  # Parent widget
    layout_position: str = "center"  # center, top, bottom, left, right
    size_policy: str = "expanding"  # fixed, minimum, expanding
    z_order: int = 0
    margins: tuple[int, int, int, int] = (0, 0, 0, 0)
    spacing: int = 0
    alignment: str = "center"
    stretch_factor: int = 1
    minimum_size: tuple[int, int] | None = None
    maximum_size: tuple[int, int] | None = None


@dataclass
class IntegrateVisualizationRequest:
    """Request for integrating visualization."""
    visualization_config: VisualizationConfiguration
    data_binding_config: DataBindingConfiguration
    rendering_config: RenderingConfiguration
    integration_config: IntegrationConfiguration
    enable_real_time: bool = True
    validate_performance: bool = True
    context_data: dict[str, Any] | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()
        if self.context_data is None:
            self.context_data = {}


@dataclass
class VisualizationComponent:
    """Information about created visualization component."""
    widget: Any  # QWidget
    visualization_type: VisualizationType
    configuration: VisualizationConfiguration
    data_source: Any | None = None
    renderer: Any | None = None
    update_timer: Any | None = None
    is_active: bool = False
    creation_time: datetime = field(default_factory=datetime.utcnow)

    def __post_init__(self):
        if self.creation_time is None:
            self.creation_time = datetime.utcnow()


@dataclass
class DataBinding:
    """Information about data binding setup."""
    source_type: DataSourceType
    source_identifier: str
    configuration: DataBindingConfiguration
    connection_active: bool = False
    last_update_time: datetime | None = None
    data_rate_hz: float = 0.0
    buffer_usage_percent: float = 0.0
    error_count: int = 0


@dataclass
class RenderingSetup:
    """Information about rendering setup."""
    rendering_mode: RenderingMode
    configuration: RenderingConfiguration
    context: Any | None = None
    performance_metrics: dict[str, float] = field(default_factory=dict)
    gpu_info: dict[str, Any] | None = None
    setup_successful: bool = False

    def __post_init__(self,
    ):
        if self.performance_metrics is None:
            self.performance_metrics = {
                "fps": 0.0,
                "frame_time_ms": 0.0,
                "memory_usage_mb": 0.0,
                "gpu_usage_percent": 0.0,
            }


@dataclass
class VisualizationState:
    """Current state of integrated visualization."""
    component: VisualizationComponent
    data_binding: DataBinding
    rendering_setup: RenderingSetup
    integration_config: IntegrationConfiguration
    is_integrated: bool
    is_running: bool
    integration_time: datetime
    last_update_time: datetime
    performance_stats: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if self.performance_stats is None:
            self.performance_stats = {
                "total_frames": 0,
                "dropped_frames": 0,
                "average_fps": 0.0,
                "peak_memory_mb": 0.0,
            }


@dataclass
class IntegrateVisualizationResponse:
    """Response from visualization integration."""
    result: IntegrateResult
    visualization_state: VisualizationState | None
    current_phase: IntegratePhase
    progress_percentage: float
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    performance_report: dict[str, Any] | None = None
    execution_time_ms: float = 0.0

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class VisualizationValidationServiceProtocol(Protocol,
    ):
    """Protocol for visualization validation operations."""

    def validate_visualization_config(self, config: VisualizationConfiguration,
    ) -> list[str]:
        """Validate visualization configuration."""
        ...

    def validate_data_binding_config(self, config: DataBindingConfiguration,
    ) -> list[str]:
        """Validate data binding configuration."""
        ...

    def validate_rendering_config(self, config: RenderingConfiguration,
    ) -> list[str]:
        """Validate rendering configuration."""
        ...

    def validate_integration_compatibility(self, container: Any, config: IntegrationConfiguration,
    ) -> list[str]:
        """Validate integration compatibility."""
        ...


class VisualizationFactoryServiceProtocol(Protocol):
    """Protocol for visualization factory operations."""

    def create_visualization_widget(self, config: VisualizationConfiguration, parent: Any,
    ) -> Any:
        """Create visualization widget."""
        ...

    def configure_visualization_properties(self, widget: Any, config: VisualizationConfiguration,
    ) -> bool:
        """Configure visualization properties."""
        ...

    def get_supported_visualization_types(self) -> list[VisualizationType]:
        """Get list of supported visualization types."""
        ...


class DataBindingServiceProtocol(Protocol):
    """Protocol for data binding operations."""

    def setup_data_source(self, config: DataBindingConfiguration,
    ) -> Any:
        """Setup data source connection."""
        ...

    def bind_data_to_visualization(self, widget: Any, data_source: Any, config: DataBindingConfiguration,
    ) -> bool:
        """Bind data source to visualization widget."""
        ...

    def start_data_streaming(self, data_source: Any,
    ) -> bool:
        """Start data streaming."""
        ...

    def stop_data_streaming(self, data_source: Any,
    ) -> bool:
        """Stop data streaming."""
        ...

    def get_data_metrics(self, data_source: Any,
    ) -> dict[str, float]:
        """Get data streaming metrics."""
        ...


class RenderingServiceProtocol(Protocol):
    """Protocol for rendering operations."""

    def setup_rendering_context(self, widget: Any, config: RenderingConfiguration,
    ) -> Any:
        """Setup rendering context."""
        ...

    def configure_rendering_pipeline(self, context: Any, config: RenderingConfiguration,
    ) -> bool:
        """Configure rendering pipeline."""
        ...

    def optimize_rendering_performance(self, context: Any,
    ) -> dict[str, Any]:
        """Optimize rendering performance."""
        ...

    def get_rendering_capabilities(self) -> dict[str, Any]:
        """Get rendering capabilities."""
        ...

    def get_performance_metrics(self, context: Any,
    ) -> dict[str, float]:
        """Get rendering performance metrics."""
        ...


class IntegrationServiceProtocol(Protocol):
    """Protocol for integration operations."""

    def integrate_widget_into_container(self, widget: Any, container: Any, config: IntegrationConfiguration,
    ) -> bool:
        """Integrate widget into container."""
        ...

    def configure_layout_properties(self, widget: Any, config: IntegrationConfiguration,
    ) -> bool:
        """Configure layout properties."""
        ...

    def setup_update_mechanism(self, widget: Any, update_mode: UpdateMode, interval_ms: int,
    ) -> Any:
        """Setup update mechanism (timer, signals, etc.)."""
        ...

    def validate_integration_success(self, widget: Any, container: Any,
    ) -> bool:
        """Validate integration success."""
        ...


class PerformanceMonitoringServiceProtocol(Protocol):
    """Protocol for performance monitoring operations."""

    def start_performance_monitoring(self, widget: Any, session_id: str,
    ) -> bool:
        """Start performance monitoring."""
        ...

    def get_performance_report(self, session_id: str,
    ) -> dict[str, Any]:
        """Get performance monitoring report."""
        ...

    def validate_performance_requirements(self,
    metrics: dict[str, float], requirements: dict[str, float]) -> list[str]:
        """Validate performance against requirements."""
        ...

    def stop_performance_monitoring(self, session_id: str,
    ) -> None:
        """Stop performance monitoring."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress_session(self, session_id: str, total_phases: int,
    ) -> None:
        """Start a new progress tracking session."""
        ...

    def update_progress(self, session_id: str, phase: IntegratePhase, percentage: float,
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


class IntegrateVisualizationUseCase:
    """Use case for integrating visualization components into the main window."""

    def __init__(
        self,
        validation_service: VisualizationValidationServiceProtocol,
        visualization_factory_service: VisualizationFactoryServiceProtocol,
        data_binding_service: DataBindingServiceProtocol,
        rendering_service: RenderingServiceProtocol,
        integration_service: IntegrationServiceProtocol,
        performance_service: PerformanceMonitoringServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.validation_service = validation_service
        self.visualization_factory_service = visualization_factory_service
        self.data_binding_service = data_binding_service
        self.rendering_service = rendering_service
        self.integration_service = integration_service
        self.performance_service = performance_service
        self.progress_service = progress_service
        self.logger_service = logger_service

    def execute(self, request: IntegrateVisualizationRequest,
    ) -> IntegrateVisualizationResponse:
        """Execute the visualization integration."""
        start_time = datetime.utcnow()
        session_id = f"integrate_visualization_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 8)
            self.progress_service.update_progress(session_id, IntegratePhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting visualization integration",
                {
                    "visualization_type": request.visualization_config.visualization_type.value,
                    "rendering_mode": request.rendering_config.rendering_mode.value,
                    "data_source_type": request.data_binding_config.data_source_type.value,
                    "real_time_enabled": request.enable_real_time,
                },
            )

            # Phase 2: Validation
            self.progress_service.update_progress(session_id, IntegratePhase.VALIDATION, 12.5)

            # Validate visualization configuration
            viz_errors = self.validation_service.validate_visualization_config(request.visualization_config)
            if viz_errors:
                return self._create_error_response(
                    IntegrateResult.VALIDATION_ERROR,
                    IntegratePhase.VALIDATION,
                    12.5,
                    f"Visualization config validation failed: {'; '.join(viz_errors)}",
                    start_time,
                )

            # Validate data binding configuration
            data_errors = self.validation_service.validate_data_binding_config(request.data_binding_config)
            if data_errors:
                return self._create_error_response(
                    IntegrateResult.VALIDATION_ERROR,
                    IntegratePhase.VALIDATION,
                    12.5,
                    f"Data binding config validation failed: {'; '.join(data_errors)}",
                    start_time,
                )

            # Validate rendering configuration
            render_errors = self.validation_service.validate_rendering_config(request.rendering_config)
            if render_errors:
                return self._create_error_response(
                    IntegrateResult.VALIDATION_ERROR,
                    IntegratePhase.VALIDATION,
                    12.5,
                    f"Rendering config validation failed: {'; '.join(render_errors)}",
                    start_time,
                )

            # Validate integration compatibility
            integration_errors = self.validation_service.validate_integration_compatibility(
                request.integration_config.container_widget,
                request.integration_config,
            )
            if integration_errors:
                return self._create_error_response(
                    IntegrateResult.VALIDATION_ERROR,
                    IntegratePhase.VALIDATION,
                    12.5,
                    f"Integration compatibility validation failed: {'; '.join(integration_errors)}",
                    start_time,
                )

            # Phase 3: Visualization Creation
            self.progress_service.update_progress(session_id, IntegratePhase.VISUALIZATION_CREATION, 25.0)

            try:
                # Check if visualization type is supported
                supported_types = self.visualization_factory_service.get_supported_visualization_types()
                if request.visualization_config.visualization_type not in supported_types:
                    return self._create_error_response(
                        IntegrateResult.VISUALIZATION_CREATION_FAILED,
                        IntegratePhase.VISUALIZATION_CREATION,
                        25.0,
                        f"Visualization type {request.visualization_config.visualization_type.value} not supported",
                        start_time,
                    )

                # Create visualization widget
                visualization_widget = self.visualization_factory_service.create_visualization_widget(
                    request.visualization_config,
                    request.integration_config.container_widget,
                )

                if not visualization_widget:
                    return self._create_error_response(
                        IntegrateResult.VISUALIZATION_CREATION_FAILED,
                        IntegratePhase.VISUALIZATION_CREATION,
                        25.0,
                        "Failed to create visualization widget",
                        start_time,
                    )

                # Configure visualization properties
                if not self.visualization_factory_service.configure_visualization_properties(
                    visualization_widget,
                    request.visualization_config,
                ):
                    self.logger_service.log_warning(
                        "Failed to configure some visualization properties",
                        {
                            "visualization_type": request.visualization_config.visualization_type.value,
                        },
                    )

                # Create visualization component
                visualization_component = VisualizationComponent(
                    widget=visualization_widget,
                    visualization_type=request.visualization_config.visualization_type,
                    configuration=request.visualization_config,
                )

            except Exception as e:
                return self._create_error_response(
                    IntegrateResult.VISUALIZATION_CREATION_FAILED,
                    IntegratePhase.VISUALIZATION_CREATION,
                    25.0,
                    f"Visualization creation failed: {e!s}",
                    start_time,
                )

            # Phase 4: Configuration Setup
            self.progress_service.update_progress(session_id, IntegratePhase.CONFIGURATION_SETUP, 37.5)

            configuration_warnings = []

            try:
                # Apply visualization configuration
                if hasattr(visualization_widget, "setMinimumSize") and request.visualization_config.dimensions:
                    visualization_widget.setMinimumSize(*request.visualization_config.dimensions)

                if hasattr(visualization_widget, "setStyleSheet") and request.visualization_config.background_color:
                    style_sheet = f"background-color: {request.visualization_config.background_color};"
                    visualization_widget.setStyleSheet(style_sheet)

                # Configure update mode and refresh rate
                if request.visualization_config.update_mode == UpdateMode.TIMER_BASED:
                    update_interval = 1000 // request.visualization_config.refresh_rate_fps
                    update_timer = self.integration_service.setup_update_mechanism(
                        visualization_widget,
                        request.visualization_config.update_mode,
                        update_interval,
                    )
                    visualization_component.update_timer = update_timer

            except Exception as e:
                configuration_warnings.append(f"Configuration setup issues: {e!s}")
                self.logger_service.log_warning(
                    f"Configuration setup issues: {e!s}",
                    {"visualization_type": request.visualization_config.visualization_type.value},
                )

            # Phase 5: Data Binding
            self.progress_service.update_progress(session_id, IntegratePhase.DATA_BINDING, 50.0)

            data_binding = None
            try:
                # Setup data source
                data_source = self.data_binding_service.setup_data_source(request.data_binding_config)

                if not data_source:
                    return self._create_error_response(
                        IntegrateResult.DATA_BINDING_FAILED,
                        IntegratePhase.DATA_BINDING,
                        50.0,
                        "Failed to setup data source",
                        start_time,
                    )

                # Bind data to visualization
                if not self.data_binding_service.bind_data_to_visualization(
                    visualization_widget,
                    data_source,
                    request.data_binding_config,
                ):
                    return self._create_error_response(
                        IntegrateResult.DATA_BINDING_FAILED,
                        IntegratePhase.DATA_BINDING,
                        50.0,
                        "Failed to bind data to visualization",
                        start_time,
                    )

                # Create data binding info
                data_binding = DataBinding(
                    source_type=request.data_binding_config.data_source_type,
                    source_identifier=request.data_binding_config.source_identifier,
                    configuration=request.data_binding_config,
                )

                visualization_component.data_source = data_source

                # Start data streaming if real-time is enabled
                if request.enable_real_time:
                    if self.data_binding_service.start_data_streaming(data_source):
                        data_binding.connection_active = True
                        data_binding.last_update_time = datetime.utcnow()
                    else:
                        self.logger_service.log_warning(
                            "Failed to start real-time data streaming",
                            {"data_source": request.data_binding_config.source_identifier},
                        )

            except Exception as e:
                return self._create_error_response(
                    IntegrateResult.DATA_BINDING_FAILED,
                    IntegratePhase.DATA_BINDING,
                    50.0,
                    f"Data binding failed: {e!s}",
                    start_time,
                )

            # Phase 6: Rendering Setup
            self.progress_service.update_progress(session_id, IntegratePhase.RENDERING_SETUP, 62.5)

            rendering_setup = None
            try:
                # Setup rendering context
                rendering_context = self.rendering_service.setup_rendering_context(
                    visualization_widget,
                    request.rendering_config,
                )

                if not rendering_context:
                    return self._create_error_response(
                        IntegrateResult.RENDERING_SETUP_FAILED,
                        IntegratePhase.RENDERING_SETUP,
                        62.5,
                        "Failed to setup rendering context",
                        start_time,
                    )

                # Configure rendering pipeline
                pipeline_success = self.rendering_service.configure_rendering_pipeline(
                    rendering_context,
                    request.rendering_config,
                )

                # Get rendering capabilities
                capabilities = self.rendering_service.get_rendering_capabilities()

                # Optimize rendering performance
                self.rendering_service.optimize_rendering_performance(rendering_context)

                # Create rendering setup info
                rendering_setup = RenderingSetup(
                    rendering_mode=request.rendering_config.rendering_mode,
                    configuration=request.rendering_config,
                    context=rendering_context,
                    gpu_info=capabilities,
                    setup_successful=pipeline_success,
                )

                visualization_component.renderer = rendering_context

                if not pipeline_success:
                    self.logger_service.log_warning(
                        "Rendering pipeline configuration incomplete",
                        {"rendering_mode": request.rendering_config.rendering_mode.value},
                    )

            except Exception as e:
                return self._create_error_response(
                    IntegrateResult.RENDERING_SETUP_FAILED,
                    IntegratePhase.RENDERING_SETUP,
                    62.5,
                    f"Rendering setup failed: {e!s}",
                    start_time,
                )

            # Phase 7: Integration
            self.progress_service.update_progress(session_id, IntegratePhase.INTEGRATION, 75.0)

            integration_success = False
            try:
                # Integrate widget into container
                if not self.integration_service.integrate_widget_into_container(
                    visualization_widget,
                    request.integration_config.container_widget,
                    request.integration_config,
                ):
                    return self._create_error_response(
                        IntegrateResult.INTEGRATION_FAILED,
                        IntegratePhase.INTEGRATION,
                        75.0,
                        "Failed to integrate widget into container",
                        start_time,
                    )

                # Configure layout properties
                if not self.integration_service.configure_layout_properties(
                    visualization_widget,
                    request.integration_config,
                ):
                    self.logger_service.log_warning(
                        "Failed to configure some layout properties",
                        {
                            "visualization_type": request.visualization_config.visualization_type.value,
                        },
                    )

                # Validate integration success
                integration_success = self.integration_service.validate_integration_success(
                    visualization_widget,
                    request.integration_config.container_widget,
                )

                if integration_success:
                    visualization_component.is_active = True

            except Exception as e:
                return self._create_error_response(
                    IntegrateResult.INTEGRATION_FAILED,
                    IntegratePhase.INTEGRATION,
                    75.0,
                    f"Integration failed: {e!s}",
                    start_time,
                )

            # Phase 8: Finalization
            self.progress_service.update_progress(session_id, IntegratePhase.FINALIZATION, 87.5)

            # Start performance monitoring if requested
            performance_report = None
            if request.validate_performance:
                try:
                    perf_session_id = f"viz_perf_{start_time.timestamp()}"
                    if self.performance_service.start_performance_monitoring(visualization_widget, perf_session_id):
                        # Get initial performance report
                        performance_report = self.performance_service.get_performance_report(perf_session_id)

                        # Validate performance requirements
                        if performance_report:
                            requirements = {
                                "min_fps": 30.0,
                                "max_memory_mb": request.rendering_config.memory_limit_mb,
                                "max_frame_time_ms": 33.0,  # ~30 FPS
                            }

                            perf_issues = self.performance_service.validate_performance_requirements(
                                performance_report,
                                requirements,
                            )

                            if perf_issues:
                                self.logger_service.log_warning(
                                    "Performance validation issues detected",
                                    {"issues": perf_issues},
                                )
                                configuration_warnings.extend(perf_issues)

                except Exception as e:
                    self.logger_service.log_warning(
                        f"Performance monitoring setup failed: {e!s}",
                        {
                            "visualization_type": request.visualization_config.visualization_type.value,
                        },
                    )

            # Create visualization state
            visualization_state = VisualizationState(
                component=visualization_component,
                data_binding=data_binding,
                rendering_setup=rendering_setup,
                integration_config=request.integration_config,
                is_integrated=integration_success,
                is_running=data_binding.connection_active if data_binding else False,
                integration_time=start_time,
                last_update_time=datetime.utcnow(),
            )

            self.progress_service.update_progress(session_id, IntegratePhase.FINALIZATION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

            # Determine result
            if not integration_success:
                result = IntegrateResult.INTEGRATION_FAILED
            elif not rendering_setup.setup_successful:
                result = IntegrateResult.RENDERING_SETUP_FAILED
            elif not data_binding.connection_active and request.enable_real_time:
                result = IntegrateResult.DATA_BINDING_FAILED
            elif configuration_warnings:
                result = IntegrateResult.SUCCESS  # Success with warnings
            else:
                result = IntegrateResult.SUCCESS

            self.logger_service.log_info(
                "Visualization integration completed",
                {
                    "visualization_type": request.visualization_config.visualization_type.value,
                    "result": result.value,
                    "execution_time_ms": execution_time,
                    "integration_successful": integration_success,
                    "rendering_setup_successful": rendering_setup.setup_successful,
                    "data_streaming_active": data_binding.connection_active if data_binding else False,
                    "performance_monitoring": performance_report is not None,
                },
            )

            return IntegrateVisualizationResponse(
                result=result,
                visualization_state=visualization_state,
                current_phase=IntegratePhase.FINALIZATION,
                progress_percentage=100.0,
                warnings=configuration_warnings,
                performance_report=performance_report,
                execution_time_ms=execution_time,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during visualization integration",
                {"error": str(e)},
            )

            return self._create_error_response(
                IntegrateResult.INTERNAL_ERROR,
                IntegratePhase.INITIALIZATION,
                0.0,
                f"Unexpected error: {e!s}",
                start_time,
            )

    def _create_error_response(
        self,
        result: IntegrateResult,
        phase: IntegratePhase,
        progress: float,
        error_message: str,
        start_time: datetime,
    ) -> IntegrateVisualizationResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

        return IntegrateVisualizationResponse(
            result=result,
            visualization_state=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )