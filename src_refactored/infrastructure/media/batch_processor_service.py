"""Batch processor service for managing file processing queues.

This module provides infrastructure services for managing batch processing
of media files with queue management and progress tracking capabilities.
"""

from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

from src_refactored.domain.media.value_objects.processing_operations import ProcessingStatus


class ProcessingItem:
    """Represents an item in the processing queue."""

    def __init__(self, file_path: str, item_type: str = "file", metadata: dict | None = None):
        """Initialize a processing item.
        
        Args:
            file_path: Path to the file to process
            item_type: Type of item ("file", "video", "memory_audio", etc.)
            metadata: Optional metadata associated with the item
        """
        self.file_path = file_path
        self.item_type = item_type
        self.metadata = metadata or {}
        self.attempts = 0
        self.max_attempts = 3
        self.last_error = None

    def __repr__(self) -> str:
        return f"ProcessingItem(file_path='{self.file_path}', type='{self.item_type}')"


class BatchProcessorService:
    """Service for managing batch processing of media files.
    
    This service provides infrastructure-only logic for queue management,
    without any UI or business logic dependencies.
    """

    def __init__(self, progress_callback: Callable[[str, float], None] | None = None):
        """Initialize the batch processor service.
        
        Args:
            progress_callback: Optional callback for progress updates (message, percentage)
        """
        self.progress_callback = progress_callback
        self.processing_queue = deque()
        self.completed_items = []
        self.failed_items = []
        self.current_item = None
        self.status = ProcessingStatus.IDLE
        self.total_items = 0
        self.processed_items = 0

    def add_files_to_queue(self, file_paths: list[str]) -> None:
        """Add multiple files to the processing queue.
        
        Args:
            file_paths: List of file paths to add to the queue
        """
        if not file_paths:
            if self.progress_callback:
                self.progress_callback("No files to add to queue", 0)
            return

        # Validate and categorize files
        for file_path in file_paths:
            if self._is_audio_file(file_path):
                # Audio files can be processed directly
                item = ProcessingItem(file_path, "audio")
                self.processing_queue.append(item)
            elif self._is_video_file(file_path):
                # Video files need conversion first
                item = ProcessingItem(file_path, "video")
                self.processing_queue.append(item)
            # Unsupported file type
            elif self.progress_callback:
                self.progress_callback(f"Skipping unsupported file: {Path(file_path).name}", 0)

        self.total_items = len(self.processing_queue)

        if self.progress_callback:
            self.progress_callback(f"Added {len(file_paths)} files to queue. Total: {self.total_items}", 0)

    def add_memory_audio_to_queue(self, audio_data: tuple[str, bytes, str]) -> None:
        """Add converted audio data to the processing queue.
        
        Args:
            audio_data: Tuple of (type_marker, audio_bytes, output_base_name)
        """
        item = ProcessingItem(
            file_path=audio_data[2],  # Use base name as identifier
            item_type="memory_audio",
            metadata={"audio_bytes": audio_data[1], "type_marker": audio_data[0]},
        )
        self.processing_queue.append(item)
        self.total_items += 1

        if self.progress_callback:
            self.progress_callback(f"Added converted audio to queue: {audio_data[2]}", 0)

    def get_next_item(self) -> ProcessingItem | None:
        """Get the next item from the processing queue.
        
        Returns:
            Next processing item or None if queue is empty
        """
        if not self.processing_queue:
            self.status = ProcessingStatus.COMPLETED
            if self.progress_callback:
                self.progress_callback("Processing queue is empty", 100)
            return None

        self.current_item = self.processing_queue.popleft()
        self.status = ProcessingStatus.PROCESSING
        self.processed_items += 1

        # Calculate progress
        progress = (self.processed_items / self.total_items) * 100 if self.total_items > 0 else 0

        if self.progress_callback:
            file_name = Path(self.current_item.file_path).name
            self.progress_callback(
                f"Processing {file_name} ({self.processed_items}/{self.total_items},
    )",
                progress,
            )

        return self.current_item

    def mark_item_completed(self, item: ProcessingItem, result: Any = None) -> None:
        """Mark an item as successfully completed.

        Args:
            item: The processing item that was completed
            result: Optional result data from processing
        """
        item.metadata["result"] = result
        item.metadata["completed"] = True
        self.completed_items.append(item)

        if self.progress_callback:
            file_name = Path(item.file_path,
    ).name
            self.progress_callback(f"Completed: {file_name}", 0)

    def mark_item_failed(self, item: ProcessingItem, error: str,
    ) -> bool:
        """Mark an item as failed and decide whether to retry.

        Args:
            item: The processing item that failed
            error: Error message describing the failure

        Returns:
            True if item should be retried, False if it should be marked as permanently failed
        """
        item.attempts += 1
        item.last_error = error

        if item.attempts < item.max_attempts:
            # Retry the item by putting it back in the queue
            self.processing_queue.appendleft(item)

            if self.progress_callback:
                file_name = Path(item.file_path).name
                self.progress_callback(
                    f"Retrying {file_name} (attempt {item.attempts + 1}/{item.max_attempts},
    )",
                    0,
                )
            return True
        # Mark as permanently failed
        item.metadata["failed"] = True
        item.metadata["error"] = error
        self.failed_items.append(item)

        if self.progress_callback:
            file_name = Path(item.file_path,
    ).name
            self.progress_callback(f"Failed permanently: {file_name} - {error}", 0)
        return False

    def get_queue_status(self) -> dict:
        """Get current status of the processing queue.

        Returns:
            Dictionary with queue status information
        """
        return {
            "status": self.status.value,
            "total_items": self.total_items,
            "processed_items": self.processed_items,
            "remaining_items": len(self.processing_queue)
            "completed_items": len(self.completed_items)
            "failed_items": len(self.failed_items)
            "current_item": self.current_item.file_path if self.current_item else None,
            "progress_percentage": (self.processed_items / self.total_items) * 100 if self.total_items > 0 else 0,
        }

    def pause_processing(self) -> None:
        """Pause the processing queue."""
        if self.status == ProcessingStatus.PROCESSING:
            self.status = ProcessingStatus.PAUSED
            if self.progress_callback:
                self.progress_callback("Processing paused", 0)

    def resume_processing(self) -> None:
        """Resume the processing queue."""
        if self.status == ProcessingStatus.PAUSED:
            self.status = ProcessingStatus.PROCESSING
            if self.progress_callback:
                self.progress_callback("Processing resumed", 0)

    def clear_queue(self) -> None:
        """Clear all items from the processing queue."""
        self.processing_queue.clear()
        self.current_item = None
        self.status = ProcessingStatus.IDLE

        if self.progress_callback:
            self.progress_callback("Processing queue cleared", 0)

    def reset_statistics(self) -> None:
        """Reset processing statistics."""
        self.completed_items.clear()
        self.failed_items.clear()
        self.total_items = len(self.processing_queue)
        self.processed_items = 0

        if self.progress_callback:
            self.progress_callback("Statistics reset", 0)

    def get_failed_items(self) -> list[ProcessingItem]:
        """Get list of items that failed processing.

        Returns:
            List of failed processing items
        """
        return self.failed_items.copy()

    def get_completed_items(self) -> list[ProcessingItem]:
        """Get list of items that completed processing.

        Returns:
            List of completed processing items
        """
        return self.completed_items.copy()

    def retry_failed_items(self) -> None:
        """Retry all failed items by adding them back to the queue."""
        for item in self.failed_items:
            # Reset attempt count and error
            item.attempts = 0
            item.last_error = None
            if "failed" in item.metadata:
                del item.metadata["failed"]
            if "error" in item.metadata:
                del item.metadata["error"]

            # Add back to queue
            self.processing_queue.append(item)

        # Update totals
        retry_count = len(self.failed_items)
        self.total_items += retry_count
        self.failed_items.clear()

        if self.progress_callback:
            self.progress_callback(f"Retrying {retry_count} failed items", 0)

    def _is_audio_file(self, file_path: str,
    ) -> bool:
        """Check if a file is an audio file.

        Args:
            file_path: Path to the file to check

        Returns:
            True if the file is an audio file, False otherwise
        """
        ext = Path(file_path).suffix.lower()
        return ext in {".mp3", ".wav"}

    def _is_video_file(self, file_path: str,
    ) -> bool:
        """Check if a file is a video file.

        Args:
            file_path: Path to the file to check

        Returns:
            True if the file is a video file, False otherwise
        """
        ext = Path(file_path).suffix.lower()
        return ext in {".mp4", ".avi", ".mkv", ".mov", ".flv", ".wmv"}