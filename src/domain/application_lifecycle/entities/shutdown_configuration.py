"""Shutdown Configuration Entity.

This module contains the ShutdownConfiguration entity for application shutdown settings.
"""

from dataclasses import dataclass

from src.domain.common.entity import Entity


@dataclass
class ShutdownConfiguration(Entity):
    """Configuration for application shutdown.
    
    This entity encapsulates all the settings and preferences for how
    the application should shut down, including cleanup, timeouts, and behaviors.
    """

    save_state: bool = True
    force_worker_termination: bool = False
    worker_timeout_seconds: int = 5
    cleanup_temp_files: bool = True
    save_window_state: bool = True
    graceful_timeout_seconds: int = 10
    force_exit_on_timeout: bool = True

    def __post_init__(self) -> None:
        # Generate ID based on key configuration settings
        config_id = f"shutdown_{self.worker_timeout_seconds}_{self.graceful_timeout_seconds}_{self.save_state}"
        super().__init__(config_id)

    def is_graceful_shutdown(self) -> bool:
        """Check if graceful shutdown is configured."""
        return self.save_state and self.save_window_state and not self.force_worker_termination

    def is_aggressive_shutdown(self) -> bool:
        """Check if aggressive shutdown is configured."""
        return self.force_worker_termination and self.force_exit_on_timeout

    def should_cleanup_resources(self) -> bool:
        """Check if resource cleanup is enabled."""
        return self.cleanup_temp_files or self.save_state or self.save_window_state

    def get_total_timeout(self) -> int:
        """Calculate total shutdown timeout."""
        return self.worker_timeout_seconds + self.graceful_timeout_seconds

    def is_state_preservation_enabled(self) -> bool:
        """Check if state preservation is enabled."""
        return self.save_state or self.save_window_state

    def __invariants__(self) -> None:
        """Validate entity invariants."""
        if self.worker_timeout_seconds < 0:
            msg = "Worker timeout cannot be negative"
            raise ValueError(msg)
        if self.graceful_timeout_seconds < 0:
            msg = "Graceful timeout cannot be negative"
            raise ValueError(msg)
        if self.worker_timeout_seconds == 0 and not self.force_worker_termination:
            msg = "Worker timeout cannot be zero without force termination"
            raise ValueError(msg)