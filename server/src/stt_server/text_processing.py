"""Text detection and preprocessing for the STT server."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime
from difflib import SequenceMatcher

from src.building_blocks.terminal import TerminalColors as bcolors
from src.stt_server.state import ServerState


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
                state.recorder.post_speech_silence_duration = state.args.mid_sentence_detection_pause
            elif sentence_end(text) and sentence_end(state.prev_text) and not ends_with_ellipsis(state.prev_text):
                state.recorder.post_speech_silence_duration = state.args.end_of_sentence_detection_pause
            else:
                state.recorder.post_speech_silence_duration = state.args.unknown_sentence_detection_pause

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

            similarity = SequenceMatcher(None, first_text, last_text).ratio()

            if (
                similarity > state.hard_break_even_on_background_noise_min_similarity
                and len(first_text) > state.hard_break_even_on_background_noise_min_chars
            ):
                state.recorder.stop()
                state.recorder.clear_audio_queue()
                state.prev_text = ""

    state.prev_text = text

    message = json.dumps({"type": "realtime", "text": text})
    asyncio.run_coroutine_threadsafe(state.audio_queue.put(message), loop)

    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]

    if state.extended_logging:
        print(
            f"  [{timestamp}] Realtime text: {bcolors.OKCYAN}{text}{bcolors.ENDC}\n",
            flush=True,
            end="",
        )
    elif state.debug_logging:
        print(f"\r[{timestamp}] {bcolors.OKCYAN}{text}{bcolors.ENDC}", flush=True, end="")
