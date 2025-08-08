"""LLM PyQt Worker Infrastructure Service.

This module provides LLM worker functionality with PyQt threading,
model initialization, and text generation capabilities.
"""

import logging
from typing import Any

from PyQt6.QtCore import QObject, pyqtSignal


class LLMPyQtWorkerService(QObject):
    """LLM worker with PyQt threading support.
    
    This service manages LLM model lifecycle within PyQt's threading model,
    providing signals for initialization, errors, and inference completion.
    
    Signals:
        initialized: Emitted when LLM model is successfully initialized
        error: Emitted when LLM operations fail
        inference_complete: Emitted when text generation is complete
        display_message_signal: Emitted for progress updates
    """

    initialized = pyqtSignal()
    error = pyqtSignal(str)
    inference_complete = pyqtSignal(str)
    display_message_signal = pyqtSignal(object,
    object, object, object, object)  # txt, filename, percentage, hold, reset

    def __init__(self, model_type: str = "gemma-3-1b-it", quantization: str = "Full"):
        """Initialize the LLM PyQt worker service.
        
        Args:
            model_type: The type of LLM model to use
            quantization: The quantization level for the model
        """
        super().__init__()
        self.model_type = model_type
        self.quantization = quantization
        self.status = False
        self.inference_session: Any | None = None
        self.tokenizer: Any | None = None
        self.config: Any | None = None

    def run(self) -> None:
        """Initialize the LLM model.
        
        This method should be called from a worker thread to avoid
        blocking the UI during model initialization.
        """
        try:
            # Log initialization
            logger = logging.getLogger(__name__)
            logger.debug(f"Initializing LLM model: {self.model_type} with quantization: {self.quantization}")

            # Import gemma inference module
            from . import gemma_inference_service as gemma_inference

            # Determine repo ID based on model type
            repo_id = f"onnx-community/{self.model_type}-ONNX"

            # Display downloading message
            self.display_message_signal.emit("Downloading Gemma model...", None, 0, False, None)

            # Load config, tokenizer, and session using the gemma_inference module
            self.config, self.tokenizer, self.inference_session = gemma_inference.load_model(
                repo_id=repo_id,
                cache_path=None,  # Use default cache path
                display_message_signal=self.display_message_signal,
                quantization=self.quantization,
            )

            self.toggle_status()
            self.initialized.emit()

        except Exception as e:
            error_msg = f"Failed to initialize LLM model: {e}"
            self.error.emit(error_msg)

            # Log the error
            logging.getLogger(__name__).exception(error_msg)

    def toggle_status(self,
    ) -> None:
        """Toggle the status of the LLM worker."""
        self.status = not self.status

    def generate_response(
    self,
    user_prompt: str,
    system_prompt: str = "You are a helpful assistant.") -> str:
        """Generate a response using the loaded LLM model.
        
        Args:
            user_prompt: The user's input prompt
            system_prompt: The system prompt to guide the model
            
        Returns:
            The generated response text
        """
        try:
            if not self.inference_session or not self.tokenizer or not self.config:
                error_msg = "Error: LLM model not initialized"

                # Log the error
                logging.getLogger(__name__).error("LLM model not initialized")

                return error_msg

            # Prepare messages format
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ]

            # Use the gemma_inference module to generate text
            from . import gemma_inference_service as gemma_inference
            generated_text, _ = gemma_inference.generate_text(
                self.config,
                self.tokenizer,
                self.inference_session,
                messages,
            )

            return generated_text

        except Exception as e:
            error_msg = f"Error generating response: {e!s}"

            # Log the error
            logging.getLogger(__name__).exception(f"Error generating LLM response: {e!s}")

            return error_msg

    def is_initialized(self,
    ) -> bool:
        """Check if the LLM model is initialized.
        
        Returns:
            True if model is initialized, False otherwise
        """
        return all([self.inference_session, self.tokenizer, self.config])

    def get_status(self) -> bool:
        """Get the current status of the LLM worker.
        
        Returns:
            The current status
        """
        return self.status

    def get_model_info(self) -> dict[str, str]:
        """Get information about the loaded model.
        
        Returns:
            Dictionary containing model information
        """
        return {
            "model_type": self.model_type,
            "quantization": self.quantization,
            "status": str(self.status),
            "initialized": str(self.is_initialized()),
        }

    def cleanup(self) -> None:
        """Clean up model resources."""
        self.inference_session = None
        self.tokenizer = None
        self.config = None
        self.status = False


class LLMPyQtWorkerManager:
    """High-level manager for LLM PyQt worker operations.
    
    This manager provides a simplified interface for LLM worker
    lifecycle management and text generation operations.
    """

    def __init__(self):
        """Initialize the LLM PyQt worker manager."""
        self._workers: list[LLMPyQtWorkerService] = []

    def create_worker(self, model_type: str = "gemma-3-1b-it", quantization: str = "Full",
    ) -> LLMPyQtWorkerService:
        """Create a new LLM PyQt worker.
        
        Args:
            model_type: The type of LLM model to use
            quantization: The quantization level for the model
            
        Returns:
            A new LLMPyQtWorkerService instance
        """
        worker = LLMPyQtWorkerService(model_type, quantization)
        self._workers.append(worker)
        return worker

    def initialize_worker(self, worker: LLMPyQtWorkerService,
    ) -> None:
        """Initialize an LLM PyQt worker.
        
        Args:
            worker: The LLM PyQt worker to initialize
        """
        worker.run()

    def generate_text(self,
    worker: LLMPyQtWorkerService,
    user_prompt: str,
    system_prompt: str = "You are a helpful assistant.",
    ) -> str:
        """Generate text using an LLM PyQt worker.
        
        Args:
            worker: The LLM PyQt worker to use
            user_prompt: The user's input prompt
            system_prompt: The system prompt to guide the model
            
        Returns:
            The generated response text
        """
        return worker.generate_response(user_prompt, system_prompt)

    def cleanup_workers(self) -> None:
        """Clean up all LLM PyQt workers."""
        for worker in self._workers:
            worker.cleanup()
        self._workers.clear()

    def get_initialized_workers(self) -> list[LLMPyQtWorkerService]:
        """Get all initialized LLM PyQt workers.
        
        Returns:
            List of initialized LLMPyQtWorkerService instances
        """
        return [worker for worker in self._workers if worker.is_initialized()]

    def get_all_workers(self) -> list[LLMPyQtWorkerService]:
        """Get all LLM PyQt workers.
        
        Returns:
            List of all LLMPyQtWorkerService instances
        """
        return self._workers.copy()

    def get_worker_by_model_type(self, model_type: str,
    ) -> LLMPyQtWorkerService | None:
        """Get an LLM PyQt worker by model type.
        
        Args:
            model_type: The model type to search for
            
        Returns:
            The LLMPyQtWorkerService instance if found, None otherwise
        """
        for worker in self._workers:
            if worker.model_type == model_type:
                return worker
        return None