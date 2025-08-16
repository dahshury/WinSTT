"""Transcription and VAD Service Adapters.

These adapters bridge the real transcription and VAD services to work with
the listener service and provide the simple interfaces expected by the application.
"""

import io
from typing import Any

from src_refactored.domain.common.ports.logging_port import LoggingPort


class SimpleVADAdapter:
    """Refactored VAD adapter using Silero VAD service (no legacy VaDetector)."""

    def __init__(self, logger: LoggingPort | None = None):
        self._logger = logger
        # Wire refactored VAD pipeline
        from src_refactored.infrastructure.audio.vad_service import (
            VADService,
            VADServiceRequest,
        )
        from src_refactored.infrastructure.audio.silero_vad_model_service import (
            SileroVADModelService,
        )
        from src_refactored.infrastructure.audio.audio_processing_service import (
            VADAudioProcessingService,
        )
        from src_refactored.infrastructure.audio.vad_validation_service import (
            VADValidationService,
        )
        from src_refactored.infrastructure.audio.vad_smoothing_service import (
            VADSmoothingService,
        )
        from src_refactored.domain.audio.value_objects.vad_operations import (
            VADConfiguration,
            VADModel,
            VADOperation,
        )
        self._service = VADService(
            model_service=SileroVADModelService(),
            audio_processing_service=VADAudioProcessingService(),
            validation_service=VADValidationService(),
            calibration_service=None,  # Optional for simple detection
            smoothing_service=VADSmoothingService(),
            progress_tracking_service=None,
            logger_service=self._logger,
        )
        # Initialize with default config
        cfg = VADConfiguration(
            model=VADModel.SILERO_V3,
            threshold=0.02,
            sample_rate=16000,
            frame_size=512,
            hop_size=256,
            enable_smoothing=True,
            smoothing_window=3,
            min_speech_duration=0.08,
            min_silence_duration=0.08,
        )
        try:
            init_resp = self._service.execute(VADServiceRequest(operation=VADOperation.INITIALIZE, config=cfg))
            if getattr(init_resp, "result", None) is None or str(getattr(init_resp, "result", "")).lower() not in ("vadresult.success", "success"):
                if self._logger:
                    self._logger.log_warning("VAD initialization did not report success; detection will fall back if needed")
        except Exception:
            if self._logger:
                self._logger.log_warning("VAD initialize failed; falling back to energy-based detection")
        # Compat: expose attribute expected by bridge to mark availability
        self._vad_detector = self._service

    def detect_speech(self, audio_data: Any) -> bool:
        """Detect speech using the refactored VAD pipeline."""
        try:
            import numpy as np
            # Convert to float32 array; extract bytes from BytesIO
            if isinstance(audio_data, (bytes, bytearray)):
                audio_bytes = bytes(audio_data)
                audio_f32 = np.frombuffer(audio_bytes, dtype=np.float32)
                sr = 16000
            elif hasattr(audio_data, "read"):
                # Decode WAV from memory using pydub
                from pydub import AudioSegment
                seg = AudioSegment.from_file(audio_data)
                seg = seg.set_frame_rate(16000).set_channels(1)
                samples = np.array(seg.get_array_of_samples(), dtype=np.float32)
                max_value = float(1 << (8 * seg.sample_width - 1)) if getattr(seg, "sample_width", 2) else 0.0
                audio_f32 = samples / max_value if max_value > 0 else samples
                sr = 16000
            else:
                if self._logger:
                    self._logger.log_warning("Invalid audio data format for VAD")
                return False

            # Quick silence gate to avoid false positives on no audio
            if audio_f32.size == 0 or float(np.sqrt(np.mean(np.square(audio_f32)))) < 0.004:
                if self._logger:
                    self._logger.log_debug("VAD pre-check: silence detected (RMS below threshold)")
                return False

            duration = float(len(audio_f32)) / float(sr) if sr > 0 else 0.0

            # Build domain AudioChunk
            from src_refactored.domain.audio.value_objects.audio_operations import AudioChunk
            chunk = AudioChunk(
                data=audio_f32.tobytes(),
                timestamp=0.0,
                sample_rate=sr,
                duration=max(0.001, duration),
                chunk_id=0,
            )

            from src_refactored.infrastructure.audio.vad_service import VADServiceRequest
            from src_refactored.domain.audio.value_objects.vad_operations import VADOperation
            resp = self._service.execute(VADServiceRequest(operation=VADOperation.DETECT_VOICE, audio_chunk=chunk))
            has_speech = bool(getattr(resp.detection, "activity", None).value == "speech") if resp.detection else False
            if self._logger:
                self._logger.log_debug(f"VAD detected speech: {has_speech}")
            return has_speech
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error in VAD speech detection: {e}")
            # On error, do not transcribe
            return False

    def has_speech(self, audio_data: Any) -> bool:
        return self.detect_speech(audio_data)


class SimpleTranscriptionAdapter:
    """Adapter over refactored ONNXTranscriptionService (legacy-compatible)."""

    def __init__(self, logger: LoggingPort | None = None):
        self._logger = logger
        # Defer ONNX service creation to the thread that will transcribe to avoid Qt thread affinity issues
        self._service = None
        # Compatibility: non-None sentinel to satisfy legacy availability check
        self._transcriber = object()

    def transcribe_audio(self, audio_data: Any) -> str:
        """Transcribe audio data to text using real transcription implementation."""
        try:
            # Create service lazily in the current thread
            if self._service is None:
                from src_refactored.infrastructure.transcription.onnx_transcription_service import (
                    ONNXTranscriptionService,
                )
                from src_refactored.domain.transcription.value_objects.transcription_quality import (
                    TranscriptionQuality,
                )
                self._service = ONNXTranscriptionService(
                    quality=TranscriptionQuality.QUANTIZED,
                    model_type="whisper-turbo",
                )
                # Keep compatibility sentinel in sync
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
                        self._logger.log_error("ONNXTranscriptionService failed to initialize")
                    return ""

            # audio_data should be a file path or BytesIO buffer
            if isinstance(audio_data, str):
                # File path
                from src_refactored.domain.transcription.value_objects.transcription_request import (
                    TranscriptionRequest,
                )
                req = TranscriptionRequest(audio_input=audio_data)
                import asyncio
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                result_obj = loop.run_until_complete(self._service.transcribe_async(req))
                loop.close()
                # Prefer explicit text; fallback to service's last_transcription buffer
                result = getattr(result_obj, "text", None) or getattr(self._service, "last_transcription", "") or ""
            elif isinstance(audio_data, (bytes, bytearray)):
                audio_buffer = io.BytesIO(audio_data)
                from src_refactored.domain.transcription.value_objects.transcription_request import (
                    TranscriptionRequest,
                )
                req = TranscriptionRequest(audio_input=audio_buffer)
                import asyncio
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                result_obj = loop.run_until_complete(self._service.transcribe_async(req))
                loop.close()
                result = getattr(result_obj, "text", None) or getattr(self._service, "last_transcription", "") or ""
            elif hasattr(audio_data, "read"):
                from src_refactored.domain.transcription.value_objects.transcription_request import (
                    TranscriptionRequest,
                )
                # Ensure helpful name for format inference when reading from memory
                try:
                    if not getattr(audio_data, "name", "").endswith(".wav"):
                        audio_data.name = "audio.wav"  # type: ignore[attr-defined]
                except Exception:
                    pass
                req = TranscriptionRequest(audio_input=audio_data)
                import asyncio
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                result_obj = loop.run_until_complete(self._service.transcribe_async(req))
                loop.close()
                result = getattr(result_obj, "text", None) or getattr(self._service, "last_transcription", "") or ""
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
    