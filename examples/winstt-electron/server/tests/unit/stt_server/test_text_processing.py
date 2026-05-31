"""Tests for stt_server/text_processing.py.

The Smart Endpoint feature lives here — `text_detected` reads the live
realtime transcription, asks a DistilBERT classifier "is this sentence
complete?", and shrinks/grows `recorder.post_speech_silence_duration`
accordingly. Higher classifier confidence ⇒ shorter wait before
finalising the utterance. These tests pin that contract.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import threading
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import pytest

from src.stt_server.state import ServerState
from src.stt_server.text_processing import (
    get_whisper_pause,
    interpolate_detection,
    preprocess_text,
    text_detected,
)
from tests.fakes.fake_sentence_classifier import FakeSentenceClassifier

# ─── Test fakes ──────────────────────────────────────────────────────────


class _FakeRecorder:
    """Minimal recorder stub — only the attrs/methods text_detected touches."""

    def __init__(self) -> None:
        self.post_speech_silence_duration: float = 0.0
        # ``silence_endpoint_enabled`` mirrors the production facade property;
        # text_processing reads it to gate the noise-break auto-stop. Defaults
        # to True so existing toggle-mode tests keep their behaviour; the new
        # PTT-mode suppression test flips it explicitly.
        self.silence_endpoint_enabled: bool = True
        self.stopped = 0
        self.cleared = 0

    def stop(self) -> None:
        self.stopped += 1

    def clear_audio_queue(self) -> None:
        self.cleared += 1


@dataclass
class _FakeLoopback:
    active: bool = False

    @property
    def is_active(self) -> bool:
        return self.active


@dataclass
class _CapturedMessages:
    """Captures whatever `text_detected` would have put on the audio_queue.

    `text_detected` calls `asyncio.run_coroutine_threadsafe(queue.put(msg), loop)`.
    The loop is created with `new_event_loop()` and started in a daemon thread
    here so the put actually runs; we then drain the queue on teardown.
    """

    messages: list[str] = field(default_factory=list)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _build_state(
    *,
    silence_timing: bool = True,
    smart_endpoint_enabled: bool = False,
    detection_speed: float = 1.5,
    classifier: FakeSentenceClassifier | None = None,
    loopback_active: bool = False,
    extended_logging: bool = False,
    debug_logging: bool = False,
    mid_sentence_detection_pause: float = 2.0,
    end_of_sentence_detection_pause: float = 0.4,
    unknown_sentence_detection_pause: float = 1.3,
) -> tuple[ServerState, _FakeRecorder]:
    """Build a ServerState with all the fakes wired up for text_detected."""
    args = argparse.Namespace(
        debug=debug_logging,
        use_extended_logging=extended_logging,
        write=False,
        logchunks=False,
        silence_timing=silence_timing,
        smart_endpoint=smart_endpoint_enabled,
        detection_speed=detection_speed,
        mid_sentence_detection_pause=mid_sentence_detection_pause,
        end_of_sentence_detection_pause=end_of_sentence_detection_pause,
        unknown_sentence_detection_pause=unknown_sentence_detection_pause,
    )
    recorder = _FakeRecorder()
    state = ServerState(
        args=args,
        loopback_capture=_FakeLoopback(active=loopback_active),  # type: ignore[arg-type]
        recorder=recorder,  # type: ignore[arg-type]
        sentence_classifier=classifier,
        silence_timing=silence_timing,
        smart_endpoint_enabled=smart_endpoint_enabled,
        detection_speed=detection_speed,
        extended_logging=extended_logging,
        debug_logging=debug_logging,
        # text_processing reads the pause durations off ServerState (not
        # args) so runtime set_parameter overrides take effect; mirror the
        # values onto both so either access path works.
        mid_sentence_detection_pause=mid_sentence_detection_pause,
        end_of_sentence_detection_pause=end_of_sentence_detection_pause,
        unknown_sentence_detection_pause=unknown_sentence_detection_pause,
    )
    return state, recorder


# NOTE: the audio-level gating that used to suppress the noise-break while
# the user was still speaking was removed from production. ``ServerState``
# no longer carries ``recent_audio_levels`` and ``text_detected`` fires the
# break purely on trailing-text repetition similarity (see project memory
# note ``project_noise_break.md``). The former ``_seed_quiet_audio`` /
# ``_seed_active_audio`` helpers seeded a state field that no longer exists
# and have been dropped along with the audio-gated test expectations.


class _RunningLoop:
    """Spin up an asyncio loop in a daemon thread so
    `asyncio.run_coroutine_threadsafe` actually runs the queue put.
    """

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def stop(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=1.0)
        self.loop.close()


@pytest.fixture
def loop_fixture() -> asyncio.AbstractEventLoop:
    rl = _RunningLoop()
    try:
        yield rl.loop
    finally:
        rl.stop()


def _drain_queue(state: ServerState, loop: asyncio.AbstractEventLoop) -> list[dict[str, Any]]:
    """Pop every message off state.audio_queue and return them as parsed dicts."""

    async def _drain() -> list[str]:
        out: list[str] = []
        while not state.audio_queue.empty():
            out.append(await state.audio_queue.get())
        return out

    fut = asyncio.run_coroutine_threadsafe(_drain(), loop)
    raw = fut.result(timeout=1.0)
    return [json.loads(m) for m in raw]


# ─── preprocess_text ─────────────────────────────────────────────────────


class TestPreprocessText:
    def test_strips_leading_whitespace(self) -> None:
        assert preprocess_text("   hello") == "Hello"

    def test_strips_leading_ellipsis(self) -> None:
        assert preprocess_text("...hello") == "Hello"

    def test_strips_ellipsis_followed_by_quote_period(self) -> None:
        # Whisper sometimes emits ``...'.`` — the cleanup drops the trailing
        # ``.`` then the trailing ``'``, collapsing back to plain ``...``.
        assert preprocess_text("hello...'.") == "Hello..."

    def test_strips_ellipsis_followed_by_quote(self) -> None:
        assert preprocess_text("hello...'") == "Hello..."

    def test_capitalises_first_letter(self) -> None:
        assert preprocess_text("hello world") == "Hello world"

    def test_preserves_already_capitalised(self) -> None:
        assert preprocess_text("Hello") == "Hello"

    def test_empty_string(self) -> None:
        assert preprocess_text("") == ""

    def test_only_whitespace(self) -> None:
        assert preprocess_text("   ") == ""

    def test_leading_ellipsis_then_whitespace(self) -> None:
        assert preprocess_text("...  hello") == "Hello"


# ─── Smart Endpoint pause math (illustrative example) ────────────────────


class TestSmartEndpointPauseExamples:
    """Worked examples — the contract the user-facing tooltip promises.

    Smart Endpoint blends two signals:

    - ``interpolate_detection(prob)``   ← DistilBERT confidence the
      sentence is complete (1.0 ⇒ very complete, 0.0 ⇒ mid-thought).
    - ``get_whisper_pause(text)``       ← punctuation heuristic
      (".", "!", "?" ⇒ short; bare words ⇒ longer; "..." ⇒ very long).

    Final wait = ``(model_pause + whisper_pause) * detection_speed``.

    High confidence + terminal punctuation ⇒ recorder commits fast;
    low confidence + no punctuation ⇒ recorder waits.
    """

    def test_complete_sentence_with_period_finalises_fast(self) -> None:
        # prob=0.9 → model_pause=0.1; "." → whisper_pause=0.4
        # (0.1 + 0.4) * 1.5 = 0.75 s
        model_pause = interpolate_detection(0.9)
        whisper_pause = get_whisper_pause("Hello world.")
        assert (model_pause + whisper_pause) * 1.5 == pytest.approx(0.75)

    def test_incomplete_sentence_no_punctuation_waits_longer(self) -> None:
        # prob=0.2 → model_pause=0.8; no punct → whisper_pause=1.8
        # (0.8 + 1.8) * 1.5 = 3.9 s — much longer hold-off before committing
        model_pause = interpolate_detection(0.2)
        whisper_pause = get_whisper_pause("Hello world")
        assert (model_pause + whisper_pause) * 1.5 == pytest.approx(3.9)

    def test_trailing_ellipsis_dominates(self) -> None:
        # "..." → whisper_pause=4.5 (Whisper hallucination guard)
        whisper_pause = get_whisper_pause("I was thinking...")
        assert whisper_pause == 4.5

    def test_detection_speed_scales_wait_linearly(self) -> None:
        base = interpolate_detection(0.5) + get_whisper_pause(".")
        assert base * 0.5 == pytest.approx(base * 0.5)
        assert base * 2.0 == pytest.approx(base * 2.0)
        # Sanity: doubling detection_speed doubles the resulting pause.
        slow = base * 2.0
        fast = base * 1.0
        assert slow == pytest.approx(fast * 2.0)


# ─── text_detected — Smart Endpoint branch ───────────────────────────────


class TestTextDetectedSmartEndpoint:
    def test_applies_classifier_pause_when_enabled_and_available(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        classifier = FakeSentenceClassifier(fixed_prob=0.9)
        state, recorder = _build_state(
            smart_endpoint_enabled=True,
            detection_speed=1.5,
            classifier=classifier,
        )

        text_detected("Hello world.", state, loop_fixture)

        # Raw math (1 - 0.9 + 0.4) * 1.5 = 0.75, but the smart-endpoint
        # hard floor (SMART_ENDPOINT_MIN_PAUSE = 0.9) clamps it so a
        # confidently-"complete" period-terminated preview can't cut the
        # user off sub-second mid-thought.
        assert recorder.post_speech_silence_duration == pytest.approx(0.9)
        # The realtime message is also broadcast.
        msgs = _drain_queue(state, loop_fixture)
        assert msgs == [{"type": "realtime", "text": "Hello world."}]

    def test_smart_endpoint_pause_is_floored(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        # prob=1.0 → model_pause=0; "." → whisper_pause=0.4;
        # (0 + 0.4) * 1.0 = 0.4, well below the 0.9 floor.
        classifier = FakeSentenceClassifier(fixed_prob=1.0)
        state, recorder = _build_state(
            smart_endpoint_enabled=True,
            detection_speed=1.0,
            classifier=classifier,
        )

        text_detected("Done.", state, loop_fixture)

        assert recorder.post_speech_silence_duration == pytest.approx(0.9)

    def test_smart_endpoint_pause_above_floor_is_unclamped(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        # Low confidence keeps the pause well above the floor — the clamp
        # must NOT drag a long, deliberate wait down.
        classifier = FakeSentenceClassifier(fixed_prob=0.2)
        state, recorder = _build_state(
            smart_endpoint_enabled=True,
            detection_speed=2.0,
            classifier=classifier,
        )

        text_detected("Thinking it over", state, loop_fixture)

        # (1 - 0.2 + 1.8) * 2.0 = 5.2 — far above the 0.9 floor.
        assert recorder.post_speech_silence_duration == pytest.approx(5.2)

    def test_low_confidence_text_yields_long_pause(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        classifier = FakeSentenceClassifier(fixed_prob=0.2)
        state, recorder = _build_state(
            smart_endpoint_enabled=True,
            detection_speed=1.5,
            classifier=classifier,
        )

        text_detected("Hello world", state, loop_fixture)

        # (1 - 0.2 + 1.8) * 1.5 = 3.9
        assert recorder.post_speech_silence_duration == pytest.approx(3.9)

    def test_detection_speed_scales_pause(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        classifier = FakeSentenceClassifier(fixed_prob=0.5)
        state, recorder = _build_state(
            smart_endpoint_enabled=True,
            detection_speed=2.0,
            classifier=classifier,
        )

        text_detected("Maybe.", state, loop_fixture)

        # (1 - 0.5 + 0.4) * 2.0 = 1.8
        assert recorder.post_speech_silence_duration == pytest.approx(1.8)

    def test_falls_back_to_heuristic_when_classifier_unavailable(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        classifier = FakeSentenceClassifier()
        classifier.set_available(False)
        state, recorder = _build_state(
            smart_endpoint_enabled=True,
            detection_speed=1.5,
            classifier=classifier,
            end_of_sentence_detection_pause=0.4,
        )
        state.prev_text = "Previous sentence."

        text_detected("Final sentence.", state, loop_fixture)

        # Heuristic: two consecutive sentence-ends → end_of_sentence pause.
        # Classifier math (which would give 0.0 here) is NOT used.
        assert recorder.post_speech_silence_duration == pytest.approx(0.4)

    def test_falls_back_to_heuristic_when_classifier_is_none(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        state, recorder = _build_state(
            smart_endpoint_enabled=True,
            classifier=None,
            unknown_sentence_detection_pause=1.3,
        )

        text_detected("Word without punctuation", state, loop_fixture)

        # No prev sentence end + no ellipsis → unknown pause.
        assert recorder.post_speech_silence_duration == pytest.approx(1.3)

    def test_disabled_uses_heuristic_even_with_classifier(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        classifier = FakeSentenceClassifier(fixed_prob=0.9)
        state, recorder = _build_state(
            smart_endpoint_enabled=False,
            classifier=classifier,
            mid_sentence_detection_pause=2.5,
        )

        text_detected("Thinking...", state, loop_fixture)

        # Ellipsis → mid_sentence pause; classifier ignored.
        assert recorder.post_speech_silence_duration == pytest.approx(2.5)


# ─── text_detected — silence_timing gating ───────────────────────────────


class TestSilenceTimingGate:
    def test_no_recorder_mutation_when_silence_timing_off(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        classifier = FakeSentenceClassifier(fixed_prob=0.9)
        state, recorder = _build_state(
            silence_timing=False,
            smart_endpoint_enabled=True,
            classifier=classifier,
        )

        text_detected("Hello world.", state, loop_fixture)

        # silence_timing gates the whole pause-tuning branch.
        assert recorder.post_speech_silence_duration == 0.0

    def test_no_recorder_mutation_during_loopback(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        classifier = FakeSentenceClassifier(fixed_prob=0.9)
        state, recorder = _build_state(
            smart_endpoint_enabled=True,
            classifier=classifier,
            loopback_active=True,
        )

        text_detected("Hello world.", state, loop_fixture)

        # Loopback mode never tunes the recorder timing — the loopback
        # capture owns post_speech_silence_duration in that flow.
        assert recorder.post_speech_silence_duration == 0.0

    def test_realtime_message_still_broadcast_when_silence_timing_off(
        self, loop_fixture: asyncio.AbstractEventLoop
    ) -> None:
        state, _ = _build_state(silence_timing=False)
        text_detected("Hello.", state, loop_fixture)
        msgs = _drain_queue(state, loop_fixture)
        assert msgs == [{"type": "realtime", "text": "Hello."}]


# ─── text_detected — early-return guards ─────────────────────────────────


class TestTextDetectedEarlyReturn:
    def test_empty_text_after_preprocess_is_skipped(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        state, recorder = _build_state(smart_endpoint_enabled=True, classifier=FakeSentenceClassifier())
        text_detected("   ", state, loop_fixture)
        assert recorder.post_speech_silence_duration == 0.0
        msgs = _drain_queue(state, loop_fixture)
        assert msgs == []

    def test_prev_text_is_updated_for_repeat_detection(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        state, _ = _build_state()
        text_detected("Hello.", state, loop_fixture)
        assert state.prev_text == "Hello."


# ─── text_detected — noise repetition break ──────────────────────────────


class TestNoiseRepetitionBreak:
    """The "stuck transcription" guard: if the trailing portion of the
    realtime text repeats several times in a short window, treat it as
    background-noise hallucination and force the recorder to stop.

    The break fires purely on trailing-text repetition similarity. The
    former audio-level gating (suppress while RMS varies) was removed from
    production — ``ServerState`` no longer carries ``recent_audio_levels``
    and the guard no longer inspects audio energy at all (see project
    memory note ``project_noise_break.md``).
    """

    def test_repeating_tail_triggers_force_stop(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        state, recorder = _build_state()
        # Use a long-enough tail that the similarity check actually fires
        # (min_chars=15, min_similarity=0.99 by default).
        tail = "this is the repeating tail " * 2
        for _ in range(state.hard_break_even_on_background_noise_min_texts):
            text_detected(f"Prefix {tail}", state, loop_fixture)

        assert recorder.stopped >= 1
        assert recorder.cleared >= 1

    def test_repeating_tail_without_audio_history_still_fires(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        """The guard has no audio-energy input at all now — a repeating
        tail always fires regardless of any (now-absent) audio history."""
        state, recorder = _build_state()
        tail = "this is the repeating tail " * 2
        for _ in range(state.hard_break_even_on_background_noise_min_texts):
            text_detected(f"Prefix {tail}", state, loop_fixture)

        assert recorder.stopped >= 1
        assert recorder.cleared >= 1

    def test_dissimilar_texts_do_not_trigger_stop(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        state, recorder = _build_state()
        # Every chunk has a different tail (>30 chars) so similarity stays low.
        chunks = [
            "Alpha beta gamma delta epsilon zeta eta theta",
            "Foo bar baz qux quux corge grault garply",
            "Lorem ipsum dolor sit amet consectetur adipiscing",
        ]
        for c in chunks:
            text_detected(c, state, loop_fixture)
        assert recorder.stopped == 0
        assert recorder.cleared == 0

    def test_suppressed_when_silence_endpoint_disabled(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        """PTT / toggle+manualToggleStop: ``silence_endpoint_enabled=False``
        means only the user's hotkey release ends the recording, so the
        noise-break MUST NOT fire ``recorder.stop`` even when Whisper
        produces a repeating tail. Regression guard for the
        "PTT pastes mid-hold on prolonged silence" bug — the realtime
        worker keeps emitting the same hallucinated suffix for silent
        frames and would otherwise trip the similarity gate ~3 s in.
        """
        state, recorder = _build_state()
        recorder.silence_endpoint_enabled = False
        tail = "this is the repeating tail " * 2
        for _ in range(state.hard_break_even_on_background_noise_min_texts):
            text_detected(f"Prefix {tail}", state, loop_fixture)

        assert recorder.stopped == 0
        assert recorder.cleared == 0


# ─── text_detected — broadcast & logging ─────────────────────────────────


class TestRealtimeBroadcast:
    def test_message_shape(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        state, _ = _build_state()
        text_detected("Hello world.", state, loop_fixture)
        msgs = _drain_queue(state, loop_fixture)
        assert msgs == [{"type": "realtime", "text": "Hello world."}]

    def test_text_is_preprocessed_before_broadcast(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        state, _ = _build_state()
        text_detected("...hello", state, loop_fixture)
        msgs = _drain_queue(state, loop_fixture)
        assert msgs == [{"type": "realtime", "text": "Hello"}]

    def test_text_time_deque_grows(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        state, _ = _build_state()
        text_detected("First.", state, loop_fixture)
        text_detected("Second.", state, loop_fixture)
        assert len(state.text_time_deque) == 2

    def test_deque_evicts_entries_older_than_window(self, loop_fixture: asyncio.AbstractEventLoop) -> None:
        state, _ = _build_state()
        # Window is `hard_break_even_on_background_noise` seconds (default 3).
        # Manually seed an ancient entry; text_detected must drop it.
        ancient: deque[tuple[float, str]] = deque()
        ancient.append((0.0, "ancient text"))  # epoch 0 → way outside window
        state.text_time_deque = ancient
        text_detected("Fresh.", state, loop_fixture)
        assert all(t > 1.0 for t, _ in state.text_time_deque)
