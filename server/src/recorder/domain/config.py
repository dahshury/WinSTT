from __future__ import annotations

import logging
import platform
from typing import Any

from pydantic import BaseModel, Field

INIT_HANDLE_BUFFER_OVERFLOW = platform.system() != "Darwin"


class StrictMutableModel(BaseModel):
    """Base for all config models: strict type checking, mutable fields."""

    model_config = {"frozen": False, "strict": True}


class AudioConfig(StrictMutableModel):
    input_device_index: int | None = None
    sample_rate: int = 16000
    buffer_size: int = 512
    use_microphone: bool = True
    handle_buffer_overflow: bool = INIT_HANDLE_BUFFER_OVERFLOW


class VADConfig(StrictMutableModel):

    silero_sensitivity: float = Field(default=0.4, ge=0.0, le=1.0)
    silero_use_onnx: bool = False
    silero_deactivity_detection: bool = False
    webrtc_sensitivity: int = Field(default=3, ge=0, le=3)
    post_speech_silence_duration: float = 0.6
    min_length_of_recording: float = 0.5
    min_gap_between_recordings: float = 0.0
    pre_recording_buffer_duration: float = 1.0


class TranscriptionConfig(StrictMutableModel):
    model: str = "tiny"
    download_root: str | None = None
    language: str = ""
    compute_type: str = "default"
    gpu_device_index: int | list[int] = 0
    device: str = "cuda"
    beam_size: int = 5
    initial_prompt: str | list[int] | None = None
    suppress_tokens: list[int] | None = Field(default_factory=lambda: [-1])
    batch_size: int = 16
    faster_whisper_vad_filter: bool = True
    normalize_audio: bool = False
    print_transcription_time: bool = False
    early_transcription_on_silence: float = 0
    allowed_latency_limit: int = 100
    backend: str = ""
    onnx_quantization: str = ""


class RealtimeConfig(StrictMutableModel):
    enable_realtime_transcription: bool = False
    use_main_model_for_realtime: bool = False
    realtime_model_type: str = "tiny"
    realtime_processing_pause: float = 0.2
    init_realtime_after_seconds: float = 0.2
    beam_size_realtime: int = 3
    realtime_batch_size: int = 16
    initial_prompt_realtime: str | list[int] | None = None


class WakeWordConfig(StrictMutableModel):
    wakeword_backend: str = ""
    openwakeword_model_paths: str | None = None
    openwakeword_inference_framework: str = "onnx"
    wake_words: str = ""
    wake_words_sensitivity: float = Field(default=0.6, ge=0.0, le=1.0)
    wake_word_activation_delay: float = 0.0
    wake_word_timeout: float = 5.0
    wake_word_buffer_duration: float = 0.1


class UIConfig(StrictMutableModel):
    spinner: bool = True
    ensure_sentence_starting_uppercase: bool = True
    ensure_sentence_ends_with_period: bool = True
    debug_mode: bool = False
    level: int = logging.WARNING
    no_log_file: bool = False
    use_extended_logging: bool = False
    start_callback_in_new_thread: bool = False


class RecorderConfig(StrictMutableModel):
    audio: AudioConfig = Field(default_factory=AudioConfig)
    vad: VADConfig = Field(default_factory=VADConfig)
    transcription: TranscriptionConfig = Field(default_factory=TranscriptionConfig)
    realtime: RealtimeConfig = Field(default_factory=RealtimeConfig)
    wake_word: WakeWordConfig = Field(default_factory=WakeWordConfig)
    ui: UIConfig = Field(default_factory=UIConfig)

    @classmethod
    def from_kwargs(cls, **kwargs: Any) -> RecorderConfig:  # noqa: ANN401
        audio_fields = set(AudioConfig.model_fields.keys())
        vad_fields = set(VADConfig.model_fields.keys())
        transcription_fields = set(TranscriptionConfig.model_fields.keys())
        realtime_fields = set(RealtimeConfig.model_fields.keys())
        wake_word_fields = set(WakeWordConfig.model_fields.keys())
        ui_fields = set(UIConfig.model_fields.keys())

        audio_kwargs: dict[str, Any] = {}
        vad_kwargs: dict[str, Any] = {}
        transcription_kwargs: dict[str, Any] = {}
        realtime_kwargs: dict[str, Any] = {}
        wake_word_kwargs: dict[str, Any] = {}
        ui_kwargs: dict[str, Any] = {}

        for key, value in kwargs.items():
            if key in audio_fields:
                audio_kwargs[key] = value
            elif key in vad_fields:
                vad_kwargs[key] = value
            elif key in transcription_fields:
                transcription_kwargs[key] = value
            elif key in realtime_fields:
                realtime_kwargs[key] = value
            elif key in wake_word_fields:
                wake_word_kwargs[key] = value
            elif key in ui_fields:
                ui_kwargs[key] = value

        return cls(
            audio=AudioConfig(**audio_kwargs),
            vad=VADConfig(**vad_kwargs),
            transcription=TranscriptionConfig(**transcription_kwargs),
            realtime=RealtimeConfig(**realtime_kwargs),
            wake_word=WakeWordConfig(**wake_word_kwargs),
            ui=UIConfig(**ui_kwargs),
        )
