"""Progress UI service for managing progress bars and UI state (Presentation)."""

from PyQt6 import QtCore
from PyQt6.QtCore import QEasingCurve, QObject, QPropertyAnimation, QTimer, pyqtSignal
from PyQt6.QtGui import QColor
from PyQt6.QtWidgets import QLabel, QProgressBar, QPushButton

from src_refactored.domain.progress_management.value_objects.progress_state import (
    ProgressState,
    ProgressStateType,
)
from src_refactored.infrastructure.progress_management.progress_tracking_service import (
    ProgressInfo as BaseProgressInfo,
)


class ProgressInfo(BaseProgressInfo):
    def __init__(self, progress_id: str):
        self.progress_id = progress_id
        self.current_value = 0.0
        self.maximum_value = 100.0
        self.state = ProgressState.create_idle()
        self.message = ""
        self.details = ""
    @property
    def percentage(self) -> float:
        if self.maximum_value <= 0:
            return 0.0
        return min(100.0, max(0.0, (self.current_value / self.maximum_value) * 100.0))
    @property
    def is_complete(self) -> bool:
        return self.state.is_completed() or self.current_value >= self.maximum_value
    @property
    def is_active(self) -> bool:
        return self.state.is_active()
    @property
    def elapsed_time(self) -> int:
        return self.start_time.msecsTo(QtCore.QDateTime.currentDateTime())
    def update(self,
               current_value: float | None = None,
               maximum_value: float | None = None,
               state: ProgressState | None = None,
               message: str | None = None,
               details: str | None = None) -> None:
        if current_value is not None:
            self.current_value = current_value
        if maximum_value is not None:
            self.maximum_value = maximum_value
        if state is not None:
            self.state = state
        if message is not None:
            self.message = message
        if details is not None:
            self.details = details
        self.last_update = QtCore.QDateTime.currentDateTime()


class ProgressUIService(QObject):
    progress_started = pyqtSignal(str, ProgressInfo)
    progress_updated = pyqtSignal(str, ProgressInfo)
    progress_completed = pyqtSignal(str, ProgressInfo)
    progress_paused = pyqtSignal(str, ProgressInfo)
    progress_resumed = pyqtSignal(str, ProgressInfo)
    progress_cancelled = pyqtSignal(str, ProgressInfo)
    progress_error = pyqtSignal(str, ProgressInfo, str)

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._progress_info: dict[str, ProgressInfo] = {}
        self._progress_bars: dict[str, QProgressBar] = {}
        self._progress_labels: dict[str, QLabel] = {}
        self._progress_buttons: dict[str, QPushButton] = {}
        self._animate_updates: bool = True
        self._animation_duration: int = 200
        self._animations: dict[str, QPropertyAnimation] = {}
        self._update_timers: dict[str, QTimer] = {}
        self._auto_update_interval: int = 100
        self._state_colors: dict[ProgressStateType, QColor] = {
            ProgressStateType.IDLE: QColor(200, 200, 200),
            ProgressStateType.DOWNLOADING: QColor(0, 120, 215),
            ProgressStateType.PROCESSING: QColor(255, 193, 7),
            ProgressStateType.COMPLETED: QColor(40, 167, 69),
            ProgressStateType.ERROR: QColor(220, 53, 69),
        }

    def register_progress_bar(self,
                             progress_id: str,
                             progress_bar: QProgressBar,
                             label: QLabel | None = None,
                             button: QPushButton | None = None) -> None:
        self._progress_bars[progress_id] = progress_bar
        if label:
            self._progress_labels[progress_id] = label
        if button:
            self._progress_buttons[progress_id] = button
        if progress_id not in self._progress_info:
            self._progress_info[progress_id] = ProgressInfo(progress_id)
        self._update_progress_bar(progress_id)

    def unregister_progress_bar(self, progress_id: str,
    ) -> None:
        self._stop_animation(progress_id)
        self._stop_update_timer(progress_id)
        self._progress_bars.pop(progress_id, None)
        self._progress_labels.pop(progress_id, None)
        self._progress_buttons.pop(progress_id, None)
        self._progress_info.pop(progress_id, None)

    def start_progress(self,
                      progress_id: str,
                      maximum_value: float = 100.0,
                      message: str = "",
                      indeterminate: bool = False,
    ) -> None:
        if progress_id in self._progress_info:
            info = self._progress_info[progress_id]
            info.update(
                current_value=0.0,
                maximum_value=maximum_value,
                state=ProgressState.create_processing()
                if not indeterminate
                else ProgressState.create_processing(),
                message=message,
            )
        else:
            info = ProgressInfo(progress_id)
            info.update(
                current_value=0.0,
                maximum_value=maximum_value,
                state=ProgressState.create_processing()
                if not indeterminate
                else ProgressState.create_processing(),
                message=message,
            )
            self._progress_info[progress_id] = info
        self._update_progress_bar(progress_id)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)
        if indeterminate:
            self._start_update_timer(progress_id)
        self.progress_started.emit(progress_id, info)

    def update_progress(self,
                       progress_id: str,
                       current_value: float | None = None,
                       maximum_value: float | None = None,
                       message: str | None = None,
                       details: str | None = None) -> None:
        if progress_id not in self._progress_info:
            return
        info = self._progress_info[progress_id]
        old_value = info.current_value
        info.update(
            current_value=current_value,
            maximum_value=maximum_value,
            message=message,
            details=details,
        )
        if info.is_complete and not info.state.is_completed():
            info.state = ProgressState.create_completed()
            self.complete_progress(progress_id)
            return
        if self._animate_updates and current_value is not None:
            self._animate_progress_update(progress_id, old_value, current_value)
        else:
            self._update_progress_bar(progress_id)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)
        self.progress_updated.emit(progress_id, info)

    def complete_progress(self, progress_id: str, message: str = "Completed") -> None:
        if progress_id not in self._progress_info:
            return
        info = self._progress_info[progress_id]
        info.update(
            current_value=info.maximum_value,
            state=ProgressState.create_completed(),
            message=message,
        )
        self._stop_animation(progress_id)
        self._stop_update_timer(progress_id)
        self._update_progress_bar(progress_id)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)
        self.progress_completed.emit(progress_id, info)

    def pause_progress(self, progress_id: str, message: str = "Paused") -> None:
        if progress_id not in self._progress_info:
            return
        info = self._progress_info[progress_id]
        if not info.state.is_active():
            return
        info.state = ProgressState.create_idle()
        info.update(message=message)
        self._stop_animation(progress_id)
        self._stop_update_timer(progress_id)
        self._update_progress_bar(progress_id)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)
        self.progress_paused.emit(progress_id, info)

    def resume_progress(self, progress_id: str, message: str = "Resuming...") -> None:
        if progress_id not in self._progress_info:
            return
        info = self._progress_info[progress_id]
        if not info.state.is_idle():
            return
        info.state = ProgressState.create_processing()
        info.update(message=message)
        if info.state.is_active():
            self._start_update_timer(progress_id)
        self._update_progress_bar(progress_id)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)
        self.progress_resumed.emit(progress_id, info)

    def cancel_progress(self, progress_id: str, message: str = "Cancelled") -> None:
        if progress_id not in self._progress_info:
            return
        info = self._progress_info[progress_id]
        info.state = ProgressState.create_idle()
        info.update(message=message)
        self._stop_animation(progress_id)
        self._stop_update_timer(progress_id)
        if progress_id in self._progress_bars:
            self._progress_bars[progress_id].setValue(0)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)
        self.progress_cancelled.emit(progress_id, info)

    def set_progress_error(self, progress_id: str, error_message: str, message: str = "Error",
    ) -> None:
        if progress_id not in self._progress_info:
            return
        info = self._progress_info[progress_id]
        info.state = ProgressState.create_error(error_message)
        info.update(message=message, details=error_message)
        self._stop_animation(progress_id)
        self._stop_update_timer(progress_id)
        self._update_progress_bar(progress_id)
        self._update_progress_label(progress_id)
        self._update_progress_button(progress_id)
        self.progress_error.emit(progress_id, info)

    def _update_progress_bar(self, progress_id: str) -> None:
        if progress_id not in self._progress_bars or progress_id not in self._progress_info:
            return
        progress_bar = self._progress_bars[progress_id]
        info = self._progress_info[progress_id]
        try:
            if info.state.is_active():
                progress_bar.setRange(0, int(info.maximum_value))
                progress_bar.setValue(int(info.current_value))
            else:
                progress_bar.setRange(0, 0)
            self._apply_progress_bar_style(progress_bar, info.state.state_type)
        except RuntimeError:
            pass

    def _update_progress_label(self, progress_id: str) -> None:
        if progress_id not in self._progress_labels or progress_id not in self._progress_info:
            return
        label = self._progress_labels[progress_id]
        info = self._progress_info[progress_id]
        try:
            if info.message:
                if info.state.is_active():
                    label.setText(f"{info.message} ({info.percentage:.1f}%)")
                else:
                    label.setText(info.message)
            elif info.state.is_active():
                label.setText(f"{info.percentage:.1f}%")
            else:
                label.setText("Processing...")
        except RuntimeError:
            pass

    def _update_progress_button(self, progress_id: str) -> None:
        if progress_id not in self._progress_buttons or progress_id not in self._progress_info:
            return
        button = self._progress_buttons[progress_id]
        info = self._progress_info[progress_id]
        try:
            if info.state.is_active():
                button.setText("Pause")
                button.setEnabled(True)
            elif info.state.is_idle():
                button.setText("Start")
                button.setEnabled(True)
            elif info.state.is_completed():
                button.setText("Done")
                button.setEnabled(False)
            elif info.state.is_error():
                button.setText("Retry")
                button.setEnabled(True)
        except RuntimeError:
            pass

    def _apply_progress_bar_style(
        self, progress_bar: QProgressBar, state_type: ProgressStateType,
    ) -> None:
        try:
            color = self._state_colors.get(state_type, self._state_colors[ProgressStateType.IDLE])
            stylesheet = f"""
            QProgressBar {{
                border: 1px solid {color.darker().name()};
                border-radius: 3px;
                text-align: center;
                background-color: #f0f0f0;
            }},
            QProgressBar::chunk {{
                background-color: {color.name()};
                border-radius: 2px;
            }},
            """
            progress_bar.setStyleSheet(stylesheet)
        except RuntimeError:
            pass

    def _animate_progress_update(
        self, progress_id: str, old_value: float, new_value: float,
    ) -> None:
        if progress_id not in self._progress_bars:
            return
        progress_bar = self._progress_bars[progress_id]
        self._stop_animation(progress_id)
        try:
            animation = QPropertyAnimation(progress_bar, b"value")
            animation.setDuration(self._animation_duration)
            animation.setStartValue(int(old_value))
            animation.setEndValue(int(new_value))
            animation.setEasingCurve(QEasingCurve.Type.OutCubic)
            self._animations[progress_id] = animation
            animation.start()
        except RuntimeError:
            pass

    def _start_update_timer(self, progress_id: str) -> None:
        if progress_id in self._update_timers:
            return
        timer = QTimer()
        timer.timeout.connect(lambda: self._update_progress_bar(progress_id))
        timer.start(self._auto_update_interval)
        self._update_timers[progress_id] = timer

    def _stop_update_timer(self, progress_id: str) -> None:
        if progress_id in self._update_timers:
            self._update_timers[progress_id].stop()
            del self._update_timers[progress_id]

    def _stop_animation(self, progress_id: str) -> None:
        if progress_id in self._animations:
            self._animations[progress_id].stop()
            del self._animations[progress_id]

    def get_progress_info(self, progress_id: str) -> ProgressInfo | None:
        return self._progress_info.get(progress_id)

    def get_all_progress_ids(self) -> list[str]:
        return list(self._progress_info.keys())

    def is_progress_active(self, progress_id: str) -> bool:
        info = self._progress_info.get(progress_id)
        return info.is_active() if info else False

    def set_animation_enabled(self, enabled: bool) -> None:
        self._animate_updates = enabled

    def set_animation_duration(self, duration: int) -> None:
        self._animation_duration = duration

    def set_auto_update_interval(self, interval: int) -> None:
        self._auto_update_interval = interval

    def set_state_color(self, state_type: ProgressStateType, color: QColor) -> None:
        self._state_colors[state_type] = color

    def cleanup(self) -> None:
        for progress_id in list(self._animations.keys()):
            self._stop_animation(progress_id)
        for progress_id in list(self._update_timers.keys()):
            self._stop_update_timer(progress_id)
        self._progress_info.clear()
        self._progress_bars.clear()
        self._progress_labels.clear()
        self._progress_buttons.clear()

