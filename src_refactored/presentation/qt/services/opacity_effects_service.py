"""Opacity Effects Service for UI element opacity management (Presentation)."""

import logging
from collections.abc import Callable

from PyQt6.QtCore import QEasingCurve, QObject, QPropertyAnimation, pyqtSignal
from PyQt6.QtWidgets import QGraphicsOpacityEffect, QWidget


class OpacityEffectsError(Exception):
    pass


class OpacityEffectsService(QObject):
    effect_created = pyqtSignal(str, QGraphicsOpacityEffect)
    effect_applied = pyqtSignal(str, QWidget)
    animation_started = pyqtSignal(str)
    animation_finished = pyqtSignal(str)
    opacity_changed = pyqtSignal(str, float)

    def __init__(self):
        super().__init__()
        self.logger = logging.getLogger(__name__)
        self._opacity_effects: dict[str, QGraphicsOpacityEffect] = {}
        self._widget_mappings: dict[str, QWidget] = {}
        self._animations: dict[str, QPropertyAnimation] = {}
        self.default_duration = 500
        self.default_easing_curve = QEasingCurve.Type.InOutQuad
        self.opacity_values = {
            "hidden": 0.0,
            "dimmed": 0.4,
            "normal": 1.0,
        }

    def create_opacity_effect(self, effect_name: str, initial_opacity: float = 1.0) -> QGraphicsOpacityEffect:
        if effect_name in self._opacity_effects:
            msg = f"Opacity effect '{effect_name}' already exists"
            raise OpacityEffectsError(msg)
        if not 0.0 <= initial_opacity <= 1.0:
            msg = f"Invalid opacity value: {initial_opacity}"
            raise OpacityEffectsError(msg)
        effect = QGraphicsOpacityEffect()
        effect.setOpacity(initial_opacity)
        self._opacity_effects[effect_name] = effect
        self.effect_created.emit(effect_name, effect)
        return effect

    def apply_effect_to_widget(self, effect_name: str, widget: QWidget,
    ) -> bool:
        if effect_name not in self._opacity_effects:
            return False
        effect = self._opacity_effects[effect_name]
        widget.setGraphicsEffect(effect)
        self._widget_mappings[effect_name] = widget
        self.effect_applied.emit(effect_name, widget)
        return True

    def set_opacity(self, effect_name: str, opacity: float,
    ) -> bool:
        if effect_name not in self._opacity_effects or not 0.0 <= opacity <= 1.0:
            return False
        effect = self._opacity_effects[effect_name]
        effect.setOpacity(opacity)
        self.opacity_changed.emit(effect_name, opacity)
        return True

    def animate_opacity(self, effect_name: str, target_opacity: float,
                        duration: int | None = None,
                        easing_curve: QEasingCurve.Type | None = None,
                        animation_name: str | None = None,
                        finished_callback: Callable | None = None) -> bool:
        if effect_name not in self._opacity_effects or not 0.0 <= target_opacity <= 1.0:
            return False
        effect = self._opacity_effects[effect_name]
        duration = duration or self.default_duration
        easing_curve = easing_curve or self.default_easing_curve
        animation_name = animation_name or f"animate_{effect_name}"
        if animation_name in self._animations:
            self._animations[animation_name].stop()
        animation = QPropertyAnimation(effect, b"opacity")
        animation.setDuration(duration)
        animation.setStartValue(effect.opacity())
        animation.setEndValue(target_opacity)
        animation.setEasingCurve(easing_curve)
        animation.valueChanged.connect(lambda: self.animation_started.emit(animation_name))
        animation.finished.connect(lambda: self.animation_finished.emit(animation_name))
        animation.finished.connect(lambda: self._cleanup_animation(animation_name))
        if finished_callback:
            animation.finished.connect(finished_callback)
        self._animations[animation_name] = animation
        animation.start()
        return True

    def fade_in(self, effect_name: str, duration: int | None = None,
                target_opacity: float = 1.0, animation_name: str | None = None) -> bool:
        return self.animate_opacity(effect_name, target_opacity, duration, animation_name=animation_name)

    def fade_out(self, effect_name: str, duration: int | None = None,
                 target_opacity: float = 0.0, animation_name: str | None = None) -> bool:
        return self.animate_opacity(effect_name, target_opacity, duration, animation_name=animation_name)

    def _cleanup_animation(self, animation_name: str,
    ) -> None:
        if animation_name in self._animations:
            del self._animations[animation_name]

    def cleanup(self) -> None:
        for animation in self._animations.values():
            animation.stop()
        self._animations.clear()
        self._opacity_effects.clear()
        self._widget_mappings.clear()

