"""Visualization Renderer Port.

This port defines the interface for rendering visualization data
without exposing implementation details to the domain layer.
"""

from abc import ABC, abstractmethod
from typing import Any

from src_refactored.domain.audio_visualization.value_objects.visualization_data import (
    VisualizationData,
    VisualizationFrame,
)
from src_refactored.domain.audio_visualization.value_objects.visualization_settings import (
    VisualizationSettings,
)
from src_refactored.domain.audio_visualization.value_objects.waveform_data import WaveformData
from src_refactored.domain.common.result import Result


class VisualizationRendererPort(ABC):
    """Port for rendering visualization data from audio data."""
    
    @abstractmethod
    def render_waveform(
        self, 
        waveform: WaveformData, 
        settings: VisualizationSettings,
    ) -> Result[VisualizationData]:
        """Render waveform data into visualization data.
        
        Args:
            waveform: Audio waveform data
            settings: Visualization settings
            
        Returns:
            Result containing rendered visualization data
        """
        ...
    
    @abstractmethod
    def render_spectrum(
        self, 
        waveform: WaveformData, 
        settings: VisualizationSettings,
    ) -> Result[VisualizationData]:
        """Render spectrum visualization from audio data.
        
        Args:
            waveform: Audio waveform data
            settings: Visualization settings
            
        Returns:
            Result containing rendered spectrum visualization data
        """
        ...
    
    @abstractmethod
    def render_level_meter(
        self, 
        waveform: WaveformData, 
        settings: VisualizationSettings,
    ) -> Result[VisualizationData]:
        """Render level meter visualization from audio data.
        
        Args:
            waveform: Audio waveform data
            settings: Visualization settings
            
        Returns:
            Result containing rendered level meter visualization data
        """
        ...
    
    @abstractmethod
    def create_visualization_frame(
        self,
        visualization_data: VisualizationData,
        settings: VisualizationSettings,
        metadata: dict[str, Any] | None = None,
    ) -> Result[VisualizationFrame]:
        """Create a complete visualization frame.
        
        Args:
            visualization_data: Rendered visualization data
            settings: Visualization settings used
            metadata: Optional metadata about the frame
            
        Returns:
            Result containing the complete visualization frame
        """
        ...
    
    @abstractmethod
    def supports_visualization_type(self, visualization_type: str) -> bool:
        """Check if this renderer supports a specific visualization type.
        
        Args:
            visualization_type: Type of visualization to check
            
        Returns:
            True if supported, False otherwise
        """
        ...
