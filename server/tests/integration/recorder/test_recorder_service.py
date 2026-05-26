from __future__ import annotations

import queue as queue_module
import struct
import threading
import time
from collections.abc import Callable
from typing import Any

import numpy as np

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.recorder.application.recorder_service import RecorderService
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.events import (
    DownloadProgress,
    NoAudioDetected,
    SpeakerSegment,
    SpeakerSegmentsDetected,
)
from src.recorder.domain.ports.transcriber import ITranscriber, TranscriptionResult
from src.recorder.domain.state_machine import RecorderState
from tests.fakes.fake_audio_source import FakeAudioSource
from tests.fakes.fake_diarizer import FakeDiarizer
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
        diarizer: FakeDiarizer | None = None,
        ensure_sentence_starting_uppercase: bool = True,
        ensure_sentence_ends_with_period: bool = True,
        custom_words: list[str] | None = None,
        word_correction_threshold: float = 0.18,
    ) -> tuple[RecorderService, FakeTranscriber, EventBus, FakeAudioSource]:
        config = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.05,
            min_length_of_recording=0.0,
            # These tests drive the end-to-end text() flow, not the
            # speech-onset debounce — keep legacy single-chunk start.
            speech_onset_consecutive_chunks=1,
            use_microphone=use_microphone,
            ensure_sentence_starting_uppercase=ensure_sentence_starting_uppercase,
            ensure_sentence_ends_with_period=ensure_sentence_ends_with_period,
            custom_words=custom_words or [],
            threshold=word_correction_threshold,
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
            diarizer=diarizer,
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

    @staticmethod
    def _run_text_with_audio(service: RecorderService) -> str:
        """Drive ``text()`` end-to-end by feeding synthetic PCM from a thread."""
        chunk = struct.pack("<512h", *([100] * 512))
        chunks = [chunk for _ in range(22)]

        def feed_audio() -> None:
            time.sleep(0.05)
            for c in chunks:
                service.feed_audio(c)
                time.sleep(0.01)

        t = threading.Thread(target=feed_audio)
        t.start()
        try:
            return service.text()
        finally:
            t.join()
            service.shutdown()

    def test_text_emits_speaker_segments_when_diarizer_present(self) -> None:
        """Diarizer success path: segments are published after the transcript."""
        diarizer = FakeDiarizer(segments=(SpeakerSegment(start=0.0, end=1.0, speaker=0),))
        service, _t, event_bus, _ = self._make_service(
            transcription_text="hello world",
            diarizer=diarizer,
        )
        received: list[SpeakerSegmentsDetected] = []
        event_bus.subscribe(SpeakerSegmentsDetected, received.append)

        result = self._run_text_with_audio(service)

        assert result == "Hello world."
        assert diarizer.diarize_calls == 1
        assert len(received) == 1
        assert received[0].segments == (SpeakerSegment(start=0.0, end=1.0, speaker=0),)

    def test_text_diarizer_failure_is_swallowed(self) -> None:
        """A diarizer that raises must not crash text(); empty segments emit."""
        diarizer = FakeDiarizer(raises=RuntimeError("diarize boom"))
        service, _t, event_bus, _ = self._make_service(
            transcription_text="hello world",
            diarizer=diarizer,
        )
        received: list[SpeakerSegmentsDetected] = []
        event_bus.subscribe(SpeakerSegmentsDetected, received.append)

        result = self._run_text_with_audio(service)

        assert result == "Hello world."
        assert diarizer.diarize_calls == 1
        assert len(received) == 1
        assert received[0].segments == ()

    def test_text_no_speaker_segments_without_diarizer(self) -> None:
        """No diarizer wired → no SpeakerSegmentsDetected ever published."""
        service, _t, event_bus, _ = self._make_service(transcription_text="hello world")
        received: list[SpeakerSegmentsDetected] = []
        event_bus.subscribe(SpeakerSegmentsDetected, received.append)

        result = self._run_text_with_audio(service)

        assert result == "Hello world."
        assert received == []

    def test_safe_diarize_returns_empty_when_diarizer_none(self) -> None:
        """Direct unit cover of the ``_safe_diarize`` None guard branch."""
        service, _t, _e, _ = self._make_service()
        assert service._safe_diarize(np.zeros(16000, dtype=np.float32)) == ()

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

    def test_preprocess_applies_custom_words(self) -> None:
        """Custom-word fuzzy corrector runs before capitalisation + period."""
        service, _, _, _ = self._make_service(
            custom_words=["ChargeBee"],
            word_correction_threshold=0.5,
        )
        # "Charge B" should fuzz-match to "ChargeBee" via the n-gram pass.
        result = service._preprocess_output("we love Charge B")
        # Greedy 3-gram absorbs "love Charge B" — the assertion only
        # checks the substitution landed (mirrors the Handy test style).
        assert "ChargeBee" in result
        assert result.endswith(".")

    def test_preprocess_custom_words_empty_short_circuits(self) -> None:
        """Empty word list skips the matcher entirely — text passes through."""
        service, _, _, _ = self._make_service(custom_words=[])
        result = service._preprocess_output("hello world")
        assert result == "Hello world."

    def test_preprocess_custom_words_skip_on_empty_text(self) -> None:
        """Empty text short-circuits even when custom_words is non-empty."""
        service, _, _, _ = self._make_service(custom_words=["OpenAI"])
        # Whitespace input after strip becomes "" — should not run the matcher.
        result = service._preprocess_output("   ")
        assert result == ""

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

    def test_silence_endpoint_enabled_getter(self) -> None:
        """Property returns the pipeline's current value."""
        service, _, _, _ = self._make_service()
        assert service.silence_endpoint_enabled is True
        service.shutdown()

    def test_silence_endpoint_enabled_setter(self) -> None:
        """Setter delegates to pipeline."""
        service, _, _, _ = self._make_service()
        service.silence_endpoint_enabled = False
        assert service.silence_endpoint_enabled is False
        service.shutdown()

    def test_set_microphone_off_stops_recording_when_silence_endpoint_disabled(self) -> None:
        """In PTT mode (silence endpoint disabled), set_microphone(False) stops recording directly."""
        service, _, _, _ = self._make_service()
        service.silence_endpoint_enabled = False
        service.listen()
        service.start()
        assert service.state == RecorderState.RECORDING

        service.set_microphone(False)
        time.sleep(0.2)
        assert service.state != RecorderState.RECORDING
        service.shutdown()

    def test_set_microphone_off_emits_no_audio_when_listening_with_smart_endpoint(self) -> None:
        """Smart endpoint PTT: releasing while still LISTENING emits NoAudioDetected."""
        service, _, event_bus, _ = self._make_service()

        no_audio_events: list[object] = []
        event_bus.subscribe(NoAudioDetected, no_audio_events.append)

        service.listen()
        # silence_endpoint stays enabled (default True); state never reaches RECORDING
        assert service.state == RecorderState.LISTENING

        service.set_microphone(False)
        assert len(no_audio_events) == 1
        service.shutdown()

    def test_set_microphone_off_stops_recording_even_with_smart_endpoint(self) -> None:
        """PTT release must be immediate even when silence endpoint is enabled.

        Regression guard: previously, set_microphone(False) waited for
        post_speech_silence_duration when smart endpoint was on, causing
        a perceptible delay before the overlay hid and text was pasted.
        """
        service, _, _, _ = self._make_service()
        # silence_endpoint_enabled stays at its default (True) — the smart-endpoint case.
        assert service.silence_endpoint_enabled is True
        service.listen()
        service.start()
        assert service.state == RecorderState.RECORDING

        service.set_microphone(False)
        time.sleep(0.2)
        assert service.state != RecorderState.RECORDING
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

    def test_audio_reader_drains_silently_when_muted(self) -> None:
        """When microphone is muted, audio reader drains chunks without feeding the pipeline.

        Previously the reader injected silence frames to drive VAD's
        speech→silence transition, but with the audio-source pause/resume
        wiring set_microphone(False) now pauses the hardware directly
        (OS mic indicator off) and request_stop() handles end-of-recording
        explicitly — there's no longer anything for the silence frames to do.
        """
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
        # With pause()/resume() wiring, nothing is fed to the pipeline while muted.
        assert service._pipeline._audio_queue.empty()
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
            speech_onset_consecutive_chunks=1,
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
            speech_onset_consecutive_chunks=1,
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

    def test_warmup_runs_main_transcriber(self) -> None:
        """warmup() runs a dummy transcription through the main transcriber."""
        service, transcriber, _, _ = self._make_service()
        assert transcriber.call_count == 0
        service.warmup()
        assert transcriber.call_count == 1
        service.shutdown()

    def test_warmup_runs_realtime_transcriber(self) -> None:
        """warmup() also warms up the realtime transcriber when present."""
        rt_transcriber = FakeTranscriber()
        service, transcriber, _, _ = self._make_service(realtime_transcriber=rt_transcriber)
        service.warmup()
        assert transcriber.call_count == 1
        assert rt_transcriber.call_count == 1
        service.shutdown()

    def test_warmup_skips_realtime_when_absent(self) -> None:
        """warmup() works fine without a realtime transcriber."""
        service, transcriber, _, _ = self._make_service()
        service.warmup()
        assert transcriber.call_count == 1
        service.shutdown()

    def test_warmup_loads_diarizer_when_present(self) -> None:
        """warmup() also eagerly loads the diarizer so the first diarized
        utterance (and the renderer's warming spinner) doesn't stall."""
        diarizer = FakeDiarizer(segments=(SpeakerSegment(start=0.0, end=1.0, speaker=0),))
        service, transcriber, _, _ = self._make_service(diarizer=diarizer)
        assert diarizer.diarize_calls == 0
        service.warmup()
        assert transcriber.call_count == 1
        assert diarizer.diarize_calls == 1
        service.shutdown()

    def test_warmup_is_safe_when_main_transcriber_slot_is_none(self) -> None:
        """Defensive guard: a swap can leave the slot transiently ``None``,
        and an unlucky warmup re-call should not crash."""
        service, _, _, _ = self._make_service()
        service._transcriber = None  # type: ignore[assignment]
        service.warmup()  # must not raise
        service.shutdown()

    def test_swap_transcriber_safe_when_old_is_none(self) -> None:
        """First install (or post-failed-restore state): the old slot is
        ``None``, so ``swap_transcriber`` skips the shutdown call."""
        service, _, _, _ = self._make_service()
        service._transcriber = None  # type: ignore[assignment]
        new_transcriber = FakeTranscriber()
        service.swap_transcriber(new_transcriber)
        assert service._transcriber is new_transcriber
        service.shutdown()

    def test_abort_unblocks_wait_audio(self) -> None:
        """abort() puts a sentinel on the queue so wait_audio() returns False immediately."""
        service, _, _, _ = self._make_service()
        service.abort()
        result = service.wait_audio()
        assert result is False
        service.shutdown()

    def test_swap_transcriber(self) -> None:
        """swap_transcriber replaces the transcriber and shuts down the old one."""
        service, old_transcriber, _, _ = self._make_service(transcription_text="old text")
        new_transcriber = FakeTranscriber(
            result=TranscriptionResult(
                text="new text",
                language="en",
                language_probability=0.99,
                duration_seconds=1.0,
            )
        )
        service.swap_transcriber(new_transcriber)
        assert old_transcriber.shutdown_called
        result = service.transcribe()
        assert result == "New text."
        service.shutdown()

    def test_clear_feed_buffer(self) -> None:
        """clear_feed_buffer() empties the internal byte buffer used by feed_audio."""
        service, _, _, _ = self._make_service()
        # Seed the feed buffer with a partial chunk (less than buffer_size * 2 bytes)
        service._feed_buffer = bytearray(b"\x01\x02\x03\x04")
        assert len(service._feed_buffer) > 0
        service.clear_feed_buffer()
        assert len(service._feed_buffer) == 0
        service.shutdown()

    def test_set_external_audio_mode(self) -> None:
        """set_external_audio_mode toggles the flag."""
        service, _, _, _ = self._make_service()
        assert service._external_audio_mode is False
        service.set_external_audio_mode(True)
        assert service._external_audio_mode is True
        service.set_external_audio_mode(False)
        assert service._external_audio_mode is False
        service.shutdown()

    def test_audio_reader_discards_in_external_audio_mode(self) -> None:
        """When mic is off AND external audio mode is active, reader discards chunks."""
        service, _, _, _ = self._make_service(use_microphone=True)
        service._microphone_enabled = False
        service._external_audio_mode = True
        service._is_running = True

        def stop_soon() -> None:
            time.sleep(0.1)
            service._is_running = False

        t = threading.Thread(target=stop_soon)
        t.start()
        service._audio_reader_loop()
        t.join()
        # In external audio mode, no silence is injected — queue should be empty
        assert service._pipeline._audio_queue.empty()
        service.shutdown()

    def test_set_input_device_delegates_to_audio_source(self) -> None:
        service, _, _, audio_source = self._make_service()
        service.set_input_device(7)
        assert audio_source.switched_to == [7]
        assert service._config.audio.input_device_index == 7

    def test_set_input_device_to_none_falls_back_to_default(self) -> None:
        service, _, _, audio_source = self._make_service()
        service._config.audio.input_device_index = 4
        service.set_input_device(None)
        assert audio_source.switched_to == [None]
        assert service._config.audio.input_device_index is None

    # ---- _reuse_realtime_text_if_eligible / text() reuse path ----

    def _make_service_with_realtime(
        self,
        *,
        use_main_model_for_realtime: bool,
        enable_realtime: bool = True,
        share_transcriber: bool = True,
    ) -> tuple[RecorderService, FakeTranscriber]:
        config = RecorderConfig.from_kwargs(
            post_speech_silence_duration=0.05,
            min_length_of_recording=0.0,
            use_microphone=False,
            speech_onset_consecutive_chunks=1,
            enable_realtime_transcription=enable_realtime,
            use_main_model_for_realtime=use_main_model_for_realtime,
        )
        transcriber = FakeTranscriber(
            result=TranscriptionResult(
                text="full pass",
                language="en",
                language_probability=0.99,
                duration_seconds=1.0,
            )
        )
        # When the toggle is on, the bootstrap shares the same instance.
        # When off, it builds a separate realtime model.
        realtime_transcriber: FakeTranscriber | None = (
            transcriber
            if share_transcriber
            else FakeTranscriber(
                result=TranscriptionResult(
                    text="realtime model",
                    language="en",
                    language_probability=0.99,
                    duration_seconds=1.0,
                )
            )
        )
        service = RecorderService(
            audio_source=FakeAudioSource(),
            vad=FakeVAD(speech_pattern=[True] + [False] * 20),
            transcriber=transcriber,
            wake_word_detector=None,
            realtime_transcriber=realtime_transcriber,
            config=config,
            event_bus=EventBus(),
            clock=Clock.system_clock(),
        )
        return service, transcriber

    def test_reuse_realtime_returns_none_when_realtime_disabled(self) -> None:
        service, _ = self._make_service_with_realtime(
            use_main_model_for_realtime=True,
            enable_realtime=False,
        )
        service._last_realtime_text = "stale preview"
        assert service._reuse_realtime_text_if_eligible() is None
        service.shutdown()

    def test_reuse_realtime_returns_none_when_use_main_off(self) -> None:
        service, _ = self._make_service_with_realtime(
            use_main_model_for_realtime=False,
            share_transcriber=False,
        )
        service._last_realtime_text = "stale preview"
        assert service._reuse_realtime_text_if_eligible() is None
        service.shutdown()

    def test_reuse_realtime_returns_none_when_transcribers_differ(self) -> None:
        # Toggle is on but a separate realtime model is wired — bootstrap
        # would normally prevent this, but we guard against it anyway.
        service, _ = self._make_service_with_realtime(
            use_main_model_for_realtime=True,
            share_transcriber=False,
        )
        service._last_realtime_text = "stale preview"
        assert service._reuse_realtime_text_if_eligible() is None
        service.shutdown()

    def test_reuse_realtime_returns_none_when_no_cached_text(self) -> None:
        service, _ = self._make_service_with_realtime(
            use_main_model_for_realtime=True,
        )
        assert service._last_realtime_text == ""
        assert service._reuse_realtime_text_if_eligible() is None
        service.shutdown()

    def test_reuse_realtime_returns_cached_text_and_clears_it(self) -> None:
        service, _ = self._make_service_with_realtime(
            use_main_model_for_realtime=True,
        )
        service._last_realtime_text = "hello world"
        assert service._reuse_realtime_text_if_eligible() == "hello world"
        # Subsequent call must not return the same text — the cache is
        # one-shot to prevent reusing yesterday's preview for today's audio.
        assert service._reuse_realtime_text_if_eligible() is None
        service.shutdown()

    def test_text_skips_full_transcription_when_realtime_reusable(self) -> None:
        """text() should skip the dedicated full transcribe call when the
        realtime worker has already produced output with the same model.

        We disable the realtime worker (enable_realtime=False) and instead
        directly verify what text() does given a pre-seeded cache + the
        toggle on. The eligibility check returns None in that config, so
        text() runs the full path — proving the gate is enforced. The reuse
        path itself is covered by the unit tests above; the end-to-end wiring
        is exercised in test_facade.py."""
        service, transcriber = self._make_service_with_realtime(
            use_main_model_for_realtime=True,
            enable_realtime=False,
        )
        # Seed the cache — but realtime is disabled, so eligibility fails and
        # text() should still call the main transcriber.
        service._last_realtime_text = "stale preview"
        chunk = struct.pack("<512h", *([100] * 512))
        chunks = [chunk for _ in range(22)]

        def feed_audio() -> None:
            time.sleep(0.05)
            for c in chunks:
                service.feed_audio(c)
                time.sleep(0.01)

        t = threading.Thread(target=feed_audio)
        t.start()
        before = transcriber.call_count
        result = service.text()
        t.join()
        service.shutdown()
        assert result == "Full pass."  # preprocessed FakeTranscriber output
        assert transcriber.call_count == before + 1

    # ---- Model swap (request_model_swap / _swap_worker) ----

    def _wait_for(self, predicate: Callable[[], bool], timeout: float = 5.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return
            time.sleep(0.005)
        raise AssertionError("condition not met within timeout")

    def test_set_swap_progress_sink_installs_callback(self) -> None:
        service, _, _, _ = self._make_service()
        sink = object()
        service.set_swap_progress_sink(sink)
        assert service._swap_progress_sink is sink
        service.set_swap_progress_sink(None)
        assert service._swap_progress_sink is None
        service.shutdown()

    def test_request_model_swap_unknown_kind_raises(self) -> None:
        service, _, _, _ = self._make_service()
        try:
            service.request_model_swap("bogus", "some/model")
            raise AssertionError("expected ValueError")
        except ValueError as e:
            assert "bogus" in str(e)
        service.shutdown()

    def test_request_model_swap_realtime_disabled_emits_failed(self) -> None:
        from src.recorder.domain.events import ModelSwapFailed

        service, _, event_bus, _ = self._make_service()
        failures: list[ModelSwapFailed] = []
        event_bus.subscribe(ModelSwapFailed, failures.append)
        service.request_model_swap("realtime", "some/model")
        assert len(failures) == 1
        assert failures[0].kind == "realtime"
        assert "disabled" in failures[0].reason.lower()
        assert failures[0].detail == "realtime transcription is disabled"
        service.shutdown()

    def _swap_service(
        self,
    ) -> tuple[RecorderService, FakeTranscriber, EventBus, list[Any]]:
        """Service whose ``_load_transcriber`` is stubbed to return a fake."""
        service, transcriber, event_bus, _ = self._make_service()
        loaded: list[Any] = []

        def fake_load(name: str, on_progress: Callable[[DownloadProgress], None]) -> ITranscriber:
            new = FakeTranscriber(
                result=TranscriptionResult(
                    text=f"loaded {name}",
                    language="en",
                    language_probability=0.99,
                    duration_seconds=1.0,
                )
            )
            loaded.append(new)
            # Drive the progress callback once so the cancel checkpoint runs.
            on_progress(
                DownloadProgress(
                    model=name,
                    progress=0.5,
                    downloaded_bytes=5,
                    total_bytes=10,
                    speed_bps=1.0,
                    eta_seconds=1.0,
                )
            )
            return new

        service._load_transcriber = fake_load  # type: ignore[method-assign]
        return service, transcriber, event_bus, loaded

    def test_model_swap_main_success(self) -> None:
        from src.recorder.domain.events import (
            ModelSwapCompleted,
            ModelSwapStarted,
        )

        service, old_transcriber, event_bus, loaded = self._swap_service()
        started: list[ModelSwapStarted] = []
        completed: list[ModelSwapCompleted] = []
        event_bus.subscribe(ModelSwapStarted, started.append)
        event_bus.subscribe(ModelSwapCompleted, completed.append)

        service.request_model_swap("main", "onnx-community/whisper-base")
        self._wait_for(lambda: len(completed) == 1)

        assert started[0].kind == "main"
        assert completed[0].name == "onnx-community/whisper-base"
        # Pointer was swapped + old model shut down.
        assert service._transcriber is loaded[0]
        assert old_transcriber.shutdown_called
        assert service._config.transcription.model == "onnx-community/whisper-base"
        service.shutdown()

    def test_model_swap_realtime_success(self) -> None:
        from src.recorder.domain.events import ModelSwapCompleted

        rt = FakeTranscriber()
        service, _, event_bus, loaded = self._swap_service()
        service._realtime_transcriber = rt
        service._config.realtime.enable_realtime_transcription = True
        completed: list[ModelSwapCompleted] = []
        event_bus.subscribe(ModelSwapCompleted, completed.append)

        service.request_model_swap("realtime", "onnx-community/whisper-tiny")
        self._wait_for(lambda: len(completed) == 1)

        assert service._realtime_transcriber is loaded[0]
        assert rt.shutdown_called
        assert service._config.realtime.realtime_model_type == "onnx-community/whisper-tiny"
        service.shutdown()

    def test_model_swap_main_relinks_realtime_when_slaved(self) -> None:
        """Regression: when ``use_main_model_for_realtime`` is on, the
        realtime slot must follow the main slot through a swap. Pre-fix,
        the realtime slot kept pointing at the now-shut-down old main
        instance, so the pill went dead while the final paste came from
        the new model (e.g. v3-turbo pasting Arabic correctly while
        the pill stayed blank).
        """
        from src.recorder.domain.events import ModelSwapCompleted

        service, old_transcriber, event_bus, loaded = self._swap_service()
        # Mirror what bootstrap does when the toggle is on: both slots
        # hold the SAME instance and share a single lock.
        service._realtime_transcriber = old_transcriber
        service._realtime_transcriber_lock = service._main_transcriber_lock
        service._config.realtime.enable_realtime_transcription = True
        service._config.realtime.use_main_model_for_realtime = True

        completed: list[ModelSwapCompleted] = []
        event_bus.subscribe(ModelSwapCompleted, completed.append)

        service.request_model_swap("main", "onnx-community/whisper-base")
        self._wait_for(lambda: len(completed) == 1)

        # Both slots now point at the freshly loaded transcriber and the
        # config name was mirrored so ``_reuse_realtime_text_if_eligible``
        # still recognises the slaving via its identity check.
        assert service._transcriber is loaded[0]
        assert service._realtime_transcriber is loaded[0]
        assert service._realtime_transcriber is service._transcriber
        assert service._realtime_transcriber_lock is service._main_transcriber_lock
        assert service._config.realtime.realtime_model_type == "onnx-community/whisper-base"
        # And ``_realtime_reuse_enabled`` flips back to True so the
        # end-of-recording duplicate transcribe is short-circuited again.
        assert service._realtime_reuse_enabled() is True
        service.shutdown()

    def test_model_swap_main_leaves_unslaved_realtime_alone(self) -> None:
        """When the toggle is off, a main swap must not touch the
        independently-managed realtime slot."""
        from src.recorder.domain.events import ModelSwapCompleted

        rt = FakeTranscriber()
        service, _, event_bus, loaded = self._swap_service()
        service._realtime_transcriber = rt
        service._config.realtime.enable_realtime_transcription = True
        service._config.realtime.use_main_model_for_realtime = False

        completed: list[ModelSwapCompleted] = []
        event_bus.subscribe(ModelSwapCompleted, completed.append)

        service.request_model_swap("main", "onnx-community/whisper-base")
        self._wait_for(lambda: len(completed) == 1)

        assert service._transcriber is loaded[0]
        assert service._realtime_transcriber is rt
        assert not rt.shutdown_called
        service.shutdown()

    def test_request_realtime_swap_rejected_when_slaved_to_main(self) -> None:
        """A direct ``reload_realtime_model`` while slaved would silently
        un-slave the worker — reject it cleanly instead."""
        from src.recorder.domain.events import ModelSwapFailed

        service, _, event_bus, _ = self._make_service()
        service._config.realtime.enable_realtime_transcription = True
        service._config.realtime.use_main_model_for_realtime = True
        failures: list[ModelSwapFailed] = []
        event_bus.subscribe(ModelSwapFailed, failures.append)

        service.request_model_swap("realtime", "some/model")
        assert len(failures) == 1
        assert failures[0].kind == "realtime"
        assert "use main model" in failures[0].reason.lower()
        assert failures[0].detail == "use_main_model_for_realtime is on"
        service.shutdown()

    def test_model_swap_load_failure_emits_failed_and_restores(self) -> None:
        """Unload-first contract: the old model is shut down BEFORE we try
        to load the new one, so a failed load can't leave the old in
        place verbatim — we rebuild it from its saved name. The slot ends
        up with a fresh instance loaded from the previous config."""
        from src.recorder.domain.events import ModelSwapFailed

        service, old, event_bus, _ = self._make_service()
        original_name = service._config.transcription.model
        failures: list[ModelSwapFailed] = []
        event_bus.subscribe(ModelSwapFailed, failures.append)

        rebuilt = FakeTranscriber()
        call_log: list[str] = []

        def loader(name: str, on_progress: Callable[[DownloadProgress], None]) -> ITranscriber:
            call_log.append(name)
            if name == "x/y":
                raise type("ConnectionError", (Exception,), {})("dns lookup failed")
            return rebuilt

        service._load_transcriber = loader  # type: ignore[method-assign]
        service.request_model_swap("main", "x/y")
        self._wait_for(lambda: len(failures) == 1)
        # Reason is the localised user message; category + detail let
        # the renderer pick a variant and surface the raw exception.
        assert failures[0].category == "network"
        assert "internet" in failures[0].reason.lower()
        assert "ConnectionError" in failures[0].detail
        # Old was shut down on the unload phase.
        assert old.shutdown_called
        # Restore loaded the previous model name back into the slot.
        self._wait_for(lambda: service._transcriber is rebuilt)
        assert "x/y" in call_log
        assert original_name in call_log
        assert service._config.transcription.model == original_name
        service.shutdown()

    def test_model_swap_cancelled_mid_download_restores_previous(self) -> None:
        from src.recorder.domain.errors import DownloadCancelledError
        from src.recorder.domain.events import ModelSwapFailed

        service, old, event_bus, _ = self._make_service()
        original_name = service._config.transcription.model
        failures: list[ModelSwapFailed] = []
        event_bus.subscribe(ModelSwapFailed, failures.append)

        rebuilt = FakeTranscriber()

        def loader(name: str, on_progress: Callable[[DownloadProgress], None]) -> ITranscriber:
            if name == "x/y":
                raise DownloadCancelledError(name)
            return rebuilt

        service._load_transcriber = loader  # type: ignore[method-assign]
        service.request_model_swap("main", "x/y")
        self._wait_for(lambda: len(failures) == 1)
        assert failures[0].category == "cancelled"
        assert "cancelled" in failures[0].reason.lower()
        assert old.shutdown_called
        self._wait_for(lambda: service._transcriber is rebuilt)
        assert service._config.transcription.model == original_name
        service.shutdown()

    def test_model_swap_load_failure_with_lost_restore_leaves_slot_empty(self) -> None:
        """If the restore *also* fails, the slot stays ``None`` and
        future transcribe calls skip via ``_safe_transcribe``."""
        from src.recorder.domain.events import ModelSwapFailed

        service, _, event_bus, _ = self._make_service()
        failures: list[ModelSwapFailed] = []
        event_bus.subscribe(ModelSwapFailed, failures.append)

        def always_boom(name: str, on_progress: Callable[[DownloadProgress], None]) -> ITranscriber:
            raise RuntimeError("CUDA out of memory")

        service._load_transcriber = always_boom  # type: ignore[method-assign]
        service.request_model_swap("main", "x/y")
        self._wait_for(lambda: len(failures) == 1)
        self._wait_for(lambda: service._transcriber is None)
        assert failures[0].category == "out_of_memory"
        # Now a transcribe attempt skips gracefully instead of raising.
        assert service.transcribe() == ""
        service.shutdown()

    def test_model_swap_superseded_when_cancel_set_after_load(self) -> None:
        """If a newer swap supersedes us between load and commit, the
        half-built new model is dropped, ``ModelSwapFailed("superseded")``
        fires, and the previous model is rebuilt into the slot."""
        from src.recorder.domain.events import ModelSwapFailed

        service, old, event_bus, _ = self._make_service()
        original_name = service._config.transcription.model
        failures: list[ModelSwapFailed] = []
        event_bus.subscribe(ModelSwapFailed, failures.append)
        new_fake = FakeTranscriber()
        rebuilt = FakeTranscriber()

        def loader(name: str, on_progress: Callable[[DownloadProgress], None]) -> ITranscriber:
            if name == "x/y":
                # Simulate a newer swap arriving mid-load.
                service._swap_cancel_events["main"].set()
                return new_fake
            return rebuilt

        service._load_transcriber = loader  # type: ignore[method-assign]
        service.request_model_swap("main", "x/y")
        self._wait_for(lambda: len(failures) == 1)
        assert failures[0].category == "superseded"
        assert new_fake.shutdown_called  # half-built new is dropped
        assert old.shutdown_called  # old was already shut down on the unload phase
        self._wait_for(lambda: service._transcriber is rebuilt)
        assert service._config.transcription.model == original_name
        service.shutdown()

    def test_request_model_swap_cancels_prior_inflight(self) -> None:
        service, _, _, _ = self._make_service()
        prior = threading.Event()
        service._swap_cancel_events["main"] = prior
        # Stub the worker so the thread does nothing observable.
        service._swap_worker = lambda *a, **k: None  # type: ignore[method-assign]
        service.request_model_swap("main", "x/y")
        assert prior.is_set()  # the prior swap's cancel event was set
        # A fresh cancel event replaced it.
        assert service._swap_cancel_events["main"] is not prior
        service.shutdown()

    # ---- _SwapProgress callback unit tests ----

    def test_swap_progress_raises_on_cancel(self) -> None:
        from src.recorder.application.recorder_service import _SwapProgress
        from src.recorder.domain.errors import DownloadCancelledError
        from src.recorder.domain.events import DownloadProgress

        service, _, _, _ = self._make_service()
        cancel = threading.Event()
        cancel.set()
        cb = _SwapProgress(service, "m", cancel)
        info = DownloadProgress(
            model="m", progress=0.1, downloaded_bytes=1, total_bytes=10, speed_bps=1.0, eta_seconds=9.0
        )
        try:
            cb(info)
            raise AssertionError("expected DownloadCancelledError")
        except DownloadCancelledError:
            pass
        service.shutdown()

    def test_swap_progress_forwards_to_sink(self) -> None:
        from src.recorder.application.recorder_service import _SwapProgress
        from src.recorder.domain.events import DownloadProgress

        service, _, _, _ = self._make_service()
        received: list[DownloadProgress] = []
        service.set_swap_progress_sink(received.append)
        cb = _SwapProgress(service, "m", threading.Event())
        info = DownloadProgress(
            model="m", progress=0.2, downloaded_bytes=2, total_bytes=10, speed_bps=1.0, eta_seconds=8.0
        )
        cb(info)
        assert received == [info]
        service.shutdown()

    def test_swap_progress_no_sink_is_noop(self) -> None:
        from src.recorder.application.recorder_service import _SwapProgress
        from src.recorder.domain.events import DownloadProgress

        service, _, _, _ = self._make_service()
        assert service._swap_progress_sink is None
        cb = _SwapProgress(service, "m", threading.Event())
        cb(
            DownloadProgress(
                model="m", progress=0.3, downloaded_bytes=3, total_bytes=10, speed_bps=1.0, eta_seconds=7.0
            )
        )  # should not raise
        service.shutdown()

    def test_swap_progress_swallows_sink_exception(self) -> None:
        from src.recorder.application.recorder_service import _SwapProgress
        from src.recorder.domain.events import DownloadProgress

        service, _, _, _ = self._make_service()

        def bad_sink(info: DownloadProgress) -> None:
            raise RuntimeError("sink boom")

        service.set_swap_progress_sink(bad_sink)
        cb = _SwapProgress(service, "m", threading.Event())
        cb(
            DownloadProgress(
                model="m", progress=0.4, downloaded_bytes=4, total_bytes=10, speed_bps=1.0, eta_seconds=6.0
            )
        )  # exception is logged + swallowed
        service.shutdown()

    # ---- runtime_info ----

    def test_runtime_info_defaults_without_onnx_attrs(self) -> None:
        service, _, _, _ = self._make_service()
        info = service.runtime_info()
        assert info["device"] == service._config.transcription.device
        assert info["providers"] == []  # FakeTranscriber has no active_providers
        assert info["is_gpu"] is False
        assert info["model"] == service._config.transcription.model
        assert info["realtime_model"] is None
        service.shutdown()

    def test_runtime_info_reports_onnx_providers_and_gpu(self) -> None:
        service, transcriber, _, _ = self._make_service()
        transcriber.active_providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]  # type: ignore[attr-defined]
        transcriber.is_gpu = True  # type: ignore[attr-defined]
        info = service.runtime_info()
        assert info["providers"] == ["CUDAExecutionProvider", "CPUExecutionProvider"]
        assert info["is_gpu"] is True
        service.shutdown()

    def test_runtime_info_includes_realtime_model_when_present(self) -> None:
        rt = FakeTranscriber()
        service, _, _, _ = self._make_service(realtime_transcriber=rt)
        service._config.realtime.realtime_model_type = "onnx-community/whisper-tiny"
        info = service.runtime_info()
        assert info["realtime_model"] == "onnx-community/whisper-tiny"
        service.shutdown()

    def test_runtime_info_quantization_normalises_empty(self) -> None:
        """Empty-string quantization (the default fp32 export) is reported as
        the empty string; non-empty quants are passed through verbatim.
        Exercises both branches of the `or ""` normalisation so the
        ``onnx_quantization`` / ``realtime_quantization`` fields are honest
        when the user hasn't picked a specific precision."""
        service, _, _, _ = self._make_service()
        # Default fp32: empty string in config → empty string in runtime_info
        service._config.transcription.onnx_quantization = ""
        info = service.runtime_info()
        assert info["onnx_quantization"] == ""
        assert info["realtime_quantization"] == ""
        # Specific quant survives the normalisation
        service._config.transcription.onnx_quantization = "fp16"
        info = service.runtime_info()
        assert info["onnx_quantization"] == "fp16"
        assert info["realtime_quantization"] == "fp16"
        service.shutdown()

    # ---- extracted helper unit tests ----

    def test_resolve_onnx_name_prefers_onnx_model_name(self) -> None:
        from src.recorder.domain.model_registry import ModelCatalog

        service, _, _, _ = self._make_service()
        catalog = ModelCatalog()
        info = next(m for m in catalog.list_all() if m.onnx_model_name)
        assert service._resolve_onnx_name(info, "fallback") == info.onnx_model_name
        assert service._resolve_onnx_name(None, "fallback") == "fallback"
        service.shutdown()

    def test_audio_stats_empty_and_nonempty(self) -> None:
        service, _, _, _ = self._make_service()
        assert service._audio_stats(np.array([], dtype=np.float32)) == (0.0, 0.0, 0.0)
        peak, rms, nz = service._audio_stats(np.array([0.0, 0.5, -0.5], dtype=np.float32))
        assert peak == 0.5
        assert rms > 0.0
        assert nz > 0.0
        service.shutdown()

    def test_assemble_realtime_text_combinations(self) -> None:
        service, _, _, _ = self._make_service()
        service._realtime_committed_text = ""
        assert service._assemble_realtime_text("fresh") == "fresh"
        service._realtime_committed_text = "old"
        assert service._assemble_realtime_text("") == "old"
        assert service._assemble_realtime_text("new") == "old new"
        service.shutdown()

    def test_text_reuses_realtime_output_when_eligible(self) -> None:
        """text() returns the realtime worker's cached text without a full pass.

        Realtime is disabled here so no realtime thread races us; the
        eligibility check is stubbed to mimic the
        ``use_main_model_for_realtime`` toggle being on with cached output.
        The main transcriber must NOT be called for the final pass.
        """
        service, transcriber, _, _ = self._make_service()

        def fake_reuse() -> str:
            return "reused realtime text"

        service._reuse_realtime_text_if_eligible = fake_reuse  # type: ignore[method-assign]
        chunk = struct.pack("<512h", *([100] * 512))
        chunks = [chunk for _ in range(22)]

        def feed_audio() -> None:
            time.sleep(0.05)
            for c in chunks:
                service.feed_audio(c)
                time.sleep(0.01)

        t = threading.Thread(target=feed_audio)
        t.start()
        before = transcriber.call_count
        result = service.text()
        t.join()
        service.shutdown()
        assert result == "reused realtime text"
        # No dedicated full-buffer transcription was performed.
        assert transcriber.call_count == before

    def test_set_microphone_skips_hardware_toggle_in_wake_word_mode(self) -> None:
        """With a wake-word detector, capture stays on (no pause/resume)."""
        service, _, _, audio_source = self._make_service(
            wake_word_detector=FakeWakeWordDetector(),
        )
        pauses: list[bool] = []
        original_pause = audio_source.pause

        def tracking_pause() -> None:
            pauses.append(True)
            original_pause()

        audio_source.pause = tracking_pause  # type: ignore[method-assign]
        service.set_microphone(False)
        # Hardware capture toggle is skipped entirely in wake-word mode.
        assert pauses == []
        service.shutdown()

    def test_handle_microphone_off_noop_when_transcribing(self) -> None:
        """No NoAudioDetected and no request_stop when state is TRANSCRIBING."""
        from src.recorder.domain.events import NoAudioDetected as _NoAudio

        service, _, event_bus, _ = self._make_service()
        events: list[_NoAudio] = []
        event_bus.subscribe(_NoAudio, events.append)
        service._state_machine.transition(RecorderState.LISTENING)
        service._state_machine.transition(RecorderState.RECORDING)
        service._state_machine.transition(RecorderState.TRANSCRIBING)
        service._handle_microphone_off()
        assert events == []
        service.shutdown()

    def test_toggle_hardware_capture_swallows_exception(self) -> None:
        """A raising audio source on pause/resume is logged, not propagated."""
        service, _, _, audio_source = self._make_service()

        def boom() -> None:
            raise RuntimeError("device busy")

        audio_source.pause = boom  # type: ignore[method-assign]
        # Must not raise.
        service._toggle_hardware_capture(microphone_on=False)
        service.shutdown()

    def test_safe_step_swallows_exception(self) -> None:
        def boom() -> None:
            raise RuntimeError("cleanup failed")

        # Static helper: must swallow + log without raising.
        RecorderService._safe_step("doing thing", boom)

    def test_join_alive_warns_when_thread_lingers(self) -> None:
        stop = threading.Event()

        def run() -> None:
            stop.wait(timeout=5.0)

        thread = threading.Thread(target=run, name="lingering")
        thread.start()
        try:
            # Thread is still alive after the short join timeout.
            RecorderService._join_alive(thread, "lingering")
            assert thread.is_alive()
        finally:
            stop.set()
            thread.join()

    def test_shutdown_transcriber_safely_swallows_exception(self) -> None:
        old = FakeTranscriber()

        def boom() -> None:
            raise RuntimeError("ort cleanup blew up")

        old.shutdown = boom  # type: ignore[method-assign]
        # Exception must be swallowed so the swap worker can keep
        # making progress toward installing the new model.
        RecorderService._shutdown_transcriber_safely("main", old)

    def test_shutdown_transcriber_safely_noop_when_none(self) -> None:
        # First-install case: nothing in the slot yet, helper is a no-op.
        RecorderService._shutdown_transcriber_safely("main", None)

    def test_handle_audio_read_error_stops_after_max_errors(self) -> None:
        service, _, _, _ = self._make_service()
        service._is_running = True
        max_errors = service._MAX_CONSECUTIVE_AUDIO_ERRORS
        result = service._handle_audio_read_error(OSError("boom"), max_errors - 1)
        assert result == max_errors
        assert service._is_running is False
        service.shutdown()

    def test_commit_chunk_appends_committed_text(self) -> None:
        rt = FakeTranscriber(
            result=TranscriptionResult(
                text="committed words",
                language="en",
                language_probability=0.99,
                duration_seconds=0.5,
            )
        )
        service, _, _, _ = self._make_service(realtime_transcriber=rt)
        chunk = struct.pack("<512h", *([100] * 512))
        for _ in range(10):
            service._audio_buffer.add_frame(chunk)
        service._realtime_committed_text = ""
        service._commit_chunk(0, 5)
        # _preprocess_output capitalizes + adds a trailing period.
        assert "Committed words" in service._realtime_committed_text
        # Second commit appends with a separating space.
        service._commit_chunk(5, 5)
        assert service._realtime_committed_text.count("Committed words") == 2
        service.shutdown()

    def test_commit_chunk_skips_empty_audio_slice(self) -> None:
        rt = FakeTranscriber()
        service, _, _, _ = self._make_service(realtime_transcriber=rt)
        service._realtime_committed_text = ""
        # Empty buffer → zero-length slice → early return, no transcription.
        service._commit_chunk(0, 5)
        assert service._realtime_committed_text == ""
        assert rt.call_count == 0
        service.shutdown()

    def test_realtime_commit_if_needed_advances_watermark(self) -> None:
        rt = FakeTranscriber(
            result=TranscriptionResult(
                text="chunk text",
                language="en",
                language_probability=0.99,
                duration_seconds=0.5,
            )
        )
        from src.recorder.application.recorder_service import (
            REALTIME_COMMIT_AFTER_SECONDS,
        )

        service, _, _, _ = self._make_service(realtime_transcriber=rt)
        chunk = struct.pack("<512h", *([100] * 512))
        fps = service._audio_buffer.frames_per_second()
        commit_chunk_frames = max(1, int(REALTIME_COMMIT_AFTER_SECONDS * fps))
        # Enough fresh frames to exceed the commit threshold.
        for _ in range(commit_chunk_frames + 5):
            service._audio_buffer.add_frame(chunk)
        service._realtime_committed_frames = 0
        new_watermark = service._realtime_commit_if_needed()
        assert new_watermark == commit_chunk_frames
        service.shutdown()

    def test_realtime_commit_if_needed_noop_below_threshold(self) -> None:
        service, _, _, _ = self._make_service()
        chunk = struct.pack("<512h", *([100] * 512))
        service._audio_buffer.add_frame(chunk)
        service._realtime_committed_frames = 0
        assert service._realtime_commit_if_needed() == 0
        service.shutdown()

    def test_commit_chunk_skips_when_realtime_transcriber_is_none(self) -> None:
        """During an unload-first realtime swap the slot is briefly None;
        ``_commit_chunk`` must skip instead of crashing."""
        service, _, _, _ = self._make_service(realtime_transcriber=FakeTranscriber())
        chunk = struct.pack("<512h", *([100] * 512))
        for _ in range(10):
            service._audio_buffer.add_frame(chunk)
        # Detach the realtime transcriber to simulate the mid-swap state.
        service._realtime_transcriber = None
        service._realtime_committed_text = ""
        service._commit_chunk(0, 5)
        assert service._realtime_committed_text == ""
        service.shutdown()

    def test_realtime_publish_fresh_skips_when_realtime_transcriber_is_none(self) -> None:
        service, _, _, _ = self._make_service(realtime_transcriber=FakeTranscriber())
        # State machine must be in a recording state so the function
        # reaches the transcribe call (it early-exits otherwise — see the
        # adjacent test for that branch).
        service.listen()
        service.start()
        chunk = struct.pack("<512h", *([100] * 512))
        for _ in range(10):
            service._audio_buffer.add_frame(chunk)
        service._realtime_transcriber = None
        service._last_realtime_text = "untouched"
        service._realtime_publish_fresh(0)
        # _safe_transcribe returned None → realtime worker bailed
        # without overwriting the cached text.
        assert service._last_realtime_text == "untouched"
        service.shutdown()

    def test_realtime_publish_fresh_early_exits_when_not_recording(self) -> None:
        """Optimization guard: realtime worker bails before transcribing if
        the user has already ended dictation (saves ~390ms at end of clip)."""
        rt = FakeTranscriber()
        service, _, _, _ = self._make_service(realtime_transcriber=rt)
        # No listen/start — state stays INACTIVE, so the early-exit fires.
        chunk = struct.pack("<512h", *([100] * 512))
        for _ in range(10):
            service._audio_buffer.add_frame(chunk)
        service._realtime_publish_fresh(0)
        assert rt.call_count == 0
        service.shutdown()

    def test_run_full_transcription_returns_empty_when_main_transcriber_is_none(self) -> None:
        """Main transcribe path during the swap returns "" instead of crashing."""
        service, _, _, _ = self._make_service()
        service._transcriber = None  # type: ignore[assignment]
        audio = np.zeros(16000, dtype=np.float32)
        text = service._run_full_transcription(audio, frame_count=10, audio_seconds=0.5)
        assert text == ""
        service.shutdown()

    def test_attempt_restore_returns_no_previous_when_name_empty(self) -> None:
        """Edge case: first install (no prior model). ``_attempt_restore``
        is a no-op and the benchmark line tags the swap accordingly."""
        from src.recorder.application.swap_benchmark import SwapBenchmark

        service, _, _, _ = self._make_service()
        bench = SwapBenchmark("main", "x/y")
        outcome = service._attempt_restore("main", "", bench)
        assert outcome == "no_previous"
        service.shutdown()

    def test_attempt_restore_lost_when_rebuild_fails(self) -> None:
        """If rebuilding the previous model also fails, the slot is left
        empty and the benchmark line tags it as ``lost``."""
        from src.recorder.application.swap_benchmark import SwapBenchmark

        service, _, _, _ = self._make_service()

        def always_boom(name: str, on_progress: Callable[[DownloadProgress], None]) -> ITranscriber:
            raise RuntimeError("ENOSPC")

        service._load_transcriber = always_boom  # type: ignore[method-assign]
        bench = SwapBenchmark("main", "x/y")
        outcome = service._attempt_restore("main", "previous/model", bench)
        assert outcome == "lost"
        service.shutdown()

    def test_commit_chunk_skips_append_when_text_blank(self) -> None:
        """Whitespace-only transcription preprocesses to '' → no append."""
        rt = FakeTranscriber(
            result=TranscriptionResult(
                text="   ",
                language="en",
                language_probability=0.99,
                duration_seconds=0.5,
            )
        )
        service, _, _, _ = self._make_service(realtime_transcriber=rt)
        chunk = struct.pack("<512h", *([100] * 512))
        for _ in range(10):
            service._audio_buffer.add_frame(chunk)
        service._realtime_committed_text = "prior"
        service._commit_chunk(0, 5)
        # Blank preprocessed text must not mutate the accumulator.
        assert service._realtime_committed_text == "prior"
        assert rt.call_count == 1
        service.shutdown()

    def test_load_transcriber_constructs_onnx_adapter(self) -> None:
        """_load_transcriber wires ModelCatalog + device providers + adapter.

        The real ONNX adapter is patched so no model is fetched; this only
        verifies the application-layer late-import + construction lines.
        """
        from unittest.mock import patch

        service, _, _, _ = self._make_service()
        captured: dict[str, Any] = {}

        class _FakeAdapter(FakeTranscriber):
            def __init__(self, **kwargs: object) -> None:
                super().__init__()
                captured.update(kwargs)

        def fake_progress(_p: DownloadProgress) -> None:
            return None

        with (
            patch(
                "src.recorder.infrastructure.onnxasr_transcriber.OnnxAsrTranscriber",
                _FakeAdapter,
            ),
            patch(
                "src.recorder.infrastructure.device.providers_for_settings",
                return_value=["CPUExecutionProvider"],
            ),
        ):
            result = service._load_transcriber("onnx-community/whisper-base", fake_progress)

        assert isinstance(result, _FakeAdapter)
        assert captured["providers"] == ["CPUExecutionProvider"]
        assert captured["on_download_progress"] is fake_progress

    # ---- Runtime diarization toggle ----

    def _wait_for_completion(
        self,
        completed: list[Any],
        failed: list[Any],
        timeout: float = 5.0,
    ) -> None:
        """Wait until the toggle worker publishes a terminal event."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if completed or failed:
                return
            time.sleep(0.005)
        raise AssertionError("toggle worker never published a terminal event")

    def test_diarization_toggle_enable_publishes_started_then_completed(self) -> None:
        from unittest.mock import patch

        from src.recorder.domain.events import (
            DiarizationToggleCompleted,
            DiarizationToggleFailed,
            DiarizationToggleStarted,
        )

        service, _, event_bus, _ = self._make_service()
        started: list[DiarizationToggleStarted] = []
        completed: list[DiarizationToggleCompleted] = []
        failed: list[DiarizationToggleFailed] = []
        event_bus.subscribe(DiarizationToggleStarted, started.append)
        event_bus.subscribe(DiarizationToggleCompleted, completed.append)
        event_bus.subscribe(DiarizationToggleFailed, failed.append)
        fake = FakeDiarizer()
        with patch("src.recorder.bootstrap.build_diarizer", return_value=fake):
            service.request_diarization_toggle(True)
            self._wait_for_completion(completed, failed)
        assert started and started[0].enabled is True
        assert completed and completed[0].enabled is True
        assert failed == []
        assert service._diarizer is fake
        service.shutdown()

    def test_diarization_toggle_disable_tears_down_and_calls_shutdown(self) -> None:
        from src.recorder.domain.events import (
            DiarizationToggleCompleted,
            DiarizationToggleFailed,
        )

        fake = FakeDiarizer()
        service, _, event_bus, _ = self._make_service(diarizer=fake)
        completed: list[DiarizationToggleCompleted] = []
        failed: list[DiarizationToggleFailed] = []
        event_bus.subscribe(DiarizationToggleCompleted, completed.append)
        event_bus.subscribe(DiarizationToggleFailed, failed.append)

        service.request_diarization_toggle(False)
        self._wait_for_completion(completed, failed)

        assert completed and completed[0].enabled is False
        assert failed == []
        assert service._diarizer is None
        assert fake.shutdown_calls == 1
        service.shutdown()

    def test_diarization_toggle_noop_emits_completed_without_loading(self) -> None:
        from unittest.mock import patch

        from src.recorder.domain.events import (
            DiarizationToggleCompleted,
            DiarizationToggleFailed,
        )

        fake = FakeDiarizer()
        service, _, event_bus, _ = self._make_service(diarizer=fake)
        completed: list[DiarizationToggleCompleted] = []
        failed: list[DiarizationToggleFailed] = []
        event_bus.subscribe(DiarizationToggleCompleted, completed.append)
        event_bus.subscribe(DiarizationToggleFailed, failed.append)

        with patch("src.recorder.bootstrap.build_diarizer") as build_mock:
            service.request_diarization_toggle(True)  # already on
            self._wait_for_completion(completed, failed)
            assert build_mock.call_count == 0

        assert completed and completed[0].enabled is True
        assert failed == []
        assert fake.shutdown_calls == 0
        assert service._diarizer is fake
        service.shutdown()

    def test_diarization_toggle_disable_noop_when_already_off(self) -> None:
        from src.recorder.domain.events import (
            DiarizationToggleCompleted,
            DiarizationToggleFailed,
        )

        service, _, event_bus, _ = self._make_service()  # no diarizer
        completed: list[DiarizationToggleCompleted] = []
        failed: list[DiarizationToggleFailed] = []
        event_bus.subscribe(DiarizationToggleCompleted, completed.append)
        event_bus.subscribe(DiarizationToggleFailed, failed.append)

        service.request_diarization_toggle(False)
        self._wait_for_completion(completed, failed)

        assert completed and completed[0].enabled is False
        assert failed == []
        assert service._diarizer is None
        service.shutdown()

    def test_diarization_toggle_missing_models_fails(self) -> None:
        from src.recorder.domain.events import (
            DiarizationToggleCompleted,
            DiarizationToggleFailed,
        )

        service, _, event_bus, _ = self._make_service()
        # Wipe the configured model names so the worker refuses on the
        # pre-flight model_not_found branch.
        service._config.diarization.segmentation_model = ""
        service._config.diarization.embedding_model = ""

        completed: list[DiarizationToggleCompleted] = []
        failed: list[DiarizationToggleFailed] = []
        event_bus.subscribe(DiarizationToggleCompleted, completed.append)
        event_bus.subscribe(DiarizationToggleFailed, failed.append)

        service.request_diarization_toggle(True)
        self._wait_for_completion(completed, failed)

        assert completed == []
        assert failed and failed[0].enabled is True
        assert failed[0].category == "model_not_found"
        assert service._diarizer is None
        service.shutdown()

    def test_diarization_toggle_load_failure_classifies_exception(self) -> None:
        from unittest.mock import patch

        from src.recorder.domain.events import (
            DiarizationToggleCompleted,
            DiarizationToggleFailed,
        )

        service, _, event_bus, _ = self._make_service()
        completed: list[DiarizationToggleCompleted] = []
        failed: list[DiarizationToggleFailed] = []
        event_bus.subscribe(DiarizationToggleCompleted, completed.append)
        event_bus.subscribe(DiarizationToggleFailed, failed.append)

        with patch(
            "src.recorder.bootstrap.build_diarizer",
            side_effect=RuntimeError("simulated load explosion"),
        ):
            service.request_diarization_toggle(True)
            self._wait_for_completion(completed, failed)

        assert completed == []
        assert failed and failed[0].enabled is True
        # classify_swap_error maps unexpected RuntimeError to "unknown".
        assert failed[0].category == "unknown"
        assert "simulated load explosion" in failed[0].detail
        assert service._diarizer is None
        service.shutdown()

    def test_diarization_toggle_supersede_emits_failed_for_first(self) -> None:
        """Two enables back-to-back: first thread sees cancel_event set and emits SUPERSEDED."""
        from unittest.mock import patch

        from src.recorder.domain.events import (
            DiarizationToggleCompleted,
            DiarizationToggleFailed,
        )

        service, _, event_bus, _ = self._make_service()
        completed: list[DiarizationToggleCompleted] = []
        failed: list[DiarizationToggleFailed] = []
        event_bus.subscribe(DiarizationToggleCompleted, completed.append)
        event_bus.subscribe(DiarizationToggleFailed, failed.append)

        gate = threading.Event()
        release_first = threading.Event()
        first_diarizer = FakeDiarizer()
        second_diarizer = FakeDiarizer()
        call_count = {"n": 0}

        def slow_build(_cfg: Any) -> FakeDiarizer:  # noqa: ANN401 — duck-typed FakeDiarizer ctor arg
            call_count["n"] += 1
            if call_count["n"] == 1:
                # First call: signal we're loading, then block until the
                # test sets release_first. The test sets the supersede in
                # between, so the cancel_event check after build sees it.
                gate.set()
                release_first.wait(timeout=5.0)
                return first_diarizer
            return second_diarizer

        with patch("src.recorder.bootstrap.build_diarizer", side_effect=slow_build):
            service.request_diarization_toggle(True)
            assert gate.wait(timeout=5.0)
            # Second request supersedes the first.
            service.request_diarization_toggle(True)
            # Let the first thread finish its build; it should detect the
            # cancel event was set and report SUPERSEDED.
            release_first.set()
            self._wait_for(lambda: any(f.enabled is True for f in failed))

        # The second toggle is a no-op (we set diarizer = first_diarizer? No,
        # actually since first is SUPERSEDED, its commit never ran, so the
        # second call finds diarizer still None and proceeds to build). The
        # second build returns second_diarizer and commits.
        self._wait_for(lambda: service._diarizer is second_diarizer)
        assert any(f.category == "unknown" for f in failed)
        service.shutdown()
        service.shutdown()
