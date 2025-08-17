"""Message display service for UI message management with animations (Presentation)."""

from collections.abc import Callable
from typing import Any

from PyQt6 import QtCore
from PyQt6.QtCore import QParallelAnimationGroup, QPropertyAnimation, QTimer
from PyQt6.QtWidgets import QGraphicsOpacityEffect, QLabel, QProgressBar


class MessageDisplayService:
    """Service for managing UI message display with animations and effects."""

    def __init__(self):
        self._label_opacity_effects = {}
        self._progress_opacity_effects = {}
        self._fade_animations = {}
        self._animation_groups = {}
        self._timers = {}
        self.default_fade_duration = 3000
        self.default_hold_duration = 5000
        self.default_easing_curve = QtCore.QEasingCurve.Type.InOutQuad

    def setup_opacity_effect(self, widget: Any, widget_id: str,
    ) -> QGraphicsOpacityEffect:
        if widget_id in self._label_opacity_effects:
            return self._label_opacity_effects[widget_id]
        opacity_effect = QGraphicsOpacityEffect(widget)
        widget.setGraphicsEffect(opacity_effect)
        self._label_opacity_effects[widget_id] = opacity_effect
        return opacity_effect

    def setup_progress_opacity_effect(self,
    progress_bar: QProgressBar, widget_id: str,
    ) -> QGraphicsOpacityEffect | None:
        if widget_id in self._progress_opacity_effects:
            return self._progress_opacity_effects[widget_id]
        if progress_bar is None:
            return None
        try:
            opacity_effect = QGraphicsOpacityEffect(progress_bar)
            progress_bar.setGraphicsEffect(opacity_effect)
            self._progress_opacity_effects[widget_id] = opacity_effect
            return opacity_effect
        except RuntimeError:
            return None

    def display_text_message(self,
                           label: QLabel,
                           text: str,
                           widget_id: str,
                           hold: bool = False,
                           fade_duration: int | None = None,
                           hold_duration: int | None = None,
                           easing_curve: QtCore.QEasingCurve.Type | None = None,
                           on_finished: Callable | None = None) -> None:
        opacity_effect = self.setup_opacity_effect(label, widget_id)
        opacity_effect.setOpacity(1.0)
        label.setText(text)
        if hold:
            return
        fade_dur = fade_duration or self.default_fade_duration
        hold_dur = hold_duration or self.default_hold_duration
        easing = easing_curve or self.default_easing_curve
        fade_animation = QPropertyAnimation(opacity_effect, b"opacity")
        fade_animation.setDuration(fade_dur)
        fade_animation.setStartValue(1.0)
        fade_animation.setEndValue(0.0)
        fade_animation.setEasingCurve(easing)
        def cleanup():
            label.setText("")
            if on_finished:
                on_finished()
        fade_animation.finished.connect(cleanup)
        self._fade_animations[f"{widget_id}_fade"] = fade_animation
        timer = QTimer()
        timer.setSingleShot(True)
        timer.timeout.connect(fade_animation.start)
        timer.start(hold_dur)
        self._timers[f"{widget_id}_timer"] = timer

    def display_filename_message(self, label: QLabel, filename: str, widget_id: str,
    ) -> None:
        opacity_effect = self.setup_opacity_effect(label, widget_id)
        label.setText(f"Downloading {filename}...")
        opacity_effect.setOpacity(1.0)

    def update_progress(self,
                       progress_bar: QProgressBar,
                       percentage: float,
                       widget_id: str,
                       on_state_change: Callable[[bool], None] | None = None) -> None:
        if progress_bar is None:
            return
        try:
            progress_bar.blockSignals(True)
            opacity_effect = self.setup_progress_opacity_effect(progress_bar, widget_id)
            if not progress_bar.isVisible():
                progress_bar.setVisible(True)
                if opacity_effect:
                    opacity_effect.setOpacity(1.0)
            progress_bar.setProperty("value", percentage)
            progress_bar.blockSignals(False)
            if on_state_change:
                if percentage < 100:
                    on_state_change(True)
                else:
                    on_state_change(False)
        except RuntimeError:
            pass

    def reset_display(self,
                     label: QLabel,
                     progress_bar: QProgressBar | None,
                     widget_id: str,
                     fade_duration: int | None = None,
                     on_finished: Callable | None = None) -> None:
        fade_dur = fade_duration or self.default_fade_duration
        label_opacity = self._label_opacity_effects.get(widget_id)
        progress_opacity = self._progress_opacity_effects.get(widget_id) if progress_bar else None
        if not label_opacity:
            self._reset_immediately(label, progress_bar, on_finished)
            return
        fade_label = QPropertyAnimation(label_opacity, b"opacity")
        fade_label.setDuration(fade_dur)
        fade_label.setStartValue(1.0)
        fade_label.setEndValue(0.0)
        animations = [fade_label]
        if progress_bar and progress_opacity:
            try:
                progress_bar.blockSignals(True)
                fade_progress = QPropertyAnimation(progress_opacity, b"opacity")
                fade_progress.setDuration(fade_dur)
                fade_progress.setStartValue(1.0)
                fade_progress.setEndValue(0.0)
                animations.append(fade_progress)
            except RuntimeError:
                pass
        animation_group = QParallelAnimationGroup()
        for animation in animations:
            animation_group.addAnimation(animation)
        def cleanup():
            self._reset_immediately(label, progress_bar, on_finished)
        animation_group.finished.connect(cleanup)
        self._animation_groups[f"{widget_id}_reset"] = animation_group
        animation_group.start()

    def _reset_immediately(self,
                          label: QLabel,
                          progress_bar: QProgressBar | None,
                          on_finished: Callable | None = None) -> None:
        try:
            if progress_bar:
                progress_bar.setValue(0)
                progress_bar.setVisible(False)
                progress_bar.blockSignals(False)
            label.setText("")
            for opacity_effect in self._label_opacity_effects.values():
                if opacity_effect:
                    opacity_effect.setOpacity(1.0)
            for opacity_effect in self._progress_opacity_effects.values():
                if opacity_effect:
                    opacity_effect.setOpacity(1.0)
            if on_finished:
                on_finished()
        except RuntimeError:
            if on_finished:
                on_finished()

    def stop_animations(self, widget_id: str | None = None) -> None:
        if widget_id:
            fade_key = f"{widget_id}_fade"
            reset_key = f"{widget_id}_reset"
            timer_key = f"{widget_id}_timer"
            if fade_key in self._fade_animations:
                self._fade_animations[fade_key].stop()
                del self._fade_animations[fade_key]
            if reset_key in self._animation_groups:
                self._animation_groups[reset_key].stop()
                del self._animation_groups[reset_key]
            if timer_key in self._timers:
                self._timers[timer_key].stop()
                del self._timers[timer_key]
        else:
            for animation in self._fade_animations.values():
                animation.stop()
            self._fade_animations.clear()
            for group in self._animation_groups.values():
                group.stop()
            self._animation_groups.clear()
            for timer in self._timers.values():
                timer.stop()
            self._timers.clear()

    def set_default_fade_duration(self, duration: int,
    ) -> None:
        self.default_fade_duration = duration

    def set_default_hold_duration(self, duration: int,
    ) -> None:
        self.default_hold_duration = duration

    def set_default_easing_curve(self, curve: QtCore.QEasingCurve.Type) -> None:
        self.default_easing_curve = curve

    def get_opacity_effect(self, widget_id: str,
    ) -> QGraphicsOpacityEffect | None:
        return self._label_opacity_effects.get(widget_id)

    def get_progress_opacity_effect(self, widget_id: str,
    ) -> QGraphicsOpacityEffect | None:
        return self._progress_opacity_effects.get(widget_id)

    def is_animation_running(self, widget_id: str,
    ) -> bool:
        fade_key = f"{widget_id}_fade"
        reset_key = f"{widget_id}_reset"
        fade_running = (fade_key in self._fade_animations and
                       self._fade_animations[fade_key].state() == QPropertyAnimation.State.Running)
        reset_running = (reset_key in self._animation_groups and
                         self._animation_groups[reset_key].state() == QParallelAnimationGroup.State.Running)
        return fade_running or reset_running

    def cleanup(self) -> None:
        self.stop_animations()
        self._label_opacity_effects.clear()
        self._progress_opacity_effects.clear()

