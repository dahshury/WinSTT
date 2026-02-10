"""Tests that shutdown completes within a strict time budget.

These tests reproduce the REAL blocking behavior: a loop calling
``recorder.text()`` (which blocks in ``wait_audio()`` for up to 60 s)
and then simulate the Ctrl+C shutdown sequence to verify it exits fast.
"""

from __future__ import annotations

import inspect
import struct
import threading
import time
import weakref

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.recorder.application.recorder_service import RecorderService
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.ports.transcriber import ITranscriber
from tests.fakes.fake_audio_source import FakeAudioSource
from tests.fakes.fake_transcriber import FakeTranscriber
from tests.fakes.fake_vad import FakeVAD


def _make_service(
    *,
    realtime: bool = False,
    transcriber: ITranscriber | None = None,
) -> RecorderService:
    config = RecorderConfig.from_kwargs(
        post_speech_silence_duration=0.05,
        min_length_of_recording=0.0,
        use_microphone=False,
        enable_realtime_transcription=realtime,
        realtime_processing_pause=0.01,
        init_realtime_after_seconds=0.0,
    )
    main_transcriber = transcriber or FakeTranscriber()
    rt_transcriber = FakeTranscriber() if realtime else None
    return RecorderService(
        audio_source=FakeAudioSource(),
        vad=FakeVAD(speech_pattern=[True] * 100),
        transcriber=main_transcriber,
        realtime_transcriber=rt_transcriber,
        config=config,
        event_bus=EventBus(),
        clock=Clock.system_clock(),
    )


class TestRecorderThreadShutdown:
    """Reproduce the real server's _recorder_thread blocking pattern.

    The server runs ``while not stop_recorder: recorder.text(cb)`` in a
    thread.  ``text()`` calls ``wait_audio()`` which blocks for up to 60 s.
    When the user presses Ctrl+C, the server must unblock the recorder
    thread and exit within seconds, not minutes.
    """

    def test_abort_unblocks_text_loop_fast(self) -> None:
        """Simulate _recorder_thread: text() loop + abort from another thread.

        This is THE test that reproduces the 3-minute hang.  text() blocks
        in wait_audio() polling a queue.  abort() puts a sentinel on the
        queue.  The loop must exit within 1 second of abort.
        """
        service = _make_service()
        stop_flag = False
        loop_exited = threading.Event()

        def recorder_loop() -> None:
            """Mimics _recorder_thread's while loop."""
            nonlocal stop_flag
            while not stop_flag:
                service.text()  # blocks in wait_audio()
            loop_exited.set()

        t = threading.Thread(target=recorder_loop, daemon=True)
        t.start()
        # Let text() enter wait_audio() and block
        time.sleep(0.3)

        # Simulate Ctrl+C: set flag + abort (like shutdown_procedure does)
        start = time.monotonic()
        stop_flag = True
        service.abort()  # Puts sentinel on queue to unblock wait_audio()

        exited = loop_exited.wait(timeout=3.0)
        elapsed = time.monotonic() - start

        # Cleanup
        service.shutdown()
        t.join(timeout=2)

        assert exited, "Recorder loop did NOT exit within 3 s (hung in wait_audio)"
        assert elapsed < 2.0, f"Recorder loop took {elapsed:.1f}s to exit after abort"

    def test_abort_during_active_recording(self) -> None:
        """abort() exits fast even when audio is being fed and VAD is active."""
        service = _make_service()
        stop_flag = False
        loop_exited = threading.Event()
        chunk = struct.pack("<512h", *([100] * 512))

        def feed_audio() -> None:
            """Feed audio to keep the pipeline busy."""
            while not stop_flag:
                service.feed_audio(chunk)
                time.sleep(0.01)

        def recorder_loop() -> None:
            nonlocal stop_flag
            while not stop_flag:
                service.text()
            loop_exited.set()

        t_loop = threading.Thread(target=recorder_loop, daemon=True)
        t_feed = threading.Thread(target=feed_audio, daemon=True)
        t_loop.start()
        t_feed.start()
        time.sleep(0.5)  # Let things get going

        start = time.monotonic()
        stop_flag = True
        service.abort()

        exited = loop_exited.wait(timeout=3.0)
        elapsed = time.monotonic() - start
        service.shutdown()
        t_loop.join(timeout=2)
        t_feed.join(timeout=2)

        assert exited, "Recorder loop did NOT exit within 3 s during active recording"
        assert elapsed < 2.0, f"Took {elapsed:.1f}s to exit during active recording"

    def test_full_shutdown_sequence(self) -> None:
        """Simulate the complete server shutdown: abort + join + shutdown.

        This reproduces the full shutdown_procedure() sequence.
        """
        service = _make_service(realtime=True)
        stop_flag = False
        chunk = struct.pack("<512h", *([100] * 512))

        def feed_audio() -> None:
            while not stop_flag:
                service.feed_audio(chunk)
                time.sleep(0.01)

        def recorder_loop() -> None:
            nonlocal stop_flag
            while not stop_flag:
                service.text()

        t_loop = threading.Thread(target=recorder_loop, daemon=True)
        t_feed = threading.Thread(target=feed_audio, daemon=True)
        t_loop.start()
        t_feed.start()
        time.sleep(0.5)

        # Full shutdown sequence (mirrors shutdown_procedure)
        start = time.monotonic()
        stop_flag = True
        service.abort()
        t_loop.join(timeout=2)
        t_feed.join(timeout=1)
        service.shutdown()
        elapsed = time.monotonic() - start

        assert elapsed < 5.0, f"Full shutdown took {elapsed:.1f}s (budget: 5s)"


class TestTranscriberShutdownContract:
    """Verify transcriber shutdown methods are free of hanging operations."""

    def test_whisper_shutdown_has_no_empty_cache(self) -> None:
        """WhisperTranscriber.shutdown() must not call torch.cuda.empty_cache()."""
        from src.recorder.infrastructure.whisper_transcriber import WhisperTranscriber

        source = inspect.getsource(WhisperTranscriber.shutdown)
        assert "empty_cache" not in source, (
            "WhisperTranscriber.shutdown() must not call torch.cuda.empty_cache()"
        )

    def test_realtime_shutdown_has_no_empty_cache(self) -> None:
        """RealtimeTranscriber.shutdown() must not call torch.cuda.empty_cache()."""
        from src.recorder.infrastructure.realtime_transcriber import RealtimeTranscriber

        source = inspect.getsource(RealtimeTranscriber.shutdown)
        assert "empty_cache" not in source, (
            "RealtimeTranscriber.shutdown() must not call torch.cuda.empty_cache()"
        )

    def test_whisper_shutdown_nulls_model(self) -> None:
        """WhisperTranscriber.shutdown() must set _model to None."""
        from src.recorder.infrastructure.whisper_transcriber import WhisperTranscriber

        instance = object.__new__(WhisperTranscriber)
        instance._ready = True
        instance._model = object()
        instance.shutdown()
        assert instance._model is None
        assert instance._ready is False

    def test_realtime_shutdown_nulls_model(self) -> None:
        """RealtimeTranscriber.shutdown() must set _model to None."""
        from src.recorder.infrastructure.realtime_transcriber import RealtimeTranscriber

        instance = object.__new__(RealtimeTranscriber)
        instance._ready = True
        instance._model = object()
        instance.shutdown()
        assert instance._model is None
        assert instance._ready is False


class TestServerSignalHandlerContract:
    """Verify the server signal handler does critical work directly.

    On Windows, signal handlers fire between Python bytecodes but CANNOT
    wake the SelectorEventLoop's select() call.  The signal handler MUST
    set stop_recorder and call recorder.abort() directly — NOT via
    call_soon_threadsafe — so the recorder thread unblocks immediately.
    """

    def test_win_signal_handler_does_not_use_call_soon_threadsafe(self) -> None:
        """The Windows SIGINT path must not route through call_soon_threadsafe."""
        source = inspect.getsource(
            __import__("src.stt_server.server", fromlist=["main_async"]).main_async
        )
        # Find the Windows signal handler block
        win_block_start = source.find("_win_signal_handler")
        assert win_block_start != -1, "Could not find _win_signal_handler in main_async"

        # The handler itself should not use call_soon_threadsafe
        handler_source = source[win_block_start : source.find("signal.signal(signal.SIGINT", win_block_start)]
        assert "call_soon_threadsafe" not in handler_source, (
            "Windows signal handler must NOT use call_soon_threadsafe — "
            "it cannot wake the SelectorEventLoop's select() on Windows"
        )

    def test_shutdown_wait_uses_polling(self) -> None:
        """The shutdown wait must use asyncio.sleep polling, not bare Event.wait()."""
        source = inspect.getsource(
            __import__("src.stt_server.server", fromlist=["main_async"]).main_async
        )
        # Must not have a bare `await shutdown_event.wait()` line
        assert "await shutdown_event.wait()" not in source, (
            "Must use polling loop (asyncio.sleep) instead of bare shutdown_event.wait() — "
            "the latter blocks in select() and prevents signal delivery on Windows"
        )


class TestModelCleanup:
    """Verify that shutdown actually releases model references.

    GPU memory is only freed when all Python references to the model
    are dropped.  These tests ensure RecorderService.shutdown() calls
    shutdown on every transcriber and that no stale references linger.
    """

    def test_shutdown_calls_main_transcriber_shutdown(self) -> None:
        """RecorderService.shutdown() must call shutdown() on the main transcriber."""
        main = FakeTranscriber()
        service = _make_service(transcriber=main)
        service.shutdown()
        assert main.shutdown_called, "Main transcriber shutdown() was never called"

    def test_shutdown_calls_realtime_transcriber_shutdown(self) -> None:
        """RecorderService.shutdown() must call shutdown() on the realtime transcriber."""
        main = FakeTranscriber()
        service = _make_service(transcriber=main, realtime=True)
        # Get a reference to the realtime transcriber before shutdown
        rt = service._realtime_transcriber
        assert rt is not None
        service.shutdown()
        assert isinstance(rt, FakeTranscriber)
        assert rt.shutdown_called, "Realtime transcriber shutdown() was never called"

    def test_whisper_shutdown_releases_model_reference(self) -> None:
        """After WhisperTranscriber.shutdown(), no internal ref keeps the model alive."""
        from src.recorder.infrastructure.whisper_transcriber import WhisperTranscriber

        class _FakeModel:
            """Weakref-able stand-in for a real Whisper model."""

        instance = object.__new__(WhisperTranscriber)
        instance._ready = True
        model = _FakeModel()
        ref = weakref.ref(model)
        instance._model = model
        del model  # Only instance._model holds a reference now

        instance.shutdown()
        assert ref() is None, "Model object still alive after shutdown — leaked reference"

    def test_realtime_shutdown_releases_model_reference(self) -> None:
        """After RealtimeTranscriber.shutdown(), no internal ref keeps the model alive."""
        from src.recorder.infrastructure.realtime_transcriber import RealtimeTranscriber

        class _FakeModel:
            """Weakref-able stand-in for a real Whisper model."""

        instance = object.__new__(RealtimeTranscriber)
        instance._ready = True
        model = _FakeModel()
        ref = weakref.ref(model)
        instance._model = model
        del model

        instance.shutdown()
        assert ref() is None, "Model object still alive after shutdown — leaked reference"

    def test_service_shutdown_releases_transcriber_model_refs(self) -> None:
        """After full service shutdown, transcriber model refs are dead."""
        from src.recorder.infrastructure.whisper_transcriber import WhisperTranscriber

        class _FakeModel:
            """Weakref-able stand-in for a real Whisper model."""

        # Create a WhisperTranscriber with a trackable model object
        transcriber = object.__new__(WhisperTranscriber)
        transcriber._ready = True
        model = _FakeModel()
        model_ref = weakref.ref(model)
        transcriber._model = model
        del model

        service = _make_service(transcriber=transcriber)
        service.shutdown()

        assert model_ref() is None, (
            "Transcriber model still alive after RecorderService.shutdown() — GPU memory leaked"
        )
