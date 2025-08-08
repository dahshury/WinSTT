"""
Download Progress Entity

Tracks download progress with size information and transfer rates.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from src_refactored.domain.common.value_object import ProgressPercentage, ValueObject

from .processing_status import ProcessingStatus


@dataclass(frozen=True)
class FileSize(ValueObject):
    """Value object for file sizes in bytes."""
    bytes: int

    def __post_init__(self):
        if self.bytes < 0:
            msg = f"File size cannot be negative, got {self.bytes}"
            raise ValueError(msg)

    @property
    def kb(self) -> float:
        """Size in kilobytes."""
        return self.bytes / 1024.0

    @property
    def mb(self) -> float:
        """Size in megabytes."""
        return self.bytes / (1024.0 * 1024.0)

    @property
    def gb(self) -> float:
        """Size in gigabytes."""
        return self.bytes / (1024.0 * 1024.0 * 1024.0)

    def format_human_readable(self) -> str:
        """Format as human-readable string."""
        if self.bytes < 1024:
            return f"{self.bytes} B"
        if self.bytes < 1024 * 1024:
            return f"{self.kb:.1f} KB"
        if self.bytes < 1024 * 1024 * 1024:
            return f"{self.mb:.1f} MB"
        return f"{self.gb:.1f} GB"


@dataclass(frozen=True)
class TransferRate(ValueObject):
    """Value object for transfer rates in bytes per second."""
    bytes_per_second: float

    def __post_init__(self):
        if self.bytes_per_second < 0:
            msg = f"Transfer rate cannot be negative, got {self.bytes_per_second}"
            raise ValueError(msg)

    def format_human_readable(self) -> str:
        """Format as human-readable string."""
        if self.bytes_per_second < 1024:
            return f"{self.bytes_per_second:.1f} B/s"
        if self.bytes_per_second < 1024 * 1024:
            return f"{self.bytes_per_second / 1024:.1f} KB/s"
        return f"{self.bytes_per_second / (1024 * 1024):.1f} MB/s"


@dataclass
class DownloadProgress:
    """Entity representing download progress with size and rate tracking."""
    url: str
    filename: str
    total_size: FileSize | None = None
    downloaded_size: FileSize = field(default_factory=lambda: FileSize(0))
    transfer_rate: TransferRate = field(default_factory=lambda: TransferRate(0.0))
    processing_status: ProcessingStatus = field(init=False)

    def __post_init__(self):
        self.processing_status = ProcessingStatus(
            operation_id=f"download_{hash(self.url)}",
        )

    def update_download_progress(
    self,
    downloaded_bytes: int,
    total_bytes: int | None = None) -> None:
        """Update download progress."""
        self.downloaded_size = FileSize(downloaded_bytes)

        if total_bytes is not None:
            self.total_size = FileSize(total_bytes)

        # Calculate progress percentage
        if self.total_size:
            progress_ratio = downloaded_bytes / self.total_size.bytes
            progress = ProgressPercentage.from_ratio(min(progress_ratio, 1.0))

        message = (
            f"Downloading {self.filename}: {self.downloaded_size.format_human_readable() if self.downloaded_size else '0 B'} / {self.total_size.format_human_readable() if self.total_size else 'Unknown'}"
        )
        if self.transfer_rate.bytes_per_second > 0:
            message += f" ({self.transfer_rate.format_human_readable()})"
        else:
            progress = ProgressPercentage(0.0)
            message = f"Downloading {self.filename}: {self.downloaded_size.format_human_readable() if self.downloaded_size else '0 B'}"

        self.processing_status.update_progress(progress, message)

    def update_transfer_rate(self, bytes_per_second: float,
    ) -> None:
        """Update transfer rate."""
        self.transfer_rate = TransferRate(bytes_per_second)

    def complete_download(self) -> None:
        """Mark download as completed."""
        self.processing_status.complete(f"Download completed: {self.filename}")

    def fail_download(self, error: str,
    ) -> None:
        """Mark download as failed."""
        self.processing_status.fail(f"Download failed: {error}")

    @property
    def is_size_known(self) -> bool:
        """Check if total download size is known."""
        return self.total_size is not None

    @property
    def estimated_time_remaining(self) -> float | None:
        """Estimate remaining time in seconds."""
        if not self.is_size_known or self.transfer_rate.bytes_per_second <= 0:
            return None

        if not self.total_size:
            return None
        remaining_bytes = self.total_size.bytes - self.downloaded_size.bytes
        return remaining_bytes / self.transfer_rate.bytes_per_second