"""Audio Device Service.

This module implements the AudioDeviceService for managing
audio devices according to the protocol requirements.
"""

from typing import Any

import pyaudio

from src_refactored.infrastructure.audio.audio_recording_service import (
    AudioDeviceServiceProtocol,
)


class AudioDeviceService(AudioDeviceServiceProtocol):
    """Service for managing audio devices."""

    def __init__(self):
        """Initialize the audio device service."""
        self._pyaudio = None
        self._initialized = False

    def _ensure_initialized(self):
        """Ensure PyAudio is initialized."""
        if not self._initialized:
            try:
                self._pyaudio = pyaudio.PyAudio()
                self._initialized = True
            except Exception:
                self._initialized = False

    def list_input_devices(self) -> tuple[bool, list[dict[str, Any]], str | None]:
        """List available input devices."""
        try:
            self._ensure_initialized()
            
            if not self._initialized or not self._pyaudio:
                return False, [], "PyAudio not initialized"
            
            devices = []
            device_count = self._pyaudio.get_device_count()
            
            for i in range(device_count):
                try:
                    device_info = self._pyaudio.get_device_info_by_index(i)
                    
                    # Only include input devices
                    if device_info["maxInputChannels"] > 0:
                        devices.append({
                            "id": i,
                            "name": device_info["name"],
                            "channels": device_info["maxInputChannels"],
                            "sample_rate": device_info["defaultSampleRate"],
                            "is_default": i == self._pyaudio.get_default_input_device_info()["index"],
                        })
                except Exception:
                    # Skip problematic devices
                    continue
            
            return True, devices, None
            
        except Exception as e:
            return False, [], f"Failed to list devices: {e}"

    def get_device_info(self, device_id: int) -> tuple[bool, dict[str, Any] | None, str | None]:
        """Get device information."""
        try:
            self._ensure_initialized()
            
            if not self._initialized or not self._pyaudio:
                return False, None, "PyAudio not initialized"
            
            if device_id < 0 or device_id >= self._pyaudio.get_device_count():
                return False, None, f"Invalid device ID: {device_id}"
            
            device_info = self._pyaudio.get_device_info_by_index(device_id)
            
            return True, {
                "id": device_id,
                "name": device_info["name"],
                "channels": device_info["maxInputChannels"],
                "sample_rate": device_info["defaultSampleRate"],
                "is_default": device_id == self._pyaudio.get_default_input_device_info()["index"],
            }, None
            
        except Exception as e:
            return False, None, f"Failed to get device info: {e}"

    def test_device(self, device_id: int) -> tuple[bool, str | None]:
        """Test device functionality."""
        try:
            self._ensure_initialized()
            
            if not self._initialized or not self._pyaudio:
                return False, "PyAudio not initialized"
            
            if device_id < 0 or device_id >= self._pyaudio.get_device_count():
                return False, f"Invalid device ID: {device_id}"
            
            device_info = self._pyaudio.get_device_info_by_index(device_id)
            
            if device_info["maxInputChannels"] <= 0:
                return False, "Device does not support input"
            
            # Try to open a test stream
            test_stream = self._pyaudio.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=16000,
                input=True,
                input_device_index=device_id,
                frames_per_buffer=1024,
            )
            
            test_stream.close()
            return True, None
            
        except Exception as e:
            return False, f"Device test failed: {e}"

    def cleanup(self):
        """Clean up resources."""
        if self._pyaudio:
            self._pyaudio.terminate()
            self._pyaudio = None
        self._initialized = False
