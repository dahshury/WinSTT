"""Audio Data Validation Service Protocol.

This module defines the protocol for audio data validation services.
"""

from typing import Any, Protocol

import numpy as np


class AudioDataValidationServiceProtocol(Protocol):
    """Protocol for audio data validation service."""

    def validate_audio_array(self, data: np.ndarray) -> bool:
        """Validate audio data array.
        
        Args:
            data: Audio data array
            
        Returns:
            True if data is valid
        """
        ...

    def check_data_integrity(self, data: np.ndarray) -> dict[str, Any]:
        """Check data integrity and return information.
        
        Args:
            data: Audio data array
            
        Returns:
            Dictionary with integrity information
        """
        ...