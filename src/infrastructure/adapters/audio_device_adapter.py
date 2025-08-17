"""Audio Device Adapter.

This adapter provides audio device checking functionality
following the adapter pattern in hexagonal architecture.
"""

from src.domain.common.ports.logging_port import LoggingPort


class AudioDeviceAdapter:
    """Adapter for audio device operations."""
    
    def __init__(self, logger: LoggingPort | None = None):
        self._logger = logger
    
    def check_availability(self) -> bool:
        """Check if audio input device is available."""
        try:
            import pyaudio
            
            p = pyaudio.PyAudio()
            device_count = p.get_device_count()
            
            # Check for any input device
            input_devices_found = 0
            for i in range(device_count):
                try:
                    device_info = p.get_device_info_by_index(i)
                    if device_info["maxInputChannels"] > 0:
                        input_devices_found += 1
                        if self._logger:
                            self._logger.log_debug(f"Found input device: {device_info.get('name', 'Unknown')}")
                except Exception as device_error:
                    # Skip this device if we can't get its info
                    if self._logger:
                        self._logger.log_debug(f"Could not get info for device {i}: {device_error}")
                    continue
            
            p.terminate()
            
            has_devices = input_devices_found > 0
            if self._logger:
                self._logger.log_info(f"Audio device check: {input_devices_found} input devices found")
            
            return has_devices
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Failed to check audio device availability: {e}")
            # Return False if we can't check - better to show error than proceed silently
            return False
