from __future__ import annotations

import contextlib
import logging
from types import TracebackType
from typing import Any, ClassVar

import numpy as np
from numpy.typing import NDArray
from scipy.signal import resample_poly
from typing_extensions import override

from src.building_blocks.errors import DeviceError
from src.building_blocks.types import (
    AudioChunk,
    BufferSize,
    DeviceBecameAvailableCallback,
    DeviceSwitchFailedCallback,
    SampleRate,
)
from src.recorder.domain.ports.audio_source import IAudioSource

logger = logging.getLogger(__name__)


def _format_pa_error(e: BaseException) -> str:
    """Render a PyAudio exception preserving its PortAudio error code.

    PyAudio raises IOError / ValueError with ``args = (message_str,
    portaudio_code_int)``; the code is the only machine-actionable part
    (e.g. paInvalidDevice, paUnanticipatedHostError). The default str()
    drops it. Reference: examples/pyaudio_portaudio/pyaudio/tests/error_tests.py.
    """
    args = getattr(e, "args", None)
    if isinstance(args, tuple) and len(args) >= 2 and isinstance(args[1], int):
        return f"{args[0]} [paErr={args[1]}]"
    return str(e)


try:
    import pyaudio
except ImportError:
    pyaudio = None

_DEFAULT_SAMPLE_RATE = SampleRate(16000)
_DEFAULT_BUFFER_SIZE = BufferSize(512)

# Hotplug probe cadence. The audio reader thread runs ``read_chunk`` once
# per buffer cycle (~32 ms at 16 kHz / 512-sample buffers). At 30 chunks
# between probes we re-check the default input device about once per
# second — fast enough that a freshly-plugged USB mic shows up before the
# user notices, slow enough that ``pa.get_default_input_device_info``
# (a cheap metadata call but still a couple ms) doesn't dominate the
# reader loop when the system genuinely has no input hardware.
_DEFAULT_DEVICE_PROBE_EVERY_N_CHUNKS = 30


class PyAudioSource(IAudioSource):
    # Sentinel meaning "no device switch is currently queued".  Distinct
    # object identity is required so a queued ``None`` (== system default)
    # is not confused with "nothing pending".
    _NO_PENDING: ClassVar[object] = object()

    def __init__(
        self,
        *,
        input_device_index: int | None = None,
        target_sample_rate: SampleRate = _DEFAULT_SAMPLE_RATE,
        buffer_size: BufferSize = _DEFAULT_BUFFER_SIZE,
        on_device_switch_failed: DeviceSwitchFailedCallback | None = None,
        on_device_became_available: DeviceBecameAvailableCallback | None = None,
        device_probe_every_n_chunks: int = _DEFAULT_DEVICE_PROBE_EVERY_N_CHUNKS,
    ) -> None:
        self._input_device_index = input_device_index
        self._target_sample_rate = target_sample_rate
        self._buffer_size = buffer_size
        self._audio_interface: Any = None
        self._stream: Any = None
        self._device_sample_rate: int | None = None
        self._active = False
        # Hardware capture state. True only between resume() and pause().
        # The OS mic-in-use indicator follows this — when False the icon
        # disappears. Initial value is False so a freshly-set-up source
        # doesn't capture until something explicitly asks it to.
        self._capturing = False
        # "Capture intent" decoupled from "capturing now". Lets resume()
        # called while waiting-for-device remember the user's wish so the
        # auto-attached hotplug stream starts producing audio without a
        # second resume() round trip after the device shows up.
        self._capture_intent = False
        self._on_device_switch_failed = on_device_switch_failed
        self._on_device_became_available = on_device_became_available
        # True between "no default device at setup" / unplug and the next
        # successful (re)attach. While true, ``read_chunk`` returns silence
        # and periodically polls for a default device. False once a stream
        # is open and producing audio. Public for tests / observability.
        self._waiting_for_device = False
        # Probe rate-limit counter. Incremented every ``read_chunk`` cycle
        # while waiting; when it reaches ``_device_probe_every_n_chunks``
        # we attempt one ``pa.get_default_input_device_info`` + open. The
        # counter approach avoids depending on a wall clock — it stays
        # deterministic in tests that drive read_chunk synchronously.
        self._device_probe_every_n_chunks = device_probe_every_n_chunks
        self._chunks_since_last_probe = 0
        # Bytes per int16 sample. Cached so read_chunk() can build silence
        # buffers without holding a PyAudio reference. Matches PyAudio's
        # canonical pa.get_sample_size(paInt16) idiom — int16 is always
        # 2 bytes but we name it so format changes propagate cleanly.
        self._sample_width = 2
        # Time per chunk of silence injected while paused — keeps the
        # reader-loop sleep cadence aligned with the buffer size so PTT
        # latency is bounded by ~one chunk after resume().
        self._silence_sleep_seconds = float(self._buffer_size) / float(self._target_sample_rate)
        # When set to anything other than ``_NO_PENDING``, the next call to
        # ``read_chunk`` will close the current stream and re-open it on
        # the queued device index.  Single-attribute writes are atomic
        # under the GIL, so no lock is needed; the audio reader thread is
        # the sole writer to ``_stream`` (RealtimeSTT pattern — see
        # examples/RealtimeSTT/RealtimeSTT/audio_recorder.py:1313 where
        # the worker recovers from stream errors in-thread).
        self._pending_device_index: object = self._NO_PENDING

    @override
    def setup(self) -> None:
        if pyaudio is None:
            msg = "PyAudio is not installed. Install with: pip install pyaudio"
            raise DeviceError(msg)

        try:
            self._audio_interface = pyaudio.PyAudio()
            pa: Any = self._audio_interface

            requested_index = self._input_device_index
            try:
                self._open_stream(pa, requested_index)
                # Open stream in paused state — the hardware is allocated
                # and ready, but no capture happens until resume() is called.
                # This keeps the Windows mic-in-use indicator off and avoids
                # the reader thread spinning on continuous chunks while the
                # user isn't holding PTT or toggle-on.
                self._stop_stream_safely(self._stream)
            except DeviceError as primary_err:
                # The configured device is gone, indices have shifted (e.g. user
                # unplugged the headset between sessions), or the index space
                # never matched in the first place. Fall back to the system
                # default so the user still gets *some* audio path; they can
                # re-pick their device in Settings — no restart needed thanks
                # to the live ``switch_device`` path.
                if requested_index is None:
                    # No default device exists at boot either — the user
                    # launched the app with nothing plugged in (or all
                    # inputs disabled). Don't fail the whole recorder:
                    # enter the hotplug "waiting" state and let read_chunk
                    # poll for a device. The reader thread keeps draining
                    # silence, the WebSocket server still comes up, and as
                    # soon as the OS reports a default input we'll attach.
                    logger.warning(
                        "No default input device at startup (%s); entering hotplug-wait state",
                        primary_err,
                    )
                    self._waiting_for_device = True
                    self._stream = None
                    self._device_sample_rate = None
                else:
                    logger.warning(
                        "Configured input device %s unavailable (%s); falling back to system default",
                        requested_index,
                        primary_err,
                    )
                    self._input_device_index = None
                    self._device_sample_rate = None
                    try:
                        self._open_stream(pa, None)
                        self._stop_stream_safely(self._stream)
                    except DeviceError as fallback_err:
                        # Neither the configured device nor the default exists.
                        # Same recovery path as the no-default case above.
                        logger.warning(
                            "Default input device also unavailable (%s); entering hotplug-wait state",
                            fallback_err,
                        )
                        self._waiting_for_device = True
                        self._stream = None
                        self._device_sample_rate = None

            self._active = True
            self._capturing = False
        except DeviceError:
            if self._audio_interface is not None:
                with contextlib.suppress(Exception):
                    self._audio_interface.terminate()
                self._audio_interface = None
            raise

    def _open_stream(self, pa: Any, device_index: int | None) -> None:  # noqa: ANN401
        """Resolve the device index, probe a sample rate, and open a stream.

        Raises ``DeviceError`` if no default exists or the open call fails.
        """
        if device_index is None:
            # Reference: system_info.py:106-118 catches IOError specifically.
            # PyAudio raises IOError (with PortAudio code in args[1]) when
            # there is no default input device.
            try:
                info: Any = pa.get_default_input_device_info()
                device_index = int(info["index"])
            except OSError as e:
                msg = f"Failed to get default input device: {_format_pa_error(e)}"
                raise DeviceError(msg) from e

        sample_rate = self._get_best_sample_rate(device_index)

        try:
            self._stream = pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=sample_rate,
                input=True,
                frames_per_buffer=self._buffer_size,
                input_device_index=device_index,
            )
        except Exception as e:
            msg = f"Failed to open audio stream (device {device_index}, rate {sample_rate}Hz): {_format_pa_error(e)}"
            raise DeviceError(msg, device_index=device_index, sample_rate=sample_rate) from e

        self._input_device_index = device_index
        self._device_sample_rate = sample_rate

    @override
    def read_chunk(self) -> AudioChunk:
        # Apply any queued device switch first.  Doing this on the audio
        # reader thread keeps PyAudio access single-threaded — the close +
        # ``pa.open`` (which blocks for hundreds of ms while probing
        # format support) never runs on the asyncio control loop.
        pending = self._pending_device_index
        if pending is not self._NO_PENDING:
            self._pending_device_index = self._NO_PENDING
            self._apply_device_switch(pending)  # type: ignore[arg-type]

        # Hotplug poll: if we entered setup with no device (or lost the
        # device mid-run), periodically re-check the system default.
        # Cheap metadata-only call, gated by a chunk counter so we don't
        # hammer PortAudio on every iteration.
        if self._waiting_for_device:
            self._try_attach_default_device()

        # Paused: hardware is allocated but not capturing. Sleep for one
        # chunk's worth of time so the reader loop's cadence matches what
        # an active stream would produce, then hand back silence. Calling
        # stream.read() on a stopped PortAudio stream raises, so we MUST
        # short-circuit here.
        if not self._capturing:
            import time as _time

            _time.sleep(self._silence_sleep_seconds)
            return b"\x00" * (self._buffer_size * self._sample_width)

        if self._stream is None:
            return b"\x00" * (self._buffer_size * self._sample_width)
        # exception_on_overflow=False is intentional: PortAudio raises
        # paInputOverflowed when ring-buffer underruns (e.g. transient OS
        # scheduling stalls). For continuous live transcription we'd rather
        # silently drop the dropped frames than crash the audio thread —
        # the next read picks up where we are now. Reference behaviour
        # (PyAudio record.py) keeps the default True; we deliberately
        # diverge for streaming.
        try:
            raw: bytes = self._stream.read(self._buffer_size, exception_on_overflow=False)
        except OSError as e:
            # The device went away under us (USB unplug, Bluetooth drop,
            # driver reset). Don't take the whole audio thread down — drop
            # the stream, flip back into waiting state so the hotplug
            # poller can pick up whatever the user plugs in next, and
            # return silence this cycle.
            logger.warning("Audio stream read failed (%s); re-entering hotplug-wait state", _format_pa_error(e))
            self._enter_waiting_state()
            return b"\x00" * (self._buffer_size * self._sample_width)
        if self._device_sample_rate and self._device_sample_rate != self._target_sample_rate:
            raw = self._resample(raw, self._device_sample_rate, self._target_sample_rate)
        return raw

    def _try_attach_default_device(self) -> None:
        """Poll for a default input device; attach + notify when one appears.

        Called from ``read_chunk`` while in waiting state. Rate-limited via
        a chunk counter so a no-mic boot doesn't slam PortAudio with one
        metadata probe per ~32 ms cycle. The probe itself
        (``pa.get_default_input_device_info``) is a couple-of-ms metadata
        call; the heavy work is the subsequent ``pa.open`` on a hit, which
        is the cost we'd pay on attach anyway.
        """
        self._chunks_since_last_probe += 1
        if self._chunks_since_last_probe < self._device_probe_every_n_chunks:
            return
        self._chunks_since_last_probe = 0

        pa = self._audio_interface
        if pa is None:
            return
        try:
            info: Any = pa.get_default_input_device_info()
            device_index = int(info["index"])
        except OSError:
            return
        try:
            self._open_stream(pa, device_index)
        except DeviceError as e:
            logger.debug("Hotplug probe found device %s but open failed: %s", device_index, e)
            return
        # Stream is open. Match the post-setup contract: paused unless the
        # user already expressed capture intent (resume() while waiting).
        if self._capture_intent:
            self._capturing = True
        else:
            self._stop_stream_safely(self._stream)
        self._waiting_for_device = False
        attached_index = self._input_device_index
        if attached_index is not None and self._on_device_became_available is not None:
            try:
                self._on_device_became_available(attached_index)
            except Exception:
                logger.exception("on_device_became_available callback raised")

    def _enter_waiting_state(self) -> None:
        """Tear down the current stream and flip the source into hotplug-wait.

        Used on mid-run device loss (read failure) so the source can keep
        running and pick up a replacement device on the next probe cycle.
        Capture intent is preserved — if the user had the mic actively
        capturing when it disappeared, the auto-attached replacement
        starts capturing immediately rather than waiting for a second
        resume() round trip.
        """
        if self._stream is not None:
            with contextlib.suppress(Exception):
                self._stream.stop_stream()
            with contextlib.suppress(Exception):
                self._stream.close()
            self._stream = None
        self._waiting_for_device = True
        self._capturing = False
        self._chunks_since_last_probe = 0
        self._device_sample_rate = None
        # Reset to None so the poller probes for the *current* default
        # device. Holding on to the disappeared index would just make
        # the next ``_open_stream`` fail on the same dead handle.
        self._input_device_index = None

    def _apply_device_switch(self, device_index: int | None) -> None:
        """Close the current stream and open a new one on ``device_index``.

        Called only from the audio reader thread (the sole writer to
        ``self._stream``), so no lock is needed.  On open failure, falls
        back to the system default; if that also fails, leaves
        ``self._stream`` as ``None`` so subsequent reads return silence
        until the user picks a different device.
        """
        if self._stream is not None:
            try:
                self._stream.stop_stream()
            except Exception as e:
                logger.debug("Error stopping audio stream during switch: %s", e)
            try:
                self._stream.close()
            except Exception as e:
                logger.debug("Error closing audio stream during switch: %s", e)
            self._stream = None

        pa = self._audio_interface
        if pa is None:
            return

        try:
            self._open_stream(pa, device_index)
        except DeviceError as primary_err:
            if device_index is None:
                logger.error("Failed to (re)open default input device: %s", primary_err)
                self._notify_switch_failed(-1, str(primary_err), None)
                return
            logger.warning(
                "Switch to input device %s failed (%s); falling back to system default",
                device_index,
                primary_err,
            )
            requested_index = device_index
            error_message = str(primary_err)
            self._input_device_index = None
            self._device_sample_rate = None
            try:
                self._open_stream(pa, None)
            except DeviceError as fallback_err:
                logger.error("Fallback to default input device also failed: %s", fallback_err)
                self._notify_switch_failed(requested_index, error_message, None)
                return
            # Primary failed but default fallback succeeded — surface this so
            # the UI can revert the user's selection and toast the reason.
            self._notify_switch_failed(requested_index, error_message, self._input_device_index)

        # ``_open_stream`` always returns a started stream. Honor the current
        # paused state so a device switch during PTT idle doesn't sneak the
        # hardware back into capture mode behind the user's back.
        if not self._capturing and self._stream is not None:
            self._stop_stream_safely(self._stream)

        # If we got here from the hotplug-wait path (user picked a device
        # from the dropdown after plug-in), exit waiting state so the
        # poller stops probing.
        if self._stream is not None:
            self._waiting_for_device = False
            self._chunks_since_last_probe = 0
            # If the user already expressed capture intent while waiting,
            # honor it now that we have a stream.
            if self._capture_intent and not self._capturing:
                with contextlib.suppress(Exception):
                    self._stream.start_stream()
                self._capturing = True

    def _notify_switch_failed(
        self,
        requested_index: int,
        error_message: str,
        fallback_index: int | None,
    ) -> None:
        """Best-effort dispatch of the switch-failure hook (audio thread)."""
        if self._on_device_switch_failed is None:
            return
        try:
            self._on_device_switch_failed(requested_index, error_message, fallback_index)
        except Exception:
            logger.exception("on_device_switch_failed callback raised")

    @override
    def cleanup(self) -> None:
        # Clean up resources in reverse order with individual error handling
        if self._stream is not None:
            try:
                self._stream.stop_stream()
            except Exception as e:
                logger.debug("Error stopping audio stream: %s", e)
            try:
                self._stream.close()
            except Exception as e:
                logger.debug("Error closing audio stream: %s", e)
            self._stream = None

        if self._audio_interface is not None:
            try:
                self._audio_interface.terminate()
            except Exception as e:
                logger.debug("Error terminating audio interface: %s", e)
            self._audio_interface = None

        self._active = False
        self._capturing = False
        self._capture_intent = False
        self._waiting_for_device = False

    @override
    def is_active(self) -> bool:
        return self._active

    @property
    @override
    def is_capturing(self) -> bool:
        return self._capturing

    @property
    def is_waiting_for_device(self) -> bool:
        """True iff the source has no live stream and is polling for one.

        Exposed for observability/tests. Not part of ``IAudioSource``
        because non-PyAudio backends (file source, fakes) don't model
        device hotplug.
        """
        return self._waiting_for_device

    @override
    def pause(self) -> None:
        """Stop hardware capture without releasing the stream.

        Uses PortAudio's ``stop_stream()`` rather than ``close()`` so resume()
        can come back online in microseconds — closing would re-trigger
        device probing (hundreds of ms). The OS mic-in-use indicator turns
        off as soon as the underlying audio engine stops pulling buffers,
        which is what users want when PTT isn't pressed.

        Idempotent: calling pause() on a paused source is a no-op.
        """
        # Always clear capture intent — pause() must override any earlier
        # resume() that happened while waiting for a device, otherwise a
        # delayed hotplug attach would start capturing against the user's
        # current wishes.
        self._capture_intent = False
        if not self._capturing:
            return
        if self._stream is not None:
            self._stop_stream_safely(self._stream)
        self._capturing = False

    @override
    def resume(self) -> None:
        """Resume hardware capture. Idempotent on already-capturing sources.

        Closes the (paused) stream and opens a fresh one on the same
        device every time. We used to try ``start_stream()`` on the
        existing stream as a fast path, but some Windows audio backends
        (notably WASAPI shared mode on certain drivers) invalidate the
        PortAudio stream object when ``stop_stream()`` is called — the
        next ``start_stream()`` raises ``paUnanticipatedHostError`` (-9999)
        or ``paStreamIsStopped`` (-9988). The fast path was therefore
        dead on those configurations: every press took the recovery
        path anyway, just with a warning line attached.

        Always-recreate costs ~10-50 ms per resume on Windows (one
        ``pa.open`` against a known device + format), which is
        imperceptible for press-to-talk: the user's reaction time
        between key press and starting to speak is an order of
        magnitude larger, and the pre-roll buffer covers the small
        sliver in front of the first phoneme.
        """
        # Record intent unconditionally so a delayed hotplug attach can
        # honor "user wants to capture" even when no device is available
        # right now.
        self._capture_intent = True
        if self._capturing:
            return
        pa = self._audio_interface
        if pa is None:
            return
        if self._waiting_for_device:
            # No stream to (re)open yet — the hotplug poller will attach
            # one as soon as the OS exposes a device, and will honor the
            # capture_intent flag we just set.
            return
        if self._stream is not None:
            try:
                self._stream.close()
            except Exception as e:
                logger.debug("close() during resume raised: %s", e)
            self._stream = None
        try:
            self._open_stream(pa, self._input_device_index)
        except DeviceError as e:
            logger.error("Failed to (re)open audio stream on resume: %s", e)
            return
        self._capturing = True

    @staticmethod
    def _stop_stream_safely(stream: Any) -> None:  # noqa: ANN401 — pyaudio.Stream is loosely typed
        """``stop_stream()`` with the swallow-and-log convention used elsewhere here."""
        try:
            stream.stop_stream()
        except Exception as e:
            logger.debug("stop_stream() raised (likely already stopped): %s", e)

    @override
    def switch_device(self, device_index: int | None) -> None:
        """Queue a live input-device swap.

        The swap is applied by the audio reader thread on its next
        ``read_chunk`` iteration (within ~one buffer cycle, typically
        ~32 ms at 16 kHz / 512-sample buffers).  This is intentionally
        non-blocking and lock-free: PyAudio's ``open``/``close`` calls
        block for hundreds of milliseconds while probing format support,
        and the WebSocket control handler that triggers this lives on the
        asyncio event loop — running PyAudio there freezes the server.

        If the source has not been ``setup()`` yet (e.g. ``use_microphone``
        is false), this just stores the new index so the next ``setup()``
        uses it; there is no live stream to swap.
        """
        if self._audio_interface is None:
            # Not yet streaming — defer to setup().
            self._input_device_index = device_index
            return
        self._pending_device_index = device_index

    @property
    @override
    def sample_rate(self) -> SampleRate:
        return self._target_sample_rate

    @property
    @override
    def buffer_size(self) -> BufferSize:
        return self._buffer_size

    def _get_best_sample_rate(self, device_index: int) -> int:
        """Pick a sample rate the device actually supports for paInt16 input.

        Order: target rate (16 kHz) → device's reported ``defaultSampleRate``
        → standard fallbacks. Each candidate is probed via
        ``is_format_supported`` so we never hand PyAudio a rate it can't
        open — that was the source of the ``[Errno -9997] Invalid sample
        rate`` failures users hit on USB devices that report a default of
        44100 but only actually support 48 kHz (or vice versa).
        """
        pa: Any = self._audio_interface
        try:
            info: Any = pa.get_device_info_by_index(device_index)
        except Exception:
            return 44100
        device_default = int(info.get("defaultSampleRate", 0)) or 0

        candidates: list[int] = []
        for rate in (self._target_sample_rate, device_default, 48000, 44100, 22050, 16000, 8000):
            if rate and rate not in candidates:
                candidates.append(rate)

        # Probe with channels=1 because ``pa.open()`` below opens mono.
        # Probing at the device's max-channel value (e.g. 2 for stereo
        # mics) can return False for rates the device DOES support in
        # mono — which then triggered the bogus 44100 fallback.
        for rate in candidates:
            try:
                if pa.is_format_supported(
                    rate,
                    input_device=device_index,
                    input_channels=1,
                    input_format=pyaudio.paInt16,
                ):
                    return rate
            except Exception as e:
                logger.debug(
                    "is_format_supported(%dHz, device=%d) raised: %s",
                    rate,
                    device_index,
                    e,
                )
                continue
        # Nothing in the candidate set probed clean — last-resort device
        # default so the caller's ``pa.open()`` produces a descriptive
        # ``DeviceError`` instead of a misleading 44100 fallback.
        return device_default or 44100

    @staticmethod
    def _resample(raw: bytes, from_rate: int, to_rate: int) -> bytes:
        pcm = np.frombuffer(raw, dtype=np.int16)
        resampled: NDArray[np.float64] = resample_poly(pcm.astype(np.float64), to_rate, from_rate)
        return bytes(resampled.astype(np.int16).tobytes())

    def __enter__(self) -> PyAudioSource:
        self.setup()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self.cleanup()
