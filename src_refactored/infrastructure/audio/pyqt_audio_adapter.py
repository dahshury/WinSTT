"""PyQt Audio Adapter Infrastructure Service.

This module provides PyQt signal integration for audio recording functionality,
wrapping the refactored AudioToTextService with PyQt signals.
"""

from __future__ import annotations

from dataclasses import dataclass
import contextlib

from collections.abc import Callable
from typing import Any

from PyQt6.QtCore import QObject, pyqtSignal

from src_refactored.application.listener.audio_to_text_config import AudioToTextConfig
from src_refactored.application.listener.audio_to_text_service import AudioToTextService
from src_refactored.infrastructure.audio.consolidated_listener_service import ConsolidatedListenerService


@dataclass
class PyQtAudioAdapter:
    service: ConsolidatedListenerService

    def __post_init__(self) -> None:
        # Prime sound playback path if available to reduce first-use latency
        with contextlib.suppress(Exception):
            sound = getattr(self.service, "_playback_service", None)
            if sound:
                # Attempt a minimal init via convenience call (empty path should no-op)
                sound.play_sound_file("")

    @property
    def start_sound_file(self) -> str | None:
        return self.service._config.start_sound_file if hasattr(self.service, "_config") else None

    @start_sound_file.setter
    def start_sound_file(self, value: str | None) -> None:
        if value is None:
            return
        if not hasattr(self.service, "_config"):
            return
        if not value:
            self.service._config.start_sound_file = ""
            return
        self.service._config.start_sound_file = value

    def has_start_sound(self) -> bool:
        return bool(getattr(self.service, "_config", None) and self.service._config.start_sound_file)

    def clear_start_sound(self) -> None:
        if not hasattr(self.service, "_config"):
            return
        self.service._config.start_sound_file = ""


class PyQtAudioAdapterService:
    """Service for creating and managing PyQt audio adapters.
    
    This service provides a clean interface for creating PyQt-enabled
    audio recording adapters with proper signal integration.
    """

    def create_adapter(self, audio_to_text_instance: AudioToTextService,
    ) -> PyQtAudioAdapter:
        """Create a PyQt adapter for an AudioToTextService instance."""
        return PyQtAudioAdapter(audio_to_text_instance)

    def create_adapter_with_factory(
        self,
        transcriber: Any,
        vad: Any,
        rec_key: str | None = None,
        error_callback: Callable | None = None,
    ) -> PyQtAudioAdapter:
        """Create a PyQt adapter using the hexagonal AudioToTextService."""
        service = AudioToTextService(
            config=AudioToTextConfig(rec_key=rec_key or ""),
            transcriber=transcriber,
            vad=vad,
        )
        # Hotkey registration is controlled explicitly via capture_keys from the adapter
        return self.create_adapter(service)


class PyQtAudioAdapterManager:
    """High-level manager for PyQt audio adapter operations.
    
    This manager provides a simplified interface for common audio adapter
    patterns and lifecycle management.
    """

    def __init__(self):
        """Initialize the adapter manager."""
        self._service = PyQtAudioAdapterService()
        self._active_adapters: list[PyQtAudioAdapter] = []

    def create_recording_adapter(
        self,
        model_cls: type,
        vad_cls: type,
        rec_key: str | None = None,
        error_callback: Callable | None = None,
    ) -> PyQtAudioAdapter:
        """Create and register a recording adapter.
        
        Args:
            model_cls: The model class for transcription
            vad_cls: The VAD class for voice activity detection
            rec_key: The recording key binding
            error_callback: Optional error callback function
            
        Returns:
            A configured PyQtAudioAdapter
        """
        adapter = self._service.create_adapter_with_factory(
            model_cls, vad_cls, rec_key, error_callback,
        )
        self._active_adapters.append(adapter)
        return adapter

    def cleanup_adapters(self) -> None:
        """Clean up all active adapters."""
        for adapter in self._active_adapters:
            if hasattr(adapter, "shutdown"):
                adapter.shutdown()
        self._active_adapters.clear()

    def get_active_adapters(self) -> list[PyQtAudioAdapter]:
        """Get all active adapters.
        
        Returns:
            List of active PyQtAudioAdapter instances
        """
        return self._active_adapters.copy()