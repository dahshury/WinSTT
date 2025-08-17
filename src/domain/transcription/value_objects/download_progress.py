"""Download Progress Value Object.

Defines progress information for downloads.
Extracted from infrastructure/transcription/model_download_service.py
"""

from dataclasses import dataclass

from src.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class DownloadProgress(ValueObject):
    """Progress information for downloads.
    
    Encapsulates download progress state and metrics.
    """
    filename: str
    percentage: int
    downloaded_bytes: int
    total_bytes: int
    is_complete: bool = False
    error_message: str | None = None

    def __post_init__(self) -> None:
        """Validate download progress data."""
        if not self.filename:
            msg = "Filename is required"
            raise ValueError(msg)

        if not 0 <= self.percentage <= 100:
            msg = "Percentage must be between 0 and 100"
            raise ValueError(msg)

        if self.downloaded_bytes < 0:
            msg = "Downloaded bytes cannot be negative"
            raise ValueError(msg)

        if self.total_bytes < 0:
            msg = "Total bytes cannot be negative"
            raise ValueError(msg)

        if self.downloaded_bytes > self.total_bytes:
            msg = "Downloaded bytes cannot exceed total bytes"
            raise ValueError(msg)

    @property
    def has_error(self) -> bool:
        """Check if download has an error."""
        return self.error_message is not None

    @property
    def is_in_progress(self) -> bool:
        """Check if download is in progress."""
        return not self.is_complete and not self.has_error

    @property
    def remaining_bytes(self,
    ) -> int:
        """Get remaining bytes to download."""
        return max(0, self.total_bytes - self.downloaded_bytes)

    @property
    def download_rate_mbps(self) -> float:
        """Calculate download rate in MB/s (requires timing info)."""
        # This would need timing information to calculate actual rate
        # For now, return 0 as placeholder
        return 0.0

    @classmethod
    def create_starting(cls, filename: str, total_bytes: int,
    ) -> "DownloadProgress":
        """Create initial download progress."""
        return cls(
            filename=filename,
            percentage=0,
            downloaded_bytes=0,
            total_bytes=total_bytes,
            is_complete=False,
        )

    @classmethod
    def create_completed(cls, filename: str, total_bytes: int,
    ) -> "DownloadProgress":
        """Create completed download progress."""
        return cls(
            filename=filename,
            percentage=100,
            downloaded_bytes=total_bytes,
            total_bytes=total_bytes,
            is_complete=True,
        )

    @classmethod
    def create_failed(cls, filename: str, error_message: str,
    ) -> "DownloadProgress":
        """Create failed download progress."""
        return cls(
            filename=filename,
            percentage=0,
            downloaded_bytes=0,
            total_bytes=0,
            is_complete=False,
            error_message=error_message,
        )