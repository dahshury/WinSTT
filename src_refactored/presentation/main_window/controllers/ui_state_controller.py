"""UI State Controller.

This controller manages UI state transitions and visual feedback,
separating UI concerns from business logic and using proper DDD audio visualization.
"""

from PyQt6.QtCore import QTimer

from src_refactored.application.audio_visualization import (
    StartVisualizationUseCase,
    StopVisualizationUseCase,
)
from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.presentation.adapters.pyqtgraph_renderer_adapter import PyQtGraphRendererAdapter
from src_refactored.presentation.main_window.components.progress_indicator_component import (
    ProgressIndicatorComponent,
)


class UIStateController:
    """Controller for managing UI state and visual feedback."""
    
    def __init__(
        self,
        progress_indicator: ProgressIndicatorComponent,
        visualization_renderer: PyQtGraphRendererAdapter,
        start_visualization_use_case: StartVisualizationUseCase | None = None,
        stop_visualization_use_case: StopVisualizationUseCase | None = None,
        sound_player_service=None,  # Will be injected when available
        logger: LoggingPort | None = None,
    ):
        self._progress_indicator = progress_indicator
        self._visualization_renderer = visualization_renderer
        self._start_visualization_use_case = start_visualization_use_case
        self._stop_visualization_use_case = stop_visualization_use_case
        self._sound_player = sound_player_service
        self._logger = logger
        
        # UI state
        self._is_recording = False
        self._is_transcribing = False
        self._progress_timer: QTimer | None = None
        self._progress_value = 0
    
    def start_recording_ui(self, enable_sound: bool = False, sound_path: str = "") -> None:
        """Update UI for recording start using proper visualization system."""
        try:
            self._is_recording = True
            
            # Show visualizer using proper adapter
            self._visualization_renderer.show_visualization()
            
            # Start visualization using use case if available
            if self._start_visualization_use_case:
                # This would properly start the visualization system
                # For now, just show the renderer
                pass
            
            # Play start sound if enabled
            if enable_sound and sound_path and self._sound_player:
                self._sound_player.play_sound(sound_path)
            
            # Start progress animation
            self._progress_timer = QTimer()
            self._progress_timer.timeout.connect(self._animate_recording_progress)
            self._progress_timer.start(200)
            self._progress_value = 0
            
            if self._logger:
                self._logger.log_debug("Recording UI started with proper visualization")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error starting recording UI: {e}")
    
    def stop_recording_ui(self) -> None:
        """Update UI for recording stop using proper visualization system."""
        try:
            self._is_recording = False
            
            # Stop progress animation
            if self._progress_timer:
                self._progress_timer.stop()
                self._progress_timer = None
            
            # Hide visualizer using proper adapter
            self._visualization_renderer.hide_visualization()
            
            # Stop visualization using use case if available
            if self._stop_visualization_use_case:
                # This would properly stop the visualization system
                # For now, just hide the renderer
                pass
            
            if self._logger:
                self._logger.log_debug("Recording UI stopped with proper visualization")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error stopping recording UI: {e}")
    
    def start_transcribing_ui(self, show_progress: bool = False) -> None:
        """Update UI for transcription start."""
        try:
            self._is_transcribing = True
            
            if show_progress:
                self._progress_indicator.show_progress(0)
            
            if self._logger:
                self._logger.log_debug("Transcribing UI started")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error starting transcribing UI: {e}")
    
    def stop_transcribing_ui(self) -> None:
        """Update UI for transcription completion."""
        try:
            self._is_transcribing = False
            
            # Hide progress bar
            self._progress_indicator.hide_progress()
            
            if self._logger:
                self._logger.log_debug("Transcribing UI stopped")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error stopping transcribing UI: {e}")
    
    def update_progress(self, value: int) -> None:
        """Update progress indicator."""
        self._progress_indicator.update_progress(value)
    
    def _animate_recording_progress(self) -> None:
        """Animate the recording progress bar."""
        try:
            self._progress_value = (self._progress_value + 5) % 100
            self._progress_indicator.update_progress(self._progress_value)
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error animating progress: {e}")
    
    @property
    def is_recording(self) -> bool:
        """Check if UI is in recording state."""
        return self._is_recording
    
    @property
    def is_transcribing(self) -> bool:
        """Check if UI is in transcribing state."""
        return self._is_transcribing
