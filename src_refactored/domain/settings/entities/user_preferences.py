"""User preferences aggregate root for settings domain."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from src_refactored.domain.common import AggregateRoot
from src_refactored.domain.settings.value_objects.audio_configuration import AudioConfiguration
from src_refactored.domain.settings.value_objects.file_path import AudioFilePath
from src_refactored.domain.settings.value_objects.key_combination import KeyCombination
from src_refactored.domain.settings.value_objects.llm_configuration import LLMConfiguration
from src_refactored.domain.settings.value_objects.model_configuration import (
    ModelConfiguration,
    ModelType,
    Quantization,
)


@dataclass
class UserPreferences(AggregateRoot):
    """Aggregate root for user preferences and settings."""

    recording_key: KeyCombination
    model_config: ModelConfiguration
    llm_config: LLMConfiguration
    audio_config: AudioConfiguration
    output_srt_enabled: bool = True

    def __post_init__(self):
        """Initialize the aggregate root."""
        super().__post_init__()
        self._validate_preferences()

    def _validate_preferences(self):
        """Validate the overall preferences configuration."""
        # Ensure recording key is valid for hotkey usage
        if not self.recording_key.is_valid_for_recording():
            msg = "Recording key must have at least one modifier for hotkey usage"
            raise ValueError(msg)

        # Validate that audio configuration is compatible with model requirements
        if not self.audio_config.is_optimized_for_speech(,
    ) and self.model_config.model_type in [
            ModelType.WHISPER_TURBO, ModelType.LITE_WHISPER_TURBO, ModelType.LITE_WHISPER_TURBO_FAST,
        ]:
            # Log warning but don't fail - user might want different audio settings
            pass

    @classmethod
    def create_default(cls) -> UserPreferences:
        """Create default user preferences."""
        return cls(
            recording_key=KeyCombination.from_string("CTRL+SHIFT+R")
            model_config=ModelConfiguration(
                model_type=ModelType.LITE_WHISPER_TURBO,
                quantization=Quantization.QUANTIZED,
                use_gpu=True,
            )
            llm_config=LLMConfiguration.create_default()
            audio_config=AudioConfiguration.create_default()
            output_srt_enabled=True,
        )

    def update_recording_key(self, new_key: KeyCombination,
    ) -> None:
        """Update the recording key combination."""
        if not new_key.is_valid_for_recording():
            msg = "Recording key must have at least one modifier"
            raise ValueError(msg)

        old_key = self.recording_key
        self.recording_key = new_key

        # Add domain event
        from src_refactored.domain.common.events import DomainEvent
        self.add_domain_event(DomainEvent(
            event_type="RECORDING_KEY_CHANGED",
            source=self,
            data={"old_key": old_key.to_string(), "new_key": new_key.to_string()},
        ))

        self.mark_as_updated()

    def update_model_configuration(self, new_config: ModelConfiguration,
    ) -> None:
        """Update the model configuration."""
        old_config = self.model_config
        self.model_config = new_config

        # Add domain event
        from src_refactored.domain.common.events import DomainEvent
        self.add_domain_event(DomainEvent(
            event_type="MODEL_CONFIGURATION_CHANGED",
            source=self,
            data={
                "old_model": old_config.model_type.value,
                "new_model": new_config.model_type.value,
                "old_quantization": old_config.quantization.value,
                "new_quantization": new_config.quantization.value,
            },
        ))

        self.mark_as_updated()

    def update_llm_configuration(self, new_config: LLMConfiguration,
    ) -> None:
        """Update the LLM configuration."""
        old_config = self.llm_config
        self.llm_config = new_config

        # Add domain event
        from src_refactored.domain.common.events import DomainEvent
        self.add_domain_event(DomainEvent(
            event_type="LLM_CONFIGURATION_CHANGED",
            source=self,
            data={
                "old_enabled": old_config.enabled,
                "new_enabled": new_config.enabled,
                "old_model": old_config.model_name,
                "new_model": new_config.model_name,
            },
        ))

        self.mark_as_updated()

    def update_audio_configuration(self, new_config: AudioConfiguration,
    ) -> None:
        """Update the audio configuration."""
        old_config = self.audio_config
        self.audio_config = new_config

        # Add domain event
        from src_refactored.domain.common.events import DomainEvent
        self.add_domain_event(DomainEvent(
            event_type="AUDIO_CONFIGURATION_CHANGED",
            source=self,
            data={
                "old_sample_rate": old_config.sample_rate,
                "new_sample_rate": new_config.sample_rate,
                "old_recording_sound_enabled": old_config.recording_sound_enabled,
                "new_recording_sound_enabled": new_config.recording_sound_enabled,
            },
        ))

        self.mark_as_updated()

    def toggle_output_srt(self) -> None:
        """Toggle SRT output setting."""
        old_value = self.output_srt_enabled
        self.output_srt_enabled = not self.output_srt_enabled

        # Add domain event
        from src_refactored.domain.common.events import DomainEvent
        self.add_domain_event(DomainEvent(
            event_type="OUTPUT_SRT_TOGGLED",
            source=self,
            data={"old_value": old_value, "new_value": self.output_srt_enabled},
        ))

        self.mark_as_updated()

    def enable_llm_processing(self) -> None:
        """Enable LLM text processing."""
        if not self.llm_config.enabled:
            self.llm_config = self.llm_config.with_enabled(True)

            # Add domain event
            from src_refactored.domain.common.events import DomainEvent
            self.add_domain_event(DomainEvent(
                event_type="LLM_PROCESSING_ENABLED",
                source=self,
                data={"model_name": self.llm_config.model_name},
            ))

            self.mark_as_updated()

    def disable_llm_processing(self) -> None:
        """Disable LLM text processing."""
        if self.llm_config.enabled:
            self.llm_config = self.llm_config.with_enabled(False)

            # Add domain event
            from src_refactored.domain.common.events import DomainEvent
            self.add_domain_event(DomainEvent(
                event_type="LLM_PROCESSING_DISABLED",
                source=self,
                data={"model_name": self.llm_config.model_name},
            ))

            self.mark_as_updated()

    def is_ready_for_transcription(self) -> bool:
        """Check if preferences are configured for transcription."""
        return (
            self.recording_key.is_valid_for_recording() and
            self.model_config is not None and
            self.audio_config is not None
        )

    def get_estimated_model_download_size(self) -> int:
        """Get estimated download size for current model configuration."""
        total_size = self.model_config.estimated_size_mb

        if self.llm_config.enabled:
            # Add estimated LLM model size (rough estimate)
            llm_size = 3000 if self.llm_config.quantization == Quantization.FULL else 1500
            total_size += llm_size

        return total_size

    def to_dict(self) -> dict[str, Any]:
        """Convert preferences to dictionary for serialization."""
        return {
            "recording_key": self.recording_key.to_string()
            "model_type": self.model_config.model_type.value,
            "model_quantization": self.model_config.quantization.value,
            "model_use_gpu": self.model_config.use_gpu,
            "model_max_memory": self.model_config.max_memory,
            "llm_enabled": self.llm_config.enabled,
            "llm_model_name": self.llm_config.model_name,
            "llm_quantization": self.llm_config.quantization.value,
            "llm_system_prompt": self.llm_config.system_prompt,
            "llm_max_tokens": self.llm_config.max_tokens,
            "llm_temperature": self.llm_config.temperature,
            "audio_sample_rate": self.audio_config.sample_rate,
            "audio_channels": self.audio_config.channels,
            "audio_bit_depth": self.audio_config.bit_depth,
            "audio_buffer_size": self.audio_config.buffer_size,
            "audio_noise_reduction": self.audio_config.enable_noise_reduction,
            "audio_recording_sound_enabled": self.audio_config.recording_sound_enabled,
            "audio_recording_sound_path": str(self.audio_config.recording_sound_path) if self.audio_config.recording_sound_path else None,
            "output_srt_enabled": self.output_srt_enabled,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> UserPreferences:
        """Create preferences from dictionary."""
        # Parse recording key
        recording_key = KeyCombination.from_string(data.get("recording_key", "CTRL+SHIFT+R"))

        # Parse model configuration
        model_config = ModelConfiguration(
            model_type=ModelType.from_string(data.get("model_type", "lite-whisper-turbo")),
            quantization=Quantization.from_string(data.get("model_quantization", "Quantized")),
            use_gpu=data.get("model_use_gpu", True)
            max_memory=data.get("model_max_memory"),
        )

        # Parse LLM configuration
        llm_config = LLMConfiguration(
            model_name=data.get("llm_model_name", "llama-3.2-3b-instruct")
            quantization=Quantization.from_string(data.get("llm_quantization", "Quantized")),
system_prompt = (
    data.get("llm_system_prompt", LLMConfiguration.create_default().system_prompt),)
            max_tokens=data.get("llm_max_tokens", 512)
            temperature=data.get("llm_temperature", 0.7)
            enabled=data.get("llm_enabled", False),
        )

        # Parse audio configuration
        recording_sound_path = None
        if data.get("audio_recording_sound_path"):
            recording_sound_path = AudioFilePath(path=data["audio_recording_sound_path"])

        audio_config = AudioConfiguration(
            sample_rate=data.get("audio_sample_rate", 16000)
            channels=data.get("audio_channels", 1)
            bit_depth=data.get("audio_bit_depth", 16)
            buffer_size=data.get("audio_buffer_size", 1024)
            enable_noise_reduction=data.get("audio_noise_reduction", True)
            recording_sound_enabled=data.get("audio_recording_sound_enabled", False)
            recording_sound_path=recording_sound_path,
        )

        return cls(
            recording_key=recording_key,
            model_config=model_config,
            llm_config=llm_config,
            audio_config=audio_config,
            output_srt_enabled=data.get("output_srt_enabled", True),
        )