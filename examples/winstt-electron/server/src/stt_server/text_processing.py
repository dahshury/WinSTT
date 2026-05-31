"""Text detection and preprocessing for the STT server."""

from __future__ import annotations

import asyncio
import json
import math
import time
from difflib import SequenceMatcher

from src.building_blocks.terminal import TerminalColors as bcolors
from src.building_blocks.terminal import format_now_hms_ms
from src.stt_server.state import ServerState


def _recent_audio_variance(state: ServerState, window_seconds: float) -> float:
    """Standard deviation of audio levels in the most recent ``window_seconds``.

    Returns ``0.0`` when there are fewer than 2 samples in the window (caller
    treats this as "no signal" → don't block the noise-break).
    """
    if not state.recent_audio_levels:
        return 0.0
    cutoff = time.time() - window_seconds
    levels = [lvl for ts, lvl in state.recent_audio_levels if ts >= cutoff]
    if len(levels) < 2:
        return 0.0
    mean = sum(levels) / len(levels)
    var = sum((lvl - mean) ** 2 for lvl in levels) / len(levels)
    return math.sqrt(var)


def preprocess_text(text: str) -> str:
    """Clean up raw transcription text."""
    text = text.lstrip()

    if text.startswith("..."):
        text = text[3:]

    if text.endswith("...'."):
        text = text[:-1]

    if text.endswith("...'"):
        text = text[:-1]

    text = text.lstrip()

    if text:
        text = text[0].upper() + text[1:]

    return text


# Hard floor on the smart-endpoint computed pause. Whisper's realtime
# preview almost always terminates phrases with a period, and the
# classifier readily scores those "complete" — without a floor the
# window collapses to ~0.7s and the recording hard-stops mid-thought
# while the user is just drawing breath. 0.9s is the RealtimeSTT
# reference's own natural minimum for a confidently-complete sentence at
# detection_speed=2.0 ((1-0.95 + 0.4) * 2.0 ≈ 0.9), so flooring here
# matches the reference's effective behaviour rather than diverging.
SMART_ENDPOINT_MIN_PAUSE = 0.9


def interpolate_detection(prob: float) -> float:
    """Linear interpolation: prob 0.0 -> 1.0s pause, prob 1.0 -> 0.0s pause."""
    return max(0.0, min(1.0, 1.0 - prob))


def get_whisper_pause(text: str) -> float:
    """Return a silence pause duration based on trailing punctuation."""
    if text.endswith("..."):
        return 4.5
    if text.endswith("."):
        return 0.4
    if text.endswith("!"):
        return 0.3
    if text.endswith("?"):
        return 0.2
    return 1.8


def text_detected(text: str, state: ServerState, loop: asyncio.AbstractEventLoop) -> None:
    """Handle realtime transcription text — adjust silence timing and enqueue for broadcast."""
    text = preprocess_text(text)

    if not text:
        return

    if state.silence_timing and not state.loopback_capture.is_active:
        assert state.recorder is not None, "recorder must be initialized before text_detected is called"

        if (
            state.smart_endpoint_enabled
            and state.sentence_classifier is not None
            and state.sentence_classifier.is_available()
        ):
            prob = state.sentence_classifier.classify(text)
            model_pause = interpolate_detection(prob)
            whisper_pause = get_whisper_pause(text)
            pause = (model_pause + whisper_pause) * state.detection_speed
            # Hard floor: never finalize on a sub-~second window. A
            # period-terminated live preview scored "complete" would
            # otherwise cut the user off mid-thought during a breath.
            pause = max(pause, SMART_ENDPOINT_MIN_PAUSE)
            state.recorder.post_speech_silence_duration = pause
        else:

            def ends_with_ellipsis(t: str) -> bool:
                if t.endswith("..."):
                    return True
                return bool(len(t) > 1 and t[:-1].endswith("..."))

            def sentence_end(t: str) -> bool:
                sentence_end_marks = [".", "!", "?", "\u3002"]
                return bool(t and t[-1] in sentence_end_marks)

            if ends_with_ellipsis(text):
                state.recorder.post_speech_silence_duration = state.mid_sentence_detection_pause
            elif sentence_end(text) and sentence_end(state.prev_text) and not ends_with_ellipsis(state.prev_text):
                state.recorder.post_speech_silence_duration = state.end_of_sentence_detection_pause
            else:
                state.recorder.post_speech_silence_duration = state.unknown_sentence_detection_pause

        # Background noise repetition detection
        current_time = time.time()
        state.text_time_deque.append((current_time, text))

        while (
            state.text_time_deque
            and state.text_time_deque[0][0] < current_time - state.hard_break_even_on_background_noise
        ):
            state.text_time_deque.popleft()

        if len(state.text_time_deque) >= state.hard_break_even_on_background_noise_min_texts:
            texts = [t[1] for t in state.text_time_deque]
            first_text = texts[0]
            last_text = texts[-1]

            # Compare the trailing portion only. Whole-text similarity is
            # misleading on long transcripts: as the realtime buffer grows,
            # the (already-stabilized) prefix dominates the ratio and pushes
            # similarity above the threshold even while the user is still
            # speaking new words at the end. Detecting "stuck" transcription
            # is really about the tail repeating, not the whole text.
            tail_len = max(state.hard_break_even_on_background_noise_min_chars, 30)
            first_tail = first_text[-tail_len:]
            last_tail = last_text[-tail_len:]
            similarity = SequenceMatcher(None, first_tail, last_tail).ratio()

            if (
                similarity > state.hard_break_even_on_background_noise_min_similarity
                and len(first_text) > state.hard_break_even_on_background_noise_min_chars
            ):
                # Auto-stop gate: ``silence_endpoint_enabled`` is the master
                # "server may auto-end the recording" switch. PTT and
                # toggle+manualToggleStop both set it to False — in those
                # modes ONLY the user's hotkey release defines the boundary,
                # so noise-break must not fire here. Without this gate,
                # holding PTT through silence triggers Whisper to hallucinate
                # a repeating tail, the similarity gate trips ~3 s in
                # (hard_break_even_on_background_noise), and ``recorder.stop``
                # finalizes the recording and pastes mid-hold. See the
                # ptt-only-user-stop bug report on 2026-05-27.
                if not state.recorder.silence_endpoint_enabled:
                    print(
                        f"{bcolors.OKCYAN}[noise-break] SUPPRESSED — auto-stop disabled "
                        f"(silence_endpoint_enabled=False; user controls stop){bcolors.ENDC}",
                        flush=True,
                    )
                else:
                    # Audio-variance gate: when recent levels show meaningful
                    # variance the user is still speaking — Whisper is just
                    # hallucinating a repeating tail at low SNR. Killing the
                    # recording here truncates real speech mid-utterance,
                    # which was the reported toggle-mode bug. The break still
                    # fires for true stuck-on-noise sessions (flat RMS,
                    # no variance).
                    audio_variance = _recent_audio_variance(state, state.hard_break_even_on_background_noise)
                    if audio_variance > state.noise_break_audio_variance_threshold:
                        print(
                            f"{bcolors.OKCYAN}[noise-break] SUPPRESSED — repeating text "
                            f"but audio still active (variance={audio_variance:.4f} > "
                            f"threshold={state.noise_break_audio_variance_threshold:.4f}){bcolors.ENDC}",
                            flush=True,
                        )
                    else:
                        print(
                            f"{bcolors.WARNING}[noise-break] FIRING — first_tail={first_tail!r} "
                            f"last_tail={last_tail!r} similarity={similarity:.4f} "
                            f"first_text_len={len(first_text)} "
                            f"audio_variance={audio_variance:.4f}{bcolors.ENDC}",
                            flush=True,
                        )
                        state.recorder.stop()
                        state.recorder.clear_audio_queue()
                        state.prev_text = ""

    state.prev_text = text

    message = json.dumps({"type": "realtime", "text": text})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)

    timestamp = format_now_hms_ms()

    if state.extended_logging:
        print(
            f"  [{timestamp}] Realtime text: {bcolors.OKCYAN}{text}{bcolors.ENDC}\n",
            flush=True,
            end="",
        )
    elif state.debug_logging:
        print(f"\r[{timestamp}] {bcolors.OKCYAN}{text}{bcolors.ENDC}", flush=True, end="")
