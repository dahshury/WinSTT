"""Progress session aggregate for progress management domain."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from enum import Enum
from typing import Any

from src_refactored.domain.common import AggregateRoot
from src_refactored.domain.common.domain_utils import DomainIdentityGenerator


class ProgressSessionState(Enum):
    """Progress session state enumeration."""
    IDLE = "idle"
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    ERROR = "error"


class ProgressType(Enum):
    """Progress type enumeration."""
    DOWNLOAD = "download"
    UPLOAD = "upload"
    PROCESSING = "processing"
    TRANSCRIPTION = "transcription"
    CONVERSION = "conversion"
    BATCH_OPERATION = "batch_operation"
    MODEL_LOADING = "model_loading"
    FILE_OPERATION = "file_operation"


@dataclass
class ProgressMetrics:
    """Progress metrics data."""
    current_value: float = 0.0
    total_value: float = 100.0
    percentage: float = 0.0
    estimated_time_remaining: timedelta | None = None
    average_speed: float | None = None

    def __post_init__(self):
        """Validate progress metrics."""
        if self.current_value < 0:
            msg = "Current value cannot be negative"
            raise ValueError(msg)
        if self.total_value <= 0:
            msg = "Total value must be positive"
            raise ValueError(msg)
        if not 0.0 <= self.percentage <= 100.0:
            msg = "Percentage must be between 0.0 and 100.0"
            raise ValueError(msg)
        if self.average_speed is not None and self.average_speed < 0:
            msg = "Average speed cannot be negative"
            raise ValueError(msg)

    def calculate_percentage(self,
    ) -> float:
        """Calculate percentage from current and total values."""
        if self.total_value == 0:
            return 0.0
        return min(100.0, (self.current_value / self.total_value) * 100.0)

    def update_percentage(self) -> None:
        """Update percentage based on current and total values."""
        self.percentage = self.calculate_percentage()


@dataclass
class ProgressConfiguration:
    """Progress session configuration."""
    session_id: str
    progress_type: ProgressType
    description: str
    auto_complete: bool = True
    timeout_seconds: int | None = None
    debounce_interval_ms: int = 200
    enable_speed_calculation: bool = True
    enable_eta_calculation: bool = True

    def __post_init__(self):
        """Validate progress configuration."""
        if not self.session_id:
            msg = "Session ID cannot be empty"
            raise ValueError(msg)
        if not self.description:
            msg = "Description cannot be empty"
            raise ValueError(msg)
        if self.timeout_seconds is not None and self.timeout_seconds <= 0:
            msg = "Timeout must be positive"
            raise ValueError(msg)
        if self.debounce_interval_ms < 0:
            msg = "Debounce interval cannot be negative"
            raise ValueError(msg)


class ProgressSession(AggregateRoot[str],
    ):
    """Progress session aggregate managing progress tracking and lifecycle."""

    def __init__(self, configuration: ProgressConfiguration,
    ):
        super().__init__(configuration.session_id)
        self._configuration = configuration
        self._state = ProgressSessionState.IDLE
        self._metrics = ProgressMetrics()
        self._start_time: float | None = None
        self._end_time: float | None = None
        self._last_update_time: float | None = None
        self._error_message: str | None = None
        self._custom_data: dict[str, Any] = {}
        self._is_debouncing = False
        self._update_count = 0
        self.validate()

    def start(self, total_value: float = 100.0, description: str | None = None) -> bool:
        """Start the progress session."""
        if self._state not in [ProgressSessionState.IDLE, ProgressSessionState.CANCELLED]:
            return False

        self._state = ProgressSessionState.ACTIVE
        self._start_time = DomainIdentityGenerator.generate_timestamp()
        self._end_time = None
        self._last_update_time = self._start_time
        self._error_message = None
        self._update_count = 0

        # Update metrics
        self._metrics = ProgressMetrics(
            current_value=0.0,
            total_value=total_value,
            percentage=0.0,
        )

        # Update description if provided
        if description:
            self._configuration = ProgressConfiguration(
                session_id=self._configuration.session_id,
                progress_type=self._configuration.progress_type,
                description=description,
                auto_complete=self._configuration.auto_complete,
                timeout_seconds=self._configuration.timeout_seconds,
                debounce_interval_ms=self._configuration.debounce_interval_ms,
                enable_speed_calculation=self._configuration.enable_speed_calculation,
                enable_eta_calculation=self._configuration.enable_eta_calculation,
            )

        self.mark_as_updated()
        return True

    def update_progress(self, current_value: float, message: str | None = None) -> bool:
        """Update progress with current value."""
        if self._state != ProgressSessionState.ACTIVE:
            return False

        if current_value < 0 or current_value > self._metrics.total_value:
            return False

        now = DomainIdentityGenerator.generate_timestamp()

        # Apply debouncing if configured
        if self._is_debouncing:
            return False

        # Update metrics
        old_value = self._metrics.current_value
        self._metrics.current_value = current_value
        self._metrics.update_percentage()

        # Calculate speed and ETA if enabled
        if self._configuration.enable_speed_calculation and self._last_update_time:
            time_diff = float(now - self._last_update_time)
            if time_diff > 0:
                value_diff = current_value - old_value
                self._metrics.average_speed = value_diff / time_diff

        if (self._configuration.enable_eta_calculation and
            self._metrics.average_speed and
            self._metrics.average_speed > 0):
            remaining_value = self._metrics.total_value - current_value
            eta_seconds = remaining_value / self._metrics.average_speed
            self._metrics.estimated_time_remaining = timedelta(seconds=eta_seconds)

        self._last_update_time = now
        self._update_count += 1

        # Update custom message if provided
        if message:
            self._custom_data["current_message"] = message

        # Auto-complete if reached total value
        if (self._configuration.auto_complete and
            current_value >= self._metrics.total_value):
            self.complete()

        self.mark_as_updated()
        return True

    def update_percentage(self, percentage: float, message: str | None = None) -> bool:
        """Update progress with percentage value."""
        if not 0.0 <= percentage <= 100.0:
            return False

        current_value = (percentage / 100.0) * self._metrics.total_value
        return self.update_progress(current_value, message)

    def pause(self) -> bool:
        """Pause the progress session."""
        if self._state != ProgressSessionState.ACTIVE:
            return False

        self._state = ProgressSessionState.PAUSED
        self.mark_as_updated()
        return True

    def resume(self) -> bool:
        """Resume the progress session."""
        if self._state != ProgressSessionState.PAUSED:
            return False

        self._state = ProgressSessionState.ACTIVE
        self._last_update_time = DomainIdentityGenerator.generate_timestamp()
        self.mark_as_updated()
        return True

    def complete(self, message: str | None = None) -> bool:
        """Complete the progress session."""
        if self._state not in [ProgressSessionState.ACTIVE, ProgressSessionState.PAUSED]:
            return False

        self._state = ProgressSessionState.COMPLETED
        self._end_time = DomainIdentityGenerator.generate_timestamp()
        self._metrics.current_value = self._metrics.total_value
        self._metrics.percentage = 100.0

        if message:
            self._custom_data["completion_message"] = message

        self.mark_as_updated()
        return True

    def cancel(self, reason: str | None = None) -> bool:
        """Cancel the progress session."""
        if self._state in [ProgressSessionState.COMPLETED, ProgressSessionState.CANCELLED]:
            return False

        self._state = ProgressSessionState.CANCELLED
        self._end_time = DomainIdentityGenerator.generate_timestamp()

        if reason:
            self._custom_data["cancellation_reason"] = reason

        self.mark_as_updated()
        return True

    def error(self, error_message: str,
    ) -> bool:
        """Mark the progress session as error."""
        if self._state in [ProgressSessionState.COMPLETED, ProgressSessionState.CANCELLED]:
            return False

        self._state = ProgressSessionState.ERROR
        self._end_time = DomainIdentityGenerator.generate_timestamp()
        self._error_message = error_message

        self.mark_as_updated()
        return True

    def reset(self) -> bool:
        """Reset the progress session to idle state."""
        self._state = ProgressSessionState.IDLE
        self._metrics = ProgressMetrics(total_value=self._metrics.total_value)
        self._start_time = None
        self._end_time = None
        self._last_update_time = None
        self._error_message = None
        self._update_count = 0
        self._custom_data.clear()

        self.mark_as_updated()
        return True

    def set_custom_data(self, key: str, value: Any,
    ) -> None:
        """Set custom data for the session."""
        self._custom_data[key] = value
        self.mark_as_updated()

    def get_custom_data(self, key: str, default: Any = None,
    ) -> Any:
        """Get custom data from the session."""
        return self._custom_data.get(key, default)

    def get_duration(self) -> timedelta | None:
        """Get session duration."""
        if not self._start_time:
            return None

        end_val = self._end_time or DomainIdentityGenerator.generate_timestamp()
        return timedelta(seconds=float(end_val - (self._start_time or end_val)))

    def get_average_update_rate(self) -> float | None:
        """Get average update rate (updates per second)."""
        duration = self.get_duration()
        if not duration or duration.total_seconds() == 0 or self._update_count == 0:
            return None

        return self._update_count / duration.total_seconds()

    def is_timeout_exceeded(self) -> bool:
        """Check if session has exceeded timeout."""
        if not self._configuration.timeout_seconds or not self._start_time:
            return False

        duration = self.get_duration()
        if not duration:
            return False

        return duration.total_seconds() > self._configuration.timeout_seconds

    def should_auto_complete(self) -> bool:
        """Check if session should auto-complete."""
        return (
            self._configuration.auto_complete and
            self._state == ProgressSessionState.ACTIVE and
            self._metrics.percentage >= 100.0
        )

    # Properties
    @property
    def configuration(self) -> ProgressConfiguration:
        """Get session configuration."""
        return self._configuration

    @property
    def state(self) -> ProgressSessionState:
        """Get current session state."""
        return self._state

    @property
    def metrics(self) -> ProgressMetrics:
        """Get current progress metrics."""
        return self._metrics

    @property
    def start_time(self) -> float | None:
        """Get session start time."""
        return self._start_time

    @property
    def end_time(self) -> float | None:
        """Get session end time."""
        return self._end_time

    @property
    def last_update_time(self) -> float | None:
        """Get last update time."""
        return self._last_update_time

    @property
    def error_message(self) -> str | None:
        """Get error message if in error state."""
        return self._error_message

    @property
    def is_active(self) -> bool:
        """Check if session is active."""
        return self._state == ProgressSessionState.ACTIVE

    @property
    def is_completed(self) -> bool:
        """Check if session is completed."""
        return self._state == ProgressSessionState.COMPLETED

    @property
    def is_cancelled(self) -> bool:
        """Check if session is cancelled."""
        return self._state == ProgressSessionState.CANCELLED

    @property
    def is_in_error(self) -> bool:
        """Check if session is in error state."""
        return self._state == ProgressSessionState.ERROR

    @property
    def is_finished(self) -> bool:
        """Check if session is finished (completed, cancelled, or error)."""
        return self._state in [ProgressSessionState.COMPLETED,
        ProgressSessionState.CANCELLED, ProgressSessionState.ERROR]

    @property
    def update_count(self) -> int:
        """Get number of updates performed."""
        return self._update_count

    def __invariants__(self) -> None:
        """Validate progress session invariants."""
        if self._state == ProgressSessionState.ACTIVE and not self._start_time:
            msg = "Active session must have start time"
            raise ValueError(msg,
    )

        if self._state in [ProgressSessionState.COMPLETED,
        ProgressSessionState.CANCELLED, ProgressSessionState.ERROR] and not self._end_time:
            msg = "Finished session must have end time"
            raise ValueError(msg)

        if self._start_time and self._end_time and self._end_time < self._start_time:
            msg = "End time cannot be before start time"
            raise ValueError(msg)

        if self._state == ProgressSessionState.ERROR and not self._error_message:
            msg = "Error state must have error message"
            raise ValueError(msg,
    )