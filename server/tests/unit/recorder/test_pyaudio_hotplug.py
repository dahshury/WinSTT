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
        del input_channels
        # PortAudio raises ValueError for an unsupported (rate, format)
        # combination — the production probe uses that to fall back from
        # paFloat32 to paInt16. The hotplug-shape tests don't exercise the
        # f32 path (the fake stream always emits int16-shaped payloads),
        # so we report only paInt16 as supported here. The dedicated
        # negotiate-format test below covers the paFloat32 happy path.
        if input_format != _FakePyAudioModule.paInt16:
            raise ValueError(f"format {input_format} not supported", -9994)
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
    paFloat32 = 1  # ditto. Production negotiates f32 first and falls back.

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

        # ``always_on_microphone=True`` is the legacy boot policy these tests
        # cover — open the stream at setup, fall back to waiting-for-device
        # when no input is present. The new default (on-demand) deliberately
        # skips the open and so doesn't enter waiting state from setup; its
        # hotplug coverage lives in ``TestAlwaysOnMicrophoneMode`` below.
        source = PyAudioSource(input_device_index=None, always_on_microphone=True)
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
            always_on_microphone=True,
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
            always_on_microphone=True,
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
            always_on_microphone=True,
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
            always_on_microphone=True,
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
            always_on_microphone=True,
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


class TestAlwaysOnMicrophoneMode:
    """Boot-time policy from ``always_on_microphone``.

    Default ``False`` mirrors Handy's ``OnDemand`` mode: the stream is
    NOT allocated at setup; the first resume() opens one. ``True`` keeps
    the legacy behavior — open at setup, stop_stream()/resume() between.
    """

    def test_setup_skips_open_when_always_on_false(self, monkeypatch: pytest.MonkeyPatch) -> None:
        pa = _FakePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)

        source = PyAudioSource(input_device_index=1, always_on_microphone=False)
        source.setup()

        assert pa.open_calls == 0
        assert source.is_active() is True
        # No "waiting for device" — the device is available; we just
        # haven't opened it yet because the policy is on-demand.
        assert source.is_waiting_for_device is False
        # Silence flows through read_chunk until first resume.
        assert source.read_chunk() == _SILENCE
        assert pa.open_calls == 0

    def test_setup_opens_when_always_on_true(self, monkeypatch: pytest.MonkeyPatch) -> None:
        pa = _FakePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)

        source = PyAudioSource(input_device_index=1, always_on_microphone=True)
        source.setup()

        # Legacy path: open at boot, immediately paused so the indicator
        # stays off until first resume.
        assert pa.open_calls == 1
        assert pa.streams[0].stop_called == 1

    def test_resume_lazily_opens_on_demand(self, monkeypatch: pytest.MonkeyPatch) -> None:
        pa = _FakePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)

        source = PyAudioSource(input_device_index=1, always_on_microphone=False)
        source.setup()
        assert pa.open_calls == 0

        source.resume()

        assert pa.open_calls == 1
        assert source.read_chunk() == _REAL_FRAME

    def test_pause_releases_device_when_always_on_false(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """pause() in on-demand mode must fully close — that's the whole
        point of the setting (OS mic indicator clears decisively)."""
        pa = _FakePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)

        source = PyAudioSource(input_device_index=1, always_on_microphone=False)
        source.setup()
        source.resume()
        opened_stream = pa.streams[-1]

        source.pause()

        assert opened_stream.close_called == 1
        # Subsequent resume opens a brand-new stream rather than reusing
        # the closed one.
        source.resume()
        assert pa.open_calls == 2

    def test_pause_keeps_stream_when_always_on_true(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """always_on=True keeps the stream object alive (only stop_stream)."""
        pa = _FakePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)

        source = PyAudioSource(input_device_index=1, always_on_microphone=True)
        source.setup()
        source.resume()
        opened_stream = pa.streams[-1]

        source.pause()

        # stop_stream gets called (1 from the post-setup pause, 1 from this
        # explicit pause); close stays at 0 — the object lives on.
        assert opened_stream.stop_called >= 1
        assert opened_stream.close_called == 0

    def test_lazy_stream_close_defers_close(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When ``lazy_stream_close=True``, pause() only stops the engine —
        the stream is closed by a deferred timer thread."""
        import time

        pa = _FakePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)

        source = PyAudioSource(
            input_device_index=1,
            always_on_microphone=False,
            lazy_stream_close=True,
            lazy_close_timeout_seconds=0.05,
        )
        source.setup()
        source.resume()
        opened_stream = pa.streams[-1]

        source.pause()

        # Right after pause: engine stopped, stream object alive.
        assert opened_stream.stop_called >= 1
        assert opened_stream.close_called == 0

        # Wait past the timer.
        time.sleep(0.2)
        assert opened_stream.close_called == 1

    def test_lazy_stream_close_cancelled_by_resume(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A resume() before the timer fires must cancel the pending close."""
        import time

        pa = _FakePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)

        source = PyAudioSource(
            input_device_index=1,
            always_on_microphone=False,
            lazy_stream_close=True,
            lazy_close_timeout_seconds=0.2,
        )
        source.setup()
        source.resume()
        opened_stream = pa.streams[-1]

        source.pause()
        # Beat the timer with a resume that bumps the generation counter.
        source.resume()
        time.sleep(0.3)

        # The deferred close from the previous pause must have NOT fired
        # against the still-alive stream (the resume opened a new one,
        # but the original was already closed by resume's close+reopen
        # path — the assertion here is that we didn't double-close).
        # Specifically: close_called from the timer should NOT have run
        # — the close that DID happen came from resume's own close+reopen.
        # Since both routes close exactly once, the safest check is that
        # the OS still has only the new stream open.
        assert pa.open_calls == 2
        # Old stream got closed by resume's close+reopen path; new one
        # is alive and ready.
        assert opened_stream.close_called == 1
        new_stream = pa.streams[-1]
        assert new_stream.close_called == 0


class TestFormatNegotiation:
    """``_open_stream`` should prefer paFloat32 and fall back to paInt16.

    Mirrors Handy's ``get_preferred_config`` (F32 > I16 > I32 priority).
    The benefit: on WASAPI shared mode the Audio Engine pumps f32
    internally, so asking for f32 hands us the engine buffer directly
    instead of forcing an in-engine i16 quantize step we don't control.
    Tests use a custom fake that opts into f32 to verify the chosen
    format flows through to ``pa.open`` and the read path's f32→i16
    conversion runs cleanly without changing the int16-shaped output.
    """

    class _F32CapablePyAudio(_FakePyAudio):
        """Fake whose ``is_format_supported`` accepts both paInt16 AND paFloat32."""

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

    def test_opens_with_paFloat32_when_supported(self, monkeypatch: pytest.MonkeyPatch) -> None:
        pa = self._F32CapablePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)
        # Intercept open() so we can inspect the format argument.
        formats_opened: list[int] = []
        original_open = pa.open

        def capture_open(**kwargs: int | bool) -> _FakeStream:
            formats_opened.append(int(kwargs["format"]))
            return original_open(**kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(pa, "open", capture_open)

        source = PyAudioSource(input_device_index=1, always_on_microphone=True)
        source.setup()

        assert formats_opened == [_FakePyAudioModule.paFloat32]

    def test_falls_back_to_paInt16_when_f32_unsupported(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Default fake only advertises paInt16 — verifies the production
        # ValueError-swallowing fallback selects int16.
        pa = _FakePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)
        formats_opened: list[int] = []
        original_open = pa.open

        def capture_open(**kwargs: int | bool) -> _FakeStream:
            formats_opened.append(int(kwargs["format"]))
            return original_open(**kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(pa, "open", capture_open)

        source = PyAudioSource(input_device_index=1, always_on_microphone=True)
        source.setup()

        assert formats_opened == [_FakePyAudioModule.paInt16]

    def test_read_chunk_converts_f32_payload_to_int16(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When the stream is f32, ``read_chunk`` returns int16 bytes downstream."""
        import struct

        pa = self._F32CapablePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)

        # Replace the stream's read payload with a known f32 buffer: 512
        # samples of +0.5 → fold to int16 16384 (``np.rint`` is round-
        # half-to-even, so 16383.5 → 16384, not 16383).
        f32_payload = struct.pack("<512f", *[0.5] * 512)

        source = PyAudioSource(input_device_index=1, always_on_microphone=True)
        source.setup()
        # Stream opened in paused state — start capturing so read_chunk
        # exercises the conversion branch rather than returning silence.
        source.resume()
        # Patch the actively-bound stream's payload.
        pa.streams[-1].read_payload = f32_payload

        chunk = source.read_chunk()
        # 512 f32 samples → 512 int16 samples = 1024 bytes.
        assert len(chunk) == 512 * 2
        samples = struct.unpack("<512h", chunk)
        assert all(s == 16384 for s in samples)
