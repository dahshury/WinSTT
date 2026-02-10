"""WebSocket client for remote AudioToTextRecorder server."""

from __future__ import annotations

import base64
import json
import logging
import os
import platform
import struct
import subprocess
import sys
import threading
import time
import wave
from collections.abc import Callable, Iterable
from types import TracebackType
from typing import Any, ClassVar
from urllib.parse import urlparse

import numpy as np
from numpy.typing import NDArray
from websocket import ABNF, WebSocketApp

from src.building_blocks.terminal import format_timestamp_ns as _format_timestamp_ns
from src.building_blocks.types import ChunkCallback, SimpleCallback, TextCallback

# Client-specific callback: receives the normalized audio float32 array
TranscriptionStartCallback = Callable[[NDArray[np.float32]], None]

log_outgoing_chunks = False

DEFAULT_CONTROL_URL = "ws://127.0.0.1:8011"
DEFAULT_DATA_URL = "ws://127.0.0.1:8012"

INIT_MODEL_TRANSCRIPTION = "tiny"
INIT_MODEL_TRANSCRIPTION_REALTIME = "tiny"
INIT_REALTIME_PROCESSING_PAUSE = 0.2
INIT_REALTIME_INITIAL_PAUSE = 0.2
INIT_SILERO_SENSITIVITY = 0.4
INIT_WEBRTC_SENSITIVITY = 3
INIT_POST_SPEECH_SILENCE_DURATION = 0.6
INIT_MIN_LENGTH_OF_RECORDING = 0.5
INIT_MIN_GAP_BETWEEN_RECORDINGS = 0
INIT_WAKE_WORDS_SENSITIVITY = 0.6
INIT_PRE_RECORDING_BUFFER_DURATION = 1.0
INIT_WAKE_WORD_ACTIVATION_DELAY = 0.0
INIT_WAKE_WORD_TIMEOUT = 5.0
INIT_WAKE_WORD_BUFFER_DURATION = 0.1
ALLOWED_LATENCY_LIMIT = 100

BUFFER_SIZE = 512
SAMPLE_RATE = 16000

INIT_HANDLE_BUFFER_OVERFLOW = platform.system() != "Darwin"


def _get_audio_input_class() -> type[Any]:
    """Lazy-import AudioInput. Raises NotImplementedError if unavailable."""
    try:
        from src.recorder.infrastructure.audio_input import AudioInput  # type: ignore[import-untyped]

        return AudioInput  # type: ignore[no-any-return]
    except ImportError as exc:
        raise NotImplementedError(
            "AudioInput is not available in this build. "
            "Microphone recording from the client is not yet supported. "
            "Use feed_audio() to supply audio data instead."
        ) from exc


class AudioToTextRecorderClient:
    """WebSocket client that connects to a remote STT server.

    Mirrors the interface of AudioToTextRecorder but delegates
    transcription to a WebSocket server instead of running models locally.
    """

    def __init__(
        self,
        model: str = INIT_MODEL_TRANSCRIPTION,
        download_root: str | None = None,
        language: str = "",
        compute_type: str = "default",
        input_device_index: int | None = None,
        gpu_device_index: int | list[int] = 0,
        device: str = "cuda",
        on_recording_start: SimpleCallback | None = None,
        on_recording_stop: SimpleCallback | None = None,
        on_transcription_start: TranscriptionStartCallback | None = None,
        ensure_sentence_starting_uppercase: bool = True,
        ensure_sentence_ends_with_period: bool = True,
        use_microphone: bool = True,
        spinner: bool = True,
        level: int = logging.WARNING,
        batch_size: int = 16,
        # Realtime transcription parameters
        enable_realtime_transcription: bool = False,
        use_main_model_for_realtime: bool = False,
        realtime_model_type: str = INIT_MODEL_TRANSCRIPTION_REALTIME,
        realtime_processing_pause: float = INIT_REALTIME_PROCESSING_PAUSE,
        init_realtime_after_seconds: float = INIT_REALTIME_INITIAL_PAUSE,
        on_realtime_transcription_update: TextCallback | None = None,
        on_realtime_transcription_stabilized: TextCallback | None = None,
        realtime_batch_size: int = 16,
        # Voice activation parameters
        silero_sensitivity: float = INIT_SILERO_SENSITIVITY,
        silero_use_onnx: bool = False,
        silero_deactivity_detection: bool = False,
        webrtc_sensitivity: int = INIT_WEBRTC_SENSITIVITY,
        post_speech_silence_duration: float = INIT_POST_SPEECH_SILENCE_DURATION,
        min_length_of_recording: float = INIT_MIN_LENGTH_OF_RECORDING,
        min_gap_between_recordings: float = INIT_MIN_GAP_BETWEEN_RECORDINGS,
        pre_recording_buffer_duration: float = INIT_PRE_RECORDING_BUFFER_DURATION,
        on_vad_start: SimpleCallback | None = None,
        on_vad_stop: SimpleCallback | None = None,
        on_vad_detect_start: SimpleCallback | None = None,
        on_vad_detect_stop: SimpleCallback | None = None,
        on_turn_detection_start: SimpleCallback | None = None,
        on_turn_detection_stop: SimpleCallback | None = None,
        # Wake word parameters
        wakeword_backend: str = "pvporcupine",
        openwakeword_model_paths: str | None = None,
        openwakeword_inference_framework: str = "onnx",
        wake_words: str = "",
        wake_words_sensitivity: float = INIT_WAKE_WORDS_SENSITIVITY,
        wake_word_activation_delay: float = INIT_WAKE_WORD_ACTIVATION_DELAY,
        wake_word_timeout: float = INIT_WAKE_WORD_TIMEOUT,
        wake_word_buffer_duration: float = INIT_WAKE_WORD_BUFFER_DURATION,
        on_wakeword_detected: SimpleCallback | None = None,
        on_wakeword_timeout: SimpleCallback | None = None,
        on_wakeword_detection_start: SimpleCallback | None = None,
        on_wakeword_detection_end: SimpleCallback | None = None,
        on_recorded_chunk: ChunkCallback | None = None,
        debug_mode: bool = False,
        handle_buffer_overflow: bool = INIT_HANDLE_BUFFER_OVERFLOW,
        beam_size: int = 5,
        beam_size_realtime: int = 3,
        buffer_size: int = BUFFER_SIZE,
        sample_rate: int = SAMPLE_RATE,
        initial_prompt: str | Iterable[int] | None = None,
        initial_prompt_realtime: str | Iterable[int] | None = None,
        suppress_tokens: list[int] | None = None,
        print_transcription_time: bool = False,
        early_transcription_on_silence: float = 0,
        allowed_latency_limit: int = ALLOWED_LATENCY_LIMIT,
        no_log_file: bool = False,
        use_extended_logging: bool = False,
        # Server urls
        control_url: str = DEFAULT_CONTROL_URL,
        data_url: str = DEFAULT_DATA_URL,
        autostart_server: bool = True,
        output_wav_file: str | None = None,
        faster_whisper_vad_filter: bool = False,
    ) -> None:
        if suppress_tokens is None:
            suppress_tokens = [-1]

        # Set instance variables from constructor parameters
        self.model = model
        self.language = language
        self.compute_type = compute_type
        self.input_device_index = input_device_index
        self.gpu_device_index = gpu_device_index
        self.device = device
        self.on_recording_start = on_recording_start
        self.on_recording_stop = on_recording_stop
        self.on_transcription_start = on_transcription_start
        self.ensure_sentence_starting_uppercase = ensure_sentence_starting_uppercase
        self.ensure_sentence_ends_with_period = ensure_sentence_ends_with_period
        self.use_microphone = use_microphone
        self.spinner = spinner
        self.level = level
        self.batch_size = batch_size
        self.init_realtime_after_seconds = init_realtime_after_seconds
        self.realtime_batch_size = realtime_batch_size

        # Real-time transcription parameters
        self.enable_realtime_transcription = enable_realtime_transcription
        self.use_main_model_for_realtime = use_main_model_for_realtime
        self.download_root = download_root
        self.realtime_model_type = realtime_model_type
        self.realtime_processing_pause = realtime_processing_pause
        self.on_realtime_transcription_update = on_realtime_transcription_update
        self.on_realtime_transcription_stabilized = on_realtime_transcription_stabilized

        # Voice activation parameters
        self.silero_sensitivity = silero_sensitivity
        self.silero_use_onnx = silero_use_onnx
        self.silero_deactivity_detection = silero_deactivity_detection
        self.webrtc_sensitivity = webrtc_sensitivity
        self.post_speech_silence_duration = post_speech_silence_duration
        self.min_length_of_recording = min_length_of_recording
        self.min_gap_between_recordings = min_gap_between_recordings
        self.pre_recording_buffer_duration = pre_recording_buffer_duration

        self.on_vad_start = on_vad_start
        self.on_vad_stop = on_vad_stop
        self.on_vad_detect_start = on_vad_detect_start
        self.on_vad_detect_stop = on_vad_detect_stop
        self.on_turn_detection_start = on_turn_detection_start
        self.on_turn_detection_stop = on_turn_detection_stop

        # Wake word parameters
        self.wakeword_backend = wakeword_backend
        self.openwakeword_model_paths = openwakeword_model_paths
        self.openwakeword_inference_framework = openwakeword_inference_framework
        self.wake_words = wake_words
        self.wake_words_sensitivity = wake_words_sensitivity
        self.wake_word_activation_delay = wake_word_activation_delay
        self.wake_word_timeout = wake_word_timeout
        self.wake_word_buffer_duration = wake_word_buffer_duration
        self.on_wakeword_detected = on_wakeword_detected
        self.on_wakeword_timeout = on_wakeword_timeout
        self.on_wakeword_detection_start = on_wakeword_detection_start
        self.on_wakeword_detection_end = on_wakeword_detection_end
        self.on_recorded_chunk = on_recorded_chunk
        self.debug_mode = debug_mode
        self.handle_buffer_overflow = handle_buffer_overflow
        self.beam_size = beam_size
        self.beam_size_realtime = beam_size_realtime
        self.buffer_size = buffer_size
        self.sample_rate = sample_rate
        self.initial_prompt = initial_prompt
        self.initial_prompt_realtime = initial_prompt_realtime
        self.suppress_tokens = suppress_tokens
        self.print_transcription_time = print_transcription_time
        self.early_transcription_on_silence = early_transcription_on_silence
        self.allowed_latency_limit = allowed_latency_limit
        self.no_log_file = no_log_file
        self.use_extended_logging = use_extended_logging
        self.faster_whisper_vad_filter = faster_whisper_vad_filter

        # Server URLs
        self.control_url = control_url
        self.data_url = data_url
        self.autostart_server = autostart_server
        self.output_wav_file = output_wav_file

        # Instance variables
        self.muted = False
        self.recording_thread: threading.Thread | None = None
        self.is_running = True
        self.connection_established = threading.Event()
        self.recording_start = threading.Event()
        self.final_text_ready = threading.Event()
        self.realtime_text = ""
        self.final_text = ""
        self._recording = False
        self.server_already_running = False
        self.wav_file: wave.Wave_write | None = None

        self.control_ws: WebSocketApp | None = None
        self.data_ws: WebSocketApp | None = None
        self.control_ws_thread: threading.Thread | None = None
        self.data_ws_thread: threading.Thread | None = None

        self.request_counter = 0
        self.pending_requests: dict[int, dict[str, Any]] = {}

        if self.debug_mode:
            print("Checking STT server")
        if not self.connect():
            print("Failed to connect to the server.", file=sys.stderr)
        else:
            if self.debug_mode:
                print("STT server is running and connected.")

        if self.use_microphone:
            self.start_recording()

        if self.server_already_running:
            if not self.connection_established.wait(timeout=10):
                print("Server connection not established within 10 seconds.")
            else:
                self.set_parameter("language", self.language)
                print(f"Language set to {self.language}")
                self.set_parameter("wake_word_activation_delay", self.wake_word_activation_delay)
                print(f"Wake word activation delay set to {self.wake_word_activation_delay}")

    def text(self, on_transcription_finished: TextCallback | None = None) -> str:
        """Wait for and return the next transcribed text."""
        self.realtime_text = ""
        self.submitted_realtime_text = ""
        self.final_text = ""
        self.final_text_ready.clear()

        self.recording_start.set()

        try:
            total_wait_time = 0.0
            wait_interval = 0.02
            max_wait_time = 60

            while total_wait_time < max_wait_time and self.is_running and self._recording:
                if self.final_text_ready.wait(timeout=wait_interval):
                    break

                if not self.is_running or not self._recording:
                    break

                total_wait_time += wait_interval

                if total_wait_time >= max_wait_time:
                    if self.debug_mode:
                        print("Timeout while waiting for text from the server.")
                    self.recording_start.clear()
                    if on_transcription_finished:
                        threading.Thread(target=on_transcription_finished, args=("",)).start()
                    return ""

            self.recording_start.clear()

            if not self.is_running or not self._recording:
                return ""

            if on_transcription_finished:
                threading.Thread(target=on_transcription_finished, args=(self.final_text,)).start()

            return self.final_text

        except KeyboardInterrupt:
            if self.debug_mode:
                print("KeyboardInterrupt in text(), exiting...")
            raise

        except Exception as e:
            print(f"Error in AudioToTextRecorderClient.text(): {e}")
            return ""

    def feed_audio(
        self,
        chunk: bytes,
        audio_meta_data: dict[str, Any] | None = None,
        original_sample_rate: int = 16000,
    ) -> None:
        """Send an audio chunk to the server with optional metadata."""
        metadata: dict[str, Any] = {"sampleRate": original_sample_rate}

        if audio_meta_data:
            server_sent_to_stt_ns = time.time_ns()
            audio_meta_data["server_sent_to_stt"] = server_sent_to_stt_ns
            metadata["server_sent_to_stt_formatted"] = _format_timestamp_ns(server_sent_to_stt_ns)
            metadata.update(audio_meta_data)

        metadata_json = json.dumps(metadata)
        metadata_length = len(metadata_json)
        message = struct.pack("<I", metadata_length) + metadata_json.encode("utf-8") + chunk

        if self.is_running and self.data_ws is not None:
            self.data_ws.send(message, opcode=ABNF.OPCODE_BINARY)

    def set_microphone(self, microphone_on: bool = True) -> None:
        """Set the microphone on or off."""
        self.muted = not microphone_on

    def abort(self) -> None:
        self.call_method("abort")

    def wakeup(self) -> None:
        self.call_method("wakeup")

    def clear_audio_queue(self) -> None:
        self.call_method("clear_audio_queue")

    def perform_final_transcription(self) -> None:
        self.call_method("perform_final_transcription")

    def stop(self) -> None:
        self.call_method("stop")

    def connect(self) -> bool:
        """Establish WebSocket connections to the server."""
        if not self.ensure_server_running():
            print("Cannot start STT server. Exiting.")
            return False

        try:
            self.control_ws = WebSocketApp(
                self.control_url,
                on_message=self.on_control_message,
                on_error=self.on_error,
                on_close=self.on_close,
                on_open=self.on_control_open,
            )

            self.control_ws_thread = threading.Thread(target=self.control_ws.run_forever)
            self.control_ws_thread.daemon = False
            self.control_ws_thread.start()

            self.data_ws = WebSocketApp(
                self.data_url,
                on_message=self.on_data_message,
                on_error=self.on_error,
                on_close=self.on_close,
                on_open=self.on_data_open,
            )

            self.data_ws_thread = threading.Thread(target=self.data_ws.run_forever)
            self.data_ws_thread.daemon = False
            self.data_ws_thread.start()

            if not self.connection_established.wait(timeout=10):
                print("Timeout while connecting to the server.")
                return False

            if self.debug_mode:
                print("WebSocket connections established successfully.")
            return True
        except Exception as e:
            print(f"Error while connecting to the server: {e}")
            return False

    # Declarative CLI arg map: (attribute, cli_flag, is_bool_flag)
    # bool_flag=True → append flag only when truthy (no value)
    # bool_flag=False → append flag + str(value) when truthy
    _CLI_ARG_MAP: ClassVar[list[tuple[str, str, bool]]] = [
        ("model", "--model", False),
        ("realtime_model_type", "--realtime_model_type", False),
        ("download_root", "--root", False),
        ("batch_size", "--batch", False),
        ("realtime_batch_size", "--realtime_batch_size", False),
        ("init_realtime_after_seconds", "--init_realtime_after_seconds", False),
        ("debug_mode", "--debug", True),
        ("language", "--language", False),
        ("silero_sensitivity", "--silero_sensitivity", False),
        ("silero_use_onnx", "--silero_use_onnx", True),
        ("webrtc_sensitivity", "--webrtc_sensitivity", False),
        ("min_length_of_recording", "--min_length_of_recording", False),
        ("min_gap_between_recordings", "--min_gap_between_recordings", False),
        ("realtime_processing_pause", "--realtime_processing_pause", False),
        ("early_transcription_on_silence", "--early_transcription_on_silence", False),
        ("silero_deactivity_detection", "--silero_deactivity_detection", True),
        ("beam_size", "--beam_size", False),
        ("beam_size_realtime", "--beam_size_realtime", False),
        ("wake_words", "--wake_words", False),
        ("wake_words_sensitivity", "--wake_words_sensitivity", False),
        ("wake_word_timeout", "--wake_word_timeout", False),
        ("wake_word_activation_delay", "--wake_word_activation_delay", False),
        ("wakeword_backend", "--wakeword_backend", False),
        ("openwakeword_model_paths", "--openwakeword_model_paths", False),
        ("openwakeword_inference_framework", "--openwakeword_inference_framework", False),
        ("wake_word_buffer_duration", "--wake_word_buffer_duration", False),
        ("use_main_model_for_realtime", "--use_main_model_for_realtime", True),
        ("use_extended_logging", "--use_extended_logging", True),
    ]

    def _build_cli_args(self) -> list[str]:
        """Build CLI args from instance attributes using the declarative map."""
        args: list[str] = ["stt-server"]
        for attr, flag, is_bool in self._CLI_ARG_MAP:
            value = getattr(self, attr, None)
            if not value and value != 0:
                continue
            if is_bool:
                args.append(flag)
            else:
                args += [flag, str(value)]

        # Special handling: prompts need newline sanitization
        if self.initial_prompt_realtime:
            sanitized = str(self.initial_prompt_realtime).replace("\n", "\\n")
            args += ["--initial_prompt_realtime", sanitized]
        if self.initial_prompt:
            sanitized = str(self.initial_prompt).replace("\n", "\\n")
            args += ["--initial_prompt", sanitized]

        # Port extraction from URLs
        if self.control_url:
            port = urlparse(self.control_url).port
            if port:
                args += ["--control_port", str(port)]
        if self.data_url:
            port = urlparse(self.data_url).port
            if port:
                args += ["--data_port", str(port)]
        return args

    def start_server(self) -> None:
        """Launch the stt-server subprocess."""
        args = self._build_cli_args()

        if os.name == "nt":  # Windows
            cmd = "start /min cmd /c " + subprocess.list2cmdline(args)
            if self.debug_mode:
                print(f"Opening server with cli command: {cmd}")
            subprocess.Popen(cmd, shell=True)
        else:  # Unix-like systems
            subprocess.Popen(
                args,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        print(
            "STT server start command issued. Please wait a moment for it to initialize.",
            file=sys.stderr,
        )

    def is_server_running(self) -> bool:
        """Check if the STT server is reachable via WebSocket."""
        try:
            from websocket import create_connection

            ws = create_connection(self.control_url, timeout=3)
            ws.close()
            return True
        except Exception:
            if self.debug_mode:
                print("Server connectivity check failed.")
            return False

    def ensure_server_running(self) -> bool:
        """Ensure the STT server is running, optionally auto-starting it."""
        if not self.is_server_running():
            if self.debug_mode:
                print("STT server is not running.", file=sys.stderr)
            if self.autostart_server:
                self.start_server()
                if self.debug_mode:
                    print("Waiting for STT server to start...", file=sys.stderr)
                for _ in range(20):  # Wait up to 20 seconds
                    if self.is_server_running():
                        if self.debug_mode:
                            print("STT server started successfully.", file=sys.stderr)
                        time.sleep(2)
                        return True
                    time.sleep(1)
                print("Failed to start STT server.", file=sys.stderr)
                return False
            else:
                print("STT server is required. Please start it manually.", file=sys.stderr)
                return False
        else:
            self.server_already_running = True

        return True

    def list_devices(self) -> None:
        """List all available audio input devices.

        Raises NotImplementedError if AudioInput is not available.
        """
        audio_input_cls = _get_audio_input_class()
        audio = audio_input_cls(debug_mode=self.debug_mode)
        audio.list_devices()

    def start_recording(self) -> None:
        """Start the microphone recording thread."""
        self.recording_thread = threading.Thread(target=self.record_and_send_audio)
        self.recording_thread.daemon = False
        self.recording_thread.start()

    def setup_audio(self) -> bool:
        """Initialize audio input.

        Raises NotImplementedError if AudioInput is not available.
        """
        audio_input_cls = _get_audio_input_class()
        self.audio_input = audio_input_cls(
            input_device_index=self.input_device_index,
            debug_mode=self.debug_mode,
        )
        return self.audio_input.setup()  # type: ignore[no-any-return]

    def record_and_send_audio(self) -> None:
        """Record and stream audio data to the server."""
        self._recording = True

        try:
            if not self.setup_audio():
                raise RuntimeError("Failed to set up audio recording.")

            # Initialize WAV file writer if output_wav_file is provided
            if self.output_wav_file and not self.wav_file:
                self.wav_file = wave.open(self.output_wav_file, "wb")  # noqa: SIM115
                self.wav_file.setnchannels(1)
                self.wav_file.setsampwidth(2)
                self.wav_file.setframerate(self.audio_input.device_sample_rate)

            if self.debug_mode:
                print("Recording and sending audio...")

            while self.is_running:
                if self.muted:
                    time.sleep(0.01)
                    continue

                try:
                    audio_data = self.audio_input.read_chunk()

                    if self.wav_file:
                        self.wav_file.writeframes(audio_data)

                    if self.on_recorded_chunk:
                        self.on_recorded_chunk(audio_data)

                    if self.muted:
                        continue

                    if self.recording_start.is_set():
                        metadata = {"sampleRate": self.audio_input.device_sample_rate}
                        metadata_json = json.dumps(metadata)
                        metadata_length = len(metadata_json)
                        message = struct.pack("<I", metadata_length) + metadata_json.encode("utf-8") + audio_data

                        if self.is_running and self.data_ws is not None:
                            if log_outgoing_chunks:
                                print(".", flush=True, end="")
                            self.data_ws.send(message, opcode=ABNF.OPCODE_BINARY)
                except KeyboardInterrupt:
                    if self.debug_mode:
                        print("KeyboardInterrupt in record_and_send_audio, exiting...")
                    break
                except Exception as e:
                    print(f"Error sending audio data: {e}")
                    break

        except Exception as e:
            print(f"Error in record_and_send_audio: {e}", file=sys.stderr)
        finally:
            self.cleanup_audio()
            self.final_text_ready.set()
            self.is_running = False
            self._recording = False

    def cleanup_audio(self) -> None:
        """Clean up audio resources."""
        if hasattr(self, "audio_input"):
            self.audio_input.cleanup()

    def on_control_message(self, ws: WebSocketApp, message: str) -> None:
        """Handle incoming control WebSocket messages."""
        try:
            data = json.loads(message)
            if "status" in data:
                if data["status"] == "success":
                    if "parameter" in data and "value" in data:
                        request_id = data.get("request_id")
                        if request_id is not None and request_id in self.pending_requests:
                            if self.debug_mode:
                                print(f"Parameter {data['parameter']} = {data['value']}")
                            self.pending_requests[request_id]["value"] = data["value"]
                            self.pending_requests[request_id]["event"].set()
                elif data["status"] == "error":
                    print(f"Server Error: {data.get('message', '')}")
            else:
                print(f"Unknown control message format: {data}")
        except json.JSONDecodeError:
            print(f"Received non-JSON control message: {message}")
        except Exception as e:
            print(f"Error processing control message: {e}")

    # Dispatch table: message type → callback attribute name (simple no-arg callbacks)
    _DATA_DISPATCH: ClassVar[dict[str, str]] = {
        "recording_start": "on_recording_start",
        "recording_stop": "on_recording_stop",
        "vad_detect_start": "on_vad_detect_start",
        "vad_detect_stop": "on_vad_detect_stop",
        "vad_start": "on_vad_start",
        "vad_stop": "on_vad_stop",
        "start_turn_detection": "on_turn_detection_start",
        "stop_turn_detection": "on_turn_detection_stop",
        "wakeword_detected": "on_wakeword_detected",
        "wakeword_detection_start": "on_wakeword_detection_start",
        "wakeword_detection_end": "on_wakeword_detection_end",
    }

    def on_data_message(self, ws: WebSocketApp, message: str) -> None:
        """Handle real-time transcription and full sentence updates."""
        try:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "realtime":
                if data["text"] != self.realtime_text:
                    self.realtime_text = data["text"]
                    if self.on_realtime_transcription_update:
                        threading.Thread(
                            target=self.on_realtime_transcription_update,
                            args=(self.realtime_text,),
                        ).start()
            elif msg_type == "fullSentence":
                self.final_text = data["text"]
                self.final_text_ready.set()
            elif msg_type == "transcription_start":
                decoded_bytes = base64.b64decode(data.get("audio_bytes_base64"))
                audio_array = np.frombuffer(decoded_bytes, dtype=np.int16)
                normalized_audio = audio_array.astype(np.float32) / 32768.0
                if self.on_transcription_start:
                    self.on_transcription_start(normalized_audio)
            elif msg_type == "recorded_chunk":
                pass
            elif msg_type in self._DATA_DISPATCH:
                cb = getattr(self, self._DATA_DISPATCH[msg_type], None)
                if cb is not None:
                    cb()
            else:
                print(f"Unknown data message format: {data}")

        except json.JSONDecodeError:
            print(f"Received non-JSON data message: {message}")
        except Exception as e:
            print(f"Error processing data message: {e}")

    def on_error(self, ws: WebSocketApp, error: Exception) -> None:
        """Handle WebSocket errors."""
        print(f"WebSocket error: {error}")

    def on_close(self, ws: WebSocketApp, close_status_code: int | None, close_msg: str | None) -> None:
        """Handle WebSocket connection close."""
        if self.debug_mode:
            if ws == self.data_ws:
                print(f"Data WebSocket connection closed: {close_status_code} - {close_msg}")
            elif ws == self.control_ws:
                print(f"Control WebSocket connection closed: {close_status_code} - {close_msg}")

        self.is_running = False

    def on_control_open(self, ws: WebSocketApp) -> None:
        """Handle control WebSocket connection open."""
        if self.debug_mode:
            print("Control WebSocket connection opened.")
        self.connection_established.set()

    def on_data_open(self, ws: WebSocketApp) -> None:
        """Handle data WebSocket connection open."""
        if self.debug_mode:
            print("Data WebSocket connection opened.")

    def set_parameter(self, parameter: str, value: Any) -> None:  # noqa: ANN401
        """Send a set_parameter command to the server."""
        command = {
            "command": "set_parameter",
            "parameter": parameter,
            "value": value,
        }
        if self.control_ws is not None:
            self.control_ws.send(json.dumps(command))

    def get_parameter(self, parameter: str) -> Any:  # noqa: ANN401
        """Send a get_parameter command and wait for the response."""
        request_id = self.request_counter
        self.request_counter += 1

        command = {
            "command": "get_parameter",
            "parameter": parameter,
            "request_id": request_id,
        }

        event = threading.Event()
        self.pending_requests[request_id] = {"event": event, "value": None}

        if self.control_ws is not None:
            self.control_ws.send(json.dumps(command))

        if event.wait(timeout=5):
            value = self.pending_requests[request_id]["value"]
            del self.pending_requests[request_id]
            return value
        else:
            print(f"Timeout waiting for get_parameter {parameter}")
            del self.pending_requests[request_id]
            return None

    def call_method(
        self,
        method: str,
        args: list[Any] | None = None,
        kwargs: dict[str, Any] | None = None,
    ) -> None:
        """Send a call_method command to the server."""
        command: dict[str, Any] = {
            "command": "call_method",
            "method": method,
            "args": args or [],
            "kwargs": kwargs or {},
        }
        if self.control_ws is not None:
            self.control_ws.send(json.dumps(command))

    def shutdown(self) -> None:
        """Shutdown all resources."""
        self.is_running = False
        if self.control_ws:
            self.control_ws.close()
        if self.data_ws:
            self.data_ws.close()

        if self.control_ws_thread:
            self.control_ws_thread.join()
        if self.data_ws_thread:
            self.data_ws_thread.join()
        if self.recording_thread:
            self.recording_thread.join()

        self.cleanup_audio()

    def __enter__(self) -> AudioToTextRecorderClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.shutdown()
