"""PyQtGraph Visualization Renderer Adapter (Presentation).

Moved from Infrastructure. Implements `VisualizationRendererPort` using pyqtgraph.
"""

import pyqtgraph as pg
from PyQt6 import QtCore
from PyQt6.QtWidgets import QGraphicsOpacityEffect, QWidget

from src_refactored.domain.audio_visualization.ports.visualization_renderer_port import (
    VisualizationRendererPort,
)
from src_refactored.domain.audio_visualization.value_objects.visualization_data import (
    VisualizationData,
    VisualizationFrame,
)
from src_refactored.domain.audio_visualization.value_objects.visualization_settings import (
    VisualizationSettings,
)
from src_refactored.domain.audio_visualization.value_objects.waveform_data import (
    WaveformData,
)
from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.domain.common.result import Result


class PyQtGraphRendererAdapter(VisualizationRendererPort):
    """Adapter for rendering audio visualizations using PyQtGraph."""

    def __init__(self, parent: QWidget, logger: LoggingPort | None = None):
        self._parent = parent
        self._logger = logger
        self._plot_widget: pg.PlotWidget | None = None
        self._waveform_plot = None
        self._opacity_effect: QGraphicsOpacityEffect | None = None
        self._is_visible = False

        self._setup_visualization_widget()

    def _setup_visualization_widget(self) -> None:
        try:
            self._plot_widget = pg.PlotWidget(parent=self._parent)
            self._plot_widget.setGeometry(QtCore.QRect(0, -5, 400, 51))
            self._plot_widget.setBackground((0, 0, 0, 0))
            self._plot_widget.showAxis("left", False)
            self._plot_widget.showAxis("bottom", False)
            self._plot_widget.setVisible(False)
            self._plot_widget.setStyleSheet("border: none;")

            self._waveform_plot = self._plot_widget.plot([], [], pen=pg.mkPen(color=(189, 46, 45), width=2.5))

            self._opacity_effect = QGraphicsOpacityEffect(self._plot_widget)
            self._plot_widget.setGraphicsEffect(self._opacity_effect)
            self._opacity_effect.setOpacity(0.0)

            if self._logger:
                self._logger.log_debug("PyQtGraph visualization widget setup completed")
        except Exception as exc:
            if self._logger:
                self._logger.log_error(f"Error setting up visualization widget: {exc}")
            raise

    def render_waveform(self, waveform: WaveformData, settings: VisualizationSettings) -> Result[VisualizationData]:
        try:
            if not self._waveform_plot:
                return Result.failure("Visualization widget not initialized")

            if hasattr(waveform, "samples") and waveform.samples:
                self._waveform_plot.setData(waveform.samples)
            else:
                self._waveform_plot.setData([], [])

            visualization_data = VisualizationData(
                frame=VisualizationFrame(
                    timestamp=0.0,
                    data=waveform.samples if hasattr(waveform, "samples") else [],
                    sample_rate=waveform.sample_rate if hasattr(waveform, "sample_rate") else 44100,
                ),
            )
            return Result.success(visualization_data)
        except Exception as exc:
            if self._logger:
                self._logger.log_error(f"Error rendering waveform: {exc}")
            return Result.failure(f"Error rendering waveform: {exc}")

    def render_spectrum(self, waveform: WaveformData, settings: VisualizationSettings) -> Result[VisualizationData]:
        return Result.failure("Spectrum rendering not implemented for waveform display")

    def render_level_meter(self, waveform: WaveformData, settings: VisualizationSettings) -> Result[VisualizationData]:
        return Result.failure("Level meter rendering not implemented for waveform display")

    def create_visualization_frame(self, visualization_data: VisualizationData, settings: VisualizationSettings, metadata: dict[str, object] | None = None) -> Result[VisualizationFrame]:
        try:
            frame = VisualizationFrame(
                timestamp=visualization_data.frame.timestamp if hasattr(visualization_data, "frame") else 0.0,
                data=visualization_data.frame.data if hasattr(visualization_data, "frame") else [],
                sample_rate=visualization_data.frame.sample_rate if hasattr(visualization_data, "frame") else 44100,
            )
            return Result.success(frame)
        except Exception as exc:
            if self._logger:
                self._logger.log_error(f"Error creating visualization frame: {exc}")
            return Result.failure(f"Error creating visualization frame: {exc}")

    def supports_visualization_type(self, visualization_type: str) -> bool:
        return visualization_type.lower() in ["waveform", "audio", "time_domain"]

    def show_visualization(self) -> None:
        if self._plot_widget and self._opacity_effect:
            self._plot_widget.setVisible(True)
            self._opacity_effect.setOpacity(1.0)
            self._is_visible = True

    def hide_visualization(self) -> None:
        if self._plot_widget and self._opacity_effect:
            self._plot_widget.setVisible(False)
            self._opacity_effect.setOpacity(0.0)
            self._is_visible = False

    def clear_visualization(self) -> None:
        if self._waveform_plot:
            self._waveform_plot.setData([], [])

    @property
    def is_visible(self) -> bool:
        return self._is_visible

    def get_plot_widget(self) -> pg.PlotWidget | None:
        return self._plot_widget


