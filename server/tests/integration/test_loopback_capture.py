"""Integration tests for LoopbackCapture using real WASAPI loopback devices.

These tests exercise real PortAudio/pyaudiowpatch calls to verify that
the threading lock in LoopbackCapture prevents segfaults from concurrent
start/stop interleaving — the exact scenario that caused the production crash.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import numpy as np
import pytest

pyaudiowpatch = pytest.importorskip("pyaudiowpatch", reason="pyaudiowpatch not installed")

from src.stt_server.loopback import LoopbackCapture

# ---------------------------------------------------------------------------
# Lightweight recorder stub — implements only the interface LoopbackCapture
# actually calls at runtime (duck-typed via TYPE_CHECKING guard).
# ---------------------------------------------------------------------------


class RecorderStub:
    """Minimal stand-in for AudioToTextRecorder used by LoopbackCapture."""

    def __init__(self) -> None:
        self.post_speech_silence_duration: float = 0.5
        self._mic_on: bool = True
        self._external: bool = False
        self._feed_count: int = 0
        self._wakeup_count: int = 0

    def set_microphone(self, on: bool) -> None:
        self._mic_on = on

    def set_external_audio_mode(self, active: bool) -> None:
        self._external = active

    def clear_feed_buffer(self) -> None:
        pass

    def wakeup(self) -> None:
        self._wakeup_count += 1

    def feed_audio(
        self,
        chunk: np.ndarray[Any, Any],
        original_sample_rate: int = 16000,
    ) -> None:
        self._feed_count += 1


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _find_loopback_device() -> int | None:
    """Return the index of the first available loopback device, or None."""
    lc = LoopbackCapture()
    devices = lc.list_devices()
    if not devices:
        return None
    # Prefer the default device
    for d in devices:
        if d.get("isDefault"):
            return int(d["index"])
    return int(devices[0]["index"])


DEVICE_INDEX = _find_loopback_device()

skip_no_device = pytest.mark.skipif(
    DEVICE_INDEX is None,
    reason="No WASAPI loopback device available",
)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@skip_no_device
class TestLoopbackCapture:
    """Real-hardware tests for LoopbackCapture."""

    def test_single_start_stop_cycle(self) -> None:
        """Basic sanity: start, capture briefly, stop — no crash."""
        lc = LoopbackCapture()
        stub = RecorderStub()

        info = lc.start(stub, DEVICE_INDEX)  # type: ignore[arg-type]
        assert info["index"] == DEVICE_INDEX
        assert lc.is_active

        # Let the capture loop run briefly so it reads from PortAudio.
        # feed_count may be 0 if no system audio is playing (loopback
        # only captures what goes through the speakers).
        time.sleep(0.3)

        lc.stop(stub)  # type: ignore[arg-type]
        assert not lc.is_active
        assert stub._mic_on is True  # restored
        assert stub._external is False  # restored

    def test_rapid_start_stop_cycles(self) -> None:
        """Rapid sequential start→stop cycles — the scenario that segfaulted.

        Without the threading.Lock, PortAudio's internal state gets corrupted
        when a new PyAudio instance is created before the previous one is
        fully terminated. 10 rapid cycles is enough to trigger it reliably.
        """
        lc = LoopbackCapture()
        stub = RecorderStub()

        for i in range(10):
            lc.start(stub, DEVICE_INDEX)  # type: ignore[arg-type]
            assert lc.is_active, f"Cycle {i}: should be active after start"
            # Minimal delay — the bug occurred with near-zero gaps
            time.sleep(0.05)
            lc.stop(stub)  # type: ignore[arg-type]
            assert not lc.is_active, f"Cycle {i}: should be inactive after stop"

        # Final state is clean
        assert not lc.is_active
        assert stub._mic_on is True
        assert stub._external is False

    def test_concurrent_start_stop_threads(self) -> None:
        """Concurrent start/stop from multiple threads — worst-case race.

        This simulates the production scenario: the asyncio event loop fires
        a stop (from mode switch) while a start (from new mode) is still
        setting up the PortAudio stream. Without serialization, PortAudio
        crashes with a segfault.
        """
        lc = LoopbackCapture()
        stub = RecorderStub()
        errors: list[Exception] = []
        barrier = threading.Barrier(2)

        def start_worker() -> None:
            try:
                barrier.wait(timeout=5)
                for _ in range(5):
                    lc.start(stub, DEVICE_INDEX)  # type: ignore[arg-type]
                    time.sleep(0.02)
            except Exception as e:
                errors.append(e)

        def stop_worker() -> None:
            try:
                barrier.wait(timeout=5)
                for _ in range(5):
                    lc.stop(stub)  # type: ignore[arg-type]
                    time.sleep(0.02)
            except Exception as e:
                errors.append(e)

        t1 = threading.Thread(target=start_worker)
        t2 = threading.Thread(target=stop_worker)
        t1.start()
        t2.start()
        t1.join(timeout=30)
        t2.join(timeout=30)

        assert not errors, f"Concurrent start/stop raised: {errors}"

        # Clean up: ensure stopped
        lc.stop(stub)  # type: ignore[arg-type]
        assert not lc.is_active

    def test_start_while_active_stops_previous(self) -> None:
        """Calling start() while already active should stop the previous
        capture and start a new one — not crash or leak threads."""
        lc = LoopbackCapture()
        stub = RecorderStub()

        lc.start(stub, DEVICE_INDEX)  # type: ignore[arg-type]
        assert lc.is_active
        time.sleep(0.1)

        # Start again without explicit stop — should internally stop first
        lc.start(stub, DEVICE_INDEX)  # type: ignore[arg-type]
        assert lc.is_active
        time.sleep(0.1)

        lc.stop(stub)  # type: ignore[arg-type]
        assert not lc.is_active

    def test_stop_when_not_active_is_safe(self) -> None:
        """Calling stop() when not active should be a no-op, not crash."""
        lc = LoopbackCapture()
        stub = RecorderStub()

        # Should not raise
        lc.stop(stub)  # type: ignore[arg-type]
        lc.stop(stub)  # type: ignore[arg-type]
        assert not lc.is_active

    def test_recorder_state_restored_after_crash_recovery(self) -> None:
        """Even after rapid cycling, recorder state is fully restored."""
        stub = RecorderStub()
        stub.post_speech_silence_duration = 0.42
        lc = LoopbackCapture()

        # Start — should override silence duration to 2.0
        lc.start(stub, DEVICE_INDEX)  # type: ignore[arg-type]
        assert stub.post_speech_silence_duration == 2.0

        # Stop — should restore to original 0.42
        lc.stop(stub)  # type: ignore[arg-type]
        assert stub.post_speech_silence_duration == 0.42
        assert stub._mic_on is True
        assert stub._external is False
