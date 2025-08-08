"""Audio Data Validation Service.

This module implements the AudioDataValidationService for validating
audio data types and formats according to the protocol requirements.
"""

from typing import Any

import numpy as np

from src_refactored.domain.audio_visualization.protocols import (
    AudioDataValidationServiceProtocol,
)
from src_refactored.domain.audio_visualization.value_objects.processing_types import AudioDataType


class AudioDataValidationService(AudioDataValidationServiceProtocol):
    """Service for validating audio data according to protocol requirements."""

    def validate_raw_data(self, data: Any, data_type: AudioDataType) -> bool:
        """Validate raw audio data.
        
        Args:
            data: Raw audio data
            data_type: Type of audio data
            
        Returns:
            True if data is valid
        """
        try:
            if data is None:
                return False
                
            if data_type == AudioDataType.NUMPY_ARRAY:
                return isinstance(data, np.ndarray) and len(data) > 0
            if data_type == AudioDataType.RAW_BYTES:
                return isinstance(data, bytes) and len(data) > 0
            if data_type == AudioDataType.FLOAT_ARRAY:
                return isinstance(data, list | tuple) and len(data) > 0
            if data_type in (AudioDataType.INT16_ARRAY, AudioDataType.INT32_ARRAY):
                return isinstance(data, list | tuple) and len(data) > 0
            return False
                
        except Exception:
            return False

    def get_data_info(self, data: Any, data_type: AudioDataType) -> dict[str, Any]:
        """Get information about audio data.
        
        Args:
            data: Raw audio data
            data_type: Type of audio data
            
        Returns:
            Dictionary with data information
        """
        try:
            # Widen the type so subsequent numeric fields are accepted
            info: dict[str, Any] = {
                "data_type": data_type.value,
                "is_valid": self.validate_raw_data(data, data_type),
            }
            
            if data is not None:
                if isinstance(data, np.ndarray):
                    info.update({
                        "shape": data.shape,
                        "dtype": str(data.dtype),
                        "size": data.size,
                        "min_value": float(np.min(data)) if data.size > 0 else None,
                        "max_value": float(np.max(data)) if data.size > 0 else None,
                        "mean_value": float(np.mean(data)) if data.size > 0 else None,
                    })
                elif isinstance(data, list | tuple):
                    info.update({
                        "length": len(data),
                        "type": type(data).__name__,
                    })
                elif isinstance(data, bytes):
                    info.update({
                        "length": len(data),
                        "type": "bytes",
                    })
                    
            return info
            
        except Exception:
            return {
                "data_type": data_type.value,
                "is_valid": False,
                "error": "Failed to analyze data",
            }
