"""ONNX-based transcription service implementation.

Extracted from utils/transcribe.py and src/core/utils/transcribe.py.
Provides Whisper ONNX transcription with PyQt signal integration and non-blocking patterns.
"""

import contextlib
import gc
import io
import logging
import os
import queue
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import onnxruntime as ort
import requests  # type: ignore[import-untyped]
from pydub import AudioSegment
from PyQt6.QtCore import QObject, pyqtSignal
from transformers import WhisperFeatureExtractor, WhisperTokenizerFast

from src_refactored.domain.transcription.entities.transcription_result import TranscriptionResult
from src_refactored.domain.audio.value_objects.audio_format import Duration
from src_refactored.domain.transcription.entities.transcription_segment import TranscriptionSegment
from src_refactored.domain.transcription.value_objects.language import Language
from src_refactored.domain.transcription.value_objects.message_display_callback import (
    MessageDisplayCallback,
)
from src_refactored.domain.transcription.value_objects.progress_callback import ProgressCallback
from src_refactored.domain.transcription.value_objects.transcription_quality import (
    TranscriptionQuality,
)
from src_refactored.domain.transcription.value_objects.transcription_request import (
    TranscriptionRequest,
)
from src_refactored.domain.transcription.value_objects.transcription_status import (
    TranscriptionStatus,
)

# Suppress transformers logging
logging.getLogger("transformers").setLevel(logging.ERROR)

custom_logger = logging.getLogger(__name__)


def resource_path(relative_path: str) -> str:
    """Get absolute path to resource, works for dev and for PyInstaller."""
    try:
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = getattr(sys, "_MEIPASS", None)
        if base_path is None:
            base_path = os.path.abspath(".")
    except AttributeError:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)


# Domain entities are now imported from domain layer


# Domain protocols are now imported from domain layer


class ONNXTranscriptionService(QObject):
    """ONNX-based Whisper transcription service with PyQt integration.
    
    Provides non-blocking transcription with progress tracking and signal integration.
    Extracted from utils/transcribe.py with infrastructure patterns.
    """

    # PyQt Signals
    transcription_started = pyqtSignal(str)  # request_id
    transcription_progress = pyqtSignal(str, int, str)  # request_id, progress, message
    transcription_completed = pyqtSignal(str, object)  # request_id, TranscriptionResult
    transcription_failed = pyqtSignal(str, str)  # request_id, error_message
    model_initialized = pyqtSignal()
    model_download_progress = pyqtSignal(str, int, int)  # filename, current, total

    def __init__(self,
                 cache_path: str | None = None,
                 quality: TranscriptionQuality = TranscriptionQuality.QUANTIZED,
                 model_type: str = "whisper-turbo",
                 display_message_callback: MessageDisplayCallback | None = None,
                 progress_callback: ProgressCallback | None = None):
        """Initialize ONNX transcription service.
        
        Args:
            cache_path: Path to model cache directory
            quality: Transcription quality level
            model_type: Whisper model type to use
            display_message_callback: Callback for displaying messages
            progress_callback: Callback for progress updates
        """
        super().__init__()

        # Configuration
        self.cache_path = cache_path or resource_path("cache")
        self.quality = quality
        self.model_type = model_type
        self.display_message_callback = display_message_callback
        self.progress_callback = progress_callback

        # State
        self.status = TranscriptionStatus.IDLE
        self.is_initialized = False
        self.sessions: dict[str, ort.InferenceSession] = {}
        self.tokenizer: WhisperTokenizerFast | None = None
        self.feature_extractor: WhisperFeatureExtractor | None = None

        # Streaming support
        self.audio_buffer: deque[float] = deque(maxlen=48000)  # 3 seconds at 16kHz
        self.buffer_lock = threading.Lock()
        self.transcript_queue: queue.Queue[str] = queue.Queue()
        self.current_transcript: str = ""
        self.is_processing: bool = False
        self.processing_thread: threading.Thread | None = None

        # Last transcription data for segment extraction
        self.last_audio_path: str | None = None
        self.last_transcription: str | None = None

        # Model paths and URLs
        self._setup_model_configuration()

        custom_logger.info(f"ONNXTranscriptionService initialized with quality: {quality.value}, model: {model_type}")

    def _setup_model_configuration(self) -> None:
        """Setup model configuration based on quality and type."""
        # Use ONNX community repository with onnx/ subfolder for model files
        base_url = "https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/onnx/"

        if self.quality == TranscriptionQuality.FULL:
            self.model_urls = {
                "encoder": f"{base_url}encoder_model.onnx",
                "decoder": f"{base_url}decoder_model.onnx",
                "decoder_with_past": f"{base_url}decoder_with_past_model.onnx",
            }
        else:
            self.model_urls = {
                "encoder": f"{base_url}encoder_model_quantized.onnx",
                "decoder": f"{base_url}decoder_model_quantized.onnx",
                "decoder_with_past": f"{base_url}decoder_with_past_model_quantized.onnx",
            }

        # Model file paths (align with utils/transcribe.py layout: cache/models/<model_type>)
        self.model_dir = Path(self.cache_path) / "models" / self.model_type
        self.model_dir.mkdir(parents=True, exist_ok=True)
        self.onnx_folder = self.model_dir / "onnx"
        self.onnx_folder.mkdir(parents=True, exist_ok=True)

        self.model_paths = {
            name: self.onnx_folder / f"{name}_model{'_quantized' if self.quality == TranscriptionQuality.QUANTIZED else ''}.onnx"
            for name in ["encoder", "decoder", "decoder_with_past"]
        }

    async def initialize_async(self) -> bool:
        """Initialize the transcription service asynchronously."""
        if self.is_initialized:
            return True

        try:
            self.status = TranscriptionStatus.INITIALIZING

            if self.display_message_callback:
                self.display_message_callback("Initializing transcription service...", None, 10, False, False)

            # Download models if needed
            await self._download_models_if_needed()

            # Initialize ONNX sessions
            self._initialize_sessions()

            # Initialize tokenizer and feature extractor
            self._initialize_processors()

            self.is_initialized = True
            self.status = TranscriptionStatus.IDLE

            if self.display_message_callback:
                self.display_message_callback("Transcription service ready", None, 100, False, True)

            self.model_initialized.emit()
            custom_logger.info("ONNX transcription service initialized successfully")
            return True

        except Exception as e:
            self.status = TranscriptionStatus.ERROR
            error_msg = f"Failed to initialize transcription service: {e}"
            custom_logger.exception(error_msg)

            if self.display_message_callback:
                self.display_message_callback(error_msg, None, 0, True, True)

            return False

    def _initialize_sessions(self) -> None:
        """Initialize ONNX runtime sessions."""
        providers = ort.get_available_providers()
        custom_logger.info(f"Available ONNX providers: {providers}")

        for name, path in self.model_paths.items():
            if not path.exists():
                msg = f"Model file not found: {path}"
                raise FileNotFoundError(msg)

            try:
                self.sessions[name] = ort.InferenceSession(str(path), providers=providers)
                custom_logger.info(f"Loaded {name} model from {path}")
            except Exception as e:
                msg = f"Failed to load {name} model: {e}"
                raise RuntimeError(msg)

    def _initialize_processors(self) -> None:
        """Initialize tokenizer and feature extractor."""
        try:
            # Prefer local cache dir (downloaded configs) to avoid network at runtime
            if (self.model_dir / "tokenizer_config.json").exists():
                self.tokenizer = WhisperTokenizerFast.from_pretrained(str(self.model_dir))
            else:
                self.tokenizer = WhisperTokenizerFast.from_pretrained("openai/whisper-large-v3-turbo")

            if (self.model_dir / "preprocessor_config.json").exists():
                self.feature_extractor = WhisperFeatureExtractor.from_pretrained(str(self.model_dir))
            else:
                self.feature_extractor = WhisperFeatureExtractor.from_pretrained("openai/whisper-large-v3-turbo")
            custom_logger.info("Tokenizer and feature extractor initialized")

            # Load model configuration files if available (needed for decoding loop)
            import json as _json
            self.config = {}
            self.generation_config = {}
            try:
                with open(self.model_dir / "config.json", "r", encoding="utf-8") as f:
                    self.config = _json.load(f)
            except Exception:
                pass
            try:
                with open(self.model_dir / "generation_config.json", "r", encoding="utf-8") as f:
                    self.generation_config = _json.load(f)
            except Exception:
                pass
        except Exception as e:
            msg = f"Failed to initialize processors: {e}"
            raise RuntimeError(msg)

    async def _download_models_if_needed(self,
    ) -> None:
        """Download models if they don't exist."""
        for name, path in self.model_paths.items():
            if not path.exists():
                self.status = TranscriptionStatus.DOWNLOADING
                url = self.model_urls[name]
                await self._download_file_with_progress(url, path, f"{name} model")

    async def _download_file_with_progress(self, url: str, save_path: Path, name: str) -> None:
        """Download file with progress tracking and resume support."""
        try:
            temp_path = save_path.with_suffix(save_path.suffix + ".tmp")

            # HEAD: detect total and range support
            head = requests.head(url, allow_redirects=True, timeout=30)
            head.raise_for_status()
            total_size_header = head.headers.get("content-length")
            total_size = int(total_size_header) if total_size_header is not None else 0
            accept_ranges = head.headers.get("accept-ranges", "").lower() == "bytes"

            # Resume offset
            downloaded = 0
            if temp_path.exists():
                downloaded = temp_path.stat().st_size
                if total_size > 0 and downloaded >= total_size:
                    temp_path.replace(save_path)
                    if self.progress_callback:
                        self.progress_callback(total_size, total_size, f"Downloaded {name}")
                    self.model_download_progress.emit(name, total_size, total_size)
                    return

            headers: dict[str, str] = {}
            if downloaded > 0 and accept_ranges:
                headers["Range"] = f"bytes={downloaded}-"

            resp = requests.get(url, stream=True, headers=headers, timeout=30)
            if downloaded > 0 and resp.status_code == 200:
                # Range not supported; start over
                downloaded = 0
                if temp_path.exists():
                    temp_path.unlink(missing_ok=True)
                resp.close()
                resp = requests.get(url, stream=True, timeout=30)
            elif resp.status_code == 416 and total_size > 0:
                if temp_path.exists() and temp_path.stat().st_size >= total_size:
                    temp_path.replace(save_path)
                    if self.progress_callback:
                        self.progress_callback(total_size, total_size, f"Downloaded {name}")
                    self.model_download_progress.emit(name, total_size, total_size)
                    return
            resp.raise_for_status()

            mode = "ab" if downloaded > 0 else "wb"
            with open(temp_path, mode) as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    if not chunk:
                        continue
                    f.write(chunk)
                    downloaded += len(chunk)
                    if self.progress_callback:
                        self.progress_callback(downloaded, total_size, f"Downloading {name}")

            temp_path.replace(save_path)
            custom_logger.info(f"Downloaded {name} successfully")

        except Exception as e:
            # Keep temp for resume where possible; only remove final path
            if save_path.exists():
                with contextlib.suppress(Exception):
                    save_path.unlink()
            msg = f"Failed to download {name}: {e}"
            raise RuntimeError(msg)

    async def transcribe_async(self, request: TranscriptionRequest,
    ) -> TranscriptionResult:
        """Transcribe audio asynchronously."""
        if not self.is_initialized:
            msg = "Service not initialized"
            raise RuntimeError(msg)

        request_id = f"req_{int(time.time() * 1000)}"

        try:
            self.status = TranscriptionStatus.PROCESSING
            self.transcription_started.emit(request_id,
    )

            # Preprocess audio
            self.transcription_progress.emit(request_id, 20, "Preprocessing audio...")
            audio_features = self._preprocess_audio(request.audio_input)

            # Run encoder
            self.transcription_progress.emit(request_id, 40, "Running encoder...")
            encoder_outputs = self._encode(audio_features)

            # Run decoder
            self.transcription_progress.emit(request_id, 70, "Running decoder...")
            output_ids = self._decode(encoder_outputs)

            # Postprocess
            self.transcription_progress.emit(request_id, 90, "Postprocessing...")
            transcription_text = self._postprocess(output_ids)

            # Generate segments if requested
            segments = []
            if getattr(request, "return_segments", False):
                segments = self._generate_segments(request.audio_input, transcription_text)
            else:
                # Produce a single segment covering the whole utterance so domain aggregate flows
                segments = [TranscriptionSegment.create_simple_segment(0.0, max(0.5, len(transcription_text) / 15.0), transcription_text)]

            result = TranscriptionResult(
                transcription_id=request_id,
                source_audio_id=f"audio_{request_id}",
                language=request.language or Language.auto_detect(),
            )
            # Mark domain aggregate as started before adding segments
            try:
                result.start_transcription(audio_duration=Duration(0.0), model_version=f"{self.model_type}-{self.quality.value}")
            except Exception:
                # Non-fatal: keep result in default state
                pass
            
            # Add segments to the result
            for segment in segments:
                result.add_segment(segment)
            # Complete if we added any segments
            try:
                if segments:
                    result.complete_transcription()
            except Exception:
                # Non-fatal: allow returning partial result
                pass

            self.status = TranscriptionStatus.COMPLETED
            self.transcription_progress.emit(request_id, 100, "Completed")
            self.transcription_completed.emit(request_id, result)

            # Store for segment extraction and for adapter fallback
            if isinstance(request.audio_input, str):
                self.last_audio_path = request.audio_input
            self.last_transcription = transcription_text

            return result

        except Exception as e:
            self.status = TranscriptionStatus.ERROR
            error_msg = f"Transcription failed: {e}"
            custom_logger.exception(error_msg)
            self.transcription_failed.emit(request_id, error_msg)
            raise

    def _preprocess_audio(self, audio_input: str | io.BytesIO | np.ndarray) -> np.ndarray:
        """Preprocess audio input to features."""
        # Normalize input into a 1D float32 numpy array at 16 kHz, mono
        if isinstance(audio_input, str):
            # File path
            audio_array, _ = librosa.load(audio_input, sr=16000, mono=True)
        elif isinstance(audio_input, io.BytesIO):
            # Audio buffer (ensure format inference works by having name set upstream)
            audio_segment = AudioSegment.from_file(audio_input)
            audio_segment = audio_segment.set_frame_rate(16000).set_channels(1)
            samples = np.array(audio_segment.get_array_of_samples(), dtype=np.float32)
            # Scale based on sample width to roughly [-1, 1]
            max_value = float(1 << (8 * audio_segment.sample_width - 1)) if getattr(audio_segment, "sample_width", 2) else 0.0
            audio_array = samples / max_value if max_value > 0 else samples
        else:
            # Raw numpy array
            audio_array = audio_input.astype(np.float32)
            if audio_array.ndim > 1 and audio_array.shape[1] == 2:
                audio_array = audio_array.mean(axis=1)

        # Guard against silent input to avoid divide-by-zero in downstream processing
        if audio_array.size == 0:
            audio_array = np.zeros(16000, dtype=np.float32)

        # Extract features via HF processor
        assert self.feature_extractor is not None
        inputs = self.feature_extractor(
            audio_array,
            sampling_rate=16000,
            return_tensors="np",
        )

        return inputs.input_features

    def _encode(self, input_features: np.ndarray) -> np.ndarray:
        """Run encoder model."""
        encoder_session = self.sessions["encoder"]
        encoder_outputs = encoder_session.run(None, {"input_features": input_features})
        return encoder_outputs[0]

    def _decode(self, encoder_hidden_states: np.ndarray) -> np.ndarray:
        """Run decoder model with greedy generation using past key-values if available."""
        # Choose decoder with past if present
        decoder_session = self.sessions.get("decoder_with_past", self.sessions.get("decoder"))
        if decoder_session is None:
            raise RuntimeError("Decoder session not initialized")

        # Determine token ids from generation config if available
        start_token_id = int(self.generation_config.get("decoder_start_token_id", 50258)) if isinstance(self.generation_config, dict) else 50258
        eos_token_id = int(self.generation_config.get("eos_token_id", 50257)) if isinstance(self.generation_config, dict) else 50257
        max_length = int(self.generation_config.get("max_length", 64)) if isinstance(self.generation_config, dict) else 64

        # Model config for shapes
        num_layers = int(self.config.get("decoder_layers", 2)) if isinstance(self.config, dict) else 2
        num_attention_heads = int(self.config.get("decoder_attention_heads", 16)) if isinstance(self.config, dict) else 16
        d_model = int(self.config.get("d_model", 1280)) if isinstance(self.config, dict) else 1280
        head_dim = d_model // max(1, num_attention_heads)

        batch_size = encoder_hidden_states.shape[0]
        decoder_input_ids = np.array([[start_token_id]] * batch_size, dtype=np.int64)

        # Initialize empty past key values
        past_key_values: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = []
        for _ in range(num_layers):
            past_decoder_key = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            past_decoder_value = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            past_encoder_key = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            past_encoder_value = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            past_key_values.append((past_decoder_key, past_decoder_value, past_encoder_key, past_encoder_value))

        output_ids: list[np.ndarray] = []

        for _ in range(max_length):
            decoder_inputs: dict[str, np.ndarray] = {
                "input_ids": decoder_input_ids,
                "use_cache_branch": np.array([False], dtype=bool),
                "encoder_hidden_states": encoder_hidden_states.astype(np.float32),
            }

            # Provide past key values
            for layer in range(num_layers):
                pkv = past_key_values[layer]
                decoder_inputs[f"past_key_values.{layer}.decoder.key"] = pkv[0]
                decoder_inputs[f"past_key_values.{layer}.decoder.value"] = pkv[1]
                decoder_inputs[f"past_key_values.{layer}.encoder.key"] = pkv[2]
                decoder_inputs[f"past_key_values.{layer}.encoder.value"] = pkv[3]

            try:
                decoder_outputs = decoder_session.run(None, decoder_inputs)
            except Exception as e:
                # Fallback: try minimal decoder without past if run fails
                basic_decoder = self.sessions.get("decoder")
                if basic_decoder is None:
                    raise e
                decoder_outputs = basic_decoder.run(None, {"input_ids": decoder_input_ids, "encoder_hidden_states": encoder_hidden_states})

            # Extract next token logits (assume first output is logits)
            logits = decoder_outputs[0]
            next_tokens = np.argmax(logits[:, -1, :], axis=-1).astype(np.int64)
            output_ids.append(next_tokens)

            # Update past key values from outputs (follow expected ordering)
            updated_past: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = []
            idx = 1
            for _layer in range(num_layers):
                try:
                    updated_past.append((
                        decoder_outputs[idx + 0],
                        decoder_outputs[idx + 1],
                        decoder_outputs[idx + 2],
                        decoder_outputs[idx + 3],
                    ))
                    idx += 4
                except Exception:
                    # If outputs don't include past, keep existing zero-length past
                    updated_past.append(past_key_values[_layer])
            past_key_values = updated_past

            # Append token to input ids for next step
            decoder_input_ids = np.concatenate([decoder_input_ids, next_tokens[:, None]], axis=-1)

            # Stop on EOS
            if np.all(next_tokens == eos_token_id):
                break

        if not output_ids:
            return np.zeros((batch_size, 0), dtype=np.int64)

        return np.array(output_ids, dtype=np.int64).T

    def _postprocess(self, output_ids: np.ndarray) -> str:
        """Convert model outputs to text.
        Accepts either token IDs (batch, seq_len) or logits (batch, seq_len, vocab)."""
        assert self.tokenizer is not None
        # If logits, argmax over vocab; if already token ids, use as-is
        if output_ids.ndim == 3:
            token_ids = np.argmax(output_ids, axis=-1)
        elif output_ids.ndim == 2:
            token_ids = output_ids.astype(np.int64, copy=False)
        elif output_ids.ndim == 1:
            token_ids = output_ids[None, :].astype(np.int64, copy=False)
        else:
            return ""
        # Take first batch
        ids_seq = token_ids[0].tolist() if hasattr(token_ids, "tolist") else list(token_ids[0])
        if not ids_seq:
            return ""
        transcription = self.tokenizer.decode(ids_seq, skip_special_tokens=True)
        return (transcription or "").strip()

    def _generate_segments(self, audio_input: str | io.BytesIO | np.ndarray,
                          transcription: str,
    ) -> list[TranscriptionSegment]:
        """Generate segments with timestamps."""
        try:
            # Get audio duration
            if isinstance(audio_input, str):
                audio_duration = librosa.get_duration(path=audio_input)
            else:
                # Estimate duration for other input types
                audio_duration = 30.0  # Default fallback

            # Simple segmentation by sentences
            import re
            sentences = re.split(r"(?<=[.!?])\s+", transcription)
            sentences = [s.strip() for s in sentences if s.strip()]

            if not sentences:
                return [TranscriptionSegment.create_simple_segment(0.0, audio_duration, transcription)]

            # Distribute time evenly across sentences
            segments = []
            duration_per_segment = audio_duration / len(sentences)

            for i, sentence in enumerate(sentences):
                start_time = i * duration_per_segment
                end_time = min((i + 1) * duration_per_segment, audio_duration)

                segments.append(TranscriptionSegment.create_simple_segment(
                    start_time, end_time, sentence, i,
                ))

            return segments

        except Exception as e:
            custom_logger.exception(f"Error generating segments: {e}")
            return [TranscriptionSegment.create_simple_segment(0.0, 30.0, transcription)]

    def get_segments(self) -> list[dict[str, Any]]:
        """Get segments from last transcription (legacy compatibility)."""
        if not self.last_transcription or not self.last_audio_path:
            return []

        segments = self._generate_segments(self.last_audio_path, self.last_transcription)
        return [
            {
                "start": seg.start_time.seconds,
                "end": seg.end_time.seconds,
                "text": getattr(seg.text, "content", str(seg.text)),
            }
            for seg in segments
        ]

    # Streaming methods
    def start_streaming(self) -> None:
        """Start streaming transcription."""
        if self.is_processing:
            return

        self.is_processing = True
        self.processing_thread = threading.Thread(target=self._process_stream, daemon=True)
        self.processing_thread.start()
        custom_logger.info("Started streaming transcription")

    def stop_streaming(self) -> None:
        """Stop streaming transcription."""
        self.is_processing = False
        if self.processing_thread:
            self.processing_thread.join(timeout=1.0)
        custom_logger.info("Stopped streaming transcription")

    def add_audio_chunk(self, chunk: np.ndarray) -> None:
        """Add audio chunk for streaming transcription."""
        with self.buffer_lock:
            # Convert int16 to float32 and normalize
            if chunk.dtype == np.int16:
                chunk = chunk.astype(np.float32) / 32768.0

            self.audio_buffer.extend(chunk)

    def get_current_transcript(self) -> str:
        """Get the latest streaming transcript."""
        try:
            while not self.transcript_queue.empty():
                self.current_transcript = self.transcript_queue.get_nowait()
        except queue.Empty:
            pass
        return self.current_transcript

    def _process_stream(self) -> None:
        """Background thread for streaming transcription."""
        while self.is_processing:
            try:
                with self.buffer_lock:
                    if len(self.audio_buffer) >= 16000:  # 1 second of audio
                        # Get audio data
                        audio_data = np.array(list(self.audio_buffer), dtype=np.float32)

                        # Process through pipeline
                        assert self.feature_extractor is not None
                        features = self.feature_extractor(
                            audio_data,
                            sampling_rate=16000,
                            return_tensors="np",
                        )

                        encoder_outputs = self._encode(features.input_features)
                        output_ids = self._decode(encoder_outputs)
                        transcription = self._postprocess(output_ids)

                        # Update transcript
                        self.current_transcript = transcription
                        self.transcript_queue.put(transcription)

                        # Keep only last 0.5 seconds for context
                        self.audio_buffer = deque(list(self.audio_buffer)[-8000:], maxlen=48000)

                time.sleep(0.1)  # Prevent busy waiting

            except Exception as e:
                custom_logger.exception(f"Error in streaming processing: {e}")
                break

    def cleanup(self) -> None:
        """Cleanup resources."""
        self.stop_streaming()

        # Clear sessions
        for session in self.sessions.values():
            if session:
                del session
        self.sessions.clear()

        # Clear buffers
        with self.buffer_lock:
            self.audio_buffer.clear()

        # Clear queue
        while not self.transcript_queue.empty():
            try:
                self.transcript_queue.get_nowait()
            except queue.Empty:
                break

        # Force garbage collection
        gc.collect()

        custom_logger.info("ONNX transcription service cleaned up")


# (Removed legacy compatibility wrapper class)


# VAD Service (extracted from utils/transcribe.py)
class VADService(QObject,
    ):
    """Voice Activity Detection service using Silero VAD."""

    # PyQt Signals
    speech_detected = pyqtSignal(float, float)  # start_time, end_time
    silence_detected = pyqtSignal(float)  # duration
    vad_initialized = pyqtSignal()

    def __init__(self, onnx_path: str | None = None, model_filename: str = "silero_vad_16k.onnx",
                 progress_callback: ProgressCallback | None = None):
        """Initialize VAD service.
        
        Args:
            onnx_path: Path to VAD model directory
            model_filename: VAD model filename
            progress_callback: Progress callback for model download
        """
        super().__init__()

        self.model_filename = model_filename
        self.onnx_path = onnx_path or resource_path("cache/vad")
        self.model_path = os.path.join(self.onnx_path, model_filename)
        self.progress_callback = progress_callback

        # Model parameters
        self.sample_rate = 16000
        self.sr_per_ms = self.sample_rate / 1000
        self.window_size_samples = int(32 * self.sr_per_ms)
        self.state_shape = (2, 1, 128)

        # VAD thresholds
        self.threshold = 0.5
        self.min_silence_duration_ms = 0
        self.speech_pad_ms = 32
        self.min_speech_duration_ms = 32
        self.max_speech_duration_s = np.inf

        # Initialize
        self._initialize()

    def _initialize(self) -> None:
        """Initialize VAD model."""
        try:
            # Download model if needed
            if not os.path.exists(self.model_path):
                os.makedirs(self.onnx_path, exist_ok=True)
                self._download_model()

            # Load ONNX model
            providers = ort.get_available_providers()
            self.session = ort.InferenceSession(self.model_path, providers=providers)

            # Get input/output names
            self.input_names = [input_.name for input_ in self.session.get_inputs()]
            self.output_names = [output.name for output in self.session.get_outputs()]

            self.reset_states()
            self.vad_initialized.emit()
            custom_logger.info("VAD service initialized successfully")

        except Exception as e:
            custom_logger.exception(f"Failed to initialize VAD service: {e}")
            raise

    def _download_model(self) -> None:
        """Download VAD model."""
        url = (
            "https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad_16k.onnx"
        )

        try:
            custom_logger.info(f"Downloading VAD model from {url}")
            response = requests.get(url, stream=True)
            response.raise_for_status()

            total_size = int(response.headers.get("content-length", 0))
            downloaded = 0

            with open(self.model_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)

                        if self.progress_callback and total_size > 0:
                            self.progress_callback(downloaded, total_size, "Downloading VAD model")

            custom_logger.info("VAD model downloaded successfully")

        except Exception as e:
            if os.path.exists(self.model_path):
                os.unlink(self.model_path)
            msg = f"Failed to download VAD model: {e}"
            raise RuntimeError(msg)

    def reset_states(self) -> None:
        """Reset VAD states."""
        self.state = np.zeros(self.state_shape, dtype=np.float32)
        self.triggered = False
        self.temp_end = 0
        self.current_sample = 0
        self.prev_end = 0
        self.next_start = 0

    def predict(self, audio_chunk: np.ndarray) -> float:
        """Predict speech probability for audio chunk.
        
        Args:
            audio_chunk: Audio data (should be 512 samples at 16kHz)
            
        Returns:
            Speech probability (0.0 to 1.0)
        """
        if len(audio_chunk) != 512:
            # Pad or truncate to 512 samples
            if len(audio_chunk) < 512:
                audio_chunk = np.pad(audio_chunk, (0, 512 - len(audio_chunk)))
            else:
                audio_chunk = audio_chunk[:512]

        # Ensure correct shape and type
        audio_chunk = audio_chunk.astype(np.float32,
    ).reshape(1, -1)

        # Run inference
        outputs = self.session.run(
            self.output_names,
            {
                self.input_names[0]: audio_chunk,
                self.input_names[1]: self.state,
            },
        )

        speech_prob = outputs[0][0][0]
        self.state = outputs[1]

        return float(speech_prob)

    def has_speech(self, file_path: str,
    ) -> bool:
        """Check if audio file contains speech.
        
        Args:
            file_path: Path to audio file
            
        Returns:
            True if speech is detected
        """
        try:
            # Load audio
            audio_data, _ = librosa.load(file_path, sr=self.sample_rate)

            # Process in chunks
            chunk_size = 512
            speech_chunks = 0
            total_chunks = 0

            for i in range(0, len(audio_data), chunk_size):
                chunk = audio_data[i:i + chunk_size]
                if len(chunk) < chunk_size:
                    break

                speech_prob = self.predict(chunk)
                total_chunks += 1

                if speech_prob > self.threshold:
                    speech_chunks += 1

            # Consider speech if more than 10% of chunks contain speech
            speech_ratio = speech_chunks / total_chunks if total_chunks > 0 else 0
            return speech_ratio > 0.1

        except Exception as e:
            custom_logger.exception(f"Error checking speech in {file_path}: {e}")
            return False