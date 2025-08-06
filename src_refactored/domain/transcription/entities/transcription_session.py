"""Transcription Session Entity.

This module contains the TranscriptionSession entity for managing
transcription sessions and their lifecycle.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from src_refactored.domain.common.abstractions import AggregateRoot
from src_refactored.domain.common.result import Result
from src_refactored.domain.transcription.value_objects import (
    TranscriptionResult,
    TranscriptionState,
)


@dataclass
class TranscriptionSession(AggregateRoot):
    """Transcription session entity for managing transcription operations."""
    
    session_id: str
    created_at: datetime
    updated_at: datetime
    state: TranscriptionState = TranscriptionState.IDLE
    current_transcription_id: str | None = None
    transcription_results: list[TranscriptionResult] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    
    def get_state(self) -> TranscriptionState:
        """Get current session state."""
        return self.state
    
    def get_current_transcription(self) -> Result[TranscriptionResult]:
        """Get current transcription result."""
        if not self.current_transcription_id:
            return Result.failure("No current transcription")
        
        for result in self.transcription_results:
            if result.transcription_id == self.current_transcription_id:
                return Result.success(result)
        
        return Result.failure("Current transcription not found")
    
    def get_latest_transcription(self) -> Result[TranscriptionResult]:
        """Get latest transcription result."""
        if not self.transcription_results:
            return Result.failure("No transcriptions available")
        
        latest = max(self.transcription_results, key=lambda r: r.created_at)
        return Result.success(latest)
    
    def get_transcription_result(self, transcription_id: str) -> Result[TranscriptionResult]:
        """Get transcription result by ID."""
        for result in self.transcription_results:
            if result.transcription_id == transcription_id:
                return Result.success(result)
        
        return Result.failure(f"Transcription {transcription_id} not found")
    
    def get_session_history(self, session_id: str) -> Result[list[TranscriptionResult]]:
        """Get session history."""
        if session_id != self.session_id:
            return Result.failure("Session ID mismatch")
        
        return Result.success(self.transcription_results)
    
    def get_all_history(self) -> Result[list[TranscriptionResult]]:
        """Get all transcription history."""
        return Result.success(self.transcription_results)
    
    def configure_model(self, model_config: Any) -> Result[None]:
        """Configure transcription model."""
        # Implementation would depend on model configuration
        return Result.success(None)
    
    def cancel_transcription(self, transcription_id: str, reason: str) -> Result[None]:
        """Cancel transcription."""
        for result in self.transcription_results:
            if result.transcription_id == transcription_id:
                result.state = TranscriptionState.CANCELLED
                result.error_message = reason
                self.mark_as_updated()
                return Result.success(None)
        
        return Result.failure(f"Transcription {transcription_id} not found")
    
    def clear_temporary_data(self, transcription_id: str, preserve_results: bool = True) -> None:
        """Clear temporary data for transcription."""
        # Implementation would clear temporary files/data
    
    def get_model_configuration(self) -> Any | None:
        """Get current model configuration."""
        # Implementation would return current model config
        return None