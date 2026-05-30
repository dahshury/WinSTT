from __future__ import annotations

import contextlib
import logging
import threading
from math import ceil, gcd
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

# Safety cap for the one-shot ``drain_available`` read at PTT release. The OS
# input ring buffer normally holds only a buffer or three, but a wedged host
# can report a pathologically large ``get_read_available`` — capping keeps the
# release path from blocking while it reads seconds of audio. 256 buffers is
# ~2.7 s at 48 kHz / 512-frame buffers, far above any real backlog.
_MAX_DRAIN_BUFFERS = 256


class _StreamingResampler:
    """Stateful, seam-free polyphase resampler for the live capture stream.

    Replaces a *stateless* ``resample_poly`` per ~10 ms buffer. Resampling
    each chunk in isolation filtered it as if silence sat on both sides, which
    (a) injected a filter discontinuity at every chunk seam — an audible buzz
    at the chunk rate (~94 Hz for 512-sample buffers @ 48 kHz) — and (b) drifted
    the sample count: 512-in → ``ceil(512*16000/48000)=171``-out gains a third of
    a sample per chunk, so a saved recording slowly pitch/length-drifts. Both
    were largely masked for the transcriber (mel + peak-norm) but obvious on
    playback of the saved recording.

    This carries the polyphase filter's overlap across chunks (overlap-save with
    a small constant hold-back) so the emitted stream is **bit-identical** to
    resampling the whole utterance in one call — the streaming equivalent of a
    one-shot ``resample_poly`` over the full clip.

    The trailing ``ctx`` input samples are always held back (a constant
    ~2-10 ms of the most-recent audio at 48/44.1 kHz); they are post-VAD
    trailing audio in practice, so nothing audible is lost.
    """

    def __init__(self, from_rate: int, to_rate: int, read_size: int) -> None:
        g = gcd(to_rate, from_rate)
        self._up = to_rate // g
        self._down = from_rate // g
        # resample_poly's prototype FIR is ``20*max(up,down)+1`` taps at the
        # up-sampled rate → ``ceil(.../up)`` input samples of support. Round up
        # to a whole number of ``down`` so each chunk boundary lands on the
        # integer output grid (no fractional-phase drift).
        pad_in = ceil((20 * max(self._up, self._down) + 1) / self._up)
        self._ctx = (pad_in // self._down + 1) * self._down
        # Consume granularity ≈ one read, snapped down to a multiple of ``down``.
        self._block = max(self._down, (read_size // self._down) * self._down)
        self._pending: NDArray[np.float64] = np.zeros(0, dtype=np.float64)
        self._first = True

    def reset(self) -> None:
        """Drop pending state so the next utterance starts from silence."""
        self._pending = np.zeros(0, dtype=np.float64)
        self._first = True

    def process(self, raw: bytes) -> bytes:
        """Feed int16 PCM bytes at the source rate; return int16 PCM at target.

        May return ``b""`` while priming or holding back the tail — every
        downstream consumer (CompositeVAD's residual buffer, the audio buffer,
        the realtime worker) already tolerates short/empty chunks.
        """
        pcm = np.frombuffer(raw, dtype=np.int16)
        if pcm.size:
            self._pending = np.concatenate([self._pending, pcm.astype(np.float64)])
        out: list[NDArray[np.float64]] = []
        need = self._ctx + self._block + self._ctx
        while self._pending.size >= need:
            seg = self._pending[:need]
            resampled = resample_poly(seg, self._up, self._down)
            # Skip the warm-up region (real left-context already emitted last
            # round); the very first block has no prior context so it starts at 0.
            start = 0 if self._first else (self._ctx * self._up) // self._down
            end = ((self._ctx + self._block) * self._up) // self._down
            out.append(resampled[start:end])
            self._first = False
            self._pending = self._pending[self._block :]
        if not out:
            return b""
        # Clip before the int16 cast — resample_poly can ring slightly past
        # full-scale near transients, and a bare ``astype(int16)`` would WRAP
        # (a loud click) rather than saturate.
        merged = np.clip(np.concatenate(out), -32768.0, 32767.0)
        return bytes(merged.astype(np.int16).tobytes())


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
        always_on_microphone: bool = False,
        lazy_stream_close: bool = False,
        lazy_close_timeout_seconds: float = 30.0,
    ) -> None:
        self._input_device_index = input_device_index
        self._target_sample_rate = target_sample_rate
        self._buffer_size = buffer_size
        # Two-axis microphone-lifecycle design:
        #
        # * ``always_on_microphone=True`` — boot opens the OS mic stream
        #   and keeps it allocated for the entire session. PTT
        #   press/release just gates the engine (``start_stream`` /
        #   ``stop_stream``). Fastest possible response (microseconds)
        #   but the OS mic-in-use indicator stays lit while the app runs.
        #
        # * ``always_on_microphone=False`` (default) — no stream opens at
        #   boot; the first PTT press lazily allocates one. On PTT
        #   release the close strategy depends on ``lazy_stream_close``:
        #     - ``False`` (default): close immediately so the OS
        #       releases the device on the same key-up that ended the
        #       recording. The mic-in-use indicator clears decisively.
        #     - ``True``: stop the engine, but defer the close for
        #       ``lazy_close_timeout_seconds`` (30 s by default). A new
        #       PTT inside that window reuses the still-open stream
        #       (microseconds resume). Generation counter in the timer
        #       handles the cancel-on-new-recording race.
        #
        # ``lazy_stream_close`` is ignored when ``always_on_microphone``
        # is True — the stream never closes either way in that mode.
        self._always_on_microphone = always_on_microphone
        self._lazy_stream_close = lazy_stream_close
        self._lazy_close_timeout_seconds = lazy_close_timeout_seconds
        # Generation counter for the lazy-close timer — incremented on
        # every pause() and on resume(). The timer thread snapshots the
        # generation it scheduled with; on fire it bails out unless the
        # generation still matches AND the source is still paused. This
        # is a generation-counter guard (see ``_schedule_lazy_close``) and
        # replaces the need for explicit thread cancellation.
        self._lazy_close_generation = 0
        self._audio_interface: Any = None
        self._stream: Any = None
        self._device_sample_rate: int | None = None
        # PortAudio sample format actually negotiated for the live stream.
        # ``_open_stream`` probes ``paFloat32`` first and falls back to
        # ``paInt16`` so we can let the WASAPI Audio Engine hand us its
        # native float buffer instead of forcing an in-engine i16 quantize
        # step we don't control. Downstream still consumes int16 bytes —
        # ``read_chunk`` converts f32→i16 right at the source so the rest
        # of the pipeline (CompositeVAD, audio_buffer, resampler) is
        # unchanged. ``None`` until the first ``_open_stream`` lands.
        # Storing the int here (not pyaudio.paInt16) so the module still
        # imports cleanly on machines that lack PyAudio for type checks.
        self._capture_format: int | None = None
        # Stateful resampler from the device's native rate down to 16 kHz,
        # built by ``_open_stream`` only when the rates differ. ``None`` means
        # capture is already at the target rate (no resampling). Carrying the
        # polyphase overlap across reads keeps the saved recording artifact-free
        # (see ``_StreamingResampler``). ``_resampler_fresh`` is set while paused
        # so the first read after a resume drops the pre-pause tail.
        self._resampler: _StreamingResampler | None = None
        self._resampler_fresh = False
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
        # Serialises PyAudio Pa_ReadStream / Pa_CloseStream / Pa_StopStream
        # calls. Without it, ``read_chunk`` runs on the audio-reader thread
        # while ``pause()`` → ``_release_stream`` runs on the asyncio
        # control-handler thread, and the two C calls on the same PaStream
        # object race inside portaudio (manifests as Windows fatal exception
        # 0xc0000374 / STATUS_HEAP_CORRUPTION at the close site). The race
        # is documented across the portaudio/pyaudio bug trackers — Pa_*
        # functions are not stream-level reentrant. Cost: an asyncio
        # pause() may block up to ~one chunk duration (~32 ms at 16 kHz /
        # 512 samples) waiting for the in-flight read to return, which is
        # well under PTT-release perceptual latency.
        self._stream_op_lock = threading.Lock()
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

        # Pa_Initialize is the riskiest call in the whole boot path on
        # Windows — when the host audio stack is in a CM_PROB_PHANTOM /
        # stuck-endpoint state (Bluetooth user-service hung, MMDevAPI
        # dead) it can either raise OSError or fatal-access-violate
        # inside the PortAudio C extension. We can't catch the AV from
        # Python, but the OSError path is recoverable: surface it as a
        # ``DeviceError`` with a host-fix hint so the recorder thread
        # logs a clean message instead of a raw traceback, and the
        # caller can route it to the WS layer for the UI to surface.
        try:
            self._audio_interface = pyaudio.PyAudio()
        except OSError as e:
            msg = (
                f"Audio subsystem unavailable: PortAudio Pa_Initialize "
                f"failed ({_format_pa_error(e)}). The Windows audio stack "
                f"may be stuck — run Fix-Audio.cmd elevated to bounce "
                f"Audiosrv / AudioEndpointBuilder, then retry."
            )
            raise DeviceError(msg) from e
        pa: Any = self._audio_interface
        try:
            # On-demand mode (the default): skip the
            # boot-time open entirely. The PyAudio interface is created so
            # device enumeration / probe paths still work, but no stream
            # is allocated until the user's first PTT press calls
            # resume(). The OS mic-in-use indicator therefore never lights
            # up just because the app is running. ``_stream=None`` is the
            # signal read_chunk uses to drain silence.
            if not self._always_on_microphone:
                self._stream = None
                self._device_sample_rate = None
                self._active = True
                self._capturing = False
                return

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

        # Probe paFloat32 first — on WASAPI shared mode (the Windows
        # default for almost every input device) the Audio Engine pumps
        # f32 internally and requesting paInt16 forces an in-engine i16
        # quantize step we don't get to control. Asking for f32 hands us
        # the engine's native buffer, then we do a deterministic
        # ``np.clip * 32767`` round-to-int16 in ``read_chunk``. Falls back
        # to paInt16 then paInt24 when the device doesn't advertise f32
        # (the F32 > I16 > I24 priority lives in ``_negotiate_format``).
        chosen_format = self._negotiate_format(pa, device_index, sample_rate)

        try:
            self._stream = pa.open(
                format=chosen_format,
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
        self._capture_format = chosen_format
        # Fresh stateful resampler for this stream (resets any prior overlap).
        # Only needed when the device isn't already at the target rate.
        self._resampler = (
            _StreamingResampler(sample_rate, self._target_sample_rate, self._buffer_size)
            if sample_rate != self._target_sample_rate
            else None
        )
        self._resampler_fresh = False

    def _negotiate_format(self, pa: Any, device_index: int, sample_rate: int) -> int:  # noqa: ANN401
        """Pick the cleanest supported capture format in priority order.

        Probes F32 > I16 > I24 and picks the first one the driver
        accepts. The rationale is that some cheap USB / Bluetooth drivers
        report support for multiple input formats but only ONE of them is
        actually the engine's native representation — the others involve
        an in-driver dither/quantize step the host can't tune. Asking for
        the engine's native format hands us the clean buffer and lets us
        do the int16 conversion deterministically in
        ``_float32_bytes_to_int16_bytes`` or the I24 equivalent.

        Float32 wins on WASAPI shared mode (the Windows default for nearly
        every input device); I16 is the universal fallback; I24 is the
        last resort for high-end USB mics that pump packed 24-bit samples.
        Any probe that raises ``ValueError`` / ``OSError`` is treated as
        "format not supported" — some virtual-cable drivers throw instead
        of returning False, and we don't want a noisy driver to mask a
        format that would otherwise work.
        """
        formats: tuple[tuple[str, int], ...] = (
            ("paFloat32", int(pyaudio.paFloat32)),
            ("paInt16", int(pyaudio.paInt16)),
            ("paInt24", int(pyaudio.paInt24)),
        )
        for label, fmt in formats:
            try:
                pa.is_format_supported(
                    rate=sample_rate,
                    input_device=device_index,
                    input_channels=1,
                    input_format=fmt,
                )
            except (ValueError, OSError) as probe_err:
                logger.debug(
                    "%s not supported on device %s @ %dHz (%s); trying next",
                    label,
                    device_index,
                    sample_rate,
                    _format_pa_error(probe_err),
                )
                continue
            return fmt
        # Nothing in the priority list probed clean — last-resort paInt16,
        # which is what every well-behaved input driver advertises. If even
        # that doesn't work the caller's ``pa.open`` will fail descriptively.
        return int(pyaudio.paInt16)

    @override
    def read_chunk(self) -> AudioChunk:
        # Apply any queued device switch first.  Doing this on the audio
        # reader thread keeps PyAudio access single-threaded — the close +
        # ``pa.open`` (which blocks for hundreds of ms while probing
        # format support) never runs on the asyncio control loop.
        pending = self._pending_device_index
        if pending is not self._NO_PENDING:
            self._pending_device_index = self._NO_PENDING
            assert pending is None or isinstance(pending, int)
            self._apply_device_switch(pending)

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

            # Mark the resampler stale so the first read after resume drops the
            # pre-pause overlap tail instead of splicing it onto the new utterance.
            self._resampler_fresh = True
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
        #
        # The read is wrapped in ``_stream_op_lock`` so a concurrent
        # ``_release_stream`` (called from the asyncio thread on PTT release)
        # can't tear the PaStream out from under us mid-read. The lock is
        # only acquired around the actual ``Pa_ReadStream`` call — the
        # hotplug / device-switch / silence branches above run lock-free
        # because they touch only Python-side state.
        try:
            with self._stream_op_lock:
                if self._stream is None:
                    # close raced us — fall back to silence for this tick.
                    return b"\x00" * (self._buffer_size * self._sample_width)
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
        # Fold whatever format the driver gave us down to the canonical
        # int16 bytes so the rest of the pipeline (CompositeVAD,
        # audio_buffer, resampler) doesn't need to know capture used
        # something else.
        raw = self._to_int16(raw)
        if self._resampler is not None:
            if self._resampler_fresh:
                # Coming out of a pause: discard the stale overlap so the new
                # utterance starts cleanly from silence.
                self._resampler.reset()
                self._resampler_fresh = False
            raw = self._resampler.process(raw)
        return raw

    def _to_int16(self, raw: bytes) -> bytes:
        """Fold the negotiated capture format down to canonical int16 bytes.

        paFloat32 → int16 covers WASAPI's native f32; paInt24 → int16 covers
        high-end USB mics that pump packed 24-bit samples. paInt16 (and the
        not-yet-negotiated ``None``) fall through untouched.
        """
        if self._capture_format is None:
            return raw
        if self._capture_format == pyaudio.paFloat32:
            return self._float32_bytes_to_int16_bytes(raw)
        if self._capture_format == pyaudio.paInt24:
            return self._int24_bytes_to_int16_bytes(raw)
        return raw

    @override
    def drain_available(self) -> AudioChunk:
        """Read the OS-buffered tail without blocking; see ``IAudioSource``.

        On PTT release the stream is about to close. PortAudio's input ring
        buffer can still hold the last fraction of a second the user spoke —
        the audio captured between the reader thread's final ``read_chunk``
        and ``pause()``. This pulls exactly what's already available
        (``get_read_available``), converts + resamples it the same way
        ``read_chunk`` does, and hands it back so the caller can feed it into
        the recording before the device is released. Returns ``b""`` when
        paused, streamless, or nothing is buffered.

        Shares ``_stream_op_lock`` with ``read_chunk`` / ``_release_stream``
        so the one-shot read can't race the reader thread or a concurrent
        teardown.
        """
        with self._stream_op_lock:
            if self._stream is None or not self._capturing:
                return b""
            try:
                available = int(self._stream.get_read_available())
            except Exception as e:
                # Any PortAudio failure here just means there's nothing to drain.
                logger.debug("drain_available: get_read_available failed: %s", _format_pa_error(e))
                return b""
            if available <= 0:
                return b""
            available = min(available, self._buffer_size * _MAX_DRAIN_BUFFERS)
            try:
                raw: bytes = self._stream.read(available, exception_on_overflow=False)
            except OSError as e:
                logger.debug("drain_available: read failed: %s", _format_pa_error(e))
                return b""
        raw = self._to_int16(raw)
        if self._resampler is not None:
            raw = self._resampler.process(raw)
        return raw

    @staticmethod
    def _float32_bytes_to_int16_bytes(raw: bytes) -> bytes:
        """Convert a paFloat32 capture buffer to the canonical int16 bytes.

        Round-to-nearest (numpy's ``rint``) avoids the systematic toward-
        zero bias of a bare ``astype(int16)``. Clipping to [-1, 1] handles
        the rare hot signal a driver might surface — WASAPI doesn't clamp
        on input even in shared mode. Scaling by ``32767`` keeps a hot
        +1.0 sample inside int16 range (32768 would overflow).
        """
        samples = np.frombuffer(raw, dtype=np.float32)
        clipped = np.clip(samples, -1.0, 1.0)
        return bytes(np.rint(clipped * 32767.0).astype(np.int16).tobytes())

    @staticmethod
    def _int24_bytes_to_int16_bytes(raw: bytes) -> bytes:
        """Convert a paInt24 capture buffer (packed 3-byte LE) to int16.

        PortAudio's paInt24 hands us 3 bytes per sample, little-endian,
        signed. numpy has no native int24 dtype, so we widen to int32 by
        inserting a zero MSB and arithmetic-shifting back down 16 bits to
        get the top 16 bits (lossy but deterministic — the bottom 8 bits
        of dynamic range get truncated). The ``>>`` on a signed int32 is
        arithmetic on numpy so sign extension is correct. If the byte
        count isn't a multiple of 3 we drop the tail rather than crash:
        a partial sample at the buffer boundary is benign in a streaming
        VAD pipeline.
        """
        usable = len(raw) - (len(raw) % 3)
        if usable == 0:
            return b""
        # Build an N x 3 array of bytes then pad each row with a zero MSB
        # (the int24 → int32 widening trick). We then view the rows as
        # little-endian int32 and shift right by 8 to land back in the
        # int24-shaped range without sign loss.
        bytes_2d = np.frombuffer(raw[:usable], dtype=np.uint8).reshape(-1, 3)
        padded = np.zeros((bytes_2d.shape[0], 4), dtype=np.uint8)
        padded[:, 1:4] = bytes_2d
        as_int32 = padded.view(np.int32).reshape(-1) >> 8
        # Now ``as_int32`` holds signed 24-bit samples in [-2^23, 2^23 - 1].
        # Drop to int16 by truncating the low byte (>>8) so the high 16
        # bits of the 24-bit dynamic range survive. ``clip`` guards
        # against the rare driver glitch that produces an out-of-range
        # sample even within the int24 envelope.
        shifted = (as_int32 >> 8).astype(np.int32)
        return bytes(np.clip(shifted, -32768, 32767).astype(np.int16).tobytes())

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
        # Clear the format too so a stale paFloat32 doesn't trigger the
        # f32→i16 conversion on the silence buffers ``read_chunk``
        # returns while waiting for a replacement device.
        self._capture_format = None
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
        self._capture_format = None

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

    def reconfigure(
        self,
        *,
        always_on_microphone: bool | None = None,
        lazy_stream_close: bool | None = None,
        lazy_close_timeout_seconds: float | None = None,
    ) -> None:
        """Update mic-release policy in-place without re-opening the stream.

        Each field is optional; ``None`` means "leave unchanged". The
        three fields used to be construction-time constants because
        ``PyAudioSource.__init__`` is the only place that reads them.
        Promoting them to a settable surface lets the renderer flip
        ``audio.microphoneRelease`` live — no process restart, no mic
        re-open, the OS mic-in-use indicator doesn't blip.

        Transitions that affect the *currently live* stream:

        * Flipping ``always_on_microphone`` from True → False while the
          source is paused has no immediate effect — the stream is
          already alive. The NEXT pause() will respect the new policy
          (and either lazy-close or full-release).
        * Flipping it False → True while paused doesn't auto-open the
          stream either. Whatever resume() path runs next observes the
          new flag and keeps the stream alive across subsequent pauses.
        * Changing ``lazy_close_timeout_seconds`` only affects timers
          scheduled AFTER the assignment — already-running lazy-close
          timers continue to use the value they captured at schedule
          time (via the closure in :meth:`_schedule_lazy_close`).

        Threading: each assignment is a single attribute write under
        the GIL, so no lock is needed. The reader thread observes the
        new values on its next read_chunk iteration.
        """
        if always_on_microphone is not None:
            self._always_on_microphone = bool(always_on_microphone)
        if lazy_stream_close is not None:
            self._lazy_stream_close = bool(lazy_stream_close)
        if lazy_close_timeout_seconds is not None:
            self._lazy_close_timeout_seconds = float(lazy_close_timeout_seconds)

    @override
    def pause(self) -> None:
        """Stop hardware capture.

        Three behaviors gated by the construction-time flags:

        * **always_on=True** — uses PortAudio's ``stop_stream()`` and
          keeps the stream object alive. resume() can come back online
          in microseconds; ``lazy_stream_close`` is ignored.

        * **always_on=False, lazy_stream_close=False (default)** — fully
          closes and nulls the stream so the device is genuinely
          released on this very call. The next resume() opens a fresh
          stream (already its normal path on Windows WASAPI shared
          mode — see resume() docstring). Slight extra latency per PTT
          press (~10-50 ms on Windows) is covered by the pre-roll
          buffer; the OS mic-in-use indicator clears decisively.

        * **always_on=False, lazy_stream_close=True** — stops the engine
          (``stop_stream``) and schedules a delayed close after
          ``lazy_close_timeout_seconds``. A new resume() inside the
          window reuses the still-open stream (microseconds) and
          cancels the pending close via the generation counter; if the
          timer fires while still paused, it tears the stream down then.

        Idempotent: calling pause() on a paused source is a no-op.
        """
        # Always clear capture intent — pause() must override any earlier
        # resume() that happened while waiting for a device, otherwise a
        # delayed hotplug attach would start capturing against the user's
        # current wishes.
        self._capture_intent = False
        if not self._capturing and self._stream is None:
            return
        if self._stream is not None:
            self._pause_stream_per_policy()
        self._capturing = False

    def _pause_stream_per_policy(self) -> None:
        """Apply the configured pause-policy branch.

        Split out so ``pause()`` stays at CC=1 and the three modes are
        legible side-by-side rather than buried in nested ifs.
        """
        if self._always_on_microphone:
            self._stop_stream_safely(self._stream)
            return
        if self._lazy_stream_close:
            # Stop the engine NOW so the OS reclaims the input quickly,
            # but keep the stream object alive so a follow-up PTT within
            # the lazy window can resume with a microsecond start_stream
            # instead of a full pa.open().
            self._stop_stream_safely(self._stream)
            self._schedule_lazy_close()
            return
        # always_on=False, lazy=False — release the device on this call.
        self._release_stream()

    def _release_stream(self) -> None:
        """Tear down ``self._stream`` and null the pointer.

        Used by both the immediate-close path in ``pause()`` and the
        deferred close in ``_lazy_close_timer_callback``. Swallowing
        stop/close exceptions matches the rest of this module's
        defensive-cleanup convention.

        Holds ``_stream_op_lock`` for the duration of the stop+close so an
        in-flight ``read_chunk`` on the audio-reader thread can't race the
        PaStream teardown — root cause of the
        ``Windows fatal exception: code 0xc0000374`` (STATUS_HEAP_CORRUPTION)
        we hit at PTT release. Reader will block up to ~one chunk duration
        waiting for the lock, then see ``_stream is None`` on the next
        iteration and fall through to the silence branch.
        """
        if self._stream is None:
            return
        with self._stream_op_lock:
            # Re-check after acquiring the lock — another caller may have
            # released first.
            if self._stream is None:
                return
            with contextlib.suppress(Exception):
                self._stream.stop_stream()
            with contextlib.suppress(Exception):
                self._stream.close()
            self._stream = None
            self._device_sample_rate = None
            self._capture_format = None

    def _schedule_lazy_close(self) -> None:
        """Spawn a daemon thread that closes the stream after the idle window.

        The generation counter guards the close: every pause() bumps it
        and every resume() bumps it again, so a pending timer that wakes after a new
        recording started (or after a manual cleanup ran) finds the
        generation has moved on and exits without touching the live
        stream. Daemon thread so server shutdown doesn't have to join.
        """
        import threading

        self._lazy_close_generation += 1
        my_gen = self._lazy_close_generation
        timeout = self._lazy_close_timeout_seconds

        def _fire() -> None:
            import time

            time.sleep(timeout)
            # Guard: stream might already have been torn down (cleanup),
            # or a new recording could be in progress (resume bumped the
            # generation). Skip the close in either case.
            if self._lazy_close_generation != my_gen:
                return
            if self._capturing:
                return
            if self._stream is None:
                return
            logger.info("Lazy-close timer firing — releasing idle audio stream")
            self._release_stream()

        threading.Thread(target=_fire, daemon=True, name="pyaudio-lazy-close").start()

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
        # Bump the lazy-close generation so any pending close-timer
        # scheduled by a recent pause() exits without touching the live
        # stream. Cheap; safe to call even when no timer is pending.
        self._lazy_close_generation += 1
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

        Order: device's reported ``defaultSampleRate`` → target rate (16 kHz)
        → standard fallbacks. Each candidate is probed via
        ``is_format_supported`` so we never hand PyAudio a rate it can't
        open — that was the source of the ``[Errno -9997] Invalid sample
        rate`` failures users hit on USB devices that report a default of
        44100 but only actually support 48 kHz (or vice versa).

        Why device-default first: opening at 16 kHz forces WASAPI / the
        kernel driver to resample inside the driver chain. Cheap USB mics
        and Bluetooth audio drivers do this badly and smear transients
        (the hardest part of far-mic speech). Opening at the device's
        preferred rate (typically 44.1 / 48 kHz) hands us the engine's
        clean buffer; we then resample to 16 kHz in-process via the
        stateful :class:`_StreamingResampler` (a high-quality phase-linear
        polyphase filter, seam-free across chunk boundaries).
        """
        pa: Any = self._audio_interface
        try:
            info: Any = pa.get_device_info_by_index(device_index)
        except Exception:
            return 44100
        device_default = int(info.get("defaultSampleRate", 0)) or 0

        candidates: list[int] = []
        # Device-native FIRST. If the device's preferred rate is already
        # 16 kHz (rare on Windows — almost everything is 44.1/48 kHz) we
        # short-circuit the software resample by picking it directly; if
        # not, we capture at the native rate and resample on read.
        for rate in (device_default, self._target_sample_rate, 48000, 44100, 22050, 16000, 8000):
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
