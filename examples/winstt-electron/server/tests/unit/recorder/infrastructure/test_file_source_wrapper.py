"""Wrapper-level tests for :mod:`src.recorder.infrastructure.file_source`.

FileAudioSource is the deterministic ``IAudioSource`` used for loopback /
external-audio feeds. No hardware, no PyAudio. We verify the buffering math
(``feed`` chops at ``2 * buffer_size``-byte boundaries), the read-empty
fallback (silence frames), the resample bridge, and the lifecycle / port
shape contracts.
"""

from __future__ import annotations

import numpy as np

from src.building_blocks.types import BufferSize, SampleRate
from src.recorder.domain.ports.audio_source import IAudioSource
from src.recorder.infrastructure.file_source import FileAudioSource


def test_implements_iaudio_source_port() -> None:
    source = FileAudioSource()
    assert isinstance(source, IAudioSource)


def test_default_sample_rate_and_buffer_size() -> None:
    source = FileAudioSource()
    assert source.sample_rate == SampleRate(16000)
    assert source.buffer_size == BufferSize(512)


def test_custom_sample_rate_and_buffer_size_round_trip() -> None:
    source = FileAudioSource(
        sample_rate=SampleRate(48000),
        buffer_size=BufferSize(1024),
    )
    assert source.sample_rate == SampleRate(48000)
    assert source.buffer_size == BufferSize(1024)


def test_setup_and_cleanup_flip_is_active() -> None:
    source = FileAudioSource()
    assert source.is_active() is False
    assert source.is_capturing is False
    source.setup()
    assert source.is_active() is True
    assert source.is_capturing is True
    source.cleanup()
    assert source.is_active() is False
    assert source.is_capturing is False


def test_cleanup_is_idempotent() -> None:
    """Calling cleanup() twice must not raise — required by the lifecycle."""
    source = FileAudioSource()
    source.setup()
    source.cleanup()
    source.cleanup()  # second call
    source.cleanup()  # third call
    assert source.is_active() is False


def test_pause_resume_switch_device_are_no_ops() -> None:
    """All three are documented no-ops for the file-backed source."""
    source = FileAudioSource()
    source.setup()
    source.pause()
    source.resume()
    source.switch_device(None)
    source.switch_device(7)
    # Active state is unaffected by these no-ops.
    assert source.is_active() is True


def test_read_chunk_returns_silence_when_queue_empty() -> None:
    """Empty queue must surface as zero bytes the size of one buffer (avoids
    deadlocking the reader thread)."""
    source = FileAudioSource(buffer_size=BufferSize(128))
    source.setup()
    chunk = source.read_chunk()
    assert chunk == b"\x00" * (128 * 2)  # int16 = 2 bytes/sample


def test_feed_bytes_chunks_into_buffer_size_frames() -> None:
    """``feed`` must split incoming bytes into ``2 * buffer_size``-sized
    chunks and enqueue each. Tail bytes shorter than a full frame stay in
    the internal buffer."""
    source = FileAudioSource(buffer_size=BufferSize(4))  # 8 bytes per frame
    source.setup()
    # 18 bytes → 2 full frames + 2 bytes residual.
    source.feed(b"\x01\x02" * 9)
    c1 = source.read_chunk()
    c2 = source.read_chunk()
    assert c1 == b"\x01\x02" * 4
    assert c2 == b"\x01\x02" * 4
    # The third read should hit the silence fallback (queue drained).
    c3 = source.read_chunk()
    assert c3 == b"\x00" * 8


def test_feed_ndarray_int16_round_trips_through_queue() -> None:
    """``buffer_size=N`` means N int16 samples (= 2N bytes) per frame.
    Feeding 8 samples at buffer_size=4 enqueues 2 frames of 4 samples each."""
    source = FileAudioSource(buffer_size=BufferSize(4))
    source.setup()
    samples = np.array([1, 2, 3, 4, 5, 6, 7, 8], dtype=np.int16)
    source.feed(samples, original_sample_rate=16000)
    c1 = np.frombuffer(source.read_chunk(), dtype=np.int16).tolist()
    c2 = np.frombuffer(source.read_chunk(), dtype=np.int16).tolist()
    assert c1 == [1, 2, 3, 4]
    assert c2 == [5, 6, 7, 8]


def test_feed_ndarray_stereo_downmixes_to_mono() -> None:
    """A 2-D ndarray (samples, channels) is averaged across channels.
    With buffer_size=2 we get one frame of 2 mono samples per read."""
    source = FileAudioSource(buffer_size=BufferSize(2))
    source.setup()
    stereo = np.array([[100, 200], [300, 400], [500, 600], [700, 800]], dtype=np.int16)
    source.feed(stereo, original_sample_rate=16000)
    # Mono = mean per row → [150, 350, 550, 750] (rounded).
    drained: list[int] = []
    for _ in range(2):
        drained.extend(np.frombuffer(source.read_chunk(), dtype=np.int16).tolist())
    assert drained == [150, 350, 550, 750]


def test_feed_ndarray_resamples_when_rate_mismatched() -> None:
    """If the feed's ``original_sample_rate`` differs from the source's
    sample rate, scipy's polyphase resampler runs and changes the sample
    count. We feed 1 s at 48 kHz and confirm the internal queue size
    matches the resampled (16 kHz) frame count, not the original."""
    source = FileAudioSource(sample_rate=SampleRate(16000), buffer_size=BufferSize(64))
    source.setup()
    samples = np.zeros(48000, dtype=np.int16)
    source.feed(samples, original_sample_rate=48000)
    # 16000 samples / 64 samples-per-frame = 250 frames expected.
    # The queue is populated synchronously by ``feed``, so qsize is stable.
    assert source._queue.qsize() == 250
