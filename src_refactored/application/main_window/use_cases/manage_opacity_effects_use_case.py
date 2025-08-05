"""Manage Opacity Effects Use Case.

This module implements the ManageOpacityEffectsUseCase for managing window opacity
effects during recording states with comprehensive validation and state management.
"""

from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

from src_refactored.domain.main_window.value_objects.opacity_effects import (
    EffectType,
    ManagePhase,
    ManageResult,
    OpacityMode,
)


class AnimationType(Enum):
    """Animation types for opacity effects."""
    LINEAR = "linear"
    EASE_IN = "ease_in"
    EASE_OUT = "ease_out"
    EASE_IN_OUT = "ease_in_out"
    BOUNCE = "bounce"
    ELASTIC = "elastic"


class StateTransition(Enum):
    """State transition types."""
    IMMEDIATE = "immediate"
    ANIMATED = "animated"
    DELAYED = "delayed"
    CONDITIONAL = "conditional"


@dataclass
class OpacityConfiguration:
    """Configuration for opacity effects."""
    mode: OpacityMode
    effect_type: EffectType
    opacity_value: float
    animation_type: AnimationType
    duration_ms: int
    transition_type: StateTransition
    auto_restore: bool = True
    loop_count: int = 1
    delay_ms: int = 0
    custom_properties: dict[str, Any] | None = None


@dataclass
class EffectTarget:
    """Target widget for opacity effects."""
    widget_id: str
    widget_type: str
    current_opacity: float
    target_opacity: float
    priority: int = 0
    constraints: dict[str, Any] | None = None


@dataclass
class AnimationConfiguration:
    """Configuration for opacity animations."""
    animation_type: AnimationType
    duration_ms: int
    easing_curve: str
    loop_behavior: str
    direction: str
    auto_reverse: bool = False
    custom_keyframes: list[dict[str, Any]] | None = None


@dataclass
class StateBackup:
    """Backup of widget states before opacity changes."""
    widget_states: dict[str, dict[str, Any]]
    timestamp: float
    backup_id: str
    metadata: dict[str, Any] | None = None


@dataclass
class ManageOpacityEffectsRequest:
    """Request for managing opacity effects."""
    operation_id: str
    opacity_config: OpacityConfiguration
    target_widgets: list[EffectTarget]
    animation_config: AnimationConfiguration | None = None
    validation_rules: dict[str, Any] | None = None
    progress_callback: Callable[[str, float], None] | None = None
    error_callback: Callable[[str, Exception], None] | None = None


@dataclass
class EffectApplication:
    """Result of applying opacity effects."""
    widget_id: str
    effect_applied: bool
    previous_opacity: float
    new_opacity: float
    animation_id: str | None = None
    error_message: str | None = None


@dataclass
class AnimationSetup:
    """Result of setting up animations."""
    animation_id: str
    animation_created: bool
    target_widgets: list[str]
    duration_ms: int
    status: str
    error_message: str | None = None


@dataclass
class OpacityEffectsState:
    """Current state of opacity effects management."""
    current_phase: ManagePhase
    active_effects: dict[str, EffectApplication]
    active_animations: dict[str, AnimationSetup]
    state_backup: StateBackup | None
    total_widgets: int
    processed_widgets: int
    errors: list[str]
    warnings: list[str]


@dataclass
class ManageOpacityEffectsResponse:
    """Response from opacity effects management operation."""
    result: ManageResult
    operation_id: str
    effects_applied: list[EffectApplication]
    animations_setup: list[AnimationSetup]
    state: OpacityEffectsState
    backup_created: bool
    execution_time_ms: float
    error_message: str | None = None
    warnings: list[str] = None


class WidgetValidationServiceProtocol(Protocol):
    """Protocol for widget validation operations."""

    def validate_widget_exists(self, widget_id: str,
    ) -> bool:
        """Validate that widget exists."""
        ...

    def validate_opacity_support(self, widget_id: str,
    ) -> bool:
        """Validate that widget supports opacity changes."""
        ...

    def validate_opacity_value(self, opacity: float,
    ) -> bool:
        """Validate opacity value range."""
        ...

    def get_widget_constraints(self, widget_id: str,
    ) -> dict[str, Any]:
        """Get widget-specific constraints."""
        ...


class StateBackupServiceProtocol(Protocol):
    """Protocol for state backup operations."""

    def create_backup(self, widget_ids: list[str]) -> StateBackup:
        """Create backup of widget states."""
        ...

    def restore_backup(self, backup: StateBackup,
    ) -> bool:
        """Restore widget states from backup."""
        ...

    def validate_backup(self, backup: StateBackup,
    ) -> bool:
        """Validate backup integrity."""
        ...


class OpacityManagementServiceProtocol(Protocol):
    """Protocol for opacity management operations."""

    def apply_opacity(self, widget_id: str, opacity: float,
    ) -> EffectApplication:
        """Apply opacity to widget."""
        ...

    def get_current_opacity(self, widget_id: str,
    ) -> float:
        """Get current widget opacity."""
        ...

    def supports_opacity_effects(self, widget_id: str,
    ) -> bool:
        """Check if widget supports opacity effects."""
        ...


class AnimationServiceProtocol(Protocol):
    """Protocol for animation operations."""

    def create_opacity_animation(
    self,
    config: AnimationConfiguration,
    targets: list[str]) -> AnimationSetup:
        """Create opacity animation."""
        ...

    def start_animation(self, animation_id: str,
    ) -> bool:
        """Start animation."""
        ...

    def stop_animation(self, animation_id: str,
    ) -> bool:
        """Stop animation."""
        ...

    def is_animation_running(self, animation_id: str,
    ) -> bool:
        """Check if animation is running."""
        ...


class EffectMonitoringServiceProtocol(Protocol):
    """Protocol for effect monitoring operations."""

    def start_monitoring(self, widget_ids: list[str]) -> bool:
        """Start monitoring opacity effects."""
        ...

    def stop_monitoring(self) -> bool:
        """Stop monitoring opacity effects."""
        ...

    def get_effect_status(self, widget_id: str,
    ) -> dict[str, Any]:
        """Get current effect status."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress(self, operation_id: str, total_steps: int,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, operation_id: str, current_step: int, message: str,
    ) -> None:
        """Update progress."""
        ...

    def complete_progress(self, operation_id: str,
    ) -> None:
        """Complete progress tracking."""
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logging operations."""

    def log_info(self, message: str, **kwargs) -> None:
        """Log info message."""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log warning message."""
        ...

    def log_error(self, message: str, error: Exception | None = None, **kwargs) -> None:
        """Log error message."""
        ...


class ManageOpacityEffectsUseCase:
    """Use case for managing window opacity effects during recording states.
    
    This use case handles:
    - Widget validation and opacity support checking
    - State backup and restoration
    - Opacity effect application with various modes
    - Animation setup and management
    - Effect monitoring and state tracking
    - Comprehensive error handling and recovery
    """

    def __init__(
        self,
        widget_validation_service: WidgetValidationServiceProtocol,
        state_backup_service: StateBackupServiceProtocol,
        opacity_management_service: OpacityManagementServiceProtocol,
        animation_service: AnimationServiceProtocol,
        effect_monitoring_service: EffectMonitoringServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self._widget_validation = widget_validation_service
        self._state_backup = state_backup_service
        self._opacity_management = opacity_management_service
        self._animation = animation_service
        self._effect_monitoring = effect_monitoring_service
        self._progress_tracking = progress_tracking_service
        self._logger = logger_service

    def execute(self, request: ManageOpacityEffectsRequest,
    ) -> ManageOpacityEffectsResponse:
        """Execute opacity effects management operation.
        
        Args:
            request: The opacity effects management request
            
        Returns:
            ManageOpacityEffectsResponse: The operation result
        """
        import time
        start_time = time.time()

        # Initialize state
        state = OpacityEffectsState(
            current_phase=ManagePhase.INITIALIZATION,
            active_effects={},
            active_animations={},
            state_backup=None,
            total_widgets=len(request.target_widgets)
            processed_widgets=0,
            errors=[],
            warnings=[],
        )

        effects_applied = []
        animations_setup = []
        backup_created = False

        try:
            self._logger.log_info(
                f"Starting opacity effects management for operation {request.operation_id}",
                operation_id=request.operation_id,
                target_count=len(request.target_widgets),
            )

            # Start progress tracking
            total_steps = 7  # Number of main phases
            self._progress_tracking.start_progress(request.operation_id, total_steps)

            # Phase 1: Validation
            state.current_phase = ManagePhase.VALIDATION
            self._progress_tracking.update_progress(request.operation_id, 1, "Validating widgets and configuration")

            validation_result = self._validate_request(request, state)
            if not validation_result:
                return self._create_error_response(
                    request.operation_id, ManageResult.VALIDATION_ERROR,
                    "Validation failed", state, effects_applied, animations_setup,
                    backup_created, time.time() - start_time,
                )

            # Phase 2: State Backup
            state.current_phase = ManagePhase.STATE_BACKUP
            self._progress_tracking.update_progress(request.operation_id, 2, "Creating state backup")

            backup_result = self._create_state_backup(request, state)
            if backup_result:
                backup_created = True
                self._logger.log_info("State backup created successfully",
    )

            # Phase 3: Effect Setup
            state.current_phase = ManagePhase.EFFECT_SETUP
            self._progress_tracking.update_progress(request.operation_id, 3, "Setting up opacity effects")

            setup_result = self._setup_effects(request, state)
            if not setup_result:
                return self._create_error_response(
                    request.operation_id, ManageResult.EFFECT_ERROR,
                    "Effect setup failed", state, effects_applied, animations_setup,
                    backup_created, time.time() - start_time,
                )

            # Phase 4: Opacity Application
            state.current_phase = ManagePhase.OPACITY_APPLICATION
            self._progress_tracking.update_progress(request.operation_id, 4, "Applying opacity effects")

            effects_applied = self._apply_opacity_effects(request, state)

            # Phase 5: Animation Setup
            state.current_phase = ManagePhase.ANIMATION_SETUP
            self._progress_tracking.update_progress(request.operation_id, 5, "Setting up animations")

            if request.animation_config:
                animations_setup = self._setup_animations(request, state)

            # Phase 6: State Monitoring
            state.current_phase = ManagePhase.STATE_MONITORING
            self._progress_tracking.update_progress(request.operation_id, 6, "Starting effect monitoring")

            monitoring_result = self._start_monitoring(request, state)
            if not monitoring_result:
                state.warnings.append("Effect monitoring could not be started")

            # Phase 7: Finalization
            state.current_phase = ManagePhase.FINALIZATION
            self._progress_tracking.update_progress(request.operation_id, 7, "Finalizing opacity effects")

            self._finalize_effects(request, state)

            # Complete progress tracking
            self._progress_tracking.complete_progress(request.operation_id)

            execution_time = (time.time() - start_time) * 1000

            self._logger.log_info(
                "Opacity effects management completed successfully",
                operation_id=request.operation_id,
                execution_time_ms=execution_time,
                effects_count=len(effects_applied)
                animations_count=len(animations_setup),
            )

            return ManageOpacityEffectsResponse(
                result=ManageResult.SUCCESS,
                operation_id=request.operation_id,
                effects_applied=effects_applied,
                animations_setup=animations_setup,
                state=state,
                backup_created=backup_created,
                execution_time_ms=execution_time,
                warnings=state.warnings if state.warnings else None,
            )

        except Exception as e:
            self._logger.log_error(
                f"Opacity effects management failed for operation {request.operation_id}",
                error=e,
                operation_id=request.operation_id,
            )

            # Attempt to restore from backup on failure
            if state.state_backup and backup_created:
                try:
                    self._state_backup.restore_backup(state.state_backup)
                    self._logger.log_info("State restored from backup after failure")
                except Exception as restore_error:
self._logger.log_error("Failed to restore state from backup", error = (
    restore_error))

            return self._create_error_response(
                request.operation_id, ManageResult.FAILED,
                str(e), state, effects_applied, animations_setup,
                backup_created, (time.time() - start_time) * 1000,
            )

    def _validate_request(self, request: ManageOpacityEffectsRequest, state: OpacityEffectsState,
    ) -> bool:
        """Validate the opacity effects management request."""
        try:
            # Validate opacity configuration
            if not (0.0 <= request.opacity_config.opacity_value <= 1.0):
                state.errors.append(f"Invalid opacity value: {request.opacity_config.opacity_value}"\
    )
                return False

            # Validate target widgets
            for target in request.target_widgets:
                if not self._widget_validation.validate_widget_exists(target.widget_id):
                    state.errors.append(f"Widget does not exist: {target.widget_id}")
                    return False

                if not self._widget_validation.validate_opacity_support(target.widget_id):
                    state.errors.append(f"Widget does not support opacity: {target.widget_id}")
                    return False

                if not self._widget_validation.validate_opacity_value(target.target_opacity):
                    state.errors.append(f"Invalid target opacity for widget {target.widget_id}: {tar\
    get.target_opacity}")
                    return False

            # Validate animation configuration if provided
            if request.animation_config:
                if request.animation_config.duration_ms <= 0:
                    state.errors.append(f"Invalid animation duration: {request.animation_config.dura\
    tion_ms}")
                    return False

            return True

        except Exception as e:
            self._logger.log_error("Validation failed", error=e)
            state.errors.append(f"Validation error: {e!s}")
            return False

    def _create_state_backup(self, request: ManageOpacityEffectsRequest, state: OpacityEffectsState,
    ) -> bool:
        """Create backup of current widget states."""
        try:
            widget_ids = [target.widget_id for target in request.target_widgets]
            backup = self._state_backup.create_backup(widget_ids,
    )
            state.state_backup = backup
            return True

        except Exception as e:
            self._logger.log_error("State backup creation failed", error=e)
            state.warnings.append(f"Could not create state backup: {e!s}")
            return False

    def _setup_effects(self, request: ManageOpacityEffectsRequest, state: OpacityEffectsState,
    ) -> bool:
        """Setup opacity effects for target widgets."""
        try:
            # Validate effect support for all targets
            for target in request.target_widgets:
                if not self._opacity_management.supports_opacity_effects(target.widget_id):
                    state.warnings.append(f"Widget {target.widget_id} has limited opacity effect sup\
    port")

            return True

        except Exception as e:
            self._logger.log_error("Effect setup failed", error=e)
            state.errors.append(f"Effect setup error: {e!s}")
            return False

    def _apply_opacity_effects(self,
    request: ManageOpacityEffectsRequest, state: OpacityEffectsState,
    ) -> list[EffectApplication]:
        """Apply opacity effects to target widgets."""
        effects_applied = []

        # Sort targets by priority
        sorted_targets = sorted(request.target_widgets, key=lambda x: x.priority, reverse=True)

        for target in sorted_targets:
            try:
                # Get current opacity
                current_opacity = self._opacity_management.get_current_opacity(target.widget_id)
                target.current_opacity = current_opacity

                # Apply opacity effect
effect_result = (
    self._opacity_management.apply_opacity(target.widget_id, target.target_opacity))
                effects_applied.append(effect_result)

                # Update state
                state.active_effects[target.widget_id] = effect_result
                state.processed_widgets += 1

                # Progress callback
                if request.progress_callback:
                    progress = state.processed_widgets / state.total_widgets
                    request.progress_callback(f"Applied opacity to {target.widget_id}", progress)

            except Exception as e:
self._logger.log_error(f"Failed to apply opacity to widget {target.widget_id}", error = (
    e))

                # Create error effect application
                error_effect = EffectApplication(
                    widget_id=target.widget_id,
                    effect_applied=False,
                    previous_opacity=target.current_opacity,
                    new_opacity=target.current_opacity,
                    error_message=str(e)
                )
                effects_applied.append(error_effect)
                state.errors.append(f"Opacity application failed for {target.widget_id}: {e!s}")

                # Error callback
                if request.error_callback:
                    request.error_callback(f"Opacity application failed for {target.widget_id}", e)

        return effects_applied

    def _setup_animations(self,
    request: ManageOpacityEffectsRequest, state: OpacityEffectsState,
    ) -> list[AnimationSetup]:
        """Setup animations for opacity effects."""
        animations_setup = []

        try:
            if request.animation_config:
                # Get target widget IDs
                target_ids = [target.widget_id for target in request.target_widgets]

                # Create animation
animation_result = (
    self._animation.create_opacity_animation(request.animation_config, target_ids))
                animations_setup.append(animation_result)

                # Start animation if created successfully
                if animation_result.animation_created and animation_result.animation_id:
animation_started = (
    self._animation.start_animation(animation_result.animation_id))
                    if animation_started:
                        state.active_animations[animation_result.animation_id] = animation_result
                        self._logger.log_info(f"Animation started: {animation_result.animation_id}")
                    else:
                        state.warnings.append(f"Failed to start animation: {animation_result.animation_id}",
    )

        except Exception as e:
            self._logger.log_error("Animation setup failed", error=e)
            state.errors.append(f"Animation setup error: {e!s}")

        return animations_setup

    def _start_monitoring(self, request: ManageOpacityEffectsRequest, state: OpacityEffectsState,
    ) -> bool:
        """Start monitoring opacity effects."""
        try:
            widget_ids = [target.widget_id for target in request.target_widgets]
            return self._effect_monitoring.start_monitoring(widget_ids,
    )

        except Exception as e:
            self._logger.log_error("Effect monitoring startup failed", error=e)
            return False

    def _finalize_effects(self, request: ManageOpacityEffectsRequest, state: OpacityEffectsState,
    ) -> None:
        """Finalize opacity effects management."""
        try:
            # Log final state
            self._logger.log_info(
                "Opacity effects management finalized",
                operation_id=request.operation_id,
                total_widgets=state.total_widgets,
                processed_widgets=state.processed_widgets,
                active_effects=len(state.active_effects)
                active_animations=len(state.active_animations)
                errors=len(state.errors)
                warnings=len(state.warnings)
            )

        except Exception as e:
            self._logger.log_error("Finalization failed", error=e)

    def _create_error_response(
        self,
        operation_id: str,
        result: ManageResult,
        error_message: str,
        state: OpacityEffectsState,
        effects_applied: list[EffectApplication],
        animations_setup: list[AnimationSetup],
        backup_created: bool,
        execution_time_ms: float,
    ) -> ManageOpacityEffectsResponse:
        """Create error response."""
        return ManageOpacityEffectsResponse(
            result=result,
            operation_id=operation_id,
            effects_applied=effects_applied,
            animations_setup=animations_setup,
            state=state,
            backup_created=backup_created,
            execution_time_ms=execution_time_ms,
            error_message=error_message,
            warnings=state.warnings if state.warnings else None,
        )