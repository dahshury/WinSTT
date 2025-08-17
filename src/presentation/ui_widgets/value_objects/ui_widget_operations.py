"""UI Widget Operations Value Objects

This module contains enums and value objects related to UI widget operations,
including creation, event handling, and state management.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from src.domain.common.value_object import ValueObject


class CreateResult(Enum):
    """Enumeration of widget creation results."""
    SUCCESS = "success"
    FAILED = "failed"
    VALIDATION_FAILED = "validation_failed"
    CREATION_FAILED = "creation_failed"
    STYLING_FAILED = "styling_failed"
    CONFIGURATION_FAILED = "configuration_failed"


class CreatePhase(Enum):
    """Enumeration of widget creation phases for progress tracking."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    CREATION = "creation"
    STYLING = "styling"
    PARAMETER_VALIDATION = "parameter_validation"
    WIDGET_CREATION = "widget_creation"
    STYLING_APPLICATION = "styling_application"
    PARENT_ATTACHMENT = "parent_attachment"
    EVENT_CONNECTION = "event_connection"
    COMPLETION = "completion"


class ToggleStyle(Enum):
    """Enumeration of toggle switch styles."""
    DEFAULT = "default"
    MOBILE = "mobile"
    MINIMAL = "minimal"
    CUSTOM = "custom"


class ToggleSize(Enum):
    """Enumeration of toggle switch sizes."""
    SMALL = "small"  # 23x11
    MEDIUM = "medium"  # 46x22
    LARGE = "large"  # 69x33
    CUSTOM = "custom"


class HandleResult(Enum):
    """Enumeration of possible event handling results."""
    SUCCESS = "success"
    FAILED = "failed"
    VALIDATION_FAILED = "validation_failed"
    EVENT_NOT_SUPPORTED = "event_not_supported"
    WIDGET_NOT_FOUND = "widget_not_found"
    HANDLER_ERROR = "handler_error"
    STATE_UPDATE_ERROR = "state_update_error"
    VALIDATION_ERROR = "validation_error"
    INTERNAL_ERROR = "internal_error"


class HandlePhase(Enum):
    """Enumeration of event handling phases for progress tracking."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    PROCESSING = "processing"
    EVENT_VALIDATION = "event_validation"
    WIDGET_VALIDATION = "widget_validation"
    HANDLER_LOOKUP = "handler_lookup"
    EVENT_PROCESSING = "event_processing"
    STATE_MANAGEMENT = "state_management"
    RESPONSE_COORDINATION = "response_coordination"
    COMPLETION = "completion"


class EventType(Enum):
    """Enumeration of supported event types."""
    CLICK = "click"
    MOUSE_PRESS = "mouse_press"
    MOUSE_RELEASE = "mouse_release"
    MOUSE_CLICK = "mouse_click"
    KEY_PRESS = "key_press"
    KEY_RELEASE = "key_release"
    VALUE_CHANGED = "value_changed"
    TEXT_CHANGED = "text_changed"
    SELECTION_CHANGED = "selection_changed"
    FOCUS_IN = "focus_in"
    FOCUS_OUT = "focus_out"
    CUSTOM = "custom"


class UpdateResult(Enum):
    """Enumeration of possible widget state update results."""
    SUCCESS = "success"
    VALIDATION_ERROR = "validation_error"
    WIDGET_NOT_FOUND = "widget_not_found"
    STATE_CONFLICT = "state_conflict"
    VISUAL_UPDATE_ERROR = "visual_update_error"
    INTERNAL_ERROR = "internal_error"


class UpdatePhase(Enum):
    """Enumeration of widget state update phases for progress tracking."""
    INITIALIZATION = "initialization"
    WIDGET_VALIDATION = "widget_validation"
    STATE_VALIDATION = "state_validation"
    STATE_UPDATE = "state_update"
    VISUAL_FEEDBACK = "visual_feedback"
    EVENT_EMISSION = "event_emission"
    COMPLETION = "completion"


class WidgetType(Enum):
    """Enumeration of supported widget types."""
    TOGGLE_SWITCH = "toggle_switch"
    COMBO_BOX = "combo_box"
    LINE_EDIT = "line_edit"
    TEXT_EDIT = "text_edit"
    SLIDER = "slider"
    BUTTON = "button"
    CHECKBOX = "checkbox"
    RADIO_BUTTON = "radio_button"


class EventPriority(Enum):
    """Enumeration of event handling priorities."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


class StateChangeType(Enum):
    """Enumeration of state change types."""
    VALUE_CHANGE = "value_change"
    ENABLED_CHANGE = "enabled_change"
    VISIBILITY_CHANGE = "visibility_change"
    STYLE_CHANGE = "style_change"
    TEXT_CHANGE = "text_change"
    SELECTION_CHANGE = "selection_change"
    PROPERTY_CHANGE = "property_change"


class WidgetProperty(Enum):
    """Widget property enumeration."""
    WIDTH = "width"
    HEIGHT = "height"
    POSITION_X = "position_x"
    POSITION_Y = "position_y"
    VISIBLE = "visible"
    ENABLED = "enabled"
    TEXT = "text"
    VALUE = "value"
    STYLE = "style"
    COLOR = "color"
    BACKGROUND_COLOR = "background_color"
    FONT = "font"
    FONT_SIZE = "font_size"
    OPACITY = "opacity"
    Z_ORDER = "z_order"


class WidgetOperationType(Enum):
    """Types of widget operations."""
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    SHOW = "show"
    HIDE = "hide"
    ENABLE = "enable"
    DISABLE = "disable"
    MOVE = "move"
    RESIZE = "resize"
    STYLE = "style"
    FOCUS = "focus"
    BLUR = "blur"
    CLICK = "click"
    HOVER = "hover"


@dataclass(frozen=True)
class WidgetOperation(ValueObject):
    """Represents an operation to be performed on a widget."""
    
    operation_type: WidgetOperationType
    widget_id: str
    parameters: dict[str, Any] | None = None
    priority: int = 0
    is_async: bool = False
    timeout_ms: int | None = None
    
    def __post_init__(self) -> None:
        """Validate widget operation parameters."""
        if not isinstance(self.operation_type, WidgetOperationType):
            msg = "operation_type must be a WidgetOperationType"
            raise ValueError(msg)
        
        if not self.widget_id or not isinstance(self.widget_id, str):
            msg = "widget_id must be a non-empty string"
            raise ValueError(msg)
        
        if self.parameters is not None and not isinstance(self.parameters, dict):
            msg = "parameters must be a dictionary or None"
            raise ValueError(msg)
        
        if self.priority < 0:
            msg = "priority must be non-negative"
            raise ValueError(msg)
        
        if self.timeout_ms is not None and self.timeout_ms <= 0:
            msg = "timeout_ms must be positive"
            raise ValueError(msg)
    
    def with_parameters(self, **kwargs: Any) -> WidgetOperation:
        """Create a new operation with additional parameters."""
        current_params = self.parameters or {}
        new_params = {**current_params, **kwargs}
        
        return WidgetOperation(
            operation_type=self.operation_type,
            widget_id=self.widget_id,
            parameters=new_params,
            priority=self.priority,
            is_async=self.is_async,
            timeout_ms=self.timeout_ms,
        )
    
    def with_priority(self, priority: int) -> WidgetOperation:
        """Create a new operation with different priority."""
        return WidgetOperation(
            operation_type=self.operation_type,
            widget_id=self.widget_id,
            parameters=self.parameters,
            priority=priority,
            is_async=self.is_async,
            timeout_ms=self.timeout_ms,
        )


@dataclass(frozen=True)
class WidgetOperationResult(ValueObject):
    """Result of a widget operation."""
    
    operation: WidgetOperation
    success: bool
    message: str = ""
    data: dict[str, Any] | None = None
    execution_time_ms: int = 0
    
    def __post_init__(self) -> None:
        """Validate operation result."""
        if not isinstance(self.operation, WidgetOperation):
            msg = "operation must be a WidgetOperation"
            raise ValueError(msg)
        
        if self.execution_time_ms < 0:
            msg = "execution_time_ms must be non-negative"
            raise ValueError(msg)
    
    @classmethod
    def success_result(
        cls,
        operation: WidgetOperation,
        message: str = "Operation completed successfully",
        data: dict[str, Any] | None = None,
        execution_time_ms: int = 0,
    ) -> WidgetOperationResult:
        """Create a successful operation result."""
        return cls(
            operation=operation,
            success=True,
            message=message,
            data=data,
            execution_time_ms=execution_time_ms,
        )
    
    @classmethod
    def failure_result(
        cls,
        operation: WidgetOperation,
        message: str = "Operation failed",
        execution_time_ms: int = 0,
    ) -> WidgetOperationResult:
        """Create a failed operation result."""
        return cls(
            operation=operation,
            success=False,
            message=message,
            data=None,
            execution_time_ms=execution_time_ms,
        )