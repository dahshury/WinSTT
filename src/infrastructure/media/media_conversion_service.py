"""Media conversion service for handling video to audio conversion."""

import os
import subprocess
from abc import ABC, abstractmethod


class MediaConversionError(Exception):
    """Exception raised for media conversion errors."""


class MediaConverter(ABC):
    """Abstract base class for media converters."""

    @abstractmethod
    def convert_video_to_audio(self, video_path: str,
    ) -> tuple[str, bytes, str] | None:
        """Convert video to audio bytes.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            Tuple of (format, audio_bytes, base_name) or None if failed
        """


class FFmpegConverter(MediaConverter):
    """FFmpeg-based media converter."""

    def __init__(self, sample_rate: int = 16000, channels: int = 1,
    ):
        self.sample_rate = sample_rate
        self.channels = channels

    def convert_video_to_audio(self, video_path: str,
    ) -> tuple[str, bytes, str] | None:
        """Convert a video file to audio bytes in memory using ffmpeg.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            Tuple of (format, audio_bytes, base_name) or None if conversion failed
        """
        try:
            os.path.basename(video_path)

            # Use ffmpeg to extract audio and output to stdout as WAV format
            ffmpeg_cmd = [
                "ffmpeg", "-i", video_path,
                "-f", "wav",
                "-ar", str(self.sample_rate),
                "-ac", str(self.channels),
                "-loglevel", "error",
                "pipe:1",
            ]

            # Run ffmpeg process
            process = subprocess.Popen(
                ffmpeg_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=10**8,  # Use a large buffer size for the audio data
            )

            # Get output
            audio_bytes, stderr = process.communicate()

            # Check if conversion was successful
            if process.returncode == 0 and audio_bytes:
                return ("memory_audio", audio_bytes, os.path.splitext(video_path)[0])

            error = stderr.decode("utf-8", errors="replace") if stderr else "Unknown error"
            msg = f"FFmpeg conversion failed: {error}"
            raise MediaConversionError(msg)

        except subprocess.SubprocessError as e:
            msg = f"FFmpeg process error: {e}"
            raise MediaConversionError(msg)
        except Exception as e:
            msg = f"Error converting video: {e}"
            raise MediaConversionError(msg)


class MediaConversionService:
    """Service for handling media conversion operations."""

    def __init__(self, converter: MediaConverter | None = None):
        self._converter = converter or FFmpegConverter()

    def convert_video_to_audio(self, video_path: str,
    ) -> tuple[str, bytes, str] | None:
        """Convert video file to audio bytes.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            Tuple of (format, audio_bytes, base_name) or None if conversion failed
        """
        try:
            return self._converter.convert_video_to_audio(video_path)
        except MediaConversionError:
            return None

    def is_conversion_available(self) -> bool:
        """Check if conversion tools are available.
        
        Returns:
            True if conversion is available, False otherwise
        """
        try:
            result = subprocess.run(
                ["ffmpeg", "-version"],
                capture_output=True,
                timeout=5, check=False,
            )
            return result.returncode == 0
        except (subprocess.SubprocessError, FileNotFoundError, subprocess.TimeoutExpired):
            return False


class MediaConversionManager:
    """High-level manager for media conversion operations."""

    def __init__(self):
        self._service = MediaConversionService()

    def convert_video_to_audio(self, video_path: str,
    ) -> tuple[str, bytes, str] | None:
        """Convert video to audio with error handling.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            Tuple of (format, audio_bytes, base_name) or None if failed
        """
        if not os.path.exists(video_path):
            return None

        return self._service.convert_video_to_audio(video_path)

    def check_conversion_capability(self) -> bool:
        """Check if media conversion is available.
        
        Returns:
            True if conversion tools are available
        """
        return self._service.is_conversion_available()

    def get_supported_video_formats(self) -> list[str]:
        """Get list of supported video file extensions.
        
        Returns:
            List of supported video extensions
        """
        return [".mp4", ".avi", ".mov", ".mkv", ".wmv", ".flv", ".webm", ".m4v"]