"""Update Waveform Use Case.

This module implements the UpdateWaveformUseCase for handling waveform
data updates in the audio visualization system.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable

    from src_refactored.domain.audio_visualization.value_objects.visualization_configuration import (
        VisualizationConfiguration,
    )
    from src_refactored.domain.audio_visualization.value_objects.waveform_data import (
        WaveformData,
    )


class IWaveformUpdatePort(Protocol):
    """Port for waveform update operations."""
    
    def update_waveform_display(self, waveform_data: WaveformData) -> None:
        """Update the waveform display with new data."""
        ...
    
    def clear_waveform_display(self) -> None:
        """Clear the waveform display."""
        ...


@dataclass
class UpdateWaveformRequest:
    """Request for updating waveform data."""
    waveform_data: WaveformData
    config: VisualizationConfiguration
    clear_previous: bool = False
    progress_callback: Callable[[str, float], None] | None = None
    completion_callback: Callable[[bool], None] | None = None
    error_callback: Callable[[str], None] | None = None


@dataclass
class UpdateWaveformResponse:
    """Response from waveform update operation."""
    success: bool
    message: str = ""
    updated_data: WaveformData | None = None


class UpdateWaveformUseCase:
    """Use case for updating waveform visualization data.
    
    This use case handles:
    - Waveform data validation and processing
    - Display update coordination
    - Error handling for visualization updates
    - Progress tracking for update operations
    """
    
    def __init__(self, waveform_port: IWaveformUpdatePort):
        """Initialize the update waveform use case.
        
        Args:
            waveform_port: Port for waveform update operations
        """
        self._waveform_port = waveform_port
    
    def execute(self, request: UpdateWaveformRequest) -> UpdateWaveformResponse:
        """Execute the waveform update operation.
        
        Args:
            request: Update waveform request
            
        Returns:
            UpdateWaveformResponse: Result of the update operation
        """
        try:
            # Report progress
            if request.progress_callback:
                request.progress_callback("Validating waveform data", 0.1)
            
            # Validate waveform data
            if not self._validate_waveform_data(request.waveform_data):
                error_msg = "Invalid waveform data provided"
                if request.error_callback:
                    request.error_callback(error_msg)
                return UpdateWaveformResponse(success=False, message=error_msg)
            
            # Report progress
            if request.progress_callback:
                request.progress_callback("Updating waveform display", 0.5)
            
            # Clear previous data if requested
            if request.clear_previous:
                self._waveform_port.clear_waveform_display()
            
            # Update waveform display
            self._waveform_port.update_waveform_display(request.waveform_data)
            
            # Report completion
            if request.progress_callback:
                request.progress_callback("Waveform update completed", 1.0)
            
            if request.completion_callback:
                request.completion_callback(True)
            
            return UpdateWaveformResponse(
                success=True,
                message="Waveform updated successfully",
                updated_data=request.waveform_data,
            )
            
        except Exception as e:
            error_msg = f"Failed to update waveform: {e!s}"
            if request.error_callback:
                request.error_callback(error_msg)
            return UpdateWaveformResponse(success=False, message=error_msg)
    
    def _validate_waveform_data(self, waveform_data: WaveformData) -> bool:
        """Validate waveform data.
        
        Args:
            waveform_data: Waveform data to validate
            
        Returns:
            bool: True if valid, False otherwise
        """
        if not waveform_data:
            return False
        
        # Add specific validation logic based on WaveformData structure
        # This would depend on the actual WaveformData implementation
        return True


def create_update_waveform_use_case(
    waveform_port: IWaveformUpdatePort,
) -> UpdateWaveformUseCase:
    """Factory function to create UpdateWaveformUseCase.
    
    Args:
        waveform_port: Port for waveform update operations
        
    Returns:
        UpdateWaveformUseCase: Configured use case instance
    """
    return UpdateWaveformUseCase(waveform_port)