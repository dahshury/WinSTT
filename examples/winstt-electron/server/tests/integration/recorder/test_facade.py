from __future__ import annotations

import struct
import threading
import time
from typing import cast

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
            input_device_index=None,
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
            buffer_size=512,
            sample_rate=16000,
            initial_prompt=None,
            initial_prompt_realtime=None,
            print_transcription_time=False,
            early_transcription_on_silence=0,
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
        service = facade._service
        assert service is not None
        service._pipeline.transcription_queue.put((True, 0.0))
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
        service = facade._service
        assert service is not None
        audio_source = service._audio_source
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
        # guard doesn't atrophy. Cast to bypass the str-list annotation since
        # this test deliberately probes the None branch.
        facade = _make_facade_with_fakes()
        facade.custom_words = ["Foo"]
        facade.custom_words = cast("list[str]", None)
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

    def test_constructor_custom_filler_words_provided_not_normalised(self) -> None:
        # When the caller hands a non-None ``custom_filler_words`` the
        # constructor must NOT clobber it with the empty default (covers
        # the false branch of ``if custom_filler_words is None``).
        recorder = AudioToTextRecorder(
            model="tiny",
            use_microphone=False,
            custom_filler_words=["umm", "like"],
        )
        assert recorder._config.text_correction.custom_filler_words == ["umm", "like"]


class _SwapRecordingService:
    """Minimal stub standing in for RecorderService on the facade.

    Records every hot-swap side-effect call so tests can assert exactly
    which reload / retune fired (and which did not) when a setter runs.
    The facade only ever calls these four methods from the runtime-knob
    setters, so a duck-typed stub is enough — no real threads, no models.
    """

    def __init__(self) -> None:
        self.swaps: list[tuple[str, str]] = []
        self.unload_timeouts: list[int | None] = []
        self.audio_reconfigs: list[dict[str, object]] = []
        # Controls the in-flight probe the config-knob setters consult before
        # triggering their reload. Default False so existing setter tests still
        # see the reload fire.
        self.swap_in_flight: dict[str, bool] = {"main": False, "realtime": False}

    def is_swap_in_flight(self, kind: str) -> bool:
        return self.swap_in_flight.get(kind, False)

    def request_model_swap(self, kind: str, name: str) -> None:
        self.swaps.append((kind, name))

    def set_unload_timeout_seconds(self, timeout: int | None) -> None:
        self.unload_timeouts.append(timeout)

    def reconfigure_audio_source(self, **kwargs: object) -> None:
        self.audio_reconfigs.append(dict(kwargs))


def _make_facade_with_stub_service(
    stub: _SwapRecordingService,
    **config_kwargs: object,
) -> AudioToTextRecorder:
    """Facade whose ``_service`` is the swap-recording stub.

    Built through the real fakes factory first (so all the private
    attributes ``_create_with_service`` installs are present), then the
    service handle is swapped for the recording stub. Optional
    ``config_kwargs`` override the realtime / transcription / audio
    config so each setter's reload-eligibility branch can be exercised.
    """
    facade = _make_facade_with_fakes()
    for dotted_key, value in config_kwargs.items():
        section, attr = dotted_key.split(".", 1)
        setattr(getattr(facade._config, section), attr, value)
    facade._service = cast("RecorderService", stub)
    return facade


class TestFacadeReloadHelpers:
    def test_maybe_reload_main_model_skips_when_service_none(self) -> None:
        """No service => no swap (covers the early-return guard)."""
        facade = AudioToTextRecorder(model="tiny", use_microphone=False)
        assert facade._service is None
        # Should be a silent no-op; we only assert it does not raise.
        facade._maybe_reload_main_model("test")

    def test_maybe_reload_main_model_skips_when_model_empty(self) -> None:
        """Service present but no model configured => no swap."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(stub, **{"transcription.model": ""})
        facade._maybe_reload_main_model("test")
        assert stub.swaps == []

    def test_maybe_reload_main_model_swaps_when_model_set(self) -> None:
        """Service present + model set => main swap fires with live model."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(stub, **{"transcription.model": "base"})
        facade._maybe_reload_main_model("test")
        assert stub.swaps == [("main", "base")]

    def test_maybe_reload_main_model_skips_when_main_swap_in_flight(self) -> None:
        """A main swap already running => the quant-knob reload is SKIPPED.

        Regression for the "switch silently reverts to the previous model"
        bug: picking a model at a new quant fires the model swap AND an
        onnx_quantization-triggered reload of the CURRENT (old) model. The
        latter is requested second, so it cancels the user's model swap and
        commits the old model. The in-flight swap re-reads the updated quant
        config at load time, so this reload is redundant — skip it.
        """
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(stub, **{"transcription.model": "base"})
        stub.swap_in_flight["main"] = True
        facade._maybe_reload_main_model("test")
        assert stub.swaps == []

    def test_maybe_reload_realtime_skips_when_realtime_swap_in_flight(self) -> None:
        """Same guard for the realtime slot."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{
                "realtime.enable_realtime_transcription": True,
                "realtime.use_main_model_for_realtime": False,
                "realtime.realtime_model_type": "tiny",
            },
        )
        stub.swap_in_flight["realtime"] = True
        facade._maybe_reload_realtime_model("test")
        assert stub.swaps == []

    def test_maybe_reload_realtime_skips_when_service_none(self) -> None:
        facade = AudioToTextRecorder(model="tiny", use_microphone=False)
        assert facade._service is None
        facade._maybe_reload_realtime_model("test")

    def test_maybe_reload_realtime_skips_when_realtime_disabled(self) -> None:
        """Realtime off => no realtime swap."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"realtime.enable_realtime_transcription": False},
        )
        facade._maybe_reload_realtime_model("test")
        assert stub.swaps == []

    def test_maybe_reload_realtime_skips_when_slaved_to_main(self) -> None:
        """Realtime slaved to main => the next main swap covers it; no-op here."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{
                "realtime.enable_realtime_transcription": True,
                "realtime.use_main_model_for_realtime": True,
                "realtime.realtime_model_type": "tiny",
            },
        )
        facade._maybe_reload_realtime_model("test")
        assert stub.swaps == []

    def test_maybe_reload_realtime_skips_when_model_empty(self) -> None:
        """Realtime enabled + standalone but no model => no swap."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{
                "realtime.enable_realtime_transcription": True,
                "realtime.use_main_model_for_realtime": False,
                "realtime.realtime_model_type": "",
            },
        )
        facade._maybe_reload_realtime_model("test")
        assert stub.swaps == []

    def test_maybe_reload_realtime_swaps_when_eligible(self) -> None:
        """Realtime enabled + standalone + model set => realtime swap fires."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{
                "realtime.enable_realtime_transcription": True,
                "realtime.use_main_model_for_realtime": False,
                "realtime.realtime_model_type": "tiny",
            },
        )
        facade._maybe_reload_realtime_model("test")
        assert stub.swaps == [("realtime", "tiny")]


class TestFacadeHotSwapSetters:
    def test_initial_prompt_realtime_noop_when_unchanged(self) -> None:
        """Re-assigning the same realtime prompt is an early-return no-op."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{
                "realtime.enable_realtime_transcription": True,
                "realtime.use_main_model_for_realtime": False,
                "realtime.realtime_model_type": "tiny",
                "realtime.initial_prompt_realtime": "same",
            },
        )
        facade.initial_prompt_realtime = "same"
        assert stub.swaps == []
        assert facade._config.realtime.initial_prompt_realtime == "same"

    def test_initial_prompt_realtime_change_triggers_realtime_reload(self) -> None:
        """A changed realtime prompt reloads the realtime model."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{
                "realtime.enable_realtime_transcription": True,
                "realtime.use_main_model_for_realtime": False,
                "realtime.realtime_model_type": "tiny",
                "realtime.initial_prompt_realtime": "old",
            },
        )
        facade.initial_prompt_realtime = "new"
        assert facade._config.realtime.initial_prompt_realtime == "new"
        assert stub.swaps == [("realtime", "tiny")]

    def test_initial_prompt_realtime_list_value_copied(self) -> None:
        """A list prompt is defensively copied onto config (list branch)."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{
                "realtime.enable_realtime_transcription": True,
                "realtime.use_main_model_for_realtime": False,
                "realtime.realtime_model_type": "tiny",
                "realtime.initial_prompt_realtime": None,
            },
        )
        tokens = [1, 2, 3]
        facade.initial_prompt_realtime = tokens
        assert facade._config.realtime.initial_prompt_realtime == [1, 2, 3]
        # Defensive copy: mutating the source list must not leak into config.
        tokens.append(4)
        assert facade._config.realtime.initial_prompt_realtime == [1, 2, 3]
        assert stub.swaps == [("realtime", "tiny")]

    def test_onnx_quantization_noop_when_unchanged(self) -> None:
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"transcription.onnx_quantization": "int8"},
        )
        facade.onnx_quantization = "int8"
        assert stub.swaps == []

    def test_onnx_quantization_getter(self) -> None:
        facade = _make_facade_with_fakes()
        facade._config.transcription.onnx_quantization = "q4"
        assert facade.onnx_quantization == "q4"
        facade.shutdown()

    def test_onnx_quantization_change_reloads_both_slots(self) -> None:
        """A quantization change reloads main and (when eligible) realtime."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{
                "transcription.model": "base",
                "transcription.onnx_quantization": "int8",
                "realtime.enable_realtime_transcription": True,
                "realtime.use_main_model_for_realtime": False,
                "realtime.realtime_model_type": "tiny",
            },
        )
        facade.onnx_quantization = "q4"
        assert facade._config.transcription.onnx_quantization == "q4"
        assert ("main", "base") in stub.swaps
        assert ("realtime", "tiny") in stub.swaps

    def test_onnx_quantization_none_coerced_to_empty(self) -> None:
        """A falsy push is coerced to '' (covers the ``value or ''`` branch)."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{
                "transcription.model": "base",
                "transcription.onnx_quantization": "int8",
            },
        )
        facade.onnx_quantization = cast("str", None)
        assert facade._config.transcription.onnx_quantization == ""
        assert ("main", "base") in stub.swaps

    def test_translate_to_english_getter(self) -> None:
        facade = _make_facade_with_fakes()
        facade._config.transcription.translate_to_english = True
        assert facade.translate_to_english is True
        facade.shutdown()

    def test_translate_to_english_noop_when_unchanged(self) -> None:
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{
                "transcription.model": "base",
                "transcription.translate_to_english": False,
            },
        )
        facade.translate_to_english = False
        assert stub.swaps == []

    def test_translate_to_english_change_reloads_main_only(self) -> None:
        """Toggling translate rebuilds the main slot, never realtime."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{
                "transcription.model": "base",
                "transcription.translate_to_english": False,
                "realtime.enable_realtime_transcription": True,
                "realtime.use_main_model_for_realtime": False,
                "realtime.realtime_model_type": "tiny",
            },
        )
        facade.translate_to_english = True
        assert facade._config.transcription.translate_to_english is True
        assert stub.swaps == [("main", "base")]

    def test_model_unload_timeout_getter(self) -> None:
        facade = _make_facade_with_fakes()
        facade._config.transcription.model_unload_timeout_seconds = 42
        assert facade.model_unload_timeout_seconds == 42
        facade.shutdown()

    def test_model_unload_timeout_noop_when_unchanged(self) -> None:
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"transcription.model_unload_timeout_seconds": 30},
        )
        facade.model_unload_timeout_seconds = 30
        assert stub.unload_timeouts == []

    def test_model_unload_timeout_change_retunes_daemon(self) -> None:
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"transcription.model_unload_timeout_seconds": None},
        )
        facade.model_unload_timeout_seconds = 60
        assert facade._config.transcription.model_unload_timeout_seconds == 60
        assert stub.unload_timeouts == [60]

    def test_model_unload_timeout_negative_sentinel_normalises_to_none(self) -> None:
        """CLI's -1 'Never' sentinel becomes None and retunes the daemon."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"transcription.model_unload_timeout_seconds": 30},
        )
        facade.model_unload_timeout_seconds = -1
        assert facade._config.transcription.model_unload_timeout_seconds is None
        assert stub.unload_timeouts == [None]

    def test_model_unload_timeout_explicit_none(self) -> None:
        """An explicit None push (already None) is a no-op early-return."""
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"transcription.model_unload_timeout_seconds": None},
        )
        facade.model_unload_timeout_seconds = None
        assert facade._config.transcription.model_unload_timeout_seconds is None
        assert stub.unload_timeouts == []

    def test_webrtc_sensitivity_getter(self) -> None:
        facade = _make_facade_with_fakes()
        facade._config.vad.webrtc_sensitivity = 2
        assert facade.webrtc_sensitivity == 2
        facade.shutdown()

    def test_webrtc_sensitivity_noop_when_unchanged(self) -> None:
        """Same (clamped) value => no live-VAD reconfigure."""
        facade = _make_facade_with_fakes()
        facade._config.vad.webrtc_sensitivity = 2

        class _MockWebRtcVad:
            def __init__(self) -> None:
                self.set_to: list[int] = []

            def set_sensitivity(self, value: int) -> None:
                self.set_to.append(value)

        mock = _MockWebRtcVad()
        facade._webrtc_vad = mock
        facade.webrtc_sensitivity = 2
        assert mock.set_to == []
        facade.shutdown()

    def test_webrtc_sensitivity_change_propagates_to_live_vad(self) -> None:
        facade = _make_facade_with_fakes()
        facade._config.vad.webrtc_sensitivity = 0

        class _MockWebRtcVad:
            def __init__(self) -> None:
                self.set_to: list[int] = []

            def set_sensitivity(self, value: int) -> None:
                self.set_to.append(value)

        mock = _MockWebRtcVad()
        facade._webrtc_vad = mock
        facade.webrtc_sensitivity = 3
        assert facade._config.vad.webrtc_sensitivity == 3
        assert mock.set_to == [3]
        facade.shutdown()

    def test_webrtc_sensitivity_clamped_to_range(self) -> None:
        """Out-of-range input is clamped to 0..3."""
        facade = _make_facade_with_fakes()
        # The test factory doesn't install ``_webrtc_vad``; mirror the
        # production default so the live-VAD guard sees None.
        facade._webrtc_vad = None
        facade._config.vad.webrtc_sensitivity = 0
        facade.webrtc_sensitivity = 99
        assert facade._config.vad.webrtc_sensitivity == 3
        facade.shutdown()

    def test_silero_deactivity_getter(self) -> None:
        facade = _make_facade_with_fakes()
        facade._config.vad.silero_deactivity_detection = True
        assert facade.silero_deactivity_detection is True
        facade.shutdown()

    def test_silero_deactivity_setter_persists_only(self) -> None:
        """Setter persists to config; no runtime consumer side-effect today."""
        facade = _make_facade_with_fakes()
        assert facade._config.vad.silero_deactivity_detection is False
        facade.silero_deactivity_detection = True
        assert facade._config.vad.silero_deactivity_detection is True
        facade.silero_deactivity_detection = False
        assert facade._config.vad.silero_deactivity_detection is False
        facade.shutdown()

    def test_always_on_microphone_getter(self) -> None:
        facade = _make_facade_with_fakes()
        facade._config.audio.always_on_microphone = True
        assert facade.always_on_microphone is True
        facade.shutdown()

    def test_always_on_microphone_noop_when_unchanged(self) -> None:
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"audio.always_on_microphone": False},
        )
        facade.always_on_microphone = False
        assert stub.audio_reconfigs == []

    def test_always_on_microphone_change_reconfigures_audio(self) -> None:
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"audio.always_on_microphone": False},
        )
        facade.always_on_microphone = True
        assert facade._config.audio.always_on_microphone is True
        assert stub.audio_reconfigs == [{"always_on_microphone": True}]

    def test_lazy_stream_close_getter(self) -> None:
        facade = _make_facade_with_fakes()
        facade._config.audio.lazy_stream_close = True
        assert facade.lazy_stream_close is True
        facade.shutdown()

    def test_lazy_stream_close_noop_when_unchanged(self) -> None:
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"audio.lazy_stream_close": False},
        )
        facade.lazy_stream_close = False
        assert stub.audio_reconfigs == []

    def test_lazy_stream_close_change_reconfigures_audio(self) -> None:
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"audio.lazy_stream_close": False},
        )
        facade.lazy_stream_close = True
        assert facade._config.audio.lazy_stream_close is True
        assert stub.audio_reconfigs == [{"lazy_stream_close": True}]

    def test_lazy_close_timeout_getter(self) -> None:
        facade = _make_facade_with_fakes()
        facade._config.audio.lazy_close_timeout_seconds = 7.5
        assert facade.lazy_close_timeout_seconds == 7.5
        facade.shutdown()

    def test_lazy_close_timeout_noop_when_unchanged(self) -> None:
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"audio.lazy_close_timeout_seconds": 3.0},
        )
        facade.lazy_close_timeout_seconds = 3.0
        assert stub.audio_reconfigs == []

    def test_lazy_close_timeout_change_reconfigures_audio(self) -> None:
        stub = _SwapRecordingService()
        facade = _make_facade_with_stub_service(
            stub,
            **{"audio.lazy_close_timeout_seconds": 3.0},
        )
        facade.lazy_close_timeout_seconds = 9.0
        assert facade._config.audio.lazy_close_timeout_seconds == 9.0
        assert stub.audio_reconfigs == [{"lazy_close_timeout_seconds": 9.0}]

    def test_event_bus_property(self) -> None:
        """event_bus exposes the facade's own bus."""
        facade = _make_facade_with_fakes()
        assert facade.event_bus is facade._event_bus
        facade.shutdown()

    def test_filter_fillers_round_trip(self) -> None:
        facade = _make_facade_with_fakes()
        assert facade.filter_fillers is True
        facade.filter_fillers = False
        assert facade.filter_fillers is False
        assert facade._config.text_correction.filter_fillers is False
        facade.shutdown()

    def test_custom_filler_words_round_trip(self) -> None:
        facade = _make_facade_with_fakes()
        assert facade.custom_filler_words == []
        facade.custom_filler_words = ["umm", "uh"]
        assert facade.custom_filler_words == ["umm", "uh"]
        assert facade._config.text_correction.custom_filler_words == ["umm", "uh"]
        # Defensive-copy invariant on the getter.
        snapshot = facade.custom_filler_words
        snapshot.append("leaked")
        assert facade.custom_filler_words == ["umm", "uh"]
        facade.shutdown()

    def test_custom_filler_words_setter_normalises_none(self) -> None:
        facade = _make_facade_with_fakes()
        facade.custom_filler_words = ["umm"]
        facade.custom_filler_words = cast("list[str]", None)
        assert facade.custom_filler_words == []
        facade.shutdown()

    def test_initial_prompt_list_value_defensively_copied(self) -> None:
        """A token-id list prompt is copied onto the main transcription config."""
        facade = _make_facade_with_fakes()
        tokens = [11, 22, 33]
        facade.initial_prompt = tokens
        assert facade._config.transcription.initial_prompt == [11, 22, 33]
        # Defensive copy: mutating the source must not leak into config.
        tokens.append(44)
        assert facade._config.transcription.initial_prompt == [11, 22, 33]
        facade.shutdown()


class TestFacadeHotSwapSettersPreService:
    """Hot-swap setters before the lazy service is built.

    These cover the ``self._service is None`` not-taken branch on the
    audio / unload setters: the config value must still update so the
    next ``setup()`` reads it, but no live reconfigure/retune fires.
    """

    def test_model_unload_timeout_change_pre_service_skips_retune(self) -> None:
        facade = AudioToTextRecorder(
            use_microphone=False,
            model_unload_timeout_seconds=30,
        )
        assert facade._service is None
        facade.model_unload_timeout_seconds = 90
        assert facade._config.transcription.model_unload_timeout_seconds == 90
        assert facade._service is None

    def test_always_on_microphone_change_pre_service_skips_reconfigure(self) -> None:
        facade = AudioToTextRecorder(
            use_microphone=False,
            always_on_microphone=False,
        )
        assert facade._service is None
        facade.always_on_microphone = True
        assert facade._config.audio.always_on_microphone is True
        assert facade._service is None

    def test_lazy_stream_close_change_pre_service_skips_reconfigure(self) -> None:
        facade = AudioToTextRecorder(
            use_microphone=False,
            lazy_stream_close=False,
        )
        assert facade._service is None
        facade.lazy_stream_close = True
        assert facade._config.audio.lazy_stream_close is True
        assert facade._service is None

    def test_lazy_close_timeout_change_pre_service_skips_reconfigure(self) -> None:
        facade = AudioToTextRecorder(
            use_microphone=False,
            lazy_close_timeout_seconds=3.0,
        )
        assert facade._service is None
        facade.lazy_close_timeout_seconds = 9.0
        assert facade._config.audio.lazy_close_timeout_seconds == 9.0
        assert facade._service is None
