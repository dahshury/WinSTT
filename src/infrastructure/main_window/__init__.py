"""Main window infrastructure services package.

This package contains infrastructure services for main window operations,
including window configuration, UI layout, visualization integration,
opacity effects, text management, and widget layering.
"""

from .opacity_effects_service import OpacityEffectsService
from .ui_layout_service import UILayoutService
from .ui_text_management_service import UITextManagementService
from .visualization_integration_service import VisualizationIntegrationService
from .widget_layering_service import WidgetLayeringService
from .window_configuration_service import WindowConfigurationService

__all__ = [
    "OpacityEffectsService",
    "UILayoutService",
    "UITextManagementService",
    "VisualizationIntegrationService",
    "WidgetLayeringService",
    "WindowConfigurationService",
]