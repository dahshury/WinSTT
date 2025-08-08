"""UI Status Adapter for bridging domain status updates to UI (Presentation).

Moved from Infrastructure. Implements `UIStatusPort` with PyQt widgets.
"""


from PyQt6.QtCore import QThread, QTimer
from PyQt6.QtWidgets import QApplication, QLabel, QProgressBar

from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.domain.common.ports.ui_status_port import (
    StatusClearRequest,
    StatusMessage,
    StatusType,
    UIStatusPort,
)


class UIStatusAdapter(UIStatusPort):
    """Adapter that bridges domain status updates to actual UI components."""

    def __init__(
        self,
        status_label: QLabel,
        progress_bar: QProgressBar,
        logger: LoggingPort | None = None,
    ):
        self._status_label = status_label
        self._progress_bar = progress_bar
        self._logger = logger
        self._current_timer: QTimer | None = None

        # Styles for different status types
        self._default_style = "color: rgb(144, 164, 174);"
        self._error_style = "color: rgb(255, 100, 100);"
        self._success_style = "color: rgb(100, 255, 100);"
        self._warning_style = "color: rgb(255, 200, 100);"
        self._recording_style = "color: rgb(255, 150, 150);"
        self._transcribing_style = "color: rgb(150, 200, 255);"

    def show_status(self, message: StatusMessage) -> None:
        try:
            # Cancel any existing timer
            if self._current_timer:
                self._current_timer.stop()
                self._current_timer = None

            display_text = message.text
            if message.filename:
                display_text = f"{message.text} ({message.filename})"
            self._status_label.setText(display_text)

            self._apply_status_style(message.type)

            # Progress
            if message.show_progress_bar and message.progress_value is not None:
                self._progress_bar.setVisible(True)
                self._progress_bar.setValue(int(message.progress_value))
            elif message.type != StatusType.PROGRESS:
                self._progress_bar.setVisible(False)

            # Auto-clear timer on UI thread
            if message.auto_clear and message.duration.value > 0:
                app = QApplication.instance()
                if app and QThread.currentThread() == app.thread():
                    self._current_timer = QTimer()
                    self._current_timer.timeout.connect(lambda: self._auto_clear_status())
                    self._current_timer.setSingleShot(True)
                    self._current_timer.start(message.duration.value)
                elif self._logger:
                    self._logger.log_warning("Cannot create timer outside Qt main thread, skipping auto-clear")

            if self._logger:
                self._logger.log_info(f"Status: {display_text}")
        except Exception as exc:
            if self._logger:
                self._logger.log_error(f"Error showing status: {exc}")

    def clear_status(self, request: StatusClearRequest) -> None:
        try:
            if self._current_timer:
                self._current_timer.stop()
                self._current_timer = None

            if request.reset_to_default:
                self._status_label.setText(request.default_message)
                self._status_label.setStyleSheet(self._default_style)
            else:
                self._status_label.setText("")

            if request.clear_progress:
                self._progress_bar.setVisible(False)
                self._progress_bar.setValue(0)
        except Exception as exc:
            if self._logger:
                self._logger.log_error(f"Error clearing status: {exc}")

    def show_progress(self, value: float, text: str = "", filename: str = "") -> None:
        message = StatusMessage(
            text=text or "Processing...",
            type=StatusType.PROGRESS,
            progress_value=value,
            filename=filename,
            auto_clear=False,
        )
        self.show_status(message)

    def hide_progress(self) -> None:
        self._progress_bar.setVisible(False)

    def _apply_status_style(self, status_type: StatusType) -> None:
        style_map = {
            StatusType.INFO: self._default_style,
            StatusType.ERROR: self._error_style,
            StatusType.SUCCESS: self._success_style,
            StatusType.WARNING: self._warning_style,
            StatusType.RECORDING: self._recording_style,
            StatusType.TRANSCRIBING: self._transcribing_style,
            StatusType.PROGRESS: self._default_style,
        }
        self._status_label.setStyleSheet(style_map.get(status_type, self._default_style))

    def _auto_clear_status(self) -> None:
        clear_request = StatusClearRequest(clear_progress=False, reset_to_default=True)
        self.clear_status(clear_request)


