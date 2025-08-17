"""UI Layout Value Objects (Domain Layer).

Framework-agnostic enums used by application layer for layout setup.
"""

from enum import Enum


class SetupResult(Enum):
    SUCCESS = "success"
    LAYOUT_CREATION_FAILED = "layout_creation_failed"
    COMPONENT_ARRANGEMENT_FAILED = "component_arrangement_failed"
    CONSTRAINT_VALIDATION_FAILED = "constraint_validation_failed"
    RESPONSIVE_SETUP_FAILED = "responsive_setup_failed"
    VALIDATION_ERROR = "validation_error"
    INTERNAL_ERROR = "internal_error"


class SetupPhase(Enum):
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    LAYOUT_CREATION = "layout_creation"
    COMPONENT_ARRANGEMENT = "component_arrangement"
    CONSTRAINT_APPLICATION = "constraint_application"
    RESPONSIVE_CONFIGURATION = "responsive_configuration"
    FINALIZATION = "finalization"


class ComponentRole(Enum):
    HEADER = "header"
    FOOTER = "footer"
    SIDEBAR = "sidebar"
    MAIN_CONTENT = "main_content"
    TOOLBAR = "toolbar"
    STATUS_BAR = "status_bar"
    NAVIGATION = "navigation"
    CONTROL_PANEL = "control_panel"
    VISUALIZATION = "visualization"


