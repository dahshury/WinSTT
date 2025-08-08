"""Visualization Component for voice visualizer integration.

This module provides voice visualization functionality following the
hexagonal architecture pattern.
"""

import logging
from typing import Any

from PyQt6.QtCore import QObject, Qt, QTimer, pyqtSignal
from PyQt6.QtWidgets import QMainWindow, QVBoxLayout, QWidget

try:
    import pyqtgraph as _pg  # type: ignore[import-not-found]
    pg: Any = _pg
    PYQTGRAPH_AVAILABLE = True
except Exception:
    PYQTGRAPH_AVAILABLE = False
    pg = None  # type: ignore[assignment]

from src_refactored.domain.ui_coordination.value_objects.ui_state_management import UIState
from src_refactored.infrastructure.audio_visualization import (
    AudioProcessorService,
    VisualizationControllerService,
)


class VisualizationComponent(QObject):
    """Component for managing voice visualization.
    
    This component handles voice visualizer integration, audio data
    visualization, and real-time waveform display.
    """

    # Signals
    visualization_started = pyqtSignal()
    visualization_stopped = pyqtSignal()
    visualization_error = pyqtSignal(str)

    def __init__(self):
        super().__init__()
        self.logger = logging.getLogger(__name__)
        # Initialize services with proper dependencies
        self.audio_viz_service = AudioProcessorService()
        self.visualization_service = VisualizationControllerService(self.audio_viz_service)

        # Visualization state
        self.is_visualizing = False
        self.visualization_widget: QWidget | None = None
        self.plot_widget: Any | None = None
        self.plot_item: Any | None = None
        self.curve: Any | None = None

        # Timer for updates
        self.update_timer = QTimer()
        self.update_timer.timeout.connect(self._update_visualization)

        # Check PyQtGraph availability
        if not PYQTGRAPH_AVAILABLE:
            self.logger.warning("PyQtGraph not available - visualization disabled")

    def setup_visualization(self, main_window: QMainWindow,
    ) -> None:
        """Setup voice visualization for the main window.
        
        Args:
            main_window: The main window to setup visualization for
        """
        self.logger.info("🎵 Setting up voice visualization...")

        if not PYQTGRAPH_AVAILABLE:
            self.logger.warning("Skipping visualization setup - PyQtGraph not available")
            return

        try:
            # Create visualization widget
            self._create_visualization_widget(main_window)

            # Setup plot widget
            self._setup_plot_widget()

            # Configure visualization appearance
            self._configure_visualization_appearance()

            # Setup visualization behavior
            self._setup_visualization_behavior()

            self.logger.info("✅ Voice visualization setup complete")

        except Exception as e:
            self.logger.exception(f"Failed to setup visualization: {e}")
            self.visualization_error.emit(str(e))

    def _create_visualization_widget(self, main_window: QMainWindow,
    ) -> None:
        """Create the visualization widget container.
        
        Args:
            main_window: The main window
        """
        # Create visualization container
        self.visualization_widget = QWidget(main_window)
        self.visualization_widget.setObjectName("visualization_widget")

        # Set initial properties
        self.visualization_widget.setVisible(False)
        self.visualization_widget.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)

        # Create layout
        layout = QVBoxLayout(self.visualization_widget)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self.logger.debug("Visualization widget created")

    def _setup_plot_widget(self) -> None:
        """Setup the PyQtGraph plot widget."""
        if not PYQTGRAPH_AVAILABLE or not self.visualization_widget:
            return

        # Create plot widget
        self.plot_widget = pg.PlotWidget()
        self.plot_widget.setObjectName("plot_widget")

        # Get plot item
        self.plot_item = self.plot_widget.getPlotItem()

        # Configure plot item
        if self.plot_item:
            # Hide axes
            self.plot_item.hideAxis("left")
            self.plot_item.hideAxis("bottom")

            # Remove padding
            self.plot_item.setContentsMargins(0, 0, 0, 0)

            # Set background
            self.plot_item.setBackground(None)

        # Add to layout
        layout = self.visualization_widget.layout()
        if layout:
            layout.addWidget(self.plot_widget)

        self.logger.debug("Plot widget setup complete")

    def _configure_visualization_appearance(self) -> None:
        """Configure the visual appearance of the visualization."""
        if not PYQTGRAPH_AVAILABLE or not self.plot_widget:
            return

        # Set transparent background
        self.plot_widget.setBackground(None)

        # Configure plot styling
        if self.plot_item:
            # Set view range
            self.plot_item.setXRange(0, 1000, padding=0)
            self.plot_item.setYRange(-1, 1, padding=0)

            # Disable auto-range
            self.plot_item.enableAutoRange(False)

            # Disable mouse interaction
            self.plot_item.setMouseEnabled(x=False, y=False)

            # Hide grid
            self.plot_item.showGrid(x=False, y=False)

        # Create curve for waveform
        if self.plot_item:
            pen = pg.mkPen(color=(255, 255, 255, 180), width=2)
            self.curve = self.plot_item.plot(pen=pen)

        self.logger.debug("Visualization appearance configured")

    def _setup_visualization_behavior(self) -> None:
        """Setup visualization behavior and interactions."""
        if not self.visualization_widget:
            return

        # Set widget properties
        self.visualization_widget.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.visualization_widget.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)

        # Configure update timer
        self.update_timer.setInterval(50)  # 20 FPS

        self.logger.debug("Visualization behavior configured")

    def start_visualization(self) -> None:
        """Start the voice visualization."""
        if not PYQTGRAPH_AVAILABLE:
            self.logger.warning("Cannot start visualization - PyQtGraph not available")
            return

        if self.is_visualizing:
            self.logger.debug("Visualization already running")
            return

        self.logger.info("Starting voice visualization")

        try:
            # Show visualization widget
            if self.visualization_widget:
                self.visualization_widget.setVisible(True)
                self.visualization_widget.raise_()

            # Start update timer
            self.update_timer.start()

            # Update state
            self.is_visualizing = True

            # Emit signal
            self.visualization_started.emit()

            self.logger.debug("Voice visualization started")

        except Exception as e:
            self.logger.exception(f"Failed to start visualization: {e}")
            self.visualization_error.emit(str(e))

    def stop_visualization(self) -> None:
        """Stop the voice visualization."""
        if not self.is_visualizing:
            self.logger.debug("Visualization not running")
            return

        self.logger.info("Stopping voice visualization")

        try:
            # Stop update timer
            self.update_timer.stop()

            # Hide visualization widget
            if self.visualization_widget:
                self.visualization_widget.setVisible(False)

            # Clear curve data
            if self.curve:
                self.curve.setData([], [])

            # Update state
            self.is_visualizing = False

            # Emit signal
            self.visualization_stopped.emit()

            self.logger.debug("Voice visualization stopped")

        except Exception as e:
            self.logger.exception(f"Failed to stop visualization: {e}")
            self.visualization_error.emit(str(e))

    def _update_visualization(self) -> None:
        """Update the visualization with current audio data."""
        if not self.is_visualizing or not self.curve:
            return

        try:
            # Get audio data from service
            audio_data = self.audio_viz_service.get_current_audio_data()

            if audio_data is not None and len(audio_data) > 0:
                # Prepare data for plotting
                x_data = list(range(len(audio_data)))
                y_data = audio_data.tolist() if hasattr(audio_data, "tolist") else list(audio_data)

                # Update curve
                self.curve.setData(x_data, y_data)
            else:
                # Clear curve if no data
                self.curve.setData([], [])

        except Exception as e:
            self.logger.exception(f"Failed to update visualization: {e}")

    def set_visualization_position(self, x: int, y: int, width: int, height: int,
    ) -> None:
        """Set the position and size of the visualization widget.
        
        Args:
            x: X coordinate
            y: Y coordinate
            width: Width
            height: Height
        """
        if self.visualization_widget:
            self.visualization_widget.setGeometry(x, y, width, height)
            self.logger.debug("Visualization position set: ({x}, {y}, {width}, {height})")

    def set_visualization_opacity(self, opacity: float,
    ) -> None:
        """Set the opacity of the visualization.
        
        Args:
            opacity: Opacity value between 0.0 and 1.0
        """
        if self.visualization_widget:
            # Clamp opacity value
            opacity = max(0.0, min(1.0, opacity))
            self.visualization_widget.setWindowOpacity(opacity)
            self.logger.debug("Visualization opacity set: {opacity}")

    def apply_state_styling(self, state: UIState,
    ) -> None:
        """Apply state-specific styling to the visualization.
        
        Args:
            state: The UI state to apply
        """
        if not PYQTGRAPH_AVAILABLE or not self.curve:
            return

        self.logger.debug("Applying visualization state styling: {state.value}")

        # Update curve color based on state
        if state == UIState.LOADING:
            pen = pg.mkPen(color=(255, 170, 0, 180), width=2)  # Orange
        elif state == UIState.ERROR:
            pen = pg.mkPen(color=(255, 0, 0, 180), width=2)  # Bright red
        elif state == UIState.SUCCESS:
            pen = pg.mkPen(color=(0, 255, 0, 180), width=2)  # Green
        else:  # ENABLED/DISABLED
            pen = pg.mkPen(color=(255, 255, 255, 180), width=2)  # White

        self.curve.setPen(pen)

    def set_audio_data(self, audio_data: Any,
    ) -> None:
        """Set audio data for visualization.
        
        Args:
            audio_data: Audio data to visualize
        """
        try:
            # Pass data to audio visualization service
            self.audio_viz_service.update_audio_data(audio_data)

        except Exception as e:
            self.logger.exception(f"Failed to set audio data: {e}")

    def toggle_visualization(self) -> None:
        """Toggle visualization on/off."""
        if self.is_visualizing:
            self.stop_visualization()
        else:
            self.start_visualization()

    def is_visualization_available(self) -> bool:
        """Check if visualization is available.
        
        Returns:
            True if visualization is available, False otherwise
        """
        return PYQTGRAPH_AVAILABLE

    def get_visualization_widget(self) -> QWidget | None:
        """Get the visualization widget.
        
        Returns:
            The visualization widget or None
        """
        return self.visualization_widget

    def cleanup(self) -> None:
        """Cleanup visualization resources."""
        self.logger.info("Cleaning up visualization component")

        # Stop visualization
        if self.is_visualizing:
            self.stop_visualization()

        # Stop timer
        if self.update_timer.isActive():
            self.update_timer.stop()

        # Clear references
        self.curve = None
        self.plot_item = None
        self.plot_widget = None

        if self.visualization_widget:
            self.visualization_widget.deleteLater()
            self.visualization_widget = None

        self.logger.debug("Visualization component cleanup complete")