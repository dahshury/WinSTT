"""Convert Video Use Case.

This module implements the ConvertVideoUseCase for handling video conversion
workflows with progress tracking and error handling.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Protocol

from src.domain.media.value_objects.conversion_operations import (
    AudioFormat,
    ConversionPhase,
    ConversionResult,
    ConversionStrategy,
)

if TYPE_CHECKING:
    from collections.abc import Callable


@dataclass
class VideoInfo:
    """Information about a video file."""
    file_path: str
    file_size: int | None = None
    duration: float | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    resolution: tuple[int, int] | None = None
    frame_rate: float | None = None
    bitrate: int | None = None
    has_audio: bool = True
    is_valid: bool = True
    error_message: str | None = None


@dataclass
class ConversionConfiguration:
    """Configuration for video conversion."""
    output_format: AudioFormat = AudioFormat.WAV
    sample_rate: int = 16000
    channels: int = 1
    bitrate: int | None = None
    quality: str | None = None
    strategy: ConversionStrategy = ConversionStrategy.BALANCED
    buffer_size: int = 10**8
    timeout_seconds: float | None = None
    preserve_metadata: bool = False
    normalize_audio: bool = False
    remove_silence: bool = False
    progress_callback_interval: float = 0.1


@dataclass
class ConvertVideoRequest:
    """Request for converting video to audio."""
    video_path: str
    configuration: ConversionConfiguration
    output_path: str | None = None
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[ConversionResult], None] | None = None
    error_callback: Callable[[str], None] | None = None


@dataclass
class AudioData:
    """Converted audio data."""
    data_type: str
    audio_bytes: bytes
    output_base_path: str
    format: AudioFormat
    sample_rate: int
    channels: int
    duration: float | None = None
    size_bytes: int | None = None


@dataclass
class ConvertVideoResponse:
    """Response from video conversion."""
    result: ConversionResult
    audio_data: AudioData | None
    input_file_size: int | None
    output_size: int | None
    conversion_time: float
    compression_ratio: float | None = None
    error_message: str | None = None
    warnings: list[str] = field(default_factory=list)

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class VideoValidationServiceProtocol(Protocol):
    """Protocol for video validation service."""

    def validate_video(self, video_path: str,
    ) -> tuple[bool, str | None]:
        """Validate a video file.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            Tuple of (is_valid, error_message)
        """
        ...

    def get_video_info(self, video_path: str,
    ) -> VideoInfo:
        """Get detailed information about a video file.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            VideoInfo with file details
        """
        ...

    def has_audio_track(self, video_path: str,
    ) -> bool:
        """Check if video has an audio track.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            True if video has audio
        """
        ...


class FFmpegServiceProtocol(Protocol):
    """Protocol for FFmpeg service."""

    def extract_audio(
        self,
        video_path: str,
        output_format: AudioFormat,
        sample_rate: int,
        channels: int,
        buffer_size: int = 10**8,
    ) -> tuple[bytes, str | None]:
        """Extract audio from video using FFmpeg.
        
        Args:
            video_path: Path to the video file
            output_format: Desired audio format
            sample_rate: Audio sample rate
            channels: Number of audio channels
            buffer_size: Buffer size for processing
            
        Returns:
            Tuple of (audio_bytes, error_message)
        """
        ...

    def is_available(self) -> bool:
        """Check if FFmpeg is available.
        
        Returns:
            True if FFmpeg is available
        """
        ...

    def get_version(self) -> str | None:
        """Get FFmpeg version.
        
        Returns:
            FFmpeg version string or None
        """
        ...


class AudioProcessingServiceProtocol(Protocol):
    """Protocol for audio processing service."""

    def normalize_audio(self, audio_bytes: bytes,
    ) -> bytes:
        """Normalize audio levels.
        
        Args:
            audio_bytes: Raw audio data
            
        Returns:
            Normalized audio data
        """
        ...

    def remove_silence(self, audio_bytes: bytes,
    ) -> bytes:
        """Remove silence from audio.
        
        Args:
            audio_bytes: Raw audio data
            
        Returns:
            Audio data with silence removed
        """
        ...

    def get_audio_duration(self, audio_bytes: bytes, sample_rate: int,
    ) -> float:
        """Get audio duration in seconds.
        
        Args:
            audio_bytes: Raw audio data
            sample_rate: Audio sample rate
            
        Returns:
            Duration in seconds
        """
        ...


class ProgressTrackingServiceProtocol(Protocol):
    """Protocol for progress tracking service."""

    def initialize_progress(self, total_steps: int,
    ) -> None:
        """Initialize progress tracking.
        
        Args:
            total_steps: Total number of steps
        """
        ...

    def update_progress(self, current_step: int, message: str,
    ) -> None:
        """Update progress.
        
        Args:
            current_step: Current step number
            message: Progress message
        """
        ...

    def get_progress_percentage(self, current_step: int, total_steps: int,
    ) -> float:
        """Get progress percentage.
        
        Args:
            current_step: Current step number
            total_steps: Total number of steps
            
        Returns:
            Progress percentage (0-100)
        """
        ...


class LoggerServiceProtocol(Protocol):
    """Protocol for logger service."""

    def log_info(self, message: str, **kwargs) -> None:
        """Log an info message."""
        ...

    def log_warning(self, message: str, **kwargs) -> None:
        """Log a warning message."""
        ...

    def log_error(self, message: str, **kwargs) -> None:
        """Log an error message."""
        ...

    def log_debug(self, message: str, **kwargs) -> None:
        """Log a debug message."""
        ...


class ConvertVideoUseCase:
    """Use case for converting video to audio with progress tracking."""

    def __init__(
        self,
        video_validation_service: VideoValidationServiceProtocol,
        ffmpeg_service: FFmpegServiceProtocol,
        audio_processing_service: AudioProcessingServiceProtocol,
        progress_tracking_service: ProgressTrackingServiceProtocol,
        logger_service: LoggerServiceProtocol,
    ):
        """Initialize the use case.
        
        Args:
            video_validation_service: Service for video validation
            ffmpeg_service: Service for FFmpeg operations
            audio_processing_service: Service for audio processing
            progress_tracking_service: Service for progress tracking
            logger_service: Service for logging
        """
        self._video_validation_service = video_validation_service
        self._ffmpeg_service = ffmpeg_service
        self._audio_processing_service = audio_processing_service
        self._progress_tracking_service = progress_tracking_service
        self._logger_service = logger_service

    def execute(self, request: ConvertVideoRequest,
    ) -> ConvertVideoResponse:
        """Execute the video conversion use case.
        
        Args:
            request: The conversion request
            
        Returns:
            ConvertVideoResponse with conversion results
        """
        import time
        start_time = time.time()

        try:
            # Phase 1: Initialize conversion
            self._logger_service.log_info(
                "Starting video conversion",
                phase=ConversionPhase.INITIALIZING.value,
                video_path=request.video_path,
            )

            # Initialize progress tracking
            total_steps = 6  # validation, preparation, extraction, processing, finalization, completion
            self._progress_tracking_service.initialize_progress(total_steps)

            if request.progress_callback:
                request.progress_callback("Initializing conversion...", 0.0)

            # Phase 2: Validate input
            self._logger_service.log_info(
                "Validating video file",
                phase=ConversionPhase.VALIDATING_INPUT.value,
            )

            # Delegate existence check to validation service to avoid direct FS dependency
            is_valid, validation_error = self._video_validation_service.validate_video(request.video_path)
            if not is_valid and (validation_error or "not found" in (validation_error or "").lower()):
                error_message = f"Video file not found: {request.video_path}"
                return self._create_error_response(
                    ConversionResult.INVALID_INPUT,
                    error_message,
                    start_time,
                    request,
                )
            # Validate video file (already checked existence, proceed with full validation)
            if not is_valid:
                return self._create_error_response(
                    ConversionResult.INVALID_INPUT,
                    validation_error or "Invalid video file",
                    start_time,
                    request,
                )

            # Get video information
            video_info = self._video_validation_service.get_video_info(request.video_path)
            if not video_info.has_audio:
                error_message = "Video file has no audio track"
                return self._create_error_response(
                    ConversionResult.UNSUPPORTED_FORMAT,
                    error_message,
                    start_time,
                    request,
                )

            # Update progress
            self._progress_tracking_service.update_progress(1, "Video validation complete")
            if request.progress_callback:
                progress = self._progress_tracking_service.get_progress_percentage(1, total_steps)
                request.progress_callback("Video validation complete", progress)

            # Phase 3: Prepare conversion
            self._logger_service.log_info(
                "Preparing conversion",
                phase=ConversionPhase.PREPARING_CONVERSION.value,
            )

            # Check FFmpeg availability
            if not self._ffmpeg_service.is_available():
                error_message = "FFmpeg is not available"
                return self._create_error_response(
                    ConversionResult.FAILURE,
                    error_message,
                    start_time,
                    request,
                )

            # Prepare output path
            if request.output_path:
                dot_index = request.output_path.rfind(".")
                output_base_path = request.output_path[:dot_index] if dot_index != -1 else request.output_path
            else:
                dot_index = request.video_path.rfind(".")
                output_base_path = request.video_path[:dot_index] if dot_index != -1 else request.video_path

            # Update progress
            self._progress_tracking_service.update_progress(2, "Conversion preparation complete")
            if request.progress_callback:
                progress = self._progress_tracking_service.get_progress_percentage(2, total_steps)
                request.progress_callback("Conversion preparation complete", progress)

            # Phase 4: Extract audio
            self._logger_service.log_info(
                "Extracting audio from video",
                phase=ConversionPhase.EXTRACTING_AUDIO.value,
            )

            base_name = request.video_path.replace("\\", "/").split("/")[-1]
            if request.progress_callback:
                request.progress_callback(f"Converting {base_name} to audio...", 40.0)

            # Extract audio using FFmpeg
            audio_bytes, ffmpeg_error = self._ffmpeg_service.extract_audio(
                request.video_path,
                request.configuration.output_format,
                request.configuration.sample_rate,
                request.configuration.channels,
                request.configuration.buffer_size,
            )

            if not audio_bytes:
                error_message = f"Audio extraction failed: {ffmpeg_error or 'Unknown error'}"
                return self._create_error_response(
                    ConversionResult.FAILURE,
                    error_message,
                    start_time,
                    request,
                )

            # Update progress
            self._progress_tracking_service.update_progress(3, "Audio extraction complete")
            if request.progress_callback:
                progress = self._progress_tracking_service.get_progress_percentage(3, total_steps)
                request.progress_callback("Audio extraction complete", progress)

            # Phase 5: Process audio (optional)
            self._logger_service.log_info(
                "Processing audio",
                phase=ConversionPhase.PROCESSING_AUDIO.value,
            )

            processed_audio = audio_bytes

            # Apply audio processing if requested
            if request.configuration.normalize_audio:
                processed_audio = self._audio_processing_service.normalize_audio(processed_audio)
                self._logger_service.log_info("Audio normalization applied")

            if request.configuration.remove_silence:
                processed_audio = self._audio_processing_service.remove_silence(processed_audio)
                self._logger_service.log_info("Silence removal applied")

            # Update progress
            self._progress_tracking_service.update_progress(4, "Audio processing complete")
            if request.progress_callback:
                progress = self._progress_tracking_service.get_progress_percentage(4, total_steps)
                request.progress_callback("Audio processing complete", progress)

            # Phase 6: Finalize conversion
            self._logger_service.log_info(
                "Finalizing conversion",
                phase=ConversionPhase.FINALIZING.value,
            )

            # Get audio duration
            duration = None
            try:
                duration = self._audio_processing_service.get_audio_duration(
                    processed_audio,
                    request.configuration.sample_rate,
                )
            except Exception as e:
                self._logger_service.log_warning(
                    "Failed to calculate audio duration",
                    error=str(e),
                )

            # Create audio data object
            audio_data = AudioData(
                data_type="memory_audio",
                audio_bytes=processed_audio,
                output_base_path=output_base_path,
                format=request.configuration.output_format,
                sample_rate=request.configuration.sample_rate,
                channels=request.configuration.channels,
                duration=duration,
                size_bytes=len(processed_audio),
            )

            # Update progress
            self._progress_tracking_service.update_progress(5, "Conversion finalization complete")
            if request.progress_callback:
                progress = self._progress_tracking_service.get_progress_percentage(5, total_steps)
                request.progress_callback("Conversion finalization complete", progress)

            # Phase 7: Complete conversion
            conversion_time = time.time() - start_time

            # Calculate compression ratio
            compression_ratio = None
            if video_info.file_size and audio_data.size_bytes:
                compression_ratio = video_info.file_size / audio_data.size_bytes

            # Final progress update
            if request.progress_callback:
                request.progress_callback(f"Conversion successful: {base_name}", 100.0)

            if request.completion_callback:
                request.completion_callback(ConversionResult.SUCCESS)

            self._logger_service.log_info(
                "Video conversion completed successfully",
                phase=ConversionPhase.COMPLETING.value,
                conversion_time=conversion_time,
                output_size=audio_data.size_bytes,
                compression_ratio=compression_ratio,
            )

            return ConvertVideoResponse(
                result=ConversionResult.SUCCESS,
                audio_data=audio_data,
                input_file_size=video_info.file_size,
                output_size=audio_data.size_bytes,
                conversion_time=conversion_time,
                compression_ratio=compression_ratio,
            )

        except Exception as e:
            error_message = f"Error in video conversion: {e!s}"
            return self._create_error_response(
                ConversionResult.FAILURE,
                error_message,
                start_time,
                request,
            )

    def _create_error_response(
        self,
        result: ConversionResult,
        error_message: str,
        start_time: float,
        request: ConvertVideoRequest,
    ) -> ConvertVideoResponse:
        """Create an error response.
        
        Args:
            result: The conversion result
            error_message: Error message
            start_time: Start time for calculating duration
            request: Original request
            
        Returns:
            ConvertVideoResponse with error information
        """
        import time

        self._logger_service.log_error(
            "Video conversion failed",
            phase=ConversionPhase.ERROR_HANDLING.value,
            error=error_message,
        )

        if request.error_callback:
            request.error_callback(error_message)

        return ConvertVideoResponse(
            result=result,
            audio_data=None,
            input_file_size=None,
            output_size=None,
            conversion_time=time.time() - start_time,
            error_message=error_message,
        )