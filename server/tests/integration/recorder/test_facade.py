from __future__ import annotations

import struct
import threading
import time

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.recorder import AudioToTextRecorder
from src.recorder.application.recorder_service import RecorderService
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.ports.transcriber import TranscriptionResult
from tests.fakes.fake_audio_source import FakeAudioSource
from tests.fakes.fake_transcriber import FakeTranscriber
from tests.fakes.fake_vad import FakeVAD


def _make_chunk(value: int = 100, size: int = 512) -> bytes:
    return struct.pack(f"<{size}h", *([value] * size))


def _make_facade_with_fakes(
    transcription_text: str = "hello world",
) -> AudioToTextRecorder:
    """Create a facade backed by fakes for testing."""
    config = RecorderConfig.from_kwargs(
        use_microphone=False,
        post_speech_silence_duration=0.05,
        # Facade delegation test, not the speech-onset debounce — keep
        # legacy single-chunk start so the single-True pattern records.
        speech_onset_consecutive_chunks=1,
    )
    transcriber = FakeTranscriber(
        result=TranscriptionResult(
            text=transcription_text,
            language="en",
            language_probability=0.99,
            duration_seconds=1.0,
        )
    )
    service = RecorderService(
        audio_source=FakeAudioSource(),
        vad=FakeVAD(speech_pattern=[True] + [False] * 20),
        transcriber=transcriber,
        config=config,
        event_bus=EventBus(),
        clock=Clock.system_clock(),
    )
    return AudioToTextRecorder._create_with_service(service, config)


class TestAudioToTextRecorderFacade:
    def test_accepts_all_original_params(self) -> None:
        """Verify constructor signature matches the monolith."""
        recorder = AudioToTextRecorder(
            model="tiny",
            download_root=None,
            language="en",
            compute_type="default",
            input_device_index=None,
            gpu_device_index=0,
            device="cuda",
            on_recording_start=lambda: None,
            on_recording_stop=lambda: None,
            on_transcription_start=lambda: None,
            ensure_sentence_starting_uppercase=True,
            ensure_sentence_ends_with_period=True,
            use_microphone=False,
            spinner=False,
            level=30,
            enable_realtime_transcription=False,
            use_main_model_for_realtime=False,
            realtime_model_type="tiny",
            realtime_processing_pause=0.2,
            init_realtime_after_seconds=0.2,
            on_realtime_transcription_update=None,
            on_realtime_transcription_stabilized=None,
            silero_sensitivity=0.4,
            silero_use_onnx=False,
            silero_deactivity_detection=False,
            webrtc_sensitivity=3,
            post_speech_silence_duration=0.6,
            min_gap_between_recordings=0.0,
            pre_recording_buffer_duration=1.0,
            on_vad_start=None,
            on_vad_stop=None,
            on_vad_detect_start=None,
            on_vad_detect_stop=None,
            on_turn_detection_start=None,
            on_turn_detection_stop=None,
            wakeword_backend="",
            openwakeword_model_paths=None,
            openwakeword_inference_framework="onnx",
            wake_words="",
            wake_words_sensitivity=0.6,
            wake_word_activation_delay=0.0,
            wake_word_timeout=5.0,
            wake_word_buffer_duration=0.1,
            on_wakeword_detected=None,
            on_wakeword_timeout=None,
            on_wakeword_detection_start=None,
            on_wakeword_detection_end=None,
            on_recorded_chunk=None,
            debug_mode=False,
            handle_buffer_overflow=True,
            buffer_size=512,
            sample_rate=16000,
            initial_prompt=None,
            initial_prompt_realtime=None,
            print_transcription_time=False,
            early_transcription_on_silence=0,
            allowed_latency_limit=100,
            no_log_file=False,
            use_extended_logging=False,
            normalize_audio=False,
            start_callback_in_new_thread=False,
        )
        assert recorder._config.transcription.model == "tiny"

    def test_context_manager(self) -> None:
        facade = _make_facade_with_fakes()
        with facade:
            pass

    def test_delegates_start(self) -> None:
        facade = _make_facade_with_fakes()
        facade.listen()
        result = facade.start()
        assert result is facade
        facade.shutdown()

    def test_delegates_shutdown(self) -> None:
        facade = _make_facade_with_fakes()
        facade.shutdown()  # should not raise

    def test_delegates_abort(self) -> None:
        facade = _make_facade_with_fakes()
        facade.listen()
        facade.abort()
        facade.shutdown()

    def test_shutdown_when_service_is_none(self) -> None:
        """Shutdown on a facade that never initialized its service."""
        recorder = AudioToTextRecorder(use_microphone=False)
        recorder.shutdown()  # _service is None, should not raise

    def test_delegates_stop(self) -> None:
        facade = _make_facade_with_fakes()
        facade.listen()
        facade.start()
        result = facade.stop()
        assert result is facade
        facade.shutdown()

    def test_delegates_feed_audio(self) -> None:
        facade = _make_facade_with_fakes()
        facade.listen()
        facade.feed_audio(_make_chunk())
        facade.shutdown()

    def test_delegates_set_microphone(self) -> None:
        facade = _make_facade_with_fakes()
        facade.set_microphone(False)

    def test_delegates_wakeup(self) -> None:
        facade = _make_facade_with_fakes()
        facade.listen()
        facade.wakeup()
        facade.shutdown()

    def test_delegates_clear_audio_queue(self) -> None:
        facade = _make_facade_with_fakes()
        facade.clear_audio_queue()

    def test_delegates_runtime_info(self) -> None:
        facade = _make_facade_with_fakes()
        info = facade.runtime_info()
        assert isinstance(info, dict)
        assert "device" in info
        facade.shutdown()

    def test_delegates_request_model_swap(self) -> None:
        facade = _make_facade_with_fakes()
        # Realtime is disabled in the fakes config, so this is a safe no-op
        # (emits ModelSwapFailed, spawns no thread) that exercises delegation.
        facade.request_model_swap("realtime", "some-model")
        facade.shutdown()

    def test_delegates_request_diarization_toggle(self) -> None:
        # Diarization is off by default in the fakes config — disabling it
        # again is a no-op fast-path that exercises delegation without
        # depending on the OnnxAsrDiarizer infrastructure.
        facade = _make_facade_with_fakes()
        facade.request_diarization_toggle(False)
        facade.shutdown()

    def test_delegates_transcribe(self) -> None:
        facade = _make_facade_with_fakes()
        result = facade.transcribe()
        assert isinstance(result, str)

    def test_delegates_wait_audio(self) -> None:
        facade = _make_facade_with_fakes()
        facade.listen()
        # Pre-populate transcription queue so wait_audio returns immediately
        facade._service._pipeline.transcription_queue.put((True, 0.0))  # type: ignore[union-attr]
        facade.wait_audio()
        facade.shutdown()

    def test_post_speech_silence_duration_getter(self) -> None:
        """Facade property reads from service."""
        facade = _make_facade_with_fakes()
        # Config default was 0.05
        assert facade.post_speech_silence_duration == 0.05
        facade.shutdown()

    def test_post_speech_silence_duration_setter(self) -> None:
        """Facade property writes through to service."""
        facade = _make_facade_with_fakes()
        facade.post_speech_silence_duration = 2.0
        assert facade.post_speech_silence_duration == 2.0
        facade.shutdown()

    def test_silence_endpoint_enabled_getter(self) -> None:
        """Facade property reads from service."""
        facade = _make_facade_with_fakes()
        assert facade.silence_endpoint_enabled is True
        facade.shutdown()

    def test_silence_endpoint_enabled_setter(self) -> None:
        """Facade property writes through to service."""
        facade = _make_facade_with_fakes()
        facade.silence_endpoint_enabled = False
        assert facade.silence_endpoint_enabled is False
        facade.shutdown()

    def test_use_microphone_value(self) -> None:
        """use_microphone exposes .value matching config."""
        facade = _make_facade_with_fakes()
        # Config was use_microphone=False
        assert facade.use_microphone.value is False
        facade.shutdown()

    def test_use_microphone_updates_on_set_microphone(self) -> None:
        """set_microphone() also updates the use_microphone flag."""
        facade = _make_facade_with_fakes()
        assert facade.use_microphone.value is False
        facade.set_microphone(True)
        assert facade.use_microphone.value is True
        facade.set_microphone(False)
        assert facade.use_microphone.value is False
        facade.shutdown()

    def test_set_microphone_before_service_initialized(self) -> None:
        """set_microphone before lazy init just updates the flag (no model load)."""
        facade = AudioToTextRecorder(use_microphone=True)
        # _service is None at this point (lazy init)
        assert facade._service is None
        facade.set_microphone(False)
        assert facade.use_microphone.value is False
        facade.set_microphone(True)
        assert facade.use_microphone.value is True
        # Service was never created — no heavy init
        assert facade._service is None

    def test_use_microphone_bool(self) -> None:
        """_BoolFlag supports bool() conversion."""
        facade = _make_facade_with_fakes()
        assert not bool(facade.use_microphone)
        facade.set_microphone(True)
        assert bool(facade.use_microphone)
        facade.shutdown()

    def test_use_microphone_repr(self) -> None:
        """_BoolFlag has a readable repr."""
        facade = _make_facade_with_fakes()
        assert repr(facade.use_microphone) == "_BoolFlag(False)"
        facade.shutdown()

    def test_frames_property(self) -> None:
        """Facade.frames delegates to service."""
        facade = _make_facade_with_fakes()
        assert facade.frames == []
        facade.shutdown()

    def test_last_words_buffer_property(self) -> None:
        """Facade.last_words_buffer delegates to service."""
        facade = _make_facade_with_fakes()
        assert len(facade.last_words_buffer) == 0
        facade.shutdown()

    def test_wake_word_activation_delay_getter(self) -> None:
        """Facade.wake_word_activation_delay reads from service."""
        facade = _make_facade_with_fakes()
        assert facade.wake_word_activation_delay == 0.0
        facade.shutdown()

    def test_wake_word_activation_delay_setter(self) -> None:
        """Facade.wake_word_activation_delay writes through to service."""
        facade = _make_facade_with_fakes()
        facade.wake_word_activation_delay = 5.0
        assert facade.wake_word_activation_delay == 5.0
        facade.shutdown()

    def test_language_getter(self) -> None:
        """Facade.language reads from config."""
        facade = _make_facade_with_fakes()
        assert facade.language == ""
        facade.shutdown()

    def test_language_setter(self) -> None:
        """Facade.language writes through to config."""
        facade = _make_facade_with_fakes()
        facade.language = "de"
        assert facade.language == "de"
        assert facade._config.transcription.language == "de"
        facade.shutdown()

    def test_silero_sensitivity_getter(self) -> None:
        """Facade.silero_sensitivity reads from config.

        Default is now 0.7 (Silero trip threshold 0.3) to match Handy;
        see :class:`VADConfig` docstring for the rationale.
        """
        facade = _make_facade_with_fakes()
        assert facade.silero_sensitivity == 0.7
        facade.shutdown()

    def test_silero_sensitivity_setter(self) -> None:
        """Facade.silero_sensitivity writes through to config (no live VAD in test factory)."""
        facade = _make_facade_with_fakes()
        facade.silero_sensitivity = 0.8
        assert facade.silero_sensitivity == 0.8
        assert facade._config.vad.silero_sensitivity == 0.8
        facade.shutdown()

    def test_silero_sensitivity_setter_propagates_to_live_vad(self) -> None:
        """Facade.silero_sensitivity propagates to a live SileroVAD reference."""
        facade = _make_facade_with_fakes()

        class _MockSileroVAD:
            sensitivity: float = 0.4

        mock_vad = _MockSileroVAD()
        facade._silero_vad = mock_vad
        facade.silero_sensitivity = 0.7
        assert mock_vad.sensitivity == 0.7
        facade.shutdown()

    def test_initial_prompt_setter_persists_on_config(self) -> None:
        """Facade.initial_prompt writes through to transcription config.

        Wired so the WebSocket ``set_parameter`` path can push live
        dictionary-derived prompts; otherwise the renderer's
        ``installInitialPromptSync`` round-trip would be rejected by the
        ``ALLOWED_PARAMETERS`` allowlist and spam debug.log on every
        server-ready event.
        """
        facade = _make_facade_with_fakes()
        facade.initial_prompt = "vocabulary: Manuel Acme Corp"
        assert facade.initial_prompt == "vocabulary: Manuel Acme Corp"
        assert facade._config.transcription.initial_prompt == "vocabulary: Manuel Acme Corp"
        facade.shutdown()

    def test_initial_prompt_setter_normalizes_empty_string_to_none(self) -> None:
        """An empty-string push (the renderer's "clear" payload) becomes None."""
        facade = _make_facade_with_fakes()
        facade.initial_prompt = "non-empty"
        facade.initial_prompt = ""
        assert facade.initial_prompt is None
        assert facade._config.transcription.initial_prompt is None
        facade.shutdown()

    def test_initial_prompt_realtime_setter_persists_on_config(self) -> None:
        """Facade.initial_prompt_realtime writes through to realtime config."""
        facade = _make_facade_with_fakes()
        facade.initial_prompt_realtime = "rt prompt"
        assert facade.initial_prompt_realtime == "rt prompt"
        assert facade._config.realtime.initial_prompt_realtime == "rt prompt"
        facade.shutdown()

    def test_initial_prompt_realtime_setter_normalizes_empty_string_to_none(self) -> None:
        facade = _make_facade_with_fakes()
        facade.initial_prompt_realtime = "x"
        facade.initial_prompt_realtime = ""
        assert facade.initial_prompt_realtime is None
        facade.shutdown()

    def test_model_getter(self) -> None:
        """Facade.model reads from config."""
        facade = _make_facade_with_fakes()
        # Config default model for the test factory is "tiny"
        assert facade.model == "tiny"
        facade.shutdown()

    def test_model_setter_updates_config(self) -> None:
        """Facade.model setter updates config immediately."""
        facade = _make_facade_with_fakes()
        facade.model = "large-v2"
        assert facade._config.transcription.model == "large-v2"
        assert facade.model == "large-v2"
        facade.shutdown()

    def test_model_setter_noop_when_same(self) -> None:
        """Setting the same model is a no-op."""
        facade = _make_facade_with_fakes()
        facade.model = "tiny"
        assert facade.model == "tiny"
        facade.shutdown()

    def test_model_setter_before_service_initialized(self) -> None:
        """model setter before lazy init only updates config (no model load)."""
        facade = AudioToTextRecorder(use_microphone=False)
        assert facade._service is None
        facade.model = "base"
        assert facade._config.transcription.model == "base"
        assert facade._service is None

    def test_model_setter_swap_failure_logs_exception(self) -> None:
        """model setter handles _swap failure gracefully (covers except branch)."""
        facade = _make_facade_with_fakes()
        # Setting a model triggers _swap in a background thread.
        # Since WhisperTranscriber isn't available in tests, the thread will
        # hit the except branch and log the exception.
        facade.model = "nonexistent-model"
        assert facade._config.transcription.model == "nonexistent-model"
        # Give the background thread time to run and hit the exception
        time.sleep(0.5)
        facade.shutdown()

    def test_delegates_text(self) -> None:
        facade = _make_facade_with_fakes()
        chunks = [_make_chunk(value=i + 1) for i in range(22)]

        def feed() -> None:
            time.sleep(0.05)
            for chunk in chunks:
                facade.feed_audio(chunk)
                time.sleep(0.01)

        t = threading.Thread(target=feed)
        t.start()
        result = facade.text()
        t.join()
        facade.shutdown()
        assert result == "Hello world."

    def test_input_device_index_setter_pre_service(self) -> None:
        """Setter before service is built just records the index in config."""
        recorder = AudioToTextRecorder(use_microphone=False, spinner=False)
        assert recorder.input_device_index is None
        recorder.input_device_index = 3
        assert recorder.input_device_index == 3
        assert recorder._config.audio.input_device_index == 3

    def test_input_device_index_setter_no_op_when_unchanged(self) -> None:
        recorder = AudioToTextRecorder(
            use_microphone=False,
            input_device_index=5,
            spinner=False,
        )
        # Same value — setter should early-exit without touching the service.
        recorder.input_device_index = 5
        assert recorder.input_device_index == 5

    def test_input_device_index_setter_delegates_to_service(self) -> None:
        facade = _make_facade_with_fakes()
        # Service is built — setter calls service.set_input_device, which
        # is a non-blocking attribute write on PyAudioSource.  For
        # FakeAudioSource it's a direct list append.
        audio_source = facade._service._audio_source  # type: ignore[union-attr]
        assert isinstance(audio_source, FakeAudioSource)
        facade.input_device_index = 9
        assert audio_source.switched_to == [9]
        assert facade.input_device_index == 9
        facade.shutdown()

    def test_custom_words_round_trip(self) -> None:
        # Default list is empty; the setter persists to config and the getter
        # returns a copy (mutating the returned list must not leak back).
        facade = _make_facade_with_fakes()
        assert facade.custom_words == []
        facade.custom_words = ["ChargeBee", "OpenAI"]
        assert facade.custom_words == ["ChargeBee", "OpenAI"]
        assert facade._config.text_correction.custom_words == ["ChargeBee", "OpenAI"]
        # Defensive-copy invariant: mutating the returned list mustn't
        # mutate the live config.
        snapshot = facade.custom_words
        snapshot.append("Mutated")
        assert facade.custom_words == ["ChargeBee", "OpenAI"]
        facade.shutdown()

    def test_custom_words_setter_normalises_none(self) -> None:
        # The control handler delivers ``None`` only via a malformed payload,
        # but tests exercise the boundary so the setter's defensive ``value or []``
        # guard doesn't atrophy.
        facade = _make_facade_with_fakes()
        facade.custom_words = ["Foo"]
        facade.custom_words = None  # type: ignore[assignment]
        assert facade.custom_words == []
        facade.shutdown()

    def test_word_correction_threshold_round_trip(self) -> None:
        facade = _make_facade_with_fakes()
        assert facade.word_correction_threshold == 0.18
        facade.word_correction_threshold = 0.32
        assert facade.word_correction_threshold == 0.32
        assert facade._config.text_correction.threshold == 0.32
        facade.shutdown()

    def test_constructor_routes_custom_words_into_config(self) -> None:
        # End-to-end check: the facade accepts the kwargs and they land
        # in :class:`TextCorrectionConfig` (mirrors the constructor-shape
        # parity test in test_accepts_all_original_params).
        recorder = AudioToTextRecorder(
            model="tiny",
            use_microphone=False,
            custom_words=["ChargeBee"],
            word_correction_threshold=0.22,
        )
        assert recorder._config.text_correction.custom_words == ["ChargeBee"]
        assert recorder._config.text_correction.threshold == 0.22

    def test_constructor_custom_words_none_normalises_to_empty(self) -> None:
        # ``None`` is the documented default; the constructor must not
        # share a mutable list across instances.
        recorder = AudioToTextRecorder(
            model="tiny",
            use_microphone=False,
            custom_words=None,
        )
        assert recorder._config.text_correction.custom_words == []
