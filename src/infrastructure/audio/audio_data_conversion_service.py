"""Audio Data Conversion Service.

This module implements the AudioDataConversionService for converting
audio data between different formats according to the protocol requirements.
"""

from typing import Any

import numpy as np

from src.domain.audio_visualization.protocols import (
    AudioDataConversionServiceProtocol,
)
from src.domain.audio_visualization.value_objects.processing_types import AudioDataType


class AudioDataConversionService(AudioDataConversionServiceProtocol):
    """Service for converting audio data between different formats."""

    def convert_to_numpy(self, data: Any, data_type: AudioDataType) -> np.ndarray:
        """Convert raw data to numpy array.
        
        Args:
            data: Raw audio data
            data_type: Type of audio data
            
        Returns:
            Numpy array representation
        """
        try:
            if data is None:
                msg = "Data cannot be None"
                raise ValueError(msg)
                
            if data_type == AudioDataType.NUMPY_ARRAY:
                if isinstance(data, np.ndarray):
                    return data
                return np.array(data)
                    
            if data_type == AudioDataType.RAW_BYTES:
                # Convert bytes to numpy array
                if isinstance(data, bytes):
                    # Assume 16-bit PCM for bytes
                    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
                return np.array(data)
                    
            if data_type in (AudioDataType.FLOAT_ARRAY, AudioDataType.INT16_ARRAY, AudioDataType.INT32_ARRAY):
                return np.array(data, dtype=np.float32)
                
            # Fallback: try to convert to numpy array
            return np.array(data, dtype=np.float32)
                
        except Exception as e:
            msg = f"Failed to convert data to numpy array: {e}"
            raise ValueError(msg)

    def resample_data(self, data: np.ndarray, target_rate: int, current_rate: int) -> np.ndarray:
        """Resample audio data to target sample rate.
        
        Args:
            data: Audio data array
            target_rate: Target sample rate
            current_rate: Current sample rate
            
        Returns:
            Resampled audio data
        """
        try:
            if current_rate == target_rate:
                return data
                
            if current_rate <= 0 or target_rate <= 0:
                msg = "Sample rates must be positive"
                raise ValueError(msg)
                
            # Simple linear interpolation for resampling
            # For production, consider using scipy.signal.resample or librosa
            ratio = target_rate / current_rate
            new_length = int(len(data) * ratio)
            
            if new_length == 0:
                return np.array([], dtype=data.dtype)
                
            # Create new time points
            old_indices = np.arange(len(data))
            new_indices = np.linspace(0, len(data) - 1, new_length)
            
            # Linear interpolation
            resampled = np.interp(new_indices, old_indices, data)
            
            return resampled.astype(data.dtype)
            
        except Exception as e:
            msg = f"Failed to resample audio data: {e}"
            raise ValueError(msg)
