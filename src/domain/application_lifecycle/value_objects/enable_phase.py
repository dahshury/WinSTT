"""Enable Phase Value Object

Defines the phases of enablement processes.
"""

from enum import Enum


class EnablePhase(Enum):
    """Phases of drag and drop enablement process."""
    INITIALIZATION = "initialization"
    VALIDATION = "validation"
    WIDGET_CONFIGURATION = "widget_configuration"
    HANDLER_SETUP = "handler_setup"
    FILE_VALIDATION = "file_validation"
    EVENT_BINDING = "event_binding"
    FINALIZATION = "finalization"