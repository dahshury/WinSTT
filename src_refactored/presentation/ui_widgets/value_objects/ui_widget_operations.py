"""UI Widget Operations Value Objects

This module contains enums and value objects related to UI widget operations,
including creation, event handling, and state management.
"""

from enum import Enum


class CreateResult(Enum):
    """Enumeration of possible widget creation results."""
    SUCCESS = "success"
    VALIDATION_ERROR = "validation_error"
    STYLING_ERROR = "styling_error"
    PARENT_ERROR = "parent_error"
    INTERNAL_ERROR = "internal_error"


class CreatePhase(Enum):
    """Enumeration of widget creation phases for progress tracking."""
    INITIALIZATION = "initialization"
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
    EVENT_NOT_SUPPORTED = "event_not_supported"
    WIDGET_NOT_FOUND = "widget_not_found"
    HANDLER_ERROR = "handler_error"
    STATE_UPDATE_ERROR = "state_update_error"
    VALIDATION_ERROR = "validation_error"
    INTERNAL_ERROR = "internal_error"


class HandlePhase(Enum):
    """Enumeration of event handling phases for progress tracking."""
    INITIALIZATION = "initialization"
    EVENT_VALIDATION = "event_validation"
    WIDGET_VALIDATION = "widget_validation"
    HANDLER_LOOKUP = "handler_lookup"
    EVENT_PROCESSING = "event_processing"
    STATE_MANAGEMENT = "state_management"
    RESPONSE_COORDINATION = "response_coordination"
    COMPLETION = "completion"


class EventType(Enum):
    """Enumeration of supported event types."""
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