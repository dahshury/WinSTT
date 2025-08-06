"""Audio File Service.

This module implements the AudioFileService for managing
audio files according to the protocol requirements.
"""

import wave
from pathlib import Path
from typing import Any

import numpy as np

from src_refactored.domain.audio.value_objects.audio_configuration import RecordingConfiguration
from src_refactored.domain.audio.value_objects.audio_data import RecordingMetadata
from src_refactored.infrastructure.audio.audio_recording_service import (
    AudioFileServiceProtocol,
)


class AudioFileService(AudioFileServiceProtocol):
    """Service for managing audio files."""

    def create_file(self, file_path: Path, config: RecordingConfiguration) -> tuple[bool, str | None]:
        """Create audio file for recording."""
        try:
            # Ensure directory exists
            file_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Create WAV file
            with wave.open(str(file_path), "wb") as wav_file:
                wav_file.setnchannels(config.channels)
                wav_file.setsampwidth(config.bit_depth // 8)
                wav_file.setframerate(config.sample_rate)
            
            return True, None
            
        except Exception as e:
            return False, f"Failed to create file: {e}"

    def write_data(self, file_path: Path, data: np.ndarray) -> tuple[bool, str | None]:
        """Write audio data to file."""
        try:
            # Convert float32 to int16 for WAV format
            if data.dtype == np.float32:
                data = (data * 32767).astype(np.int16)
            
            with wave.open(str(file_path), "ab") as wav_file:
                wav_file.writeframes(data.tobytes())
            
            return True, None
            
        except Exception as e:
            return False, f"Failed to write data: {e}"

    def finalize_file(self, file_path: Path, metadata: RecordingMetadata) -> tuple[bool, str | None]:
        """Finalize audio file."""
        try:
            # For WAV files, no additional finalization needed
            # The file is already properly formatted
            return True, None
            
        except Exception as e:
            return False, f"Failed to finalize file: {e}"

    def get_file_info(self, file_path: Path) -> tuple[bool, dict[str, Any] | None, str | None]:
        """Get audio file information."""
        try:
            with wave.open(str(file_path), "rb") as wav_file:
                info = {
                    "channels": wav_file.getnchannels(),
                    "sample_width": wav_file.getsampwidth(),
                    "frame_rate": wav_file.getframerate(),
                    "frames": wav_file.getnframes(),
                    "duration": wav_file.getnframes() / wav_file.getframerate(),
                    "size": file_path.stat().st_size,
                }
            
            return True, info, None
            
        except Exception as e:
            return False, None, f"Failed to get file info: {e}"
