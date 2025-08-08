"""Window Operations Value Objects.

This module defines value objects for window management operations.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from src_refactored.domain.common.value_object import ValueObject


class IntegratePhase(Enum):
    """Phases of visualization integration."""
    INITIALIZATION = "initialization"
    PREPARATION = "preparation"
    VALIDATION = "validation"
    SETUP = "setup"
    VISUALIZATION_CREATION = "visualization_creation"
    CONFIGURATION_SETUP = "configuration_setup"
    DATA_BINDING = "data_binding"
    RENDERING_SETUP = "rendering_setup"
    INTEGRATION = "integration"
    FINALIZATION = "finalization"


class InitializePhase(Enum):
    """Phases of window initialization."""
    INITIALIZATION = "initialization"
    CREATION = "creation"
    CONFIGURATION = "configuration"
    CONFIGURATION_VALIDATION = "configuration_validation"
    WINDOW_CREATION = "window_creation"
    COMPONENT_SETUP = "component_setup"
    LAYOUT_CONFIGURATION = "layout_configuration"
    LAYOUT_SETUP = "layout_setup"
    SIGNAL_CONNECTION = "signal_connection"
    COMPONENT_BINDING = "component_binding"
    FINALIZATION = "finalization"


class ConfigurePhase(Enum):
    """Phases of window configuration."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    PROPERTY_SETTING = "property_setting"
    PROPERTY_UPDATE = "property_update"
    GEOMETRY_UPDATE = "geometry_update"
    STYLE_UPDATE = "style_update"
    STYLE_APPLICATION = "style_application"
    BEHAVIOR_CONFIGURATION = "behavior_configuration"
    FINALIZATION = "finalization"


class UpdatePhase(Enum):
    """Phases of UI text updates."""
    VALIDATION = "validation"
    TEXT_FORMATTING = "text_formatting"
    TRANSLATION = "translation"
    APPLICATION = "application"
    EXECUTION = "execution"
    FINALIZATION = "finalization"


class RenderingMode(Enum):
    """Rendering modes for visualization."""
    AUTO = "auto"
    REAL_TIME = "real_time"
    BUFFERED = "buffered"
    ON_DEMAND = "on_demand"


class VisualizationType(Enum):
    """Types of audio visualization."""
    WAVEFORM = "waveform"
    SPECTRUM = "spectrum"
    OSCILLOSCOPE = "oscilloscope"
    BARS = "bars"


class ComponentType(Enum):
    """Types of UI components."""
    BUTTON = "button"
    LABEL = "label"
    TEXT_EDIT = "text_edit"
    PROGRESS_BAR = "progress_bar"
    SLIDER = "slider"
    COMBO_BOX = "combo_box"
    CHECK_BOX = "check_box"
    RADIO_BUTTON = "radio_button"
    MENU = "menu"
    TOOLBAR = "toolbar"
    STATUS_BAR = "status_bar"
    VISUALIZATION_WIDGET = "visualization_widget"


class WindowType(Enum):
    """Types of windows."""
    MAIN = "main"
    MAIN_WINDOW = "main_window"
    DIALOG = "dialog"
    POPUP = "popup"
    TOOLTIP = "tooltip"
    SPLASH = "splash"
    SETTINGS = "settings"


class PropertyType(Enum):
    """Types of window properties."""
    GEOMETRY = "geometry"
    STYLE = "style"
    BEHAVIOR = "behavior"
    CONTENT = "content"
    STATE = "state"


class IntegrateResultStatus(Enum):
    """Status values for integration results."""
    SUCCESS = "success"
    VALIDATION_ERROR = "validation_error"
    VISUALIZATION_CREATION_FAILED = "visualization_creation_failed"
    DATA_BINDING_FAILED = "data_binding_failed"
    RENDERING_SETUP_FAILED = "rendering_setup_failed"
    INTEGRATION_FAILED = "integration_failed"
    INTERNAL_ERROR = "internal_error"


class InitializeResultStatus(Enum):
    """Status values for initialization results."""
    SUCCESS = "success"
    VALIDATION_ERROR = "validation_error"
    CONFIGURATION_ERROR = "configuration_error"
    WINDOW_CREATION_FAILED = "window_creation_failed"
    COMPONENT_INITIALIZATION_FAILED = "component_initialization_failed"
    LAYOUT_SETUP_FAILED = "layout_setup_failed"
    SIGNAL_CONNECTION_FAILED = "signal_connection_failed"
    INTERNAL_ERROR = "internal_error"


class ConfigureResultStatus(Enum):
    """Status values for configuration results."""
    SUCCESS = "success"
    WINDOW_NOT_FOUND = "window_not_found"
    VALIDATION_ERROR = "validation_error"
    PROPERTY_UPDATE_FAILED = "property_update_failed"
    GEOMETRY_UPDATE_FAILED = "geometry_update_failed"
    STYLE_UPDATE_FAILED = "style_update_failed"
    INTERNAL_ERROR = "internal_error"


@dataclass(frozen=True)
class IntegrateResult(ValueObject):
    """Result of visualization integration operation."""
    
    success: bool
    phase: IntegratePhase
    visualization_type: VisualizationType | None = None
    rendering_mode: RenderingMode | None = None
    error_message: str | None = None
    details: dict[str, Any] | None = None


@dataclass(frozen=True)
class InitializeResult(ValueObject):
    """Result of window initialization operation."""
    
    success: bool
    phase: InitializePhase
    window_type: WindowType | None = None
    components_created: list[ComponentType] | None = None
    error_message: str | None = None
    details: dict[str, Any] | None = None


@dataclass(frozen=True)
class ConfigureResult(ValueObject):
    """Result of window configuration operation."""
    
    success: bool
    phase: ConfigurePhase
    property_type: PropertyType | None = None
    properties_set: list[str] | None = None
    error_message: str | None = None
    details: dict[str, Any] | None = None


class WindowOperationType(Enum):
    """Types of window operations."""
    SHOW = "show"
    HIDE = "hide"
    MINIMIZE = "minimize"
    MAXIMIZE = "maximize"
    RESTORE = "restore"
    CLOSE = "close"
    MOVE = "move"
    RESIZE = "resize"
    BRING_TO_FRONT = "bring_to_front"
    SEND_TO_BACK = "send_to_back"
    TOGGLE_FULLSCREEN = "toggle_fullscreen"
    ACTIVATE = "activate"
    DEACTIVATE = "deactivate"


@dataclass(frozen=True)
class WindowOperation(ValueObject):
    """Represents a window operation with its parameters."""
    
    operation_type: WindowOperationType
    parameters: dict[str, Any] | None = None
    target_window_id: str | None = None
    is_async: bool = False
    priority: int = 0
    
    def __post_init__(self) -> None:
        """Validate the operation parameters."""
        if not isinstance(self.operation_type, WindowOperationType):
            msg = "operation_type must be a WindowOperationType"
            raise ValueError(msg)
        
        if self.parameters is not None and not isinstance(self.parameters, dict):
            msg = "parameters must be a dictionary or None"
            raise ValueError(msg)
        
        if self.priority < 0:
            msg = "priority must be non-negative"
            raise ValueError(msg)
    
    def with_parameters(self, **kwargs: Any) -> WindowOperation:
        """Create a new operation with additional parameters."""
        current_params = self.parameters or {}
        new_params = {**current_params, **kwargs}
        
        return WindowOperation(
            operation_type=self.operation_type,
            parameters=new_params,
            target_window_id=self.target_window_id,
            is_async=self.is_async,
            priority=self.priority,
        )
    
    def with_target(self, target_window_id: str) -> WindowOperation:
        """Create a new operation with a different target window."""
        return WindowOperation(
            operation_type=self.operation_type,
            parameters=self.parameters,
            target_window_id=target_window_id,
            is_async=self.is_async,
            priority=self.priority,
        )
    
    def with_priority(self, priority: int) -> WindowOperation:
        """Create a new operation with different priority."""
        return WindowOperation(
            operation_type=self.operation_type,
            parameters=self.parameters,
            target_window_id=self.target_window_id,
            is_async=self.is_async,
            priority=priority,
        )
    
    def as_async(self) -> WindowOperation:
        """Create an asynchronous version of this operation."""
        return WindowOperation(
            operation_type=self.operation_type,
            parameters=self.parameters,
            target_window_id=self.target_window_id,
            is_async=True,
            priority=self.priority,
        )
    
    def as_sync(self) -> WindowOperation:
        """Create a synchronous version of this operation."""
        return WindowOperation(
            operation_type=self.operation_type,
            parameters=self.parameters,
            target_window_id=self.target_window_id,
            is_async=False,
            priority=self.priority,
        )