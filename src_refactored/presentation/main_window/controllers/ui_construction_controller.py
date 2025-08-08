"""UI Construction Controller for the main window.

This controller encapsulates building the main window UI via the existing
`MainWindowUIBuilder`, keeping the `QMainWindow` class thin and focused on
composition and event forwarding.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from src_refactored.presentation.main_window.builders.main_window_builder import (
    MainWindowUIBuilder,
)

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.domain.common.ports.logging_port import LoggingPort
    from src_refactored.presentation.adapters.pyqtgraph_renderer_adapter import (
        PyQtGraphRendererAdapter,
    )
    from src_refactored.presentation.main_window.components.progress_indicator_component import (
        ProgressIndicatorComponent,
    )
    from src_refactored.presentation.main_window.components.status_display_component import (
        StatusDisplayComponent,
    )


class IResourceService(Protocol):
    """Resource service protocol expected by the controller."""

    def get_resource_path(self, relative_path: str) -> str: ...


class IThemeService(Protocol):
    """Theme service protocol expected by the controller."""

    # Marker protocol - current builder takes a concrete UIThemeService


@dataclass
class BuiltUI:
    """Holds references to built UI sub-systems."""

    status_display: StatusDisplayComponent
    progress_indicator: ProgressIndicatorComponent
    visualization_renderer: PyQtGraphRendererAdapter


class UIConstructionController:
    """Controller that orchestrates building the main window UI using the builder."""

    def __init__(self, logger: LoggingPort) -> None:
        self._logger = logger

    def build(
        self,
        parent_widget: object,
        resources: IResourceService,
        theme_service: IThemeService,
        recording_key: str,
        has_hw_acceleration: bool,
        on_settings_clicked: Callable[[], None],
    ) -> BuiltUI:
        """Build all UI components and return references to them.

        Args:
            parent_widget: Central widget to attach UI controls to
            resources: Resource service to resolve paths
            theme_service: Theme service for colors/fonts
            recording_key: Current hotkey to include in instruction text
            has_hw_acceleration: Whether to show enabled state on the indicator
            on_settings_clicked: Callback invoked when settings button is pressed
        """
        # The builder expects a concrete UIThemeService; relax via type: ignore
        builder = MainWindowUIBuilder(parent_widget, resources, theme_service, self._logger)  # type: ignore[arg-type]

        builder.build_status_components() \
            .build_progress_components() \
            .build_visualization_renderer() \
            .build_settings_button(on_settings_clicked) \
            .build_hardware_acceleration_indicator(has_hw_acceleration) \
            .build_logo_and_background() \
            .configure_instruction_text(recording_key)

        status_display = builder.get_status_display()
        progress_indicator = builder.get_progress_indicator()
        visualization_renderer = builder.get_visualization_renderer()

        # Return simple container with references
        return BuiltUI(
            status_display=status_display,
            progress_indicator=progress_indicator,
            visualization_renderer=visualization_renderer,
        )


