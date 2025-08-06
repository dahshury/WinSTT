"""Setup UI Layout Use Case

This module implements the SetupUILayoutUseCase for configuring and managing
UI layout components, arrangements, and responsive design.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any, Protocol

from src_refactored.domain.main_window.value_objects.ui_layout import (
    ComponentRole,
    SetupPhase,
    SetupResult,
)
from src_refactored.domain.window_management.value_objects import LayoutType


class AlignmentType(Enum):
    """Enumeration of alignment types."""
    LEFT = "left"
    RIGHT = "right"
    CENTER = "center"
    TOP = "top"
    BOTTOM = "bottom"
    MIDDLE = "middle"
    STRETCH = "stretch"
    JUSTIFY = "justify"


class SizePolicy(Enum):
    """Enumeration of size policies."""
    FIXED = "fixed"
    MINIMUM = "minimum"
    MAXIMUM = "maximum"
    PREFERRED = "preferred"
    EXPANDING = "expanding"
    MINIMUM_EXPANDING = "minimum_expanding"
    IGNORED = "ignored"


@dataclass
class LayoutConstraints:
    """Configuration for layout constraints."""
    margins: tuple[int, int, int, int] = (0, 0, 0, 0)  # top, right, bottom, left
    spacing: int = 0
    alignment: AlignmentType = AlignmentType.STRETCH
    size_policy_horizontal: SizePolicy = SizePolicy.PREFERRED
    size_policy_vertical: SizePolicy = SizePolicy.PREFERRED
    minimum_size: tuple[int, int] | None = None
    maximum_size: tuple[int, int] | None = None
    stretch_factor: int = 0
    row_span: int = 1
    column_span: int = 1
    row_position: int = 0
    column_position: int = 0


@dataclass
class ComponentLayoutInfo:
    """Information about component layout configuration."""
    component: Any  # QWidget
    role: ComponentRole
    layout_type: LayoutType
    constraints: LayoutConstraints
    parent_layout: Any | None = None
    child_layouts: list[Any] = field(default_factory=list)
    visible: bool = True
    enabled: bool = True
    z_order: int = 0

    def __post_init__(self,
    ):
        if self.child_layouts is None:
            self.child_layouts = []


@dataclass
class ResponsiveConfiguration:
    """Configuration for responsive layout behavior."""
    enable_responsive: bool = True
    breakpoints: dict[str, int] = field(default_factory=lambda: {"small": 600, "medium": 900, "large": 1200})  # {"small": 600, "medium": 900, "large": 1200}
    layout_variants: dict[str, LayoutType] = field(default_factory=dict)  # {"small": LayoutType.VERTICAL_BOX}
    component_visibility: dict[str, dict[ComponentRole, bool]] = field(default_factory=dict)
    size_adjustments: dict[str, dict[str, Any]] = field(default_factory=dict)

    def __post_init__(self):
        if self.breakpoints is None:
            self.breakpoints = {"small": 600, "medium": 900, "large": 1200}
        if self.layout_variants is None:
            self.layout_variants = {}
        if self.component_visibility is None:
            self.component_visibility = {}
        if self.size_adjustments is None:
            self.size_adjustments = {}


@dataclass
class SetupUILayoutRequest:
    """Request for setting up UI layout."""
    parent_widget: Any  # QWidget
    layout_type: LayoutType
    component_infos: list[ComponentLayoutInfo]
    responsive_config: ResponsiveConfiguration | None = None
    global_constraints: LayoutConstraints | None = None
    validate_constraints: bool = True
    apply_immediately: bool = True
    context_data: dict[str, Any] | None = None
    timestamp: datetime = field(default_factory=datetime.now(UTC))

    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.now(UTC)
        if self.context_data is None:
            self.context_data = {}
        if self.global_constraints is None:
            self.global_constraints = LayoutConstraints()


@dataclass
class LayoutArrangementResult:
    """Result of layout arrangement operation."""
    component_role: ComponentRole
    component: Any
    arrangement_successful: bool
    layout_assigned: Any | None = None
    constraints_applied: bool = False
    error_message: str | None = None
    execution_time_ms: float = 0.0


@dataclass
class UILayoutState:
    """Current state of UI layout."""
    parent_widget: Any
    main_layout: Any
    layout_type: LayoutType
    component_arrangements: dict[ComponentRole, LayoutArrangementResult]
    responsive_config: ResponsiveConfiguration | None
    current_breakpoint: str | None
    layout_valid: bool
    setup_time: datetime
    last_update_time: datetime

    def __post_init__(self):
        if not hasattr(self, "component_arrangements"):
            self.component_arrangements = {}


@dataclass
class SetupUILayoutResponse:
    """Response from UI layout setup."""
    result: SetupResult
    layout_state: UILayoutState | None
    current_phase: SetupPhase
    progress_percentage: float
    arrangement_results: list[LayoutArrangementResult] = field(default_factory=list)
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    execution_time_ms: float = 0.0

    def __post_init__(self):
        if self.arrangement_results is None:
            self.arrangement_results = []
        if self.warnings is None:
            self.warnings = []


class LayoutValidationServiceProtocol(Protocol,
    ):
    """Protocol for layout validation operations."""

    def validate_layout_type_compatibility(self, parent: Any, layout_type: LayoutType,
    ) -> list[str]:
        """Validate layout type compatibility with parent."""
        ...

    def validate_component_constraints(self, component: Any, constraints: LayoutConstraints,
    ) -> list[str]:
        """Validate component layout constraints."""
        ...

    def validate_layout_hierarchy(self, component_infos: list[ComponentLayoutInfo]) -> list[str]:
        """Validate layout hierarchy and dependencies."""
        ...

    def validate_responsive_configuration(self, config: ResponsiveConfiguration,
    ) -> list[str]:
        """Validate responsive configuration."""
        ...


class LayoutFactoryServiceProtocol(Protocol):
    """Protocol for layout factory operations."""

    def create_layout(self, layout_type: LayoutType, parent: Any,
    ) -> Any:
        """Create layout of specified type."""
        ...

    def configure_layout_properties(self, layout: Any, constraints: LayoutConstraints,
    ) -> bool:
        """Configure layout properties and constraints."""
        ...

    def clone_layout(self, source_layout: Any, new_parent: Any,
    ) -> Any:
        """Clone existing layout for new parent."""
        ...


class ComponentArrangementServiceProtocol(Protocol):
    """Protocol for component arrangement operations."""

    def add_component_to_layout(self,
    layout: Any, component: Any, constraints: LayoutConstraints, role: ComponentRole,
    ) -> bool:
        """Add component to layout with constraints."""
        ...

    def remove_component_from_layout(self, layout: Any, component: Any,
    ) -> bool:
        """Remove component from layout."""
        ...

    def rearrange_components(self, layout: Any, arrangement_map: dict[ComponentRole, int]) -> bool:
        """Rearrange components in layout."""
        ...

    def update_component_constraints(self, layout: Any, component: Any, constraints: LayoutConstraints,
    ) -> bool:
        """Update component constraints in layout."""
        ...


class ResponsiveLayoutServiceProtocol(Protocol):
    """Protocol for responsive layout operations."""

    def setup_responsive_behavior(self, parent: Any, config: ResponsiveConfiguration,
    ) -> bool:
        """Setup responsive layout behavior."""
        ...

    def detect_current_breakpoint(self, parent: Any, breakpoints: dict[str, int]) -> str:
        """Detect current breakpoint based on parent size."""
        ...

    def apply_breakpoint_layout(self, parent: Any, breakpoint: str, config: ResponsiveConfiguration,
    ) -> bool:
        """Apply layout configuration for specific breakpoint."""
        ...

    def register_resize_handler(self, parent: Any, handler: Any,
    ) -> bool:
        """Register resize event handler for responsive updates."""
        ...


class LayoutOptimizationServiceProtocol(Protocol):
    """Protocol for layout optimization operations."""

    def optimize_layout_performance(self, layout: Any,
    ) -> dict[str, Any]:
        """Optimize layout for better performance."""
        ...

    def calculate_optimal_sizes(
    self,
    layout: Any,
    components: list[Any]) -> dict[Any, tuple[int, int]]:
        """Calculate optimal sizes for components."""
        ...

    def validate_layout_efficiency(self, layout: Any,
    ) -> list[str]:
        """Validate layout efficiency and suggest improvements."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress_session(self, session_id: str, total_phases: int,
    ) -> None:
        """Start a new progress tracking session."""
        ...

    def update_progress(self, session_id: str, phase: SetupPhase, percentage: float,
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


class SetupUILayoutUseCase:
    """Use case for setting up UI layout with components and responsive behavior."""

    def __init__(
        self,
        validation_service: LayoutValidationServiceProtocol,
        layout_factory_service: LayoutFactoryServiceProtocol,
        arrangement_service: ComponentArrangementServiceProtocol,
        responsive_service: ResponsiveLayoutServiceProtocol,
        optimization_service: LayoutOptimizationServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.validation_service = validation_service
        self.layout_factory_service = layout_factory_service
        self.arrangement_service = arrangement_service
        self.responsive_service = responsive_service
        self.optimization_service = optimization_service
        self.progress_service = progress_service
        self.logger_service = logger_service

    def execute(self, request: SetupUILayoutRequest,
    ) -> SetupUILayoutResponse:
        """Execute the UI layout setup."""
        start_time = datetime.now(UTC)
        session_id = f"setup_ui_layout_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 7)
            self.progress_service.update_progress(session_id, SetupPhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting UI layout setup",
                {
                    "layout_type": request.layout_type.value,
                    "component_count": len(request.component_infos),
                    "responsive_enabled": request.responsive_config is not None,
                    "parent_widget": str(request.parent_widget),
                },
            )

            # Phase 2: Validation
            self.progress_service.update_progress(session_id, SetupPhase.VALIDATION, 14.3)

            # Validate layout type compatibility
            layout_errors = self.validation_service.validate_layout_type_compatibility(
                request.parent_widget,
                request.layout_type,
            )
            if layout_errors:
                return self._create_error_response(
                    SetupResult.VALIDATION_ERROR,
                    SetupPhase.VALIDATION,
                    14.3,
                    f"Layout type validation failed: {'; '.join(layout_errors)}",
                    start_time,
                )

            # Validate component constraints
            constraint_errors = []
            for component_info in request.component_infos:
                if request.validate_constraints:
                    errors = self.validation_service.validate_component_constraints(
                        component_info.component,
                        component_info.constraints,
                    )
                    constraint_errors.extend(errors)

            if constraint_errors:
                return self._create_error_response(
                    SetupResult.CONSTRAINT_VALIDATION_FAILED,
                    SetupPhase.VALIDATION,
                    14.3,
                    f"Constraint validation failed: {'; '.join(constraint_errors)}",
                    start_time,
                )

            # Validate layout hierarchy
            hierarchy_errors = self.validation_service.validate_layout_hierarchy(request.component_infos)
            if hierarchy_errors:
                self.logger_service.log_warning(
                    "Layout hierarchy validation issues",
                    {"errors": hierarchy_errors},
                )

            # Validate responsive configuration
            responsive_errors = []
            if request.responsive_config:
                responsive_errors = self.validation_service.validate_responsive_configuration(
                    request.responsive_config,
                )
                if responsive_errors:
                    self.logger_service.log_warning(
                        "Responsive configuration validation issues",
                        {"errors": responsive_errors},
                    )

            # Phase 3: Layout Creation
            self.progress_service.update_progress(session_id, SetupPhase.LAYOUT_CREATION, 28.6)

            try:
                # Create main layout
                main_layout = self.layout_factory_service.create_layout(
                    request.layout_type,
                    request.parent_widget,
                )

                if not main_layout:
                    return self._create_error_response(
                        SetupResult.LAYOUT_CREATION_FAILED,
                        SetupPhase.LAYOUT_CREATION,
                        28.6,
                        "Failed to create main layout",
                        start_time,
                    )

                # Configure layout properties
                if not self.layout_factory_service.configure_layout_properties(
                    main_layout,
                    request.global_constraints,
                ):
                    self.logger_service.log_warning(
                        "Failed to configure some layout properties",
                        {"layout_type": request.layout_type.value},
                    )

                # Set layout to parent widget
                if hasattr(request.parent_widget, "setLayout"):
                    request.parent_widget.setLayout(main_layout)
                elif hasattr(request.parent_widget, "setCentralWidget") and hasattr(main_layout, "parentWidget"):
                    # For QMainWindow, create a central widget with the layout
                    central_widget = main_layout.parentWidget()
                    if central_widget:
                        request.parent_widget.setCentralWidget(central_widget)

            except Exception as e:
                return self._create_error_response(
                    SetupResult.LAYOUT_CREATION_FAILED,
                    SetupPhase.LAYOUT_CREATION,
                    28.6,
                    f"Layout creation failed: {e!s}",
                    start_time,
                )

            # Phase 4: Component Arrangement
            self.progress_service.update_progress(session_id, SetupPhase.COMPONENT_ARRANGEMENT, 42.9)

            arrangement_results = []
            arrangement_failures = []

            # Sort components by z-order and role priority
            sorted_components = sorted(
                request.component_infos,
                key=lambda x: (x.z_order, x.role.value),
            )

            for component_info in sorted_components:
                arrangement_start = datetime.now(UTC)

                try:
                    # Add component to layout
                    success = self.arrangement_service.add_component_to_layout(
                        main_layout,
                        component_info.component,
                        component_info.constraints,
                        component_info.role,
                    )

                    arrangement_time = (datetime.now(UTC) - arrangement_start).total_seconds() * 1000

                    if success:
                        # Update component constraints if needed
                        constraints_applied = self.arrangement_service.update_component_constraints(
                            main_layout,
                            component_info.component,
                            component_info.constraints,
                        )

                        arrangement_results.append(LayoutArrangementResult(
                            component_role=component_info.role,
                            component=component_info.component,
                            arrangement_successful=True,
                            layout_assigned=main_layout,
                            constraints_applied=constraints_applied,
                            execution_time_ms=arrangement_time,
                        ))

                        # Set component visibility and enabled state
                        if hasattr(component_info.component, "setVisible"):
                            component_info.component.setVisible(component_info.visible)
                        if hasattr(component_info.component, "setEnabled"):
                            component_info.component.setEnabled(component_info.enabled)

                    else:
                        error_msg = f"Failed to arrange component {component_info.role.value}"
                        arrangement_failures.append(error_msg)

                        arrangement_results.append(LayoutArrangementResult(
                            component_role=component_info.role,
                            component=component_info.component,
                            arrangement_successful=False,
                            error_message=error_msg,
                            execution_time_ms=arrangement_time,
                        ))

                except Exception as e:
                    error_msg = f"Component arrangement failed for {component_info.role.value}: {e!s}"
                    arrangement_failures.append(error_msg)

                    arrangement_time = (datetime.now(UTC) - arrangement_start).total_seconds() * 1000
                    arrangement_results.append(LayoutArrangementResult(
                        component_role=component_info.role,
                        component=component_info.component,
                        arrangement_successful=False,
                        error_message=error_msg,
                        execution_time_ms=arrangement_time,
                    ))

            # Check if critical arrangements failed
            if arrangement_failures:
                self.logger_service.log_warning(
                    "Some component arrangements failed",
                    {"failures": arrangement_failures},
                )

            # Phase 5: Constraint Application
            self.progress_service.update_progress(session_id, SetupPhase.CONSTRAINT_APPLICATION, 57.2)

            # Apply additional constraints and optimizations
            try:
                # Calculate optimal sizes
                components = [info.component for info in request.component_infos if info.component]
                optimal_sizes = self.optimization_service.calculate_optimal_sizes(main_layout, components)

                # Apply optimal sizes
                for component, (width, height) in optimal_sizes.items():
                    if hasattr(component, "resize"):
                        component.resize(width, height)

                # Optimize layout performance
                optimization_results = self.optimization_service.optimize_layout_performance(main_layout)
                if optimization_results:
                    self.logger_service.log_info(
                        "Layout optimization applied",
                        {"optimizations": optimization_results},
                    )

                # Validate layout efficiency
                efficiency_warnings = self.optimization_service.validate_layout_efficiency(main_layout)
                if efficiency_warnings:
                    self.logger_service.log_warning(
                        "Layout efficiency warnings",
                        {"warnings": efficiency_warnings},
                    )

            except Exception as e:
                self.logger_service.log_warning(
                    f"Constraint application issues: {e!s}",
                    {"layout_type": request.layout_type.value},
                )

            # Phase 6: Responsive Configuration
            self.progress_service.update_progress(session_id, SetupPhase.RESPONSIVE_CONFIGURATION, 71.5)

            current_breakpoint = None
            responsive_setup_success = True

            if request.responsive_config and request.responsive_config.enable_responsive:
                try:
                    # Setup responsive behavior
                    if not self.responsive_service.setup_responsive_behavior(
                        request.parent_widget,
                        request.responsive_config,
                    ):
                        responsive_setup_success = False
                        self.logger_service.log_warning(
                            "Failed to setup responsive behavior",
                            {"layout_type": request.layout_type.value},
                        )

                    # Detect current breakpoint
                    current_breakpoint = self.responsive_service.detect_current_breakpoint(
                        request.parent_widget,
                        request.responsive_config.breakpoints,
                    )

                    # Apply initial breakpoint layout
                    if current_breakpoint and not self.responsive_service.apply_breakpoint_layout(
                        request.parent_widget,
                        current_breakpoint,
                        request.responsive_config,
                    ):
                        self.logger_service.log_warning(
                            f"Failed to apply initial breakpoint layout: {current_breakpoint}",
                            {"layout_type": request.layout_type.value},
                        )

                    # Register resize handler for future responsive updates
                    if not self.responsive_service.register_resize_handler(
                        request.parent_widget,
                        None,  # Handler would be provided by the service
                    ):
                        self.logger_service.log_warning(
                            "Failed to register resize handler for responsive updates",
                            {"layout_type": request.layout_type.value},
                        )

                except Exception as e:
                    responsive_setup_success = False
                    self.logger_service.log_error(
                        f"Responsive configuration failed: {e!s}",
                        {"layout_type": request.layout_type.value},
                    )

            # Phase 7: Finalization
            self.progress_service.update_progress(session_id, SetupPhase.FINALIZATION, 85.8)

            # Create component arrangements map
            component_arrangements = {
                result.component_role: result
                for result in arrangement_results
            }

            # Validate final layout
            layout_valid = True
            try:
                # Final layout validation
                final_validation_errors = self.validation_service.validate_layout_hierarchy(
                    request.component_infos,
                )
                if final_validation_errors:
                    layout_valid = False
                    self.logger_service.log_warning(
                        "Final layout validation issues",
                        {"errors": final_validation_errors},
                    )

            except Exception as e:
                layout_valid = False
                self.logger_service.log_warning(
                    f"Final layout validation failed: {e!s}",
                    {"layout_type": request.layout_type.value},
                )

            # Create layout state
            layout_state = UILayoutState(
                parent_widget=request.parent_widget,
                main_layout=main_layout,
                layout_type=request.layout_type,
                component_arrangements=component_arrangements,
                responsive_config=request.responsive_config,
                current_breakpoint=current_breakpoint,
                layout_valid=layout_valid,
                setup_time=start_time,
                last_update_time=datetime.now(UTC),
            )

            self.progress_service.update_progress(session_id, SetupPhase.FINALIZATION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            execution_time = (datetime.now(UTC) - start_time).total_seconds() * 1000

            # Determine result
            if arrangement_failures and not any(result.arrangement_successful for result in arrangement_results):
                result = SetupResult.COMPONENT_ARRANGEMENT_FAILED
            elif not responsive_setup_success and request.responsive_config:
                result = SetupResult.RESPONSIVE_SETUP_FAILED
            elif not layout_valid:
                result = SetupResult.VALIDATION_ERROR
            else:
                result = SetupResult.SUCCESS

            # Collect warnings
            warnings = []
            warnings.extend(hierarchy_errors)
            warnings.extend(responsive_errors)
            warnings.extend(arrangement_failures)
            if not responsive_setup_success and request.responsive_config:
                warnings.append("Responsive setup incomplete")
            if not layout_valid:
                warnings.append("Layout validation issues detected")

            self.logger_service.log_info(
                "UI layout setup completed",
                {
                    "layout_type": request.layout_type.value,
                    "result": result.value,
                    "execution_time_ms": execution_time,
                    "components_arranged": len([r for r in arrangement_results if r.arrangement_successful]),
                    "total_components": len(request.component_infos),
                    "responsive_enabled": request.responsive_config is not None,
                    "current_breakpoint": current_breakpoint,
                    "layout_valid": layout_valid,
                },
            )

            return SetupUILayoutResponse(
                result=result,
                layout_state=layout_state,
                current_phase=SetupPhase.FINALIZATION,
                progress_percentage=100.0,
                arrangement_results=arrangement_results,
                warnings=warnings,
                execution_time_ms=execution_time,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during UI layout setup",
                {"error": str(e)},
            )

            return self._create_error_response(
                SetupResult.INTERNAL_ERROR,
                SetupPhase.INITIALIZATION,
                0.0,
                f"Unexpected error: {e!s}",
                start_time,
            )

    def _create_error_response(
        self,
        result: SetupResult,
        phase: SetupPhase,
        progress: float,
        error_message: str,
        start_time: datetime,
    ) -> SetupUILayoutResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.now(UTC) - start_time).total_seconds() * 1000

        return SetupUILayoutResponse(
            result=result,
            layout_state=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )