"""Speech-to-Text (STT) Server with Real-Time Transcription and WebSocket Interface.

This server provides real-time speech-to-text (STT) transcription using the
RealtimeSTT library. It allows clients to connect via WebSocket to send audio
data and receive real-time transcription updates. The server supports
configurable audio recording parameters, voice activity detection (VAD), and
wake word detection. It is designed to handle continuous transcription as well
as post-recording processing, enabling real-time feedback with the option to
improve final transcription quality after the complete sentence is recognised.

Features
--------
- Real-time transcription using pre-configured or user-defined STT models.
- WebSocket-based communication for control and data handling.
- Flexible recording and transcription options, including configurable pauses
  for sentence detection.
- Supports Silero and WebRTC VAD for robust voice activity detection.

Starting the Server
-------------------
You can start the server using the command-line interface (CLI) command
``stt-server``, passing the desired configuration options::

    stt-server [OPTIONS]

WebSocket Interface
-------------------
The server supports two WebSocket connections:

1. **Control WebSocket** -- Used to send and receive commands, such as setting
   parameters or calling recorder methods.
2. **Data WebSocket** -- Used to send audio data for transcription and receive
   real-time transcription updates.

The server will broadcast real-time transcription updates to all connected
clients on the data WebSocket.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import logging
import os
import signal
import sys
from collections import deque
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pyaudio

from src.stt_server.install_packages import check_and_install_packages

if TYPE_CHECKING:
    from collections.abc import Callable

debug_logging: bool = False
extended_logging: bool = False
send_recorded_chunk: bool = False
log_incoming_chunks: bool = False
silence_timing: bool = False
writechunks: str | bool = False
wav_file: wave.Wave_write | None = None

hard_break_even_on_background_noise: float = 3.0
hard_break_even_on_background_noise_min_texts: int = 3
hard_break_even_on_background_noise_min_similarity: float = 0.99
hard_break_even_on_background_noise_min_chars: int = 15


text_time_deque: deque[tuple[float, str]] = deque()
loglevel: int = logging.WARNING

# ─── Settings persistence ───────────────────────────────────────────────
# Persists parameters set at runtime (e.g. model) so the next server
# startup uses the same values without waiting for a frontend sync.
SETTINGS_DIR = Path.home() / ".winstt"
SETTINGS_FILE = SETTINGS_DIR / "server-settings.json"
PERSISTED_PARAMETERS: set[str] = {"model"}


def load_persisted_settings() -> dict[str, Any]:
    if not SETTINGS_FILE.exists():
        return {}
    try:
        data: dict[str, Any] = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        return data
    except (json.JSONDecodeError, OSError):
        return {}


def persist_setting(key: str, value: object) -> None:
    if key not in PERSISTED_PARAMETERS:
        return
    settings = load_persisted_settings()
    settings[key] = value
    try:
        SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    except OSError:
        pass

FORMAT = pyaudio.paInt16
CHANNELS = 1


if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


check_and_install_packages(
    [
        {
            "module_name": "src.recorder",
            "attribute": "AudioToTextRecorder",
            "install_name": "RealtimeSTT",
        },
        {
            "module_name": "websockets",
            "install_name": "websockets",
        },
        {
            "module_name": "numpy",
            "install_name": "numpy",
        },
        {
            "module_name": "scipy.signal",
            "attribute": "resample",
            "install_name": "scipy",
        },
    ]
)


# Define ANSI colour codes for terminal output
class bcolors:
    HEADER = "\033[95m"  # Magenta
    OKBLUE = "\033[94m"  # Blue
    OKCYAN = "\033[96m"  # Cyan
    OKGREEN = "\033[92m"  # Green
    WARNING = "\033[93m"  # Yellow
    FAIL = "\033[91m"  # Red
    ENDC = "\033[0m"  # Reset to default
    BOLD = "\033[1m"
    UNDERLINE = "\033[4m"


print(f"{bcolors.BOLD}{bcolors.OKCYAN}Starting server, please wait...{bcolors.ENDC}")

# Initialize colorama
import json  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import wave  # noqa: E402

import numpy as np  # noqa: E402
import websockets  # noqa: E402
from colorama import Fore, Style, init  # noqa: E402
from scipy.signal import resample  # noqa: E402
from websockets.asyncio.server import ServerConnection  # noqa: E402

from src.recorder import AudioToTextRecorder  # noqa: E402
from src.recorder.domain.events import DownloadProgress  # noqa: E402
from src.stt_server.loopback import LoopbackCapture  # noqa: E402

init()

global_args: argparse.Namespace | None = None
recorder: AudioToTextRecorder | None = None
loopback_capture = LoopbackCapture()
recorder_config: dict[str, Any] = {}
recorder_ready = threading.Event()
recorder_thread: threading.Thread | None = None
stop_recorder: bool = False
prev_text: str = ""
shutdown_event: asyncio.Event | None = None

# Define allowed methods and parameters for security
allowed_methods: list[str] = [
    "set_microphone",
    "abort",
    "stop",
    "clear_audio_queue",
    "wakeup",
    "shutdown",
    "text",
]
allowed_parameters: list[str] = [
    "model",
    "language",
    "silero_sensitivity",
    "wake_word_activation_delay",
    "post_speech_silence_duration",
    "listen_start",
    "recording_stop_time",
    "last_transcription_bytes",
    "last_transcription_bytes_b64",
    "speech_end_silence_start",
    "is_recording",
    "use_wake_words",
    "silence_timing",
]

# Queues and connections for control and data
control_connections: set[ServerConnection] = set()
data_connections: set[ServerConnection] = set()
control_queue: asyncio.Queue[str] = asyncio.Queue()
audio_queue: asyncio.Queue[str] = asyncio.Queue()


def preprocess_text(text: str) -> str:
    # Remove leading whitespaces
    text = text.lstrip()

    # Remove starting ellipses if present
    if text.startswith("..."):
        text = text[3:]

    if text.endswith("...'."):
        text = text[:-1]

    if text.endswith("...'"):
        text = text[:-1]

    # Remove any leading whitespaces again after ellipses removal
    text = text.lstrip()

    # Uppercase the first letter
    if text:
        text = text[0].upper() + text[1:]

    return text


def debug_print(message: str) -> None:
    if debug_logging:
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        thread_name = threading.current_thread().name
        print(
            f"{Fore.CYAN}[DEBUG][{timestamp}][{thread_name}] {message}{Style.RESET_ALL}",
            file=sys.stderr,
        )


def format_timestamp_ns(timestamp_ns: int) -> str:
    # Split into whole seconds and the nanosecond remainder
    seconds = timestamp_ns // 1_000_000_000
    remainder_ns = timestamp_ns % 1_000_000_000

    # Convert seconds part into a datetime object (local time)
    dt = datetime.fromtimestamp(seconds)

    # Format the main time as HH:MM:SS
    time_str = dt.strftime("%H:%M:%S")

    # For instance, if you want milliseconds, divide the remainder by 1e6 and format as 3-digit
    milliseconds = remainder_ns // 1_000_000
    formatted_timestamp = f"{time_str}.{milliseconds:03d}"

    return formatted_timestamp


def text_detected(text: str, loop: asyncio.AbstractEventLoop) -> None:
    global prev_text

    text = preprocess_text(text)

    if silence_timing and not loopback_capture.is_active:
        assert recorder is not None, "recorder must be initialized before text_detected is called"
        assert global_args is not None, "global_args must be set before text_detected is called"

        def ends_with_ellipsis(text: str) -> bool:
            if text.endswith("..."):
                return True
            return bool(len(text) > 1 and text[:-1].endswith("..."))

        def sentence_end(text: str) -> bool:
            sentence_end_marks = [".", "!", "?", "\u3002"]
            return bool(text and text[-1] in sentence_end_marks)

        if ends_with_ellipsis(text):
            recorder.post_speech_silence_duration = global_args.mid_sentence_detection_pause
        elif sentence_end(text) and sentence_end(prev_text) and not ends_with_ellipsis(prev_text):
            recorder.post_speech_silence_duration = global_args.end_of_sentence_detection_pause
        else:
            recorder.post_speech_silence_duration = global_args.unknown_sentence_detection_pause

        # Append the new text with its timestamp
        current_time = time.time()
        text_time_deque.append((current_time, text))

        # Remove texts older than hard_break_even_on_background_noise seconds
        while text_time_deque and text_time_deque[0][0] < current_time - hard_break_even_on_background_noise:
            text_time_deque.popleft()

        # Check if at least hard_break_even_on_background_noise_min_texts texts
        # have arrived within the last hard_break_even_on_background_noise seconds
        if len(text_time_deque) >= hard_break_even_on_background_noise_min_texts:
            texts = [t[1] for t in text_time_deque]
            first_text = texts[0]
            last_text = texts[-1]

            # Compute the similarity ratio between the first and last texts
            similarity = SequenceMatcher(None, first_text, last_text).ratio()

            if (
                similarity > hard_break_even_on_background_noise_min_similarity
                and len(first_text) > hard_break_even_on_background_noise_min_chars
            ):
                recorder.stop()
                recorder.clear_audio_queue()
                prev_text = ""

    prev_text = text

    # Put the message in the audio queue to be sent to clients
    message = json.dumps(
        {
            "type": "realtime",
            "text": text,
        }
    )
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)

    # Get current timestamp in HH:MM:SS.nnn format
    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]

    if extended_logging:
        print(
            f"  [{timestamp}] Realtime text: {bcolors.OKCYAN}{text}{bcolors.ENDC}\n",
            flush=True,
            end="",
        )
    elif debug_logging:
        print(f"\r[{timestamp}] {bcolors.OKCYAN}{text}{bcolors.ENDC}", flush=True, end="")


def on_recording_start(loop: asyncio.AbstractEventLoop) -> None:
    message = json.dumps(
        {
            "type": "recording_start",
        }
    )
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_recording_stop(loop: asyncio.AbstractEventLoop) -> None:
    message = json.dumps(
        {
            "type": "recording_stop",
        }
    )
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_vad_detect_start(loop: asyncio.AbstractEventLoop) -> None:
    message = json.dumps(
        {
            "type": "vad_detect_start",
        }
    )
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_vad_detect_stop(loop: asyncio.AbstractEventLoop) -> None:
    message = json.dumps(
        {
            "type": "vad_detect_stop",
        }
    )
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_wakeword_detected(loop: asyncio.AbstractEventLoop) -> None:
    message = json.dumps(
        {
            "type": "wakeword_detected",
        }
    )
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_wakeword_detection_start(loop: asyncio.AbstractEventLoop) -> None:
    message = json.dumps(
        {
            "type": "wakeword_detection_start",
        }
    )
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_wakeword_detection_end(loop: asyncio.AbstractEventLoop) -> None:
    message = json.dumps(
        {
            "type": "wakeword_detection_end",
        }
    )
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


# Latest download state — replayed to data clients that connect mid-download.
_download_state: str | None = None

# Cancel flag — set via the "cancel_download" control command.
_cancel_download_requested: bool = False


def on_model_download_start(model: str, loop: asyncio.AbstractEventLoop) -> None:
    global _download_state, _cancel_download_requested
    _cancel_download_requested = False
    print(f"{bcolors.OKGREEN}[download] start: {model}{bcolors.ENDC}")
    message = json.dumps({"type": "model_download_start", "model": model})
    _download_state = message
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_model_download_progress(info: DownloadProgress, loop: asyncio.AbstractEventLoop) -> None:
    global _download_state
    message = json.dumps({
        "type": "model_download_progress",
        "model": info.model,
        "progress": info.progress,
        "downloaded_bytes": info.downloaded_bytes,
        "total_bytes": info.total_bytes,
        "speed_bps": info.speed_bps,
        "eta_seconds": info.eta_seconds,
    })
    _download_state = message
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_model_download_complete(model: str, loop: asyncio.AbstractEventLoop) -> None:
    global _download_state
    print(f"{bcolors.OKGREEN}[download] complete: {model}{bcolors.ENDC}")
    message = json.dumps({"type": "model_download_complete", "model": model})
    _download_state = None
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_transcription_start(
    _audio_bytes: np.ndarray[Any, np.dtype[np.int16]],
    loop: asyncio.AbstractEventLoop,
) -> None:
    bytes_b64 = base64.b64encode(_audio_bytes.tobytes()).decode("utf-8")
    message = json.dumps(
        {
            "type": "transcription_start",
            "audio_bytes_base64": bytes_b64,
        }
    )
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_audio_level(level: float, loop: asyncio.AbstractEventLoop) -> None:
    message = json.dumps({"type": "audio_level", "level": round(level, 4)})
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_turn_detection_start(loop: asyncio.AbstractEventLoop) -> None:
    debug_print("on_turn_detection_start")
    message = json.dumps(
        {
            "type": "start_turn_detection",
        }
    )
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


def on_turn_detection_stop(loop: asyncio.AbstractEventLoop) -> None:
    debug_print("on_turn_detection_stop")
    message = json.dumps(
        {
            "type": "stop_turn_detection",
        }
    )
    asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)


# Define the server's arguments
def parse_arguments() -> argparse.Namespace:
    global debug_logging, extended_logging, loglevel, writechunks, log_incoming_chunks, silence_timing

    parser = argparse.ArgumentParser(
        description="Start the Speech-to-Text (STT) server with various configuration options.",
    )

    parser.add_argument(
        "-m",
        "--model",
        type=str,
        default="large-v2",
        help=(
            "Path to the STT model or model size. Options include: tiny, tiny.en, "
            "base, base.en, small, small.en, medium, medium.en, large-v1, large-v2, "
            "or any huggingface CTranslate2 STT model such as "
            "deepdml/faster-whisper-large-v3-turbo-ct2. Default is large-v2."
        ),
    )

    parser.add_argument(
        "-r",
        "--rt-model",
        "--realtime_model_type",
        type=str,
        default="tiny",
        help=(
            "Model size for real-time transcription. Options same as --model. "
            "This is used only if real-time transcription is enabled "
            "(enable_realtime_transcription). Default is tiny.en."
        ),
    )

    parser.add_argument(
        "-l",
        "--lang",
        "--language",
        type=str,
        default="en",
        help=(
            "Language code for the STT model to transcribe in a specific language. "
            "Leave this empty for auto-detection based on input audio. Default is en. "
            "List of supported language codes: "
            "https://github.com/openai/whisper/blob/main/whisper/tokenizer.py#L11-L110"
        ),
    )

    parser.add_argument(
        "-i",
        "--input-device",
        "--input-device-index",
        type=int,
        default=1,
        help=(
            "Index of the audio input device to use. Use this option to specify a "
            "particular microphone or audio input device based on your system. Default is 1."
        ),
    )

    parser.add_argument(
        "-c",
        "--control",
        "--control_port",
        type=int,
        default=8011,
        help=(
            "The port number used for the control WebSocket connection. Control "
            "connections are used to send and receive commands to the server. "
            "Default is port 8011."
        ),
    )

    parser.add_argument(
        "-d",
        "--data",
        "--data_port",
        type=int,
        default=8012,
        help=(
            "The port number used for the data WebSocket connection. Data connections "
            "are used to send audio data and receive transcription updates in real time. "
            "Default is port 8012."
        ),
    )

    parser.add_argument(
        "-w",
        "--wake_words",
        type=str,
        default="",
        help=(
            "Specify the wake word(s) that will trigger the server to start listening. "
            'For example, setting this to "Jarvis" will make the system start '
            'transcribing when it detects the wake word "Jarvis". Default is "".'
        ),
    )

    parser.add_argument(
        "-D",
        "--debug",
        action="store_true",
        help="Enable debug logging for detailed server operations",
    )

    parser.add_argument(
        "--debug_websockets",
        action="store_true",
        help="Enable debug logging for detailed server websocket operations",
    )

    parser.add_argument(
        "-W",
        "--write",
        metavar="FILE",
        help="Save received audio to a WAV file",
    )

    parser.add_argument(
        "-b",
        "--batch",
        "--batch_size",
        type=int,
        default=16,
        help=(
            "Batch size for inference. This parameter controls the number of audio "
            "chunks processed in parallel during transcription. Default is 16."
        ),
    )

    parser.add_argument(
        "--root",
        "--download_root",
        type=str,
        default=None,
        help="Specifies the root path where the Whisper models are downloaded to. Default is None.",
    )

    parser.add_argument(
        "-s",
        "--silence_timing",
        action="store_true",
        default=False,
        help=(
            "Enable dynamic adjustment of silence duration for sentence detection. "
            "Adjusts post-speech silence duration based on detected sentence structure "
            "and punctuation. Default is False. Automatically enabled by the frontend "
            "when recording mode is set to Toggle."
        ),
    )

    parser.add_argument(
        "--init_realtime_after_seconds",
        type=float,
        default=0.2,
        help=(
            "The initial waiting time in seconds before real-time transcription starts. "
            "This delay helps prevent false positives at the beginning of a session. "
            "Default is 0.2 seconds."
        ),
    )

    parser.add_argument(
        "--realtime_batch_size",
        type=int,
        default=16,
        help=(
            "Batch size for the real-time transcription model. This parameter controls "
            "the number of audio chunks processed in parallel during real-time "
            "transcription. Default is 16."
        ),
    )

    parser.add_argument(
        "--initial_prompt_realtime",
        type=str,
        default="",
        help=(
            "Initial prompt that guides the real-time transcription model to produce "
            "transcriptions in a particular style or format."
        ),
    )

    parser.add_argument(
        "--silero_sensitivity",
        type=float,
        default=0.05,
        help=(
            "Sensitivity level for Silero Voice Activity Detection (VAD), with a range "
            "from 0 to 1. Lower values make the model less sensitive, useful for noisy "
            "environments. Default is 0.05."
        ),
    )

    parser.add_argument(
        "--silero_use_onnx",
        action="store_true",
        default=False,
        help=(
            "Enable ONNX version of Silero model for faster performance with lower resource usage. Default is False."
        ),
    )

    parser.add_argument(
        "--webrtc_sensitivity",
        type=int,
        default=3,
        help=(
            "Sensitivity level for WebRTC Voice Activity Detection (VAD), with a range "
            "from 0 to 3. Higher values make the model less sensitive, useful for "
            "cleaner environments. Default is 3."
        ),
    )

    parser.add_argument(
        "--min_length_of_recording",
        type=float,
        default=1.1,
        help=(
            "Minimum duration of valid recordings in seconds. This prevents very short "
            "recordings from being processed, which could be caused by noise or "
            "accidental sounds. Default is 1.1 seconds."
        ),
    )

    parser.add_argument(
        "--min_gap_between_recordings",
        type=float,
        default=0,
        help=(
            "Minimum time (in seconds) between consecutive recordings. Setting this "
            "helps avoid overlapping recordings when there is a brief silence between "
            "them. Default is 0 seconds."
        ),
    )

    parser.add_argument(
        "--enable_realtime_transcription",
        action="store_true",
        default=False,
        help=(
            "Enable continuous real-time transcription of audio as it is received. "
            "When enabled, transcriptions are sent in near real-time."
        ),
    )

    parser.add_argument(
        "--realtime_processing_pause",
        type=float,
        default=0.02,
        help=(
            "Time interval (in seconds) between processing audio chunks for real-time "
            "transcription. Lower values increase responsiveness but may put more load "
            "on the CPU. Default is 0.02 seconds."
        ),
    )

    parser.add_argument(
        "--silero_deactivity_detection",
        action="store_true",
        default=True,
        help=(
            "Use the Silero model for end-of-speech detection. This option can provide "
            "more robust silence detection in noisy environments, though it consumes "
            "more GPU resources. Default is True."
        ),
    )

    parser.add_argument(
        "--early_transcription_on_silence",
        type=float,
        default=0.2,
        help=(
            "Start transcription after the specified seconds of silence. This is "
            "useful when you want to trigger transcription mid-speech when there is a "
            "brief pause. Should be lower than post_speech_silence_duration. Set to 0 "
            "to disable. Default is 0.2 seconds."
        ),
    )

    parser.add_argument(
        "--beam_size",
        type=int,
        default=5,
        help=(
            "Beam size for the main transcription model. Larger values may improve "
            "transcription accuracy but increase the processing time. Default is 5."
        ),
    )

    parser.add_argument(
        "--beam_size_realtime",
        type=int,
        default=3,
        help=(
            "Beam size for the real-time transcription model. A smaller beam size "
            "allows for faster real-time processing but may reduce accuracy. Default is 3."
        ),
    )

    parser.add_argument(
        "--initial_prompt",
        type=str,
        default=(
            "Incomplete thoughts should end with '...'. "
            "Examples of complete thoughts: 'The sky is blue.' 'She walked home.' "
            "Examples of incomplete thoughts: 'When the sky...' 'Because he...'"
        ),
        help=(
            "Initial prompt that guides the transcription model to produce "
            "transcriptions in a particular style or format. The default provides "
            "instructions for handling sentence completions and ellipsis usage."
        ),
    )

    parser.add_argument(
        "--end_of_sentence_detection_pause",
        type=float,
        default=0.45,
        help=(
            "The duration of silence (in seconds) that the model should interpret as "
            "the end of a sentence. This helps the system detect when to finalise the "
            "transcription of a sentence. Default is 0.45 seconds."
        ),
    )

    parser.add_argument(
        "--unknown_sentence_detection_pause",
        type=float,
        default=0.7,
        help=(
            "The duration of pause (in seconds) that the model should interpret as an "
            "incomplete or unknown sentence. This is useful for identifying when a "
            "sentence is trailing off or unfinished. Default is 0.7 seconds."
        ),
    )

    parser.add_argument(
        "--mid_sentence_detection_pause",
        type=float,
        default=2.0,
        help=(
            "The duration of pause (in seconds) that the model should interpret as a "
            "mid-sentence break. Longer pauses can indicate a pause in speech but not "
            "necessarily the end of a sentence. Default is 2.0 seconds."
        ),
    )

    parser.add_argument(
        "--wake_words_sensitivity",
        type=float,
        default=0.5,
        help=(
            "Sensitivity level for wake word detection, with a range from 0 (most "
            "sensitive) to 1 (least sensitive). Adjust this value based on your "
            "environment to ensure reliable wake word detection. Default is 0.5."
        ),
    )

    parser.add_argument(
        "--wake_word_timeout",
        type=float,
        default=5.0,
        help=(
            "Maximum time in seconds that the system will wait for a wake word before "
            "timing out. After this timeout, the system stops listening for wake words "
            "until reactivated. Default is 5.0 seconds."
        ),
    )

    parser.add_argument(
        "--wake_word_activation_delay",
        type=float,
        default=0,
        help=(
            "The delay in seconds before the wake word detection is activated after "
            "the system starts listening. This prevents false positives during the "
            "start of a session. Default is 0 seconds."
        ),
    )

    parser.add_argument(
        "--wakeword_backend",
        type=str,
        default="none",
        help=(
            "The backend used for wake word detection. You can specify different "
            'backends such as "default" or any custom implementations depending on '
            'your setup. Default is "pvporcupine".'
        ),
    )

    parser.add_argument(
        "--openwakeword_model_paths",
        type=str,
        nargs="*",
        help=(
            "A list of file paths to OpenWakeWord models. This is useful if you are "
            "using OpenWakeWord for wake word detection and need to specify custom models."
        ),
    )

    parser.add_argument(
        "--openwakeword_inference_framework",
        type=str,
        default="tensorflow",
        help=(
            "The inference framework to use for OpenWakeWord models. Supported "
            'frameworks could include "tensorflow", "pytorch", etc. Default is '
            '"tensorflow".'
        ),
    )

    parser.add_argument(
        "--wake_word_buffer_duration",
        type=float,
        default=1.0,
        help=(
            "Duration of the buffer in seconds for wake word detection. This sets how "
            "long the system will store the audio before and after detecting the wake "
            "word. Default is 1.0 seconds."
        ),
    )

    parser.add_argument(
        "--use_main_model_for_realtime",
        action="store_true",
        default=False,
        help=(
            "Use the main model for real-time transcription instead of loading a "
            "separate smaller model. Saves GPU memory at the cost of slightly higher "
            "processing time."
        ),
    )

    parser.add_argument(
        "--use_extended_logging",
        action="store_true",
        help="Writes extensive log messages for the recording worker, that processes the audio chunks.",
    )

    parser.add_argument(
        "--compute_type",
        type=str,
        default="default",
        help="Type of computation to use. See https://opennmt.net/CTranslate2/quantization.html",
    )

    parser.add_argument(
        "--gpu_device_index",
        type=int,
        default=0,
        help="Index of the GPU device to use. Default is None.",
    )

    parser.add_argument(
        "--device",
        type=str,
        default="cuda",
        help='Device for model to use. Can either be "cuda" or "cpu". Default is cuda.',
    )

    parser.add_argument(
        "--handle_buffer_overflow",
        action="store_true",
        help="Handle buffer overflow during transcription. Default is False.",
    )

    parser.add_argument(
        "--suppress_tokens",
        type=int,
        default=[-1],
        nargs="*",
        help="Suppress tokens during transcription. Default is [-1].",
    )

    parser.add_argument(
        "--allowed_latency_limit",
        type=int,
        default=100,
        help=("Maximal amount of chunks that can be unprocessed in queue before discarding chunks. Default is 100."),
    )

    parser.add_argument(
        "--faster_whisper_vad_filter",
        action="store_true",
        help="Enable VAD filter for Faster Whisper. Default is False.",
    )

    parser.add_argument(
        "--logchunks",
        action="store_true",
        help="Enable logging of incoming audio chunks (periods)",
    )

    parser.add_argument(
        "--backend",
        type=str,
        default="",
        help='Transcriber backend override. Use "faster_whisper" or "onnx_asr". Default is auto-detect from model.',
    )

    parser.add_argument(
        "--onnx_quantization",
        type=str,
        default="",
        help="Quantization level for onnx-asr models (e.g. int8, fp16). Default is none.",
    )

    # Parse arguments
    args = parser.parse_args()

    # Apply persisted settings for args not explicitly provided on CLI
    persisted = load_persisted_settings()
    if not any(a in sys.argv for a in ("-m", "--model")) and "model" in persisted:
        args.model = persisted["model"]

    debug_logging = args.debug
    extended_logging = args.use_extended_logging
    writechunks = args.write
    log_incoming_chunks = args.logchunks
    silence_timing = args.silence_timing

    ws_logger = logging.getLogger("websockets")
    if args.debug_websockets:
        ws_logger.setLevel(logging.DEBUG)
        ws_logger.propagate = False
    else:
        ws_logger.setLevel(logging.WARNING)
        ws_logger.propagate = True

    # Replace escaped newlines with actual newlines in initial_prompt
    if args.initial_prompt:
        args.initial_prompt = args.initial_prompt.replace("\\n", "\n")

    if args.initial_prompt_realtime:
        args.initial_prompt_realtime = args.initial_prompt_realtime.replace("\\n", "\n")

    return args


def _recorder_thread(loop: asyncio.AbstractEventLoop) -> None:
    global recorder, stop_recorder
    print(f"{bcolors.OKGREEN}Initializing RealtimeSTT server with parameters:{bcolors.ENDC}")
    # Display parameters as a formatted table
    max_key_len = max(len(k) for k in recorder_config)
    separator = f"  {bcolors.OKBLUE}{'─' * (max_key_len + 2)}┬{'─' * 50}{bcolors.ENDC}"
    print(separator)
    for key, value in recorder_config.items():
        display_val = str(value)
        if callable(value):
            display_val = "<callback>"
        print(f"  {bcolors.OKBLUE}{key:<{max_key_len}}{bcolors.ENDC}  │ {display_val}")
    print(separator)
    try:
        recorder = AudioToTextRecorder(**recorder_config)
    except Exception as e:
        from src.recorder.infrastructure.whisper_transcriber import DownloadCancelledError

        if isinstance(e, DownloadCancelledError):
            global _download_state
            model_name = recorder_config.get("model", "unknown")
            print(f"{bcolors.WARNING}[download] cancelled: {model_name}{bcolors.ENDC}")
            message = json.dumps({
                "type": "model_download_complete",
                "model": model_name,
                "cancelled": True,
            })
            _download_state = None
            asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)
        raise
    print(f"{bcolors.OKGREEN}Models loaded, warming up CUDA kernels...{bcolors.ENDC}")
    recorder.warmup()
    print(f"{bcolors.OKGREEN}{bcolors.BOLD}RealtimeSTT initialized{bcolors.ENDC}")
    recorder_ready.set()

    # Broadcast server_ready to all connected control clients
    msg = json.dumps({"type": "server_ready"})
    for ws in list(control_connections):
        asyncio.run_coroutine_threadsafe(ws.send(msg), loop)

    def process_text(full_sentence: str) -> None:
        global prev_text
        prev_text = ""
        full_sentence = preprocess_text(full_sentence)
        message = json.dumps(
            {
                "type": "fullSentence",
                "text": full_sentence,
            }
        )
        # Use the passed event loop here
        asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)

        timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]

        if extended_logging:
            print(
                f"  [{timestamp}] Full text: {bcolors.BOLD}Sentence:{bcolors.ENDC} "
                f"{bcolors.OKGREEN}{full_sentence}{bcolors.ENDC}\n",
                flush=True,
                end="",
            )
        else:
            print(
                f"\r[{timestamp}] {bcolors.BOLD}Sentence:{bcolors.ENDC} "
                f"{bcolors.OKGREEN}{full_sentence}{bcolors.ENDC}\n",
            )

    try:
        assert recorder is not None
        while not stop_recorder:
            recorder.text(process_text)
    except KeyboardInterrupt:
        print(f"{bcolors.WARNING}Exiting application due to keyboard interrupt{bcolors.ENDC}")


def decode_and_resample(
    audio_data: bytes,
    original_sample_rate: int,
    target_sample_rate: int,
) -> bytes:
    # Decode 16-bit PCM data to numpy array
    if original_sample_rate == target_sample_rate:
        return audio_data

    audio_np = np.frombuffer(audio_data, dtype=np.int16)

    # Calculate the number of samples after resampling
    num_original_samples = len(audio_np)
    num_target_samples = int(num_original_samples * target_sample_rate / original_sample_rate)

    # Resample the audio
    resampled_audio = resample(audio_np, num_target_samples)

    result: bytes = resampled_audio.astype(np.int16).tobytes()
    return result


SUPPORTED_AUDIO_EXT = {".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".wma"}
SUPPORTED_VIDEO_EXT = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm"}
SUPPORTED_FILE_EXT = SUPPORTED_AUDIO_EXT | SUPPORTED_VIDEO_EXT


def _send_file_event(event: dict[str, Any], loop: asyncio.AbstractEventLoop) -> None:
    asyncio.run_coroutine_threadsafe(audio_queue.put(json.dumps(event)), loop)


def _format_srt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _format_srt(segments: list[Any]) -> str:
    lines: list[str] = []
    for i, seg in enumerate(segments, 1):
        start = _format_srt_time(seg.start)
        end = _format_srt_time(seg.end)
        lines.append(f"{i}")
        lines.append(f"{start} --> {end}")
        lines.append(seg.text.strip())
        lines.append("")
    return "\n".join(lines)


def _handle_transcribe_file(file_path: str, request_id: str, loop: asyncio.AbstractEventLoop, fmt: str = "txt") -> None:
    """Transcribe an audio/video file using the already-loaded Whisper model."""
    file_name = Path(file_path).name
    try:
        p = Path(file_path)
        if not p.exists():
            _send_file_event(
                {
                    "type": "file_transcription_error",
                    "request_id": request_id,
                    "file_path": file_path,
                    "error": "File not found",
                },
                loop,
            )
            return

        ext = p.suffix.lower()
        if ext not in SUPPORTED_FILE_EXT:
            _send_file_event(
                {
                    "type": "file_transcription_error",
                    "request_id": request_id,
                    "file_path": file_path,
                    "error": f"Unsupported format: {ext}",
                },
                loop,
            )
            return

        assert recorder is not None, "Recorder must be initialized"

        _send_file_event(
            {
                "type": "file_transcription_progress",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "progress": 0.1,
                "message": "Transcribing...",
            },
            loop,
        )

        # Access the transcriber's underlying WhisperModel (not BatchedInferencePipeline)
        transcriber = recorder._service._transcriber  # type: ignore[union-attr]
        model = transcriber._model  # type: ignore[union-attr]

        # BatchedInferencePipeline wraps the real model — unwrap it for file transcription
        import faster_whisper  # type: ignore[import-untyped]

        if isinstance(model, faster_whisper.BatchedInferencePipeline):
            model = model.model

        # vad_filter=False: Silero VAD filters out singing/music as non-speech.
        # For file transcription we want everything, so disable VAD and let
        # Whisper's own 30-second windowed decoding handle the full file.
        segments, _info = model.transcribe(
            file_path,
            language=recorder.language or None,
            beam_size=getattr(transcriber, "_beam_size", 5),
            initial_prompt=getattr(transcriber, "_initial_prompt", None),
            suppress_tokens=getattr(transcriber, "_suppress_tokens", [-1]),
            vad_filter=False,
        )
        seg_list = list(segments)

        text = _format_srt(seg_list) if fmt == "srt" else " ".join(seg.text for seg in seg_list).strip()

        _send_file_event(
            {
                "type": "file_transcription_progress",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "progress": 1.0,
                "message": "Complete",
            },
            loop,
        )

        _send_file_event(
            {
                "type": "file_transcription_complete",
                "request_id": request_id,
                "file_path": file_path,
                "file_name": file_name,
                "text": text,
                "format": fmt,
            },
            loop,
        )

        print(f"{bcolors.OKGREEN}File transcription complete: {file_name} ({len(text)} chars){bcolors.ENDC}")

    except Exception as e:
        _send_file_event(
            {
                "type": "file_transcription_error",
                "request_id": request_id,
                "file_path": file_path,
                "error": str(e),
            },
            loop,
        )
        print(f"{bcolors.FAIL}File transcription error: {e}{bcolors.ENDC}")


async def control_handler(websocket: ServerConnection) -> None:
    debug_print(f"New control connection from {websocket.remote_address}")
    print(f"{bcolors.OKGREEN}Control client connected{bcolors.ENDC}")
    global recorder
    control_connections.add(websocket)
    if recorder_ready.is_set():
        await websocket.send(json.dumps({"type": "server_ready"}))
    try:
        PRE_READY_COMMANDS = {"list_models"}

        async for message in websocket:
            msg_preview = message[:200] if isinstance(message, str) else message[:200].decode("utf-8", errors="replace")
            debug_print(f"Received control message: {msg_preview}...")
            if not recorder_ready.is_set():
                if isinstance(message, str):
                    try:
                        pre_data = json.loads(message)
                        if pre_data.get("command") not in PRE_READY_COMMANDS:
                            continue
                    except json.JSONDecodeError:
                        continue
                else:
                    continue
            if isinstance(message, str):
                # Handle text message (command)
                try:
                    command_data = json.loads(message)
                    command = command_data.get("command")
                    if command == "set_parameter":
                        parameter = command_data.get("parameter")
                        value = command_data.get("value")
                        if parameter == "silence_timing":
                            global silence_timing
                            silence_timing = bool(value)
                            timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                            print(
                                f"  [{timestamp}] {bcolors.OKGREEN}Set silence_timing "
                                f"to: {bcolors.OKBLUE}{silence_timing}{bcolors.ENDC}",
                            )
                            await websocket.send(
                                json.dumps(
                                    {
                                        "status": "success",
                                        "message": f"Parameter silence_timing set to {silence_timing}",
                                    }
                                )
                            )
                        elif parameter in allowed_parameters and hasattr(recorder, parameter):
                            setattr(recorder, parameter, value)
                            persist_setting(parameter, value)
                            # Format the value for output
                            value_formatted = f"{value:.2f}" if isinstance(value, float) else value
                            timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                            print(
                                f"  [{timestamp}] {bcolors.OKGREEN}Set recorder.{parameter} "
                                f"to: {bcolors.OKBLUE}{value_formatted}{bcolors.ENDC}",
                            )
                            # Optionally send a response back to the client
                            await websocket.send(
                                json.dumps(
                                    {
                                        "status": "success",
                                        "message": f"Parameter {parameter} set to {value}",
                                    }
                                )
                            )
                        else:
                            if parameter not in allowed_parameters:
                                print(
                                    f"{bcolors.WARNING}Parameter {parameter} is not allowed "
                                    f"(set_parameter){bcolors.ENDC}",
                                )
                                await websocket.send(
                                    json.dumps(
                                        {
                                            "status": "error",
                                            "message": f"Parameter {parameter} is not allowed (set_parameter)",
                                        }
                                    )
                                )
                            else:
                                print(
                                    f"{bcolors.WARNING}Parameter {parameter} does not exist "
                                    f"(set_parameter){bcolors.ENDC}",
                                )
                                await websocket.send(
                                    json.dumps(
                                        {
                                            "status": "error",
                                            "message": f"Parameter {parameter} does not exist (set_parameter)",
                                        }
                                    )
                                )

                    elif command == "get_parameter":
                        parameter = command_data.get("parameter")
                        request_id = command_data.get("request_id")
                        if parameter in allowed_parameters and hasattr(recorder, parameter):
                            value = getattr(recorder, parameter)
                            value_formatted = f"{value:.2f}" if isinstance(value, float) else f"{value}"

                            value_truncated = (
                                value_formatted[:39] + "\u2026" if len(value_formatted) > 40 else value_formatted
                            )

                            timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                            if extended_logging:
                                print(
                                    f"  [{timestamp}] {bcolors.OKGREEN}Get recorder.{parameter}: "
                                    f"{bcolors.OKBLUE}{value_truncated}{bcolors.ENDC}",
                                )
                            response: dict[str, Any] = {
                                "status": "success",
                                "parameter": parameter,
                                "value": value,
                            }
                            if request_id is not None:
                                response["request_id"] = request_id
                            await websocket.send(json.dumps(response))
                        else:
                            if parameter not in allowed_parameters:
                                print(
                                    f"{bcolors.WARNING}Parameter {parameter} is not allowed "
                                    f"(get_parameter){bcolors.ENDC}",
                                )
                                await websocket.send(
                                    json.dumps(
                                        {
                                            "status": "error",
                                            "message": f"Parameter {parameter} is not allowed (get_parameter)",
                                        }
                                    )
                                )
                            else:
                                print(
                                    f"{bcolors.WARNING}Parameter {parameter} does not exist "
                                    f"(get_parameter){bcolors.ENDC}",
                                )
                                await websocket.send(
                                    json.dumps(
                                        {
                                            "status": "error",
                                            "message": f"Parameter {parameter} does not exist (get_parameter)",
                                        }
                                    )
                                )
                    elif command == "call_method":
                        method_name = command_data.get("method")
                        if method_name in allowed_methods:
                            method = getattr(recorder, method_name, None)
                            if method and callable(method):
                                args = command_data.get("args", [])
                                kwargs = command_data.get("kwargs", {})
                                method(*args, **kwargs)
                                timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                                print(
                                    f"  [{timestamp}] {bcolors.OKGREEN}Called method "
                                    f"recorder.{bcolors.OKBLUE}{method_name}{bcolors.ENDC}",
                                )
                                await websocket.send(
                                    json.dumps(
                                        {
                                            "status": "success",
                                            "message": f"Method {method_name} called",
                                        }
                                    )
                                )
                            else:
                                print(
                                    f"{bcolors.WARNING}Recorder does not have method {method_name}{bcolors.ENDC}",
                                )
                                await websocket.send(
                                    json.dumps(
                                        {
                                            "status": "error",
                                            "message": f"Recorder does not have method {method_name}",
                                        }
                                    )
                                )
                        else:
                            print(f"{bcolors.WARNING}Method {method_name} is not allowed{bcolors.ENDC}")
                            await websocket.send(
                                json.dumps(
                                    {
                                        "status": "error",
                                        "message": f"Method {method_name} is not allowed",
                                    }
                                )
                            )
                    elif command == "transcribe_file":
                        request_id = command_data.get("request_id", "")
                        file_path = command_data.get("file_path", "")
                        fmt = command_data.get("format", "txt")
                        loop = asyncio.get_event_loop()
                        threading.Thread(
                            target=_handle_transcribe_file,
                            args=(file_path, request_id, loop, fmt),
                            daemon=True,
                        ).start()
                        await websocket.send(
                            json.dumps({"status": "success", "message": "File transcription started"})
                        )
                    elif command == "list_models":
                        from src.recorder.domain.model_registry import ModelCatalog

                        catalog = ModelCatalog()
                        await websocket.send(
                            json.dumps({
                                "status": "success",
                                "command": "list_models",
                                "models": catalog.to_dicts(),
                            })
                        )
                    elif command == "list_loopback_devices":
                        request_id = command_data.get("request_id")
                        try:
                            devices = loopback_capture.list_devices()
                            response_payload: dict[str, Any] = {
                                "status": "success",
                                "value": devices,
                            }
                            if request_id is not None:
                                response_payload["request_id"] = request_id
                            await websocket.send(json.dumps(response_payload))
                        except Exception as e:
                            error_payload: dict[str, Any] = {
                                "status": "error",
                                "message": f"Failed to list loopback devices: {e}",
                                "value": [],
                            }
                            if request_id is not None:
                                error_payload["request_id"] = request_id
                            await websocket.send(json.dumps(error_payload))
                    elif command == "start_loopback":
                        device_index = command_data.get("device_index")
                        if device_index is None or recorder is None:
                            await websocket.send(
                                json.dumps({"status": "error", "message": "Missing device_index or recorder not ready"})
                            )
                        else:
                            try:
                                dev_info = loopback_capture.start(recorder, int(device_index))
                                loop = asyncio.get_event_loop()
                                message = json.dumps({
                                    "type": "loopback_started",
                                    "deviceName": dev_info.get("name", ""),
                                })
                                asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)
                                print(
                                    f"{bcolors.OKGREEN}Loopback started: "
                                    f"{dev_info.get('name', '')} @ {dev_info.get('defaultSampleRate', 0)}Hz"
                                    f"{bcolors.ENDC}",
                                )
                                await websocket.send(
                                    json.dumps({"status": "success", "message": "Loopback started"})
                                )
                            except Exception as e:
                                await websocket.send(
                                    json.dumps({"status": "error", "message": f"Failed to start loopback: {e}"})
                                )
                    elif command == "stop_loopback":
                        if recorder is not None and loopback_capture.is_active:
                            loopback_capture.stop(recorder)
                            loop = asyncio.get_event_loop()
                            message = json.dumps({"type": "loopback_stopped"})
                            asyncio.run_coroutine_threadsafe(audio_queue.put(message), loop)
                            print(f"{bcolors.OKGREEN}Loopback stopped{bcolors.ENDC}")
                        await websocket.send(
                            json.dumps({"status": "success", "message": "Loopback stopped"})
                        )
                    elif command == "cancel_download":
                        global _cancel_download_requested
                        _cancel_download_requested = True
                        print(f"{bcolors.WARNING}[download] cancel requested by client{bcolors.ENDC}")
                        await websocket.send(
                            json.dumps({"status": "success", "message": "Download cancel requested"})
                        )
                    else:
                        print(f"{bcolors.WARNING}Unknown command: {command}{bcolors.ENDC}")
                        await websocket.send(
                            json.dumps(
                                {
                                    "status": "error",
                                    "message": f"Unknown command {command}",
                                }
                            )
                        )
                except json.JSONDecodeError:
                    print(f"{bcolors.WARNING}Received invalid JSON command{bcolors.ENDC}")
                    await websocket.send(
                        json.dumps(
                            {
                                "status": "error",
                                "message": "Invalid JSON command",
                            }
                        )
                    )
            else:
                print(f"{bcolors.WARNING}Received unknown message type on control connection{bcolors.ENDC}")
    except websockets.exceptions.ConnectionClosed as e:
        print(f"{bcolors.WARNING}Control client disconnected: {e}{bcolors.ENDC}")
    finally:
        control_connections.remove(websocket)


async def data_handler(websocket: ServerConnection) -> None:
    global writechunks, wav_file
    print(f"{bcolors.OKGREEN}Data client connected{bcolors.ENDC}")
    data_connections.add(websocket)

    # Replay current download state so clients that connect mid-download see the progress bar.
    if _download_state is not None:
        try:
            await websocket.send(_download_state)
        except websockets.exceptions.ConnectionClosed:
            data_connections.discard(websocket)
            return

    try:
        while True:
            message = await websocket.recv()
            if not recorder_ready.is_set():
                continue  # Ignore incoming audio during model download / init
            if isinstance(message, bytes):
                if extended_logging:
                    debug_print(f"Received audio chunk (size: {len(message)} bytes)")
                elif log_incoming_chunks:
                    print(".", end="", flush=True)
                # Handle binary message (audio data)
                metadata_length = int.from_bytes(message[:4], byteorder="little")
                metadata_json = message[4 : 4 + metadata_length].decode("utf-8")
                metadata = json.loads(metadata_json)
                sample_rate = metadata["sampleRate"]

                if "server_sent_to_stt" in metadata:
                    stt_received_ns = time.time_ns()
                    metadata["stt_received"] = stt_received_ns
                    metadata["stt_received_formatted"] = format_timestamp_ns(stt_received_ns)
                    print(
                        f"Server received audio chunk of length {len(message)} bytes, metadata: {metadata}",
                    )

                if extended_logging:
                    debug_print(f"Processing audio chunk with sample rate {sample_rate}")
                chunk = message[4 + metadata_length :]

                if writechunks and isinstance(writechunks, str):
                    if not wav_file:
                        wav_file = wave.open(writechunks, "wb")  # noqa: SIM115
                        wav_file.setnchannels(CHANNELS)
                        wav_file.setsampwidth(pyaudio.get_sample_size(FORMAT))
                        wav_file.setframerate(sample_rate)

                    wav_file.writeframes(chunk)

                assert recorder is not None
                if sample_rate != 16000:
                    resampled_chunk = decode_and_resample(chunk, sample_rate, 16000)
                    if extended_logging:
                        debug_print(f"Resampled chunk size: {len(resampled_chunk)} bytes")
                    recorder.feed_audio(resampled_chunk)
                else:
                    recorder.feed_audio(chunk)
            else:
                print(f"{bcolors.WARNING}Received non-binary message on data connection{bcolors.ENDC}")
    except websockets.exceptions.ConnectionClosed as e:
        print(f"{bcolors.WARNING}Data client disconnected: {e}{bcolors.ENDC}")
    finally:
        data_connections.remove(websocket)
        if recorder is not None:
            recorder.clear_audio_queue()


async def broadcast_audio_messages() -> None:
    while True:
        message = await audio_queue.get()
        for conn in list(data_connections):
            try:
                timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]

                if extended_logging:
                    print(
                        f"  [{timestamp}] Sending message: {bcolors.OKBLUE}{message}{bcolors.ENDC}\n",
                        flush=True,
                        end="",
                    )
                await conn.send(message)
            except websockets.exceptions.ConnectionClosed:
                data_connections.remove(conn)


# Helper function to create event loop bound closures for callbacks
def make_callback(
    loop: asyncio.AbstractEventLoop,
    callback: Callable[..., None],
) -> Callable[..., None]:
    def inner_callback(*args: object, **kwargs: object) -> None:
        callback(*args, **kwargs, loop=loop)

    return inner_callback


async def main_async() -> None:
    global stop_recorder, recorder_config, global_args
    args = parse_arguments()
    global_args = args

    # Get the event loop here and pass it to the recorder thread
    loop = asyncio.get_event_loop()

    recorder_config = {
        "model": args.model,
        "download_root": args.root,
        "realtime_model_type": args.rt_model,
        "language": args.lang,
        "batch_size": args.batch,
        "init_realtime_after_seconds": args.init_realtime_after_seconds,
        "realtime_batch_size": args.realtime_batch_size,
        "initial_prompt_realtime": args.initial_prompt_realtime,
        "input_device_index": args.input_device,
        "silero_sensitivity": args.silero_sensitivity,
        "silero_use_onnx": args.silero_use_onnx,
        "webrtc_sensitivity": args.webrtc_sensitivity,
        "post_speech_silence_duration": args.unknown_sentence_detection_pause,
        "min_length_of_recording": args.min_length_of_recording,
        "min_gap_between_recordings": args.min_gap_between_recordings,
        "enable_realtime_transcription": args.enable_realtime_transcription,
        "realtime_processing_pause": args.realtime_processing_pause,
        "silero_deactivity_detection": args.silero_deactivity_detection,
        "early_transcription_on_silence": args.early_transcription_on_silence,
        "beam_size": args.beam_size,
        "beam_size_realtime": args.beam_size_realtime,
        "initial_prompt": args.initial_prompt,
        "wake_words": args.wake_words,
        "wake_words_sensitivity": args.wake_words_sensitivity,
        "wake_word_timeout": args.wake_word_timeout,
        "wake_word_activation_delay": args.wake_word_activation_delay,
        "wakeword_backend": args.wakeword_backend,
        "openwakeword_model_paths": args.openwakeword_model_paths,
        "openwakeword_inference_framework": args.openwakeword_inference_framework,
        "wake_word_buffer_duration": args.wake_word_buffer_duration,
        "use_main_model_for_realtime": args.use_main_model_for_realtime,
        "spinner": False,
        "use_microphone": True,
        "on_realtime_transcription_update": make_callback(loop, text_detected),
        "on_recording_start": make_callback(loop, on_recording_start),
        "on_recording_stop": make_callback(loop, on_recording_stop),
        "on_vad_detect_start": make_callback(loop, on_vad_detect_start),
        "on_vad_detect_stop": make_callback(loop, on_vad_detect_stop),
        "on_wakeword_detected": make_callback(loop, on_wakeword_detected),
        "on_wakeword_detection_start": make_callback(loop, on_wakeword_detection_start),
        "on_wakeword_detection_end": make_callback(loop, on_wakeword_detection_end),
        "on_transcription_start": make_callback(loop, on_transcription_start),
        "on_audio_level": make_callback(loop, on_audio_level),
        "on_turn_detection_start": make_callback(loop, on_turn_detection_start),
        "on_turn_detection_stop": make_callback(loop, on_turn_detection_stop),
        "on_model_download_start": make_callback(loop, on_model_download_start),
        "on_model_download_progress": make_callback(loop, on_model_download_progress),
        "on_model_download_complete": make_callback(loop, on_model_download_complete),
        "cancel_download_check": lambda: _cancel_download_requested,
        # "on_recorded_chunk": make_callback(loop, on_recorded_chunk),
        "no_log_file": True,
        "use_extended_logging": args.use_extended_logging,
        "level": loglevel,
        "compute_type": args.compute_type,
        "gpu_device_index": args.gpu_device_index,
        "device": args.device,
        "handle_buffer_overflow": args.handle_buffer_overflow,
        "suppress_tokens": args.suppress_tokens,
        "allowed_latency_limit": args.allowed_latency_limit,
        "faster_whisper_vad_filter": args.faster_whisper_vad_filter,
        "backend": args.backend,
        "onnx_quantization": args.onnx_quantization,
    }

    try:
        # Attempt to start control and data servers
        control_server = await websockets.serve(control_handler, "localhost", args.control)
        data_server = await websockets.serve(data_handler, "localhost", args.data)
        print(
            f"{bcolors.OKGREEN}Control server started on {bcolors.OKBLUE}ws://localhost:{args.control}{bcolors.ENDC}",
        )
        print(
            f"{bcolors.OKGREEN}Data server started on {bcolors.OKBLUE}ws://localhost:{args.data}{bcolors.ENDC}",
        )

        # Set up shutdown signal handler BEFORE model loading so Ctrl+C
        # works during initialization (model download, CUDA warmup, etc.)
        global shutdown_event
        shutdown_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        _shutdown_count = 0

        def _request_shutdown() -> None:
            nonlocal _shutdown_count
            _shutdown_count += 1
            if _shutdown_count >= 2:
                # Second Ctrl+C: force-exit immediately
                print(f"\n{bcolors.FAIL}Force exit.{bcolors.ENDC}")
                os._exit(1)
            assert shutdown_event is not None
            shutdown_event.set()

        if sys.platform == "win32":
            def _win_signal_handler(_sig: int, _frame: object) -> None:
                """Handle Ctrl+C on Windows.

                Signal handlers fire between Python bytecodes but CANNOT
                wake the SelectorEventLoop's select() call.  We must do
                the critical work (abort recorder, set flags) directly
                here so the recorder thread unblocks immediately.
                """
                global stop_recorder
                stop_recorder = True
                if recorder is not None:
                    recorder.abort()
                _request_shutdown()

            signal.signal(signal.SIGINT, _win_signal_handler)
        else:
            loop.add_signal_handler(signal.SIGINT, _request_shutdown)
            loop.add_signal_handler(signal.SIGTERM, _request_shutdown)

        # Start the broadcast and recorder threads
        broadcast_task = asyncio.create_task(broadcast_audio_messages())

        recorder_thread = threading.Thread(target=_recorder_thread, args=(loop,), daemon=True)
        recorder_thread.start()
        await loop.run_in_executor(None, recorder_ready.wait)

        print(f"{bcolors.OKGREEN}Server started. Press Ctrl+C to stop the server.{bcolors.ENDC}")

        # Poll with short sleeps so the event loop regularly returns to
        # Python bytecode, allowing Windows signal handlers to fire.
        # (On Windows, SelectorEventLoop.select() blocks in C code and
        # defers signal delivery until control returns to Python.)
        while not shutdown_event.is_set():
            await asyncio.sleep(0.5)

        print(f"\n{bcolors.WARNING}Server interrupted by user, shutting down...{bcolors.ENDC}")

        # Close WebSocket servers so clients disconnect
        control_server.close()
        data_server.close()
        broadcast_task.cancel()
        await asyncio.wait_for(control_server.wait_closed(), timeout=2)
        await asyncio.wait_for(data_server.wait_closed(), timeout=2)
    except TimeoutError:
        pass  # WebSocket servers slow to close — proceed to shutdown
    except OSError:
        print(
            f"{bcolors.FAIL}Error: Could not start server on specified ports. "
            f"It's possible another instance of the server is already running, "
            f"or the ports are being used by another application.{bcolors.ENDC}",
        )
    finally:
        # Shutdown procedures for recorder and server threads
        await shutdown_procedure()
        print(f"{bcolors.OKGREEN}Server shutdown complete.{bcolors.ENDC}")


async def shutdown_procedure() -> None:
    global stop_recorder, recorder_thread

    # Hard deadline: if graceful shutdown takes too long, force-exit.
    def _watchdog() -> None:
        time.sleep(8)
        print(f"{bcolors.FAIL}Shutdown deadline exceeded, forcing exit.{bcolors.ENDC}")
        os._exit(1)

    wd = threading.Thread(target=_watchdog, daemon=True)
    wd.start()

    if recorder and loopback_capture.is_active:
        loopback_capture.stop(recorder)
    if recorder:
        stop_recorder = True
        recorder.abort()  # Unblocks wait_audio() immediately via queue sentinel

        if recorder_thread:
            recorder_thread.join(timeout=2)

        recorder.shutdown()
        print(f"{bcolors.OKGREEN}Recorder shut down{bcolors.ENDC}")

    tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def _clear_pycache() -> None:
    """Remove all __pycache__ directories under src/ so stale .pyc files never mask source changes."""
    import shutil

    src_root = Path(__file__).resolve().parent.parent  # src/
    for cache_dir in src_root.rglob("__pycache__"):
        shutil.rmtree(cache_dir, ignore_errors=True)


def main() -> None:
    _clear_pycache()
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        # Capture any residual KeyboardInterrupt (e.g. during startup before signal handler is installed)
        print(f"\n{bcolors.WARNING}Server interrupted by user.{bcolors.ENDC}")
    except SystemExit:
        pass
    finally:
        # Force-exit to avoid segfaults during Python interpreter shutdown.
        # CUDA/PyTorch native objects get garbage-collected in undefined order
        # during normal interpreter teardown, causing segfaults when torch
        # tensors reference already-freed CUDA memory.  All graceful cleanup
        # (thread joins, model unloading, torch.cuda.empty_cache) has already
        # completed in shutdown_procedure(), so os._exit() is safe here.
        os._exit(0)


if __name__ == "__main__":
    main()
