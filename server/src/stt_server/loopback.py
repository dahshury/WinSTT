"""WASAPI loopback audio capture for system audio transcription.

Uses ``pyaudiowpatch`` (a patched PyAudio build with WASAPI loopback support)
to capture desktop/speaker output and feed it into the existing recorder
pipeline via ``recorder.feed_audio()``.
"""

from __future__ import annotations

import contextlib
import threading
import time
from typing import TYPE_CHECKING, Any, Protocol

import numpy as np

if TYPE_CHECKING:
    from src.recorder import AudioToTextRecorder


class _AudioStream(Protocol):
    def read(self, num_frames: int, *, exception_on_overflow: bool = ...) -> bytes: ...
    def stop_stream(self) -> None: ...
    def close(self) -> None: ...


TARGET_PEAK: float = 8000.0  # Target peak amplitude (out of 32768)
MAX_GAIN: float = 30.0  # Maximum amplification factor
NOISE_FLOOR: float = 50.0  # Ignore chunks below this peak
GAIN_SMOOTH: float = 0.05  # EMA smoothing factor (slow-tracking AGC)


class LoopbackCapture:
    """Manages a WASAPI loopback capture stream in a background thread."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._audio: Any = None  # pyaudiowpatch.PyAudio instance
        self._stream: Any = None
        self._device_rate: int = 0
        self._device_channels: int = 0
        self._gain: float = 1.0  # Running AGC gain
        self._saved_silence_duration: float | None = None

    # ── Device enumeration ────────────────────────────────────────────

    def list_devices(self) -> list[dict[str, Any]]:
        """Return WASAPI loopback-capable output devices."""
        import pyaudiowpatch as pyaudio

        audio = pyaudio.PyAudio()
        try:
            wasapi_info: dict[str, Any] = audio.get_host_api_info_by_type(pyaudio.paWASAPI)
            default_output_index: int = int(wasapi_info.get("defaultOutputDevice", -1))
            devices: list[dict[str, Any]] = []

            for i in range(audio.get_device_count()):
                dev: dict[str, Any] = audio.get_device_info_by_index(i)
                if dev["hostApi"] == wasapi_info["index"] and dev["maxOutputChannels"] > 0:
                    is_default = dev["index"] == default_output_index
                    # Try to find the matching loopback device
                    for loopback in audio.get_loopback_device_info_generator():
                        if loopback["index"] == dev["index"] or dev["name"] in loopback["name"]:
                            devices.append(
                                {
                                    "index": loopback["index"],
                                    "name": str(dev["name"]),
                                    "defaultSampleRate": int(loopback["defaultSampleRate"]),
                                    "maxOutputChannels": int(
                                        max(loopback.get("maxInputChannels", 0), loopback.get("maxOutputChannels", 0))
                                    ),
                                    "isDefault": is_default,
                                }
                            )
                            break
                    else:
                        devices.append(
                            {
                                "index": dev["index"],
                                "name": str(dev["name"]),
                                "defaultSampleRate": int(dev["defaultSampleRate"]),
                                "maxOutputChannels": int(dev["maxOutputChannels"]),
                                "isDefault": is_default,
                            }
                        )
            return devices
        finally:
            audio.terminate()

    # ── Start / Stop ──────────────────────────────────────────────────

    def start(self, recorder: AudioToTextRecorder, device_index: int) -> dict[str, Any]:
        """Open loopback stream and start capture thread.

        Returns device info dict for the started device.
        Serialized with a lock so concurrent start/stop calls from the
        asyncio event loop cannot interleave and crash PortAudio.
        """
        with self._lock:
            return self._start_locked(recorder, device_index)

    def _start_locked(self, recorder: AudioToTextRecorder, device_index: int) -> dict[str, Any]:
        import pyaudiowpatch as pyaudio

        if self._thread is not None and self._thread.is_alive():
            self._stop_locked(recorder)

        # Stage all PyAudio setup inside a try block so that any failure
        # (bad device index, format-unsupported, OS-level open failure)
        # terminates the freshly-allocated PyAudio handle instead of
        # leaking the PortAudio backend on every failed start. Mirrors
        # PyAudioSource.setup()'s cleanup-on-error pattern at
        # pyaudio_source.py:64-95.
        audio = pyaudio.PyAudio()
        try:
            dev_info: dict[str, Any] = audio.get_device_info_by_index(device_index)
            device_rate = int(dev_info["defaultSampleRate"])
            device_channels = max(
                int(dev_info.get("maxInputChannels", 0)),
                int(dev_info.get("maxOutputChannels", 0)),
            )
            if device_channels < 1:
                device_channels = 2

            # Pre-flight probe — same is_format_supported check used for
            # regular input devices in control_handler._device_can_open.
            # Without this, loopback start failures only surface when
            # pa.open() throws, which is more expensive and less specific.
            try:
                audio.is_format_supported(
                    device_rate,
                    input_device=device_index,
                    input_channels=device_channels,
                    input_format=pyaudio.paInt16,
                )
            except ValueError as fmt_err:
                msg = (
                    f"Loopback device {device_index} ({dev_info.get('name', '')!r}) "
                    f"does not support {device_rate}Hz / {device_channels}ch / int16: {fmt_err}"
                )
                raise RuntimeError(msg) from fmt_err

            # Switch recorder to feed_audio mode — external audio mode first
            # so the reader thread discards instead of injecting silence.
            recorder.set_external_audio_mode(True)
            recorder.set_microphone(False)

            # Use a longer silence threshold for loopback (continuous audio)
            self._saved_silence_duration = recorder.post_speech_silence_duration
            recorder.post_speech_silence_duration = 2.0

            self._gain = 1.0  # Reset AGC

            # Clear stale audio from previous session so VAD doesn't get
            # misaligned partial chunks on restart.
            recorder.clear_feed_buffer()

            self._stop_event.clear()
            stream = audio.open(
                format=pyaudio.paInt16,
                channels=device_channels,
                rate=device_rate,
                input=True,
                frames_per_buffer=512,
                input_device_index=device_index,
            )
        except Exception:
            # Caller's `start()` raises this back to the WS handler, which
            # surfaces it to the renderer. Make sure we don't leak PortAudio.
            with contextlib.suppress(Exception):
                audio.terminate()
            raise

        # Commit to instance state only after every fallible step succeeded.
        self._audio = audio
        self._device_rate = device_rate
        self._device_channels = device_channels
        self._stream = stream

        recorder.wakeup()

        # Hand the stream to the capture thread as a local arg so it never
        # touches a replaced self._stream after a concurrent start/stop cycle.
        self._thread = threading.Thread(
            target=self._capture_loop,
            args=(recorder, stream),
            daemon=True,
            name="loopback-capture",
        )
        self._thread.start()

        return {
            "index": device_index,
            "name": str(dev_info.get("name", "")),
            "defaultSampleRate": self._device_rate,
            "maxOutputChannels": self._device_channels,
        }

    def stop(self, recorder: AudioToTextRecorder) -> None:
        """Stop capture thread and restore mic input.

        Serialized with a lock so concurrent start/stop calls cannot
        interleave and crash PortAudio.
        """
        with self._lock:
            self._stop_locked(recorder)

    def _stop_locked(self, recorder: AudioToTextRecorder) -> None:
        self._stop_event.set()

        # Stop the stream FIRST to unblock any pending read() call in the
        # capture thread.  Without this, thread.join() can time out while
        # the thread is stuck in a blocking PortAudio read, and we'd then
        # close/terminate the audio backend out from under it → segfault.
        if self._stream is not None:
            with contextlib.suppress(Exception):
                self._stream.stop_stream()

        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

        # Now safe to close/terminate — the capture thread has exited.
        if self._stream is not None:
            with contextlib.suppress(Exception):
                self._stream.close()
            self._stream = None

        if self._audio is not None:
            with contextlib.suppress(Exception):
                self._audio.terminate()
            self._audio = None

        # Clear stale audio left in the feed buffer from this session
        recorder.clear_feed_buffer()

        # Leave the mic PAUSED, not resumed. Every non-listen mode reaches
        # idle with the hardware mic closed: PTT/Toggle only open it on a
        # hotkey press, and Wake Word respawns the server. An unconditional
        # set_microphone(True) here (or restoring the stale use_microphone
        # flag, which is left at True in PTT idle even though the hardware
        # is paused) re-opened the OS mic stream the instant the user
        # switched away from Listen — the bug the user kept hitting. PTT/
        # Toggle re-resume() the stream themselves on the next hotkey press.
        recorder.set_microphone(False)
        recorder.set_external_audio_mode(False)
        if self._saved_silence_duration is not None:
            recorder.post_speech_silence_duration = self._saved_silence_duration
            self._saved_silence_duration = None

    @property
    def is_active(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ── Internal ──────────────────────────────────────────────────────

    def _capture_loop(self, recorder: AudioToTextRecorder, stream: _AudioStream) -> None:
        """Read audio frames from WASAPI loopback and feed to recorder."""
        from src.building_blocks.terminal import TerminalColors as bcolors

        consecutive_errors = 0
        max_consecutive_errors = 5

        try:
            while not self._stop_event.is_set():
                try:
                    # Same rationale as PyAudioSource.read_chunk:
                    # exception_on_overflow=False keeps the capture loop
                    # alive across transient PortAudio overflows instead
                    # of crashing the thread. For loopback we'd rather
                    # drop a frame than tear down the WASAPI session.
                    data: bytes = stream.read(512, exception_on_overflow=False)
                    consecutive_errors = 0  # Reset on success

                    # Convert to numpy int16 and reshape for multi-channel
                    samples = np.frombuffer(data, dtype=np.int16).reshape(-1, self._device_channels)

                    # AGC: normalize speech level so VAD works regardless of
                    # system volume. A chunk below the noise floor is silence
                    # — decay the gain back toward unity and pass it through
                    # *un-amplified*. Holding the speech-time gain over the
                    # trailing silence (multiplying residual room/noise by up
                    # to MAX_GAIN) kept the composite VAD pegged at "speech",
                    # so Listen mode never reached its silence endpoint and
                    # the model transcribed continuously instead of gating on
                    # voice activity like Toggle/Wake Word.
                    peak = float(np.max(np.abs(samples)))
                    if peak > NOISE_FLOOR:
                        desired_gain = min(TARGET_PEAK / peak, MAX_GAIN)
                        self._gain += GAIN_SMOOTH * (desired_gain - self._gain)
                        if self._gain > 1.0:
                            samples = np.clip(samples.astype(np.float32) * self._gain, -32768, 32767).astype(np.int16)
                    else:
                        self._gain += GAIN_SMOOTH * (1.0 - self._gain)

                    # feed_audio handles stereo->mono and resampling internally
                    recorder.feed_audio(samples, original_sample_rate=self._device_rate)
                except Exception as e:
                    if self._stop_event.is_set():
                        break

                    consecutive_errors += 1
                    error_msg = f"[loopback] Capture error (attempt {consecutive_errors}/{max_consecutive_errors}): {e}"
                    print(f"{bcolors.WARNING}{error_msg}{bcolors.ENDC}")

                    if consecutive_errors >= max_consecutive_errors:
                        print(f"{bcolors.FAIL}[loopback] Too many consecutive errors, stopping capture{bcolors.ENDC}")
                        break

                    time.sleep(0.1)  # Back off before retry
        except Exception as e:
            print(f"{bcolors.FAIL}[loopback] Fatal capture error: {type(e).__name__}: {e}{bcolors.ENDC}")
