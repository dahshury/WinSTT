"""Media infrastructure services package.

This package contains infrastructure services for media file handling,
including file validation, video conversion, media scanning, and batch processing.
"""

from .batch_processor_service import BatchProcessorService, ProcessingItem, ProcessingStatus
from .file_validation_service import FileValidationService
from .folder_scanning_service import (
    FolderScanningError,
    FolderScanningManager,
    FolderScanningService,
)
from .media_conversion_service import (
    FFmpegConverter,
    MediaConversionError,
    MediaConversionManager,
    MediaConversionService,
)
from .media_scanner_service import MediaScannerService

# Progress tracking service temporarily disabled - module not found
# from .progress_tracking_service import (
#     ProgressInfo,
#     ProgressState,
#     ProgressTrackingError,
#     ProgressTrackingManager,
#     ProgressTrackingService,
# )
ProgressInfo = None
ProgressState = None
ProgressTrackingError = Exception
ProgressTrackingManager = None
ProgressTrackingService = None
from .video_conversion_service import VideoConversionService

__all__ = [
    "BatchProcessorService",
    "FFmpegConverter",
    "FileValidationService",
    "FolderScanningError",
    "FolderScanningManager",
    "FolderScanningService",
    "MediaConversionError",
    "MediaConversionManager",
    "MediaConversionService",
    "MediaScannerService",
    "ProcessingItem",
    "ProcessingStatus",
    # "ProgressInfo",
    # "ProgressState",
    # "ProgressTrackingError",
    # "ProgressTrackingManager",
    # "ProgressTrackingService",
    "VideoConversionService",
]