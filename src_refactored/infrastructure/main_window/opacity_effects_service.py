"""Opacity Effects Service for UI element opacity management.

This module provides infrastructure services for managing opacity effects
and animations for various UI elements in the main window.
"""

from collections.abc import Callable

from PyQt6.QtCore import QEasingCurve, QObject, QPropertyAnimation, pyqtSignal
from PyQt6.QtWidgets import QGraphicsOpacityEffect, QWidget

from logger import setup_logger


class OpacityEffectsError(Exception):
    """Exception raised for opacity effects errors."""


class OpacityEffectsService(QObject):
    """Service for managing opacity effects and animations."""

    # Signals
    effect_created = pyqtSignal(str, QGraphicsOpacityEffect)  # effect_name, effect
    effect_applied = pyqtSignal(str, QWidget)  # effect_name, widget
    animation_started = pyqtSignal(str)  # animation_name
    animation_finished = pyqtSignal(str)  # animation_name
    opacity_changed = pyqtSignal(str, float)  # effect_name, opacity_value

    def __init__(self):
        """Initialize the opacity effects service."""
        super().__init__()
        self.logger = setup_logger()

        # Storage for opacity effects
        self._opacity_effects: dict[str, QGraphicsOpacityEffect] = {}
        self._widget_mappings: dict[str, QWidget] = {}

        # Storage for animations
        self._animations: dict[str, QPropertyAnimation] = {}

        # Default animation settings
        self.default_duration = 500  # milliseconds
        self.default_easing_curve = QEasingCurve.Type.InOutQuad

        # Predefined opacity values
        self.opacity_values = {
            "hidden": 0.0,
            "dimmed": 0.4,
            "normal": 1.0,
            "transparent": 0.1,
            "semi_transparent": 0.7,
        }

    def create_opacity_effect(
    self,
    effect_name: str,
    initial_opacity: float = 1.0) -> QGraphicsOpacityEffect:
        """Create a new opacity effect.
        
        Args:
            effect_name: Unique name for the effect
            initial_opacity: Initial opacity value (0.0 to 1.0)
            
        Returns:
            QGraphicsOpacityEffect instance
            
        Raises:
            OpacityEffectsError: If effect name already exists or invalid opacity
        """
        try:
            if effect_name in self._opacity_effects:
                msg = f"Opacity effect '{effect_name}' already exists"
                raise OpacityEffectsError(msg)

            if not 0.0 <= initial_opacity <= 1.0:
                msg = f"Invalid opacity value: {initial_opacity}. Must be between 0.0 and 1.0"
                raise OpacityEffectsError(msg)

            # Create the effect
            effect = QGraphicsOpacityEffect()
            effect.setOpacity(initial_opacity)

            # Store the effect
            self._opacity_effects[effect_name] = effect

            self.effect_created.emit(effect_name, effect)
            self.logger.debug("Created opacity effect '{effect_name}' with opacity {initial_opacity}\
    ")

            return effect

        except Exception as e:
            error_msg = f"Failed to create opacity effect '{effect_name}': {e}"
            self.logger.exception(error_msg)
            raise OpacityEffectsError(error_msg,
    )

    def apply_effect_to_widget(self, effect_name: str, widget: QWidget,
    ) -> bool:
        """Apply an opacity effect to a widget.
        
        Args:
            effect_name: Name of the opacity effect
            widget: Widget to apply the effect to
            
        Returns:
            True if application successful, False otherwise
        """
        try:
            if effect_name not in self._opacity_effects:
                self.logger.error("Opacity effect '{effect_name}' not found")
                return False

            effect = self._opacity_effects[effect_name]
            widget.setGraphicsEffect(effect)

            # Store widget mapping
            self._widget_mappings[effect_name] = widget

            self.effect_applied.emit(effect_name, widget)
            self.logger.debug("Applied opacity effect '{effect_name}' to widget")

            return True

        except Exception as e:
            self.logger.exception(f"Failed to apply opacity effect '{effect_name}': {e}")
            return False

    def set_opacity(self, effect_name: str, opacity: float,
    ) -> bool:
        """Set opacity value for an effect.
        
        Args:
            effect_name: Name of the opacity effect
            opacity: Opacity value (0.0 to 1.0)
            
        Returns:
            True if set successful, False otherwise
        """
        try:
            if effect_name not in self._opacity_effects:
                self.logger.error("Opacity effect '{effect_name}' not found")
                return False

            if not 0.0 <= opacity <= 1.0:
                self.logger.error("Invalid opacity value: {opacity}. Must be between 0.0 and 1.0")
                return False

            effect = self._opacity_effects[effect_name]
            effect.setOpacity(opacity)

            self.opacity_changed.emit(effect_name, opacity)
            self.logger.debug("Set opacity for '{effect_name}' to {opacity}")

            return True

        except Exception as e:
            self.logger.exception(f"Failed to set opacity for '{effect_name}': {e}")
            return False

    def get_opacity(self, effect_name: str,
    ) -> float | None:
        """Get current opacity value for an effect.
        
        Args:
            effect_name: Name of the opacity effect
            
        Returns:
            Current opacity value or None if effect not found
        """
        if effect_name not in self._opacity_effects:
            return None

        return self._opacity_effects[effect_name].opacity()

    def animate_opacity(self, effect_name: str, target_opacity: float,
                       duration: int | None = None,
                       easing_curve: QEasingCurve.Type | None = None,
                       animation_name: str | None = None,
                       finished_callback: Callable | None = None) -> bool:
        """Animate opacity change for an effect.
        
        Args:
            effect_name: Name of the opacity effect
            target_opacity: Target opacity value (0.0 to 1.0)
            duration: Animation duration in milliseconds
            easing_curve: Easing curve for animation
            animation_name: Custom name for the animation
            finished_callback: Callback function when animation finishes
            
        Returns:
            True if animation started successfully, False otherwise
        """
        try:
            if effect_name not in self._opacity_effects:
                self.logger.error("Opacity effect '{effect_name}' not found")
                return False

            if not 0.0 <= target_opacity <= 1.0:
                self.logger.error(f"Invalid target opacity: {target_opacity}. Must be between 0.0 and 1.0")
                return False

            effect = self._opacity_effects[effect_name]

            # Use defaults if not provided
            duration = duration or self.default_duration
            easing_curve = easing_curve or self.default_easing_curve
            animation_name = animation_name or f"animate_{effect_name}"

            # Stop existing animation if running
            if animation_name in self._animations:
                self._animations[animation_name].stop()

            # Create animation
            animation = QPropertyAnimation(effect, b"opacity")
            animation.setDuration(duration)
            animation.setStartValue(effect.opacity())
            animation.setEndValue(target_opacity)
            animation.setEasingCurve(easing_curve)

            # Connect signals
            animation.valueChanged.connect(lambda: self.animation_started.emit(animation_name))
            animation.finished.connect(lambda: self.animation_finished.emit(animation_name))
            animation.finished.connect(lambda: self._cleanup_animation(animation_name))

            if finished_callback:
                animation.finished.connect(finished_callback)

            # Store and start animation
            self._animations[animation_name] = animation
            animation.start()

            self.logger.debug("Started opacity animation '{animation_name}' for '{effect_name}' to {\
    target_opacity}")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to animate opacity for '{effect_name}': {e}")
            return False

    def fade_in(self, effect_name: str, duration: int | None = None,
               target_opacity: float = 1.0, animation_name: str | None = None) -> bool:
        """Fade in an effect (animate to higher opacity).
        
        Args:
            effect_name: Name of the opacity effect
            duration: Animation duration in milliseconds
            target_opacity: Target opacity value for fade in
            animation_name: Custom name for the animation
            
        Returns:
            True if fade in started successfully, False otherwise
        """
        animation_name = animation_name or f"fade_in_{effect_name}"
        return self.animate_opacity(effect_name, target_opacity, duration,
                                  animation_name=animation_name)

    def fade_out(self, effect_name: str, duration: int | None = None,
                target_opacity: float = 0.0, animation_name: str | None = None) -> bool:
        """Fade out an effect (animate to lower opacity).
        
        Args:
            effect_name: Name of the opacity effect
            duration: Animation duration in milliseconds
            target_opacity: Target opacity value for fade out
            animation_name: Custom name for the animation
            
        Returns:
            True if fade out started successfully, False otherwise
        """
        animation_name = animation_name or f"fade_out_{effect_name}"
        return self.animate_opacity(effect_name, target_opacity, duration,
                                  animation_name=animation_name)

    def fade_to_dimmed(self, effect_name: str, duration: int | None = None,
                      animation_name: str | None = None) -> bool:
        """Fade to dimmed opacity (0.4).
        
        Args:
            effect_name: Name of the opacity effect
            duration: Animation duration in milliseconds
            animation_name: Custom name for the animation
            
        Returns:
            True if fade started successfully, False otherwise
        """
        animation_name = animation_name or f"fade_to_dimmed_{effect_name}"
        return self.animate_opacity(effect_name, self.opacity_values["dimmed"],
                                  duration, animation_name=animation_name)

    def stop_animation(self, animation_name: str,
    ) -> bool:
        """Stop a running animation.
        
        Args:
            animation_name: Name of the animation to stop
            
        Returns:
            True if animation stopped, False if not found
        """
        if animation_name not in self._animations:
            return False

        try:
            self._animations[animation_name].stop()
            self._cleanup_animation(animation_name)
            self.logger.debug("Stopped animation '{animation_name}'")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to stop animation '{animation_name}': {e}")
            return False

    def stop_all_animations(self) -> None:
        """Stop all running animations."""
        animation_names = list(self._animations.keys())
        for animation_name in animation_names:
            self.stop_animation(animation_name)

    def is_animation_running(self, animation_name: str,
    ) -> bool:
        """Check if an animation is currently running.
        
        Args:
            animation_name: Name of the animation
            
        Returns:
            True if animation is running, False otherwise
        """
        if animation_name not in self._animations:
            return False

        animation = self._animations[animation_name]
        return animation.state() == QPropertyAnimation.State.Running

    def get_effect(self, effect_name: str,
    ) -> QGraphicsOpacityEffect | None:
        """Get an opacity effect by name.
        
        Args:
            effect_name: Name of the opacity effect
            
        Returns:
            QGraphicsOpacityEffect or None if not found
        """
        return self._opacity_effects.get(effect_name)

    def get_widget(self, effect_name: str,
    ) -> QWidget | None:
        """Get the widget associated with an effect.
        
        Args:
            effect_name: Name of the opacity effect
            
        Returns:
            QWidget or None if not found
        """
        return self._widget_mappings.get(effect_name)

    def remove_effect(self, effect_name: str,
    ) -> bool:
        """Remove an opacity effect.
        
        Args:
            effect_name: Name of the opacity effect to remove
            
        Returns:
            True if removed successfully, False if not found
        """
        try:
            if effect_name not in self._opacity_effects:
                return False

            # Stop any running animations for this effect
            animations_to_stop = [name for name in self._animations
                                if effect_name in name]
            for animation_name in animations_to_stop:
                self.stop_animation(animation_name)

            # Remove widget graphics effect
            if effect_name in self._widget_mappings:
                widget = self._widget_mappings[effect_name]
                widget.setGraphicsEffect(None)
                del self._widget_mappings[effect_name]

            # Remove effect
            del self._opacity_effects[effect_name]

            self.logger.debug("Removed opacity effect '{effect_name}'")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to remove opacity effect '{effect_name}': {e}",
    )
            return False

    def set_default_duration(self, duration: int,
    ) -> None:
        """Set default animation duration.
        
        Args:
            duration: Duration in milliseconds
        """
        if duration > 0:
            self.default_duration = duration
            self.logger.debug("Default animation duration set to {duration}ms")

    def set_default_easing_curve(self, easing_curve: QEasingCurve.Type) -> None:
        """Set default easing curve for animations.
        
        Args:
            easing_curve: QEasingCurve type
        """
        self.default_easing_curve = easing_curve
        self.logger.debug("Default easing curve set to {easing_curve}")

    def get_all_effects(self) -> dict[str, QGraphicsOpacityEffect]:
        """Get all opacity effects.
        
        Returns:
            Dictionary of effect names to QGraphicsOpacityEffect objects
        """
        return self._opacity_effects.copy()

    def get_all_animations(self) -> dict[str, QPropertyAnimation]:
        """Get all animations.
        
        Returns:
            Dictionary of animation names to QPropertyAnimation objects
        """
        return self._animations.copy()

    def _cleanup_animation(self, animation_name: str,
    ) -> None:
        """Clean up finished animation.
        
        Args:
            animation_name: Name of the animation to clean up
        """
        if animation_name in self._animations:
            del self._animations[animation_name]

    def cleanup(self) -> None:
        """Clean up all opacity effects and animations."""
        try:
            # Stop all animations
            self.stop_all_animations()

            # Remove all effects
            effect_names = list(self._opacity_effects.keys())
            for effect_name in effect_names:
                self.remove_effect(effect_name)

            # Clear storage
            self._opacity_effects.clear()
            self._widget_mappings.clear()
            self._animations.clear()

            self.logger.debug("Opacity effects service cleaned up")

        except Exception as e:
            self.logger.exception(f"Failed to cleanup opacity effects service: {e}")


class OpacityEffectsManager:
    """High-level manager for opacity effects operations."""

    def __init__(self):
        self._service: OpacityEffectsService | None = None

    def create_opacity_service(self) -> OpacityEffectsService:
        """Create and return opacity effects service.
        
        Returns:
            OpacityEffectsService instance
        """
        self._service = OpacityEffectsService()
        return self._service

    def get_service(self) -> OpacityEffectsService | None:
        """Get current opacity effects service.
        
        Returns:
            Current OpacityEffectsService or None if not created
        """
        return self._service

    def setup_standard_effects(self, widgets: dict[str, QWidget]) -> bool:
        """Setup standard opacity effects for common UI elements.
        
        Args:
            widgets: Dictionary mapping effect names to widgets
            
        Returns:
            True if setup successful, False otherwise
            
        Raises:
            OpacityEffectsError: If service not created
        """
        if not self._service:
            msg = "Opacity effects service not created"
            raise OpacityEffectsError(msg,
    )

        try:
            for effect_name, widget in widgets.items():
                # Create effect with normal opacity
                self._service.create_opacity_effect(effect_name, 1.0)

                # Apply to widget
                self._service.apply_effect_to_widget(effect_name, widget)

            return True

        except Exception as e:
            msg = f"Failed to setup standard effects: {e}"
            raise OpacityEffectsError(msg,
    )

    def fade_out_all_except(self, except_effects: list, target_opacity: float = 0.4,
    ) -> bool:
        """Fade out all effects except specified ones.
        
        Args:
            except_effects: List of effect names to exclude from fade out
            target_opacity: Target opacity for fade out
            
        Returns:
            True if fade out started successfully, False otherwise
            
        Raises:
            OpacityEffectsError: If service not created
        """
        if not self._service:
            msg = "Opacity effects service not created"
            raise OpacityEffectsError(msg)

        try:
            all_effects = self._service.get_all_effects()

            for effect_name in all_effects:
                if effect_name not in except_effects:
                    self._service.fade_out(effect_name, target_opacity=target_opacity)

            return True

        except Exception as e:
            msg = f"Failed to fade out effects: {e}"
            raise OpacityEffectsError(msg,
    )

    def fade_in_all(self, target_opacity: float = 1.0,
    ) -> bool:
        """Fade in all effects.
        
        Args:
            target_opacity: Target opacity for fade in
            
        Returns:
            True if fade in started successfully, False otherwise
            
        Raises:
            OpacityEffectsError: If service not created
        """
        if not self._service:
            msg = "Opacity effects service not created"
            raise OpacityEffectsError(msg)

        try:
            all_effects = self._service.get_all_effects()

            for effect_name in all_effects:
                self._service.fade_in(effect_name, target_opacity=target_opacity)

            return True

        except Exception as e:
            msg = f"Failed to fade in effects: {e}"
            raise OpacityEffectsError(msg)

    def cleanup(self) -> None:
        """Clean up opacity effects manager."""
        if self._service:
            self._service.cleanup()
            self._service = None