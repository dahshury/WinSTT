"""Audio File Repository.

This module implements the AudioFileRepository for managing audio file persistence
with progress tracking and comprehensive file operations.
Extracted from utils/listener.py file persistence logic.
"""

from __future__ import annotations

import io
import os
import threading
import uuid
import wave
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from src_refactored.domain.audio.entities.audio_file import (
    AudioFile,
    FilePath,
    FileSize,
    FileSource,
)
from src_refactored.domain.audio.value_objects.duration import Duration
from src_refactored.domain.audio.value_objects.audio_data import AudioData
from src_refactored.domain.audio.value_objects.audio_format import AudioFormat
from src_refactored.domain.audio.value_objects.sample_rate import SampleRate
from src_refactored.domain.file_operations.value_objects.file_operations import (
    FileOperationResult,
    FileOperationType,
)


@dataclass
class FileOperationProgress:
    """Progress information for file operations."""
    operation_type: FileOperationType
    file_path: str
    bytes_processed: int
    total_bytes: int
    percentage: float
    start_time: datetime
    estimated_completion: datetime | None = None
    current_phase: str = ""

    @property
    def is_complete(self) -> bool:
        """Check if operation is complete."""
        return self.percentage >= 100.0

    @property
    def elapsed_time(self) -> float:
        """Get elapsed time in seconds."""
        return (datetime.now() - self.start_time).total_seconds()


class ProgressCallback(Protocol,
    ):
    """Protocol for progress callbacks."""

    def __call__(self, progress: FileOperationProgress,
    ) -> None:
        """Called with progress updates."""
        ...


@dataclass
class AudioFileRepositoryConfiguration:
    """Configuration for audio file repository."""
    default_output_directory: str = "recordings"
    enable_progress_tracking: bool = True
    chunk_size: int = 8192  # Bytes to process at a time
    auto_create_directories: bool = True
    validate_files_on_load: bool = True
    backup_existing_files: bool = False
    max_file_size_mb: int = 500


@dataclass
class SaveAudioRequest:
    """Request for saving audio data."""
    audio_data: AudioData
    file_path: FilePath
    audio_format: AudioFormat
    metadata: dict[str, Any] = field(default_factory=dict)
    overwrite_existing: bool = False
    progress_callback: ProgressCallback | None = None


@dataclass
class LoadAudioRequest:
    """Request for loading audio data."""
    file_path: FilePath
    validate_format: bool = True
    progress_callback: ProgressCallback | None = None


@dataclass
class AudioFileOperationResult:
    """Result of an audio file operation."""
    result: FileOperationResult
    audio_file: AudioFile | None = None
    audio_data: AudioData | None = None
    error_message: str | None = None
    bytes_processed: int = 0
    operation_time: float = 0.0


class AudioFileRepository:
    """Repository for managing audio file persistence with progress tracking."""

    def __init__(self, config: AudioFileRepositoryConfiguration | None = None):
        """Initialize the audio file repository."""
        self._config = config or AudioFileRepositoryConfiguration()
        self._active_operations: dict[str, FileOperationProgress] = {}
        self._lock = threading.RLock()

        # Ensure output directory exists
        if self._config.auto_create_directories:
            os.makedirs(self._config.default_output_directory, exist_ok=True)

    def save_audio_data(self, request: SaveAudioRequest,
    ) -> AudioFileOperationResult:
        """Save audio data to a file with progress tracking."""
        operation_id = self._generate_operation_id()
        start_time = datetime.now()

        try:
            # Validate request
            validation_result = self._validate_save_request(request)
            if validation_result.result != FileOperationResult.SUCCESS:
                return validation_result

            # Prepare file path
            file_path = Path(request.file_path.path)
            if self._config.auto_create_directories:
                file_path.parent.mkdir(parents=True, exist_ok=True)

            # Check if file exists and handle overwrite
            if file_path.exists() and not request.overwrite_existing:
                if self._config.backup_existing_files:
                    self._backup_existing_file(file_path)
                else:
                    return AudioFileOperationResult(
                        result=FileOperationResult.FAILURE,
                        error_message="File already exists and overwrite not allowed",
                    )

            # Convert audio data to WAV bytes
            wav_bytes = self._convert_audio_to_wav_bytes(request.audio_data)
            total_bytes = len(wav_bytes)

            # Initialize progress tracking
            if self._config.enable_progress_tracking and request.progress_callback:
                progress = FileOperationProgress(
                    operation_type=FileOperationType.SAVE,
                    file_path=str(file_path),
                    bytes_processed=0,
                    total_bytes=len(wav_bytes),
                    percentage=0.0,
                    start_time=start_time,
                    current_phase="Writing file",
                )
                self._active_operations[operation_id] = progress
                request.progress_callback(progress)

            # Write file in chunks with progress updates
            bytes_written = 0
            with open(file_path, "wb") as f:
                for i in range(0, len(wav_bytes), self._config.chunk_size):
                    chunk = wav_bytes[i:i + self._config.chunk_size]
                    f.write(chunk)
                    bytes_written += len(chunk)

                    # Update progress
                    if self._config.enable_progress_tracking and request.progress_callback:
                        progress.bytes_processed = bytes_written
                        progress.percentage = (bytes_written / total_bytes) * 100
                        request.progress_callback(progress)

            # Create AudioFile entity
            file_size = FileSize(bytes=int(bytes_written))
            duration = Duration(seconds=request.audio_data.calculated_duration.total_seconds())

            audio_file = AudioFile(
                entity_id=str(uuid.uuid4()),
                file_path=request.file_path,
                audio_format=request.audio_format,
                duration=duration,
                file_size=file_size,
                source=FileSource.RECORDING,
                title=request.metadata.get("title"),
                description=request.metadata.get("description"),
                tags=request.metadata.get("tags", []),
            )

            # Final progress update
            if self._config.enable_progress_tracking and request.progress_callback:
                progress.percentage = 100.0
                progress.current_phase = "Complete"
                request.progress_callback(progress)

            operation_time = (datetime.now() - start_time).total_seconds()

            return AudioFileOperationResult(
                result=FileOperationResult.SUCCESS,
                audio_file=audio_file,
                bytes_processed=bytes_written,
                operation_time=operation_time,
            )

        except PermissionError:
            return AudioFileOperationResult(
                result=FileOperationResult.PERMISSION_DENIED,
                error_message="Permission denied accessing file",
            )
        except OSError as e:
            if "No space left on device" in str(e):
                return AudioFileOperationResult(
                    result=FileOperationResult.DISK_FULL,
                    error_message="Insufficient disk space",
                )
            if "File name too long" in str(e):
                return AudioFileOperationResult(
                    result=FileOperationResult.PATH_TOO_LONG,
                    error_message="File path too long",
                )
            return AudioFileOperationResult(
                result=FileOperationResult.FAILURE,
                error_message=f"OS error: {e!s}",
            )
        except Exception as e:
            return AudioFileOperationResult(
                result=FileOperationResult.FAILURE,
                error_message=f"Unexpected error: {e!s}",
            )
        finally:
            # Clean up operation tracking
            with self._lock:
                self._active_operations.pop(operation_id, None)

    def load_audio_data(self, request: LoadAudioRequest,
    ) -> AudioFileOperationResult:
        """Load audio data from a file with progress tracking."""
        operation_id = self._generate_operation_id()
        start_time = datetime.now()

        try:
            file_path = Path(request.file_path.path)

            # Check if file exists
            if not file_path.exists():
                return AudioFileOperationResult(
                    result=FileOperationResult.FILE_NOT_FOUND,
                    error_message="Audio file not found",
                )

            # Get file size for progress tracking
            file_size = file_path.stat().st_size

            # Initialize progress tracking
            if self._config.enable_progress_tracking and request.progress_callback:
                progress = FileOperationProgress(
                    operation_type=FileOperationType.LOAD,
                    file_path=str(file_path),
                    bytes_processed=0,
                    total_bytes=file_size,
                    percentage=0.0,
                    start_time=start_time,
                    current_phase="Reading file",
                )
                self._active_operations[operation_id] = progress
                request.progress_callback(progress)

            # Read and parse WAV file
            with wave.open(str(file_path), "rb") as wav_file:
                # Get audio parameters
                channels = wav_file.getnchannels()
                sample_width = wav_file.getsampwidth()
                sample_rate = wav_file.getframerate()
                n_frames = wav_file.getnframes()

                # Read audio data in chunks
                frames_data = []
                frames_read = 0

                while frames_read < n_frames:
                    chunk_frames = min(self._config.chunk_size // (channels * sample_width), n_frames - frames_read)
                    chunk_data = wav_file.readframes(chunk_frames)
                    frames_data.append(chunk_data)
                    frames_read += chunk_frames

                    # Update progress
                    if self._config.enable_progress_tracking and request.progress_callback:
                        bytes_processed = frames_read * channels * sample_width
                        progress.bytes_processed = bytes_processed
                        progress.percentage = (frames_read / n_frames) * 100
                        request.progress_callback(progress)

                # Combine all chunks
                audio_bytes = b"".join(frames_data)

            # Convert to numpy array
                if sample_width == 1:
                    dtype: Any = np.uint8
                elif sample_width == 2:
                    dtype = np.int16
                elif sample_width == 4:
                    dtype = np.int32
                else:
                    return AudioFileOperationResult(
                        result=FileOperationResult.INVALID_FORMAT,
                        error_message=f"Unsupported sample width: {sample_width}",
                    )

                samples = np.frombuffer(audio_bytes, dtype=dtype)

                # Handle multi-channel audio
                if channels > 1:
                    samples = samples.reshape(-1, channels)

                # Create AudioFormat
                from src_refactored.domain.audio.value_objects.audio_format import (
                    AudioFormatType,
                    BitDepth,
                )
                audio_format = AudioFormat(
                    format_type=AudioFormatType.WAV,
                    sample_rate=sample_rate,
                    channels=channels,
                    bit_depth=int(BitDepth(sample_width * 8).value),
                    chunk_size=1024,  # Default chunk size for WAV files
                )

                # Convert to list of float for domain compatibility
                samples = samples.astype(float).tolist()

                # Create AudioData
                audio_data = AudioData(
                    data=samples,
                    sample_rate=SampleRate(sample_rate),
                    channels=channels,
                    audio_format=audio_format,
                    timestamp=datetime.now(),
                    duration=timedelta(seconds=n_frames / sample_rate),
                )

                # Create AudioFile entity
                file_size = FileSize(bytes=int(file_path.stat().st_size))
                duration = Duration(seconds=n_frames / sample_rate)

                audio_file = AudioFile(
                    entity_id=str(uuid.uuid4()),
                    file_path=request.file_path,
                    audio_format=audio_format,
                    duration=duration,
                    file_size=file_size,
                    source=FileSource.UPLOAD,
                )

                # Final progress update
                if self._config.enable_progress_tracking and request.progress_callback:
                    progress.percentage = 100.0
                    progress.current_phase = "Complete"
                    request.progress_callback(progress)

                operation_time = (datetime.now() - start_time).total_seconds()

                return AudioFileOperationResult(
                    result=FileOperationResult.SUCCESS,
                    audio_file=audio_file,
                    audio_data=audio_data,
                    bytes_processed=file_path.stat().st_size,
                    operation_time=operation_time,
                )

        except PermissionError:
            return AudioFileOperationResult(
                result=FileOperationResult.PERMISSION_DENIED,
                error_message="Permission denied accessing file",
            )
        except Exception as e:
            return AudioFileOperationResult(
                result=FileOperationResult.FAILURE,
                error_message=f"Error loading audio file: {e!s}",
            )
        finally:
            # Clean up operation tracking
            with self._lock:
                self._active_operations.pop(operation_id, None)

    def delete_audio_file(self, file_path: FilePath,
    ) -> FileOperationResult:
        """Delete an audio file."""
        try:
            path = Path(file_path.path)
            if not path.exists():
                return FileOperationResult.FILE_NOT_FOUND

            path.unlink()
            return FileOperationResult.SUCCESS

        except PermissionError:
            return FileOperationResult.PERMISSION_DENIED
        except Exception:
            return FileOperationResult.FAILURE

    def get_active_operations(self,
    ) -> dict[str, FileOperationProgress]:
        """Get currently active file operations."""
        with self._lock:
            return self._active_operations.copy()

    def _validate_save_request(self, request: SaveAudioRequest,
    ) -> AudioFileOperationResult:
        """Validate a save request."""
        # Check file size limit
        estimated_size_mb = (len(request.audio_data.data) * 2) / (1024 * 1024)  # Rough estimate for 16-bit
        if estimated_size_mb > self._config.max_file_size_mb:
            return AudioFileOperationResult(
                result=FileOperationResult.FAILURE,
                error_message=f"File size ({estimated_size_mb:.1f} MB) exceeds limit ({self._config.max_file_size_mb} MB)",
            )

        # Validate audio data
        if request.audio_data.data is None or len(request.audio_data.data) == 0:
            return AudioFileOperationResult(
                result=FileOperationResult.INVALID_FORMAT,
                error_message="Audio data is empty",
            )

        return AudioFileOperationResult(result=FileOperationResult.SUCCESS)

    def _convert_audio_to_wav_bytes(self, audio_data: AudioData,
    ) -> bytes:
        """Convert AudioData to WAV format bytes."""
        with io.BytesIO() as wav_buffer:
            with wave.open(wav_buffer, "wb") as wav_file:
                wav_file.setnchannels(audio_data.channels)
                wav_file.setsampwidth(2)  # 16-bit
                wav_file.setframerate(audio_data.sample_rate.value)

                # Convert samples to bytes
                # Ensure numpy array for conversion
                samples_np = np.asarray(audio_data.data)
                if samples_np.dtype != np.int16:
                    # Convert to int16 if needed
                    samples_int16 = (samples_np * 32767).astype(np.int16)
                else:
                    samples_int16 = samples_np

                wav_file.writeframes(samples_int16.tobytes())

            wav_buffer.seek(0)
            return wav_buffer.read()

    def _backup_existing_file(self, file_path: Path,
    ) -> None:
        """Create a backup of an existing file."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = file_path.with_suffix(f".{timestamp}.bak{file_path.suffix}")
        file_path.rename(backup_path)

    def _generate_operation_id(self) -> str:
        """Generate a unique operation ID."""
        return f"op_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"

    def get_configuration(self) -> AudioFileRepositoryConfiguration:
        """Get the current configuration."""
        return self._config

    def update_configuration(self, config: AudioFileRepositoryConfiguration,
    ) -> None:
        """Update the repository configuration."""
        self._config = config

        # Ensure output directory exists if auto-create is enabled
        if self._config.auto_create_directories:
            os.makedirs(self._config.default_output_directory, exist_ok=True)