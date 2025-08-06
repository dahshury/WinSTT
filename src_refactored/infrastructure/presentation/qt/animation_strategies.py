"""Animation strategies for UI components in the refactored architecture.

This module provides comprehensive animation strategies with PyQt6 integration
for opacity effects and transitions, following the Strategy pattern.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

from src_refactored.domain.common.result import Result

if TYPE_CHECKING:
    from PyQt6.QtWidgets import QWidget


class IAnimationStrategy(ABC):
    """Interface for widget animation strategies."""
    
    @abstractmethod
    def execute(self, context: QWidget) -> Result[None]:
        """Execute the animation strategy.
        
        Args:
            context: The widget to animate
            
        Returns:
            Result indicating success or failure of the animation
        """


class FadeInStrategy(IAnimationStrategy):
    """Strategy for fade-in animations using opacity effects."""
    
    def __init__(self, duration: int = 500):
        """Initialize fade-in strategy.
        
        Args:
            duration: Animation duration in milliseconds
        """
        self.duration = duration
    
    def execute(self, context: QWidget) -> Result[None]:
        """Execute fade-in animation.
        
        Args:
            context: The widget to animate
            
        Returns:
            Result indicating success or failure of the animation
        """
        try:
            from PyQt6.QtCore import QPropertyAnimation
            from PyQt6.QtWidgets import QGraphicsOpacityEffect
            
            effect = QGraphicsOpacityEffect()
            context.setGraphicsEffect(effect)
            
            self.animation = QPropertyAnimation(effect, b"opacity")
            self.animation.setDuration(self.duration)
            self.animation.setStartValue(0.0)
            self.animation.setEndValue(1.0)
            self.animation.start()
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Fade-in animation failed: {e!s}")


class SlideInStrategy(IAnimationStrategy):
    """Strategy for slide-in animations with directional movement."""
    
    def __init__(self, direction: str = "left", duration: int = 500):
        """Initialize slide-in strategy.
        
        Args:
            direction: Direction of slide animation (left, right, top, bottom)
            duration: Animation duration in milliseconds
        """
        self.direction = direction
        self.duration = duration
    
    def execute(self, context: QWidget) -> Result[None]:
        """Execute slide-in animation.
        
        Args:
            context: The widget to animate
            
        Returns:
            Result indicating success or failure of the animation
        """
        try:
            from PyQt6.QtCore import QPropertyAnimation, QRect
            
            # Get current geometry
            current_rect = context.geometry()
            
            # Calculate start position based on direction
            start_rect = QRect(current_rect)
            if self.direction == "left":
                start_rect.moveLeft(current_rect.left() - current_rect.width())
            elif self.direction == "right":
                start_rect.moveLeft(current_rect.left() + current_rect.width())
            elif self.direction == "top":
                start_rect.moveTop(current_rect.top() - current_rect.height())
            elif self.direction == "bottom":
                start_rect.moveTop(current_rect.top() + current_rect.height())
            
            # Set start position and animate to end position
            context.setGeometry(start_rect)
            
            self.animation = QPropertyAnimation(context, b"geometry")
            self.animation.setDuration(self.duration)
            self.animation.setStartValue(start_rect)
            self.animation.setEndValue(current_rect)
            self.animation.start()
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Slide-in animation failed: {e!s}")


class AnimationContext:
    """Context for managing and executing animation strategies."""
    
    def __init__(self, widget: QWidget):
        """Initialize animation context.
        
        Args:
            widget: The widget to be animated
        """
        self.widget = widget
        self._strategy: IAnimationStrategy | None = None
    
    def set_strategy(self, strategy: IAnimationStrategy) -> None:
        """Set the animation strategy.
        
        Args:
            strategy: The animation strategy to use
        """
        self._strategy = strategy
    
    def animate(self) -> Result[None]:
        """Execute the current animation strategy.
        
        Returns:
            Result indicating success or failure of the animation
        """
        if not self._strategy:
            return Result.failure("No animation strategy set")
        
        return self._strategy.execute(self.widget)


class FadeOutStrategy(IAnimationStrategy):
    """Strategy for fade-out animations using opacity effects."""
    
    def __init__(self, duration: int = 500):
        """Initialize fade-out strategy.
        
        Args:
            duration: Animation duration in milliseconds
        """
        self.duration = duration
    
    def execute(self, context: QWidget) -> Result[None]:
        """Execute fade-out animation.
        
        Args:
            context: The widget to animate
            
        Returns:
            Result indicating success or failure of the animation
        """
        try:
            from PyQt6.QtCore import QPropertyAnimation
            from PyQt6.QtWidgets import QGraphicsOpacityEffect
            
            effect = QGraphicsOpacityEffect()
            context.setGraphicsEffect(effect)
            
            self.animation = QPropertyAnimation(effect, b"opacity")
            self.animation.setDuration(self.duration)
            self.animation.setStartValue(1.0)
            self.animation.setEndValue(0.0)
            self.animation.start()
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Fade-out animation failed: {e!s}")


class SlideOutStrategy(IAnimationStrategy):
    """Strategy for slide-out animations with directional movement."""
    
    def __init__(self, direction: str = "left", duration: int = 500):
        """Initialize slide-out strategy.
        
        Args:
            direction: Direction of slide animation (left, right, top, bottom)
            duration: Animation duration in milliseconds
        """
        self.direction = direction
        self.duration = duration
    
    def execute(self, context: QWidget) -> Result[None]:
        """Execute slide-out animation.
        
        Args:
            context: The widget to animate
            
        Returns:
            Result indicating success or failure of the animation
        """
        try:
            from PyQt6.QtCore import QPropertyAnimation, QRect
            
            # Get current geometry
            current_rect = context.geometry()
            
            # Calculate end position based on direction
            end_rect = QRect(current_rect)
            if self.direction == "left":
                end_rect.moveLeft(current_rect.left() - current_rect.width())
            elif self.direction == "right":
                end_rect.moveLeft(current_rect.left() + current_rect.width())
            elif self.direction == "top":
                end_rect.moveTop(current_rect.top() - current_rect.height())
            elif self.direction == "bottom":
                end_rect.moveTop(current_rect.top() + current_rect.height())
            
            self.animation = QPropertyAnimation(context, b"geometry")
            self.animation.setDuration(self.duration)
            self.animation.setStartValue(current_rect)
            self.animation.setEndValue(end_rect)
            self.animation.start()
            
            return Result.success(None)
        except Exception as e:
            return Result.failure(f"Slide-out animation failed: {e!s}")


__all__ = [
    "AnimationContext",
    "FadeInStrategy",
    "FadeOutStrategy",
    "IAnimationStrategy",
    "SlideInStrategy",
    "SlideOutStrategy",
]