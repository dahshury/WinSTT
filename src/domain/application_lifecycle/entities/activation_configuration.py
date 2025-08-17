"""Activation Configuration Entity.

This module contains the ActivationConfiguration entity for window activation settings.
"""

from dataclasses import dataclass, field

from src.domain.common.entity import Entity
from src.domain.window_management.value_objects import ActivationMethod


@dataclass
class ActivationConfiguration(Entity):
    """Configuration for window activation.
    
    This entity encapsulates all the settings and preferences for how
    windows should be activated, including methods, timeouts, and behaviors.
    """

    method: ActivationMethod = ActivationMethod.WIN32_API
    fallback_methods: list[ActivationMethod] = field(default_factory=list)
    timeout_seconds: int = 5
    retry_attempts: int = 3
    retry_delay_seconds: float = 0.5
    restore_if_minimized: bool = True
    bring_to_foreground: bool = True
    focus_window: bool = True
    flash_window: bool = False
    flash_count: int = 3

    def __post_init__(self) -> None:
        # Generate ID based on configuration
        config_id = f"{self.method.value}_{self.timeout_seconds}_{self.retry_attempts}"
        super().__init__(config_id,
    )

        if not self.fallback_methods:
            self.fallback_methods = [ActivationMethod.QT_NATIVE, ActivationMethod.FORCE_FOREGROUND]

    def get_all_methods(self) -> list[ActivationMethod]:
        """Get all activation methods including primary and fallbacks."""
        return [self.method, *self.fallback_methods]

    def has_fallback_methods(self) -> bool:
        """Check if fallback methods are configured."""
        return len(self.fallback_methods) > 0

    def is_aggressive_activation(self) -> bool:
        """Check if configuration uses aggressive activation settings."""
        return (
            self.restore_if_minimized and
            self.bring_to_foreground and
            self.focus_window and
            self.flash_window
        )

    def get_total_timeout(self) -> float:
        """Calculate total timeout including retries."""
        return self.timeout_seconds + (self.retry_attempts * self.retry_delay_seconds)

    def __invariants__(self) -> None:
        """Validate entity invariants."""
        if self.timeout_seconds <= 0:
            msg = "Timeout must be positive"
            raise ValueError(msg)
        if self.retry_attempts < 0:
            msg = "Retry attempts cannot be negative"
            raise ValueError(msg)
        if self.retry_delay_seconds < 0:
            msg = "Retry delay cannot be negative"
            raise ValueError(msg)
        if self.flash_count < 0:
            msg = "Flash count cannot be negative"
            raise ValueError(msg)
        if self.method in self.fallback_methods:
            msg = "Primary method cannot be in fallback methods"
            raise ValueError(msg,
    )