"""PyAudioSource hotplug behavior.

Scenario: the user starts the app without a microphone plugged in (or with
all audio devices disabled in Windows). The recorder used to crash here —
``setup()`` raised ``DeviceError`` when ``pa.get_default_input_device_info()``
had nothing to return. After the hotplug refactor, ``setup()`` instead
enters a "waiting" state: the source stays active and read_chunk hands
back silence while the audio reader thread periodically probes for a
default device. As soon as one appears, the source opens it and resumes
delivering real audio.

These tests cover four shapes of the same flow:

1. Boot with no mic → setup succeeds, source is waiting.
2. Mic plugged in mid-run → polling discovers and attaches it.
3. Explicit ``switch_device`` on a waiting source → user picked one from
   the dropdown after the OS surfaced it.
4. Mic unplugged mid-stream → read failure cleanly re-enters waiting state
   so the next plug-in attaches without restarting the server.
"""

from __future__ import annotations

from typing import Any

import pytest

from src.recorder.infrastructure.pyaudio_source import PyAudioSource

# Distinguishable non-silence payload. Real PyAudio gives us int16 PCM;
# we don't care about the *values*, only that ``read_chunk()`` hands back
# what the stream produced (not the silence fallback).
_REAL_FRAME = b"\x12\x34" * 512
_SILENCE = b"\x00" * (512 * 2)

_USB_MIC: dict[str, Any] = {
    "index": 1,
    "name": "USB Mic",
    "defaultSampleRate": 16000,
    "maxInputChannels": 1,
}
_OTHER_MIC: dict[str, Any] = {
    "index": 2,
    "name": "Other Mic",
    "defaultSampleRate": 16000,
    "maxInputChannels": 1,
}


class _FakeStream:
    """Stand-in for a pyaudio Stream.

    The behaviors PyAudioSource exercises: ``stop_stream`` / ``close``
    paired around switches, ``read`` returning bytes (or raising
    ``OSError`` when the device disappears, mirroring PortAudio's
    ``paInputOverflowed`` / ``paUnanticipatedHostError`` family).
    """

    def __init__(
        self,
        *,
        device_index: int | None,
        sample_rate: int,
        read_payload: bytes = _REAL_FRAME,
    ) -> None:
        self.device_index = device_index
        self.sample_rate = sample_rate
        self.read_payload = read_payload
        self.read_raises: bool = False
        self.start_called = 0
        self.stop_called = 0
        self.close_called = 0
        self.read_called = 0

    def start_stream(self) -> None:
        self.start_called += 1

    def stop_stream(self) -> None:
        self.stop_called += 1

    def close(self) -> None:
        self.close_called += 1

    def read(self, buffer_size: int, exception_on_overflow: bool = True) -> bytes:
        self.read_called += 1
        if self.read_raises:
            # PyAudio surfaces PortAudio errors as OSError with the code
            # in ``args[1]``. -9986 is paInputOverflowed, the closest
            # canonical analog for "the device went away under us".
            raise OSError("simulated device disappeared", -9986)
        return self.read_payload


class _FakePyAudio:
    """Toggleable fake PyAudio. Tests mutate ``default_index`` to plug/unplug."""

    def __init__(
        self,
        *,
        devices: dict[int, dict[str, Any]],
        default_index: int | None,
    ) -> None:
        self.devices = devices
        self.default_index = default_index
        self.streams: list[_FakeStream] = []
        self.open_calls = 0
        self.terminate_called = 0

    def get_default_input_device_info(self) -> dict[str, Any]:
        if self.default_index is None:
            # Match PyAudio: OSError with PortAudio error code in args[1].
            # -9996 is paInvalidDevice — what PortAudio reports when there
            # is no default input device on the system.
            raise OSError("no default input device", -9996)
        return self.devices[self.default_index]

    def get_device_info_by_index(self, index: int) -> dict[str, Any]:
        if index not in self.devices:
            raise OSError(f"unknown device {index}", -9996)
        return self.devices[index]

    def is_format_supported(
        self,
        rate: int,
        *,
        input_device: int,
        input_channels: int,
        input_format: int,
    ) -> bool:
        del input_channels, input_format
        dev = self.devices.get(input_device, {})
        return rate in (16000, int(dev.get("defaultSampleRate", 0)))

    def open(
        self,
        *,
        format: int,
        channels: int,
        rate: int,
        input: bool,
        frames_per_buffer: int,
        input_device_index: int,
    ) -> _FakeStream:
        del format, channels, input, frames_per_buffer
        self.open_calls += 1
        stream = _FakeStream(device_index=input_device_index, sample_rate=rate)
        self.streams.append(stream)
        return stream

    def terminate(self) -> None:
        self.terminate_called += 1


class _FakePyAudioModule:
    """Minimal substitute for the ``pyaudio`` module."""

    paInt16 = 8  # numeric value is irrelevant — only identity matters

    def __init__(self, pa: _FakePyAudio) -> None:
        self._pa = pa

    def PyAudio(self) -> _FakePyAudio:
        return self._pa


def _install_fake_pyaudio(monkeypatch: pytest.MonkeyPatch, pa: _FakePyAudio) -> None:
    """Patch the module-level ``pyaudio`` ref so PyAudioSource sees the fake."""
    import src.recorder.infrastructure.pyaudio_source as mod

    monkeypatch.setattr(mod, "pyaudio", _FakePyAudioModule(pa))


class TestBootWithoutMicrophone:
    def test_setup_succeeds_when_no_default_device(self, monkeypatch: pytest.MonkeyPatch) -> None:
        pa = _FakePyAudio(devices={}, default_index=None)
        _install_fake_pyaudio(monkeypatch, pa)

        source = PyAudioSource(input_device_index=None)
        source.setup()  # used to raise DeviceError; now enters waiting state

        assert source.is_active() is True
        assert source.is_waiting_for_device is True
        assert pa.open_calls == 0

    def test_read_returns_silence_while_waiting(self, monkeypatch: pytest.MonkeyPatch) -> None:
        pa = _FakePyAudio(devices={}, default_index=None)
        _install_fake_pyaudio(monkeypatch, pa)

        source = PyAudioSource(
            input_device_index=None,
            device_probe_every_n_chunks=10**6,  # disable polling for this test
        )
        source.setup()

        assert source.read_chunk() == _SILENCE
        # No probe attempt means no open call either.
        assert pa.open_calls == 0


class TestHotplugDetection:
    def test_polling_attaches_default_device_when_it_appears(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        pa = _FakePyAudio(devices={1: _USB_MIC}, default_index=None)
        _install_fake_pyaudio(monkeypatch, pa)

        attaches: list[int] = []
        source = PyAudioSource(
            input_device_index=None,
            on_device_became_available=attaches.append,
            device_probe_every_n_chunks=1,
        )
        source.setup()

        # No device yet — read returns silence, no open call.
        assert source.read_chunk() == _SILENCE
        assert pa.open_calls == 0
        assert attaches == []

        # Plug the mic in.
        pa.default_index = 1

        # Next read probes, finds the device, opens it (paused — matches the
        # post-setup contract that hardware capture stays off until resume()).
        # The hook fires once.
        result = source.read_chunk()
        assert pa.open_calls == 1
        assert pa.streams[0].device_index == 1
        assert attaches == [1]
        assert source.is_waiting_for_device is False
        # The just-attached stream is paused, so we still get silence here.
        assert result == _SILENCE

        # After resume(), real frames flow.
        source.resume()
        assert source.read_chunk() == _REAL_FRAME

    def test_explicit_switch_device_on_waiting_source_attaches(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        pa = _FakePyAudio(devices={1: _USB_MIC, 2: _OTHER_MIC}, default_index=None)
        _install_fake_pyaudio(monkeypatch, pa)

        source = PyAudioSource(
            input_device_index=None,
            device_probe_every_n_chunks=10**6,  # polling off — only explicit switch attaches
        )
        source.setup()
        assert source.is_waiting_for_device is True

        # Settings UI calls set_parameter("input_device_index", 2) which
        # ultimately calls switch_device(2) on the source.
        source.switch_device(2)
        source.read_chunk()  # applies queued switch

        assert pa.open_calls == 1
        assert pa.streams[0].device_index == 2
        assert source.is_waiting_for_device is False

        source.resume()
        assert source.read_chunk() == _REAL_FRAME


class TestMidRunUnplug:
    def test_read_failure_re_enters_waiting_state(self, monkeypatch: pytest.MonkeyPatch) -> None:
        pa = _FakePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)

        source = PyAudioSource(
            input_device_index=None,
            device_probe_every_n_chunks=10**6,  # polling off during unplug phase
        )
        source.setup()
        source.resume()
        # resume() always close+reopens to dodge a WASAPI quirk where a
        # stopped stream can't be re-started, so we expect two opens: one
        # from setup(), one from resume(). The currently-live stream is
        # the last one in pa.streams.
        assert source.is_waiting_for_device is False
        assert pa.open_calls == 2
        assert source.read_chunk() == _REAL_FRAME

        # Yank the device.
        pa.streams[-1].read_raises = True
        pa.default_index = None

        chunk = source.read_chunk()
        # Recover: silence this cycle, source flips back to waiting so the
        # reader loop keeps running and the next attach (manual or hotplug)
        # comes online without a restart.
        assert chunk == _SILENCE
        assert source.is_waiting_for_device is True

    def test_unplug_then_replug_reattaches_automatically(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        pa = _FakePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)

        attaches: list[int] = []
        source = PyAudioSource(
            input_device_index=None,
            on_device_became_available=attaches.append,
            device_probe_every_n_chunks=1,
        )
        source.setup()
        source.resume()

        # Working baseline. The hook does NOT fire on initial setup —
        # it's specifically a "device became available after we lost (or
        # never had) it" transition signal, not a "device is present"
        # signal.
        assert source.read_chunk() == _REAL_FRAME
        assert attaches == []

        # Unplug.
        pa.streams[-1].read_raises = True
        pa.default_index = None
        assert source.read_chunk() == _SILENCE
        assert source.is_waiting_for_device is True

        # Replug. Capture intent was set by the earlier resume() and
        # survives the unplug → wait → reattach cycle, so the hotplug-
        # attached stream comes back capturing without needing a second
        # resume() round trip.
        pa.default_index = 1
        assert source.read_chunk() == _REAL_FRAME
        assert attaches == [1]
        assert source.is_waiting_for_device is False
