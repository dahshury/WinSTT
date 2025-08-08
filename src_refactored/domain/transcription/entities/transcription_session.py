"""Transcription Session Entity.

This module contains the TranscriptionSession entity for managing
transcription sessions and their lifecycle.
"""

from dataclasses import dataclass, field
from typing import Any

from src_refactored.domain.common.abstractions import AggregateRoot
from src_refactored.domain.common.result import Result
from src_refactored.domain.transcription.entities.transcription_result import (
    TranscriptionResult,
)
from src_refactored.domain.transcription.value_objects import (
    TranscriptionState,
)


@dataclass
class TranscriptionSession(AggregateRoot):
    """Transcription session entity for managing transcription operations."""
    
    session_id: str
    state: TranscriptionState = TranscriptionState.IDLE
    current_transcription_id: str | None = None
    transcription_results: list[TranscriptionResult] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        super().__init__(self.session_id)

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
        
        # Find the latest transcription based on started_at timestamp, fallback to 0 for comparison
        latest = max(self.transcription_results, key=lambda r: r.started_at.timestamp() if r.started_at else 0.0)
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
                # Cancel the transcription using proper entity method
                result.cancel_transcription(reason)
                self.increment_version()
                return Result.success(None)
        
        return Result.failure(f"Transcription {transcription_id} not found")
    
    def clear_temporary_data(self, transcription_id: str, preserve_results: bool = True) -> None:
        """Clear temporary data for transcription."""
        # Implementation would clear temporary files/data
    
    def get_model_configuration(self) -> Any | None:
        """Get current model configuration."""
        # Implementation would return current model config
        return None
    
    def get_session_id(self) -> str:
        """Get the session ID."""
        return self.session_id
    
    def start_transcription(self, audio_data: Any, language: str | None = None, task: str = "transcribe") -> Result[str]:
        """Start a new transcription."""
        from src_refactored.domain.common.domain_utils import DomainIdentityGenerator
        from src_refactored.domain.transcription.entities.transcription_result import (
            TranscriptionResult,
            TranscriptionStatus,
        )
        
        # Generate a new transcription ID
        transcription_id = DomainIdentityGenerator.generate_domain_id("transcription")
        
        # Create new transcription result entity

        from src_refactored.domain.transcription.value_objects.language import Language
        
        # Create language object if provided
        language_obj = Language.from_code(language) if language else Language.from_code("en")
        
        # Create new transcription result
        transcription_result = TranscriptionResult(
            transcription_id=transcription_id,
            source_audio_id=DomainIdentityGenerator.generate_domain_id("audio"),
            language=language_obj,
            status=TranscriptionStatus.PENDING,
            started_at=None,
            completed_at=None,
        )
        
        # Add to session
        self.transcription_results.append(transcription_result)
        self.current_transcription_id = transcription_id
        self.state = TranscriptionState.PROCESSING
        self.increment_version()
        
        return Result.success(transcription_id)