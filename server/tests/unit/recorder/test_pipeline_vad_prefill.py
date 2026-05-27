"""Leading-silence carry-forward (Handy parity).

Far-mic accuracy: when a user speaks 1-2 m away from the microphone, the
opening consonants of the first word are typically attenuated 20-30 dB
below the rest of the utterance. Whisper's encoder is trained on clips
that always include the silence→speech transition; truncating that
boundary makes weak starting consonants disappear into the model's
"start-of-clip" prior.

Handy's reference implementation
(``examples/Handy/src-tauri/src/audio_toolkit/vad/smoothed.rs``) keeps
a 15-frame ``VecDeque`` of silent frames. On the first speech-classified
frame after a silence run, the deque is PREPENDED to the recorded audio
so the model sees the full transition.

WinSTT's equivalent: a deque sized from ``vad_prefill_ms`` in
:class:`VADConfig` (default 450 ms ⇒ ~15 chunks at 32 ms/chunk). This
test file locks down the contract:

1. The deque size matches ``vad_prefill_ms`` / chunk_duration.
2. Silence-then-speech sequences prepend the silence deque to the
   recording buffer (the property the prompt explicitly demanded).
3. Setting ``vad_prefill_ms=0`` disables the feature cleanly.
4. ``request_abort`` clears the prefill so the next utterance doesn't
   inherit stale silence from the aborted one.
"""

from __future__ import annotations

import struct

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from src.building_blocks.clock import Clock
from src.building_blocks.event_bus import EventBus
from src.building_blocks.types import BufferSize, SampleRate
from src.recorder.application.pipeline import RecordingPipeline
from src.recorder.domain.audio_buffer import AudioBuffer
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.state_machine import RecorderStateMachine
from tests.fakes.fake_audio_source import FakeAudioSource
from tests.fakes.fake_transcriber import FakeTranscriber
from tests.fakes.fake_vad import FakeVAD

_BUFFER_SIZE = 512
_SAMPLE_RATE = 16000
# 512 / 16000 = 32 ms per chunk; 450 / 32 = 14.06 → ceil = 15 chunks.
_DEFAULT_PREFILL_CHUNKS = 15


def _make_chunk(value: int = 0) -> bytes:
    return struct.pack(f"<{_BUFFER_SIZE}h", *([value] * _BUFFER_SIZE))


def _make_pipeline(
    *,
    speech_pattern: list[bool],
    vad_prefill_ms: int = 450,
    pre_recording_buffer_duration: float = 0.0,
) -> tuple[RecordingPipeline, AudioBuffer, RecorderStateMachine]:
    """Build a synchronous pipeline (worker NOT started).

    ``pre_recording_buffer_duration=0.0`` deliberately disables the
    pre-roll deque so this test isolates the silence-prefill mechanism.
    The two buffers overlap in content under the default config (pre-roll
    is the wider net); we want the prefill alone to be observable here.
    """
    cfg = RecorderConfig.from_kwargs(
        post_speech_silence_duration=10.0,  # large so the test doesn't auto-stop
        speech_onset_consecutive_chunks=1,
        pre_recording_buffer_duration=pre_recording_buffer_duration,
        vad_prefill_ms=vad_prefill_ms,
        sample_rate=_SAMPLE_RATE,
        buffer_size=_BUFFER_SIZE,
    )
    bus = EventBus()
    sm = RecorderStateMachine()
    # AudioBuffer's pre-roll deque has maxlen >= 1 even when duration=0,
    # so we still get a 1-chunk pre-roll. Acceptable — the prefill test
    # accounts for it by exact frame-count math below.
    buf = AudioBuffer(
        sample_rate=SampleRate(_SAMPLE_RATE),
        buffer_size=BufferSize(_BUFFER_SIZE),
        pre_recording_buffer_duration=pre_recording_buffer_duration,
    )
    vad = FakeVAD(speech_pattern=speech_pattern)
    pipeline = RecordingPipeline(
        audio_source=FakeAudioSource(),
        vad=vad,
        transcriber=FakeTranscriber(),
        wake_word_detector=None,
        config=cfg,
        event_bus=bus,
        clock=Clock.system_clock(),
        state_machine=sm,
        audio_buffer=buf,
    )
    return pipeline, buf, sm


class TestPrefillDequeSizing:
    def test_maxlen_matches_450ms_at_default_buffer(self) -> None:
        """450 ms / (512 samples / 16 kHz = 32 ms) = 14.06 → ceil = 15."""
        pipeline, _buf, _sm = _make_pipeline(speech_pattern=[False] * 20)
        assert pipeline._silence_prefill.maxlen == _DEFAULT_PREFILL_CHUNKS

    def test_maxlen_is_zero_when_disabled(self) -> None:
        pipeline, _buf, _sm = _make_pipeline(speech_pattern=[False] * 5, vad_prefill_ms=0)
        # maxlen=0 means appends are silently dropped — the cheapest way
        # to express "feature off" without per-append guards.
        assert pipeline._silence_prefill.maxlen == 0

    @given(prefill_ms=st.integers(min_value=1, max_value=2000))
    @settings(max_examples=25, deadline=None, suppress_health_check=[HealthCheck.too_slow])
    def test_maxlen_is_ceiling_of_prefill_div_chunk(self, prefill_ms: int) -> None:
        """For any prefill in [1, 2000] ms, maxlen = ceil(prefill / 32)."""
        pipeline, _buf, _sm = _make_pipeline(
            speech_pattern=[False] * 5,
            vad_prefill_ms=prefill_ms,
        )
        # 512/16000 * 1000 = 32 ms per chunk; ceil division.
        chunk_ms = (_BUFFER_SIZE * 1000.0) / _SAMPLE_RATE
        expected = -(-prefill_ms // int(chunk_ms))  # ceil for positive ints
        # Tolerate the +1 ceil correction when prefill_ms isn't divisible
        # by chunk_ms — the production code rounds UP precisely.
        assert pipeline._silence_prefill.maxlen == expected


class TestPrefillSpliceBehaviour:
    def test_20_silence_then_5_speech_prepends_last_15_silence_frames(self) -> None:
        """The acceptance criterion from the goal prompt.

        Sequence: 20 silence chunks → 5 speech chunks. After processing:
          * The first speech chunk (chunk 21) commits the recording via
            the VAD-onset path. ``_try_start_on_voice_activity_from_result``
            calls ``request_start`` (which drains the prefill deque into
            the buffer) and then early-returns — the trigger chunk
            itself is NOT added to ``_frames`` (a pre-existing
            convention; the pre-roll covers it). Speech chunks 2-5 are
            then added as regular recording frames.
          * Buffer ordering after the sequence: [15 prefill silence] +
            [1 pre-roll silence (deque maxlen >= 1)] + [4 speech chunks
            (2-5)].

        We test the silence-first / speech-last invariant explicitly:
        the LAST 4 frames are speech (chunks 2-5) and the 15 frames
        immediately before them are silence (the prefill).
        """
        # Distinguishable silence (zeros) vs speech (non-zero amplitude).
        silence_chunk = _make_chunk(value=0)
        speech_chunks = [_make_chunk(value=100 + i) for i in range(5)]

        # Speech pattern: 20 False (silence), then 5 True (speech).
        speech_pattern = [False] * 20 + [True] * 5
        pipeline, buf, _sm = _make_pipeline(speech_pattern=speech_pattern)

        # Request listen so VAD onset is armed.
        pipeline.request_listen()

        # Feed 20 silence chunks.
        for _ in range(20):
            pipeline._handle_chunk(silence_chunk)
        # All 20 went through ``_process_not_recording``; the prefill deque
        # holds the last 15 silence chunks (maxlen).
        assert len(pipeline._silence_prefill) == _DEFAULT_PREFILL_CHUNKS

        # Feed 5 speech chunks. The first commits the recording (onset
        # debounce = 1), draining the prefill into the buffer. The next
        # 4 are added as recording frames.
        for sp in speech_chunks:
            pipeline._handle_chunk(sp)

        # After the speech onset, prefill must be EMPTY — drained by the
        # splice into the buffer.
        assert len(pipeline._silence_prefill) == 0

        # Buffer composition: [prefill (15)] + [pre-roll (~1)] + [speech (4)]
        # The first speech chunk triggers the start and is consumed by
        # the dispatcher without being added to ``_frames`` (existing
        # pipeline convention; the pre-roll's last entry covers the
        # trailing silence-to-speech transition).
        frames = list(buf.frames)
        # 15 prefill + 1 pre-roll + 4 speech = 20 (or 19 if pre-roll
        # happened to be empty under some scheduling).
        assert 19 <= len(frames) <= 20

        # The LAST 4 frames must be speech chunks 2-5 in order.
        assert frames[-4:] == speech_chunks[1:]

        # The 15 frames immediately before the speech window are the
        # prefill drain — all silence. (We slice from the end so the
        # potential 0/1 pre-roll frame between prefill and speech
        # doesn't perturb the assertion.)
        silence_window = frames[-(4 + _DEFAULT_PREFILL_CHUNKS) : -4]
        assert len(silence_window) == _DEFAULT_PREFILL_CHUNKS
        assert all(frame == silence_chunk for frame in silence_window)


class TestPrefillLifecycle:
    def test_abort_clears_prefill(self) -> None:
        """A request_abort drops the silence prefill so the NEXT recording
        doesn't inherit stale silence from the aborted one."""
        pipeline, _buf, _sm = _make_pipeline(speech_pattern=[False] * 30)
        pipeline.request_listen()
        silence_chunk = _make_chunk(value=0)
        for _ in range(20):
            pipeline._handle_chunk(silence_chunk)
        # Prefill is at max capacity.
        assert len(pipeline._silence_prefill) == _DEFAULT_PREFILL_CHUNKS

        pipeline.request_abort()

        # Abort drops the prefill — fresh start for the next recording.
        assert len(pipeline._silence_prefill) == 0

    def test_disabled_prefill_does_not_populate_deque(self) -> None:
        """With vad_prefill_ms=0, processing silence does NOT populate the
        deque (maxlen=0 ⇒ appends silently drop)."""
        pipeline, _buf, _sm = _make_pipeline(
            speech_pattern=[False] * 30,
            vad_prefill_ms=0,
        )
        pipeline.request_listen()
        for _ in range(20):
            pipeline._handle_chunk(_make_chunk(value=0))
        assert len(pipeline._silence_prefill) == 0

    def test_speech_chunks_do_not_populate_silence_prefill(self) -> None:
        """Only SILENCE-classified chunks enter the prefill deque.

        If the VAD trips on noise (a single speech-classified chunk in a
        silence run), the prefill deque must NOT add that frame —
        otherwise the prefill window would contain transient non-speech
        bursts that defeat the silence→speech context cue.
        """
        # Pattern: 5 silence, 1 speech (lone), 5 silence. The 6th chunk
        # is speech but, since onset_consecutive_chunks=1, it would
        # trigger a recording — so we set onset_consecutive_chunks=3 to
        # let the lone speech chunk fail the debounce check, leaving us
        # in LISTENING with a single not-silence-classified chunk
        # interleaved with silence chunks in the prefill deque's view.
        cfg = RecorderConfig.from_kwargs(
            post_speech_silence_duration=10.0,
            speech_onset_consecutive_chunks=3,
            pre_recording_buffer_duration=0.0,
            vad_prefill_ms=450,
            sample_rate=_SAMPLE_RATE,
            buffer_size=_BUFFER_SIZE,
        )
        bus = EventBus()
        sm = RecorderStateMachine()
        buf = AudioBuffer(
            sample_rate=SampleRate(_SAMPLE_RATE),
            buffer_size=BufferSize(_BUFFER_SIZE),
            pre_recording_buffer_duration=0.0,
        )
        speech_pattern = [False] * 5 + [True] + [False] * 5
        vad = FakeVAD(speech_pattern=speech_pattern)
        pipeline = RecordingPipeline(
            audio_source=FakeAudioSource(),
            vad=vad,
            transcriber=FakeTranscriber(),
            wake_word_detector=None,
            config=cfg,
            event_bus=bus,
            clock=Clock.system_clock(),
            state_machine=sm,
            audio_buffer=buf,
        )
        pipeline.request_listen()

        silence_chunk = _make_chunk(value=0)
        speech_chunk = _make_chunk(value=999)
        for _ in range(5):
            pipeline._handle_chunk(silence_chunk)
        pipeline._handle_chunk(speech_chunk)  # lone speech, debounced
        for _ in range(5):
            pipeline._handle_chunk(silence_chunk)

        # Prefill has 10 silence chunks (5 before + 5 after the lone
        # speech). The speech chunk did NOT enter the deque even though
        # it was processed in LISTENING state.
        assert len(pipeline._silence_prefill) == 10
        assert all(frame == silence_chunk for frame in pipeline._silence_prefill)
