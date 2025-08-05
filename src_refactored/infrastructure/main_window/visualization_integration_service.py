"""Visualization Integration Service for voice visualizer management.

This module provides infrastructure services for integrating and managing
voice visualization components including audio processing, waveform display,
and fade animations.
"""

import contextlib

import numpy as np
import pyqtgraph as pg
from PyQt6.QtCore import QEasingCurve, QObject, QPropertyAnimation, pyqtSignal
from PyQt6.QtWidgets import QGraphicsOpacityEffect

from logger import setup_logger
from src.ui.voice_visualizer import VoiceVisualizer


class VisualizationIntegrationError(Exception):
    """Exception raised for visualization integration errors."""


class VisualizationIntegrationService(QObject):
    """Service for integrating voice visualization with main window."""

    # Signals
    visualization_started = pyqtSignal()
    visualization_stopped = pyqtSignal()
    visualization_updated = pyqtSignal(np.ndarray)  # waveform_data
    visualization_error = pyqtSignal(str)  # error_message
    fade_animation_finished = pyqtSignal(str)  # animation_type

    def __init__(self):
        """Initialize the visualization integration service."""
        super().__init__()
        self.logger = setup_logger()

        # Visualization components
        self.voice_visualizer_controller: VoiceVisualizer | None = None
        self.plot_widget: pg.PlotWidget | None = None
        self.waveform_plot = None

        # Opacity effects
        self.visualizer_opacity_effect: QGraphicsOpacityEffect | None = None
        self.logo_opacity_effect: QGraphicsOpacityEffect | None = None
        self.title_opacity_effect: QGraphicsOpacityEffect | None = None
        self.settings_opacity_effect: QGraphicsOpacityEffect | None = None
        self.instruction_opacity_effect: QGraphicsOpacityEffect | None = None

        # Animation objects
        self.fade_in_visualizer: QPropertyAnimation | None = None
        self.fade_out_visualizer: QPropertyAnimation | None = None
        self.fade_out_logo: QPropertyAnimation | None = None
        self.fade_out_title: QPropertyAnimation | None = None
        self.fade_out_settings: QPropertyAnimation | None = None
        self.fade_in_logo: QPropertyAnimation | None = None
        self.fade_in_title: QPropertyAnimation | None = None
        self.fade_in_settings: QPropertyAnimation | None = None

        # State tracking
        self.is_visualization_active = False
        self.animation_duration = 500  # milliseconds

        # Waveform configuration
        self.waveform_color = (189, 46, 45)  # Red color
        self.waveform_width = 2.5
        self.downsample_factor = 4  # Take every 4th sample for performance

    def initialize_visualization(self, plot_widget: pg.PlotWidget,
                               visualizer_opacity_effect: QGraphicsOpacityEffect,
                               logo_opacity_effect: QGraphicsOpacityEffect,
                               title_opacity_effect: QGraphicsOpacityEffect,
                               settings_opacity_effect: QGraphicsOpacityEffect,
instruction_opacity_effect: QGraphicsOpacityEffect | None = (
    None) -> bool:)
        """Initialize visualization components and effects.
        
        Args:
            plot_widget: PyQtGraph plot widget for visualization
            visualizer_opacity_effect: Opacity effect for visualizer
            logo_opacity_effect: Opacity effect for logo
            title_opacity_effect: Opacity effect for title
            settings_opacity_effect: Opacity effect for settings button
            instruction_opacity_effect: Optional opacity effect for instruction text
            
        Returns:
            True if initialization successful, False otherwise
        """
        try:
            # Store references
            self.plot_widget = plot_widget
            self.visualizer_opacity_effect = visualizer_opacity_effect
            self.logo_opacity_effect = logo_opacity_effect
            self.title_opacity_effect = title_opacity_effect
            self.settings_opacity_effect = settings_opacity_effect
            self.instruction_opacity_effect = instruction_opacity_effect

            # Create waveform plot
            pen = pg.mkPen(color=self.waveform_color, width=self.waveform_width)
            self.waveform_plot = self.plot_widget.plot([], [], pen=pen)

            # Set initial opacity
            self.visualizer_opacity_effect.setOpacity(0.0)

            self.logger.debug("Visualization components initialized")
            return True

        except Exception as e:
            error_msg = f"Failed to initialize visualization: {e}"
            self.logger.exception(error_msg)
            self.visualization_error.emit(error_msg,
    )
            return False

    def start_visualization(self, parent_widget: QObject,
    ) -> bool:
        """Start voice visualization and fade in effects.
        
        Args:
            parent_widget: Parent widget for voice visualizer controller
            
        Returns:
            True if start successful, False otherwise
        """
        try:
            if self.is_visualization_active:
                self.logger.warning("Visualization already active")
                return True

            # Create voice visualizer controller if not exists
            if not self.voice_visualizer_controller:
                self.voice_visualizer_controller = VoiceVisualizer(parent_widget)
                # Connect data signal to update method
                if hasattr(self.voice_visualizer_controller, "processor"):
                    self.voice_visualizer_controller.processor.data_ready.connect(self._handle_audio\
    _data)

            # Start audio processing
            self.voice_visualizer_controller.start_processing()

            # Show the visualizer
            if self.plot_widget:
                self.plot_widget.setVisible(True)

            # Start fade animations
            self._start_fade_in_animations()

            self.is_visualization_active = True
            self.visualization_started.emit()
            self.logger.debug("Voice visualization started")
            return True

        except Exception as e:
            error_msg = f"Failed to start visualization: {e}"
            self.logger.exception(error_msg)
            self.visualization_error.emit(error_msg)
            return False

    def stop_visualization(self,
    ) -> bool:
        """Stop voice visualization and fade out effects.
        
        Returns:
            True if stop successful, False otherwise
        """
        try:
            if not self.is_visualization_active:
                self.logger.warning("Visualization not active")
                return True

            # Start fade out animations
            self._start_fade_out_animations()

            # Stop audio processing after animations complete
            if self.voice_visualizer_controller:
                # Delay stopping to allow fade out animation
                self._schedule_stop_processing()

            self.is_visualization_active = False
            self.visualization_stopped.emit()
            self.logger.debug("Voice visualization stopped")
            return True

        except Exception as e:
            error_msg = f"Failed to stop visualization: {e}"
            self.logger.exception(error_msg)
            self.visualization_error.emit(error_msg,
    )
            return False

    def update_waveform(self, audio_data: np.ndarray) -> bool:
        """Update waveform visualization with new audio data.
        
        Args:
            audio_data: Audio data array
            
        Returns:
            True if update successful, False otherwise
        """
        try:
            if not self.waveform_plot or not self.plot_widget:
                return False

            if not self.plot_widget.isVisible():
                return False

            # Down-sample data for better performance
            data_downsampled = audio_data[::self.downsample_factor]

            # Create x-axis time values
            time_values = np.linspace(0, len(data_downsampled), len(data_downsampled))

            # Update the plot
            self.waveform_plot.setData(time_values, data_downsampled)

            self.visualization_updated.emit(audio_data)
            return True

        except Exception as e:
            self.logger.exception(f"Failed to update waveform: {e}")
            return False

    def _handle_audio_data(self, audio_data: np.ndarray) -> None:
        """Handle new audio data from voice visualizer controller.
        
        Args:
            audio_data: Audio data from processor
        """
        with contextlib.suppress(Exception):
            self.update_waveform(audio_data)

    def _start_fade_in_animations(self) -> None:
        """Start fade in animations for visualizer and fade out for other elements."""
        try:
            # Fade in visualizer
            if self.visualizer_opacity_effect:
self.fade_in_visualizer = (
    QPropertyAnimation(self.visualizer_opacity_effect, b"opacity"))
                self.fade_in_visualizer.setDuration(self.animation_duration)
                self.fade_in_visualizer.setStartValue(0.0)
                self.fade_in_visualizer.setEndValue(1.0)
                self.fade_in_visualizer.setEasingCurve(QEasingCurve.Type.InOutQuad)
                self.fade_in_visualizer.finished.connect(lambda: self.fade_animation_finished.emit("\
    fade_in_visualizer"))
                self.fade_in_visualizer.start()

            # Fade out other elements
            self._fade_out_element(self.logo_opacity_effect, "fade_out_logo")
            self._fade_out_element(self.title_opacity_effect, "fade_out_title")
            self._fade_out_element(self.settings_opacity_effect, "fade_out_settings")

            if self.instruction_opacity_effect:
                self._fade_out_element(self.instruction_opacity_effect, "fade_out_instruction")

        except Exception as e:
            self.logger.exception(f"Failed to start fade in animations: {e}")

    def _start_fade_out_animations(self) -> None:
        """Start fade out animations for visualizer and fade in for other elements."""
        try:
            # Fade out visualizer
            if self.visualizer_opacity_effect:
self.fade_out_visualizer = (
    QPropertyAnimation(self.visualizer_opacity_effect, b"opacity"))
                self.fade_out_visualizer.setDuration(self.animation_duration)
                self.fade_out_visualizer.setStartValue(1.0)
                self.fade_out_visualizer.setEndValue(0.0)
                self.fade_out_visualizer.setEasingCurve(QEasingCurve.Type.InOutQuad)
                self.fade_out_visualizer.finished.connect(self._on_fade_out_complete)
                self.fade_out_visualizer.finished.connect(lambda: self.fade_animation_finished.emit(\
    "fade_out_visualizer"))
                self.fade_out_visualizer.start()

            # Fade in other elements
            self._fade_in_element(self.logo_opacity_effect, "fade_in_logo", 1.0)
            self._fade_in_element(self.title_opacity_effect, "fade_in_title", 1.0)
self._fade_in_element(self.settings_opacity_effect, "fade_in_settings", 1.0, start_value = (
    0.4))

            if self.instruction_opacity_effect:
                self._fade_in_element(self.instruction_opacity_effect, "fade_in_instruction", 1.0)

        except Exception as e:
            self.logger.exception(f"Failed to start fade out animations: {e}")

    def _fade_out_element(self, opacity_effect: QGraphicsOpacityEffect | None,
                         animation_name: str, end_value: float = 0.4,
    ) -> None:
        """Fade out a UI element.

        Args:
            opacity_effect: Opacity effect to animate
            animation_name: Name for tracking animation
            end_value: End opacity value
        """
        if not opacity_effect:
            return

        try:
            animation = QPropertyAnimation(opacity_effect, b"opacity")
            animation.setDuration(self.animation_duration)
            animation.setStartValue(1.0)
            animation.setEndValue(end_value)
            animation.setEasingCurve(QEasingCurve.Type.InOutQuad)
            animation.finished.connect(lambda: self.fade_animation_finished.emit(animation_name))
            animation.start()

            # Store animation reference to prevent garbage collection
            setattr(self, animation_name.replace("fade_out_", "fade_out_"), animation)

        except Exception as e:
            self.logger.exception(f"Failed to fade out element {animation_name}: {e}")

    def _fade_in_element(self, opacity_effect: QGraphicsOpacityEffect | None,
                        animation_name: str, end_value: float = 1.0,
                        start_value: float = 0.4,
    ) -> None:
        """Fade in a UI element.

        Args:
            opacity_effect: Opacity effect to animate
            animation_name: Name for tracking animation
            end_value: End opacity value
            start_value: Start opacity value
        """
        if not opacity_effect:
            return

        try:
            animation = QPropertyAnimation(opacity_effect, b"opacity")
            animation.setDuration(self.animation_duration)
            animation.setStartValue(start_value)
            animation.setEndValue(end_value)
            animation.setEasingCurve(QEasingCurve.Type.InOutQuad)
            animation.finished.connect(lambda: self.fade_animation_finished.emit(animation_name))
            animation.start()

            # Store animation reference to prevent garbage collection
            setattr(self, animation_name.replace("fade_in_", "fade_in_"), animation)

        except Exception as e:
            self.logger.exception(f"Failed to fade in element {animation_name}: {e}")

    def _on_fade_out_complete(self) -> None:
        """Handle completion of fade out animation."""
        try:
            # Hide the visualizer widget
            if self.plot_widget:
                self.plot_widget.setVisible(False)

        except Exception as e:
            self.logger.exception(f"Failed to handle fade out completion: {e}")

    def _schedule_stop_processing(self) -> None:
        """Schedule stopping of audio processing after animation delay."""
        try:
            # Stop processing after animation completes
            if self.voice_visualizer_controller:
                # Use a timer or direct call depending on implementation
                self.voice_visualizer_controller.stop_processing()

        except Exception as e:
            self.logger.exception(f"Failed to stop audio processing: {e}")

    def set_animation_duration(self, duration_ms: int,
    ) -> None:
        """Set animation duration for fade effects.

        Args:
            duration_ms: Animation duration in milliseconds
        """
        if duration_ms > 0:
            self.animation_duration = duration_ms
            self.logger.debug("Animation duration set to {duration_ms}ms")

    def set_waveform_style(self, color: tuple | None = None, width: float | None = None) -> None:
        """Set waveform visual style.

        Args:
            color: RGB color tuple for waveform
            width: Line width for waveform
        """
        try:
            if color:
                self.waveform_color = color
            if width:
                self.waveform_width = width

            # Update existing plot if available
            if self.waveform_plot:
                pen = pg.mkPen(color=self.waveform_color, width=self.waveform_width)
                self.waveform_plot.setPen(pen)

self.logger.debug("Waveform style updated: color = (
    {self.waveform_color}, width={self.waveform_width}"))

        except Exception as e:
            self.logger.exception(f"Failed to set waveform style: {e}")

    def set_downsample_factor(self, factor: int,
    ) -> None:
        """Set downsample factor for performance optimization.

        Args:
            factor: Downsample factor (take every Nth sample)
        """
        if factor > 0:
            self.downsample_factor = factor
            self.logger.debug("Downsample factor set to {factor}")

    def is_active(self) -> bool:
        """Check if visualization is currently active.

        Returns:
            True if visualization is active, False otherwise
        """
        return self.is_visualization_active

    def get_voice_visualizer_controller(self) -> VoiceVisualizer | None:
        """Get voice visualizer controller.

        Returns:
            VoiceVisualizer controller or None if not created
        """
        return self.voice_visualizer_controller

    def cleanup(self) -> None:
        """Clean up visualization resources."""
        try:
            # Stop visualization if active
            if self.is_visualization_active:
                self.stop_visualization()

            # Clean up controller
            if self.voice_visualizer_controller:
                self.voice_visualizer_controller.stop_processing()
                self.voice_visualizer_controller = None

            # Clear references
            self.plot_widget = None
            self.waveform_plot = None
            self.visualizer_opacity_effect = None
            self.logo_opacity_effect = None
            self.title_opacity_effect = None
            self.settings_opacity_effect = None
            self.instruction_opacity_effect = None

            # Clear animations
            self.fade_in_visualizer = None
            self.fade_out_visualizer = None
            self.fade_out_logo = None
            self.fade_out_title = None
            self.fade_out_settings = None
            self.fade_in_logo = None
            self.fade_in_title = None
            self.fade_in_settings = None

            self.logger.debug("Visualization resources cleaned up")

        except Exception as e:
            self.logger.exception(f"Failed to cleanup visualization: {e}")


class VisualizationIntegrationManager:
    """High-level manager for visualization integration operations."""

    def __init__(self):
        self._service: VisualizationIntegrationService | None = None

    def create_visualization_service(self) -> VisualizationIntegrationService:
        """Create and return visualization integration service.

        Returns:
            VisualizationIntegrationService instance
        """
        self._service = VisualizationIntegrationService()
        return self._service

    def get_service(self) -> VisualizationIntegrationService | None:
        """Get current visualization integration service.

        Returns:
            Current VisualizationIntegrationService or None if not created
        """
        return self._service

    def setup_visualization(self, plot_widget: pg.PlotWidget,
                          visualizer_opacity_effect: QGraphicsOpacityEffect,
                          logo_opacity_effect: QGraphicsOpacityEffect,
                          title_opacity_effect: QGraphicsOpacityEffect,
                          settings_opacity_effect: QGraphicsOpacityEffect,
                          instruction_opacity_effect: QGraphicsOpacityEffect | None = None) -> bool:
        """Setup visualization integration.

        Args:
            plot_widget: PyQtGraph plot widget
            visualizer_opacity_effect: Visualizer opacity effect
            logo_opacity_effect: Logo opacity effect
            title_opacity_effect: Title opacity effect
            settings_opacity_effect: Settings opacity effect
            instruction_opacity_effect: Optional instruction opacity effect

        Returns:
            True if setup successful, False otherwise

        Raises:
            VisualizationIntegrationError: If service not created
        """
        if not self._service:
            msg = "Visualization service not created"
            raise VisualizationIntegrationError(msg,
    )

        return self._service.initialize_visualization(
            plot_widget, visualizer_opacity_effect, logo_opacity_effect,
            title_opacity_effect, settings_opacity_effect, instruction_opacity_effect,
        )

    def start_visualization(self, parent_widget: QObject,
    ) -> bool:
        """Start visualization.

        Args:
            parent_widget: Parent widget for controller

        Returns:
            True if start successful, False otherwise

        Raises:
            VisualizationIntegrationError: If service not created
        """
        if not self._service:
            msg = "Visualization service not created"
            raise VisualizationIntegrationError(msg)

        return self._service.start_visualization(parent_widget)

    def stop_visualization(self,
    ) -> bool:
        """Stop visualization.

        Returns:
            True if stop successful, False otherwise

        Raises:
            VisualizationIntegrationError: If service not created
        """
        if not self._service:
            msg = "Visualization service not created"
            raise VisualizationIntegrationError(msg)

        return self._service.stop_visualization()

    def cleanup(self) -> None:
        """Clean up visualization integration manager."""
        if self._service:
            self._service.cleanup(,
    )
            self._service = None