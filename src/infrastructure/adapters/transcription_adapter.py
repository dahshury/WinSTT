"""Transcription and VAD Service Adapters.

These adapters bridge the real transcription and VAD services to work with
the listener service and provide the simple interfaces expected by the application.
"""

import io
from typing import Any

from src.domain.common.ports.logging_port import LoggingPort


class SimpleVADAdapter:
    """Refactored VAD adapter using Silero VAD service (no legacy VaDetector)."""

    def __init__(self, logger: LoggingPort | None = None):
        self._logger = logger
        # Wire refactored VAD pipeline
        from src.domain.audio.value_objects.vad_operations import (
            VADConfiguration,
            VADModel,
            VADOperation,
        )
        from src.infrastructure.audio.audio_processing_service import (
            VADAudioProcessingService,
        )
        from src.infrastructure.audio.silero_vad_model_service import (
            SileroVADModelService,
        )
        from src.infrastructure.audio.vad_service import (
            VADService,
            VADServiceRequest,
        )
        from src.infrastructure.audio.vad_smoothing_service import (
            VADSmoothingService,
        )
        from src.infrastructure.audio.vad_validation_service import (
            VADValidationService,
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
        # Initialize asynchronously to avoid blocking UI startup on first run
        def _init_vad_async() -> None:
            try:
                init_resp = self._service.execute(
                    VADServiceRequest(operation=VADOperation.INITIALIZE, config=cfg),
                )
                if (
                    getattr(init_resp, "result", None) is None
                    or str(getattr(init_resp, "result", "")).lower()
                    not in ("vadresult.success", "success")
                ):
                    if self._logger:
                        self._logger.log_warning(
                            "VAD initialization did not report success; detection will fall back if needed",
                        )
            except Exception:
                if self._logger:
                    self._logger.log_warning(
                        "VAD initialize failed; falling back to energy-based detection",
                    )

        try:
            import threading as _threading
            _threading.Thread(target=_init_vad_async, daemon=True).start()
        except Exception:
            # Best-effort fallback to sync init if threading unavailable
            _init_vad_async()
        # Compat: expose attribute expected by bridge to mark availability
        self._vad_detector = self._service

    def detect_speech(self, audio_data: Any) -> bool:
        """Detect speech using the refactored VAD pipeline."""
        try:
            import numpy as np
            # Convert to float32 array; extract bytes from BytesIO
            if isinstance(audio_data, bytes | bytearray):
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
            from src.domain.audio.value_objects.audio_operations import AudioChunk
            chunk = AudioChunk(
                data=audio_f32.tobytes(),
                timestamp=0.0,
                sample_rate=sr,
                duration=max(0.001, duration),
                chunk_id=0,
            )

            from src.domain.audio.value_objects.vad_operations import VADOperation
            from src.infrastructure.audio.vad_service import VADServiceRequest
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
                from src.domain.transcription.value_objects.transcription_configuration import (
                    TranscriptionConfiguration,
                )
                from src.domain.transcription.value_objects.transcription_quality import (
                    TranscriptionQuality,
                )
                from src.infrastructure.transcription.onnx_model_loader import OnnxModelLoader
                from src.infrastructure.transcription.onnx_transcription_service import (
                    ONNXTranscriptionService,
                )
                from src.infrastructure.transcription.whisper_artifacts_service import (
                    WhisperArtifactsService,
                )

                def _progress_cb(current: int, total: int, message: str) -> None:
                    try:
                        if self._ui_status_callback is None:
                            return
                        percent = int((current / total) * 100) if total and total > 0 else None
                        self._ui_status_callback(message, None, percent, True, None)
                    except Exception:
                        pass

                config = TranscriptionConfiguration(quality=TranscriptionQuality.QUANTIZED)
                # Prepare runtime sessions and artifacts
                from src.domain.transcription.value_objects.model_download_config import (
                    ModelDownloadConfig,
                )

                # Resolve cache directory using resource service
                from src.infrastructure.common.resource_service import resource_path
                from src.infrastructure.transcription.model_download_service import (
                    ModelDownloadService,
                )
                cache_root = resource_path("src/cache")
                loader = OnnxModelLoader(cache_path=cache_root, model_type="whisper-turbo", quality=config.quality)
                if not loader.are_models_present():
                    # Best-effort download (non-interactive); progress shown via UI callback
                    # We intentionally avoid wiring signals here and rely on status callback
                    ModelDownloadService(ModelDownloadConfig(cache_path=cache_root, model_type="whisper-turbo", quality=config.quality)).download_whisper_models()
                sessions = loader.load_sessions()
                artifacts_service = WhisperArtifactsService()
                tokenizer, feature_extractor, model_cfg, gen_cfg = artifacts_service.get_artifacts(loader.get_model_cache_dir())
                self._service = ONNXTranscriptionService(
                    quality=TranscriptionQuality.QUANTIZED,
                    model_type="whisper-turbo",
                    display_message_callback=self._ui_status_callback,
                    progress_callback=_progress_cb if self._ui_status_callback else None,
                    configuration=config,
                    runtime_sessions=sessions,
                    tokenizer=tokenizer,
                    feature_extractor=feature_extractor,
                    model_config=model_cfg,
                    generation_config=gen_cfg,
                )
                # Keep compatibility sentinel in sync
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
                from src.domain.transcription.value_objects.transcription_configuration import (
                    TranscriptionConfiguration,
                )
                from src.domain.transcription.value_objects.transcription_quality import (
                    TranscriptionQuality,
                )
                from src.infrastructure.transcription.onnx_model_loader import OnnxModelLoader
                from src.infrastructure.transcription.onnx_transcription_service import (
                    ONNXTranscriptionService,
                )
                from src.infrastructure.transcription.whisper_artifacts_service import (
                    WhisperArtifactsService,
                )
                # Map progress callback to UI status updates
                def _progress_cb(current: int, total: int, message: str) -> None:
                    try:
                        if self._ui_status_callback is None:
                            return
                        percent = int((current / total) * 100) if total and total > 0 else None
                        self._ui_status_callback(message, None, percent, True, None)
                    except Exception:
                        pass

                config = TranscriptionConfiguration(quality=TranscriptionQuality.QUANTIZED)
                # Prepare runtime sessions and artifacts
                from src.domain.transcription.value_objects.model_download_config import (
                    ModelDownloadConfig,
                )
                from src.infrastructure.common.resource_service import resource_path
                from src.infrastructure.transcription.model_download_service import (
                    ModelDownloadService,
                )
                cache_root = resource_path("src/cache")
                loader = OnnxModelLoader(cache_path=cache_root, model_type="whisper-turbo", quality=config.quality)
                if not loader.are_models_present():
                    ModelDownloadService(ModelDownloadConfig(cache_path=cache_root, model_type="whisper-turbo", quality=config.quality)).download_whisper_models()
                sessions = loader.load_sessions()
                artifacts_service = WhisperArtifactsService()
                tokenizer, feature_extractor, model_cfg, gen_cfg = artifacts_service.get_artifacts(loader.get_model_cache_dir())
                self._service = ONNXTranscriptionService(
                    quality=TranscriptionQuality.QUANTIZED,
                    model_type="whisper-turbo",
                    display_message_callback=self._ui_status_callback,
                    progress_callback=_progress_cb if self._ui_status_callback else None,
                    configuration=config,
                    runtime_sessions=sessions,
                    tokenizer=tokenizer,
                    feature_extractor=feature_extractor,
                    model_config=model_cfg,
                    generation_config=gen_cfg,
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
                from src.domain.transcription.value_objects.transcription_request import (
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
            elif isinstance(audio_data, bytes | bytearray):
                audio_buffer = io.BytesIO(audio_data)
                from src.domain.transcription.value_objects.transcription_request import (
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
                from src.domain.transcription.value_objects.transcription_request import (
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
    