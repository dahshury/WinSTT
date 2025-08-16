import contextlib
import gc
import io

# Suppress transformers warning about PyTorch/TensorFlow/Flax before any imports
import logging

logging.getLogger("transformers").setLevel(logging.ERROR)

from PyQt6.QtCore import QObject, QThread, pyqtSignal

from src_refactored.application.listener.audio_to_text_config import AudioToTextConfig

# Bridge to refactored architecture (replace legacy listener usage only)
from src_refactored.application.listener.audio_to_text_service import AudioToTextService
from src_refactored.infrastructure.adapters.transcription_adapter import (
    SimpleTranscriptionAdapter,
    SimpleVADAdapter,
)
from src_refactored.infrastructure.system_integration.keyboard_hook_adapter import (
    KeyboardHookAdapter,
)
from utils.logger_compat import setup_logger
from utils.transcribe import VaDetector, WhisperONNXTranscriber

logger = setup_logger()

# Audio to text adapter that adds PyQt signals without modifying the original class
class PyQtAudioToText(QObject):
    """
    Adapter that bridges to the refactored AudioToTextService and emits PyQt signals.
    This replaces the legacy utils.listener.AudioToText usage while preserving
    VAD/transcriber imports elsewhere in this module.
    """

    recording_started_signal = pyqtSignal()
    recording_stopped_signal = pyqtSignal()

    def __init__(self, model_cls, vad_cls, rec_key=None, error_callback=None):
        super().__init__()
        # Keep API compatible (model_cls, vad_cls unused by design here)
        self._rec_key = rec_key or ""
        # Use refactored adapters that internally use utils.transcribe
        self._transcriber = SimpleTranscriptionAdapter()
        self._vad = SimpleVADAdapter()
        self._service = AudioToTextService(
            config=AudioToTextConfig(rec_key=self._rec_key),
            transcriber=self._transcriber,
            vad=self._vad,
        )
        self._kb = KeyboardHookAdapter()

    def capture_keys(self, rec_key=None):
        key_combo = (rec_key or self._rec_key) or ""
        self._kb.start()
        self._kb.unregister_hotkey("worker_rec_hotkey")

        def _pressed(_):
            # Emit started only when transitioning
            self._service.start_recording()
            self.recording_started_signal.emit()

        def _released(_):
            self._service.stop_recording()
            self.recording_stopped_signal.emit()

        self._kb.register_hotkey("worker_rec_hotkey", key_combo, _pressed, _released)

    def shutdown(self):
        with contextlib.suppress(Exception):
            self._service.shutdown()
        with contextlib.suppress(Exception):
            self._kb.shutdown()

    # Minimal delegation for compatibility
    def __getattr__(self, name):
        return getattr(self._service, name)

class VadWorker(QObject):
    initialized = pyqtSignal()
    error = pyqtSignal(str)
    
    def __init__(self):
        super().__init__()
        self.status = False

    def run(self):
        try:
            self.vad = VaDetector()
            self.initialized.emit()
            self.toggle_status()
        except Exception as e:
            self.error.emit(f"Failed to initialize VAD: {e}")
            logger.debug(f"Failed to initialize VAD: {e}")
            
    def toggle_status(self):
        if not self.status:
            self.status = True
        else:
            self.status = False
        
class ModelWorker(QObject):
    error = pyqtSignal(str)
    display_message_signal = pyqtSignal(object, object, object, object, object)# txt=None, filename=None, percentage=None, hold=False, reset=None
    initialized = pyqtSignal()
    def __init__(self, model_type="whisper-turbo", quantization=None):
        super().__init__()
        self.model_type = model_type
        self.quantization = quantization
        self.status = False

    def run(self):
        try:
            logger.debug(f"Initializing model type: {self.model_type} with quantization: {self.quantization}")
            
            # Initialize the WhisperONNXTranscriber (using the real implementation from utils/)
            # Note: The real implementation now supports organized cache structure
            self.model = WhisperONNXTranscriber(
                q=self.quantization,
                display_message_signal=self.display_message_signal,
                model_type=self.model_type,
            )
            
            self.initialized.emit()
            self.toggle_status()
        except Exception as e:
            self.error.emit(f"Failed to initialize model: {e}")
            logger.exception(f"Failed to initialize model: {e}")
            
    def toggle_status(self):
        if not self.status:
            self.status = True
        else:
            self.status = False
    
    def transcript_file(self, file_path):
        """
        Transcribe an audio file using the model.
        Returns the transcription and segments in a dictionary.
        """
        try:
            if not hasattr(self, "model"):
                logger.error("Model not initialized")
                return None
                
            # Determine what to log based on the file_path type
            if isinstance(file_path, io.BytesIO):
                # Check if we have the original filename stored on the BytesIO object
                if hasattr(file_path, "original_filename"):
                    logger.debug(f"Transcribing memory buffer for: {file_path.original_filename}")
                else:
                    logger.debug("Transcribing memory buffer")
            else:
                # Regular file path
                logger.debug(f"Transcribing file: {file_path}")
            
            # Transcribe the file
            text = self.model.transcribe(file_path)
            
            # Get segmentation information
            segments = self.model.get_segments()
            
            # Return results in a dictionary
            return {
                "text": text,
                "segments": segments,
            }
        except Exception as e:
            logger.exception(f"Error transcribing file: {e!s}")
            return None

class ListenerWorker(QObject):
    transcription_ready = pyqtSignal(str)
    error = pyqtSignal(str)
    initialized = pyqtSignal()
    recording_started = pyqtSignal()
    recording_stopped = pyqtSignal()
    display_message_signal = pyqtSignal(object, object, object, object, object)# txt=None, filename=None, percentage=None, hold=False, reset=None
    terminate_signal = pyqtSignal()
    
    def __init__(self, model, vad, rec_key):
        super().__init__()
        self._running = None
        # Use the PyQt adapter instead of directly using AudioToText
        self.listener = PyQtAudioToText(model, vad, rec_key, error_callback=self.display_message_signal)
        self.rec_key = rec_key
        
        # Connect directly to signals from the adapter
        self.listener.recording_started_signal.connect(self.recording_started.emit)
        self.listener.recording_stopped_signal.connect(self.recording_stopped.emit)

    def _setup_recording_hooks(self):
        """
        This method is now deprecated. 
        State monitoring is done via direct signals from PyQtAudioToText.
        """
        # Method kept for backward compatibility but no longer needed

    def run(self):
        try:
            self.listener.capture_keys(self.rec_key)
            self.initialized.emit()
            self._running = True
            while self._running:
                QThread.msleep(10)
        except Exception as e:
            self.error.emit(f"Listener Error: {e}")
            logger.debug(f"Listener Error: {e}")
        finally:
            self.listener.shutdown()
            del self.listener
            gc.collect()
            
    def stop(self):
        self._running = False
        self.terminate_signal.emit()

class LLMWorker(QObject):
    initialized = pyqtSignal()
    error = pyqtSignal(str)
    inference_complete = pyqtSignal(str)
    display_message_signal = pyqtSignal(object, object, object, object, object)  # txt=None, filename=None, percentage=None, hold=False, reset=None
    
    def __init__(self, model_type="gemma-3-1b-it", quantization="Full"):
        super().__init__()
        self.model_type = model_type
        self.quantization = quantization
        self.status = False
        self.inference_session = None
        self.tokenizer = None
        self.config = None
        
    def run(self):
        try:
            logger.debug(f"Initializing LLM model: {self.model_type} with quantization: {self.quantization}")
            
            from src.core.utils import gemma_inference
            
            # Repo ID based on model type
            repo_id = f"onnx-community/{self.model_type}-ONNX"
            
            # Display downloading message
            self.display_message_signal.emit("Downloading Gemma model...", None, 0, False, None)
            
            # Load config, tokenizer, and session using the gemma_inference module
            # Pass the display_message_signal to show download progress
            self.config, self.tokenizer, self.inference_session = gemma_inference.load_model(
                repo_id=repo_id,
                cache_path=None,  # Use default cache path
                display_message_signal=self.display_message_signal,
                quantization=self.quantization,
            )
            
            self.toggle_status()
            self.initialized.emit()
            
        except Exception as e:
            self.error.emit(f"Failed to initialize LLM model: {e}")
            logger.exception(f"Failed to initialize LLM model: {e}")
    
    def toggle_status(self):
        if not self.status:
            self.status = True
        else:
            self.status = False
    
    def generate_response(self, user_prompt, system_prompt="You are a helpful assistant."):
        """
        Generate a response using the loaded Gemma model
        """
        try:
            if not self.inference_session or not self.tokenizer or not self.config:
                logger.error("LLM model not initialized")
                return "Error: LLM model not initialized"
            
            # Prepare messages format
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ]
            
            # Use the gemma_inference module to generate text
            from src.core.utils import gemma_inference
            generated_text, _ = gemma_inference.generate_text(
                self.config, 
                self.tokenizer, 
                self.inference_session, 
                messages,
            )
            
            return generated_text
            
        except Exception as e:
            logger.exception(f"Error generating LLM response: {e!s}")
            return f"Error generating response: {e!s}"