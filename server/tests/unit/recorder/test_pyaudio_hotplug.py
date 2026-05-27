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
    paInt24 = 4  # third priority in the format probe — same identity convention.

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

        def capture_open(**kwargs: Any) -> _FakeStream:  # noqa: ANN401 — wraps third-party pa.open's heterogenous kwargs
            formats_opened.append(int(kwargs["format"]))
            return original_open(**kwargs)

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

        def capture_open(**kwargs: Any) -> _FakeStream:  # noqa: ANN401 — wraps third-party pa.open's heterogenous kwargs
            formats_opened.append(int(kwargs["format"]))
            return original_open(**kwargs)

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


class TestFormatPriorityPrefersInt16OverInt24:
    """When the device supports both paInt16 AND paInt24 but NOT paFloat32,
    the priority probe must pick paInt16 (the cheaper widening path).
    This locks down the F32 > I16 > I24 order documented in
    ``_negotiate_format`` against accidental reordering.
    """

    class _Int16OrInt24PyAudio(_FakePyAudio):
        def is_format_supported(
            self,
            rate: int,
            *,
            input_device: int,
            input_channels: int,
            input_format: int,
        ) -> bool:
            del input_channels
            if input_format == _FakePyAudioModule.paFloat32:
                raise ValueError("paFloat32 unsupported", -9994)
            # Accept paInt16 AND paInt24 at the device's sample rate.
            dev = self.devices.get(input_device, {})
            return rate in (16000, int(dev.get("defaultSampleRate", 0)))

    def test_picks_paInt16_when_both_int16_and_int24_supported(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        pa = self._Int16OrInt24PyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)
        formats_opened: list[int] = []
        original_open = pa.open

        def capture_open(**kwargs: Any) -> _FakeStream:  # noqa: ANN401 — wraps third-party pa.open's heterogenous kwargs
            formats_opened.append(int(kwargs["format"]))
            return original_open(**kwargs)

        monkeypatch.setattr(pa, "open", capture_open)

        source = PyAudioSource(input_device_index=1, always_on_microphone=True)
        source.setup()

        # F32 fails → I16 wins (priority: F32 > I16 > I24).
        assert formats_opened == [_FakePyAudioModule.paInt16]


class TestFormatPriorityFallsBackToInt24:
    """When the device supports ONLY paInt24 (rare — some pro USB mics),
    the source picks I24 rather than failing the open."""

    class _OnlyInt24PyAudio(_FakePyAudio):
        def is_format_supported(
            self,
            rate: int,
            *,
            input_device: int,
            input_channels: int,
            input_format: int,
        ) -> bool:
            del input_channels
            if input_format != _FakePyAudioModule.paInt24:
                raise ValueError("only int24 supported", -9994)
            dev = self.devices.get(input_device, {})
            return rate in (16000, int(dev.get("defaultSampleRate", 0)))

    def test_picks_paInt24_when_only_int24_supported(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        pa = self._OnlyInt24PyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)
        formats_opened: list[int] = []
        original_open = pa.open

        def capture_open(**kwargs: Any) -> _FakeStream:  # noqa: ANN401 — wraps third-party pa.open's heterogenous kwargs
            formats_opened.append(int(kwargs["format"]))
            return original_open(**kwargs)

        monkeypatch.setattr(pa, "open", capture_open)

        source = PyAudioSource(input_device_index=1, always_on_microphone=True)
        source.setup()

        assert formats_opened == [_FakePyAudioModule.paInt24]

    def test_int24_read_chunk_converts_to_int16(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When the stream is paInt24, ``read_chunk`` returns int16 bytes.

        paInt24 is 3 bytes per sample (LE signed). A buffer of 512
        samples of value ``0x010000`` (1.0% of int24 range) widens to
        int32 ``0x010000``, then ``>> 8`` gives int16 ``0x0100`` = 256.
        """
        import struct

        pa = self._OnlyInt24PyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)

        # 512 samples of signed int24 with value 0x010000.
        # LE encoding: bytes are 0x00, 0x00, 0x01.
        int24_payload = b"\x00\x00\x01" * 512

        source = PyAudioSource(input_device_index=1, always_on_microphone=True)
        source.setup()
        source.resume()
        pa.streams[-1].read_payload = int24_payload

        chunk = source.read_chunk()
        # 512 samples → 1024 int16 bytes.
        assert len(chunk) == 512 * 2
        samples = struct.unpack("<512h", chunk)
        # 0x010000 widened to int32 → >>8 to drop the synthetic MSB
        # zero → >>8 again in the int24→int16 step. Net: high 16 bits
        # of 24-bit value 0x010000 = 0x0100 = 256.
        assert all(s == 256 for s in samples)


class TestSampleRatePrefersDeviceDefault:
    """``_get_best_sample_rate`` now prefers the device's reported
    ``defaultSampleRate`` over the 16 kHz target so we don't force the
    WASAPI / driver resampler to do a sloppy in-driver resample. The
    in-process scipy.signal.resample_poly path is phase-linear and
    high-quality, equivalent to Handy's rubato::FftFixedIn.
    """

    class _MultiRatePyAudio(_FakePyAudio):
        """Accepts both 16 kHz and 48 kHz at paInt16."""

        def is_format_supported(
            self,
            rate: int,
            *,
            input_device: int,
            input_channels: int,
            input_format: int,
        ) -> bool:
            del input_channels
            if input_format != _FakePyAudioModule.paInt16:
                raise ValueError("only paInt16 supported", -9994)
            return rate in (16000, 48000)

    def test_picks_device_default_48k_even_when_16k_also_supported(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # Device's defaultSampleRate is 48 kHz; both rates probe clean.
        # Previously the source picked 16000 (target) first; now it must
        # pick the device default to avoid the in-driver resampler.
        mic_48k = {**_USB_MIC, "defaultSampleRate": 48000}
        pa = self._MultiRatePyAudio(devices={1: mic_48k}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)
        opened_rates: list[int] = []
        original_open = pa.open

        def capture_open(**kwargs: Any) -> _FakeStream:  # noqa: ANN401 — wraps third-party pa.open's heterogenous kwargs
            opened_rates.append(int(kwargs["rate"]))
            return original_open(**kwargs)

        monkeypatch.setattr(pa, "open", capture_open)

        source = PyAudioSource(input_device_index=1, always_on_microphone=True)
        source.setup()

        assert opened_rates == [48000]

    def test_picks_16k_when_device_default_is_already_16k(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """No resample needed when the device's native rate is already
        16 kHz. The target-rate fallback selects 16 kHz directly."""
        # _USB_MIC already has defaultSampleRate=16000.
        pa = self._MultiRatePyAudio(devices={1: _USB_MIC}, default_index=1)
        _install_fake_pyaudio(monkeypatch, pa)
        opened_rates: list[int] = []
        original_open = pa.open

        def capture_open(**kwargs: Any) -> _FakeStream:  # noqa: ANN401 — wraps third-party pa.open's heterogenous kwargs
            opened_rates.append(int(kwargs["rate"]))
            return original_open(**kwargs)

        monkeypatch.setattr(pa, "open", capture_open)

        source = PyAudioSource(input_device_index=1, always_on_microphone=True)
        source.setup()

        assert opened_rates == [16000]


class TestResamplePreservesSineFrequency:
    """Native-SR capture + scipy polyphase resample preserves the audio
    spectrum: a 1 kHz sine captured at 48 kHz and resampled to 16 kHz
    must still have its FFT peak at 1 kHz. Polyphase filtering is
    phase-linear so the peak does NOT shift."""

    def test_48k_sine_resampled_to_16k_keeps_peak_at_1khz(self) -> None:
        import struct

        import numpy as np

        # 1024 ms of audio at 48 kHz = 48000 samples; 1 kHz sine.
        from_rate = 48000
        to_rate = 16000
        n_samples_in = from_rate  # 1 s of audio
        freq_hz = 1000

        t = np.arange(n_samples_in) / from_rate
        sine = (0.5 * np.sin(2 * np.pi * freq_hz * t) * 32767).astype(np.int16)
        raw_bytes = sine.tobytes()

        # Use the production static method so the test exercises the
        # actual ``resample_poly`` call PyAudioSource uses.
        resampled = PyAudioSource._resample(raw_bytes, from_rate, to_rate)

        # 1 s in -> 1/3 s * 16000 = 16000 samples out.
        samples_out = np.frombuffer(resampled, dtype=np.int16).astype(np.float64)
        assert len(samples_out) == to_rate

        # FFT and find the peak frequency.
        spectrum = np.abs(np.fft.rfft(samples_out))
        peak_bin = int(np.argmax(spectrum))
        peak_freq_hz = peak_bin * to_rate / len(samples_out)

        # Allow ±1 bin tolerance (1 Hz at this resolution).
        assert abs(peak_freq_hz - freq_hz) < 2.0

        # Verify the resampler unpacks back to the expected byte size.
        # 512 raw int16 bytes = 256 samples; we passed 48000 samples ⇒
        # 96000 bytes input → 32000 bytes output (16000 samples).
        assert len(resampled) == to_rate * 2

        # Sanity: struct unpacks the result without errors.
        struct.unpack(f"<{to_rate}h", resampled)
