"""Window Operations Value Objects.

This module defines value objects for window management operations including
results, phases, and operational types.
"""

from enum import Enum


class ConfigureResult(Enum):
    """Results for window configuration operations."""
    SUCCESS = "success"
    FAILED = "failed"
    VALIDATION_ERROR = "validation_error"
    WIDGET_ERROR = "widget_error"
    LAYOUT_ERROR = "layout_error"
    PROPERTY_ERROR = "property_error"
    CANCELLED = "cancelled"


class ConfigurePhase(Enum):
    """Phases of window configuration process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    WIDGET_SETUP = "widget_setup"
    LAYOUT_CONFIGURATION = "layout_configuration"
    PROPERTY_APPLICATION = "property_application"
    FINALIZATION = "finalization"


class PropertyType(Enum):
    """Types of window properties."""
    GEOMETRY = "geometry"
    STYLE = "style"
    BEHAVIOR = "behavior"
    APPEARANCE = "appearance"
    INTERACTION = "interaction"
    ACCESSIBILITY = "accessibility"


class InitializeResult(Enum):
    """Results for window initialization operations."""
    SUCCESS = "success"
    FAILED = "failed"
    VALIDATION_ERROR = "validation_error"
    WIDGET_CREATION_ERROR = "widget_creation_error"
    LAYOUT_ERROR = "layout_error"
    SIGNAL_CONNECTION_ERROR = "signal_connection_error"
    RESOURCE_ERROR = "resource_error"
    CANCELLED = "cancelled"


class InitializePhase(Enum):
    """Phases of window initialization process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    WIDGET_CREATION = "widget_creation"
    LAYOUT_SETUP = "layout_setup"
    SIGNAL_CONNECTION = "signal_connection"
    RESOURCE_LOADING = "resource_loading"
    FINALIZATION = "finalization"


class WindowType(Enum):
    """Types of windows."""
    MAIN = "main"
    DIALOG = "dialog"
    POPUP = "popup"
    TOOL = "tool"
    SPLASH = "splash"
    OVERLAY = "overlay"


class ComponentType(Enum):
    """Types of UI components."""
    BUTTON = "button"
    LABEL = "label"
    INPUT = "input"
    MENU = "menu"
    TOOLBAR = "toolbar"
    STATUS_BAR = "status_bar"
    WIDGET = "widget"
    LAYOUT = "layout"


class IntegrateResult(Enum):
    """Results for visualization integration operations."""
    SUCCESS = "success"
    FAILED = "failed"
    VALIDATION_ERROR = "validation_error"
    WIDGET_ERROR = "widget_error"
    INTEGRATION_ERROR = "integration_error"
    RENDERING_ERROR = "rendering_error"
    CANCELLED = "cancelled"


class IntegratePhase(Enum):
    """Phases of visualization integration process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    WIDGET_PREPARATION = "widget_preparation"
    INTEGRATION_SETUP = "integration_setup"
    RENDERING_CONFIGURATION = "rendering_configuration"
    FINALIZATION = "finalization"


class VisualizationType(Enum):
    """Types of visualizations."""
    WAVEFORM = "waveform"
    SPECTRUM = "spectrum"
    LEVEL_METER = "level_meter"
    OSCILLOSCOPE = "oscilloscope"
    SPECTROGRAM = "spectrogram"


class RenderingMode(Enum):
    """Rendering modes for visualizations."""
    REAL_TIME = "real_time"
    BUFFERED = "buffered"
    STATIC = "static"
    INTERACTIVE = "interactive"