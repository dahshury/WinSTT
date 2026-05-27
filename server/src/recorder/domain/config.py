from __future__ import annotations

import logging
import platform
from typing import Any, ClassVar

from pydantic import BaseModel, Field, field_validator

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
    # When ``True``, the OS microphone stream is opened at server boot and
    # stays allocated for the entire session — fastest possible PTT response
    # (no PortAudio probe latency on each press) but the OS mic-in-use
    # indicator stays lit whenever the app is running. When ``False`` (the
    # default, matching Handy's ``always_on_microphone`` design): boot does
    # not open any stream, the first PTT press opens one lazily, PTT release
    # tears it down so the OS sees the mic as released. The trade-off is
    # ~10-50 ms of extra latency on each PTT press (the open-stream cost on
    # Windows WASAPI) which the pre-roll buffer covers for typical speech.
    always_on_microphone: bool = False
    # Only consulted when ``always_on_microphone`` is False. When ``True``,
    # PTT release schedules a delayed close after ``lazy_close_timeout_seconds``
    # rather than closing immediately, so rapid PTT cycles don't pay the
    # per-press open cost. Matches Handy's ``lazy_stream_close`` knob — it's
    # a debounce for users who PTT frequently but still want the mic
    # released during longer idle periods. ``False`` (default) is "release
    # immediately on release."
    lazy_stream_close: bool = False
    # Idle window before the lazy-close timer fires. The renderer's
    # consolidated "Microphone Release" picker maps its enum values
    # (sec30 / min1 / min5) to this number of seconds. Only consulted
    # when ``lazy_stream_close=True``. Default 30 s matches Handy's
    # ``STREAM_IDLE_TIMEOUT`` constant.
    lazy_close_timeout_seconds: float = 30.0
    # Tail-of-recording capture window in ms, applied after the user
    # releases PTT (or otherwise calls set_microphone(False) while a
    # recording is in progress). The mic keeps capturing for this many
    # ms before the pause+stop sequence runs, so trailing syllables that
    # leave the lips just after the key-up still land in the buffer.
    # Mirrors Handy's ``extra_recording_buffer_ms``. ``0`` (default) is
    # off; capped at 2000 ms so a bad value can't lock the recorder.
    # Only applies to user-driven stops (set_microphone path); VAD
    # silence endpoints already consume ``post_speech_silence_duration``.
    extra_recording_buffer_ms: int = Field(default=0, ge=0, le=2000)


class VADConfig(StrictMutableModel):
    # Trip threshold = ``1 - silero_sensitivity`` (see
    # :meth:`SileroVad.detect`). Default 0.7 ⇒ speech trips at Silero
    # probability > 0.3, matching Handy's hardcoded value (see
    # ``examples/Handy/src-tauri/src/managers/audio.rs::SileroVad::new``).
    # The previous 0.4 default (⇒ trip > 0.6) was the root cause of
    # quiet/distant voice being dropped entirely: Silero's confidence on
    # far-mic speech routinely lands in the 0.3-0.6 band, and 0.4 sits
    # exactly on the wrong side of that. Per-device adaptive calibration
    # (``sileroSensitivityByDeviceName``) still adapts from this new
    # baseline. Raising the value back toward 1.0 if a specific mic is
    # over-triggering on noise is the supported escape hatch.
    silero_sensitivity: float = Field(default=0.7, ge=0.0, le=1.0)
    silero_use_onnx: bool = False
    silero_deactivity_detection: bool = False
    webrtc_sensitivity: int = Field(default=3, ge=0, le=3)
    # Consecutive speech chunks required before VAD onset starts a recording.
    # A lone noisy chunk (key click, desk thump, fan transient) that briefly
    # fools BOTH WebRTC and Silero must not pop the overlay pill or wake the
    # Whisper model — only sustained speech should. The pre-roll buffer
    # (``pre_recording_buffer_duration``) backfills the onset audio that
    # elapses while debouncing, so this costs no transcription quality.
    # ``1`` restores the legacy behaviour (start on the first speech chunk).
    # At buffer_size=512 @ 16 kHz a chunk is ~32 ms, so 3 ≈ ~96 ms of
    # sustained speech — short enough not to clip real onsets, long enough
    # to reject impulsive non-speech noise. Only affects the server-driven
    # VAD-onset path (toggle / listen / wakeword); PTT force-starts and is
    # unaffected.
    speech_onset_consecutive_chunks: int = Field(default=3, ge=1)
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
    # "auto" probes CUDA at runtime and falls back to CPU when its DLL chain
    # isn't actually loadable (see :func:`device.resolve_device`). "cuda" /
    # "cpu" still pin the device explicitly; persisted configs from before
    # the "auto" default landed continue to work.
    device: str = "auto"
    # User-facing accelerator preference. "auto" walks the per-OS priority
    # list (Windows: DirectML > CUDA > CPU; Linux: CUDA > ROCm > CPU; macOS:
    # CoreML > CPU). Explicit values pin a specific EP — "cuda", "directml",
    # "rocm", "coreml", "cpu" — and fall back to CPU with a log line when
    # that EP isn't registered with the bundled onnxruntime wheel. Lets
    # power users override the default DirectML choice on Windows without
    # touching the legacy ``device`` field. See
    # :func:`device.resolve_accelerator`.
    accelerator: str = "auto"
    initial_prompt: str | list[int] | None = None
    # Peak-normalize audio to ~0.95 before Silero VAD + Whisper. Quiet mics
    # (peak around 0.1-0.2) otherwise get rejected by Silero's confidence
    # threshold and the entire utterance is dropped. Costs one O(n) numpy
    # pass per transcribe — negligible.
    normalize_audio: bool = True
    print_transcription_time: bool = False
    early_transcription_on_silence: float = 0
    allowed_latency_limit: int = 100
    backend: str = ""
    # "auto" picks fp16 when the resolved device is CUDA AND the model
    # actually ships an fp16 ONNX (most onnx-community Whisper repos do);
    # otherwise falls back to fp32. Empty string is treated as auto for
    # backward compatibility with configs persisted before the default
    # changed. Concrete sub-fp16 values (int8/q4/q4f16/bnb4/uint8) work
    # only on the CPU device — they fall back to fp32 with a warning on
    # CUDA per :func:`bootstrap._resolve_quantization`.
    onnx_quantization: str = "auto"
    # Whisper-native task=translate. When True AND the active model is a
    # multilingual Whisper variant, the decoder prompt's ``<|transcribe|>``
    # token gets swapped for ``<|translate|>`` so non-English audio is
    # translated to English in a single decode (no LLM hop, no extra
    # latency). Other backends (NeMo, GigaAM, Moonshine, *.en Whispers)
    # silently no-op with a warning. Mirrors Handy's
    # ``translate_to_english``.
    translate_to_english: bool = False
    # Idle-timeout that unloads the loaded ONNX session(s) to free RAM/
    # VRAM. Three modes mirroring Handy's ``ModelUnloadTimeout`` enum:
    #
    #   * ``None``         — keep the model resident forever
    #                        (Handy's ``Never`` option)
    #   * ``0``            — tear down immediately after every
    #                        transcription (Handy's ``Immediately``);
    #                        every PTT pays the cold-load cost but
    #                        memory returns to the OS between presses
    #   * positive ``int`` — idle seconds before tear-down; default 300
    #                        (5 min) matches Handy's default
    #
    # The next transcription after a tear-down synchronously reloads
    # the saved model on the foreground thread.
    model_unload_timeout_seconds: int | None = 300


class RealtimeConfig(StrictMutableModel):
    enable_realtime_transcription: bool = False
    use_main_model_for_realtime: bool = False
    realtime_model_type: str = "tiny"
    # 0.1s makes the preview ~2x more responsive than the 0.2s default; the
    # RealtimeSTT WASAPI reference uses 0.01s but that assumes ctranslate2 +
    # tiny.en which is faster than our ONNX path, so 0.1s is the safe knee.
    realtime_processing_pause: float = 0.1
    init_realtime_after_seconds: float = 0.2
    initial_prompt_realtime: str | list[int] | None = None


# Sentinel values that mean "no wake-word backend". The server CLI defaults
# `--wakeword_backend` to the literal string "none" (argparse can't express
# "absent"), and historically "default"/"" have also meant off. Normalising
# them all to "" in one place keeps every downstream check honest —
# crucially `bool(config.wake_word.wakeword_backend)` in the pipeline, which
# would otherwise treat the 4-char string "none" as True and wrongly arm
# wake-word mode for PTT/toggle/listen.
_WAKEWORD_OFF_SENTINELS = frozenset({"", "none", "default"})


class WakeWordConfig(StrictMutableModel):
    wakeword_backend: str = ""
    openwakeword_model_paths: str | None = None
    openwakeword_inference_framework: str = "onnx"
    wake_words: str = ""
    wake_words_sensitivity: float = Field(default=0.6, ge=0.0, le=1.0)
    wake_word_activation_delay: float = 0.0
    wake_word_timeout: float = 5.0
    wake_word_buffer_duration: float = 0.1

    @field_validator("wakeword_backend", mode="before")
    @classmethod
    def _normalise_wakeword_backend(cls, raw: object) -> str:
        """Collapse all "off" sentinels to ``""``.

        The CLI defaults ``--wakeword_backend`` to the literal string
        ``"none"``; ``bool("none")`` is ``True``, so a naive truthiness
        check would wrongly arm wake-word mode for every PTT/toggle/listen
        session. ``None``, ``""``, ``"none"`` and ``"default"`` (any case,
        surrounding whitespace ignored) all mean "no wake-word backend".
        Real backend names are trimmed but **not** lowercased — the facade
        matches them against the registry's exact keys.
        """
        if raw is None:
            return ""
        text = str(raw).strip()
        if text.lower() in {"", "none", "default"}:
            return ""
        return text


class EndpointConfig(StrictMutableModel):
    smart_endpoint_enabled: bool = False
    detection_speed: float = 1.5
    smart_endpoint_model: str = "KoljaB/SentenceFinishedClassification"


class DiarizationConfig(StrictMutableModel):
    """Per-utterance speaker diarization with session-wide identity tracking.

    When ``enabled``, the recorder runs each completed utterance's audio through
    ``onnx_asr.SessionDiarizer`` and publishes a :class:`SpeakerSegmentsDetected`
    event right after :class:`TranscriptionCompleted`. Adds ~35 MB to the bundle
    (pyannote-segmentation-3.0 + wespeaker-voxceleb-resnet34-LM) on first use.
    """

    enabled: bool = False
    max_speakers: int = Field(default=8, ge=1, le=50)
    # Cosine-distance cutoff for the online clusterer: a new embedding within
    # this distance of an existing centroid is matched; otherwise a fresh
    # speaker ID is minted. 0.5 is calibrated for wespeaker-resnet34-LM.
    delta_new: float = Field(default=0.5, ge=0.0, le=2.0)
    # Minimum per-segment active-frame ratio to update a centroid (avoids
    # corrupting clean centroids with noisy short crops).
    rho_update: float = Field(default=0.3, ge=0.0, le=1.0)
    segmentation_model: str = "onnx-community/pyannote-segmentation-3.0"
    embedding_model: str = "wespeaker-voxceleb-resnet34-LM"


class TextCorrectionConfig(StrictMutableModel):
    """Deterministic post-ASR fuzzy correction settings.

    The runtime applies :func:`src.recorder.text.dictionary.apply_custom_words`
    right after ASR finishes and before the per-sentence cleanup
    (capitalisation, trailing period). When ``custom_words`` is empty the
    correction is a no-op fast path. ``threshold`` is forwarded to the
    matcher verbatim — 0.18 is the value Handy's reference implementation
    ships, see ``examples/Handy/src-tauri/src/audio_toolkit/text.rs``.

    This layer runs BEFORE any LLM modifier pipeline (the LLM step lives
    in the Electron main process), so the LLM still sees post-dictionary
    text and can fix anything the deterministic pass missed.
    """

    custom_words: list[str] = Field(default_factory=list)
    threshold: float = Field(default=0.18, ge=0.0, le=1.0)
    # Locale-aware filler-word stripping + 3+ consecutive stutter
    # collapse. Mirrors Handy's ``filter_transcription_output``. When
    # ``True`` (the default) the post-processor consults
    # ``custom_filler_words`` first; if that's empty it falls back to
    # the language table in ``filler_filter.FILLERS_BY_LANG`` keyed on
    # the transcription's detected language (with the configured
    # ``TranscriptionConfig.language`` as a fallback when the
    # detection is empty). Tokens that are real words in some locales
    # (``"um"`` in Portuguese, ``"ha"`` in Spanish) are already
    # excluded from the relevant tables.
    filter_fillers: bool = True
    # Optional override for the per-language disfluency table. Empty
    # (the default) means "use the language table"; a non-empty list
    # replaces it verbatim. To disable filler removal without changing
    # ``filter_fillers``, set this to a single sentinel string the user
    # would never say — typically simpler to just flip
    # ``filter_fillers`` off instead.
    custom_filler_words: list[str] = Field(default_factory=list)


class UIConfig(StrictMutableModel):
    spinner: bool = True
    ensure_sentence_starting_uppercase: bool = True
    ensure_sentence_ends_with_period: bool = True
    debug_mode: bool = False
    level: int = logging.WARNING
    no_log_file: bool = False
    use_extended_logging: bool = False
    start_callback_in_new_thread: bool = False


class HistoryConfig(StrictMutableModel):
    """Server-side knobs for the SQLite transcription-history sidecar.

    The recorder doesn't open the SQLite DB itself — that lives in the
    Electron main process where it can be paged on demand. What the recorder
    DOES do, when ``save_wav`` is true, is dump the just-transcribed PCM to a
    WAV file under ``recordings_dir`` and surface the absolute path on the
    :class:`TranscriptionCompleted` event so the IPC relay can persist a
    matching history row. Disabled by default — opt-in costs disk + the
    one-shot write per utterance.

    ``recordings_dir`` is resolved by the facade against
    ``app.getPath("userData")/recordings`` on Electron's behalf; in standalone
    server runs it falls back to the OS temp dir so a dev test launch doesn't
    write into a user's real data folder.
    """

    save_wav: bool = False
    recordings_dir: str = ""


class RecorderConfig(StrictMutableModel):
    audio: AudioConfig = Field(default_factory=AudioConfig)
    vad: VADConfig = Field(default_factory=VADConfig)
    transcription: TranscriptionConfig = Field(default_factory=TranscriptionConfig)
    realtime: RealtimeConfig = Field(default_factory=RealtimeConfig)
    wake_word: WakeWordConfig = Field(default_factory=WakeWordConfig)
    ui: UIConfig = Field(default_factory=UIConfig)
    endpoint: EndpointConfig = Field(default_factory=EndpointConfig)
    diarization: DiarizationConfig = Field(default_factory=DiarizationConfig)
    text_correction: TextCorrectionConfig = Field(default_factory=TextCorrectionConfig)
    history: HistoryConfig = Field(default_factory=HistoryConfig)

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
        DiarizationConfig,
        TextCorrectionConfig,
        HistoryConfig,
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
        (
            audio_kw,
            vad_kw,
            transcription_kw,
            realtime_kw,
            wake_word_kw,
            ui_kw,
            endpoint_kw,
            diarization_kw,
            text_correction_kw,
            history_kw,
        ) = cls._route_kwargs(kwargs, cls._SUBCONFIGS)
        return cls(
            audio=AudioConfig(**audio_kw),
            vad=VADConfig(**vad_kw),
            transcription=TranscriptionConfig(**transcription_kw),
            realtime=RealtimeConfig(**realtime_kw),
            wake_word=WakeWordConfig(**wake_word_kw),
            ui=UIConfig(**ui_kw),
            endpoint=EndpointConfig(**endpoint_kw),
            diarization=DiarizationConfig(**diarization_kw),
            text_correction=TextCorrectionConfig(**text_correction_kw),
            history=HistoryConfig(**history_kw),
        )
