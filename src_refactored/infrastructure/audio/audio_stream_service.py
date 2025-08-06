"""Audio Stream Service.

This module implements the AudioStreamService for managing
audio streams according to the protocol requirements.
"""


import contextlib

import numpy as np
import pyaudio

from src_refactored.domain.audio.value_objects.audio_configuration import RecordingConfiguration
from src_refactored.infrastructure.audio.audio_recording_service import (
    AudioStreamServiceProtocol,
)


class AudioStreamService(AudioStreamServiceProtocol):
    """Service for managing audio streams."""

    def __init__(self):
        """Initialize the audio stream service."""
        self._pyaudio = None
        self._streams = {}
        self._initialized = False

    def _ensure_initialized(self):
        """Ensure PyAudio is initialized."""
        if not self._initialized:
            try:
                self._pyaudio = pyaudio.PyAudio()
                self._initialized = True
            except Exception:
                self._initialized = False

    def _get_pyaudio_format(self, config: RecordingConfiguration) -> int:
        """Get PyAudio format from configuration."""
        if config.bit_depth == 16:
            return pyaudio.paInt16
        if config.bit_depth == 24:
            return pyaudio.paInt24
        if config.bit_depth == 32:
            return pyaudio.paInt32
        return pyaudio.paInt16  # Default

    def create_input_stream(self, config: RecordingConfiguration) -> tuple[bool, str | None, str | None]:
        """Create input stream for recording."""
        try:
            self._ensure_initialized()
            
            if not self._initialized or not self._pyaudio:
                return False, None, "PyAudio not initialized"
            
            # Generate unique stream ID
            import uuid
            stream_id = f"stream_{uuid.uuid4().hex[:8]}"
            
            # Create stream
            stream = self._pyaudio.open(
                format=self._get_pyaudio_format(config),
                channels=config.channels,
                rate=config.sample_rate,
                input=True,
                frames_per_buffer=config.buffer_size,
            )
            
            self._streams[stream_id] = stream
            return True, stream_id, None
            
        except Exception as e:
            return False, None, f"Failed to create stream: {e}"

    def start_stream(self, stream_id: str) -> tuple[bool, str | None]:
        """Start audio stream."""
        try:
            if stream_id not in self._streams:
                return False, f"Stream not found: {stream_id}"
            
            # PyAudio streams are started automatically when created
            return True, None
            
        except Exception as e:
            return False, f"Failed to start stream: {e}"

    def stop_stream(self, stream_id: str) -> tuple[bool, str | None]:
        """Stop audio stream."""
        try:
            if stream_id not in self._streams:
                return False, f"Stream not found: {stream_id}"
            
            stream = self._streams[stream_id]
            stream.stop_stream()
            return True, None
            
        except Exception as e:
            return False, f"Failed to stop stream: {e}"

    def read_stream(self, stream_id: str, frames: int) -> tuple[bool, np.ndarray | None, str | None]:
        """Read data from stream."""
        try:
            if stream_id not in self._streams:
                return False, None, f"Stream not found: {stream_id}"
            
            stream = self._streams[stream_id]
            data = stream.read(frames, exception_on_overflow=False)
            
            # Convert to numpy array
            audio_data = np.frombuffer(data, dtype=np.int16)
            # Convert to float32 and normalize
            audio_data = audio_data.astype(np.float32) / 32768.0
            
            return True, audio_data, None
            
        except Exception as e:
            return False, None, f"Failed to read stream: {e}"

    def destroy_stream(self, stream_id: str) -> tuple[bool, str | None]:
        """Destroy audio stream."""
        try:
            if stream_id not in self._streams:
                return False, f"Stream not found: {stream_id}"
            
            stream = self._streams[stream_id]
            stream.close()
            del self._streams[stream_id]
            return True, None
            
        except Exception as e:
            return False, f"Failed to destroy stream: {e}"

    def cleanup(self):
        """Clean up all streams."""
        for stream_id in list(self._streams.keys()):
            with contextlib.suppress(Exception):
                self.destroy_stream(stream_id)
        
        if self._pyaudio:
            self._pyaudio.terminate()
            self._pyaudio = None
        self._initialized = False