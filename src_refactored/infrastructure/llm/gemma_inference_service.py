"""Gemma Inference Service for LLM model operations.

This module provides infrastructure services for loading and running
Gemma ONNX models with progress tracking and PyQt signal integration.
"""

import gc
from collections.abc import Callable
from pathlib import Path
from typing import Any

try:
    import numpy as np
    import onnxruntime as ort
    from huggingface_hub import snapshot_download
    from transformers import AutoConfig, AutoTokenizer
except ImportError as e:
    msg = f"Required dependencies not installed: {e}"
    raise ImportError(msg)


class GemmaInferenceError(Exception):
    """Exception raised for Gemma inference errors."""


class GemmaInferenceService:
    """Service for Gemma ONNX model inference operations."""

    def __init__(self,
progress_callback: Callable[[str, str | None, float | None, bool, bool | None], None] | None = None):
        """Initialize the Gemma inference service.
        
        Args:
            progress_callback: Optional callback for progress updates
                              (message, filename, percentage, hold, reset)
        """
        self.progress_callback = progress_callback
        self._default_cache_path = Path.home() / ".cache" / "huggingface" / "hub"

    def load_model(self, repo_id: str, cache_path: str | None = None,
                   quantization: str = "Full",
    ) -> tuple[Any, Any, Any]:
        """Load Gemma model configuration, tokenizer, and ONNX session.
        
        Args:
            repo_id: HuggingFace repository ID (e.g., 'onnx-community/gemma-3-1b-it-ONNX')
            cache_path: Optional custom cache path
            quantization: Quantization level ('Full', 'Quantized', etc.)
            
        Returns:
            Tuple of (config, tokenizer, inference_session)
            
        Raises:
            GemmaInferenceError: If model loading fails
        """
        try:
            if self.progress_callback:
                self.progress_callback("Downloading Gemma model...", None, 0, False, None)

            # Set cache path
            if cache_path is None:
                cache_path = str(self._default_cache_path)

            # Download model files
            model_path = self._download_model(repo_id, cache_path)

            if self.progress_callback:
                self.progress_callback("Loading model configuration...", None, 30, False, None)

            # Load configuration
            config = AutoConfig.from_pretrained(model_path)

            if self.progress_callback:
                self.progress_callback("Loading tokenizer...", None, 50, False, None)

            # Load tokenizer
            tokenizer = AutoTokenizer.from_pretrained(model_path)

            if self.progress_callback:
                self.progress_callback("Initializing ONNX session...", None, 70, False, None)

            # Load ONNX model
            onnx_model_path = self._get_onnx_model_path(model_path, quantization)
            inference_session = self._create_onnx_session(onnx_model_path)

            if self.progress_callback:
                self.progress_callback("Model loaded successfully!", None, 100, False, None)

            return config, tokenizer, inference_session

        except Exception as e:
            error_msg = f"Failed to load Gemma model: {e}"
            if self.progress_callback:
                self.progress_callback(error_msg, None, 0, True, None)
            raise GemmaInferenceError(error_msg)

    def generate_text(self, config: Any, tokenizer: Any, session: Any,
                     messages: list[dict[str, str]], max_length: int = 512,
                     temperature: float = 0.7,
    ) -> tuple[str, dict[str, Any]]:
        """Generate text using the loaded Gemma model.
        
        Args:
            config: Model configuration
            tokenizer: Tokenizer instance
            session: ONNX inference session
            messages: List of message dictionaries with 'role' and 'content'
            max_length: Maximum generation length
            temperature: Sampling temperature
            
        Returns:
            Tuple of (generated_text, generation_info)
            
        Raises:
            GemmaInferenceError: If text generation fails
        """
        try:
            # Format messages into prompt
            prompt = self._format_messages(messages, tokenizer)

            # Tokenize input
            inputs = tokenizer(prompt, return_tensors="np", padding=True, truncation=True)
            input_ids = inputs["input_ids"]
            attention_mask = inputs["attention_mask"]

            # Generate text
            generated_ids = self._generate_tokens(
                session, input_ids, attention_mask, max_length, temperature,
            )

            # Decode generated text
            generated_text = tokenizer.decode(
                generated_ids[0][len(input_ids[0]):],
                skip_special_tokens=True,
            )

            generation_info = {
                "input_length": len(input_ids[0]),
                "output_length": len(generated_ids[0]),
                "temperature": temperature,
                "max_length": max_length,
            }

            return generated_text.strip(), generation_info

        except Exception as e:
            msg = f"Text generation failed: {e}"
            raise GemmaInferenceError(msg,
    )

    def _download_model(self, repo_id: str, cache_path: str,
    ) -> str:
        """Download model from HuggingFace Hub.
        
        Args:
            repo_id: Repository ID
            cache_path: Cache directory path
            
        Returns:
            Path to downloaded model
        """
        try:
            return snapshot_download(
                repo_id=repo_id,
                cache_dir=cache_path,
                resume_download=True,
            )
        except Exception as e:
            msg = f"Model download failed: {e}"
            raise GemmaInferenceError(msg,
    )

    def _get_onnx_model_path(self, model_path: str, quantization: str,
    ) -> str:
        """Get the ONNX model file path based on quantization.
        
        Args:
            model_path: Base model directory path
            quantization: Quantization level
            
        Returns:
            Path to ONNX model file
        """
        model_dir = Path(model_path)

        # Common ONNX file patterns
        onnx_patterns = [
            "model.onnx",
            "model_quantized.onnx",
            "onnx/model.onnx",
            "onnx/model_quantized.onnx",
        ]

        # Try to find ONNX file
        for pattern in onnx_patterns:
            onnx_path = model_dir / pattern
            if onnx_path.exists():
                return str(onnx_path)

        # If no specific file found, look for any .onnx file
        onnx_files = list(model_dir.rglob("*.onnx"))
        if onnx_files:
            return str(onnx_files[0])

        msg = f"No ONNX model file found in {model_path}"
        raise GemmaInferenceError(msg)

    def _create_onnx_session(self, model_path: str,
    ) -> Any:
        """Create ONNX Runtime inference session.
        
        Args:
            model_path: Path to ONNX model file
            
        Returns:
            ONNX Runtime inference session
        """
        try:
            # Configure session options for better performance
            session_options = ort.SessionOptions()
            session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

            # Create inference session
            providers = ["CPUExecutionProvider"]
            if ort.get_available_providers():
                # Use GPU if available
                available_providers = ort.get_available_providers()
                if "CUDAExecutionProvider" in available_providers:
                    providers.insert(0, "CUDAExecutionProvider")

            return ort.InferenceSession(
                model_path,
                sess_options=session_options,
                providers=providers,
            )


        except Exception as e:
            msg = f"Failed to create ONNX session: {e}"
            raise GemmaInferenceError(msg)

    def _format_messages(self, messages: list[dict[str, str]], tokenizer: Any,
    ) -> str:
        """Format messages into a prompt string.
        
        Args:
            messages: List of message dictionaries
            tokenizer: Tokenizer instance
            
        Returns:
            Formatted prompt string
        """
        # Use tokenizer's chat template if available
        if hasattr(tokenizer, "apply_chat_template"):
            try:
                return tokenizer.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True,
                )
            except Exception:
                pass

        # Fallback to simple formatting
        prompt_parts = []
        for message in messages:
            role = message.get("role", "user")
            content = message.get("content", "")
            prompt_parts.append(f"{role}: {content}")

        prompt_parts.append("assistant:")
        return "\n".join(prompt_parts)

    def _generate_tokens(self, session: Any, input_ids: np.ndarray,
                        attention_mask: np.ndarray, max_length: int,
                        temperature: float,
    ) -> np.ndarray:
        """Generate tokens using ONNX session.
        
        Args:
            session: ONNX inference session
            input_ids: Input token IDs
            attention_mask: Attention mask
            max_length: Maximum generation length
            temperature: Sampling temperature
            
        Returns:
            Generated token IDs
        """
        current_ids = input_ids.copy()
        current_mask = attention_mask.copy()

        for _ in range(max_length - len(input_ids[0])):
            # Run inference
            outputs = session.run(
                None,
                {
                    "input_ids": current_ids.astype(np.int64),
                    "attention_mask": current_mask.astype(np.int64),
                },
            )

            # Get logits and apply temperature
            logits = outputs[0][:, -1, :] / temperature

            # Simple sampling (could be improved with top-k, top-p)
            probs = self._softmax(logits)
            next_token = np.random.choice(len(probs[0]), p=probs[0])

            # Append new token
            current_ids = np.concatenate([
                current_ids,
                np.array([[next_token]]),
            ], axis=1)

            current_mask = np.concatenate([
                current_mask,
                np.array([[1]]),
            ], axis=1)

            # Check for end token (simplified)
            if next_token == 2:  # Common EOS token ID
                break

        return current_ids

    def _softmax(self, x: np.ndarray) -> np.ndarray:
        """Apply softmax to logits.
        
        Args:
            x: Input logits
            
        Returns:
            Softmax probabilities
        """
        exp_x = np.exp(x - np.max(x, axis=-1, keepdims=True))
        return exp_x / np.sum(exp_x, axis=-1, keepdims=True)


class GemmaInferenceManager:
    """High-level manager for Gemma inference operations."""

    def __init__(self):
        self._service = GemmaInferenceService()

    def load_model_with_progress(self, repo_id: str,
                               progress_callback: Callable[[str, str | None, float | None, bool, bool | None], None],
                               cache_path: str | None = None,
                               quantization: str = "Full",
    ) -> tuple[Any, Any, Any]:
        """Load model with progress reporting.
        
        Args:
            repo_id: HuggingFace repository ID
            progress_callback: Callback for progress updates
            cache_path: Optional custom cache path
            quantization: Quantization level
            
        Returns:
            Tuple of (config, tokenizer, inference_session)
        """
        service = GemmaInferenceService(progress_callback)
        return service.load_model(repo_id, cache_path, quantization)

    def generate_response(self, config: Any, tokenizer: Any, session: Any,
                         user_prompt: str, system_prompt: str = "You are a helpful assistant.",
    ) -> str:
        """Generate a response to user input.
        
        Args:
            config: Model configuration
            tokenizer: Tokenizer instance
            session: ONNX inference session
            user_prompt: User's input prompt
            system_prompt: System prompt for context
            
        Returns:
            Generated response text
        """
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        try:
            generated_text, _ = self._service.generate_text(
                config, tokenizer, session, messages,
            )
            return generated_text
        except GemmaInferenceError:
            return "Error: Failed to generate response"

    def cleanup_resources(self) -> None:
        """Clean up resources and memory."""
        gc.collect()


# Legacy compatibility functions for existing code
def load_model(repo_id: str, cache_path: str | None = None,
               display_message_signal=None, quantization: str = "Full",
    ) -> tuple[Any, Any, Any]:
    """Legacy function for backward compatibility.
    
    Args:
        repo_id: HuggingFace repository ID
        cache_path: Optional cache path
        display_message_signal: PyQt signal for progress updates
        quantization: Quantization level
        
    Returns:
        Tuple of (config, tokenizer, inference_session)
    """
    progress_callback = None
    if display_message_signal:
        def progress_callback(msg, fname, pct, hold, reset):
            return display_message_signal.emit(msg, fname, pct, hold, reset)

    service = GemmaInferenceService(progress_callback)
    return service.load_model(repo_id, cache_path, quantization)


def generate_text(config: Any, tokenizer: Any, session: Any,
                 messages: list[dict[str, str]]) -> tuple[str, dict[str, Any]]:
    """Legacy function for backward compatibility.
    
    Args:
        config: Model configuration
        tokenizer: Tokenizer instance
        session: ONNX inference session
        messages: List of message dictionaries
        
    Returns:
        Tuple of (generated_text, generation_info)
    """
    service = GemmaInferenceService()
    return service.generate_text(config, tokenizer, session, messages)