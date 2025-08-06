"""Waveform Update Port for audio visualization operations."""

from abc import ABC, abstractmethod

from src_refactored.domain.audio_visualization.value_objects.visualization_config import (
    VisualizationConfig,
)
from src_refactored.domain.audio_visualization.value_objects.waveform_data import WaveformData
from src_refactored.domain.common.result import Result


class IWaveformUpdatePort(ABC):
    """Port interface for waveform update operations."""
    
    @abstractmethod
    def update_waveform(self, waveform_data: WaveformData, config: VisualizationConfig) -> Result[None]:
        """Update waveform visualization.
        
        Args:
            waveform_data: Waveform data to display
            config: Visualization configuration
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def clear_waveform(self) -> Result[None]:
        """Clear the current waveform display.
        
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def set_visualization_config(self, config: VisualizationConfig) -> Result[None]:
        """Set visualization configuration.
        
        Args:
            config: New visualization configuration
            
        Returns:
            Result indicating success or failure
        """
        ...
    
    @abstractmethod
    def get_current_config(self) -> Result[VisualizationConfig]:
        """Get current visualization configuration.
        
        Returns:
            Result containing current configuration
        """
        ...
