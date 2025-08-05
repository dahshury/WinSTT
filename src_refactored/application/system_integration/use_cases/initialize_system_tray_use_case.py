"""Initialize System Tray Use Case.

This module implements the InitializeSystemTrayUseCase for setting up system tray
functionality with menu configuration and icon management.
"""

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Protocol

from src_refactored.domain.system_integration.value_objects.system_operations import (
    InitializePhase,
    InitializeResult,
    MenuItemType,
    TrayIconType,
)


class TrayVisibility(Enum):
    """System tray visibility modes."""
    ALWAYS_VISIBLE = "always_visible"
    AUTO_HIDE = "auto_hide"
    MINIMIZE_TO_TRAY = "minimize_to_tray"
    SHOW_ON_STARTUP = "show_on_startup"


class EventBindingMode(Enum):
    """Event binding modes for tray interactions."""
    SINGLE_CLICK = "single_click"
    DOUBLE_CLICK = "double_click"
    RIGHT_CLICK = "right_click"
    MIDDLE_CLICK = "middle_click"
    HOVER = "hover"


@dataclass
class TrayIconConfiguration:
    """Configuration for system tray icon."""
    icon_path: Path
    icon_type: TrayIconType
    tooltip_text: str
    size: tuple[int, int]
    fallback_icon: Path | None = None
    animated: bool = False
    animation_frames: list[Path] | None = None


@dataclass
class MenuItem:
    """Configuration for a menu item."""
    id: str
    text: str
    item_type: MenuItemType
    enabled: bool = True
    visible: bool = True
    icon: Path | None = None
    shortcut: str | None = None
    tooltip: str | None = None
    action_callback: str | None = None
    submenu_items: list["MenuItem"] | None = None
    checked: bool = False


@dataclass
class MenuConfiguration:
    """Configuration for system tray menu."""
    menu_items: list[MenuItem]
    style_sheet: str | None = None
    max_width: int | None = None
    separator_style: str | None = None
    font_family: str | None = None
    font_size: int | None = None


@dataclass
class EventBindingConfiguration:
    """Configuration for event bindings."""
    click_actions: dict[EventBindingMode, str]
    hover_enabled: bool = False
    context_menu_enabled: bool = True
    balloon_notifications: bool = True
    activation_reason_handling: bool = True


@dataclass
class TrayBehaviorConfiguration:
    """Configuration for tray behavior."""
    visibility_mode: TrayVisibility
    minimize_to_tray: bool = True
    close_to_tray: bool = False
    startup_minimized: bool = False
    restore_on_click: bool = True
    show_notifications: bool = True


@dataclass
class InitializeSystemTrayRequest:
    """Request for system tray initialization."""
    icon_config: TrayIconConfiguration
    menu_config: MenuConfiguration
    event_config: EventBindingConfiguration
    behavior_config: TrayBehaviorConfiguration
    parent_widget: Any
    enable_logging: bool = True
    enable_progress_tracking: bool = True


@dataclass
class TrayIconSetup:
    """Result of tray icon setup."""
    icon_loaded: bool
    icon_path: Path
    fallback_used: bool
    tooltip_set: bool
    animation_configured: bool


@dataclass
class MenuSetup:
    """Result of menu setup."""
    menu_created: bool
    items_count: int
    separators_count: int
    submenus_count: int
    actions_bound: int
    style_applied: bool


@dataclass
class EventBinding:
    """Result of event binding setup."""
    click_events_bound: int
    hover_events_bound: bool
    context_menu_bound: bool
    notifications_enabled: bool
    activation_handling_enabled: bool


@dataclass
class SystemTrayState:
    """Current state of system tray initialization."""
    current_phase: InitializePhase
    icon_setup: TrayIconSetup | None = None
    menu_setup: MenuSetup | None = None
    event_binding: EventBinding | None = None
    tray_widget: Any | None = None
    is_visible: bool = False
    error_message: str | None = None


@dataclass
class InitializeSystemTrayResponse:
    """Response from system tray initialization."""
    result: InitializeResult
    state: SystemTrayState
    tray_widget: Any | None = None
    menu_widget: Any | None = None
    error_message: str | None = None
    warnings: list[str] = None
    execution_time: float = 0.0
    phase_times: dict[InitializePhase, float] = None

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []
        if self.phase_times is None:
            self.phase_times = {}


class TrayValidationServiceProtocol(Protocol):
    """Protocol for system tray validation service."""

    def validate_icon_configuration(self, config: TrayIconConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate tray icon configuration."""
        ...

    def validate_menu_configuration(self, config: MenuConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate menu configuration."""
        ...

    def validate_event_configuration(self, config: EventBindingConfiguration,
    ) -> tuple[bool, str | None]:
        """Validate event binding configuration."""
        ...

    def validate_system_support(self) -> tuple[bool, str | None]:
        """Validate system tray support."""
        ...


class IconManagementServiceProtocol(Protocol):
    """Protocol for icon management service."""

    def load_icon(self, config: TrayIconConfiguration,
    ) -> tuple[bool, Any, str | None]:
        """Load tray icon from configuration."""
        ...

    def setup_animation(self, icon_widget: Any, config: TrayIconConfiguration,
    ) -> tuple[bool, str | None]:
        """Setup icon animation if configured."""
        ...

    def set_tooltip(self, icon_widget: Any, tooltip: str,
    ) -> tuple[bool, str | None]:
        """Set icon tooltip."""
        ...


class MenuCreationServiceProtocol(Protocol):
    """Protocol for menu creation service."""

    def create_menu(self, config: MenuConfiguration, parent: Any,
    ) -> tuple[bool, Any, str | None]:
        """Create system tray menu."""
        ...

    def add_menu_items(self, menu: Any, items: list[MenuItem]) -> tuple[bool, int, str | None]:
        """Add items to menu."""
        ...

    def bind_menu_actions(self, menu: Any, items: list[MenuItem]) -> tuple[bool, int, str | None]:
        """Bind actions to menu items."""
        ...


class TrayCreationServiceProtocol(Protocol):
    """Protocol for system tray creation service."""

    def create_system_tray(self, parent: Any,
    ) -> tuple[bool, Any, str | None]:
        """Create system tray widget."""
        ...

    def set_tray_icon(self, tray: Any, icon: Any,
    ) -> tuple[bool, str | None]:
        """Set tray icon."""
        ...

    def set_tray_menu(self, tray: Any, menu: Any,
    ) -> tuple[bool, str | None]:
        """Set tray context menu."""
        ...

    def configure_tray_behavior(self, tray: Any, config: TrayBehaviorConfiguration,
    ) -> tuple[bool, str | None]:
        """Configure tray behavior."""
        ...


class EventBindingServiceProtocol(Protocol):
    """Protocol for event binding service."""

    def bind_click_events(self, tray: Any, config: EventBindingConfiguration,
    ) -> tuple[bool, int, str | None]:
        """Bind click events to tray."""
        ...

    def bind_hover_events(self, tray: Any, config: EventBindingConfiguration,
    ) -> tuple[bool, str | None]:
        """Bind hover events to tray."""
        ...

    def setup_notifications(self, tray: Any, enabled: bool,
    ) -> tuple[bool, str | None]:
        """Setup notification handling."""
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def start_progress(self, total_phases: int,
    ) -> None:
        """Start progress tracking."""
        ...

    def update_progress(self, phase: InitializePhase, progress: float,
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


class InitializeSystemTrayUseCase:
    """Use case for initializing system tray functionality."""

    def __init__(
        self,
        tray_validation_service: TrayValidationServiceProtocol,
        icon_management_service: IconManagementServiceProtocol,
        menu_creation_service: MenuCreationServiceProtocol,
        tray_creation_service: TrayCreationServiceProtocol,
        event_binding_service: EventBindingServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol | None = None,
        logger_service: LoggerServiceProtocol | None = None,
    ):
        self._tray_validation_service = tray_validation_service
        self._icon_management_service = icon_management_service
        self._menu_creation_service = menu_creation_service
        self._tray_creation_service = tray_creation_service
        self._event_binding_service = event_binding_service
        self._progress_tracking_service = progress_tracking_service
        self._logger_service = logger_service

    def execute(self, request: InitializeSystemTrayRequest,
    ) -> InitializeSystemTrayResponse:
        """Execute system tray initialization."""
        import time
        start_time = time.time()
        phase_times = {}

        state = SystemTrayState(current_phase=InitializePhase.INITIALIZATION)
        warnings = []

        try:
            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.start_progress(len(InitializePhase))

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info("Starting system tray initialization")

            # Phase 1: Validation
            phase_start = time.time()
            state.current_phase = InitializePhase.VALIDATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.VALIDATION, 0.0)

            # Validate system support
            system_valid, system_error = self._tray_validation_service.validate_system_support()
            if not system_valid:
                state.error_message = f"System tray not supported: {system_error}"
                return InitializeSystemTrayResponse(
                    result=InitializeResult.SYSTEM_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            # Validate icon configuration
icon_valid, icon_error = (
    self._tray_validation_service.validate_icon_configuration(request.icon_config))
            if not icon_valid:
                state.error_message = f"Invalid icon configuration: {icon_error}"
                return InitializeSystemTrayResponse(
                    result=InitializeResult.VALIDATION_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            # Validate menu configuration
menu_valid, menu_error = (
    self._tray_validation_service.validate_menu_configuration(request.menu_config))
            if not menu_valid:
                state.error_message = f"Invalid menu configuration: {menu_error}"
                return InitializeSystemTrayResponse(
                    result=InitializeResult.VALIDATION_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            # Validate event configuration
event_valid, event_error = (
    self._tray_validation_service.validate_event_configuration(request.event_config))
            if not event_valid:
                state.error_message = f"Invalid event configuration: {event_error}"
                return InitializeSystemTrayResponse(
                    result=InitializeResult.VALIDATION_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            phase_times[InitializePhase.VALIDATION] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.VALIDATION, 1.0)

            # Phase 2: Icon Setup
            phase_start = time.time()
            state.current_phase = InitializePhase.ICON_SETUP

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.ICON_SETUP, 0.0)

icon_loaded, icon_widget, icon_error = (
    self._icon_management_service.load_icon(request.icon_config))
            if not icon_loaded:
                state.error_message = f"Failed to load icon: {icon_error}"
                return InitializeSystemTrayResponse(
                    result=InitializeResult.ICON_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            # Setup tooltip
            tooltip_set, tooltip_error = self._icon_management_service.set_tooltip(
                icon_widget, request.icon_config.tooltip_text,
            )
            if not tooltip_set and tooltip_error:
                warnings.append(f"Failed to set tooltip: {tooltip_error}")

            # Setup animation if configured
            animation_configured = False
            if request.icon_config.animated and request.icon_config.animation_frames:
                anim_success, anim_error = self._icon_management_service.setup_animation(
                    icon_widget, request.icon_config,
                )
                if not anim_success and anim_error:
                    warnings.append(f"Failed to setup animation: {anim_error}")
                else:
                    animation_configured = anim_success

            state.icon_setup = TrayIconSetup(
                icon_loaded=icon_loaded,
                icon_path=request.icon_config.icon_path,
                fallback_used=False,  # Would be determined by icon service
                tooltip_set=tooltip_set,
                animation_configured=animation_configured,
            )

            phase_times[InitializePhase.ICON_SETUP] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.ICON_SETUP, 1.0)

            # Phase 3: Menu Creation
            phase_start = time.time()
            state.current_phase = InitializePhase.MENU_CREATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.MENU_CREATION, 0.0)

            menu_created, menu_widget, menu_error = self._menu_creation_service.create_menu(
                request.menu_config, request.parent_widget,
            )
            if not menu_created:
                state.error_message = f"Failed to create menu: {menu_error}"
                return InitializeSystemTrayResponse(
                    result=InitializeResult.MENU_ERROR,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            # Add menu items
            items_added, items_count, items_error = self._menu_creation_service.add_menu_items(
                menu_widget, request.menu_config.menu_items,
            )
            if not items_added:
                warnings.append(f"Failed to add some menu items: {items_error}")

            # Bind menu actions
actions_bound, actions_count, actions_error = (
    self._menu_creation_service.bind_menu_actions()
                menu_widget, request.menu_config.menu_items,
            )
            if not actions_bound:
                warnings.append(f"Failed to bind some menu actions: {actions_error}")

            state.menu_setup = MenuSetup(
                menu_created=menu_created,
                items_count=items_count,
                separators_count=sum(1 for item in request.menu_config.menu_items if item.item_type
                 ==  MenuItemType.SEPARATOR)
                submenus_count=sum(1 for item in request.menu_config.menu_items if item.item_type
                 ==  MenuItemType.SUBMENU)
                actions_bound=actions_count,
                style_applied=bool(request.menu_config.style_sheet),
            )

            phase_times[InitializePhase.MENU_CREATION] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.MENU_CREATION, 1.0)

            # Phase 4: Tray Creation
            phase_start = time.time()
            state.current_phase = InitializePhase.TRAY_CREATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.TRAY_CREATION, 0.0)

            tray_created, tray_widget, tray_error = self._tray_creation_service.create_system_tray(
                request.parent_widget,
            )
            if not tray_created:
                state.error_message = f"Failed to create system tray: {tray_error}"
                return InitializeSystemTrayResponse(
                    result=InitializeResult.FAILED,
                    state=state,
                    error_message=state.error_message,
                    execution_time=time.time() - start_time,
                )

            # Set tray icon
icon_set, icon_set_error = (
    self._tray_creation_service.set_tray_icon(tray_widget, icon_widget))
            if not icon_set:
                warnings.append(f"Failed to set tray icon: {icon_set_error}")

            # Set tray menu
menu_set, menu_set_error = (
    self._tray_creation_service.set_tray_menu(tray_widget, menu_widget))
            if not menu_set:
                warnings.append(f"Failed to set tray menu: {menu_set_error}")

            # Configure tray behavior
            behavior_set, behavior_error = self._tray_creation_service.configure_tray_behavior(
                tray_widget, request.behavior_config,
            )
            if not behavior_set:
                warnings.append(f"Failed to configure tray behavior: {behavior_error}")

            state.tray_widget = tray_widget

            phase_times[InitializePhase.TRAY_CREATION] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.TRAY_CREATION, 1.0)

            # Phase 5: Event Binding
            phase_start = time.time()
            state.current_phase = InitializePhase.EVENT_BINDING

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.EVENT_BINDING, 0.0)

            # Bind click events
clicks_bound, clicks_count, clicks_error = (
    self._event_binding_service.bind_click_events()
                tray_widget, request.event_config,
            )
            if not clicks_bound:
                warnings.append(f"Failed to bind click events: {clicks_error}")

            # Bind hover events
            hover_bound, hover_error = self._event_binding_service.bind_hover_events(
                tray_widget, request.event_config,
            )
            if not hover_bound and request.event_config.hover_enabled:
                warnings.append(f"Failed to bind hover events: {hover_error}")

            # Setup notifications
notifications_setup, notifications_error = (
    self._event_binding_service.setup_notifications()
                tray_widget, request.behavior_config.show_notifications,
            )
            if not notifications_setup:
                warnings.append(f"Failed to setup notifications: {notifications_error}")

            state.event_binding = EventBinding(
                click_events_bound=clicks_count,
                hover_events_bound=hover_bound,
                context_menu_bound=request.event_config.context_menu_enabled,
                notifications_enabled=notifications_setup,
                activation_handling_enabled=request.event_config.activation_reason_handling,
            )

            phase_times[InitializePhase.EVENT_BINDING] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.EVENT_BINDING, 1.0)

            # Phase 6: Finalization
            phase_start = time.time()
            state.current_phase = InitializePhase.FINALIZATION

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.FINALIZATION, 0.0)

            # Set visibility based on configuration
            if request.behavior_config.visibility_mode == TrayVisibility.SHOW_ON_STARTUP:
                state.is_visible = True
            elif request.behavior_config.startup_minimized:
                state.is_visible = False
            else:
                state.is_visible = True

            phase_times[InitializePhase.FINALIZATION] = time.time() - phase_start

            if request.enable_progress_tracking and self._progress_tracking_service:
                self._progress_tracking_service.update_progress(InitializePhase.FINALIZATION, 1.0)
                self._progress_tracking_service.complete_progress()

            if request.enable_logging and self._logger_service:
                self._logger_service.log_info(
                    "System tray initialization completed successfully",
                    warnings_count=len(warnings)
                    execution_time=time.time() - start_time,
                )

            result = InitializeResult.SUCCESS if not warnings else InitializeResult.PARTIAL_SUCCESS

            return InitializeSystemTrayResponse(
                result=result,
                state=state,
                tray_widget=tray_widget,
                menu_widget=menu_widget,
                warnings=warnings,
                execution_time=time.time() - start_time,
                phase_times=phase_times,
            )

        except Exception as e:
            error_message = f"Unexpected error during system tray initialization: {e!s}"
            state.error_message = error_message

            if request.enable_logging and self._logger_service:
                self._logger_service.log_error(
                    "System tray initialization failed",
                    error=str(e)
                    phase=state.current_phase.value,
                    execution_time=time.time() - start_time,
                )

            return InitializeSystemTrayResponse(
                result=InitializeResult.FAILED,
                state=state,
                error_message=error_message,
                warnings=warnings,
                execution_time=time.time() - start_time,
                phase_times=phase_times,
            )