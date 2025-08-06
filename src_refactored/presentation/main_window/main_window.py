"""Main window presenter for presentation layer.

This presenter follows MVP pattern and delegates business logic to application services.
Replaces the previous MainWindow aggregate that violated hexagonal architecture.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from src_refactored.domain.common.result import Result

if TYPE_CHECKING:
    from src_refactored.application.interfaces.main_window_service import (
        IMainWindowService,
        WindowMetrics,
        WindowMode,
        WindowState,
    )
    from src_refactored.presentation.main_window.value_objects.opacity_level import OpacityLevel
    from src_refactored.presentation.main_window.value_objects.ui_layout import UILayout
    from src_refactored.presentation.main_window.value_objects.visualization_integration import (
        VisualizationIntegration,
    )
    from src_refactored.presentation.main_window.value_objects.window_configuration import (
        WindowConfiguration,
    )


class MainWindowPresenter:
    """Main window presenter coordinating with application services.
    
    This presenter handles UI concerns and delegates business logic to application services,
    following hexagonal architecture principles.
    """

    def __init__(
        self,
        window_id: str,
        main_window_service: IMainWindowService,
        configuration: WindowConfiguration,
        ui_layout: UILayout,
        visualization: VisualizationIntegration,
    ):
        """Initialize the main window presenter.
        
        Args:
            window_id: Unique identifier for the window
            main_window_service: Application service for main window operations
            configuration: Window configuration (presentation-specific)
            ui_layout: UI layout configuration (presentation-specific)
            visualization: Visualization integration (presentation-specific)
        """
        self._window_id = window_id
        self._main_window_service = main_window_service
        self._configuration = configuration
        self._ui_layout = ui_layout
        self._visualization = visualization
        self._created_at = datetime.utcnow()

    @classmethod
    def create(
        cls,
        main_window_service: IMainWindowService,
        configuration: WindowConfiguration,
        ui_layout: UILayout,
        visualization: VisualizationIntegration,
    ) -> Result[MainWindowPresenter]:
        """Create a new main window presenter."""
        try:
            window_id = f"main_window_{datetime.utcnow().timestamp()}"
            presenter = cls(window_id, main_window_service, configuration, ui_layout, visualization)
            return Result.success(presenter)
        except Exception as e:
            return Result.failure(f"Failed to create main window presenter: {e!s}")

    def initialize(self) -> Result[None]:
        """Initialize the main window through application service."""
        # Initialize UI layout (presentation concern)
        layout_result = self._ui_layout.initialize()
        if not layout_result.is_success:
            return Result.failure(f"Failed to initialize UI layout: {layout_result.error()}")

        # Initialize visualization (presentation concern)
        viz_result = self._visualization.initialize()
        if not viz_result.is_success:
            return Result.failure(f"Failed to initialize visualization: {viz_result.error()}")

        # Delegate business logic to application service
        return self._main_window_service.initialize_window(self._window_id)

    def start_recording(self) -> Result[None]:
        """Start recording mode through application service."""
        # Delegate to application service for business logic
        service_result = self._main_window_service.start_recording(self._window_id)
        if not service_result.is_success:
            return service_result

        # Handle presentation-specific visualization updates
        viz_result = self._visualization.start_recording()
        if not viz_result.is_success:
            return Result.failure(f"Failed to update visualization: {viz_result.error()}")

        return Result.success(None)

    def stop_recording(self) -> Result[None]:
        """Stop recording mode through application service."""
        # Delegate to application service for business logic
        service_result = self._main_window_service.stop_recording(self._window_id)
        if not service_result.is_success:
            return service_result

        # Handle presentation-specific visualization updates
        viz_result = self._visualization.stop_recording()
        if not viz_result.is_success:
            return Result.failure(f"Failed to update visualization: {viz_result.error()}")

        return Result.success(None)

    def complete_transcription(self) -> Result[None]:
        """Complete transcription through application service."""
        return self._main_window_service.complete_transcription(self._window_id)

    def minimize(self) -> Result[None]:
        """Minimize the window through application service."""
        return self._main_window_service.minimize_window(self._window_id)

    def restore(self) -> Result[None]:
        """Restore the window through application service."""
        return self._main_window_service.restore_window(self._window_id)

    def set_mode(self, mode: WindowMode) -> Result[None]:
        """Set window display mode through application service."""
        return self._main_window_service.set_window_mode(self._window_id, mode)

    def apply_opacity_effect(self, effect_name: str, opacity: OpacityLevel) -> Result[None]:
        """Apply an opacity effect through application service."""
        opacity_value = opacity.value if hasattr(opacity, "value") else float(opacity)
        return self._main_window_service.apply_opacity_effect(self._window_id, effect_name, opacity_value)

    def remove_opacity_effect(self, effect_name: str) -> Result[None]:
        """Remove an opacity effect through application service."""
        return self._main_window_service.remove_opacity_effect(self._window_id, effect_name)

    def close(self) -> Result[None]:
        """Close the window through application service."""
        return self._main_window_service.close_window(self._window_id)

    # Read-only properties that delegate to application service
    def get_state(self) -> Result[WindowState]:
        """Get current window state from application service."""
        return self._main_window_service.get_window_state(self._window_id)

    def get_mode(self) -> Result[WindowMode]:
        """Get current window mode from application service."""
        return self._main_window_service.get_window_mode(self._window_id)

    def get_metrics(self) -> Result[WindowMetrics]:
        """Get window metrics from application service."""
        return self._main_window_service.get_window_metrics(self._window_id)

    def is_transcribing(self) -> Result[bool]:
        """Check if window is transcribing from application service."""
        return self._main_window_service.is_transcribing(self._window_id)

    # Presentation-specific properties (not delegated to application service)
    @property
    def window_id(self) -> str:
        """Get window identifier."""
        return self._window_id

    @property
    def configuration(self) -> WindowConfiguration:
        """Get window configuration (presentation concern)."""
        return self._configuration

    @property
    def ui_layout(self) -> UILayout:
        """Get UI layout (presentation concern)."""
        return self._ui_layout

    @property
    def visualization(self) -> VisualizationIntegration:
        """Get visualization integration (presentation concern)."""
        return self._visualization

    @property
    def created_at(self) -> datetime:
        """Get presenter creation timestamp."""
        return self._created_at

    @property
    def uptime(self) -> float:
        """Get presenter uptime in seconds."""
        return (datetime.utcnow() - self._created_at).total_seconds()


# Backward compatibility alias - will be removed after full migration
MainWindow = MainWindowPresenter