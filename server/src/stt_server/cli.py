"""CLI argument parsing and settings persistence for the STT server."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

# ─── Data root resolution (portable-aware) ─────────────────────────────
# WinSTT's Electron main process forwards the active user-data directory
# via the ``--data-dir`` CLI flag (and also as the ``WINSTT_DATA_DIR``
# environment variable — covers raw ``stt-server`` launches from a
# portable tree where the flag may be missing).
#
# When set, that path is the root for every server-side artifact that
# would otherwise default to ``~/.winstt`` / a platform cache:
#   - ``server-settings.json`` (persisted model choice)
#   - rotating log file (when ``--log-dir`` itself is missing)
#   - recordings (if ever written from server side; client-side WAVs
#     come from the Electron main process)
#
# We resolve it ONCE at module import (before the argparse defaults run)
# so every helper in this module sees the same root. CLI ``--data-dir``
# overrides the env var when both are present.


def _resolve_data_dir(argv: list[str]) -> Path | None:
    """Pick the active user-data directory, honoring CLI > env > None.

    Looks for ``--data-dir <path>`` / ``--data-dir=<path>`` /
    ``--data_dir`` in ``argv`` so the value is available BEFORE the main
    parser runs (the persistence helpers below need it at module load).
    Falls back to ``$WINSTT_DATA_DIR``. Returns ``None`` when neither is
    present — callers then keep the historic ``~/.winstt`` default.
    """
    flags = ("--data-dir", "--data_dir")
    for i, tok in enumerate(argv):
        if tok in flags and i + 1 < len(argv):
            return Path(argv[i + 1]).expanduser()
        for flag in flags:
            prefix = f"{flag}="
            if tok.startswith(prefix):
                return Path(tok[len(prefix) :]).expanduser()
    env_value = os.environ.get("WINSTT_DATA_DIR")
    if env_value:
        return Path(env_value).expanduser()
    return None


def _settings_dir() -> Path:
    """Resolve the directory that holds ``server-settings.json``.

    Honors the portable / Electron-supplied data dir when set, otherwise
    falls back to the historic ``~/.winstt`` location so non-Electron
    launches (CI, manual ``stt-server`` runs) keep working unchanged.
    """
    data_dir = _resolve_data_dir(sys.argv[1:])
    return data_dir if data_dir is not None else Path.home() / ".winstt"


def get_settings_file() -> Path:
    """Path of the persisted ``server-settings.json`` (portable-aware)."""
    return _settings_dir() / "server-settings.json"


# Back-compat module-level constants. Several tests + downstream callers
# still reference ``SETTINGS_DIR`` / ``SETTINGS_FILE`` directly; keep them
# pointing at the resolved values so non-portable launches behave exactly
# as before. The portable-aware accessors above are the new canonical
# entry points.
SETTINGS_DIR = _settings_dir()
SETTINGS_FILE = SETTINGS_DIR / "server-settings.json"
PERSISTED_PARAMETERS: set[str] = {"model"}


def load_persisted_settings() -> dict[str, Any]:
    settings_file = get_settings_file()
    if not settings_file.exists():
        return {}
    try:
        data: dict[str, Any] = json.loads(settings_file.read_text(encoding="utf-8"))
        return data
    except (json.JSONDecodeError, OSError):
        return {}


def persist_setting(key: str, value: object) -> None:
    if key not in PERSISTED_PARAMETERS:
        return
    settings = load_persisted_settings()
    settings[key] = value
    settings_file = get_settings_file()
    try:
        settings_file.parent.mkdir(parents=True, exist_ok=True)
        settings_file.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    except OSError:
        pass


def parse_arguments() -> argparse.Namespace:
    """Parse CLI arguments and apply persisted settings."""
    parser = argparse.ArgumentParser(
        description="Start the Speech-to-Text (STT) server with various configuration options.",
    )

    parser.add_argument(
        "-m",
        "--model",
        type=str,
        default="large-v3-turbo",
        help=(
            "STT model id from the catalog (e.g. tiny, base, small, medium, large-v3, "
            "large-v3-turbo, lite-whisper-large-v3-turbo, nemo-canary-1b-v2) or any "
            "onnx-asr-resolvable HuggingFace ONNX repo (e.g. onnx-community/whisper-base). "
            "Default is large-v3-turbo."
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
        # Empty default = auto-detect — matches the rest of the codebase
        # (OnnxAsrTranscriber treats falsy language as None → Whisper picks
        # the language from the audio itself). The Electron frontend stores
        # the "Auto-detect" picker option as "" and skips passing --lang
        # when empty, so a non-empty default here would silently override
        # the user's explicit auto-detect choice.
        default="",
        help=(
            "Language code for the STT model to transcribe in a specific language. "
            "Leave this empty (the default) for auto-detection based on input audio. "
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
        help="Enable ONNX version of Silero model for faster performance with lower resource usage. Default is False.",
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
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Enable continuous real-time transcription of audio as it is received. "
            "Enabled by default. Use --no-enable_realtime_transcription to disable."
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
        default=1.3,
        help=(
            "The duration of pause (in seconds) tolerated after speech with no clear "
            "terminator before the recording ends. This is the fallback bucket for "
            "normal mid-sentence speech (live text rarely ends in punctuation), so it "
            "governs how long a natural breath/think pause can be without cutting the "
            "speaker off. Default is 1.3 seconds (0.7 cut off thinkers mid-sentence)."
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
        "--enable_diarization",
        action="store_true",
        default=False,
        help=(
            "Run per-utterance speaker diarization (pyannote-segmentation-3.0 + "
            "wespeaker-resnet34-LM via onnx-asr) and emit speaker_segments events. "
            "Downloads ~32 MB of ONNX models on first use. Off by default."
        ),
    )

    parser.add_argument(
        "--diarization_max_speakers",
        type=int,
        default=8,
        help="Max simultaneous global speakers tracked across a session. Default 8.",
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
        help="Maximal amount of chunks that can be unprocessed in queue before discarding chunks. Default is 100.",
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

    parser.add_argument(
        "--smart_endpoint",
        action="store_true",
        default=False,
        help=(
            "Enable DistilBERT-based sentence completion detection for smarter "
            "silence duration. Requires the transformers library. Default is False."
        ),
    )

    parser.add_argument(
        "--detection_speed",
        type=float,
        default=2.0,
        help=(
            "Smart-endpoint pause multiplier: pause = (model_pause + "
            "whisper_pause) * detection_speed. HIGHER values mean a LONGER "
            "wait before finalizing (more patient — tolerates pauses); "
            "lower values commit faster. Default is 2.0 (matches the "
            "RealtimeSTT reference)."
        ),
    )

    parser.add_argument(
        "--log-dir",
        "--log_dir",
        type=str,
        default=None,
        help=(
            "Directory to write the rotating server log file (stt-server.log) into. "
            "Falls back to the WINSTT_LOG_DIR environment variable. When neither is "
            "set, the server logs only to stdout. The directory is created if missing."
        ),
    )

    parser.add_argument(
        "--data-dir",
        "--data_dir",
        type=str,
        default=None,
        help=(
            "Root directory for server-side user data (model cache base, persisted "
            "settings file, recordings if ever server-written). The Electron frontend "
            "passes this so portable installs (a `portable` marker file alongside the "
            "executable) keep everything under `Data/` next to the exe instead of in "
            "`~/.winstt` / platform caches. Falls back to the WINSTT_DATA_DIR env var. "
            "When neither is set, the historic `~/.winstt` location is used."
        ),
    )

    # ─── TTS ────────────────────────────────────────────────────────────
    parser.add_argument(
        "--tts-voice",
        "--tts_voice",
        type=str,
        default="af_heart",
        help="Default Kokoro voice ID (e.g. af_heart, af_nicole, am_michael).",
    )
    parser.add_argument(
        "--tts-lang",
        "--tts_lang",
        type=str,
        default="en-us",
        help="Default Kokoro language code (en-us, en-gb, ja, cmn, es, fr, hi, it, pt-br).",
    )
    parser.add_argument(
        "--tts-speed",
        "--tts_speed",
        type=float,
        default=1.0,
        help="Default playback speed multiplier (0.5..2.0).",
    )
    parser.add_argument(
        "--tts-device",
        "--tts_device",
        type=str,
        default="auto",
        help="TTS execution device: auto (default), cuda, cpu. 'auto' falls back to cpu when CUDA isn't viable.",
    )
    parser.add_argument(
        "--tts-cache-dir",
        "--tts_cache_dir",
        type=str,
        default=None,
        help=(
            "Override the directory where Kokoro model + voicepacks are cached. "
            "Defaults to %%LOCALAPPDATA%%/winstt/tts/kokoro."
        ),
    )

    # Parse arguments
    args = parser.parse_args()

    # Apply persisted settings for args not explicitly provided on CLI
    persisted = load_persisted_settings()
    if not any(a in sys.argv for a in ("-m", "--model")) and "model" in persisted:
        args.model = persisted["model"]

    # Configure websocket logging
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
