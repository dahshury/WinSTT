"""Message display service for UI message management with animations.

This module provides infrastructure services for displaying messages
with opacity effects, fade animations, and progress tracking.
"""

from collections.abc import Callable
from typing import Any

from PyQt6 import QtCore
from PyQt6.QtCore import QParallelAnimationGroup, QPropertyAnimation, QTimer
from PyQt6.QtWidgets import QGraphicsOpacityEffect, QLabel, QProgressBar


class MessageDisplayService:
    """Service for managing UI message display with animations and effects.
    
    This service provides infrastructure-only logic for message display,
    opacity effects, and fade animations without any business logic dependencies.
    """

    def __init__(self):
        """Initialize the message display service."""
        self._label_opacity_effects = {}
        self._progress_opacity_effects = {}
        self._fade_animations = {}
        self._animation_groups = {}
        self._timers = {}

        # Default animation settings
        self.default_fade_duration = 3000  # 3 seconds
        self.default_hold_duration = 5000   # 5 seconds
        self.default_easing_curve = QtCore.QEasingCurve.Type.InOutQuad

    def setup_opacity_effect(self, widget: Any, widget_id: str,
    ) -> QGraphicsOpacityEffect:
        """Setup opacity effect for a widget.
        
        Args:
            widget: Widget to apply opacity effect to
            widget_id: Unique identifier for the widget
            
        Returns:
            QGraphicsOpacityEffect instance
        """
        if widget_id in self._label_opacity_effects:
            return self._label_opacity_effects[widget_id]

        opacity_effect = QGraphicsOpacityEffect(widget)
        widget.setGraphicsEffect(opacity_effect)
        self._label_opacity_effects[widget_id] = opacity_effect

        return opacity_effect

    def setup_progress_opacity_effect(self,
    progress_bar: QProgressBar, widget_id: str,
    ) -> QGraphicsOpacityEffect | None:
        """Setup opacity effect for a progress bar.
        
        Args:
            progress_bar: Progress bar widget
            widget_id: Unique identifier for the progress bar
            
        Returns:
            QGraphicsOpacityEffect instance or None if setup failed
        """
        if widget_id in self._progress_opacity_effects:
            return self._progress_opacity_effects[widget_id]

        if progress_bar is None:
            return None

        try:
            opacity_effect = QGraphicsOpacityEffect(progress_bar)
            progress_bar.setGraphicsEffect(opacity_effect,
    )
            self._progress_opacity_effects[widget_id] = opacity_effect
            return opacity_effect
        except RuntimeError:
            # Progress bar has been deleted
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
        """Display a text message with fade animation.
        
        Args:
            label: Label widget to display text in
            text: Text to display
            widget_id: Unique identifier for the widget
            hold: Whether to hold the message without fading
            fade_duration: Duration of fade animation in milliseconds
            hold_duration: Duration to hold message before fading in milliseconds
            easing_curve: Easing curve for animation
            on_finished: Callback to execute when animation finishes
        """
        # Setup opacity effect
        opacity_effect = self.setup_opacity_effect(label, widget_id)

        # Set text and reset opacity
        opacity_effect.setOpacity(1.0)
        label.setText(text)

        # Don't animate if holding
        if hold:
            return

        # Use default values if not provided
        fade_dur = fade_duration or self.default_fade_duration
        hold_dur = hold_duration or self.default_hold_duration
        easing = easing_curve or self.default_easing_curve

        # Create fade out animation
        fade_animation = QPropertyAnimation(opacity_effect, b"opacity")
        fade_animation.setDuration(fade_dur)
        fade_animation.setStartValue(1.0)
        fade_animation.setEndValue(0.0)
        fade_animation.setEasingCurve(easing)

        # Clear text after animation
        def cleanup():
            label.setText("")
            if on_finished:
                on_finished()

        fade_animation.finished.connect(cleanup)

        # Store animation reference
        self._fade_animations[f"{widget_id}_fade"] = fade_animation

        # Start fade out after hold duration
        timer = QTimer()
        timer.setSingleShot(True)
        timer.timeout.connect(fade_animation.start)
        timer.start(hold_dur)

        # Store timer reference
        self._timers[f"{widget_id}_timer"] = timer

    def display_filename_message(self, label: QLabel, filename: str, widget_id: str,
    ) -> None:
        """Display a filename download message.
        
        Args:
            label: Label widget to display text in
            filename: Filename being downloaded
            widget_id: Unique identifier for the widget
        """
        opacity_effect = self.setup_opacity_effect(label, widget_id)
        label.setText(f"Downloading {filename}...")
        opacity_effect.setOpacity(1.0)

    def update_progress(self,
                       progress_bar: QProgressBar,
                       percentage: float,
                       widget_id: str,
                       on_state_change: Callable[[bool], None] | None = None) -> None:
        """Update progress bar value with state management.
        
        Args:
            progress_bar: Progress bar widget
            percentage: Progress percentage (0-100)
            widget_id: Unique identifier for the progress bar
            on_state_change: Callback for state changes (downloading/completed)
        """
        if progress_bar is None:
            return

        try:
            # Block signals during update
            progress_bar.blockSignals(True)

            # Setup opacity effect if needed
            opacity_effect = self.setup_progress_opacity_effect(progress_bar, widget_id)

            # Show progress bar if hidden
            if not progress_bar.isVisible():
                progress_bar.setVisible(True)
                if opacity_effect:
                    opacity_effect.setOpacity(1.0)

            # Update value
            progress_bar.setProperty("value", percentage)

            # Unblock signals
            progress_bar.blockSignals(False)

            # Handle state changes
            if on_state_change:
                if percentage < 100:
                    on_state_change(True)  # Downloading
                else:
                    on_state_change(False)  # Completed

        except RuntimeError:
            # Progress bar has been deleted
            pass

    def reset_display(self,
                     label: QLabel,
                     progress_bar: QProgressBar | None,
                     widget_id: str,
                     fade_duration: int | None = None,
                     on_finished: Callable | None = None) -> None:
        """Reset display elements with fade animation.
        
        Args:
            label: Label widget to reset
            progress_bar: Progress bar widget to reset (optional)
            widget_id: Unique identifier for the widgets
            fade_duration: Duration of fade animation in milliseconds
            on_finished: Callback to execute when reset is complete
        """
        fade_dur = fade_duration or self.default_fade_duration

        # Get opacity effects
        label_opacity = self._label_opacity_effects.get(widget_id)
        progress_opacity = self._progress_opacity_effects.get(widget_id) if progress_bar else None

        if not label_opacity:
            # No opacity effect, just reset immediately
            self._reset_immediately(label, progress_bar, on_finished)
            return

        # Create fade animations
        fade_label = QPropertyAnimation(label_opacity, b"opacity")
        fade_label.setDuration(fade_dur)
        fade_label.setStartValue(1.0)
        fade_label.setEndValue(0.0)

        animations = [fade_label]

        if progress_bar and progress_opacity:
            try:
                # Block signals during reset
                progress_bar.blockSignals(True)

                fade_progress = QPropertyAnimation(progress_opacity, b"opacity")
                fade_progress.setDuration(fade_dur)
                fade_progress.setStartValue(1.0)
                fade_progress.setEndValue(0.0)
                animations.append(fade_progress)
            except RuntimeError:
                # Progress bar has been deleted
                pass

        # Create animation group
        animation_group = QParallelAnimationGroup()
        for animation in animations:
            animation_group.addAnimation(animation)

        # Setup cleanup function
        def cleanup():
            self._reset_immediately(label, progress_bar, on_finished)

        animation_group.finished.connect(cleanup)

        # Store animation group reference
        self._animation_groups[f"{widget_id}_reset"] = animation_group

        # Start animation
        animation_group.start()

    def _reset_immediately(self,
                          label: QLabel,
                          progress_bar: QProgressBar | None,
                          on_finished: Callable | None = None) -> None:
        """Reset display elements immediately without animation.
        
        Args:
            label: Label widget to reset
            progress_bar: Progress bar widget to reset (optional)
            on_finished: Callback to execute when reset is complete
        """
        try:
            # Reset progress bar
            if progress_bar:
                progress_bar.setValue(0)
                progress_bar.setVisible(False)
                progress_bar.blockSignals(False)

            # Reset label
            label.setText("")

            # Reset opacity effects
            for opacity_effect in self._label_opacity_effects.values():
                if opacity_effect:
                    opacity_effect.setOpacity(1.0)

            for opacity_effect in self._progress_opacity_effects.values():
                if opacity_effect:
                    opacity_effect.setOpacity(1.0)

            if on_finished:
                on_finished()

        except RuntimeError:
            # Widgets have been deleted
            if on_finished:
                on_finished()

    def stop_animations(self, widget_id: str | None = None) -> None:
        """Stop running animations.
        
        Args:
            widget_id: Specific widget ID to stop animations for (None for all)
        """
        if widget_id:
            # Stop specific widget animations
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
            # Stop all animations
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
        """Set default fade animation duration.
        
        Args:
            duration: Duration in milliseconds
        """
        self.default_fade_duration = duration

    def set_default_hold_duration(self, duration: int,
    ) -> None:
        """Set default hold duration before fade.
        
        Args:
            duration: Duration in milliseconds
        """
        self.default_hold_duration = duration

    def set_default_easing_curve(self, curve: QtCore.QEasingCurve.Type) -> None:
        """Set default easing curve for animations.
        
        Args:
            curve: Easing curve type
        """
        self.default_easing_curve = curve

    def get_opacity_effect(self, widget_id: str,
    ) -> QGraphicsOpacityEffect | None:
        """Get opacity effect for a widget.
        
        Args:
            widget_id: Widget identifier
            
        Returns:
            QGraphicsOpacityEffect or None if not found
        """
        return self._label_opacity_effects.get(widget_id)

    def get_progress_opacity_effect(self, widget_id: str,
    ) -> QGraphicsOpacityEffect | None:
        """Get progress opacity effect for a widget.
        
        Args:
            widget_id: Widget identifier
            
        Returns:
            QGraphicsOpacityEffect or None if not found
        """
        return self._progress_opacity_effects.get(widget_id)

    def is_animation_running(self, widget_id: str,
    ) -> bool:
        """Check if animations are running for a widget.
        
        Args:
            widget_id: Widget identifier
            
        Returns:
            True if animations are running, False otherwise
        """
        fade_key = f"{widget_id}_fade"
        reset_key = f"{widget_id}_reset"

        fade_running = (fade_key in self._fade_animations and
                       self._fade_animations[fade_key].state() == QPropertyAnimation.State.Running)

        reset_running = (reset_key in self._animation_groups and
self._animation_groups[reset_key].state() == QParallelAnimationGroup.State.Running)

        return fade_running or reset_running

    def cleanup(self) -> None:
        """Clean up service resources."""
        self.stop_animations()
        self._label_opacity_effects.clear()
        self._progress_opacity_effects.clear()

    def __del__(self):
        """Destructor to ensure cleanup."""
        self.cleanup()


class MessageDisplayManager:
    """High-level manager for message display functionality.
    
    Provides a simplified interface for common message display patterns.
    """

    def __init__(self):
        """Initialize the message display manager."""
        self.service = MessageDisplayService()

    def show_temporary_message(self,
                             label: QLabel,
                             text: str,
                             widget_id: str = "default",
                             duration: int = 5000,
    ) -> None:
        """Show a temporary message that fades out.
        
        Args:
            label: Label widget to display message in
            text: Message text
            widget_id: Unique identifier for the widget
            duration: Duration to show message before fading
        """
        self.service.display_text_message(
            label=label,
            text=text,
            widget_id=widget_id,
            hold=False,
            hold_duration=duration,
        )

    def show_persistent_message(self,
                              label: QLabel,
                              text: str,
                              widget_id: str = "default",
    ) -> None:
        """Show a persistent message that doesn't fade.
        
        Args:
            label: Label widget to display message in
            text: Message text
            widget_id: Unique identifier for the widget
        """
        self.service.display_text_message(
            label=label,
            text=text,
            widget_id=widget_id,
            hold=True,
        )

    def show_download_progress(self,
                             label: QLabel,
                             progress_bar: QProgressBar,
                             filename: str,
                             percentage: float,
                             widget_id: str = "download",
    ) -> None:
        """Show download progress with filename and percentage.
        
        Args:
            label: Label widget for filename
            progress_bar: Progress bar widget
            filename: Name of file being downloaded
            percentage: Download percentage
            widget_id: Unique identifier for the widgets
        """
        self.service.display_filename_message(label, filename, f"{widget_id}_label")
        self.service.update_progress(progress_bar, percentage, f"{widget_id}_progress")

    def reset_all(self,
                 label: QLabel,
                 progress_bar: QProgressBar | None = None,
                 widget_id: str = "default") -> None:
        """Reset all display elements.
        
        Args:
            label: Label widget to reset
            progress_bar: Progress bar widget to reset (optional,
    )
            widget_id: Unique identifier for the widgets
        """
        self.service.reset_display(label, progress_bar, widget_id)

    def cleanup(self) -> None:
        """Clean up manager resources."""
        self.service.cleanup()