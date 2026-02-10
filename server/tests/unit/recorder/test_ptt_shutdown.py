"""Test that reproduces the PTT demo's Ctrl+C hang.

The push_to_talk_demo.py shutdown sequence was:
  1. KeyboardInterrupt caught → exit_event.set()
  2. live.stop()
  3. recorder.shutdown()  ← NO abort() call — HANGS

The transcription_loop thread is stuck in recorder.text() → wait_audio()
which polls a queue with 0.1s timeouts for up to 60 seconds.  Without
abort(), the loop never unblocks, so shutdown() hangs waiting for threads.

The STT server works because its signal handler calls recorder.abort()
(which puts a sentinel on the queue) BEFORE shutdown().

Fix: call recorder.abort() before recorder.shutdown() in the PTT demo,
matching the STT server's shutdown_procedure().
"""

from __future__ import annotations

import threading
import time

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.recorder.application.recorder_service import RecorderService
from src.recorder.domain.config import RecorderConfig
from tests.fakes.fake_audio_source import FakeAudioSource
from tests.fakes.fake_transcriber import FakeTranscriber
from tests.fakes.fake_vad import FakeVAD


def _make_service() -> RecorderService:
    config = RecorderConfig.from_kwargs(
        post_speech_silence_duration=0.05,
        min_length_of_recording=0.0,
        use_microphone=False,
    )
    return RecorderService(
        audio_source=FakeAudioSource(),
        vad=FakeVAD(speech_pattern=[True] * 100),
        transcriber=FakeTranscriber(),
        config=config,
        event_bus=EventBus(),
        clock=Clock.system_clock(),
    )


class TestPTTDemoShutdownHang:
    """Reproduce the PTT demo's shutdown hang.

    The demo calls recorder.text(process_text) in a loop.  text()
    calls wait_audio() which blocks for up to 60 seconds.  Without
    abort(), shutdown() cannot complete because the transcription
    thread holds resources the pipeline needs to release.
    """

    def test_shutdown_without_abort_leaves_thread_blocked(self) -> None:
        """Proves the root cause: shutdown() alone does NOT unblock wait_audio().

        This is the EXACT bug in the PTT demo.  The transcription loop
        stays stuck in wait_audio() even after shutdown() returns.
        """
        service = _make_service()
        loop_exited = threading.Event()

        def transcription_loop() -> None:
            """Mimics the PTT demo's transcription_loop."""
            service.text()  # blocks in wait_audio() indefinitely
            loop_exited.set()

        t = threading.Thread(target=transcription_loop, daemon=True)
        t.start()
        time.sleep(0.3)  # let text() enter wait_audio()

        # PTT demo's OLD shutdown: NO abort, just shutdown()
        service.shutdown()

        exited = loop_exited.wait(timeout=2.0)

        # BUG: the loop did NOT exit — still stuck in wait_audio()
        assert not exited, (
            "Expected the loop to STAY blocked (proving the bug), "
            "but it exited — the fix may already be applied to RecorderService"
        )
        assert t.is_alive(), "Thread should still be alive (stuck in wait_audio)"

        # Cleanup: abort to actually unblock the thread
        service.abort()
        t.join(timeout=2)

    def test_abort_before_shutdown_exits_fast(self) -> None:
        """The fix: abort() + join + shutdown() — matches the STT server pattern.

        This is the correct shutdown sequence used by the STT server's
        shutdown_procedure() and now the PTT demo's finally block.
        """
        service = _make_service()
        exit_event = threading.Event()
        loop_exited = threading.Event()

        def transcription_loop() -> None:
            """Mimics the FIXED PTT demo's transcription_loop."""
            while not exit_event.is_set():
                service.text()
            loop_exited.set()

        t = threading.Thread(target=transcription_loop, daemon=True)
        t.start()
        time.sleep(0.3)

        # Correct shutdown: abort → join → shutdown (mirrors fixed PTT demo)
        start = time.monotonic()
        exit_event.set()
        service.abort()  # Unblocks wait_audio() via queue sentinel
        t.join(timeout=2)
        service.shutdown()
        elapsed = time.monotonic() - start

        exited = loop_exited.wait(timeout=1.0)

        assert exited, "Loop did NOT exit after abort()"
        assert elapsed < 3.0, f"Shutdown took {elapsed:.1f}s (expected < 3s)"
