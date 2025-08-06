"""Audio Processing Service.

This module implements the AudioProcessingService for processing
audio data according to the protocol requirements.
"""


import numpy as np

from src_refactored.infrastructure.audio.audio_recording_service import (
    AudioProcessingServiceProtocol,
)


class AudioProcessingService(AudioProcessingServiceProtocol):
    """Service for processing audio data."""

    def apply_noise_reduction(self, data: np.ndarray) -> tuple[bool, np.ndarray | None, str | None]:
        """Apply noise reduction to audio data."""
        try:
            if len(data) == 0:
                return True, data, None
            
            # Simple noise gate
            threshold = 0.01
            mask = np.abs(data) > threshold
            processed_data = data * mask
            
            return True, processed_data, None
            
        except Exception as e:
            return False, None, f"Failed to apply noise reduction: {e}"

    def apply_auto_gain(self, data: np.ndarray) -> tuple[bool, np.ndarray | None, str | None]:
        """Apply automatic gain control."""
        try:
            if len(data) == 0:
                return True, data, None
            
            # Calculate RMS
            rms = np.sqrt(np.mean(np.square(data)))
            
            if rms > 0:
                # Normalize to target RMS
                target_rms = 0.1
                gain = target_rms / rms
                gain = min(gain, 10.0)  # Limit maximum gain
                
                processed_data = data * gain
                processed_data = np.clip(processed_data, -1.0, 1.0)
                
                return True, processed_data, None
            return True, data, None
                
        except Exception as e:
            return False, None, f"Failed to apply auto gain: {e}"

    def detect_silence(self, data: np.ndarray, threshold: float) -> tuple[bool, bool, str | None]:
        """Detect silence in audio data."""
        try:
            if len(data) == 0:
                return True, True, None
            
            # Calculate RMS
            rms = np.sqrt(np.mean(np.square(data)))
            
            is_silence = rms < threshold
            
            return True, is_silence, None
            
        except Exception as e:
            return False, False, f"Failed to detect silence: {e}"

    def calculate_levels(self, data: np.ndarray) -> tuple[bool, float, float, str | None]:
        """Calculate RMS and peak levels."""
        try:
            if len(data) == 0:
                return True, 0.0, 0.0, None
            
            rms = np.sqrt(np.mean(np.square(data)))
            peak = np.max(np.abs(data))
            
            return True, rms, peak, None
            
        except Exception as e:
            return False, 0.0, 0.0, f"Failed to calculate levels: {e}"
