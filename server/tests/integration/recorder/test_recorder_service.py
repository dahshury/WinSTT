from __future__ import annotations

import queue as queue_module
import struct
import threading
import time
from typing import Any

import numpy as np

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.recorder.application.recorder_service import RecorderService
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.ports.transcriber import TranscriptionResult
from src.recorder.domain.state_machine import RecorderState
from tests.fakes.fake_audio_source import FakeAudioSource
from tests.fakes.fake_transcriber import FakeTranscriber
from tests.fakes.fake_vad import FakeVAD
from tests.fakes.fake_wake_word import FakeWakeWordDetector


class TestRecorderService:
    def _make_service(
        self,
        speech_pattern: list[bool] | None = None,
        transcription_text: str = "hello world",
        use_microphone: bool = False,
        realtime_transcriber: FakeTranscriber | None = None,
        wake_word_detector: FakeWakeWordDetector | None = None,
        ensure_sentence_starting_uppercase: bool = True,
        ensure_sentence_ends_with_period: bool = True,
    ) -> tuple[RecorderService, FakeTranscriber, EventBus, FakeAudioSource]:
        config = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.05,
            min_length_of_recording=0.0,
            use_microphone=use_microphone,
            ensure_sentence_starting_uppercase=ensure_sentence_starting_uppercase,
            ensure_sentence_ends_with_period=ensure_sentence_ends_with_period,
        )
        transcriber = FakeTranscriber(
            result=TranscriptionResult(
                text=transcription_text,
                language="en",
                language_probability=0.99,
                duration_seconds=1.0,
            )
        )
        event_bus = EventBus()
        audio_source = FakeAudioSource()
        service = RecorderService(
            audio_source=audio_source,
            vad=FakeVAD(speech_pattern=speech_pattern or [True] + [False] * 20),
            transcriber=transcriber,
            wake_word_detector=wake_word_detector,
            realtime_transcriber=realtime_transcriber,
            config=config,
            event_bus=event_bus,
            clock=Clock.system_clock(),
        )
        return service, transcriber, event_bus, audio_source

    # ---- Original 6 tests (preserved) ----

    def test_context_manager(self) -> None:
        service, _, _, _ = self._make_service()
        with service:
            pass  # should not raise

    def test_start_and_stop(self) -> None:
        service, _, _, _ = self._make_service()
        service.listen()
        service.start()
        assert service.is_recording
        service.shutdown()

    def test_shutdown(self) -> None:
        service, transcriber, _, _ = self._make_service()
        service.shutdown()
        assert transcriber.shutdown_called

    def test_preprocess_uppercase(self) -> None:
        service, _, _, _ = self._make_service(transcription_text="hello")
        result = service._preprocess_output("hello")
        assert result[0] == "H"

    def test_preprocess_period(self) -> None:
        service, _, _, _ = self._make_service(transcription_text="hello")
        result = service._preprocess_output("hello")
        assert result.endswith(".")

    def test_abort(self) -> None:
        service, _, _, _ = self._make_service()
        service.listen()
        service.abort()
        # Should not raise

    # ---- New tests for 100% coverage ----

    def test_text_returns_transcription(self) -> None:
        """Cover lines 72-85: text() method end-to-end."""
        service, _transcriber, _event_bus, _ = self._make_service(
            transcription_text="hello world",
        )
        # Build audio chunks that look like valid int16 PCM
        chunk = struct.pack("<512h", *([100] * 512))
        chunks = [chunk for _ in range(22)]

        def feed_audio() -> None:
            time.sleep(0.05)  # Let text() call listen() first
            for c in chunks:
                service.feed_audio(c)
                time.sleep(0.01)

        t = threading.Thread(target=feed_audio)
        t.start()
        result = service.text()
        t.join()
        service.shutdown()
        assert result == "Hello world."

    def test_text_not_in_transcribing_state(self) -> None:
        """Cover the branch at lines 82-83 where state != TRANSCRIBING so
        the transition is skipped."""
        service, _transcriber, _event_bus, _ = self._make_service(
            transcription_text="hello world",
        )
        chunk = struct.pack("<512h", *([100] * 512))
        chunks = [chunk for _ in range(22)]

        def feed_audio() -> None:
            time.sleep(0.05)
            for c in chunks:
                service.feed_audio(c)
                time.sleep(0.01)

        t = threading.Thread(target=feed_audio)
        t.start()

        # Call listen + wait_audio manually, then force state to INACTIVE
        # before calling text() -- but text() calls listen/wait_audio itself.
        # Instead: call text() normally but after it returns, set the state
        # machine to something else before the transition check.
        # Actually, the simplest approach: manually invoke text()'s logic
        # but force the state to INACTIVE before the if-check.
        # Since we cannot modify the source, let's just ensure the branch
        # is taken by calling text() where the pipeline processes the stop
        # and transitions to TRANSCRIBING, then the if-check passes.
        # The "not in TRANSCRIBING" branch happens when an abort() has
        # already moved the state away. We can set up a callback that
        # aborts the state machine mid-way.

        # Simplest approach: pre-put something on the transcription_queue so
        # wait_audio() returns immediately, and the state machine is still INACTIVE
        # (never went to TRANSCRIBING).
        t.join()
        service.shutdown()

        # For the branch test, create a new service and directly test it
        service2, _, _, _ = self._make_service(transcription_text="test")
        service2.listen()
        # Put item on transcription queue so wait_audio returns immediately
        service2._pipeline._transcription_queue.put((True, 0.0))
        # State machine is LISTENING, not TRANSCRIBING, so the branch at line 82
        # will NOT transition (it skips transition).
        result = service2.text()
        service2.shutdown()
        assert result == "Test."

    def test_stop_delegates(self) -> None:
        """Cover lines 96-97: stop() delegates to pipeline.request_stop."""
        service, _, _, _ = self._make_service()
        service.listen()
        service.start()
        assert service.is_recording
        result = service.stop()
        assert result is service  # returns self
        service.shutdown()

    def test_listen_starts_pipeline(self) -> None:
        """Cover lines 100-102: first listen() call starts the pipeline."""
        service, _, _, _ = self._make_service()
        assert not service._is_running
        service.listen()
        assert service._is_running
        service.shutdown()

    def test_feed_audio_bytes(self) -> None:
        """Cover feed_audio with raw bytes (not numpy)."""
        service, _, _, _ = self._make_service()
        service.listen()
        chunk = struct.pack("<512h", *([100] * 512))
        service.feed_audio(chunk)
        service.shutdown()

    def test_feed_audio_numpy_1d(self) -> None:
        """Cover lines 109-119: feed_audio with 1D numpy array."""
        service, _, _, _ = self._make_service()
        service.listen()
        arr = np.array([100] * 512, dtype=np.float32)
        service.feed_audio(arr)
        service.shutdown()

    def test_feed_audio_numpy_2d(self) -> None:
        """Cover line 111-112: feed_audio with 2D (stereo) numpy array -> mono."""
        service, _, _, _ = self._make_service()
        service.listen()
        arr = np.array([[100, 200]] * 512, dtype=np.float32)
        service.feed_audio(arr)  # 2D -> averaged to 1D
        service.shutdown()

    def test_feed_audio_numpy_resample(self) -> None:
        """Cover lines 113-117: feed_audio with different sample rate triggers resampling."""
        service, _, _, _ = self._make_service()
        service.listen()
        arr = np.array([100] * 1024, dtype=np.float32)
        service.feed_audio(arr, original_sample_rate=48000)  # 48k -> 16k
        service.shutdown()

    def test_set_microphone_on(self) -> None:
        """set_microphone(True) enables the microphone flag."""
        service, _, _, _ = self._make_service()
        service.set_microphone(False)
        assert service.use_microphone is False
        service.set_microphone(True)
        assert service.use_microphone is True
        service.shutdown()

    def test_set_microphone_off(self) -> None:
        """set_microphone(False) disables the microphone flag."""
        service, _, _, _ = self._make_service()
        service.set_microphone(False)
        assert service.use_microphone is False
        service.shutdown()

    def test_shutdown_with_realtime_transcriber(self) -> None:
        """Cover lines 132-133: shutdown with realtime_transcriber present."""
        rt_transcriber = FakeTranscriber()
        service, transcriber, _, _ = self._make_service(
            realtime_transcriber=rt_transcriber,
        )
        service.shutdown()
        assert transcriber.shutdown_called
        assert rt_transcriber.shutdown_called

    def test_shutdown_with_wake_word_detector(self) -> None:
        """Cover lines 134-135: shutdown with wake_word_detector present."""
        wwd = FakeWakeWordDetector()
        service, transcriber, _, _ = self._make_service(
            wake_word_detector=wwd,
        )
        service.shutdown()
        assert transcriber.shutdown_called
        assert wwd.cleanup_called

    def test_wait_audio_timeout(self) -> None:
        """wait_audio() returns False on timeout."""
        service, _, _, _ = self._make_service()

        class AlwaysEmptyQueue:
            def get(self, timeout: float = 0) -> None:
                raise queue_module.Empty

        service._pipeline._transcription_queue = AlwaysEmptyQueue()  # type: ignore[assignment]
        service.listen()
        assert service.wait_audio() is False
        service.shutdown()

    def test_wait_audio_success(self) -> None:
        """wait_audio() returns True when audio is ready."""
        service, _, _, _ = self._make_service()
        service.listen()
        # Pre-populate the queue so get() returns immediately
        service._pipeline._transcription_queue.put((True, 0.0))
        assert service.wait_audio() is True
        service.shutdown()

    def test_text_returns_empty_on_timeout(self) -> None:
        """text() returns empty string and clears buffer when wait_audio times out."""
        service, _, _, _ = self._make_service()

        class AlwaysEmptyQueue:
            def get(self, timeout: float = 0) -> None:
                raise queue_module.Empty

        service._pipeline._transcription_queue = AlwaysEmptyQueue()  # type: ignore[assignment]
        # Seed buffer with stale data so we can verify it gets cleared
        service._audio_buffer._frames = [b"\x01\x00" * 160]
        result = service.text()
        assert result == ""
        assert service._audio_buffer.frame_count == 0
        service.shutdown()

    def test_wakeup(self) -> None:
        """Cover line 149: wakeup() calls pipeline.request_listen()."""
        service, _, _, _ = self._make_service()
        service.listen()
        service.wakeup()  # Should not raise
        service.shutdown()

    def test_clear_audio_queue(self) -> None:
        """Cover line 152: clear_audio_queue() clears the audio buffer."""
        service, _, _, _ = self._make_service()
        service.clear_audio_queue()
        service.shutdown()

    def test_transcribe(self) -> None:
        """Cover lines 155-157: transcribe() gets audio and transcribes."""
        service, transcriber, _, _ = self._make_service(
            transcription_text="hello world",
        )
        result = service.transcribe()
        assert result == "Hello world."
        assert transcriber.call_count == 1
        service.shutdown()

    def test_state_property(self) -> None:
        """Cover line 161: state property returns state_machine.state."""
        service, _, _, _ = self._make_service()
        assert service.state == RecorderState.INACTIVE
        service.shutdown()

    def test_start_pipeline_with_microphone(self) -> None:
        """Cover line 168-169: _start_pipeline with use_microphone=True calls
        audio_source.setup()."""
        service, _, _, audio_source = self._make_service(use_microphone=True)
        assert not audio_source.setup_called
        service.listen()  # triggers _start_pipeline since not running
        assert audio_source.setup_called
        service.shutdown()

    def test_preprocess_empty_string(self) -> None:
        """Cover branches at lines 175 and 177 where text is empty."""
        service, _, _, _ = self._make_service()
        result = service._preprocess_output("")
        assert result == ""

    def test_preprocess_already_has_period(self) -> None:
        """Cover branch at line 177 where last char is not alphanumeric
        (already ends with period)."""
        service, _, _, _ = self._make_service()
        result = service._preprocess_output("hello.")
        assert result == "Hello."
        # Should NOT add another period

    def test_preprocess_whitespace_normalization(self) -> None:
        """Cover line 174: whitespace normalization via regex."""
        service, _, _, _ = self._make_service()
        result = service._preprocess_output("  hello   world  ")
        assert result == "Hello world."

    def test_preprocess_no_uppercase(self) -> None:
        """Cover branch at line 175 where ensure_sentence_starting_uppercase is False."""
        service, _, _, _ = self._make_service(
            ensure_sentence_starting_uppercase=False,
        )
        result = service._preprocess_output("hello")
        assert result == "hello."

    def test_post_speech_silence_duration_getter(self) -> None:
        """Property returns the pipeline's current value."""
        service, _, _, _ = self._make_service()
        # Config default was 0.05
        assert service.post_speech_silence_duration == 0.05
        service.shutdown()

    def test_post_speech_silence_duration_setter(self) -> None:
        """Setter delegates to pipeline."""
        service, _, _, _ = self._make_service()
        service.post_speech_silence_duration = 1.23
        assert service.post_speech_silence_duration == 1.23
        service.shutdown()

    def test_use_microphone_initial(self) -> None:
        """use_microphone reflects config at construction time."""
        service, _, _, _ = self._make_service(use_microphone=False)
        assert service.use_microphone is False
        service.shutdown()

    def test_use_microphone_tracks_set_microphone(self) -> None:
        """use_microphone updates when set_microphone is called."""
        service, _, _, _ = self._make_service(use_microphone=False)
        assert service.use_microphone is False
        service.set_microphone(True)
        assert service.use_microphone is True
        service.set_microphone(False)
        assert service.use_microphone is False
        service.shutdown()

    def test_frames_property(self) -> None:
        """Service.frames delegates to pipeline.frames."""
        service, _, _, _ = self._make_service()
        assert service.frames == []
        service.shutdown()

    def test_last_words_buffer_property(self) -> None:
        """Service.last_words_buffer delegates to pipeline.last_words_buffer."""
        service, _, _, _ = self._make_service()
        assert len(service.last_words_buffer) == 0
        service.shutdown()

    def test_wake_word_activation_delay_getter(self) -> None:
        """Property returns the config default (0.0)."""
        service, _, _, _ = self._make_service()
        assert service.wake_word_activation_delay == 0.0
        service.shutdown()

    def test_wake_word_activation_delay_setter(self) -> None:
        """Setter delegates to pipeline."""
        service, _, _, _ = self._make_service()
        service.wake_word_activation_delay = 5.0
        assert service.wake_word_activation_delay == 5.0
        service.shutdown()

    def test_text_calls_on_transcription_finished(self) -> None:
        """text() invokes the callback with the transcription result."""
        service, _, _, _ = self._make_service(transcription_text="hello world")
        chunk = struct.pack("<512h", *([100] * 512))
        result_holder: list[str] = []
        done = threading.Event()

        def callback(text: str) -> None:
            result_holder.append(text)
            done.set()

        def feed_audio() -> None:
            time.sleep(0.05)
            for _ in range(22):
                service.feed_audio(chunk)
                time.sleep(0.01)

        t = threading.Thread(target=feed_audio)
        t.start()
        service.text(callback)
        t.join()
        done.wait(timeout=5.0)
        service.shutdown()
        assert result_holder == ["Hello world."]

    def test_audio_reader_feeds_pipeline(self) -> None:
        """When use_microphone=True, the reader thread feeds the pipeline."""
        service, _, _, _ = self._make_service(use_microphone=True)
        result = service.text()
        service.shutdown()
        assert result == "Hello world."

    def test_audio_reader_feeds_silence_when_muted(self) -> None:
        """When microphone is muted, audio reader feeds silence frames."""
        service, _, _, _ = self._make_service(use_microphone=True)
        # Directly exercise the reader loop with mic disabled
        service._microphone_enabled = False
        service._is_running = True

        def stop_soon() -> None:
            time.sleep(0.1)
            service._is_running = False

        t = threading.Thread(target=stop_soon)
        t.start()
        service._audio_reader_loop()  # blocks until _is_running flipped
        t.join()
        # Silence frames should have been fed (not discarded)
        assert not service._pipeline._audio_queue.empty()
        chunk = service._pipeline._audio_queue.get_nowait()
        assert chunk == b"\x00" * len(chunk)
        service.shutdown()

    def test_audio_reader_handles_read_error(self) -> None:
        """Audio reader survives an exception from read_chunk and keeps going."""
        service, _, _, audio_source = self._make_service(use_microphone=True)
        call_count = 0
        original_read = audio_source.read_chunk

        def flaky_read() -> bytes:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise OSError("simulated stream error")
            return original_read()

        audio_source.read_chunk = flaky_read  # type: ignore[method-assign]
        result = service.text()
        service.shutdown()
        assert result == "Hello world."

    def test_audio_reader_exits_on_shutdown_during_error(self) -> None:
        """Audio reader exits when _is_running is False during an exception."""
        service, _, _, audio_source = self._make_service(use_microphone=True)

        def always_fail() -> bytes:
            # Simulate shutdown happening while read fails
            service._is_running = False
            raise OSError("stream closed")

        # Start the pipeline so the reader thread starts
        service.listen()
        time.sleep(0.05)
        audio_source.read_chunk = always_fail  # type: ignore[method-assign]
        time.sleep(0.1)
        service.shutdown()

    def test_preprocess_no_period(self) -> None:
        """Cover branch at line 177 where ensure_sentence_ends_with_period is False."""
        service, _, _, _ = self._make_service(
            ensure_sentence_ends_with_period=False,
        )
        result = service._preprocess_output("hello")
        assert result == "Hello"

    def _make_realtime_service(
        self,
        realtime_text: str = "live transcription",
    ) -> tuple[RecorderService, FakeTranscriber, EventBus]:
        config = RecorderConfig.from_kwargs(
            post_speech_silence_duration=5.0,
            min_length_of_recording=0.0,
            use_microphone=False,
            enable_realtime_transcription=True,
            realtime_processing_pause=0.01,
            init_realtime_after_seconds=0.0,
        )
        transcriber = FakeTranscriber()
        rt_transcriber = FakeTranscriber(
            result=TranscriptionResult(
                text=realtime_text,
                language="en",
                language_probability=0.99,
                duration_seconds=0.5,
            )
        )
        event_bus = EventBus()
        service = RecorderService(
            audio_source=FakeAudioSource(),
            vad=FakeVAD(speech_pattern=[True] * 1000),
            transcriber=transcriber,
            realtime_transcriber=rt_transcriber,
            config=config,
            event_bus=event_bus,
            clock=Clock.system_clock(),
        )
        return service, rt_transcriber, event_bus

    def test_realtime_worker_publishes_updates(self) -> None:
        """Realtime worker periodically transcribes and publishes events."""
        from src.recorder.domain.events import RealtimeTranscriptionUpdate

        service, rt_transcriber, event_bus = self._make_realtime_service()
        received: list[str] = []
        done = threading.Event()

        def on_update(event: RealtimeTranscriptionUpdate) -> None:
            received.append(event.text)
            if len(received) >= 1:
                done.set()

        event_bus.subscribe(RealtimeTranscriptionUpdate, on_update)

        chunk = struct.pack("<512h", *([100] * 512))

        def feed_loop() -> None:
            time.sleep(0.05)
            for _ in range(50):
                service.feed_audio(chunk)
                time.sleep(0.01)

        service.listen()
        t = threading.Thread(target=feed_loop)
        t.start()
        done.wait(timeout=5.0)
        t.join()
        service.shutdown()
        assert len(received) >= 1
        assert rt_transcriber.call_count >= 1

    def test_realtime_worker_not_started_when_disabled(self) -> None:
        """Realtime thread is not spawned when enable_realtime_transcription=False."""
        service, _, _, _ = self._make_service()
        service.listen()
        assert service._realtime_thread is None
        service.shutdown()

    def test_realtime_worker_skips_when_not_recording(self) -> None:
        """Realtime worker sleeps when not recording (no crash)."""
        service, rt_transcriber, _ = self._make_realtime_service()
        # Start pipeline but do NOT trigger recording (don't feed audio)
        service.listen()
        time.sleep(0.1)
        service.shutdown()
        assert rt_transcriber.call_count == 0

    def test_shutdown_joins_realtime_thread(self) -> None:
        """shutdown() properly joins the realtime thread."""
        service, _, _ = self._make_realtime_service()
        service.listen()
        assert service._realtime_thread is not None
        service.shutdown()
        assert service._realtime_thread is None

    def test_realtime_worker_respects_init_delay(self) -> None:
        """Realtime worker waits for init_realtime_after_seconds before first transcription."""
        config = RecorderConfig.from_kwargs(
            post_speech_silence_duration=5.0,
            min_length_of_recording=0.0,
            use_microphone=False,
            enable_realtime_transcription=True,
            realtime_processing_pause=0.01,
            init_realtime_after_seconds=10.0,  # Very long delay
        )
        rt_transcriber = FakeTranscriber()
        event_bus = EventBus()
        service = RecorderService(
            audio_source=FakeAudioSource(),
            vad=FakeVAD(speech_pattern=[True] * 1000),
            transcriber=FakeTranscriber(),
            realtime_transcriber=rt_transcriber,
            config=config,
            event_bus=event_bus,
            clock=Clock.system_clock(),
        )
        chunk = struct.pack("<512h", *([100] * 512))
        service.listen()
        for _ in range(10):
            service.feed_audio(chunk)
            time.sleep(0.01)
        time.sleep(0.1)
        service.shutdown()
        # Should not have transcribed due to long init delay
        assert rt_transcriber.call_count == 0

    def test_realtime_worker_handles_transcription_error(self) -> None:
        """Realtime worker logs and continues on transcription errors."""
        from src.recorder.domain.events import RealtimeTranscriptionUpdate

        service, rt_transcriber, event_bus = self._make_realtime_service()
        call_count = 0

        def failing_transcribe(
            audio: np.ndarray[Any, Any],
            language: str = "",
            use_prompt: bool = True,
        ) -> TranscriptionResult:
            nonlocal call_count
            call_count += 1
            if call_count <= 2:
                raise RuntimeError("simulated failure")
            return TranscriptionResult(text="recovered", language="en", language_probability=0.99, duration_seconds=0.5)

        rt_transcriber.transcribe = failing_transcribe  # type: ignore[method-assign]
        chunk = struct.pack("<512h", *([100] * 512))
        received: list[str] = []
        done = threading.Event()

        def on_update(event: RealtimeTranscriptionUpdate) -> None:
            received.append(event.text)
            done.set()

        event_bus.subscribe(RealtimeTranscriptionUpdate, on_update)
        service.listen()

        def feed_loop() -> None:
            time.sleep(0.05)
            for _ in range(80):
                service.feed_audio(chunk)
                time.sleep(0.01)

        t = threading.Thread(target=feed_loop)
        t.start()
        done.wait(timeout=5.0)
        t.join()
        service.shutdown()
        assert call_count >= 3  # first 2 failed, then recovered
