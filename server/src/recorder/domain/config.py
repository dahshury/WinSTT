from __future__ import annotations

import logging
import platform
from typing import Any, ClassVar

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
    # Peak-normalize audio to ~0.95 before Silero VAD + Whisper. Quiet mics
    # (peak around 0.1-0.2) otherwise get rejected by Silero's confidence
    # threshold and the entire utterance is dropped. Costs one O(n) numpy
    # pass per transcribe — negligible.
    normalize_audio: bool = True
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


class EndpointConfig(StrictMutableModel):
    smart_endpoint_enabled: bool = False
    detection_speed: float = 1.5
    smart_endpoint_model: str = "KoljaB/SentenceFinishedClassification"


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
    endpoint: EndpointConfig = Field(default_factory=EndpointConfig)

    # Sub-config classes in priority order: a kwarg is routed to the first
    # class that declares a matching field (preserves the original
    # if/elif precedence in from_kwargs).
    _SUBCONFIGS: ClassVar[tuple[type[StrictMutableModel], ...]] = (
        AudioConfig,
        VADConfig,
        TranscriptionConfig,
        RealtimeConfig,
        WakeWordConfig,
        UIConfig,
        EndpointConfig,
    )

    @staticmethod
    def _field_owner_index(
        subconfigs: tuple[type[StrictMutableModel], ...],
    ) -> dict[str, int]:
        """Map each field name to the index of its first owning sub-config.

        Iterating in reverse so that an earlier sub-config wins when a
        field name is shared, preserving the original if/elif precedence.
        """
        owner: dict[str, int] = {}
        for index in reversed(range(len(subconfigs))):
            owner.update(dict.fromkeys(subconfigs[index].model_fields, index))
        return owner

    @staticmethod
    def _empty_buckets(count: int) -> list[dict[str, Any]]:
        """Allocate ``count`` independent empty kwarg buckets."""
        return [{} for _ in range(count)]

    @classmethod
    def _route_kwargs(
        cls,
        kwargs: dict[str, Any],
        subconfigs: tuple[type[StrictMutableModel], ...],
    ) -> list[dict[str, Any]]:
        """Bucket each kwarg into the first sub-config that declares it.

        Unknown kwargs (no matching field) are dropped, matching the
        original behaviour.
        """
        owner = cls._field_owner_index(subconfigs)
        buckets = cls._empty_buckets(len(subconfigs))
        for key, value in kwargs.items():
            index = owner.get(key)
            if index is not None:
                buckets[index][key] = value
        return buckets

    @classmethod
    def from_kwargs(cls, **kwargs: Any) -> RecorderConfig:  # noqa: ANN401
        audio_kw, vad_kw, transcription_kw, realtime_kw, wake_word_kw, ui_kw, endpoint_kw = cls._route_kwargs(
            kwargs, cls._SUBCONFIGS
        )
        return cls(
            audio=AudioConfig(**audio_kw),
            vad=VADConfig(**vad_kw),
            transcription=TranscriptionConfig(**transcription_kw),
            realtime=RealtimeConfig(**realtime_kw),
            wake_word=WakeWordConfig(**wake_word_kw),
            ui=UIConfig(**ui_kw),
            endpoint=EndpointConfig(**endpoint_kw),
        )
