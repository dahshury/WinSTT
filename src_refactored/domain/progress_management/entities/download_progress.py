"""Download progress entity for progress management domain."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING

from src_refactored.domain.common import Entity
from src_refactored.domain.common.domain_utils import DomainIdentityGenerator

if TYPE_CHECKING:
    from collections.abc import Callable


class DownloadState(Enum):
    """Enumeration of download states."""
    IDLE = "idle"
    STARTING = "starting"
    DOWNLOADING = "downloading"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class DownloadMetrics:
    """Value object for download metrics."""
    percentage: float = 0.0
    bytes_downloaded: int = 0
    total_bytes: int | None = None
    download_speed: float = 0.0  # bytes per second
    estimated_time_remaining: float | None = None  # seconds

    def __post_init__(self,
    ) -> None:
        """Validate download metrics."""
        if not 0.0 <= self.percentage <= 100.0:
            msg = f"Percentage must be between 0 and 100, got: {self.percentage}"
            raise ValueError(msg)
        if self.bytes_downloaded < 0:
            msg = f"Bytes downloaded cannot be negative, got: {self.bytes_downloaded}"
            raise ValueError(msg)
        if self.total_bytes is not None and self.total_bytes < 0:
            msg = f"Total bytes cannot be negative, got: {self.total_bytes}"
            raise ValueError(msg)
        if self.download_speed < 0:
            msg = f"Download speed cannot be negative, got: {self.download_speed}"
            raise ValueError(msg)


@dataclass
class DownloadConfiguration:
    """Value object for download configuration."""
    filename: str
    target_path: str
    auto_retry: bool = True
    max_retries: int = 3
    timeout_seconds: int = 30
    chunk_size: int = 8192

    def __post_init__(self) -> None:
        """Validate download configuration."""
        if not self.filename or not self.filename.strip():
            msg = "Filename cannot be empty"
            raise ValueError(msg)
        if not self.target_path or not self.target_path.strip():
            msg = "Target path cannot be empty"
            raise ValueError(msg)
        if self.max_retries < 0:
            msg = f"Max retries cannot be negative, got: {self.max_retries}"
            raise ValueError(msg)
        if self.timeout_seconds <= 0:
            msg = f"Timeout must be positive, got: {self.timeout_seconds}"
            raise ValueError(msg)
        if self.chunk_size <= 0:
            msg = f"Chunk size must be positive, got: {self.chunk_size}"
            raise ValueError(msg)


class DownloadProgress(Entity):
    """Entity representing download progress tracking and coordination."""

    def __init__(
        self,
        download_id: str,
        configuration: DownloadConfiguration,
        progress_callback: Callable[[float], None] | None = None,
        completion_callback: Callable[[], None] | None = None,
        error_callback: Callable[[str], None] | None = None,
    ):
        """Initialize download progress entity."""
        super().__init__(download_id)
        self._download_id = download_id
        self._configuration = configuration
        self._state = DownloadState.IDLE
        self._metrics = DownloadMetrics()
        self._start_time: datetime | None = None
        self._end_time: datetime | None = None
        self._error_message: str | None = None
        self._retry_count = 0
        self._progress_callback = progress_callback
        self._completion_callback = completion_callback
        self._error_callback = error_callback

    @property
    def download_id(self) -> str:
        """Get download ID."""
        return self._download_id

    @property
    def configuration(self) -> DownloadConfiguration:
        """Get download configuration."""
        return self._configuration

    @property
    def state(self) -> DownloadState:
        """Get current download state."""
        return self._state

    @property
    def metrics(self) -> DownloadMetrics:
        """Get current download metrics."""
        return self._metrics

    @property
    def start_time(self) -> datetime | None:
        """Get download start time."""
        return self._start_time

    @property
    def end_time(self) -> datetime | None:
        """Get download end time."""
        return self._end_time

    @property
    def error_message(self) -> str | None:
        """Get error message if download failed."""
        return self._error_message

    @property
    def retry_count(self) -> int:
        """Get current retry count."""
        return self._retry_count

    @property
    def is_active(self) -> bool:
        """Check if download is currently active."""
        return self._state in {DownloadState.STARTING, DownloadState.DOWNLOADING}

    @property
    def is_completed(self) -> bool:
        """Check if download is completed."""
        return self._state == DownloadState.COMPLETED

    @property
    def is_failed(self) -> bool:
        """Check if download has failed."""
        return self._state == DownloadState.FAILED

    @property
    def can_retry(self) -> bool:
        """Check if download can be retried."""
        return (
            self._state == DownloadState.FAILED and
            self._configuration.auto_retry and
            self._retry_count < self._configuration.max_retries
        )

    def start_download(self) -> None:
        """Start the download process."""
        if self._state not in {DownloadState.IDLE, DownloadState.FAILED}:
            msg = f"Cannot start download in state: {self._state}"
            raise ValueError(msg)

        self._state = DownloadState.STARTING
        self._start_time = datetime.fromtimestamp(DomainIdentityGenerator.generate_timestamp())
        self._end_time = None
        self._error_message = None
        self._metrics = DownloadMetrics()

    def update_progress(
        self,
        percentage: float,
        bytes_downloaded: int = 0,
        total_bytes: int | None = None,
        download_speed: float = 0.0,
    ) -> None:
        """Update download progress."""
        if self._state not in {DownloadState.STARTING, DownloadState.DOWNLOADING}:
            msg = f"Cannot update progress in state: {self._state}"
            raise ValueError(msg)

        # Calculate estimated time remaining
        estimated_time_remaining = None
        if download_speed > 0 and total_bytes is not None:
            remaining_bytes = total_bytes - bytes_downloaded
            estimated_time_remaining = remaining_bytes / download_speed

        self._metrics = DownloadMetrics(
            percentage=percentage,
            bytes_downloaded=bytes_downloaded,
            total_bytes=total_bytes,
            download_speed=download_speed,
            estimated_time_remaining=estimated_time_remaining,
        )

        if self._state == DownloadState.STARTING:
            self._state = DownloadState.DOWNLOADING

        # Trigger progress callback
        if self._progress_callback:
            try:
                self._progress_callback(percentage)
            except Exception:
                # Don't let callback errors affect download progress
                pass

    def pause_download(self) -> None:
        """Pause the download."""
        if self._state != DownloadState.DOWNLOADING:
            msg = f"Cannot pause download in state: {self._state}"
            raise ValueError(msg)

        self._state = DownloadState.PAUSED

    def resume_download(self) -> None:
        """Resume the download."""
        if self._state != DownloadState.PAUSED:
            msg = f"Cannot resume download in state: {self._state}"
            raise ValueError(msg)

        self._state = DownloadState.DOWNLOADING

    def complete_download(self,
    ) -> None:
        """Mark download as completed."""
        if self._state not in {DownloadState.DOWNLOADING, DownloadState.STARTING}:
            msg = f"Cannot complete download in state: {self._state}"
            raise ValueError(msg)

        self._state = DownloadState.COMPLETED
        self._end_time = datetime.fromtimestamp(DomainIdentityGenerator.generate_timestamp())
        self._metrics = DownloadMetrics(
            percentage=100.0,
            bytes_downloaded=self._metrics.bytes_downloaded,
            total_bytes=self._metrics.total_bytes,
            download_speed=self._metrics.download_speed,
        )

        # Trigger completion callback
        if self._completion_callback:
            try:
                self._completion_callback()
            except Exception:
                # Don't let callback errors affect download completion
                pass

    def fail_download(self, error_message: str,
    ) -> None:
        """Mark download as failed."""
        if self._state in {DownloadState.COMPLETED, DownloadState.CANCELLED}:
            msg = f"Cannot fail download in state: {self._state}"
            raise ValueError(msg)

        self._state = DownloadState.FAILED
        self._end_time = datetime.fromtimestamp(DomainIdentityGenerator.generate_timestamp())
        self._error_message = error_message

        # Trigger error callback
        if self._error_callback:
            try:
                self._error_callback(error_message)
            except Exception:
                # Don't let callback errors affect error handling
                pass

    def cancel_download(self) -> None:
        """Cancel the download."""
        if self._state in {DownloadState.COMPLETED, DownloadState.FAILED}:
            msg = f"Cannot cancel download in state: {self._state}"
            raise ValueError(msg)

        self._state = DownloadState.CANCELLED
        self._end_time = datetime.fromtimestamp(DomainIdentityGenerator.generate_timestamp())

    def retry_download(self) -> None:
        """Retry the failed download."""
        if not self.can_retry:
            msg = "Download cannot be retried"
            raise ValueError(msg)

        self._retry_count += 1
        self._state = DownloadState.IDLE
        self._error_message = None
        self._metrics = DownloadMetrics()

    def reset(self) -> None:
        """Reset download to initial state."""
        self._state = DownloadState.IDLE
        self._metrics = DownloadMetrics()
        self._start_time = None
        self._end_time = None
        self._error_message = None
        self._retry_count = 0

    def get_duration(self) -> float | None:
        """Get download duration in seconds."""
        if self._start_time is None:
            return None

        end_time = self._end_time or datetime.fromtimestamp(DomainIdentityGenerator.generate_timestamp())
        return (end_time - self._start_time).total_seconds()

    def get_average_speed(self) -> float | None:
        """Get average download speed in bytes per second."""
        duration = self.get_duration()
        if duration is None or duration <= 0:
            return None

        return self._metrics.bytes_downloaded / duration