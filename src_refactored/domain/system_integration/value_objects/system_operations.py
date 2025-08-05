"""System Integration Operations Value Objects.

This module defines value objects for system integration operations including
result types, phases, and operational enums.
"""

from enum import Enum


class EnableResult(Enum):
    """Result status for drag and drop enabling."""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL_SUCCESS = "partial_success"
    VALIDATION_ERROR = "validation_error"
    SYSTEM_ERROR = "system_error"
    PERMISSION_ERROR = "permission_error"
    COMPATIBILITY_ERROR = "compatibility_error"


class InitializeResult(Enum):
    """Result status for system tray initialization."""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL_SUCCESS = "partial_success"
    VALIDATION_ERROR = "validation_error"
    SYSTEM_ERROR = "system_error"
    ICON_ERROR = "icon_error"
    MENU_ERROR = "menu_error"


class KeyEventType(Enum):
    """Types of keyboard events."""
    KEY_DOWN = "down"
    KEY_UP = "up"


class KeyboardServiceResult(Enum):
    """Results of keyboard service operations."""
    SUCCESS = "success"
    FAILURE = "failure"
    ALREADY_HOOKED = "already_hooked"
    NOT_HOOKED = "not_hooked"
    INVALID_COMBINATION = "invalid_combination"


class InitializePhase(Enum):
    """Phases of system tray initialization process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    ICON_LOADING = "icon_loading"
    MENU_CREATION = "menu_creation"
    EVENT_BINDING = "event_binding"
    SYSTEM_REGISTRATION = "system_registration"
    FINALIZATION = "finalization"


class TrayIconType(Enum):
    """Types of system tray icons."""
    DEFAULT = "default"
    RECORDING = "recording"
    PROCESSING = "processing"
    ERROR = "error"
    DISABLED = "disabled"
    CUSTOM = "custom"


class MenuItemType(Enum):
    """Types of system tray menu items."""
    ACTION = "action"
    SEPARATOR = "separator"
    SUBMENU = "submenu"
    CHECKBOX = "checkbox"
    RADIO = "radio"
    DISABLED = "disabled"


class InstallResult(Enum):
    """Result status for event filter installation."""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL_SUCCESS = "partial_success"
    VALIDATION_ERROR = "validation_error"
    FILTER_ERROR = "filter_error"
    EVENT_ERROR = "event_error"
    SYSTEM_ERROR = "system_error"


class InstallPhase(Enum):
    """Phases of event filter installation process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    FILTER_CREATION = "filter_creation"
    EVENT_BINDING = "event_binding"
    SYSTEM_REGISTRATION = "system_registration"
    TESTING = "testing"
    FINALIZATION = "finalization"


class FilterType(Enum):
    """Types of event filters."""
    GLOBAL = "global"
    APPLICATION = "application"
    WIDGET = "widget"
    KEYBOARD = "keyboard"
    MOUSE = "mouse"
    CUSTOM = "custom"


class EventType(Enum):
    """Types of events to filter."""
    KEY_PRESS = "key_press"
    KEY_RELEASE = "key_release"
    MOUSE_PRESS = "mouse_press"
    MOUSE_RELEASE = "mouse_release"
    MOUSE_MOVE = "mouse_move"
    WHEEL = "wheel"
    FOCUS = "focus"
    WINDOW = "window"
    CUSTOM = "custom"


class ManageResult(Enum):
    """Result status for geometry management."""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL_SUCCESS = "partial_success"
    VALIDATION_ERROR = "validation_error"
    CONSTRAINT_ERROR = "constraint_error"
    SCREEN_ERROR = "screen_error"
    ANIMATION_ERROR = "animation_error"


class ManagePhase(Enum):
    """Phases of geometry management process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    SCREEN_ANALYSIS = "screen_analysis"
    CONSTRAINT_CHECKING = "constraint_checking"
    GEOMETRY_CALCULATION = "geometry_calculation"
    ANIMATION_SETUP = "animation_setup"
    GEOMETRY_APPLICATION = "geometry_application"
    STATE_PERSISTENCE = "state_persistence"
    FINALIZATION = "finalization"


class GeometryOperation(Enum):
    """Types of geometry operations."""
    MOVE = "move"
    RESIZE = "resize"
    MOVE_AND_RESIZE = "move_and_resize"
    CENTER = "center"
    MAXIMIZE = "maximize"
    MINIMIZE = "minimize"
    RESTORE = "restore"
    FIT_TO_SCREEN = "fit_to_screen"
    SNAP_TO_EDGE = "snap_to_edge"


class PositionMode(Enum):
    """Positioning modes for geometry management."""
    ABSOLUTE = "absolute"
    RELATIVE = "relative"
    CENTERED = "centered"
    SMART = "smart"
    CUSTOM = "custom"


class SetupResult(Enum):
    """Result status for worker threads setup."""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL_SUCCESS = "partial_success"
    VALIDATION_ERROR = "validation_error"
    THREAD_ERROR = "thread_error"
    COORDINATION_ERROR = "coordination_error"
    TIMEOUT_ERROR = "timeout_error"


class SetupPhase(Enum):
    """Phases of worker threads setup process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    THREAD_CREATION = "thread_creation"
    COORDINATION_SETUP = "coordination_setup"
    LIFECYCLE_MANAGEMENT = "lifecycle_management"
    MONITORING_SETUP = "monitoring_setup"
    FINALIZATION = "finalization"


class ThreadType(Enum):
    """Types of worker threads."""
    AUDIO_PROCESSING = "audio_processing"
    TRANSCRIPTION = "transcription"
    MODEL_LOADING = "model_loading"
    FILE_PROCESSING = "file_processing"
    BACKGROUND_TASK = "background_task"
    MONITORING = "monitoring"
    CLEANUP = "cleanup"


class ThreadPriority(Enum):
    """Thread priority levels."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"
    REAL_TIME = "real_time"


class ErrorSeverity(Enum):
    """Error severity levels for different types of errors."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class ExitCode(Enum):
    """Standard application exit codes."""
    SUCCESS = 0
    GENERAL_ERROR = 1
    ALREADY_RUNNING = 2
    STARTUP_FAILURE = 3
    CONFIGURATION_ERROR = 4
    RESOURCE_ERROR = 5


class ThreadState(Enum):
    """Thread state enumeration."""
    CREATED = "created"
    RUNNING = "running"
    STOPPED = "stopped"
    ERROR = "error"