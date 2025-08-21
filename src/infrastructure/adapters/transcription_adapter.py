"""Transcription and VAD Service Adapters.

These adapters bridge the real transcription and VAD services to work with
the listener service and provide the simple interfaces expected by the application.
"""

import io
from typing import Any

from src.domain.common.ports.logging_port import LoggingPort


class SimpleVADAdapter:
    """VAD adapter backed by onnx_asr Silero VAD (no legacy pipeline)."""

    def __init__(self, logger: LoggingPort | None = None):
        self._logger = logger
        self._vad = None
        # Provide a non-None sentinel so bridge does not enter degraded mode
        self._vad_detector = object()

        def _lazy_init() -> None:
            try:
                import onnx_asr  # type: ignore[import-not-found]
                self._vad = onnx_asr.load_vad("silero")
            except Exception as e:  # best-effort; fallback to RMS gate
                if self._logger:
                    self._logger.log_warning(f"Silero VAD init failed; falling back to RMS gate: {e}")
            # If loaded successfully, update compat attribute expected by bridge
            if self._vad is not None:
                self._vad_detector = self._vad

        try:
            import threading as _th
            _th.Thread(target=_lazy_init, daemon=True).start()
        except Exception:
            _lazy_init()

    def _to_numpy_waveform(self, audio_input: Any, target_sr: int = 16000):
        try:
            import numpy as np
            from pydub import AudioSegment  # type: ignore[import-not-found]
            if isinstance(audio_input, (bytes, bytearray)):
                import io as _io
                buf = _io.BytesIO(audio_input)
                seg = AudioSegment.from_file(buf)
            else:
                seg = AudioSegment.from_file(audio_input)
            seg = seg.set_frame_rate(target_sr).set_channels(1)
            samples = np.array(seg.get_array_of_samples(), dtype=np.float32)
            sample_width = int(getattr(seg, "sample_width", 2) or 2)
            max_value = float(1 << (8 * sample_width - 1)) if sample_width > 0 else 1.0
            waveform = samples / max_value if max_value > 0 else samples
            return waveform.astype(np.float32, copy=False), target_sr
        except Exception:
            # Fallback: decode simple PCM WAV
            import io as _io
            import wave as _wave
            import numpy as np
            with (_io.BytesIO(audio_input) if isinstance(audio_input, (bytes, bytearray)) else audio_input) as f:  # type: ignore[arg-type]
                with _wave.open(f, "rb") as wf:
                    n_channels = wf.getnchannels()
                    sr = wf.getframerate()
                    frames = wf.readframes(wf.getnframes())
                    data = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
                    if n_channels == 2:
                        data = data.reshape(-1, 2).mean(axis=1)
                    # naive resample if needed
                    if sr != target_sr and sr > 0:
                        import numpy as _n
                        duration = data.shape[0] / float(sr)
                        target_len = int(duration * target_sr)
                        if target_len > 0:
                            x_old = _n.linspace(0.0, 1.0, num=data.shape[0], endpoint=False, dtype=_n.float32)
                            x_new = _n.linspace(0.0, 1.0, num=target_len, endpoint=False, dtype=_n.float32)
                            data = _n.interp(x_new, x_old, data).astype(_n.float32, copy=False)
                    return data.astype(np.float32, copy=False), target_sr

    def detect_speech(self, audio_data: Any) -> bool:
        """Detect speech using onnx_asr VAD or RMS fallback."""
        try:
            import numpy as np
            waveform, sr = self._to_numpy_waveform(audio_data, 16000)
            if waveform.size == 0:
                return False
            # Quick RMS gate as pre-check
            if float(np.sqrt(np.mean(np.square(waveform)))) < 0.004:
                return False
            # Use Silero VAD if available
            if self._vad is not None:
                # Prepare batch with single waveform
                waveforms = np.expand_dims(waveform.astype(np.float32, copy=False), axis=0)
                waveforms_len = np.array([waveform.shape[0]], dtype=np.int64)
                try:
                    segments_batch = self._vad.segment_batch(waveforms, waveforms_len)
                    first_iter = next(iter(segments_batch), None)
                    if first_iter is None:
                        return False
                    # Determine if any segment exists
                    try:
                        first_segment = next(iter(first_iter), None)
                        return first_segment is not None
                    except Exception:
                        # If iterator cannot be consumed twice, coalesce by scanning
                        return any(True for _ in first_iter)
                except Exception:
                    # Fall through to RMS decision
                    pass
            # Fallback: RMS-based speech gate
            return float(np.sqrt(np.mean(np.square(waveform)))) >= 0.005
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error in VAD speech detection: {e}")
            return False

    def has_speech(self, audio_data: Any) -> bool:
        return self.detect_speech(audio_data)


class SimpleTranscriptionAdapter:
    """Adapter over onnx-asr-backed transcription service (legacy-compatible)."""

    def __init__(self, logger: LoggingPort | None = None):
        self._logger = logger
        # Defer ONNX service creation to the thread that will transcribe to avoid Qt thread affinity issues
        self._service = None
        # Compatibility: non-None sentinel to satisfy legacy availability check
        self._transcriber = object()
        self._ui_status_callback = None

    def set_ui_status_callback(self, callback) -> None:
        """Provide UI status callback used for download/progress updates."""
        self._ui_status_callback = callback

    def cleanup(self) -> None:
        """Cleanup underlying service and cancel downloads if any."""
        try:
            if self._service is not None and hasattr(self._service, "request_shutdown"):
                self._service.request_shutdown()
            if self._service is not None and hasattr(self._service, "cleanup"):
                self._service.cleanup()
        except Exception:
            pass

    def preload_models(self) -> None:
        """Kick off background initialization so models download at startup."""
        try:
            if self._service is None:
                from src.infrastructure.transcription.onnx_transcription_service import (
                    OnnxAsrTranscriptionService,
                )
                # Create wrapper; let onnx-asr handle model loading and caching
                # Map UI-configured model and quantization if available later via settings
                # Read from configuration adapter to avoid domain-layer file IO coupling
                from src.infrastructure.adapters.configuration_adapter import ConfigurationServiceAdapter as _Cfg
                cfg = _Cfg("settings.json", self._logger)
                model_name = str(cfg.get_setting("model", "onnx-community/whisper-small"))
                quantization = str(cfg.get_setting("quantization", "Quantized"))
                self._service = OnnxAsrTranscriptionService(
                    model_name=model_name,
                    use_vad=True,
                    display_message_callback=self._ui_status_callback,
                    quantization=quantization,
                )
                self._transcriber = self._service

            import asyncio
            import threading

            def _init_async():
                try:
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    loop.run_until_complete(self._service.initialize_async())
                    loop.close()
                except Exception:
                    pass

            threading.Thread(target=_init_async, daemon=True).start()
        except Exception:
            # Swallow errors during preloading; runtime will fallback gracefully
            pass

    def is_ready(self) -> bool:
        """Return True when transcription service is initialized (models downloaded)."""
        try:
            return bool(getattr(self._service, "is_initialized", False))
        except Exception:
            return False

    def transcribe_audio(self, audio_data: Any) -> str:
        """Transcribe audio data to text using real transcription implementation."""
        try:
            # Create service lazily in the current thread
            if self._service is None:
                from src.infrastructure.transcription.onnx_transcription_service import (
                    OnnxAsrTranscriptionService,
                )
                from src.infrastructure.adapters.configuration_adapter import ConfigurationServiceAdapter as _Cfg
                cfg = _Cfg("settings.json", self._logger)
                model_name = str(cfg.get_setting("model", "onnx-community/whisper-small"))
                quantization = str(cfg.get_setting("quantization", "Quantized"))
                self._service = OnnxAsrTranscriptionService(
                    model_name=model_name,
                    use_vad=True,
                    display_message_callback=self._ui_status_callback,
                    quantization=quantization,
                )
                self._transcriber = self._service
            # Ensure service is initialized lazily
            if not getattr(self._service, "is_initialized", False):
                import asyncio
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                ok = loop.run_until_complete(self._service.initialize_async())
                loop.close()
                if not ok or not getattr(self._service, "is_initialized", False):
                    if self._logger:
                        self._logger.log_error("OnnxAsrTranscriptionService failed to initialize")
                    return ""

            # audio_data should be a file path or BytesIO buffer
            if isinstance(audio_data, str):
                # File path
                from src.domain.transcription.value_objects.transcription_request import (
                    TranscriptionRequest,
                )
                req = TranscriptionRequest(audio_input=audio_data)
                import asyncio
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                result_obj = loop.run_until_complete(self._service.transcribe_async(req))
                loop.close()
                result = getattr(result_obj, "text", None) or ""
            elif isinstance(audio_data, bytes | bytearray):
                audio_buffer = io.BytesIO(audio_data)
                from src.domain.transcription.value_objects.transcription_request import (
                    TranscriptionRequest,
                )
                # For paste path (recorded buffer), do not request segments
                req = TranscriptionRequest(audio_input=audio_buffer, return_segments=False)
                import asyncio
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                result_obj = loop.run_until_complete(self._service.transcribe_async(req))
                loop.close()
                result = getattr(result_obj, "text", None) or ""
            elif hasattr(audio_data, "read"):
                from src.domain.transcription.value_objects.transcription_request import (
                    TranscriptionRequest,
                )
                # Ensure helpful name for format inference when reading from memory
                try:
                    if not getattr(audio_data, "name", "").endswith(".wav"):
                        audio_data.name = "audio.wav"  # type: ignore[attr-defined]
                except Exception:
                    pass
                req = TranscriptionRequest(audio_input=audio_data, return_segments=False)
                import asyncio
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                result_obj = loop.run_until_complete(self._service.transcribe_async(req))
                loop.close()
                result = getattr(result_obj, "text", None) or ""
            else:
                if self._logger:
                    self._logger.log_warning("Invalid audio data format for transcription")
                return "Invalid audio format"
            
            if self._logger:
                self._logger.log_debug(f"Transcription completed: {result[:50]}...")
            
            return result if result else "No transcription result"
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error in transcription: {e}")
            return f"Transcription error: {e!s}"

    def transcribe(self, audio_data: Any) -> str:
        """Alias for transcribe_audio to match original interface."""
        return self.transcribe_audio(audio_data)

    def transcribe_with_timestamps(self, audio_data: Any) -> list[dict[str, Any]]:
        """Transcribe and return timestamped segments using our ONNX implementation.

        Returns a list of dicts with keys: start, end, text.
        """
        # Ensure service exists and is initialized
        if self._service is None:
            # Initialize service without performing a real transcription
            self.preload_models()
        if not getattr(self._service, "is_initialized", False):
            import asyncio
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            ok = loop.run_until_complete(self._service.initialize_async())
            loop.close()
            if not ok:
                return []
        # Call service with segments requested
        from src.domain.transcription.value_objects.transcription_request import TranscriptionRequest
        if isinstance(audio_data, (bytes, bytearray)):
            audio_data = io.BytesIO(audio_data)
        req = TranscriptionRequest(audio_input=audio_data, return_segments=True)
        import asyncio
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result_obj = loop.run_until_complete(self._service.transcribe_async(req))
        loop.close()
        return getattr(result_obj, "segments", None) or []
    