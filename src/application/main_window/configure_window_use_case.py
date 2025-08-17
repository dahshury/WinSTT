"""Configure Window Use Case

This module implements the ConfigureWindowUseCase for configuring window
properties, appearance, and behavior after initialization.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Protocol

from src.domain.ui_coordination.value_objects.window_operations import (
    ConfigurePhase,
    ConfigureResult,
    ConfigureResultStatus,
    PropertyType,
)


class GeometryType(Enum):
    """Enumeration of geometry property types."""
    POSITION = "position"
    SIZE = "size"
    MINIMUM_SIZE = "minimum_size"
    MAXIMUM_SIZE = "maximum_size"
    FIXED_SIZE = "fixed_size"
    CENTER_ON_SCREEN = "center_on_screen"
    CENTER_ON_PARENT = "center_on_parent"


class StyleType(Enum):
    """Enumeration of style property types."""
    STYLESHEET = "stylesheet"
    BACKGROUND_COLOR = "background_color"
    BORDER = "border"
    FONT = "font"
    CURSOR = "cursor"
    THEME = "theme"


@dataclass
class PropertyUpdate:
    """Configuration for a property update."""
    property_type: PropertyType
    value: Any
    validate_before_apply: bool = True
    revert_on_failure: bool = True
    backup_current_value: bool = True


@dataclass
class GeometryUpdate:
    """Configuration for a geometry update."""
    geometry_type: GeometryType
    value: tuple[int, int] | int | bool
    animate_transition: bool = False
    transition_duration_ms: int = 250
    validate_constraints: bool = True


@dataclass
class StyleUpdate:
    """Configuration for a style update."""
    style_type: StyleType
    value: Any
    merge_with_existing: bool = True
    validate_syntax: bool = True
    apply_to_children: bool = False


@dataclass
class ConfigurationBackup:
    """Backup of current window configuration."""
    properties: dict[PropertyType, Any]
    geometry: dict[GeometryType, Any]
    styles: dict[StyleType, Any]
    timestamp: datetime
    backup_id: str


@dataclass
class ConfigureWindowRequest:
    """Request for configuring window."""
    window: Any  # QWidget/QMainWindow
    property_updates: list[PropertyUpdate] = field(default_factory=list)
    geometry_updates: list[GeometryUpdate] = field(default_factory=list)
    style_updates: list[StyleUpdate] = field(default_factory=list)
    create_backup: bool = True
    validate_all_changes: bool = True
    apply_changes_atomically: bool = True
    context_data: dict[str, Any] | None = None
    timestamp: datetime = field(default_factory=datetime.utcnow)

    def __post_init__(self):
        if self.property_updates is None:
            self.property_updates = []
        if self.geometry_updates is None:
            self.geometry_updates = []
        if self.style_updates is None:
            self.style_updates = []
        if self.timestamp is None:
            self.timestamp = datetime.utcnow()
        if self.context_data is None:
            self.context_data = {}


@dataclass
class UpdateResult:
    """Result of a single update operation."""
    update_type: str  # property/geometry/style
    target: str  # specific property/geometry/style name
    success: bool
    old_value: Any = None
    new_value: Any = None
    error_message: str | None = None
    execution_time_ms: float = 0.0


@dataclass
class WindowConfigurationState:
    """Current state of window configuration."""
    window: Any
    current_properties: dict[PropertyType, Any]
    current_geometry: dict[GeometryType, Any]
    current_styles: dict[StyleType, Any]
    backup: ConfigurationBackup | None
    last_update_time: datetime
    update_count: int = 0

    def __post_init__(self,
    ):
        if not hasattr(self, "current_properties"):
            self.current_properties = {}
        if not hasattr(self, "current_geometry"):
            self.current_geometry = {}
        if not hasattr(self, "current_styles"):
            self.current_styles = {}


@dataclass
class ConfigureWindowResponse:
    """Response from window configuration."""
    result: ConfigureResult
    window_state: WindowConfigurationState | None
    current_phase: ConfigurePhase
    progress_percentage: float
    update_results: list[UpdateResult] = field(default_factory=list)
    backup_created: ConfigurationBackup | None = None
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)
    execution_time_ms: float = 0.0

    def __post_init__(self):
        if self.update_results is None:
            self.update_results = []
        if self.warnings is None:
            self.warnings = []


class WindowValidationServiceProtocol(Protocol,
    ):
    """Protocol for window validation operations."""

    def validate_window_exists(self, window: Any,
    ) -> bool:
        """Validate that window exists and is valid."""
        ...

    def validate_property_update(self, window: Any, update: PropertyUpdate,
    ) -> list[str]:
        """Validate property update."""
        ...

    def validate_geometry_update(self, window: Any, update: GeometryUpdate,
    ) -> list[str]:
        """Validate geometry update."""
        ...

    def validate_style_update(self, window: Any, update: StyleUpdate,
    ) -> list[str]:
        """Validate style update."""
        ...


class PropertyManagementServiceProtocol(Protocol):
    """Protocol for property management operations."""

    def get_current_property(self, window: Any, property_type: PropertyType,
    ) -> Any:
        """Get current property value."""
        ...

    def set_property(self, window: Any, property_type: PropertyType, value: Any,
    ) -> bool:
        """Set property value."""
        ...

    def backup_property(self, window: Any, property_type: PropertyType,
    ) -> Any:
        """Backup current property value."""
        ...

    def restore_property(self, window: Any, property_type: PropertyType, value: Any,
    ) -> bool:
        """Restore property value from backup."""
        ...


class GeometryManagementServiceProtocol(Protocol):
    """Protocol for geometry management operations."""

    def get_current_geometry(self, window: Any, geometry_type: GeometryType,
    ) -> Any:
        """Get current geometry value."""
        ...

    def set_geometry(self,
window: Any, geometry_type: GeometryType, value: Any, animate: bool = False, duration_ms: int = 250,
    ) -> bool:
        """Set geometry value with optional animation."""
        ...

    def validate_geometry_constraints(self, window: Any, geometry_type: GeometryType, value: Any,
    ) -> bool:
        """Validate geometry constraints."""
        ...

    def backup_geometry(self, window: Any, geometry_type: GeometryType,
    ) -> Any:
        """Backup current geometry value."""
        ...


class StyleManagementServiceProtocol(Protocol):
    """Protocol for style management operations."""

    def get_current_style(self, window: Any, style_type: StyleType,
    ) -> Any:
        """Get current style value."""
        ...

    def set_style(self,
window: Any, style_type: StyleType, value: Any, merge: bool = True, apply_to_children: bool = False,
    ) -> bool:
        """Set style value with merge and inheritance options."""
        ...

    def validate_style_syntax(self, style_type: StyleType, value: Any,
    ) -> list[str]:
        """Validate style syntax."""
        ...

    def backup_style(self, window: Any, style_type: StyleType,
    ) -> Any:
        """Backup current style value."""
        ...


class BackupServiceProtocol(Protocol):
    """Protocol for backup operations."""

    def create_configuration_backup(self, window: Any, backup_id: str,
    ) -> ConfigurationBackup:
        """Create complete configuration backup."""
        ...

    def restore_from_backup(self, window: Any, backup: ConfigurationBackup,
    ) -> bool:
        """Restore configuration from backup."""
        ...

    def validate_backup_integrity(self, backup: ConfigurationBackup,
    ) -> bool:
        """Validate backup integrity."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking operations."""

    def start_progress_session(self, session_id: str, total_phases: int,
    ) -> None:
        """Start a new progress tracking session."""
        ...

    def update_progress(self, session_id: str, phase: ConfigurePhase, percentage: float,
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


class ConfigureWindowUseCase:
    """Use case for configuring window properties, geometry, and styles."""

    def __init__(
        self,
        validation_service: WindowValidationServiceProtocol,
        property_service: PropertyManagementServiceProtocol,
        geometry_service: GeometryManagementServiceProtocol,
        style_service: StyleManagementServiceProtocol,
        backup_service: BackupServiceProtocol,
        progress_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        self.validation_service = validation_service
        self.property_service = property_service
        self.geometry_service = geometry_service
        self.style_service = style_service
        self.backup_service = backup_service
        self.progress_service = progress_service
        self.logger_service = logger_service

    def execute(self, request: ConfigureWindowRequest,
    ) -> ConfigureWindowResponse:
        """Execute the window configuration."""
        start_time = datetime.utcnow()
        session_id = f"configure_window_{start_time.timestamp()}"

        try:
            # Phase 1: Initialization
            self.progress_service.start_progress_session(session_id, 6)
            self.progress_service.update_progress(session_id, ConfigurePhase.INITIALIZATION, 0.0)

            self.logger_service.log_info(
                "Starting window configuration",
                {
                    "property_updates": len(request.property_updates),
                    "geometry_updates": len(request.geometry_updates),
                    "style_updates": len(request.style_updates),
                    "create_backup": request.create_backup,
                },
            )

            # Phase 2: Validation
            self.progress_service.update_progress(session_id, ConfigurePhase.VALIDATION, 16.7)

            # Validate window exists
            if not self.validation_service.validate_window_exists(request.window):
                return self._create_error_response(
                    ConfigureResultStatus.WINDOW_NOT_FOUND,
                    ConfigurePhase.VALIDATION,
                    0.0,
                    "Window not found or invalid",
                    start_time,
                )

            # Validate all updates
            validation_errors = []

            for prop_update in request.property_updates:
                if prop_update.validate_before_apply:
                    errors = self.validation_service.validate_property_update(request.window, prop_update)
                    validation_errors.extend(errors)

            for geom_update in request.geometry_updates:
                if geom_update.validate_constraints:
                    errors = self.validation_service.validate_geometry_update(request.window, geom_update)
                    validation_errors.extend(errors)

            for style_update in request.style_updates:
                if style_update.validate_syntax:
                    errors = self.validation_service.validate_style_update(request.window, style_update)
                    validation_errors.extend(errors)

            if validation_errors and request.validate_all_changes:
                return self._create_error_response(
                    ConfigureResultStatus.VALIDATION_ERROR,
                    ConfigurePhase.VALIDATION,
                    16.7,
                    f"Validation failed: {'; '.join(validation_errors)}",
                    start_time,
                )

            # Create backup if requested
            backup = None
            if request.create_backup:
                try:
                    backup_id = f"config_backup_{start_time.timestamp()}"
                    backup = self.backup_service.create_configuration_backup(request.window, backup_id)

                    if not self.backup_service.validate_backup_integrity(backup):
                        self.logger_service.log_warning(
                            "Backup integrity validation failed",
                            {"backup_id": backup_id},
                        )

                except Exception as e:
                    self.logger_service.log_warning(
                        f"Failed to create configuration backup: {e!s}",
                        {"window": str(request.window)},
                    )

            update_results = []
            warnings = []

            # Phase 3: Property Updates
            self.progress_service.update_progress(session_id, ConfigurePhase.PROPERTY_UPDATE, 33.4)

            property_failures = []
            for prop_update in request.property_updates:
                update_start = datetime.utcnow()

                try:
                    # Backup current value if requested
                    old_value = None
                    if prop_update.backup_current_value:
                        old_value = self.property_service.backup_property(
                            request.window,
                            prop_update.property_type,
                        )

                    # Apply property update
                    success = self.property_service.set_property(
                        request.window,
                        prop_update.property_type,
                        prop_update.value,
                    )

                    update_time = (datetime.utcnow() - update_start).total_seconds() * 1000

                    if success:
                        update_results.append(UpdateResult(
                            update_type="property",
                            target=prop_update.property_type.value,
                            success=True,
                            old_value=old_value,
                            new_value=prop_update.value,
                            execution_time_ms=update_time,
                        ))
                    else:
                        error_msg = f"Failed to set property {prop_update.property_type.value}"
                        property_failures.append(error_msg)

                        # Revert if requested
                        if prop_update.revert_on_failure and old_value is not None:
                            self.property_service.restore_property(
                                request.window,
                                prop_update.property_type,
                                old_value,
                            )

                        update_results.append(UpdateResult(
                            update_type="property",
                            target=prop_update.property_type.value,
                            success=False,
                            old_value=old_value,
                            new_value=prop_update.value,
                            error_message=error_msg,
                            execution_time_ms=update_time,
                        ))

                except Exception as e:
                    error_msg = f"Property update failed for {prop_update.property_type.value}: {e!s}"
                    property_failures.append(error_msg)

                    update_time = (datetime.utcnow() - update_start).total_seconds() * 1000
                    update_results.append(UpdateResult(
                        update_type="property",
                        target=prop_update.property_type.value,
                        success=False,
                        error_message=error_msg,
                        execution_time_ms=update_time,
                    ))

            # Phase 4: Geometry Updates
            self.progress_service.update_progress(session_id, ConfigurePhase.GEOMETRY_UPDATE, 50.1)

            geometry_failures = []
            for geom_update in request.geometry_updates:
                update_start = datetime.utcnow()

                try:
                    # Backup current value
                    old_value = self.geometry_service.backup_geometry(
                        request.window,
                        geom_update.geometry_type,
                    )

                    # Validate constraints if requested
                    if geom_update.validate_constraints:
                        if not self.geometry_service.validate_geometry_constraints(
                            request.window,
                            geom_update.geometry_type,
                            geom_update.value,
                        ):
                            error_msg = f"Geometry constraints validation failed for {geom_update.geometry_type.value}"
                            geometry_failures.append(error_msg)

                            update_time = (datetime.utcnow() - update_start).total_seconds() * 1000
                            update_results.append(UpdateResult(
                                update_type="geometry",
                                target=geom_update.geometry_type.value,
                                success=False,
                                old_value=old_value,
                                new_value=geom_update.value,
                                error_message=error_msg,
                                execution_time_ms=update_time,
                            ))
                            continue

                    # Apply geometry update
                    success = self.geometry_service.set_geometry(
                        request.window,
                        geom_update.geometry_type,
                        geom_update.value,
                        geom_update.animate_transition,
                        geom_update.transition_duration_ms,
                    )

                    update_time = (datetime.utcnow() - update_start).total_seconds() * 1000

                    if success:
                        update_results.append(UpdateResult(
                            update_type="geometry",
                            target=geom_update.geometry_type.value,
                            success=True,
                            old_value=old_value,
                            new_value=geom_update.value,
                            execution_time_ms=update_time,
                        ))
                    else:
                        error_msg = f"Failed to set geometry {geom_update.geometry_type.value}"
                        geometry_failures.append(error_msg)

                        update_results.append(UpdateResult(
                            update_type="geometry",
                            target=geom_update.geometry_type.value,
                            success=False,
                            old_value=old_value,
                            new_value=geom_update.value,
                            error_message=error_msg,
                            execution_time_ms=update_time,
                        ))

                except Exception as e:
                    error_msg = f"Geometry update failed for {geom_update.geometry_type.value}: {e!s}"
                    geometry_failures.append(error_msg)

                    update_time = (datetime.utcnow() - update_start).total_seconds() * 1000
                    update_results.append(UpdateResult(
                        update_type="geometry",
                        target=geom_update.geometry_type.value,
                        success=False,
                        error_message=error_msg,
                        execution_time_ms=update_time,
                    ))

            # Phase 5: Style Updates
            self.progress_service.update_progress(session_id, ConfigurePhase.STYLE_UPDATE, 66.8)

            style_failures = []
            for style_update in request.style_updates:
                update_start = datetime.utcnow()

                try:
                    # Validate style syntax if requested
                    if style_update.validate_syntax:
                        syntax_errors = self.style_service.validate_style_syntax(
                            style_update.style_type,
                            style_update.value,
                        )
                        if syntax_errors:
                            error_msg = f"Style syntax validation failed for {style_update.style_type.value}: {'; '.join(syntax_errors)}"
                            style_failures.append(error_msg)

                            update_time = (datetime.utcnow() - update_start).total_seconds() * 1000
                            update_results.append(UpdateResult(
                                update_type="style",
                                target=style_update.style_type.value,
                                success=False,
                                new_value=style_update.value,
                                error_message=error_msg,
                                execution_time_ms=update_time,
                            ))
                            continue

                    # Backup current value
                    old_value = self.style_service.backup_style(
                        request.window,
                        style_update.style_type,
                    )

                    # Apply style update
                    success = self.style_service.set_style(
                        request.window,
                        style_update.style_type,
                        style_update.value,
                        style_update.merge_with_existing,
                        style_update.apply_to_children,
                    )

                    update_time = (datetime.utcnow() - update_start).total_seconds() * 1000

                    if success:
                        update_results.append(UpdateResult(
                            update_type="style",
                            target=style_update.style_type.value,
                            success=True,
                            old_value=old_value,
                            new_value=style_update.value,
                            execution_time_ms=update_time,
                        ))
                    else:
                        error_msg = f"Failed to set style {style_update.style_type.value}"
                        style_failures.append(error_msg)

                        update_results.append(UpdateResult(
                            update_type="style",
                            target=style_update.style_type.value,
                            success=False,
                            old_value=old_value,
                            new_value=style_update.value,
                            error_message=error_msg,
                            execution_time_ms=update_time,
                        ))

                except Exception as e:
                    error_msg = f"Style update failed for {style_update.style_type.value}: {e!s}"
                    style_failures.append(error_msg)

                    update_time = (datetime.utcnow() - update_start).total_seconds() * 1000
                    update_results.append(UpdateResult(
                        update_type="style",
                        target=style_update.style_type.value,
                        success=False,
                        error_message=error_msg,
                        execution_time_ms=update_time,
                    ))

            # Phase 6: Finalization
            self.progress_service.update_progress(session_id, ConfigurePhase.FINALIZATION, 83.5)

            # Collect current state
            current_properties = {}
            current_geometry = {}
            current_styles = {}

            try:
                # Get current properties
                for prop_update in request.property_updates:
                    current_properties[prop_update.property_type] = self.property_service.get_current_property(
                        request.window,
                        prop_update.property_type,
                    )

                # Get current geometry
                for geom_update in request.geometry_updates:
                    current_geometry[geom_update.geometry_type] = self.geometry_service.get_current_geometry(
                        request.window,
                        geom_update.geometry_type,
                    )

                # Get current styles
                for style_update in request.style_updates:
                    current_styles[style_update.style_type] = self.style_service.get_current_style(
                        request.window,
                        style_update.style_type,
                    )

            except Exception as e:
                self.logger_service.log_warning(
                    f"Failed to collect current state: {e!s}",
                    {"window": str(request.window)},
                )

            # Create window state
            window_state = WindowConfigurationState(
                window=request.window,
                current_properties=current_properties,
                current_geometry=current_geometry,
                current_styles=current_styles,
                backup=backup,
                last_update_time=datetime.utcnow(),
                update_count=len(update_results),
            )

            self.progress_service.update_progress(session_id, ConfigurePhase.FINALIZATION, 100.0)
            self.progress_service.complete_progress_session(session_id)

            execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

            # Determine result
            total_failures = len(property_failures) + len(geometry_failures) + len(style_failures)
            total_updates = len(request.property_updates) + len(request.geometry_updates) + len(request.style_updates)

            if total_failures == 0:
                result = ConfigureResult(
                    success=True,
                    phase=ConfigurePhase.FINALIZATION,
                    error_message=None,
                    details={
                        "status": ConfigureResultStatus.SUCCESS.value,
                        "execution_time_ms": execution_time,
                        "progress_percentage": 100.0,
                    },
                )
            elif property_failures and not geometry_failures and not style_failures:
                result = ConfigureResult(
                    success=False,
                    phase=ConfigurePhase.PROPERTY_UPDATE,
                    error_message=f"Property updates failed: {'; '.join(property_failures)}",
                    details={
                        "status": ConfigureResultStatus.PROPERTY_UPDATE_FAILED.value,
                        "execution_time_ms": execution_time,
                        "progress_percentage": 100.0,
                    },
                )
            elif geometry_failures and not property_failures and not style_failures:
                result = ConfigureResult(
                    success=False,
                    phase=ConfigurePhase.GEOMETRY_UPDATE,
                    error_message=f"Geometry updates failed: {'; '.join(geometry_failures)}",
                    details={
                        "status": ConfigureResultStatus.GEOMETRY_UPDATE_FAILED.value,
                        "execution_time_ms": execution_time,
                        "progress_percentage": 100.0,
                    },
                )
            elif style_failures and not property_failures and not geometry_failures:
                result = ConfigureResult(
                    success=False,
                    phase=ConfigurePhase.STYLE_UPDATE,
                    error_message=f"Style updates failed: {'; '.join(style_failures)}",
                    details={
                        "status": ConfigureResultStatus.STYLE_UPDATE_FAILED.value,
                        "execution_time_ms": execution_time,
                        "progress_percentage": 100.0,
                    },
                )
            elif total_failures == total_updates:
                result = ConfigureResult(
                    success=False,
                    phase=ConfigurePhase.INITIALIZATION,
                    error_message="Internal error during configuration",
                    details={
                        "status": ConfigureResultStatus.INTERNAL_ERROR.value,
                        "execution_time_ms": execution_time,
                        "progress_percentage": 0.0,
                    },
                )
            else:
                result = ConfigureResult(
                    success=True,
                    phase=ConfigurePhase.FINALIZATION,
                    error_message=None,
                    details={
                        "status": ConfigureResultStatus.SUCCESS.value,
                        "execution_time_ms": execution_time,
                        "progress_percentage": 100.0,
                    },
                )

            # Collect warnings
            warnings.extend(validation_errors)
            warnings.extend(property_failures)
            warnings.extend(geometry_failures)
            warnings.extend(style_failures)

            self.logger_service.log_info(
                "Window configuration completed",
                {
                    "result": result.details.get("status", "unknown") if result.details else "unknown",
                    "execution_time_ms": execution_time,
                    "total_updates": total_updates,
                    "successful_updates": total_updates - total_failures,
                    "failed_updates": total_failures,
                    "backup_created": backup is not None,
                },
            )

            return ConfigureWindowResponse(
                result=result,
                window_state=window_state,
                current_phase=ConfigurePhase.FINALIZATION,
                progress_percentage=100.0,
                update_results=update_results,
                backup_created=backup,
                warnings=warnings,
                execution_time_ms=execution_time,
            )

        except Exception as e:
            self.logger_service.log_error(
                "Unexpected error during window configuration",
                {"error": str(e)},
            )

            return self._create_error_response(
                ConfigureResultStatus.INTERNAL_ERROR,
                ConfigurePhase.INITIALIZATION,
                0.0,
                f"Unexpected error: {e!s}",
                start_time,
            )

    def _create_error_response(
        self,
        status: ConfigureResultStatus,
        phase: ConfigurePhase,
        progress: float,
        error_message: str,
        start_time: datetime,
    ) -> ConfigureWindowResponse:
        """Create an error response with timing information."""
        execution_time = (datetime.utcnow() - start_time).total_seconds() * 1000

        result = ConfigureResult(
            success=False,
            phase=phase,
            error_message=error_message,
            details={
                "status": status.value,
                "execution_time_ms": execution_time,
                "progress_percentage": progress,
            },
        )

        return ConfigureWindowResponse(
            result=result,
            window_state=None,
            current_phase=phase,
            progress_percentage=progress,
            error_message=error_message,
            execution_time_ms=execution_time,
        )