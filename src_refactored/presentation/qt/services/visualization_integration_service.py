"""Visualization Integration Service for voice visualizer management (Presentation)."""

import contextlib

import numpy as np
import pyqtgraph as pg
from PyQt6.QtCore import QEasingCurve, QObject, QPropertyAnimation, pyqtSignal
from PyQt6.QtWidgets import QGraphicsOpacityEffect

from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.presentation.qt.voice_visualizer import VoiceVisualizer


class VisualizationIntegrationError(Exception):
    pass


class VisualizationIntegrationService(QObject):
    visualization_started = pyqtSignal()
    visualization_stopped = pyqtSignal()
    visualization_updated = pyqtSignal(np.ndarray)
    visualization_error = pyqtSignal(str)
    fade_animation_finished = pyqtSignal(str)

    def __init__(self, logger: LoggingPort | None = None):
        super().__init__()
        self.logger = logger
        self.voice_visualizer_controller: VoiceVisualizer | None = None
        self.plot_widget: pg.PlotWidget | None = None
        self.waveform_plot = None
        self.visualizer_opacity_effect: QGraphicsOpacityEffect | None = None
        self.logo_opacity_effect: QGraphicsOpacityEffect | None = None
        self.title_opacity_effect: QGraphicsOpacityEffect | None = None
        self.settings_opacity_effect: QGraphicsOpacityEffect | None = None
        self.instruction_opacity_effect: QGraphicsOpacityEffect | None = None
        self.fade_in_visualizer: QPropertyAnimation | None = None
        self.fade_out_visualizer: QPropertyAnimation | None = None
        self.fade_out_logo: QPropertyAnimation | None = None
        self.fade_out_title: QPropertyAnimation | None = None
        self.fade_out_settings: QPropertyAnimation | None = None
        self.fade_in_logo: QPropertyAnimation | None = None
        self.fade_in_title: QPropertyAnimation | None = None
        self.fade_in_settings: QPropertyAnimation | None = None
        self.is_visualization_active = False
        self.animation_duration = 500
        self.waveform_color = (189, 46, 45)
        self.waveform_width = 2.5
        self.downsample_factor = 4

    def initialize_visualization(self, plot_widget: pg.PlotWidget,
                                 visualizer_opacity_effect: QGraphicsOpacityEffect,
                                 logo_opacity_effect: QGraphicsOpacityEffect,
                                 title_opacity_effect: QGraphicsOpacityEffect,
                                 settings_opacity_effect: QGraphicsOpacityEffect,
                                 instruction_opacity_effect: QGraphicsOpacityEffect | None = None) -> bool:
        try:
            self.plot_widget = plot_widget
            self.visualizer_opacity_effect = visualizer_opacity_effect
            self.logo_opacity_effect = logo_opacity_effect
            self.title_opacity_effect = title_opacity_effect
            self.settings_opacity_effect = settings_opacity_effect
            self.instruction_opacity_effect = instruction_opacity_effect
            pen = pg.mkPen(color=self.waveform_color, width=self.waveform_width)
            self.waveform_plot = self.plot_widget.plot([], [], pen=pen)
            self.visualizer_opacity_effect.setOpacity(0.0)
            if self.logger:
                self.logger.log_debug("Visualization components initialized")
            return True
        except Exception as e:
            error_msg = f"Failed to initialize visualization: {e}"
            if self.logger:
                self.logger.log_exception(error_msg)
            self.visualization_error.emit(error_msg)
            return False

    def start_visualization(self, parent_widget: QObject,
    ) -> bool:
        try:
            if self.is_visualization_active:
                if self.logger:
                    self.logger.log_warning("Visualization already active")
                return True
            if not self.voice_visualizer_controller:
                self.voice_visualizer_controller = VoiceVisualizer(parent_widget)
                if hasattr(self.voice_visualizer_controller, "processor"):
                    self.voice_visualizer_controller.processor.data_ready.connect(self._handle_audio_data)
            self.voice_visualizer_controller.start_processing()
            if self.plot_widget:
                self.plot_widget.setVisible(True)
            self._start_fade_in_animations()
            self.is_visualization_active = True
            self.visualization_started.emit()
            if self.logger:
                self.logger.log_debug("Voice visualization started")
            return True
        except Exception as e:
            error_msg = f"Failed to start visualization: {e}"
            if self.logger:
                self.logger.log_exception(error_msg)
            self.visualization_error.emit(error_msg)
            return False

    def stop_visualization(self,
    ) -> bool:
        try:
            if not self.is_visualization_active:
                if self.logger:
                    self.logger.log_warning("Visualization not active")
                return True
            self._start_fade_out_animations()
            if self.voice_visualizer_controller:
                self._schedule_stop_processing()
            self.is_visualization_active = False
            self.visualization_stopped.emit()
            if self.logger:
                self.logger.log_debug("Voice visualization stopped")
            return True
        except Exception as e:
            error_msg = f"Failed to stop visualization: {e}"
            if self.logger:
                self.logger.log_exception(error_msg)
            self.visualization_error.emit(error_msg)
            return False

    def update_waveform(self, audio_data: np.ndarray) -> bool:
        try:
            if not self.waveform_plot or not self.plot_widget:
                return False
            if not self.plot_widget.isVisible():
                return False
            data_downsampled = audio_data[::self.downsample_factor]
            time_values = np.linspace(0, len(data_downsampled), len(data_downsampled))
            self.waveform_plot.setData(time_values, data_downsampled)
            self.visualization_updated.emit(audio_data)
            return True
        except Exception as e:
            if self.logger:
                self.logger.log_exception(f"Failed to update waveform: {e}")
            return False

    def _handle_audio_data(self, audio_data: np.ndarray) -> None:
        with contextlib.suppress(Exception):
            self.update_waveform(audio_data)

    def _start_fade_in_animations(self) -> None:
        try:
            if self.visualizer_opacity_effect:
                self.fade_in_visualizer = QPropertyAnimation(self.visualizer_opacity_effect, b"opacity")
                self.fade_in_visualizer.setDuration(self.animation_duration)
                self.fade_in_visualizer.setStartValue(0.0)
                self.fade_in_visualizer.setEndValue(1.0)
                self.fade_in_visualizer.setEasingCurve(QEasingCurve.Type.InOutQuad)
                self.fade_in_visualizer.finished.connect(lambda: self.fade_animation_finished.emit("fade_in_visualizer"))
                self.fade_in_visualizer.start()
            self._fade_out_element(self.logo_opacity_effect, "fade_out_logo")
            self._fade_out_element(self.title_opacity_effect, "fade_out_title")
            self._fade_out_element(self.settings_opacity_effect, "fade_out_settings")
            if self.instruction_opacity_effect:
                self._fade_out_element(self.instruction_opacity_effect, "fade_out_instruction")
        except Exception as e:
            if self.logger:
                self.logger.log_exception(f"Failed to start fade in animations: {e}")

    def _start_fade_out_animations(self) -> None:
        try:
            if self.visualizer_opacity_effect:
                self.fade_out_visualizer = QPropertyAnimation(self.visualizer_opacity_effect, b"opacity")
                self.fade_out_visualizer.setDuration(self.animation_duration)
                self.fade_out_visualizer.setStartValue(1.0)
                self.fade_out_visualizer.setEndValue(0.0)
                self.fade_out_visualizer.setEasingCurve(QEasingCurve.Type.InOutQuad)
                self.fade_out_visualizer.finished.connect(self._on_fade_out_complete)
                self.fade_out_visualizer.finished.connect(lambda: self.fade_animation_finished.emit("fade_out_visualizer"))
                self.fade_out_visualizer.start()
            self._fade_in_element(self.logo_opacity_effect, "fade_in_logo", 1.0)
            self._fade_in_element(self.title_opacity_effect, "fade_in_title", 1.0)
            self._fade_in_element(self.settings_opacity_effect, "fade_in_settings", 1.0, start_value=0.4)
            if self.instruction_opacity_effect:
                self._fade_in_element(self.instruction_opacity_effect, "fade_in_instruction", 1.0)
        except Exception as e:
            if self.logger:
                self.logger.log_exception(f"Failed to start fade out animations: {e}")

    def _fade_out_element(self, opacity_effect: QGraphicsOpacityEffect | None,
                         animation_name: str, end_value: float = 0.4,
    ) -> None:
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
            setattr(self, animation_name.replace("fade_out_", "fade_out_"), animation)
        except Exception as e:
            if self.logger:
                self.logger.log_exception(f"Failed to fade out element {animation_name}: {e}")

    def _fade_in_element(self, opacity_effect: QGraphicsOpacityEffect | None,
                        animation_name: str, end_value: float = 1.0,
                        start_value: float = 0.4,
    ) -> None:
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
            setattr(self, animation_name.replace("fade_in_", "fade_in_"), animation)
        except Exception as e:
            if self.logger:
                self.logger.log_exception(f"Failed to fade in element {animation_name}: {e}")

    def _on_fade_out_complete(self) -> None:
        try:
            if self.plot_widget:
                self.plot_widget.setVisible(False)
        except Exception as e:
            if self.logger:
                self.logger.log_exception(f"Failed to handle fade out completion: {e}")

    def _schedule_stop_processing(self) -> None:
        try:
            if self.voice_visualizer_controller:
                self.voice_visualizer_controller.stop_processing()
        except Exception as e:
            if self.logger:
                self.logger.log_exception(f"Failed to stop audio processing: {e}")

    def set_animation_duration(self, duration_ms: int,
    ) -> None:
        if duration_ms > 0:
            self.animation_duration = duration_ms
            if self.logger:
                self.logger.log_debug("Animation duration updated")

    def set_waveform_style(self, color: tuple | None = None, width: float | None = None) -> None:
        try:
            if color:
                self.waveform_color = color
            if width:
                self.waveform_width = width
            if self.waveform_plot:
                pen = pg.mkPen(color=self.waveform_color, width=self.waveform_width)
                self.waveform_plot.setPen(pen)
        except Exception as e:
            if self.logger:
                self.logger.log_exception(f"Failed to set waveform style: {e}")

    def set_downsample_factor(self, factor: int,
    ) -> None:
        if factor > 0:
            self.downsample_factor = factor
            if self.logger:
                self.logger.log_debug("Downsample factor updated")

    def is_active(self) -> bool:
        return self.is_visualization_active

    def get_voice_visualizer_controller(self) -> VoiceVisualizer | None:
        return self.voice_visualizer_controller

    def cleanup(self) -> None:
        try:
            if self.is_visualization_active:
                self.stop_visualization()
            if self.voice_visualizer_controller:
                self.voice_visualizer_controller.stop_processing()
                self.voice_visualizer_controller = None
            self.plot_widget = None
            self.waveform_plot = None
            self.visualizer_opacity_effect = None
            self.logo_opacity_effect = None
            self.title_opacity_effect = None
            self.settings_opacity_effect = None
            self.instruction_opacity_effect = None
            self.fade_in_visualizer = None
            self.fade_out_visualizer = None
            self.fade_out_logo = None
            self.fade_out_title = None
            self.fade_out_settings = None
            self.fade_in_logo = None
            self.fade_in_title = None
            self.fade_in_settings = None
            if self.logger:
                self.logger.log_debug("Visualization resources cleaned up")
        except Exception as e:
            if self.logger:
                self.logger.log_exception(f"Failed to cleanup visualization: {e}")


class VisualizationIntegrationManager:
    def __init__(self):
        self._service: VisualizationIntegrationService | None = None

    def create_visualization_service(self) -> VisualizationIntegrationService:
        self._service = VisualizationIntegrationService()
        return self._service

    def get_service(self) -> VisualizationIntegrationService | None:
        return self._service

    def setup_visualization(self, plot_widget: pg.PlotWidget,
                          visualizer_opacity_effect: QGraphicsOpacityEffect,
                          logo_opacity_effect: QGraphicsOpacityEffect,
                          title_opacity_effect: QGraphicsOpacityEffect,
                          settings_opacity_effect: QGraphicsOpacityEffect,
                          instruction_opacity_effect: QGraphicsOpacityEffect | None = None) -> bool:
        if not self._service:
            msg = "Visualization service not created"
            raise VisualizationIntegrationError(msg)
        return self._service.initialize_visualization(
            plot_widget, visualizer_opacity_effect, logo_opacity_effect,
            title_opacity_effect, settings_opacity_effect, instruction_opacity_effect,
        )

    def start_visualization(self, parent_widget: QObject,
    ) -> bool:
        if not self._service:
            msg = "Visualization service not created"
            raise VisualizationIntegrationError(msg)
        return self._service.start_visualization(parent_widget)

    def stop_visualization(self,
    ) -> bool:
        if not self._service:
            msg = "Visualization service not created"
            raise VisualizationIntegrationError(msg)
        return self._service.stop_visualization()

    def cleanup(self) -> None:
        if self._service:
            self._service.cleanup()
            self._service = None

