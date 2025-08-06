"""LLM Worker infrastructure service for handling language model operations."""

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from src_refactored.domain.transcription.value_objects import ProgressCallback

logger = logging.getLogger(__name__)


class LLMError(Exception):
    """Exception raised when LLM operations fail."""


class LLMWorkerService:
    """Infrastructure service for LLM model operations."""

    def __init__(self, progress_callback: ProgressCallback | None = None):
        """Initialize the LLM worker service.
        
        Args:
            progress_callback: Optional callback for progress updates
        """
        self.progress_callback = progress_callback
        self.model_type = None
        self.quantization = None
        self.status = False
        self.inference_session = None
        self.tokenizer = None
        self.config = None
        self._initialized = False

    def initialize_model(self, model_type: str = "gemma-3-1b-it",
                        quantization: str = "Full") -> None:
        """Initialize the LLM model.
        
        Args:
            model_type: Type of model to load
            quantization: Quantization level
            
        Raises:
            LLMError: If model initialization fails
        """
        try:
            self.model_type = model_type
            self.quantization = quantization

            logger.debug(f"Initializing LLM model: {model_type} with quantization: {quantization}")

            # Import here to avoid circular dependencies
            from . import gemma_inference_service as gemma_inference

            # Repo ID based on model type
            repo_id = f"onnx-community/{model_type}-ONNX"

            # Display downloading message
            if self.progress_callback:
                self.progress_callback(txt="Downloading Gemma model...",
    )

            # Load config, tokenizer, and session using the gemma_inference module
            self.config, self.tokenizer, self.inference_session = gemma_inference.load_model(
                repo_id=repo_id,
                cache_path=None,  # Use default cache path
                display_message_signal=self._create_display_signal_adapter(),
                quantization=quantization,
            )

            self.status = True
            self._initialized = True

            if self.progress_callback:
                self.progress_callback(txt=f"LLM Model Initialized: {model_type}")

        except Exception as e:
            error_msg = f"Failed to initialize LLM model: {e}"
            logger.exception(error_msg)
            raise LLMError(error_msg)

    def _create_display_signal_adapter(self,
    ) -> Callable | None:
        """Create an adapter for the display signal to work with progress callback.
        
        Returns:
            Adapter function or None if no progress callback
        """
        if not self.progress_callback:
            return None

        def signal_adapter(txt=None, filename=None, percentage=None, hold=False, reset=None):
            """Adapter to convert display signal to progress callback."""
            if txt:
                self.progress_callback(txt=txt)

        return signal_adapter

    def is_initialized(self) -> bool:
        """Check if the model is initialized.
        
        Returns:
            True if model is initialized, False otherwise
        """
        return self._initialized and self.status

    def generate_response(self, user_prompt: str,
                         system_prompt: str = "You are a helpful assistant.") -> str:
        """Generate a response using the loaded LLM model.
        
        Args:
            user_prompt: User's input prompt
            system_prompt: System prompt for context
            
        Returns:
            Generated response text
            
        Raises:
            LLMError: If model is not initialized or generation fails
        """
        if not self.is_initialized():
            msg = "LLM model not initialized"
            raise LLMError(msg)

        try:
            if not self.inference_session or not self.tokenizer or not self.config:
                msg = "LLM model components not properly loaded"
                raise LLMError(msg,
    )

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
            error_msg = f"Error generating LLM response: {e}"
            logger.exception(error_msg)
            raise LLMError(error_msg)

    def get_model_info(self,
    ) -> dict[str, Any]:
        """Get information about the current model.
        
        Returns:
            Dictionary containing model information
        """
        return {
            "model_type": self.model_type,
            "quantization": self.quantization,
            "status": self.status,
            "initialized": self._initialized,
            "has_session": self.inference_session is not None,
            "has_tokenizer": self.tokenizer is not None,
            "has_config": self.config is not None,
        }

    def cleanup(self) -> None:
        """Clean up model resources."""
        try:
            if self.inference_session:
                # Clean up ONNX session if it has cleanup methods
                if hasattr(self.inference_session, "close"):
                    self.inference_session.close()
                self.inference_session = None

            self.tokenizer = None
            self.config = None
            self.status = False
            self._initialized = False

            if self.progress_callback:
                self.progress_callback(txt="LLM model resources cleaned up")

        except Exception as e:
            logger.warning(f"Error during LLM cleanup: {e}")

    def get_supported_models(self) -> list[str]:
        """Get list of supported model types.
        
        Returns:
            List of supported model type strings
        """
        return [
            "gemma-3-1b-it",
            "gemma-3-2b-it",
            "gemma-3-8b-it",
            "gemma-2-2b-it",
            "gemma-2-9b-it",
            "gemma-2-27b-it",
        ]

    def get_supported_quantizations(self) -> list[str]:
        """Get list of supported quantization levels.
        
        Returns:
            List of supported quantization strings
        """
        return [
            "Full",
            "INT8",
            "INT4",
            "FP16",
        ]

    def validate_model_config(self, model_type: str, quantization: str,
    ) -> bool:
        """Validate model configuration.
        
        Args:
            model_type: Model type to validate
            quantization: Quantization level to validate
            
        Returns:
            True if configuration is valid, False otherwise
        """
        return (model_type in self.get_supported_models() and
                quantization in self.get_supported_quantizations())

    def get_model_cache_path(self, model_type: str,
    ) -> Path:
        """Get the cache path for a specific model.
        
        Args:
            model_type: Model type
            
        Returns:
            Path to model cache directory
        """
        # This would typically use the same cache logic as the original
        import os
        from pathlib import Path

        cache_dir = os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")
        repo_id = f"onnx-community/{model_type}-ONNX"

        # Convert repo_id to valid directory name
        safe_repo_id = repo_id.replace("/", "--")
        return Path(cache_dir) / "hub" / f"models--{safe_repo_id}"

    def is_model_cached(self, model_type: str,
    ) -> bool:
        """Check if a model is already cached locally.
        
        Args:
            model_type: Model type to check
            
        Returns:
            True if model is cached, False otherwise
        """
        cache_path = self.get_model_cache_path(model_type)
        return cache_path.exists() and any(cache_path.iterdir())

    def estimate_model_size(self, model_type: str, quantization: str,
    ) -> str:
        """Estimate the download size for a model.
        
        Args:
            model_type: Model type
            quantization: Quantization level
            
        Returns:
            Estimated size as string (e.g., "2.5 GB")
        """
        # Rough estimates based on model type and quantization
        base_sizes = {
            "gemma-3-1b-it": 2.0,  # GB
            "gemma-3-2b-it": 4.0,
            "gemma-3-8b-it": 16.0,
            "gemma-2-2b-it": 4.0,
            "gemma-2-9b-it": 18.0,
            "gemma-2-27b-it": 54.0,
        }

        quantization_multipliers = {
            "Full": 1.0,
            "FP16": 0.5,
            "INT8": 0.25,
            "INT4": 0.125,
        }

        base_size = base_sizes.get(model_type, 2.0)
        multiplier = quantization_multipliers.get(quantization, 1.0)
        estimated_size = base_size * multiplier

        if estimated_size < 1.0:
            return f"{estimated_size * 1024:.0f} MB"
        return f"{estimated_size:.1f} GB"