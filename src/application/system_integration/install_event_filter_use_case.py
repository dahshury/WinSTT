"""Install Event Filter Use Case.

This module implements the InstallEventFilterUseCase for installing event filters
with system integration and comprehensive event handling.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from src.domain.system_integration.value_objects.system_operations import (
    EventType,
    FilterType,
    InstallPhase,
    InstallResult,
)


class FilterScope(Enum):
    """Scope of event filter application."""
    WIDGET_ONLY = "widget_only"
    WINDOW_ONLY = "window_only"
    APPLICATION_WIDE = "application_wide"
    SYSTEM_WIDE = "system_wide"
    GLOBAL_SCOPE = "global_scope"


class FilterPriority(Enum):
    """Priority levels for event filters."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"
    SYSTEM = "system"


class FilterMode(Enum):
    """Event filter processing modes."""
    PASSIVE = "passive"  # Monitor only
    ACTIVE = "active"    # Can modify events
    BLOCKING = "blocking" # Can block events
    INTERCEPTING = "intercepting" # Can intercept and redirect


@dataclass
class EventFilterConfiguration:
    """Configuration for an event filter."""
    filter_id: str
    filter_type: FilterType
    filter_name: str
    event_types: list[EventType]
    filter_scope: FilterScope
    filter_priority: FilterPriority
    filter_mode: FilterMode
    filter_function: Callable[[Any], bool]
    target_widget: Any | None = None
    enabled: bool = True
    auto_install: bool = True
    persistent: bool = False
    description: str | None = None


@dataclass
class SystemIntegrationConfiguration:
    """Configuration for system integration."""
    enable_global_hooks: bool = False
    enable_low_level_hooks: bool = False
    hook_timeout: float = 5.0
    permission_elevation: bool = False
    system_event_handling: bool = True
    cross_process_events: bool = False
    security_validation: bool = True


@dataclass
class EventBindingConfiguration:
    """Configuration for event binding."""
    bind_immediately: bool = True
    cascade_events: bool = True
    event_propagation: bool = True
    error_handling: bool = True
    performance_monitoring: bool = False
    debug_logging: bool = False


@dataclass
class TestingConfiguration:
    """Configuration for filter testing."""
    enable_testing: bool = True
    test_events: list[str] = field(default_factory=list)
    test_timeout: float = 10.0
    validate_responses: bool = True
    performance_testing: bool = False
    stress_testing: bool = False

    def __post_init__(self,
    ):
        if self.test_events is None:
            self.test_events = []


@dataclass
class InstallEventFilterRequest:
    """Request for event filter installation."""
    filter_configs: list[EventFilterConfiguration]
    system_config: SystemIntegrationConfiguration
    binding_config: EventBindingConfiguration
    testing_config: TestingConfiguration
    target_application: Any
    enable_logging: bool = True
    enable_progress_tracking: bool = True
    installation_timeout: float = 30.0


@dataclass
class FilterInstallationResult:
    """Result of individual filter installation."""
    filter_id: str
    filter_installed: bool
    filter_active: bool
    filter_object: Any | None = None
    events_bound: int = 0
    error_message: str | None = None
    installation_time: float = 0.0
    test_results: dict[str, bool] | None = None

    def __post_init__(self):
        if self.test_results is None:
            self.test_results = {}


@dataclass
class SystemIntegrationResult:
    """Result of system integration setup."""
    integration_successful: bool
    global_hooks_installed: bool
    low_level_hooks_installed: bool
    permissions_elevated: bool
    system_events_enabled: bool
    cross_process_enabled: bool
    security_validated: bool


@dataclass
class EventBindingResult:
    """Result of event binding setup."""
    binding_successful: bool
    events_bound: int
    cascading_enabled: bool
    propagation_enabled: bool
    error_handling_enabled: bool
    monitoring_enabled: bool


@dataclass
class TestingResult:
    """Result of filter testing."""
    testing_completed: bool
    tests_passed: int
    tests_failed: int
    performance_metrics: dict[str, float] | None = None
    stress_test_passed: bool = False
    validation_successful: bool = False

    def __post_init__(self):
        if self.performance_metrics is None:
            self.performance_metrics = {}


@dataclass
class EventFilterState:
    """Current state of event filter installation."""
    current_phase: InstallPhase
    filter_results: list[FilterInstallationResult] = field(default_factory=list)
    system_integration: SystemIntegrationResult | None = None
    event_binding: EventBindingResult | None = None
    testing_result: TestingResult | None = None
    active_filters: int = 0
    failed_filters: int = 0
    error_message: str | None = None

    def __post_init__(self,
    ):
        if self.filter_results is None:
            self.filter_results = []


@dataclass
class InstallEventFilterResponse:
    """Response from event filter installation."""
    result: InstallResult
    state: EventFilterState
    filter_manager: Any | None = None
    system_integrator: Any | None = None
    event_dispatcher: Any | None = None
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    execution_time: float = 0.0
    phase_times: dict[InstallPhase, float] = field(default_factory=dict)

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []
        if self.phase_times is None:
            self.phase_times = {}


class FilterValidationServiceProtocol(Protocol):
    """Protocol for event filter validation service."""

    def validate_filter_configuration(self, config: EventFilterConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate filter configuration."""
        ...

    def validate_system_configuration(self, config: SystemIntegrationConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate system integration configuration."""
        ...

    def validate_permissions(self, config: SystemIntegrationConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate system permissions."""
        ...

    def check_filter_conflicts(
    self,
    configs: list[EventFilterConfiguration]) -> tuple[bool, str | None]:
        """Check for filter conflicts."""
        ...


class FilterCreationServiceProtocol(Protocol):
    """Protocol for filter creation service."""

    def create_filter(self, config: EventFilterConfiguration,
    ) -> tuple[bool, Any, str | None]:
        """Create an event filter."""
        ...

    def configure_filter_priority(self, filter_obj: Any, priority: FilterPriority,
    ) -> tuple[bool, str | None]:
        """Configure filter priority."""
        ...

    def set_filter_scope(self, filter_obj: Any, scope: FilterScope,
    ) -> tuple[bool, str | None]:
        """Set filter scope."""
        ...


class SystemIntegrationServiceProtocol(Protocol):
    """Protocol for system integration service."""

    def setup_system_integration(self, config: SystemIntegrationConfiguration,
    ) -> tuple[bool, Any, str | None]:
        """Setup system integration."""
        ...

    def install_global_hooks(self, config: SystemIntegrationConfiguration,
    ) -> tuple[bool, str | None]:
        """Install global event hooks."""
        ...

    def elevate_permissions(self) -> tuple[bool, str | None]:
        """Elevate system permissions if needed."""
        ...

    def validate_security(self, filters: list[Any]) -> tuple[bool, str | None]:
        """Validate security for filters."""
        ...


class EventBindingServiceProtocol(Protocol):
    """Protocol for event binding service."""

    def bind_events(self, filters: list[Any], config: EventBindingConfiguration,
    ) -> tuple[bool, Any, str | None]:
        """Bind events to filters."""
        ...

    def setup_event_cascading(self, filters: list[Any]) -> tuple[bool, str | None]:
        """Setup event cascading."""
        ...

    def configure_propagation(self, filters: list[Any], enabled: bool,
    ) -> tuple[bool, str | None]:
        """Configure event propagation."""
        ...

    def install_error_handling(self, filters: list[Any]) -> tuple[bool, str | None]:
        """Install error handling for events."""
        ...


class FilterTestingServiceProtocol(Protocol):
    """Protocol for filter testing service."""

    def test_filters(self,
    filters: list[Any], config: TestingConfiguration,
    ) -> tuple[bool, dict[str, Any], str | None]:
        """Test installed filters."""
        ...

    def run_performance_tests(
    self,
    filters: list[Any]) -> tuple[bool, dict[str, float], str | None]:
        """Run performance tests on filters."""
        ...

    def validate_filter_responses(
    self,
    filters: list[Any]) -> tuple[bool, dict[str, bool], str | None]:
        """Validate filter responses."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def start_progress(self, total_phases: int,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, phase: InstallPhase, progress: float,
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


class InstallEventFilterUseCase:
    """Use case for installing event filters with system integration."""

    def __init__(
        self,
        filter_validation_service: FilterValidationServiceProtocol,
        filter_creation_service: FilterCreationServiceProtocol,
        system_integration_service: SystemIntegrationServiceProtocol,
        event_binding_service: EventBindingServiceProtocol,
        filter_testing_service: FilterTestingServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol | None = None,
        logger_service: LoggerServiceProtocol | None = None,
    ):
        self._filter_validation_service = filter_validation_service
        self._filter_creation_service = filter_creation_service
        self._system_integration_service = system_integration_service
        self._event_binding_service = event_binding_service
        self._filter_testing_service = filter_testing_service
        self._progress_tracking_service = progress_tracking_service
        self._logger_service = logger_service

    def execute(self, request: InstallEventFilterRequest,
    ) -> InstallEventFilterResponse:
        """Execute event filter installation."""
        start_time = time.time()
        phase_times = {}

        state = EventFilterState(current_phase=InstallPhase.INITIALIZATION)
        warnings = []
        created_filters = []

        try:
            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.start_progress(len(InstallPhase))

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Starting event filter installation",
                    filter_count=len(request.filter_configs),
                )

            # Phase 1: Validation
            phase_start = time.time()
            state.current_phase = InstallPhase.VALIDATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InstallPhase.VALIDATION, 0.0)

            # Validate system configuration
            system_valid, system_error = self._filter_validation_service.validate_system_configuration(
                request.system_config,
            )
            if not system_valid:
                state.error_message = f"Invalid system configuration: {system_error}"
                return InstallEventFilterResponse(
                    result=InstallResult.VALIDATION_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            # Validate permissions
            permissions_valid, permissions_error = self._filter_validation_service.validate_permissions(
                request.system_config,
            )
            if not permissions_valid:
                state.error_message = f"Insufficient permissions: {permissions_error}"
                return InstallEventFilterResponse(
                    result=InstallResult.SYSTEM_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            # Validate filter configurations
            for config in request.filter_configs:
                config_valid, config_error = self._filter_validation_service.validate_filter_configuration(config)
                if not config_valid:
                    state.error_message = f"Invalid filter configuration for {config.filter_id}: {config_error}"
                    return InstallEventFilterResponse(
                        result=InstallResult.VALIDATION_ERROR,
                        state=state,
                        error_message=state.error_message,
                        execution_time=time.time() - start_time,
                    )

            # Check for filter conflicts
            conflicts_valid, conflicts_error = self._filter_validation_service.check_filter_conflicts(
                request.filter_configs,
            )
            if not conflicts_valid:
                warnings.append(f"Filter conflicts detected: {conflicts_error}")

            phase_times[InstallPhase.VALIDATION] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InstallPhase.VALIDATION, 1.0)

            # Phase 2: Filter Creation
            phase_start = time.time()
            state.current_phase = InstallPhase.FILTER_CREATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InstallPhase.FILTER_CREATION, 0.0)

            for i, config in enumerate(request.filter_configs):
                filter_start_time = time.time()

                # Create filter
                filter_created, filter_obj, filter_error = self._filter_creation_service.create_filter(config)

                result = FilterInstallationResult(
                    filter_id=config.filter_id,
                    filter_installed=filter_created,
                    filter_active=False,
                    filter_object=filter_obj,
                    error_message=filter_error,
                    installation_time=time.time() - filter_start_time,
                )

                if filter_created and filter_obj:
                    created_filters.append(filter_obj)

                    # Configure filter priority
                    priority_set, priority_error = self._filter_creation_service.configure_filter_priority(
                        filter_obj, config.filter_priority,
                    )
                    if not priority_set and priority_error:
                        warnings.append(f"Failed to set priority for {config.filter_id}: {priority_error}")

                    # Set filter scope
                    scope_set, scope_error = self._filter_creation_service.set_filter_scope(
                        filter_obj, config.filter_scope,
                    )
                    if not scope_set and scope_error:
                        warnings.append(f"Failed to set scope for {config.filter_id}: {scope_error}")

                    state.active_filters += 1
                else:
                    state.failed_filters += 1

                state.filter_results.append(result)

                if request.enable_progress_tracking and self._progress_tracking_service:
                    progress = (i + 1) / len(request.filter_configs)
                    self._progress_tracking_service.update_progress(InstallPhase.FILTER_CREATION, progress)

            # Check if any filters were created successfully
            if not created_filters:
                state.error_message = "Failed to create any event filters"
                return InstallEventFilterResponse(
                    result=InstallResult.FILTER_ERROR,
                    state=state,
                    error_message=state.error_message,
                    warnings=warnings,
                    execution_time=time.time() - start_time,
                    phase_times=phase_times,
                )

            phase_times[InstallPhase.FILTER_CREATION] = time.time() - phase_start

            # Phase 3: System Integration
            phase_start = time.time()
            state.current_phase = InstallPhase.SYSTEM_REGISTRATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InstallPhase.SYSTEM_REGISTRATION, 0.0)

            # Setup system integration
            integration_setup, integrator, integration_error = self._system_integration_service.setup_system_integration(
                request.system_config,
            )
            if not integration_setup:
                warnings.append(f"Failed to setup system integration: {integration_error}")

            # Elevate permissions if needed
            permissions_elevated = False
            if request.system_config.permission_elevation:
                elevated, elevation_error = self._system_integration_service.elevate_permissions()
                if not elevated:
                    warnings.append(f"Failed to elevate permissions: {elevation_error}")
                else:
                    permissions_elevated = True

            # Install global hooks if needed
            global_hooks_installed = False
            if request.system_config.enable_global_hooks:
                hooks_installed, hooks_error = self._system_integration_service.install_global_hooks(
                    request.system_config,
                )
                if not hooks_installed:
                    warnings.append(f"Failed to install global hooks: {hooks_error}")
                else:
                    global_hooks_installed = True

            # Validate security
            security_validated = False
            if request.system_config.security_validation:
                security_valid, security_error = self._system_integration_service.validate_security(created_filters)
                if not security_valid:
                    warnings.append(f"Security validation failed: {security_error}")
                else:
                    security_validated = True

            state.system_integration = SystemIntegrationResult(
                integration_successful=integration_setup,
                global_hooks_installed=global_hooks_installed,
                low_level_hooks_installed=request.system_config.enable_low_level_hooks,
                permissions_elevated=permissions_elevated,
                system_events_enabled=request.system_config.system_event_handling,
                cross_process_enabled=request.system_config.cross_process_events,
                security_validated=security_validated,
            )

            phase_times[InstallPhase.SYSTEM_REGISTRATION] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InstallPhase.SYSTEM_REGISTRATION, 1.0)

            # Phase 4: Event Binding
            phase_start = time.time()
            state.current_phase = InstallPhase.EVENT_BINDING

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InstallPhase.EVENT_BINDING, 0.0)

            # Bind events
            events_bound, dispatcher, binding_error = self._event_binding_service.bind_events(
                created_filters, request.binding_config,
            )
            if not events_bound:
                warnings.append(f"Failed to bind events: {binding_error}")

            # Setup event cascading
            cascading_setup = False
            if request.binding_config.cascade_events:
                cascading_enabled, cascading_error = self._event_binding_service.setup_event_cascading(created_filters)
                if not cascading_enabled:
                    warnings.append(f"Failed to setup event cascading: {cascading_error}")
                else:
                    cascading_setup = True

            # Configure event propagation
            propagation_setup = False
            if request.binding_config.event_propagation:
                propagation_enabled, propagation_error = self._event_binding_service.configure_propagation(
                    created_filters, request.binding_config.event_propagation,
                )
                if not propagation_enabled:
                    warnings.append(f"Failed to configure event propagation: {propagation_error}")
                else:
                    propagation_setup = True

            # Install error handling
            error_handling_setup = False
            if request.binding_config.error_handling:
                error_handling_enabled, error_handling_error = self._event_binding_service.install_error_handling(
                    created_filters,
                )
                if not error_handling_enabled:
                    warnings.append(f"Failed to install error handling: {error_handling_error}")
                else:
                    error_handling_setup = True

            # Update filter results with binding information
            events_bound_count = 0
            for i, filter_result in enumerate(state.filter_results):
                if filter_result.filter_installed:
                    filter_result.filter_active = events_bound
                    filter_result.events_bound = len(request.filter_configs[i].event_types)
                    events_bound_count += filter_result.events_bound

            state.event_binding = EventBindingResult(
                binding_successful=events_bound,
                events_bound=events_bound_count,
                cascading_enabled=cascading_setup,
                propagation_enabled=propagation_setup,
                error_handling_enabled=error_handling_setup,
                monitoring_enabled=request.binding_config.performance_monitoring,
            )

            phase_times[InstallPhase.EVENT_BINDING] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InstallPhase.EVENT_BINDING, 1.0)

            # Phase 5: Testing
            phase_start = time.time()
            state.current_phase = InstallPhase.TESTING

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InstallPhase.TESTING, 0.0)

            testing_completed = False
            performance_metrics: dict[str, float] = {}
            validation_results: dict[str, bool] = {}

            if request.testing_config.enable_testing:
                # Test filters
                tests_passed, test_results, test_error = self._filter_testing_service.test_filters(
                    created_filters, request.testing_config,
                )
                if not tests_passed:
                    warnings.append(f"Filter testing failed: {test_error}")
                else:
                    testing_completed = True

                # Run performance tests
                if request.testing_config.performance_testing:
                    perf_passed, perf_metrics, perf_error = self._filter_testing_service.run_performance_tests(
                        created_filters,
                    )
                    if not perf_passed:
                        warnings.append(f"Performance testing failed: {perf_error}")
                    else:
                        performance_metrics = perf_metrics

                # Validate filter responses
                if request.testing_config.validate_responses:
                    validation_passed, validation_result, validation_error = self._filter_testing_service.validate_filter_responses(
                        created_filters,
                    )
                    if not validation_passed:
                        warnings.append(f"Response validation failed: {validation_error}")
                    elif isinstance(validation_result, dict):
                        # validation_result is expected to be mapping of filter_id -> passed(bool)
                        # Ensure type consistency
                        validation_results = {str(k): bool(v) for k, v in validation_result.items()}
                # If validate_responses is False, validation_results remains as initialized empty dict

                # Update filter results with test information
                for filter_result in state.filter_results:
                    if filter_result.filter_installed:
                        # Store a small structured result per filter
                        filter_passed = bool(validation_results.get(filter_result.filter_id, False))
                        filter_result.test_results = {"validated": filter_passed}

            state.testing_result = TestingResult(
                testing_completed=testing_completed,
                tests_passed=sum(1 for r in validation_results.values() if r),
                tests_failed=sum(1 for r in validation_results.values() if not r),
                performance_metrics=performance_metrics,
                stress_test_passed=bool(request.testing_config.stress_testing and testing_completed),
                validation_successful=bool(validation_results),
            )

            phase_times[InstallPhase.TESTING] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InstallPhase.TESTING, 1.0)

            # Phase 6: Finalization
            phase_start = time.time()
            state.current_phase = InstallPhase.FINALIZATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InstallPhase.FINALIZATION, 0.0)
                self._progress_tracking_service.complete_progress()

            phase_times[InstallPhase.FINALIZATION] = time.time() - phase_start

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "Event filter installation completed",
                    active_filters=state.active_filters,
                    failed_filters=state.failed_filters,
                    warnings_count=len(warnings),
                    execution_time=time.time() - start_time,
                )

            # Determine result
            if state.failed_filters == 0:
                final_result = InstallResult.SUCCESS if not warnings else InstallResult.PARTIAL_SUCCESS
            elif state.active_filters > 0:
                final_result = InstallResult.PARTIAL_SUCCESS
            else:
                final_result = InstallResult.FAILED

            return InstallEventFilterResponse(
                result=final_result,
                state=state,
                filter_manager=None,  # Would be created by a filter manager service
                system_integrator=integrator if integration_setup else None,
                event_dispatcher=dispatcher if events_bound else None,
                warnings=warnings,
                execution_time=time.time() - start_time,
                phase_times=phase_times,
            )

        except Exception as e:
            error_message = f"Unexpected error during event filter installation: {e!s}"
            state.error_message = error_message

            if request.enable_logging and self._logger_service:
                self._logger_service.log_error(
                    "Event filter installation failed",
                    error=str(e),
                    phase=state.current_phase.value,
                    execution_time=time.time() - start_time,
                )

            return InstallEventFilterResponse(
                result=InstallResult.FAILED,
                state=state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
                phase_times=phase_times,
            )