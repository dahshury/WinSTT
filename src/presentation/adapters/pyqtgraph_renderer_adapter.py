"""PyQtGraph Visualization Renderer Adapter (Presentation).

Moved from Infrastructure. Implements `VisualizationRendererPort` using pyqtgraph.
"""
from contextlib import suppress

import pyqtgraph as pg
from PyQt6 import QtCore
from PyQt6.QtWidgets import QGraphicsOpacityEffect, QWidget

from src.domain.audio_visualization.ports.visualization_renderer_port import (
    VisualizationRendererPort,
)
from src.domain.audio_visualization.value_objects.visualization_data import (
    VisualizationData,
    VisualizationFrame,
)
from src.domain.audio_visualization.value_objects.visualization_settings import (
    VisualizationSettings,
)
from src.domain.audio_visualization.value_objects.waveform_data import (
    WaveformData,
)
from src.domain.common.ports.logging_port import LoggingPort
from src.domain.common.result import Result
from src.presentation.shared.ui_theme_service import UIThemeService


class PyQtGraphRendererAdapter(VisualizationRendererPort):
    """Adapter for rendering audio visualizations using PyQtGraph."""

    def __init__(self, parent: QWidget, logger: LoggingPort | None = None):
        self._parent = parent
        self._logger = logger
        self._plot_widget: pg.PlotWidget | None = None
        self._waveform_plot = None
        self._opacity_effect: QGraphicsOpacityEffect | None = None
        self._is_visible = False
        self._theme = UIThemeService()

        # Disable pyqtgraph's atexit cleanup to avoid RecursionError in ViewBox.quit on shutdown
        with suppress(Exception):
            if hasattr(pg, "setConfigOptions"):
                pg.setConfigOptions(exitCleanup=False)
            elif hasattr(pg, "setConfigOption"):
                pg.setConfigOption("exitCleanup", False)

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

            # Configure view for smoother plotting
            with suppress(Exception):
                pg.setConfigOptions(antialias=True)
            plot_item = self._plot_widget.getPlotItem()
            if plot_item is not None:
                with suppress(Exception):
                    plot_item.enableAutoRange(False)
                with suppress(Exception):
                    plot_item.setXRange(0, 400, padding=0)
                with suppress(Exception):
                    plot_item.setYRange(-0.8, 0.8, padding=0)

            # Use theme accent color
            pen_color = self._parse_color(self._theme.get_color("border_accent"), alpha=220)
            self._waveform_plot = self._plot_widget.plot([], [], pen=pg.mkPen(color=pen_color, width=2.0))
            with suppress(Exception):
                # Improve performance/visuals on dense data
                self._waveform_plot.setClipToView(True)
            with suppress(Exception):
                self._waveform_plot.setDownsampling(auto=True, method="peak")  # type: ignore[attr-defined]

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
                samples = list(waveform.samples)
                # Resample to match widget width for less crowding
                max_points = 400
                try:
                    if self._plot_widget is not None and self._plot_widget.width() > 0:
                        max_points = max(50, int(self._plot_widget.width()))
                except Exception:
                    pass
                step = max(1, len(samples) // max_points)
                if step > 1:
                    samples = samples[::step]
                x_values = list(range(len(samples)))
                self._waveform_plot.setData(x_values, samples)
            else:
                self._waveform_plot.setData([], [])

            # Build VisualizationData/Frame according to domain definitions
            viz_data = VisualizationData(
                data_points=list(waveform.samples) if hasattr(waveform, "samples") else [],
                width=len(waveform.samples) if hasattr(waveform, "samples") else 0,
                height=1,
                data_type="waveform",
                timestamp=QtCore.QDateTime.currentDateTime().toPyDateTime(),
            )
            VisualizationFrame(
                visualization_data=viz_data,
                settings=settings,
                frame_id="waveform",
            )
            return Result.success(viz_data)
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
                visualization_data=visualization_data,
                settings=settings,
                frame_id="frame",
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
            # Ensure the visualization is above any background widgets
            with suppress(Exception):
                self._plot_widget.raise_()
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

    def cleanup(self) -> None:
        """Explicitly clean up pyqtgraph widgets to prevent atexit recursion errors."""
        try:
            # Clear data and effects
            if self._waveform_plot is not None:
                with suppress(Exception):
                    self._waveform_plot.setData([], [])
                self._waveform_plot = None

            if self._plot_widget is not None:
                with suppress(Exception):
                    self._plot_widget.clear()
                with suppress(Exception):
                    self._plot_widget.close()
                with suppress(Exception):
                    self._plot_widget.deleteLater()
                self._plot_widget = None

            self._opacity_effect = None
            self._is_visible = False
        except Exception as exc:
            if self._logger:
                self._logger.log_warning(f"PyQtGraph cleanup warning: {exc}")

    @property
    def is_visible(self) -> bool:
        return self._is_visible

    def get_plot_widget(self) -> pg.PlotWidget | None:
        return self._plot_widget

    def _parse_color(self, css_color: str, alpha: int = 255) -> tuple[int, int, int, int]:
        """Parse a CSS rgb/rgba color string into a 4-tuple suitable for pyqtgraph.

        Falls back to a neutral accent if parsing fails.
        """
        try:
            text = css_color.strip().lower()
            if text.startswith("rgba"):
                nums = text[text.find("(")+1:text.find(")")].split(",")
                r, g, b, a = (int(float(n.strip())) for n in nums)
                return (r, g, b, a)
            if text.startswith("rgb"):
                nums = text[text.find("(")+1:text.find(")")].split(",")
                r, g, b = (int(float(n.strip())) for n in nums)
                return (r, g, b, alpha)
        except Exception:
            pass
        # Fallback to a pleasant accent
        return (78, 106, 129, alpha)


