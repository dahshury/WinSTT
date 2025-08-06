"""Video conversion service using FFmpeg.

This module provides infrastructure services for converting video files
to audio format using FFmpeg with progress tracking capabilities.
"""

import subprocess
from collections.abc import Callable
from pathlib import Path


class VideoConversionError(Exception):
    """Exception raised when video conversion fails."""


class VideoConversionService:
    """Service for converting video files to audio format using FFmpeg.
    
    This service provides infrastructure-only logic for video conversion,
    without any UI or business logic dependencies.
    """

    def __init__(self, progress_callback: Callable[[str, float], None] | None = None):
        """Initialize the video conversion service.
        
        Args:
            progress_callback: Optional callback for progress updates (message, percentage)
        """
        self.progress_callback = progress_callback

    def convert_video_to_audio_bytes(self, video_path: str,
    ) -> tuple[str, bytes, str] | None:
        """Convert a video file to audio bytes in memory using FFmpeg.
        
        Args:
            video_path: Path to the video file to convert
            
        Returns:
            Tuple of (type_marker, audio_bytes, output_base_name) or None if conversion fails
            
        Raises:
            VideoConversionError: If conversion fails
        """
        try:
            base_name = Path(video_path,
    ).name
            if self.progress_callback:
                self.progress_callback(f"Converting {base_name} to audio...", 0)

            # Validate input file
            if not Path(video_path).exists():
                msg = f"Video file not found: {video_path}"
                raise VideoConversionError(msg)

            # Use FFmpeg to extract audio and output to stdout as WAV format
            # -f wav specifies WAV format for stdout
            # -loglevel error reduces output noise
            # -ar 16000 sets sample rate to 16kHz
            # -ac 1 sets to mono channel
            ffmpeg_cmd = [
                "ffmpeg",
                "-i", video_path,
                "-f", "wav",
                "-ar", "16000",
                "-ac", "1",
                "-loglevel", "error",
                "pipe:1",
            ]

            if self.progress_callback:
                self.progress_callback(f"Running FFmpeg conversion for {base_name}", 25)

            # Run FFmpeg process
            process = subprocess.Popen(
                ffmpeg_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=10**8,  # Use a large buffer size for the audio data
            )

            if self.progress_callback:
                self.progress_callback(f"Processing audio data for {base_name}", 50)

            # Get output
            audio_bytes, stderr = process.communicate()

            if self.progress_callback:
                self.progress_callback(f"Finalizing conversion for {base_name}", 75)

            # Check if conversion was successful
            if process.returncode == 0 and audio_bytes:
                if self.progress_callback:
                    self.progress_callback(f"Conversion successful: {base_name}", 100)

                # Return a tuple with the type marker, audio bytes, and base name
                output_base_name = Path(video_path).stem
                return ("memory_audio", audio_bytes, output_base_name)

            # Handle conversion failure
            error_msg = stderr.decode("utf-8", errors="replace") if stderr else "Unknown error"
            msg = f"FFmpeg conversion failed: {error_msg}"
            raise VideoConversionError(msg)

        except subprocess.SubprocessError as e:
            error_msg = f"Subprocess error during conversion: {e}"
            if self.progress_callback:
                self.progress_callback(error_msg, 0)
            raise VideoConversionError(error_msg) from e
        except Exception as e:
            error_msg = f"Error converting video: {e}"
            if self.progress_callback:
                self.progress_callback(error_msg, 0)
            raise VideoConversionError(error_msg) from e

    def convert_video_to_file(self, video_path: str, output_path: str,
                             sample_rate: int = 16000, channels: int = 1) -> bool:
        """Convert a video file to an audio file on disk.
        
        Args:
            video_path: Path to the video file to convert
            output_path: Path where the audio file should be saved
            sample_rate: Audio sample rate (default: 16000)
            channels: Number of audio channels (default: 1 for mono,
    )
            
        Returns:
            True if conversion was successful, False otherwise
            
        Raises:
            VideoConversionError: If conversion fails
        """
        try:
            base_name = Path(video_path,
    ).name
            if self.progress_callback:
                self.progress_callback(f"Converting {base_name} to file...", 0)

            # Validate input file
            if not Path(video_path).exists():
                msg = f"Video file not found: {video_path}"
                raise VideoConversionError(msg)

            # Ensure output directory exists
            Path(output_path).parent.mkdir(parents=True, exist_ok=True)

            # Build FFmpeg command
            ffmpeg_cmd = [
                "ffmpeg",
                "-i", video_path,
                "-ar", str(sample_rate),
                "-ac", str(channels),
                "-loglevel", "error",
                "-y",  # Overwrite output file
                output_path,
            ]

            if self.progress_callback:
                self.progress_callback(f"Running FFmpeg conversion to {Path(output_path).name}", 25)

            # Run FFmpeg process
            process = subprocess.run(
                ffmpeg_cmd,
                capture_output=True,
                text=True,
                check=False,
            )

            if self.progress_callback:
                self.progress_callback("Checking conversion results", 75)

            # Check if conversion was successful
            if process.returncode == 0 and Path(output_path).exists():
                if self.progress_callback:
                    self.progress_callback(f"File conversion successful: {Path(output_path).name}", 100)
                return True

            # Handle conversion failure
            error_msg = process.stderr if process.stderr else "Unknown error"
            msg = f"FFmpeg file conversion failed: {error_msg}"
            raise VideoConversionError(msg)

        except subprocess.SubprocessError as e:
            error_msg = f"Subprocess error during file conversion: {e}"
            if self.progress_callback:
                self.progress_callback(error_msg, 0)
            raise VideoConversionError(error_msg) from e
        except Exception as e:
            error_msg = f"Error converting video to file: {e}"
            if self.progress_callback:
                self.progress_callback(error_msg, 0)
            raise VideoConversionError(error_msg) from e

    def is_ffmpeg_available(self) -> bool:
        """Check if FFmpeg is available in the system PATH.
        
        Returns:
            True if FFmpeg is available, False otherwise
        """
        try:
            result = subprocess.run(
                ["ffmpeg", "-version"],
                capture_output=True,
                text=True,
                check=False,
                timeout=10,
            )
            return result.returncode == 0
        except (subprocess.SubprocessError, FileNotFoundError, subprocess.TimeoutExpired):
            return False

    def get_video_info(self, video_path: str,
    ) -> dict | None:
        """Get basic information about a video file using FFprobe.
        
        Args:
            video_path: Path to the video file
            
        Returns:
            Dictionary with video information or None if failed
        """
        try:
            if not Path(video_path).exists():
                return None

            # Use FFprobe to get video information
            ffprobe_cmd = [
                "ffprobe",
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                "-show_streams",
                video_path,
            ]

            result = subprocess.run(
                ffprobe_cmd,
                capture_output=True,
                text=True,
                check=False,
                timeout=30,
            )

            if result.returncode == 0:
                import json
                return json.loads(result.stdout)

            return None

        except (subprocess.SubprocessError, FileNotFoundError,
                subprocess.TimeoutExpired, json.JSONDecodeError):
            return None